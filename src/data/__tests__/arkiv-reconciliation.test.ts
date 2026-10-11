import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import { hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { OperationIntent, ReplaceBookCommand } from '../types';
import { createArkivRepository } from '../arkiv';
import type { RpcRequest } from '../arkiv/client';
import { nativeCreate } from '../arkiv/verification';
import { allocateOperationStep, createOperationController, createOperationIntent, MemoryOperationStore } from '../operations';
import type { StoredOperationStep } from '../operations';
import { createWalletGateway } from '../wallet';
import type { RpcRequest as WalletRequest } from '../wallet';
import { NOW, PUBLISHER, entityKey, readyFixture } from './arkiv-fixture';

/** Real SDK/writer/controller paths; the only wallet is this in-memory provider. */
function fixture() {
  const source = readyFixture();
  const store = new MemoryOperationStore();
  const control = { sends: 0, estimates: 0, reject: true, failEstimate: false, failRead: false, rpcMethods: [] as string[] };
  const request: RpcRequest = async args => {
    control.rpcMethods.push(args.method);
    if (control.failRead) throw new Error('The current scoped snapshot is unavailable.');
    if (args.method === 'eth_estimateGas') {
      control.estimates++;
      if (control.failEstimate) throw new Error('The unsigned estimate is unavailable.');
      return toHex(100_000);
    }
    if (args.method === 'eth_gasPrice') return '0x2';
    return source.rpc.request(args);
  };
  const provider = { request: async (args: WalletRequest): Promise<unknown> => {
    if (args.method === 'eth_accounts') return [PUBLISHER];
    if (args.method === 'eth_chainId') return toHex(TIRAMISU_CHAIN_ID);
    if (args.method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet method: ${args.method}`);
    control.sends++;
    if (control.reject) throw { code: 4001, message: 'The fixture user rejected the wallet prompt.' };
    throw new Error('The provider lost its response after admission.');
  } };
  const gateway = createWalletGateway({ provider, publicRpc: { request } });
  const controller = createOperationController({ store, gateway, now: () => NOW });
  const repository = createArkivRepository({ request, controller, now: () => NOW });
  const fields = { publisherRoot: source.book.publisherRoot, expectedHeads: [entityKey(4)],
    book: { ...structuredClone(source.book), predecessorKeys: [entityKey(4)] }, lifetimeSeconds: 91 * 86_400 };
  const command: ReplaceBookCommand = { ...fields, operation: createOperationIntent('replace_book', {
    mode: 'public', actor: { kind: 'wallet', address: PUBLISHER }, chainId: TIRAMISU_CHAIN_ID,
  }, fields, { id: 'reconcile-evidence', now: NOW }) };
  const withRecords = (records: StoredOperationStep[]) => {
    const nextStore = new MemoryOperationStore(); nextStore.putMany(records);
    const nextController = createOperationController({ store: nextStore, gateway, now: () => NOW });
    return createArkivRepository({ request, controller: nextController, now: () => NOW });
  };
  async function prepare(operation: OperationIntent, phase: 'book_pending' | 'link_pending' = 'book_pending') {
    const step = allocateOperationStep(operation, phase, {});
    const batch = { creates: [nativeCreate(source.book, 91 * 86_400)] };
    step.inputHash = hashCanonical(batch); operation.steps.push(step); operation.phase = phase;
    return controller.prepareStep({ operation, step, batch });
  }
  return { ...source, store, controller, repository, control, command, withRecords, prepare };
}

describe('public reconciliation requires retained journal evidence', () => {
  it('proves an explicit rejected wallet prompt was not sent using its retained native record', async () => {
    const f = fixture();
    expect(await f.repository.replaceBook(f.command)).toMatchObject({ ok: false, error: { code: 'rejected' } });
    expect(f.store.list()[0]).toMatchObject({ step: { status: 'failed-before-send' },
      error: { kind: 'rejected', code: 'rejected', providerCode: 4001 } });
    expect(f.store.list()[0]!.admission).not.toBeNull();
    expect(await f.repository.reconcile(f.command.operation)).toMatchObject({ ok: true,
      value: { status: 'not_sent', evidence: 'native-journal' } });
    expect(f.control.sends).toBe(1);
  });

  it('proves a failed unsigned preparation never reached the wallet', async () => {
    const f = fixture(); f.control.failEstimate = true;
    expect(await f.repository.replaceBook(f.command)).toMatchObject({ ok: false });
    expect(f.store.list()[0]).toMatchObject({ admission: null, step: { status: 'failed-before-send' } });
    expect(await f.repository.reconcile(f.command.operation)).toMatchObject({ ok: true,
      value: { status: 'not_sent', evidence: 'native-journal' } });
    expect(f.control.sends).toBe(0);
  });

  it('proves an intact prepared journal is safe to continue before admission', async () => {
    const f = fixture(); await f.prepare(structuredClone(f.command.operation));
    expect(await f.repository.reconcile(f.command.operation)).toMatchObject({ ok: true,
      value: { status: 'not_sent', evidence: 'native-journal' } });
    expect(f.control.sends).toBe(0);
  });

  it('does not infer no send from a pristine caller intent after the admitted native journal disappears', async () => {
    const f = fixture(); f.control.reject = false;
    expect(await f.repository.replaceBook(f.command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    expect(f.command.operation.steps).toEqual([]);
    expect(f.store.list()[0]!.admission).not.toBeNull();
    expect(await f.withRecords([]).reconcile(f.command.operation)).toMatchObject({ ok: true, value: { status: 'unverified' } });
    expect(f.control.sends).toBe(1);
  });

  it('does not reuse old no-send evidence after a rejected attempt was retried with an unknown result', async () => {
    const f = fixture(); await f.repository.replaceBook(f.command);
    const rejected = f.controller.getOperation(f.command.operation.id)!;
    f.control.reject = false;
    expect(await f.repository.replaceBook({ ...f.command, operation: rejected })).toMatchObject({ ok: false, error: { code: 'unverified' } });
    expect(await f.withRecords([]).reconcile(rejected)).toMatchObject({ ok: true, value: { status: 'unverified' } });
    expect(f.control.sends).toBe(2);
  });

  it('rejects an older prepared journal when the caller already observed admission', async () => {
    const f = fixture(); const prepared = await f.prepare(structuredClone(f.command.operation));
    f.control.reject = false;
    await expect(f.controller.submitStep(prepared.operation.id, prepared.step.id)).rejects.toMatchObject({ kind: 'unverified' });
    const admitted = f.controller.getOperation(f.command.operation.id)!;
    expect(await f.withRecords([prepared]).reconcile(admitted)).toMatchObject({ ok: true, value: { status: 'unverified' } });
    expect(f.control.sends).toBe(1);
  });

  it('rejects a partial journal even when the caller retains only the pristine overall intent', async () => {
    const f = fixture(); const first = await f.prepare(structuredClone(f.command.operation));
    f.control.reject = false;
    await expect(f.controller.submitStep(first.operation.id, first.step.id)).rejects.toMatchObject({ kind: 'unverified' });
    const afterAdmission = f.controller.getOperation(f.command.operation.id)!;
    const later = await f.prepare(afterAdmission, 'link_pending');
    expect(await f.withRecords([later]).reconcile(f.command.operation)).toMatchObject({ ok: true, value: { status: 'unverified' } });
    expect(f.control.sends).toBe(1);
  });

  it.each(['inputHash', 'expectedHeads', 'phase'] as const)('rejects a saved attempt whose immutable %s differs from the observed attempt', async field => {
    const f = fixture(); const prepared = await f.prepare(structuredClone(f.command.operation));
    const observed = structuredClone(prepared.operation);
    if (field === 'inputHash') observed.steps[0]!.inputHash = entityKey(999);
    if (field === 'expectedHeads') observed.steps[0]!.expectedHeads = [entityKey(999)];
    if (field === 'phase') observed.steps[0]!.phase = 'root_pending';
    expect(await f.repository.reconcile(observed)).toMatchObject({ ok: true, value: { status: 'unverified' } });
    expect(f.control.sends).toBe(0);
  });

  it('proves a writer validation failure through the separate attempt journal without inventing a native step', async () => {
    const f = fixture(); const invalid = structuredClone(f.command); invalid.book.name = 'Changed after review';
    expect(await f.repository.replaceBook(invalid)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.store.list()).toEqual([]);
    expect(f.controller.getAttempt(f.command.operation.id)).toMatchObject({ state: 'rejected-before-native', nativeStepIds: [] });
    expect(await f.repository.reconcile(f.command.operation)).toMatchObject({ ok: true, value: { status: 'not_sent', evidence: 'preflight-journal' } });
    expect(await f.withRecords([]).reconcile(f.command.operation)).toMatchObject({ ok: true, value: { status: 'unverified' } });
    expect(f.control.sends).toBe(0);
  });

  it('can deliberately retry the same unchanged operation after a retained RPC preflight rejection', async () => {
    const f = fixture(); f.control.failRead = true;
    expect(await f.repository.replaceBook(f.command)).toMatchObject({ ok: false, error: { code: 'network' } });
    const first = f.controller.getAttempt(f.command.operation.id)!;
    expect(await f.repository.reconcile(f.command.operation)).toMatchObject({ ok: true, value: { status: 'not_sent', evidence: 'preflight-journal' } });
    f.control.failRead = false;
    expect(await f.repository.replaceBook(f.command)).toMatchObject({ ok: false, error: { code: 'rejected' } });
    expect(f.controller.getAttempt(f.command.operation.id)).toMatchObject({ state: 'native-started' });
    expect(f.controller.getAttempt(f.command.operation.id)!.attemptId).not.toBe(first.attemptId);
    expect(await f.repository.reconcile(f.command.operation)).toMatchObject({ ok: true, value: { status: 'not_sent', evidence: 'native-journal' } });
    expect(f.control.sends).toBe(1);
  });

  it('cannot replace a rejected preflight intent with changed input under the same ID', async () => {
    const f = fixture(); f.control.failRead = true;
    await f.repository.replaceBook(f.command);
    const { operation, ...fields } = f.command;
    const changed = { ...fields, book: { ...fields.book, name: 'A changed request' } };
    const replacement = { ...changed, operation: createOperationIntent('replace_book', operation.authority, changed,
      { id: operation.id, now: operation.createdAt }) };
    f.control.failRead = false;
    expect(await f.repository.replaceBook(replacement)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(f.control.sends).toBe(0);
  });
});
