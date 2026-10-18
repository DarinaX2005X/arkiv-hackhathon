import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { OperationIntent, OperationReceipt, OperationStep } from '../types';
import type { NativeBatch, NativeTransactionOptions, NativeWalletGateway } from '../wallet/types';
import { WalletOperationError } from '../wallet/types';
import { assertOperationId } from './intent';
import { inspectReconciliationJournal, operationBinding as binding } from './reconciliation';
import type { OperationStore, StoredOperationAttempt, StoredOperationStep } from './types';

const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const error = (message: string, code: ConstructorParameters<typeof WalletOperationError>[1]['code'] = 'invalid_input') =>
  new WalletOperationError(message, { kind: 'not_sent', code });
const unresolvedAttempt = () => new WalletOperationError('The original operation attempt is incomplete. Retain its journal and reconcile before another attempt.', {
  kind: 'unverified', code: 'unverified',
});
function scope(operation: OperationIntent): string {
  if (operation.authority.mode !== 'public' || operation.authority.actor.kind !== 'wallet' || !/^0x[\da-fA-F]{40}$/.test(operation.authority.actor.address)) {
    throw error('A Tiramisu EOA authority is required.', 'unauthorized');
  }
  if (operation.authority.chainId !== TIRAMISU_CHAIN_ID) throw error('This operation requires Arkiv Tiramisu.', 'wrong_chain');
  return `${operation.authority.chainId}:${operation.authority.actor.address.toLowerCase()}`;
}
function syncStep(record: StoredOperationStep): void {
  const steps = record.operation.steps.filter(step => step.id !== record.step.id);
  record.operation.steps = [...steps, clone(record.step)];
}

export interface OperationController {
  /** The callback must throw validation/read failures; repository Result conversion stays outside. */
  withOperationAttempt<T>(operation: OperationIntent, action: () => Promise<T>): Promise<T>;
  /** Persist before any native preparation, including an outer adapter's unsigned estimate. */
  beforeNativeAttempt(operationId: string, step: OperationStep): Promise<void>;
  getAttempt(operationId: string): StoredOperationAttempt | undefined;
  /** Unsigned option resolution runs after the exact native step is saved and must never submit. */
  prepareStep(input: { operation: OperationIntent; step: OperationStep; batch: NativeBatch; transactionOptions?: NativeTransactionOptions },
    resolveTransactionOptions?: () => Promise<NativeTransactionOptions>): Promise<StoredOperationStep>;
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
  const activeAttempts = new Map<string, { attemptId: string; nativeBoundaryEntered: boolean; boundarySteps: Set<string> }>();
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
  const readOperation = (operationId: string): OperationIntent | undefined => {
    const records = store.list().filter(record => record.operation.id === operationId).sort((left, right) => left.revision - right.revision);
    const latest = records.at(-1);
    if (!latest) return undefined;
    const operation = clone(latest.operation);
    const steps = new Map(operation.steps.map(step => [step.id, step]));
    for (const record of records) steps.set(record.step.id, clone(record.step));
    operation.steps = [...steps.values()];
    operation.confirmedKeys = [...new Set([...operation.confirmedKeys, ...records.filter(record => record.step.status === 'confirmed').flatMap(record => record.step.confirmedKeys)])];
    return operation;
  };
  // Called only while holding the short journal lock. Native-started is sticky,
  // including when preparation fails before a StoredOperationStep can be written.
  const markNative = (operationId: string, step: OperationStep, operation?: OperationIntent) => {
    const attempt = store.getAttempt(operationId);
    if (!attempt) { if (operation) return; throw unresolvedAttempt(); }
    const frame = activeAttempts.get(operationId);
    if (operation && binding(operation) !== binding(attempt.operation)) throw error('This operation ID is already bound to different input.', 'conflict');
    if (frame && frame.attemptId !== attempt.attemptId) throw unresolvedAttempt();
    if (attempt.nativeStepIds.some(id => !store.get(operationId, id) && !frame?.boundarySteps.has(id))) throw unresolvedAttempt();
    const nativeStepIds = [...new Set([...attempt.nativeStepIds, step.id])];
    if (attempt.state !== 'native-started' || nativeStepIds.length !== attempt.nativeStepIds.length) {
      store.putAttemptCAS({ ...attempt, revision: attempt.revision + 1, state: 'native-started', nativeStepIds, settledAt: null }, attempt.revision);
    }
    frame?.boundarySteps.add(step.id);
  };

  return {
    async withOperationAttempt(operationInput, action) {
      const operation = clone(operationInput);
      assertOperationId(operation.id); const accountScope = scope(operation);
      if (operation.inputHash !== hashCanonical(operation.input)) throw error('The operation input hash does not match its input.');
      return store.runOperationExclusive(operation.id, async () => {
        const attempt = await store.runExclusive(accountScope, async () => {
          const current = store.getAttempt(operation.id);
          const saved = readOperation(operation.id);
          if (current && binding(current.operation) !== binding(operation)) throw error('This operation ID is already bound to different input.', 'conflict');
          if (current?.state === 'preflight') throw unresolvedAttempt();
          if (current?.state === 'native-started') {
            if (!inspectReconciliationJournal(operation, saved, store.get.bind(store), current).complete) throw unresolvedAttempt();
            return current;
          }
          if (current && saved) throw unresolvedAttempt();
          if (saved && !inspectReconciliationJournal(operation, saved, store.get.bind(store)).complete) throw unresolvedAttempt();
          if (!saved && (operation.phase !== 'prepared' || operation.steps.length > 0 || operation.transactionHash || operation.confirmedKeys.length > 0)) throw unresolvedAttempt();
          const next: StoredOperationAttempt = {
            version: 1, revision: (current?.revision ?? 0) + 1, operation, attemptId: globalThis.crypto.randomUUID(),
            state: saved ? 'native-started' : 'preflight', nativeStepIds: saved?.steps.map(step => step.id) ?? [], startedAt: now(), settledAt: null,
          };
          store.putAttemptCAS(next, current?.revision ?? null);
          return next;
        });
        const frame = { attemptId: attempt.attemptId, nativeBoundaryEntered: attempt.state === 'native-started', boundarySteps: new Set<string>() };
        activeAttempts.set(operation.id, frame);
        try {
          const result = await action();
          if (result && typeof result === 'object' && 'ok' in result && result.ok === false) throw error('Operation attempt callbacks must throw failures before repository result conversion.');
          return result;
        } catch (caught) {
          if (!frame.nativeBoundaryEntered) {
            try {
              // Another operation may hold the journal during unsigned preparation or a
              // wallet prompt. Finishing this failed read must wait for that lock without
              // queuing a send or leaving a known no-send attempt permanently unresolved.
              await store.runExclusive(accountScope, async () => {
                const current = store.getAttempt(operation.id);
                if (!current || current.attemptId !== frame.attemptId || current.state !== 'preflight'
                  || current.nativeStepIds.length || store.list().some(record => record.operation.id === operation.id)) throw unresolvedAttempt();
                store.putAttemptCAS({ ...current, revision: current.revision + 1, state: 'rejected-before-native', settledAt: Math.max(now(), current.startedAt) }, current.revision);
              }, { wait: true });
            } catch (checkpointFailure) {
              throw new WalletOperationError('The failed operation could not be checkpointed. Retain its journal before trying again.', {
                kind: 'unverified', code: checkpointFailure instanceof WalletOperationError ? checkpointFailure.code : 'storage',
                cause: new AggregateError([caught, checkpointFailure], 'Preflight and journal settlement failed.'),
              });
            }
          }
          throw caught;
        } finally { activeAttempts.delete(operation.id); }
      });
    },
    async beforeNativeAttempt(operationId, step) {
      assertOperationId(operationId); assertOperationId(step.id);
      const frame = activeAttempts.get(operationId);
      const attempt = store.getAttempt(operationId);
      if (!attempt) throw unresolvedAttempt();
      await store.runExclusive(scope(attempt.operation), async () => {
        if (frame) frame.nativeBoundaryEntered = true;
        markNative(operationId, step);
      });
    },
    getAttempt: operationId => store.getAttempt(operationId),
    async prepareStep(input, resolveTransactionOptions) {
      const frozen = clone(input);
      const { operation, step, batch } = frozen;
      assertOperationId(operation.id); assertOperationId(step.id);
      const accountScope = scope(operation);
      if (operation.inputHash !== hashCanonical(operation.input)) throw error('The operation input hash does not match its input.');
      const frame = activeAttempts.get(operation.id);
      let entered = false;
      try { return await store.runExclusive(accountScope, async () => {
        entered = true;
        if (frame) frame.nativeBoundaryEntered = true;
        markNative(operation.id, step, operation);
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
          const transactionOptions = resolveTransactionOptions ? clone(await resolveTransactionOptions()) : frozen.transactionOptions;
          record.prepared = await gateway.prepare(batch, operation.authority.actor.address, transactionOptions);
          save(record);
          return clone(record);
        } catch (caught) {
          const failure = caught instanceof WalletOperationError ? caught : new WalletOperationError('The transaction could not be prepared.', { kind: 'not_sent', code: 'network', cause: caught });
          record.step.status = 'failed-before-send';
          record.error = { kind: 'not_sent', code: failure.code, message: failure.message };
          save(record);
          throw failure;
        }
      }); } catch (caught) {
        // beforeNativeAttempt can have saved this step just before another operation
        // acquired the account lock. No unsigned preparation ran in this call. Retain
        // that observed refusal as a native no-send checkpoint instead of stranding a
        // native-started marker with no step. Existing send evidence is never replaced.
        if (!entered && frame?.boundarySteps.has(step.id) && caught instanceof WalletOperationError
          && caught.kind === 'not_sent' && caught.code === 'conflict') {
          try {
            await store.runExclusive(accountScope, async () => {
              const attempt = store.getAttempt(operation.id);
              if (!attempt || attempt.attemptId !== frame.attemptId || attempt.state !== 'native-started'
                || !attempt.nativeStepIds.includes(step.id) || binding(attempt.operation) !== binding(operation)) throw unresolvedAttempt();
              if (store.get(operation.id, step.id)) return;
              save({ version: 1, revision: 1, operation,
                step: { ...step, status: 'failed-before-send', transactionHash: null, confirmedKeys: [] },
                batch, prepared: null, admission: null, submissionHash: null, receipt: null,
                error: { kind: 'not_sent', code: caught.code, message: caught.message } });
            }, { wait: true });
          } catch (checkpointFailure) {
            throw new WalletOperationError('The preparation refusal could not be checkpointed. Retain its journal before trying again.', {
              kind: 'unverified', code: checkpointFailure instanceof WalletOperationError ? checkpointFailure.code : 'storage',
              cause: new AggregateError([caught, checkpointFailure], 'Preparation admission and journal settlement failed.'),
            });
          }
        }
        throw caught;
      }
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
    getOperation: readOperation,
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
