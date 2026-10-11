import type { AppRuntime } from '../../app/context';
import { parseRoute, routePath } from '../../app/routes';
import type { StorageIssue } from '../../app/storage';
import type { EntityKey, PlanDocument } from '../../domain/types';
import { hashCanonical } from '../../domain/canonical';
import { validatePlanDocument } from '../../domain/validation';
import { draftScope } from './drafts';

export interface PlanReviewDraft { fingerprint: string; plan: PlanDocument; explanation: string }
type StoredReviewDraft = Omit<PlanReviewDraft, 'explanation'> & { explanation?: string };
export interface PlanReviewSnapshot { draft: PlanReviewDraft | null; persisted: boolean; issue: StorageIssue | null }

function isStoredReviewDraft(value: unknown): value is StoredReviewDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>, keys = Object.keys(item).sort().join(',');
  // Existing reviews predate the explanatory note. Reading them must not require recovery or replace them.
  return (keys === 'fingerprint,plan' || keys === 'explanation,fingerprint,plan')
    && typeof item.fingerprint === 'string' && (item.explanation === undefined || typeof item.explanation === 'string')
    && validatePlanDocument(item.plan).valid;
}

function makePlanReviewStore(runtime: AppRuntime, projectRoot: EntityKey, scope: string) {
  const key = `plan-review:${hashCanonical({ projectRoot, scope }).slice(2)}`;
  const store = runtime.drafts(key, 'plan-review', isStoredReviewDraft);
  const loaded = store.load();
  let state: PlanReviewSnapshot = {
    draft: loaded.status === 'ready' ? { ...loaded.value, explanation: loaded.value.explanation ?? '' } : null,
    persisted: loaded.status === 'ready' || loaded.status === 'missing',
    issue: loaded.status === 'recovery' || loaded.status === 'unavailable' ? loaded.issue : null,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save(draft: PlanReviewDraft) {
      const current = runtime.session.getSnapshot();
      if (draftScope(current.mode, current.actor) !== scope || draft.plan.projectRoot !== projectRoot) {
        throw new TypeError('Return to the account and project that own this review before editing it.');
      }
      const result = store.save(draft);
      state = { draft: structuredClone(draft), persisted: result.persisted, issue: result.issue };
      listeners.forEach(listener => listener());
      return state;
    },
    exportRecovery: store.exportRecovery,
  };
}

const reviews = new WeakMap<AppRuntime, Map<string, ReturnType<typeof makePlanReviewStore>>>();
/** One review per project and account survives route changes, including unavailable browser storage. */
export function createPlanReviewStore(runtime: AppRuntime, projectRoot: EntityKey, scope: string) {
  let stores = reviews.get(runtime);
  if (!stores) { stores = new Map(); reviews.set(runtime, stores); }
  const key = `${projectRoot}:${scope}`;
  let store = stores.get(key);
  if (!store) { store = makePlanReviewStore(runtime, projectRoot, scope); stores.set(key, store); }
  return store;
}

/** A journal may finish in the background, but its old page must not move the person's current work. */
export function captureProjectContinuation(runtime: AppRuntime, isMounted: () => boolean, visibleDestination: () => string) {
  const origin = runtime.session.getSnapshot();
  const scope = draftScope(origin.mode, origin.actor);
  return () => {
    const current = runtime.session.getSnapshot();
    return isMounted() && origin.actor !== null && current.actor !== null
      && draftScope(current.mode, current.actor) === scope && current.chainId === origin.chainId
      && current.destination === origin.destination
      && routePath(parseRoute(visibleDestination())) === origin.destination;
  };
}

/** Check twice: a refresh can itself finish after the user has left or changed accounts. */
export async function continueProjectPublication(canContinue: () => boolean, refresh: () => Promise<void>, navigate: () => void) {
  if (!canContinue()) return;
  await refresh();
  if (canContinue()) navigate();
}
