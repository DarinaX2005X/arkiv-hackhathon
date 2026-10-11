import type { AppSession } from '../../app/session';
import { routeHref } from '../../app/routes';
import type { StoragePort } from '../../app/storage';
import type { EventRepositoryContract } from '../../data/events/types';
import { attendanceStatus, deriveEventAvailability } from '../../domain/events';
import type { PublicEntityKey } from '../../domain/types';
import { Button, ErrorState, Link, LoadingState, Notice } from '../../ui';
import { RegistrationPanel } from '../attendance/RegistrationPanel';
import { AudienceChanges } from '../attendance/AudienceChanges';
import { EventEvidence, EventStatus } from './EventSummary';
import { useEventClock, useEventRead } from './hooks';
import { eventDate, eventError } from './presentation';
import './events.css';

export interface EventDetailProps { projectRoot: PublicEntityKey; repository: EventRepositoryContract | null; session: AppSession; storage?: StoragePort | null }

export function EventDetail({ projectRoot, repository, session, storage }: EventDetailProps) {
  const { value, pending, error, refresh } = useEventRead(repository, projectRoot, session);
  const now = useEventClock();
  const event = value?.event;
  const terms = event?.release?.payload.terms;
  const status = event && !error && !pending ? deriveEventAvailability(event, now) : 'unverified';
  const needsReview = value?.attendance && attendanceStatus(value.attendance, value.event, now, value.myEvent?.registeredRelease ?? null) === 'needs_review';
  return <section className="pf-events-page" aria-labelledby="event-title">
    <header className="pf-events-heading"><div><Link href={routeHref({ name: 'events' })}>All events</Link><h1 id="event-title">{terms?.title ?? 'Event details'}</h1>
      {event && <div className="pf-event-title-status"><EventStatus status={status} /><Button variant="quiet" size="compact" onClick={() => void refresh()} disabled={pending}>Refresh event</Button></div>}</div>
      <Link href={routeHref({ name: 'my-events' })}>My events</Link></header>
    {pending && <LoadingState title="Checking the current event" description="Reading the published details, agreements and your registration when signed in." />}
    {error && <ErrorState title="This event could not be refreshed" description={eventError(error)} actions={<Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Try again</Button>} />}
    {event && !terms && !pending && <Notice tone="warning" title="The visitor page is unavailable">The event details may have expired, been removed or could not be authenticated. No cancellation or registration status can be inferred from this missing record.</Notice>}
    {event && value && <div className="pf-event-detail-grid">
      <article className="pf-event-body">
        {terms && <>
        {needsReview && <AudienceChanges previous={value.myEvent?.registeredRelease?.payload.terms ?? null} current={terms} />}
        <section><h2>About the event</h2><p className="pf-event-prose">{terms.description || 'The organizer has not added a description.'}</p></section>
        <section><h2>When and where</h2><dl className="pf-event-facts"><div><dt>Time</dt><dd>{eventDate(terms)}</dd></div><div><dt>Time zone</dt><dd>{terms.timeZone}</dd></div><div><dt>Place</dt><dd className="pf-event-prose">{terms.venue}</dd></div></dl></section>
        <section><h2>Before you come</h2><p className="pf-event-prose">{terms.instructions || 'No preparation instructions have been provided.'}</p></section>
        <section><h2>Participation conditions</h2><p className="pf-event-prose">{terms.conditions || 'No additional participation conditions have been provided.'}</p></section>
        </>}
        <EventEvidence event={event} />
      </article>
      <RegistrationPanel projectRoot={projectRoot} repository={repository} session={session} read={value} now={now} unverified={Boolean(error || pending)} refresh={refresh} storage={storage} />
    </div>}
  </section>;
}
