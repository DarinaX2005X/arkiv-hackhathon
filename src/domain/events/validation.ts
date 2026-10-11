import { canonicalJson } from '../canonical';
import { sameActor } from '../readiness';
import { TIRAMISU_CHAIN_ID } from '../types';
import type { Actor, DomainReason, Snapshot, ValidationResult } from '../types';
import { audienceHash } from './canonical';
import { EVENTS_PROTOCOL, EVENTS_SCHEMA_VERSION, MAX_EVENT_PAYLOAD_BYTES, MAX_EVENT_RESERVATIONS, MAX_EVENT_STATE_PAYLOAD_BYTES } from './types';
import type { EventPayload, EventRecord, EventRelease, EventState } from './types';

type Check = (value: unknown, path: string, reasons: DomainReason[]) => void;
const issue = (reasons: DomainReason[], path: string, code: DomainReason['code'] = 'invalid_schema'): void => { reasons.push({ code, path }); };
const string = (max: number, min = 0): Check => (value, path, reasons) => {
  if (typeof value !== 'string' || value.length < min || value.length > max) issue(reasons, path);
};
const literal = (...values: unknown[]): Check => (value, path, reasons) => { if (!values.includes(value)) issue(reasons, path); };
const optional = (check: Check): Check => (value, path, reasons) => { if (value !== undefined) check(value, path, reasons); };
const nullable = (check: Check): Check => (value, path, reasons) => { if (value !== null) check(value, path, reasons); };
const time: Check = (value, path, reasons) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) issue(reasons, path);
};
const key: Check = (value, path, reasons) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) issue(reasons, path, 'invalid_identity');
};
const account: Check = (value, path, reasons) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value)) issue(reasons, path, 'invalid_identity');
};
const operationId: Check = (value, path, reasons) => {
  string(128, 1)(value, path, reasons);
  if (typeof value === 'string' && (value !== value.normalize('NFC') || /[\u0000-\u001f\u007f]/.test(value)
    || new TextEncoder().encode(value).byteLength > 128)) issue(reasons, path, 'invalid_identity');
};
const object = (shape: Record<string, Check>): Check => (value, path, reasons) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return issue(reasons, path);
  const input = value as Record<string, unknown>;
  for (const field of Object.keys(input)) if (!Object.hasOwn(shape, field)) issue(reasons, `${path}.${field}`);
  for (const [field, check] of Object.entries(shape)) check(input[field], `${path}.${field}`, reasons);
};
const predecessors: Check = (value, path, reasons) => {
  if (!Array.isArray(value) || value.length > 64) return issue(reasons, path);
  value.forEach((entry, index) => key(entry, `${path}[${index}]`, reasons));
  if (new Set(value).size !== value.length) issue(reasons, path, 'invalid_input');
};
const zone: Check = (value, path, reasons) => {
  string(100, 1)(value, path, reasons);
  if (typeof value !== 'string') return;
  // IANA names/aliases and UTC are accepted; a raw offset is not a named time zone.
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(value)) return issue(reasons, path, 'invalid_input');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { issue(reasons, path, 'invalid_input'); }
};
const source = object({ projectRoot: key, activationKey: key, proposalKey: key, proposalHash: key });
const accounts: Check = (value, path, reasons) => {
  if (!Array.isArray(value) || value.length > MAX_EVENT_RESERVATIONS) return issue(reasons, path);
  value.forEach((entry, index) => account(entry, `${path}[${index}]`, reasons));
  if (new Set(value).size !== value.length) issue(reasons, path, 'invalid_input');
};
const publicUrl: Check = (value, path, reasons) => {
  string(2_000)(value, path, reasons);
  if (value === '') return;
  try {
    const url = new URL(String(value));
    // Public routing parameters and anchors are allowed; recognized credential fields are not.
    const credentials = /^(?:password|passwd|pwd|passcode|access_token|auth_token|token|secret)$/i;
    const fragment = new URLSearchParams(url.hash.replace(/^#\??/, ''));
    if (url.protocol !== 'https:' || url.username || url.password
      || [...url.searchParams.keys(), ...fragment.keys()].some(name => credentials.test(name))) issue(reasons, path, 'invalid_input');
  } catch { issue(reasons, path, 'invalid_input'); }
};
const registration = object({ deadline: nullable(time), capacity: (value, path, reasons) => {
  const kind = value && typeof value === 'object' && 'kind' in value ? value.kind : null;
  if (kind === 'unlimited') object({ kind: literal('unlimited') })(value, path, reasons);
  else object({ kind: literal('limited'), limit: (limit, limitPath, target) => {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_RESERVATIONS) issue(target, limitPath, 'invalid_input');
  } })(value, path, reasons);
}, waitlist: literal(true, false), admission: literal('open', 'invite_only'), invitedAccounts: accounts });
const terms = object({ title: string(200, 1), description: string(10_000), startsAt: time, endsAt: time,
  timeZone: zone, venue: string(1_000, 1), instructions: string(10_000), conditions: string(10_000),
  termsVersion: optional(literal(2)), format: optional(literal('online', 'in_person', 'hybrid')),
  location: optional(nullable(object({ countryCode: (value, path, reasons) => {
    if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) issue(reasons, path, 'invalid_input');
  }, country: string(100, 1), city: string(200, 1), venue: string(1_000, 1) }))),
  online: optional(nullable(object({ url: publicUrl, instructions: string(10_000) }))), registration: optional(registration) });
const admissions: Check = (value, path, reasons) => {
  if (!Array.isArray(value) || value.length > MAX_EVENT_RESERVATIONS) return issue(reasons, path);
  value.forEach((entry, index) => object({ attendee: account, attendanceKey: key, releaseKey: key })(entry, `${path}[${index}]`, reasons));
  if (new Set(value.map(entry => entry?.attendee)).size !== value.length
    || new Set(value.map(entry => entry?.attendanceKey)).size !== value.length) issue(reasons, path, 'invalid_input');
};
const base = { protocol: literal(EVENTS_PROTOCOL), schemaVersion: literal(EVENTS_SCHEMA_VERSION), operationId, createdAt: time };
const shapes: Record<EventPayload['entityType'], Check> = {
  event_release: object({ ...base, entityType: literal('event_release'), projectRoot: key,
    predecessorReleaseKey: (value, path, reasons) => { if (value !== null) key(value, path, reasons); },
    terms, audienceHash: key, source, reconfirmationAccounts: optional(accounts) }),
  event_state: object({ ...base, entityType: literal('event_state'), projectRoot: key, releaseKey: key,
    audienceHash: key, startsAt: time, endsAt: time, source, status: literal('open', 'closed', 'cancelled', 'ended'), predecessorKeys: predecessors,
    admissions: optional(admissions) }),
  attendance_state: object({ ...base, entityType: literal('attendance_state'), projectRoot: key, attendee: account,
    releaseKey: key, audienceHash: key, decision: literal('going', 'withdrawn'), predecessorKeys: predecessors, joinWaitlist: optional(literal(true, false)) }),
};

export function validateEventPayload(value: unknown): ValidationResult {
  const reasons: DomainReason[] = [];
  try {
    // Canonical encoding rejects cycles, undefined, non-JSON values and class instances.
    canonicalJson(value);
    const kind = value && typeof value === 'object' && 'entityType' in value ? value.entityType : null;
    const maximum = kind === 'event_state' ? MAX_EVENT_STATE_PAYLOAD_BYTES : MAX_EVENT_PAYLOAD_BYTES;
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) {
      return { valid: false, reasons: [{ code: 'payload_too_large' }] };
    }
    if (typeof kind !== 'string' || !Object.hasOwn(shapes, kind)) return { valid: false, reasons: [{ code: 'invalid_schema', path: 'payload.entityType' }] };
    shapes[kind as EventPayload['entityType']](value, 'payload', reasons);
    if (!reasons.length) {
      const payload = value as EventPayload;
      if (payload.entityType !== 'attendance_state' && payload.source.projectRoot !== payload.projectRoot) issue(reasons, 'payload.source.projectRoot', 'scope_mismatch');
      if (payload.entityType === 'event_release') {
        if (payload.terms.endsAt <= payload.terms.startsAt) issue(reasons, 'payload.terms.endsAt', 'invalid_input');
        const terms = payload.terms;
        if (payload.reconfirmationAccounts !== undefined && (terms.termsVersion !== 2
          || (payload.reconfirmationAccounts.length > 0 && payload.predecessorReleaseKey === null))) issue(reasons, 'payload.reconfirmationAccounts');
        const structured = ['format', 'location', 'online', 'registration'] as const;
        if (terms.termsVersion === 2) {
          for (const field of structured) if (!Object.hasOwn(terms, field)) issue(reasons, `payload.terms.${field}`);
          if (terms.format === 'online' ? terms.location !== null : !terms.location) issue(reasons, 'payload.terms.location', 'invalid_input');
          if (terms.format === 'in_person' ? terms.online !== null : !terms.online) issue(reasons, 'payload.terms.online', 'invalid_input');
          if (terms.online && !terms.online.url.trim() && !terms.online.instructions.trim()) issue(reasons, 'payload.terms.online', 'invalid_input');
          if (terms.location && terms.venue !== terms.location.venue) issue(reasons, 'payload.terms.venue', 'projection_mismatch');
          if (terms.registration) {
            if (terms.registration.deadline !== null && terms.registration.deadline > terms.endsAt) issue(reasons, 'payload.terms.registration.deadline', 'invalid_input');
            if (terms.registration.capacity.kind === 'unlimited' && terms.registration.waitlist) issue(reasons, 'payload.terms.registration.waitlist', 'invalid_input');
            if (terms.registration.admission === 'open' && terms.registration.invitedAccounts.length) issue(reasons, 'payload.terms.registration.invitedAccounts', 'invalid_input');
          }
        } else if (structured.some(field => Object.hasOwn(terms, field))) issue(reasons, 'payload.terms.termsVersion');
        if (audienceHash(payload.terms) !== payload.audienceHash) issue(reasons, 'payload.audienceHash', 'hash_mismatch');
      }
      if (payload.entityType === 'event_state' && payload.endsAt <= payload.startsAt) issue(reasons, 'payload.endsAt', 'invalid_input');
    }
  } catch { issue(reasons, 'payload'); }
  return { valid: reasons.length === 0, reasons };
}

/** Adapter projections must be checked separately against these authenticated payload fields. */
export function validateEventRecord(record: EventRecord, snapshot: Snapshot, authority?: Actor): ValidationResult {
  const reasons = [...validateEventPayload(record.payload).reasons];
  key(record.key, 'key', reasons);
  const provenance = record.provenance;
  if (provenance.mode !== 'public' || snapshot.mode !== 'public' || snapshot.chainId !== TIRAMISU_CHAIN_ID
    || snapshot.source !== 'arkiv' || provenance.contentType !== 'application/json') issue(reasons, 'provenance', 'invalid_schema');
  if (provenance.readonly !== true || provenance.permissionlessExtension !== false) issue(reasons, 'provenance', 'not_readonly');
  if (provenance.creator.kind !== 'wallet' || provenance.owner.kind !== 'wallet') issue(reasons, 'provenance', 'invalid_identity');
  else {
    for (const actor of [provenance.creator, provenance.owner]) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(actor.address)) issue(reasons, 'provenance', 'invalid_identity');
    }
  }
  if (!sameActor(provenance.creator, provenance.owner)) issue(reasons, 'provenance.owner', 'owner_changed');
  if (authority && !sameActor(provenance.creator, authority)) issue(reasons, 'provenance.creator', 'foreign_author');
  if (record.payload.entityType === 'attendance_state'
    && !sameActor(provenance.creator, { kind: 'wallet', address: record.payload.attendee })) issue(reasons, 'payload.attendee', 'foreign_author');
  try {
    if (![snapshot.blockNumber, provenance.createdAtBlock, provenance.expiresAtBlock].every(value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) {
      issue(reasons, 'provenance', 'incomplete_snapshot');
    } else {
      const block = BigInt(snapshot.blockNumber!), created = BigInt(provenance.createdAtBlock!), expires = BigInt(provenance.expiresAtBlock!);
      if (created > block || expires <= block || expires <= created) issue(reasons, 'provenance.expiresAtBlock', 'expired');
    }
  } catch { issue(reasons, 'provenance'); }
  if (record.payload.createdAt > snapshot.blockTimestamp) issue(reasons, 'payload.createdAt', 'invalid_input');
  return { valid: reasons.length === 0, reasons };
}

/** Current-head date/hash pointers cannot be trusted until their release has been joined. */
export function validateEventReleaseBinding(state: EventState, release: EventRecord<EventRelease>): ValidationResult {
  const reasons: DomainReason[] = [];
  if (state.projectRoot !== release.payload.projectRoot || state.releaseKey !== release.key
    || state.audienceHash !== release.payload.audienceHash || state.startsAt !== release.payload.terms.startsAt
    || state.endsAt !== release.payload.terms.endsAt) issue(reasons, 'release', 'projection_mismatch');
  return { valid: reasons.length === 0, reasons };
}
