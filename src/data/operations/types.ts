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

/** A writer attempt exists before validation and never stands in for a native step. */
export interface StoredOperationAttempt {
  version: 1;
  revision: number;
  operation: OperationIntent;
  attemptId: string;
  state: 'preflight' | 'native-started' | 'rejected-before-native';
  nativeStepIds: string[];
  startedAt: number;
  settledAt: number | null;
}

export interface OperationStore {
  get(operationId: string, stepId: string): StoredOperationStep | undefined;
  list(): StoredOperationStep[];
  put(record: StoredOperationStep): void;
  putMany(records: StoredOperationStep[]): void;
  getAttempt(operationId: string): StoredOperationAttempt | undefined;
  /** Compare and swap under the short journal lock; null requires an absent record. */
  putAttemptCAS(record: StoredOperationAttempt, expectedRevision: number | null): void;
  /** Fails fast by default. Waiting is only for short journal writes, never wallet admission. */
  runExclusive<T>(scope: string, action: () => Promise<T>, options?: { wait?: boolean }): Promise<T>;
  /** Holds one operation across validation without blocking nested journal writes. */
  runOperationExclusive<T>(operationId: string, action: () => Promise<T>): Promise<T>;
}

export interface OperationLockProvider {
  /** A waiting caller must acquire the same lock after its current holder finishes. */
  runExclusive<T>(scope: string, action: () => Promise<T>, options?: { wait?: boolean }): Promise<T>;
}
