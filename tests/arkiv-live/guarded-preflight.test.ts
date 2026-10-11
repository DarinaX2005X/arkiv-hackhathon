import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { allocateOperationStep, createOperationController, MemoryOperationStore } from '../../src/data/operations';
import { createWalletGateway, WalletOperationError } from '../../src/data/wallet';
import { hashCanonical } from '../../src/domain/canonical';
import type { OperationIntent } from '../../src/data/types';
import type { NativeBatch, NativeTransactionOptions } from '../../src/data/wallet';
import { applyGuardedPreflightEvidence, createPreflightWitnessDocument, GuardedPreflightWitnesses, withGuardedPreflightEvidence } from './guarded-preflight';
import type { PreflightWitnessDocument } from './guarded-preflight';
import { BudgetLedger, createBudgetDocument, createGuardedAccountProvider, GuardedPreflightNotSent, LIVE_CHAIN_ID } from './safety';
import type { BudgetDocument, ReadRpc } from './safety';

const commit = 'a'.repeat(40), now = 1791700000000;
async function fixture(options: { witnessFailure?: number; ledgerFailure?: boolean; keyFailure?: boolean; sendFailure?: boolean } = {}) {
  // Ephemeral synthetic account, memory stores and stub RPC only; no real journal or network.
  const account = privateKeyToAccount(generatePrivateKey());
  const input = { label: 'Synthetic immutable intent' };
  const operation: OperationIntent = { id: 'synthetic-operation', kind: 'replace_book', createdAt: now, input, inputHash: hashCanonical(input),
    authority: { mode: 'public', chainId: LIVE_CHAIN_ID, actor: { kind: 'wallet', address: account.address } },
    phase: 'prepared', expectedHeads: [], steps: [], transactionHash: null, confirmedKeys: [], pendingPublisherRoots: [] };
  const batch: NativeBatch = { deletes: [`0x${'22'.repeat(32)}`] };
  const step = allocateOperationStep(operation, 'book_pending', batch, []); step.inputHash = hashCanonical(batch);
  const transactionOptions: NativeTransactionOptions = { gas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' };
  const store = new MemoryOperationStore();
  let readsFail = true, estimate = 80000n, prepareReads = 0, keyLoads = 0, sends = 0, witnessSaves = 0;
  const witnessDocuments: PreflightWitnessDocument[] = [], budgetDocuments: BudgetDocument[] = [];
  const witnesses = new GuardedPreflightWitnesses(createPreflightWitnessDocument('synthetic-run'), document => {
    witnessSaves++;
    if (witnessSaves === options.witnessFailure) throw Error('Synthetic persistence fault');
    witnessDocuments.push(structuredClone(document));
  });
  const ledger = new BudgetLedger(createBudgetDocument({ rootAccount: account.address }), document => {
    if (options.ledgerFailure) throw Error('Synthetic ledger fault');
    budgetDocuments.push(structuredClone(document));
  });
  const read: ReadRpc = async args => {
    if (readsFail) throw Error('Synthetic RPC fault');
    if (args.method === 'eth_chainId') return toHex(LIVE_CHAIN_ID);
    if (args.method === 'eth_getTransactionCount') return '0x0';
    if (args.method === 'eth_getBalance') return toHex(10n ** 20n);
    throw Error('Unexpected guarded read');
  };
  const provider = createGuardedAccountProvider({ address: account.address, ledger, read, broadcast: true,
    preflight: witnesses.hooks(store, commit, () => now + 10),
    resolveAdmission: request => ({ operationId: operation.id, stepId: step.id, request }),
    loadAccount: async () => { keyLoads++; if (options.keyFailure) throw Error('Synthetic key fault'); return account; },
    sendRaw: async raw => { sends++; if (options.sendFailure) throw Error('Synthetic transport fault'); return keccak256(raw); },
  });
  const base = createWalletGateway({ provider, publicRpc: { request: async args => {
    prepareReads++;
    if (args.method === 'eth_chainId') return toHex(LIVE_CHAIN_ID);
    if (args.method === 'eth_blockNumber') return '0x64';
    if (args.method === 'eth_estimateGas') return toHex(estimate);
    throw Error('Unexpected unsigned read');
  } } });
  const gateway = withGuardedPreflightEvidence(base, store, witnesses);
  const controller = createOperationController({ store, gateway, now: () => now });
  const attempt = () => controller.withOperationAttempt(operation, async () => {
    await controller.prepareStep({ operation, step, batch, transactionOptions });
    return controller.submitStep(operation.id, step.id);
  });
  return { operation, step, batch, store, witnesses, ledger, controller, gateway, base, attempt, witnessDocuments, budgetDocuments,
    counters: () => ({ prepareReads, keyLoads, sends }), saved: () => store.get(operation.id, step.id)!,
    allowGuardReads: () => { readsFail = false; }, setEstimate: (value: bigint) => { estimate = value; } };
}

describe('durable guarded preflight evidence', () => {
  it('classifies the actual provider/gateway/controller failure and retries the same intent and native step through current preflight', async () => {
    const f = await fixture();
    await expect(f.attempt()).rejects.toMatchObject({ kind: 'not_sent', code: 'network' });
    const original = f.saved(), attemptId = f.store.getAttempt(f.operation.id)!.attemptId;
    expect(original.step.status).toBe('failed-before-send'); expect(original.admission).not.toBeNull();
    expect(f.witnesses.matches(original)).toBe(true);
    expect(f.witnessDocuments.map(doc => doc.records.at(-1)!.state)).toEqual(['entered', 'not_sent']);
    expect(f.counters()).toMatchObject({ keyLoads: 0, sends: 0 }); expect(f.ledger.snapshot().records).toHaveLength(0);
    const before = f.counters().prepareReads;
    f.allowGuardReads();
    const submitted = await f.attempt();
    expect(submitted.step.status).toBe('submitted'); expect(submitted.step.id).toBe(original.step.id);
    expect(submitted.operation.inputHash).toBe(original.operation.inputHash);
    expect(submitted.prepared!.transactionOptions).toEqual(original.prepared!.transactionOptions);
    expect(submitted.prepared!.request).toEqual(original.prepared!.request);
    expect(f.store.getAttempt(f.operation.id)!.attemptId).toBe(attemptId);
    expect(f.counters().prepareReads).toBeGreaterThan(before);
    expect(f.counters()).toMatchObject({ keyLoads: 1, sends: 1 });
    expect(f.witnesses.matches(submitted)).toBe(false);
  });

  it('runs current unsigned validation on retry and blocks stale gas before any key or forward', async () => {
    const f = await fixture(); await expect(f.attempt()).rejects.toMatchObject({ kind: 'not_sent' });
    f.allowGuardReads(); f.setEstimate(100001n);
    await expect(f.attempt()).rejects.toMatchObject({ kind: 'not_sent' });
    expect(f.saved().admission).toBeNull(); expect(f.counters()).toMatchObject({ keyLoads: 0, sends: 0 });
    expect(f.witnesses.snapshot().records).toHaveLength(1);
  });

  it('repairs only the controller crash checkpoint with positive durable evidence and retains admission and IDs', async () => {
    const f = await fixture(); await expect(f.attempt()).rejects.toMatchObject({ kind: 'not_sent' });
    const saved = f.saved(); saved.step.status = 'unverified'; saved.error = { kind: 'unverified', code: 'unverified', message: 'Synthetic crash' };
    saved.operation.steps = [structuredClone(saved.step)]; f.store.put(saved);
    const reloaded = new GuardedPreflightWitnesses(f.witnessDocuments.at(-1)!, () => {});
    applyGuardedPreflightEvidence(f.store, [], reloaded);
    expect(f.saved()).toMatchObject({ admission: saved.admission, step: { id: saved.step.id, status: 'failed-before-send' }, error: { kind: 'not_sent' } });
    expect(f.saved().operation.steps[0]!.status).toBe('failed-before-send');
    f.allowGuardReads(); await expect(f.attempt()).resolves.toMatchObject({ step: { status: 'submitted' } });
  });

  it.each([1, 2])('poisons failed witness persistence %s and never infers not-sent from memory', async witnessFailure => {
    const f = await fixture({ witnessFailure });
    await expect(f.attempt()).rejects.toMatchObject({ kind: 'unverified' });
    expect(f.saved().step.status).toBe('unverified'); expect(f.counters()).toMatchObject({ keyLoads: 0, sends: 0 });
    expect(() => f.witnesses.snapshot()).toThrow('PREFLIGHT_WITNESS_RELOAD_REQUIRED');
    const reloaded = new GuardedPreflightWitnesses(f.witnessDocuments.at(-1) ?? createPreflightWitnessDocument('synthetic-run'), () => {});
    applyGuardedPreflightEvidence(f.store, [], reloaded); expect(f.saved().step.status).toBe('unverified');
    f.allowGuardReads(); await expect(f.attempt()).rejects.toMatchObject({ kind: 'unverified' });
    expect(f.counters()).toMatchObject({ keyLoads: 0, sends: 0 });
  });

  it.each(['ledgerFailure', 'keyFailure', 'sendFailure'] as const)('retains ambiguous admission after %s', async failure => {
    const f = await fixture({ [failure]: true }); f.allowGuardReads();
    await expect(f.attempt()).rejects.toMatchObject({ kind: 'unverified' });
    expect(f.saved().step.status).toBe('unverified'); expect(f.witnesses.snapshot().records[0]!.state).toBe('entered');
    expect(f.witnesses.matches(f.saved())).toBe(false);
    expect(f.counters().sends).toBe(failure === 'sendFailure' ? 1 : 0);
  });

  it('refuses stale, mismatched, hash-bearing or receipt-bearing witness bindings', async () => {
    const f = await fixture(); await expect(f.attempt()).rejects.toMatchObject({ kind: 'not_sent' });
    const original = f.saved();
    for (const mutate of [
      (s: typeof original) => { s.admission!.at++; },
      (s: typeof original) => { s.admission!.request.data = '0xabcd'; },
      (s: typeof original) => { s.prepared!.request.data = '0xabcd'; },
      (s: typeof original) => { s.submissionHash = `0x${'33'.repeat(32)}`; },
      (s: typeof original) => { s.step.transactionHash = `0x${'33'.repeat(32)}`; },
      (s: typeof original) => { s.step.confirmedKeys = [`0x${'33'.repeat(32)}`]; },
    ]) { const altered = structuredClone(original); mutate(altered); expect(f.witnesses.matches(altered)).toBe(false); }
    expect(f.witnesses.matches(original, 'wrong-attempt')).toBe(false);
    const corrupt = f.witnesses.snapshot(); corrupt.records[0]!.proof!.rawForwards = 1 as 0;
    expect(() => new GuardedPreflightWitnesses(corrupt, () => {})).toThrow('INVALID_PREFLIGHT_WITNESS');
  });

  it('does not repair legacy gaps or classify generic errors as positive not-sent evidence', async () => {
    const f = await fixture(); await expect(f.attempt()).rejects.toMatchObject({ kind: 'not_sent' });
    const saved = f.saved(); saved.step.status = 'unverified'; f.store.put(saved);
    applyGuardedPreflightEvidence(f.store, [], new GuardedPreflightWitnesses(createPreflightWitnessDocument('synthetic-run'), () => {}));
    expect(f.saved().step.status).toBe('unverified');
    const generic = new WalletOperationError('GUARDED_PREFLIGHT_NOT_SENT', { kind: 'unverified', code: 'network', cause: new Error('GUARDED_PREFLIGHT_NOT_SENT') });
    const wrapper = withGuardedPreflightEvidence({ ...f.base, submit: async () => { throw generic; } }, f.store, f.witnesses);
    await expect(wrapper.submit(saved.prepared!, { onAdmission() {}, onHash() {} })).rejects.toBe(generic);
    const wrong = withGuardedPreflightEvidence({ ...f.base, submit: async () => { throw new GuardedPreflightNotSent('wrong-attempt'); } }, f.store, f.witnesses);
    await expect(wrong.submit(saved.prepared!, { onAdmission() {}, onHash() {} })).rejects.toThrow('PREFLIGHT_WITNESS_ADMISSION_MISMATCH');
  });
});
