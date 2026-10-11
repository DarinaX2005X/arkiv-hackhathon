import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { routeHref } from '../../app/routes';
import type { AppSession } from '../../app/session';
import type { EventFilters, EventRepositoryContract } from '../../data/events/types';
import type { ListResult, RepositoryError } from '../../data/types';
import type { EventAggregate } from '../../domain/events';
import { Button, EmptyState, ErrorState, Field, Link, LoadingState, Notice } from '../../ui';
import { EventSummary } from './EventSummary';
import { useEventClock } from './hooks';
import { catalogueFilters, eventError } from './presentation';
import './events.css';

export interface EventCatalogProps { repository: EventRepositoryContract | null; session?: AppSession }

export function EventCatalog({ repository }: EventCatalogProps) {
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
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
  const filtered = Boolean(filters.search || filters.from !== undefined || filters.to !== undefined);
  const incomplete = result && (result.snapshot.completeness !== 'complete' || result.snapshot.freshness !== 'fresh' || result.diagnostics.length > 0 || result.snapshot.reasons.length > 0);
  const stale = result && now - result.snapshot.fetchedAt > 60_000;
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = catalogueFilters(search, from, to, zone);
    if (!next.ok) { setValidation(next.error); return; }
    setValidation(null); setFilters(next.filters);
  }
  function clearFilters() { setSearch(''); setFrom(''); setTo(''); setValidation(null); setFilters({}); }
  return <section className="pf-events-page" aria-labelledby="events-title">
    <header className="pf-events-heading"><div><h1 id="events-title">Find an event to be part of</h1>
      <p>Explore events prepared by independent people and groups. Read the details, then choose what you want to join.</p></div>
      <Link href={routeHref({ name: 'my-events' })}>My events</Link></header>
    <form className="pf-event-filters" onSubmit={submit} aria-label="Find events">
      <Field type="search" label="Search event titles" placeholder="Search by event title" value={search} onChange={event => setSearch(event.target.value)} maxLength={200} />
      <Field type="date" label="From date" value={from} onChange={event => setFrom(event.target.value)} />
      <Field type="date" label="Through date" value={to} onChange={event => setTo(event.target.value)} />
      <Button type="submit" disabled={pending}>Find events</Button>
      <div className="pf-event-filter-foot"><p>Calendar dates use {zone}. Each event shows its own time zone.</p>
        {(search || from || to || filtered) && <Button variant="quiet" size="compact" onClick={clearFilters}>Clear filters</Button>}</div>
      {validation && <p className="pf-event-filter-error" role="alert">{validation}</p>}
    </form>
    {error && <ErrorState title="Events could not be refreshed" description={eventError(error)} actions={<Button variant="secondary" onClick={() => void refresh()} disabled={pending}>Try again</Button>} />}
    {pending && <LoadingState title="Reading published events" description="Checking the current details and preparation status from Arkiv." />}
    {!pending && !error && incomplete && <Notice tone="warning" title="This list is incomplete" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>Some public data could not be verified. The events below are the readable part of this snapshot; other events may be missing.</Notice>}
    {!pending && !error && stale && !incomplete && <Notice tone="warning" actions={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}>This list needs a fresh check. Open an event to read its current registration status.</Notice>}
    {result && result.items.length > 0 && <div className="pf-events-results" aria-live="polite" aria-busy={pending}>
      <p className="pf-events-result-label">{result.items.length} {result.items.length === 1 ? 'event' : 'events'} in this {incomplete ? 'partial ' : ''}result</p>
      <div className="pf-event-list">{result.items.map(event => <EventSummary key={event.projectRoot} event={event} now={now} unverified={Boolean(error || incomplete || pending)} />)}</div>
    </div>}
    {result && !result.items.length && !pending && !error && !incomplete && <EmptyState
      title={filtered ? 'No events match these filters' : 'No published events yet'}
      description={filtered ? 'Try another title or a wider date range. If an organizer shared an event link, you can open it directly.' : 'Events appear here when an organizer publishes their visitor page after the team has agreed on the preparations. You can also open an event link shared with you.'}
      actions={filtered ? <Button variant="secondary" onClick={clearFilters}>Show all events</Button> : <Link href={routeHref({ name: 'new-project' })}>Organize an event</Link>} />}
  </section>;
}
