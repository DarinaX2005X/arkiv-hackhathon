import { describe, expect, it } from 'vitest';
import { stringToHex, toHex } from 'viem';
import { audienceHash, deriveEventAvailability, attendanceStatus, EVENTS_PROTOCOL } from '../../domain/events';
import type { AttendanceState, AudienceTerms, EventPayload, EventRelease, EventState } from '../../domain/events';
import type { AccountAddress, DomainReason, PublicEntityKey } from '../../domain/types';
import type { RpcRequest } from '../arkiv/client';
import type { ReaderPolicy } from '../arkiv/reader';
import { repositoryError } from '../arkiv/errors';
import { COORDINATOR, KEYS, NOW, STRANGER, entityKey, rawEntity, readyFixture } from '../__tests__/arkiv-fixture';
import type { RawAttribute, RawEntity, ReadRpcFixture } from '../__tests__/arkiv-fixture';
import { EventReader } from './reader';
import { EventRepository } from './repository';

const RELEASE = entityKey(101); const STATE = entityKey(102); const ATTENDANCE = entityKey(103);
const eventBase = (operationId: string) => ({ protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, operationId, createdAt: NOW - 1_000 });
const terms: AudienceTerms = { title: 'A neighbourhood workshop', description: 'Make something together.',
  startsAt: NOW + 3_600_000, endsAt: NOW + 7_200_000, timeZone: 'UTC', venue: 'Public library',
  instructions: 'Use the front entrance.', conditions: 'Free participation; no guaranteed reserved seat.' };

/** Independent raw projection fixture; the production event encoder is intentionally not used. */
function rawEvent(key: PublicEntityKey, payload: EventPayload, creator: AccountAddress,
  overrides: Partial<RawEntity> = {}): RawEntity {
  const attributes: RawAttribute[] = [
    { name: 'project', type: 'str', value: 'partfolk-events' }, { name: 'schema_version', type: 'i32', value: 1 },
    { name: 'entity_type', type: 'str', value: payload.entityType }, { name: 'operation_id', type: 'str', value: payload.operationId },
    { name: 'project_key', type: 'key', value: payload.projectRoot }, { name: 'created_at', type: 'u64', value: toHex(payload.createdAt) },
    { name: 'audience_hash', type: 'bytes32', value: payload.audienceHash },
  ];
  if (payload.entityType === 'attendance_state') {
    attributes.push({ name: 'release_key', type: 'key', value: payload.releaseKey }, { name: 'decision', type: 'str', value: payload.decision });
  } else {
    const dates = payload.entityType === 'event_release' ? payload.terms : payload;
    attributes.push({ name: 'starts_at', type: 'u64', value: toHex(dates.startsAt) }, { name: 'ends_at', type: 'u64', value: toHex(dates.endsAt) },
      { name: 'proposal_key', type: 'key', value: payload.source.proposalKey });
    if (payload.entityType === 'event_state') attributes.push({ name: 'release_key', type: 'key', value: payload.releaseKey },
      { name: 'status', type: 'str', value: payload.status });
  }
  return { key, creator, owner: creator, createdAt: toHex(95), expiresAt: toHex(10_000), creationFlags: 1,
    contentType: 'application/json', payload: stringToHex(JSON.stringify(payload)), attributes, ...overrides };
}

function fixture() {
  const base = readyFixture();
  const release: EventRelease = { ...eventBase('release-1'), entityType: 'event_release', projectRoot: KEYS.project,
    terms: structuredClone(terms), audienceHash: audienceHash(terms), predecessorReleaseKey: null, source: base.source };
  const state: EventState = { ...eventBase('event-1'), entityType: 'event_state', projectRoot: KEYS.project,
    releaseKey: RELEASE, audienceHash: release.audienceHash, startsAt: terms.startsAt, endsAt: terms.endsAt,
    status: 'open', source: base.source, predecessorKeys: [] };
  const attendance: AttendanceState = { ...eventBase('attendance-1'), entityType: 'attendance_state', projectRoot: KEYS.project,
    releaseKey: RELEASE, audienceHash: release.audienceHash, attendee: STRANGER, decision: 'going', predecessorKeys: [] };
  base.rpc.put(rawEvent(RELEASE, release, COORDINATOR)); base.rpc.put(rawEvent(STATE, state, COORDINATOR));
  base.rpc.put(rawEvent(ATTENDANCE, attendance, STRANGER));
  return { ...base, release, state, attendance };
}

function reader(rpc: ReadRpcFixture, policy: Partial<ReaderPolicy> = {}) {
  const queries: string[] = [];
  const request: RpcRequest = async args => {
    if (args.method !== 'arkiv_query' || !Array.isArray(args.params)) return rpc.request(args);
    const query = args.params[0] as string; queries.push(query);
    // Extend only this test's fixture with the SDK's exact numeric range syntax.
    const ranges = [...query.matchAll(/(starts_at|ends_at)\s*(>=|<=)\s*u64\((\d+)\)/g)];
    if (!ranges.length) return rpc.request(args);
    const previous = rpc.rows;
    rpc.rows = previous.filter(row => ranges.every(([, name, operator, scalar]) => {
      const actual = row.attributes.find(attribute => attribute.name === name);
      if (actual?.type !== 'u64') return false;
      return operator === '>=' ? BigInt(actual.value as string) >= BigInt(scalar!) : BigInt(actual.value as string) <= BigInt(scalar!);
    }));
    const equality = query.replace(/\s*AND\s+(?:starts_at|ends_at)\s*(?:>=|<=)\s*u64\(\d+\)/g, '');
    try { return await rpc.request({ ...args, params: [equality, ...args.params.slice(1)] }); }
    finally { rpc.rows = previous; }
  };
  return { instance: new EventReader({ request, now: () => NOW, policy }), queries };
}
const codes = (reasons: DomainReason[]) => reasons.map(reason => reason.code);
async function rejects(task: Promise<unknown>, code: DomainReason['code']) {
  let caught: unknown; try { await task; } catch (error) { caught = error; }
  expect(caught).toBeDefined(); expect(codes(repositoryError(caught).reasons)).toContain(code);
}

describe('independent event reads through the SDK with a readonly RPC fixture', () => {
  it('loads the ready source before the organizer has published the first event state', async () => {
    const { rpc } = fixture(); rpc.remove(STATE); rpc.remove(RELEASE);
    const event = await reader(rpc).instance.loadEvent(KEYS.project);
    expect(event.state.status).toBe('missing'); expect(event.sourceProject?.root.key).toBe(KEYS.project);
    expect(event.sourceProject?.proposal?.key).toBe(KEYS.proposal);
    expect(deriveEventAvailability(event, NOW)).toBe('unverified');
  });

  it('discovers ready events and restores a wallet registration from a fresh independent reader', async () => {
    const { rpc } = fixture(); rpc.pageSize = 1;
    const catalogue = await reader(rpc).instance.listEvents({ search: 'NEIGHBOURHOOD' });
    expect(catalogue.items).toHaveLength(1); expect(catalogue.diagnostics).toEqual([]);
    expect(deriveEventAvailability(catalogue.items[0]!, NOW)).toBe('open');
    const mine = await reader(rpc).instance.listMyEvents({ kind: 'wallet', address: STRANGER });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]!.registeredRelease?.key).toBe(RELEASE);
    expect(attendanceStatus(mine.items[0]!.attendance, mine.items[0]!.event!, NOW)).toBe('going');
    expect(rpc.queries.every(query => query.options.atBlock === '0x64')).toBe(true);
    expect(rpc.calls.every(call => ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'arkiv_query'].includes(call.method))).toBe(true);
  });

  it('walks every event head page and detects forks beyond the date range', async () => {
    const { rpc, state } = fixture(); rpc.pageSize = 1;
    rpc.put(rawEvent(entityKey(104), { ...state, operationId: 'fork-2', startsAt: NOW + 86_400_000, endsAt: NOW + 90_000_000 }, COORDINATOR));
    rpc.put(rawEvent(entityKey(105), { ...state, operationId: 'fork-3', startsAt: NOW + 96_400_000, endsAt: NOW + 100_000_000 }, COORDINATOR));
    const { instance, queries } = reader(rpc);
    const result = await instance.listEvents({ from: terms.startsAt, to: terms.endsAt });
    expect(result.items).toHaveLength(1); expect(result.items[0]!.state.status).toBe('conflict');
    if (result.items[0]!.state.status === 'conflict') expect(result.items[0]!.state.entities).toHaveLength(3);
    expect(deriveEventAvailability(result.items[0]!, NOW)).toBe('unverified');
    expect(queries[0]).toContain(`ends_at >= u64(${terms.startsAt})`);
    expect(queries[0]).toContain(`starts_at <= u64(${terms.endsAt})`);
    const scoped = queries.filter(query => query.includes("entity_type = str('event_state')") && query.includes('project_key'));
    expect(scoped.length).toBeGreaterThan(1);
    expect(scoped.every(query => !query.includes('schema_version') && !query.includes('starts_at') && !query.includes('ends_at'))).toBe(true);
  });

  it('sorts and searches after traversing the full catalogue, including later pages', async () => {
    const { rpc, root, release, state } = fixture(); rpc.pageSize = 1;
    const secondRoot = entityKey(111), secondRelease = entityKey(112), secondState = entityKey(113);
    const earlierTerms = { ...terms, title: 'Earlier gathering', startsAt: terms.startsAt - 10_000, endsAt: terms.endsAt - 10_000 };
    const source = { ...state.source, projectRoot: secondRoot };
    rpc.put(rawEntity(secondRoot, root, COORDINATOR));
    rpc.put(rawEvent(secondRelease, { ...release, projectRoot: secondRoot, terms: earlierTerms,
      audienceHash: audienceHash(earlierTerms), source }, COORDINATOR));
    rpc.put(rawEvent(secondState, { ...state, projectRoot: secondRoot, releaseKey: secondRelease,
      startsAt: earlierTerms.startsAt, endsAt: earlierTerms.endsAt, audienceHash: audienceHash(earlierTerms), source, status: 'cancelled' }, COORDINATOR));
    const result = await reader(rpc).instance.listEvents();
    expect(result.items.map(item => item.projectRoot)).toEqual([secondRoot, KEYS.project]);
    const searched = await reader(rpc).instance.listEvents({ search: 'earlier' });
    expect(searched.items.map(item => item.projectRoot)).toEqual([secondRoot]);
    expect(deriveEventAvailability(searched.items[0]!, NOW)).toBe('cancelled');
  });

  it('does not hide an invalid authored head behind a valid schema or choose a winner', async () => {
    const { rpc, state } = fixture();
    const invalid = rawEvent(entityKey(104), { ...state, operationId: 'invalid-fork' }, COORDINATOR);
    invalid.attributes.find(attribute => attribute.name === 'schema_version')!.value = 2; rpc.put(invalid);
    const result = await reader(rpc).instance.listEvents();
    const event = result.items[0]!; expect(event.state.status).toBe('unverified');
    expect(codes(event.diagnostics)).toEqual(expect.arrayContaining(['conflicting_heads', 'projection_mismatch']));
    expect(deriveEventAvailability(event, NOW)).toBe('unverified');
  });

  it('rejects event discovery authored by a stranger even when it names a real project', async () => {
    const { rpc, state } = fixture(); rpc.remove(STATE);
    rpc.put(rawEvent(STATE, state, STRANGER));
    const result = await reader(rpc).instance.listEvents();
    expect(result.items).toEqual([]); expect(codes(result.diagnostics)).toContain('foreign_author');
  });

  it.each(['foreign', 'expired', 'wrong-dates', 'wrong-namespace'] as const)('keeps %s releases unavailable', async fault => {
    const { rpc, release, state } = fixture();
    if (fault === 'foreign') rpc.put(rawEvent(RELEASE, release, STRANGER));
    if (fault === 'expired') rpc.row(RELEASE).expiresAt = toHex(100);
    if (fault === 'wrong-dates') rpc.put(rawEvent(STATE, { ...state, startsAt: state.startsAt - 1 }, COORDINATOR));
    if (fault === 'wrong-namespace') rpc.row(RELEASE).attributes.find(attribute => attribute.name === 'project')!.value = 'untrusted';
    const event = await reader(rpc).instance.loadEvent(KEYS.project);
    expect(event.release).toBeNull(); expect(event.diagnostics.length).toBeGreaterThan(0);
    expect(deriveEventAvailability(event, NOW)).toBe('unverified');
  });

  it('preserves an unavailable event in the wallet list and completes every attendance page', async () => {
    const { rpc, attendance } = fixture(); rpc.pageSize = 1;
    const missingRoot = entityKey(999);
    rpc.put(rawEvent(entityKey(110), { ...attendance, projectRoot: missingRoot, operationId: 'missing-event' }, STRANGER));
    const result = await reader(rpc).instance.listMyEvents({ kind: 'wallet', address: STRANGER });
    expect(result.items).toHaveLength(2);
    const unavailable = result.items.find(item => item.projectRoot === missingRoot)!;
    expect(unavailable.attendance.status).toBe('unique'); expect(unavailable.registeredRelease).toBeNull();
    expect(codes(unavailable.diagnostics)).toContain('missing_root');
    expect(result.snapshot.completeness).toBe('complete');
    expect(rpc.queries.filter(query => query.query.includes("entity_type = str('attendance_state')") && !query.query.includes('project_key')).length).toBe(2);
  });

  it('authenticates old registered terms separately from a changed current release', async () => {
    const { rpc, release, state } = fixture();
    const changedTerms = { ...terms, venue: 'Community hall', startsAt: terms.startsAt + 86_400_000, endsAt: terms.endsAt + 86_400_000 };
    const next: EventRelease = { ...release, operationId: 'release-2', terms: changedTerms, audienceHash: audienceHash(changedTerms), predecessorReleaseKey: RELEASE };
    rpc.put(rawEvent(entityKey(104), next, COORDINATOR));
    rpc.put(rawEvent(STATE, { ...state, releaseKey: entityKey(104), audienceHash: next.audienceHash,
      startsAt: changedTerms.startsAt, endsAt: changedTerms.endsAt }, COORDINATOR));
    const mine = (await reader(rpc).instance.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(mine.registeredRelease?.payload.terms.venue).toBe('Public library');
    expect(mine.event?.release?.payload.terms.venue).toBe('Community hall');
    expect(attendanceStatus(mine.attendance, mine.event!, NOW, mine.registeredRelease)).toBe('needs_review');
  });

  it('keeps malformed attendance forks visible and never treats them as a unique registration', async () => {
    const { rpc, attendance } = fixture(); rpc.pageSize = 1;
    const invalid = rawEvent(entityKey(104), { ...attendance, operationId: 'bad-attendance' }, STRANGER);
    invalid.attributes.find(attribute => attribute.name === 'schema_version')!.value = 2; rpc.put(invalid);
    const mine = (await reader(rpc).instance.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(mine.attendance.status).toBe('unverified');
    expect(codes(mine.diagnostics)).toContain('conflicting_heads');
    expect(attendanceStatus(mine.attendance, mine.event!, NOW)).toBe('unverified');
  });

  it.each(['first', 'last'] as const)('isolates unavailable event sources when the bad event is traversed %s', async order => {
    const { rpc, root, release, state, attendance } = fixture();
    const badRoot = entityKey(201), badRelease = entityKey(202), badState = entityKey(203), badCoreState = entityKey(204);
    const source = { ...state.source, projectRoot: badRoot };
    const coreState = readyFixture().state;
    const badRows = [
      rawEntity(badRoot, { ...root, coordinator: { kind: 'wallet', address: STRANGER } }, STRANGER),
      rawEntity(badCoreState, { ...coreState, projectRoot: badRoot, publisherRoots: [entityKey(999)] }, STRANGER),
      rawEvent(badRelease, { ...release, projectRoot: badRoot, source }, STRANGER),
      rawEvent(badState, { ...state, projectRoot: badRoot, releaseKey: badRelease, source }, STRANGER),
      rawEvent(entityKey(205), { ...attendance, projectRoot: badRoot, releaseKey: badRelease }, STRANGER),
    ];
    rpc.rows = order === 'first' ? [...badRows, ...rpc.rows] : [...rpc.rows, ...badRows];
    rpc.pageSize = 1;
    const catalogue = await reader(rpc).instance.listEvents();
    expect(catalogue.snapshot.completeness).toBe('complete'); expect(catalogue.snapshot.reasons).toEqual([]);
    const healthy = catalogue.items.find(item => item.projectRoot === KEYS.project)!;
    const bad = catalogue.items.find(item => item.projectRoot === badRoot)!;
    expect(deriveEventAvailability(healthy, NOW)).toBe('open');
    expect(deriveEventAvailability(bad, NOW)).toBe('unverified');
    expect(bad.sourceProject?.snapshot.completeness).toBe('incomplete');
    expect(healthy.sourceProject?.snapshot.completeness).toBe('complete');
    const mine = await reader(rpc).instance.listMyEvents({ kind: 'wallet', address: STRANGER });
    expect(mine.items).toHaveLength(2); expect(mine.snapshot.completeness).toBe('complete');
    const healthyRegistration = mine.items.find(item => item.projectRoot === KEYS.project)!;
    const badRegistration = mine.items.find(item => item.projectRoot === badRoot)!;
    expect(attendanceStatus(healthyRegistration.attendance, healthyRegistration.event!, NOW, healthyRegistration.registeredRelease)).toBe('going');
    expect(attendanceStatus(badRegistration.attendance, badRegistration.event!, NOW, badRegistration.registeredRelease)).toBe('unverified');
  });

  it.each(['missing', 'foreign', 'wrong-hash'] as const)('preserves the decision but cannot confirm a %s registered release', async fault => {
    const { rpc, attendance, release } = fixture();
    const oldKey = entityKey(110);
    rpc.put(rawEvent(ATTENDANCE, { ...attendance, releaseKey: oldKey }, STRANGER));
    if (fault === 'foreign') rpc.put(rawEvent(oldKey, release, STRANGER));
    if (fault === 'wrong-hash') {
      const different = { ...terms, conditions: 'Bring your own materials.' };
      rpc.put(rawEvent(oldKey, { ...release, terms: different, audienceHash: audienceHash(different) }, COORDINATOR));
    }
    const mine = (await reader(rpc).instance.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(mine.attendance.status).toBe('unique'); expect(mine.registeredRelease).toBeNull();
    expect(mine.diagnostics.length).toBeGreaterThan(0);
    expect(attendanceStatus(mine.attendance, mine.event!, NOW, mine.registeredRelease)).toBe('unverified');
    expect(deriveEventAvailability(mine.event!, NOW)).toBe('open');
  });

  it('pauses new registration when a required contributor withdraws without rewriting attendance', async () => {
    const { rpc, book } = fixture();
    book.decisions[0]!.status = 'withdrawn'; book.grants = []; rpc.update(KEYS.book, book);
    const mine = (await reader(rpc).instance.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(deriveEventAvailability(mine.event!, NOW)).toBe('paused');
    expect(attendanceStatus(mine.attendance, mine.event!, NOW)).toBe('going');
  });

  it.each(['cancelled', 'closed', 'ended'] as const)('authenticates %s independently of missing source contributors', async status => {
    const { rpc, state } = fixture(); rpc.remove(KEYS.publisher);
    rpc.put(rawEvent(STATE, { ...state, status }, COORDINATOR));
    const independent = reader(rpc).instance;
    const event = await independent.loadEvent(KEYS.project);
    expect(event.snapshot.completeness).toBe('complete'); expect(event.sourceProject).toBeNull();
    expect(deriveEventAvailability(event, NOW)).toBe(status);
    const myEvent = (await independent.listMyEvents({ kind: 'wallet', address: STRANGER })).items[0]!;
    expect(attendanceStatus(myEvent.attendance, myEvent.event!, NOW, myEvent.registeredRelease)).toBe(status === 'closed' ? 'going' : status);
    rpc.remove(RELEASE);
    expect(deriveEventAvailability(await independent.loadEvent(KEYS.project), NOW)).toBe('unverified');
  });

  it('explicitly loads a closed event source for the organizer through the repository contract', async () => {
    const { rpc, state } = fixture();
    rpc.put(rawEvent(STATE, { ...state, status: 'closed' }, COORDINATOR));
    const repository = new EventRepository({ request: rpc.request, now: () => NOW });
    const publicEvent = await repository.loadEvent(KEYS.project);
    expect(publicEvent.ok).toBe(true);
    if (!publicEvent.ok) throw new Error('The public event read failed.');
    expect(publicEvent.value.sourceProject).toBeNull();
    const organizerEvent = await repository.loadEvent(KEYS.project, { includeSource: true });
    expect(organizerEvent.ok).toBe(true);
    if (!organizerEvent.ok) throw new Error('The organizer event read failed.');
    expect(organizerEvent.value.sourceProject?.proposal?.key).toBe(KEYS.proposal);
    expect(organizerEvent.value.sourceProject?.snapshot.completeness).toBe('complete');
    expect(organizerEvent.value.sourceProject?.snapshot.blockNumber).toBe(organizerEvent.value.snapshot.blockNumber);
    expect(deriveEventAvailability(organizerEvent.value, NOW)).toBe('closed');
    expect(rpc.queries.every(query => query.options.atBlock === '0x64')).toBe(true);
  });

  it('keeps organizer source unavailability explicit and enforces freshness on requested source reads', async () => {
    const { rpc, state } = fixture(); rpc.remove(KEYS.publisher);
    rpc.put(rawEvent(STATE, { ...state, status: 'closed' }, COORDINATOR));
    const event = await reader(rpc).instance.loadEvent(KEYS.project, { includeSource: true });
    expect(event.sourceProject?.snapshot.completeness).toBe('incomplete');
    expect(deriveEventAvailability(event, NOW)).toBe('closed');
    await rejects(new EventReader({ request: rpc.request, now: () => NOW + 60_001 })
      .loadEvent(KEYS.project, { includeSource: true }), 'stale_snapshot');
  });

  it('explicitly skips an open event source during a contributor RPC outage without claiming it is open', async () => {
    const { rpc } = fixture();
    rpc.queryOverride = call => {
      if (call.query.includes("entity_type = str('book_state')")) throw new Error('Contributor RPC unavailable');
      return undefined;
    };
    const repository = new EventRepository({ request: rpc.request, now: () => NOW });
    for (const options of [undefined, { includeSource: true }]) {
      const failed = await repository.loadEvent(KEYS.project, options);
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error('Contributor traversal failure must fail the source read.');
      expect(failed.error.code).toBe('network');
      expect(codes(failed.error.reasons)).toContain('rpc_error');
    }
    const beforeEnvelope = rpc.queries.length;
    const envelope = await repository.loadEvent(KEYS.project, { includeSource: false });
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('The independently authenticated event envelope should remain readable.');
    expect(envelope.value.root?.key).toBe(KEYS.project);
    expect(envelope.value.state).toMatchObject({ status: 'unique', entity: { key: STATE, payload: { status: 'open' } } });
    expect(envelope.value.release?.key).toBe(RELEASE);
    expect(envelope.value.sourceProject).toBeNull();
    expect(envelope.value.diagnostics).toEqual([]);
    expect(envelope.value.snapshot.completeness).toBe('complete');
    expect(deriveEventAvailability(envelope.value, NOW)).toBe('unverified');
    expect(rpc.queries.slice(beforeEnvelope).every(query => !query.query.includes("entity_type = str('book_state')"))).toBe(true);
  });

  it('restores authenticated own decisions across events without contributor reads when explicitly requested', async () => {
    const { rpc, root, release, state, attendance } = fixture(); rpc.pageSize = 1;
    const otherRoot = entityKey(211), otherRelease = entityKey(212), otherState = entityKey(213), otherAttendance = entityKey(214);
    const source = { ...state.source, projectRoot: otherRoot };
    rpc.put(rawEntity(otherRoot, root, COORDINATOR));
    rpc.put(rawEvent(otherRelease, { ...release, projectRoot: otherRoot, source }, COORDINATOR));
    rpc.put(rawEvent(otherState, { ...state, projectRoot: otherRoot, releaseKey: otherRelease, source }, COORDINATOR));
    rpc.put(rawEvent(otherAttendance, { ...attendance, projectRoot: otherRoot, releaseKey: otherRelease }, STRANGER));
    rpc.put(rawEvent(entityKey(215), { ...attendance, attendee: COORDINATOR }, COORDINATOR));
    rpc.queryOverride = call => {
      if (call.query.includes("entity_type = str('book_state')")) throw new Error('Contributor RPC unavailable');
      return undefined;
    };
    const repository = new EventRepository({ request: rpc.request, now: () => NOW });
    for (const options of [undefined, { includeSource: true }]) {
      const strict = await repository.listMyEvents({ kind: 'wallet', address: STRANGER }, options);
      expect(strict.ok).toBe(false);
      if (strict.ok) throw new Error('The requested source traversal must report the contributor RPC failure.');
      expect(strict.error.code).toBe('network');
    }
    const beforeEnvelope = rpc.queries.length;
    const saved = await repository.listMyEvents({ kind: 'wallet', address: STRANGER }, { includeSource: false });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('Own authenticated decisions should remain readable for withdrawal.');
    expect(saved.value.items).toHaveLength(2); expect(saved.value.diagnostics).toEqual([]);
    expect(saved.value.snapshot.completeness).toBe('complete');
    for (const item of saved.value.items) {
      expect(item.attendance).toMatchObject({ status: 'unique', entity: { provenance: { creator: { kind: 'wallet', address: STRANGER } }, payload: { decision: 'going' } } });
      expect(item.registeredRelease?.key).toBe(item.projectRoot === KEYS.project ? RELEASE : otherRelease);
      expect(item.event?.state.status).toBe('unique'); expect(item.event?.release?.key).toBe(item.registeredRelease?.key);
      expect(item.event?.sourceProject).toBeNull(); expect(item.diagnostics).toEqual([]);
      expect(deriveEventAvailability(item.event!, NOW)).toBe('unverified');
      expect(attendanceStatus(item.attendance, item.event!, NOW, item.registeredRelease)).toBe('unverified');
    }
    expect(rpc.queries.slice(beforeEnvelope).every(query => !query.query.includes("entity_type = str('book_state')"))).toBe(true);
  });

  it('rejects the whole catalogue when the bounded traversal cannot finish', async () => {
    const { rpc, state } = fixture(); rpc.pageSize = 1;
    rpc.put(rawEvent(entityKey(104), { ...state, operationId: 'another-head' }, COORDINATOR));
    await rejects(reader(rpc, { maxPages: 1 }).instance.listEvents(), 'page_budget');
  });

  it('still fails the whole traversal if a source child context reaches a query budget or mixed block', async () => {
    const { rpc } = fixture();
    await rejects(reader(rpc, { maxPages: 6 }).instance.listEvents(), 'page_budget');
    rpc.queryOverride = (call, response) => call.query.includes("entity_type = str('book_state')")
      ? { ...response, blockNumber: toHex(99) } : response;
    await rejects(reader(rpc).instance.listEvents(), 'incomplete_snapshot');
  });

  it('rejects mixed query blocks and stalled latest snapshots', async () => {
    const { rpc } = fixture(); rpc.queryOverride = (_call, response) => ({ ...response, blockNumber: toHex(99) });
    await rejects(reader(rpc).instance.listEvents(), 'incomplete_snapshot');
    rpc.queryOverride = undefined;
    await rejects(new EventReader({ request: rpc.request, now: () => NOW + 60_001 }).listEvents(), 'stale_snapshot');
  });
});
