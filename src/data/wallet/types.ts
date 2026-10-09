import type { AccountAddress, ChainId, DecimalString, PublicEntityKey, TransactionHash } from '../../domain/types';
import type { RepositoryErrorCode } from '../types';

export interface RpcRequest { method: string; params?: readonly unknown[] }
export interface RpcRequester { request(request: RpcRequest): Promise<unknown> }
export interface InjectedWalletProvider extends RpcRequester {
  on?(event: 'accountsChanged' | 'chainChanged' | 'disconnect', listener: (...args: unknown[]) => void): void;
  removeListener?(event: 'accountsChanged' | 'chainChanged' | 'disconnect', listener: (...args: unknown[]) => void): void;
}
export type NativeAttribute =
  | { type: 'str'; value: string }
  | { type: 'i32'; value: number }
  | { type: 'u64'; value: DecimalString }
  | { type: 'key' | 'bytes32'; value: `0x${string}` };
export interface NativeBatch {
  creates?: {
    payloadJson: string; attributes: Record<string, NativeAttribute>;
    lifetimeSeconds: number; salt: DecimalString;
  }[];
  deletes?: PublicEntityKey[];
  extensions?: { entityKey: PublicEntityKey; expiresAtBlock: DecimalString }[];
}
export interface NativeTransactionOptions {
  gas?: DecimalString; gasPrice?: DecimalString;
  maxFeePerGas?: DecimalString; maxPriorityFeePerGas?: DecimalString;
}
export interface NativeTransactionRequest {
  from: AccountAddress; to: AccountAddress; data: `0x${string}`;
  value: '0x0'; chainId: `0x${string}`;
  gas?: `0x${string}`; gasPrice?: `0x${string}`;
  maxFeePerGas?: `0x${string}`; maxPriorityFeePerGas?: `0x${string}`;
}
export interface PreparedNativeBatch {
  batch: NativeBatch; account: AccountAddress; chainId: ChainId;
  transactionOptions: NativeTransactionOptions; request: NativeTransactionRequest;
  estimatedGas: DecimalString; preparedAtBlock: DecimalString;
  estimatedCostWei: DecimalString | null;
  /** Non-null only when BOTH a gas limit and per-gas price/cap were explicitly frozen. */
  estimatedMaximumCostWei: DecimalString | null;
  estimatePolicy: 'explicit-cap' | 'estimate-only' | 'gas-only';
}
export interface SendHooks {
  onAdmission(request: NativeTransactionRequest): void | Promise<void>;
  onHash(hash: TransactionHash): void | Promise<void>;
}
export interface NativeWalletGateway {
  prepare(batch: NativeBatch, account: AccountAddress, options?: NativeTransactionOptions): Promise<PreparedNativeBatch>;
  submit(prepared: PreparedNativeBatch, hooks: SendHooks): Promise<{ status: 'submitted'; transactionHash: TransactionHash }>;
  dispose(): void;
}
export class WalletOperationError extends Error {
  readonly kind: 'not_sent' | 'rejected' | 'unverified' | 'reverted';
  readonly code: RepositoryErrorCode;
  readonly providerCode?: number;
  readonly transactionHash?: TransactionHash;
  constructor(message: string, details: {
    kind: 'not_sent' | 'rejected' | 'unverified' | 'reverted'; code: RepositoryErrorCode;
    providerCode?: number; transactionHash?: TransactionHash; cause?: unknown;
  }) {
    super(message, { cause: details.cause });
    this.name = 'WalletOperationError';
    this.kind = details.kind; this.code = details.code;
    this.providerCode = details.providerCode; this.transactionHash = details.transactionHash;
  }
}
