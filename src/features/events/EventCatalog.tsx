import { useEffect, useMemo, useState } from 'react';
import { routeHref } from '../../app/routes';
import type { AppSession } from '../../app/session';
import type { EventRepositoryContract } from '../../data/events/types';
import { currentEventSnapshot, type EventAggregate } from '../../domain/events';
import { Button, EmptyState, ErrorState, Field, Link, LoadingState, Notice, SearchSelect, Select } from '../../ui';
import { EventSummary } from './EventSummary';
import { useEventCatalog, useEventClock } from './hooks';
import { catalogFiltersFromInput, emptyCatalogFilters, filterCatalog, validCatalogLocation, type CatalogFilterInput } from './filters';
import { eventError } from './presentation';
import { catalogPlaceOptions } from './places';
import './events.css';

export interface EventCatalogProps { repository: EventRepositoryContract | null; session?: AppSession }
const noEvents: readonly EventAggregate[] = [];

export function EventCatalog({ repository }: EventCatalogProps) {
  const [input, setInput] = useState<CatalogFilterInput>(emptyCatalogFilters);
  const [zone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const { result, pending, error, refresh } = useEventCatalog(repository);
  const now = useEventClock();
  const events = result?.items ?? noEvents;
  const options = useMemo(() => catalogPlaceOptions(events, input.countryCode), [events, input.countryCode]);
  const parsed = useMemo(() => catalogFiltersFromInput(input, events, zone), [input, events, zone]);
  const incomplete = Boolean(result && result.snapshot.completeness !== 'complete');
  const stale = Boolean(result && !currentEventSnapshot(result.snapshot, now));
  // A refresh does not invalidate an already fresh snapshot. Keep its cards and
  // availability filters stable while the replacement read is in flight.
  const unverified = Boolean(error || stale);
  const warnings = Boolean(result?.diagnostics.length);
  const visible = useMemo(() => filterCatalog(events, parsed.filters, now, unverified), [events, parsed.filters, now, unverified]);
  const filtered = Object.values(input).some(Boolean);

  useEffect(() => {
    setInput(previous => {
      const location = validCatalogLocation(events, previous.countryCode, previous.city);
      return location.countryCode === previous.countryCode && location.city === previous.city ? previous : { ...previous, ...location };
    });
  }, [events]);

  function change(field: keyof CatalogFilterInput, value: string) {
    setInput(previous => ({ ...previous, [field]: value, ...(field === 'format' && value === 'online' ? { countryCode: '', city: '' } : {}) }));
  }
  function changeCountry(countryCode: string) {
    setInput(previous => ({ ...previous, ...validCatalogLocation(events, countryCode, previous.city) }));
  }
  function clearFilters() { setInput(emptyCatalogFilters); }

  return <section className="pf-events-page" aria-labelledby="events-title">
    <header className="pf-events-heading"><div><h1 id="events-title">Find an event to be part of</h1>
      <p>Find a gathering nearby, join online or choose a hybrid event. See when it happens and how to take part.</p></div>
      <Link href={routeHref({ name: 'my-events' })}>My events</Link></header>
    <form className="pf-event-filters pf-surface-light" onSubmit={event => event.preventDefault()} aria-label="Filter events">
      <div className="pf-event-filter-core">
        <Field type="search" label="Search event titles" placeholder="Search by event title" value={input.search} onChange={event => change('search', event.target.value)} maxLength={200} />
        <Select label="Event format" value={input.format} onChange={event => change('format', event.target.value)} options={[{ value: '', label: 'Every format' }, { value: 'in_person', label: 'In person' }, { value: 'online', label: 'Online' }, { value: 'hybrid', label: 'Hybrid' }]} />
        <Select label="Registration" value={input.availability} onChange={event => change('availability', event.target.value)} options={[{ value: '', label: 'Every status' }, { value: 'open', label: 'Registration open' }, { value: 'waitlist', label: 'Waiting list open' }, { value: 'full', label: 'Fully booked' }, { value: 'registration_closed', label: 'Deadline passed' }, { value: 'closed', label: 'Registration closed' }, { value: 'paused', label: 'Plans being updated' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'ended', label: 'Ended' }, { value: 'unverified', label: 'Needs verification' }]} />
      </div>
      <div className="pf-event-filter-extra">
        <SearchSelect label="Country" value={input.countryCode} options={options.countries} placeholder="Every country" clearLabel="Clear country" onValueChange={changeCountry} disabled={input.format === 'online' || !options.countries.length} noResultsText="No country in this event list matches" />
        <SearchSelect label="City" value={input.city} options={options.cities} placeholder={input.countryCode ? 'Every city' : 'Choose country first'} clearLabel="Clear city" onValueChange={value => change('city', value)} disabled={input.format === 'online' || !input.countryCode || !options.cities.length} noResultsText="No city in this event list matches" />
        <Field type="date" label="From date" value={input.from} onChange={event => change('from', event.target.value)} error={parsed.dateErrorField === 'from' ? parsed.dateError : undefined} />
        <Field type="date" label="Through date" value={input.to} onChange={event => change('to', event.target.value)} error={parsed.dateErrorField === 'to' ? parsed.dateError : undefined} />
        <Field type="date" label="Deadline by" value={input.deadline} onChange={event => change('deadline', event.target.value)} error={parsed.deadlineError} hint="Registration deadlines on or before this date." />
      </div>
      <div className="pf-event-filter-foot"><p>Filters update as you choose. Calendar dates use {zone}.</p>
        {filtered && <Button variant="quiet" size="compact" onClick={clearFilters}>Clear filters</Button>}</div>
    </form>
    {error && <ErrorState title="Events could not be refreshed" description={eventError(error)} actions={<Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Try again</Button>} />}
    {pending && !result && <LoadingState title="Reading published events" description="Checking event details and registration availability." />}
    {!pending && !error && incomplete && <Notice tone="warning" title="This list is incomplete" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>Some events could not be loaded. The records shown need a fresh check before registration.</Notice>}
    {!pending && !error && warnings && !stale && <Notice tone="warning" title="Some published records could not be verified" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>Some events could not be loaded safely. The verified records below are still available to review.</Notice>}
    {!pending && !error && stale && !incomplete && <Notice tone="warning" title="This list needs a fresh check" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>Open an event to read its current registration status, or refresh this list.</Notice>}
    {result && <div className="pf-events-results" aria-busy={pending}>
      <div className="pf-events-result-heading"><p className="pf-events-result-label" role="status" aria-live="polite">{pending ? 'Refreshing event records.' : `${visible.length} ${visible.length === 1 ? 'event' : 'events'}${filtered ? ' match your filters' : ' to explore'}${unverified ? ' in this unverified list' : ''}`}</p>
        {!error && !stale && <Button variant="quiet" size="compact" disabled={pending} onClick={() => void refresh()}>Refresh events</Button>}</div>
      {visible.length > 0 && <div className="pf-event-list">{visible.map(event => <EventSummary key={event.projectRoot} event={event} now={now} unverified={unverified} />)}</div>}
      {!visible.length && !pending && <EmptyState
        title={unverified || warnings ? 'No matching events in the available records' : filtered ? 'No events match these filters' : 'No published events yet'}
        description={unverified || warnings ? 'The full event list could not be verified. Adjust your filters or refresh to check the current records.' : filtered ? 'Try another title, place or a wider date range. You can also open an event link shared with you.' : 'Events appear here when an organizer publishes their visitor page after the team agrees on the preparations.'}
        actions={filtered ? <Button variant="secondary" onClick={clearFilters}>Show all events</Button> : !unverified && !warnings ? <Link href={routeHref({ name: 'new-project' })}>Organize an event</Link> : undefined} />}
    </div>}
  </section>;
}
