import type {
  AccountAddress, ContentHash, DomainReason, EntityKey, EntityProvenance, EntityRecord,
  OperationId, ProjectAggregate, ProjectRoot, Snapshot, SourcePlanRef, UtcMilliseconds,
} from '../types';

/** Independent extension: the original partfolk/1 payloads and consent hashes stay unchanged. */
export const EVENTS_PROTOCOL = 'partfolk-events/1' as const;
export const EVENTS_SCHEMA_VERSION = 1 as const;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
/** SDK 0.8.1 allows a 128 KiB payload cell; match core's 120 KiB bound for a complete 512-place roster. */
export const MAX_EVENT_STATE_PAYLOAD_BYTES = 120 * 1024;
export const MAX_EVENT_RESERVATIONS = 512;
export type EventEntityType = 'event_release' | 'event_state' | 'attendance_state';

export type EventFormat = 'online' | 'in_person' | 'hybrid';
export interface EventLocation { countryCode: string; country: string; city: string; venue: string }
/** Public information only. Credentials and private meeting tokens must never be published. */
export interface PublicOnlineConnection { url: string; instructions: string }
export interface RegistrationRules {
  deadline: UtcMilliseconds | null;
  capacity: { kind: 'unlimited' } | { kind: 'limited'; limit: number };
  waitlist: boolean;
  admission: 'open' | 'invite_only';
  /** Public wallet admission list, not confidential invitations. */
  invitedAccounts: AccountAddress[];
}

export interface AudienceTerms {
  title: string;
  description: string;
  startsAt: UtcMilliseconds;
  endsAt: UtcMilliseconds;
  timeZone: string;
  venue: string;
  instructions: string;
  conditions: string;
  /** Absent on legacy releases. Version 2 requires every structured field below. */
  termsVersion?: 2;
  format?: EventFormat;
  location?: EventLocation | null;
  online?: PublicOnlineConnection | null;
  registration?: RegistrationRules;
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
  /** Owner-held attendees copied from the reviewed predecessor roster; permits changed-term reconfirmation after the deadline. */
  reconfirmationAccounts?: AccountAddress[];
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
  /** Coordinator-owned reservations. Only an explicit atomic owner transition releases a place. */
  admissions?: EventAdmission[];
}

export interface EventAdmission { attendee: AccountAddress; attendanceKey: EntityKey; releaseKey: EntityKey }

export interface AttendanceState extends EventPayloadBase {
  entityType: 'attendance_state';
  projectRoot: EntityKey;
  attendee: AccountAddress;
  /** Consent applies to this exact audience version, including when a later release repeats its hash. */
  releaseKey: EntityKey;
  audienceHash: ContentHash;
  decision: 'going' | 'withdrawn';
  predecessorKeys: EntityKey[];
  /** Explicit permission to retain this request in the waiting list. Absence means false. */
  joinWaitlist?: boolean;
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
  /** Present on structured events; absent never means an empty verified roster. */
  roster?: EventRoster;
}

export interface EventRosterEntry {
  attendee: AccountAddress;
  attendance: EventScope<AttendanceState>;
  registeredRelease: EventRecord<EventRelease> | null;
  /** Canonical inclusion time from the creation block, never payload.createdAt. */
  inclusionTimestamp: UtcMilliseconds | null;
}
export interface EventRoster {
  entries: EventRosterEntry[];
  snapshot: Snapshot;
  diagnostics: DomainReason[];
}

export type EventAvailability = 'open' | 'paused' | 'closed' | 'cancelled' | 'ended' | 'unverified' | 'registration_closed' | 'full' | 'waitlist';
export type AttendanceStatus = 'not_registered' | 'going' | 'withdrawn' | 'needs_review' | 'cancelled' | 'ended' | 'unverified'
  | 'pending' | 'waitlisted' | 'full' | 'invitation_required' | 'registration_closed';
