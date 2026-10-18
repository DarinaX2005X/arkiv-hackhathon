import { beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise hook continuations directly; no DOM or browser renderer is used.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; current?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const slots: Slot[] = [], pending: (() => void)[] = [];
  let cursor = 0;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a?.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  return {
    reset() { slots.length = 0; cursor = 0; pending.length = 0; },
    render<T>(read: () => T) { cursor = 0; return read(); },
    effects() { for (const run of pending.splice(0)) run(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
    useState<T>(initial: T | (() => T)) {
      const id = cursor++;
      slots[id] ??= { value: typeof initial === 'function' ? (initial as () => T)() : initial };
      return [slots[id]!.value as T, (next: T | ((previous: T) => T)) => { slots[id]!.value = typeof next === 'function' ? (next as (previous: T) => T)(slots[id]!.value as T) : next; }] as const;
    },
    useRef<T>(initial: T) { const id = cursor++; slots[id] ??= { current: initial }; return slots[id] as { current: T }; },
    useMemo<T>(create: () => T, deps: readonly unknown[]) { const id = cursor++; if (!slots[id] || !same(slots[id]!.deps, deps)) slots[id] = { value: create(), deps }; return slots[id]!.value as T; },
    useCallback<T>(callback: T, deps: readonly unknown[]) { const id = cursor++; if (!slots[id] || !same(slots[id]!.deps, deps)) slots[id] = { value: callback, deps }; return slots[id]!.value as T; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const id = cursor++;
      if (!slots[id] || !same(slots[id]!.deps, deps)) {
        const previous = slots[id], slot: Slot = { deps }; slots[id] = slot;
        pending.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
      }
    },
  };
});
vi.mock('react', () => hooks);
vi.mock('../../domain/events', () => ({ eventRosterVerified: () => true }));
import { useEventRead } from './hooks';
import type { AppSession } from '../../app/session';
import type { EventRepositoryContract } from '../../data/events/types';

const projectRoot = `0x${'1'.repeat(64)}` as const;
const addressA = `0x${'a'.repeat(40)}` as const, addressB = `0x${'b'.repeat(40)}` as const;
const eventResult = () => ({ ok: true as const, value: { projectRoot, roster: { entries: [] } } });
const session = (address: typeof addressA | typeof addressB) => ({ mode: 'public', actor: { kind: 'wallet', address }, chainId: 7738577 }) as AppSession;
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const makeRepository = (loadEvent = vi.fn(async () => eventResult())) => ({ repository: { loadEvent } as unknown as EventRepositoryContract, loadEvent });

describe('event reads retained by a pending account action', () => {
  beforeEach(() => hooks.reset());

  it('does not start an old account refresh or replace the new account result', async () => {
    const { repository, loadEvent } = makeRepository();
    const a = hooks.render(() => useEventRead(repository, projectRoot, session(addressA)));
    hooks.effects(); await settle();
    const changing = hooks.render(() => useEventRead(repository, projectRoot, session(addressB)));
    expect(changing.value).toBeNull();
    hooks.effects(); await settle();
    expect(hooks.render(() => useEventRead(repository, projectRoot, session(addressB))).value?.actor?.address).toBe(addressB);
    await a.refresh(); await a.refreshWithdrawal();
    expect(loadEvent).toHaveBeenCalledTimes(2);
    expect(hooks.render(() => useEventRead(repository, projectRoot, session(addressB))).value?.actor?.address).toBe(addressB);
  });

  it('discards an old in-flight read even when its transport ignores abort', async () => {
    let finishOld!: (result: ReturnType<typeof eventResult>) => void;
    const loadEvent = vi.fn(async () => eventResult()).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const { repository } = makeRepository(loadEvent);
    hooks.render(() => useEventRead(repository, projectRoot, session(addressA))); hooks.effects();
    hooks.render(() => useEventRead(repository, projectRoot, session(addressB))); hooks.effects(); await settle();
    finishOld(eventResult()); await settle();
    expect(hooks.render(() => useEventRead(repository, projectRoot, session(addressB))).value?.actor?.address).toBe(addressB);
  });

  it('cannot restart event reads after the original page unmounts', async () => {
    const { repository, loadEvent } = makeRepository();
    const view = hooks.render(() => useEventRead(repository, projectRoot, session(addressA)));
    hooks.effects(); await settle(); hooks.unmount();
    expect(await view.refresh()).toBeNull();
    expect(await view.refreshWithdrawal()).toBeNull();
    expect(loadEvent).toHaveBeenCalledOnce();
  });
});
