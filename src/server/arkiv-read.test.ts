import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient } from '@arkiv-network/sdk';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { i32, key, u64 } from '@arkiv-network/sdk/attr';
import { eq, gte, lte, toRpcSelect } from '@arkiv-network/sdk/query';
import { custom, toEventSelector } from 'viem';
import type { EIP1193RequestFn } from 'viem';
import { ENTITY_SELECTION } from '../data/arkiv/envelope';
import { createWalletGateway } from '../data/wallet/gateway';
import type { NativeBatch } from '../data/wallet';
import { MAX_HEADER_BATCH_SIZE } from '../data/arkiv/read-policy';
import { ARKIV_READ_LIMITS, createArkivReadHandler } from './arkiv-read';
import type { ArkivReadHandlerOptions } from './arkiv-read';
import entryPoint from '../../api/arkiv-read';

const SECRET = 'test-only-server-credential';
const ACCOUNT = `0x${'12'.repeat(20)}` as const;
const ENTITY = `0x${'ab'.repeat(32)}` as const;
const OTHER = `0x${'cd'.repeat(32)}` as const;
const NATIVE = '0x4400000000000000000000000000000000000044';
const URL = 'https://partfolk.test/api/arkiv-read';
const select = toRpcSelect(ENTITY_SELECTION);
const page = () => ({ data: [], blockNumber: '0x64' });
const query = (expression = "project = str('partfolk-events') AND entity_type = str('event_state') AND schema_version = i32(1)", settings = {}) =>
  ({ jsonrpc: '2.0', id: 1, method: 'arkiv_query', params: [expression, { atBlock: '0x64', limit: '0x64', select, ...settings }] });
const rpc = (method: string, params?: unknown[], id: number | string = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const headerBatch = (count = 2) => Array.from({ length: count }, (_item, index) => rpc('eth_getBlockByNumber', [`0x${(100 + index).toString(16)}`, false], `header-${index}`));
const headerReplies = (count = 2) => Array.from({ length: count }, (_item, index) => ({ jsonrpc: '2.0', id: index + 1,
  result: { number: `0x${(100 + index).toString(16)}`, hash: ENTITY, timestamp: '0x1' } }));
const success = (result: unknown, id = 1) => Response.json({ jsonrpc: '2.0', id, result });
function request(body: unknown, options: RequestInit = {}): Request {
  return new Request(URL, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, ...options });
}
function setup(fetcher = vi.fn<typeof fetch>(async () => success(page())), options: Partial<ArkivReadHandlerOptions> = {}) {
  return { fetcher, handler: createArkivReadHandler({ accessKey: () => SECRET, fetch: fetcher, ...options }) };
}
function streamRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: 'POST', body: stream, duplex: 'half',
    headers: { 'Content-Type': 'application/json', ...headers } } as RequestInit & { duplex: 'half' });
}
async function nativeRequest(overrides: { namespace?: string; payloadSize?: number; batch?: NativeBatch } = {}) {
  const payload = JSON.stringify({ entityType: 'project_root', note: 'x'.repeat(overrides.payloadSize ?? 0) });
  const batch: NativeBatch = overrides.batch ?? { creates: [{ payloadJson: payload, lifetimeSeconds: 3_600, salt: '0',
    attributes: { project: { type: 'str', value: overrides.namespace ?? 'partfolk' }, entity_type: { type: 'str', value: 'project_root' },
      schema_version: { type: 'i32', value: 1 } } }] };
  const gateway = createWalletGateway({ provider: { request: async () => { throw new Error('No wallet request is allowed during preparation.'); } },
    publicRpc: { request: async args => args.method === 'eth_chainId' ? '0x7614d1' : args.method === 'eth_blockNumber' ? '0x64'
      : args.method === 'eth_estimateGas' ? '0x186a0' : args.method === 'eth_gasPrice' ? '0x1' : Promise.reject(new Error('Unexpected preparation read.')) } });
  const prepared = await gateway.prepare(batch, ACCOUNT);
  const { chainId: _chain, ...transaction } = prepared.request;
  return transaction;
}
function replaceWord(data: string, offset: number, value: bigint): string {
  const index = 10 + offset * 2; return data.slice(0, index) + value.toString(16).padStart(64, '0') + data.slice(index + 64);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('hosted Arkiv read request boundary', () => {
  it('exports the Vercel Node Web Standard handler and rejects GET before consulting a credential', async () => {
    const response = await entryPoint.fetch(new Request(URL));
    expect(response.status).toBe(405); expect(response.headers.get('Allow')).toBe('POST');
  });
  it('accepts the installed SDK query wire format across ordinary, scoped, date, exact-reference and recovery reads', async () => {
    const calls: unknown[] = [];
    const client = createPublicClient({ chain: tiramisu, cacheTime: 0, transport: custom({ request: (async args => {
      calls.push(rpc(args.method, args.params as unknown[])); return page();
    }) as EIP1193RequestFn }, { retryCount: 0 }) });
    await client.select(ENTITY_SELECTION).where(eq('project', 'partfolk'), eq('entity_type', 'project_root'), eq('schema_version', i32(1)))
      .createdBy(ACCOUNT).atBlock(100n).limit(100).fetch();
    await client.select(ENTITY_SELECTION).where(eq('project', 'partfolk'), eq('entity_type', 'book_state'), eq('book_key', key(ENTITY)))
      .createdBy(ACCOUNT).atBlock(100n).limit(100).fetch();
    await client.select(ENTITY_SELECTION).where(eq('project', 'partfolk-events'), eq('entity_type', 'event_state'), eq('schema_version', i32(1)),
      gte('ends_at', u64(1_000n)), lte('starts_at', u64(9_000n))).atBlock(100n).limit(100).fetch();
    await client.select(ENTITY_SELECTION).where(eq('project', 'partfolk-events'), eq('entity_type', 'attendance_state'), eq('project_key', key(ENTITY)))
      .createdBy(ACCOUNT).atBlock(100n).limit(100).fetch();
    await client.select(ENTITY_SELECTION).where(eq('$key', key(ENTITY))).atBlock(100n).limit(2).fetch();
    await client.select(ENTITY_SELECTION).where(eq('project', 'partfolk'), eq('operation_id', "id') OR true -- \\"))
      .createdBy(ACCOUNT).atBlock(100n).limit(100).fetch();
    const { handler, fetcher } = setup();
    for (const call of calls) expect((await handler(request(call))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(select).toEqual({ ...ENTITY_SELECTION, updatedAt: false, attributeSchema: false });
  });

  it('accepts grouped conjunctions and an opaque cursor without broadening the query', async () => {
    const { handler } = setup();
    const response = await handler(request(query("(project = str('partfolk') AND entity_type = str('project_link')) AND (schema_version = i32(1) AND link_kind = str('offer')) AND project_key = key(" + ENTITY + ')', { cursor: 'opaque+/=:page' })));
    expect(response.status).toBe(200);
  });

  it.each(['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'wallet_sendTransaction', 'eth_call',
    'eth_getBalance', 'eth_getTransactionCount', 'eth_maxPriorityFeePerGas', 'arkiv_getEntityCount', 'debug_traceTransaction'])
  ('does not forward unsupported method %s', async method => {
    const { handler, fetcher } = setup();
    expect((await handler(request(rpc(method, [])))).status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [rpc('eth_chainId')], { ...rpc('eth_chainId'), id: undefined }, { ...rpc('eth_chainId'), id: {} },
    { ...rpc('eth_chainId'), jsonrpc: '1.0' }, { ...rpc('eth_chainId'), upstream: 'https://attacker.test' },
    rpc('eth_chainId', ['extra']), { ...rpc('eth_chainId'), params: null }, { ...rpc('eth_chainId'), params: {} },
    rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBlockByNumber', ['0x64', true]),
    rpc('eth_getTransactionReceipt', ['0x123']), rpc('eth_getTransactionByHash', [ENTITY, 'latest']),
  ])('rejects malformed envelopes or parameters without an upstream call: %#', async body => {
    const { handler, fetcher } = setup();
    expect((await handler(request(body))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "project = str('partfolk') OR project = str('elsewhere')",
    "project = str('elsewhere') AND entity_type = str('project_root') AND operation_id = str('partfolk')",
    "project = str('partfolk') AND entity_type = str('event_state')",
    "project = str('partfolk-events') AND entity_type = str('book_state')",
    "project = str('partfolk') AND entity_type = str('project_root') -- comment",
    "project = str('partfolk') AND NOT entity_type = str('project_root')",
    "project = str('partfolk') AND entity_type = str('project_root') AND project = str('partfolk')",
    "project = str('partfolk') AND entity_type = str('project_root') AND $owner = addr(" + ACCOUNT + ')',
    "project = str('partfolk') AND operation_id = str('id')",
    "$key = key(" + ENTITY + ") AND project = str('partfolk')",
    "project = str('partfolk-events') AND entity_type = str('event_state') AND starts_at >= u64(1)",
    "project = str('partfolk') AND entity_type = str('project_root') AND schema_version = i32(2)",
    "project = str('partfolk\\') OR true --') AND entity_type = str('project_root')",
    '('.repeat(10) + "project = str('partfolk') AND entity_type = str('project_root')" + ')'.repeat(10),
  ])('rejects query broadening, wrong namespaces/types and unsupported grammar: %#', async expression => {
    const { handler, fetcher } = setup();
    expect((await handler(request(query(expression)))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ limit: 100 }, { limit: '0xc9' }, { limit: '0x0' }, { atBlock: 'latest' }, { cursor: '' }, { cursor: 'x'.repeat(4097) },
    { select: ENTITY_SELECTION }, { select: { ...select, updatedAt: true } }, { select: { ...select, arbitrary: true } }, { count: true }])
  ('requires a pinned, bounded page and the exact SDK projection: %#', async settings => {
    const { handler, fetcher } = setup();
    expect((await handler(request(query(undefined, settings)))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows omitted parameters only on zero-argument methods and always forwards the fixed upstream/header', async () => {
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async () => success('0x64')));
    const response = await handler(request(rpc('eth_blockNumber', undefined, 'browser:7'),
      { headers: { 'Content-Type': 'application/json', 'X-API-KEY': 'attacker-key', Authorization: 'attacker-auth' } }));
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 'browser:7', result: '0x64' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://rpc.tiramisu.db-chain.testnet.arkiv.network');
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
    expect(new Headers(init?.headers).get('X-API-KEY')).toBe(SECRET);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(init!.body as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
  });

  it('rejects foreign browser origins, wrong HTTP methods and compressed/non-JSON bodies', async () => {
    const { handler, fetcher } = setup();
    expect((await handler(new Request(URL))).status).toBe(405);
    expect((await handler(request(query(), { headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.test' } }))).status).toBe(403);
    expect((await handler(request(query(), { headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } }))).status).toBe(403);
    expect((await handler(request(query(), { headers: { 'Content-Type': 'text/plain' } }))).status).toBe(415);
    expect((await handler(request(query(), { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } }))).status).toBe(415);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when the server credential is absent', async () => {
    const { handler, fetcher } = setup(undefined, { accessKey: () => undefined });
    expect((await handler(request(query()))).status).toBe(503); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('native read-only preflight and recovery', () => {
  it('accepts SDK-generated create, replacement, delete and extension estimates without forwarding any send', async () => {
    const creation = await nativeRequest({ payloadSize: 40_000 });
    const deletion = await nativeRequest({ batch: { deletes: [ENTITY, OTHER] } });
    const extension = await nativeRequest({ batch: { extensions: [{ entityKey: ENTITY, expiresAtBlock: '999' }] } });
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async () => success('0x186a0')));
    for (const transaction of [creation, deletion, extension, { ...creation, chainId: '0x7614d1', gas: '0x20000', gasPrice: '0x1' }]) {
      expect((await handler(request(rpc('eth_estimateGas', [transaction])))).status).toBe(200);
    }
    expect(fetcher.mock.calls.every(([, init]) => JSON.parse(init!.body as string).method === 'eth_estimateGas')).toBe(true);
  });

  it('rejects foreign namespaces, non-native destinations, fee conflicts and noncanonical or unsupported native operations', async () => {
    const transaction = await nativeRequest(), foreign = await nativeRequest({ namespace: 'another-project' });
    const { handler, fetcher } = setup();
    const bodies = [foreign, { ...transaction, to: ACCOUNT }, { ...transaction, value: '0x1' }, { ...transaction, from: NATIVE },
      { ...transaction, gasPrice: '0x1', maxFeePerGas: '0x2' }, { ...transaction, maxPriorityFeePerGas: '0x3', maxFeePerGas: '0x2' },
      { ...transaction, chainId: '0x1' }, { ...transaction, nonce: '0x1' }, { ...transaction, data: transaction.data + '00' },
      { ...transaction, data: replaceWord(transaction.data, 0, 64n) },
      { ...transaction, data: replaceWord(transaction.data, 32, 1_000_000_000n) },
      { ...transaction, data: replaceWord(transaction.data, 384, 1_000_000_000n) },
      { ...transaction, data: replaceWord(transaction.data, 320, 3n) },
      { ...transaction, data: replaceWord(transaction.data, 96, 2n) },
      { ...transaction, data: replaceWord(transaction.data, 96, 4n) }];
    for (const body of bodies) expect((await handler(request(rpc('eth_estimateGas', [body])))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects payloads above the application limit and pathological native fork batches without truncation', async () => {
    const oversized = await nativeRequest({ payloadSize: 120 * 1024 });
    const many = await nativeRequest({ batch: { deletes: Array.from({ length: 129 }, () => ENTITY) } });
    const { handler, fetcher } = setup();
    expect((await handler(request(rpc('eth_estimateGas', [oversized])))).status).toBe(400);
    expect((await handler(request(rpc('eth_estimateGas', [many])))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows hash lookups and only EntityCreated logs at one exact block and the native address', async () => {
    const filter = { address: NATIVE, fromBlock: '0x64', toBlock: '0x64',
      topics: [toEventSelector('EntityCreated(bytes32,address,uint64,uint8)'), null, '0x' + '0'.repeat(24) + ACCOUNT.slice(2)] };
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async (_url, init) => {
      const method = JSON.parse(init!.body as string).method; return success(method === 'eth_getLogs' ? [] : null);
    }));
    for (const method of ['eth_getTransactionReceipt', 'eth_getTransactionByHash']) expect((await handler(request(rpc(method, [ENTITY])))).status).toBe(200);
    expect((await handler(request(rpc('eth_getLogs', [filter])))).status).toBe(200);
    for (const invalid of [{ ...filter, toBlock: '0x65' }, { ...filter, address: ACCOUNT }, { ...filter, blockHash: ENTITY },
      { ...filter, topics: [filter.topics[0], [ENTITY, OTHER]] }, { ...filter, topics: [ENTITY] }]) {
      expect((await handler(request(rpc('eth_getLogs', [invalid])))).status).toBe(400);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('bounded bodies and sanitized provider failures', () => {
  it('bounds real streamed request bytes even with a false Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(700)); controller.enqueue(new Uint8Array(700));
    }, cancel() { cancelled = true; } });
    const { handler, fetcher } = setup(undefined, { limits: { requestBytes: 1024 } });
    expect((await handler(streamRequest(stream, { 'Content-Length': '1' }))).status).toBe(413);
    expect(cancelled).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds a stalled request stream and releases its admission slot', async () => {
    vi.useFakeTimers();
    const { handler, fetcher } = setup(undefined, { limits: { bodyTimeoutMs: 20, maxIncoming: 1 } });
    const pending = handler(streamRequest(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })));
    expect((await handler(request(query()))).status).toBe(429);
    await vi.advanceTimersByTimeAsync(21);
    expect((await pending).status).toBe(408);
    expect((await handler(request(query()))).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid UTF-8 and invalid JSON without echoing their contents', async () => {
    const { handler, fetcher } = setup();
    for (const body of [new Uint8Array([0xff]), new TextEncoder().encode(`{"private":"${SECRET}"`)]) {
      const response = await handler(new Request(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
      expect(response.status).toBe(400); expect(await response.text()).not.toContain(SECRET);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('marks only the local response bound for safe page-size reduction and never returns a partial page', async () => {
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"data":['));
      controller.enqueue(new Uint8Array(1024)); controller.close();
    } });
    const { handler } = setup(vi.fn<typeof fetch>(async () => new Response(oversized, { headers: { 'Content-Length': '1' } })), { limits: { responseBytes: 512 } });
    const response = await handler(request(query()));
    expect(response.status).toBe(413); expect(response.headers.get('X-Arkiv-Read-Error')).toBe('response_too_large');
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32098,
      message: 'This read exceeds the response limit. No partial result was returned.' } });
    const upstream = setup(vi.fn<typeof fetch>(async () => new Response(SECRET, { status: 413 })));
    expect((await upstream.handler(request(query()))).headers.has('X-Arkiv-Read-Error')).toBe(false);
  });

  it.each([401, 403, 429, 500, 502, 503, 504])('preserves HTTP %i while removing provider credentials, URLs and error bodies', async status => {
    const { handler } = setup(vi.fn<typeof fetch>(async () => new Response(`https://rpc.test/${SECRET} raw failure`,
      { status, headers: { 'Retry-After': '70', 'X-Provider-Debug': SECRET } })));
    const response = await handler(request(query()));
    expect(response.status).toBe(status); expect(await response.text()).not.toContain(SECRET);
    expect([...response.headers.values()].join('|')).not.toContain(SECRET);
  });

  it('retains a monthly quota delay, prevents further upstream requests, and recovers when the deadline passes', async () => {
    let now = Date.UTC(2026, 9, 13);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(SECRET, { status: 429, headers: { 'Retry-After': '86400' } }))
      .mockImplementation(async () => success(page()));
    const { handler } = setup(fetcher, { now: () => now });
    const first = await handler(request(query())); expect(first.status).toBe(429); expect(first.headers.get('Retry-After')).toBe('86400');
    now += 10_000;
    const second = await handler(request(query())); expect(second.status).toBe(429); expect(second.headers.get('Retry-After')).toBe('86390');
    expect(fetcher).toHaveBeenCalledTimes(1); now += 86_400_000;
    expect((await handler(request(query()))).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts Retry-After dates and bounds maliciously large or malformed metadata', async () => {
    const now = Date.UTC(2026, 9, 13);
    for (const [header, expected] of [[new Date(now + 120_000).toUTCString(), '120'], ['999999999999999', '2678400'], [SECRET, '30']]) {
      const { handler } = setup(vi.fn<typeof fetch>(async () => new Response('', { status: 429, headers: { 'Retry-After': header! } })), { now: () => now });
      expect((await handler(request(query()))).headers.get('Retry-After')).toBe(expected);
    }
  });

  it('normalizes a later quota reset into Retry-After without forwarding unsafe provider headers', async () => {
    const now = Date.UTC(2026, 9, 13);
    const { handler } = setup(vi.fn<typeof fetch>(async () => new Response(SECRET, { status: 429,
      headers: { 'Retry-After': '10', 'X-RateLimit-Reset': String(now / 1000 + 86_400), 'X-Quota-Reset': SECRET } })), { now: () => now });
    const response = await handler(request(query()));
    expect(response.headers.get('Retry-After')).toBe('86400'); expect(response.headers.has('X-Quota-Reset')).toBe(false);
  });

  it('classifies missing or malformed provider bodies as upstream failures, without suggesting a smaller page', async () => {
    for (const response of [new Response(null, { status: 204 }), new Response('{}', { headers: { 'Content-Length': 'invalid' } }),
      new Response(`{"private":"${SECRET}"`)]) {
      const { handler } = setup(vi.fn<typeof fetch>(async () => response));
      const result = await handler(request(query())); expect(result.status).toBe(502);
      expect(result.headers.has('X-Arkiv-Read-Error')).toBe(false); expect(await result.text()).not.toContain(SECRET);
    }
  });

  it('preserves a cursor error code but discards all provider error message/data fields', async () => {
    const { handler } = setup(vi.fn<typeof fetch>(async () => Response.json({ jsonrpc: '2.0', id: 1,
      error: { code: -32005, message: SECRET, data: { url: `https://rpc.test/${SECRET}` } } })));
    const response = await handler(request(query()));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1,
      error: { code: -32005, message: 'The public network rejected this read.' } });
  });

  it.each([
    { jsonrpc: '2.0', id: 1, result: page(), error: { code: -32005, message: SECRET } },
    { jsonrpc: '2.0', id: 2, result: page() },
    { jsonrpc: '2.0', id: 1, result: { ...page(), blockNumber: '0x65' } },
    { jsonrpc: '2.0', id: 1, result: { ...page(), data: [{ payload: SECRET }] } },
    { jsonrpc: '2.0', id: 1, result: { ...page(), error: SECRET } },
  ])('rejects malformed, mixed-success, wrong-snapshot and credential-echo provider envelopes: %#', async body => {
    const { handler } = setup(vi.fn<typeof fetch>(async () => Response.json(body)));
    const response = await handler(request(query())); expect(response.status).toBe(502);
    const text = await response.text(); expect(text).not.toContain(SECRET); expect(text).not.toContain('"result"');
  });

  it('bounds fetch time even when an upstream implementation ignores abort, then recovers', async () => {
    vi.useFakeTimers(); let now = 1_000;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async () => success(page()));
    const { handler } = setup(fetcher, { now: () => now, limits: { upstreamTimeoutMs: 20 } });
    const pending = handler(request(query())); await vi.advanceTimersByTimeAsync(21);
    expect((await pending).status).toBe(504);
    expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
    now += 2_100; expect((await handler(request(query()))).status).toBe(200);
  });

  it('bounds a stalled upstream response stream as part of the same upstream deadline', async () => {
    vi.useFakeTimers();
    const { handler } = setup(vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }))),
      { limits: { upstreamTimeoutMs: 20 } });
    const pending = handler(request(query())); await vi.advanceTimersByTimeAsync(21); expect((await pending).status).toBe(504);
  });

  it('does not expose fetch exceptions or follow provider redirects', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { expect(init?.redirect).toBe('error'); throw new Error(`redirect https://elsewhere.test/${SECRET}`); });
    const response = await setup(fetcher).handler(request(query())); expect(response.status).toBe(502); expect(await response.text()).not.toContain(SECRET);
  });
});

describe('admitted header-operation budgets', () => {
  it('counts every repeated-height batch member and scalar header against the same independent allowance', async () => {
    const forwarded: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const input = JSON.parse(options!.body as string);
      const requests = Array.isArray(input) ? input : [input]; forwarded.push(requests.length);
      const replies = requests.map(item => ({ jsonrpc: '2.0', id: item.id, result: item.method === 'eth_chainId' ? '0x7614d1'
        : { number: item.params[0], hash: ENTITY, timestamp: '0x1' } }));
      return Response.json(Array.isArray(input) ? replies : replies[0]);
    });
    const { handler } = setup(fetcher, { now: () => 0, limits: { headerIpBurst: 32, headerInstanceBurst: 32 } });
    const repeated = headerBatch(32).map(item => ({ ...item, params: ['0x64', false] }));
    expect((await handler(request(repeated))).status).toBe(200);
    const limited = await handler(request(rpc('eth_getBlockByNumber', ['0x64', false])));
    expect(limited.status).toBe(429); expect(limited.headers.get('Retry-After')).toBe('1');
    expect((await handler(request(rpc('eth_chainId')))).status).toBe(200);
    expect(forwarded).toEqual([32, 1]);
  });

  it('rejects a whole batch above a lowered header cap before forwarding any member', async () => {
    const { handler, fetcher } = setup(undefined, { now: () => 0, limits: { headerIpBurst: 1, headerInstanceBurst: 1 } });
    const response = await handler(request(headerBatch()));
    expect(response.status).toBe(429); expect(fetcher).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(headerBatch().map(item => ({ jsonrpc: '2.0', id: item.id,
      error: { code: -32099, message: 'Several reads are already in progress. Try again shortly.' } })));
  });

  it('preserves both header buckets on rejected IP admission and bounds all IPs together', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(headerReplies()));
    const { handler } = setup(fetcher, { now: () => 0, limits: { headerIpBurst: 2, headerInstanceBurst: 4 } });
    const from = (ip: string) => request(headerBatch(), { headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': ip } });
    expect((await handler(from('192.0.2.1'))).status).toBe(200);
    expect((await handler(from('192.0.2.1'))).status).toBe(429);
    expect((await handler(from('192.0.2.2'))).status).toBe(200);
    expect((await handler(from('192.0.2.3'))).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves the new IP allowance when the shared instance header budget rejects it', async () => {
    let clock = 0;
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async () => Response.json(headerReplies())), {
      now: () => clock, limits: { headerIpBurst: 2, headerIpPerMinute: 1, headerInstanceBurst: 2, headerInstancePerMinute: 60 },
    });
    const from = (ip: string) => request(headerBatch(), { headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': ip } });
    expect((await handler(from('192.0.2.1'))).status).toBe(200);
    expect((await handler(from('192.0.2.2'))).status).toBe(429);
    clock = 2_000; expect((await handler(from('192.0.2.2'))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares units between scalar and batch requests without debiting a partially affordable batch', async () => {
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async (_url, options) => {
      const input = JSON.parse(options!.body as string);
      return Array.isArray(input) ? Response.json(headerReplies(input.length)) : success({ number: '0x64', hash: ENTITY, timestamp: '0x1' });
    }), { now: () => 0, limits: { headerIpBurst: 4, headerInstanceBurst: 4, headerIpPerMinute: 60, headerInstancePerMinute: 60 } });
    const single = () => request(rpc('eth_getBlockByNumber', ['0x64', false]));
    expect((await handler(request(headerBatch()))).status).toBe(200);
    expect((await handler(single())).status).toBe(200);
    const partial = await handler(request(headerBatch()));
    expect(partial.status).toBe(429); expect(partial.headers.get('Retry-After')).toBe('1');
    expect((await handler(single())).status).toBe(200);
    expect((await handler(single())).status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('returns the full-batch deficit from the slower bucket and admits only after complete refill', async () => {
    let clock = 0;
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async () => Response.json(headerReplies(4))), {
      now: () => clock, limits: { headerIpBurst: 4, headerIpPerMinute: 60, headerInstanceBurst: 4, headerInstancePerMinute: 30 },
    });
    expect((await handler(request(headerBatch(4)))).status).toBe(200);
    clock = 1_000; const response = await handler(request(headerBatch(4)));
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('7');
    clock = 7_999; expect((await handler(request(headerBatch(4)))).status).toBe(429);
    clock = 8_000; expect((await handler(request(headerBatch(4)))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not charge header units for malformed batches or missing credentials, while HTTP admission remains independent', async () => {
    let credential: string | undefined;
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async () => success({ number: '0x64', hash: ENTITY, timestamp: '0x1' })), {
      now: () => 0, accessKey: () => credential, limits: { headerIpBurst: 1, headerInstanceBurst: 1, ipBurst: 3 },
    });
    expect((await handler(request([...headerBatch(1), rpc('eth_chainId', [], 2)]))).status).toBe(400);
    expect((await handler(request(rpc('eth_getBlockByNumber', ['0x64', false])))).status).toBe(503);
    credential = SECRET;
    expect((await handler(request(rpc('eth_getBlockByNumber', ['0x64', false])))).status).toBe(200);
    expect((await handler(request(rpc('eth_chainId')))).status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains admitted header units when the provider returns an RPC failure', async () => {
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async () => Response.json({ jsonrpc: '2.0', id: 1,
      error: { code: -32000, message: 'not available' } })), { now: () => 0, limits: { headerIpBurst: 1, headerInstanceBurst: 1 } });
    expect((await handler(request(rpc('eth_getBlockByNumber', ['0x64', false])))).status).toBe(200);
    expect((await handler(request(rpc('eth_getBlockByNumber', ['0x64', false])))).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains admitted header units when a queued request is cancelled before reaching the provider', async () => {
    let release!: (response: Response) => void, admitted = () => {}, credentials = 0;
    const headerAdmitted = new Promise<void>(resolve => { admitted = resolve; });
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; })), {
      now: () => 0, accessKey: () => { if (++credentials === 2) admitted(); return SECRET; },
      limits: { maxConcurrent: 1, maxQueued: 1, headerIpBurst: 1, headerInstanceBurst: 1 },
    });
    const first = handler(request(query())); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const leaving = new AbortController();
    const queued = handler(request(rpc('eth_getBlockByNumber', ['0x64', false]), { signal: leaving.signal }));
    await headerAdmitted; leaving.abort(); expect((await queued).status).toBe(408);
    expect((await handler(request(rpc('eth_getBlockByNumber', ['0x64', false])))).status).toBe(429);
    release(success(page())); expect((await first).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('bounded standard block-header batches', () => {
  it('accepts exactly32 headers in one upstream request and remaps reordered responses to every caller ID', async () => {
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(options?.body as string);
      expect(body).toHaveLength(MAX_HEADER_BATCH_SIZE);
      expect(body.every((item: { method: string; params: unknown[] }, index: number) => item.method === 'eth_getBlockByNumber'
        && item.params[0] === headerBatch(MAX_HEADER_BATCH_SIZE)[index]!.params![0] && item.params[1] === false)).toBe(true);
      return Response.json(headerReplies(MAX_HEADER_BATCH_SIZE).reverse());
    }));
    const response = await handler(request(headerBatch(MAX_HEADER_BATCH_SIZE)));
    expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual(headerReplies(MAX_HEADER_BATCH_SIZE).map((item, index) => ({ ...item, id: `header-${index}` })));
  });

  it.each([
    [], headerBatch(MAX_HEADER_BATCH_SIZE + 1), [headerBatch()[0], rpc('eth_chainId', [], 'other')],
    [headerBatch()[0], { ...query(), id: 'other' }], [headerBatch()[0], { ...headerBatch()[1], params: ['latest', false] }],
    [headerBatch()[0], { ...headerBatch()[1], params: ['0x65', true] }],
    [headerBatch()[0], { ...headerBatch()[1], id: 'header-0' }],
  ].map(body => ({ body })))('rejects an empty, oversized, mixed, inexact or duplicate-ID batch before contacting upstream: %#', async ({ body }) => {
    const { handler, fetcher } = setup();
    expect((await handler(request(body))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains an individual provider error under its own ID without exposing provider messages or claiming success', async () => {
    const { handler } = setup(vi.fn<typeof fetch>(async () => Response.json([
      { jsonrpc: '2.0', id: 2, error: { code: -32005, message: SECRET, data: SECRET } }, headerReplies()[0],
    ])));
    const response = await handler(request(headerBatch()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ ...headerReplies()[0], id: 'header-0' },
      { jsonrpc: '2.0', id: 'header-1', error: { code: -32005, message: 'The public network rejected this read.' } }]);
  });

  it.each([
    [headerReplies()[0]], [...headerReplies(), { ...headerReplies()[0], id: 3 }],
    [headerReplies()[0], headerReplies()[0]], [headerReplies()[0], { ...headerReplies()[1], id: 3 }],
    [headerReplies()[0], { ...headerReplies()[1], id: '2' }],
    [headerReplies()[0], { ...headerReplies()[1], jsonrpc: '1.0' }],
    [headerReplies()[0], { ...headerReplies()[1], error: { code: -32005 } }],
    [headerReplies()[0], { jsonrpc: '2.0', id: 2, error: { code: 'invalid' } }],
    [headerReplies()[0], { ...headerReplies()[1], result: { payload: SECRET } }], headerReplies()[0],
  ].map(body => ({ body })))('rejects incomplete, duplicate, foreign or malformed provider replies as a whole: %#', async ({ body }) => {
    const { handler } = setup(vi.fn<typeof fetch>(async () => Response.json(body)));
    const response = await handler(request(headerBatch()));
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.map((item: { id: string }) => item.id)).toEqual(['header-0', 'header-1']);
    expect(data.every((item: { error?: unknown; result?: unknown }) => item.error && !Object.hasOwn(item, 'result'))).toBe(true);
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it('applies the existing aggregate byte limit to the whole batch', async () => {
    const { handler } = setup(vi.fn<typeof fetch>(async () => Response.json(headerReplies().map(item => ({
      ...item, result: { ...item.result, extraData: 'a'.repeat(300) },
    })))), { limits: { responseBytes: 512 } });
    const response = await handler(request(headerBatch()));
    expect(response.status).toBe(413); expect(response.headers.get('X-Arkiv-Read-Error')).toBe('response_too_large');
    expect((await response.json()).every((item: { error: { code: number } }) => item.error.code === -32098)).toBe(true);
  });

  it('bounds a stalled batch with the same upstream deadline and cancellation', async () => {
    vi.useFakeTimers();
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(() => new Promise(() => {})), { limits: { upstreamTimeoutMs: 20 } });
    const pending = handler(request(headerBatch())); await vi.advanceTimersByTimeAsync(21);
    const response = await pending;
    expect(response.status).toBe(504); expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect((await response.json()).map((item: { id: string }) => item.id)).toEqual(['header-0', 'header-1']);
  });

  it('keeps overlapping recheck batches independent within the shared concurrency limit', async () => {
    const releases: ((response: Response) => void)[] = [];
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(() => new Promise(resolve => releases.push(resolve))),
      { limits: { maxConcurrent: 1, maxQueued: 1 } });
    const first = handler(request(headerBatch())), recheck = handler(request(headerBatch()));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((await handler(request(headerBatch()))).status).toBe(429);
    releases[0]!(Response.json(headerReplies())); expect((await first).status).toBe(200);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releases[1]!(Response.json(headerReplies().map(item => ({ ...item, result: { ...item.result, hash: OTHER } }))));
    expect((await (await recheck).json()).every((item: { result: { hash: string } }) => item.result.hash === OTHER)).toBe(true);
  });
});

describe('concurrency and freshness', () => {
  it('coalesces only active identical pinned reads, remaps IDs and makes a new request after completion', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockImplementation(async () => success(page()));
    const { handler } = setup(fetcher);
    const first = handler(request(query())), second = handler(request({ ...query(), id: 'second' }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); release(success(page()));
    expect((await (await first).json()).id).toBe(1); expect((await (await second).json()).id).toBe('second');
    expect((await handler(request(query()))).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber'])('never shares even an overlapping fresh %s check', async method => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => releases.push(resolve)));
    const { handler } = setup(fetcher);
    const body = rpc(method, method === 'eth_getBlockByNumber' ? ['0x64', false] : []);
    const first = handler(request(body)), second = handler(request(body));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    for (const release of releases) release(success(method === 'eth_getBlockByNumber' ? { number: '0x64' } : '0x64'));
    expect((await first).status).toBe(200); expect((await second).status).toBe(200);
  });

  it('does not cancel another consumer when one leaves, but cancels an abandoned sole flight', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
    const { handler } = setup(fetcher), leaving = new AbortController();
    const first = handler(request(query(), { signal: leaving.signal })), second = handler(request(query()));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); leaving.abort();
    expect((await first).status).toBe(408); expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(false);
    release(success(page())); expect((await second).status).toBe(200);
    const sole = new AbortController(), third = handler(request(query(), { signal: sole.signal }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); sole.abort();
    expect((await third).status).toBe(408); expect(fetcher.mock.calls[1]![1]!.signal?.aborted).toBe(true);
  });

  it('bounds the queue without dropping any already admitted result', async () => {
    const releases: ((response: Response) => void)[] = [];
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(() => new Promise(resolve => releases.push(resolve))),
      { limits: { maxConcurrent: 1, maxQueued: 1 } });
    const first = handler(request(rpc('eth_blockNumber'))), second = handler(request(rpc('eth_chainId')));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((await handler(request(rpc('eth_gasPrice')))).status).toBe(429);
    releases[0]!(success('0x64')); expect((await first).status).toBe(200);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); releases[1]!(success('0x7614d1'));
    expect((await second).status).toBe(200);
  });

  it('expires a queued request and releases its place', async () => {
    vi.useFakeTimers(); let release!: (response: Response) => void;
    const { handler, fetcher } = setup(vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; })),
      { limits: { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 20 } });
    const first = handler(request(rpc('eth_blockNumber'))), second = handler(request(rpc('eth_chainId')));
    await vi.advanceTimersByTimeAsync(21); expect((await second).status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(1);
    release(success('0x64')); expect((await first).status).toBe(200);
  });

  it('rate-limits invalid attempts per IP and independently bounds traffic across forged IP headers', async () => {
    const perIp = setup(undefined, { limits: { ipBurst: 1, ipPerMinute: 1 } });
    expect((await perIp.handler(request(rpc('eth_sendTransaction')))).status).toBe(403);
    const denied = await perIp.handler(request(query())); expect(denied.status).toBe(429); expect(denied.headers.get('Retry-After')).toBeTruthy();
    expect(perIp.fetcher).not.toHaveBeenCalled();
    const global = setup(undefined, { limits: { instanceBurst: 1, instancePerMinute: 1 } });
    expect((await global.handler(request(query(), { headers: { 'Content-Type': 'application/json', 'X-Vercel-Forwarded-For': '192.0.2.1' } }))).status).toBe(200);
    expect((await global.handler(request(query(), { headers: { 'Content-Type': 'application/json', 'X-Vercel-Forwarded-For': '192.0.2.2' } }))).status).toBe(429);
    expect(global.fetcher).toHaveBeenCalledTimes(1);
  });

  it('publishes bounds compatible with the existing hosted transport and platform body ceiling', () => {
    expect(ARKIV_READ_LIMITS.requestBytes).toBeLessThan(4_500_000);
    expect(ARKIV_READ_LIMITS.responseBytes).toBeLessThan(4_500_000);
    expect(ARKIV_READ_LIMITS.upstreamTimeoutMs + ARKIV_READ_LIMITS.queueTimeoutMs).toBeLessThan(10_000);
    expect(() => setup(undefined, { limits: { maxConcurrent: 99 } })).toThrow('Invalid read service bounds.');
  });
});
