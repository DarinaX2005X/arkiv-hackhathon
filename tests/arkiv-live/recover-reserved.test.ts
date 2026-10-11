import { describe, expect, it } from 'vitest';
import { allocateOperationStep, MemoryOperationStore } from '../../src/data/operations';
import type { StoredOperationStep } from '../../src/data/operations/types';
import { hashCanonical } from '../../src/domain/canonical';
import type { AccountAddress } from '../../src/domain/types';
import { parseRecoveryOptions, recoveryBinding } from './recover-reserved';
import type { BudgetRecord } from './safety';
import { ACTOR_IDS } from './scenario';
import { freezeAction, ROOT_ACCOUNT, validateState } from './state';
import type { ProofState } from './state';

const expectedHash = `0x${'11'.repeat(32)}` as const;
const commit = 'a1'.repeat(20);
const args = ['--recover-reserved', '--expected-hash', expectedHash, '--reviewed-commit', commit, '--broadcast', '--max-transactions', '1'];
function fixture() {
  const state: ProofState = { version: 1, runId: 'recovery-test', chainId: 7738577, genesisHash: `0x${'99'.repeat(32)}`,
    initializedAt: 1791547200000, initialCodeCommit: commit, rootAccount: ROOT_ACCOUNT,
    actors: Object.fromEntries(ACTOR_IDS.map((actor, index) => [actor, `0x${(index + 1).toString(16).padStart(40, '0')}` as AccountAddress])) as ProofState['actors'],
    projectRoot: null, publisherRoots: {}, proposals: {}, actions: {}, completedPhases: [], observationIds: [] };
  const action = freezeAction(state, 'register-ash', 'ash', 'registerPublisher', 'register_publisher',
    { mode: 'public', chainId: 7738577, actor: { kind: 'wallet', address: state.actors.ash } },
    { lifetimeSeconds: 3600, name: 'Synthetic Ash', kind: 'person', description: 'Offline test' }, commit, state.initializedAt);
  const operation = structuredClone(action.command.operation);
  const batch = { deletes: [`0x${'22'.repeat(32)}` as const] };
  const step = allocateOperationStep(operation, 'initial_state_pending', {}, []);
  step.inputHash = hashCanonical(batch); step.status = 'submitted'; step.transactionHash = expectedHash; operation.steps.push(step);
  const request = { from: state.actors.ash, to: '0x4400000000000000000000000000000000000044' as const,
    data: '0x1234' as const, value: '0x0' as const, chainId: '0x7614d1' as const,
    gas: '0x186a0' as const, maxFeePerGas: '0x77359400' as const, maxPriorityFeePerGas: '0x1' as const };
  const saved: StoredOperationStep = { version: 1, revision: 1, operation, step, batch,
    prepared: { batch, account: state.actors.ash, chainId: 7738577, request,
      transactionOptions: { gas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' },
      estimatedGas: '100000', preparedAtBlock: '100', estimatedCostWei: null, estimatedMaximumCostWei: null, estimatePolicy: 'estimate-only' },
    admission: { request, at: state.initializedAt }, submissionHash: expectedHash, receipt: null, error: null };
  const store = new MemoryOperationStore(); store.put(saved);
  store.putAttemptCAS({ version: 1, revision: 1, operation, attemptId: 'recovery-attempt', state: 'native-started',
    nativeStepIds: [step.id], startedAt: state.initializedAt, settledAt: null }, null);
  const record: BudgetRecord = { id: `${operation.id}:${step.id}`, kind: 'native', status: 'reserved',
    maximumCostWei: '200000000000000', signedTransaction: null, transactionHash: null, receipt: null,
    plan: { chainId: 7738577, from: state.actors.ash.toLowerCase(), to: request.to, data: request.data, value: '0', nonce: 1,
      gas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' } };
  return { state: validateState(state), store, saved, record };
}

describe('explicit original reservation recovery CLI', () => {
  it('requires every explicit recovery, hash, commit and one-send flag', () => {
    expect(parseRecoveryOptions(args)).toEqual({ expectedHash, reviewedCommit: commit, broadcast: true, maxTransactions: 1 });
    for (const flag of ['--recover-reserved', '--expected-hash', '--reviewed-commit', '--broadcast', '--max-transactions']) {
      const reduced = [...args]; const index = reduced.indexOf(flag); reduced.splice(index, flag === '--recover-reserved' || flag === '--broadcast' ? 1 : 2);
      expect(() => parseRecoveryOptions(reduced)).toThrow();
    }
    for (const invalid of [[], [...args, '--broadcast'], args.map(item => item === '1' ? '2' : item), [...args, '--initialize']]) {
      expect(() => parseRecoveryOptions(invalid)).toThrow();
    }
  });
  it('binds the original action and admission to its same reserved step', () => {
    const f = fixture();
    expect(recoveryBinding(f.state, f.store, [f.record], expectedHash)).toEqual({ actor: 'ash', address: f.state.actors.ash,
      record: f.record, request: f.saved.admission!.request });
  });
  it('refuses missing or inconsistent journal hashes and reservations', () => {
    const f = fixture();
    expect(() => recoveryBinding(f.state, f.store, [], expectedHash)).toThrow();
    expect(() => recoveryBinding(f.state, f.store, [f.record], `0x${'33'.repeat(32)}`)).toThrow('RECOVERY_ORIGINAL_JOURNAL_REQUIRED');
    f.saved.step.transactionHash = `0x${'33'.repeat(32)}`; f.store.put(f.saved);
    expect(() => recoveryBinding(f.state, f.store, [f.record], expectedHash)).toThrow('RECOVERY_JOURNAL_HASH_MISMATCH');
  });
  it('refuses a changed original action and wrong signer binding', () => {
    const f = fixture(); f.state.actions['register-ash']!.command.operation.inputHash = `0x${'44'.repeat(32)}`;
    expect(() => recoveryBinding(f.state, f.store, [f.record], expectedHash)).toThrow('RECOVERY_ACTION_MISMATCH');
    const g = fixture(); g.record.plan.from = ROOT_ACCOUNT.toLowerCase();
    expect(() => recoveryBinding(g.state, g.store, [g.record], expectedHash)).toThrow('RECOVERY_RESERVATION_MISMATCH');
  });
  it('requires the original native-started attempt and saved batch binding', () => {
    const f = fixture(); const withoutAttempt = new MemoryOperationStore(); withoutAttempt.put(f.saved);
    expect(() => recoveryBinding(f.state, withoutAttempt, [f.record], expectedHash)).toThrow('RECOVERY_ORIGINAL_ATTEMPT_REQUIRED');
    f.saved.step.inputHash = `0x${'55'.repeat(32)}`; f.store.put(f.saved);
    expect(() => recoveryBinding(f.state, f.store, [f.record], expectedHash)).toThrow('RECOVERY_AUTHORITY_MISMATCH');
  });
});
