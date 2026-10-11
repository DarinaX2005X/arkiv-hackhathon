import { describe, expect, it } from 'vitest';
import { allocateOperationStep, MemoryOperationStore } from '../../src/data/operations';
import type { StoredOperationStep } from '../../src/data/operations/types';
import { hashCanonical } from '../../src/domain/canonical';
import type { AccountAddress } from '../../src/domain/types';
import { admissionRecoveryBinding, assertOriginalGuardProvenance, LEGACY_GUARD_COMMIT, LEGACY_GUARD_DIGESTS, parseAdmissionRecoveryOptions } from './recover-admission';
import { nativeRequestHash } from './safety';
import type { BudgetRecord } from './safety';
import { ACTOR_IDS } from './scenario';
import { freezeAction, ROOT_ACCOUNT, validateState } from './state';
import type { ProofState } from './state';

const hash = `0x${'11'.repeat(32)}` as const, reviewedCommit = 'a1'.repeat(20);
function fixture() {
  const state: ProofState = { version: 1, runId: 'recovery-test', chainId: 7738577, genesisHash: `0x${'99'.repeat(32)}`,
    initializedAt: 1791547200000, initialCodeCommit: LEGACY_GUARD_COMMIT, rootAccount: ROOT_ACCOUNT,
    actors: Object.fromEntries(ACTOR_IDS.map((actor, index) => [actor, `0x${(index + 1).toString(16).padStart(40, '0')}` as AccountAddress])) as ProofState['actors'],
    projectRoot: null, publisherRoots: {}, proposals: {}, actions: {}, completedPhases: [], observationIds: [] };
  const action = freezeAction(state, 'p2-accept-ash', 'ash', 'replaceBook', 'replace_book',
    { mode: 'public', chainId: 7738577, actor: { kind: 'wallet', address: state.actors.ash } },
    { lifetimeSeconds: 3600, label: 'Synthetic original intent' }, LEGACY_GUARD_COMMIT, state.initializedAt);
  const operation = structuredClone(action.command.operation), batch = { deletes: [`0x${'22'.repeat(32)}` as const] };
  const step = allocateOperationStep(operation, 'book_pending', batch, []);
  step.inputHash = hashCanonical(batch); step.status = 'unverified'; operation.steps.push(step);
  const request = { from: state.actors.ash, to: '0x4400000000000000000000000000000000000044' as const,
    data: '0x1234' as const, value: '0x0' as const, chainId: '0x7614d1' as const,
    gas: '0x186a0' as const, maxFeePerGas: '0x77359400' as const, maxPriorityFeePerGas: '0x1' as const };
  const saved: StoredOperationStep = { version: 1, revision: 1, operation, step, batch,
    prepared: { batch, account: state.actors.ash, chainId: 7738577, request,
      transactionOptions: { gas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' },
      estimatedGas: '100000', preparedAtBlock: '100', estimatedCostWei: null, estimatedMaximumCostWei: null, estimatePolicy: 'estimate-only' },
    admission: { request, at: state.initializedAt }, submissionHash: null, receipt: null, error: { kind: 'unverified', code: 'unverified', message: 'Synthetic gap' } };
  const store = new MemoryOperationStore(); store.put(saved);
  store.putAttemptCAS({ version: 1, revision: 1, operation, attemptId: 'recovery-attempt', state: 'native-started',
    nativeStepIds: [step.id], startedAt: state.initializedAt, settledAt: null }, null);
  const args = ['--recover-admission', '--action', 'p2-accept-ash', '--step-id', step.id, '--expected-nonce', '4',
    '--original-commit', LEGACY_GUARD_COMMIT, '--reviewed-commit', reviewedCommit, '--broadcast', '--max-transactions', '1'];
  const options = parseAdmissionRecoveryOptions(args);
  const candidate: BudgetRecord = { id: `${operation.id}:${step.id}`, kind: 'native', status: 'reserved',
    maximumCostWei: '200000000000000', signedTransaction: null, transactionHash: null, receipt: null,
    plan: { chainId: 7738577, from: state.actors.ash.toLowerCase(), to: request.to, data: request.data, value: '0', nonce: 4,
      gas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' },
    admissionRecovery: { version: 1, preparedAtBlock: '100', preparedBlockHash: hash, originalCommit: LEGACY_GUARD_COMMIT, requestHash: nativeRequestHash(request) } };
  return { state: validateState(state), store, saved, options, args, candidate };
}

describe('explicit legacy admission recovery binding', () => {
  it('requires every explicit action, step, nonce, provenance, reviewed commit and one-send flag', () => {
    const f = fixture(); expect(f.options).toMatchObject({ actionId: 'p2-accept-ash', stepId: f.saved.step.id, expectedNonce: 4, broadcast: true, maxTransactions: 1 });
    for (const flag of ['--recover-admission', '--action', '--step-id', '--expected-nonce', '--original-commit', '--reviewed-commit', '--broadcast', '--max-transactions']) {
      const reduced = [...f.args], index = reduced.indexOf(flag); reduced.splice(index, ['--recover-admission', '--broadcast'].includes(flag) ? 1 : 2);
      expect(() => parseAdmissionRecoveryOptions(reduced)).toThrow();
    }
    for (const invalid of [[], [...f.args, '--broadcast'], [...f.args, '--initialize'], f.args.map(arg => arg === '4' ? '0' : arg),
      f.args.map(arg => arg === '4' ? '9007199254740993' : arg), f.args.map(arg => arg === '1' ? '2' : arg)]) {
      expect(() => parseAdmissionRecoveryOptions(invalid)).toThrow();
    }
  });

  it('requires the exact reviewed legacy implementation and matching original action commit', () => {
    expect(() => assertOriginalGuardProvenance(LEGACY_GUARD_COMMIT, LEGACY_GUARD_COMMIT, LEGACY_GUARD_DIGESTS)).not.toThrow();
    expect(() => assertOriginalGuardProvenance(reviewedCommit, LEGACY_GUARD_COMMIT, LEGACY_GUARD_DIGESTS)).toThrow('LEGACY_GUARD_PROVENANCE_REQUIRED');
    expect(() => assertOriginalGuardProvenance(LEGACY_GUARD_COMMIT, reviewedCommit, LEGACY_GUARD_DIGESTS)).toThrow('LEGACY_GUARD_PROVENANCE_REQUIRED');
    for (const path of Object.keys(LEGACY_GUARD_DIGESTS)) {
      expect(() => assertOriginalGuardProvenance(LEGACY_GUARD_COMMIT, LEGACY_GUARD_COMMIT, { ...LEGACY_GUARD_DIGESTS, [path]: 'wrong' })).toThrow();
    }
  });

  it('binds the original hashless gap and its exact reserved restart candidate', () => {
    const f = fixture();
    const expected = { actor: 'ash', address: f.state.actors.ash, id: f.candidate.id, preparedAtBlock: '100', request: f.saved.admission!.request, actionCommit: LEGACY_GUARD_COMMIT };
    expect(admissionRecoveryBinding(f.state, f.store, [], f.options)).toEqual(expected);
    expect(admissionRecoveryBinding(f.state, f.store, [f.candidate], f.options)).toEqual(expected);
  });

  it.each(['nonce', 'request', 'commit', 'block'] as const)('rejects a restart with changed %s metadata', field => {
    const f = fixture();
    if (field === 'nonce') f.candidate.plan.nonce++;
    if (field === 'request') f.candidate.admissionRecovery!.requestHash = `0x${'33'.repeat(32)}`;
    if (field === 'commit') f.candidate.admissionRecovery!.originalCommit = reviewedCommit;
    if (field === 'block') f.candidate.admissionRecovery!.preparedAtBlock = '101';
    expect(() => admissionRecoveryBinding(f.state, f.store, [f.candidate], f.options)).toThrow('ADMISSION_RECOVERY_CANDIDATE_MISMATCH');
  });

  it('accepts only matching app hashes after candidate hydration and never treats a hash-bearing legacy gap as recoverable', () => {
    const f = fixture(); f.saved.submissionHash = hash; f.saved.step.transactionHash = hash; f.store.put(f.saved);
    expect(() => admissionRecoveryBinding(f.state, f.store, [], f.options)).toThrow('ADMISSION_RECOVERY_HASHLESS_REQUIRED');
    expect(() => admissionRecoveryBinding(f.state, f.store, [f.candidate], f.options)).toThrow('ADMISSION_RECOVERY_HASH_MISMATCH');
    f.candidate.transactionHash = hash;
    expect(admissionRecoveryBinding(f.state, f.store, [f.candidate], f.options).id).toBe(f.candidate.id);
  });

  it.each(['confirmed', 'input', 'actor', 'batch', 'request', 'attempt'] as const)('rejects changed original %s binding', changed => {
    const f = fixture();
    if (changed === 'confirmed') f.state.actions['p2-accept-ash']!.confirmed = true;
    if (changed === 'input') f.state.actions['p2-accept-ash']!.command.operation.inputHash = hash;
    if (changed === 'actor') f.saved.prepared!.account = ROOT_ACCOUNT;
    if (changed === 'batch') f.saved.step.inputHash = hash;
    if (changed === 'request') f.saved.prepared!.request = { ...f.saved.prepared!.request, data: '0xabcd' };
    const store = changed === 'attempt' ? new MemoryOperationStore() : f.store;
    if (changed === 'attempt') store.put(f.saved);
    expect(() => { f.store.put(f.saved); admissionRecoveryBinding(f.state, store, [], f.options); }).toThrow();
  });

  it('rejects any second missing ledger admission or orphaned native budget record', () => {
    const f = fixture(), other = structuredClone(f.saved); other.step.id = 'other-step'; f.store.put(other);
    expect(() => admissionRecoveryBinding(f.state, f.store, [], f.options)).toThrow('ADMISSION_RECOVERY_CONTINUITY_MISMATCH');
    const g = fixture(), orphan = structuredClone(g.candidate); orphan.id = 'orphan:record';
    expect(() => admissionRecoveryBinding(g.state, g.store, [orphan], g.options)).toThrow('ADMISSION_RECOVERY_CONTINUITY_MISMATCH');
  });
});
