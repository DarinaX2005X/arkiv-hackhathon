import type { AppSession } from '../../../app/session';
import { createOperationIntent } from '../../../data/operations';
import type { ReplaceEventCommand } from '../../../data/events/types';
import { canonicalJson, hashCanonical } from '../../../domain/canonical';
import { canAdmitAttendance, validateEventRecord, validateEventReleaseBinding, type EventAggregate } from '../../../domain/events';
import { sameActor } from '../../../domain/readiness';
import { TIRAMISU_CHAIN_ID, type AccountAddress } from '../../../domain/types';
import { organizerAccess, publishingLifetime } from './model';

export interface AdmissionReview { kind: 'admit' | 'release'; attendee: AccountAddress; command: ReplaceEventCommand }
function admissionInput(event: EventAggregate, session: AppSession, attendee: AccountAddress, kind: AdmissionReview['kind'], now: number) {
  const access = organizerAccess(event, session, now);
  if (access) return { ok: false as const, message: access };
  if (event.state.status !== 'unique' || !event.release || !event.root
    || !validateEventRecord(event.state.entity, event.snapshot, event.root.payload.coordinator).valid
    || !validateEventRecord(event.release, event.snapshot, event.root.payload.coordinator).valid
    || !validateEventReleaseBinding(event.state.entity.payload, event.release).valid) return { ok: false as const, message: 'The current event could not be verified. Refresh before changing a place.' };
  const state = event.state.entity.payload, existing = state.admissions ?? [];
  if (state.status === 'cancelled' || state.status === 'ended') return { ok: false as const, message: 'This event is final. Its places cannot change.' };
  let admissions = existing.filter(item => item.attendee.toLowerCase() !== attendee.toLowerCase());
  if (kind === 'release') {
    if (admissions.length === existing.length) return { ok: false as const, message: 'This wallet no longer has a reserved place. Refresh the list.' };
  } else {
    const entry = event.roster?.entries.find(item => item.attendee.toLowerCase() === attendee.toLowerCase());
    if (!entry || entry.attendance.status !== 'unique' || !canAdmitAttendance(event, entry, now)) return { ok: false as const, message: 'This request cannot be confirmed now. Refresh to check the current request, available places and event preparations.' };
    const request = entry.attendance.entity;
    if (existing.some(item => item.attendee === entry.attendee && item.attendanceKey === request.key && item.releaseKey === event.release!.key)) return { ok: false as const, message: 'This exact request already has a confirmed place.' };
    admissions = [...admissions, { attendee: entry.attendee, attendanceKey: entry.attendance.entity.key, releaseKey: event.release.key }];
  }
  return { ok: true as const, input: { projectRoot: event.projectRoot, releaseKey: event.release.key, audienceHash: event.release.payload.audienceHash,
    source: state.source, status: state.status, admissions, expectedHeads: [event.state.entity.key], lifetimeSeconds: publishingLifetime(event.release.payload.terms.endsAt, Math.min(now, event.snapshot.blockTimestamp)) } };
}
export function prepareAdmissionReview(event: EventAggregate, session: AppSession, attendee: AccountAddress, kind: AdmissionReview['kind'], now = Date.now()): { ok: true; review: AdmissionReview } | { ok: false; message: string } {
  const result = admissionInput(event, session, attendee, kind, now);
  if (!result.ok) return result;
  if (session.actor?.kind !== 'wallet') return { ok: false, message: 'Sign in with the organizer wallet.' };
  const command = { ...result.input, operation: createOperationIntent('replace_event', { mode: 'public', chainId: TIRAMISU_CHAIN_ID, actor: session.actor }, result.input, { now }) };
  return { ok: true, review: { kind, attendee, command } };
}
export function validateAdmissionReview(review: AdmissionReview, event: EventAggregate, session: AppSession, now = Date.now()): string | null {
  const { operation, ...input } = review.command;
  if (operation.kind !== 'replace_event' || !sameActor(operation.authority.actor, session.actor ?? undefined)
    || operation.inputHash !== hashCanonical(input) || operation.inputHash !== hashCanonical(operation.input)) return 'The account or saved place decision changed. Start a fresh review.';
  const next = admissionInput(event, session, review.attendee, review.kind, now);
  if (!next.ok) return next.message;
  if (canonicalJson({ ...next.input, lifetimeSeconds: input.lifetimeSeconds }) !== canonicalJson(input)) return 'The event or its places changed while you reviewed. Refresh and review this decision again.';
  return null;
}

