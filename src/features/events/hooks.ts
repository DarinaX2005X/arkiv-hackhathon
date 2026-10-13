import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSession } from '../../app/session';
import type { EventReadOptions, EventRepositoryContract, MyEvent } from '../../data/events/types';
import { markEventReadStale } from '../../data/events/read-cache';
import type { ListResult, RepositoryError } from '../../data/types';
import { eventRosterVerified, type AttendanceState, type EventAggregate, type EventScope } from '../../domain/events';
import type { Actor, PublicEntityKey } from '../../domain/types';

export interface EventRead {
  event: EventAggregate;
  attendance: EventScope<AttendanceState> | null;
  myEvent: MyEvent | null;
  actor: Extract<Actor, { kind: 'wallet' }> | null;
}

const cancelledEventRead = (): { ok: false; error: RepositoryError } => ({ ok: false,
  error: { code: 'unverified', reasons: [{ code: 'incomplete_snapshot' }], retryable: true } });

/** Read the entire bounded catalog once. Search and facets never trigger network work. */
export function useEventCatalog(repository: EventRepositoryContract | null) {
  const [result, setResult] = useState<ListResult<EventAggregate> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<RepositoryError | null>(null);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const serial = ++sequence.current;
    abort.current?.abort();
    const current = new AbortController();
    abort.current = current;
    if (!repository) {
      setError({ code: 'network', reasons: [], retryable: true });
      setPending(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await repository.listEvents(undefined, { signal: current.signal });
      if (serial !== sequence.current || current.signal.aborted) return;
      if (response.ok) setResult(response.value);
      else { setError(response.error); setResult(previous => previous ? markEventReadStale(previous) : null); }
    } catch {
      if (serial === sequence.current && !current.signal.aborted) {
        setError({ code: 'network', reasons: [], retryable: true });
        setResult(previous => previous ? markEventReadStale(previous) : null);
      }
    } finally {
      if (serial === sequence.current) setPending(false);
    }
  }, [repository]);
  useEffect(() => {
    setResult(null);
    void refresh();
    return () => { ++sequence.current; abort.current?.abort(); };
  }, [refresh]);
  return { result, pending, error, refresh };
}

/** Public detail and personal intent are read at one authenticated snapshot. */
export async function readEventForActor(repository: EventRepositoryContract, projectRoot: PublicEntityKey,
  actor: Extract<Actor, { kind: 'wallet' }> | null, signal?: AbortSignal, options: Pick<EventReadOptions, 'includeSource'> = {}): Promise<
  { ok: true; value: EventRead } | { ok: false; error: RepositoryError }
> {
  if (signal?.aborted) return cancelledEventRead();
  const result = await repository.loadEvent(projectRoot, { signal, ...options });
  if (signal?.aborted) return cancelledEventRead();
  if (!result.ok) return result;
  let attendance: EventScope<AttendanceState> | null = null;
  let myEvent: MyEvent | null = null;
  if (actor) {
    // Structured event reads already contain the complete creator-authenticated
    // roster at this same snapshot. Do not reread every event for this account.
    if (eventRosterVerified(result.value)) {
      const entry = result.value.roster!.entries.find(candidate => candidate.attendee.toLowerCase() === actor.address.toLowerCase());
      attendance = entry?.attendance ?? { status: 'missing', reason: 'not_initialized' };
      if (entry) myEvent = { projectRoot, attendance, event: result.value, registeredRelease: entry.registeredRelease,
        diagnostics: attendance.status === 'unverified' ? attendance.reasons : attendance.status === 'conflict' ? [{ code: 'conflicting_heads' }] : [] };
      return { ok: true, value: { event: result.value, attendance, myEvent, actor } };
    }
    const own = await repository.listMyEvents(actor, { snapshot: result.value.snapshot, signal, ...options });
    if (signal?.aborted) return cancelledEventRead();
    if (!own.ok) attendance = { status: 'unverified', reasons: own.error.reasons.length ? own.error.reasons : [{ code: 'rpc_error' }] };
    else if (own.value.snapshot.completeness !== 'complete' || own.value.snapshot.freshness !== 'fresh'
      || own.value.snapshot.blockHash !== result.value.snapshot.blockHash || own.value.snapshot.blockNumber !== result.value.snapshot.blockNumber
      || own.value.snapshot.reasons.length) {
      attendance = { status: 'unverified', reasons: [{ code: 'incomplete_snapshot' }] };
    } else {
      const matches = own.value.items.filter(item => item.projectRoot === projectRoot);
      if (matches.length > 1) attendance = { status: 'unverified', reasons: [{ code: 'conflicting_heads' }] };
      else {
        myEvent = matches[0] ?? null;
        attendance = myEvent?.attendance ?? { status: 'missing', reason: 'not_initialized' };
        // Missing event references must not erase an authenticated owner decision.
        // Its own scope remains usable for withdrawal; attendanceStatus still
        // checks all required event evidence before claiming a current registration.
      }
    }
  }
  return { ok: true, value: { event: result.value, attendance, myEvent, actor } };
}

/** Withdrawal authenticates the owner's decision without requiring contributor availability. */
export function readEventForWithdrawal(repository: EventRepositoryContract, projectRoot: PublicEntityKey,
  actor: Extract<Actor, { kind: 'wallet' }>, signal?: AbortSignal) {
  return readEventForActor(repository, projectRoot, actor, signal, { includeSource: false });
}

export function useEventRead(repository: EventRepositoryContract | null, projectRoot: PublicEntityKey, session: AppSession) {
  const [value, setValue] = useState<EventRead | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<RepositoryError | null>(null);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const address = session.actor?.kind === 'wallet' ? session.actor.address : null;
  const refreshRead = useCallback(async (withdrawal = false): Promise<EventRead | null> => {
    const serial = ++sequence.current;
    abort.current?.abort();
    const current = new AbortController(); abort.current = current;
    if (!repository) { setPending(false); setError({ code: 'network', reasons: [], retryable: true }); return null; }
    setPending(true); setError(null);
    try {
      const actor = address ? { kind: 'wallet' as const, address } : null;
      const result = withdrawal && actor
        ? await readEventForWithdrawal(repository, projectRoot, actor, current.signal)
        : await readEventForActor(repository, projectRoot, actor, current.signal);
      if (serial !== sequence.current || current.signal.aborted) return null;
      if (!result.ok) {
        setError(result.error);
        setValue(previous => previous ? markEventReadStale(previous) : null);
        // Preserve access to the owner's withdrawal when only the event's source
        // is unavailable. Do not immediately fan out again during a transport
        // outage or cooldown; explicit withdrawal refresh remains available.
        if (!withdrawal && actor && result.error.code !== 'rate_limited' && result.error.code !== 'network') {
          const own = await readEventForWithdrawal(repository, projectRoot, actor, current.signal);
          if (serial === sequence.current && !current.signal.aborted && own.ok) setValue(own.value);
        }
        return null;
      }
      setValue(result.value);
      return result.value;
    } catch {
      if (serial === sequence.current && !current.signal.aborted) {
        setError({ code: 'network', reasons: [], retryable: true });
        setValue(previous => previous ? markEventReadStale(previous) : null);
      }
      return null;
    } finally { if (serial === sequence.current) setPending(false); }
  }, [repository, projectRoot, address]);
  const refresh = useCallback(() => refreshRead(), [refreshRead]);
  const refreshWithdrawal = useCallback(() => refreshRead(true), [refreshRead]);
  useEffect(() => { setValue(null); void refresh(); return () => { ++sequence.current; abort.current?.abort(); }; }, [refresh]);
  return { value, pending, error, refresh, refreshWithdrawal };
}

/** Freshness can expire while a page stays open, without a user interaction. */
export function useEventClock() {
  const [, setNow] = useState(Date.now);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(interval); }, []);
  // A completed read can arrive between ticks. Compare it with this render's time,
  // not the earlier mount tick, or a freshly fetched snapshot appears future-dated.
  return Date.now();
}
