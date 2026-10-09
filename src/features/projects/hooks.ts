import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp, useAppSession } from '../../app/context';
import type { EntityKey } from '../../domain/types';
import { createProjectDrafts, draftScope } from './drafts';
import { createProjectReader } from './projectReader';

export function useProject(root: EntityKey) {
  const runtime = useApp(), session = useAppSession();
  const reader = useMemo(() => createProjectReader(signal => runtime.repository
    ? runtime.repository.loadProject(root, { signal })
    : Promise.resolve({ ok: false, error: { code: 'unsupported', reasons: [{ code: 'unsupported' }], retryable: false } }), runtime.now), [runtime, root]);
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => {
    reader.start(session.mode === 'public', typeof window === 'undefined' ? undefined : window);
    return reader.stop;
  }, [reader, session.mode]);
  return { ...state, refresh: reader.refresh };
}

export function useProjectDrafts() {
  const runtime = useApp();
  const session = useAppSession();
  const scope = draftScope(session.mode, session.actor);
  const storage = useMemo(() => createProjectDrafts(runtime, scope), [runtime, scope]);
  const [, refresh] = useState(0);
  return { storage, scope, changed: () => refresh(value => value + 1) };
}
