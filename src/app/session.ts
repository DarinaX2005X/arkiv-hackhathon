import type { Actor, DataMode } from '../domain/types';
import { createDraftStore, type StorageIssue, type StoragePort } from './storage';
import { isAccountAddress, isLocalActorId } from './ids';
import { parseRoute, routePath, type Route } from './routes';

export interface SavedSession { mode: DataMode; destination: string; activeDraftId: string | null }
export interface AppSession extends SavedSession {
  /** Live authority is never restored from browser storage. */
  actor: Actor | null; chainId: number | null; storageIssue: StorageIssue | null;
}
function isSavedSession(value: unknown): value is SavedSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'activeDraftId,destination,mode'
    && (record.mode === 'local' || record.mode === 'public')
    && typeof record.destination === 'string' && record.destination.length <= 2048 && record.destination.startsWith('/')
    && (record.activeDraftId === null || (typeof record.activeDraftId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(record.activeDraftId)));
}
export function createSessionStore({ storage = null, namespace = 'partfolk:studio' }: { storage?: StoragePort | null; namespace?: string } = {}) {
  const persistence = createDraftStore({ storage, key: `${namespace}:session`, kind: 'app-session', validate: isSavedSession });
  const loaded = persistence.load();
  const saved: SavedSession = loaded.status === 'ready' ? loaded.value : { mode: 'local', destination: '/', activeDraftId: null };
  let state: AppSession = { ...saved, actor: null, chainId: null, storageIssue: loaded.status === 'recovery' || loaded.status === 'unavailable' ? loaded.issue : null };
  const listeners = new Set<() => void>();
  const update = (next: AppSession, persist = true) => {
    if (persist) {
      const result = persistence.save({ mode: next.mode, destination: next.destination, activeDraftId: next.activeDraftId });
      next = { ...next, storageIssue: result.issue };
    }
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: (): AppSession => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    navigate: (route: Route) => update({ ...state, destination: routePath(route) }),
    currentRoute: (): Route => parseRoute(state.destination),
    selectDraft: (activeDraftId: string | null) => {
      if (!isSavedSession({ mode: state.mode, destination: state.destination, activeDraftId })) throw new TypeError('Invalid draft identity.');
      update({ ...state, activeDraftId });
    },
    setMode: (mode: DataMode) => update({ ...state, mode, actor: null, chainId: null }),
    setAccount: (actor: Actor | null, chainId: number | null = null) => {
      if (actor?.kind === 'wallet' && (state.mode !== 'public' || !isAccountAddress(actor.address))) throw new TypeError('Wallet authority requires public mode and a valid address.');
      if (actor?.kind === 'local' && (state.mode !== 'local' || !isLocalActorId(actor.id))) throw new TypeError('Sample authority requires local mode and a tagged actor.');
      if (chainId !== null && (!Number.isSafeInteger(chainId) || chainId < 1)) throw new TypeError('Invalid chain ID.');
      update({ ...state, actor, chainId: actor?.kind === 'wallet' ? chainId : null }, false);
    },
    exportRecovery: persistence.exportRecovery,
    exportSession: () => persistence.export({ mode: state.mode, destination: state.destination, activeDraftId: state.activeDraftId }),
  };
}
export type SessionStore = ReturnType<typeof createSessionStore>;
