import { useEffect, useRef, useState } from 'react';
import { ActionRecovery } from '../../../app/ActionRecovery';
import type { AppSession } from '../../../app/session';
import type { StoragePort } from '../../../app/storage';
import type { EventRepositoryContract, ReplaceEventCommand } from '../../../data/events/types';
import { attendanceStatus, canAdmitAttendance, eventRosterVerified, type EventAggregate } from '../../../domain/events';
import type { AccountAddress } from '../../../domain/types';
import { Button, Checkbox, Notice, StatusLabel } from '../../../ui';
import { eventError, shortAddress } from '../presentation';
import { useEventAction } from '../useEventAction';
import { validPublishingCommand } from './model';
import { prepareAdmissionReview, validateAdmissionReview, type AdmissionReview } from './admission';

export function EventAdmissions({ event, repository, session, storage, refresh, now }: { event: EventAggregate; repository: EventRepositoryContract | null; session: AppSession; storage: StoragePort | null; refresh: (includeSource?: boolean) => Promise<EventAggregate | null>; now: number }) {
  const [review, setReview] = useState<AdmissionReview | null>(null), [acknowledged, setAcknowledged] = useState(false), [message, setMessage] = useState<string | null>(null), [checking, setChecking] = useState(false);
  const [resume, setResume] = useState(false);
  const busy = useRef(false), current = useRef(session); current.current = session;
  const { controller: action, state } = useEventAction(repository, session, `admissions:${event.projectRoot}`, storage);
  const owner = session.actor?.kind === 'wallet' ? session.actor.address : null;
  useEffect(() => { setReview(null); setAcknowledged(false); }, [owner, event.release?.key]);
  const reservations = event.state.status === 'unique' ? event.state.entity.payload.admissions ?? [] : [];
  const entries = event.roster?.entries ?? [];
  const complete = eventRosterVerified(event, now);
  const unresolved = state.status === 'needs-verification' || state.status === 'submitting';
  const finalEvent = event.state.status === 'unique' && ['cancelled', 'ended'].includes(event.state.entity.payload.status);
  const pending = checking || state.status === 'submitting';
  const rules = event.release?.payload.terms.registration;
  if (!rules) return null;
  const managedPlaces = rules.capacity.kind === 'limited' || rules.admission === 'invite_only';
  async function prepare(attendee: AccountAddress, kind: AdmissionReview['kind']) {
    if (busy.current || unresolved) return;
    busy.current = true; setChecking(true); setMessage(null); setAcknowledged(false); setResume(false);
    const account = current.current.actor;
    try {
      const fresh = await refresh(kind !== 'release');
      if (!fresh || current.current.actor?.kind !== account?.kind || current.current.actor?.kind === 'wallet' && account?.kind === 'wallet' && current.current.actor.address !== account.address) { setMessage('Refresh the event with the same organizer wallet before continuing.'); return; }
      const result = prepareAdmissionReview(fresh, current.current, attendee, kind);
      if (!result.ok) { setMessage(result.message); return; }
      if (!action.clear()) { setMessage('Check the saved place decision before preparing another.'); return; }
      setReview(result.review);
    } finally { busy.current = false; setChecking(false); }
  }
  async function confirm() {
    if (!review || !acknowledged || busy.current || unresolved && !resume) return;
    const selected = review; busy.current = true; setChecking(true); setMessage(null);
    try {
      const fresh = await refresh(selected.kind !== 'release');
      if (!fresh) { setMessage('The event could not be refreshed. No new decision was sent.'); return; }
      const error = validateAdmissionReview(selected, fresh, current.current);
      if (error) { setMessage(error); setAcknowledged(false); return; }
      const result = resume ? await action.resume((repo, command: ReplaceEventCommand) => repo.replaceEvent(command)) : await action.run(selected.command, (repo, command) => repo.replaceEvent(command));
      setAcknowledged(false);
      if (!result.ok) { setMessage(eventError(result.error)); return; }
      setReview(null);
      const verified = await refresh(selected.kind !== 'release');
      if (!verified || selected.kind === 'admit' && !eventRosterVerified(verified)) { setMessage('The decision was recorded. Refresh to verify the current places.'); return; }
      const currentReservations = verified.state.status === 'unique' ? verified.state.entity.payload.admissions ?? [] : [];
      const confirmed = currentReservations.some(item => item.attendee === selected.attendee && item.attendanceKey === selected.command.admissions?.find(candidate => candidate.attendee === selected.attendee)?.attendanceKey);
      const released = !currentReservations.some(item => item.attendee === selected.attendee);
      if (selected.kind === 'release') await refresh();
      setMessage(selected.kind === 'admit' && confirmed ? 'The place is confirmed for this request.' : selected.kind === 'release' && released ? 'The reserved place is released. You can review another request.' : 'The event changed after this decision. Check its current places.');
    } finally { busy.current = false; setChecking(false); }
  }
  async function checkOriginal() {
    if (busy.current) return; busy.current = true; setChecking(true);
    try {
      const result = await action.reconcile(); setReview(null); setAcknowledged(false); setResume(false);
      if (!result.ok || result.value.status === 'unverified') { setMessage('The saved decision cannot be verified yet. Keep its recovery file and check again.'); return; }
      if (action.getSnapshot().status === 'confirmed' || action.getSnapshot().status === 'reverted') { await refresh(); setMessage(action.getSnapshot().status === 'confirmed' ? 'Your original place decision is confirmed. Check the current places below.' : 'The original decision did not complete. Refresh and review the visitor again.'); return; }
      const command = action.recoverableCommand as ReplaceEventCommand | null;
      if (!validPublishingCommand(command) || !('admissions' in command) || !Array.isArray(command.admissions)) return;
      const fresh = await refresh(false);
      if (!fresh || fresh.state.status !== 'unique' || !command?.admissions || result.value.status !== 'not_sent') return;
      const previous = fresh.state.entity.payload.admissions ?? [];
      const added = command.admissions.filter(item => !previous.some(old => old.attendee === item.attendee && old.attendanceKey === item.attendanceKey && old.releaseKey === item.releaseKey));
      const removed = previous.filter(item => !command.admissions!.some(next => next.attendee === item.attendee));
      const attendee = added.length === 1 && !removed.length ? added[0]!.attendee : !added.length && removed.length === 1 ? removed[0]!.attendee : null;
      if (!attendee) { setMessage('The saved decision no longer matches these places. Keep its recovery file and check the current event.'); return; }
      const recovered: AdmissionReview = { attendee, kind: added.length ? 'admit' : 'release', command };
      const checked = recovered.kind === 'admit' ? await refresh() : fresh;
      if (!checked) return;
      const error = validateAdmissionReview(recovered, checked, current.current);
      if (error) { setMessage(error); return; }
      setReview(recovered); setResume(true); setMessage('The original decision was not sent. Review it below to continue the same request.');
    } finally { busy.current = false; setChecking(false); }
  }
  return <section className="pf-admissions" aria-label="Requests and confirmed places" aria-busy={pending}>
    <div className="pf-publishing-heading"><h3>Requests and confirmed places</h3><p>{managedPlaces ? 'Confirm each request yourself. Releasing a reservation makes room for another visitor; a withdrawal does not automatically release it.' : 'Visitors can join this event directly. Earlier reserved places stay here until you release them.'}</p></div>
    {(managedPlaces || reservations.length > 0) && <p>{reservations.length} reserved {rules.capacity.kind === 'limited' ? `of ${rules.capacity.limit} places` : 'places'}</p>}
    {!complete && <Notice tone="warning" title="The registration list needs a fresh check">Some requests could not be verified. You can release a known reservation after reviewing it, but no new place can be confirmed.</Notice>}
    {message && <Notice role="status">{message}</Notice>}
    <Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Refresh requests and places</Button>
    {unresolved && <Notice tone="warning" title="Check the saved place decision"><p>The original decision may already be recorded. Check it before sending another.</p><ActionRecovery action={{ recoveryText: action.recoveryText, restoreRecovery: action.restoreRecovery }} /><Button variant="secondary" disabled={pending} onClick={() => void checkOriginal()}>Check original decision</Button></Notice>}
    {state.status === 'rejected' && <Notice>The wallet request was cancelled. Your review is kept. Review the visitor again to make a new decision.</Notice>}
    {!entries.length && !reservations.length && complete && <p>No registration requests yet. Share your event page to welcome visitors.</p>}
    <ul className="pf-admission-list">{entries.map(entry => {
      const reserved = reservations.find(item => item.attendee === entry.attendee);
      const status = attendanceStatus(entry.attendance, event, now, entry.registeredRelease);
      const exact = entry.attendance.status === 'unique' && reserved?.attendanceKey === entry.attendance.entity.key && reserved.releaseKey === event.release?.key;
      const labels = { pending: 'Awaiting confirmation', waitlisted: 'Waiting list', full: 'No place available', going: 'Confirmed place', withdrawn: 'Visitor withdrew', needs_review: 'Visitor must review new details', invitation_required: 'Invitation required', registration_closed: 'Request missed the deadline', unverified: 'Request needs verification', cancelled: 'Event cancelled', ended: 'Event ended', not_registered: 'No current request' };
      return <li key={entry.attendee}><div><strong title={entry.attendee}>{shortAddress(entry.attendee)}</strong><StatusLabel tone={exact && status === 'going' ? 'success' : 'neutral'}>{labels[status]}</StatusLabel>{reserved && !exact && <p>A place is still reserved for an earlier request.</p>}{entry.attendance.status === 'unique' && entry.attendance.entity.payload.joinWaitlist && <p>Visitor chose the waiting list</p>}</div><div className="pf-actions">{managedPlaces && !exact && <Button variant="secondary" disabled={pending || unresolved || finalEvent || !canAdmitAttendance(event, entry, now)} onClick={() => void prepare(entry.attendee, 'admit')}>{reserved ? 'Confirm updated request' : entry.attendance.status === 'unique' && entry.attendance.entity.payload.joinWaitlist ? 'Review waiting list promotion' : 'Review place confirmation'}</Button>}{reserved && <Button variant="quiet" disabled={pending || unresolved || finalEvent} onClick={() => void prepare(entry.attendee, 'release')}>Release reserved place</Button>}</div></li>;
    })}{reservations.filter(item => !entries.some(entry => entry.attendee === item.attendee)).map(item => <li key={item.attendee}><div><strong title={item.attendee}>{shortAddress(item.attendee)}</strong><p>Reserved place. The visitor’s request is unavailable.</p></div><Button variant="secondary" disabled={pending || unresolved || finalEvent} onClick={() => void prepare(item.attendee, 'release')}>Review releasing place</Button></li>)}</ul>
    {review && (!unresolved || resume) && <div className="pf-event-public-preview"><h3>{review.kind === 'admit' ? 'Confirm this visitor’s place' : 'Release this reserved place'}</h3><p className="pf-event-reference">{review.attendee}</p><p>{review.kind === 'admit' ? 'This confirms one place for the exact event version and request you reviewed.' : 'This removes the organizer’s reservation. The visitor’s own request remains unchanged; they will no longer have a confirmed place.'}</p><Checkbox label="I reviewed the visitor, current event and effect of this decision" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={pending} /><div className="pf-actions"><Button variant={review.kind === 'release' ? 'danger' : 'primary'} onClick={() => void confirm()} disabled={pending || !acknowledged}>{resume ? 'Continue original decision' : review.kind === 'admit' ? 'Confirm place' : 'Release place'}</Button><Button variant="quiet" disabled={pending} onClick={() => { setReview(null); setAcknowledged(false); }}>Keep reviewing</Button></div></div>}
  </section>;
}

