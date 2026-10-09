import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import type { EntityKey, ProjectAggregate } from '../../domain/types';
import type { RepositoryError } from '../../data/types';
import { createProjectDrafts, draftScope } from './drafts';

export function useProject(root: EntityKey) {
  const { repository } = useApp();
  const [project, setProject] = useState<ProjectAggregate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<RepositoryError | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!repository) { setError({ code: 'unsupported', reasons: [{ code: 'unsupported' }], retryable: false }); return; }
    setLoading(true);
    try {
      const result = await repository.loadProject(root);
      if (request !== sequence.current) return;
      if (result.ok) { setProject(result.value); setError(null); }
      else {
        setError(result.error);
        setProject(previous => previous === null ? null : { ...previous, snapshot: { ...previous.snapshot, freshness: 'stale', completeness: 'incomplete', reasons: [...previous.snapshot.reasons, { code: 'rpc_error' }] } });
      }
    } catch {
      if (request === sequence.current) {
        setError({ code: 'network', reasons: [{ code: 'rpc_error' }], retryable: true });
        setProject(previous => previous === null ? null : { ...previous, snapshot: { ...previous.snapshot, freshness: 'stale', completeness: 'incomplete', reasons: [...previous.snapshot.reasons, { code: 'rpc_error' }] } });
      }
    } finally { if (request === sequence.current) setLoading(false); }
  }, [repository, root]);
  useEffect(() => { setProject(null); void refresh(); const timer = setInterval(() => { void refresh(); }, 15000); return () => { clearInterval(timer); sequence.current++; }; }, [refresh]);
  return { project, loading, error, refresh };
}

export function useProjectDrafts() {
  const runtime = useApp();
  const session = useAppSession();
  const scope = draftScope(session.mode, session.actor);
  const storage = useMemo(() => createProjectDrafts(runtime, scope), [runtime, scope]);
  const [, refresh] = useState(0);
  return { storage, scope, changed: () => refresh(value => value + 1) };
}
