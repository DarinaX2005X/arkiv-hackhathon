import type {
  AccountAddress, ContentHash, DomainReason, EntityKey, EntityProvenance, EntityRecord,
  OperationId, ProjectAggregate, ProjectRoot, Snapshot, SourcePlanRef, UtcMilliseconds,
} from '../types';

/** Independent extension: the original partfolk/1 payloads and consent hashes stay unchanged. */
export const EVENTS_PROTOCOL = 'partfolk-events/1' as const;
export const EVENTS_SCHEMA_VERSION = 1 as const;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
export type EventEntityType = 'event_release' | 'event_state' | 'attendance_state';

export interface AudienceTerms {
  title: string;
  description: string;
  startsAt: UtcMilliseconds;
  endsAt: UtcMilliseconds;
  timeZone: string;
  venue: string;
  instructions: string;
  conditions: string;
}

export interface EventPayloadBase {
  protocol: typeof EVENTS_PROTOCOL;
  schemaVersion: typeof EVENTS_SCHEMA_VERSION;
  operationId: OperationId;
  createdAt: UtcMilliseconds;
}

export interface EventRelease extends EventPayloadBase {
  entityType: 'event_release';
  projectRoot: EntityKey;
  predecessorReleaseKey: EntityKey | null;
  terms: AudienceTerms;
  audienceHash: ContentHash;
  /** The source at publication; a later internal repair need not change audience terms. */
  source: SourcePlanRef;
}

export interface EventState extends EventPayloadBase {
  entityType: 'event_state';
  projectRoot: EntityKey;
  releaseKey: EntityKey;
  audienceHash: ContentHash;
  /** Authenticated copies of release dates permit catalogue queries over the current heads. */
  startsAt: UtcMilliseconds;
  endsAt: UtcMilliseconds;
  source: SourcePlanRef;
  status: 'open' | 'closed' | 'cancelled' | 'ended';
  predecessorKeys: EntityKey[];
}

export interface AttendanceState extends EventPayloadBase {
  entityType: 'attendance_state';
  projectRoot: EntityKey;
  attendee: AccountAddress;
  /** Consent applies to this exact audience version, including when a later release repeats its hash. */
  releaseKey: EntityKey;
  audienceHash: ContentHash;
  decision: 'going' | 'withdrawn';
  predecessorKeys: EntityKey[];
}

export type EventPayload = EventRelease | EventState | AttendanceState;
export interface EventRecord<T extends EventPayload = EventPayload> {
  key: EntityKey;
  payload: T;
  provenance: EntityProvenance;
}
export type EventScope<T extends EventPayload> =
  | { status: 'unique'; entity: EventRecord<T> }
  | { status: 'missing'; reason: 'not_initialized' | 'expired_or_deleted' | 'not_found' }
  | { status: 'conflict'; entities: EventRecord<T>[] }
  | { status: 'unverified'; reasons: DomainReason[] };

export interface EventAggregate {
  projectRoot: EntityKey;
  root: EntityRecord<ProjectRoot> | null;
  state: EventScope<EventState>;
  release: EventRecord<EventRelease> | null;
  sourceProject: ProjectAggregate | null;
  snapshot: Snapshot;
  diagnostics: DomainReason[];
}

export type EventAvailability = 'open' | 'paused' | 'closed' | 'cancelled' | 'ended' | 'unverified';
export type AttendanceStatus = 'not_registered' | 'going' | 'withdrawn' | 'needs_review' | 'cancelled' | 'ended' | 'unverified';
