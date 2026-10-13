import type { AppSession } from '../../app/session';
import { routeHref } from '../../app/routes';
import { formatDateTime } from '../../app/time';
import type { StoragePort } from '../../app/storage';
import type { EventRepositoryContract } from '../../data/events/types';
import { attendanceStatus, deriveEventAvailability } from '../../domain/events';
import type { PublicEntityKey } from '../../domain/types';
import { Button, ErrorState, Link, LoadingState, Notice } from '../../ui';
import { RegistrationPanel } from '../attendance/RegistrationPanel';
import { AudienceChanges } from '../attendance/AudienceChanges';
import { EventCoverFrame, EventEvidence, EventQuickFacts, EventStatus } from './EventSummary';
import { useEventClock, useEventRead } from './hooks';
import { eventError, eventPlace, eventRegistrationLabel, downloadEventCalendar } from './presentation';
import './events.css';

export interface EventDetailProps { projectRoot: PublicEntityKey; repository: EventRepositoryContract | null; session: AppSession; storage?: StoragePort | null }

export function EventDetail({ projectRoot, repository, session, storage }: EventDetailProps) {
  const { value, pending, error, refresh, refreshWithdrawal } = useEventRead(repository, projectRoot, session);
  const now = useEventClock();
  const event = value?.event;
  const terms = event?.release?.payload.terms;
  const status = event && !error && !pending ? deriveEventAvailability(event, now) : 'unverified';
  const needsReview = value?.attendance && attendanceStatus(value.attendance, value.event, now, value.myEvent?.registeredRelease ?? null) === 'needs_review';
  return <section className="pf-events-page" aria-labelledby="event-title">
    <header className="pf-events-heading"><div><Link href={routeHref({ name: 'events' })}>All events</Link><h1 id="event-title">{terms?.title ?? 'Event details'}</h1>
      {event && <div className="pf-event-title-status"><EventStatus status={status} /><Button variant="quiet" size="compact" onClick={() => void refresh()} disabled={pending}>Refresh event</Button></div>}</div>
      <Link href={routeHref({ name: 'my-events' })}>My events</Link></header>
    {pending && !value && <LoadingState title="Checking the current event" description="Reading the published details, agreements and your registration when signed in." />}
    {pending && value && <p className="pf-event-meta" role="status">Checking the current event and registration.</p>}
    {error && <ErrorState title="This event could not be refreshed" description={eventError(error)} actions={<Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Try again</Button>} />}
    {event && !terms && !pending && <Notice tone="warning" title="The visitor page is unavailable">The event details may have expired, been removed or could not be authenticated. An unavailable record does not mean that the event was cancelled.</Notice>}
    {event && value && <>
      <div className={`pf-event-detail-grid${terms ? '' : ' pf-event-detail-grid--without-overview'}`}>
        {terms && <section className="pf-event-overview pf-surface-light" aria-labelledby="event-overview-title">
          <EventCoverFrame terms={terms} verified={status !== 'unverified'} className="pf-event-detail-cover" />
          <div className="pf-event-overview-facts"><h2 id="event-overview-title">When and where</h2><EventQuickFacts terms={terms} />
            <Button variant="secondary" disabled={status === 'unverified'} disabledReason={status === 'unverified' ? 'Refresh the event before saving its calendar details.' : undefined}
              onClick={() => downloadEventCalendar(terms, projectRoot, status === 'cancelled')}>{status === 'cancelled' ? 'Save cancelled calendar event' : 'Add to calendar'}</Button></div>
        </section>}
        <RegistrationPanel projectRoot={projectRoot} repository={repository} session={session} read={value} now={now} unverified={Boolean(error || pending)} refresh={refresh} refreshWithdrawal={refreshWithdrawal} storage={storage} />
      </div>
      <article className="pf-event-body pf-surface-light">
        {terms && <>
          {needsReview && <AudienceChanges previous={value.myEvent?.registeredRelease?.payload.terms ?? null} current={terms} />}
          <section><h2>About the event</h2><p className="pf-event-prose">{terms.description || 'The organizer has not added a description.'}</p></section>
          <div className="pf-event-information-grid">
            {terms.format !== 'online' && <section><h2>{terms.format === 'hybrid' ? 'Meet in person' : 'Location'}</h2><p className="pf-event-prose">{eventPlace(terms)}</p></section>}
            {terms.online && <section><h2>Join online</h2>
              {terms.online.instructions && <p className="pf-event-prose">{terms.online.instructions}</p>}
              {terms.online.url && /^https?:\/\//i.test(terms.online.url) && <Link className="pf-button pf-button--secondary" href={terms.online.url} target="_blank" rel="noopener noreferrer">Open public event link</Link>}
            </section>}
            <section><h2>Before you join</h2><p className="pf-event-prose">{terms.instructions || 'No preparation instructions have been provided.'}</p></section>
            <section><h2>Participation conditions</h2><p className="pf-event-prose">{terms.conditions || 'No additional participation conditions have been provided.'}</p></section>
            <section><h2>Registration details</h2><p>{eventRegistrationLabel(terms)}</p>
              {terms.registration?.deadline != null && <p>Registration closes {formatDateTime(terms.registration.deadline, terms.timeZone)} ({terms.timeZone}).</p>}
              {terms.registration?.waitlist && <p>You can choose to join the waiting list if all places are reserved.</p>}
            </section>
          </div>
        </>}
        <EventEvidence event={event} />
      </article>
    </>}
  </section>;
}
