import { i32, key, u64 } from '@arkiv-network/sdk/attr';
import { eq, gte, lte } from '@arkiv-network/sdk/query';
import type { Expression } from '@arkiv-network/sdk/query';
import { validateEventReleaseBinding } from '../../domain/events';
import type { AttendanceState, EventAggregate, EventPayload, EventRecord, EventRelease, EventScope, EventState } from '../../domain/events';
import type { AccountAddress, Actor, DomainReason, EntityKey, ProjectRoot } from '../../domain/types';
import type { ListResult, ReadOptions } from '../types';
import { ArkivReader } from '../arkiv/reader';
import type { ArkivReaderOptions, ReadContext } from '../arkiv/reader';
import { ArkivRepositoryError, assertArkiv, repositoryError } from '../arkiv/errors';
import { creatorOf, publicAddress, publicKey, sameIdentity } from '../arkiv/envelope';
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
    sourcePolicy: 'automatic' | 'required' | 'skip' = 'automatic'): Promise<EventAggregate> {
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
    // Terminal audience outcomes are authenticated by the event envelope itself. A missing
    // contributor must not erase a coordinator's cancellation or prevent publishing it.
    // Publication/opening explicitly requests the source, and a live open page always reads it.
    const needsSource = sourcePolicy === 'required' || (sourcePolicy === 'automatic'
      && (result.state.status === 'missing' || (result.state.status === 'unique' && result.state.entity.payload.status === 'open'
        && (!result.release || result.release.payload.terms.endsAt > context.snapshot.blockTimestamp))));
    if (!needsSource) return result;
    // Source availability belongs to this event. One unrelated publisher's missing
    // record must not change another catalogue item's confidence. Queries still share
    // the exact block, authenticated entity cache and cumulative traversal budgets.
    const sourceContext: ReadContext = { ...context, snapshot: structuredClone(context.snapshot), publishers: new Map() };
    try {
      result.sourceProject = await this.core.project(sourceContext, target);
      const traversal = [...sourceContext.snapshot.reasons, ...(result.sourceProject.proposalHistoryStatus?.reasons ?? [])].find(reason =>
        ['page_budget', 'cursor_error', 'incomplete_snapshot', 'stale_snapshot', 'rpc_error'].includes(reason.code));
      if (traversal) throw new ArkivRepositoryError('incomplete', traversal.code, 'The event source read could not complete at the pinned block.');
    } catch (error) { result.diagnostics.push(...targetReasons(error)); }
    finally { context.pages = sourceContext.pages; context.entities = sourceContext.entities; }
    return result;
  }

  async loadEvent(projectRoot: EntityKey, options: EventReadOptions = {}): Promise<EventAggregate> {
    const context = await this.core.context(options);
    const result = await this.event(context, projectRoot, options.includeSource ? 'required' : 'automatic');
    await this.core.finish(context); return result;
  }

  async listEvents(filters: EventFilters = {}, options: ReadOptions = {}): Promise<ListResult<EventAggregate>> {
    for (const value of [filters.from, filters.to]) assertArkiv(value === undefined
      || (Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000), 'invalid_input', 'invalid_input', 'Event date filters must be UTC milliseconds.');
    assertArkiv(filters.from === undefined || filters.to === undefined || filters.from <= filters.to,
      'invalid_input', 'invalid_input', 'The event date interval is reversed.');
    assertArkiv(filters.search === undefined || (typeof filters.search === 'string' && filters.search.length <= 200),
      'invalid_input', 'invalid_input', 'The event title search exceeds its limit.');
    const context = await this.core.context(options); const predicates = this.base('event_state');
    if (filters.from !== undefined) predicates.push(gte('ends_at', u64(BigInt(filters.from))));
    if (filters.to !== undefined) predicates.push(lte('starts_at', u64(BigInt(filters.to))));
    const rows = await this.core.query(context, predicates);
    const items: EventAggregate[] = []; const diagnostics: DomainReason[] = []; const seen = new Set<string>();
    const search = (filters.search ?? '').trim().toLocaleLowerCase('en');
    for (const row of rows) {
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
        items.push(aggregate);
      } catch (error) { diagnostics.push(...targetReasons(error)); }
    }
    items.sort((a, b) => (a.release?.payload.terms.startsAt ?? (a.state.status === 'unique' ? a.state.entity.payload.startsAt : Infinity))
      - (b.release?.payload.terms.startsAt ?? (b.state.status === 'unique' ? b.state.entity.payload.startsAt : Infinity))
      || a.projectRoot.localeCompare(b.projectRoot));
    await this.core.finish(context); return { items, snapshot: context.snapshot, diagnostics };
  }

  async listMyEvents(actor: Actor, options: ReadOptions = {}): Promise<ListResult<MyEvent>> {
    const account = this.core.walletActor(actor); const context = await this.core.context(options);
    // Include malformed authored heads so an invalid second head cannot disappear from a wallet's list.
    const rows = await this.core.query(context, [eq('project', EVENTS_NAMESPACE), eq('entity_type', 'attendance_state')], account);
    const roots = new Set<string>(); const diagnostics: DomainReason[] = [];
    for (const row of rows) {
      try {
        const projection = row.attributes?.project_key;
        assertArkiv(projection?.type === 'key', 'unverified', 'projection_mismatch', 'An attendance record has no event identity projection.');
        roots.add(publicKey(projection.value));
      } catch (error) { diagnostics.push(...targetReasons(error)); }
    }
    const items: MyEvent[] = [];
    for (const rootKey of roots) {
      const projectRoot = publicKey(rootKey);
      const attendance = await this.scope<AttendanceState>(context, 'attendance_state', projectRoot, account);
      const item: MyEvent = { projectRoot, attendance, event: null, registeredRelease: null, diagnostics: [...scopeReasons(attendance)] };
      item.event = await this.event(context, projectRoot);
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
