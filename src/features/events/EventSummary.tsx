import { routeHref } from '../../app/routes';
import { formatDateTime } from '../../app/time';
import { isPublicEntityKey } from '../../app/ids';
import { deriveEventAvailability, isTestEventTerms, type AudienceTerms, type EventAggregate, type EventAvailability } from '../../domain/events';
import { Link, StatusLabel } from '../../ui';
import { availabilityCopy, shortAddress, eventFormatLabel, eventDayLabel, eventTimeLabel, eventLocationLabel, eventAdmissionLabel } from './presentation';
import { EventCover, EventFactIcon } from './cover';

export function EventStatus({ status }: { status: EventAvailability }) {
  const copy = availabilityCopy[status];
  return <StatusLabel tone={copy.tone}>{copy.label}</StatusLabel>;
}

export function EventCoverFrame({ terms, verified, className = '' }: { terms?: AudienceTerms; verified: boolean; className?: string }) {
  return <div className={`pf-event-cover-frame ${className}`}>
    <EventCover format={terms?.format} />
    <div className="pf-event-cover-badges">
      {isTestEventTerms(terms) && <StatusLabel tone="neutral">TEST EVENT</StatusLabel>}
      {verified && <StatusLabel tone="success" title="The current public event record was checked. This does not verify the organizer’s real-world identity or physical attendance."><EventFactIcon name="check" />Verified record</StatusLabel>}
    </div>
  </div>;
}

export function EventQuickFacts({ terms }: { terms: AudienceTerms }) {
  const location = eventLocationLabel(terms);
  return <ul className="pf-event-quick-facts">
    <li><EventFactIcon name="calendar" /><span>{eventDayLabel(terms)}</span></li>
    <li><EventFactIcon name="clock" /><span>{eventTimeLabel(terms)}<span className="pf-event-fact-secondary">{terms.timeZone}</span></span></li>
    <li><EventFactIcon name={terms.format ?? 'place'} /><span>{eventFormatLabel(terms)}{location && <span className="pf-event-fact-secondary">{location}</span>}</span></li>
  </ul>;
}

export function EventSummary({ event, now, unverified = false }: { event: EventAggregate; now: number; unverified?: boolean }) {
  const terms = event.release?.payload.terms;
  const status = unverified ? 'unverified' : deriveEventAvailability(event, now);
  const date = terms ? { day: new Intl.DateTimeFormat('en', { day: 'numeric', timeZone: terms.timeZone }).format(terms.startsAt), month: new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: terms.timeZone }).format(terms.startsAt) } : null;
  return <article className="pf-event-programme pf-surface-light">
    <div className="pf-event-programme-date" aria-hidden="true">{date ? <><strong>{date.day}</strong><span>{date.month}</span></> : <span>Date unavailable</span>}</div>
    <div className="pf-event-programme-body">
      <div className="pf-event-programme-badges">{isTestEventTerms(terms) && <StatusLabel tone="neutral">TEST EVENT</StatusLabel>}{status !== 'unverified' && <span className="pf-event-record-note" title="The public record was checked. This does not verify the organizer’s identity or physical attendance."><EventFactIcon name="check" />Record checked</span>}</div>
      <h2>{terms?.title ?? 'Event details unavailable'}</h2>
      {terms ? <><div className="pf-event-programme-facts"><p>{eventDayLabel(terms)}<span>{eventTimeLabel(terms)} ({terms.timeZone})</span></p><p>{eventFormatLabel(terms)}{eventLocationLabel(terms) && <span>{eventLocationLabel(terms)}</span>}</p></div>{terms.description && <p className="pf-event-programme-description">{terms.description}</p>}</> : <p>The visitor page is unavailable. Open the event to check its current record.</p>}
      <div className="pf-event-programme-foot"><div><EventStatus status={status} />{terms && <span>{eventAdmissionLabel(terms)}</span>}</div>{isPublicEntityKey(event.projectRoot) && <Link className="pf-button pf-button--primary" href={routeHref({ name: 'event', projectRoot: event.projectRoot })} aria-label={`View ${terms?.title ?? 'event details'}`}>View event <span aria-hidden="true">→</span></Link>}</div>
    </div>
    <div className="pf-event-programme-art"><EventCover format={terms?.format} /></div>
  </article>;
}

export function EventEvidence({ event }: { event: EventAggregate }) {
  const organizer = event.root?.payload.coordinator;
  return <details className="pf-event-evidence"><summary>About this public record</summary><div className="pf-stack pf-stack--compact">
    <p>Partfolk reads this event and its contributors’ agreements from Arkiv. Your registration belongs to the exact event version you reviewed. When places are limited or invitations are required, the organizer confirms your place separately. It does not prove attendance.</p>
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
