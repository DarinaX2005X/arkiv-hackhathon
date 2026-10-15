import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionRecovery } from '../../app/ActionRecovery';
import { routeHref, routePath } from '../../app/routes';
import type { AppSession } from '../../app/session';
import type { StoragePort } from '../../app/storage';
import type { EventRepositoryContract, ReplaceAttendanceCommand } from '../../data/events/types';
import type { MutationResult } from '../../data/types';
import { attendanceStatus, deriveEventAvailability, registrationEligibility, type AttendanceState, type EventRecord } from '../../domain/events';
import { TIRAMISU_CHAIN_ID, type PublicEntityKey } from '../../domain/types';
import { Button, Checkbox, Link, Notice } from '../../ui';
import type { EventRead } from '../events/hooks';
import { EventFactIcon } from '../events/cover';
import { availabilityCopy, eventDate, eventError, shortAddress, eventPlace, downloadEventCalendar } from '../events/presentation';
import { browserEventStorage, useEventAction } from '../events/useEventAction';
import { clearJoinTarget, joinTargetStore, prepareRegistration, prepareWithdrawal, registrationLifetime, targetForEvent, targetForWithdrawal, targetMatchesEvent, type JoinTarget, type WithdrawalTarget } from './intent';
import { attendanceRequestCopy } from './status';

export interface RegistrationPanelProps {
  repository: EventRepositoryContract | null;
  session: AppSession;
  projectRoot: PublicEntityKey;
  read: EventRead;
  now: number;
  unverified?: boolean;
  refresh: () => Promise<EventRead | null>;
  refreshWithdrawal: () => Promise<EventRead | null>;
  storage?: StoragePort | null;
}

export function RegistrationPanel({ repository, session, projectRoot, read, now, unverified = false, refresh, refreshWithdrawal, storage: suppliedStorage }: RegistrationPanelProps) {
  const storage = suppliedStorage === undefined ? browserEventStorage() : suppliedStorage;
  const store = useMemo(() => joinTargetStore(storage, projectRoot), [storage, projectRoot]);
  const [target, setTarget] = useState<JoinTarget | null>(null);
  const [withdrawal, setWithdrawal] = useState<WithdrawalTarget | null>(null);
  const [joinWaitlist, setJoinWaitlist] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [storageIssue, setStorageIssue] = useState(false);
  const sessionRef = useRef(session); sessionRef.current = session;
  const busy = useRef(false);
  const { controller: action, state } = useEventAction(repository, session, `attendance:${projectRoot}`, storage);
  useEffect(() => {
    const loaded = store.load();
    setTarget(loaded.status === 'ready' ? loaded.value : null);
    setStorageIssue(loaded.status === 'unavailable' || loaded.status === 'recovery');
    setAcknowledged(false); setMessage(null);
  }, [store]);
  const account = session.actor?.kind === 'wallet' ? session.actor.address : null;
  useEffect(() => { setAcknowledged(false); }, [account, read.event.release?.key]);
  // Sign-in restores the selected event. It never restores consent or sends a transaction.
  useEffect(() => {
    if (!target || target.attendee || !account) return;
    const bound = { ...target, attendee: account.toLowerCase() as typeof account };
    setTarget(bound); const saved = store.save(bound); setStorageIssue(!saved.persisted);
  }, [account, target, store]);
  const terms = read.event.release?.payload.terms;
  const availability = unverified ? 'unverified' : deriveEventAvailability(read.event, now);
  const ownStatus = unverified || !read.attendance || read.actor?.address.toLowerCase() !== account?.toLowerCase() ? 'unverified'
    : attendanceStatus(read.attendance, read.event, now, read.myEvent?.registeredRelease ?? null);
  const eligibility = registrationEligibility(read.event, session.actor ?? undefined, now);
  const retainedPlace = availability !== 'unverified' && read.event.state.status === 'unique' && read.event.state.entity.payload.admissions?.some(item => item.attendee.toLowerCase() === account?.toLowerCase());
  const requestCopy = attendanceRequestCopy(ownStatus);
  const requested = requestCopy !== null;
  const canStart = !unverified && ['join', 'request', 'waitlist'].includes(eligibility.status);
  const requestLabel = eligibility.status === 'waitlist' ? 'Join waiting list' : eligibility.requiresApproval ? 'Request a place' : 'Join event';
  const signedIn = session.mode === 'public' && account !== null;
  const correctChain = session.chainId === TIRAMISU_CHAIN_ID;
  const differentWallet = Boolean(target?.attendee && target.attendee.toLowerCase() !== account?.toLowerCase());
  const changedTerms = Boolean(target && !targetMatchesEvent(target, read));
  const unresolved = state.status === 'needs-verification' || state.status === 'submitting';
  const savedRetry = state.status === 'rejected';
  const submitting = checking || state.status === 'submitting';
  const ownKnown = read.attendance?.status === 'unique' || (read.attendance?.status === 'missing' && read.attendance.reason === 'not_initialized');
  const registered = ownStatus === 'going';
  const withdrawn = ownStatus === 'withdrawn';
  const freshConfirmation = registered;
  const savedCommand = action.recoverableCommand as ReplaceAttendanceCommand | null;
  const retryingWithdrawal = savedRetry && savedCommand?.decision === 'withdrawn';
  const refreshSavedDecision = savedCommand?.decision === 'withdrawn' ? refreshWithdrawal : refresh;
  const canConfirm = signedIn && correctChain && canStart && ownKnown && target && !changedTerms && !differentWallet
    && acknowledged && !submitting && !unresolved && !storageIssue && !registered && !requested && (eligibility.status !== 'waitlist' || joinWaitlist) && state.status !== 'confirmed';
  const signInHref = routeHref({ name: 'sign-in', returnTo: routePath({ name: 'event', projectRoot }) });

  function chooseCurrent() {
    const next = targetForEvent(read, sessionRef.current);
    if (!next) return;
    if (['rejected', 'reverted', 'confirmed'].includes(state.status)) action.clear();
    setTarget(next); setJoinWaitlist(false); setWithdrawal(null); setAcknowledged(false); setMessage(null);
    const saved = store.save(next); setStorageIssue(!saved.persisted);
  }

  async function checkOriginal() {
    if (busy.current) return; busy.current = true; setChecking(true); setMessage(null);
    try { await action.reconcile(); await refreshSavedDecision(); }
    finally { busy.current = false; setChecking(false); }
  }

  async function confirm() {
    if (!canConfirm || !target || busy.current) return;
    busy.current = true; setChecking(true); setMessage(null);
    const selected = target;
    try {
      const fresh = await refresh();
      if (!fresh) { setMessage('The event could not be refreshed. Nothing new was sent. Your review is kept.'); return; }
      const prepared = prepareRegistration(fresh, selected, sessionRef.current, Date.now(), joinWaitlist);
      if (!prepared.ok) { setAcknowledged(false); setMessage(prepared.message); return; }
      const old = action.recoverableCommand as ReplaceAttendanceCommand | null;
      const sameRetry = savedRetry && old && old.operation.kind === 'replace_attendance'
        && old.projectRoot === prepared.command.projectRoot && old.releaseKey === prepared.command.releaseKey
        && old.audienceHash === prepared.command.audienceHash && old.decision === 'going' && Boolean(old.joinWaitlist) === Boolean(prepared.command.joinWaitlist)
        && JSON.stringify(old.expectedHeads) === JSON.stringify(prepared.command.expectedHeads);
      if (savedRetry && !sameRetry) { setMessage('The saved request no longer matches the current event. Review the latest details to prepare a new registration.'); setAcknowledged(false); return; }
      const result = sameRetry
        ? await action.resume<ReplaceAttendanceCommand, MutationResult<EventRecord<AttendanceState>>>((repo, command) => repo.replaceAttendance(command))
        : await action.run(prepared.command, (repo, command) => repo.replaceAttendance(command));
      setAcknowledged(false);
      if (!result.ok) { setMessage(eventError(result.error)); return; }
      // A receipt alone is not the confirmation shown to the attendee.
      const verified = await refresh();
      const going = verified?.attendance && ['going', 'pending', 'waitlisted'].includes(attendanceStatus(verified.attendance, verified.event, Date.now(), verified.myEvent?.registeredRelease ?? null));
      if (!going) setMessage('The transaction was recorded, but your current registration still needs a fresh check. Refresh your registration before relying on it.');
      else { setTarget(null); clearJoinTarget(storage, projectRoot); }
    } finally { busy.current = false; setChecking(false); }
  }

  function chooseWithdrawal() {
    const selected = targetForWithdrawal(read, sessionRef.current);
    if (!selected) return;
    if (state.status === 'confirmed' || state.status === 'reverted' || state.status === 'rejected' && savedCommand?.decision !== 'withdrawn') action.clear();
    setWithdrawal(selected); setAcknowledged(false); setMessage(null);
  }

  async function confirmWithdrawal() {
    if (!withdrawal || !acknowledged || !correctChain || unresolved || submitting || busy.current) return;
    busy.current = true; setChecking(true); setMessage(null);
    const selected = withdrawal;
    try {
      const fresh = await refreshWithdrawal();
      if (!fresh) { setMessage('Your registration could not be refreshed. No withdrawal was sent.'); return; }
      const prepared = prepareWithdrawal(fresh, selected, sessionRef.current, Date.now());
      if (!prepared.ok) { setMessage(prepared.message); setAcknowledged(false); return; }
      const old = action.recoverableCommand as ReplaceAttendanceCommand | null;
      const sameRetry = retryingWithdrawal && old && old.projectRoot === prepared.command.projectRoot
        && old.releaseKey === prepared.command.releaseKey && old.audienceHash === prepared.command.audienceHash
        && JSON.stringify(old.expectedHeads) === JSON.stringify(prepared.command.expectedHeads);
      if (savedRetry && !sameRetry) { setMessage('The saved request differs from this withdrawal. Resolve the original request before changing your decision.'); return; }
      const result = sameRetry
        ? await action.resume<ReplaceAttendanceCommand, MutationResult<EventRecord<AttendanceState>>>((repo, command) => repo.replaceAttendance(command))
        : await action.run(prepared.command, (repo, command) => repo.replaceAttendance(command));
      setAcknowledged(false);
      if (!result.ok) { setMessage(eventError(result.error)); return; }
      const verified = await refreshWithdrawal();
      const recorded = verified?.attendance && attendanceStatus(verified.attendance, verified.event, Date.now(), verified.myEvent?.registeredRelease ?? null) === 'withdrawn';
      if (recorded) { setWithdrawal(null); setTarget(null); clearJoinTarget(storage, projectRoot); }
      else setMessage('The transaction was recorded. Refresh your registration to verify that the withdrawal is current.');
    } finally { busy.current = false; setChecking(false); }
  }

  return <aside className={`pf-event-registration pf-surface-light${freshConfirmation ? ' pf-event-registration--confirmed' : ''}`} aria-labelledby="registration-title" aria-busy={submitting}>
    <div className="pf-event-registration-heading"><span className="pf-event-registration-icon"><EventFactIcon name={freshConfirmation ? 'check' : 'people'} /></span>
      <h2 id="registration-title">{freshConfirmation ? eligibility.requiresApproval ? 'Your place is confirmed' : 'You’re registered' : requestCopy?.title ?? (withdrawn ? 'You withdrew' : 'Take part in this event')}</h2></div>
    {freshConfirmation ? <><Notice tone="success" role="status">{eligibility.requiresApproval ? 'The organizer confirmed your place for this event version.' : 'Your registration is recorded for the event details shown here.'}</Notice>
      <p>Registered as <span title={account ?? undefined}>{account ? shortAddress(account) : 'your wallet'}</span>.</p>
      <Link href={routeHref({ name: 'my-events' })}>View my events</Link></>
      : requestCopy ? <><Notice tone="warning" role="status">{requestCopy.message}</Notice><Link href={routeHref({ name: 'my-events' })}>View my events</Link></> : withdrawn ? <><Notice role="status">Your withdrawal is recorded. You can choose to join again if registration is open.</Notice><Link href={routeHref({ name: 'my-events' })}>View my events</Link></>
        : <p>{eligibility.requiresApproval ? 'Request a place and wait for the organizer to confirm it.' : 'Review the event details, then confirm your registration.'}</p>}
    {availability !== 'open' && !requested && !(eligibility.status === 'request' && retainedPlace) && <Notice tone={availabilityCopy[availability].tone} title={availabilityCopy[availability].label}>{availabilityCopy[availability].explanation}</Notice>}
    {availability !== 'unverified' && eligibility.status === 'invitation_required' && !requested && <Notice tone="warning" title="Invitation required">{signedIn ? 'This wallet is not on the event’s public invitation list. Use an invited wallet or contact the organizer.' : 'Sign in with an invited wallet to check your invitation.'}{!signedIn && <Link href={signInHref} onClick={chooseCurrent}>Sign in to check invitation</Link>}</Notice>}
    {eligibility.status === 'request' && retainedPlace && !registered && !requested && <Notice>Your previous place remains reserved. Review the latest event details and request confirmation for this version.</Notice>}
    {eligibility.remaining !== null && availability !== 'unverified' && <p className="pf-event-capacity"><EventFactIcon name="people" /><span><strong>{eligibility.remaining}</strong> {eligibility.remaining === 1 ? 'place' : 'places'} currently unreserved</span></p>}
    {freshConfirmation && terms && <Button variant="secondary" onClick={() => downloadEventCalendar(terms, projectRoot)}>Add to calendar</Button>}
    {ownStatus === 'needs_review' && <Notice tone="warning" title="Review this new version">The organizer published a new version of this event. Your earlier registration belongs to the previous version. Review the latest details before confirming again.</Notice>}
    {signedIn && !ownKnown && !unresolved && <Notice tone="warning" actions={<Button variant="secondary" onClick={() => void refresh()} disabled={submitting}>Check my registration</Button>}>Your existing registration could not be fully checked. No new decision will be sent until it is verified.</Notice>}
    {state.status === 'confirmed' && !freshConfirmation && !requested && !withdrawn && <Notice tone="warning" actions={<><Button variant="secondary" onClick={() => void refreshSavedDecision()} disabled={submitting}>Refresh my registration</Button>
      {ownKnown && canStart && <Button variant="secondary" onClick={chooseCurrent}>Review a new registration</Button>}</>}>Your earlier transaction is confirmed. Check the current event and registration before making another decision.</Notice>}
    {message && <Notice tone="warning" role="status">{message}</Notice>}
    {storageIssue && <Notice tone="warning">This browser could not retain your selected event safely. Keep this page open. Enable browser storage and reopen the event before sending a registration.</Notice>}
    {unresolved && <Notice tone="warning" title={state.status === 'submitting' ? 'Waiting for the wallet and network' : 'Check your saved registration'}>
      <p>{state.status === 'submitting' ? 'Keep this page open while the request is sent and checked.' : state.message || 'The original request may already have been sent. Check that request before making another decision.'}</p>
      <ActionRecovery action={{ recoveryText: action.recoveryText, restoreRecovery: action.restoreRecovery }} />
      {state.operation && <Button variant="secondary" onClick={() => void checkOriginal()} disabled={submitting || !correctChain}>Check original request</Button>}
    </Notice>}
    {savedRetry && <Notice role="status">No transaction was sent. Review the same {retryingWithdrawal ? 'withdrawal' : 'registration'} and confirm below to retry the saved request.</Notice>}
    {!registered && !requested && !unresolved && canStart && !target && !withdrawal && !retryingWithdrawal && <>
      {signedIn ? <Button onClick={chooseCurrent} disabled={!ownKnown}>{withdrawn ? 'Review joining again' : requestLabel}</Button>
        : <Link className="pf-button pf-button--primary" href={signInHref} onClick={chooseCurrent}>{requestLabel}</Link>}
    </>}
    {!registered && !requested && !unresolved && target && !withdrawal && !signedIn && <><p>Your selected event is kept while you sign in. You will review the public record before confirming.</p><Link className="pf-button pf-button--primary" href={signInHref}>Sign in to continue</Link></>}
    {!registered && !requested && !unresolved && target && !withdrawal && !retryingWithdrawal && signedIn && <>
      {(changedTerms || differentWallet) ? <Notice tone="warning" title={differentWallet ? 'The wallet changed' : 'The event details changed'} actions={<Button variant="secondary" onClick={chooseCurrent} disabled={!canStart}>Review current details</Button>}>
        {differentWallet ? 'This review belongs to another wallet. Start a new review for the wallet currently connected.' : 'The version selected before sign-in is no longer current. Check the updated details before registering.'}
      </Notice> : terms && <div className="pf-event-public-preview">
        <h3>{eligibility.requiresApproval ? 'Your public request' : 'Your public registration'}</h3>
        <dl className="pf-event-facts"><div><dt>Event</dt><dd>{terms.title}</dd></div><div><dt>When</dt><dd>{eventDate(terms)} ({terms.timeZone})</dd></div>
          <div><dt>Place</dt><dd>{eventPlace(terms)}</dd></div><div><dt>Wallet</dt><dd className="pf-event-reference">{account}</dd></div><div><dt>Decision</dt><dd>{eligibility.requiresApproval ? joinWaitlist ? 'Request a place and join the waiting list if needed' : 'Request a place' : 'I plan to attend'}</dd></div></dl>
        <p>Your wallet address, this event version and your decision will be publicly readable on Arkiv. No name, email or phone number is requested.</p>
        <details><summary>Record lifetime</summary><p>This request asks for {Math.ceil(registrationLifetime(terms.endsAt, Math.min(now, read.event.snapshot.blockTimestamp)) / 86_400)} days of storage. Event references have their own lifetimes. Expiry does not erase downloaded copies or guarantee a permanent history.</p></details>
        {terms.registration?.waitlist && <Checkbox label="Join the waiting list if a place is not available" checked={joinWaitlist} onChange={event => { setJoinWaitlist(event.target.checked); setAcknowledged(false); }} disabled={submitting} />}
        <Checkbox label={`I reviewed the event details and understand that my ${eligibility.requiresApproval ? 'request' : 'registration'} is public.`} checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={submitting} />
        {!correctChain && <Notice tone="warning">Switch your wallet to Arkiv Tiramisu to continue. Your review is kept.</Notice>}
        <Button onClick={() => void confirm()} disabled={!canConfirm} {...(submitting ? { pending: true as const, pendingLabel: 'Checking your registration' } : { pending: false as const })}>
          {savedRetry ? 'Retry saved registration' : eligibility.requiresApproval ? joinWaitlist && eligibility.status === 'waitlist' ? 'Confirm waiting list request' : 'Send my place request' : 'Confirm my registration'}
        </Button>
        <Button variant="quiet" onClick={() => { setTarget(null); setAcknowledged(false); }} disabled={submitting}>Keep reading</Button>
      </div>}
    </>}
    {signedIn && !unresolved && read.attendance?.status === 'unique' && read.attendance.entity.payload.decision === 'going' && !withdrawal
      && <Button variant="secondary" onClick={chooseWithdrawal} disabled={submitting || !correctChain} disabledReason={!correctChain ? 'Switch your wallet to Arkiv Tiramisu to withdraw.' : undefined}>{retryingWithdrawal ? 'Review saved withdrawal' : requested ? 'Withdraw my request' : 'Withdraw my registration'}</Button>}
    {withdrawal && !unresolved && <div className="pf-event-public-preview">
      <h3>Withdraw your registration</h3><p>You will replace your own intention to attend with a public withdrawal. The event and other people’s decisions stay available.</p>
      <dl className="pf-event-facts"><div><dt>Event</dt><dd>{terms?.title ?? read.myEvent?.registeredRelease?.payload.terms.title ?? 'Event details unavailable'}</dd></div>
        <div><dt>Wallet</dt><dd className="pf-event-reference">{withdrawal.attendee}</dd></div><div><dt>Decision</dt><dd>I no longer plan to attend</dd></div></dl>
      <Checkbox label="Record my withdrawal publicly on Arkiv." checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={submitting} />
      <Button variant="danger" onClick={() => void confirmWithdrawal()} disabled={!acknowledged || submitting || !correctChain || withdrawal.attendee?.toLowerCase() !== account?.toLowerCase()}
        {...(submitting ? { pending: true as const, pendingLabel: 'Checking your withdrawal' } : { pending: false as const })}>{retryingWithdrawal ? 'Retry saved withdrawal' : 'Confirm my withdrawal'}</Button>
      <Button variant="quiet" onClick={() => { setWithdrawal(null); setAcknowledged(false); if (state.status === 'rejected') action.clear(); }} disabled={submitting}>Keep my registration</Button>
    </div>}
    <p className="pf-field-message">Only you can change your request or withdraw. For limited or invited events, the organizer separately confirms or releases your place.</p>
  </aside>;
}
