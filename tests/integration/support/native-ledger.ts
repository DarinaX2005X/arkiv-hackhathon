import assert from 'node:assert/strict';
import { ENTITY_EVENTS_ABI, ExpirationTime } from '@arkiv-network/sdk';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, stringToHex, toHex } from 'viem';
import type { Hex } from 'viem';
import { ARKIV_ADDRESS } from '../../../src/data/arkiv/client';
import type { RpcRequest } from '../../../src/data/arkiv/client';
import type { StoredOperationStep } from '../../../src/data/operations';
import type { NativeTransactionRequest } from '../../../src/data/wallet';
import { entityKey, NOW } from '../../../src/data/__tests__/arkiv-fixture';
import type { QueryCall, RawAttribute, RawEntity, RawPage } from '../../../src/data/__tests__/arkiv-fixture';
import type { AccountAddress, PublicEntityKey } from '../../../src/domain/types';
import { TIRAMISU_CHAIN_ID } from '../../../src/domain/types';

type RpcArgs = Parameters<RpcRequest>[0];
type Block = { number: Hex; hash: Hex; timestamp: Hex; transactions: Hex[] };
type Log = { address: string; topics: Hex[]; data: Hex; blockHash: Hex; blockNumber: Hex;
  transactionHash: Hex; transactionIndex: Hex; logIndex: Hex; removed: false };
export interface NativeLedgerSend {
  request: NativeTransactionRequest; record: StoredOperationStep; hash: Hex;
  blockNumber: number; createdKeys: PublicEntityKey[]; deletedKeys: PublicEntityKey[];
}

/** Strict SDK query subset used by the two production repositories; unsupported syntax always fails. */
function queryPredicate(query: string): (row: RawEntity) => boolean {
  const expression = /(\$?[A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|=)\s*(str|i32|u64|key|addr|bytes32)\((?:'((?:[^']|'')*)'|(0x[0-9a-fA-F]+|-?\d+))\)/g;
  const predicates = [...query.matchAll(expression)];
  const remainder = query.replace(expression, '').replace(/\bAND\b|[()\s]/g, '');
  assert.ok(predicates.length && !remainder, `Unsupported ledger query: ${query}`);
  for (const [, name, operator, type] of predicates) {
    assert.ok(operator === '=' || (type === 'u64' && (name === 'starts_at' || name === 'ends_at')),
      `Unsupported ledger range: ${query}`);
  }
  return row => predicates.every(([, name, operator, type, quoted, scalar]) => {
    const actual = name === '$key' ? { type: 'key', value: row.key }
      : name === '$creator' ? { type: 'addr', value: row.creator }
        : row.attributes.find(attribute => attribute.name === name);
    if (!actual || actual.type !== type) return false;
    if (type === 'i32' || type === 'u64') {
      const expected = BigInt(scalar!), value = BigInt(actual.value as string | number);
      return operator === '>=' ? value >= expected : operator === '<=' ? value <= expected : value === expected;
    }
    return type === 'str' ? actual.value === quoted!.replace(/''/g, "'")
      : String(actual.value).toLowerCase() === scalar!.toLowerCase();
  });
}

/** Empty deterministic native ledger. All entities and decisions must arrive through admitted batches. */
export function createNativeLedger(options: { now?: number; pageSize?: number } = {}) {
  let time = options.now ?? NOW, blockNumber = 100, nextKey = 10_000, loseResponse = false;
  const pageSize = options.pageSize ?? 200;
  assert.ok(Number.isSafeInteger(time) && time >= 0 && time % 1_000 === 0, 'Use a whole-second ledger time.');
  assert.ok(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 200, 'Invalid ledger page size.');
  let rows: RawEntity[] = [];
  const snapshots = new Map<number, RawEntity[]>(), blocks = new Map<number, Block>();
  const receipts = new Map<string, Record<string, unknown>>(), transactions = new Map<string, Record<string, unknown>>();
  const logs: Log[] = [], sends: NativeLedgerSend[] = [], calls: RpcArgs[] = [];
  const cursors = new Map<string, { binding: string; offset: number }>();
  const blockHash = () => entityKey(1_000_000 + blockNumber);
  function archive(transactionHashes: Hex[] = []) {
    blocks.set(blockNumber, { number: toHex(blockNumber), hash: blockHash(), timestamp: toHex(time / 1_000), transactions: transactionHashes });
    snapshots.set(blockNumber, structuredClone(rows));
  }
  archive();
  function snapshot(at: number): RawEntity[] {
    const found = snapshots.get(at);
    if (!found) throw Object.assign(new Error('The requested ledger block is unavailable.'), { code: -32006 });
    return found;
  }
  function setTime(next: number) {
    assert.ok(Number.isSafeInteger(next) && next >= time && next % 1_000 === 0, 'Ledger time must move forward in whole seconds.');
    if (next === time) return;
    blockNumber += Math.max(1, Math.ceil((next - time) / 2_000));
    time = next; archive();
  }
  const request: RpcRequest = async args => {
    calls.push(structuredClone(args));
    const params = Array.isArray(args.params) ? args.params : [];
    switch (args.method) {
      case 'eth_chainId': return toHex(TIRAMISU_CHAIN_ID);
      case 'eth_blockNumber': return toHex(blockNumber);
      case 'eth_estimateGas': return toHex(100_000);
      case 'eth_gasPrice': return '0x2';
      case 'eth_getTransactionReceipt': return structuredClone(receipts.get(String(params[0])) ?? null);
      case 'eth_getTransactionByHash': return structuredClone(transactions.get(String(params[0])) ?? null);
      case 'eth_getBlockByNumber': {
        const at = params[0] === 'latest' ? blockNumber : Number(BigInt(String(params[0])));
        snapshot(at); return structuredClone(blocks.get(at)!);
      }
      case 'eth_getLogs': {
        const filter = params[0] as { address?: string | string[]; fromBlock?: string; toBlock?: string; topics?: (string | string[] | null)[] };
        const at = (value: string | undefined, fallback: number) => value === undefined ? fallback : value === 'latest' ? blockNumber : Number(BigInt(value));
        const addresses = filter.address === undefined ? [] : Array.isArray(filter.address) ? filter.address : [filter.address];
        return structuredClone(logs.filter(log => Number(BigInt(log.blockNumber)) >= at(filter.fromBlock, 0)
          && Number(BigInt(log.blockNumber)) <= at(filter.toBlock, blockNumber)
          && (!addresses.length || addresses.some(address => address.toLowerCase() === log.address.toLowerCase()))
          && (!filter.topics || filter.topics.every((topic, index) => topic === null || (Array.isArray(topic) ? topic : [topic])
            .some(value => value.toLowerCase() === log.topics[index]?.toLowerCase())))));
      }
      case 'arkiv_query': {
        assert.equal(typeof params[0], 'string', 'A query expression is required.');
        const query = params[0] as string, settings = params[1] as QueryCall['options'];
        assert.ok(settings?.atBlock && settings.select && settings.limit, 'Queries must pin a block and select the envelope.');
        const at = Number(BigInt(settings.atBlock)), stored = snapshot(at), match = queryPredicate(query);
        const binding = JSON.stringify([query, settings.atBlock, settings.select, settings.limit]);
        const cursor = settings.cursor ? cursors.get(settings.cursor) : undefined;
        if (settings.cursor && (!cursor || cursor.binding !== binding)) throw Object.assign(new Error('Invalid ledger cursor.'), { code: -32005 });
        const offset = cursor?.offset ?? 0, size = Math.min(pageSize, Number(BigInt(settings.limit)));
        assert.ok(Number.isSafeInteger(size) && size > 0, 'A positive page size is required.');
        const found = stored.filter(row => BigInt(row.createdAt) <= BigInt(at) && BigInt(row.expiresAt) > BigInt(at) && match(row));
        const page: RawPage = { data: structuredClone(found.slice(offset, offset + size)), blockNumber: toHex(at) };
        if (offset + size < found.length) {
          page.cursor = `ledger-cursor-${cursors.size + 1}`;
          cursors.set(page.cursor, { binding, offset: offset + size });
        }
        return page;
      }
      default: throw new Error(`Native ledger does not implement RPC method ${args.method}.`);
    }
  };

  function submit(sent: NativeTransactionRequest, record: StoredOperationStep): Hex {
    assert.deepEqual(record.admission?.request, sent, 'The exact send must have durable admission.');
    assert.ok(record.prepared, 'The native batch must have been prepared.');
    assert.deepEqual(record.prepared.batch, record.batch, 'The admitted batch must match preparation.');
    assert.equal(record.operation.authority.mode, 'public');
    assert.equal(record.operation.authority.actor.kind, 'wallet');
    const author = (record.operation.authority.actor as { kind: 'wallet'; address: AccountAddress }).address;
    assert.equal(sent.from, author);
    assert.equal(record.operation.authority.chainId, TIRAMISU_CHAIN_ID);
    assert.equal(sent.chainId, toHex(TIRAMISU_CHAIN_ID));
    assert.equal(sent.to.toLowerCase(), ARKIV_ADDRESS);
    assert.equal(sent.value, '0x0');
    const creates = record.batch.creates ?? [], deletes = record.batch.deletes ?? [], extensions = record.batch.extensions ?? [];
    assert.ok(creates.length + deletes.length + extensions.length > 0, 'A native batch cannot be empty.');
    const touched = [...deletes, ...extensions.map(extension => extension.entityKey)];
    assert.equal(new Set(touched).size, touched.length, 'A native batch may touch each existing entity only once.');
    // Validate the full batch before changing any entity, including all consumed ownership.
    const nextBlock = blockNumber + 1;
    for (const key of touched) {
      const row = rows.find(item => item.key === key);
      assert.ok(row && BigInt(row.expiresAt) > BigInt(nextBlock), `Native entity ${key} is no longer live.`);
      assert.equal(row.owner, author, 'A native batch cannot consume another wallet’s entity.');
    }
    const newRows = creates.map((create, index): RawEntity => {
      assert.ok(Number.isSafeInteger(create.lifetimeSeconds) && create.lifetimeSeconds > 0);
      const payload = JSON.parse(create.payloadJson) as { entityType?: string };
      assert.equal(typeof payload.entityType, 'string', 'A creation must contain an entity payload.');
      const attributes: RawAttribute[] = Object.entries(create.attributes).map(([name, attribute]) => ({ name,
        type: attribute.type, value: attribute.type === 'u64' ? toHex(BigInt(attribute.value)) : attribute.value }));
      return { key: entityKey(nextKey + index), creator: author, owner: author,
        createdAt: toHex(nextBlock), expiresAt: toHex(BigInt(nextBlock) + ExpirationTime.fromSeconds(create.lifetimeSeconds).minLifetime),
        creationFlags: 1, contentType: 'application/json', payload: stringToHex(create.payloadJson), attributes };
    });
    for (const extension of extensions) {
      const current = rows.find(row => row.key === extension.entityKey)!;
      assert.ok(BigInt(extension.expiresAtBlock) > BigInt(current.expiresAt), 'An extension must increase the current deadline.');
    }
    blockNumber = nextBlock; time += 2_000; nextKey += newRows.length;
    const hash = entityKey(6_000 + sends.length), minedLogs: Log[] = [];
    const addLog = (eventName: 'EntityCreated' | 'EntityDeleted' | 'ExpiryExtended', key: PublicEntityKey, expiry?: bigint) => {
      minedLogs.push({ address: ARKIV_ADDRESS,
        topics: encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName, args: { entityKey: key, owner: author } }) as Hex[],
        data: eventName === 'EntityDeleted' ? '0x' : eventName === 'EntityCreated'
          ? encodeAbiParameters(parseAbiParameters('uint64,uint8'), [expiry!, 1]) : encodeAbiParameters(parseAbiParameters('uint64'), [expiry!]),
        blockHash: blockHash(), blockNumber: toHex(blockNumber), transactionHash: hash,
        transactionIndex: '0x0', logIndex: toHex(minedLogs.length), removed: false });
    };
    for (const row of newRows) addLog('EntityCreated', row.key, BigInt(row.expiresAt));
    for (const key of deletes) addLog('EntityDeleted', key);
    rows = [...rows.filter(row => !deletes.includes(row.key)), ...newRows];
    for (const extension of extensions) {
      rows.find(row => row.key === extension.entityKey)!.expiresAt = toHex(BigInt(extension.expiresAtBlock));
      addLog('ExpiryExtended', extension.entityKey, BigInt(extension.expiresAtBlock));
    }
    logs.push(...minedLogs); archive([hash]);
    const typedFees = sent.maxFeePerGas !== undefined || sent.maxPriorityFeePerGas !== undefined;
    receipts.set(hash, { transactionHash: hash, transactionIndex: '0x0', blockHash: blockHash(), blockNumber: toHex(blockNumber),
      from: author, to: ARKIV_ADDRESS, cumulativeGasUsed: toHex(100_000), gasUsed: toHex(100_000), effectiveGasPrice: '0x2',
      contractAddress: null, status: '0x1', type: typedFees ? '0x2' : '0x0', logsBloom: '0x', logs: minedLogs });
    transactions.set(hash, { hash, blockHash: blockHash(), blockNumber: toHex(blockNumber), transactionIndex: '0x0', from: author,
      to: ARKIV_ADDRESS, chainId: toHex(TIRAMISU_CHAIN_ID), value: '0x0', input: sent.data,
      gas: sent.gas ?? toHex(120_000), gasPrice: sent.gasPrice ?? '0x2', nonce: toHex(sends.filter(item => item.request.from === author).length),
      ...(sent.maxFeePerGas ? { maxFeePerGas: sent.maxFeePerGas } : {}),
      ...(sent.maxPriorityFeePerGas ? { maxPriorityFeePerGas: sent.maxPriorityFeePerGas } : {}),
      type: typedFees ? '0x2' : '0x0', r: entityKey(1), s: entityKey(2), v: '0x1b' });
    sends.push({ request: structuredClone(sent), record: structuredClone(record), hash, blockNumber,
      createdKeys: newRows.map(row => row.key), deletedKeys: [...deletes] });
    if (loseResponse) { loseResponse = false; throw new Error('The synthetic provider lost the response after inclusion.'); }
    return hash;
  }

  return { request, now: () => time, setTime, blockNumber: () => blockNumber, submit, sends, calls,
    readRows: (at = blockNumber) => structuredClone(snapshot(at)),
    loseNextResponse: () => { loseResponse = true; } };
}
