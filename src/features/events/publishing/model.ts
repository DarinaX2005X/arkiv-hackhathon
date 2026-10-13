import { Temporal } from '@js-temporal/polyfill';
import { validRepositoryActionRecord } from '../../../app/actions';
import { isAccountAddress, isPublicEntityKey } from '../../../app/ids';
import type { AppSession } from '../../../app/session';
import { createDraftStore, type StoragePort } from '../../../app/storage';
import { localDateTimeToUtc, type TimeDisambiguation, type TimeResult } from '../../../app/time';
import { createOperationIntent } from '../../../data/operations';
import type { EventRepositoryContract, PublishEventCommand, ReplaceEventCommand } from '../../../data/events/types';
import type { MutationResult, Result } from '../../../data/types';
import { canonicalJson, hashCanonical } from '../../../domain/canonical';
import { audienceChanges, audienceHash, eventPublicationDeadlineGuard, EVENTS_PROTOCOL, validateEventPayload, validateEventRecord, validateEventReleaseBinding,
  type AudienceTerms, type EventAggregate, type EventRecord, type EventState } from '../../../domain/events';
import { activeSource, deriveReadiness, sameActor, sameSource, validateCurrentEntity } from '../../../domain/readiness';
import { TIRAMISU_CHAIN_ID, type AccountAddress, type PublicEntityKey, type SourcePlanRef } from '../../../domain/types';

export interface PublishingFields {
  title: string; description: string; startsLocal: string; endsLocal: string; timeZone: string;
  venue: string; instructions: string; conditions: string; startOccurrence: TimeDisambiguation; endOccurrence: TimeDisambiguation;
  format?: 'online' | 'in_person' | 'hybrid'; countryCode?: string; country?: string; city?: string;
  onlineUrl?: string; onlineInstructions?: string; deadlineLocal?: string; deadlineOccurrence?: TimeDisambiguation;
  capacityKind?: 'unlimited' | 'limited'; capacityLimit?: string; waitlist?: boolean; admission?: 'open' | 'invite_only'; invitedAccounts?: string;
}
export interface PublishingDraft {
  projectRoot: PublicEntityKey; organizer: AccountAddress; baselineReleaseKey: PublicEntityKey | null; fields: PublishingFields;
}
export type PublishingKind = 'publish' | 'repair' | 'close' | 'cancel' | 'end';
export type PublishingCommand = PublishEventCommand | ReplaceEventCommand;
export interface PublishingReview {
  kind: PublishingKind; command: PublishingCommand; terms: AudienceTerms; previous: AudienceTerms | null;
  changed: (keyof AudienceTerms)[]; resume: boolean;
}
export type PreparedReview = { ok: true; review: PublishingReview } | { ok: false; message: string };
export type PublishingValue = MutationResult<EventAggregate | EventRecord<EventState>>;
const draftMemories = new WeakMap<EventRepositoryContract, Map<string, PublishingDraft>>();
const disconnectedDrafts = new Map<string, PublishingDraft>();

/** Keep failed-storage input through account/route unmounts within this workspace. */
export function publishingDraftMemory(repository: EventRepositoryContract | null): Map<string, PublishingDraft> {
  if (!repository) return disconnectedDrafts;
  let memory = draftMemories.get(repository);
  if (!memory) { memory = new Map(); draftMemories.set(repository, memory); }
  return memory;
}
export const structuredFieldDefaults = { format: 'in_person' as const, countryCode: '', country: '', city: '', onlineUrl: '', onlineInstructions: '', deadlineLocal: '', deadlineOccurrence: 'reject' as const, capacityKind: 'unlimited' as const, capacityLimit: '', waitlist: false, admission: 'open' as const, invitedAccounts: '' };
const day = 86_400_000;
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export function emptyPublishingFields(structured = false): PublishingFields {
  let timeZone = 'UTC';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* Explicit UTC fallback. */ }
  return { title: '', description: '', startsLocal: '', endsLocal: '', timeZone, venue: '', instructions: '', conditions: '', startOccurrence: 'reject', endOccurrence: 'reject', ...(structured ? structuredFieldDefaults : {}) };
}

/** Keep even sub-second published instants when an untouched form is reopened. */
export function publishingFields(terms: AudienceTerms): PublishingFields {
  const local = (at: number) => Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(terms.timeZone).toPlainDateTime().toString({ smallestUnit: 'millisecond' });
  const occurrence = (at: number): TimeDisambiguation => {
    const plain = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(terms.timeZone).toPlainDateTime();
    const first = plain.toZonedDateTime(terms.timeZone, { disambiguation: 'earlier' });
    const last = plain.toZonedDateTime(terms.timeZone, { disambiguation: 'later' });
    return first.epochMilliseconds === last.epochMilliseconds ? 'reject' : first.epochMilliseconds === at ? 'earlier' : 'later';
  };
  return { title: terms.title, description: terms.description, startsLocal: local(terms.startsAt), endsLocal: local(terms.endsAt),
    timeZone: terms.timeZone, venue: terms.venue, instructions: terms.instructions, conditions: terms.conditions,
    startOccurrence: occurrence(terms.startsAt), endOccurrence: occurrence(terms.endsAt),
    ...(terms.termsVersion === 2 && terms.registration ? { ...structuredFieldDefaults, format: terms.format, countryCode: terms.location?.countryCode ?? '', country: terms.location?.country ?? '', city: terms.location?.city ?? '', onlineUrl: terms.online?.url ?? '', onlineInstructions: terms.online?.instructions ?? '', deadlineLocal: terms.registration.deadline === null ? '' : local(terms.registration.deadline), deadlineOccurrence: terms.registration.deadline === null ? 'reject' as const : occurrence(terms.registration.deadline), capacityKind: terms.registration.capacity.kind, capacityLimit: terms.registration.capacity.kind === 'limited' ? String(terms.registration.capacity.limit) : '', waitlist: terms.registration.waitlist, admission: terms.registration.admission, invitedAccounts: terms.registration.invitedAccounts.join('\n') } : {}) };
}

export function validPublishingDraft(value: unknown): value is PublishingDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).sort().join(',') !== 'baselineReleaseKey,fields,organizer,projectRoot' || !isPublicEntityKey(draft.projectRoot)
    || !isAccountAddress(draft.organizer) || draft.baselineReleaseKey !== null && !isPublicEntityKey(draft.baselineReleaseKey)
    || !draft.fields || typeof draft.fields !== 'object' || Array.isArray(draft.fields)) return false;
  const fields = draft.fields as Record<string, unknown>;
  const limits = { title: 200, description: 10000, startsLocal: 32, endsLocal: 32, timeZone: 100, venue: 1000, instructions: 10000, conditions: 10000 };
  const extraLimits = { countryCode: 2, country: 100, city: 200, onlineUrl: 2000, onlineInstructions: 10000, deadlineLocal: 32, capacityLimit: 12, invitedAccounts: 24000 };
  const allowed = [...Object.keys(limits), 'startOccurrence', 'endOccurrence', ...Object.keys(structuredFieldDefaults)];
  return Object.keys(fields).every(key => allowed.includes(key))
    && Object.entries(extraLimits).every(([key, max]) => fields[key] === undefined || typeof fields[key] === 'string' && fields[key].length <= max)
    && (fields.format === undefined || ['online', 'in_person', 'hybrid'].includes(String(fields.format)))
    && (fields.capacityKind === undefined || ['unlimited', 'limited'].includes(String(fields.capacityKind)))
    && (fields.admission === undefined || ['open', 'invite_only'].includes(String(fields.admission)))
    && (fields.waitlist === undefined || typeof fields.waitlist === 'boolean')
    && (fields.deadlineOccurrence === undefined || ['reject', 'earlier', 'later'].includes(String(fields.deadlineOccurrence)))
    && Object.entries(limits).every(([key, max]) => typeof fields[key] === 'string' && fields[key].length <= max)
    && ['reject', 'earlier', 'later'].includes(String(fields.startOccurrence)) && ['reject', 'earlier', 'later'].includes(String(fields.endOccurrence));
}

export function publishingDraftStore(storage: StoragePort | null, projectRoot: PublicEntityKey, organizer: AccountAddress) {
  return createDraftStore({ storage, key: `partfolk:events:publishing-draft:${projectRoot}:${organizer.toLowerCase()}`, kind: 'event-publishing-draft',
    validate: (value): value is PublishingDraft => validPublishingDraft(value) && value.projectRoot === projectRoot && value.organizer.toLowerCase() === organizer.toLowerCase() });
}

export function publishingLocalInstant(value: string, timeZone: string, occurrence: TimeDisambiguation = 'reject'): TimeResult {
  const match = /^(.*T\d{2}:\d{2}:\d{2})\.(\d{1,3})$/.exec(value);
  const result = localDateTimeToUtc(match?.[1] ?? value, timeZone, occurrence);
  return result.ok ? { ok: true, utcMilliseconds: result.utcMilliseconds + (match ? Number(match[2]!.padEnd(3, '0')) : 0) } : result;
}

export function publishingDateInputType(value: string): 'text' | 'datetime-local' {
  return value && !publishingLocalInstant(value, 'UTC').ok ? 'text' : 'datetime-local';
}

export function termsFromFields(fields: PublishingFields): { ok: true; terms: AudienceTerms } | { ok: false; message: string } {
  if (!fields.title.trim()) return fail('Give the event a title visitors will recognize.');
  if (fields.format !== 'online' && !fields.venue.trim()) return fail('Add the public place or meeting point.');
  const instant = (value: string, occurrence: TimeDisambiguation) => publishingLocalInstant(value, fields.timeZone, occurrence);
  const start = instant(fields.startsLocal, fields.startOccurrence), end = instant(fields.endsLocal, fields.endOccurrence);
  for (const [label, result] of [['start', start], ['end', end]] as const) {
    if (!result.ok) {
      if (result.error === 'ambiguous_time') return fail(`The ${label} time occurs twice when the clocks change. Choose its first or second occurrence.`);
      if (result.error === 'nonexistent_time') return fail(`The ${label} time does not exist when the clocks change. Choose another time.`);
      if (result.error === 'invalid_timezone') return fail('Enter a named time zone, such as Europe/London or Asia/Almaty.');
      return fail(`Choose a valid ${label} date and time.`);
    }
  }
  if (!start.ok || !end.ok) return fail('Check the event dates.');
  if (end.utcMilliseconds <= start.utcMilliseconds) return fail('The event must end after it starts.');
  const terms: AudienceTerms = { title: fields.title, description: fields.description, startsAt: start.utcMilliseconds, endsAt: end.utcMilliseconds,
    timeZone: fields.timeZone, venue: fields.format === 'online' ? 'Online' : fields.venue, instructions: fields.instructions, conditions: fields.conditions };
  if (fields.format) {
    const physical = fields.format !== 'online', online = fields.format !== 'in_person';
    if (physical && (!/^[A-Za-z]{2}$/.test(fields.countryCode ?? '') || !fields.country?.trim() || !fields.city?.trim())) return fail('Choose the country and add the city so visitors can find this event.');
    if (online && !fields.onlineUrl?.trim() && !fields.onlineInstructions?.trim()) return fail('Add a public online link or explain how to join online.');
    if (online && fields.onlineUrl?.trim()) {
      try { const url = new URL(fields.onlineUrl.trim()); if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.replace(/^#\??/, '')).keys()].some(key => /^(?:password|passwd|pwd|passcode|access_token|auth_token|token|secret)$/i.test(key))) return fail('Use a public HTTPS link without passwords or access tokens. Put safe joining steps in the instructions.'); }
      catch { return fail('Enter a complete public online link, starting with https://.'); }
    }
    let deadline: number | null = null;
    if (fields.deadlineLocal) {
      const parsed = instant(fields.deadlineLocal, fields.deadlineOccurrence ?? 'reject');
      if (!parsed.ok) return fail('Choose a valid registration deadline in the event time zone. If the clock repeats, choose the first or second occurrence.');
      deadline = parsed.utcMilliseconds;
      if (deadline > end.utcMilliseconds) return fail('Registration must close at or before the event ends.');
    }
    if (fields.capacityKind === 'limited' && (!/^[1-9][0-9]*$/.test(fields.capacityLimit ?? '') || !Number.isSafeInteger(Number(fields.capacityLimit)) || Number(fields.capacityLimit) > 512)) return fail('Enter a whole capacity between 1 and 512.');
    const invited = (fields.invitedAccounts ?? '').split(/[\s,;]+/).filter(Boolean);
    if (fields.admission === 'invite_only' && (!invited.length || invited.some(value => !isAccountAddress(value)))) return fail('Add the invited wallet addresses, one per line. Each must be a complete 0x address.');
    const invitedAccounts = [...new Set(invited.map(value => value.toLowerCase()))] as AccountAddress[];
    if (invitedAccounts.length > 512) return fail('Use at most 512 invited wallet addresses.');
    Object.assign(terms, { termsVersion: 2, format: fields.format,
      location: physical ? { countryCode: fields.countryCode!.toUpperCase(), country: fields.country!.trim(), city: fields.city!.trim(), venue: fields.venue } : null,
      online: online ? { url: fields.onlineUrl?.trim() ?? '', instructions: fields.onlineInstructions ?? '' } : null,
      registration: { deadline, capacity: fields.capacityKind === 'limited' ? { kind: 'limited', limit: Number(fields.capacityLimit) } : { kind: 'unlimited' }, waitlist: fields.capacityKind === 'limited' && Boolean(fields.waitlist), admission: fields.admission ?? 'open', invitedAccounts: fields.admission === 'invite_only' ? invitedAccounts : [] } });
  }
  return { ok: true, terms };
}

export function publishingLifetime(endsAt: number, now: number): number {
  return Math.ceil(Math.max(90 * day, endsAt + 30 * day - now) / 2000) * 2;
}

/** A readable generic action envelope may still contain the wrong feature payload. */
export function validPublishingCommand(value: unknown): value is PublishingCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>, source = command.source as Record<string, unknown> | undefined,
    operation = command.operation as Record<string, unknown> | undefined;
  if (!validRepositoryActionRecord({ status: 'needs-verification', command: value, operation })) return false;
  if (!isPublicEntityKey(command.projectRoot) || !source || typeof source !== 'object' || !operation || typeof operation !== 'object'
    || source.projectRoot !== command.projectRoot || !['activationKey', 'proposalKey', 'proposalHash'].every(field => isPublicEntityKey(source[field]))
    || !Array.isArray(command.expectedHeads) || !command.expectedHeads.every(isPublicEntityKey)
    || !Number.isSafeInteger(command.lifetimeSeconds) || Number(command.lifetimeSeconds) <= 0 || Number(command.lifetimeSeconds) % 2 !== 0
    || Number(command.lifetimeSeconds) > 10 * 366 * 86_400) return false;
  if (operation.kind === 'publish_event') return validateEventPayload({ protocol: EVENTS_PROTOCOL, schemaVersion: 1, entityType: 'event_release',
    operationId: operation.id, createdAt: operation.createdAt, projectRoot: command.projectRoot, predecessorReleaseKey: null,
    terms: command.terms, audienceHash: (() => { try { return audienceHash(command.terms as AudienceTerms); } catch { return ''; } })(), source }).valid;
  return operation.kind === 'replace_event' && !('terms' in command) && isPublicEntityKey(command.releaseKey) && isPublicEntityKey(command.audienceHash)
    && ['open', 'closed', 'cancelled', 'ended'].includes(String(command.status))
    && (command.admissions === undefined || Array.isArray(command.admissions) && command.admissions.length <= 512
      && command.admissions.every(item => item && typeof item === 'object' && Object.keys(item).sort().join(',') === 'attendanceKey,attendee,releaseKey' && isAccountAddress(item.attendee) && isPublicEntityKey(item.attendanceKey) && isPublicEntityKey(item.releaseKey))
      && new Set(command.admissions.map(item => item.attendee.toLowerCase())).size === command.admissions.length);
}

/** A completed old request must never replace newer or half-edited visitor details. */
export function draftAfterPublication(draft: PublishingDraft | undefined, submitted: AudienceTerms, event: EventAggregate): PublishingDraft | null {
  if (!draft || !validPublishingDraft(draft) || draft.projectRoot !== event.projectRoot || !event.release) return null;
  const parsed = termsFromFields(draft.fields), hash = audienceHash(submitted);
  if (!parsed.ok || audienceHash(parsed.terms) !== hash || event.release.payload.audienceHash !== hash) return null;
  return { ...draft, fields: publishingFields(event.release.payload.terms), baselineReleaseKey: event.release.key as PublicEntityKey };
}

function fresh(event: EventAggregate, now: number): boolean {
  const snapshot = event.snapshot;
  return snapshot.mode === 'public' && snapshot.chainId === TIRAMISU_CHAIN_ID && snapshot.source === 'arkiv'
    && snapshot.completeness === 'complete' && snapshot.freshness === 'fresh' && snapshot.reasons.length === 0
    && typeof snapshot.blockNumber === 'string' && /^(0|[1-9]\d*)$/.test(snapshot.blockNumber)
    && typeof snapshot.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(snapshot.blockHash)
    && Number.isSafeInteger(now) && Number.isSafeInteger(snapshot.fetchedAt) && Number.isSafeInteger(snapshot.blockTimestamp)
    && now >= snapshot.fetchedAt && now - snapshot.fetchedAt <= 60_000 && now >= snapshot.blockTimestamp && now - snapshot.blockTimestamp <= 60_000;
}

export function organizerAccess(event: EventAggregate, session: AppSession, now: number): string | null {
  if (session.mode !== 'public' || session.actor?.kind !== 'wallet') return 'Sign in with the wallet that created this project to publish its event.';
  if (session.chainId !== TIRAMISU_CHAIN_ID) return 'Switch your wallet to Arkiv Tiramisu. Your event draft is kept.';
  if (!fresh(event, now)) return 'Refresh the event to check its current details before continuing.';
  if (!event.root || event.root.key !== event.projectRoot || !validateCurrentEntity(event.root, event.snapshot, event.root.payload.coordinator).valid)
    return 'The project creator could not be verified. Refresh before continuing.';
  if (!sameActor(event.root.provenance.creator, session.actor)) return 'Only the wallet that created this project can publish or change its event.';
  return null;
}

function currentEnvelope(event: EventAggregate, allowMissing: boolean): string | null {
  if (event.state.status === 'missing') return allowMissing ? null : 'The current event record is unavailable. Recover its original publication before changing its status.';
  if (event.state.status !== 'unique' || !event.root || !event.release
    || event.state.entity.payload.projectRoot !== event.projectRoot || event.release.payload.projectRoot !== event.projectRoot
    || !validateEventRecord(event.state.entity, event.snapshot, event.root.payload.coordinator).valid
    || !validateEventRecord(event.release, event.snapshot, event.root.payload.coordinator).valid
    || !validateEventReleaseBinding(event.state.entity.payload, event.release).valid)
    return 'The current event version could not be verified. Refresh before making another request.';
  return null;
}

function readySource(event: EventAggregate, now: number): SourcePlanRef | null {
  const project = event.sourceProject;
  if (!project || project.root.key !== event.projectRoot || !fresh({ ...event, snapshot: project.snapshot }, now)
    || project.snapshot.blockHash !== event.snapshot.blockHash || project.snapshot.blockNumber !== event.snapshot.blockNumber
    || project.snapshot.blockTimestamp !== event.snapshot.blockTimestamp || deriveReadiness(project, now).status !== 'ready') return null;
  return activeSource(project);
}

export interface PublishingPreparations {
  title: string; placeReference: string; timeZone: string;
  requirements: { id: string; title: string; start: number; end: number }[];
}

/** Show only the exact immutable plan selected by this review, never an edited recipe. */
export function publishingPreparations(event: EventAggregate, selected: SourcePlanRef, now = Date.now()): PublishingPreparations | null {
  const current = readySource(event, now), project = event.sourceProject, proposal = project?.proposal;
  if (!current || !sameSource(current, selected) || !project || !proposal || project.root.key !== selected.projectRoot
    || proposal.key !== selected.proposalKey || proposal.payload.projectRoot !== selected.projectRoot
    || proposal.payload.proposalHash !== selected.proposalHash || proposal.payload.plan.projectRoot !== selected.projectRoot) return null;
  const variant = proposal.payload.plan.variant;
  return { title: variant.title, placeReference: variant.venueId, timeZone: variant.timeZone,
    requirements: variant.requirements.map(item => ({ id: item.id, title: item.title, start: item.interval.start, end: item.interval.end })) };
}

export function preparePublishingReview(event: EventAggregate, session: AppSession, kind: PublishingKind, draft: PublishingDraft | null, now = Date.now()): PreparedReview {
  const access = organizerAccess(event, session, now) ?? currentEnvelope(event, kind === 'publish');
  if (access) return fail(access);
  const current = event.state.status === 'unique' ? event.state.entity : null;
  if (current && ['cancelled', 'ended'].includes(current.payload.status)) return fail('This event is final. A cancelled or ended event cannot reopen.');
  const source = kind === 'publish' || kind === 'repair' ? readySource(event, now) : current?.payload.source;
  if (!source) return fail('Agree on the current project plan before opening registration. Every required contributor needs a current agreement.');
  let terms = event.release?.payload.terms;
  let changed: (keyof AudienceTerms)[] = [];
  if (kind === 'publish') {
    if (!draft || !validPublishingDraft(draft) || draft.projectRoot !== event.projectRoot || session.actor?.kind !== 'wallet'
      || draft.organizer.toLowerCase() !== session.actor.address.toLowerCase()) return fail('This draft belongs to another event or wallet. Return to its account before publishing.');
    if (draft.baselineReleaseKey !== (event.release?.key ?? null)) return fail('The published event changed after this draft was started. Compare your draft with the latest version before publishing.');
    const parsed = termsFromFields(draft.fields); if (!parsed.ok) return parsed;
    terms = parsed.terms;
    if (terms.registration?.capacity.kind === 'limited' && terms.registration.capacity.limit < (current?.payload.admissions?.length ?? 0)) return fail('Release reserved places before reducing capacity below the current reservations. Your event draft is kept.');
    changed = event.release ? audienceChanges(event.release.payload.terms, terms) : [];
    if (event.release && changed.length === 0) return fail('The visitor details have not changed. Use the agreed plan action to restore or reopen registration without asking visitors to confirm again.');
  }
  if (!terms) return fail('The current visitor details could not be read. Refresh before continuing.');
  if (kind === 'publish') {
    const guard = eventPublicationDeadlineGuard(event, terms, now);
    if (guard === 'reopen_required') return fail('Existing attendees need to accept these changes. Choose a later registration deadline, up to the event end, before publishing changed terms.');
    if (guard === 'unverified') return fail('Refresh the complete registration list before changing details after the deadline, or choose a future registration deadline so earlier visitors can confirm again.');
  }
  if ((kind === 'publish' || kind === 'repair') && terms.endsAt <= Math.max(now, event.snapshot.blockTimestamp)) return fail('The event has already ended. Choose a future end time to publish visitor details.');
  if (kind === 'end' && event.snapshot.blockTimestamp < terms.endsAt) return fail('The scheduled end has not arrived yet. You can close registration or cancel the event now.');
  if (kind === 'close' && current?.payload.status === 'closed') return fail('Registration is already closed.');
  if (kind === 'repair' && current?.payload.status === 'open' && sameSource(current.payload.source, source)) return fail('Registration already uses this agreed plan. There is no internal change to publish.');
  const lifetimeSeconds = publishingLifetime(terms.endsAt, Math.min(now, event.snapshot.blockTimestamp));
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds > 10 * 366 * 86_400) return fail('Choose an event date within the supported ten-year record lifetime.');
  const provisional = { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, entityType: 'event_release' as const, operationId: 'event-preview',
    createdAt: now, projectRoot: event.projectRoot, predecessorReleaseKey: event.release?.key ?? null, terms, audienceHash: audienceHash(terms), source };
  if (!validateEventPayload(provisional).valid) return fail('The event details exceed the supported format or size. Shorten the text and check the dates and time zone.');
  const shared = { lifetimeSeconds, projectRoot: event.projectRoot, source, expectedHeads: current ? [current.key] : [] };
  const authority = { mode: 'public' as const, chainId: TIRAMISU_CHAIN_ID, actor: { kind: 'wallet' as const, address: (session.actor as { address: AccountAddress }).address.toLowerCase() as AccountAddress } };
  const command: PublishingCommand = kind === 'publish'
    ? (() => { const input = { ...shared, terms }; return { ...input, operation: createOperationIntent('publish_event', authority, input, { now }) }; })()
    : (() => { const input = { ...shared, releaseKey: event.release!.key, audienceHash: event.release!.payload.audienceHash,
      status: kind === 'repair' ? 'open' as const : kind === 'close' ? 'closed' as const : kind === 'cancel' ? 'cancelled' as const : 'ended' as const };
      return { ...input, operation: createOperationIntent('replace_event', authority, input, { now }) }; })();
  return { ok: true, review: { kind, command, terms, previous: event.release?.payload.terms ?? null, changed, resume: false } };
}

/** Validate a frozen review again after async reads; never allocate another operation to retry it. */
export function validatePublishingReview(review: PublishingReview, event: EventAggregate, session: AppSession, now = Date.now()): string | null {
  const { command } = review;
  if (!validPublishingCommand(command)) return 'The saved event request could not be read safely. Keep its recovery file before continuing.';
  const access = organizerAccess(event, session, now) ?? currentEnvelope(event, command.operation.kind === 'publish_event');
  if (access) return access;
  const { operation, ...input } = command;
  if (command.projectRoot !== event.projectRoot || operation.inputHash !== hashCanonical(input) || operation.inputHash !== hashCanonical(operation.input)
    || !sameActor(operation.authority.actor, session.actor ?? undefined) || operation.authority.mode !== 'public' || operation.authority.chainId !== TIRAMISU_CHAIN_ID)
    return 'This review belongs to different details or another wallet. Review the event again.';
  const heads = event.state.status === 'unique' ? [event.state.entity.key] : [];
  if (canonicalJson(heads) !== canonicalJson(command.expectedHeads)) return 'The event changed during your review. Refresh and review its latest version.';
  const state = event.state.status === 'unique' ? event.state.entity.payload : null;
  if (state && ['cancelled', 'ended'].includes(state.status)) return 'This event has already been cancelled or ended.';
  const opening = 'terms' in command || command.status === 'open';
  if (opening) {
    const source = readySource(event, now);
    if (!source || !sameSource(source, command.source)) return 'The project plan or its agreements changed. Restore agreement and review the current plan before opening registration.';
  } else if (!state || !sameSource(state.source, command.source)) return 'The published source changed. Review the current event before changing its status.';
  const terms = 'terms' in command ? command.terms : event.release?.payload.terms;
  if (!terms || canonicalJson(terms) !== canonicalJson(review.terms)) return 'The visitor details no longer match this review.';
  if ('terms' in command) {
    const guard = eventPublicationDeadlineGuard(event, terms, now);
    if (guard !== 'ready') return guard === 'reopen_required' ? 'Existing attendees need to accept these changes. Choose a later registration deadline, up to the event end, before publishing changed terms.' : 'The complete registration list could not be verified. Refresh it or choose a future registration deadline before publishing these changes.';
  }
  if (!('terms' in command) && (!event.release || command.releaseKey !== event.release.key || command.audienceHash !== event.release.payload.audienceHash))
    return 'The public event version changed. Review the current details before continuing.';
  if (opening && terms.endsAt <= Math.max(now, event.snapshot.blockTimestamp)) return 'The event has already ended. No new registration can open.';
  if (!('terms' in command) && command.status === 'ended' && event.snapshot.blockTimestamp < terms.endsAt) return 'The scheduled end has not arrived yet.';
  return null;
}

export function reviewOriginalCommand(command: unknown, event: EventAggregate, session: AppSession, now = Date.now()): PreparedReview {
  if (!validPublishingCommand(command)) return fail('This saved request is not a valid organizer publication. Keep its recovery file before continuing.');
  const kind: PublishingKind = 'terms' in command ? 'publish' : command.status === 'open' ? 'repair' : command.status === 'closed' ? 'close' : command.status === 'cancelled' ? 'cancel' : 'end';
  const terms = 'terms' in command ? command.terms : event.release?.payload.terms;
  if (!terms) return fail('The visitor details for the original request are unavailable. Keep the saved request and refresh.');
  const review: PublishingReview = { kind, command, terms, previous: event.release?.payload.terms ?? null,
    changed: event.release ? audienceChanges(event.release.payload.terms, terms) : [], resume: true };
  const error = validatePublishingReview(review, event, session, now);
  return error ? fail(error) : { ok: true, review };
}

export async function confirmPublishingReview<T>(review: PublishingReview, ports: {
  read: () => Promise<EventAggregate | null>; session: () => AppSession; isCurrent: () => boolean; submit: (command: PublishingCommand) => Promise<T>;
}): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const event = await ports.read();
  if (!ports.isCurrent()) return fail('The account or event changed. Your draft and original request are kept.');
  if (!event) return fail('The event could not be refreshed. Your draft is kept and no new request was sent.');
  const error = validatePublishingReview(review, event, ports.session());
  if (error) return fail(error);
  return { ok: true, value: await ports.submit(review.command) };
}

export function submitPublishingCommand(repository: EventRepositoryContract, command: PublishingCommand): Promise<Result<PublishingValue>> {
  return 'terms' in command ? repository.publishEvent(command) : repository.replaceEvent(command);
}
