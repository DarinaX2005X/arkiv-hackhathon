import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { Snapshot } from '../../domain/types';
import { ArkivRepositoryError } from '../arkiv/errors';

interface PendingRead {
  controller: AbortController;
  consumers: number;
  promise: Promise<unknown>;
}

function cancelled() {
  return new ArkivRepositoryError('unverified', 'incomplete_snapshot', 'This read was cancelled. Refresh to check the latest information.');
}

/** Exact display inputs, including account, source policy and the entire requested snapshot. */
export function eventReadKey(inputs: readonly unknown[]): string {
  try {
    return JSON.stringify([TIRAMISU_CHAIN_ID, ...inputs], (_key, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)));
    });
  } catch { throw new ArkivRepositoryError('invalid_input', 'invalid_input', 'The event read has invalid parameters.'); }
}

/** Shares only concurrent display reads. Every later refresh starts a new canonical read. */
export class EventReadCache {
  private readonly pending = new Map<string, PendingRead>();
  private generation = 0;
  constructor(private readonly maxPending = 32) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('Invalid event read bound.');
  }

  invalidate(): void {
    this.generation++;
    const previous = [...this.pending.values()]; this.pending.clear();
    for (const entry of previous) entry.controller.abort();
  }

  run<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled());
    let entry = this.pending.get(key);
    if (entry?.controller.signal.aborted) { this.pending.delete(key); entry = undefined; }
    if (!entry) {
      if (this.pending.size >= this.maxPending) return Promise.reject(new ArkivRepositoryError('network', 'rpc_error',
        'Several reads are already in progress. Try again shortly.', true));
      const generation = this.generation, controller = new AbortController();
      const fresh: PendingRead = { controller, consumers: 0, promise: Promise.resolve() };
      fresh.promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancelled();
        return load(controller.signal);
      }).then(value => {
        if (controller.signal.aborted || generation !== this.generation) throw cancelled();
        return value;
      }).finally(() => { if (this.pending.get(key) === fresh) this.pending.delete(key); });
      this.pending.set(key, fresh); entry = fresh;
    }
    return this.join<T>(entry, signal);
  }

  private join<T>(entry: PendingRead, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      entry.consumers++;
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort); entry.controller.signal.removeEventListener('abort', abort);
        entry.consumers--; if (!entry.consumers) entry.controller.abort();
        complete();
      };
      const abort = () => finish(() => reject(cancelled()));
      signal?.addEventListener('abort', abort, { once: true });
      entry.controller.signal.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => {
        try { const copy = structuredClone(value) as T; finish(() => resolve(copy)); }
        catch (error) { finish(() => reject(error)); }
      }, error => finish(() => reject(error)));
    });
  }
}

/** Retains display evidence without turning old nested aggregates into current authority. */
export function markEventReadStale<T>(value: T, reason: 'rpc_error' | 'stale_snapshot' = 'rpc_error'): T {
  const copy = structuredClone(value), seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    const snapshot = item as Partial<Snapshot>;
    if (snapshot.mode === 'public' && snapshot.source === 'arkiv' && Array.isArray(snapshot.reasons)
      && typeof snapshot.fetchedAt === 'number' && typeof snapshot.blockTimestamp === 'number'
      && (snapshot.completeness === 'complete' || snapshot.completeness === 'incomplete')
      && (snapshot.freshness === 'fresh' || snapshot.freshness === 'stale')) {
      snapshot.freshness = 'stale';
      if (reason === 'rpc_error') snapshot.completeness = 'incomplete';
      if (!snapshot.reasons.some(item => item.code === reason)) snapshot.reasons.push({ code: reason });
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(copy); return copy;
}
