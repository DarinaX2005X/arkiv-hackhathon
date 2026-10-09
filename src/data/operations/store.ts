import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { WalletOperationError } from '../wallet/types';
import { assertOperationId } from './intent';
import type { OperationLockProvider, OperationStore, StoredOperationStep } from './types';

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

export class MemoryOperationStore implements OperationStore {
  private records = new Map<string, StoredOperationStep>();
  private active = new Set<string>();
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
  async runExclusive<T>(scope: string, action: () => Promise<T>): Promise<T> {
    if (this.active.has(scope)) throw busy();
    this.active.add(scope);
    try { return await action(); } finally { this.active.delete(scope); }
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
  private read(): Record<string, StoredOperationStep> {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return {};
      const document = JSON.parse(raw) as { version?: unknown; records?: unknown };
      if (document.version !== 1 || !document.records || typeof document.records !== 'object' || Array.isArray(document.records)) throw new Error('Unsupported journal version.');
      const records: Record<string, StoredOperationStep> = {};
      for (const [id, value] of Object.entries(document.records)) {
        const record = validateRecord(value);
        if (id !== identity(record.operation.id, record.step.id)) throw new Error('Journal identity mismatch.');
        records[id] = record;
      }
      return records;
    } catch (error) { if (error instanceof WalletOperationError) throw error; throw storageError(error); }
  }
  get(operationId: string, stepId: string): StoredOperationStep | undefined { return this.read()[identity(operationId, stepId)]; }
  list(): StoredOperationStep[] { return Object.values(this.read()); }
  put(record: StoredOperationStep): void { this.putMany([record]); }
  putMany(records: StoredOperationStep[]): void {
    const checked = records.map(validateRecord);
    const document = this.read();
    for (const record of checked) document[identity(record.operation.id, record.step.id)] = record;
    try { this.storage.setItem(this.key, canonicalJson({ version: 1, records: document })); }
    catch (error) { throw storageError(error); }
  }
  async runExclusive<T>(scope: string, action: () => Promise<T>): Promise<T> {
    // The document contains several accounts, so its read/merge/write needs one store-wide lock.
    const name = this.lockKey ?? `${this.key}:journal`;
    if (this.locks) return this.locks.runExclusive(name, action);
    const locks = globalThis.navigator?.locks;
    if (!locks) throw new WalletOperationError('This browser cannot safely coordinate wallet operations across tabs.', { kind: 'not_sent', code: 'unsupported' });
    return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw busy();
      return action();
    });
  }
}
