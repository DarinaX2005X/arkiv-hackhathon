import { describe, expect, it, vi } from 'vitest';
import { eq } from '@arkiv-network/sdk/query';
import { createArkivReadClient, HOSTED_READ_RPC, OFFICIAL_RPC } from './client';
import { readResponseTooLarge, repositoryError } from './errors';
import { classifyReadFailure, createReadPolicy, MAX_HEADER_BATCH_SIZE, providerRetryAt, readBlockHeaders, READ_NETWORK_COOLDOWN_MS, READ_RATE_LIMIT_COOLDOWN_MS } from './read-policy';
import type { RpcRead, RpcRequest } from './read-policy';

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const query: RpcRead = { method: 'arkiv_query', params: ["project = str('partfolk') AND entity_type = str('book_state')",
  { atBlock: '0x64', limit: '0x64', select: { key: true, payload: true } }] };
const block: RpcRead = { method: 'eth_getBlockByNumber', params: ['0x64', false] };
const page = () => ({ data: [], blockNumber: '0x64' });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

describe('one bounded public read policy', () => {
  it('schedules bounded header batches as independent fresh reads within the shared concurrency limit', async () => {
    const source: RpcRequest = vi.fn<RpcRequest>(), releases: ((value: unknown[]) => void)[] = [];
    source.readBlockHeaders = vi.fn<NonNullable<RpcRequest['readBlockHeaders']>>(() => new Promise(resolve => releases.push(resolve)));
    const policy = createReadPolicy(source, { maxConcurrent: 1, maxQueued: 1 });
    const heights = Array.from({ length: MAX_HEADER_BATCH_SIZE }, (_value, index) => BigInt(index));
    const first = readBlockHeaders(policy.request, heights), recheck = readBlockHeaders(policy.request, heights);
    await expect(readBlockHeaders(policy.request, heights)).rejects.toMatchObject({ detail: { code: 'network' } });
    await flush(); expect(source.readBlockHeaders).toHaveBeenCalledTimes(1);
    const headers = heights.map(number => ({ number: `0x${number.toString(16)}`, hash: hash('1') }));
    releases[0]!(headers); expect(await first).toEqual(headers);
    await flush(); expect(source.readBlockHeaders).toHaveBeenCalledTimes(2);
    const changed = headers.map(header => ({ ...header, hash: hash('2') }));
    releases[1]!(changed); expect(await recheck).toEqual(changed); expect(source).not.toHaveBeenCalled();
    await expect(readBlockHeaders(policy.request, [...heights, 33n])).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
    await expect(readBlockHeaders(policy.request, [])).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
    expect(source.readBlockHeaders).toHaveBeenCalledTimes(2);
  });

  it('uses the ordinary bounded scheduler for custom transports without a header-batch capability', async () => {
    let active = 0, peak = 0;
    const source = vi.fn<RpcRequest>(async args => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
      return { number: (args.params as unknown[])[0], hash: hash('1') };
    });
    const policy = createReadPolicy(source, { maxConcurrent: 3 });
    const heights = Array.from({ length: MAX_HEADER_BATCH_SIZE }, (_value, index) => BigInt(index));
    const result = await readBlockHeaders(policy.request, heights);
    expect(peak).toBeLessThanOrEqual(3); expect(source).toHaveBeenCalledTimes(MAX_HEADER_BATCH_SIZE);
    expect(result.map(header => (header as { number: string }).number)).toEqual(heights.map(number => `0x${number.toString(16)}`));
  });

  it('cancels an in-flight header batch and rejects a partial custom batch', async () => {
    const source: RpcRequest = vi.fn<RpcRequest>(); let signal: AbortSignal | undefined;
    source.readBlockHeaders = vi.fn<NonNullable<RpcRequest['readBlockHeaders']>>((_heights, options) => {
      signal = options?.signal; return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    const policy = createReadPolicy(source), owner = new AbortController();
    const pending = readBlockHeaders(policy.request, [1n, 2n], { signal: owner.signal }).then(() => null, repositoryError);
    await flush(); expect(signal?.aborted).toBe(false); owner.abort();
    expect(signal?.aborted).toBe(true); expect(await pending).toMatchObject({ code: 'unverified', reasons: [{ code: 'incomplete_snapshot' }] });
    source.readBlockHeaders = vi.fn(async () => [{ number: '0x1', hash: hash('1') }]);
    await expect(readBlockHeaders(policy.request, [1n, 2n])).rejects.toMatchObject({ detail: { code: 'unverified', reasons: [{ code: 'incomplete_snapshot' }] } });
  });

  it('shares batch quota failures with ordinary reads and never retries a rate-limited batch', async () => {
    const source: RpcRequest = vi.fn<RpcRequest>();
    source.readBlockHeaders = vi.fn(async () => { throw { status: 429, headers: { 'Retry-After': '7' } }; });
    const policy = createReadPolicy(source, { now: () => 1_000 });
    await expect(readBlockHeaders(policy.request, [1n, 2n])).rejects.toMatchObject({ detail: { code: 'rate_limited' } });
    expect(policy.cooldownRemainingMs()).toBe(7_000);
    await expect(policy.request(query)).rejects.toMatchObject({ detail: { code: 'rate_limited' } });
    expect(source.readBlockHeaders).toHaveBeenCalledTimes(1); expect(source).not.toHaveBeenCalled();
  });

  it.each([
    [{ jsonrpc: '2.0', id: 1, result: {} }],
    [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 1, result: {} }],
    [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 3, result: {} }],
    [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: '2', result: {} }],
    [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '1.0', id: 2, result: {} }],
    [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {}, error: { code: -32005, message: 'error' } }],
    [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, error: { code: 'invalid', message: 'error' } }],
    [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }, { jsonrpc: '2.0', id: 3, result: {} }],
    { jsonrpc: '2.0', id: 1, result: {} },
  ].map(body => ({ body })))('rejects malformed standard HTTP batch response association without returning a partial list: %#', async ({ body }) => {
    vi.resetModules();
    const { createArkivReadClient: createHttpClient } = await import('./client');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    try {
      await expect(readBlockHeaders(createHttpClient(undefined, { transport: 'direct' }).request, [1n, 2n]))
        .rejects.toMatchObject({ detail: { code: 'unverified', reasons: [{ code: 'incomplete_snapshot' }] } });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });

  it('fails a complete HTTP header batch when any associated request has a provider error', async () => {
    vi.resetModules();
    const { createArkivReadClient: createHttpClient } = await import('./client');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([
      { jsonrpc: '2.0', id: 2, error: { code: -32005, message: 'Header unavailable.' } },
      { jsonrpc: '2.0', id: 1, result: { number: '0x1', hash: hash('1') } },
    ]));
    try {
      await expect(readBlockHeaders(createHttpClient(undefined, { transport: 'direct' }).request, [1n, 2n])).rejects.toMatchObject({ name: 'RpcRequestError' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });

  it('coalesces matching requests across clients and does not wrap an already shared request twice', async () => {
    let complete: (value: unknown) => void = () => {};
    const source = vi.fn<RpcRequest>(() => new Promise(resolve => { complete = resolve; }));
    const first = createArkivReadClient(source), second = createArkivReadClient(source), nested = createArkivReadClient(first.request);
    const calls = [first.request(query), second.request(query), nested.request(query)];
    await flush(); expect(source).toHaveBeenCalledTimes(1);
    complete(page()); const results = await Promise.all(calls);
    expect(results).toEqual([page(), page(), page()]);
    expect(results[0]).not.toBe(results[1]);
  });

  it('never shares account, projection, cursor or block-specific requests under a partial cache key', async () => {
    const source = vi.fn<RpcRequest>(async () => page()); const policy = createReadPolicy(source);
    await Promise.all([
      policy.request({ ...query, params: ['creator-a', { atBlock: '0x64', select: { key: true } }] }),
      policy.request({ ...query, params: ['creator-b', { atBlock: '0x64', select: { key: true } }] }),
      policy.request({ ...query, params: ['creator-a', { atBlock: '0x65', select: { key: true } }] }),
      policy.request({ ...query, params: ['creator-a', { atBlock: '0x64', select: { payload: true } }] }),
      policy.request({ ...query, params: ['creator-a', { atBlock: '0x64', select: { key: true }, cursor: 'next' }] }),
    ]);
    expect(source).toHaveBeenCalledTimes(5);
  });

  it('reuses pinned pages only within a checked generation, while every head and header stays fresh', async () => {
    let currentHash = hash('1');
    const source = vi.fn<RpcRequest>(async args => args.method === 'eth_getBlockByNumber'
      ? { number: '0x64', hash: currentHash } : args.method === 'arkiv_query' ? page() : '0x64');
    const policy = createReadPolicy(source);
    await policy.request(block); await policy.request(query); await policy.request(query);
    expect(source.mock.calls.filter(([args]) => args.method === 'arkiv_query')).toHaveLength(1);
    await policy.request(block);
    expect(source.mock.calls.filter(([args]) => args.method === 'eth_getBlockByNumber')).toHaveLength(2);
    await policy.request({ method: 'eth_chainId' }); await policy.request(query);
    expect(source.mock.calls.filter(([args]) => args.method === 'arkiv_query')).toHaveLength(2);
    await policy.request({ method: 'eth_blockNumber' }); await policy.request(query);
    expect(source.mock.calls.filter(([args]) => args.method === 'arkiv_query')).toHaveLength(3);
    currentHash = hash('2'); await policy.request(block); await policy.request(query);
    expect(source.mock.calls.filter(([args]) => args.method === 'arkiv_query')).toHaveLength(4);
  });

  it.each(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber'])('starts %s independently of an older in-flight authority read', async method => {
    const complete: ((value: unknown) => void)[] = [];
    const source = vi.fn<RpcRequest>(() => new Promise(resolve => complete.push(resolve)));
    const policy = createReadPolicy(source);
    const args = { ...block, method };
    const earlier = policy.request(args); await flush();
    const completionCheck = policy.request(args); await flush();
    expect(source).toHaveBeenCalledTimes(2);
    complete[0]!({ number: '0x64', hash: hash('1') });
    complete[1]!({ number: '0x64', hash: hash('2') });
    await expect(earlier).resolves.toMatchObject({ hash: hash('1') });
    await expect(completionCheck).resolves.toMatchObject({ hash: hash('2') });
  });

  it('does not cache unchecked, malformed, expired or new-block pages', async () => {
    let now = 1_000, response: unknown = page();
    const source = vi.fn<RpcRequest>(async args => args.method === 'eth_getBlockByNumber'
      ? { number: '0x64', hash: hash('1') } : response);
    const policy = createReadPolicy(source, { now: () => now, cacheAgeMs: 10 });
    await policy.request(query); await policy.request(query);
    expect(source).toHaveBeenCalledTimes(2);
    await policy.request(block); await policy.request(query); await policy.request(query);
    expect(source).toHaveBeenCalledTimes(4);
    now += 11; await policy.request(query); expect(source).toHaveBeenCalledTimes(5);
    policy.invalidate(); response = { data: null, blockNumber: '0x64' };
    await policy.request(query); await policy.request(query); expect(source).toHaveBeenCalledTimes(7);
    response = page(); await policy.request({ ...query, params: ['same', { atBlock: '0x65' }] });
    await policy.request({ ...query, params: ['same', { atBlock: '0x65' }] }); expect(source).toHaveBeenCalledTimes(9);
  });

  it('bounds pinned cache entries and bytes without changing returned evidence', async () => {
    const source = vi.fn<RpcRequest>(async args => args.method === 'eth_getBlockByNumber'
      ? { number: '0x64', hash: hash('1') } : page());
    const policy = createReadPolicy(source, { cacheEntries: 1 });
    await policy.request(block); await policy.request(query);
    await policy.request({ ...query, params: ['other', { atBlock: '0x64' }] });
    await policy.request(query); expect(source).toHaveBeenCalledTimes(4);
    const tiny = createReadPolicy(source, { cacheBytes: 1 });
    await tiny.request(block); await tiny.request(query); await tiny.request(query);
    expect(source).toHaveBeenCalledTimes(7);
  });

  it('limits concurrency and refuses an unbounded queue', async () => {
    const releases: (() => void)[] = [];
    const source = vi.fn<RpcRequest>(() => new Promise(resolve => releases.push(() => resolve('0x1'))));
    const policy = createReadPolicy(source, { maxConcurrent: 1, maxQueued: 1 });
    const first = policy.request({ method: 'eth_getBalance', params: ['first', 'latest'] });
    const second = policy.request({ method: 'eth_getBalance', params: ['second', 'latest'] });
    const refused = policy.request({ method: 'eth_getBalance', params: ['third', 'latest'] });
    await expect(refused).rejects.toMatchObject({ detail: { code: 'network', retryable: true } });
    await flush(); expect(source).toHaveBeenCalledTimes(1);
    releases.shift()!(); await first; await flush(); expect(source).toHaveBeenCalledTimes(2);
    releases.shift()!(); await second;
  });

  it('lets one consumer cancel without aborting another and cancels abandoned queued work', async () => {
    let complete: (value: unknown) => void = () => {};
    const source = vi.fn<RpcRequest>(() => new Promise(resolve => { complete = resolve; }));
    const policy = createReadPolicy(source, { maxConcurrent: 1 });
    const owner = new AbortController();
    const first = policy.request(query, { signal: owner.signal }), second = policy.request(query);
    const queuedOwner = new AbortController();
    const queued = policy.request({ method: 'eth_chainId' }, { signal: queuedOwner.signal });
    owner.abort(); queuedOwner.abort();
    await expect(first).rejects.toMatchObject({ detail: { code: 'unverified' } });
    await expect(queued).rejects.toMatchObject({ detail: { code: 'unverified' } });
    await flush(); expect(source).toHaveBeenCalledTimes(1);
    expect(source.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    complete(page()); await expect(second).resolves.toEqual(page());
  });

  it('retries only a transient read with bounded jitter, then opens a short shared circuit', async () => {
    let now = 1_000; const sleep = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {});
    const source = vi.fn<RpcRequest>().mockRejectedValue(Object.assign(new Error('private provider body'), { status: 503 }));
    const policy = createReadPolicy(source, { now: () => now, sleep, random: () => 0.5 });
    await expect(policy.request(query)).rejects.toMatchObject({ detail: { code: 'network', retryable: true } });
    expect(source).toHaveBeenCalledTimes(2); expect(sleep.mock.calls[0]?.[0]).toBe(250);
    await expect(policy.request({ method: 'eth_chainId' })).rejects.toMatchObject({ detail: { code: 'network' } });
    expect(source).toHaveBeenCalledTimes(2); expect(policy.cooldownRemainingMs()).toBe(READ_NETWORK_COOLDOWN_MS);
    now += READ_NETWORK_COOLDOWN_MS; source.mockResolvedValue('0x1');
    await expect(policy.request({ method: 'eth_chainId' })).resolves.toBe('0x1');
  });

  it('honors Retry-After once and blocks all methods until its provider deadline', async () => {
    let now = Date.parse('2026-10-13T12:00:00Z'); const sleep = vi.fn(async () => {});
    const source = vi.fn<RpcRequest>().mockRejectedValue(Object.assign(new Error('private URL and key'), {
      status: 429, headers: new Headers({ 'Retry-After': '45' }),
    }));
    const policy = createReadPolicy(source, { now: () => now, sleep });
    let failed: unknown; try { await policy.request(query); } catch (error) { failed = error; }
    expect(repositoryError(failed)).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(repositoryError(failed).diagnostic).toContain('45 seconds');
    expect(repositoryError(failed).diagnostic).not.toContain('private'); expect(source).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    policy.invalidate(); // A display invalidation must never reset provider quota.
    await expect(policy.request({ method: 'eth_blockNumber' })).rejects.toMatchObject({ detail: { code: 'rate_limited' } });
    now += 45_000; source.mockResolvedValue('0x64');
    await expect(policy.request({ method: 'eth_blockNumber' })).resolves.toBe('0x64'); expect(source).toHaveBeenCalledTimes(2);
  });

  it('uses a safe quota cooldown without headers and preserves it through SDK wrapping', async () => {
    const source = vi.fn<RpcRequest>().mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }));
    const client = createArkivReadClient(source);
    let failed: unknown; try { await client.client.getChainId(); } catch (error) { failed = error; }
    expect(repositoryError(failed)).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(client.cooldownRemainingMs()).toBeGreaterThan(READ_RATE_LIMIT_COOLDOWN_MS - 1_000);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('preserves quota and explicit response bounds from non-2xx JSON-RPC over the real HTTP transport', async () => {
    vi.resetModules();
    const { createArkivReadClient: createHttpClient } = await import('./client');
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1,
      error: { code: -32099, message: 'private provider body' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '45' } }));
    try {
      const client = createHttpClient(undefined, { transport: 'direct' });
      await expect(client.request(query)).rejects.toMatchObject({ detail: { code: 'rate_limited' } });
      expect(client.cooldownRemainingMs()).toBe(45_000);
      await expect(client.request({ method: 'eth_blockNumber' })).rejects.toMatchObject({ detail: { code: 'rate_limited' } });
      expect(fetch).toHaveBeenCalledTimes(1);
      now += 45_000;
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32098, message: 'response bound' } }),
        { status: 413, headers: { 'Content-Type': 'application/json', 'X-Arkiv-Read-Error': 'response_too_large' } }));
      let bounded: unknown; try { await client.request(query); } catch (error) { bounded = error; }
      expect(readResponseTooLarge(bounded)).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
      expect(repositoryError(bounded).diagnostic).not.toContain('private');
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32099, message: 'request bound' } }),
        { status: 413, headers: { 'Content-Type': 'application/json' } }));
      let generic: unknown; try { await client.request(query); } catch (error) { generic = error; }
      expect(readResponseTooLarge(generic)).toBe(false); expect(fetch).toHaveBeenCalledTimes(3);
    } finally { fetch.mockRestore(); clock.mockRestore(); }
  });

  it('aborts a held HTTP fetch and frees its endpoint slot for a queued SDK read', async () => {
    vi.resetModules();
    const [{ createArkivReadClient: createHttpClient }, { repositoryError: httpError }] = await Promise.all([import('./client'), import('./errors')]);
    const signals: AbortSignal[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) { reject(new Error('The HTTP read has no cancellation signal.')); return; }
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled fetch', 'AbortError')), { once: true });
    }));
    const owners = Array.from({ length: 4 }, () => new AbortController());
    const client = createHttpClient(undefined, { transport: 'direct' });
    const reads = owners.map(owner => client.createScopedClient(owner.signal).getChainId().then(() => null, httpError));
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      owners[0]!.abort();
      expect(signals[0]?.aborted).toBe(true);
      expect(await reads[0]).toMatchObject({ code: 'unverified', reasons: [{ code: 'incomplete_snapshot' }] });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
      expect(signals.slice(1).every(signal => !signal.aborted)).toBe(true);
    } finally {
      for (const owner of owners) owner.abort();
      await Promise.all(reads); fetch.mockRestore();
    }
  });

  it('preserves a shared HTTP query while another SDK consumer still needs it', async () => {
    vi.resetModules();
    const [{ createArkivReadClient: createHttpClient }, { repositoryError: httpError }] = await Promise.all([import('./client'), import('./errors')]);
    let signal: AbortSignal | null | undefined, complete: () => void = () => {};
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((resolve, reject) => {
      signal = options?.signal;
      const abort = () => reject(new DOMException('Cancelled fetch', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      complete = () => {
        signal?.removeEventListener('abort', abort);
        resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: page() }), { headers: { 'Content-Type': 'application/json' } }));
      };
    }));
    const firstOwner = new AbortController(), secondOwner = new AbortController();
    const client = createHttpClient(undefined, { transport: 'direct' });
    const read = (owner: AbortController) => client.createScopedClient(owner.signal).select({ key: true })
      .where(eq('project', 'partfolk')).atBlock(100n).limit(1).fetch();
    const first = read(firstOwner).then(() => null, httpError);
    const second = read(secondOwner).then(value => ({ value }), error => ({ error: httpError(error) }));
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      firstOwner.abort(); expect(await first).toMatchObject({ code: 'unverified' });
      expect(signal?.aborted).toBe(false);
      complete(); expect(await second).toMatchObject({ value: { entities: [], blockNumber: 100n } });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { firstOwner.abort(); secondOwner.abort(); await Promise.all([first, second]); fetch.mockRestore(); }
  });

  it('keeps the full HTTP body read bounded when a supplied signal overrides viem’s timeout signal', async () => {
    vi.resetModules();
    const [{ createArkivReadClient: createHttpClient, READ_RPC_TIMEOUT_MS }, { repositoryError: httpError }] = await Promise.all([import('./client'), import('./errors')]);
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5), signals: AbortSignal[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error('The HTTP read has no cancellation signal.');
      signals.push(signal);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        signal.addEventListener('abort', () => controller.error(new DOMException('Cancelled body', 'AbortError')), { once: true });
      } });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    });
    const owner = new AbortController(), client = createHttpClient(undefined, { transport: 'direct' });
    const result = client.createScopedClient(owner.signal).getChainId().then(() => null, httpError);
    try {
      await flush(); expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(READ_RPC_TIMEOUT_MS);
      expect(signals[0]?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(250); expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(READ_RPC_TIMEOUT_MS);
      expect(signals[1]?.aborted).toBe(true);
      expect(await result).toMatchObject({ code: 'network', retryable: true });
      expect(client.cooldownRemainingMs()).toBe(READ_NETWORK_COOLDOWN_MS);
    } finally { owner.abort(); await result; vi.clearAllTimers(); vi.useRealTimers(); random.mockRestore(); fetch.mockRestore(); }
  });

  it.each([400, 401, 403, 404, 408, 413])('never retries HTTP %s', async status => {
    const source = vi.fn<RpcRequest>().mockRejectedValue({ status }); const policy = createReadPolicy(source);
    await expect(policy.request(query)).rejects.toEqual({ status }); expect(source).toHaveBeenCalledTimes(1);
  });
  it.each([-32001, -32002, -32003, -32004, -32005, -32006, -32602])('leaves RPC %s to the complete query walker', async code => {
    const source = vi.fn<RpcRequest>().mockRejectedValue({ code }); const policy = createReadPolicy(source);
    await expect(policy.request(query)).rejects.toEqual({ code }); expect(source).toHaveBeenCalledTimes(1);
  });
  it('does not retry malformed responses, unknown failures or any write/unknown method', async () => {
    const source = vi.fn<RpcRequest>().mockRejectedValue(new SyntaxError('invalid response')); const policy = createReadPolicy(source);
    await expect(policy.request(query)).rejects.toBeInstanceOf(SyntaxError);
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'wallet_switchEthereumChain', 'arkiv_unknown']) {
      await expect(policy.request({ method })).rejects.toMatchObject({ detail: { code: 'unsupported' } });
    }
    expect(source).toHaveBeenCalledTimes(1);
    expect(classifyReadFailure(new Error('unknown'))).toMatchObject({ kind: 'permanent' });
    expect(classifyReadFailure(new TypeError('Cannot read properties of undefined'))).toMatchObject({ kind: 'permanent' });
    expect(classifyReadFailure(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'transient' });
  });

  it('defers a provider-directed unavailable response instead of sleeping past its retry deadline', async () => {
    const source = vi.fn<RpcRequest>().mockRejectedValue({ status: 503, headers: { 'Retry-After': '120' } });
    const sleep = vi.fn(async () => {}), policy = createReadPolicy(source, { now: () => 1_000, sleep });
    await expect(policy.request(query)).rejects.toMatchObject({ detail: { code: 'network' } });
    expect(policy.cooldownRemainingMs()).toBe(120_000); expect(source).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });

  it('parses HTTP-date and quota reset metadata without shortening a provider deadline', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(providerRetryAt(new Headers({ 'Retry-After': new Date(now + 20_000).toUTCString(), 'X-RateLimit-Reset': String((now + 90_000) / 1_000) }), now)).toBe(now + 90_000);
    expect(providerRetryAt({ 'RateLimit-Reset': '75' }, now)).toBe(now + 75_000);
    expect(providerRetryAt({ 'retry-after': 'nonsense' }, now)).toBeNull();
  });

  it('supports explicit same-origin hosting and independent direct access without automatic fallback', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ARKIV_READ_TRANSPORT', '');
    try {
      const { arkivReadEndpoint: endpoint } = await import('./client');
      expect(endpoint({ transport: 'hosted' })).toBe(HOSTED_READ_RPC);
      expect(endpoint({ transport: 'direct' })).toBe(OFFICIAL_RPC);
      expect(endpoint()).toBe(OFFICIAL_RPC); // Node has no browser/server dependency.
    } finally { vi.unstubAllEnvs(); }
  });

  it('honors an explicit hosted or direct environment choice while preserving explicit client overrides', async () => {
    vi.resetModules();
    try {
      vi.stubEnv('VITE_ARKIV_READ_TRANSPORT', 'hosted');
      expect(import.meta.env.VITE_ARKIV_READ_TRANSPORT).toBe('hosted');
      const { arkivReadEndpoint: endpoint } = await import('./client');
      expect(endpoint()).toBe(HOSTED_READ_RPC);
      expect(endpoint({ transport: 'auto' })).toBe(HOSTED_READ_RPC);
      expect(endpoint({ transport: 'direct' })).toBe(OFFICIAL_RPC);
      vi.stubEnv('VITE_ARKIV_READ_TRANSPORT', 'direct');
      expect(endpoint()).toBe(OFFICIAL_RPC);
      expect(endpoint({ transport: 'hosted' })).toBe(HOSTED_READ_RPC);
    } finally { vi.unstubAllEnvs(); }
  });
});
