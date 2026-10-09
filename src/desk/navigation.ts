import { createDraftStore, type StoragePort } from '../app/storage';
import { deskPath, isSavedDeskRoute, parseDeskRoute, type DeskRoute } from './routes';

/** The Desk owns its destination. Wallet connection never replaces an invitation. */
export function createDeskNavigation(storage: StoragePort | null, initialHash: string) {
  const persisted = createDraftStore({ storage, key: 'partfolk:partner-desk:destination', kind: 'partner-desk-destination', validate: isSavedDeskRoute });
  const saved = persisted.load();
  let route = parseDeskRoute(initialHash || (saved.status === 'ready' ? saved.value : '/contributions'));
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => route,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readHash(hash: string) {
      const next = parseDeskRoute(hash);
      if (deskPath(next) === deskPath(route)) return;
      route = next;
      if (next.name !== 'not-found') persisted.save(deskPath(next));
      listeners.forEach(listener => listener());
    },
    remember() { if (route.name !== 'not-found') persisted.save(deskPath(route)); },
  };
}
export type DeskNavigation = ReturnType<typeof createDeskNavigation>;
