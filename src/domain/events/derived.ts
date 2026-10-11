import { deriveReadiness, sameSource, validateCurrentEntity } from '../readiness';
import { TIRAMISU_CHAIN_ID } from '../types';
import type { Actor, Snapshot } from '../types';
import type { AttendanceState, AttendanceStatus, EventAggregate, EventAvailability, EventRecord, EventRelease, EventRosterEntry, EventScope } from './types';
import { validateEventRecord, validateEventReleaseBinding } from './validation';
import { audienceHash } from './canonical';
import type { AudienceTerms } from './types';

export function currentEventSnapshot(snapshot: Snapshot, now: number): boolean {
  return snapshot.mode === 'public' && snapshot.chainId === TIRAMISU_CHAIN_ID && snapshot.source === 'arkiv'
    && typeof snapshot.blockNumber === 'string' && /^(0|[1-9][0-9]*)$/.test(snapshot.blockNumber)
    && typeof snapshot.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(snapshot.blockHash)
    && Number.isSafeInteger(now) && Number.isSafeInteger(snapshot.fetchedAt) && Number.isSafeInteger(snapshot.blockTimestamp)
    && snapshot.completeness === 'complete' && snapshot.freshness === 'fresh' && snapshot.reasons.length === 0
    && now >= snapshot.fetchedAt && now - snapshot.fetchedAt <= 60_000
    && now >= snapshot.blockTimestamp && now - snapshot.blockTimestamp <= 60_000;
}
const currentSnapshot = currentEventSnapshot;

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return left.mode === right.mode && left.chainId === right.chainId && left.blockNumber === right.blockNumber
    && left.blockHash === right.blockHash && left.blockTimestamp === right.blockTimestamp;
}

/** Authentication and the current audience release are needed even for cancellation/closure. */
function verifiedEvent(event: EventAggregate, now: number): boolean {
  if (!currentSnapshot(event.snapshot, now) || event.diagnostics.length || !event.root || !event.release || event.state.status !== 'unique') return false;
  if (event.root.key !== event.projectRoot || event.state.entity.payload.projectRoot !== event.projectRoot) return false;
  if (event.root.provenance.readonly !== true || event.root.provenance.permissionlessExtension !== false) return false;
  const authority = event.root.payload.coordinator;
  return validateCurrentEntity(event.root, event.snapshot, authority).valid
    && validateEventRecord(event.state.entity, event.snapshot, authority).valid
    && validateEventRecord(event.release, event.snapshot, authority).valid
    && validateEventReleaseBinding(event.state.entity.payload, event.release).valid;
}

export function deriveEventAvailability(event: EventAggregate, now = Date.now()): EventAvailability {
  if (!verifiedEvent(event, now) || event.state.status !== 'unique' || !event.release) return 'unverified';
  const state = event.state.entity.payload;
  if (state.status === 'cancelled') return 'cancelled';
  if (state.status === 'ended' || now >= event.release.payload.terms.endsAt) return 'ended';
  if (state.status === 'closed') return 'closed';
  if (event.release.payload.terms.termsVersion === 2 && !verifiedRoster(event, now)) return 'unverified';
  const project = event.sourceProject;
  if (!project || project.root.key !== event.projectRoot || !sameSnapshot(project.snapshot, event.snapshot)
    || !currentSnapshot(project.snapshot, now)) return 'unverified';
  const readiness = deriveReadiness(project, now);
  if (readiness.status === 'unverified' || readiness.status === 'conflict') return 'unverified';
  if (readiness.status !== 'ready' || readiness.lifecycle === 'closed'
    || !readiness.source || !sameSource(state.source, readiness.source)) return 'paused';
  if (event.release.payload.terms.termsVersion === 2) {
    const rules = event.release.payload.terms.registration!;
    if (rules.deadline !== null && now >= rules.deadline) return 'registration_closed';
    if (rules.capacity.kind === 'limited' && (state.admissions?.length ?? 0) >= rules.capacity.limit) return rules.waitlist ? 'waitlist' : 'full';
  }
  return 'open';
}

export const eventAvailability = deriveEventAvailability;

function verifiedRoster(event: EventAggregate, now: number): boolean {
  const roster = event.roster;
  if (!roster || roster.diagnostics.length || !sameSnapshot(roster.snapshot, event.snapshot) || !currentSnapshot(roster.snapshot, now)
    || event.state.status !== 'unique' || !event.release) return false;
  const capacity = event.release.payload.terms.registration?.capacity;
  if (capacity?.kind === 'limited' && (event.state.entity.payload.admissions?.length ?? 0) > capacity.limit) return false;
  if (new Set(roster.entries.map(entry => entry.attendee)).size !== roster.entries.length) return false;
  return (event.state.entity.payload.admissions ?? []).every(admission => {
    const entry = roster.entries.find(candidate => candidate.attendee === admission.attendee);
    if (!entry || entry.attendance.status !== 'unique' || !validateEventRecord(entry.attendance.entity, event.snapshot,
      { kind: 'wallet', address: admission.attendee }).valid) return false;
    const request = entry.attendance.entity;
    if (request.payload.projectRoot !== event.projectRoot) return false;
    // Keeping an owner reservation occupied does not require trusting or reconstructing deleted
    // predecessor claims. Any different current key remains unconfirmed until the owner binds it.
    if (request.key !== admission.attendanceKey) return true;
    const release = entry.registeredRelease;
    const rules = release?.payload.terms.registration;
    return !!release && release.key === admission.releaseKey && release.payload.projectRoot === event.projectRoot
      && release.payload.audienceHash === request.payload.audienceHash && request.payload.releaseKey === release.key
      && validateEventRecord(release, event.snapshot, event.root?.payload.coordinator).valid && request.payload.decision === 'going'
      && entry.inclusionTimestamp !== null && Number.isSafeInteger(entry.inclusionTimestamp) && entry.inclusionTimestamp <= event.snapshot.blockTimestamp
      && (rules?.deadline == null || entry.inclusionTimestamp < rules.deadline || release.payload.reconfirmationAccounts?.includes(admission.attendee))
      && (rules?.admission !== 'invite_only' || rules.invitedAccounts.includes(admission.attendee));
  });
}
export function eventRosterVerified(event: EventAggregate, now = Date.now()): boolean {
  return verifiedEvent(event, now) && verifiedRoster(event, now);
}

/** An immutable release plus a still-held owner reservation authorizes reconfirmation, never general late signup. */
export function hasRetainedRegistration(event: EventAggregate, attendee: string): boolean {
  const account = attendee.toLowerCase();
  return event.state.status === 'unique' && !!event.release?.payload.reconfirmationAccounts?.some(candidate => candidate === account)
    && !!event.state.entity.payload.admissions?.some(admission => admission.attendee === account);
}

/** Unreserved unlimited attendees need an explicitly reopened public deadline to accept changed terms. */
export function eventPublicationDeadlineGuard(event: EventAggregate, terms: AudienceTerms, now = Date.now()): 'ready' | 'reopen_required' | 'unverified' {
  if (!event.release || terms.registration?.deadline == null || terms.registration.deadline > now
    || audienceHash(terms) === event.release.payload.audienceHash) return 'ready';
  if (!eventRosterVerified(event, now)) return 'unverified';
  const admissions = event.state.status === 'unique' ? event.state.entity.payload.admissions ?? [] : [];
  const unreserved = event.roster!.entries.filter(entry => !admissions.some(admission => admission.attendee === entry.attendee))
    .map(entry => ({ status: attendanceStatus(entry.attendance, event, now, entry.registeredRelease),
      rules: entry.registeredRelease?.payload.terms.registration }));
  if (unreserved.some(entry => entry.status === 'unverified')) return 'unverified';
  return unreserved.some(entry => (entry.status === 'going' || entry.status === 'needs_review')
    && (!entry.rules || (entry.rules.capacity.kind === 'unlimited' && entry.rules.admission === 'open'))) ? 'reopen_required' : 'ready';
}

/** Existing timely requests may be confirmed after the signup deadline; their chain inclusion controls eligibility. */
export function requestEligibleForAdmission(event: EventAggregate, entry: EventRosterEntry, now = Date.now()): boolean {
  if (!eventRosterVerified(event, now) || !event.release || event.state.status !== 'unique'
    || event.state.entity.payload.status !== 'open' || now >= event.release.payload.terms.endsAt || entry.attendance.status !== 'unique') return false;
  if (!['open', 'full', 'waitlist', 'registration_closed'].includes(deriveEventAvailability(event, now))) return false;
  const rules = event.release.payload.terms.registration; const request = entry.attendance.entity;
  const observed = event.roster!.entries.find(candidate => candidate.attendee === entry.attendee);
  if (!observed || observed.attendance.status !== 'unique' || observed.attendance.entity.key !== request.key
    || observed.inclusionTimestamp !== entry.inclusionTimestamp || observed.registeredRelease?.key !== event.release.key) return false;
  if (!rules || request.payload.decision !== 'going' || request.payload.projectRoot !== event.projectRoot
    || request.payload.releaseKey !== event.release.key || request.payload.audienceHash !== event.release.payload.audienceHash
    || request.payload.attendee !== entry.attendee || !validateEventRecord(request, event.snapshot, { kind: 'wallet', address: entry.attendee }).valid
    || entry.inclusionTimestamp === null || !Number.isSafeInteger(entry.inclusionTimestamp) || entry.inclusionTimestamp < 0
    || entry.inclusionTimestamp > event.snapshot.blockTimestamp || (rules.deadline !== null && entry.inclusionTimestamp >= rules.deadline
      && !hasRetainedRegistration(event, entry.attendee))
    || (rules.admission === 'invite_only' && !rules.invitedAccounts.includes(entry.attendee))) return false;
  return true;
}
export function canAdmitAttendance(event: EventAggregate, entry: EventRosterEntry, now = Date.now()): boolean {
  if (!requestEligibleForAdmission(event, entry, now) || event.state.status !== 'unique') return false;
  const rules = event.release!.payload.terms.registration!;
  const admissions = event.state.entity.payload.admissions ?? [];
  return rules.capacity.kind === 'unlimited' || admissions.some(admission => admission.attendee === entry.attendee) || admissions.length < rules.capacity.limit;
}

export interface RegistrationEligibility {
  status: EventAvailability | 'join' | 'request' | 'invitation_required';
  requiresApproval: boolean;
  remaining: number | null;
}

/** This is an invitation to submit a request, not a reservation or promise about the next block. */
export function registrationEligibility(event: EventAggregate, actor?: Actor, now = Date.now()): RegistrationEligibility {
  const rules = event.release?.payload.terms.registration;
  const requiresApproval = !!rules && (rules.capacity.kind === 'limited' || rules.admission === 'invite_only');
  const availability = deriveEventAvailability(event, now);
  const remaining = rules?.capacity.kind === 'limited' && verifiedRoster(event, now) && event.state.status === 'unique'
    ? Math.max(0, rules.capacity.limit - (event.state.entity.payload.admissions?.length ?? 0)) : null;
  const retained = actor?.kind === 'wallet' && hasRetainedRegistration(event, actor.address);
  if (!['open', 'full', 'waitlist'].includes(availability) && !(availability === 'registration_closed' && retained)) return { status: availability, requiresApproval, remaining };
  if (rules?.admission === 'invite_only' && (!actor || actor.kind !== 'wallet'
    || !rules.invitedAccounts.includes(actor.address.toLowerCase() as typeof rules.invitedAccounts[number]))) {
    return { status: 'invitation_required', requiresApproval, remaining };
  }
  if (availability === 'registration_closed' && retained) return { status: 'request', requiresApproval, remaining };
  if ((availability === 'full' || availability === 'waitlist') && actor?.kind === 'wallet' && event.state.status === 'unique'
    && event.state.entity.payload.admissions?.some(admission => admission.attendee === actor.address.toLowerCase())) {
    return { status: 'request', requiresApproval, remaining };
  }
  return { status: availability === 'open' ? requiresApproval ? 'request' : 'join' : availability, requiresApproval, remaining };
}

/** An attendance decision is an intention to attend, never proof of physical attendance. */
export function attendanceStatus(attendance: EventScope<AttendanceState>, event: EventAggregate, now = Date.now(),
  registeredRelease?: EventRecord<EventRelease> | null): AttendanceStatus {
  if (!currentSnapshot(event.snapshot, now)) return 'unverified';
  if (attendance.status === 'missing') return attendance.reason === 'not_initialized' ? 'not_registered' : 'unverified';
  if (attendance.status !== 'unique' || attendance.entity.payload.projectRoot !== event.projectRoot
    || !validateEventRecord(attendance.entity, event.snapshot).valid) return 'unverified';
  // A missing event reference never turns a person's own recorded withdrawal into another decision.
  if (attendance.entity.payload.decision === 'withdrawn') return 'withdrawn';
  if (!verifiedEvent(event, now) || !event.release) return 'unverified';
  const accepted = registeredRelease === undefined ? event.release : registeredRelease;
  if (!accepted || accepted.key !== attendance.entity.payload.releaseKey
    || accepted.payload.projectRoot !== event.projectRoot || accepted.payload.audienceHash !== attendance.entity.payload.audienceHash
    || !validateEventRecord(accepted, event.snapshot, event.root!.payload.coordinator).valid) return 'unverified';
  const availability = deriveEventAvailability(event, now);
  if (availability === 'unverified') return 'unverified';
  if (availability === 'cancelled' || availability === 'ended') return availability;
  // Consent belongs to one exact audience release; publishing an earlier hash again cannot revive it.
  if (attendance.entity.payload.releaseKey !== event.release.key
    || attendance.entity.payload.audienceHash !== event.release.payload.audienceHash) return 'needs_review';
  if (event.release.payload.terms.termsVersion === 2) {
    if (!verifiedRoster(event, now)) return 'unverified';
    const request = attendance.entity; const rules = event.release.payload.terms.registration!;
    const entry = event.roster!.entries.find(candidate => candidate.attendee === request.payload.attendee);
    if (!entry || entry.attendance.status !== 'unique' || entry.attendance.entity.key !== request.key
      || entry.inclusionTimestamp === null || !Number.isSafeInteger(entry.inclusionTimestamp)
      || entry.inclusionTimestamp < 0 || entry.inclusionTimestamp > event.snapshot.blockTimestamp) return 'unverified';
    if (rules.deadline !== null && entry.inclusionTimestamp >= rules.deadline && !hasRetainedRegistration(event, request.payload.attendee)) return 'registration_closed';
    if (rules.admission === 'invite_only' && !rules.invitedAccounts.includes(request.payload.attendee)) return 'invitation_required';
    const admissions = event.state.status === 'unique' ? event.state.entity.payload.admissions ?? [] : [];
    if (rules.capacity.kind === 'unlimited' && rules.admission === 'open') return 'going';
    if (admissions.some(admission => admission.attendee === request.payload.attendee && admission.attendanceKey === request.key
      && admission.releaseKey === event.release!.key)) return 'going';
    if (admissions.some(admission => admission.attendee === request.payload.attendee)) return 'pending';
    if (rules.capacity.kind === 'limited' && admissions.length >= rules.capacity.limit) return rules.waitlist && request.payload.joinWaitlist ? 'waitlisted' : 'full';
    return 'pending';
  }
  return 'going';
}
