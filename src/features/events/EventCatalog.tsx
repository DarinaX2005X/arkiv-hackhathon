import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { routeHref } from '../../app/routes';
import type { AppSession } from '../../app/session';
import type { EventFilters, EventRepositoryContract } from '../../data/events/types';
import type { ListResult, RepositoryError } from '../../data/types';
import type { EventAggregate } from '../../domain/events';
import { Button, EmptyState, ErrorState, Field, Link, LoadingState, Notice, Select } from '../../ui';
import { EventSummary } from './EventSummary';
import { useEventClock } from './hooks';
import { catalogueFilters, eventError } from './presentation';
import './events.css';
import { countryOptions } from './places';

export interface EventCatalogProps { repository: EventRepositoryContract | null; session?: AppSession }

export function EventCatalog({ repository }: EventCatalogProps) {
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [format, setFormat] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [city, setCity] = useState('');
  const [availability, setAvailability] = useState('');
  const [deadline, setDeadline] = useState('');
  const [filters, setFilters] = useState<EventFilters>({});
  const [validation, setValidation] = useState<string | null>(null);
  const [result, setResult] = useState<ListResult<EventAggregate> | null>(null);
  const [error, setError] = useState<RepositoryError | null>(null);
  const [pending, setPending] = useState(false);
  const [zone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const now = useEventClock();
  const refresh = useCallback(async () => {
    const serial = ++sequence.current;
    abort.current?.abort(); const current = new AbortController(); abort.current = current;
    if (!repository) { setError({ code: 'network', reasons: [], retryable: true }); return; }
    setPending(true); setError(null);
    try {
      const response = await repository.listEvents(filters, { signal: current.signal });
      if (serial !== sequence.current) return;
      if (response.ok) setResult(response.value); else setError(response.error);
    } catch { if (serial === sequence.current) setError({ code: 'network', reasons: [], retryable: true }); }
    finally { if (serial === sequence.current) setPending(false); }
  }, [repository, filters]);
  useEffect(() => { setResult(null); void refresh(); return () => { ++sequence.current; abort.current?.abort(); }; }, [refresh]);
  const filtered = Object.keys(filters).length > 0;
  const incomplete = result && (result.snapshot.completeness !== 'complete' || result.snapshot.freshness !== 'fresh' || result.snapshot.reasons.length > 0);
  const warnings = Boolean(result?.diagnostics.length);
  const stale = result && now - result.snapshot.fetchedAt > 60_000;
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = catalogueFilters(search, from, to, zone);
    if (!next.ok) { setValidation(next.error); return; }
    const deadlineFilter = catalogueFilters('', '', deadline, zone);
    if (!deadlineFilter.ok) { setValidation(deadlineFilter.error); return; }
    if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) { setValidation('Choose a country from the list.'); return; }
    setValidation(null); setFilters({ ...next.filters, ...(format ? { format: format as EventFilters['format'] } : {}), ...(countryCode ? { countryCode: countryCode.toUpperCase() } : {}), ...(city.trim() ? { city: city.trim() } : {}), ...(availability ? { availability: availability as EventFilters['availability'] } : {}), ...(deadlineFilter.filters.to !== undefined ? { deadlineBefore: deadlineFilter.filters.to } : {}) });
  }
  function clearFilters() { setSearch(''); setFrom(''); setTo(''); setFormat(''); setCountryCode(''); setCity(''); setAvailability(''); setDeadline(''); setValidation(null); setFilters({}); }
  return <section className="pf-events-page" aria-labelledby="events-title">
    <header className="pf-events-heading"><div><h1 id="events-title">Find an event to be part of</h1>
      <p>Find a gathering nearby, join online or choose a hybrid event. See when it happens and how to take part.</p></div>
      <Link href={routeHref({ name: 'my-events' })}>My events</Link></header>
    <form className="pf-event-filters pf-surface-light" onSubmit={submit} aria-label="Find events">
      <div className="pf-event-filter-core">
        <Field type="search" label="Search event titles" placeholder="Search by event title" value={search} onChange={event => setSearch(event.target.value)} maxLength={200} />
        <Select label="Event format" value={format} onChange={event => setFormat(event.target.value)} options={[{ value: '', label: 'Every format' }, { value: 'in_person', label: 'In person' }, { value: 'online', label: 'Online' }, { value: 'hybrid', label: 'Hybrid' }]} />
        <Select label="Country" value={countryCode} options={[{ value: '', label: 'Every country' }, ...countryOptions]} onChange={event => setCountryCode(event.target.value)} />
        <Field label="City" placeholder="Any city" value={city} maxLength={200} onChange={event => setCity(event.target.value)} />
        <Button type="submit" disabled={pending}>Find events</Button>
      </div>
      <details className="pf-event-filter-more"><summary>Dates and registration{(filters.from !== undefined || filters.to !== undefined || filters.availability || filters.deadlineBefore !== undefined) ? ' (filters active)' : ''}</summary>
        <div className="pf-event-filter-extra">
          <Field type="date" label="From date" value={from} onChange={event => setFrom(event.target.value)} />
          <Field type="date" label="Through date" value={to} onChange={event => setTo(event.target.value)} />
          <Select label="Availability" value={availability} onChange={event => setAvailability(event.target.value)} options={[{ value: '', label: 'Every status' }, { value: 'open', label: 'Registration open' }, { value: 'waitlist', label: 'Waiting list open' }, { value: 'full', label: 'Fully booked' }, { value: 'registration_closed', label: 'Deadline passed' }, { value: 'closed', label: 'Registration closed' }, { value: 'paused', label: 'Plans being updated' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'ended', label: 'Ended' }]} />
          <Field type="date" label="Registration deadline by" value={deadline} onChange={event => setDeadline(event.target.value)} hint="Events with a deadline on or before this date." />
        </div><p className="pf-field-message">Calendar dates use {zone}. Each event shows its own time zone.</p><Button type="submit" variant="secondary" disabled={pending}>Apply date and registration filters</Button>
      </details>
      <div className="pf-event-filter-foot"><p>{filtered ? `${Object.keys(filters).length} filters applied` : 'Online, in person and hybrid events'}</p>
        {(search || from || to || format || countryCode || city || availability || deadline || filtered) && <Button variant="quiet" size="compact" onClick={clearFilters}>Clear filters</Button>}</div>
      {validation && <p className="pf-event-filter-error" role="alert">{validation}</p>}
    </form>
    {error && <ErrorState title="Events could not be refreshed" description={eventError(error)} actions={<Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Try again</Button>} />}
    {pending && <LoadingState title="Reading published events" description="Checking event details and registration availability." />}
    {!pending && !error && incomplete && <Notice tone="warning" title="This list is incomplete" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>Some events could not be loaded. The events shown may not be the full list.</Notice>}
    {!pending && !error && warnings && !incomplete && <Notice tone="warning" title="Some published records could not be verified" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>Some events could not be loaded safely. Try refreshing the list.</Notice>}
    {!pending && !error && stale && !incomplete && <Notice tone="warning" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>This list needs a fresh check. Open an event to read its current registration status.</Notice>}
    {result && result.items.length > 0 && <div className="pf-events-results" aria-live="polite" aria-busy={pending}>
      <p className="pf-events-result-label">{result.items.length} {result.items.length === 1 ? 'event' : 'events'} in this {incomplete ? 'partial ' : ''}result</p>
      <div className="pf-event-list">{result.items.map(event => <EventSummary key={event.projectRoot} event={event} now={now} unverified={Boolean(error || incomplete || pending)} />)}</div>
    </div>}
    {result && !result.items.length && !pending && !error && !incomplete && !warnings && <EmptyState
      title={filtered ? 'No events match these filters' : 'No published events yet'}
      description={filtered ? 'Try another title, place or a wider date range. If an organizer shared an event link, you can open it directly.' : 'Events appear here when an organizer publishes their visitor page after the team has agreed on the preparations. You can also open an event link shared with you.'}
      actions={filtered ? <Button variant="secondary" onClick={clearFilters}>Show all events</Button> : <Link href={routeHref({ name: 'new-project' })}>Organize an event</Link>} />}
  </section>;
}
