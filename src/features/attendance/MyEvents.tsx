import { useCallback, useEffect, useRef, useState } from 'react';
import { isPublicEntityKey } from '../../app/ids';
import { routeHref, routePath } from '../../app/routes';
import type { AppSession } from '../../app/session';
import type { StoragePort } from '../../app/storage';
import type { EventRepositoryContract, MyEvent } from '../../data/events/types';
import type { ListResult, RepositoryError } from '../../data/types';
import { attendanceStatus, deriveEventAvailability, type AttendanceStatus } from '../../domain/events';
import { Button, EmptyState, ErrorState, Link, LoadingState, Notice, Select, StatusLabel, type Tone } from '../../ui';
import { EventStatus } from '../events/EventSummary';
import { useEventClock } from '../events/hooks';
import { eventDate, eventError, shortAddress } from '../events/presentation';
import { AudienceChanges } from './AudienceChanges';
import '../events/events.css';

export interface MyEventsProps { repository: EventRepositoryContract | null; session: AppSession; storage?: StoragePort | null }
const statusCopy: Record<AttendanceStatus, { label: string; tone: Tone }> = {
  not_registered: { label: 'No current registration', tone: 'neutral' }, going: { label: 'Registered', tone: 'success' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' }, needs_review: { label: 'Review new version', tone: 'warning' },
  cancelled: { label: 'Event cancelled', tone: 'danger' }, ended: { label: 'Event ended', tone: 'neutral' },
  unverified: { label: 'Registration needs verification', tone: 'warning' },
};
export type MyEventFilter = 'all' | 'upcoming' | 'needs_review' | 'past';
export function myEventStatus(item: MyEvent, now: number): AttendanceStatus {
  return item.event ? attendanceStatus(item.attendance, item.event, now, item.registeredRelease) : 'unverified';
}
export function matchesMyEventFilter(status: AttendanceStatus, filter: MyEventFilter) {
  if (filter === 'all') return true;
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
    if (!account || !repository) { setResult(null); if (account) setError({ code: 'network', reasons: [], retryable: true }); return; }
    setPending(true); setError(null);
    try {
      const response = await repository.listMyEvents({ kind: 'wallet', address: account }, { signal: current.signal });
      if (serial !== sequence.current) return;
      if (response.ok) setResult(response.value); else setError(response.error);
    } catch { if (serial === sequence.current) setError({ code: 'network', reasons: [], retryable: true }); }
    finally { if (serial === sequence.current) setPending(false); }
  }, [repository, account]);
  useEffect(() => { setResult(null); void refresh(); return () => { ++sequence.current; abort.current?.abort(); }; }, [refresh]);
  const incomplete = result && (result.snapshot.completeness !== 'complete' || result.snapshot.freshness !== 'fresh' || result.snapshot.reasons.length > 0);
  const warnings = Boolean(result?.diagnostics.length);
  const unverified = Boolean(error || pending || incomplete);
  const rows = result?.items.map(item => ({ item, status: unverified ? 'unverified' as const : myEventStatus(item, now) })) ?? [];
  const shown = rows.filter(row => matchesMyEventFilter(row.status, filter));
  return <section className="pf-events-page" aria-labelledby="my-events-title">
    <header className="pf-events-heading"><div><h1 id="my-events-title">My events</h1><p>Your registrations, the latest visitor details and changes to the events you chose.</p>
      {account && <p>Reading public registrations for <span title={account}>{shortAddress(account)}</span>.</p>}</div><Link href={routeHref({ name: 'events' })}>Browse events</Link></header>
    {!account ? <EmptyState title="Find your registrations" description="Sign in with the wallet you used to register. Your events are read from Arkiv, including when you return on another device."
      actions={<Link className="pf-button pf-button--primary" href={routeHref({ name: 'sign-in', returnTo: routePath({ name: 'my-events' }) })}>Sign in to view my events</Link>} /> : <>
      <div className="pf-my-events-tools"><Select label="Show events" value={filter} onChange={event => setFilter(event.target.value as MyEventFilter)} options={[
        { value: 'all', label: 'All registrations' }, { value: 'upcoming', label: 'Registered events' }, { value: 'needs_review', label: 'Needs attention' }, { value: 'past', label: 'Ended, cancelled or withdrawn' },
      ]} /><Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Refresh my events</Button></div>
      {pending && <LoadingState title="Reading your registrations" description="Checking your own public decisions and the current event versions." />}
      {error && <ErrorState title="Your registrations could not be refreshed" description={eventError(error)} />}
      {incomplete && !pending && <Notice tone="warning" title="Some registrations could not be verified">This is a partial view. Missing records do not mean you withdrew or an event was cancelled.</Notice>}
      {warnings && !incomplete && !pending && <Notice tone="warning" title="Some public records could not be read">Some records could not be linked to a verified event. The registrations below retain their individually checked status.</Notice>}
      {!pending && !error && result && !result.items.length && !incomplete && !warnings && <EmptyState title="No current registrations found" description="Browse events and choose one to join. This list contains current public records; older registrations may have expired."
        actions={<Link className="pf-button pf-button--primary" href={routeHref({ name: 'events' })}>Find an event</Link>} />}
      {!pending && rows.length > 0 && !shown.length && <EmptyState title="No registrations in this view" actions={<Button variant="secondary" onClick={() => setFilter('all')}>Show all registrations</Button>} />}
      <div className="pf-my-events-list">{shown.map(({ item, status }) => {
        const terms = item.event?.release?.payload.terms ?? item.registeredRelease?.payload.terms;
        const availability = item.event && !unverified ? deriveEventAvailability(item.event, now) : 'unverified';
        return <article key={item.projectRoot} className="pf-my-event">
          <div className="pf-my-event-heading"><div><h2>{terms?.title ?? 'Event details unavailable'}</h2>
            {terms && <><p className="pf-event-meta">{eventDate(terms)} ({terms.timeZone})</p><p>{terms.venue}</p></>}</div>
            <StatusLabel tone={statusCopy[status].tone}>{statusCopy[status].label}</StatusLabel></div>
          {status === 'going' && availability !== 'open' && <div className="pf-stack pf-stack--compact"><EventStatus status={availability} />
            {availability === 'paused' && <p>Your intention to attend is kept while the organizers update the preparations.</p>}</div>}
          {status === 'needs_review' && item.event?.release && <AudienceChanges previous={item.registeredRelease?.payload.terms ?? null} current={item.event.release.payload.terms} />}
          {status === 'cancelled' && <p>The organizer cancelled this event. Your original decision remains part of the public record.</p>}
          {status === 'ended' && <p>This event has ended. Your registration records an intention to attend, not proof of physical attendance.</p>}
          {status === 'withdrawn' && <p>You withdrew your registration. You can review the event and join again if registration is open.</p>}
          {status === 'unverified' && <p>The current event or registration could not be fully verified. An unavailable or expired record is not a cancellation on your behalf.</p>}
          {isPublicEntityKey(item.projectRoot) && <Link href={routeHref({ name: 'event', projectRoot: item.projectRoot })}>{status === 'needs_review' ? 'Review updated event' : status === 'going' ? 'Manage my registration' : 'View event and registration'}</Link>}
        </article>;
      })}</div>
    </>}
  </section>;
}
