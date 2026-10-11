import { canonicalJson, hashCanonical } from '../../src/domain/canonical';
import type { PublicEntityKey } from '../../src/domain/types';
import type { OperationStore } from '../../src/data/operations';
import { inspectReconciliationJournal, operationBinding } from '../../src/data/operations/reconciliation';
import { publicKey } from '../../src/data/arkiv/envelope';
import { LIVE_CHAIN_ID, LiveSafetyError } from './safety';
import type { BudgetRecord } from './safety';
import type { FrozenAction } from './state';

export interface ConfirmedActionResult {
  operation: { confirmedKeys: PublicEntityKey[] };
  value?: { root: { key: PublicEntityKey } };
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireMatch(condition: unknown): asserts condition {
  if (!condition) throw new LiveSafetyError('CONFIRMED_ACTION_JOURNAL_MISMATCH');
}

/** Historical completion only. Call after this invocation authenticated the entire budget ledger. */
export function confirmedActionResult(action: FrozenAction, store: OperationStore, budget: BudgetRecord[]): ConfirmedActionResult | undefined {
  // Publication needs the writer's proposal/activation/fanout result, so it must re-enter normally.
  if (!action.confirmed || !['createProject', 'registerPublisher', 'replaceProject', 'replaceBook', 'publishProjectLink'].includes(action.method)) return undefined;
  const { operation: input, ...fields } = action.command;
  requireMatch(input.inputHash === hashCanonical(fields) && input.inputHash === hashCanonical(input.input));
  const records = store.list().filter(record => record.operation.id === input.id).sort((left, right) => left.revision - right.revision);
  const latest = records.at(-1)?.operation;
  const attempt = store.getAttempt(input.id);
  requireMatch(latest && latest.phase === 'complete' && latest.pendingPublisherRoots.length === 0
    && operationBinding(latest) === operationBinding(input) && attempt?.state === 'native-started'
    && operationBinding(attempt.operation) === operationBinding(input));
  requireMatch(inspectReconciliationJournal(input, latest, (operationId, stepId) => store.get(operationId, stepId), attempt).complete);
  requireMatch(records.length === latest.steps.length && same(attempt.nativeStepIds, latest.steps.map(step => step.id)));
  const ordered = latest.steps.map(step => records.find(record => record.step.id === step.id)!);
  const keys = ordered.flatMap(record => record.step.confirmedKeys);
  requireMatch(keys.length > 0 && new Set(keys).size === keys.length && same(keys, latest.confirmedKeys) && same(keys, action.confirmedKeys));
  const nativeRecords = budget.filter(record => record.kind === 'native' && record.id.startsWith(`${input.id}:`));
  requireMatch(nativeRecords.length === records.length);
  for (const record of ordered) {
    const native = nativeRecords.find(item => item.id === `${input.id}:${record.step.id}`);
    const request = record.admission?.request, receipt = record.receipt;
    requireMatch(same(record.operation, latest) && record.step.status === 'confirmed' && record.error === null
      && record.prepared && request && receipt && native?.status === 'confirmed' && native.signedTransaction && native.receipt?.status === 'success');
    requireMatch(same(record.prepared.batch, record.batch) && same(record.prepared.request, request)
      && record.step.inputHash === hashCanonical(record.batch) && same(receipt.entityKeys, record.step.confirmedKeys)
      && same(receipt.consumedKeys, record.batch.deletes ?? [])
      && receipt.entityKeys.length === (record.batch.creates?.length ?? 0) + (record.batch.extensions?.length ?? 0)
      && receipt.operationId === input.id && receipt.blockNumber === native.receipt.blockNumber
      && record.submissionHash === native.transactionHash && record.step.transactionHash === native.transactionHash
      && receipt.transactionHash === native.transactionHash && native.receipt.transactionHash === native.transactionHash);
    const plan = native.plan;
    requireMatch(input.authority.mode === 'public' && input.authority.chainId === LIVE_CHAIN_ID
      && plan.from === input.authority.actor.address.toLowerCase() && plan.from === request.from.toLowerCase()
      && plan.to === request.to.toLowerCase() && plan.data === request.data.toLowerCase() && plan.value === '0'
      && request.value === '0x0' && plan.chainId === LIVE_CHAIN_ID && BigInt(request.chainId) === BigInt(LIVE_CHAIN_ID)
      && request.gas && plan.gas === BigInt(request.gas).toString()
      && request.maxFeePerGas && plan.maxFeePerGas === BigInt(request.maxFeePerGas).toString()
      && request.maxPriorityFeePerGas && plan.maxPriorityFeePerGas === BigInt(request.maxPriorityFeePerGas).toString());
  }
  const result: ConfirmedActionResult = { operation: { confirmedKeys: keys.map(publicKey) } };
  if (action.method === 'createProject' || action.method === 'registerPublisher') {
    // The original proof creates its root in its first native step. Explicit-root
    // commands need the normal writer to reconstruct their richer result.
    if (fields.rootKey !== undefined) return undefined;
    const first = ordered[0]!;
    requireMatch(first.step.phase === 'root_pending' && first.step.confirmedKeys.length === 1 && first.batch.creates?.length === 1);
    const root = JSON.parse(first.batch.creates[0]!.payloadJson) as { entityType?: string };
    requireMatch(root.entityType === (action.method === 'createProject' ? 'project_root' : 'publisher_root'));
    result.value = { root: { key: publicKey(first.step.confirmedKeys[0]) } };
  }
  return result;
}
