import { i32, key, u64 } from '@arkiv-network/sdk/attr';
import { eq, gte, lte } from '@arkiv-network/sdk/query';
import type { Expression } from '@arkiv-network/sdk/query';
import { deriveEventAvailability, validateEventReleaseBinding } from '../../domain/events';
import type { AttendanceState, EventAggregate, EventPayload, EventRecord, EventRelease, EventRoster, EventScope, EventState } from '../../domain/events';
import type { AccountAddress, Actor, DomainReason, EntityKey, ProjectRoot } from '../../domain/types';
import type { ListResult, ReadOptions } from '../types';
import { ArkivReader } from '../arkiv/reader';
import type { ArkivReaderOptions, ReadContext } from '../arkiv/reader';
import { ArkivRepositoryError, assertArkiv, repositoryError } from '../arkiv/errors';
import { creatorOf, publicAddress, publicKey, sameIdentity } from '../arkiv/envelope';
import { MAX_HEADER_BATCH_SIZE, readBlockHeaders } from '../arkiv/read-policy';
import { EVENTS_NAMESPACE, decodeEventEntity } from './envelope';
import type { EventFilters, EventReadOptions, MyEvent } from './types';

/** A missing or invalid target is local evidence; an interrupted traversal is never a complete list. */
function targetReasons(error: unknown): DomainReason[] {
  const detail = repositoryError(error);
  if (!(error instanceof ArkivRepositoryError)
    || !['unverified', 'invalid_input', 'expired', 'not_found', 'payload_too_large'].includes(detail.code)
    || detail.reasons.some(reason => ['page_budget', 'cursor_error', 'incomplete_snapshot', 'stale_snapshot', 'rpc_error'].includes(reason.code))) throw error;
  return detail.reasons;
}

function eventCreator(record: EventRecord): AccountAddress {
  assertArkiv(record.provenance.creator.kind === 'wallet', 'unverified', 'foreign_author', 'The event has no wallet creator.');
  return publicAddress(record.provenance.creator.address);
}

function scopeReasons(scope: EventScope<EventPayload>): DomainReason[] {
  return scope.status === 'unique' ? [] : scope.status === 'unverified' ? scope.reasons
    : [{ code: scope.status === 'conflict' ? 'conflicting_heads' : 'missing_state' }];
}

/** The extension shares the core RPC, limits, canonical block and complete-page walker. */
export class EventReader {
  readonly core: ArkivReader;
  private readonly caches = new WeakMap<ReadContext, Map<string, EventRecord>>();
  constructor(options: ArkivReaderOptions = {}) { this.core = new ArkivReader(options); }

  base(type: EventPayload['entityType']): Expression[] {
    return [eq('project', EVENTS_NAMESPACE), eq('entity_type', type), eq('schema_version', i32(1))];
  }

  async entity<T extends EventPayload>(context: ReadContext, entityKey: EntityKey,
    type: T['entityType'], creator?: AccountAddress): Promise<EventRecord<T> | null> {
    this.core.checkAbort(context.options);
    const target = publicKey(entityKey);
    let cache = this.caches.get(context);
    if (!cache) { cache = new Map(); this.caches.set(context, cache); }
    const cached = cache.get(target);
    if (cached) {
      assertArkiv(cached.payload.entityType === type && (!creator || sameIdentity(eventCreator(cached), creator)),
        'unverified', 'foreign_author', 'An event reference has conflicting expected type or authority.');
      return cached as EventRecord<T>;
    }
    // An exact reference must expose wrong namespaces, types and creators rather than filter them away.
    const rows = await this.core.query(context, [eq('$key', key(target))], undefined, true);
    assertArkiv(rows.length <= 1, 'unverified', 'incomplete_snapshot', 'An exact event key returned multiple entities.');
    if (!rows[0]) return null;
    const record = decodeEventEntity<T>(rows[0], type, context.snapshot, creator, target);
    cache.set(target, record); return record;
  }

  async scope<T extends EventState | AttendanceState>(context: ReadContext, type: T['entityType'],
    projectRoot: EntityKey, creator: AccountAddress): Promise<EventScope<T>> {
    this.core.checkAbort(context.options);
    const target = publicKey(projectRoot);
    // No schema or date filter: every authored head must participate in conflict detection.
    const rows = await this.core.query(context, [eq('project', EVENTS_NAMESPACE), eq('entity_type', type),
      eq('project_key', key(target))], publicAddress(creator));
    if (!rows.length) return { status: 'missing', reason: 'expired_or_deleted' };
    const records: EventRecord<T>[] = []; const invalid: DomainReason[] = [];
    for (const row of rows) {
      try {
        const record = decodeEventEntity<T>(row, type, context.snapshot, creator);
        assertArkiv(sameIdentity(record.payload.projectRoot, target), 'unverified', 'scope_mismatch', 'The event head belongs to another project.');
        records.push(record);
      } catch (error) { invalid.push(...targetReasons(error)); }
    }
    if (invalid.length) return { status: 'unverified', reasons: [...(rows.length > 1 ? [{ code: 'conflicting_heads' } as DomainReason] : []), ...invalid] };
    return records.length > 1 ? { status: 'conflict', entities: records } : { status: 'unique', entity: records[0]! };
  }

  async event(context: ReadContext, projectRoot: EntityKey,
    sourcePolicy: 'automatic' | 'required' | 'skip' = 'automatic', includeRoster = true): Promise<EventAggregate> {
    this.core.checkAbort(context.options);
    const target = publicKey(projectRoot);
    const result: EventAggregate = { projectRoot: target, root: null, state: { status: 'missing', reason: 'not_found' },
      release: null, sourceProject: null, snapshot: context.snapshot, diagnostics: [] };
    try { result.root = await this.core.entity<ProjectRoot>(context, target, 'project_root'); }
    catch (error) {
      result.diagnostics.push(...targetReasons(error));
      result.state = { status: 'unverified', reasons: result.diagnostics }; return result;
    }
    if (!result.root) { result.diagnostics.push({ code: 'missing_root' }); return result; }
    const creator = creatorOf(result.root);
    result.state = await this.scope<EventState>(context, 'event_state', target, creator);
    result.diagnostics.push(...scopeReasons(result.state));
    if (result.state.status === 'unique') {
      try {
        const release = await this.entity<EventRelease>(context, result.state.entity.payload.releaseKey, 'event_release', creator);
        if (!release) result.diagnostics.push({ code: 'evidence_unavailable', path: 'release' });
        else {
          const binding = validateEventReleaseBinding(result.state.entity.payload, release);
          if (!binding.valid) result.diagnostics.push(...binding.reasons);
          else result.release = release;
        }
      } catch (error) { result.diagnostics.push(...targetReasons(error)); }
    }
    if (includeRoster && result.release?.payload.terms.termsVersion === 2) result.roster = await this.roster(context, result);
    // Terminal audience outcomes are authenticated by the event envelope itself. A missing
    // contributor must not erase a coordinator's cancellation or prevent publishing it.
    // Publication/opening explicitly requests the source; an ordinary live open page reads it too.
    // Explicit envelope-only reads let the organizer close or cancel during a contributor outage.
    const needsSource = sourcePolicy === 'required' || (sourcePolicy === 'automatic'
      && (result.state.status === 'missing' || (result.state.status === 'unique' && result.state.entity.payload.status === 'open'
        && (!result.release || result.release.payload.terms.endsAt > context.snapshot.blockTimestamp))));
    if (!needsSource) return result;
    // Source availability belongs to this event. One unrelated publisher's missing
    // record must not change another catalogue item's confidence. Queries still share
    // the exact block, authenticated entity cache and cumulative traversal budgets.
    const sourceContext: ReadContext = { ...context, snapshot: structuredClone(context.snapshot), publishers: new Map() };
    try {
      this.core.checkAbort(context.options);
      result.sourceProject = await this.core.project(sourceContext, target);
      const traversal = [...sourceContext.snapshot.reasons, ...(result.sourceProject.proposalHistoryStatus?.reasons ?? [])].find(reason =>
        ['page_budget', 'cursor_error', 'incomplete_snapshot', 'stale_snapshot', 'rpc_error'].includes(reason.code));
      if (traversal) throw new ArkivRepositoryError('incomplete', traversal.code, 'The event source read could not complete at the pinned block.');
    } catch (error) { result.diagnostics.push(...targetReasons(error)); }
    finally { context.pages = sourceContext.pages; context.entities = sourceContext.entities; }
    return result;
  }

  /** A complete pinned creator-authenticated request set; arbitrary namespaces are only discovery hints. */
  async roster(context: ReadContext, event: EventAggregate): Promise<EventRoster> {
    this.core.checkAbort(context.options);
    const result: EventRoster = { entries: [], snapshot: context.snapshot, diagnostics: [] };
    const rows = await this.core.query(context, [eq('project', EVENTS_NAMESPACE), eq('entity_type', 'attendance_state'),
      eq('project_key', key(publicKey(event.projectRoot)))]);
    const groups = new Map<AccountAddress, typeof rows>();
    for (const row of rows) {
      const creator = publicAddress(row.creator);
      groups.set(creator, [...(groups.get(creator) ?? []), row]);
    }
    const historicalBlocks = new Set<string>();
    for (const [attendee, records] of groups) {
      this.core.checkAbort(context.options);
      const valid: EventRecord<AttendanceState>[] = []; const reasons: DomainReason[] = [];
      for (const row of records) {
        try {
          const record = decodeEventEntity<AttendanceState>(row, 'attendance_state', context.snapshot, attendee);
          assertArkiv(record.payload.projectRoot === event.projectRoot, 'unverified', 'scope_mismatch', 'The attendance scope disagrees with its event.');
          valid.push(record);
        } catch (error) { reasons.push(...targetReasons(error)); }
      }
      const attendance: EventScope<AttendanceState> = reasons.length ? { status: 'unverified', reasons }
        : valid.length !== 1 ? { status: 'conflict', entities: valid } : { status: 'unique', entity: valid[0]! };
      if (attendance.status === 'unique' && attendance.entity.provenance.createdAtBlock !== context.snapshot.blockNumber) {
        historicalBlocks.add(attendance.entity.provenance.createdAtBlock!);
      }
      result.entries.push({ attendee, attendance, registeredRelease: null, inclusionTimestamp: null });
    }
    // Authenticate distinct creation blocks in bounded standard RPC batches. The complete
    // request set and both independent header passes remain at the same pinned snapshot.
    const times = await this.inclusionHeaders(context, [...historicalBlocks]);
    for (const entry of result.entries) {
      this.core.checkAbort(context.options);
      const attendance = entry.attendance;
      if (attendance.status === 'unique') {
        const record = attendance.entity; const blockNumber = record.provenance.createdAtBlock!;
        if (blockNumber === context.snapshot.blockNumber) {
          // The context already authenticates this block; finish() checks it again after the walk.
          entry.inclusionTimestamp = context.snapshot.blockTimestamp;
        } else entry.inclusionTimestamp = times.get(blockNumber)!.timestamp;
        try {
          entry.registeredRelease = await this.entity<EventRelease>(context, record.payload.releaseKey, 'event_release', creatorOf(event.root!));
          if (entry.registeredRelease && (entry.registeredRelease.payload.projectRoot !== event.projectRoot
            || entry.registeredRelease.payload.audienceHash !== record.payload.audienceHash)) entry.registeredRelease = null;
        } catch (error) { targetReasons(error); }
      }
    }
    const checkedTimes = await this.inclusionHeaders(context, [...historicalBlocks]);
    for (const [blockNumber, expected] of times) {
      const checked = checkedTimes.get(blockNumber)!;
      assertArkiv(checked.hash === expected.hash && checked.timestamp === expected.timestamp,
        'unverified', 'incomplete_snapshot', 'A request inclusion block changed during roster verification.');
    }
    result.entries.sort((a, b) => {
      if (a.attendance.status !== 'unique') return b.attendance.status === 'unique' ? 1 : a.attendee.localeCompare(b.attendee);
      if (b.attendance.status !== 'unique') return -1;
      const left = BigInt(a.attendance.entity.provenance.createdAtBlock!); const right = BigInt(b.attendance.entity.provenance.createdAtBlock!);
      return left < right ? -1 : left > right ? 1 : a.attendance.entity.key.localeCompare(b.attendance.entity.key);
    });
    // Every explicit reservation still occupies a place; missing evidence never silently frees one.
    if (event.state.status === 'unique') for (const admission of event.state.entity.payload.admissions ?? []) {
      const entry = result.entries.find(candidate => candidate.attendee === admission.attendee);
      if (!entry || entry.attendance.status !== 'unique') { result.diagnostics.push({ code: 'evidence_unavailable', path: 'admissions' }); continue; }
      const request = entry.attendance.entity;
      if (request.key !== admission.attendanceKey) {
        // A live unique same-creator decision makes the old reservation obsolete. Its place stays
        // occupied, but no inferred/deleted lineage can transfer confirmation to this current key.
        continue;
      }
      const release = entry.registeredRelease;
      if (!release || release.key !== admission.releaseKey || request.payload.decision !== 'going'
        || (release.payload.terms.registration?.deadline != null && (entry.inclusionTimestamp === null
          || (entry.inclusionTimestamp >= release.payload.terms.registration.deadline
            && !release.payload.reconfirmationAccounts?.includes(admission.attendee))))
        || (release.payload.terms.registration?.admission === 'invite_only'
          && !release.payload.terms.registration.invitedAccounts.includes(admission.attendee))) {
        result.diagnostics.push({ code: 'evidence_unavailable', path: 'admissions' });
      }
    }
    return result;
  }

  private async inclusionHeaders(context: ReadContext, blockNumbers: string[]): Promise<Map<string, { timestamp: number; hash: string }>> {
    const result = new Map<string, { timestamp: number; hash: string }>();
    for (let offset = 0; offset < blockNumbers.length; offset += MAX_HEADER_BATCH_SIZE) {
      this.core.checkAbort(context.options);
      const chunk = blockNumbers.slice(offset, offset + MAX_HEADER_BATCH_SIZE);
      const headers = await readBlockHeaders(this.core.request, chunk.map(BigInt), { signal: context.options.signal });
      this.core.checkAbort(context.options);
      assertArkiv(Array.isArray(headers) && headers.length === chunk.length, 'unverified', 'incomplete_snapshot', 'The request inclusion blocks are incomplete.');
      for (const [index, blockNumber] of chunk.entries()) {
        const block = headers[index] as { number?: unknown; timestamp?: unknown; hash?: unknown } | null;
        const quantity = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]+$/i.test(value);
        assertArkiv(block && quantity(block.number) && quantity(block.timestamp) && typeof block.hash === 'string' && /^0x[\da-f]{64}$/i.test(block.hash),
          'unverified', 'incomplete_snapshot', 'The request inclusion block could not be authenticated.');
        const timestamp = Number(BigInt(block.timestamp) * 1_000n);
        assertArkiv(BigInt(block.number) === BigInt(blockNumber) && Number.isSafeInteger(timestamp)
          && timestamp >= 0 && timestamp <= context.snapshot.blockTimestamp,
        'unverified', 'incomplete_snapshot', 'The request inclusion block could not be authenticated.');
        result.set(blockNumber, { timestamp, hash: block.hash });
      }
    }
    return result;
  }

  async loadEvent(projectRoot: EntityKey, options: EventReadOptions = {}): Promise<EventAggregate> {
    const context = await this.core.context(options);
    const result = await this.event(context, projectRoot, options.includeSource === false ? 'skip'
      : options.includeSource === true ? 'required' : 'automatic');
    await this.core.finish(context); return result;
  }

  async listEvents(filters: EventFilters = {}, options: ReadOptions = {}): Promise<ListResult<EventAggregate>> {
    for (const value of [filters.from, filters.to, filters.deadlineBefore]) assertArkiv(value === undefined
      || (Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000), 'invalid_input', 'invalid_input', 'Event date filters must be UTC milliseconds.');
    assertArkiv(filters.from === undefined || filters.to === undefined || filters.from <= filters.to,
      'invalid_input', 'invalid_input', 'The event date interval is reversed.');
    assertArkiv(filters.search === undefined || (typeof filters.search === 'string' && filters.search.length <= 200),
      'invalid_input', 'invalid_input', 'The event title search exceeds its limit.');
    assertArkiv(filters.format === undefined || ['online', 'in_person', 'hybrid'].includes(filters.format), 'invalid_input', 'invalid_input', 'Unknown event format.');
    assertArkiv(filters.countryCode === undefined || /^[A-Z]{2}$/.test(filters.countryCode), 'invalid_input', 'invalid_input', 'Use a two-letter country code.');
    assertArkiv(filters.city === undefined || (typeof filters.city === 'string' && filters.city.length <= 200), 'invalid_input', 'invalid_input', 'Invalid city filter.');
    assertArkiv(filters.availability === undefined || ['open', 'paused', 'closed', 'cancelled', 'ended', 'unverified', 'registration_closed', 'full', 'waitlist'].includes(filters.availability),
      'invalid_input', 'invalid_input', 'Unknown registration availability filter.');
    const context = await this.core.context(options); const predicates = this.base('event_state');
    if (filters.from !== undefined) predicates.push(gte('ends_at', u64(BigInt(filters.from))));
    if (filters.to !== undefined) predicates.push(lte('starts_at', u64(BigInt(filters.to))));
    const rows = await this.core.query(context, predicates);
    const items: EventAggregate[] = []; const diagnostics: DomainReason[] = []; const seen = new Set<string>();
    const search = (filters.search ?? '').trim().toLocaleLowerCase('en');
    for (const row of rows) {
      this.core.checkAbort(context.options);
      try {
        const candidate = decodeEventEntity<EventState>(row, 'event_state', context.snapshot);
        const target = publicKey(candidate.payload.projectRoot);
        // A namespace match is only a discovery hint. Authenticate against the immutable root first.
        const root = await this.core.entity<ProjectRoot>(context, target, 'project_root');
        assertArkiv(root, 'not_found', 'missing_root', 'The discovered event project is unavailable.');
        assertArkiv(sameIdentity(eventCreator(candidate), creatorOf(root)), 'unverified', 'foreign_author', 'A foreign publisher cannot create an event for another project.');
        if (seen.has(target)) continue;
        seen.add(target);
        const aggregate = await this.event(context, target);
        if (search && !aggregate.release?.payload.terms.title.toLocaleLowerCase('en').includes(search)) continue;
        const terms = aggregate.release?.payload.terms;
        if (filters.format && terms?.format !== filters.format) continue;
        if (filters.countryCode && terms?.location?.countryCode !== filters.countryCode) continue;
        if (filters.city && terms?.location?.city.toLocaleLowerCase('en') !== filters.city.trim().toLocaleLowerCase('en')) continue;
        if (filters.availability && deriveEventAvailability(aggregate, this.core.now()) !== filters.availability) continue;
        if (filters.deadlineBefore !== undefined && (terms?.registration?.deadline == null || terms.registration.deadline > filters.deadlineBefore)) continue;
        items.push(aggregate);
      } catch (error) { diagnostics.push(...targetReasons(error)); }
    }
    items.sort((a, b) => (a.release?.payload.terms.startsAt ?? (a.state.status === 'unique' ? a.state.entity.payload.startsAt : Infinity))
      - (b.release?.payload.terms.startsAt ?? (b.state.status === 'unique' ? b.state.entity.payload.startsAt : Infinity))
      || a.projectRoot.localeCompare(b.projectRoot));
    await this.core.finish(context); return { items, snapshot: context.snapshot, diagnostics };
  }

  async listMyEvents(actor: Actor, options: EventReadOptions = {}): Promise<ListResult<MyEvent>> {
    const account = this.core.walletActor(actor); const context = await this.core.context(options);
    // Include malformed authored heads so an invalid second head cannot disappear from a wallet's list.
    const rows = await this.core.query(context, [eq('project', EVENTS_NAMESPACE), eq('entity_type', 'attendance_state')], account);
    const roots = new Set<string>(); const diagnostics: DomainReason[] = [];
    for (const row of rows) {
      this.core.checkAbort(context.options);
      try {
        const projection = row.attributes?.project_key;
        assertArkiv(projection?.type === 'key', 'unverified', 'projection_mismatch', 'An attendance record has no event identity projection.');
        roots.add(publicKey(projection.value));
      } catch (error) { diagnostics.push(...targetReasons(error)); }
    }
    const items: MyEvent[] = [];
    for (const rootKey of roots) {
      this.core.checkAbort(context.options);
      const projectRoot = publicKey(rootKey);
      const attendance = await this.scope<AttendanceState>(context, 'attendance_state', projectRoot, account);
      const item: MyEvent = { projectRoot, attendance, event: null, registeredRelease: null, diagnostics: [...scopeReasons(attendance)] };
      item.event = await this.event(context, projectRoot, options.includeSource === false ? 'skip'
        : options.includeSource === true ? 'required' : 'automatic');
      item.diagnostics.push(...item.event.diagnostics);
      if (attendance.status === 'unique' && item.event.root) {
        try {
          const accepted = attendance.entity.payload;
          const release = await this.entity<EventRelease>(context, accepted.releaseKey, 'event_release', creatorOf(item.event.root));
          assertArkiv(release, 'not_found', 'evidence_unavailable', 'The registered event terms are unavailable.');
          assertArkiv(sameIdentity(release.payload.projectRoot, projectRoot)
            && sameIdentity(release.payload.audienceHash, accepted.audienceHash), 'unverified', 'hash_mismatch', 'The registration does not match its referenced event terms.');
          item.registeredRelease = release;
        } catch (error) { item.diagnostics.push(...targetReasons(error)); }
      }
      items.push(item);
    }
    items.sort((a, b) => (a.event?.release?.payload.terms.startsAt ?? a.registeredRelease?.payload.terms.startsAt ?? Infinity)
      - (b.event?.release?.payload.terms.startsAt ?? b.registeredRelease?.payload.terms.startsAt ?? Infinity)
      || a.projectRoot.localeCompare(b.projectRoot));
    await this.core.finish(context); return { items, snapshot: context.snapshot, diagnostics };
  }
}

/** Compatibility name for clients describing the network adapter explicitly. */
export { EventReader as ArkivEventReader };
