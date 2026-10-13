import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { EventReadCache, eventReadKey, markEventReadStale } from './read-cache';

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function pending<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(): Snapshot {
  return { mode: 'public', source: 'arkiv', chainId: TIRAMISU_CHAIN_ID, blockNumber: '100',
    blockHash: `0x${'1'.repeat(64)}`, blockTimestamp: 1_000, fetchedAt: 1_005,
    completeness: 'complete', freshness: 'fresh', reasons: [] };
}

describe('concurrent event display reads', () => {
  it('shares one traversal, isolates consumer data, and starts a fresh traversal on the next refresh', async () => {
    const cache = new EventReadCache(), task = pending<{ items: string[] }>();
    const load = vi.fn(() => task.promise);
    const first = cache.run('catalog', load), second = cache.run('catalog', load);
    await flush(); expect(load).toHaveBeenCalledTimes(1);
    task.resolve({ items: ['event-a'] });
    const [left, right] = await Promise.all([first, second]);
    left.items.push('local-change'); expect(right.items).toEqual(['event-a']);
    await cache.run('catalog', load); expect(load).toHaveBeenCalledTimes(2);
  });

  it('isolates cancellation and aborts the traversal when every consumer leaves', async () => {
    const cache = new EventReadCache(), task = pending<string>();
    const load = vi.fn((_signal: AbortSignal) => task.promise);
    const firstOwner = new AbortController(), secondOwner = new AbortController();
    const first = cache.run('catalog', load, firstOwner.signal), second = cache.run('catalog', load, secondOwner.signal);
    await flush();
    firstOwner.abort(); await expect(first).rejects.toMatchObject({ detail: { code: 'unverified' } });
    expect(load.mock.calls[0]![0].aborted).toBe(false);
    secondOwner.abort(); await expect(second).rejects.toMatchObject({ detail: { code: 'unverified' } });
    expect(load.mock.calls[0]![0].aborted).toBe(true);
    task.resolve('late result'); await flush();
    await expect(cache.run('catalog', async () => 'new result')).resolves.toBe('new result');
  });

  it('invalidates late results without erasing a replacement traversal', async () => {
    const cache = new EventReadCache(), old = pending<string>(), fresh = pending<string>();
    const previous = cache.run('catalog', () => old.promise); await flush();
    cache.invalidate(); await expect(previous).rejects.toMatchObject({ detail: { code: 'unverified' } });
    const load = vi.fn(() => fresh.promise);
    const replacement = cache.run('catalog', load); await flush();
    old.resolve('former block'); await flush();
    const concurrent = cache.run('catalog', load); await flush();
    expect(load).toHaveBeenCalledTimes(1);
    fresh.resolve('current block'); await expect(Promise.all([replacement, concurrent])).resolves.toEqual(['current block', 'current block']);
  });

  it('bounds distinct pending traversals and never starts an already abandoned read', async () => {
    const cache = new EventReadCache(1), task = pending<string>(), load = vi.fn(() => task.promise);
    const first = cache.run('one', load); await flush();
    await expect(cache.run('two', load)).rejects.toMatchObject({ detail: { code: 'network', retryable: true } });
    const owner = new AbortController(); owner.abort();
    await expect(cache.run('three', load, owner.signal)).rejects.toMatchObject({ detail: { code: 'unverified' } });
    expect(load).toHaveBeenCalledTimes(1); task.resolve('done'); await first;
  });

  it('keys accounts, event roots, snapshot evidence, source policy and filters independently', () => {
    const baseline = ['mine', { kind: 'wallet', address: 'account-a' }, snapshot(), true, { search: 'one', city: 'Oxford' }];
    const key = eventReadKey(baseline);
    expect(eventReadKey(['mine', { address: 'account-a', kind: 'wallet' }, snapshot(), true, { city: 'Oxford', search: 'one' }])).toBe(key);
    expect(new Set([key,
      eventReadKey(['mine', { kind: 'wallet', address: 'account-b' }, snapshot(), true, baseline[4]]),
      eventReadKey(['event', 'root-a', snapshot(), true, baseline[4]]),
      eventReadKey(['event', 'root-b', snapshot(), true, baseline[4]]),
      eventReadKey(['mine', baseline[1], { ...snapshot(), blockHash: `0x${'2'.repeat(64)}` }, true, baseline[4]]),
      eventReadKey(['mine', baseline[1], { ...snapshot(), freshness: 'stale' }, true, baseline[4]]),
      eventReadKey(['mine', baseline[1], snapshot(), false, baseline[4]]),
      eventReadKey(['mine', baseline[1], snapshot(), true, { search: 'two', city: 'Oxford' }]),
    ]).size).toBe(8);
  });
});

describe('retained event evidence', () => {
  it('marks every nested snapshot stale and incomplete while retaining evidence and original read times', () => {
    const original = { items: [{ projectRoot: 'event-a', roster: { snapshot: snapshot() },
      sourceProject: { snapshot: snapshot(), publishers: [{ snapshot: snapshot() }] }, snapshot: snapshot() }], snapshot: snapshot() };
    const retained = markEventReadStale(original);
    const snapshots = [retained.snapshot, retained.items[0]!.snapshot, retained.items[0]!.roster.snapshot,
      retained.items[0]!.sourceProject.snapshot, retained.items[0]!.sourceProject.publishers[0]!.snapshot];
    for (const value of snapshots) expect(value).toEqual({ ...snapshot(), freshness: 'stale', completeness: 'incomplete', reasons: [{ code: 'rpc_error' }] });
    expect(retained.items[0]!.projectRoot).toBe('event-a'); expect(original.snapshot.freshness).toBe('fresh');
    expect(markEventReadStale(retained).snapshot.reasons).toEqual([{ code: 'rpc_error' }]);
  });

  it('expires confidence without changing completeness or local rehearsal snapshots', () => {
    const original = { snapshot: snapshot(), local: { snapshot: { ...snapshot(), mode: 'local', source: 'local' } } };
    const retained = markEventReadStale(original, 'stale_snapshot');
    expect(retained.snapshot).toEqual({ ...snapshot(), freshness: 'stale', reasons: [{ code: 'stale_snapshot' }] });
    expect(retained.local.snapshot).toEqual(original.local.snapshot);
  });
});
