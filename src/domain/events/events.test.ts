import { describe, expect, it } from 'vitest';
import { hashOffer, hashPlan, hashRequirements } from '../canonical';
import { deriveReadiness } from '../readiness';
import { deriveRequiredApprovers } from '../validation';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from '../types';
import type { Actor, EntityKey, EntityPayload, EntityProvenance, EntityRecord, PlanDocument, ProjectAggregate, PublisherAggregate, Snapshot, SourcePlanRef } from '../types';
import { attendanceStatus, audienceChanges, audienceHash, deriveEventAvailability, EVENTS_PROTOCOL,
  canAdmitAttendance, eventPublicationDeadlineGuard, eventRosterVerified, registrationEligibility, validateEventPayload, validateEventRecord, validateEventReleaseBinding } from './index';
import { MAX_EVENT_RESERVATIONS, MAX_EVENT_STATE_PAYLOAD_BYTES } from './types';
import type { AttendanceState, AudienceTerms, EventAggregate, EventPayload, EventRecord, EventRelease, EventScope, EventState } from './index';

const NOW = 1_900_000_000_000;
const key = (number: number): EntityKey => `0x${number.toString(16).padStart(64, '0')}`;
const wallet = (digit: string): Extract<Actor, { kind: 'wallet' }> => ({ kind: 'wallet', address: `0x${digit.repeat(40)}` });
const coordinator = wallet('1'), contributor = wallet('2'), attendee = wallet('3');
const root = key(1), publisherRoot = key(2);
const base = { protocol: PROTOCOL, schemaVersion: 1 as const, createdAt: NOW, operationId: 'fixture' };
const eventBase = { ...base, protocol: EVENTS_PROTOCOL };
const snapshot = (): Snapshot => ({ mode: 'public', chainId: TIRAMISU_CHAIN_ID, blockNumber: '100', blockHash: `0x${'aa'.repeat(32)}`,
  blockTimestamp: NOW, fetchedAt: NOW, completeness: 'complete', freshness: 'fresh', source: 'arkiv', reasons: [] });
const provenance = (actor: Actor): EntityProvenance => ({ mode: 'public', creator: actor, owner: actor, readonly: true,
  permissionlessExtension: false, contentType: 'application/json', createdAtBlock: '90', expiresAtBlock: '200', transactionHash: `0x${'bb'.repeat(32)}` });
const record = <T extends EntityPayload>(entityKey: EntityKey, payload: T, actor: Actor): EntityRecord<T> => ({ key: entityKey, payload, provenance: provenance(actor) });
const eventRecord = <T extends EventPayload>(entityKey: EntityKey, payload: T, actor: Actor = coordinator): EventRecord<T> => ({ key: entityKey, payload, provenance: provenance(actor) });
const terms = (): AudienceTerms => ({ title: 'Small Works', description: 'An exhibition of synthetic artwork.', startsAt: NOW + 100,
  endsAt: NOW + 900, timeZone: 'Europe/London', venue: 'Synthetic library hall', instructions: 'Come through the front entrance.', conditions: 'Free open event. No reserved seat.' });

function sourceProject(): ProjectAggregate {
  const interval = { start: NOW + 100, end: NOW + 900 };
  const offer = { id: 'host', title: 'Host visitors', resourceId: 'self', kind: 'person' as const, unit: 'person', quantity: 1,
    capabilities: ['hosting'], availability: [{ start: NOW, end: NOW + 10_000 }], projectScope: [], conditions: [], instructions: '' };
  const variant = { id: 'morning', title: 'Morning', venueId: 'library', timeZone: 'UTC', instructions: '', requirements: [
    { id: 'hosting', title: 'Welcome visitors', kind: 'person' as const, capability: 'hosting', unit: 'person', quantity: 1, interval, instructions: '', dependsOn: [] },
  ] };
  const offerHash = hashOffer(publisherRoot, offer);
  const plan: PlanDocument = { protocol: PROTOCOL, validationVersion: 1, chainId: TIRAMISU_CHAIN_ID, projectRoot: root, outcome: 'Welcome visitors.', variant,
    offers: [{ publisherRoot, offerId: offer.id, offerHash }], resourceAssumptions: [{ publisherRoot, resourceId: 'self', capacity: 1, unit: 'person' }],
    allocations: [{ id: 'host', requirementId: 'hosting', publisherRoot, offerId: offer.id, offerHash, resourceId: 'self', quantity: 1, unit: 'person', interval }],
    requiredApprovers: [], conditions: [], instructions: '', predecessor: null,
    runbook: [{ kind: 'task', id: 'welcome', title: 'Welcome visitors', publisherRoot, interval, allocationIds: ['host'], dependsOn: [], instructions: '' }] };
  plan.requiredApprovers = deriveRequiredApprovers(plan);
  const proposalHash = hashPlan(plan);
  const source: SourcePlanRef = { projectRoot: root, activationKey: key(3), proposalKey: key(4), proposalHash };
  const publisher: PublisherAggregate = {
    root: record(publisherRoot, { ...base, entityType: 'publisher_root', publisher: contributor, kind: 'individual' }, contributor), snapshot: snapshot(),
    book: { status: 'unique', entity: record(key(5), { ...base, entityType: 'book_state', publisherRoot, predecessorKeys: [], name: 'Synthetic host', description: '',
      resources: [{ id: 'self', name: 'Host', kind: 'person', unit: 'person', capacity: 1, capabilities: ['hosting'], availability: offer.availability }], offers: [offer],
      decisions: [{ ...source, status: 'accepted', decidedAt: NOW, operationId: 'accept' }],
      grants: [{ ...source, id: 'grant', protocol: PROTOCOL, chainId: TIRAMISU_CHAIN_ID, offers: plan.offers, allocations: plan.allocations,
        validUntil: NOW + 2_000, acceptedAt: NOW, operationId: 'accept' }], attestations: [], custodyHolds: [], retentionDays: 90 }, contributor) },
  };
  const proposal = record(source.proposalKey, { ...base, entityType: 'proposal' as const, projectRoot: root, requirementsHash: hashRequirements(root, variant.requirements),
    proposalHash, plan, changeExplanation: '' }, coordinator);
  return { root: record(root, { ...base, entityType: 'project_root', coordinator }, coordinator),
    state: { status: 'unique', entity: record(key(6), { ...base, entityType: 'project_state', projectRoot: root, predecessorKeys: [],
      recipe: { title: 'Small Works', outcome: plan.outcome, timeZone: 'UTC', variants: [variant], instructions: '' }, publisherRoots: [publisherRoot], lifecycle: 'planning', completedWork: [], completion: null }, coordinator) },
    activation: { status: 'unique', entity: record(source.activationKey, { ...base, entityType: 'plan_activation', projectRoot: root,
      proposalKey: source.proposalKey, proposalHash, predecessorActivationKeys: [] }, coordinator) },
    proposal, proposalHistory: [proposal], publishers: [publisher], snapshot: snapshot() };
}

function fixture(): { event: EventAggregate; attendance: EventScope<AttendanceState>; state: EventState; release: EventRelease; project: ProjectAggregate } {
  const project = sourceProject();
  if (project.activation.status !== 'unique') throw new Error('fixture activation');
  const source = { projectRoot: root, activationKey: project.activation.entity.key,
    proposalKey: project.activation.entity.payload.proposalKey, proposalHash: project.activation.entity.payload.proposalHash };
  const release: EventRelease = { ...eventBase, entityType: 'event_release', projectRoot: root, predecessorReleaseKey: null, terms: terms(), audienceHash: audienceHash(terms()), source };
  const releaseRecord = eventRecord(key(7), release);
  const state: EventState = { ...eventBase, entityType: 'event_state', projectRoot: root, releaseKey: releaseRecord.key, audienceHash: release.audienceHash,
    startsAt: release.terms.startsAt, endsAt: release.terms.endsAt, source: { ...source }, status: 'open', predecessorKeys: [] };
  const event: EventAggregate = { projectRoot: root, root: project.root, state: { status: 'unique', entity: eventRecord(key(8), state) },
    release: releaseRecord, sourceProject: project, snapshot: snapshot(), diagnostics: [] };
  const attendance: EventScope<AttendanceState> = { status: 'unique', entity: eventRecord(key(9), { ...eventBase, entityType: 'attendance_state',
    projectRoot: root, attendee: attendee.address, releaseKey: releaseRecord.key, audienceHash: release.audienceHash, decision: 'going', predecessorKeys: [] }, attendee) };
  return { event, attendance, state, release, project };
}

function structuredFixture() {
  const result = fixture(); const { event, state, release, attendance } = result;
  release.terms = { ...release.terms, termsVersion: 2, format: 'hybrid',
    location: { countryCode: 'GB', country: 'United Kingdom', city: 'London', venue: release.terms.venue },
    online: { url: 'https://meet.example.org/public-room', instructions: 'Public room; no password.' },
    registration: { deadline: NOW + 50, capacity: { kind: 'limited', limit: 1 }, waitlist: true, admission: 'open', invitedAccounts: [] } };
  release.audienceHash = audienceHash(release.terms); state.audienceHash = release.audienceHash; state.admissions = [];
  if (attendance.status !== 'unique') throw new Error('fixture');
  attendance.entity.payload.audienceHash = release.audienceHash;
  event.roster = { snapshot: event.snapshot, diagnostics: [], entries: [{ attendee: attendee.address, attendance,
    registeredRelease: event.release, inclusionTimestamp: NOW - 100 }] };
  return { ...result, attendance, entry: event.roster.entries[0]! };
}

describe('structured conditions and explicit admission', () => {
  it('fits the maximum full roster and predecessor set within the source-checked SDK payload ceiling', () => {
    const { state } = structuredFixture();
    state.operationId = '\\'.repeat(128); state.createdAt = 8_640_000_000_000_000;
    state.startsAt = 8_639_999_999_999_999; state.endsAt = 8_640_000_000_000_000; state.status = 'cancelled';
    state.predecessorKeys = Array.from({ length: 64 }, (_, index) => key(index + 1));
    state.admissions = Array.from({ length: MAX_EVENT_RESERVATIONS }, (_, index) => ({
      attendee: `0x${index.toString(16).padStart(40, '0')}` as `0x${string}`, attendanceKey: key(index + 1000), releaseKey: key(index + 2000),
    }));
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBe(120_700);
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThan(MAX_EVENT_STATE_PAYLOAD_BYTES);
    expect(MAX_EVENT_STATE_PAYLOAD_BYTES).toBeLessThan(128 * 1024);
    expect(validateEventPayload(state).valid).toBe(true);
    state.admissions.push({ attendee: wallet('9').address, attendanceKey: key(9999), releaseKey: key(8888) });
    expect(validateEventPayload(state).valid).toBe(false);
  });
  it('preserves the exact legacy hash and hashes every structured material condition', () => {
    const legacy = terms();
    expect(audienceHash(legacy)).toBe('0x2b9d1c0e7f57cf601c5eda3965ddce11dcd7dd9844bb4a78187dadab4da54422');
    const { release } = structuredFixture(); expect(validateEventPayload(release).valid).toBe(true);
    const original = audienceHash(release.terms);
    for (const change of [{ format: 'online', location: null }, { location: { ...release.terms.location!, city: 'Oxford' } },
      { online: { ...release.terms.online!, instructions: 'Another public room' } },
      { registration: { ...release.terms.registration!, deadline: null } },
      { registration: { ...release.terms.registration!, capacity: { kind: 'limited', limit: 2 } } },
      { registration: { ...release.terms.registration!, waitlist: false } },
      { registration: { ...release.terms.registration!, admission: 'invite_only', invitedAccounts: [attendee.address] } }]) {
      expect(audienceHash({ ...release.terms, ...change } as AudienceTerms)).not.toBe(original);
    }
    expect(audienceChanges(legacy, release.terms)).toEqual(['termsVersion', 'format', 'location', 'online', 'registration']);
  });

  it('rejects partial extensions, empty physical locations, credentials, bad limits and late deadlines', () => {
    const { release } = structuredFixture();
    const valid = (next: AudienceTerms) => validateEventPayload({ ...release, terms: next, audienceHash: audienceHash(next) }).valid;
    expect(valid({ ...release.terms, termsVersion: undefined })).toBe(false);
    expect(valid({ ...release.terms, location: null })).toBe(false);
    expect(valid({ ...release.terms, registration: { ...release.terms.registration!, capacity: { kind: 'limited', limit: 0 } } })).toBe(false);
    expect(valid({ ...release.terms, registration: { ...release.terms.registration!, deadline: release.terms.endsAt + 1 } })).toBe(false);
    for (const url of ['http://meet.example.org', 'https://user:pass@meet.example.org', 'https://meet.example.org?pwd=secret', 'https://meet.example.org#token=secret']) {
      expect(valid({ ...release.terms, online: { url, instructions: '' } })).toBe(false);
    }
    expect(valid({ ...release.terms, online: { url: '', instructions: 'Use the publicly listed room in the community directory.' } })).toBe(true);
    expect(valid({ ...release.terms, online: { url: '', instructions: '' } })).toBe(false);
    expect(valid({ ...release.terms, online: { url: 'https://www.youtube.com/watch?v=public-stream#program', instructions: '' } })).toBe(true);
  });

  it('distinguishes a pending request from a reserved place, including at capacity', () => {
    const { event, attendance, state, entry } = structuredFixture();
    expect(eventRosterVerified(event, NOW)).toBe(true);
    expect(registrationEligibility(event, attendee, NOW)).toEqual({ status: 'request', requiresApproval: true, remaining: 1 });
    expect(attendanceStatus(attendance, event, NOW)).toBe('pending'); expect(canAdmitAttendance(event, entry, NOW)).toBe(true);
    state.admissions = [{ attendee: attendee.address, attendanceKey: attendance.entity.key, releaseKey: event.release!.key }];
    expect(attendanceStatus(attendance, event, NOW)).toBe('going');
    expect(registrationEligibility(event, attendee, NOW)).toEqual({ status: 'request', requiresApproval: true, remaining: 0 });
  });

  it('uses chain inclusion for the deadline and retains timely admitted attendance after it', () => {
    const { event, attendance, state, entry } = structuredFixture();
    event.release!.payload.terms.registration!.deadline = NOW - 50;
    event.release!.payload.audienceHash = audienceHash(event.release!.payload.terms);
    state.audienceHash = event.release!.payload.audienceHash; attendance.entity.payload.audienceHash = state.audienceHash;
    attendance.entity.payload.createdAt = NOW - 1_000_000;
    entry.inclusionTimestamp = NOW;
    expect(attendanceStatus(attendance, event, NOW)).toBe('registration_closed'); expect(canAdmitAttendance(event, entry, NOW)).toBe(false);
    entry.inclusionTimestamp = NOW - 100;
    state.admissions = [{ attendee: attendee.address, attendanceKey: attendance.entity.key, releaseKey: event.release!.key }];
    expect(attendanceStatus(attendance, event, NOW + 60)).toBe('going');
    expect(registrationEligibility(event, attendee, NOW + 60).status).toBe('registration_closed');
  });

  it('permits changed-release reconfirmation after the deadline only for immutable-listed wallets with a still-held place', () => {
    const { event, attendance, state, entry } = structuredFixture();
    event.release!.payload.predecessorReleaseKey = key(501); event.release!.payload.reconfirmationAccounts = [attendee.address];
    event.release!.payload.terms.registration!.deadline = NOW - 50;
    event.release!.payload.audienceHash = audienceHash(event.release!.payload.terms); state.audienceHash = event.release!.payload.audienceHash;
    attendance.entity.payload.audienceHash = state.audienceHash; entry.inclusionTimestamp = NOW;
    state.admissions = [{ attendee: attendee.address, attendanceKey: key(502), releaseKey: key(501) }];
    expect(registrationEligibility(event, attendee, NOW).status).toBe('request');
    expect(registrationEligibility(event, contributor, NOW).status).toBe('registration_closed');
    expect(attendanceStatus(attendance, event, NOW)).toBe('pending'); expect(canAdmitAttendance(event, entry, NOW)).toBe(true);
    state.admissions = [];
    expect(registrationEligibility(event, attendee, NOW).status).toBe('registration_closed');
    expect(attendanceStatus(attendance, event, NOW)).toBe('registration_closed');
  });

  it('requires a deliberate future deadline for material edits affecting unreserved unlimited attendees', () => {
    const { event, attendance, state } = structuredFixture();
    event.release!.payload.terms.registration = { ...event.release!.payload.terms.registration!, capacity: { kind: 'unlimited' }, waitlist: false, deadline: NOW - 50 };
    event.release!.payload.audienceHash = audienceHash(event.release!.payload.terms); state.audienceHash = event.release!.payload.audienceHash;
    attendance.entity.payload.audienceHash = state.audienceHash;
    const changed: AudienceTerms = { ...event.release!.payload.terms, description: 'Changed terms' };
    expect(eventPublicationDeadlineGuard(event, changed, NOW)).toBe('reopen_required');
    expect(eventPublicationDeadlineGuard(event, event.release!.payload.terms, NOW)).toBe('ready');
    const reopened = { ...changed, registration: { ...changed.registration!, deadline: NOW + 10 } };
    expect(eventPublicationDeadlineGuard(event, reopened, NOW)).toBe('ready');
    event.roster!.snapshot = { ...event.snapshot, completeness: 'incomplete' };
    expect(eventPublicationDeadlineGuard(event, changed, NOW)).toBe('unverified');
  });

  it('does not lose an active older-release attendee across repeated changes before a closed deadline', () => {
    const { event, attendance, state, entry } = structuredFixture();
    event.release!.payload.terms.registration = { ...event.release!.payload.terms.registration!, capacity: { kind: 'unlimited' }, waitlist: false, deadline: NOW - 50 };
    event.release!.payload.audienceHash = audienceHash(event.release!.payload.terms); state.audienceHash = event.release!.payload.audienceHash;
    attendance.entity.payload.audienceHash = state.audienceHash;
    const prior = structuredClone(event.release!);
    event.release!.key = key(510); event.release!.payload.predecessorReleaseKey = prior.key;
    event.release!.payload.terms.description = 'Second release'; event.release!.payload.audienceHash = audienceHash(event.release!.payload.terms);
    state.releaseKey = event.release!.key; state.audienceHash = event.release!.payload.audienceHash; entry.registeredRelease = prior;
    expect(attendanceStatus(attendance, event, NOW, prior)).toBe('needs_review');
    const third = { ...event.release!.payload.terms, description: 'Third release' };
    expect(eventPublicationDeadlineGuard(event, third, NOW)).toBe('reopen_required');
    entry.registeredRelease = null;
    expect(eventPublicationDeadlineGuard(event, third, NOW)).toBe('unverified');
  });

  it('requires the public invitation independently of an owner admission claim', () => {
    const { event, attendance, state, release } = structuredFixture();
    release.terms.registration!.admission = 'invite_only';
    release.audienceHash = audienceHash(release.terms); state.audienceHash = release.audienceHash; attendance.entity.payload.audienceHash = release.audienceHash;
    expect(registrationEligibility(event, attendee, NOW).status).toBe('invitation_required');
    expect(attendanceStatus(attendance, event, NOW)).toBe('invitation_required');
    state.admissions = [{ attendee: attendee.address, attendanceKey: attendance.entity.key, releaseKey: event.release!.key }];
    expect(eventRosterVerified(event, NOW)).toBe(false);
  });

  it('fails closed for missing, partial, forked, foreign, or over-capacity admission evidence', () => {
    for (const mutate of [
      (f: ReturnType<typeof structuredFixture>) => { f.event.roster = undefined; },
      (f: ReturnType<typeof structuredFixture>) => { f.event.roster!.snapshot = { ...f.event.snapshot, completeness: 'incomplete' }; },
      (f: ReturnType<typeof structuredFixture>) => { f.event.roster!.entries = []; },
      (f: ReturnType<typeof structuredFixture>) => { f.entry.attendance = { status: 'conflict', entities: [f.attendance.entity, f.attendance.entity] }; },
      (f: ReturnType<typeof structuredFixture>) => { f.attendance.entity.provenance.creator = contributor; },
      (f: ReturnType<typeof structuredFixture>) => { f.state.admissions!.push({ attendee: contributor.address, attendanceKey: key(42), releaseKey: f.event.release!.key }); },
    ]) {
      const f = structuredFixture(); f.state.admissions = [{ attendee: attendee.address, attendanceKey: f.attendance.entity.key, releaseKey: f.event.release!.key }]; mutate(f);
      expect(eventRosterVerified(f.event, NOW)).toBe(false); expect(attendanceStatus(f.attendance, f.event, NOW)).toBe('unverified');
    }
  });

  it('retains the reserved count on withdrawal and requires owner confirmation of a replacement request', () => {
    const { event, attendance, state, entry } = structuredFixture();
    const originalKey = attendance.entity.key;
    state.admissions = [{ attendee: attendee.address, attendanceKey: originalKey, releaseKey: event.release!.key }];
    attendance.entity = { ...attendance.entity, key: key(90), payload: { ...attendance.entity.payload, predecessorKeys: [originalKey], decision: 'withdrawn' } };
    entry.attendance = attendance;
    expect(attendanceStatus(attendance, event, NOW)).toBe('withdrawn'); expect(registrationEligibility(event, attendee, NOW).remaining).toBe(0);
    attendance.entity.payload.decision = 'going';
    expect(attendanceStatus(attendance, event, NOW)).toBe('pending');
    state.admissions = [{ attendee: attendee.address, attendanceKey: attendance.entity.key, releaseKey: event.release!.key }];
    expect(attendanceStatus(attendance, event, NOW)).toBe('going');
  });

  it('keeps unrelated admission valid across withdrawal and arbitrary rejoin successors without transferring confirmation', () => {
    const f = structuredFixture(); const { event, state, attendance, entry } = f;
    event.release!.payload.terms.registration!.capacity = { kind: 'limited', limit: 2 };
    event.release!.payload.audienceHash = audienceHash(event.release!.payload.terms);
    state.audienceHash = event.release!.payload.audienceHash; attendance.entity.payload.audienceHash = state.audienceHash;
    const other = eventRecord(key(77), { ...attendance.entity.payload, attendee: contributor.address, operationId: 'other' }, contributor);
    const otherScope: EventScope<AttendanceState> = { status: 'unique', entity: other };
    event.roster!.entries.push({ attendee: contributor.address, attendance: otherScope, registeredRelease: event.release, inclusionTimestamp: NOW - 100 });
    const original = attendance.entity.key;
    state.admissions = [{ attendee: attendee.address, attendanceKey: original, releaseKey: event.release!.key },
      { attendee: contributor.address, attendanceKey: other.key, releaseKey: event.release!.key }];
    for (let index = 0; index < 6; index++) {
      const previous = attendance.entity.key;
      attendance.entity = { ...attendance.entity, key: key(200 + index), payload: { ...attendance.entity.payload,
        decision: index % 2 === 0 ? 'withdrawn' : 'going', predecessorKeys: [previous] } };
      entry.attendance = attendance;
      expect(eventRosterVerified(event, NOW)).toBe(true);
      expect(registrationEligibility(event, attendee, NOW).remaining).toBe(0);
      expect(attendanceStatus(otherScope, event, NOW)).toBe('going');
      expect(attendanceStatus(attendance, event, NOW)).toBe(index % 2 === 0 ? 'withdrawn' : 'pending');
    }
    expect(state.admissions[0]!.attendanceKey).toBe(original);
  });

  it('blocks admission when the source is paused and keeps owner withdrawal legible during an outage', () => {
    const { event, attendance, entry } = structuredFixture(); event.sourceProject = null;
    expect(canAdmitAttendance(event, entry, NOW)).toBe(false);
    attendance.entity.payload.decision = 'withdrawn'; event.root = null; event.release = null;
    expect(attendanceStatus(attendance, event, NOW)).toBe('withdrawn');
  });
});

describe('event payload validation and audience consent', () => {
  it('validates all extension records independently of the original protocol', () => {
    const { event, attendance } = fixture();
    expect(validateEventPayload(event.release!.payload)).toEqual({ valid: true, reasons: [] });
    expect(event.state.status === 'unique' && validateEventPayload(event.state.entity.payload).valid).toBe(true);
    expect(attendance.status === 'unique' && validateEventPayload(attendance.entity.payload).valid).toBe(true);
    expect(validateEventPayload({ ...event.release!.payload, protocol: PROTOCOL }).valid).toBe(false);
  });

  it('hashes every audience field but no source plan or transaction metadata', () => {
    const previous = terms();
    for (const field of Object.keys(previous) as (keyof AudienceTerms)[]) {
      const current = { ...previous, [field]: typeof previous[field] === 'number' ? Number(previous[field]) + 1 : `${previous[field]} changed` };
      expect(audienceHash(current), field).not.toBe(audienceHash(previous));
      expect(audienceChanges(previous, current), field).toEqual([field]);
    }
    const { release } = fixture();
    release.source.activationKey = key(500);
    release.operationId = 'new-publication';
    release.createdAt += 1;
    expect(audienceHash(release.terms)).toBe(release.audienceHash);
    expect(audienceChanges({ ...previous, description: 'Cafe\u0301\r\nEntry' }, { ...previous, description: 'Café\nEntry' })).toEqual([]);
    expect(audienceHash({ ...previous, description: 'Cafe\u0301\r\nEntry' })).toBe(audienceHash({ ...previous, description: 'Café\nEntry' }));
  });

  it('rejects unknown and missing keys, local references, noncanonical identities, duplicates, and wrong scope', () => {
    const { release, state, attendance } = fixture();
    const mutations: unknown[] = [
      { ...release, contactEmail: 'private@example.test' }, { ...release, terms: { ...release.terms, maxCapacity: 5 } },
      { ...release, projectRoot: 'local:project' }, { ...release, source: { ...release.source, activationKey: 'local:activation' } },
      { ...release, source: { ...release.source, projectRoot: key(99) } }, { ...release, source: { ...release.source, proposalKey: undefined } },
      { ...release, audienceHash: release.audienceHash.toUpperCase() }, { ...release, audienceHash: key(99) },
      { ...state, predecessorKeys: [key(1), key(1)] }, { ...state, predecessorKeys: Array.from({ length: 65 }, (_, index) => key(index)) },
      { ...state, startsAt: undefined }, { ...release, operationId: 'line\nbreak' }, { ...release, operationId: 'é'.repeat(65) },
      attendance.status === 'unique' ? { ...attendance.entity.payload, attendee: `0x${'AB'.repeat(20)}` } : null,
    ];
    for (const mutation of mutations) expect(validateEventPayload(mutation).valid).toBe(false);
  });

  it('rejects invalid dates, unnamed offsets, reversed intervals, and UTF-8 payload overflow', () => {
    const { release, state } = fixture();
    for (const change of [{ startsAt: -1 }, { startsAt: 0.5 }, { endsAt: Number.MAX_SAFE_INTEGER }, { endsAt: release.terms.startsAt },
      { timeZone: '+01:00' }, { timeZone: 'Not/AZone' }]) {
      const next = { ...release, terms: { ...release.terms, ...change } };
      expect(validateEventPayload(next).valid).toBe(false);
    }
    expect(validateEventPayload({ ...state, endsAt: state.startsAt }).valid).toBe(false);
    const big = { ...release, terms: { ...release.terms, description: '漢'.repeat(10_000), instructions: '漢'.repeat(10_000), conditions: '漢'.repeat(10_000) } };
    big.audienceHash = audienceHash(big.terms);
    expect(validateEventPayload(big)).toMatchObject({ valid: false, reasons: [{ code: 'payload_too_large' }] });
  });

  it('fails safely on values outside JSON and altered claimed hashes', () => {
    const { release } = fixture();
    const cyclic: Record<string, unknown> = { ...release }; cyclic.self = cyclic;
    for (const value of [undefined, null, [], new Date(), cyclic, { ...release, createdAt: NaN }, { ...release, terms: { ...release.terms, title: 'Different' } }]) {
      expect(validateEventPayload(value).valid).toBe(false);
    }
  });
});

describe('event availability and attendee decisions', () => {
  it('opens only on a current independently verified ready plan', () => {
    const { event, project, attendance } = fixture();
    expect(deriveReadiness(project, NOW).status).toBe('ready');
    expect(deriveEventAvailability(event, NOW)).toBe('open');
    expect(attendanceStatus(attendance, event, NOW)).toBe('going');
    const book = project.publishers[0]!.book;
    if (book.status !== 'unique') throw new Error('fixture book');
    book.entity.payload.decisions[0]!.status = 'withdrawn'; book.entity.payload.grants = [];
    expect(deriveEventAvailability(event, NOW)).toBe('paused');
    expect(attendanceStatus(attendance, event, NOW)).toBe('going');
  });

  it('pauses a stale source pointer and resumes after internal repair without changing attendee consent', () => {
    const { event, state, release, project, attendance } = fixture();
    state.source.activationKey = key(999);
    expect(deriveEventAvailability(event, NOW)).toBe('paused');
    if (project.activation.status !== 'unique' || project.publishers[0]!.book.status !== 'unique') throw new Error('fixture');
    project.activation.entity.key = key(999);
    const book = project.publishers[0]!.book.entity.payload;
    book.decisions[0]!.activationKey = key(999); book.grants[0]!.activationKey = key(999);
    expect(release.source.activationKey).not.toBe(state.source.activationKey);
    expect(deriveReadiness(project, NOW).status).toBe('ready');
    expect(deriveEventAvailability(event, NOW)).toBe('open');
    expect(attendanceStatus(attendance, event, NOW)).toBe('going');
  });

  it('requires review for each new audience release even when its terms are identical', () => {
    const { event, state, release, attendance } = fixture();
    const accepted = structuredClone(event.release!);
    event.release!.key = key(99); state.releaseKey = key(99);
    expect(attendanceStatus(attendance, event, NOW, accepted)).toBe('needs_review');
    release.terms.venue = 'Different hall'; release.audienceHash = audienceHash(release.terms); state.audienceHash = release.audienceHash;
    expect(attendanceStatus(attendance, event, NOW, accepted)).toBe('needs_review');
  });

  it('does not revive old consent when audience terms change from A to B and back to A', () => {
    const { event, state, attendance } = fixture();
    const acceptedA = structuredClone(event.release!);
    const publish = (releaseKey: EntityKey, venue: string): void => {
      const priorKey = event.release!.key;
      const nextTerms = { ...acceptedA.payload.terms, venue };
      event.release = eventRecord(releaseKey, { ...acceptedA.payload, predecessorReleaseKey: priorKey,
        terms: nextTerms, audienceHash: audienceHash(nextTerms) });
      state.releaseKey = releaseKey; state.audienceHash = event.release.payload.audienceHash;
    };
    expect(attendanceStatus(attendance, event, NOW, acceptedA)).toBe('going');
    publish(key(100), 'Alternative hall');
    expect(attendanceStatus(attendance, event, NOW, acceptedA)).toBe('needs_review');
    publish(key(101), acceptedA.payload.terms.venue);
    expect(event.release!.payload.audienceHash).toBe(acceptedA.payload.audienceHash);
    expect(audienceChanges(acceptedA.payload.terms, event.release!.payload.terms)).toEqual([]);
    expect(attendanceStatus(attendance, event, NOW, acceptedA)).toBe('needs_review');
    if (attendance.status !== 'unique') throw new Error('fixture');
    attendance.entity.payload.releaseKey = event.release!.key;
    expect(attendanceStatus(attendance, event, NOW, event.release)).toBe('going');
  });

  it('requires authenticated historical release evidence even when copied audience hashes match', () => {
    const { event, attendance } = fixture();
    if (attendance.status !== 'unique') throw new Error('fixture');
    expect(attendanceStatus(attendance, event, NOW, null)).toBe('unverified');
    attendance.entity.payload.releaseKey = key(999);
    expect(attendanceStatus(attendance, event, NOW)).toBe('unverified');
    const claimedRelease = structuredClone(event.release!); claimedRelease.key = key(999);
    claimedRelease.provenance.creator = attendee; claimedRelease.provenance.owner = attendee;
    expect(attendanceStatus(attendance, event, NOW, claimedRelease)).toBe('unverified');
  });

  it('keeps cancellation, closure and elapsed end distinct and never claims physical attendance', () => {
    const { event, state, attendance } = fixture();
    state.status = 'closed';
    expect(deriveEventAvailability(event, NOW)).toBe('closed');
    expect(attendanceStatus(attendance, event, NOW)).toBe('going');
    state.status = 'open';
    expect(deriveEventAvailability(event, NOW + 900)).toBe('ended');
    expect(attendanceStatus(attendance, event, NOW + 900)).toBe('ended');
    state.status = 'cancelled'; event.sourceProject = null;
    expect(deriveEventAvailability(event, NOW)).toBe('cancelled');
    expect(attendanceStatus(attendance, event, NOW)).toBe('cancelled');
    event.snapshot.freshness = 'stale';
    expect(deriveEventAvailability(event, NOW)).toBe('unverified');
  });

  it('keeps explicit withdrawal visible even when event references disappear', () => {
    const { event, attendance } = fixture();
    event.release = null;
    expect(attendanceStatus(attendance, event, NOW)).toBe('unverified');
    if (attendance.status !== 'unique') throw new Error('fixture');
    attendance.entity.payload.decision = 'withdrawn';
    expect(attendanceStatus(attendance, event, NOW)).toBe('withdrawn');
    expect(attendanceStatus({ status: 'missing', reason: 'expired_or_deleted' }, event, NOW)).toBe('unverified');
    expect(attendanceStatus({ status: 'missing', reason: 'not_initialized' }, event, NOW)).toBe('not_registered');
  });

  it('fails closed for stale, incomplete, missing, forked, forged, and mixed-block records', () => {
    const changes: ((event: EventAggregate) => void)[] = [
      event => { event.snapshot.freshness = 'stale'; }, event => { event.snapshot.completeness = 'incomplete'; },
      event => { event.snapshot.fetchedAt = NOW - 60_001; }, event => { event.snapshot.fetchedAt = NOW + 1; },
      event => { event.snapshot.blockTimestamp = NOW - 60_001; }, event => { event.snapshot.blockTimestamp = NOW + 1; },
      event => { event.snapshot.blockNumber = null; }, event => { event.snapshot.blockHash = null; },
      event => { event.diagnostics.push({ code: 'page_budget' }); }, event => { event.root = null; },
      event => { event.release = null; }, event => { event.sourceProject = null; },
      event => { event.state = { status: 'missing', reason: 'expired_or_deleted' }; },
      event => { if (event.state.status === 'unique') event.state = { status: 'conflict', entities: [event.state.entity, event.state.entity] }; },
      event => { event.state = { status: 'unverified', reasons: [{ code: 'rpc_error' }] }; },
      event => { event.release!.provenance.creator = attendee; event.release!.provenance.owner = attendee; },
      event => { event.release!.provenance.expiresAtBlock = '100'; },
      event => { event.release!.provenance.readonly = false; },
      event => { event.release!.payload.terms.title = 'Forged terms'; },
      event => { if (event.state.status === 'unique') event.state.entity.payload.startsAt += 1; },
      event => { event.sourceProject!.snapshot.blockNumber = '101'; },
      event => { event.sourceProject!.activation = { status: 'conflict', entities: [] }; },
    ];
    for (const change of changes) {
      const { event, attendance } = fixture(); change(event);
      expect(deriveEventAvailability(event, NOW), change.toString()).toBe('unverified');
      expect(attendanceStatus(attendance, event, NOW), change.toString()).toBe('unverified');
    }
  });

  it('authenticates attendance against immutable creator and rejects changed ownership or expiry', () => {
    const { event, attendance, state } = fixture();
    if (attendance.status !== 'unique') throw new Error('fixture');
    expect(validateEventReleaseBinding(state, event.release!).valid).toBe(true);
    const changes: ((record: EventRecord<AttendanceState>) => void)[] = [
      value => { value.payload.attendee = coordinator.address; }, value => { value.provenance.owner = coordinator; },
      value => { value.provenance.permissionlessExtension = true; }, value => { value.provenance.createdAtBlock = '101'; },
      value => { value.provenance.expiresAtBlock = '100'; }, value => { value.payload.createdAt = NOW + 1; },
    ];
    for (const change of changes) {
      const next = structuredClone(attendance.entity); change(next);
      expect(validateEventRecord(next, event.snapshot).valid).toBe(false);
      expect(attendanceStatus({ status: 'unique', entity: next }, event, NOW)).toBe('unverified');
    }
    const malformed = structuredClone(attendance.entity);
    Object.assign(malformed.provenance, { readonly: 'false', permissionlessExtension: undefined });
    expect(validateEventRecord(malformed, event.snapshot).valid).toBe(false);
  });
});
