import { LocalRepository } from '../data/local';
import { SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, SMALL_WORKS_PROJECT_ROOT, smallWorksRecords } from '../domain/fixtures';
import type { Actor } from '../domain/types';
import type { InjectedWalletProvider } from '../data/wallet';
import type { RpcRequest } from '../data/arkiv';
import { createAppRuntime } from './context';
import { createPublicRuntime } from './network';
import { parseRoute, type Route } from './routes';
import { isPublicEntityKey } from './ids';
import type { StoragePort } from './storage';

export type WorkspaceKind = 'practice' | 'local' | 'public';
export const LOCAL_COORDINATOR: Actor = { kind: 'local', id: 'local-actor:me' };
export function workspaceForRoute(route: Route, current: WorkspaceKind): WorkspaceKind {
  if (route.name === 'demo' || (route.name === 'project' && route.projectRoot === SMALL_WORKS_PROJECT_ROOT)) return 'practice';
  if (route.name === 'project') return isPublicEntityKey(route.projectRoot) ? 'public' : 'local';
  if (route.name === 'new-project' && current === 'practice') return 'local';
  return current;
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
  practice.session.setMode('local'); practice.session.setAccount(SMALL_WORKS_COORDINATOR);
  local.session.setMode('local'); local.session.setAccount(LOCAL_COORDINATOR);
  const runtimes = { practice, local, public: publicBinding.runtime };
  let initial: WorkspaceKind = 'local';
  try { const saved = storage?.getItem('partfolk:studio:workspace'); if (saved === 'practice' || saved === 'local' || saved === 'public') initial = saved; } catch { /* Session exposes storage availability. */ }
  let state = { kind: initial, runtime: runtimes[initial], loading: false, issue: null as string | null, generation: 0 };
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
      update({ kind, runtime: runtimes[kind], loading: false, issue });
    } catch (error) {
      if (version === requestVersion) update({ kind, runtime: runtimes[kind], loading: false,
        issue: error instanceof Error ? error.message : 'This workspace could not be opened.' });
    }
  };
  return {
    runtimes, publicBinding, practiceRepository, localRepository,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select,
    async followRoute(route: Route) {
      const kind = workspaceForRoute(route, state.kind);
      if (kind !== state.kind || (kind === 'practice' && !seeded)) await select(kind, route);
      else state.runtime.session.navigate(route);
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
      if (state.kind === 'public' || actor.kind !== 'local') throw new TypeError('Choose a local role only in a local workspace.');
      state.runtime.session.setAccount(actor);
    },
    initialRoute: () => parseRoute(runtimes[initial].session.getSnapshot().destination),
    dispose: () => { requestVersion++; publicBinding.dispose(); listeners.clear(); },
  };
}
export type StudioWorkspaces = ReturnType<typeof createStudioWorkspaces>;
