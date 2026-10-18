import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { WalletOperationError } from '../wallet/types';
import { assertOperationId } from './intent';
import { operationBinding } from './reconciliation';
import type { OperationLockProvider, OperationStore, StoredOperationAttempt, StoredOperationStep } from './types';

export const DEFAULT_OPERATION_STORAGE_KEY = 'partfolk:wallet-operations:v1';
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const identity = (operationId: string, stepId: string) => JSON.stringify([operationId, stepId]);
const storageError = (cause?: unknown) => new WalletOperationError('The saved operation journal is unavailable or invalid. Existing data was preserved.', {
  kind: 'not_sent', code: 'storage', cause,
});
const busy = () => new WalletOperationError('Another operation for this wallet is in progress.', { kind: 'not_sent', code: 'conflict' });

function validateRecord(value: unknown): StoredOperationStep {
  try {
    if (!value || typeof value !== 'object') throw new Error('Invalid record.');
    const record = value as StoredOperationStep;
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1 || !record.operation || !record.step || !record.batch
      || !('admission' in record) || !('prepared' in record) || !('receipt' in record) || !('submissionHash' in record)) throw new Error('Invalid version or fields.');
    assertOperationId(record.operation.id); assertOperationId(record.step.id);
    const authority = record.operation.authority;
    if (authority?.mode !== 'public' || authority.chainId !== TIRAMISU_CHAIN_ID || authority.actor?.kind !== 'wallet'
      || !/^0x[\da-fA-F]{40}$/.test(authority.actor.address)) throw new Error('Invalid authority.');
    if (record.operation.inputHash !== hashCanonical(record.operation.input)
      || !Array.isArray(record.operation.steps) || !Array.isArray(record.step.expectedHeads)
      || !Array.isArray(record.step.confirmedKeys) || !/^0x[\da-fA-F]{64}$/.test(record.step.inputHash)
      || !['prepared', 'submitted', 'confirmed', 'unverified', 'failed-before-send', 'reverted'].includes(record.step.status)) throw new Error('Invalid step.');
    if (record.prepared !== null && (
      record.prepared.chainId !== authority.chainId
      || record.prepared.account.toLowerCase() !== authority.actor.address.toLowerCase()
      || canonicalJson(record.prepared.batch) !== canonicalJson(record.batch))) throw new Error('Prepared input changed.');
    if (record.admission !== null && (!record.prepared
      || canonicalJson(record.admission.request) !== canonicalJson(record.prepared.request)
      || !Number.isSafeInteger(record.admission.at))) throw new Error('Invalid send admission.');
    for (const hash of [record.submissionHash, record.step.transactionHash]) {
      if (hash !== null && !/^0x[\da-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    }
    if (record.step.status === 'submitted' && (!record.admission || !record.submissionHash || !record.step.transactionHash)) throw new Error('Missing submitted evidence.');
    if ((record.step.status === 'confirmed' || record.step.status === 'reverted') && (!record.receipt || !record.step.transactionHash)) throw new Error('Missing verified receipt.');
    return clone(record);
  } catch (error) { throw storageError(error); }
}

function validateAttempt(value: unknown): StoredOperationAttempt {
  try {
    if (!value || typeof value !== 'object') throw new Error('Invalid attempt.');
    const record = value as StoredOperationAttempt;
    const authority = record.operation?.authority;
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0
      || !Number.isSafeInteger(record.operation?.createdAt) || record.operation.createdAt < 0
      || authority?.mode !== 'public' || authority.chainId !== TIRAMISU_CHAIN_ID || authority.actor?.kind !== 'wallet'
      || !/^0x[\da-fA-F]{40}$/.test(authority.actor.address)
      || record.operation.inputHash !== hashCanonical(record.operation.input)
      || !Array.isArray(record.operation.steps) || !Array.isArray(record.operation.expectedHeads)
      || !Array.isArray(record.nativeStepIds) || new Set(record.nativeStepIds).size !== record.nativeStepIds.length) throw new Error('Invalid attempt fields.');
    assertOperationId(record.operation.id); assertOperationId(record.attemptId);
    record.nativeStepIds.forEach(assertOperationId);
    if (!['preflight', 'native-started', 'rejected-before-native'].includes(record.state)
      || (record.state === 'native-started') !== (record.nativeStepIds.length > 0)
      || (record.state === 'rejected-before-native'
        ? !Number.isSafeInteger(record.settledAt) || record.settledAt! < record.startedAt
        : record.settledAt !== null)) throw new Error('Invalid attempt state.');
    return clone(record);
  } catch (error) { throw storageError(error); }
}

function checkAttemptRevision(record: StoredOperationAttempt, current: StoredOperationAttempt | undefined, expectedRevision: number | null): void {
  if ((current?.revision ?? null) !== expectedRevision || record.revision !== (expectedRevision ?? 0) + 1) throw busy();
  if (current && operationBinding(record.operation) !== operationBinding(current.operation)) throw storageError();
  if (current?.state === 'native-started' && (record.state !== 'native-started' || record.attemptId !== current.attemptId
    || current.nativeStepIds.some(id => !record.nativeStepIds.includes(id)))) throw storageError();
}

interface JournalDocument {
  version: 1;
  records: Record<string, StoredOperationStep>;
  attempts: Record<string, StoredOperationAttempt>;
}

export class MemoryOperationStore implements OperationStore {
  private records = new Map<string, StoredOperationStep>();
  private attempts = new Map<string, StoredOperationAttempt>();
  private active = new Set<string>();
  private waiters = new Map<string, (() => void)[]>();
  get(operationId: string, stepId: string): StoredOperationStep | undefined {
    const value = this.records.get(identity(operationId, stepId));
    return value === undefined ? undefined : clone(value);
  }
  list(): StoredOperationStep[] { return [...this.records.values()].map(clone); }
  put(record: StoredOperationStep): void { this.putMany([record]); }
  putMany(records: StoredOperationStep[]): void {
    const checked = records.map(validateRecord);
    for (const record of checked) this.records.set(identity(record.operation.id, record.step.id), record);
  }
  getAttempt(operationId: string): StoredOperationAttempt | undefined {
    const value = this.attempts.get(operationId);
    return value === undefined ? undefined : clone(value);
  }
  putAttemptCAS(input: StoredOperationAttempt, expectedRevision: number | null): void {
    const record = validateAttempt(input);
    checkAttemptRevision(record, this.attempts.get(record.operation.id), expectedRevision);
    this.attempts.set(record.operation.id, record);
  }
  runOperationExclusive<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    assertOperationId(operationId);
    return this.runExclusive(`operation:${operationId}`, action);
  }
  async runExclusive<T>(scope: string, action: () => Promise<T>, options: { wait?: boolean } = {}): Promise<T> {
    if (this.active.has(scope)) {
      if (!options.wait) throw busy();
      await new Promise<void>(resolve => {
        const waiting = this.waiters.get(scope) ?? [];
        waiting.push(resolve); this.waiters.set(scope, waiting);
      });
    } else this.active.add(scope);
    try { return await action(); }
    finally {
      const waiting = this.waiters.get(scope), next = waiting?.shift();
      if (!waiting?.length) this.waiters.delete(scope);
      // Keep ownership assigned while the next queued callback resumes.
      if (next) next(); else this.active.delete(scope);
    }
  }
}

/** One JSON document, no signing keys. Failed parsing/version/quota never clears stored data. */
export class BrowserOperationStore implements OperationStore {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  private readonly key: string;
  private readonly lockKey?: string;
  private readonly locks?: OperationLockProvider;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'>, options: { key?: string; lockKey?: string; locks?: OperationLockProvider } = {}) {
    this.storage = storage; this.key = options.key ?? DEFAULT_OPERATION_STORAGE_KEY;
    this.lockKey = options.lockKey; this.locks = options.locks;
  }
  private read(): JournalDocument {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return { version: 1, records: {}, attempts: {} };
      const document = JSON.parse(raw) as { version?: unknown; records?: unknown; attempts?: unknown };
      if (document.version !== 1 || !document.records || typeof document.records !== 'object' || Array.isArray(document.records)) throw new Error('Unsupported journal version.');
      const records: Record<string, StoredOperationStep> = {};
      for (const [id, value] of Object.entries(document.records)) {
        const record = validateRecord(value);
        if (id !== identity(record.operation.id, record.step.id)) throw new Error('Journal identity mismatch.');
        records[id] = record;
      }
      const attempts: Record<string, StoredOperationAttempt> = {};
      if (document.attempts !== undefined) {
        if (!document.attempts || typeof document.attempts !== 'object' || Array.isArray(document.attempts)) throw new Error('Invalid attempt journal.');
        for (const [id, value] of Object.entries(document.attempts)) {
          const attempt = validateAttempt(value);
          if (id !== attempt.operation.id) throw new Error('Attempt identity mismatch.');
          Object.defineProperty(attempts, id, { value: attempt, enumerable: true, writable: true, configurable: true });
        }
      }
      return { version: 1, records, attempts };
    } catch (error) { if (error instanceof WalletOperationError) throw error; throw storageError(error); }
  }
  get(operationId: string, stepId: string): StoredOperationStep | undefined { return this.read().records[identity(operationId, stepId)]; }
  list(): StoredOperationStep[] { return Object.values(this.read().records); }
  put(record: StoredOperationStep): void { this.putMany([record]); }
  putMany(records: StoredOperationStep[]): void {
    const checked = records.map(validateRecord);
    const document = this.read();
    for (const record of checked) document.records[identity(record.operation.id, record.step.id)] = record;
    this.write(document);
  }
  getAttempt(operationId: string): StoredOperationAttempt | undefined {
    const attempts = this.read().attempts;
    return Object.hasOwn(attempts, operationId) ? attempts[operationId] : undefined;
  }
  putAttemptCAS(input: StoredOperationAttempt, expectedRevision: number | null): void {
    const record = validateAttempt(input); const document = this.read();
    const current = Object.hasOwn(document.attempts, record.operation.id) ? document.attempts[record.operation.id] : undefined;
    checkAttemptRevision(record, current, expectedRevision);
    Object.defineProperty(document.attempts, record.operation.id, { value: record, enumerable: true, writable: true, configurable: true });
    this.write(document);
  }
  private write(document: JournalDocument): void {
    try { this.storage.setItem(this.key, canonicalJson(document)); }
    catch (error) { throw storageError(error); }
  }
  async runExclusive<T>(scope: string, action: () => Promise<T>, options: { wait?: boolean } = {}): Promise<T> {
    // The document contains several accounts, so its read/merge/write needs one store-wide lock.
    const name = this.lockKey ?? `${this.key}:journal`;
    return this.lock(name, action, options);
  }
  runOperationExclusive<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    assertOperationId(operationId);
    return this.lock(`${this.lockKey ?? `${this.key}:journal`}:${this.key}:operation:${operationId}`, action);
  }
  private async lock<T>(name: string, action: () => Promise<T>, options: { wait?: boolean } = {}): Promise<T> {
    if (this.locks) return this.locks.runExclusive(name, action, options);
    const locks = globalThis.navigator?.locks;
    if (!locks) throw new WalletOperationError('This browser cannot safely coordinate wallet operations across tabs.', { kind: 'not_sent', code: 'unsupported' });
    return locks.request(name, { mode: 'exclusive', ...(options.wait ? {} : { ifAvailable: true }) }, async lock => {
      if (!lock) throw busy();
      return action();
    });
  }
}
