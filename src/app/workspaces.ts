import { LocalRepository } from '../data/local';
import { createEventRepository } from '../data/events';
import { SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, SMALL_WORKS_PROJECT_ROOT, smallWorksRecords } from '../domain/fixtures';
import type { Actor } from '../domain/types';
import type { InjectedWalletProvider } from '../data/wallet';
import type { RpcRequest } from '../data/arkiv';
import { createAppRuntime } from './context';
import { createPublicRuntime } from './network';
import { parseRoute, routePath, safeReturnPath, type Route } from './routes';
import { isPublicEntityKey } from './ids';
import { createDraftStore, type StoragePort } from './storage';

interface ReturnContext { kind: 'local' | 'public'; destination: string }
function isReturnContext(value: unknown): value is ReturnContext | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') === 'destination,kind' && (item.kind === 'local' || item.kind === 'public')
    && typeof item.destination === 'string' && safeReturnPath(item.destination) === item.destination;
}

export type WorkspaceKind = 'practice' | 'local' | 'public';
export const LOCAL_COORDINATOR: Actor = { kind: 'local', id: 'local-actor:me' };
export function workspaceForRoute(route: Route, current: WorkspaceKind): WorkspaceKind {
  if (route.name === 'demo' || (route.name === 'project' && route.projectRoot === SMALL_WORKS_PROJECT_ROOT)) return 'practice';
  if (route.name === 'project' || (route.name === 'contributions' && route.projectRoot)) return isPublicEntityKey(route.projectRoot) ? 'public' : route.projectRoot === SMALL_WORKS_PROJECT_ROOT ? 'practice' : 'local';
  if (['sign-in', 'account', 'onboarding', 'events', 'event', 'my-events'].includes(route.name)) return 'public';
  if (['home', 'new-project', 'workspace'].includes(route.name)) return 'public';
  return current === 'practice' ? 'practice' : 'public';
}

/** The sample can be reset without touching custom projects, drafts, or public records. */
export function createStudioWorkspaces({ storage, provider, request, now = Date.now }: {
  storage: StoragePort | null; provider?: InjectedWalletProvider; request?: RpcRequest; now?: () => number;
}) {
  const practiceRepository = new LocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW, logicalClock: true });
  const localRepository = new LocalRepository({ storage, namespace: 'custom', now });
  let practiceEpoch = 0;
  try { const saved = storage?.getItem('partfolk:studio:practice-epoch'); if (saved && /^\d{1,8}$/.test(saved)) practiceEpoch = Number(saved); } catch { /* Preserve data if storage cannot be read. */ }
  const newPracticeRuntime = () => createAppRuntime({ repository: practiceRepository, storage, namespace: `partfolk:studio:practice:${practiceEpoch}`, now: () => practiceRepository.currentTime() });
  let practice = newPracticeRuntime();
  const local = createAppRuntime({ repository: localRepository, storage, namespace: 'partfolk:studio:local', now });
  const publicBinding = createPublicRuntime({ storage, namespace: 'partfolk:studio:public', provider, request, now });
  const events = createEventRepository({ request: publicBinding.request, controller: publicBinding.controller, now });
  const returnStore = createDraftStore({ storage, key: 'partfolk:studio:account-return', kind: 'account-return', validate: isReturnContext, now });
  const savedReturn = returnStore.load();
  let accountReturn: ReturnContext | null = savedReturn.status === 'ready' ? savedReturn.value : null;
  practice.session.setMode('local'); practice.session.setAccount(SMALL_WORKS_COORDINATOR);
  local.session.setMode('local'); local.session.setAccount(LOCAL_COORDINATOR);
  const runtimes = { practice, local, public: publicBinding.runtime };
  const initial: WorkspaceKind = 'public';
  let state = { kind: initial as WorkspaceKind, runtime: runtimes[initial], loading: false, issue: null as string | null, generation: 0 };
  let previousRoute = state.runtime.session.currentRoute();
  let requestVersion = 0;
  let seeded = false;
  const listeners = new Set<() => void>();
  const update = (next: Partial<typeof state>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
  const preparePractice = async () => {
    if (seeded) return;
    const existing = await practiceRepository.loadProject(SMALL_WORKS_PROJECT_ROOT);
    if (!existing.ok) {
      if (existing.error.code !== 'not_found') throw new Error('The saved practice could not be read. Export its recovery data before resetting it.');
      const seededResult = practiceRepository.seed(smallWorksRecords());
      if (!seededResult.ok) throw new Error('The practice could not be saved. Your existing records were kept.');
    }
    seeded = true;
  };
  const select = async (kind: WorkspaceKind, route?: Route) => {
    const version = ++requestVersion;
    update({ loading: true, issue: null });
    try {
      if (kind === 'practice') await preparePractice();
      if (version !== requestVersion) return;
      let issue: string | null = null;
      try { storage?.setItem('partfolk:studio:workspace', kind); } catch { issue = 'Your workspace choice is kept in memory only. Export important work before leaving.'; }
      if (route) runtimes[kind].session.navigate(route);
      if (route) previousRoute = route;
      update({ kind, runtime: runtimes[kind], loading: false, issue });
    } catch (error) {
      if (version === requestVersion) update({ kind, runtime: runtimes[kind], loading: false,
        issue: error instanceof Error ? error.message : 'This workspace could not be opened.' });
    }
  };
  return {
    runtimes, publicBinding, events, storage, practiceRepository, localRepository,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select,
    async followRoute(route: Route) {
      const accountDetour = ['sign-in', 'account', 'onboarding', 'help'].includes(route.name);
      if (accountDetour && 'returnTo' in route && route.returnTo && state.kind !== 'practice'
        && !['sign-in', 'account', 'onboarding', 'help'].includes(previousRoute.name)) {
        // Remember the source namespace as well as the URL: a local new draft
        // and a public new draft deliberately have the same editor route.
        accountReturn = { kind: state.kind, destination: route.returnTo };
        returnStore.save(accountReturn);
      }
      let kind = workspaceForRoute(route, state.kind);
      // Old local return hints remain recoverable, but never turn normal routes into local work.
      if (!accountDetour && accountReturn) { accountReturn = null; returnStore.save(null); }
      if (kind !== state.kind || (kind === 'practice' && !seeded)) await select(kind, route);
      else { state.runtime.session.navigate(route); previousRoute = route; }
    },
    async resetPractice() {
      const nextEpoch = practiceEpoch + 1;
      // Save the new draft/action boundary before replacing the authorized sample records.
      // Previous drafts are retained, but cannot replay against newly seeded sample keys.
      if (storage) storage.setItem('partfolk:studio:practice-epoch', String(nextEpoch));
      const result = practiceRepository.resetPractice();
      if (!result.ok) throw new Error('The practice could not be reset. Existing data was kept.');
      seeded = false;
      await preparePractice();
      practiceEpoch = nextEpoch;
      const destination = practice.session.currentRoute();
      practice = newPracticeRuntime();
      practice.session.setMode('local');
      practice.session.setAccount(SMALL_WORKS_COORDINATOR);
      practice.session.navigate(destination);
      runtimes.practice = practice;
      update({ generation: state.generation + 1, ...(state.kind === 'practice' ? { runtime: practice } : {}) });
    },
    setLocalActor(actor: Actor) {
      if (state.kind !== 'practice' || actor.kind !== 'local') throw new TypeError('Sample roles are only available in practice.');
      state.runtime.session.setAccount(actor);
    },
    initialRoute: (): Route => ({ name: 'home' }),
    dispose: () => { requestVersion++; publicBinding.dispose(); listeners.clear(); },
  };
}
export type StudioWorkspaces = ReturnType<typeof createStudioWorkspaces>;
