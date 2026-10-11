import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex } from 'viem';
import type { Hex } from 'viem';
import { hashOffer, hashPlan, hashRequirements } from '../../domain/canonical';
import { deriveExecution } from '../../domain/execution';
import { activeSource } from '../../domain/readiness';
import { prepareAttestation, prepareCloseProject, prepareDecision } from '../../domain/operations';
import { independentlyValidatePlan } from '../../domain/validation';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { AccountAddress, EntityPayload, PublicEntityKey } from '../../domain/types';
import { prepareProgressCommand, runbookRows } from '../../features/execution/model';
import type { ProgressInput } from '../../features/execution/model';
import { repairInput, solveRepair } from '../../features/execution/repair';
import { publishPlanInput } from '../../features/projects/selectors';
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

function equipmentHarness() {
  const f = harness(), recipientRoot = entityKey(80), recipientBook = entityKey(81);
  const offer = f.book.offers[0]!;
  Object.assign(offer, { resourceId: 'boards', kind: 'equipment', unit: 'board', quantity: 6 });
  Object.assign(f.book.resources[0]!, { id: 'boards', kind: 'equipment', unit: 'board', capacity: 6 });
  Object.assign(f.plan.variant.requirements[0]!, { kind: 'equipment', unit: 'board', quantity: 6 });
  Object.assign(f.plan.allocations[0]!, { resourceId: 'boards', unit: 'board', quantity: 6, offerHash: hashOffer(KEYS.publisher, offer) });
  Object.assign(f.plan.offers[0]!, { offerHash: hashOffer(KEYS.publisher, offer) });
  Object.assign(f.plan.resourceAssumptions[0]!, { resourceId: 'boards', unit: 'board', capacity: 6 });
  const allocation = f.plan.allocations[0]!;
  const common = { publisherRoot: KEYS.publisher, resourceId: 'boards', quantity: 6, unit: 'board',
    allocationIds: [allocation.id], dependsOn: [], instructions: 'Count the boards.' };
  f.plan.runbook.push({ ...common, kind: 'handover', id: 'send', transferId: 'delivery', title: 'Deliver boards',
    giver: KEYS.publisher, receiver: recipientRoot, interval: { start: allocation.interval.start, end: allocation.interval.start + 1 } },
  { ...common, kind: 'return', id: 'return', transferId: 'return-delivery', title: 'Return boards', publisherRoot: recipientRoot,
    giver: recipientRoot, receiver: KEYS.publisher, interval: { start: allocation.interval.end - 1, end: allocation.interval.end } });
  f.plan.requiredApprovers.push(recipientRoot);
  f.proposal.proposalHash = hashPlan(f.plan); f.proposal.requirementsHash = hashRequirements(KEYS.project, f.plan.variant.requirements);
  f.activation.proposalHash = f.proposal.proposalHash;
  f.state.publisherRoots.push(recipientRoot);
  f.book.decisions[0]!.proposalHash = f.proposal.proposalHash;
  Object.assign(f.book.grants[0]!, { proposalHash: f.proposal.proposalHash, offers: f.plan.offers, allocations: f.plan.allocations });
  f.requestLink.proposalHash = f.proposal.proposalHash;
  f.rpc.update(KEYS.book, f.book); f.rpc.update(KEYS.proposal, f.proposal); f.rpc.update(KEYS.activation, f.activation);
  f.rpc.update(KEYS.state, f.state); f.rpc.update(KEYS.requestLink, f.requestLink);
  f.rpc.put(rawEntity(recipientRoot, { ...f.publisher, publisher: { kind: 'wallet', address: STRANGER } }, STRANGER));
  f.rpc.put(rawEntity(recipientBook, { ...f.book, publisherRoot: recipientRoot, name: 'Recipient', resources: [], offers: [], decisions: [], grants: [], attestations: [], custodyHolds: [] }, STRANGER));
  f.saveSnapshot();
  async function load() {
    const result = await f.repository.loadProject(KEYS.project);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    for (const publisher of result.value.publishers) if (publisher.book.status !== 'unique') throw new Error(JSON.stringify(publisher.book));
    return result.value;
  }
  async function progress(address: AccountAddress, duty: string, input: ProgressInput, id: string) {
    f.control.account = address;
    const project = await load();
    const command = prepareProgressCommand(project, project.proposal!, activeSource(project)!, duty, authority(address), input, f.rpc.timestamp, id);
    const result = await f.repository.replaceBook(command);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return load();
  }
  return { ...f, recipientRoot, load, progress };
}

describe('public transfer commands with the real writer and injected RPC', () => {
  it('persists sender six-to-four correction through writer capacity checks and requires the receiver’s new receipt', async () => {
    const f = equipmentHarness();
    await f.progress(PUBLISHER, 'send', { kind: 'transfer_report', quantity: 6 }, 'original-six');
    await f.progress(STRANGER, 'send', { kind: 'transfer_acknowledgement', reportId: 'report:original-six', quantity: 6 }, 'receipt-six');
    let project = await f.progress(PUBLISHER, 'send', { kind: 'transfer_report', correctsReportId: 'report:original-six', quantity: 4 }, 'correct-four');
    let row = runbookRows(project, project.proposal!, activeSource(project), null).find(item => item.obligation.id === 'send')!;
    expect(row).toMatchObject({ reportedQuantity: 4, acknowledgedQuantity: 0, status: 'awaiting_acknowledgement' });
    expect(row.historicalStatements.map(item => item.id)).toEqual(expect.arrayContaining(['report:original-six', 'report:receipt-six']));
    expect(deriveExecution(project).outstandingCustodyHolds.map(hold => hold.quantity)).toEqual([4]);
    project = await f.progress(STRANGER, 'send', { kind: 'transfer_acknowledgement', reportId: 'report:correct-four', quantity: 4 }, 'receipt-four');
    row = runbookRows(project, project.proposal!, activeSource(project), null).find(item => item.obligation.id === 'send')!;
    expect(row.acknowledgedQuantity).toBe(4); expect(deriveExecution(project).reasons).toEqual([]);
    expect(f.control.sends).toBe(4);
  });
  it('publishes reconciled remaining work and accepts two held plus four new boards through their full return', async () => {
    const f = equipmentHarness();
    await f.progress(PUBLISHER, 'send', { kind: 'transfer_report', quantity: 6 }, 'reported-six');
    let project = await f.progress(STRANGER, 'send', { kind: 'transfer_acknowledgement', reportId: 'report:reported-six', quantity: 2 }, 'received-two');
    expect(repairInput(project)).toBeNull();
    await f.progress(PUBLISHER, 'send', { kind: 'transfer_report', correctsReportId: 'report:reported-six', quantity: 2 }, 'correct-two');
    project = await f.progress(STRANGER, 'send', { kind: 'transfer_acknowledgement', reportId: 'report:correct-two', quantity: 2 }, 'confirm-two');
    const input = repairInput(project)!;
    const candidate = solveRepair(project, input, [], { maxNodes: 10000, maxCandidates: 1 }).candidates[0]!;
    expect(candidate.plan.runbook.find(duty => duty.id === 'send')).toMatchObject({ quantity: 4 });
    f.control.account = COORDINATOR;
    const fields = publishPlanInput(project, candidate, 'repair-transfer', f.rpc.timestamp, 'Deliver the remaining four boards.', { sourceRecipe: input.recipe });
    const published = await f.repository.publishPlan(f.command('publish_plan', fields, 'repair-transfer', COORDINATOR));
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    project = await f.progress(PUBLISHER, 'send', { kind: 'transfer_report', quantity: 4 }, 'remaining-four');
    expect(deriveExecution(project).outstandingCustodyHolds.reduce((sum, hold) => sum + hold.quantity, 0)).toBe(6);
    await f.progress(STRANGER, 'send', { kind: 'transfer_acknowledgement', reportId: 'report:remaining-four', quantity: 4 }, 'received-four');
    await f.progress(STRANGER, 'return', { kind: 'transfer_report', quantity: 6 }, 'return-six');
    project = await f.progress(PUBLISHER, 'return', { kind: 'transfer_acknowledgement', reportId: 'report:return-six', quantity: 6 }, 'confirm-return');
    expect(deriveExecution(project).outstandingCustodyHolds).toEqual([]);
    expect(deriveExecution(project).completed.map(work => work.obligationId)).toEqual(expect.arrayContaining(['send', 'return']));
    expect(independentlyValidatePlan(project.proposal!.payload.plan, project.publishers, project.snapshot.blockTimestamp).valid).toBe(true);
  });
});

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
  it.each([[], [KEYS.project], [entityKey(999), KEYS.project]].map(projectScope => ({ projectScope })))('publishes an owned offer link when its project is allowed by scope %j', async ({ projectScope }) => {
    const f = harness(); f.book.offers[0]!.projectScope = projectScope;
    f.rpc.update(KEYS.book, f.book); f.saveSnapshot();
    const command = f.command('publish_project_link', { link: f.offerLink, lifetimeSeconds: LIFETIME });
    expect(await f.repository.publishProjectLink(command)).toMatchObject({ ok: true });
    expect(f.control.sentTypes).toEqual([['project_link']]);
  });
  it('rejects an offer link before unsigned preparation if any named offer excludes the project', async () => {
    const f = harness();
    f.book.offers.push({ ...structuredClone(f.book.offers[0]!), id: 'scoped-elsewhere', projectScope: [entityKey(999)] });
    f.rpc.update(KEYS.book, f.book); f.saveSnapshot();
    const command = f.command('publish_project_link', {
      link: { ...f.offerLink, offerIds: ['host', 'scoped-elsewhere'] }, lifetimeSeconds: LIFETIME,
    });
    expect(await f.repository.publishProjectLink(command)).toMatchObject({ ok: false,
      error: { code: 'invalid_input', reasons: [{ code: 'missing_offer' }] } });
    expect(f.control.sends).toBe(0); expect(f.control.reads).not.toContain('eth_estimateGas');
    expect(f.store.list()).toHaveLength(0);
  });
  it('does not let a foreign wallet publish an offer link even when its project scope matches', async () => {
    const f = harness(STRANGER);
    const command = f.command('publish_project_link', { link: f.offerLink, lifetimeSeconds: LIFETIME });
    expect(await f.repository.publishProjectLink(command)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(f.control.sends).toBe(0); expect(f.control.reads).not.toContain('eth_estimateGas');
    expect(f.store.list()).toHaveLength(0);
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
  it('does not prepare or admit a write against a stalled current head', async () => {
    const f = harness();
    const repository = createArkivRepository({ request: f.read, controller: f.controller, now: () => NOW + 7 * 86_400_000 });
    expect(await repository.replaceBook(f.replacement())).toMatchObject({ ok: false,
      error: { code: 'unverified', reasons: [{ code: 'stale_snapshot' }] } });
    expect(f.control.sends).toBe(0);
    expect(f.control.reads).not.toContain('eth_estimateGas');
    expect(f.store.list()).toHaveLength(0);
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
  it.each(['proposal', 'activation', 'acceptance'] as const)('rejects %s that reuses capacity already occupied by completed predecessor work', async action => {
    const f = harness(action === 'acceptance' ? PUBLISHER : COORDINATOR);
    f.book.attestations.push({ ...f.source, kind: 'task_report', id: 'completed-welcome', operationId: 'report-welcome',
      obligationId: 'welcome', author: KEYS.publisher, recordedAt: NOW, status: 'done', note: '' });
    f.state.completedWork = [{ source: f.source, obligationId: 'welcome', attestationIds: ['completed-welcome'],
      recordedAt: NOW, evidenceAvailability: 'available' }];
    const plan = structuredClone(f.plan); plan.predecessor = f.source;
    plan.variant.requirements[0] = { ...plan.variant.requirements[0]!, id: 'remaining-hosting', title: 'Host another group' };
    plan.allocations[0] = { ...plan.allocations[0]!, id: 'remaining-allocation', requirementId: 'remaining-hosting' };
    plan.runbook[0] = { ...plan.runbook[0]!, id: 'remaining-task', title: 'Host another group', allocationIds: ['remaining-allocation'] };
    const proposal = { ...f.proposal, operationId: 'overlapping-proposal', plan, proposalHash: hashPlan(plan),
      requirementsHash: hashRequirements(KEYS.project, plan.variant.requirements), changeExplanation: 'Add remaining work.' };
    const proposalKey = entityKey(92), activationKey = entityKey(93);
    f.rpc.put(rawEntity(proposalKey, proposal, COORDINATOR, { createdAt: toHex(92) }));
    if (action === 'acceptance') {
      f.rpc.remove(KEYS.activation);
      f.rpc.put(rawEntity(activationKey, { ...f.activation, proposalKey, proposalHash: proposal.proposalHash,
        predecessorActivationKeys: [KEYS.activation] }, COORDINATOR, { createdAt: toHex(93) }));
    }
    f.rpc.update(KEYS.book, f.book); f.rpc.update(KEYS.state, f.state); f.saveSnapshot();
    const loaded = await f.repository.loadProject(KEYS.project);
    if (!loaded.ok) throw new Error('Expected a readable completed-work fixture.');
    // The current allocations alone fit; only independently verified completed history closes this bypass.
    expect(independentlyValidatePlan(plan, loaded.value.publishers, NOW).valid).toBe(true);
    const result = action === 'proposal'
      ? await f.repository.publishProposal(f.command('publish_proposal', { projectRoot: KEYS.project, proposal, lifetimeSeconds: LIFETIME }))
      : action === 'activation'
        ? await f.repository.activateProposal(f.command('activate_proposal', { projectRoot: KEYS.project, proposalKey,
          proposalHash: proposal.proposalHash, expectedActivationHeads: [KEYS.activation], lifetimeSeconds: LIFETIME }))
        : await f.repository.replaceBook(f.command('replace_book', { publisherRoot: KEYS.publisher, expectedHeads: [KEYS.book],
          book: { ...f.book, predecessorKeys: [KEYS.book],
            decisions: [{ ...f.book.decisions[0]!, activationKey, proposalKey, proposalHash: proposal.proposalHash, operationId: 'accept-overlap', decidedAt: NOW }],
            grants: [{ ...f.book.grants[0]!, activationKey, proposalKey, proposalHash: proposal.proposalHash,
              id: 'overlapping-grant', operationId: 'accept-overlap', acceptedAt: NOW, allocations: plan.allocations, offers: plan.offers }] },
          lifetimeSeconds: LIFETIME }));
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'capacity_exceeded', resourceId: 'self', params: { capacity: 1, required: 2 } })]) } });
    expect(f.control.sends).toBe(0); expect(f.control.reads).not.toContain('eth_estimateGas');
    expect(f.store.list()).toHaveLength(0);
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
  it('reconciles an old known receipt without treating its historical block as a current head', async () => {
    const f = harness(); const command = f.replacement(); f.control.hideReceipts = true;
    expect(await f.repository.replaceBook(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    const saved = f.controller.getOperation(command.operation.id)!;
    expect(saved.steps[0]!.status).toBe('submitted');
    f.control.hideReceipts = false;
    f.rpc.timestamp = NOW + 7 * 86_400_000;
    expect(await f.repository.reconcile(saved)).toMatchObject({ ok: true,
      value: { status: 'pending', operation: { steps: [{ status: 'confirmed' }] } } });
    expect(f.store.list()[0]?.receipt?.blockNumber).toBe('101');
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
