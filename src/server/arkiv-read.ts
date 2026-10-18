import { isIP } from 'node:net';
import { hexToBytes, toEventSelector, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { MAX_HEADER_BATCH_SIZE } from '../data/arkiv/read-policy.js';
import { MAX_EVENT_RESERVATIONS } from '../domain/events/types.js';

const UPSTREAM = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network';
const NATIVE = '0x4400000000000000000000000000000000000044';
const EXECUTE = toFunctionSelector('execute((uint8,bytes)[])');
const CREATED = toEventSelector('EntityCreated(bytes32,address,uint64,uint8)');
const KEY = /^0x[\da-fA-F]{64}$/;
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const CORE_TYPES = ['project_root', 'publisher_root', 'project_state', 'book_state', 'proposal', 'plan_activation', 'project_link'];
const EVENT_TYPES = ['event_release', 'event_state', 'attendance_state'];
// SDK 0.8.1 toRpcSelect(ENTITY_SELECTION) explicitly emits the two false fields.
const SELECTION: Record<string, boolean> = { key: true, owner: true, creator: true, createdAt: true,
  updatedAt: false, expiresAt: true, creationFlags: true, contentType: true, payload: true,
  attributeSchema: false, attributes: true };

// Two independent historical-header passes for one maximum managed roster, plus one
// batch of head/recheck reserve. This allowance is 1056 admitted header operations.
const HEADER_TRAVERSAL_UNITS = 2 * MAX_EVENT_RESERVATIONS + MAX_HEADER_BATCH_SIZE;

/** Service bounds, not Arkiv protocol limits. No settled responses or chain heads are cached. */
export const ARKIV_READ_LIMITS = Object.freeze({
  requestBytes: 2 * 1024 * 1024, responseBytes: 4 * 1024 * 1024,
  bodyTimeoutMs: 2_000, upstreamTimeoutMs: 7_000, queueTimeoutMs: 1_500,
  maxIncoming: 64, maxConcurrent: 3, maxQueued: 24,
  instanceBurst: 180, instancePerMinute: 600, ipBurst: 96, ipPerMinute: 240, maxIpEntries: 1024,
  // Two reads in an IP burst; one full read per 15 seconds sustained. Instance bounds
  // allow four burst reads and three independent readers at that cadence. HTTP caps also apply.
  headerIpBurst: 2 * HEADER_TRAVERSAL_UNITS, headerIpPerMinute: 4 * HEADER_TRAVERSAL_UNITS,
  headerInstanceBurst: 4 * HEADER_TRAVERSAL_UNITS, headerInstancePerMinute: 12 * HEADER_TRAVERSAL_UNITS,
});
type Limits = { [K in keyof typeof ARKIV_READ_LIMITS]: number };
export interface ArkivReadHandlerOptions {
  /** Supplied only by the server entry point; never accepted from request data. */
  accessKey: () => string | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Tests and deployments may lower, but never raise, the published service bounds. */
  limits?: Partial<Limits>;
}
type Id = number | string | null;
type Rpc = { jsonrpc: '2.0'; id: Id; method: string; params: unknown[] };
type Reply = { result: unknown } | { error: { code: number; message: string } };
class Failure extends Error {
  constructor(readonly status: number, readonly code: number, message: string, readonly retryAfter?: number) { super(message); }
}
const invalid = () => new Failure(400, -32602, 'This read request has unsupported parameters.');
const busy = (seconds = 1) => new Failure(429, -32099, 'Several reads are already in progress. Try again shortly.', seconds);
const cancelled = () => new Failure(408, -32099, 'This read was cancelled.');
const upstreamFailure = () => new Failure(502, -32099, 'The public network could not complete this read.');
function requireValue(condition: unknown): asserts condition { if (!condition) throw invalid(); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function quantity(value: unknown, bits = 256): value is string {
  return typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][\da-fA-F]*)$/.test(value)
    && value.length <= 2 + Math.ceil(bits / 4) && BigInt(value) < 2n ** BigInt(bits);
}
function textValue(value: unknown, maxBytes: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && !/[\u0000-\u001f\u007f]/.test(value)
    && encoder.encode(value).length <= maxBytes;
}
function validId(id: unknown): id is number | string {
  return (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)
    || (typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(id));
}
function validType(namespace: unknown, type: unknown): boolean {
  return typeof type === 'string' && (namespace === 'partfolk' ? CORE_TYPES.includes(type)
    : namespace === 'partfolk-events' && EVENT_TYPES.includes(type));
}

interface Atom { field: string; operator: string; tag: string; value: string }
/** Parse the whole SDK expression. Quotes are doubled; backslashes never escape a quote. */
function queryAtoms(source: string): Atom[] {
  requireValue(textValue(source, 4096));
  let offset = 0;
  const atoms: Atom[] = [];
  const whitespace = () => { while (source[offset] === ' ') offset++; };
  const take = (literal: string) => { requireValue(source.slice(offset, offset + literal.length) === literal); offset += literal.length; };
  const factor = (depth: number): void => {
    requireValue(depth <= 8); whitespace();
    if (source[offset] === '(') { offset++; expression(depth + 1); take(')'); return; }
    const start = /^(\$[a-zA-Z]+|[a-z][a-z0-9_]*) *(=|>=|<=) *(str|key|addr|i32|u64)\(/.exec(source.slice(offset));
    requireValue(start); offset += start[0].length;
    const [, field, operator, tag] = start;
    let value = '';
    if (tag === 'str') {
      take("'"); let closed = false;
      while (offset < source.length) {
        const char = source[offset++]!;
        if (char !== "'") { value += char; continue; }
        if (source[offset] === "'") { value += "'"; offset++; continue; }
        closed = true; break;
      }
      requireValue(closed && textValue(value, 128));
    } else {
      const literal = /^(?:0x[\da-fA-F]+|0|[1-9]\d*)/.exec(source.slice(offset));
      requireValue(literal); value = literal[0]; offset += value.length;
      requireValue(tag === 'key' ? KEY.test(value) : tag === 'addr' ? ADDRESS.test(value)
        : /^(0|[1-9]\d*)$/.test(value) && value.length <= 20 && BigInt(value) < (tag === 'u64' ? 2n ** 64n : 2n ** 31n));
    }
    take(')'); requireValue(atoms.length < 24);
    atoms.push({ field: field!, operator: operator!, tag: tag!, value });
  };
  const expression = (depth: number): void => {
    factor(depth); whitespace();
    while (offset < source.length && source[offset] !== ')') {
      take('AND'); requireValue(source[offset] === ' ' || source[offset] === '('); factor(depth); whitespace();
    }
  };
  expression(0); requireValue(offset === source.length);
  requireValue(new Set(atoms.map(atom => atom.field)).size === atoms.length);
  return atoms;
}

function validateQuery(expression: unknown, options: unknown): void {
  requireValue(typeof expression === 'string' && object(options) && keys(options, ['atBlock', 'limit', 'select'], ['cursor']));
  requireValue(quantity(options.atBlock, 64) && quantity(options.limit, 32) && BigInt(options.limit) >= 1n && BigInt(options.limit) <= 200n);
  requireValue(object(options.select) && keys(options.select, Object.keys(SELECTION))
    && Object.entries(SELECTION).every(([key, value]) => (options.select as Record<string, unknown>)[key] === value));
  requireValue(options.cursor === undefined || textValue(options.cursor, 4096));
  const atoms = queryAtoms(expression), byField = new Map(atoms.map(atom => [atom.field, atom]));
  const exact = (name: string, tag: string, value?: string) => {
    const atom = byField.get(name);
    return !!atom && atom.operator === '=' && atom.tag === tag && (value === undefined || atom.value === value);
  };
  if (byField.has('$key')) {
    // Do not hide foreign or malformed referenced records behind a namespace filter.
    requireValue(atoms.length === 1 && exact('$key', 'key') && BigInt(options.limit) <= 2n); return;
  }
  const namespace = byField.get('project')?.value;
  requireValue(exact('project', 'str') && (namespace === 'partfolk' || namespace === 'partfolk-events'));
  if (byField.has('operation_id')) {
    requireValue(atoms.length === 3 && exact('operation_id', 'str') && exact('$creator', 'addr')); return;
  }
  const type = byField.get('entity_type')?.value;
  requireValue(exact('entity_type', 'str') && validType(namespace, type));
  const extra: Record<string, string[]> = {
    project_root: [], publisher_root: [], project_state: ['project_key'], book_state: ['book_key'],
    proposal: ['project_key'], plan_activation: ['project_key', 'proposal_key'],
    project_link: ['project_key', 'publisher_key', 'link_kind'],
    event_release: ['project_key', 'starts_at', 'ends_at'], event_state: ['project_key', 'starts_at', 'ends_at'],
    attendance_state: ['project_key'],
  };
  for (const atom of atoms) {
    if (atom.field === 'project' || atom.field === 'entity_type') continue;
    if (atom.field === '$creator') { requireValue(exact('$creator', 'addr')); continue; }
    if (atom.field === 'schema_version') { requireValue(exact('schema_version', 'i32', '1')); continue; }
    requireValue(extra[type!]?.includes(atom.field));
    if (atom.field === 'link_kind') requireValue(exact('link_kind', 'str') && ['offer', 'request'].includes(atom.value));
    else if (atom.field === 'starts_at' || atom.field === 'ends_at') requireValue(atom.tag === 'u64'
      && atom.operator === (atom.field === 'starts_at' ? '<=' : '>=') && BigInt(atom.value) <= 8_640_000_000_000_000n);
    else requireValue(exact(atom.field, 'key'));
  }
}

function word(hex: string, byteOffset: number): bigint {
  requireValue(Number.isSafeInteger(byteOffset) && byteOffset >= 0 && byteOffset * 2 + 64 <= hex.length);
  return BigInt(`0x${hex.slice(byteOffset * 2, byteOffset * 2 + 64)}`);
}
function count(hex: string, offset: number, maximum: number): number {
  const value = word(hex, offset); requireValue(value <= BigInt(maximum)); return Number(value);
}
function bytes(hex: string, offset: number, maximum: number): { value: string; end: number } {
  const length = count(hex, offset, maximum), end = offset + 32 + Math.ceil(length / 32) * 32;
  requireValue(end * 2 <= hex.length && /^0*$/.test(hex.slice((offset + 32 + length) * 2, end * 2)));
  return { value: hex.slice((offset + 32) * 2, (offset + 32 + length) * 2), end };
}
function decodeText(hex: string): string { return utf8.decode(hexToBytes(`0x${hex}` as Hex)); }
const ATTRIBUTE_TYPES: Record<string, number> = { project: 8, entity_type: 8, schema_version: 2, created_at: 3,
  operation_id: 8, project_key: 10, book_key: 10, requirements_hash: 6, proposal_hash: 6, proposal_key: 10,
  link_kind: 8, publisher_key: 10, activation_key: 10, audience_hash: 6, starts_at: 3, ends_at: 3,
  release_key: 10, status: 8, decision: 8, $payload: 7, $contentType: 8 };

function validateCreate(hex: string): void {
  requireValue(word(hex, 0) === 32n && word(hex, 32) < 2n ** 128n && word(hex, 64) < 2n ** 64n
    && word(hex, 96) < 2n ** 64n && word(hex, 128) === 1n && word(hex, 160) === 160n);
  const length = count(hex, 192, 32), attributes = new Map<string, string>();
  let next = 224 + length * 32, previous = '';
  for (let index = 0; index < length; index++) {
    requireValue(word(hex, 224 + index * 32) === BigInt(next - 224));
    const nameHex = hex.slice(next * 2, next * 2 + 64);
    requireValue(nameHex.length === 64 && nameHex > previous); previous = nameHex;
    const nameBytes = nameHex.replace(/(?:00)+$/, ''), name = decodeText(nameBytes);
    requireValue(/^(?:[a-z][a-z0-9_]{0,31}|\$payload|\$contentType)$/.test(name)
      && Object.hasOwn(ATTRIBUTE_TYPES, name) && word(hex, next + 32) === BigInt(ATTRIBUTE_TYPES[name]!)
      && word(hex, next + 64) === 96n);
    const cell = bytes(hex, next + 96, name === '$payload' ? 120 * 1024 : 128); next = cell.end;
    const type = ATTRIBUTE_TYPES[name];
    if (type === 8) { const value = decodeText(cell.value); requireValue(textValue(value, 128, true)); attributes.set(name, value); }
    else if (type === 7) attributes.set(name, decodeText(cell.value));
    else {
      requireValue(cell.value.length === 64);
      if (type === 3) requireValue(BigInt(`0x${cell.value}`) < 2n ** 64n);
      if (name === 'schema_version') requireValue(BigInt(`0x${cell.value}`) === 1n);
      attributes.set(name, cell.value);
    }
  }
  requireValue(next * 2 === hex.length && attributes.has('schema_version') && attributes.get('$contentType') === 'application/json'
    && validType(attributes.get('project'), attributes.get('entity_type')) && attributes.has('$payload'));
  let payload: unknown;
  try { payload = JSON.parse(attributes.get('$payload')!); } catch { throw invalid(); }
  requireValue(object(payload) && payload.entityType === attributes.get('entity_type'));
}

/** Canonical SDK 0.8.1 framing, with bounds checked before following any ABI length or offset. */
function validateNativeData(value: unknown): void {
  requireValue(typeof value === 'string' && value.length <= 2 + 900 * 1024 * 2 && /^0x(?:[\da-fA-F]{2})+$/.test(value));
  requireValue(value.slice(0, 10).toLowerCase() === EXECUTE);
  const hex = value.slice(10).toLowerCase();
  requireValue(word(hex, 0) === 32n);
  const length = count(hex, 32, 128); requireValue(length > 0);
  let next = 64 + length * 32;
  for (let index = 0; index < length; index++) {
    requireValue(word(hex, 64 + index * 32) === BigInt(next - 64) && word(hex, next + 32) === 64n);
    const operation = count(hex, next, 5), payload = bytes(hex, next + 64, 900 * 1024); next = payload.end;
    if (operation === 1) validateCreate(payload.value);
    else if (operation === 5) requireValue(payload.value.length === 64);
    else if (operation === 3) requireValue(payload.value.length === 192 && word(payload.value, 32) < 2n ** 64n
      && word(payload.value, 64) < 2n ** 64n);
    else throw invalid();
  }
  requireValue(next * 2 === hex.length);
}
function validateEstimate(value: unknown): void {
  requireValue(object(value) && keys(value, ['from', 'to', 'data', 'value'], ['chainId', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']));
  requireValue(typeof value.from === 'string' && ADDRESS.test(value.from) && !/^0x0{40}$/i.test(value.from)
    && value.from.toLowerCase() !== NATIVE && typeof value.to === 'string' && value.to.toLowerCase() === NATIVE && value.value === '0x0');
  requireValue(value.chainId === undefined || value.chainId === '0x7614d1');
  for (const name of ['gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) requireValue(value[name] === undefined || quantity(value[name]));
  requireValue(value.gas === undefined || BigInt(value.gas as string) > 0n);
  requireValue(value.gasPrice === undefined || (value.maxFeePerGas === undefined && value.maxPriorityFeePerGas === undefined));
  requireValue(value.maxFeePerGas === undefined || value.maxPriorityFeePerGas === undefined
    || BigInt(value.maxPriorityFeePerGas as string) <= BigInt(value.maxFeePerGas as string));
  validateNativeData(value.data);
}
function validateLogs(value: unknown): void {
  requireValue(object(value) && keys(value, ['address', 'fromBlock', 'toBlock', 'topics']) && typeof value.address === 'string'
    && value.address.toLowerCase() === NATIVE && quantity(value.fromBlock, 64) && value.toBlock === value.fromBlock
    && Array.isArray(value.topics) && value.topics.length >= 1 && value.topics.length <= 3 && value.topics[0] === CREATED);
  if (value.topics.length >= 2) requireValue(value.topics[1] === null || (typeof value.topics[1] === 'string' && KEY.test(value.topics[1])));
  if (value.topics.length === 3) requireValue(typeof value.topics[2] === 'string' && /^0x0{24}[\da-fA-F]{40}$/.test(value.topics[2]));
}
function validateRpc(value: unknown): Rpc {
  requireValue(object(value) && keys(value, ['jsonrpc', 'id', 'method'], ['params']) && value.jsonrpc === '2.0' && validId(value.id));
  const params = value.params ?? [];
  requireValue(Array.isArray(params) && (value.params !== null));
  switch (value.method) {
    case 'eth_chainId': case 'eth_blockNumber': case 'eth_gasPrice': requireValue(params.length === 0); break;
    case 'eth_getBlockByNumber': requireValue(params.length === 2 && quantity(params[0], 64) && params[1] === false); break;
    case 'eth_getTransactionReceipt': case 'eth_getTransactionByHash': requireValue(params.length === 1 && typeof params[0] === 'string' && KEY.test(params[0])); break;
    case 'eth_getLogs': requireValue(params.length === 1); validateLogs(params[0]); break;
    case 'eth_estimateGas': requireValue(params.length === 1); validateEstimate(params[0]); break;
    case 'arkiv_query': requireValue(params.length === 2); validateQuery(params[0], params[1]); break;
    default: throw new Failure(403, -32601, 'This endpoint only supports the public reads used by Partfolk.');
  }
  return { jsonrpc: '2.0', id: value.id, method: value.method, params };
}

async function boundedJson(body: ReadableStream<Uint8Array> | null, headers: Headers, maximum: number, tooLarge: Failure,
  signal: AbortSignal): Promise<unknown> {
  const declared = headers.get('content-length');
  if (declared !== null && !/^\d+$/.test(declared)) throw new Error('Invalid body framing.');
  if (declared !== null && Number(declared) > maximum) { void body?.cancel().catch(() => undefined); throw tooLarge; }
  if (!body) throw new Error('Missing JSON body.');
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      if (signal.aborted) throw cancelled();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength; if (length > maximum) throw tooLarge; chunks.push(chunk.value);
    }
    if (signal.aborted) throw cancelled();
    const joined = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(utf8.decode(joined)) as unknown;
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
async function deadline<T>(milliseconds: number, external: AbortSignal, timeout: Failure,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(cancelled()); controller.abort(); };
      external.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { reject(timeout); controller.abort(); }, milliseconds);
      if (external.aborted) abort();
    });
    return await Promise.race([stopped, work(controller.signal)]);
  } finally { clearTimeout(timer); external.removeEventListener('abort', abort); controller.abort(); }
}
function retryDelay(headers: Headers, now: number, fallback = 30): number {
  const delays: number[] = [];
  for (const name of ['retry-after', 'x-ratelimit-reset', 'x-rate-limit-reset', 'x-quota-reset', 'ratelimit-reset']) {
    const raw = headers.get(name); if (!raw || raw.length > 128) continue;
    const numeric = /^\d+(?:\.\d+)?$/.test(raw.trim()), value = Number(raw);
    const milliseconds = numeric ? name === 'retry-after' || name === 'ratelimit-reset' ? value * 1000
      : (value < 1_000_000_000_000 ? value * 1000 : value) - now : Date.parse(raw) - now;
    if (Number.isFinite(milliseconds) && milliseconds > 0) delays.push(milliseconds);
  }
  return delays.length ? Math.max(1, Math.min(31 * 24 * 60 * 60, Math.ceil(Math.max(...delays) / 1000))) : fallback;
}
function checkResult(value: unknown, request: Rpc, secret: string): void {
  // Reject credential echoes even in a falsely successful provider envelope. No provider message is logged.
  const pending = [value]; let visited = 0;
  while (pending.length) {
    const item = pending.pop(); if (++visited > 100_000) throw upstreamFailure();
    if (typeof item === 'string' && item.includes(secret)) throw upstreamFailure();
    if (item && typeof item === 'object') {
      for (const [key, entry] of Object.entries(item)) { if (key.includes(secret)) throw upstreamFailure(); pending.push(entry); }
    }
  }
  if (['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_estimateGas'].includes(request.method)) {
    if (!quantity(value)) throw upstreamFailure();
  } else if (request.method === 'arkiv_query') {
    const settings = request.params[1] as Record<string, string>;
    if (!object(value) || !keys(value, ['data', 'blockNumber'], ['cursor']) || !Array.isArray(value.data)
      || value.data.length > Number(BigInt(settings.limit!)) || !value.data.every(object)
      || !quantity(value.blockNumber, 64) || BigInt(value.blockNumber) !== BigInt(settings.atBlock!)
      || (value.cursor !== undefined && !textValue(value.cursor, 4096, true))) throw upstreamFailure();
  } else if (request.method === 'eth_getLogs') {
    if (!Array.isArray(value) || value.length > 2048 || !value.every(object)) throw upstreamFailure();
  } else if (value !== null && !object(value)) throw upstreamFailure();
}
function respond(id: Id | Id[], reply: Reply | Reply[], status = 200, retryAfter?: number): Response {
  const ids = Array.isArray(id) ? id : [id], replies = Array.isArray(reply) ? reply : ids.map(() => reply);
  const body = replies.map((item, index) => ({ jsonrpc: '2.0', id: ids[index] ?? null, ...item }));
  return new Response(JSON.stringify(Array.isArray(id) ? body : body[0]), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0',
    'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 405 ? { Allow: 'POST' } : {}), ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }),
    ...(status === 413 && replies.some(item => 'error' in item && item.error.code === -32098) ? { 'X-Arkiv-Read-Error': 'response_too_large' } : {}),
  } });
}
interface Bucket { tokens: number; updated: number }
interface IpBuckets { requests: Bucket; headers: Bucket }
interface Flight { promise: Promise<Reply[]>; controller: AbortController; consumers: number }
interface Waiting { run: () => void; stop: () => void }

/** Per-instance admission is a bounded guard, not a distributed quota or user-authentication guarantee. */
export function createArkivReadHandler(options: ArkivReadHandlerOptions): (request: Request) => Promise<Response> {
  const limits: Limits = { ...ARKIV_READ_LIMITS, ...options.limits }, fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'maxQueued' ? 0 : 1) || value > ARKIV_READ_LIMITS[key as keyof Limits]) throw new Error('Invalid read service bounds.');
  }
  const flights = new Map<string, Flight>(), ips = new Map<string, IpBuckets>(), queue: Waiting[] = [];
  const aggregate: Bucket = { tokens: limits.instanceBurst, updated: now() };
  const aggregateHeaders: Bucket = { tokens: limits.headerInstanceBurst, updated: now() };
  let incoming = 0, active = 0, cooldownUntil = 0, cooldownStatus = 429;
  const checkCooldown = () => {
    if (cooldownUntil > now()) throw new Failure(cooldownStatus, -32099, 'The public network needs a moment. Try again later.', Math.ceil((cooldownUntil - now()) / 1000));
  };
  const refill = (bucket: Bucket, burst: number, perMinute: number, time = now()) => {
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, time - bucket.updated) * perMinute / 60_000); bucket.updated = time;
  };
  const spend = (bucket: Bucket, burst: number, perMinute: number) => {
    refill(bucket, burst, perMinute);
    if (bucket.tokens < 1) throw busy(Math.max(1, Math.ceil((1 - bucket.tokens) * 60 / perMinute))); bucket.tokens--;
  };
  const admit = (request: Request) => {
    spend(aggregate, limits.instanceBurst, limits.instancePerMinute);
    // Vercel supplies this header. Deploying behind another runtime requires a trusted-IP adapter;
    // the independent instance-wide budget still applies when headers are missing or forged there.
    const forwarded = request.headers.get('x-vercel-forwarded-for') ?? '', ip = isIP(forwarded) ? forwarded.toLowerCase() : 'unknown';
    let buckets = ips.get(ip);
    if (!buckets) {
      if (ips.size >= limits.maxIpEntries) ips.delete(ips.keys().next().value!);
      buckets = { requests: { tokens: limits.ipBurst, updated: now() }, headers: { tokens: limits.headerIpBurst, updated: now() } };
      ips.set(ip, buckets);
    }
    spend(buckets.requests, limits.ipBurst, limits.ipPerMinute); return buckets;
  };
  const admitHeaders = (ip: IpBuckets, units: number) => {
    if (!units) return;
    const time = now();
    refill(aggregateHeaders, limits.headerInstanceBurst, limits.headerInstancePerMinute, time);
    refill(ip.headers, limits.headerIpBurst, limits.headerIpPerMinute, time);
    const delay = Math.max((units - aggregateHeaders.tokens) * 60 / limits.headerInstancePerMinute,
      (units - ip.headers.tokens) * 60 / limits.headerIpPerMinute);
    if (delay > 0) throw busy(Math.max(1, Math.ceil(delay)));
    // Reserve the whole request atomically. Rejected batches cannot drain another IP's
    // header allowance. Admitted work stays charged on queue cancellation or provider failure.
    aggregateHeaders.tokens -= units; ip.headers.tokens -= units;
  };
  const schedule = (work: () => Promise<Reply[]>, signal: AbortSignal): Promise<Reply[]> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      clearTimeout(timer); signal.removeEventListener('abort', stop); active++;
      Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); checkCooldown(); return work(); }).then(resolve, reject).finally(() => {
        active--; queue.shift()?.run();
      });
    };
    const waiting: Waiting = { run, stop: () => {} };
    const remove = () => { const index = queue.indexOf(waiting); if (index >= 0) queue.splice(index, 1); clearTimeout(timer); signal.removeEventListener('abort', stop); };
    const stop = () => { remove(); reject(cancelled()); }; waiting.stop = stop;
    if (active < limits.maxConcurrent) { run(); return; }
    if (queue.length >= limits.maxQueued) { reject(busy()); return; }
    queue.push(waiting); signal.addEventListener('abort', stop, { once: true });
    timer = setTimeout(() => { remove(); reject(busy()); }, limits.queueTimeoutMs);
  });
  const callUpstream = async (requests: Rpc[], batch: boolean, secret: string, signal: AbortSignal): Promise<Reply[]> => {
    try {
      return await deadline(limits.upstreamTimeoutMs, signal, new Failure(504, -32099, 'The public network response timed out.'), async boundedSignal => {
        const outgoing = requests.map((rpc, index) => ({ jsonrpc: '2.0', id: index + 1, method: rpc.method, params: rpc.params }));
        const response = await fetcher(UPSTREAM, { method: 'POST', redirect: 'error', cache: 'no-store', signal: boundedSignal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-KEY': secret },
          body: JSON.stringify(batch ? outgoing : outgoing[0]) });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const status = [401, 403, 413, 429, 500, 502, 503, 504].includes(response.status) ? response.status : 502;
          const delay = retryDelay(response.headers, now(), status === 429 || status === 401 || status === 403 ? 30 : 2);
          if (status !== 413) { cooldownUntil = Math.max(cooldownUntil, now() + delay * 1000); cooldownStatus = status; }
          throw new Failure(status, -32099, status === 413 ? 'This read exceeds the public network response or request limit.'
            : 'The public network could not complete this read.', status === 413 ? undefined : delay);
        }
        const body = await boundedJson(response.body, response.headers, limits.responseBytes,
          new Failure(413, -32098, 'This read exceeds the response limit. No partial result was returned.'), boundedSignal);
        const entries = batch ? body : [body];
        if (!Array.isArray(entries) || entries.length !== requests.length) throw upstreamFailure();
        const replies = new Map<number, Reply>();
        for (const entry of entries) {
          if (!object(entry) || entry.jsonrpc !== '2.0' || !Number.isSafeInteger(entry.id)
            || Number(entry.id) < 1 || Number(entry.id) > requests.length || replies.has(Number(entry.id))) throw upstreamFailure();
          const index = Number(entry.id) - 1;
          if (Object.hasOwn(entry, 'error')) {
            if (!keys(entry, ['jsonrpc', 'id', 'error']) || !object(entry.error) || !Number.isSafeInteger(entry.error.code)
              || Number(entry.error.code) < -2_147_483_648 || Number(entry.error.code) > 2_147_483_647) throw upstreamFailure();
            // Preserve machine codes with their exact request IDs, never provider messages/data.
            replies.set(index + 1, { error: { code: entry.error.code as number, message: 'The public network rejected this read.' } });
          } else {
            if (!keys(entry, ['jsonrpc', 'id', 'result'])) throw upstreamFailure();
            checkResult(entry.result, requests[index]!, secret); replies.set(index + 1, { result: entry.result });
          }
        }
        return requests.map((_rpc, index) => replies.get(index + 1)!);
      });
    } catch (error) {
      if (signal.aborted) throw cancelled();
      const failure = error instanceof Failure ? error : upstreamFailure();
      if (failure.status >= 500 && cooldownUntil <= now()) { cooldownUntil = now() + 2_000; cooldownStatus = 503; }
      throw failure;
    }
  };
  const join = (flight: Flight, signal: AbortSignal): Promise<Reply[]> => new Promise((resolve, reject) => {
    flight.consumers++; let finished = false;
    const finish = (action: () => void) => {
      if (finished) return; finished = true; signal.removeEventListener('abort', abort);
      if (--flight.consumers === 0) flight.controller.abort(); action();
    };
    const abort = () => finish(() => reject(cancelled()));
    signal.addEventListener('abort', abort, { once: true });
    flight.promise.then(reply => finish(() => resolve(reply)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
  return async request => {
    let id: Id | Id[] = null, admitted = false;
    try {
      const ip = admit(request);
      if (request.method !== 'POST') throw new Failure(405, -32600, 'Use POST for this read endpoint.');
      const origin = request.headers.get('origin');
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new Failure(403, -32600, 'This read endpoint does not allow cross-origin browser requests.');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
        || (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')) throw new Failure(415, -32600, 'Use an uncompressed UTF-8 JSON request.');
      if (incoming >= limits.maxIncoming) throw busy(); incoming++; admitted = true;
      checkCooldown();
      const input = await deadline(limits.bodyTimeoutMs, request.signal, new Failure(408, -32600, 'The request body timed out.'),
        signal => boundedJson(request.body, request.headers, limits.requestBytes, new Failure(413, -32600, 'The request exceeds the read service limit.'), signal));
      if (object(input) && validId(input.id)) id = input.id;
      const batch = Array.isArray(input);
      let requests: Rpc[];
      try {
        if (batch) {
          requireValue(input.length > 0 && input.length <= MAX_HEADER_BATCH_SIZE);
          id = input.map(item => object(item) && validId(item.id) ? item.id : null);
          requests = input.map(validateRpc);
          // Batching is deliberately narrow: queries, simulations and all other methods
          // retain their existing one-request admission and byte/CPU bounds.
          requireValue(requests.every(rpc => rpc.method === 'eth_getBlockByNumber')
            && new Set(requests.map(rpc => rpc.id)).size === requests.length);
        } else requests = [validateRpc(input)];
      } catch (error) { throw error instanceof Failure ? error : invalid(); }
      let secret: string | undefined;
      try { secret = options.accessKey(); } catch { /* Credential-store failures are never client input errors. */ }
      if (!secret || !/^[\x21-\x7e]{1,1024}$/.test(secret)) throw new Failure(503, -32099, 'Public network access is temporarily unavailable.');
      // Every exact header costs one unit, including scalar requests and repeated heights.
      admitHeaders(ip, requests.filter(rpc => rpc.method === 'eth_getBlockByNumber').length);
      const rpc = requests[0]!;
      const key = JSON.stringify([rpc.method, rpc.params], (_name, item: unknown) => object(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
      // A finish/reorg check must contact the provider after that check begins, even when
      // another reader has an older header request in progress. Heads are never coalesced.
      const shareable = !batch && !['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber'].includes(rpc.method);
      let flight = shareable ? flights.get(key) : undefined;
      if (!flight || flight.controller.signal.aborted) {
        const controller = new AbortController();
        const created: Flight = { controller, consumers: 0, promise: Promise.resolve([]) };
        created.promise = schedule(() => callUpstream(requests, batch, secret, controller.signal), controller.signal)
          .finally(() => { if (flights.get(key) === created) flights.delete(key); });
        if (shareable) flights.set(key, created); flight = created;
      }
      return respond(id, await join(flight, request.signal));
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure(400, -32700, 'The request could not be read as valid JSON.');
      return respond(id, { error: { code: failure.code, message: failure.message } }, failure.status, failure.retryAfter);
    } finally {
      if (admitted) incoming--;
      // Also stop uploads rejected before the bounded reader was acquired.
      if (!request.body?.locked) void request.body?.cancel().catch(() => undefined);
    }
  };
}
