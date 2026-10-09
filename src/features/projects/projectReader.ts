import type { ProjectAggregate, Snapshot } from '../../domain/types';
import type { RepositoryError, Result } from '../../data/types';

export const PROJECT_REFRESH_INTERVAL_MS = 15_000;
const MAX_FRESH_AGE_MS = 60_000;
export interface ProjectReadState<T extends { snapshot: Snapshot } = ProjectAggregate> { project: T | null; loading: boolean; error: RepositoryError | null }
export interface FocusEvents {
  addEventListener(type: 'focus', listener: () => void): void;
  removeEventListener(type: 'focus', listener: () => void): void;
}

function staleProject<T extends { snapshot: Snapshot }>(project: T, reason: 'rpc_error' | 'stale_snapshot'): T {
  return { ...project, snapshot: { ...project.snapshot, freshness: 'stale',
    completeness: reason === 'rpc_error' ? 'incomplete' : project.snapshot.completeness,
    reasons: project.snapshot.reasons.some(item => item.code === reason) ? project.snapshot.reasons : [...project.snapshot.reasons, { code: reason }],
  } };
}

/** Polls reads only. A pending request is shared by timer, focus and manual refresh. */
export function createProjectReader<T extends { snapshot: Snapshot } = ProjectAggregate>(load: (signal: AbortSignal) => Promise<Result<T>>, now = Date.now) {
  let state: ProjectReadState<T> = { project: null, loading: false, error: null };
  const listeners = new Set<() => void>();
  let active = false, publicReads = false, generation = 0, inFlight: Promise<void> | null = null;
  let abort: AbortController | null = null, timer: ReturnType<typeof setInterval> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopFocus: (() => void) | null = null;
  const update = (next: ProjectReadState<T>) => { state = next; for (const listener of listeners) listener(); };
  const expireOldRead = () => {
    if (!state.project || state.project.snapshot.freshness !== 'fresh') return;
    const age = now() - state.project.snapshot.fetchedAt;
    if (age > MAX_FRESH_AGE_MS || age < 0) update({ ...state, project: staleProject(state.project, 'stale_snapshot') });
  };
  const scheduleExpiry = () => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (!active || !publicReads || !state.project || state.project.snapshot.freshness !== 'fresh') return;
    expiryTimer = setTimeout(() => { expiryTimer = null; expireOldRead(); }, Math.max(1, state.project.snapshot.fetchedAt + MAX_FRESH_AGE_MS + 1 - now()));
  };
  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve();
    expireOldRead();
    if (inFlight) return inFlight;
    const request = generation, controller = new AbortController();
    abort = controller;
    update({ ...state, loading: true });
    const work = Promise.resolve().then(() => {
      if (!active || request !== generation || controller.signal.aborted) throw new Error('Read cancelled.');
      return load(controller.signal);
    }).then(result => {
      if (!active || request !== generation || controller.signal.aborted) return;
      if (result.ok) update({ project: result.value, loading: true, error: null });
      else update({ project: state.project ? staleProject(state.project, 'rpc_error') : null, loading: true, error: result.error });
      expireOldRead();
      scheduleExpiry();
    }).catch(() => {
      if (!active || request !== generation || controller.signal.aborted) return;
      update({ project: state.project ? staleProject(state.project, 'rpc_error') : null, loading: true,
        error: { code: 'network', reasons: [{ code: 'rpc_error' }], retryable: true } });
    }).finally(() => {
      if (request !== generation || !active) return;
      inFlight = null; abort = null;
      update({ ...state, loading: false });
    });
    inFlight = work;
    return work;
  };
  const stop = () => {
    active = false; generation++;
    if (timer !== null) clearInterval(timer);
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    timer = null; stopFocus?.(); stopFocus = null;
    abort?.abort(); abort = null; inFlight = null;
    state = { ...state, loading: false };
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    start(shouldPoll: boolean, focus?: FocusEvents) {
      stop(); active = true; publicReads = shouldPoll;
      void refresh();
      scheduleExpiry();
      if (publicReads) {
        timer = setInterval(() => { void refresh(); }, PROJECT_REFRESH_INTERVAL_MS);
        if (focus) {
          const onFocus = () => { void refresh(); };
          focus.addEventListener('focus', onFocus);
          stopFocus = () => focus.removeEventListener('focus', onFocus);
        }
      }
    },
    stop,
  };
}
