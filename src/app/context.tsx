import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Repository } from '../data/types';
import { createCopyRegistry } from '../i18n';
import { shellCopy } from '../i18n/shell';
import { createSessionStore } from './session';
import { createDraftStore, type StoragePort, type Validator } from './storage';

export interface RuntimeOptions { repository?: Repository | null; storage?: StoragePort | null; namespace?: string; now?: () => number }
/** Studio and Desk each create their own runtime. No router, storage or repository singleton. */
export function createAppRuntime({ repository = null, storage = null, namespace = 'partfolk:studio', now = Date.now }: RuntimeOptions = {}) {
  return {
    repository, now, session: createSessionStore({ storage, namespace }),
    copy: createCopyRegistry({ shell: shellCopy }),
    drafts: <T,>(id: string, kind: string, validate: Validator<T>) => {
      if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) throw new TypeError('Invalid draft identity.');
      return createDraftStore({ storage, key: `${namespace}:draft:${id}`, kind, validate, now });
    },
  };
}
export type AppRuntime = ReturnType<typeof createAppRuntime>;
const AppContext = createContext<AppRuntime | null>(null);
export function AppProvider({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) {
  return <AppContext.Provider value={runtime}>{children}</AppContext.Provider>;
}
export function useApp(): AppRuntime {
  const runtime = useContext(AppContext);
  if (!runtime) throw new Error('AppProvider is required.');
  return runtime;
}
export function useAppSession() {
  const { session } = useApp();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
