import { routeHref } from '../../app/routes';
import { formatDateTime } from '../../app/time';
import { isPublicEntityKey } from '../../app/ids';
import { deriveEventAvailability, type EventAggregate, type EventAvailability } from '../../domain/events';
import { Link, StatusLabel } from '../../ui';
import { availabilityCopy, eventDate, shortAddress } from './presentation';

export function EventStatus({ status }: { status: EventAvailability }) {
  const copy = availabilityCopy[status];
  return <StatusLabel tone={copy.tone}>{copy.label}</StatusLabel>;
}

export function EventSummary({ event, now, unverified = false }: { event: EventAggregate; now: number; unverified?: boolean }) {
  const terms = event.release?.payload.terms;
  const status = unverified ? 'unverified' : deriveEventAvailability(event, now);
  const date = terms ? new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: terms.timeZone }).format(new Date(terms.startsAt)) : null;
  return <article className="pf-event-row">
    <div className="pf-event-date" aria-hidden="true">{date ?? 'Date unavailable'}</div>
    <div className="pf-event-row-content">
      <h2>{isPublicEntityKey(event.projectRoot)
        ? <Link href={routeHref({ name: 'event', projectRoot: event.projectRoot })}>{terms?.title ?? 'Event details unavailable'}</Link>
        : terms?.title ?? 'Event details unavailable'}</h2>
      {terms ? <><p className="pf-event-meta">{eventDate(terms)} <span>({terms.timeZone})</span></p><p>{terms.venue}</p>
        {terms.description && <p className="pf-event-description">{terms.description}</p>}</> : <p>The original page may have expired or become unavailable. Open the record to check its status.</p>}
      <EventStatus status={status} />
    </div>
    {isPublicEntityKey(event.projectRoot) && <Link className="pf-event-open" href={routeHref({ name: 'event', projectRoot: event.projectRoot })} aria-label={`View ${terms?.title ?? 'event details'}`}>View event</Link>}
  </article>;
}

export function EventEvidence({ event }: { event: EventAggregate }) {
  const organizer = event.root?.payload.coordinator;
  return <details className="pf-event-evidence"><summary>About this public record</summary><div className="pf-stack pf-stack--compact">
    <p>Partfolk reads this event and its contributors’ agreements from Arkiv. Registration records an intention to attend an open, free event. It does not reserve a limited seat or prove attendance.</p>
    <dl className="pf-event-facts">
      <div><dt>Last read</dt><dd>{formatDateTime(event.snapshot.fetchedAt, 'UTC')} UTC</dd></div>
      <div><dt>Organizer wallet</dt><dd>{organizer?.kind === 'wallet' ? <span title={organizer.address}>{shortAddress(organizer.address)}</span> : 'Could not be verified'}</dd></div>
      <div><dt>Network</dt><dd>Arkiv Tiramisu testnet</dd></div>
      <div><dt>Read completeness</dt><dd>{event.snapshot.completeness === 'complete' ? 'Complete snapshot' : 'Incomplete snapshot'}</dd></div>
      {event.snapshot.blockNumber && <div><dt>Read at block</dt><dd>{event.snapshot.blockNumber}</dd></div>}
      {event.release && <div><dt>Event record expires at block</dt><dd>{event.release.provenance.expiresAtBlock ?? 'Unknown'}</dd></div>}
      {event.state.status === 'unique' && <div><dt>Current status expires at block</dt><dd>{event.state.entity.provenance.expiresAtBlock ?? 'Unknown'}</dd></div>}
      <div><dt>Event reference</dt><dd className="pf-event-reference">{event.projectRoot}</dd></div>
    </dl>
    <p>Records have a finite lifetime. Missing or expired records do not prove cancellation, and downloaded copies may remain after expiry.</p>
    <Link href={routeHref({ name: 'help', topic: 'public-data' })}>How public data and wallets work</Link>
  </div></details>;
}
