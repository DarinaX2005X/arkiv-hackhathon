import { describe, expect, it } from 'vitest';
import { createRepositoryActionController, validRepositoryActionRecord } from '../../app/actions';
import type { AppSession } from '../../app/session';
import { createDraftStore, type StoragePort } from '../../app/storage';
import { createArkivRepository } from '../../data/arkiv';
import { createOperationIntent } from '../../data/operations';
import { COORDINATOR, KEYS, NOW, STRANGER, entityKey, readyFixture } from '../../data/__tests__/arkiv-fixture';
import type { EventReadOptions, EventRepositoryContract } from '../../data/events/types';
import type { OperationIntent } from '../../data/types';
import { attendanceStatus, audienceHash, deriveEventAvailability, EVENTS_PROTOCOL, type AttendanceState, type EventAggregate, type EventRelease, type EventRecord } from '../../domain/events';
import type { Actor, EntityProvenance } from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { readEventForActor, readEventForWithdrawal, type EventRead } from '../events/hooks';
import { catalogueFilters } from '../events/presentation';
import { joinTargetStore, prepareRegistration, prepareWithdrawal, registrationLifetime, targetForEvent, targetForWithdrawal } from './intent';
import { matchesMyEventFilter, myEventStatus } from './MyEvents';

const account = { kind: 'wallet' as const, address: STRANGER };
const session: AppSession = { mode: 'public', actor: account, chainId: TIRAMISU_CHAIN_ID, activeDraftId: null, destination: '/events', storageIssue: null };
const memoryStorage = (): StoragePort => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
};
async function fixture() {
  const { rpc, source } = readyFixture();
  const project = await createArkivRepository({ request: rpc.request, now: () => NOW }).loadProject(KEYS.project);
  if (!project.ok) throw new Error('Invalid core fixture');
  const provenance: EntityProvenance = { mode: 'public', creator: { kind: 'wallet', address: COORDINATOR }, owner: { kind: 'wallet', address: COORDINATOR }, readonly: true,
    contentType: 'application/json', permissionlessExtension: false, createdAtBlock: '95', expiresAtBlock: '10000', transactionHash: entityKey(100) };
  const base = { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, operationId: 'ui-fixture', createdAt: NOW - 1000 };
  const terms = { title: 'An open workshop', description: 'Make things together.', startsAt: NOW + 3_600_000, endsAt: NOW + 7_200_000,
    timeZone: 'UTC', venue: 'Library hall', instructions: 'Use the front entrance.', conditions: 'Free open event.' };
  const release: EventRecord<EventRelease> = { key: entityKey(101), provenance, payload: { ...base, entityType: 'event_release',
    projectRoot: KEYS.project, terms, audienceHash: audienceHash(terms), predecessorReleaseKey: null, source } };
  const event: EventAggregate = { projectRoot: KEYS.project, root: project.value.root, sourceProject: project.value, release, snapshot: project.value.snapshot, diagnostics: [],
    state: { status: 'unique', entity: { key: entityKey(102), provenance, payload: { ...base, entityType: 'event_state', projectRoot: KEYS.project,
      releaseKey: release.key, audienceHash: release.payload.audienceHash, source, status: 'open', predecessorKeys: [], startsAt: terms.startsAt, endsAt: terms.endsAt } } } };
  const read: EventRead = { event, actor: account, myEvent: null, attendance: { status: 'missing', reason: 'not_initialized' } };
  return { event, read, target: targetForEvent(read, session, NOW)! };
}

function register(read: EventRead) {
  const release = read.event.release!;
  const entity: EventRecord<AttendanceState> = { key: entityKey(103), provenance: { ...release.provenance, creator: account, owner: account }, payload: {
    protocol: EVENTS_PROTOCOL, schemaVersion: 1, operationId: 'registered', createdAt: NOW - 1000, entityType: 'attendance_state',
    projectRoot: KEYS.project, releaseKey: release.key, audienceHash: release.payload.audienceHash, attendee: STRANGER, decision: 'going', predecessorKeys: [],
  } };
  read.attendance = { status: 'unique', entity };
  read.myEvent = { projectRoot: KEYS.project, attendance: read.attendance, event: read.event, registeredRelease: structuredClone(release), diagnostics: [] };
  return entity;
}

describe('visitor registration review boundaries', () => {
  it('prepares one explicit current-wallet operation with the reviewed release and a bounded retention', async () => {
    const { event, read, target } = await fixture();
    expect(deriveEventAvailability(event, NOW)).toBe('open');
    const prepared = prepareRegistration(read, target, session, NOW);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.command.releaseKey).toBe(event.release!.key);
    expect(prepared.command.expectedHeads).toEqual([]);
    expect(prepared.command.operation.authority.actor).toEqual(account);
    expect(prepared.command.operation.phase).toBe('prepared');
    expect(prepared.command.operation.transactionHash).toBeNull();
    expect(prepared.command.lifetimeSeconds).toBe(90 * 86_400);
  });
  it('preserves the selected release through sign-in without storing wallet consent', async () => {
    const { read } = await fixture();
    const store = joinTargetStore(memoryStorage(), KEYS.project);
    const target = targetForEvent(read, { ...session, actor: null, chainId: null }, NOW)!;
    expect(store.save(target).persisted).toBe(true);
    const restored = store.load();
    expect(restored.status).toBe('ready');
    if (restored.status !== 'ready') return;
    expect(restored.value.attendee).toBeNull();
    expect(restored.value.releaseKey).toBe(read.event.release!.key);
    expect(prepareRegistration(read, restored.value, session, NOW).ok).toBe(false);
  });
  it('blocks a changed wallet, wrong chain and another release even with identical audience terms', async () => {
    const { read, target } = await fixture();
    expect(prepareRegistration(read, target, { ...session, actor: { kind: 'wallet', address: COORDINATOR } }, NOW).ok).toBe(false);
    expect(prepareRegistration(read, target, { ...session, chainId: 1 }, NOW).ok).toBe(false);
    read.event.release!.key = entityKey(999);
    expect(prepareRegistration(read, target, session, NOW)).toEqual({ ok: false, message: 'The event details changed. Review the current time, place and participation conditions before confirming.' });
  });
  it('blocks a stale read and an ambiguous personal registration before preparing a send', async () => {
    const { read, target } = await fixture();
    expect(prepareRegistration(read, target, session, NOW + 60_001).ok).toBe(false);
    read.attendance = { status: 'conflict', entities: [] };
    expect(prepareRegistration(read, target, session, NOW).ok).toBe(false);
  });
  it('uses the public-read snapshot for the personal read and fails closed on a mismatched response', async () => {
    const { event } = await fixture();
    let observed: unknown;
    const repository = { loadEvent: async () => ({ ok: true, value: event }), listMyEvents: async (_actor: Actor, options: unknown) => {
      observed = options; return { ok: true, value: { items: [], snapshot: { ...event.snapshot, blockHash: entityKey(999) }, diagnostics: [] } };
    } } as unknown as EventRepositoryContract;
    const read = await readEventForActor(repository, KEYS.project, account);
    expect(observed).toEqual({ snapshot: event.snapshot, signal: undefined });
    expect(read.ok && read.value.attendance?.status).toBe('unverified');
  });
  it('keeps the selected intent but performs no private read for a public visitor', async () => {
    const { event } = await fixture(); let personalReads = 0;
    const repository = { loadEvent: async () => ({ ok: true, value: event }), listMyEvents: async () => { personalReads++; throw new Error('must not read'); } } as unknown as EventRepositoryContract;
    const read = await readEventForActor(repository, KEYS.project, null);
    expect(read.ok && read.value.attendance).toBeNull(); expect(personalReads).toBe(0);
  });
});

describe('event request persistence with the shared action controller', () => {
  it('validates event operations and retains the original unknown-send operation across reopening', async () => {
    const { read, target } = await fixture(); const prepared = prepareRegistration(read, target, session, NOW);
    if (!prepared.ok) throw new Error(prepared.message);
    const storage = memoryStorage();
    const store = createDraftStore({ storage, key: 'action', kind: 'repository-action', validate: validRepositoryActionRecord });
    let writes = 0; let reconciled: OperationIntent | null = null;
    const repository = { mode: 'public', reconcile: async (operation: OperationIntent) => {
      reconciled = operation; return { ok: true, value: { status: 'pending', operation } };
    } } as unknown as EventRepositoryContract;
    let actor: Actor | null = account;
    const action = createRepositoryActionController({ repository, store, getActor: () => actor });
    await action.run(prepared.command, async () => { writes++; throw new Error('Lost response'); });
    const reopened = createRepositoryActionController({ repository, store, getActor: () => actor });
    expect(reopened.getSnapshot().status).toBe('needs-verification');
    expect(reopened.getSnapshot().operation?.id).toBe(prepared.command.operation.id);
    await reopened.run(prepared.command, async () => { writes++; throw new Error('must not run'); });
    await reopened.reconcile();
    expect(reconciled).toEqual(prepared.command.operation);
    expect(writes).toBe(1);
    actor = { kind: 'wallet', address: COORDINATOR };
    await reopened.resume(async () => { writes++; throw new Error('must not run'); });
    expect(writes).toBe(1); expect(reopened.clear()).toBe(false);
  });
  it('does not ask the repository to send when request persistence is unavailable', async () => {
    const { read, target } = await fixture(); const prepared = prepareRegistration(read, target, session, NOW);
    if (!prepared.ok) throw new Error(prepared.message);
    let writes = 0;
    const repository = { mode: 'public' } as EventRepositoryContract;
    const store = createDraftStore({ storage: null, key: 'action', kind: 'repository-action', validate: validRepositoryActionRecord });
    const action = createRepositoryActionController({ repository, store, getActor: () => account });
    await action.run(prepared.command, async () => { writes++; throw new Error('must not run'); });
    expect(writes).toBe(0); expect(action.getSnapshot().error?.code).toBe('storage');
  });
  it('checks hashes on every event kind rather than merely recognizing its name', () => {
    for (const kind of ['publish_event', 'replace_event', 'replace_attendance'] as const) {
      const input = { lifetimeSeconds: 3600, expectedHeads: [] };
      const operation = createOperationIntent(kind, { mode: 'public', actor: account, chainId: TIRAMISU_CHAIN_ID }, input);
      const record = { status: 'needs-verification', command: { ...input, operation }, operation };
      expect(validRepositoryActionRecord(record)).toBe(true);
      expect(validRepositoryActionRecord({ ...record, command: { ...record.command, lifetimeSeconds: 3602 } })).toBe(false);
    }
  });
});

describe('event date and retention boundaries', () => {
  it('filters the whole calendar day through DST in the displayed zone', () => {
    const result = catalogueFilters(' Workshop ', '2026-03-08', '2026-03-08', 'America/New_York');
    expect(result).toEqual({ ok: true, filters: { search: 'Workshop', from: Date.parse('2026-03-08T05:00:00Z'), to: Date.parse('2026-03-09T04:00:00Z') - 1 } });
    expect(catalogueFilters('', '2026-11-02', '2026-11-01', 'UTC').ok).toBe(false);
  });
  it('covers a future event and the return period in even seconds', () => {
    const end = NOW + 120 * 86_400_000 + 333;
    const seconds = registrationLifetime(end, NOW);
    expect(seconds % 2).toBe(0); expect(seconds * 1000).toBeGreaterThanOrEqual(end + 30 * 86_400_000 - NOW);
  });
});

describe('returning attendee decisions', () => {
  it('requires a new explicit operation for another release even when its visible terms are identical', async () => {
    const { read } = await fixture(); const registration = register(read);
    const previousKey = read.event.release!.key;
    read.event.release = { ...structuredClone(read.event.release!), key: entityKey(104), payload: { ...read.event.release!.payload, predecessorReleaseKey: previousKey } };
    if (read.event.state.status !== 'unique') throw new Error('fixture');
    read.event.state.entity.payload.releaseKey = read.event.release.key;
    expect(myEventStatus(read.myEvent!, NOW)).toBe('needs_review');
    const target = targetForEvent(read, session, NOW)!;
    const prepared = prepareRegistration(read, target, session, NOW);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.command.expectedHeads).toEqual([registration.key]);
    expect(prepared.command.releaseKey).toBe(entityKey(104));
    expect(read.myEvent!.registeredRelease?.key).toBe(previousKey);
    expect(registration.payload.releaseKey).toBe(previousKey);
  });
  it('allows the owner to withdraw an authenticated current registration even when event references disappeared', async () => {
    const { read } = await fixture(); const registration = register(read);
    const target = targetForWithdrawal(read, session, NOW)!;
    read.event.root = null; read.event.release = null; read.event.sourceProject = null; read.event.diagnostics = [{ code: 'missing_root' }];
    read.myEvent!.registeredRelease = null;
    const prepared = prepareWithdrawal(read, target, session, NOW);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.command.decision).toBe('withdrawn');
    expect(prepared.command.releaseKey).toBe(registration.payload.releaseKey);
    expect(prepared.command.audienceHash).toBe(registration.payload.audienceHash);
    expect(prepared.command.expectedHeads).toEqual([registration.key]);
  });
  it('reads and confirms an own withdrawal without contributor availability while new registration stays blocked', async () => {
    const { read, target } = await fixture(); const registration = register(read);
    const withdrawal = targetForWithdrawal(read, session, NOW)!;
    read.event.sourceProject = null;
    const ownReads: EventReadOptions[] = [];
    const repository = {
      loadEvent: async (_root: unknown, options?: EventReadOptions) => options?.includeSource === false
        ? { ok: true, value: read.event }
        : { ok: false, error: { code: 'network', reasons: [], retryable: true } },
      listMyEvents: async (_actor: Actor, options?: EventReadOptions) => {
        ownReads.push(options ?? {});
        if (options?.includeSource !== false) throw new Error('Contributor RPC is unavailable');
        return { ok: true, value: { items: [read.myEvent], snapshot: read.event.snapshot, diagnostics: [] } };
      },
    } as unknown as EventRepositoryContract;
    expect((await readEventForActor(repository, KEYS.project, account)).ok).toBe(false);
    const fresh = await readEventForWithdrawal(repository, KEYS.project, account);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(ownReads[0]).toEqual({ snapshot: read.event.snapshot, signal: undefined, includeSource: false });
    expect(prepareWithdrawal(fresh.value, withdrawal, session, NOW).ok).toBe(true);
    expect(prepareRegistration(fresh.value, target, session, NOW).ok).toBe(false);
    expect(deriveEventAvailability(fresh.value.event, NOW)).toBe('unverified');
    registration.payload.decision = 'withdrawn';
    const verified = await readEventForWithdrawal(repository, KEYS.project, account);
    expect(verified.ok && attendanceStatus(verified.value.attendance!, verified.value.event, NOW)).toBe('withdrawn');
  });
  it('blocks a withdrawal after the wallet, current predecessor or registration evidence changes', async () => {
    const { read } = await fixture(); const registration = register(read); const target = targetForWithdrawal(read, session, NOW)!;
    expect(prepareWithdrawal(read, target, { ...session, actor: { kind: 'wallet', address: COORDINATOR } }, NOW).ok).toBe(false);
    registration.key = entityKey(105);
    expect(prepareWithdrawal(read, target, session, NOW).ok).toBe(false);
    registration.key = target.attendanceKey; registration.provenance.expiresAtBlock = '99';
    expect(prepareWithdrawal(read, target, session, NOW).ok).toBe(false);
  });
  it('keeps unavailable, cancelled, ended and withdrawn outcomes distinct in My events', async () => {
    const { read } = await fixture(); const registration = register(read); const item = read.myEvent!;
    expect(myEventStatus(item, NOW)).toBe('going');
    if (read.event.state.status !== 'unique') throw new Error('fixture');
    read.event.state.entity.payload.status = 'cancelled';
    expect(myEventStatus(item, NOW)).toBe('cancelled'); expect(registration.payload.decision).toBe('going');
    read.event.state.entity.payload.status = 'ended';
    expect(myEventStatus(item, NOW)).toBe('ended'); expect(registration.payload.decision).toBe('going');
    read.event.release = null;
    expect(myEventStatus(item, NOW)).toBe('unverified'); expect(matchesMyEventFilter('unverified', 'all')).toBe(true);
    registration.payload.decision = 'withdrawn';
    expect(myEventStatus(item, NOW)).toBe('withdrawn');
    expect(matchesMyEventFilter('withdrawn', 'past')).toBe(true); expect(matchesMyEventFilter('withdrawn', 'upcoming')).toBe(false);
  });
  it('retains the authentic own scope when only linked event evidence is missing', async () => {
    const { read, event } = await fixture(); register(read); read.myEvent!.diagnostics = [{ code: 'missing_root' }];
    const repository = { loadEvent: async () => ({ ok: true, value: event }), listMyEvents: async () => ({ ok: true, value: {
      items: [read.myEvent], snapshot: event.snapshot, diagnostics: [],
    } }) } as unknown as EventRepositoryContract;
    const refreshed = await readEventForActor(repository, KEYS.project, account);
    expect(refreshed.ok && refreshed.value.attendance?.status).toBe('unique');
  });
  it('does not confuse isolated rejected discovery records with an incomplete chosen-event read', async () => {
    const { read, event } = await fixture(); register(read);
    const repository = { loadEvent: async () => ({ ok: true, value: event }), listMyEvents: async () => ({ ok: true, value: {
      items: [read.myEvent], snapshot: event.snapshot, diagnostics: [{ code: 'projection_mismatch' }],
    } }) } as unknown as EventRepositoryContract;
    const refreshed = await readEventForActor(repository, KEYS.project, account);
    expect(refreshed.ok && refreshed.value.attendance?.status).toBe('unique');
    expect(refreshed.ok && myEventStatus(refreshed.value.myEvent!, NOW)).toBe('going');
  });
});
