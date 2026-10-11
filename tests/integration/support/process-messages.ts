import type { RpcRequest } from '../../../src/data/arkiv/client';
import type { StoredOperationStep } from '../../../src/data/operations';
import type { ExportPacket, OperationReceipt } from '../../../src/data/types';
import type { NativeTransactionRequest } from '../../../src/data/wallet';
import type { AccountAddress, PublicEntityKey } from '../../../src/domain/types';

export type ProcessRole = 'studio-read' | 'desk-withdraw' | 'cli-read';
export interface ProcessStart {
  kind: 'start'; role: ProcessRole; now: number; projectRoot: PublicEntityKey;
  publisherRoot: PublicEntityKey; account: AccountAddress;
}
export interface ProcessResult {
  pid: number; role: ProcessRole; packet: ExportPacket;
  ownPublisherRoots: string[]; walletMethods: string[]; storageKeys: string[]; fetchAttempts: number;
  receipt: OperationReceipt | null;
}
export type ParentMessage = ProcessStart | { kind: 'rpc-result'; id: number; now: number; value?: unknown; error?: string };
export type ChildMessage =
  | { kind: 'rpc'; id: number; request: Parameters<RpcRequest>[0] }
  | { kind: 'wallet'; id: number; request: NativeTransactionRequest; record: StoredOperationStep }
  | { kind: 'result'; result: ProcessResult }
  | { kind: 'failure'; message: string };
