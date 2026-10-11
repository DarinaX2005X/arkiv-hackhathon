import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS_ABI } from '@arkiv-network/sdk';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex } from 'viem';
import type { Hex } from 'viem';
import { hashPlan } from '../../domain/canonical';
import { prepareAttestation, prepareCloseProject, prepareDecision } from '../../domain/operations';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { AccountAddress, EntityPayload, PublicEntityKey } from '../../domain/types';
import type { OperationKind, ReplaceBookCommand, WriteAuthority } from '../types';
import type { StoredOperationStep } from '../operations';
import { createOperationController, createOperationIntent, MemoryOperationStore } from '../operations';
import { createWalletGateway } from '../wallet';
import type { RpcRequest as WalletRequest } from '../wallet';
import { createArkivRepository } from '../arkiv';
import { ARKIV_ADDRESS } from '../arkiv/client';
import type { RpcRequest } from '../arkiv/client';
import { BLOCK_HASH, COORDINATOR, KEYS, NOW, PUBLISHER, STRANGER, entityKey, rawEntity, readyFixture } from '../__tests__/arkiv-fixture';
import type { RawEntity } from '../__tests__/arkiv-fixture';

import { stringToHex } from 'viem';
import { createEventRepository } from './repository';
import type { EventAdmission, EventPayload, EventRecord, EventRelease, EventState, AttendanceState, AudienceTerms } from '../../domain/events';
import { audienceHash, attendanceStatus, eventAvailability } from '../../domain/events';
import { unwrap } from '../arkiv/errors';

const terms: AudienceTerms = { title: 'Open workshop', description: 'Make together.', startsAt: NOW + 3_600_000,
  endsAt: NOW + 7_200_000, timeZone: 'UTC', venue: 'Library', instructions: 'Front entrance.', conditions: 'Free, open participation.' };
function rawEvent(key: PublicEntityKey, payload: EventPayload, creator: AccountAddress, overrides: Partial<RawEntity> = {}): RawEntity {
  const attributes: RawEntity['attributes'] = [
    { name: 'project', type: 'str', value: 'partfolk-events' }, { name: 'entity_type', type: 'str', value: payload.entityType },
    { name: 'schema_version', type: 'i32', value: 1 }, { name: 'created_at', type: 'u64', value: toHex(payload.createdAt) },
    { name: 'operation_id', type: 'str', value: payload.operationId }, { name: 'project_key', type: 'key', value: payload.projectRoot },
    { name: 'audience_hash', type: 'bytes32', value: payload.audienceHash },
  ];
  if (payload.entityType === 'event_release' || payload.entityType === 'event_state') {
    attributes.push({ name: 'starts_at', type: 'u64', value: toHex(payload.entityType === 'event_release' ? payload.terms.startsAt : payload.startsAt) },
      { name: 'ends_at', type: 'u64', value: toHex(payload.entityType === 'event_release' ? payload.terms.endsAt : payload.endsAt) },
      { name: 'proposal_key', type: 'key', value: payload.source.proposalKey });
  }
  if (payload.entityType !== 'event_release') attributes.push({ name: 'release_key', type: 'key', value: payload.releaseKey });
  if (payload.entityType === 'event_state') attributes.push({ name: 'status', type: 'str', value: payload.status });
  if (payload.entityType === 'attendance_state') attributes.push({ name: 'decision', type: 'str', value: payload.decision });
  return { key, creator, owner: creator, createdAt: toHex(100), expiresAt: toHex(9_000_000), creationFlags: 1,
    contentType: 'application/json', payload: stringToHex(JSON.stringify(payload)), attributes, ...overrides };
}
const LIFETIME = 91 * 86400;
type RawLog = { address: string; topics: Hex[]; data: Hex; blockHash: Hex; blockNumber: Hex;
  transactionHash: Hex; transactionIndex: Hex; logIndex: Hex; removed: false };
const authority = (address: AccountAddress): WriteAuthority => ({ mode: 'public', actor: { kind: 'wallet', address }, chainId: TIRAMISU_CHAIN_ID });

/** Local ledger responses only; the production SDK serializes, reads and verifies every transaction. */
function harness(account: AccountAddress = COORDINATOR) {
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
      rpc.put(rawEvent(key, payload as unknown as EventPayload, sent.from, { createdAt: toHex(rpc.block), expiresAt: toHex(expiry) }));
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
  const repository = createEventRepository({ request: read, controller, now: () => rpc.timestamp, receiptTimeoutMs: 10 });
  const command = <T extends object>(kind: OperationKind, fields: T, id = 'writer-operation', address = account) => ({
    ...structuredClone(fields), operation: createOperationIntent(kind, authority(address), fields, { id, now: NOW }),
  });
  const replacement = (): ReplaceBookCommand => command('replace_book', {
    publisherRoot: KEYS.publisher, expectedHeads: [KEYS.book],
    book: { ...structuredClone(source.book), predecessorKeys: [KEYS.book], name: 'Updated synthetic host' }, lifetimeSeconds: LIFETIME,
  });
  return { ...source, store, controller, gateway, repository, control, command, replacement, externalReplaceBook, saveSnapshot, nextBlock, read, receipts, transactions };
}

const publish = (f: ReturnType<typeof harness>, id = 'event-publish') => f.command('publish_event', {
  projectRoot: KEYS.project, terms, source: f.source, expectedHeads: [], lifetimeSeconds: LIFETIME,
}, id);
async function published(f: ReturnType<typeof harness>) {
  const result = unwrap(await f.repository.publishEvent(publish(f)));
  if (result.value.state.status !== 'unique' || !result.value.release) throw new Error('Fixture publication did not resolve.');
  return { event: result.value, state: result.value.state.entity, release: result.value.release };
}
function attendanceCommand(f: ReturnType<typeof harness>, release: EventRecord<EventRelease>, expectedHeads: PublicEntityKey[] = [],
  decision: 'going' | 'withdrawn' = 'going', id = 'attendance-join') {
  return f.command('replace_attendance', { projectRoot: KEYS.project, releaseKey: release.key,
    audienceHash: release.payload.audienceHash, decision, expectedHeads, lifetimeSeconds: LIFETIME }, id, STRANGER);
}

function structuredTerms(changes: Partial<AudienceTerms> = {}): AudienceTerms {
  return { ...terms, termsVersion: 2, format: 'in_person', location: { countryCode: 'GB', country: 'United Kingdom', city: 'Oxford', venue: terms.venue },
    online: null, registration: { deadline: NOW + 60_000, capacity: { kind: 'limited', limit: 1 }, waitlist: true, admission: 'open', invitedAccounts: [] }, ...changes };
}
async function publishStructured(f: ReturnType<typeof harness>, next = structuredTerms()) {
  const mutation = unwrap(await f.repository.publishEvent(f.command('publish_event', {
    projectRoot: KEYS.project, terms: next, source: f.source, expectedHeads: [], lifetimeSeconds: LIFETIME,
  }, 'structured-publish')));
  if (mutation.value.state.status !== 'unique' || !mutation.value.release) throw new Error('fixture');
  return { event: mutation.value, state: mutation.value.state.entity, release: mutation.value.release };
}
function admissionCommand(f: ReturnType<typeof harness>, state: EventRecord<EventState>, admissions: EventAdmission[], id: string) {
  return f.command('replace_event', { projectRoot: KEYS.project, releaseKey: state.payload.releaseKey, audienceHash: state.payload.audienceHash,
    source: state.payload.source, status: state.payload.status, expectedHeads: [state.key], lifetimeSeconds: LIFETIME, admissions }, id, COORDINATOR);
}
const admissionFor = (record: EventRecord<AttendanceState>): EventAdmission => ({ attendee: record.payload.attendee, attendanceKey: record.key, releaseKey: record.payload.releaseKey });

describe('native structured-event admissions', () => {
  it('guards closed-deadline material edits for unlimited attendees before writing and allows deliberate reopening', async () => {
    const f = harness(); const next = structuredTerms(); next.registration = { ...next.registration!, capacity: { kind: 'unlimited' }, waitlist: false, deadline: NOW + 10_000 };
    const { state, release } = await publishStructured(f, next); f.control.account = STRANGER;
    unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release)));
    while (f.rpc.timestamp < NOW + 10_000) { f.nextBlock(); f.saveSnapshot(); }
    f.control.account = COORDINATOR; const sends = f.control.sends;
    const changed = { ...next, description: 'New instructions that need fresh consent' };
    const blocked = await f.repository.publishEvent(f.command('publish_event', { projectRoot: KEYS.project, terms: changed, source: f.source,
      expectedHeads: [state.key], lifetimeSeconds: LIFETIME }, 'closed-deadline-edit'));
    expect(blocked.ok).toBe(false); expect(!blocked.ok && blocked.error.diagnostic).toContain('later registration deadline');
    expect(f.control.sends).toBe(sends);
    changed.registration = { ...changed.registration!, deadline: next.endsAt };
    const reopened = unwrap(await f.repository.publishEvent(f.command('publish_event', { projectRoot: KEYS.project, terms: changed, source: f.source,
      expectedHeads: [state.key], lifetimeSeconds: LIFETIME }, 'explicit-reopening'))).value;
    expect(reopened.release!.payload.terms.registration!.deadline).toBe(next.endsAt);
    expect(reopened.release!.payload.reconfirmationAccounts).toEqual([]);
  });

  it('derives immutable deadline-reconfirmation wallets only from the exact owner-held predecessor roster', async () => {
    const f = harness(); const next = structuredTerms(); next.registration!.deadline = NOW + 10_000;
    const result = unwrap(await f.repository.publishEvent(f.command('publish_event', { projectRoot: KEYS.project, terms: next, source: f.source,
      expectedHeads: [], lifetimeSeconds: LIFETIME, reconfirmationAccounts: [STRANGER] }, 'cannot-forge-carryover'))).value;
    expect(result.release!.payload.reconfirmationAccounts).toEqual([]);
    if (result.state.status !== 'unique') throw new Error('fixture');
    f.control.account = STRANGER;
    const first = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, result.release!))).value;
    f.control.account = COORDINATOR;
    const admitted = unwrap(await f.repository.replaceEvent(admissionCommand(f, result.state.entity, [admissionFor(first)], 'admit'))).value;
    while (f.rpc.timestamp < NOW + 10_000) { f.nextBlock(); f.saveSnapshot(); }
    const changed = unwrap(await f.repository.publishEvent(f.command('publish_event', { projectRoot: KEYS.project,
      terms: { ...next, description: 'Changed venue instructions' }, source: f.source, expectedHeads: [admitted.key], lifetimeSeconds: LIFETIME }, 'changed-after-deadline'))).value;
    expect(changed.release!.payload.reconfirmationAccounts).toEqual([STRANGER]);
    f.control.account = STRANGER;
    const current = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, changed.release!, [first.key as PublicEntityKey], 'going', 'late-reconfirmation'))).value;
    let event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: current }, event, f.rpc.timestamp)).toBe('pending');
    f.control.account = COORDINATOR;
    if (changed.state.status !== 'unique') throw new Error('fixture');
    unwrap(await f.repository.replaceEvent(admissionCommand(f, changed.state.entity, [admissionFor(current)], 'confirm-changed-release')));
    event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: current }, event, f.rpc.timestamp)).toBe('going');
  });
  it('supports withdrawal then rejoining before the owner releases the old reservation', async () => {
    const f = harness(); const { state, release } = await publishStructured(f); f.control.account = STRANGER;
    const first = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release))).value;
    f.control.account = COORDINATOR;
    const admitted = unwrap(await f.repository.replaceEvent(admissionCommand(f, state, [admissionFor(first)], 'admit'))).value;
    f.control.account = STRANGER;
    const withdrawal = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release, [first.key as PublicEntityKey], 'withdrawn', 'withdraw'))).value;
    const rejoined = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release, [withdrawal.key as PublicEntityKey], 'going', 'rejoin'))).value;
    let event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(event.roster?.diagnostics).toEqual([]);
    expect(attendanceStatus({ status: 'unique', entity: rejoined }, event, f.rpc.timestamp)).toBe('pending');
    expect(event.state.status === 'unique' && event.state.entity.payload.admissions).toEqual([admissionFor(first)]);
    f.control.account = COORDINATOR;
    unwrap(await f.repository.replaceEvent(admissionCommand(f, admitted, [admissionFor(rejoined)], 'confirm-rejoin')));
    event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: rejoined }, event, f.rpc.timestamp)).toBe('going');
  });
  it('records a request first, grants a place only with an explicit owner transition, and rejects duplicate going', async () => {
    const f = harness(); const { state, release } = await publishStructured(f); f.control.account = STRANGER;
    const request = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release)));
    let event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: request.value }, event, f.rpc.timestamp)).toBe('pending');
    const sends = f.control.sends;
    const duplicate = await f.repository.replaceAttendance(attendanceCommand(f, release, [request.value.key as PublicEntityKey], 'going', 'repeat-going'));
    expect(duplicate.ok).toBe(false); expect(f.control.sends).toBe(sends);
    f.control.account = COORDINATOR;
    const admitted = unwrap(await f.repository.replaceEvent(admissionCommand(f, state, [admissionFor(request.value)], 'admit')));
    expect(admitted.value.payload.admissions).toEqual([admissionFor(request.value)]);
    event = unwrap(await createEventRepository({ request: f.read, now: () => f.rpc.timestamp }).loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: request.value }, event, f.rpc.timestamp)).toBe('going');
  });

  it('requires explicit waiting-list consent and never promotes when another attendee withdraws', async () => {
    const f = harness(); const { state, release } = await publishStructured(f); f.control.account = STRANGER;
    const first = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release))).value;
    f.control.account = COORDINATOR;
    const admitted = unwrap(await f.repository.replaceEvent(admissionCommand(f, state, [admissionFor(first)], 'admit'))).value;
    f.control.account = PUBLISHER;
    const fields = { projectRoot: KEYS.project, releaseKey: release.key, audienceHash: release.payload.audienceHash, decision: 'going' as const,
      expectedHeads: [] as PublicEntityKey[], lifetimeSeconds: LIFETIME };
    const refused = await f.repository.replaceAttendance(f.command('replace_attendance', fields, 'not-waiting', PUBLISHER));
    expect(refused.ok).toBe(false);
    const waiting = unwrap(await f.repository.replaceAttendance(f.command('replace_attendance', { ...fields, joinWaitlist: true }, 'waiting', PUBLISHER))).value;
    let event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: waiting }, event, f.rpc.timestamp)).toBe('waitlisted');
    f.control.account = STRANGER;
    const withdrawal = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release, [first.key as PublicEntityKey], 'withdrawn', 'withdraw'))).value;
    event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: withdrawal }, event, f.rpc.timestamp)).toBe('withdrawn');
    expect(attendanceStatus({ status: 'unique', entity: waiting }, event, f.rpc.timestamp)).toBe('waitlisted');
    f.control.account = COORDINATOR;
    // One deliberate owner batch may release the old reservation and promote a verified waiter.
    unwrap(await f.repository.replaceEvent(admissionCommand(f, admitted, [admissionFor(waiting)], 'release-and-promote')));
    event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: waiting }, event, f.rpc.timestamp)).toBe('going');
  });

  it('rejects a request mined at or after the deadline despite an earlier signed payload time', async () => {
    const f = harness(); const next = structuredTerms(); next.registration!.deadline = NOW + 5_000;
    const { state, release } = await publishStructured(f, next); f.control.account = STRANGER;
    const request = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release))).value;
    expect(request.payload.createdAt).toBe(NOW); expect(f.rpc.timestamp).toBe(NOW + 6_000);
    const event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: request }, event, f.rpc.timestamp)).toBe('registration_closed');
    f.control.account = COORDINATOR; const sends = f.control.sends;
    const result = await f.repository.replaceEvent(admissionCommand(f, state, [admissionFor(request)], 'late-admit'));
    expect(result.ok).toBe(false); expect(f.control.sends).toBe(sends);
  });

  it('enforces public invitation eligibility before signing and requires owner admission for invited unlimited requests', async () => {
    const f = harness(); const next = structuredTerms(); next.registration = { ...next.registration!, capacity: { kind: 'unlimited' },
      waitlist: false, admission: 'invite_only', invitedAccounts: [STRANGER] };
    const { state, release } = await publishStructured(f, next); f.control.account = PUBLISHER;
    const fields = { projectRoot: KEYS.project, releaseKey: release.key, audienceHash: release.payload.audienceHash, decision: 'going' as const,
      expectedHeads: [], lifetimeSeconds: LIFETIME };
    const denied = await f.repository.replaceAttendance(f.command('replace_attendance', fields, 'uninvited', PUBLISHER));
    expect(denied.ok).toBe(false); expect(f.control.sends).toBe(2);
    f.control.account = STRANGER;
    const request = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release))).value;
    let event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: request }, event, f.rpc.timestamp)).toBe('pending');
    f.control.account = COORDINATOR; unwrap(await f.repository.replaceEvent(admissionCommand(f, state, [admissionFor(request)], 'invite-admit')));
    event = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: request }, event, f.rpc.timestamp)).toBe('going');
  });

  it('lets the owner release a missing reservation without any source or roster query, but cannot add one', async () => {
    const f = harness(); const { state, release } = await publishStructured(f); f.control.account = STRANGER;
    const request = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release))).value;
    f.control.account = COORDINATOR;
    const admitted = unwrap(await f.repository.replaceEvent(admissionCommand(f, state, [admissionFor(request)], 'admit'))).value;
    f.rpc.remove(request.key as PublicEntityKey); f.rpc.remove(KEYS.book); f.saveSnapshot();
    const broken = unwrap(await f.repository.loadEvent(KEYS.project)); expect(eventAvailability(broken, f.rpc.timestamp)).toBe('unverified');
    const released = unwrap(await f.repository.replaceEvent(admissionCommand(f, admitted, [], 'release-missing'))).value;
    expect(released.payload.admissions).toEqual([]);
    const sends = f.control.sends;
    const result = await f.repository.replaceEvent(admissionCommand(f, released, [admissionFor(request)], 'cannot-readmit'));
    expect(result.ok).toBe(false); expect(f.control.sends).toBe(sends);
  });

  it('rejects lower capacity before any publication write and carries reserved places across a material release', async () => {
    const f = harness(); const next = structuredTerms(); next.registration!.capacity = { kind: 'limited', limit: 2 };
    const { state, release } = await publishStructured(f, next); f.control.account = STRANGER;
    const first = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release))).value;
    f.control.account = PUBLISHER;
    const second = unwrap(await f.repository.replaceAttendance(f.command('replace_attendance', {
      projectRoot: KEYS.project, releaseKey: release.key, audienceHash: release.payload.audienceHash, decision: 'going' as const,
      expectedHeads: [], lifetimeSeconds: LIFETIME }, 'second-request', PUBLISHER))).value;
    f.control.account = COORDINATOR;
    const admitted = unwrap(await f.repository.replaceEvent(admissionCommand(f, state, [admissionFor(first), admissionFor(second)], 'admit-both'))).value;
    const reduced = structuredTerms(); const sends = f.control.sends;
    const bad = await f.repository.publishEvent(f.command('publish_event', { projectRoot: KEYS.project, terms: reduced, source: f.source,
      expectedHeads: [admitted.key], lifetimeSeconds: LIFETIME }, 'invalid-cap-reduction'));
    expect(bad.ok).toBe(false); expect(f.control.sends).toBe(sends);
    const freed = unwrap(await f.repository.replaceEvent(admissionCommand(f, admitted, [admissionFor(first)], 'release-one'))).value;
    const changed = unwrap(await f.repository.publishEvent(f.command('publish_event', { projectRoot: KEYS.project, terms: reduced, source: f.source,
      expectedHeads: [freed.key], lifetimeSeconds: LIFETIME }, 'valid-cap-reduction'))).value;
    expect(changed.state.status === 'unique' && changed.state.entity.payload.admissions).toEqual([admissionFor(first)]);
    expect(attendanceStatus({ status: 'unique', entity: first }, changed, f.rpc.timestamp, release)).toBe('needs_review');
    f.control.account = STRANGER;
    const reconfirmed = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, changed.release!, [first.key as PublicEntityKey], 'going', 'review-new-terms'))).value;
    const pending = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: reconfirmed }, pending, f.rpc.timestamp)).toBe('pending');
    f.control.account = COORDINATOR;
    if (changed.state.status !== 'unique') throw new Error('fixture');
    unwrap(await f.repository.replaceEvent(admissionCommand(f, changed.state.entity, [admissionFor(reconfirmed)], 'confirm-current-release')));
    const final = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(attendanceStatus({ status: 'unique', entity: reconfirmed }, final, f.rpc.timestamp)).toBe('going');
  });
});

describe('event publication and registration through the frozen native journal', () => {
  it('publishes independently readable immutable terms and an authored current state without changing the core source', async () => {
    const f = harness(); const result = await published(f);
    expect(f.control.sentTypes).toEqual([['event_release'], ['event_state']]);
    expect(eventAvailability(result.event, f.rpc.timestamp)).toBe('open');
    const independent = createEventRepository({ request: f.read, now: () => f.rpc.timestamp });
    const events = unwrap(await independent.listEvents());
    expect(events.items).toHaveLength(1); expect(events.items[0]!.release?.payload.terms).toEqual(terms);
    expect(f.rpc.row(KEYS.book)).toBeDefined(); expect(f.rpc.row(KEYS.activation)).toBeDefined();
    expect(f.store.list().every(step => step.step.status === 'confirmed')).toBe(true);
  });
  it('rejects another coordinator, mutated frozen terms, and insufficient lifetime before signing', async () => {
    const f = harness(STRANGER);
    expect(await f.repository.publishEvent(publish(f))).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    const own = harness(); const changed = publish(own); changed.terms.title = 'Silent change';
    expect(await own.repository.publishEvent(changed)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const { operation: _, ...fields } = publish(own);
    expect(await own.repository.publishEvent(own.command('publish_event', { ...fields, lifetimeSeconds: 86_400 })))
      .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.control.sends + own.control.sends).toBe(0);
  });
  it('keeps one own registration and withdraws atomically without changing anyone else', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    const joined = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release)));
    const independent = createEventRepository({ request: f.read, now: () => f.rpc.timestamp });
    const mine = unwrap(await independent.listMyEvents({ kind: 'wallet', address: STRANGER }));
    expect(mine.items).toHaveLength(1);
    const item = mine.items[0]!;
    expect(attendanceStatus(item.attendance, item.event!, f.rpc.timestamp, item.registeredRelease)).toBe('going');
    expect(unwrap(await independent.listMyEvents({ kind: 'wallet', address: COORDINATOR })).items).toHaveLength(0);
    const cancelled = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release, [joined.value.key as PublicEntityKey], 'withdrawn', 'withdraw')));
    expect(cancelled.value.payload.decision).toBe('withdrawn');
    expect(cancelled.receipt.consumedKeys).toEqual([joined.value.key]);
    expect(f.rpc.rows.filter(row => row.attributes.some(a => a.name === 'entity_type' && a.value === 'attendance_state'))).toHaveLength(1);
  });
  it('blocks a join if a contributor withdraws during unsigned preparation', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    f.control.afterEstimate = () => { f.book.decisions[0]!.status = 'withdrawn'; f.book.grants = []; f.rpc.update(KEYS.book, f.book); f.saveSnapshot(); };
    expect(await f.repository.replaceAttendance(attendanceCommand(f, release))).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(f.control.sends).toBe(2); expect(f.store.list().at(-1)?.admission).toBeNull();
  });
  it('requires confirmation of changed public terms and preserves the exact older release', async () => {
    const f = harness(); const first = await published(f); f.control.account = STRANGER;
    const joined = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, first.release)));
    f.control.account = COORDINATOR;
    const second = unwrap(await f.repository.publishEvent(f.command('publish_event', { projectRoot: KEYS.project,
      terms: { ...terms, venue: 'Community hall' }, source: f.source, expectedHeads: [first.state.key], lifetimeSeconds: LIFETIME }, 'new-terms')));
    const mine = unwrap(await f.repository.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(mine.registeredRelease?.key).toBe(first.release.key);
    expect(attendanceStatus(mine.attendance, mine.event!, f.rpc.timestamp, mine.registeredRelease)).toBe('needs_review');
    f.control.account = STRANGER;
    expect(await f.repository.replaceAttendance(attendanceCommand(f, first.release, [joined.value.key as PublicEntityKey], 'going', 'stale-join')))
      .toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(second.value.release?.payload.predecessorReleaseKey).toBe(first.release.key);
  });
  it('reconciles a lost send response with its original operation and never creates a second registration', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    f.control.loseResponseAt.add(3); const command = attendanceCommand(f, release);
    expect(await f.repository.replaceAttendance(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    const recovered = unwrap(await f.repository.reconcile(command.operation));
    expect(recovered.status).toBe('confirmed'); expect(f.control.sends).toBe(3);
    expect(unwrap(await f.repository.replaceAttendance(command)).value.payload.decision).toBe('going');
    expect(f.control.sends).toBe(3);
  });
  it('keeps an uncertain original action unresolved when its native journal disappears', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    const command = attendanceCommand(f, release); f.control.loseResponseAt.add(3);
    await f.repository.replaceAttendance(command);
    // The action envelope still holds its original intent, but the separate native journal is gone.
    const empty = createOperationController({ store: new MemoryOperationStore(), gateway: f.gateway, now: () => f.rpc.timestamp });
    const reopened = createEventRepository({ request: f.read, controller: empty, now: () => f.rpc.timestamp });
    expect(unwrap(await reopened.reconcile(command.operation))).toMatchObject({ status: 'unverified', error: { code: 'unverified' } });
    expect(f.control.sends).toBe(3);
  });
  it('durably attests rejected validation before all three event mutation entry points reach native preparation', async () => {
    const f = harness(); const first = await published(f);
    const publication = f.command('publish_event', { projectRoot: KEYS.project, terms, source: f.source,
      expectedHeads: [first.state.key], lifetimeSeconds: 1 }, 'invalid-publication');
    const replacement = f.command('replace_event', { projectRoot: KEYS.project, releaseKey: first.release.key,
      audienceHash: first.release.payload.audienceHash, source: f.source, status: 'closed' as const,
      expectedHeads: [first.state.key], lifetimeSeconds: 1 }, 'invalid-event-state');
    const attendance = f.command('replace_attendance', { projectRoot: KEYS.project, releaseKey: first.release.key,
      audienceHash: first.release.payload.audienceHash, decision: 'going' as const,
      expectedHeads: [], lifetimeSeconds: 1 }, 'invalid-attendance', STRANGER);
    const cases = [
      { operation: publication.operation, run: () => f.repository.publishEvent(publication) },
      { operation: replacement.operation, run: () => f.repository.replaceEvent(replacement) },
      { operation: attendance.operation, run: () => f.repository.replaceAttendance(attendance) },
    ];
    const restored = createEventRepository({ request: f.read,
      controller: createOperationController({ store: f.store, gateway: f.gateway, now: () => f.rpc.timestamp }), now: () => f.rpc.timestamp });
    for (const item of cases) {
      expect(await item.run()).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(f.controller.getOperation(item.operation.id)).toBeUndefined();
      expect(unwrap(await restored.reconcile(item.operation))).toMatchObject({ status: 'not_sent', evidence: 'preflight-journal' });
    }
    expect(f.control.sends).toBe(2);
  });
  it('retries the same operation only after its failed source read settles before native preparation', async () => {
    const f = harness(); const command = publish(f); let fail = true;
    const request: RpcRequest = async args => {
      if (fail && args.method === 'eth_chainId') { fail = false; throw new Error('The preflight RPC is unavailable.'); }
      return f.read(args);
    };
    const repository = createEventRepository({ request, controller: f.controller, now: () => f.rpc.timestamp });
    expect(await repository.publishEvent(command)).toMatchObject({ ok: false, error: { code: 'network' } });
    expect(f.store.list()).toEqual([]);
    expect(unwrap(await repository.reconcile(command.operation))).toMatchObject({ status: 'not_sent', evidence: 'preflight-journal' });
    expect(unwrap(await repository.publishEvent(command)).value.state.status).toBe('unique');
    expect(f.control.sentTypes).toEqual([['event_release'], ['event_state']]);
  });
  it('keeps an in-flight preflight attempt unresolved when reopened from the same durable store', async () => {
    const f = harness(); const command = publish(f); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const request: RpcRequest = async args => {
      if (args.method === 'eth_chainId') { enter(); await pending; throw new Error('The interrupted preflight has now failed.'); }
      return f.read(args);
    };
    const active = createEventRepository({ request, controller: f.controller, now: () => f.rpc.timestamp }).publishEvent(command);
    await entered;
    const restored = createEventRepository({ request: f.read,
      controller: createOperationController({ store: f.store, gateway: f.gateway, now: () => f.rpc.timestamp }), now: () => f.rpc.timestamp });
    expect(unwrap(await restored.reconcile(command.operation))).toMatchObject({ status: 'unverified' });
    expect(f.store.list()).toEqual([]); expect(f.control.sends).toBe(0);
    release(); expect((await active).ok).toBe(false);
    expect(unwrap(await restored.reconcile(command.operation))).toMatchObject({ status: 'not_sent', evidence: 'preflight-journal' });
  });
  it('keeps native preparation unknown when a preparation wrapper fails before the step record exists', async () => {
    const f = harness(); const command = publish(f);
    const capped = { ...f.controller, prepareStep: async () => { throw new Error('The preparation wrapper failed before its native checkpoint.'); } };
    const repository = createEventRepository({ request: f.read, controller: capped, now: () => f.rpc.timestamp });
    expect((await repository.publishEvent(command)).ok).toBe(false);
    expect(f.store.list()).toEqual([]); expect(f.control.sends).toBe(0);
    expect(unwrap(await repository.reconcile(command.operation))).toMatchObject({ status: 'unverified' });
    expect((await f.repository.publishEvent(command)).ok).toBe(false);
    expect(f.control.sends).toBe(0);
  });
  it('attests no send only from its actual persisted unadmitted step', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    const command = attendanceCommand(f, release);
    f.control.afterEstimate = () => { f.book.decisions[0]!.status = 'withdrawn'; f.book.grants = []; f.rpc.update(KEYS.book, f.book); f.saveSnapshot(); };
    expect(await f.repository.replaceAttendance(command)).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(unwrap(await f.repository.reconcile(command.operation))).toMatchObject({ status: 'not_sent', evidence: 'native-journal' });
    expect(f.control.sends).toBe(2);
  });
  it('retains definitive wallet rejection as no-send evidence', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    const command = attendanceCommand(f, release); f.control.failBeforeAt.set(3, { code: 4001, message: 'User rejected the request.' });
    expect(await f.repository.replaceAttendance(command)).toMatchObject({ ok: false, error: { code: 'rejected' } });
    expect(unwrap(await f.repository.reconcile(command.operation))).toMatchObject({ status: 'not_sent', evidence: 'native-journal' });
    expect(f.control.sentTypes).toHaveLength(2);
  });
  it('does not downgrade observed admission when only an earlier preparation checkpoint survives', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    const command = attendanceCommand(f, release); let earlier: StoredOperationStep | undefined;
    f.control.afterEstimate = () => { earlier = f.store.list().find(record => record.operation.id === command.operation.id); };
    f.control.loseResponseAt.add(3); await f.repository.replaceAttendance(command);
    const observed = f.controller.getOperation(command.operation.id)!;
    expect(observed.steps[0]?.status).toBe('unverified'); expect(earlier?.admission).toBeNull();
    const truncated = new MemoryOperationStore(); truncated.put(earlier!);
    const recoveredController = createOperationController({ store: truncated, gateway: f.gateway, now: () => f.rpc.timestamp });
    const reopened = createEventRepository({ request: f.read, controller: recoveredController, now: () => f.rpc.timestamp });
    expect(unwrap(await reopened.reconcile(observed))).toMatchObject({ status: 'unverified', error: { code: 'unverified' } });
    expect(f.control.sends).toBe(3);
  });
  it('rejects a foreign or altered mined transaction even when its SDK-shaped receipt reports success', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    f.control.loseResponseAt.add(3); const command = attendanceCommand(f, release);
    await f.repository.replaceAttendance(command);
    const transaction = f.transactions.get(entityKey(6003))!; transaction.from = COORDINATOR;
    expect(unwrap(await f.repository.reconcile(command.operation)).status).toBe('unverified');
    expect(f.control.sends).toBe(3);
  });
  it('fails closed on a second attendee head and preserves withdrawal when event references expire', async () => {
    const f = harness(); const { release } = await published(f); f.control.account = STRANGER;
    const first = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release)));
    f.rpc.put(rawEvent(entityKey(9999), first.value.payload, STRANGER)); f.saveSnapshot();
    expect(await f.repository.replaceAttendance(attendanceCommand(f, release, [first.value.key as PublicEntityKey], 'withdrawn', 'forked')))
      .toMatchObject({ ok: false, error: { code: 'conflict' } });
    f.rpc.remove(entityKey(9999)); f.rpc.remove(release.key as PublicEntityKey); f.saveSnapshot();
    const withdrawn = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, release, [first.value.key as PublicEntityKey], 'withdrawn', 'missing-ref')));
    expect(withdrawn.value.payload.decision).toBe('withdrawn');
  });
  it.each(['deleted', 'expired'] as const)('does not reset an event whose current state is %s while older authored releases remain', async fault => {
    const f = harness(); const first = await published(f);
    if (fault === 'deleted') f.rpc.remove(first.state.key as PublicEntityKey);
    else f.rpc.row(first.state.key as PublicEntityKey).expiresAt = toHex(f.rpc.block);
    f.saveSnapshot();
    expect(await f.repository.publishEvent(publish(f, 'reset-missing-state')))
      .toMatchObject({ ok: false, error: { code: 'unverified', reasons: [{ code: 'missing_state' }] } });
    expect(f.control.sends).toBe(2); expect(f.store.list()).toHaveLength(2);
    expect(unwrap(await f.repository.loadEvent(KEYS.project)).state.status).toBe('missing');
  });
  it('only resumes the confirmed first release through its original publication journal', async () => {
    const f = harness(); const command = publish(f); f.control.loseResponseAt.add(1);
    expect(await f.repository.publishEvent(command)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    expect(unwrap(await f.repository.reconcile(command.operation)).status).toBe('pending');
    expect(f.controller.getOperation(command.operation.id)?.steps[0]?.status).toBe('confirmed');
    expect(await f.repository.publishEvent(publish(f, 'replacement-publication')))
      .toMatchObject({ ok: false, error: { code: 'unverified', reasons: [{ code: 'missing_state' }] } });
    const result = unwrap(await f.repository.publishEvent(command));
    expect(result.value.state.status).toBe('unique'); expect(eventAvailability(result.value, f.rpc.timestamp)).toBe('open');
    expect(f.control.sentTypes).toEqual([['event_release'], ['event_state']]); expect(f.control.sends).toBe(2);
    expect(f.rpc.rows.filter(row => row.attributes.some(a => a.name === 'entity_type' && a.value === 'event_release'))).toHaveLength(1);
  });
  it('pauses after internal plan replacement and preserves the attendee decision when the coordinator binds repaired ready work', async () => {
    const f = harness(); const first = await published(f); f.control.account = STRANGER;
    const registration = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, first.release)));
    // A repaired core package gets a new proposal, activation and fresh contributor agreement.
    // The audience release keeps its original time, venue and terms.
    f.nextBlock(); const nextActivation = entityKey(12000), nextProposal = entityKey(12001), nextBook = entityKey(12002);
    const repairedPlan = { ...f.plan, predecessor: f.source, instructions: 'Host the same workshop with an updated internal checklist.' };
    const repairedHash = hashPlan(repairedPlan);
    const repairedSource = { ...f.source, activationKey: nextActivation, proposalKey: nextProposal, proposalHash: repairedHash };
    f.rpc.put(rawEntity(nextProposal, { ...f.proposal, plan: repairedPlan, proposalHash: repairedHash, operationId: 'repaired-proposal' }, COORDINATOR,
      { createdAt: toHex(f.rpc.block) }));
    f.rpc.remove(KEYS.activation);
    f.rpc.put(rawEntity(nextActivation, { ...f.activation, proposalKey: nextProposal, proposalHash: repairedHash,
      predecessorActivationKeys: [KEYS.activation], operationId: 'repaired-activation' }, COORDINATOR,
      { createdAt: toHex(f.rpc.block) }));
    f.book.decisions = [{ ...f.book.decisions[0]!, ...repairedSource, operationId: 'accept-repair', decidedAt: f.rpc.timestamp }];
    f.book.grants = [{ ...f.book.grants[0]!, ...repairedSource, operationId: 'accept-repair', acceptedAt: f.rpc.timestamp }];
    f.rpc.remove(KEYS.book); f.rpc.put(rawEntity(nextBook, { ...f.book, predecessorKeys: [KEYS.book] }, PUBLISHER,
      { createdAt: toHex(f.rpc.block) })); f.saveSnapshot();
    const paused = unwrap(await f.repository.loadEvent(KEYS.project));
    expect(eventAvailability(paused, f.rpc.timestamp)).toBe('paused');
    expect(await f.repository.replaceAttendance(attendanceCommand(f, first.release, [registration.value.key as PublicEntityKey], 'going', 'paused-rejoin')))
      .toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    f.control.account = COORDINATOR;
    const repaired = unwrap(await f.repository.replaceEvent(f.command('replace_event', {
      projectRoot: KEYS.project, releaseKey: first.release.key, audienceHash: first.release.payload.audienceHash,
      source: repairedSource, status: 'open' as const, expectedHeads: [first.state.key], lifetimeSeconds: LIFETIME,
    }, 'bind-repaired-source')));
    expect(repaired.receipt.consumedKeys).toEqual([first.state.key]);
    expect(repaired.value.payload.releaseKey).toBe(first.release.key);
    const independent = createEventRepository({ request: f.read, now: () => f.rpc.timestamp });
    const item = unwrap(await independent.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(eventAvailability(item.event!, f.rpc.timestamp)).toBe('open');
    expect(attendanceStatus(item.attendance, item.event!, f.rpc.timestamp, item.registeredRelease)).toBe('going');
    expect(item.attendance.status === 'unique' && item.attendance.entity.key).toBe(registration.value.key);
    expect(f.control.sentTypes.at(-1)).toEqual(['event_state']);
  });
  it('keeps cancellation visible to an independent attendee and never reopens a terminal event', async () => {
    const f = harness(); const first = await published(f); f.control.account = STRANGER;
    const registration = unwrap(await f.repository.replaceAttendance(attendanceCommand(f, first.release))); f.control.account = COORDINATOR;
    // Cancellation is allowed after a contributor withdraws; no current readiness is fabricated.
    f.book.decisions[0]!.status = 'withdrawn'; f.book.grants = []; f.rpc.update(KEYS.book, f.book); f.saveSnapshot();
    const cancellation = unwrap(await f.repository.replaceEvent(f.command('replace_event', {
      projectRoot: KEYS.project, releaseKey: first.release.key, audienceHash: first.release.payload.audienceHash, source: f.source,
      status: 'cancelled' as const, expectedHeads: [first.state.key], lifetimeSeconds: LIFETIME,
    }, 'cancel-event')));
    const independent = createEventRepository({ request: f.read, now: () => f.rpc.timestamp });
    const item = unwrap(await independent.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(eventAvailability(item.event!, f.rpc.timestamp)).toBe('cancelled');
    expect(attendanceStatus(item.attendance, item.event!, f.rpc.timestamp, item.registeredRelease)).toBe('cancelled');
    const original = f.control.sends;
    expect(await f.repository.replaceEvent(f.command('replace_event', { projectRoot: KEYS.project,
      releaseKey: first.release.key, audienceHash: first.release.payload.audienceHash, source: f.source, status: 'open' as const,
      expectedHeads: [cancellation.value.key], lifetimeSeconds: LIFETIME }, 'reopen-cancelled')))
      .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.control.sends).toBe(original);
    f.control.account = STRANGER;
    expect(unwrap(await f.repository.replaceAttendance(attendanceCommand(f, first.release,
      [registration.value.key as PublicEntityKey], 'withdrawn', 'withdraw-cancelled'))).value.payload.decision).toBe('withdrawn');
  });
  it('allows authenticated cancellation when source evidence is unavailable and still refuses reopening', async () => {
    const f = harness(); const first = await published(f); f.control.account = STRANGER;
    await f.repository.replaceAttendance(attendanceCommand(f, first.release)); f.control.account = COORDINATOR;
    f.rpc.remove(KEYS.publisher); f.saveSnapshot();
    const cancelled = unwrap(await f.repository.replaceEvent(f.command('replace_event', {
      projectRoot: KEYS.project, releaseKey: first.release.key, audienceHash: first.release.payload.audienceHash, source: f.source,
      status: 'cancelled' as const, expectedHeads: [first.state.key], lifetimeSeconds: LIFETIME,
    }, 'cancel-unavailable-source')));
    const independent = createEventRepository({ request: f.read, now: () => f.rpc.timestamp });
    const item = unwrap(await independent.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(eventAvailability(item.event!, f.rpc.timestamp)).toBe('cancelled');
    expect(attendanceStatus(item.attendance, item.event!, f.rpc.timestamp, item.registeredRelease)).toBe('cancelled');
    const sends = f.control.sends;
    expect((await f.repository.replaceEvent(f.command('replace_event', {
      projectRoot: KEYS.project, releaseKey: first.release.key, audienceHash: first.release.payload.audienceHash, source: f.source,
      status: 'open' as const, expectedHeads: [cancelled.value.key], lifetimeSeconds: LIFETIME,
    }, 'reopen-unavailable-source'))).ok).toBe(false);
    expect(f.control.sends).toBe(sends);
  });
  it.each(['closed', 'cancelled'] as const)('publishes %s through a fresh envelope read during contributor RPC failure', async status => {
    const f = harness(); const first = await published(f); let contributorQueries = 0;
    const request: RpcRequest = async args => {
      if (args.method === 'arkiv_query' && String((args.params as unknown[])[0]).includes("entity_type = str('book_state')")) {
        contributorQueries++; throw new Error('The contributor RPC is unavailable.');
      }
      return f.read(args);
    };
    const repository = createEventRepository({ request, controller: f.controller, now: () => f.rpc.timestamp });
    const envelope = unwrap(await repository.loadEvent(KEYS.project, { includeSource: false }));
    expect(envelope.state.status).toBe('unique'); expect(envelope.release?.key).toBe(first.release.key);
    const result = unwrap(await repository.replaceEvent(f.command('replace_event', {
      projectRoot: KEYS.project, releaseKey: first.release.key, audienceHash: first.release.payload.audienceHash, source: f.source,
      status, expectedHeads: [first.state.key], lifetimeSeconds: LIFETIME,
    }, `source-rpc-${status}`)));
    expect(result.value.payload.status).toBe(status); expect(contributorQueries).toBe(0);
    expect(f.control.sentTypes.at(-1)).toEqual(['event_state']);
  });
  it('closes registration independently from cancellation and rejects premature or elapsed-end joins', async () => {
    const f = harness(); const first = await published(f);
    const fields = { projectRoot: KEYS.project, releaseKey: first.release.key, audienceHash: first.release.payload.audienceHash,
      source: f.source, expectedHeads: [first.state.key], lifetimeSeconds: LIFETIME };
    expect(await f.repository.replaceEvent(f.command('replace_event', { ...fields, status: 'ended' as const }, 'premature-end')))
      .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const closed = unwrap(await f.repository.replaceEvent(f.command('replace_event', { ...fields, status: 'closed' as const }, 'close-registration')));
    f.control.account = STRANGER;
    expect(await f.repository.replaceAttendance(attendanceCommand(f, first.release)))
      .toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    f.control.account = COORDINATOR;
    const reopened = unwrap(await f.repository.replaceEvent(f.command('replace_event', { ...fields,
      expectedHeads: [closed.value.key], status: 'open' as const }, 'reopen-registration')));
    expect(reopened.value.payload.status).toBe('open');
    // Advance the synthetic ledger to the scheduled end, keeping its current block fresh.
    f.rpc.timestamp = terms.endsAt; f.nextBlock(); f.saveSnapshot();
    expect(eventAvailability(unwrap(await f.repository.loadEvent(KEYS.project)), f.rpc.timestamp)).toBe('ended');
    f.control.account = STRANGER;
    expect(await f.repository.replaceAttendance(attendanceCommand(f, first.release, [], 'going', 'late-join')))
      .toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    f.control.account = COORDINATOR;
    const ended = unwrap(await f.repository.replaceEvent(f.command('replace_event', { ...fields,
      expectedHeads: [reopened.value.key], status: 'ended' as const }, 'record-end')));
    expect(ended.value.payload.status).toBe('ended');
  });
});


