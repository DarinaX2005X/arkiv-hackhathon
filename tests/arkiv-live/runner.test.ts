import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import { createArkivRepository } from '../../src/data/arkiv';
import type { RpcRequest as ArkivRpcRequest } from '../../src/data/arkiv/client';
import { NOW, PUBLISHER, readyFixture } from '../../src/data/__tests__/arkiv-fixture';
import { allocateOperationStep, createOperationController, createOperationIntent, MemoryOperationStore } from '../../src/data/operations';
import { createWalletGateway, WalletOperationError } from '../../src/data/wallet';
import type { NativeWalletGateway, RpcRequest as WalletRpcRequest } from '../../src/data/wallet';
import { hashCanonical } from '../../src/domain/canonical';
import { assertJournalContinuity, expectedProofLineage, hydrateOriginalHashes, withCappedPreparation } from './runner';
import type { BudgetRecord } from './safety';
import type { FrozenAction, ProofState } from './state';
import { ROOT_ACCOUNT } from './state';

const txHash = `0x${'11'.repeat(32)}` as const;
const entityKey = (number: number) => `0x${number.toString(16).padStart(64, '0')}` as const;
function fixture() {
  const store = new MemoryOperationStore();
  const operation = createOperationIntent('create_project', { mode: 'public', chainId: 7738577, actor: { kind: 'wallet', address: ROOT_ACCOUNT } },
    { lifetimeSeconds: 3600 }, { id: 'unit:runner', now: 1791547200000 });
  const batch = { deletes: [`0x${'22'.repeat(32)}` as const] };
  const step = allocateOperationStep(operation, 'root_pending', {}, []);
  step.inputHash = hashCanonical(batch); operation.steps.push(step);
  let estimateCount = 0;
  const gateway: NativeWalletGateway = {
    async prepare(input, account, transactionOptions = {}) {
      estimateCount += 1;
      return { batch: input, account, chainId: 7738577, transactionOptions,
        request: { from: account, to: '0x4400000000000000000000000000000000000044', data: '0x1234', value: '0x0', chainId: '0x7614d1',
          ...(transactionOptions.gas ? { gas: `0x${BigInt(transactionOptions.gas).toString(16)}` as const } : {}),
          maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x1' }, estimatedGas: '100000', preparedAtBlock: '100',
        estimatedCostWei: null, estimatedMaximumCostWei: null, estimatePolicy: 'estimate-only' };
    },
    async submit() { throw new WalletOperationError('Read-only boundary', { kind: 'not_sent', code: 'unsupported' }); }, dispose() {},
  };
  const controller = withCappedPreparation(createOperationController({ store, gateway }), store, gateway);
  const action: FrozenAction = { actor: 'coordinator', method: 'createProject', codeCommit: 'a'.repeat(40),
    command: { operation, lifetimeSeconds: 3600 }, confirmed: false, confirmedKeys: [] };
  return { store, operation, step, batch, controller, action, estimates: () => estimateCount };
}

async function admitted() {
  const f = fixture(); const saved = await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: f.batch });
  saved.admission = { request: saved.prepared!.request, at: 1791547200000 }; saved.step.status = 'unverified'; f.store.put(saved);
  const request = saved.admission.request;
  const record: BudgetRecord = { id: `${saved.operation.id}:${saved.step.id}`, kind: 'native', status: 'submitted',
    transactionHash: txHash, signedTransaction: '0x1234', receipt: null, maximumCostWei: '240000000000000',
    plan: { chainId: 7738577, from: ROOT_ACCOUNT.toLowerCase(), to: request.to.toLowerCase(), data: request.data,
      value: '0', nonce: 0, gas: '120000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' } };
  return { ...f, saved, record };
}

describe('proof runner resume boundary', () => {
  it('requires only the saved revision prefix for each checkpoint and refuses a missing intermediate publication', () => {
    const state: Pick<ProofState, 'projectRoot' | 'proposals'> = { projectRoot: entityKey(1), proposals: {
      p1: { proposalKey: entityKey(10), activationKey: entityKey(11), proposalHash: entityKey(12) },
    } };
    const first = expectedProofLineage(state, 'p1');
    expect(first).toEqual([{ projectRoot: state.projectRoot, ...state.proposals.p1 }]);
    expect(() => expectedProofLineage(state, 'p2')).toThrow('saved p2 proposal reference is missing');
    state.proposals.p2 = { proposalKey: entityKey(20), activationKey: entityKey(21), proposalHash: entityKey(22) };
    expect(expectedProofLineage(state, 'p2')).toHaveLength(2);
    state.proposals.p3 = { proposalKey: entityKey(30), activationKey: entityKey(31), proposalHash: entityKey(32) };
    expect(expectedProofLineage(state, 'p1')).toEqual(first);
    expect(expectedProofLineage(state, 'p3')).toEqual(['p1', 'p2', 'p3'].map(name => ({ projectRoot: state.projectRoot,
      ...state.proposals[name as keyof typeof state.proposals] })));
    delete state.proposals.p2;
    expect(() => expectedProofLineage(state, 'p3')).toThrow('saved p2 proposal reference is missing');
  });
  it('keeps explicit fee options in the real controller and resumes the original prepared intent', async () => {
    const f = fixture();
    await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: f.batch });
    await expect(f.controller.submitStep(f.operation.id, f.step.id)).rejects.toThrow('Read-only boundary');
    const prepared = await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: f.batch });
    expect(prepared.prepared!.transactionOptions).toEqual({ gas: '120000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' });
    expect(prepared.admission).toBeNull(); expect(prepared.step.id).toBe(f.step.id);
    expect(f.estimates()).toBe(3); // Initial cap estimate + preparation, then one re-preparation with original caps.
  });
  it('recovers a capped estimate RPC failure through the production writer and the same saved intent', async () => {
    const source = readyFixture(); const store = new MemoryOperationStore();
    const control = { failEstimate: true, estimates: 0, walletPrompts: 0 };
    const request: ArkivRpcRequest = async args => {
      if (args.method === 'eth_estimateGas') {
        control.estimates++;
        // The cap resolver must enter only after the real writer has saved this exact native batch.
        expect(store.list()).toHaveLength(1);
        expect(store.list()[0]?.admission).toBeNull();
        if (control.failEstimate) throw new Error('Transient unsigned estimate failure');
        return toHex(100_000);
      }
      if (args.method === 'eth_gasPrice') return '0x2';
      return source.rpc.request(args);
    };
    const provider = { request: async (args: WalletRpcRequest): Promise<unknown> => {
      if (args.method === 'eth_accounts') return [PUBLISHER];
      if (args.method === 'eth_chainId') return toHex(7738577);
      if (args.method !== 'eth_sendTransaction') throw new Error(`Unexpected mocked wallet method ${args.method}`);
      control.walletPrompts++;
      throw { code: 4001, message: 'Mocked user rejection; no signer or network exists in this test.' };
    } };
    const gateway = createWalletGateway({ provider, publicRpc: { request } });
    const controller = withCappedPreparation(createOperationController({ store, gateway, now: () => NOW }), store, gateway);
    const repository = createArkivRepository({ request, controller, now: () => NOW });
    const fields = { publisherRoot: source.book.publisherRoot, expectedHeads: [entityKey(4)],
      book: { ...structuredClone(source.book), predecessorKeys: [entityKey(4)] }, lifetimeSeconds: 91 * 86_400 };
    const command = { ...fields, operation: createOperationIntent('replace_book', {
      mode: 'public', actor: { kind: 'wallet', address: PUBLISHER }, chainId: 7738577,
    }, fields, { id: 'unit:capped-writer-retry', now: NOW }) };
    expect(await repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'network' } });
    const failed = store.list()[0]!;
    expect(failed).toMatchObject({ step: { status: 'failed-before-send' }, prepared: null, admission: null, submissionHash: null });
    expect(controller.getAttempt(command.operation.id)).toMatchObject({ state: 'native-started', nativeStepIds: [failed.step.id] });
    expect(await repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'not_sent', evidence: 'native-journal' } });
    expect(control.walletPrompts).toBe(0);
    // A restarted controller uses the retained failed step; a new operation ID is unnecessary.
    const restoredController = withCappedPreparation(createOperationController({ store, gateway, now: () => NOW }), store, gateway);
    const restored = createArkivRepository({ request, controller: restoredController, now: () => NOW });
    control.failEstimate = false;
    expect(await restored.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'rejected' } });
    expect(store.list()).toHaveLength(1); expect(store.list()[0]!.step.id).toBe(failed.step.id);
    expect(store.list()[0]!.prepared?.transactionOptions).toEqual({ gas: '120000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' });
    expect(control.walletPrompts).toBe(1);
    expect(control.estimates).toBe(4); // Failed cap estimate, cap resolution, preparation, final pre-send re-estimate.
    expect(await restored.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'not_sent', evidence: 'native-journal' } });
  });
  it('blocks a missing journal for a partially sent action', async () => {
    const f = await admitted();
    expect(() => assertJournalContinuity({ first: f.action }, new MemoryOperationStore(), [f.record])).toThrow('missing its original application journal');
  });
  it('blocks a missing journal for an action that completed before its state checkpoint', () => {
    const f = fixture(); f.action.confirmed = true;
    expect(() => assertJournalContinuity({ first: f.action }, f.store, [])).toThrow('completed action');
  });
  it('blocks a missing budget record for an admitted application operation', async () => {
    const f = await admitted();
    expect(() => assertJournalContinuity({ first: f.action }, f.store, [])).toThrow('budget record');
  });
  it('allows a never-admitted prepared action to resume', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: f.batch });
    expect(() => assertJournalContinuity({ first: f.action }, f.store, [])).not.toThrow();
  });
  it('hydrates the persisted original hash without replacing or sending the action', async () => {
    const f = await admitted(); assertJournalContinuity({ first: f.action }, f.store, [f.record]);
    hydrateOriginalHashes(f.store, [f.record]);
    const saved = f.store.get(f.operation.id, f.step.id)!;
    expect(saved.submissionHash).toBe(txHash); expect(saved.step.transactionHash).toBe(txHash);
    expect(saved.step.status).toBe('submitted'); expect(saved.admission).toEqual(f.saved.admission);
  });
  it('rejects a mismatching original admission and preserves the unsolved record', async () => {
    const f = await admitted(); f.record.plan.data = '0x9999';
    expect(() => hydrateOriginalHashes(f.store, [f.record])).toThrow('does not match');
    expect(f.store.get(f.operation.id, f.step.id)!.submissionHash).toBeNull();
  });
});
