import { canonicalJson, hashCanonical } from '../../domain/canonical';
import type { OperationIntent, OperationStep } from '../types';
import type { StoredOperationAttempt, StoredOperationStep } from './types';

export interface ReconciliationJournal {
  complete: boolean;
  notSentEvidence?: 'native-journal' | 'preflight-journal';
  reason?: 'missing' | 'inconsistent';
}

export const operationBinding = (operation: OperationIntent) => canonicalJson({
  id: operation.id, kind: operation.kind, authority: operation.authority, createdAt: operation.createdAt,
  input: operation.input, inputHash: operation.inputHash, expectedHeads: operation.expectedHeads,
});
const stepBinding = (step: OperationStep) => canonicalJson({
  id: step.id, phase: step.phase, publisherRoot: step.publisherRoot ?? null,
  inputHash: step.inputHash, expectedHeads: step.expectedHeads,
});
const subset = (observed: readonly string[], retained: readonly string[]) => {
  const known = new Set(retained.map(value => value.toLowerCase()));
  return observed.every(value => known.has(value.toLowerCase()));
};
const hashes = (record: StoredOperationStep): string[] => [record.submissionHash,
  record.step.transactionHash, record.receipt?.transactionHash].filter((value): value is NonNullable<typeof value> => typeof value === 'string');
const progressedPhase = (operation: OperationIntent) => operation.phase === 'complete'
  || operation.phase === 'initialized' || operation.phase.endsWith('_confirmed');

function neverSent(record: StoredOperationStep): boolean {
  if (record.submissionHash || record.receipt || record.step.transactionHash || record.step.confirmedKeys.length) return false;
  if (record.step.status === 'prepared') return record.admission === null;
  if (record.step.status !== 'failed-before-send') return false;
  if (record.admission === null) return record.error?.kind === 'not_sent' || record.error?.kind === 'rejected';
  // Admission is journalled before the wallet prompt. Its explicit EIP-1193 rejection
  // establishes no send, unlike a timeout or an unknown provider error after admission.
  return record.error?.kind === 'rejected' && record.error.code === 'rejected' && record.error.providerCode === 4001;
}

/** An echoed caller intent is not evidence that an admitted transaction never happened. */
export function inspectReconciliationJournal(input: OperationIntent, saved: OperationIntent | undefined,
  getStep: (operationId: string, stepId: string) => StoredOperationStep | undefined,
  attempt?: StoredOperationAttempt): ReconciliationJournal {
  const inconsistent: ReconciliationJournal = { complete: false, reason: 'inconsistent' };
  try {
    if (attempt) {
      if (operationBinding(input) !== operationBinding(attempt.operation)
        || attempt.operation.inputHash !== hashCanonical(attempt.operation.input)) return inconsistent;
      if (attempt.state === 'rejected-before-native') {
        const pristine = (operation: OperationIntent) => operation.phase === 'prepared' && operation.steps.length === 0
          && !operation.transactionHash && operation.confirmedKeys.length === 0;
        return !saved && attempt.nativeStepIds.length === 0 && attempt.settledAt !== null
          && pristine(input) && pristine(attempt.operation)
          ? { complete: true, notSentEvidence: 'preflight-journal' } : inconsistent;
      }
      if (attempt.state === 'preflight') return { complete: false, reason: 'missing' };
      if (!saved || attempt.nativeStepIds.length === 0
        || attempt.nativeStepIds.some(id => !saved.steps.some(step => step.id === id) || !getStep(input.id, id))) return inconsistent;
    }
    if (!saved) return { complete: false, reason: 'missing' };
    if (operationBinding(input) !== operationBinding(saved) || saved.inputHash !== hashCanonical(saved.input)
      || saved.steps.length === 0 || new Set(saved.steps.map(step => step.id)).size !== saved.steps.length
      || new Set(input.steps.map(step => step.id)).size !== input.steps.length) return inconsistent;
    const records = new Map<string, StoredOperationStep>();
    for (const step of saved.steps) {
      const record = getStep(saved.id, step.id);
      if (!record || operationBinding(record.operation) !== operationBinding(saved) || canonicalJson(record.step) !== canonicalJson(step)
        || record.step.inputHash !== hashCanonical(record.batch)) return inconsistent;
      records.set(step.id, record);
    }
    // Older per-step copies may still name a phase missing from the latest operation.
    // Do not turn a partially lost multi-step journal into a fresh unadmitted request.
    for (const record of records.values()) {
      if (record.operation.steps.some(step => !records.has(step.id)
        || stepBinding(step) !== stepBinding(records.get(step.id)!.step))) return inconsistent;
    }
    for (const observed of [...input.steps, ...(attempt?.operation.steps ?? [])]) {
      const record = records.get(observed.id);
      if (!record || stepBinding(observed) !== stepBinding(record.step)
        || (observed.transactionHash && !subset([observed.transactionHash], hashes(record)))
        || !subset(observed.confirmedKeys, record.step.confirmedKeys)) return inconsistent;
      if ((observed.status === 'confirmed' || observed.status === 'reverted') && observed.status !== record.step.status) return inconsistent;
      if (['submitted', 'unverified'].includes(observed.status) && ['prepared', 'failed-before-send'].includes(record.step.status)) return inconsistent;
    }
    const retained = [...records.values()];
    const retainedHashes = retained.flatMap(hashes);
    const confirmedKeys = retained.filter(record => record.step.status === 'confirmed').flatMap(record => record.step.confirmedKeys);
    for (const operation of [input, saved, ...(attempt ? [attempt.operation] : []), ...retained.map(record => record.operation)]) {
      if ((operation.transactionHash && !subset([operation.transactionHash], retainedHashes))
        || !subset(operation.confirmedKeys, confirmedKeys)
        || (progressedPhase(operation) && !retained.some(record => record.step.status === 'confirmed'))) return inconsistent;
    }
    const notSent = !input.transactionHash && input.confirmedKeys.length === 0 && !progressedPhase(input)
      && !input.steps.some(step => ['submitted', 'unverified', 'confirmed', 'reverted'].includes(step.status))
      && !saved.transactionHash && saved.confirmedKeys.length === 0 && !progressedPhase(saved)
      && retained.every(neverSent);
    return { complete: true, ...(notSent ? { notSentEvidence: 'native-journal' as const } : {}) };
  } catch { return inconsistent; }
}
