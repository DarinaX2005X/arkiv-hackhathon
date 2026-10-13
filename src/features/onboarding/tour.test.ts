import { describe, expect, it, vi } from 'vitest';
import { createAppRuntime } from '../../app/context';
import type { Route } from '../../app/routes';
import type { StoragePort } from '../../app/storage';
import type { Repository } from '../../data/types';
import type { Actor } from '../../domain/types';
import {
  createTourController, isTourProgress, resolveTourTarget, tourScope,
  tourSteps, workspaceTour, TOUR_STEP_COUNT, canShowTour, tourContext, tourRole,
} from './tour';

const actorA = { kind: 'wallet', address: `0x${'ab'.repeat(20)}` } as const;
const actorB = { kind: 'wallet', address: `0x${'cd'.repeat(20)}` } as const;
function memoryStorage() {
  const values = new Map<string, string>();
  const storage: StoragePort = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  return { storage, values };
}
const runtimeFor = (storage: StoragePort | null) => createAppRuntime({ storage, namespace: 'tour-test', now: () => 1791700000000 });

describe('contextual tour progress without rendering', () => {
  it('requires an actual public wallet session even when stored progress is active', () => {
    const route: Route = { name: 'workspace' };
    expect(canShowTour(route, 'public', actorA)).toBe(true);
    expect(canShowTour(route, 'public', null)).toBe(false);
    expect(canShowTour(route, 'public', { kind: 'local', id: 'local-actor:me' })).toBe(false);
    expect(canShowTour(route, 'practice', actorA)).toBe(false);
    expect(canShowTour({ name: 'onboarding' }, 'public', actorA)).toBe(false);
    expect(canShowTour({ name: 'home' }, 'public', actorA)).toBe(false);
    expect(canShowTour({ name: 'help' }, 'public', actorA)).toBe(true);
  });

  it('adapts to the current invitation before account preference and preserves Help context', () => {
    const root = `0x${'ef'.repeat(32)}` as const;
    const event: Route = { name: 'event', projectRoot: root };
    const invitation: Route = { name: 'contributions', projectRoot: root, returnTo: `/projects/${root}/needs` };
    expect(tourContext(event, 'workspace')).toBe(event);
    expect(tourContext(invitation, 'my-events')).toBe(invitation);
    expect(tourRole(event)).toBe('visitor');
    expect(tourRole(invitation)).toBe('contributor');
    expect(tourRole({ name: 'new-project' })).toBe('organizer');
    expect(tourRole({ name: 'requests' })).toBe('contributor');
    expect(tourContext({ name: 'help', returnTo: `/events/${root}` }, 'contributions')).toEqual(event);
    expect(tourContext({ name: 'help' }, 'my-events')).toEqual({ name: 'my-events' });
    expect(tourContext({ name: 'help', returnTo: 'https://example.org' }, 'contributions')).toEqual({ name: 'contributions' });
    expect(tourSteps(event)[0]?.title).toBe('Start with this event');
    expect(tourSteps(invitation)[1]?.body).toContain('Your invitation is still here');
  });
  it('only stores guide progress and never navigates, changes authority, touches drafts or calls the repository', () => {
    const { storage, values } = memoryStorage();
    const repositoryAccesses: PropertyKey[] = [];
    const repository = new Proxy({} as Repository, { get: (_target, property) => {
      repositoryAccesses.push(property);
      throw new Error(`The guide must not access repository.${String(property)}`);
    } });
    const runtime = createAppRuntime({ storage, repository, namespace: 'tour-test' });
    runtime.session.setMode('public');
    runtime.session.setAccount(actorA, 60138453025);
    runtime.session.navigate({ name: 'new-project' });
    runtime.session.selectDraft('my-unfinished-work');
    const sessionBefore = structuredClone(runtime.session.getSnapshot());
    const storedBefore = new Map(values);
    const sessionWrites = ['navigate', 'selectDraft', 'setMode', 'setAccount'].map(method =>
      vi.spyOn(runtime.session, method as 'navigate' | 'selectDraft' | 'setMode' | 'setAccount'));

    const tour = createTourController(runtime, tourScope(actorA));
    expect(tour.getSnapshot()).toEqual({ progress: { status: 'unseen', step: 0 }, storageIssue: null });
    expect(values).toEqual(storedBefore);
    tour.ensureStarted(); tour.next(); tour.back(); tour.skip(); tour.start(); tour.close(); tour.start(); tour.complete();

    expect(runtime.session.getSnapshot()).toEqual(sessionBefore);
    for (const write of sessionWrites) expect(write).not.toHaveBeenCalled();
    expect(repositoryAccesses).toEqual([]);
    for (const [key, value] of storedBefore) expect(values.get(key)).toBe(value);
    expect(values.size).toBe(storedBefore.size + 1);
  });

  it('keeps progress bounded to four steps, completes at the end and replays from the beginning', () => {
    const { storage } = memoryStorage();
    const tour = createTourController(runtimeFor(storage), 'device');
    tour.next(); tour.back();
    expect(tour.getSnapshot().progress).toEqual({ status: 'unseen', step: 0 });
    tour.ensureStarted(); tour.back();
    expect(tour.getSnapshot().progress).toEqual({ status: 'active', step: 0 });
    tour.next(); tour.next(); tour.ensureStarted();
    expect(tour.getSnapshot().progress).toEqual({ status: 'active', step: 2 });
    tour.back();
    expect(tour.getSnapshot().progress).toEqual({ status: 'active', step: 1 });
    for (let index = 0; index < 12; index += 1) tour.next();
    expect(TOUR_STEP_COUNT).toBe(4);
    expect(tour.getSnapshot().progress).toEqual({ status: 'completed', step: 3 });
    tour.back(); tour.ensureStarted();
    expect(tour.getSnapshot().progress).toEqual({ status: 'completed', step: 3 });
    tour.start();
    expect(tour.getSnapshot().progress).toEqual({ status: 'active', step: 0 });
  });

  it.each(['skip', 'close', 'complete'] as const)('persists %s so the tour does not reopen after returning later', action => {
    const { storage } = memoryStorage();
    const first = createTourController(runtimeFor(storage), tourScope(actorA));
    first.ensureStarted(); first.next(); first[action]();
    const expected = action === 'complete' ? { status: 'completed', step: 3 } : { status: 'skipped', step: 1 };
    const restored = createTourController(runtimeFor(storage), tourScope(actorA));
    expect(restored.getSnapshot().progress).toEqual(expected);
    restored.ensureStarted(); restored.next(); restored.back();
    expect(restored.getSnapshot().progress).toEqual(expected);
    restored.start();
    expect(restored.getSnapshot().progress).toEqual({ status: 'active', step: 0 });
  });

  it('separates device and wallet progress while normalizing wallet letter case', () => {
    const { storage } = memoryStorage();
    const first = runtimeFor(storage);
    const localActor: Actor = { kind: 'local', id: 'local-actor:me' };
    expect(tourScope(null)).toBe('device');
    expect(tourScope(localActor)).toBe('device');
    workspaceTour(first, null).skip();
    const accountA = workspaceTour(first, actorA);
    accountA.ensureStarted(); accountA.next();
    workspaceTour(first, actorB).complete();
    const upperCase = { ...actorA, address: `0x${actorA.address.slice(2).toUpperCase()}` } as Actor;
    expect(workspaceTour(first, upperCase)).toBe(accountA);
    const restored = runtimeFor(storage);
    expect(workspaceTour(restored, localActor).getSnapshot().progress.status).toBe('skipped');
    expect(workspaceTour(restored, upperCase).getSnapshot().progress).toEqual({ status: 'active', step: 1 });
    expect(workspaceTour(restored, actorB).getSnapshot().progress).toEqual({ status: 'completed', step: 3 });
    expect(restored.session.getSnapshot().actor).toBeNull();
  });

  it('notifies subscribers for changed progress and stops notifications after unsubscribe', () => {
    const tour = createTourController(runtimeFor(null), 'device');
    const changed = vi.fn();
    const stop = tour.subscribe(changed);
    const initial = tour.getSnapshot();
    expect(tour.getSnapshot()).toBe(initial);
    tour.ensureStarted();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(tour.getSnapshot()).not.toBe(initial);
    tour.ensureStarted(); tour.back();
    expect(changed).toHaveBeenCalledTimes(1);
    stop(); tour.next();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(tour.getSnapshot().progress).toEqual({ status: 'active', step: 1 });
  });

  it('rejects malformed progress and invalid scopes before creating persistent state', () => {
    for (const invalid of [
      null, [], {}, { status: 'active', step: -1 }, { status: 'active', step: 4 },
      { status: 'active', step: 1.5 }, { status: 'active', step: '1' }, { status: ['active'], step: 1 },
      { status: 'unknown', step: 1 }, { status: 'active', step: NaN }, { status: 'active', step: Infinity },
      { status: 'active', step: 0, projectRoot: 'local:sample' },
    ]) expect(isTourProgress(invalid)).toBe(false);
    const { storage, values } = memoryStorage();
    for (const scope of ['', 'wallet:0x123', 'local-actor:me', 'device:other', 'wallet:https://example.org']) {
      expect(() => createTourController(runtimeFor(storage), scope)).toThrow(TypeError);
    }
    expect(values.size).toBe(0);
  });

  it.each(['future', 'corrupt', 'out-of-range'] as const)('preserves %s progress bytes for recovery instead of silently overwriting them', kind => {
    const { storage, values } = memoryStorage();
    createTourController(runtimeFor(storage), 'device').start();
    const [key, current] = [...values.entries()][0]!;
    const raw = kind === 'future' ? current.replace('"version":1', '"version":99')
      : kind === 'out-of-range' ? current.replace('"step":0', '"step":4') : '{broken';
    storage.setItem(key, raw);
    const restored = createTourController(runtimeFor(storage), 'device');
    expect(restored.getSnapshot().storageIssue?.code).toBe(kind === 'future' ? 'unsupported_version' : kind === 'out-of-range' ? 'invalid_payload' : 'invalid_json');
    restored.ensureStarted(); restored.next(); restored.skip();
    expect(restored.getSnapshot()).toMatchObject({ progress: { status: 'skipped', step: 1 }, storageIssue: { code: 'recovery_required' } });
    expect(restored.exportRecovery()).toBe(raw);
    expect(values.get(key)).toBe(raw);
  });

  it('retains skipped progress within the same runtime when storage is missing or refuses writes', () => {
    const { storage } = memoryStorage();
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    for (const [port, code] of [[null, 'unavailable'], [storage, 'write_failed']] as const) {
      const runtime = runtimeFor(port);
      const tour = workspaceTour(runtime, actorA);
      tour.ensureStarted(); tour.next(); tour.skip();
      expect(tour.getSnapshot()).toMatchObject({ progress: { status: 'skipped', step: 1 }, storageIssue: { code } });
      expect(workspaceTour(runtime, actorA)).toBe(tour);
      workspaceTour(runtime, actorA).ensureStarted();
      expect(tour.getSnapshot().progress.status).toBe('skipped');
      expect(workspaceTour(runtime, actorB).getSnapshot().progress.status).toBe('unseen');
    }
  });

  it('offers four descriptive steps for each work context with a safe missing-target fallback', () => {
    const publicRoot = `0x${'ef'.repeat(32)}` as const;
    const routes: Route[] = [
      { name: 'workspace' }, { name: 'new-project' }, { name: 'project', projectRoot: publicRoot, tab: 'agreement' },
      { name: 'contributions' }, { name: 'contributions', projectRoot: publicRoot },
      { name: 'events' }, { name: 'event', projectRoot: publicRoot }, { name: 'my-events' },
    ];
    for (const route of routes) {
      const steps = tourSteps(route);
      expect(steps).toHaveLength(4);
      for (const step of steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.body.length).toBeGreaterThan(0);
        expect(step.targetLabel.length).toBeGreaterThan(0);
        expect(resolveTourTarget(step, [step.targetId, 'work-surface'])).toBe(step.targetId);
        expect(resolveTourTarget(step, ['work-surface'])).toBe('work-surface');
        expect(resolveTourTarget(step, ['unrelated-control'])).toBeNull();
      }
    }
    expect(tourSteps({ name: 'contributions', projectRoot: publicRoot })[1]?.body)
      .not.toBe(tourSteps({ name: 'contributions' })[1]?.body);
  });
});
