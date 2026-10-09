import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { OperationIntent, OperationReceipt, OperationStep } from '../types';
import type { NativeBatch, NativeTransactionOptions, NativeWalletGateway } from '../wallet/types';
import { WalletOperationError } from '../wallet/types';
import { assertOperationId } from './intent';
import type { OperationStore, StoredOperationStep } from './types';

const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const error = (message: string, code: ConstructorParameters<typeof WalletOperationError>[1]['code'] = 'invalid_input') =>
  new WalletOperationError(message, { kind: 'not_sent', code });
const binding = (operation: OperationIntent) => canonicalJson({
  id: operation.id, kind: operation.kind, authority: operation.authority,
  input: operation.input, inputHash: operation.inputHash, expectedHeads: operation.expectedHeads,
});
function scope(operation: OperationIntent): string {
  if (operation.authority.mode !== 'public' || operation.authority.chainId !== TIRAMISU_CHAIN_ID
    || operation.authority.actor.kind !== 'wallet' || !/^0x[\da-fA-F]{40}$/.test(operation.authority.actor.address)) {
    throw error('A Tiramisu EOA authority is required.', 'unauthorized');
  }
  return `${operation.authority.chainId}:${operation.authority.actor.address.toLowerCase()}`;
}
function syncStep(record: StoredOperationStep): void {
  const steps = record.operation.steps.filter(step => step.id !== record.step.id);
  record.operation.steps = [...steps, clone(record.step)];
}

export interface OperationController {
  prepareStep(input: { operation: OperationIntent; step: OperationStep; batch: NativeBatch; transactionOptions?: NativeTransactionOptions }): Promise<StoredOperationStep>;
  submitStep(operationId: string, stepId: string): Promise<StoredOperationStep>;
  getStep(operationId: string, stepId: string): StoredOperationStep | undefined;
  getOperation(operationId: string): OperationIntent | undefined;
  listPending(): StoredOperationStep[];
  /** Caller must authenticate the official RPC transaction, receipt and domain readback first. */
  markConfirmed(operationId: string, stepId: string, receipt: OperationReceipt): Promise<StoredOperationStep>;
  markReverted(operationId: string, stepId: string, receipt: OperationReceipt): Promise<StoredOperationStep>;
  updateOperation(operation: OperationIntent): Promise<void>;
  subscribe(listener: (record: StoredOperationStep) => void): () => void;
}

export function createOperationController(options: {
  store: OperationStore; gateway: NativeWalletGateway; now?: () => number;
}): OperationController {
  const { store, gateway } = options;
  const now = options.now ?? Date.now;
  const listeners = new Set<(record: StoredOperationStep) => void>();
  const notify = (record: StoredOperationStep) => {
    for (const listener of listeners) { try { listener(clone(record)); } catch { /* A view cannot alter admission. */ } }
  };
  const nextRevision = (operationId: string) => Math.max(0, ...store.list().filter(record => record.operation.id === operationId).map(record => record.revision)) + 1;
  const save = (record: StoredOperationStep) => { syncStep(record); record.revision = nextRevision(record.operation.id); store.put(record); notify(record); };
  const requireStep = (operationId: string, stepId: string) => {
    const record = store.get(operationId, stepId);
    if (!record) throw error('The prepared operation step was not found.', 'not_found');
    return record;
  };

  return {
    async prepareStep(input) {
      const frozen = clone(input);
      const { operation, step, batch } = frozen;
      assertOperationId(operation.id); assertOperationId(step.id);
      const accountScope = scope(operation);
      if (operation.inputHash !== hashCanonical(operation.input)) throw error('The operation input hash does not match its input.');
      return store.runExclusive(accountScope, async () => {
        const existing = store.get(operation.id, step.id);
        if (existing) {
          if (binding(existing.operation) !== binding(operation)
            || existing.step.inputHash !== step.inputHash
            || canonicalJson(existing.step.expectedHeads) !== canonicalJson(step.expectedHeads)
            || canonicalJson(existing.batch) !== canonicalJson(batch)
            || (existing.prepared && canonicalJson(existing.prepared.transactionOptions) !== canonicalJson(frozen.transactionOptions ?? {}))) {
            throw error('This operation ID is already bound to different input.', 'conflict');
          }
          if (existing.step.status !== 'failed-before-send'
            && !(existing.step.status === 'prepared' && existing.prepared === null && existing.admission === null)) return existing;
        } else if (step.status !== 'prepared' || step.transactionHash !== null || step.confirmedKeys.length > 0) {
          throw error('A new operation step must start prepared with no transaction.');
        }
        for (const saved of store.list().filter(saved => saved.operation.id === operation.id)) {
          if (binding(saved.operation) !== binding(operation)) throw error('This operation ID is already bound to different input.', 'conflict');
        }
        const record: StoredOperationStep = {
          version: 1, revision: 1, operation, step: { ...step, status: 'prepared', transactionHash: null, confirmedKeys: [] },
          batch, prepared: null, admission: null, submissionHash: null, receipt: null, error: null,
        };
        save(record);
        try {
          if (operation.authority.mode !== 'public') throw error('A public wallet is required.');
          record.prepared = await gateway.prepare(batch, operation.authority.actor.address, frozen.transactionOptions);
          save(record);
          return clone(record);
        } catch (caught) {
          const failure = caught instanceof WalletOperationError ? caught : new WalletOperationError('The transaction could not be prepared.', { kind: 'not_sent', code: 'network', cause: caught });
          record.step.status = 'failed-before-send';
          record.error = { kind: 'not_sent', code: failure.code, message: failure.message };
          save(record);
          throw failure;
        }
      });
    },

    async submitStep(operationId, stepId) {
      const initial = requireStep(operationId, stepId);
      return store.runExclusive(scope(initial.operation), async () => {
        const record = requireStep(operationId, stepId);
        if (record.step.status === 'confirmed' || record.step.status === 'submitted') return record;
        if (record.step.status === 'reverted') throw new WalletOperationError('This transaction reverted. Prepare a new corrected operation to continue.', { kind: 'reverted', code: 'reverted', transactionHash: record.step.transactionHash ?? undefined });
        if (record.step.status === 'unverified' || record.admission !== null) {
          throw new WalletOperationError('Reconcile this operation before any further submission.', {
            kind: 'unverified', code: 'unverified', transactionHash: record.submissionHash ?? undefined,
          });
        }
        if (!record.prepared || record.step.status !== 'prepared') throw error('Prepare this operation before asking the wallet.');
        const blocker = store.list().find(other => scope(other.operation) === scope(record.operation)
          && !(other.operation.id === operationId && other.step.id === stepId)
          && (other.step.status === 'submitted' || other.step.status === 'unverified'));
        if (blocker) throw new WalletOperationError('Another transaction from this wallet still needs verification.', { kind: 'unverified', code: 'unverified', transactionHash: blocker.submissionHash ?? undefined });
        let admitted = false;
        try {
          await gateway.submit(record.prepared, {
            onAdmission(request) {
              record.admission = { request: clone(request), at: now() };
              record.step.status = 'unverified'; record.error = null;
              save(record);
              admitted = true;
            },
            onHash(hash) {
              record.submissionHash = hash;
              record.step.transactionHash = hash; record.operation.transactionHash = hash;
              record.step.status = 'submitted';
              save(record);
            },
          });
          return clone(record);
        } catch (caught) {
          const failure = caught instanceof WalletOperationError ? caught : new WalletOperationError(admitted ? 'The transaction needs verification.' : 'The transaction was not sent.', {
            kind: admitted ? 'unverified' : 'not_sent', code: admitted ? 'unverified' : 'network', cause: caught,
          });
          record.step.status = failure.kind === 'unverified' ? 'unverified' : 'failed-before-send';
          if (failure.transactionHash) {
            record.submissionHash = failure.transactionHash; record.step.transactionHash = failure.transactionHash;
            record.operation.transactionHash = failure.transactionHash;
          }
          record.error = {
            kind: failure.kind, code: failure.code, message: failure.message,
            ...(failure.providerCode === undefined ? {} : { providerCode: failure.providerCode }),
          };
          try { save(record); }
          catch (checkpointFailure) {
            throw new WalletOperationError(admitted ? 'The send checkpoint could not be saved. Reconcile before continuing.' : 'The operation journal could not be saved. Nothing was sent.', {
              kind: admitted ? 'unverified' : 'not_sent', code: 'storage', transactionHash: record.submissionHash ?? undefined, cause: checkpointFailure,
            });
          }
          throw failure;
        }
      });
    },

    getStep: (operationId, stepId) => store.get(operationId, stepId),
    getOperation(operationId) {
      const records = store.list().filter(record => record.operation.id === operationId).sort((left, right) => left.revision - right.revision);
      const latest = records.at(-1);
      if (!latest) return undefined;
      const operation = clone(latest.operation);
      const steps = new Map(operation.steps.map(step => [step.id, step]));
      for (const record of records) steps.set(record.step.id, clone(record.step));
      operation.steps = [...steps.values()];
      operation.confirmedKeys = [...new Set([...operation.confirmedKeys, ...records.filter(record => record.step.status === 'confirmed').flatMap(record => record.step.confirmedKeys)])];
      return operation;
    },
    listPending: () => store.list().filter(record => record.step.status !== 'confirmed' && record.step.status !== 'reverted'),

    async markConfirmed(operationId, stepId, receiptInput) {
      const receipt = clone(receiptInput);
      const initial = requireStep(operationId, stepId);
      return store.runExclusive(scope(initial.operation), async () => {
        const record = requireStep(operationId, stepId);
        if (record.step.status === 'reverted') throw error('A reverted step cannot become confirmed.', 'conflict');
        if (receipt.operationId !== operationId || !receipt.transactionHash || !/^0x[\da-fA-F]{64}$/.test(receipt.transactionHash)) {
          throw error('The verified receipt must identify this operation and a transaction.');
        }
        if (!record.admission) throw error('An operation without send admission cannot be confirmed.');
        if (record.receipt && canonicalJson(record.receipt) !== canonicalJson(receipt)) throw error('This step already has a different confirmed receipt.', 'conflict');
        record.receipt = receipt;
        record.step.status = 'confirmed'; record.step.transactionHash = receipt.transactionHash;
        record.step.confirmedKeys = [...receipt.entityKeys]; record.error = null;
        record.operation.transactionHash = receipt.transactionHash;
        record.operation.confirmedKeys = [...new Set([...record.operation.confirmedKeys, ...receipt.entityKeys])];
        save(record);
        return clone(record);
      });
    },

    async markReverted(operationId, stepId, receiptInput) {
      const receipt = clone(receiptInput);
      const initial = requireStep(operationId, stepId);
      return store.runExclusive(scope(initial.operation), async () => {
        const record = requireStep(operationId, stepId);
        if (receipt.operationId !== operationId || !receipt.transactionHash || !/^0x[\da-fA-F]{64}$/.test(receipt.transactionHash)
          || receipt.entityKeys.length || receipt.consumedKeys.length) throw error('A reverted receipt must identify this operation and contain no applied entity changes.');
        if (!record.admission || record.step.status === 'confirmed') throw error('This step cannot be marked reverted.', 'conflict');
        if (record.receipt && canonicalJson(record.receipt) !== canonicalJson(receipt)) throw error('This step already has a different verified receipt.', 'conflict');
        record.receipt = receipt;
        record.step.status = 'reverted'; record.step.transactionHash = receipt.transactionHash;
        record.step.confirmedKeys = [];
        record.operation.transactionHash = receipt.transactionHash;
        record.error = { kind: 'reverted', code: 'reverted', message: 'The transaction reverted. No entity changes were applied; gas may have been spent.' };
        save(record);
        return clone(record);
      });
    },

    async updateOperation(operationInput) {
      const operation = clone(operationInput);
      await store.runExclusive(scope(operation), async () => {
        const records = store.list().filter(record => record.operation.id === operation.id);
        for (const record of records) {
          if (binding(record.operation) !== binding(operation)) throw error('Operation progress cannot change its frozen input.', 'conflict');
        }
        const steps = new Map(operation.steps.map(step => [step.id, step]));
        for (const record of records) steps.set(record.step.id, record.step);
        operation.steps = [...steps.values()].map(clone);
        const revision = nextRevision(operation.id);
        for (const record of records) { record.operation = clone(operation); record.revision = revision; }
        store.putMany(records);
        for (const record of records) notify(record);
      });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
