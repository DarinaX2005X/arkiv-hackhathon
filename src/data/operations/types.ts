import type { TransactionHash } from '../../domain/types';
import type { OperationIntent, OperationReceipt, OperationStep, RepositoryErrorCode } from '../types';
import type { NativeBatch, NativeTransactionRequest, PreparedNativeBatch } from '../wallet/types';

export interface StoredOperationStep {
  version: 1;
  revision: number;
  operation: OperationIntent;
  step: OperationStep;
  batch: NativeBatch;
  prepared: PreparedNativeBatch | null;
  admission: { request: NativeTransactionRequest; at: number } | null;
  /** Kept even if a separately verified replacement supplies the eventual receipt. */
  submissionHash: TransactionHash | null;
  receipt: OperationReceipt | null;
  error: {
    kind: 'not_sent' | 'rejected' | 'unverified' | 'reverted'; code: RepositoryErrorCode;
    message: string; providerCode?: number;
  } | null;
}

export interface OperationStore {
  get(operationId: string, stepId: string): StoredOperationStep | undefined;
  list(): StoredOperationStep[];
  put(record: StoredOperationStep): void;
  putMany(records: StoredOperationStep[]): void;
  /** Non-queuing account lock. Browser implementation uses same-origin Web Locks. */
  runExclusive<T>(scope: string, action: () => Promise<T>): Promise<T>;
}

export interface OperationLockProvider {
  runExclusive<T>(scope: string, action: () => Promise<T>): Promise<T>;
}
