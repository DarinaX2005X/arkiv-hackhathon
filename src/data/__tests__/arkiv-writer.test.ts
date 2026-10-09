import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex } from 'viem';
import type { Hex } from 'viem';
import { hashPlan } from '../../domain/canonical';
import { prepareAttestation, prepareCloseProject, prepareDecision } from '../../domain/operations';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { AccountAddress, EntityPayload, PublicEntityKey } from '../../domain/types';
import type { OperationKind, ReplaceBookCommand, WriteAuthority } from '../types';
import { createOperationController, createOperationIntent, MemoryOperationStore } from '../operations';
import { createWalletGateway } from '../wallet';
import type { RpcRequest as WalletRequest } from '../wallet';
import { createArkivRepository } from '../arkiv';
import { ARKIV_ADDRESS } from '../arkiv/client';
import type { RpcRequest } from '../arkiv/client';
import { BLOCK_HASH, COORDINATOR, KEYS, NOW, PUBLISHER, STRANGER, entityKey, rawEntity, readyFixture } from './arkiv-fixture';
import type { RawEntity } from './arkiv-fixture';

const LIFETIME = 91 * 86400;
type RawLog = { address: string; topics: Hex[]; data: Hex; blockHash: Hex; blockNumber: Hex;
  transactionHash: Hex; transactionIndex: Hex; logIndex: Hex; removed: false };
const authority = (address: AccountAddress): WriteAuthority => ({ mode: 'public', actor: { kind: 'wallet', address }, chainId: TIRAMISU_CHAIN_ID });

/** Local ledger responses only; the production SDK serializes, reads and verifies every transaction. */
function harness(account: AccountAddress = PUBLISHER) {
  const source = readyFixture(); const { rpc } = source;
  const store = new MemoryOperationStore();
  const blocks = new Map<number, { number: Hex; hash: Hex; timestamp: Hex; transactions: never[] }>([
    [100, { number: '0x64', hash: BLOCK_HASH, timestamp: toHex(NOW / 1000), transactions: [] }],
  ]);
  const snapshots = new Map<number, RawEntity[]>([[100, structuredClone(rpc.rows)]]);
  const receipts = new Map<string, Record<string, unknown>>();
  const transactions = new Map<string, Record<string, unknown>>();
  let nextKey = 10000;
  const control = {
    account, sends: 0, sentTypes: [] as string[][],
    failBeforeAt: new Map<number, unknown>(), loseResponseAt: new Set<number>(),
    revertAt: new Set<number>(),
    hideReceipts: false, afterEstimate: undefined as (() => void) | undefined,
    reads: [] as string[],
  };
  function nextBlock() {
    rpc.block++; rpc.timestamp += 2000; rpc.blockHash = entityKey(5000 + rpc.block);
    blocks.set(rpc.block, { number: toHex(rpc.block), hash: rpc.blockHash, timestamp: toHex(rpc.timestamp / 1000), transactions: [] });
  }
  function saveSnapshot() { snapshots.set(rpc.block, structuredClone(rpc.rows)); }
  function externalReplaceBook() {
    nextBlock(); rpc.remove(KEYS.book);
    rpc.put(rawEntity(entityKey(9000), { ...source.book, predecessorKeys: [KEYS.book] }, PUBLISHER, { createdAt: toHex(rpc.block) }));
    saveSnapshot();
  }
  const read: RpcRequest = async args => {
    control.reads.push(args.method);
    if (args.method === 'eth_estimateGas') { const callback = control.afterEstimate; control.afterEstimate = undefined; callback?.(); return toHex(100000); }
    if (args.method === 'eth_gasPrice') return '0x2';
    if (args.method === 'eth_getTransactionReceipt') return control.hideReceipts ? null : structuredClone(receipts.get(String((args.params as unknown[])[0])) ?? null);
    if (args.method === 'eth_getTransactionByHash') return structuredClone(transactions.get(String((args.params as unknown[])[0])) ?? null);
    if (args.method === 'eth_getBlockByNumber') {
      const target = (args.params as unknown[])[0];
      const number = target === 'latest' ? rpc.block : Number(BigInt(String(target)));
      return structuredClone(blocks.get(number) ?? null);
    }
    if (args.method === 'eth_getLogs') {
      const query = (args.params as Record<string, unknown>[])[0]!;
      return [...receipts.values()].flatMap(receipt => receipt.logs as RawLog[]).filter(log =>
        BigInt(log.blockNumber) >= BigInt(String(query.fromBlock)) && BigInt(log.blockNumber) <= BigInt(String(query.toBlock))
        && (!Array.isArray(query.topics) || query.topics.every((topic, index) => topic === null || topic === log.topics[index])));
    }
    if (args.method === 'arkiv_query') {
      const requestedBlock = Number(BigInt((args.params as [string, { atBlock: string }])[1].atBlock));
      const current = rpc.rows; rpc.rows = structuredClone(snapshots.get(requestedBlock) ?? current);
      try { return await rpc.request(args); } finally { rpc.rows = current; }
    }
    return rpc.request(args);
  };
  const provider = { request: async (request: WalletRequest): Promise<unknown> => {
    if (request.method === 'eth_accounts') return [control.account];
    if (request.method === 'eth_chainId') return toHex(TIRAMISU_CHAIN_ID);
    if (request.method !== 'eth_sendTransaction') throw new Error(`Fixture forbids wallet method ${request.method}`);
    control.sends++;
    if (control.failBeforeAt.has(control.sends)) throw control.failBeforeAt.get(control.sends);
    const sent = request.params![0] as { from: AccountAddress; to: AccountAddress; data: Hex };
    const record = store.list().sort((left, right) => right.revision - left.revision)
      .find(candidate => candidate.step.status === 'unverified' && candidate.admission?.request.data === sent.data);
    if (!record) throw new Error('The send did not persist its exact admission first.');
    nextBlock();
    const hash = entityKey(6000 + control.sends); const logs: RawLog[] = [];
    const addLog = (name: 'EntityCreated' | 'EntityDeleted' | 'ExpiryExtended', key: PublicEntityKey, expiry?: bigint) => {
      logs.push({ address: ARKIV_ADDRESS,
        topics: encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName: name, args: { entityKey: key, owner: sent.from } }) as Hex[],
        data: name === 'EntityDeleted' ? '0x' : name === 'EntityCreated'
          ? encodeAbiParameters(parseAbiParameters('uint64,uint8'), [expiry!, 1])
          : encodeAbiParameters(parseAbiParameters('uint64'), [expiry!]),
        blockHash: rpc.blockHash, blockNumber: toHex(rpc.block), transactionHash: hash,
        transactionIndex: '0x0', logIndex: toHex(logs.length), removed: false });
    };
    const types: string[] = [];
    for (const create of control.revertAt.has(control.sends) ? [] : record.batch.creates ?? []) {
      const payload = JSON.parse(create.payloadJson) as EntityPayload; const key = entityKey(nextKey++);
      const expiry = BigInt(rpc.block + create.lifetimeSeconds / 2); types.push(payload.entityType);
      rpc.put(rawEntity(key, payload, sent.from, { createdAt: toHex(rpc.block), expiresAt: toHex(expiry) }));
      addLog('EntityCreated', key, expiry);
    }
    for (const key of control.revertAt.has(control.sends) ? [] : record.batch.deletes ?? []) { rpc.remove(key); addLog('EntityDeleted', key); }
    for (const extension of control.revertAt.has(control.sends) ? [] : record.batch.extensions ?? []) {
      rpc.row(extension.entityKey).expiresAt = toHex(BigInt(extension.expiresAtBlock));
      addLog('ExpiryExtended', extension.entityKey, BigInt(extension.expiresAtBlock));
    }
    control.sentTypes.push(types); saveSnapshot();
    receipts.set(hash, { transactionHash: hash, transactionIndex: '0x0', blockHash: rpc.blockHash, blockNumber: toHex(rpc.block),
      from: sent.from, to: ARKIV_ADDRESS, cumulativeGasUsed: toHex(100000), gasUsed: toHex(100000),
      effectiveGasPrice: '0x2', contractAddress: null, status: control.revertAt.has(control.sends) ? '0x0' : '0x1', type: '0x0', logsBloom: '0x', logs });
    transactions.set(hash, { hash, blockHash: rpc.blockHash, blockNumber: toHex(rpc.block), transactionIndex: '0x0',
      from: sent.from, to: sent.to, chainId: toHex(TIRAMISU_CHAIN_ID), value: '0x0', input: sent.data,
      gas: toHex(120000), gasPrice: '0x2', nonce: toHex(control.sends), type: '0x0', r: entityKey(1), s: entityKey(2), v: '0x1b' });
    if (control.loseResponseAt.has(control.sends)) throw new Error('The provider lost the response after inclusion.');
    return hash;
  } };
  const gateway = createWalletGateway({ provider, publicRpc: { request: read } });
  const controller = createOperationController({ store, gateway, now: () => rpc.timestamp });
  const repository = createArkivRepository({ request: read, controller, now: () => rpc.timestamp, receiptTimeoutMs: 10 });
  const command = <T extends object>(kind: OperationKind, fields: T, id = 'writer-operation', address = account) => ({
    ...structuredClone(fields), operation: createOperationIntent(kind, authority(address), fields, { id, now: NOW }),
  });
  const replacement = (): ReplaceBookCommand => command('replace_book', {
    publisherRoot: KEYS.publisher, expectedHeads: [KEYS.book],
    book: { ...structuredClone(source.book), predecessorKeys: [KEYS.book], name: 'Updated synthetic host' }, lifetimeSeconds: LIFETIME,
  });
  return { ...source, store, controller, gateway, repository, control, command, replacement, externalReplaceBook, saveSnapshot, read, receipts };
}

describe('writer preflight and facade error boundaries', () => {
  it('binds every command field to the frozen input before any RPC or wallet work', async () => {
    const f = harness(); const command = f.replacement(); command.book.name = 'Changed after review';
    const result = await f.repository.replaceBook(command);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', reasons: [{ code: 'hash_mismatch' }] } });
    expect(f.control.sends).toBe(0); expect(f.control.reads).toHaveLength(0);
  });
  it('rejects a missing wallet port as a typed facade error', async () => {
    const f = harness(); const readonly = createArkivRepository({ request: f.read, now: () => NOW });
    expect(await readonly.replaceBook(f.replacement())).toMatchObject({ ok: false, error: { code: 'not_connected' } });
    expect(f.control.sends).toBe(0);
  });
  it('rejects foreign root authority even when that wallet is connected', async () => {
    const f = harness(STRANGER);
    expect(await f.repository.replaceBook(f.replacement())).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(f.control.sends).toBe(0); expect(f.store.list()).toHaveLength(0);
  });
  it('rejects wrong chain and local authority before asking the public writer', async () => {
    const f = harness(); const command = f.replacement();
    (command.operation.authority as { chainId: number }).chainId = 1;
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'wrong_chain' } });
    command.operation.authority = { mode: 'local', chainId: null, actor: { kind: 'local', id: 'local-actor:one' } };
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(f.control.sends).toBe(0);
  });
  it('rejects stale heads and wrong payload predecessor references', async () => {
    const f = harness(); const command = f.replacement(); const { operation: _operation, ...fields } = command;
    const stale = f.command('replace_book', { ...fields, expectedHeads: [entityKey(999)], book: { ...fields.book, predecessorKeys: [entityKey(999)] } });
    expect(await f.repository.replaceBook(stale)).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    const unlinked = f.command('replace_book', { ...fields, book: { ...fields.book, predecessorKeys: [] } });
    expect(await f.repository.replaceBook(unlinked)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.control.sends).toBe(0);
  });
  it('checks the current heads again after unsigned preparation', async () => {
    const f = harness(); f.control.afterEstimate = f.externalReplaceBook;
    expect(await f.repository.replaceBook(f.replacement())).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(f.control.sends).toBe(0);
    expect(f.store.list()[0]?.admission).toBeNull();
  });
  it('requires explicit empty-book recovery and refuses copied grants under a missing scope', async () => {
    const f = harness(); f.rpc.remove(KEYS.book); f.saveSnapshot();
    const { operation: _operation, ...fields } = f.replacement();
    const missing = { ...fields, expectedHeads: [], book: { ...fields.book, predecessorKeys: [] } };
    expect(await f.repository.replaceBook(f.command('replace_book', missing))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const copied = { ...missing, recovery: { acknowledgedMissingState: true as const, redeclaredAvailability: true as const } };
    expect(await f.repository.replaceBook(f.command('replace_book', copied))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.control.sends).toBe(0);
  });
  it('rejects proposals and activations that do not descend from the current exact agreement', async () => {
    const f = harness(COORDINATOR);
    const proposal = f.command('publish_proposal', { projectRoot: KEYS.project, proposal: f.proposal, lifetimeSeconds: LIFETIME });
    expect(await f.repository.publishProposal(proposal)).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    const activation = f.command('activate_proposal', { projectRoot: KEYS.project, proposalKey: KEYS.proposal,
      proposalHash: f.proposal.proposalHash, expectedActivationHeads: [KEYS.activation], lifetimeSeconds: LIFETIME });
    expect(await f.repository.activateProposal(activation)).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(f.control.sends).toBe(0);
  });
});

describe('writer confirmation and resumable operations', () => {
  it('resumes only a mined-reverted initialization phase while retaining the original root and failed attempt', async () => {
    const f = harness(COORDINATOR); f.control.revertAt.add(2);
    const command = f.command('create_project', { recipe: f.state.recipe, lifetimeSeconds: LIFETIME });
    expect(await f.repository.createProject(command)).toMatchObject({ ok: false, error: { code: 'reverted' } });
    const saved = f.controller.getOperation(command.operation.id)!;
    const root = saved.confirmedKeys[0]!;
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'partial_reverted', operation: { confirmedKeys: [root] } } });
    expect(f.control.sends).toBe(2);
    const resumed = await f.repository.createProject(command);
    expect(resumed).toMatchObject({ ok: true, value: { value: { root: { key: root } } } });
    expect(f.control.sentTypes).toEqual([['project_root'], [], ['project_state']]);
    const attempts = f.controller.getOperation(command.operation.id)!.steps;
    expect(attempts.map(step => step.status)).toEqual(['confirmed', 'reverted', 'confirmed']);
    expect(attempts[1]!.id).not.toBe(attempts[2]!.id);
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'confirmed' } });
    expect(await f.repository.createProject(command)).toMatchObject({ ok: true });
    expect(f.control.sends).toBe(3);
  });
  it('retains the proposal and activation when an explicitly resumed request fanout follows a mined revert', async () => {
    const f = harness(COORDINATOR);
    const plan = { ...structuredClone(f.plan), predecessor: f.source, instructions: 'Revised synthetic workshop.' };
    const proposal = { ...structuredClone(f.proposal), plan, proposalHash: hashPlan(plan), changeExplanation: 'Updated instructions.' };
    const command = f.command('publish_plan', { projectRoot: KEYS.project, proposal, expectedActivationHeads: [KEYS.activation],
      requestPublisherRoots: [KEYS.publisher], lifetimeSeconds: LIFETIME });
    f.control.revertAt.add(3);
    expect(await f.repository.publishPlan(command)).toMatchObject({ ok: false, error: { code: 'reverted' } });
    const prior = f.controller.getOperation(command.operation.id)!;
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'partial_reverted' } });
    expect(await f.repository.publishPlan(command)).toMatchObject({ ok: true, value: { proposalKey: prior.confirmedKeys[0], activationKey: prior.confirmedKeys[1] } });
    expect(f.control.sentTypes).toEqual([['proposal'], ['plan_activation'], [], ['project_link']]);
    expect(f.controller.getOperation(command.operation.id)!.steps.map(step => step.status)).toEqual(['confirmed', 'confirmed', 'reverted', 'confirmed']);
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'confirmed' } });
  });
  it('keeps a first-phase or single-transaction mined revert terminal', async () => {
    const f = harness(); f.control.revertAt.add(1); const command = f.replacement();
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'reverted' } });
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'reverted' } });
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'reverted' } });
    expect(f.control.sends).toBe(1);
  });
  it('resumes an interrupted root creation into exactly one initialized project', async () => {
    const f = harness(COORDINATOR);
    const command = f.command('create_project', { recipe: f.state.recipe, lifetimeSeconds: LIFETIME });
    f.control.loseResponseAt.add(1);
    expect(await f.repository.createProject(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    const result = await f.repository.createProject(command);
    expect(result).toMatchObject({ ok: true, value: { value: { state: { status: 'unique' }, activation: { status: 'missing' } }, operation: { phase: 'complete' } } });
    expect(f.control.sentTypes).toEqual([['project_root'], ['project_state']]);
    expect(await f.repository.createProject(command)).toMatchObject({ ok: true });
    expect(f.control.sends).toBe(2);
  });
  it('validates a publisher initial book before creating its root and initializes only once', async () => {
    const f = harness();
    expect(await f.repository.registerPublisher(f.command('register_publisher', { kind: 'individual' as const,
      name: '', description: '', lifetimeSeconds: LIFETIME }))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.control.sends).toBe(0);
    const command = f.command('register_publisher', { kind: 'individual' as const, name: 'A synthetic contributor', description: '', lifetimeSeconds: LIFETIME });
    expect(await f.repository.registerPublisher(command)).toMatchObject({ ok: true, value: { value: { book: { status: 'unique', entity: { payload: { resources: [], grants: [] } } } } } });
    expect(await f.repository.registerPublisher(command)).toMatchObject({ ok: true });
    expect(f.control.sentTypes).toEqual([['publisher_root'], ['book_state']]);
  });
  it('confirms an explicitly empty same-root recovery without restoring cached approval', async () => {
    const f = harness(); f.rpc.remove(KEYS.book); f.saveSnapshot();
    const book = { ...structuredClone(f.book), predecessorKeys: [], resources: [], offers: [], decisions: [], grants: [], attestations: [], custodyHolds: [] };
    const command = f.command('replace_book', { publisherRoot: KEYS.publisher, expectedHeads: [], book,
      recovery: { acknowledgedMissingState: true as const, redeclaredAvailability: true as const }, lifetimeSeconds: LIFETIME });
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: true, value: { receipt: { consumedKeys: [] }, value: { payload: { publisherRoot: KEYS.publisher, grants: [] } } } });
    expect(f.control.sends).toBe(1);
  });
  it('freshly revalidates an exact owner acceptance before replacing its book', async () => {
    const f = harness(); const loaded = await f.repository.loadProject(KEYS.project);
    if (!loaded.ok) throw new Error('Fixture project failed to load.');
    const prepared = prepareDecision(loaded.value, KEYS.publisher, authority(PUBLISHER).actor,
      { status: 'accepted', operationId: 'fresh-acceptance', now: NOW, validUntil: f.book.grants[0]!.validUntil });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    const command = f.command('replace_book', { publisherRoot: KEYS.publisher, ...prepared.value, lifetimeSeconds: LIFETIME });
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: true, value: { value: { payload: { grants: [{ operationId: 'fresh-acceptance' }] } } } });
    expect(f.control.sends).toBe(1);
  });
  it('rejects a fabricated task obligation and accepts the owner assertion for its actual duty', async () => {
    const f = harness(); const loaded = await f.repository.loadProject(KEYS.project);
    if (!loaded.ok) throw new Error('Fixture project failed to load.');
    const attestation = { ...f.source, kind: 'task_report' as const, id: 'task-report', author: KEYS.publisher,
      obligationId: f.plan.runbook[0]!.id, recordedAt: NOW, operationId: 'task-report-op', status: 'done' as const, note: 'Synthetic completion.' };
    const bad = { ...f.book, predecessorKeys: [KEYS.book], attestations: [{ ...attestation, obligationId: 'fabricated-duty' }] };
    expect(await f.repository.replaceBook(f.command('replace_book', { publisherRoot: KEYS.publisher, expectedHeads: [KEYS.book], book: bad, lifetimeSeconds: LIFETIME }, 'bad-report')))
      .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.control.sends).toBe(0);
    const prepared = prepareAttestation(loaded.value, KEYS.publisher, authority(PUBLISHER).actor, attestation);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    const command = f.command('replace_book', { publisherRoot: KEYS.publisher, ...prepared.value, lifetimeSeconds: LIFETIME }, 'valid-report');
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: true }); expect(f.control.sends).toBe(1);
  });
  it('closes with honest outstanding work while atomically consuming the current activation', async () => {
    const f = harness(COORDINATOR); const loaded = await f.repository.loadProject(KEYS.project);
    if (!loaded.ok) throw new Error('Fixture project failed to load.');
    const prepared = prepareCloseProject(loaded.value, authority(COORDINATOR).actor,
      { outcome: 'cancelled', statement: 'Synthetic cancellation.', operationId: 'cancel', now: NOW });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    const command = f.command('close_project', { projectRoot: KEYS.project, ...prepared.value, lifetimeSeconds: LIFETIME });
    expect(await f.repository.replaceProject(command)).toMatchObject({ ok: true, value: { receipt: { consumedKeys: [KEYS.state, KEYS.activation] } } });
    const closed = await f.repository.loadProject(KEYS.project);
    expect(closed).toMatchObject({ ok: true, value: { state: { status: 'unique', entity: { payload: { lifecycle: 'closed', completion: { outcome: 'cancelled' } } } }, activation: { status: 'missing' } } });
    expect(f.rpc.rows.some(row => row.key === KEYS.book)).toBe(true);
  });
  it('confirms an independently verified replacement and resumes the original command without sending twice', async () => {
    const f = harness(); const command = f.replacement();
    const first = await f.repository.replaceBook(command);
    expect(first).toMatchObject({ ok: true, value: { operation: { phase: 'complete' }, receipt: { consumedKeys: [KEYS.book] } } });
    expect(f.control.sends).toBe(1); expect(command.operation.steps).toHaveLength(0);
    const second = await f.repository.replaceBook(command);
    expect(second).toMatchObject({ ok: true }); expect(f.control.sends).toBe(1);
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'confirmed' } });
  });
  it('can explicitly retry a rejected wallet prompt through the same writer operation', async () => {
    const f = harness(); const command = f.replacement();
    f.control.failBeforeAt.set(1, { code: 4001, message: 'User rejected the wallet prompt.' });
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'rejected' } });
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'not_sent' } });
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: true });
    expect(f.control.sends).toBe(2); expect(f.store.list()).toHaveLength(1);
  });
  it('recovers a mined operation after a lost wallet response without broadcasting again', async () => {
    const f = harness(); const command = f.replacement(); f.control.loseResponseAt.add(1);
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    expect(f.store.list()[0]).toMatchObject({ submissionHash: null, step: { status: 'unverified' } });
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: true });
    expect(f.control.sends).toBe(1); expect(f.control.reads).toContain('eth_getLogs');
  });
  it('preserves a submitted hash when confirmation is unavailable, then confirms by reconciliation', async () => {
    const f = harness(); const command = f.replacement(); f.control.hideReceipts = true;
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    const saved = f.controller.getOperation(command.operation.id)!;
    expect(saved.transactionHash).not.toBeNull(); expect(saved.steps[0]!.status).toBe('submitted');
    f.control.hideReceipts = false;
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: true });
    expect(f.control.sends).toBe(1);
  });
  it('never reports not_sent when a caller has send evidence but its local sidecar is missing', async () => {
    const f = harness(); const command = f.replacement();
    command.operation.transactionHash = entityKey(8000);
    command.operation.steps = [{ id: 'lost-journal', phase: 'book_pending', status: 'submitted', transactionHash: entityKey(8000),
      confirmedKeys: [], expectedHeads: [KEYS.book], inputHash: command.operation.inputHash }];
    expect(await f.repository.reconcile(command.operation)).toMatchObject({ ok: true, value: { status: 'unverified' } });
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    expect(f.control.sends).toBe(0);
  });
  it('resumes proposal/activation/fanout by retained step IDs after the final response is lost', async () => {
    const f = harness(COORDINATOR);
    const plan = { ...structuredClone(f.plan), predecessor: f.source, instructions: 'A revised synthetic workshop.' };
    const proposal = { ...structuredClone(f.proposal), plan, proposalHash: hashPlan(plan), changeExplanation: 'Revised workshop instructions.' };
    const command = f.command('publish_plan', { projectRoot: KEYS.project, proposal, expectedActivationHeads: [KEYS.activation],
      requestPublisherRoots: [KEYS.publisher], lifetimeSeconds: LIFETIME });
    f.control.loseResponseAt.add(3);
    expect(await f.repository.publishPlan(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    expect(f.control.sends).toBe(3);
    expect(f.control.sentTypes).toEqual([['proposal'], ['plan_activation'], ['project_link']]);
    const resumed = await f.repository.publishPlan(command);
    expect(resumed).toMatchObject({ ok: true, value: { operation: { phase: 'complete' }, pendingPublisherRoots: [] } });
    expect(f.control.sends).toBe(3);
    expect(f.controller.getOperation(command.operation.id)?.steps).toHaveLength(3);
  });
});
