import { createPublicClient } from '@arkiv-network/sdk';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { custom, http, HttpRequestError, TimeoutError } from 'viem';
import type { EIP1193RequestFn } from 'viem';
import { createReadPolicy } from './read-policy';
import type { ReadPolicy, RpcRequest } from './read-policy';

export { READ_METHODS } from './read-policy';
export type { RpcRequest } from './read-policy';

export const OFFICIAL_RPC = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network';
export const ARKIV_ADDRESS = '0x4400000000000000000000000000000000000044' as const;
export const HOSTED_READ_RPC = '/api/arkiv-read';
export const READ_RPC_TIMEOUT_MS = 10_000;
export interface ArkivReadClientOptions { transport?: 'auto' | 'direct' | 'hosted' }
const customPolicies = new WeakMap<RpcRequest, ReadPolicy>();
const endpointPolicies = new Map<string, ReadPolicy>();

/** Independently hosted clients can explicitly use direct RPC, without a Studio service. */
export function arkivReadEndpoint(options: ArkivReadClientOptions = {}): string {
  const environment = import.meta.env;
  const transport = options.transport ?? 'auto';
  if (transport === 'direct' || (transport === 'auto' && environment?.VITE_ARKIV_READ_TRANSPORT === 'direct')) return OFFICIAL_RPC;
  if (transport === 'hosted' || (transport === 'auto' && environment?.VITE_ARKIV_READ_TRANSPORT === 'hosted')) return HOSTED_READ_RPC;
  return typeof window !== 'undefined' && environment?.PROD ? HOSTED_READ_RPC : OFFICIAL_RPC;
}

function readPolicy(request: RpcRequest | undefined, options: ArkivReadClientOptions): ReadPolicy {
  if (request) {
    const existing = customPolicies.get(request);
    if (existing) return existing;
    const policy = createReadPolicy(request);
    customPolicies.set(request, policy); customPolicies.set(policy.request, policy); return policy;
  }
  const endpoint = arkivReadEndpoint(options);
  const existing = endpointPolicies.get(endpoint);
  if (existing) return existing;
  const transportRequest = http(endpoint, { timeout: READ_RPC_TIMEOUT_MS, retryCount: 0, maxResponseBodySize: 16 * 1024 * 1024,
    fetchOptions: { cache: 'no-store', redirect: 'error' },
    // viem otherwise converts non-2xx JSON-RPC bodies to RPC errors and loses quota headers.
    onFetchResponse: async response => {
      if (response.ok) return;
      const headers = new Headers();
      for (const name of ['retry-after', 'x-ratelimit-reset', 'x-rate-limit-reset', 'x-quota-reset', 'ratelimit-reset', 'x-arkiv-read-error']) {
        const value = response.headers.get(name); if (value !== null) headers.set(name, value);
      }
      try { await response.body?.cancel(); } catch { /* The response remains a failed read. */ }
      throw new HttpRequestError({ status: response.status, headers, url: endpoint,
        details: 'The public reading service could not complete this request.' });
    } })({ chain: tiramisu }).request as RpcRequest;
  const underlying: RpcRequest = async (args, requestOptions) => {
    // viem's HTTP timer does not abort a supplied signal and ends before body parsing.
    // Bound the entire read while forwarding cancellation to fetch and its response stream.
    const controller = new AbortController(), signal = requestOptions?.signal;
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new TimeoutError({ body: { method: args.method }, url: endpoint })); }, READ_RPC_TIMEOUT_MS);
    });
    try { return await Promise.race([transportRequest(args, { signal: controller.signal }), timeout]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const policy = createReadPolicy(underlying);
  endpointPolicies.set(endpoint, policy); customPolicies.set(policy.request, policy); return policy;
}

export function createArkivReadClient(request?: RpcRequest, options: ArkivReadClientOptions = {}) {
  const policy = readPolicy(request, options), read = policy.request;
  const createScopedClient = (signal?: AbortSignal) => {
    const scoped: RpcRequest = signal ? args => read(args, { signal }) : read;
    return createPublicClient({ chain: tiramisu, cacheTime: 0,
      transport: custom({ request: scoped as EIP1193RequestFn }, { retryCount: 0 }) });
  };
  return { client: createScopedClient(), createScopedClient, request: read, invalidate: policy.invalidate, cooldownRemainingMs: policy.cooldownRemainingMs };
}
/** Scheduling advice only. A zero delay never establishes snapshot or write authority. */
export const readCooldownRemainingMs = (request?: RpcRequest): number => readPolicy(request, {}).cooldownRemainingMs();
export const invalidateArkivReadCache = (request?: RpcRequest): void => readPolicy(request, {}).invalidate();
export type ArkivReadClient = ReturnType<typeof createArkivReadClient>['client'];
