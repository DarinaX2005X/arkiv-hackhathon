import type { AppRuntime } from '../../app/context';
import type { Route } from '../../app/routes';
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

export interface TourStep { title: string; body: string; targetId: string; targetLabel: string }
const sharedSteps: readonly TourStep[] = [
  { title: 'Your own work, in one place', body: 'My projects reads the projects owned by your connected wallet. Drafts on this device are listed separately and can be continued or exported.', targetId: 'work-surface', targetLabel: 'Show my work' },
  { title: 'Offer your part', body: 'My contributions holds your time, place and equipment offers. Each owner publishes their own availability. A project cannot promise someone else’s help.', targetId: 'nav-contributions', targetLabel: 'Show My contributions' },
  { title: 'Review the exact plan', body: 'Requests brings you to plans using your offers. Read the whole plan and confirm only your own part. A changed plan needs fresh agreement from everyone involved.', targetId: 'nav-requests', targetLabel: 'Show Requests' },
  { title: 'Come back with the same wallet', body: 'Your public work is read from Arkiv. Browser drafts and pending operations remain here after sign-out. Account has your settings; Help explains recovery and can replay this guide.', targetId: 'account-commands', targetLabel: 'Show Account' },
];
export function tourSteps(route: Route): readonly TourStep[] {
  if (route.name === 'new-project') return [
    { title: 'Begin with your event', body: 'Describe the outcome, possible dates and what you need. Your entries remain a browser draft until you explicitly publish. An empty plan will show what help is missing.', targetId: 'work-surface', targetLabel: 'Show the project draft' },
    { title: 'Invite the people who can help', body: 'After publishing, share the project invitation. Contributors offer their own time, place or equipment. They keep control of their availability and decisions.', targetId: 'work-surface', targetLabel: 'Show the project draft' },
    sharedSteps[2]!, sharedSteps[3]!,
  ];
  if (route.name === 'project') return [
    { title: 'Start with the current plan', body: 'Plan contains the needs and workable options. A possible arrangement is not an agreement. Public project details stay readable even without a connected wallet.', targetId: 'work-surface', targetLabel: 'Show this project' },
    { title: 'Everyone decides for themselves', body: 'People shows the contributors and their decisions. Only the owner can confirm an offer for the exact proposed version.', targetId: 'work-surface', targetLabel: 'Show this project' },
    { title: 'Handle a change openly', body: 'A withdrawal or changed condition can make the plan incomplete. Find a replacement, review the differences and collect fresh agreement before relying on it.', targetId: 'work-surface', targetLabel: 'Show this project' },
    { title: 'Carry the event through', body: 'Run sheet follows the work, handovers and returns. Report your own actions and leave unconfirmed items visible. History keeps earlier versions separate from the current plan.', targetId: 'work-surface', targetLabel: 'Show this project' },
  ];
  if (route.name === 'contributions') return [
    { title: 'Offer help on your terms', body: 'Describe your own time, place or equipment, including when it is available. Preview the public details before publishing. An offer does not agree to a project by itself.', targetId: 'work-surface', targetLabel: 'Show my contributions' },
    { title: 'Share with the right project', body: route.projectRoot ? 'This page retains the project from your invitation. Share your offer with that project so its organizer can include it in a plan.' : 'Share an offer with a project you want to help. The organizer can include it in a plan; only you can agree to its use.', targetId: 'work-surface', targetLabel: 'Show my contributions' },
    sharedSteps[2]!, sharedSteps[3]!,
  ];
  if (['events', 'event', 'my-events'].includes(route.name)) return [
    { title: 'Choose an event to join', body: 'Read the event date, place and participation terms before deciding. Attending is separate from offering equipment or helping organize the event.', targetId: 'work-surface', targetLabel: 'Show the event page' },
    { title: 'Confirm only after reviewing', body: 'Joining records your wallet’s participation publicly on Arkiv. Signing in alone does not register you. You review the exact terms before signing your decision.', targetId: 'work-surface', targetLabel: 'Show the event page' },
    { title: 'Notice changes before going', body: 'My events restores your registrations with the same wallet. A new time, place or participation rule needs your confirmation again. Preparation problems are shown separately.', targetId: 'nav-my-events', targetLabel: 'Show My events' },
    sharedSteps[3]!,
  ];
  return sharedSteps;
}
export function resolveTourTarget(step: TourStep, availableIds: readonly string[]): string | null {
  if (availableIds.includes(step.targetId)) return step.targetId;
  return availableIds.includes('work-surface') ? 'work-surface' : null;
}
