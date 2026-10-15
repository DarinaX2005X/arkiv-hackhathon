import { useCallback, useEffect, useRef, useState } from 'react';
import { isPublicEntityKey } from '../../app/ids';
import { routeHref, routePath } from '../../app/routes';
import type { AppSession } from '../../app/session';
import type { StoragePort } from '../../app/storage';
import type { EventRepositoryContract, MyEvent } from '../../data/events/types';
import { markEventReadStale } from '../../data/events/read-cache';
import type { ListResult, RepositoryError } from '../../data/types';
import { attendanceStatus, audienceChanges, currentEventSnapshot, deriveEventAvailability, type AttendanceStatus } from '../../domain/events';
import { Button, EmptyState, ErrorState, Link, LoadingState, Notice, Select, StatusLabel, type Tone } from '../../ui';
import { EventCoverFrame, EventQuickFacts, EventStatus } from '../events/EventSummary';
import { useEventClock } from '../events/hooks';
import { audienceLabels, eventError, shortAddress, downloadEventCalendar } from '../events/presentation';
import '../events/events.css';

export interface MyEventsProps { repository: EventRepositoryContract | null; session: AppSession; storage?: StoragePort | null }
const statusCopy: Record<AttendanceStatus, { label: string; tone: Tone; explanation: string }> = {
  pending: { label: 'Awaiting organizer confirmation', tone: 'warning', explanation: 'Your request is sent. The organizer must confirm your place before you are registered.' },
  waitlisted: { label: 'On the waiting list', tone: 'warning', explanation: 'You chose the waiting list. The organizer can confirm a place when one becomes available.' },
  full: { label: 'No place available', tone: 'neutral', explanation: 'There is no confirmed place for this request. Open the event to check waiting list options.' },
  invitation_required: { label: 'Invitation required', tone: 'warning', explanation: 'This wallet is no longer eligible under the current invitation list. Review the event details.' },
  registration_closed: { label: 'Deadline passed', tone: 'neutral', explanation: 'The registration deadline has passed. Review the event to check your request.' },
  not_registered: { label: 'No current registration', tone: 'neutral', explanation: 'No current registration is recorded for this wallet.' },
  going: { label: 'Registered', tone: 'success', explanation: 'Your registration is recorded for this event version.' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral', explanation: 'You withdrew your registration. You can review the event and join again if registration is open.' },
  needs_review: { label: 'Review new version', tone: 'warning', explanation: 'Your earlier registration belongs to a previous event version. Review the latest details before confirming again.' },
  cancelled: { label: 'Event cancelled', tone: 'danger', explanation: 'The organizer cancelled this event. Your original decision remains part of the public record.' },
  ended: { label: 'Event ended', tone: 'neutral', explanation: 'This event has ended. Your registration records an intention to attend.' },
  unverified: { label: 'Registration needs verification', tone: 'warning', explanation: 'The current event or registration could not be fully verified. An unavailable record does not mean you withdrew or the event was cancelled.' },
};
export type MyEventFilter = 'all' | 'upcoming' | 'needs_review' | 'pending' | 'past';
export function myEventStatus(item: MyEvent, now: number): AttendanceStatus {
  return item.event ? attendanceStatus(item.attendance, item.event, now, item.registeredRelease) : 'unverified';
}
export function matchesMyEventFilter(status: AttendanceStatus, filter: MyEventFilter) {
  if (filter === 'all') return true;
  if (filter === 'pending') return ['pending', 'waitlisted', 'full', 'invitation_required', 'registration_closed'].includes(status);
  if (filter === 'upcoming') return status === 'going';
  if (filter === 'needs_review') return status === 'needs_review' || status === 'unverified';
  return status === 'cancelled' || status === 'ended' || status === 'withdrawn';
}

export function MyEvents({ repository, session }: MyEventsProps) {
  const [result, setResult] = useState<ListResult<MyEvent> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<RepositoryError | null>(null);
  const [filter, setFilter] = useState<MyEventFilter>('all');
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const now = useEventClock();
  const account = session.actor?.kind === 'wallet' ? session.actor.address : null;
  const refresh = useCallback(async () => {
    const serial = ++sequence.current;
    abort.current?.abort(); const current = new AbortController(); abort.current = current;
    if (!account || !repository) {
      setResult(null); setPending(false); setError(account ? { code: 'network', reasons: [], retryable: true } : null); return;
    }
    setPending(true); setError(null);
    try {
      const response = await repository.listMyEvents({ kind: 'wallet', address: account }, { signal: current.signal });
      if (serial !== sequence.current || current.signal.aborted) return;
      if (response.ok) setResult(response.value);
      else { setError(response.error); setResult(previous => previous ? markEventReadStale(previous) : null); }
    } catch {
      if (serial === sequence.current && !current.signal.aborted) {
        setError({ code: 'network', reasons: [], retryable: true });
        setResult(previous => previous ? markEventReadStale(previous) : null);
      }
    } finally { if (serial === sequence.current) setPending(false); }
  }, [repository, account]);
  useEffect(() => { setResult(null); void refresh(); return () => { ++sequence.current; abort.current?.abort(); }; }, [refresh]);
  const incomplete = Boolean(result && result.snapshot.completeness !== 'complete');
  const stale = Boolean(result && !currentEventSnapshot(result.snapshot, now));
  const warnings = Boolean(result?.diagnostics.length);
  // Retain individually verified statuses during an ordinary refresh. A failed
  // read marks the cached result stale, so mutations still require fresh data.
  const unverified = Boolean(error || stale);
  const rows = result?.items.map(item => ({ item, status: unverified ? 'unverified' as const : myEventStatus(item, now) })) ?? [];
  const shown = rows.filter(row => matchesMyEventFilter(row.status, filter));
  return <section className="pf-events-page" aria-labelledby="my-events-title">
    <header className="pf-events-heading"><div><h1 id="my-events-title">My events</h1><p>Your registrations, requests and changes to the events you chose.</p>
      {account && <p>Registrations for <span title={account}>{shortAddress(account)}</span>.</p>}</div><Link href={routeHref({ name: 'events' })}>Browse events</Link></header>
    {!account ? <EmptyState title="Find your registrations" description="Sign in with the wallet you used to register. Your events are read from Arkiv, including when you return on another device."
      actions={<Link className="pf-button pf-button--primary" href={routeHref({ name: 'sign-in', returnTo: routePath({ name: 'my-events' }) })}>Sign in to view my events</Link>} /> : <>
      <div className="pf-my-events-tools pf-surface-light"><Select label="Show events" value={filter} onChange={event => setFilter(event.target.value as MyEventFilter)} options={[
        { value: 'all', label: 'All registrations' }, { value: 'upcoming', label: 'Confirmed events' }, { value: 'pending', label: 'Requests and waiting list' }, { value: 'needs_review', label: 'Needs attention' }, { value: 'past', label: 'Ended, cancelled or withdrawn' },
      ]} /><Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Refresh my events</Button></div>
      {pending && !result && <LoadingState title="Reading your registrations" description="Checking your own public decisions and the current event versions." />}
      {error && <ErrorState title="Your registrations could not be refreshed" description={eventError(error)} />}
      {incomplete && !pending && !error && <Notice tone="warning" title="Some registrations could not be verified">This is a partial view. Missing records do not mean you withdrew or an event was cancelled.</Notice>}
      {stale && !incomplete && !pending && !error && <Notice tone="warning" title="Your registrations need a fresh check">Refresh my events to check current places, requests and event details.</Notice>}
      {warnings && !stale && !pending && !error && <Notice tone="warning" title="Some public records could not be read">Some records could not be linked to a verified event. The registrations below retain their individually checked status.</Notice>}
      {!pending && !error && result && !result.items.length && !stale && !warnings && <EmptyState title="No current registrations found" description="Browse events and choose one to join. This list contains current public records; older registrations may have expired."
        actions={<Link className="pf-button pf-button--primary" href={routeHref({ name: 'events' })}>Find an event</Link>} />}
      {rows.length > 0 && <p className="pf-events-result-label" role="status" aria-live="polite">{pending ? 'Refreshing your registrations.' : `${shown.length} ${shown.length === 1 ? 'event' : 'events'} in this view`}</p>}
      {!pending && rows.length > 0 && !shown.length && <EmptyState title={unverified ? 'No verified registrations in this view' : 'No registrations in this view'} description={unverified ? 'Refresh your registrations, or show all records to review what was last loaded.' : undefined} actions={<Button variant="secondary" onClick={() => setFilter('all')}>Show all registrations</Button>} />}
      <div className="pf-my-events-list" aria-busy={pending}>{shown.map(({ item, status }) => {
        const currentTerms = item.event?.release?.payload.terms;
        const terms = currentTerms ?? item.registeredRelease?.payload.terms;
        const availability = item.event && !unverified ? deriveEventAvailability(item.event, now) : 'unverified';
        const confirmedPlace = status === 'going' && (terms?.registration?.capacity.kind === 'limited' || terms?.registration?.admission === 'invite_only');
        const changed = status === 'needs_review' && terms && item.registeredRelease
          ? audienceChanges(item.registeredRelease.payload.terms, terms).map(field => audienceLabels[field]) : [];
        const actionLabel = status === 'needs_review' ? 'Review updated event' : status === 'going' ? 'Manage my registration' : 'View event and registration';
        return <article key={item.projectRoot} className="pf-event-card pf-my-event pf-surface-light">
          <EventCoverFrame terms={terms} verified={availability !== 'unverified' && status !== 'unverified'} />
          <div className="pf-event-card-content">
            <h2>{terms?.title ?? 'Event details unavailable'}</h2>
            {terms && <EventQuickFacts terms={terms} />}
            {!currentTerms && terms && <p className="pf-field-message">Last recorded event details. Current details are unavailable.</p>}
            <div className="pf-my-event-state"><StatusLabel tone={statusCopy[status].tone}>{confirmedPlace ? 'Place confirmed' : statusCopy[status].label}</StatusLabel>
              <p>{confirmedPlace ? 'Your place is confirmed for this event version.' : statusCopy[status].explanation}</p>
              {status === 'going' && availability !== 'open' && <><EventStatus status={availability} />
                {availability === 'paused' && <p>Your registration is kept while the organizers update the preparations.</p>}</>}
              {status === 'needs_review' && changed.length > 0 && <p>Updated details: {changed.join(', ')}.</p>}
            </div>
            <div className="pf-my-event-actions">
              {isPublicEntityKey(item.projectRoot) && <Link className="pf-button pf-button--primary" href={routeHref({ name: 'event', projectRoot: item.projectRoot })} aria-label={`${actionLabel}: ${terms?.title ?? 'event details'}`}>{actionLabel}</Link>}
              {(status === 'going' || status === 'cancelled') && terms && <Button variant="secondary" onClick={() => downloadEventCalendar(terms, item.projectRoot, status === 'cancelled')}>{status === 'cancelled' ? 'Save cancelled calendar event' : 'Add to calendar'}</Button>}
            </div>
          </div>
        </article>;
      })}</div>
    </>}
  </section>;
}
