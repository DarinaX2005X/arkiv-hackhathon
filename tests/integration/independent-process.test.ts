import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex } from 'viem';
import type { Hex } from 'viem';
import { ARKIV_ADDRESS } from '../../src/data/arkiv/client';
import type { RpcRequest } from '../../src/data/arkiv/client';
import type { StoredOperationStep } from '../../src/data/operations';
import type { NativeTransactionRequest } from '../../src/data/wallet';
import { BLOCK_HASH, KEYS, NOW, PUBLISHER, entityKey, rawEntity, readyFixture } from '../../src/data/__tests__/arkiv-fixture';
import type { RawEntity } from '../../src/data/__tests__/arkiv-fixture';
import { canonicalJson } from '../../src/domain/canonical';
import { activeSource } from '../../src/domain/readiness';
import type { BookState, PublicEntityKey } from '../../src/domain/types';
import { TIRAMISU_CHAIN_ID } from '../../src/domain/types';
import type { ChildMessage, ParentMessage, ProcessResult, ProcessRole } from './support/process-messages';

/** A narrow deterministic ledger for one owner-authored book replacement. No real RPC or signer. */
function ledger() {
  const { rpc } = readyFixture();
  const snapshots = new Map<number, RawEntity[]>([[100, structuredClone(rpc.rows)]]);
  const blocks = new Map<number, { number: Hex; hash: Hex; timestamp: Hex; transactions: never[] }>([
    [100, { number: '0x64', hash: BLOCK_HASH, timestamp: toHex(NOW / 1000), transactions: [] }],
  ]);
  const receipts = new Map<string, unknown>(), transactions = new Map<string, unknown>();
  const calls: { role: ProcessRole; method: string }[] = [];
  const sent: NativeTransactionRequest[] = [];
  const currentTime = () => rpc.timestamp;
  const read: RpcRequest = async args => {
    if (args.method === 'eth_estimateGas') return toHex(100_000);
    if (args.method === 'eth_gasPrice') return '0x2';
    if (args.method === 'eth_getTransactionReceipt') return receipts.get(String((args.params as unknown[])[0])) ?? null;
    if (args.method === 'eth_getTransactionByHash') return transactions.get(String((args.params as unknown[])[0])) ?? null;
    if (args.method === 'eth_getBlockByNumber') {
      const target = (args.params as unknown[])[0];
      return blocks.get(target === 'latest' ? rpc.block : Number(BigInt(String(target)))) ?? null;
    }
    if (args.method === 'arkiv_query') {
      const block = Number(BigInt((args.params as [string, { atBlock: string }])[1].atBlock));
      const rows = snapshots.get(block);
      if (!rows) throw new Error('The requested fixture block is unavailable.');
      const current = rpc.rows; rpc.rows = structuredClone(rows);
      try { return await rpc.request(args); } finally { rpc.rows = current; }
    }
    return rpc.request(args);
  };
  function withdraw(request: NativeTransactionRequest, record: StoredOperationStep): Hex {
    expect(record.admission?.request).toEqual(request);
    expect(record.operation.authority).toEqual({ mode: 'public', actor: { kind: 'wallet', address: PUBLISHER }, chainId: TIRAMISU_CHAIN_ID });
    expect(record.batch.deletes).toEqual([KEYS.book]);
    expect(record.batch.creates).toHaveLength(1);
    expect(record.batch.extensions ?? []).toEqual([]);
    expect(request.from).toBe(PUBLISHER);
    expect(request.to.toLowerCase()).toBe(ARKIV_ADDRESS);
    expect(request.value).toBe('0x0');
    expect(request.chainId).toBe(toHex(TIRAMISU_CHAIN_ID));
    expect(sent).toEqual([]);
    const create = record.batch.creates![0]!;
    const book = JSON.parse(create.payloadJson) as BookState;
    expect(book).toMatchObject({ entityType: 'book_state', publisherRoot: KEYS.publisher, predecessorKeys: [KEYS.book], grants: [],
      decisions: [expect.objectContaining({ status: 'withdrawn', activationKey: KEYS.activation, proposalKey: KEYS.proposal })] });
    sent.push(structuredClone(request));
    const priorBlock = rpc.block;
    rpc.block++; rpc.timestamp += 2_000; rpc.blockHash = entityKey(5000 + rpc.block);
    blocks.set(rpc.block, { number: toHex(rpc.block), hash: rpc.blockHash, timestamp: toHex(rpc.timestamp / 1000), transactions: [] });
    const key = entityKey(10000), hash = entityKey(6000), expiry = BigInt(rpc.block + create.lifetimeSeconds / 2);
    rpc.remove(KEYS.book);
    rpc.put(rawEntity(key, book, PUBLISHER, { createdAt: toHex(rpc.block), expiresAt: toHex(expiry) }));
    snapshots.set(rpc.block, structuredClone(rpc.rows));
    expect(snapshots.get(priorBlock)?.some(row => row.key === KEYS.book)).toBe(true);
    const log = (eventName: 'EntityCreated' | 'EntityDeleted', entity: PublicEntityKey, index: number) => ({
      address: ARKIV_ADDRESS,
      topics: encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName, args: { entityKey: entity, owner: PUBLISHER } }),
      data: eventName === 'EntityCreated' ? encodeAbiParameters(parseAbiParameters('uint64,uint8'), [expiry, 1]) : '0x',
      blockHash: rpc.blockHash, blockNumber: toHex(rpc.block), transactionHash: hash, transactionIndex: '0x0', logIndex: toHex(index), removed: false,
    });
    receipts.set(hash, { transactionHash: hash, transactionIndex: '0x0', blockHash: rpc.blockHash, blockNumber: toHex(rpc.block),
      from: PUBLISHER, to: ARKIV_ADDRESS, cumulativeGasUsed: toHex(100000), gasUsed: toHex(100000), effectiveGasPrice: '0x2',
      contractAddress: null, status: '0x1', type: '0x0', logsBloom: '0x', logs: [log('EntityCreated', key, 0), log('EntityDeleted', KEYS.book, 1)] });
    transactions.set(hash, { hash, blockHash: rpc.blockHash, blockNumber: toHex(rpc.block), transactionIndex: '0x0', from: PUBLISHER,
      to: ARKIV_ADDRESS, chainId: toHex(TIRAMISU_CHAIN_ID), value: '0x0', input: request.data,
      gas: request.gas ?? toHex(120000), gasPrice: request.gasPrice ?? '0x2', nonce: '0x1', type: '0x0', r: entityKey(1), s: entityKey(2), v: '0x1b' });
    return hash;
  }
  return { rpc, sent, calls, currentTime, async handle(role: ProcessRole, message: Extract<ChildMessage, { kind: 'rpc' | 'wallet' }>) {
    calls.push({ role, method: message.kind === 'wallet' ? 'eth_sendTransaction' : message.request.method });
    if (message.kind === 'wallet') {
      if (role !== 'desk-withdraw') throw new Error('Only the explicitly connected synthetic Desk owner may submit to this fixture.');
      return withdraw(message.request, message.record);
    }
    return read(message.request);
  } };
}

/** Resolves only after the process has exited; the next client cannot depend on its runtime. */
function runClient(role: ProcessRole, fixture: ReturnType<typeof ledger>): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = fork(resolve(import.meta.dirname, 'support/public-client-process.ts'), [], {
      execArgv: ['--import', 'tsx'], env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let result: ProcessResult | undefined, failure = '', output = '';
    const timeout = setTimeout(() => { failure = 'Independent fixture process exceeded 20 seconds.'; child.kill(); }, 20_000);
    child.stdout?.on('data', data => { output += String(data); });
    child.stderr?.on('data', data => { output += String(data); });
    child.on('error', error => { failure = error.message; });
    child.on('message', (message: ChildMessage) => {
      if (message.kind === 'result') { result = message.result; return; }
      if (message.kind === 'failure') { failure = message.message; return; }
      void fixture.handle(role, message).then(value => {
        child.send({ kind: 'rpc-result', id: message.id, now: fixture.currentTime(), value } satisfies ParentMessage);
      }, error => {
        child.send({ kind: 'rpc-result', id: message.id, now: fixture.currentTime(), error: String(error) } satisfies ParentMessage);
      });
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || !result || failure || output) reject(new Error(failure || output || `Child exited with ${code}, without a result.`));
      else resolveResult(result);
    });
    child.send({ kind: 'start', role, now: fixture.currentTime(), projectRoot: KEYS.project,
      publisherRoot: KEYS.publisher, account: PUBLISHER } satisfies ParentMessage);
  });
}

describe('independent public client processes with a deterministic RPC ledger', () => {
  it('lets Desk withdraw after Studio exits, then reconstructs the same authored change in fresh Studio and CLI processes', async () => {
    const fixture = ledger();
    const initialStudio = await runClient('studio-read', fixture);
    expect(initialStudio.packet.readiness).toMatchObject({ status: 'ready', acceptedApprovers: [KEYS.publisher], reasons: [] });
    expect(initialStudio.walletMethods).toEqual([]);
    // runClient has awaited process exit. There is no running Studio service or private-storage bridge.
    const desk = await runClient('desk-withdraw', fixture);
    expect(desk.ownPublisherRoots).toEqual([KEYS.publisher]);
    expect(desk.receipt).toMatchObject({ entityKeys: [entityKey(10000)], consumedKeys: [KEYS.book], transactionHash: entityKey(6000) });
    expect(desk.walletMethods.filter(method => method === 'eth_sendTransaction')).toHaveLength(1);
    const restartedStudio = await runClient('studio-read', fixture);
    const cli = await runClient('cli-read', fixture);
    expect(new Set([initialStudio.pid, desk.pid, restartedStudio.pid, cli.pid]).size).toBe(4);
    for (const client of [desk, restartedStudio, cli]) {
      expect(client.fetchAttempts).toBe(0);
      expect(client.packet.snapshot).toMatchObject({ blockNumber: '101', blockHash: entityKey(5101), completeness: 'complete', freshness: 'fresh' });
      expect(client.packet.readiness).toMatchObject({ status: 'changed', acceptedApprovers: [],
        reasons: [expect.objectContaining({ code: 'withdrawn', publisherRoot: KEYS.publisher })] });
      expect(activeSource(client.packet.project)).toEqual(activeSource(initialStudio.packet.project));
      const book = client.packet.project.publishers[0]!.book;
      expect(book).toMatchObject({ status: 'unique', entity: { key: entityKey(10000), provenance: {
        creator: { kind: 'wallet', address: PUBLISHER }, owner: { kind: 'wallet', address: PUBLISHER }, readonly: true,
      }, payload: { grants: [], decisions: [expect.objectContaining({ status: 'withdrawn' })] } } });
    }
    expect(canonicalJson(restartedStudio.packet)).toBe(canonicalJson(cli.packet));
    expect(restartedStudio.walletMethods).toEqual([]);
    expect(cli.walletMethods).toEqual([]);
    expect(desk.storageKeys.every(key => key.startsWith('partfolk:partner-desk:'))).toBe(true);
    expect(fixture.sent).toHaveLength(1);
    for (const role of ['studio-read', 'desk-withdraw', 'cli-read'] as const) {
      expect(fixture.calls.some(call => call.role === role && call.method === 'arkiv_query')).toBe(true);
    }
    expect(fixture.rpc.queries.every(query => ['0x64', '0x65'].includes(query.options.atBlock))).toBe(true);
  }, 30_000);
});
