import { prepareAdmissionReview, validateAdmissionReview } from './admission';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositoryActionController, validRepositoryActionRecord } from '../../../app/actions';
import type { AppSession } from '../../../app/session';
import { createDraftStore, type StoragePort } from '../../../app/storage';
import { createArkivRepository } from '../../../data/arkiv';
import { COORDINATOR, KEYS, NOW, STRANGER, entityKey, readyFixture } from '../../../data/__tests__/arkiv-fixture';
import type { EventRepositoryContract } from '../../../data/events/types';
import { createOperationIntent } from '../../../data/operations';
import type { OperationIntent } from '../../../data/types';
import { audienceHash, EVENTS_PROTOCOL, type EventAggregate, type EventRecord, type EventRelease } from '../../../domain/events';
import { TIRAMISU_CHAIN_ID, type Actor, type EntityProvenance, type PublicEntityKey } from '../../../domain/types';
import { confirmPublishingReview, draftAfterPublication, emptyPublishingFields, preparePublishingReview, publishingDraftMemory, publishingDraftStore,
  publishingFields, publishingLifetime, publishingPreparations, reviewOriginalCommand, termsFromFields, validatePublishingReview, validPublishingCommand,
  type PublishingCommand, type PublishingDraft, type PublishingReview } from './model';
const actor = { kind: 'wallet' as const, address: COORDINATOR };
const session: AppSession = { mode: 'public', actor, chainId: TIRAMISU_CHAIN_ID, activeDraftId: null, destination: '/projects', storageIssue: null };
function memoryStorage(): StoragePort {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
async function fixture() {
  const { rpc, source } = readyFixture();
  const project = await createArkivRepository({ request: rpc.request, now: () => NOW }).loadProject(KEYS.project);
  if (!project.ok) throw new Error('Invalid core fixture');
  const provenance: EntityProvenance = { mode: 'public', creator: actor, owner: actor, readonly: true,
    contentType: 'application/json', permissionlessExtension: false, createdAtBlock: '95', expiresAtBlock: '10000', transactionHash: entityKey(100) };
  const base = { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, operationId: 'publisher-fixture', createdAt: NOW - 1000 };
  const terms = { title: 'An open workshop', description: 'Make things together.', startsAt: NOW + 3_600_123, endsAt: NOW + 7_200_456,
    timeZone: 'UTC', venue: 'Library hall', instructions: 'Use the front entrance.', conditions: 'Free open event.' };
  const release: EventRecord<EventRelease> = { key: entityKey(101), provenance, payload: { ...base, entityType: 'event_release',
    projectRoot: KEYS.project, terms, audienceHash: audienceHash(terms), predecessorReleaseKey: null, source } };
  const event: EventAggregate = { projectRoot: KEYS.project, root: project.value.root, sourceProject: project.value, release, snapshot: project.value.snapshot, diagnostics: [],
    state: { status: 'unique', entity: { key: entityKey(102), provenance, payload: { ...base, entityType: 'event_state', projectRoot: KEYS.project,
      releaseKey: release.key, audienceHash: release.payload.audienceHash, source, status: 'open', predecessorKeys: [], startsAt: terms.startsAt, endsAt: terms.endsAt } } } };
  const draft: PublishingDraft = { projectRoot: KEYS.project, organizer: COORDINATOR, baselineReleaseKey: release.key as PublicEntityKey,
    fields: { ...publishingFields(terms), title: 'The spring workshop' } };
  return { event, draft, terms, source };
}
function mustReview(result: ReturnType<typeof preparePublishingReview>): PublishingReview {
  if (!result.ok) throw new Error(result.message); return result.review;
}
afterEach(() => { vi.useRealTimers(); });
describe('organizer publication review', () => {
  it('binds changed visitor terms to the exact current event and agreed source', async () => {
    const { event, draft, source } = await fixture();
    const review = mustReview(preparePublishingReview(event, session, 'publish', draft, NOW));
    expect(review.changed).toEqual(['title']);
    expect(review.command.operation.kind).toBe('publish_event');
    expect(review.command.expectedHeads).toEqual([entityKey(102)]);
    expect(review.command.source).toEqual(source);
    expect(review.command.operation.authority.actor).toEqual(actor);
    expect(validPublishingCommand(review.command)).toBe(true);
    expect(validatePublishingReview(review, event, session, NOW)).toBeNull();
  });
  it('summarizes the selected immutable preparation plan without substituting guest details or draft edits', async () => {
    const { event, draft, source } = await fixture();
    const selected = event.sourceProject!.proposal!.payload.plan.variant;
    if (event.sourceProject!.state.status !== 'unique') throw Error('fixture');
    event.sourceProject!.state.entity.payload.recipe.variants[0]!.venueId = 'Unagreed draft location';
    const summary = publishingPreparations(event, source, NOW);
    expect(summary).toEqual({ title: selected.title, placeReference: selected.venueId, timeZone: selected.timeZone,
      requirements: selected.requirements.map(item => ({ id: item.id, title: item.title, start: item.interval.start, end: item.interval.end })) });
    expect(summary!.placeReference).not.toBe('Unagreed draft location');
    // Preparation intervals need not equal organizer-authored guest times.
    draft.fields.startsLocal = '2030-03-20T18:00'; draft.fields.endsLocal = '2030-03-20T20:00';
    expect(publishingPreparations(event, source, NOW)).toEqual(summary);
  });
  it('does not show another or stale preparation plan beside an earlier publication review', async () => {
    const { event, source } = await fixture();
    expect(publishingPreparations(event, { ...source, proposalKey: entityKey(888) }, NOW)).toBeNull();
    expect(publishingPreparations(event, { ...source, proposalHash: entityKey(889) }, NOW)).toBeNull();
    expect(publishingPreparations(event, source, NOW + 60001)).toBeNull();
    event.sourceProject!.proposal!.key = entityKey(890);
    expect(publishingPreparations(event, source, NOW)).toBeNull();
  });
  it('prepares a first publication from ready project evidence without claiming missing history is new', async () => {
    const { event, draft } = await fixture();
    event.state = { status: 'missing', reason: 'expired_or_deleted' }; event.release = null; event.diagnostics = [{ code: 'missing_state' }];
    draft.baselineReleaseKey = null;
    const review = mustReview(preparePublishingReview(event, session, 'publish', draft, NOW));
    expect(review.command.expectedHeads).toEqual([]);
    expect(review.previous).toBeNull();
    // Writer initialPublication remains responsible for the complete authored release walk before a signature.
    expect(review.command.operation.transactionHash).toBeNull();
  });
  it('rejects wrong wallet, wrong chain, changed creator and stale snapshot before a command', async () => {
    const { event, draft } = await fixture();
    expect(preparePublishingReview(event, { ...session, actor: { kind: 'wallet', address: STRANGER } }, 'publish', draft, NOW).ok).toBe(false);
    expect(preparePublishingReview(event, { ...session, chainId: 1 }, 'publish', draft, NOW).ok).toBe(false);
    expect(preparePublishingReview(event, session, 'publish', draft, NOW + 60_001).ok).toBe(false);
    event.root!.provenance.creator = { kind: 'wallet', address: STRANGER };
    expect(preparePublishingReview(event, session, 'publish', draft, NOW).ok).toBe(false);
  });
  it('does not open registration with missing, stale or mismatched plan evidence', async () => {
    const { event, draft } = await fixture();
    event.sourceProject!.publishers[0]!.book = { status: 'missing', reason: 'expired_or_deleted' };
    expect(preparePublishingReview(event, session, 'publish', draft, NOW).ok).toBe(false);
    event.sourceProject = null;
    expect(preparePublishingReview(event, session, 'publish', draft, NOW).ok).toBe(false);
    const fresh = await fixture(); fresh.event.sourceProject!.snapshot = { ...fresh.event.snapshot, blockHash: entityKey(999) };
    expect(preparePublishingReview(fresh.event, session, 'publish', fresh.draft, NOW).ok).toBe(false);
  });
  it('blocks a changed release baseline even if its visitor terms are identical', async () => {
    const { event, draft } = await fixture();
    event.release!.key = entityKey(201);
    if (event.state.status !== 'unique') throw new Error('fixture');
    event.state.entity.payload.releaseKey = event.release!.key;
    expect(preparePublishingReview(event, session, 'publish', draft, NOW)).toMatchObject({ ok: false, message: expect.stringContaining('published event changed') });
  });
  it('does not publish another release for unchanged audience terms', async () => {
    const { event, draft, terms } = await fixture(); draft.fields = publishingFields(terms);
    expect(preparePublishingReview(event, session, 'publish', draft, NOW)).toMatchObject({ ok: false, message: expect.stringContaining('have not changed') });
  });
  it('uses a new ready source for internal repair while retaining the exact audience release', async () => {
    const { event, draft, source } = await fixture();
    if (event.state.status !== 'unique') throw new Error('fixture');
    event.state.entity.payload.source = { ...source, activationKey: entityKey(500) };
    const review = mustReview(preparePublishingReview(event, session, 'repair', draft, NOW));
    expect(review.command).toMatchObject({ releaseKey: event.release!.key, audienceHash: event.release!.payload.audienceHash, source, status: 'open' });
    expect('terms' in review.command).toBe(false); expect(review.changed).toEqual([]);
    expect(review.command.operation.kind).toBe('replace_event');
  });
  it('builds close and cancel only from the authenticated current event, preserving a broken draft', async () => {
    const { event, draft, source } = await fixture();
    event.sourceProject = null; event.diagnostics = [{ code: 'missing_offer' }];
    draft.fields.startsLocal = 'unfinished'; draft.fields.title = '';
    const before = structuredClone(draft);
    for (const kind of ['close', 'cancel'] as const) {
      const review = mustReview(preparePublishingReview(event, session, kind, draft, NOW));
      expect(review.command.source).toEqual(source);
      expect(review.command).toMatchObject({ releaseKey: event.release!.key, status: kind === 'close' ? 'closed' : 'cancelled' });
      expect(validatePublishingReview(review, event, session, NOW)).toBeNull();
    }
    expect(draft).toEqual(before);
  });
  it('requires the chain-observed end and never reopens cancelled or ended events', async () => {
    const { event, draft, terms } = await fixture();
    expect(preparePublishingReview(event, session, 'end', draft, NOW).ok).toBe(false);
    event.snapshot = { ...event.snapshot, fetchedAt: terms.endsAt, blockTimestamp: terms.endsAt - 1 };
    expect(preparePublishingReview(event, session, 'end', draft, terms.endsAt).ok).toBe(false);
    event.snapshot.blockTimestamp = terms.endsAt;
    expect(preparePublishingReview(event, session, 'end', draft, terms.endsAt).ok).toBe(true);
    if (event.state.status !== 'unique') throw new Error('fixture');
    for (const status of ['cancelled', 'ended'] as const) {
      event.state.entity.payload.status = status;
      expect(preparePublishingReview(event, session, 'repair', draft, terms.endsAt).ok).toBe(false);
      expect(preparePublishingReview(event, session, 'publish', draft, terms.endsAt).ok).toBe(false);
    }
  });
  it('rejects frozen reviews when a head, account or plan changes before confirmation', async () => {
    const { event, draft } = await fixture(); const review = mustReview(preparePublishingReview(event, session, 'publish', draft, NOW));
    expect(validatePublishingReview(review, event, { ...session, actor: { kind: 'wallet', address: STRANGER } }, NOW)).not.toBeNull();
    if (event.state.status !== 'unique') throw new Error('fixture');
    event.state.entity.key = entityKey(900);
    expect(validatePublishingReview(review, event, session, NOW)).toContain('event changed');
    event.state.entity.key = entityKey(102); event.sourceProject = null;
    expect(validatePublishingReview(review, event, session, NOW)).toContain('agreements changed');
  });
});
describe('event time and draft retention', () => {
  it('round-trips exact milliseconds and the second occurrence of a repeated clock time', async () => {
    const { terms } = await fixture();
    expect(termsFromFields(publishingFields(terms))).toEqual({ ok: true, terms });
    const repeated = { ...terms, timeZone: 'America/New_York', startsAt: Date.parse('2026-11-01T06:30:15.123Z'), endsAt: Date.parse('2026-11-01T07:30:45.456Z') };
    const fields = publishingFields(repeated);
    expect(fields.startOccurrence).toBe('later'); expect(termsFromFields(fields)).toEqual({ ok: true, terms: repeated });
  });
  it('requires an explicit DST fold choice and rejects nonexistent clock times even with a choice', () => {
    const fields = { ...emptyPublishingFields(), title: 'Workshop', venue: 'Hall', timeZone: 'America/New_York', startsLocal: '2026-11-01T01:30', endsLocal: '2026-11-01T03:30' };
    expect(termsFromFields(fields)).toMatchObject({ ok: false, message: expect.stringContaining('occurs twice') });
    expect(termsFromFields({ ...fields, startOccurrence: 'later' }).ok).toBe(true);
    expect(termsFromFields({ ...fields, startsLocal: '2026-03-08T02:30', endsLocal: '2026-03-08T04:00', startOccurrence: 'later' })).toMatchObject({ ok: false, message: expect.stringContaining('does not exist') });
  });
  it('covers the event plus return period using an even bounded nominal lifetime', () => {
    const end = NOW + 150 * 86_400_000 + 999, lifetime = publishingLifetime(end, NOW);
    expect(lifetime % 2).toBe(0); expect(lifetime * 1000).toBeGreaterThanOrEqual(end + 30 * 86_400_000 - NOW);
  });
  it('retains half-edited fields per event and wallet across storage restore', async () => {
    const { draft } = await fixture(); draft.fields.endsLocal = 'half-edited';
    const storage = memoryStorage(), store = publishingDraftStore(storage, KEYS.project, COORDINATOR);
    expect(store.save(draft).persisted).toBe(true);
    expect(publishingDraftStore(storage, KEYS.project, COORDINATOR).load()).toMatchObject({ status: 'ready', value: draft });
    expect(publishingDraftStore(storage, KEYS.project, STRANGER).inspectImport(store.export(draft)).status).toBe('recovery');
    expect(publishingDraftStore(storage, entityKey(999), COORDINATOR).inspectImport(store.export(draft)).status).toBe('recovery');
  });
  it('keeps failed-storage drafts when the panel is unmounted and isolates another workspace', async () => {
    const { draft } = await fixture(); const repository = { mode: 'public' } as EventRepositoryContract;
    const key = `${KEYS.project}:${COORDINATOR}`;
    expect(publishingDraftStore(null, KEYS.project, COORDINATOR).save(draft).persisted).toBe(false);
    publishingDraftMemory(repository).set(key, draft);
    expect(publishingDraftMemory(repository).get(key)).toEqual(draft);
    expect(publishingDraftMemory({ mode: 'public' } as EventRepositoryContract).get(key)).toBeUndefined();
    expect(publishingDraftMemory(repository).get(`${KEYS.project}:${STRANGER}`)).toBeUndefined();
  });
  it('advances a matching published draft but preserves newer and half-edited fields after old-request success', async () => {
    const { event, draft, terms } = await fixture();
    const matching = { ...draft, fields: publishingFields(terms), baselineReleaseKey: null };
    expect(draftAfterPublication(matching, terms, event)?.baselineReleaseKey).toBe(event.release!.key);
    expect(draftAfterPublication(draft, terms, event)).toBeNull();
    expect(draftAfterPublication({ ...draft, fields: { ...draft.fields, startsLocal: 'in progress' } }, terms, event)).toBeNull();
  });
});
describe('durable original event requests', () => {
  it('restores a partially published first event with its original ID and input', async () => {
    const { event, draft } = await fixture(); event.state = { status: 'missing', reason: 'expired_or_deleted' }; event.release = null; draft.baselineReleaseKey = null;
    const review = mustReview(preparePublishingReview(event, session, 'publish', draft, NOW));
    const command = structuredClone(review.command); command.operation.phase = 'proposal_confirmed'; command.operation.confirmedKeys = [entityKey(700)];
    const restored = mustReview(reviewOriginalCommand(command, event, session, NOW));
    expect(restored.resume).toBe(true); expect(restored.command.operation.id).toBe(review.command.operation.id);
    expect(restored.command.operation.inputHash).toBe(review.command.operation.inputHash);
  });
  it('rejects malformed feature input even when its generic action envelope is valid', async () => {
    const { event } = await fixture();
    const input = { lifetimeSeconds: 90 * 86_400, projectRoot: KEYS.project, expectedHeads: [] };
    const operation = createOperationIntent('publish_event', { mode: 'public', chainId: TIRAMISU_CHAIN_ID, actor }, input, { now: NOW });
    const command = { ...input, operation };
    expect(validRepositoryActionRecord({ status: 'needs-verification', command, operation })).toBe(true);
    expect(validPublishingCommand(command)).toBe(false);
    expect(reviewOriginalCommand(command, event, session, NOW).ok).toBe(false);
  });
  it('retains unknown outcomes across reopen and never sends a new request or a different account', async () => {
    const { event, draft } = await fixture(); const review = mustReview(preparePublishingReview(event, session, 'publish', draft, NOW));
    const storage = memoryStorage(), store = createDraftStore({ storage, key: 'action', kind: 'repository-action', validate: validRepositoryActionRecord });
    let writes = 0; let currentActor: Actor = actor; let observed: OperationIntent | null = null;
    const repository = { mode: 'public', reconcile: async (operation: OperationIntent) => {
      observed = operation; return { ok: true, value: { status: 'pending', operation } };
    } } as EventRepositoryContract;
    const action = createRepositoryActionController({ repository, store, getActor: () => currentActor });
    await action.run(review.command, async () => { writes++; throw new Error('Lost response'); });
    const reopened = createRepositoryActionController({ repository, store, getActor: () => currentActor });
    expect(reopened.getSnapshot().status).toBe('needs-verification');
    await reopened.run(review.command, async () => { writes++; throw new Error('Must not send'); });
    await reopened.reconcile();
    expect(observed).toEqual(review.command.operation); expect(writes).toBe(1);
    currentActor = { kind: 'wallet', address: STRANGER };
    await reopened.resume(async () => { writes++; throw new Error('Must not send'); });
    expect(writes).toBe(1); expect(reopened.clear()).toBe(false);
  });
  it('does not send with unavailable original-request persistence', async () => {
    const { event, draft } = await fixture(); const review = mustReview(preparePublishingReview(event, session, 'publish', draft, NOW)); let writes = 0;
    const action = createRepositoryActionController({ repository: { mode: 'public' } as EventRepositoryContract,
      store: createDraftStore({ storage: null, key: 'action', kind: 'repository-action', validate: validRepositoryActionRecord }), getActor: () => actor });
    await action.run(review.command, async () => { writes++; throw new Error('Must not send'); });
    expect(writes).toBe(0); expect(action.getSnapshot().error?.code).toBe('storage');
  });
  it('rechecks the live account and route after an asynchronous refresh and retains the frozen operation on success', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { event, draft } = await fixture(); const review = mustReview(preparePublishingReview(event, session, 'publish', draft, NOW)); let writes = 0;
    const lateAccount = await confirmPublishingReview(review, { read: async () => event,
      session: () => ({ ...session, actor: { kind: 'wallet', address: STRANGER } }), isCurrent: () => true, submit: async () => { writes++; return true; } });
    expect(lateAccount.ok).toBe(false);
    const lateRoute = await confirmPublishingReview(review, { read: async () => event, session: () => session,
      isCurrent: () => false, submit: async () => { writes++; return true; } });
    expect(lateRoute.ok).toBe(false); expect(writes).toBe(0);
    const confirmed = await confirmPublishingReview(review, { read: async () => event, session: () => session, isCurrent: () => true,
      submit: async command => { writes++; return command.operation.id; } });
    expect(confirmed).toEqual({ ok: true, value: review.command.operation.id }); expect(writes).toBe(1);
  });
});


describe('organizer place review', () => {
  async function managed() {
    const result = await fixture(), { event } = result;
    if (!event.release || event.state.status !== 'unique') throw Error('fixture');
    const terms = { ...event.release.payload.terms, termsVersion: 2 as const, format: 'in_person' as const,
      location: { countryCode: 'GB', country: 'United Kingdom', city: 'London', venue: result.terms.venue }, online: null,
      registration: { deadline: null, capacity: { kind: 'limited' as const, limit: 1 }, waitlist: true, admission: 'open' as const, invitedAccounts: [] } };
    event.release.payload.terms = terms; event.release.payload.audienceHash = audienceHash(terms);
    event.state.entity.payload.audienceHash = event.release.payload.audienceHash; event.state.entity.payload.admissions = [];
    const person = { kind: 'wallet' as const, address: STRANGER };
    const attendance = { status: 'unique' as const, entity: { key: entityKey(140), provenance: { ...event.release.provenance, creator: person, owner: person },
      payload: { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, operationId: 'request-place', createdAt: NOW - 1000, entityType: 'attendance_state' as const,
        projectRoot: event.projectRoot, attendee: STRANGER, releaseKey: event.release.key, audienceHash: event.release.payload.audienceHash, decision: 'going' as const, predecessorKeys: [] } } };
    event.roster = { snapshot: event.snapshot, diagnostics: [], entries: [{ attendee: STRANGER, attendance, registeredRelease: event.release, inclusionTimestamp: NOW - 500 }] };
    return { ...result, attendance, state: event.state.entity.payload };
  }
  it('binds confirmation to the exact request, event head and owner', async () => {
    const { event, attendance } = await managed();
    const result = prepareAdmissionReview(event, session, STRANGER, 'admit', NOW);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.review.command.admissions).toEqual([{ attendee: STRANGER, attendanceKey: attendance.entity.key, releaseKey: event.release!.key }]);
    expect(validateAdmissionReview(result.review, event, session, NOW)).toBeNull();
    expect(validateAdmissionReview(result.review, event, { ...session, actor: { kind: 'wallet', address: STRANGER } }, NOW)).not.toBeNull();
    if (event.state.status === 'unique') event.state.entity.key = entityKey(141);
    expect(validateAdmissionReview(result.review, event, session, NOW)).toContain('changed');
  });
  it('releases an explicit retained reservation when the visitor request is unavailable', async () => {
    const { event, attendance, state } = await managed();
    state.admissions = [{ attendee: STRANGER, attendanceKey: attendance.entity.key, releaseKey: event.release!.key }];
    event.roster = undefined; event.sourceProject = null;
    expect(prepareAdmissionReview(event, session, STRANGER, 'admit', NOW).ok).toBe(false);
    const result = prepareAdmissionReview(event, session, STRANGER, 'release', NOW);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.review.command.admissions).toEqual([]);
    expect(validateAdmissionReview(result.review, event, session, NOW)).toBeNull();
    expect(prepareAdmissionReview(event, session, COORDINATOR, 'release', NOW).ok).toBe(false);
  });
  it('requires reopening a closed deadline when unreserved attendees must accept changed details', async () => {
    const { event, attendance, state, draft } = await managed();
    event.release!.payload.terms.registration!.capacity = { kind: 'unlimited' };
    event.release!.payload.terms.registration!.deadline = NOW - 100;
    event.release!.payload.terms.registration!.waitlist = false;
    event.release!.payload.audienceHash = audienceHash(event.release!.payload.terms);
    state.audienceHash = event.release!.payload.audienceHash; attendance.entity.payload.audienceHash = state.audienceHash;
    const changed = { ...draft, fields: { ...publishingFields(event.release!.payload.terms), title: 'Updated visitor details' } };
    const closed = preparePublishingReview(event, session, 'publish', changed, NOW);
    expect(closed.ok).toBe(false); if (!closed.ok) expect(closed.message).toContain('later registration deadline');
    changed.fields.deadlineLocal = new Date(NOW + 3600000).toISOString().slice(0, -1);
    expect(preparePublishingReview(event, session, 'publish', changed, NOW).ok).toBe(true);
  });
  it('keeps reservations when publishing and stops a cap reduction before signing', async () => {
    const { event, attendance, state, draft } = await managed();
    state.admissions = [{ attendee: STRANGER, attendanceKey: attendance.entity.key, releaseKey: event.release!.key }, { attendee: COORDINATOR, attendanceKey: entityKey(142), releaseKey: event.release!.key }];
    const result = preparePublishingReview(event, session, 'publish', { ...draft, fields: { ...publishingFields(event.release!.payload.terms), title: 'Changed event', capacityLimit: '1' } }, NOW);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.message).toContain('Release reserved places');
    expect(state.admissions).toHaveLength(2);
  });
});
