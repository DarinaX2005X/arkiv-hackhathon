import { TIRAMISU_CHAIN_ID } from '../../domain/types.js';
import { ArkivRepositoryError } from './errors.js';

export interface RpcRead { method: string; params?: readonly unknown[] | object }
export type RpcRequest = ((request: RpcRead, options?: { signal?: AbortSignal }) => Promise<unknown>) & {
  /** Optional standard JSON-RPC batching, restricted to exact block headers. */
  readBlockHeaders?: (blockNumbers: readonly bigint[], options?: { signal?: AbortSignal }) => Promise<unknown[]>;
};
export const MAX_HEADER_BATCH_SIZE = 32;
export const READ_METHODS: ReadonlySet<string> = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getLogs',
  'eth_getBalance', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas', 'eth_call', 'arkiv_query']);
export const READ_RATE_LIMIT_COOLDOWN_MS = 30_000;
export const READ_NETWORK_COOLDOWN_MS = 15_000;

export interface ReadPolicyOptions {
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxConcurrent?: number;
  maxQueued?: number;
  /** Extra attempts after a transient transport failure; never applied to quota or RPC errors. */
  retries?: number;
  cacheEntries?: number;
  cacheBytes?: number;
  cacheAgeMs?: number;
}

function cancelled(): ArkivRepositoryError {
  return new ArkivRepositoryError('unverified', 'incomplete_snapshot', 'This read was cancelled. Refresh to check the latest information.');
}
function checkSignal(signal?: AbortSignal) { if (signal?.aborted) throw cancelled(); }
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function header(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  if ('get' in headers && typeof headers.get === 'function') {
    const value: unknown = headers.get(name); return typeof value === 'string' ? value : null;
  }
  const pair = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof pair?.[1] === 'string' ? pair[1] : null;
}

/** Only standard delay/reset metadata is retained; URLs, bodies and provider messages never escape. */
export function providerRetryAt(headers: unknown, now: number): number | null {
  const deadlines: number[] = [];
  const retry = header(headers, 'retry-after');
  if (retry !== null) {
    const value = /^\d+(?:\.\d+)?$/.test(retry.trim()) ? now + Number(retry) * 1_000 : Date.parse(retry);
    if (Number.isFinite(value) && value > now) deadlines.push(value);
  }
  for (const name of ['x-ratelimit-reset', 'x-rate-limit-reset', 'x-quota-reset']) {
    const raw = header(headers, name);
    if (raw === null) continue;
    const parsed = /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : Date.parse(raw);
    const value = /^\d+(?:\.\d+)?$/.test(raw.trim()) && parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
    if (Number.isFinite(value) && value > now) deadlines.push(value);
  }
  const relativeReset = header(headers, 'ratelimit-reset');
  if (relativeReset !== null && /^\d+(?:\.\d+)?$/.test(relativeReset.trim())) {
    const value = now + Number(relativeReset) * 1_000;
    if (Number.isFinite(value) && value > now) deadlines.push(value);
  }
  return deadlines.length ? Math.max(...deadlines) : null;
}

interface ReadFailure { kind: 'quota' | 'transient' | 'permanent'; retryAt: number | null }
export function classifyReadFailure(error: unknown, now = Date.now()): ReadFailure {
  let current: unknown = error, status: number | undefined, retryAt: number | null = null;
  let network = false, rpc = false, malformed = false;
  const seen = new Set<unknown>();
  for (let depth = 0; current && typeof current === 'object' && depth < 12 && !seen.has(current); depth++) {
    seen.add(current);
    const item = current as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; headers?: unknown; cause?: unknown };
    if (typeof item.status === 'number') status = item.status;
    else if (typeof item.statusCode === 'number') status = item.statusCode;
    const deadline = providerRetryAt(item.headers, now);
    if (deadline !== null) retryAt = Math.max(retryAt ?? deadline, deadline);
    if (typeof item.code === 'number') rpc = true;
    if (item.name === 'SyntaxError' || item.name === 'ResponseBodyTooLargeError') malformed = true;
    if (item.name === 'TimeoutError' || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(item.code))
      || (item.name === 'TypeError' && ['Failed to fetch', 'fetch failed', 'Load failed', 'NetworkError when attempting to fetch resource.'].includes(String(item.message)))) network = true;
    current = item.cause;
  }
  if (status === 429) return { kind: 'quota', retryAt };
  if (malformed || (status !== undefined && status >= 400 && status < 500) || (status === undefined && rpc)) return { kind: 'permanent', retryAt: null };
  return { kind: status !== undefined ? ([500, 502, 503, 504].includes(status) ? 'transient' : 'permanent')
    : network ? 'transient' : 'permanent', retryAt };
}

function stable(value: unknown): string {
  try {
    const result = JSON.stringify(value, (_key, item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      return Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined).sort(([left], [right]) => left.localeCompare(right)));
    });
    if (result === undefined) throw new Error('Missing JSON');
    return result;
  } catch { throw new ArkivRepositoryError('invalid_input', 'invalid_input', 'The read request has invalid parameters.'); }
}

function hexBlock(value: unknown): string | null {
  return typeof value === 'string' && /^0x[\da-f]+$/i.test(value) ? BigInt(value).toString() : null;
}
export function validateHeaderBatch(blockNumbers: readonly bigint[]): void {
  if (!Array.isArray(blockNumbers) || !blockNumbers.length || blockNumbers.length > MAX_HEADER_BATCH_SIZE
    || blockNumbers.some(number => typeof number !== 'bigint' || number < 0n || number >= 2n ** 64n)) {
    throw new ArkivRepositoryError('invalid_input', 'invalid_input', 'An exact bounded block-header batch is required.');
  }
}
/** Custom transports without HTTP batching still use the endpoint's ordinary bounded scheduler. */
export async function readBlockHeaders(request: RpcRequest, blockNumbers: readonly bigint[], options?: { signal?: AbortSignal }): Promise<unknown[]> {
  validateHeaderBatch(blockNumbers);
  return request.readBlockHeaders ? request.readBlockHeaders(blockNumbers, options)
    : Promise.all(blockNumbers.map(number => request({ method: 'eth_getBlockByNumber', params: [`0x${number.toString(16)}`, false] }, options)));
}
interface Flight { promise: Promise<unknown>; controller: AbortController; consumers: number }
interface CachedPage { value: unknown; block: string; epoch: number; expiresAt: number; bytes: number }
interface QueuedRead { run: () => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void }

/** One endpoint's bounded read budget. It never forwards, retries or caches a write. */
export function createReadPolicy(underlying: RpcRequest, options: ReadPolicyOptions = {}) {
  const now = options.now ?? Date.now, random = options.random ?? Math.random, sleep = options.sleep ?? pause;
  const maxConcurrent = options.maxConcurrent ?? 3, maxQueued = options.maxQueued ?? 96, retries = options.retries ?? 1;
  const cacheEntries = options.cacheEntries ?? 128, cacheBytes = options.cacheBytes ?? 8 * 1024 * 1024, cacheAgeMs = options.cacheAgeMs ?? 15_000;
  if (![maxConcurrent, maxQueued, retries, cacheEntries, cacheBytes, cacheAgeMs].every(value => Number.isSafeInteger(value) && value >= 0)
    || maxConcurrent < 1 || retries > 2) throw new Error('Invalid read policy bounds.');
  let active = 0, epoch = 0, authorityRead = 0, usedBytes = 0, cooldownUntil = 0, cooldownCode: 'network' | 'rate_limited' = 'rate_limited';
  const flights = new Map<string, Flight>(), cache = new Map<string, CachedPage>(), hashes = new Map<string, string>(), queue: QueuedRead[] = [];
  const invalidate = () => { epoch++; cache.clear(); usedBytes = 0; };
  const cooldownRemainingMs = () => Math.max(0, cooldownUntil - now());
  const cooldownError = () => new ArkivRepositoryError(cooldownCode, 'rpc_error',
    `The network needs a moment. Try again in ${Math.max(1, Math.ceil(cooldownRemainingMs() / 1_000))} seconds.`, true);
  const checkCooldown = () => { if (cooldownRemainingMs()) throw cooldownError(); };
  const defer = (code: 'network' | 'rate_limited', until: number) => {
    if (until >= cooldownUntil) { cooldownCode = code; cooldownUntil = until; }
    invalidate();
  };
  const removePage = (key: string) => { const page = cache.get(key); if (page) usedBytes -= page.bytes; cache.delete(key); };
  const prune = () => {
    for (const [key, page] of cache) if (page.expiresAt <= now() || page.epoch !== epoch) removePage(key);
    while (cache.size > cacheEntries || usedBytes > cacheBytes) removePage(cache.keys().next().value!);
  };
  const schedule = (task: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    checkSignal(signal);
    const run = () => {
      active++;
      Promise.resolve().then(() => { checkSignal(signal); checkCooldown(); return task(); }).then(resolve, reject).finally(() => {
        active--;
        const next = queue.shift();
        if (next) { next.signal.removeEventListener('abort', next.abort); next.run(); }
      });
    };
    if (active < maxConcurrent) { run(); return; }
    if (queue.length >= maxQueued) { reject(new ArkivRepositoryError('network', 'rpc_error', 'Several reads are already in progress. Try again shortly.', true)); return; }
    const waiting: QueuedRead = { run, reject, signal, abort: () => {
      const index = queue.indexOf(waiting); if (index >= 0) queue.splice(index, 1);
      signal.removeEventListener('abort', waiting.abort); reject(cancelled());
    } };
    queue.push(waiting); signal.addEventListener('abort', waiting.abort, { once: true });
  });
  const run = async (args: RpcRead, signal: AbortSignal, perform: () => Promise<unknown> = () => underlying(args, { signal })): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      checkSignal(signal); checkCooldown();
      try { return await perform(); }
      catch (error) {
        checkSignal(signal);
        const failure = classifyReadFailure(error, now());
        if (failure.kind === 'quota') {
          defer('rate_limited', failure.retryAt ?? now() + READ_RATE_LIMIT_COOLDOWN_MS); throw cooldownError();
        }
        if (failure.kind !== 'transient') { if (args.method === 'arkiv_query') invalidate(); throw error; }
        if (failure.retryAt !== null || attempt >= retries) {
          defer('network', failure.retryAt ?? now() + READ_NETWORK_COOLDOWN_MS); throw cooldownError();
        }
        await sleep(Math.round(250 * 2 ** attempt * (0.75 + Math.max(0, Math.min(1, random())) * 0.5)), signal);
      }
    }
  };
  const join = (flight: Flight, signal?: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    flight.consumers++;
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
      flight.consumers--; if (!flight.consumers) flight.controller.abort(); complete();
    };
    const abort = () => finish(() => reject(cancelled()));
    signal?.addEventListener('abort', abort, { once: true });
    flight.promise.then(value => finish(() => resolve(structuredClone(value))), error => finish(() => reject(error)));
  });
  const observeHeader = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const header = value as { number?: unknown; hash?: unknown };
    const number = hexBlock(header.number);
    if (number !== null && typeof header.hash === 'string' && /^0x[\da-f]{64}$/i.test(header.hash)) {
      const oldHash = hashes.get(number);
      if (oldHash && oldHash !== header.hash) invalidate();
      hashes.delete(number); hashes.set(number, header.hash);
      while (hashes.size > 256) hashes.delete(hashes.keys().next().value!);
    }
  };
  const request: RpcRequest = (args, requestOptions) => {
    if (!READ_METHODS.has(args.method)) return Promise.reject(new ArkivRepositoryError('unsupported', 'unsupported', 'This connection only supports reading public information.'));
    try { checkSignal(requestOptions?.signal); checkCooldown(); } catch (error) { return Promise.reject(error); }
    const params = stable(args.params ?? []), baseKey = `${TIRAMISU_CHAIN_ID}:${args.method}:${params}`;
    const query = args.method === 'arkiv_query' && Array.isArray(args.params) && args.params[1] && typeof args.params[1] === 'object'
      ? args.params[1] as { atBlock?: unknown } : null;
    const block = query ? hexBlock(query.atBlock) : null, hash = block === null ? undefined : hashes.get(block);
    // A preflight or completion check must never inherit an older in-flight head/header read.
    const authority = ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber'].includes(args.method);
    const key = `${baseKey}${query ? `:${epoch}:${hash ?? 'unchecked'}` : ''}${authority ? `:${++authorityRead}` : ''}`;
    const existing = flights.get(key);
    if (existing && !existing.controller.signal.aborted) return join(existing, requestOptions?.signal);
    // A new repository read or write preflight must not inherit a former head's authority.
    // Headers themselves are always read again, including finish/reorg checks.
    if (args.method === 'eth_chainId' || args.method === 'eth_blockNumber') invalidate();
    prune();
    const cached = block !== null && hash ? cache.get(key) : undefined;
    if (cached) return Promise.resolve(structuredClone(cached.value));
    const generation = epoch, controller = new AbortController();
    const flight: Flight = { controller, consumers: 0, promise: Promise.resolve() };
    flight.promise = schedule(() => run(args, controller.signal), controller.signal).then(value => {
      checkSignal(controller.signal);
      if (args.method === 'eth_getBlockByNumber') observeHeader(value);
      if (block !== null && hash && generation === epoch && hashes.get(block) === hash && value && typeof value === 'object') {
        const page = value as { data?: unknown; blockNumber?: unknown; cursor?: unknown };
        if (Array.isArray(page.data) && hexBlock(page.blockNumber) === block && (page.cursor === undefined || typeof page.cursor === 'string')) {
          const bytes = new TextEncoder().encode(stable(value)).length;
          if (bytes <= cacheBytes) { cache.set(key, { value: structuredClone(value), block, epoch, bytes, expiresAt: now() + cacheAgeMs }); usedBytes += bytes; prune(); }
        }
      }
      return value;
    }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    flights.set(key, flight);
    return join(flight, requestOptions?.signal);
  };
  request.readBlockHeaders = async (blockNumbers, requestOptions) => {
    validateHeaderBatch(blockNumbers); checkSignal(requestOptions?.signal); checkCooldown();
    if (!underlying.readBlockHeaders) return Promise.all(blockNumbers.map(number => request({
      method: 'eth_getBlockByNumber', params: [`0x${number.toString(16)}`, false],
    }, requestOptions)));
    const controller = new AbortController();
    // One bounded HTTP batch occupies one concurrency slot. Every invocation starts a new
    // provider read; a completion/reorg check never joins an earlier batch or settled cache.
    const flight: Flight = { controller, consumers: 0, promise: Promise.resolve() };
    flight.promise = schedule(() => run({ method: 'eth_getBlockByNumber' }, controller.signal,
      () => underlying.readBlockHeaders!(blockNumbers, { signal: controller.signal })), controller.signal).then(value => {
      checkSignal(controller.signal);
      if (!Array.isArray(value) || value.length !== blockNumbers.length) {
        throw new ArkivRepositoryError('unverified', 'incomplete_snapshot', 'The block-header batch was incomplete.');
      }
      value.forEach(observeHeader); return value;
    });
    return await join(flight, requestOptions?.signal) as unknown[];
  };
  return { request, invalidate, cooldownRemainingMs };
}
export type ReadPolicy = ReturnType<typeof createReadPolicy>;
