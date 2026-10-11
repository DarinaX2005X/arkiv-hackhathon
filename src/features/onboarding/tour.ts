import type { AppRuntime } from '../../app/context';
import { parseRoute, safeReturnPath, type Route } from '../../app/routes';
import type { StorageIssue } from '../../app/storage';
import type { Actor } from '../../domain/types';
import { isAccountAddress } from '../../app/ids';

export interface TourProgress { status: 'unseen' | 'active' | 'skipped' | 'completed'; step: number }
export interface TourSnapshot { progress: TourProgress; storageIssue: StorageIssue | null }
export const TOUR_STEP_COUNT = 4;
export function isTourProgress(value: unknown): value is TourProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).sort().join(',') === 'status,step' && typeof entry.status === 'string'
    && ['unseen', 'active', 'skipped', 'completed'].includes(entry.status)
    && typeof entry.step === 'number' && Number.isInteger(entry.step) && entry.step >= 0 && entry.step < TOUR_STEP_COUNT;
}
export function tourScope(actor: Actor | null): string {
  return actor?.kind === 'wallet' ? `wallet:${actor.address.toLowerCase()}` : 'device';
}
/** Stores guide progress only. It does not read or mutate projects or wallet authority. */
export function createTourController(runtime: AppRuntime, scope: string) {
  if (scope !== 'device' && (!scope.startsWith('wallet:') || !isAccountAddress(scope.slice(7)))) throw new TypeError('Invalid tour scope.');
  const store = runtime.drafts(`workspace-tour:${scope.toLowerCase()}`, 'workspace-tour', isTourProgress);
  const loaded = store.load();
  let snapshot: TourSnapshot = {
    progress: loaded.status === 'ready' ? loaded.value : { status: 'unseen', step: 0 },
    storageIssue: loaded.status === 'recovery' || loaded.status === 'unavailable' ? loaded.issue : null,
  };
  const listeners = new Set<() => void>();
  const update = (progress: TourProgress) => {
    const result = store.save(progress);
    snapshot = { progress, storageIssue: result.issue };
    listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureStarted: () => { if (snapshot.progress.status === 'unseen') update({ status: 'active', step: 0 }); },
    start: () => update({ status: 'active', step: 0 }),
    next: () => {
      if (snapshot.progress.status !== 'active') return;
      if (snapshot.progress.step === TOUR_STEP_COUNT - 1) update({ ...snapshot.progress, status: 'completed' });
      else update({ status: 'active', step: snapshot.progress.step + 1 });
    },
    back: () => { if (snapshot.progress.status === 'active' && snapshot.progress.step > 0) update({ status: 'active', step: snapshot.progress.step - 1 }); },
    skip: () => update({ ...snapshot.progress, status: 'skipped' }),
    close: () => update({ ...snapshot.progress, status: 'skipped' }),
    complete: () => update({ status: 'completed', step: TOUR_STEP_COUNT - 1 }),
    exportRecovery: store.exportRecovery,
  };
}
export type TourController = ReturnType<typeof createTourController>;
const controllers = new WeakMap<AppRuntime, Map<string, TourController>>();
export function workspaceTour(runtime: AppRuntime, actor: Actor | null = runtime.session.getSnapshot().actor) {
  let scopes = controllers.get(runtime);
  if (!scopes) { scopes = new Map(); controllers.set(runtime, scopes); }
  const scope = tourScope(actor);
  let controller = scopes.get(scope);
  if (!controller) { controller = createTourController(runtime, scope); scopes.set(scope, controller); }
  return controller;
}

export type TourArt = 'event' | 'resources' | 'agreement' | 'return';
export type TourRole = 'organizer' | 'contributor' | 'visitor';
export interface TourStep { title: string; body: string; targetId: string; targetLabel: string; art: TourArt }

/** An invitation takes precedence over a preferred starting area. Reading context never navigates. */
export function tourContext(route: Route, preferred: 'workspace' | 'contributions' | 'my-events' = 'workspace'): Route {
  if (route.name === 'help') return parseRoute(safeReturnPath(route.returnTo) ?? `/${preferred}`);
  return route;
}
export function tourRole(route: Route): TourRole {
  if (['events', 'event', 'my-events'].includes(route.name)) return 'visitor';
  if (['contributions', 'requests'].includes(route.name) || (route.name === 'project' && route.tab === 'agreement')) return 'contributor';
  return 'organizer';
}
export function canShowTour(route: Route, mode: string, actor: Actor | null): boolean {
  return mode === 'public' && actor?.kind === 'wallet'
    && ['workspace', 'new-project', 'contributions', 'requests', 'project', 'events', 'event', 'my-events', 'help'].includes(route.name);
}
const agreement: TourStep = {
  title: 'Every owner has a say',
  body: 'Each person agrees to the exact plan using their own wallet. Arkiv holds their separate decisions. If the plan changes, everyone involved reviews it again.',
  targetId: 'nav-requests', targetLabel: 'Open Requests', art: 'agreement',
};
const returnStep: TourStep = {
  title: 'Your work is here when you return',
  body: 'Sign in with the same wallet to find your published work on Arkiv. Unpublished drafts stay on this device. You can replay this welcome tour from Help anytime.',
  targetId: 'account-commands', targetLabel: 'Open Account', art: 'return',
};
export function tourSteps(route: Route): readonly TourStep[] {
  const role = tourRole(route);
  if (role === 'visitor') return [
    { title: route.name === 'event' ? 'Start with this event' : 'Find your next event',
      body: 'Discover events online, in person or a mix of both. Open an event to check its time, location and participation rules before you join.',
      targetId: 'work-surface', targetLabel: route.name === 'event' ? 'Review this event' : 'Browse events', art: 'event' },
    { title: 'Choose how you take part',
      body: 'Check whether registration is open, a place is available or a waiting list applies. An invitation may be needed. Signing in alone does not register you.',
      targetId: 'work-surface', targetLabel: 'Review participation', art: 'resources' },
    { title: 'Review before you register',
      body: 'Open events with unlimited places let you join directly. Limited or invitation-only events need organizer confirmation of your request. Check your place or waiting-list status in My events. Your decision is public on Arkiv.',
      targetId: 'nav-my-events', targetLabel: 'Open My events', art: 'agreement' },
    returnStep,
  ];
  if (role === 'contributor') return [
    { title: route.name === 'requests' || route.name === 'project' ? 'Review the invitation' : 'Bring what you can offer',
      body: route.name === 'requests' || route.name === 'project'
        ? 'Read the proposed work and your part in it. Check the dates, responsibilities and return arrangements before deciding.'
        : 'Open My contributions to offer your time, a place or equipment. Set your availability and conditions. Each resource stays under its owner’s control.',
      targetId: 'work-surface', targetLabel: 'Review my part', art: 'resources' },
    { title: 'Share an offer on your terms',
      body: route.name === 'contributions' && route.projectRoot
        ? 'Your invitation is still here. Share your offer with this project when you are ready. Publishing an offer does not agree to its use.'
        : 'Publish your offer on Arkiv and share it with a project you want to help. Publishing an offer does not agree to its use.',
      targetId: 'nav-contributions', targetLabel: 'Open My contributions', art: 'event' },
    agreement, returnStep,
  ];
  return [
    { title: route.name === 'project' ? 'Bring this event together' : 'Make an event happen',
      body: route.name === 'project'
        ? 'Start with the needs in this project. Bring people, places and equipment together for an online, in-person or hybrid event.'
        : 'Start a project for an online, in-person or hybrid event. Add what you want to make happen, possible dates and the help you need.',
      targetId: 'work-surface', targetLabel: route.name === 'project' ? 'Review this project' : 'Start my project', art: 'event' },
    { title: 'Invite people to bring their part',
      body: 'Publish your project when you are ready to invite help. People offer their own time, places and equipment. A draft stays on this device until you publish it.',
      targetId: 'work-surface', targetLabel: 'Review my project', art: 'resources' },
    agreement, returnStep,
  ];
}
export function resolveTourTarget(step: TourStep, availableIds: readonly string[]): string | null {
  if (availableIds.includes(step.targetId)) return step.targetId;
  return availableIds.includes('work-surface') ? 'work-surface' : null;
}
