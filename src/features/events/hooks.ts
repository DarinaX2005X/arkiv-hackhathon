import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSession } from '../../app/session';
import type { EventRepositoryContract, MyEvent } from '../../data/events/types';
import type { RepositoryError } from '../../data/types';
import type { AttendanceState, EventAggregate, EventScope } from '../../domain/events';
import type { Actor, PublicEntityKey } from '../../domain/types';

export interface EventRead {
  event: EventAggregate;
  attendance: EventScope<AttendanceState> | null;
  myEvent: MyEvent | null;
  actor: Extract<Actor, { kind: 'wallet' }> | null;
}

/** Public detail and personal intent are read at one authenticated snapshot. */
export async function readEventForActor(repository: EventRepositoryContract, projectRoot: PublicEntityKey,
  actor: Extract<Actor, { kind: 'wallet' }> | null, signal?: AbortSignal): Promise<
  { ok: true; value: EventRead } | { ok: false; error: RepositoryError }
> {
  const result = await repository.loadEvent(projectRoot, { signal });
  if (!result.ok) return result;
  let attendance: EventScope<AttendanceState> | null = null;
  let myEvent: MyEvent | null = null;
  if (actor) {
    const own = await repository.listMyEvents(actor, { snapshot: result.value.snapshot, signal });
    if (!own.ok) attendance = { status: 'unverified', reasons: own.error.reasons.length ? own.error.reasons : [{ code: 'rpc_error' }] };
    else if (own.value.snapshot.completeness !== 'complete' || own.value.snapshot.freshness !== 'fresh'
      || own.value.snapshot.blockHash !== result.value.snapshot.blockHash || own.value.snapshot.blockNumber !== result.value.snapshot.blockNumber
      || own.value.diagnostics.length || own.value.snapshot.reasons.length) {
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

export function useEventRead(repository: EventRepositoryContract | null, projectRoot: PublicEntityKey, session: AppSession) {
  const [value, setValue] = useState<EventRead | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<RepositoryError | null>(null);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const address = session.actor?.kind === 'wallet' ? session.actor.address : null;
  const refresh = useCallback(async (): Promise<EventRead | null> => {
    const serial = ++sequence.current;
    abort.current?.abort();
    const current = new AbortController(); abort.current = current;
    if (!repository) { setError({ code: 'network', reasons: [], retryable: true }); return null; }
    setPending(true); setError(null);
    try {
      const result = await readEventForActor(repository, projectRoot, address ? { kind: 'wallet', address } : null, current.signal);
      if (serial !== sequence.current) return null;
      if (!result.ok) { setError(result.error); return null; }
      setValue(result.value);
      return result.value;
    } catch {
      if (serial === sequence.current) setError({ code: 'network', reasons: [], retryable: true });
      return null;
    } finally { if (serial === sequence.current) setPending(false); }
  }, [repository, projectRoot, address]);
  useEffect(() => { setValue(null); void refresh(); return () => { ++sequence.current; abort.current?.abort(); }; }, [refresh]);
  return { value, pending, error, refresh };
}

/** Freshness can expire while a page stays open, without a user interaction. */
export function useEventClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(interval); }, []);
  return now;
}
