import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, stringToHex, toHex } from 'viem';
import type { Hex } from 'viem';
import { canonicalJson } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { BookState, DomainReason, PublicEntityKey } from '../../domain/types';
import { createOperationIntent } from '../operations';
import type { StoredOperationStep } from '../operations';
import { createWalletGateway, WalletOperationError } from '../wallet';
import type { NativeBatch } from '../wallet';
import { ARKIV_ADDRESS } from '../arkiv/client';
import type { RpcRequest } from '../arkiv/client';
import { ArkivReader } from '../arkiv/reader';
import { ArkivRepositoryError, repositoryError } from '../arkiv/errors';
import { nativeCreate, verifyOperationStep } from '../arkiv/verification';
import {
  BLOCK_HASH, KEYS, NOW, PUBLISHER, STRANGER, ReadRpcFixture, entityKey, rawEntity, readyFixture,
} from './arkiv-fixture';

const HASH = entityKey(7000);
const OLD = entityKey(7001);
const STEP = 'verify-book-step';
const LIFETIME = 3600;
const EXPIRY = 100 + LIFETIME / 2;

interface RawLog {
  address: string; blockHash: string; blockNumber: string;
  transactionHash: string; transactionIndex: string; logIndex: string;
  removed: boolean; topics: Hex[]; data: Hex;
}
function log(kind: 'EntityCreated' | 'EntityDeleted' | 'ExpiryExtended', key: PublicEntityKey, index = 0, overrides: Partial<RawLog> = {}): RawLog {
  const topics = encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName: kind, args: { entityKey: key, owner: PUBLISHER } }) as Hex[];
  const data = kind === 'EntityDeleted' ? '0x'
    : kind === 'ExpiryExtended' ? encodeAbiParameters(parseAbiParameters('uint64'), [BigInt(EXPIRY)])
      : encodeAbiParameters(parseAbiParameters('uint64,uint8'), [BigInt(EXPIRY), 1]);
  return { address: ARKIV_ADDRESS, blockHash: BLOCK_HASH, blockNumber: '0x64',
    transactionHash: HASH, transactionIndex: '0x0', logIndex: toHex(index), removed: false, topics, data, ...overrides };
}

async function fixture(kind: 'replacement' | 'extension' | 'double-create' = 'replacement') {
  const payload: BookState = { ...readyFixture().book, operationId: STEP, predecessorKeys: [OLD] };
  const native = nativeCreate(payload, LIFETIME);
  const batch: NativeBatch = kind === 'extension' ? { extensions: [{ entityKey: KEYS.book, expiresAtBlock: `${EXPIRY}` }] }
    : kind === 'double-create' ? { creates: [native, { ...structuredClone(native), salt: '1' }] }
      : { creates: [native], deletes: [OLD] };
  const secondKey = entityKey(7002);
  const rows = [rawEntity(KEYS.book, payload, PUBLISHER, { createdAt: toHex(kind === 'extension' ? 80 : 100), expiresAt: toHex(EXPIRY) })];
  if (kind === 'double-create') rows.push(rawEntity(secondKey, payload, PUBLISHER, { createdAt: toHex(100), expiresAt: toHex(EXPIRY) }));
  const rpc = new ReadRpcFixture(rows);
  const state = {
    rpc, payload, batch,
    logs: kind === 'extension' ? [log('ExpiryExtended', KEYS.book)]
      : kind === 'double-create' ? [log('EntityCreated', KEYS.book), log('EntityCreated', secondKey, 1)]
        : [log('EntityCreated', KEYS.book), log('EntityDeleted', OLD, 1)],
    receipt: {} as Record<string, unknown>, transaction: {} as Record<string, unknown>,
    getLogs: undefined as RawLog[] | undefined,
    receiptAbsent: false,
    calls: [] as { method: string; params?: readonly unknown[] | object }[],
  };
  const request: RpcRequest = async args => {
    state.calls.push(structuredClone(args));
    if (args.method === 'eth_estimateGas') return toHex(100000);
    if (args.method === 'eth_gasPrice') return '0x2';
    if (args.method === 'eth_getTransactionReceipt') return state.receiptAbsent ? null : structuredClone({ ...state.receipt, logs: state.logs });
    if (args.method === 'eth_getTransactionByHash') return structuredClone(state.transaction);
    if (args.method === 'eth_getLogs') return structuredClone(state.getLogs ?? state.logs.filter(item => item.topics[0] === log('EntityCreated', KEYS.book).topics[0]));
    return rpc.request(args);
  };
  const gateway = createWalletGateway({
    provider: { request: async () => { throw new Error('Verification fixtures cannot access a signing wallet.'); } },
    publicRpc: { request },
  });
  const prepared = await gateway.prepare(batch, PUBLISHER);
  gateway.dispose();
  const operation = createOperationIntent(kind === 'extension' ? 'renew_entity' : 'replace_book', {
    mode: 'public', chainId: TIRAMISU_CHAIN_ID, actor: { kind: 'wallet', address: PUBLISHER },
  }, { expectedHeads: kind === 'replacement' ? [OLD] : [], lifetimeSeconds: LIFETIME, book: payload }, { id: 'verify-operation', now: NOW });
  const step = { id: STEP, phase: 'book_pending' as const, status: 'submitted' as const,
    transactionHash: HASH, confirmedKeys: [], expectedHeads: operation.expectedHeads, inputHash: operation.inputHash };
  operation.steps = [step];
  const record: StoredOperationStep = {
    version: 1, revision: 1, operation, step, batch, prepared,
    admission: { request: structuredClone(prepared.request), at: NOW }, submissionHash: HASH, receipt: null, error: null,
  };
  state.receipt = {
    transactionHash: HASH, transactionIndex: '0x0', blockHash: BLOCK_HASH, blockNumber: '0x64',
    from: PUBLISHER, to: ARKIV_ADDRESS, cumulativeGasUsed: toHex(100000), gasUsed: toHex(100000),
    effectiveGasPrice: '0x2', contractAddress: null, status: '0x1', type: '0x0', logsBloom: '0x',
  };
  state.transaction = {
    hash: HASH, blockHash: BLOCK_HASH, blockNumber: '0x64', transactionIndex: '0x0',
    from: PUBLISHER, to: ARKIV_ADDRESS, chainId: toHex(TIRAMISU_CHAIN_ID), value: '0x0',
    input: prepared.request.data, gas: toHex(120000), gasPrice: '0x2', nonce: '0x1', type: '0x0',
    r: entityKey(1), s: entityKey(2), v: '0x1b',
  };
  state.calls.length = 0; rpc.calls.length = 0;
  return { ...state, state, record, reader: new ArkivReader({ request, now: () => NOW }) };
}

async function rejects(task: Promise<unknown>, reason?: DomainReason['code']): Promise<void> {
  let caught: unknown;
  try { await task; } catch (error) { caught = error; }
  expect(caught, 'Untrusted or incomplete evidence must never produce a verified result.').toBeDefined();
  if (reason) {
    expect(caught).toBeInstanceOf(ArkivRepositoryError);
    expect(repositoryError(caught).reasons.map(item => item.code)).toContain(reason);
  }
}
type VerificationFixture = Awaited<ReturnType<typeof fixture>>;

describe('independent native transaction verification with the installed SDK reader', () => {
  it('verifies the exact create/delete transition and pins entity readback to its canonical receipt block', async () => {
    const f = await fixture();
    const result = await verifyOperationStep(f.reader, f.record);
    expect(result).toMatchObject({ reverted: false, receipt: { operationId: 'verify-operation', transactionHash: HASH,
      entityKeys: [KEYS.book], consumedKeys: [OLD], blockNumber: '100', confirmedAt: NOW } });
    expect(result!.records[0]!.payload).toEqual(f.payload);
    expect(result!.records[0]!.provenance.transactionHash).toBe(HASH);
    expect(f.rpc.queries.every(call => call.options.atBlock === '0x64')).toBe(true);
    expect(f.rpc.queries.some(call => call.query.includes(OLD))).toBe(true);
    expect(f.state.calls.some(call => /send|sign/i.test(call.method))).toBe(false);
  });

  it.each<[string, (fixture: VerificationFixture) => void]>([
    ['transaction sender', f => { f.state.transaction.from = STRANGER; }],
    ['receipt sender', f => { f.state.receipt.from = STRANGER; }],
    ['native destination', f => { f.state.transaction.to = STRANGER; }],
    ['receipt destination', f => { f.state.receipt.to = STRANGER; }],
    ['chain ID', f => { f.state.transaction.chainId = '0x1'; }],
    ['nonzero value', f => { f.state.transaction.value = '0x1'; }],
    ['calldata', f => { f.state.transaction.input = '0x12345678'; }],
    ['transaction hash', f => { f.state.transaction.hash = entityKey(8000); }],
    ['receipt hash', f => { f.state.receipt.transactionHash = entityKey(8000); }],
  ])('rejects a mismatched %s', async (_name, mutate) => {
    const f = await fixture(); mutate(f);
    await rejects(verifyOperationStep(f.reader, f.record), 'foreign_author');
  });

  it.each<[string, (fixture: VerificationFixture) => void]>([
    ['receipt/transaction block hash', f => { f.state.transaction.blockHash = entityKey(8000); }],
    ['receipt/transaction block number', f => { f.state.transaction.blockNumber = '0x63'; }],
    ['canonical block hash', f => { f.rpc.blockHash = entityKey(8000); }],
    ['reorg during readback', f => { f.rpc.blockOverride = call => call >= 3 ? { hash: entityKey(8000) } : {}; }],
  ])('rejects a mismatched %s', async (_name, mutate) => {
    const f = await fixture(); mutate(f);
    await rejects(verifyOperationStep(f.reader, f.record), 'incomplete_snapshot');
  });

  it.each<[string, (fixture: VerificationFixture) => void]>([
    ['missing creation', f => { f.state.logs.shift(); }],
    ['extra native event', f => { f.state.logs.push(log('EntityDeleted', entityKey(8001), 2)); }],
    ['events in the wrong order', f => { f.state.logs.reverse(); f.state.logs.forEach((entry, index) => { entry.logIndex = toHex(index); }); }],
    ['wrong creation owner', f => { f.state.logs[0]!.topics = encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName: 'EntityCreated', args: { entityKey: KEYS.book, owner: STRANGER } }) as Hex[]; }],
    ['wrong creation flags', f => { f.state.logs[0]!.data = encodeAbiParameters(parseAbiParameters('uint64,uint8'), [BigInt(EXPIRY), 3]); }],
    ['wrong expiry', f => { f.state.logs[0]!.data = encodeAbiParameters(parseAbiParameters('uint64,uint8'), [BigInt(EXPIRY + 1), 1]); }],
    ['wrong consumed key', f => { f.state.logs[1] = log('EntityDeleted', entityKey(8001), 1); }],
    ['wrong event contract', f => { f.state.logs[0]!.address = STRANGER; }],
  ])('rejects %s', async (_name, mutate) => {
    const f = await fixture(); mutate(f);
    await rejects(verifyOperationStep(f.reader, f.record), 'projection_mismatch');
  });

  it.each<[string, (fixture: VerificationFixture) => void, DomainReason['code']]>([
    ['foreign entity creator', f => { f.rpc.row(KEYS.book).creator = STRANGER; }, 'foreign_author'],
    ['changed created payload', f => { f.rpc.row(KEYS.book).payload = stringToHex(canonicalJson({ ...f.payload, name: 'Different content' })); }, 'projection_mismatch'],
    ['different mint block', f => { f.rpc.row(KEYS.book).createdAt = '0x63'; }, 'projection_mismatch'],
    ['different readback expiry', f => { f.rpc.row(KEYS.book).expiresAt = toHex(EXPIRY + 1); }, 'projection_mismatch'],
    ['still-live consumed predecessor', f => { f.rpc.put(rawEntity(OLD, f.payload, PUBLISHER)); }, 'projection_mismatch'],
  ])('rejects %s', async (_name, mutate, reason) => {
    const f = await fixture(); mutate(f);
    await rejects(verifyOperationStep(f.reader, f.record), reason);
  });

  it('returns a separately typed reverted result with no fabricated entity changes', async () => {
    const f = await fixture(); f.state.receipt.status = '0x0'; f.state.logs = [];
    const result = await verifyOperationStep(f.reader, f.record);
    expect(result).toMatchObject({ reverted: true, records: [], receipt: { transactionHash: HASH, entityKeys: [], consumedKeys: [] } });
    expect(f.rpc.queries).toHaveLength(0);
  });
  it('authenticates a reverted transaction before reporting its failure', async () => {
    const f = await fixture(); f.state.receipt.status = '0x0'; f.state.logs = []; f.state.transaction.input = '0x1234';
    await rejects(verifyOperationStep(f.reader, f.record), 'foreign_author');
  });
  it('never treats an unknown send hash and empty operation query as not_sent', async () => {
    const f = await fixture(); f.record.submissionHash = null; f.record.step.transactionHash = null; f.record.step.status = 'unverified';
    f.rpc.rows = [];
    await expect(verifyOperationStep(f.reader, f.record)).resolves.toBeNull();
    expect(f.record.step.status).toBe('unverified'); expect(f.record.admission).not.toBeNull();
    expect(f.state.calls.some(call => call.method === 'eth_getTransactionReceipt')).toBe(false);
  });
  it('recovers a lost response by exact operation payload and canonical creation logs, then verifies the transaction', async () => {
    const f = await fixture(); f.record.submissionHash = null; f.record.step.transactionHash = null; f.record.step.status = 'unverified';
    const result = await verifyOperationStep(f.reader, f.record);
    expect(result?.receipt.transactionHash).toBe(HASH);
    expect(result?.receipt.entityKeys).toEqual([KEYS.book]);
    expect(f.rpc.queries.some(call => call.query.includes(`operation_id = str('${STEP}')`) && call.query.includes(PUBLISHER))).toBe(true);
    expect(f.state.calls.some(call => call.method === 'eth_getLogs')).toBe(true);
  });
  it('rejects an operation-ID collision containing a different payload', async () => {
    const f = await fixture(); f.record.submissionHash = null; f.record.step.transactionHash = null;
    f.rpc.update(KEYS.book, { ...f.payload, name: 'An unrelated write using the same ID' });
    await rejects(verifyOperationStep(f.reader, f.record), 'projection_mismatch');
    expect(f.state.calls.some(call => call.method === 'eth_getTransactionReceipt')).toBe(false);
  });
  it('rejects ambiguous multiple rows for a single expected creation', async () => {
    const f = await fixture(); f.record.submissionHash = null; f.record.step.transactionHash = null;
    f.rpc.put(rawEntity(entityKey(8002), f.payload, PUBLISHER, { createdAt: toHex(100), expiresAt: toHex(EXPIRY) }));
    await rejects(verifyOperationStep(f.reader, f.record), 'conflicting_heads');
  });
  it('keeps a known hash unresolved when its receipt is unavailable', async () => {
    const f = await fixture(); f.state.receiptAbsent = true;
    await rejects(verifyOperationStep(f.reader, f.record));
    expect(f.record.submissionHash).toBe(HASH); expect(f.record.step.status).toBe('submitted');
  });
  it('verifies a renewal and rejects an expiry that differs from the frozen extension', async () => {
    const f = await fixture('extension');
    const result = await verifyOperationStep(f.reader, f.record);
    expect(result?.records[0]!.provenance.expiresAtBlock).toBe(`${EXPIRY}`);
    expect(result?.receipt.entityKeys).toEqual([KEYS.book]);
    f.rpc.row(KEYS.book).expiresAt = toHex(EXPIRY + 1);
    await rejects(verifyOperationStep(f.reader, f.record), 'projection_mismatch');
  });

  // These boundary checks deliberately cover malformed RPC envelopes in addition to decoded args.
  it.each(['transactionHash', 'blockHash', 'blockNumber', 'transactionIndex', 'logIndex', 'removed'] as const)('rejects native log %s provenance that contradicts its receipt', async field => {
    const f = await fixture();
    if (field === 'transactionHash') f.state.logs[0]!.transactionHash = entityKey(8003);
    else if (field === 'blockHash') f.state.logs[0]!.blockHash = entityKey(8003);
    else if (field === 'blockNumber') f.state.logs[0]!.blockNumber = '0x63';
    else if (field === 'transactionIndex') f.state.logs[0]!.transactionIndex = '0x1';
    else if (field === 'logIndex') f.state.logs[0]!.logIndex = '0x1';
    else f.state.logs[0]!.removed = true;
    await rejects(verifyOperationStep(f.reader, f.record));
  });
  it('rejects duplicate minted keys even when the two frozen create payloads are identical', async () => {
    const f = await fixture('double-create');
    f.state.logs[1] = log('EntityCreated', KEYS.book, 1);
    await rejects(verifyOperationStep(f.reader, f.record));
  });
  it('rejects a block header whose number contradicts the requested receipt block', async () => {
    const f = await fixture(); f.rpc.blockOverride = () => ({ number: '0x63' });
    await rejects(verifyOperationStep(f.reader, f.record));
  });
  it.each(['gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const)('checks the frozen %s instead of trusting wallet estimates', async field => {
    const f = await fixture();
    f.record.admission!.request[field] = '0x1'; f.record.prepared!.request[field] = '0x1';
    f.state.transaction[field] = '0x2';
    await rejects(verifyOperationStep(f.reader, f.record), 'invalid_input');
  });
});

describe('public wallet error translation', () => {
  it.each([
    ['rejected', 'rejected'], ['not_connected', 'not_sent'], ['wrong_chain', 'not_sent'],
    ['reverted', 'reverted'], ['storage', 'unverified'], ['insufficient_funds', 'not_sent'],
  ] as const)('preserves %s without exposing provider payloads', (code, kind) => {
    const failure = new WalletOperationError('UNSAFE PROVIDER PAYLOAD', { code, kind });
    const translated = repositoryError(new Error('Wrapper', { cause: failure }));
    expect(translated.code).toBe(code); expect(translated.retryable).toBe(false);
    expect(translated.diagnostic).not.toContain('UNSAFE');
  });
});
