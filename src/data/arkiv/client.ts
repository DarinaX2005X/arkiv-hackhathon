import { createPublicClient } from '@arkiv-network/sdk';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { custom, http } from 'viem';
import type { EIP1193RequestFn } from 'viem';
import { ArkivRepositoryError } from './errors';

export const OFFICIAL_RPC = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network';
export const ARKIV_ADDRESS = '0x4400000000000000000000000000000000000044' as const;
export type RpcRequest = (request: { method: string; params?: readonly unknown[] | object }) => Promise<unknown>;
export const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getLogs',
  'eth_getBalance', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas', 'eth_call', 'arkiv_query']);

export function createArkivReadClient(request?: RpcRequest) {
  const underlying = request ?? (http(OFFICIAL_RPC, { timeout: 10_000, retryCount: 0,
    fetchOptions: { cache: 'no-store', redirect: 'error' } })({ chain: tiramisu }).request as RpcRequest);
  const read: RpcRequest = args => {
    if (!READ_METHODS.has(args.method)) throw new ArkivRepositoryError('unsupported', 'unsupported', 'This RPC boundary only permits reads.');
    return underlying(args);
  };
  const client = createPublicClient({ chain: tiramisu, cacheTime: 0,
    transport: custom({ request: read as EIP1193RequestFn }, { retryCount: 0 }) });
  return { client, request: read };
}
export type ArkivReadClient = ReturnType<typeof createArkivReadClient>['client'];
