import { deriveReadiness, sameSource, validateCurrentEntity } from '../readiness';
import { TIRAMISU_CHAIN_ID } from '../types';
import type { Snapshot } from '../types';
import type { AttendanceState, AttendanceStatus, EventAggregate, EventAvailability, EventRecord, EventRelease, EventScope } from './types';
import { validateEventRecord, validateEventReleaseBinding } from './validation';

function currentSnapshot(snapshot: Snapshot, now: number): boolean {
  return snapshot.mode === 'public' && snapshot.chainId === TIRAMISU_CHAIN_ID && snapshot.source === 'arkiv'
    && typeof snapshot.blockNumber === 'string' && /^(0|[1-9][0-9]*)$/.test(snapshot.blockNumber)
    && typeof snapshot.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(snapshot.blockHash)
    && Number.isSafeInteger(now) && Number.isSafeInteger(snapshot.fetchedAt) && Number.isSafeInteger(snapshot.blockTimestamp)
    && snapshot.completeness === 'complete' && snapshot.freshness === 'fresh' && snapshot.reasons.length === 0
    && now >= snapshot.fetchedAt && now - snapshot.fetchedAt <= 60_000
    && now >= snapshot.blockTimestamp && now - snapshot.blockTimestamp <= 60_000;
}

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
  const project = event.sourceProject;
  if (!project || project.root.key !== event.projectRoot || !sameSnapshot(project.snapshot, event.snapshot)
    || !currentSnapshot(project.snapshot, now)) return 'unverified';
  const readiness = deriveReadiness(project, now);
  if (readiness.status === 'unverified' || readiness.status === 'conflict') return 'unverified';
  if (readiness.status !== 'ready' || readiness.lifecycle === 'closed'
    || !readiness.source || !sameSource(state.source, readiness.source)) return 'paused';
  return 'open';
}

export const eventAvailability = deriveEventAvailability;

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
  return 'going';
}
