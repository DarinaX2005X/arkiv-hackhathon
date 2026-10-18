import { isAccountAddress, isPublicEntityKey } from '../../app/ids';
import type { AppSession } from '../../app/session';
import { createDraftStore, type StoragePort } from '../../app/storage';
import { createOperationIntent } from '../../data/operations';
import type { ReplaceAttendanceCommand } from '../../data/events/types';
import { attendanceStatus, registrationEligibility, validateEventRecord } from '../../domain/events';
import type { AccountAddress, ContentHash, PublicEntityKey } from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { EventRead } from '../events/hooks';

export interface JoinTarget {
  projectRoot: PublicEntityKey;
  releaseKey: PublicEntityKey;
  audienceHash: ContentHash;
  attendee: AccountAddress | null;
  selectedAt: number;
}

export function validJoinTarget(value: unknown): value is JoinTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return Object.keys(target).sort().join(',') === 'attendee,audienceHash,projectRoot,releaseKey,selectedAt'
    && isPublicEntityKey(target.projectRoot) && isPublicEntityKey(target.releaseKey) && isPublicEntityKey(target.audienceHash)
    && (target.attendee === null || isAccountAddress(target.attendee))
    && Number.isSafeInteger(target.selectedAt) && Number(target.selectedAt) >= 0;
}

export function joinTargetStore(storage: StoragePort | null, projectRoot: PublicEntityKey) {
  return createDraftStore({ storage, key: `partfolk:events:join:${projectRoot.toLowerCase()}`, kind: 'event-join-target', validate: validJoinTarget });
}

export function clearJoinTarget(storage: StoragePort | null, projectRoot: PublicEntityKey, reviewed: JoinTarget): boolean {
  try {
    if (!storage) return false;
    const saved = joinTargetStore(storage, projectRoot).load();
    if (saved.status !== 'ready' || saved.value.projectRoot !== reviewed.projectRoot
      || saved.value.releaseKey !== reviewed.releaseKey || saved.value.audienceHash !== reviewed.audienceHash
      || saved.value.attendee !== reviewed.attendee || saved.value.selectedAt !== reviewed.selectedAt) return false;
    storage.removeItem(`partfolk:events:join:${projectRoot.toLowerCase()}`);
    return true;
  } catch { return false; }
}

export interface WithdrawalTarget extends JoinTarget { attendanceKey: PublicEntityKey }

export function targetForWithdrawal(read: EventRead, session: AppSession, now = Date.now()): WithdrawalTarget | null {
  const own = read.attendance;
  if (own?.status !== 'unique' || session.actor?.kind !== 'wallet' || !isPublicEntityKey(own.entity.key)
    || !isPublicEntityKey(own.entity.payload.projectRoot) || !isPublicEntityKey(own.entity.payload.releaseKey)) return null;
  return { projectRoot: own.entity.payload.projectRoot, attendanceKey: own.entity.key, releaseKey: own.entity.payload.releaseKey,
    audienceHash: own.entity.payload.audienceHash, attendee: session.actor.address.toLowerCase() as AccountAddress, selectedAt: now };
}

export function targetForEvent(read: EventRead, session: AppSession, now = Date.now()): JoinTarget | null {
  const release = read.event.release;
  if (!release || !isPublicEntityKey(read.event.projectRoot) || !isPublicEntityKey(release.key)) return null;
  return { projectRoot: read.event.projectRoot, releaseKey: release.key, audienceHash: release.payload.audienceHash,
    attendee: session.actor?.kind === 'wallet' ? session.actor.address.toLowerCase() as AccountAddress : null, selectedAt: now };
}

export function targetMatchesEvent(target: JoinTarget, read: EventRead): boolean {
  return target.projectRoot === read.event.projectRoot && target.releaseKey === read.event.release?.key
    && target.audienceHash === read.event.release.payload.audienceHash;
}

/** Record lifetime is explicit and bounded; it is not a promise about future network access. */
export function registrationLifetime(endsAt: number, now: number): number {
  return Math.max(90 * 86_400, Math.ceil((endsAt + 30 * 86_400_000 - now + 60_000) / 2_000) * 2);
}

export function prepareRegistration(read: EventRead, target: JoinTarget, session: AppSession, now = Date.now(), joinWaitlist = false):
  { ok: true; command: ReplaceAttendanceCommand } | { ok: false; message: string } {
  if (session.mode !== 'public' || session.actor?.kind !== 'wallet') return { ok: false, message: 'Sign in with your wallet to review this registration.' };
  if (session.chainId !== TIRAMISU_CHAIN_ID) return { ok: false, message: 'Switch your wallet to Tiramisu before confirming.' };
  if (!target.attendee || target.attendee.toLowerCase() !== session.actor.address.toLowerCase()
    || read.actor?.address.toLowerCase() !== session.actor.address.toLowerCase()) return { ok: false, message: 'The wallet changed. Review the registration with your current wallet before continuing.' };
  if (!targetMatchesEvent(target, read)) return { ok: false, message: 'The event details changed. Review the current time, place and participation conditions before confirming.' };
  const eligibility = registrationEligibility(read.event, session.actor, now);
  if (!['join', 'request', 'waitlist'].includes(eligibility.status)) return { ok: false, message: eligibility.status === 'invitation_required' ? 'This wallet is not on the invitation list.' : 'This event is not currently accepting registrations. Refresh its status before continuing.' };
  if (eligibility.status === 'waitlist' && !joinWaitlist) return { ok: false, message: 'All places are reserved. Choose the waiting list explicitly to request a place.' };
  if (joinWaitlist && !read.event.release?.payload.terms.registration?.waitlist) return { ok: false, message: 'This event does not offer a waiting list.' };
  const scope = read.attendance;
  if (!scope || scope.status === 'unverified' || scope.status === 'conflict'
    || (scope.status === 'missing' && scope.reason !== 'not_initialized')) return { ok: false, message: 'Your previous registration could not be verified. Refresh before sending another decision.' };
  if (scope.status === 'unique' && scope.entity.payload.attendee.toLowerCase() !== session.actor.address.toLowerCase()) return { ok: false, message: 'This registration belongs to a different wallet. Refresh before continuing.' };
  if (['going', 'pending', 'waitlisted'].includes(attendanceStatus(scope, read.event, now, read.myEvent?.registeredRelease ?? read.event.release))) return { ok: false, message: 'This wallet is already registered for these event details.' };
  const lifetimeSeconds = registrationLifetime(read.event.release!.payload.terms.endsAt, Math.min(now, read.event.snapshot.blockTimestamp));
  if (lifetimeSeconds > 10 * 366 * 86_400) return { ok: false, message: 'This event is too far in the future for the supported record lifetime.' };
  const input = { lifetimeSeconds, projectRoot: target.projectRoot, releaseKey: target.releaseKey, audienceHash: target.audienceHash,
    decision: 'going' as const, ...(joinWaitlist ? { joinWaitlist: true } : {}), expectedHeads: scope.status === 'unique' ? [scope.entity.key] : [] };
  return { ok: true, command: { ...input, operation: createOperationIntent('replace_attendance', {
    mode: 'public', chainId: TIRAMISU_CHAIN_ID, actor: { kind: 'wallet', address: session.actor.address.toLowerCase() as AccountAddress },
  }, input, { now }) } };
}

/** A person may withdraw even when the event or the organizer's source is unavailable. */
export function prepareWithdrawal(read: EventRead, target: WithdrawalTarget, session: AppSession, now = Date.now()):
  { ok: true; command: ReplaceAttendanceCommand } | { ok: false; message: string } {
  if (session.mode !== 'public' || session.actor?.kind !== 'wallet' || session.chainId !== TIRAMISU_CHAIN_ID
    || session.actor.address.toLowerCase() !== target.attendee?.toLowerCase() || read.actor?.address.toLowerCase() !== session.actor.address.toLowerCase()) {
    return { ok: false, message: 'Connect the Tiramisu wallet shown in this withdrawal review before continuing.' };
  }
  const own = read.attendance;
  const snapshot = read.event.snapshot;
  if (own?.status !== 'unique' || snapshot.freshness !== 'fresh' || snapshot.completeness !== 'complete' || snapshot.reasons.length
    || now < snapshot.fetchedAt || now - snapshot.fetchedAt > 60_000 || !validateEventRecord(own.entity, snapshot, session.actor).valid) {
    return { ok: false, message: 'Your current registration could not be verified. Refresh it before withdrawing.' };
  }
  const previous = own.entity.payload;
  if (previous.decision === 'withdrawn') return { ok: false, message: 'Your registration is already withdrawn.' };
  if (own.entity.key !== target.attendanceKey || previous.projectRoot !== target.projectRoot || previous.releaseKey !== target.releaseKey
    || previous.audienceHash !== target.audienceHash || previous.attendee.toLowerCase() !== target.attendee?.toLowerCase()) {
    return { ok: false, message: 'Your registration changed. Review the current decision before withdrawing.' };
  }
  const input = { lifetimeSeconds: 90 * 86_400, projectRoot: previous.projectRoot, releaseKey: previous.releaseKey,
    audienceHash: previous.audienceHash, decision: 'withdrawn' as const, expectedHeads: [own.entity.key] };
  return { ok: true, command: { ...input, operation: createOperationIntent('replace_attendance', {
    mode: 'public', chainId: TIRAMISU_CHAIN_ID, actor: { kind: 'wallet', address: session.actor.address.toLowerCase() as AccountAddress },
  }, input, { now }) } };
}
