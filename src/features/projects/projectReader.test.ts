import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalSnapshot, makeSmallWorksProject, SMALL_WORKS_NOW } from '../../domain/fixtures';
import type { ProjectAggregate } from '../../domain/types';
import type { Result } from '../../data/types';
import { createProjectReader, PROJECT_REFRESH_INTERVAL_MS, type FocusEvents } from './projectReader';

function focusEvents() {
  const listeners = new Set<() => void>();
  return {
    addEventListener: (_type: 'focus', listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: 'focus', listener: () => void) => { listeners.delete(listener); },
    focus: () => { for (const listener of listeners) listener(); },
    count: () => listeners.size,
  } satisfies FocusEvents & { focus: () => void; count: () => number };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const fresh = () => makeSmallWorksProject({ now: Date.now() });
const ok = (project = fresh()): Result<ProjectAggregate> => ({ ok: true, value: project });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(SMALL_WORKS_NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('project reads and freshness', () => {
  it('expires a retained snapshot on restart even when the replacement read hangs', async () => {
    const pending = deferred<Result<ProjectAggregate>>();
    const load = vi.fn<() => Promise<Result<ProjectAggregate>>>().mockResolvedValueOnce(ok()).mockReturnValue(pending.promise);
    const reader = createProjectReader(load);
    reader.start(true); await reader.refresh();
    reader.stop(); reader.start(true);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(reader.getSnapshot().project?.snapshot.freshness).toBe('stale');
    expect(reader.getSnapshot().loading).toBe(true);
    reader.stop();
  });
  it('refreshes public records every 15 seconds and on focus without any write callback', async () => {
    const focus = focusEvents(), load = vi.fn(async () => ok());
    const reader = createProjectReader(load);
    reader.start(true, focus); await reader.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROJECT_REFRESH_INTERVAL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    focus.focus(); await reader.refresh();
    expect(load).toHaveBeenCalledTimes(3);
    expect(reader.getSnapshot().project?.snapshot.freshness).toBe('fresh');
    reader.stop(); expect(focus.count()).toBe(0);
  });

  it('keeps local work to mount and manual reads, without timer or focus reads', async () => {
    const focus = focusEvents(), load = vi.fn(async () => ok());
    const reader = createProjectReader(load);
    reader.start(false, focus); await reader.refresh();
    expect(focus.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    focus.focus(); await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(1);
    await reader.refresh(); expect(load).toHaveBeenCalledTimes(2);
    reader.stop();
  });

  it('shares a pending read across polling, focus and manual refresh', async () => {
    const pending = deferred<Result<ProjectAggregate>>(), focus = focusEvents();
    const load = vi.fn(() => pending.promise), reader = createProjectReader(load);
    reader.start(true, focus);
    const first = reader.refresh();
    await vi.advanceTimersByTimeAsync(45_000);
    focus.focus();
    expect(reader.refresh()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(ok()); await first;
    expect(reader.getSnapshot().loading).toBe(false);
    reader.stop();
  });

  it('retains the last-known project but marks its agreement evidence stale after an error', async () => {
    const project = fresh(), load = vi.fn<() => Promise<Result<ProjectAggregate>>>()
      .mockResolvedValueOnce(ok(project))
      .mockResolvedValueOnce({ ok: false, error: { code: 'network', reasons: [{ code: 'rpc_error' }], retryable: true } })
      .mockRejectedValueOnce(new Error('Connection interrupted'))
      .mockImplementation(async () => ok());
    const reader = createProjectReader(load);
    reader.start(true); await reader.refresh(); await reader.refresh();
    expect(reader.getSnapshot().project?.root).toBe(project.root);
    expect(reader.getSnapshot().project?.snapshot).toMatchObject({ freshness: 'stale', completeness: 'incomplete' });
    expect(reader.getSnapshot().error?.code).toBe('network');
    await reader.refresh();
    expect(reader.getSnapshot().project?.snapshot.reasons.filter(reason => reason.code === 'rpc_error')).toHaveLength(1);
    await reader.refresh();
    expect(reader.getSnapshot().project?.snapshot.freshness).toBe('fresh');
    expect(reader.getSnapshot().error).toBeNull();
    reader.stop();
  });

  it('expires a formerly fresh agreement on time even when its next read never finishes', async () => {
    const pending = deferred<Result<ProjectAggregate>>();
    const load = vi.fn<() => Promise<Result<ProjectAggregate>>>().mockResolvedValueOnce(ok()).mockImplementation(() => pending.promise);
    const reader = createProjectReader(load);
    reader.start(true); await reader.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(reader.getSnapshot().loading).toBe(true);
    expect(reader.getSnapshot().project?.snapshot.freshness).toBe('fresh');
    await vi.advanceTimersByTimeAsync(1);
    expect(reader.getSnapshot().project?.snapshot.freshness).toBe('stale');
    expect(reader.getSnapshot().project?.snapshot.reasons).toContainEqual({ code: 'stale_snapshot' });
    reader.stop();
  });

  it('aborts and removes all work on cleanup, ignoring an obsolete result', async () => {
    const pending = deferred<Result<ProjectAggregate>>(), focus = focusEvents();
    const load = vi.fn((_signal: AbortSignal) => pending.promise), reader = createProjectReader(load);
    reader.start(true, focus); const work = reader.refresh(); await Promise.resolve();
    const signal = load.mock.calls[0]![0];
    reader.stop();
    expect(signal.aborted).toBe(true);
    expect(focus.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(ok()); await work;
    focus.focus(); await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(reader.getSnapshot().project).toBeNull();
  });

  it('does not let a cancelled old read replace a restarted reader’s result', async () => {
    const pending = deferred<Result<ProjectAggregate>>(), current = fresh();
    const load = vi.fn<(_signal: AbortSignal) => Promise<Result<ProjectAggregate>>>().mockImplementationOnce(() => pending.promise).mockResolvedValue(ok(current));
    const reader = createProjectReader(load);
    reader.start(true); const oldWork = reader.refresh(); await Promise.resolve();
    reader.stop(); reader.start(true); await reader.refresh();
    const outdated = fresh(); pending.resolve(ok(outdated)); await oldWork;
    expect(reader.getSnapshot().project).toBe(current);
    reader.stop();
  });

  it('supports independently loaded publisher records without a project-specific dependency', async () => {
    const record = { publisherName: 'Library', snapshot: createLocalSnapshot(Date.now()) };
    const reader = createProjectReader(async () => ({ ok: true as const, value: record }));
    reader.start(true); await reader.refresh();
    expect(reader.getSnapshot().project?.publisherName).toBe('Library');
    reader.stop();
  });
});
