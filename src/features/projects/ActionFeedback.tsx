import { Button, Notice } from '../../ui';
import type { RepositoryError } from '../../data/types';
import { repositoryErrorText } from './catalog';

export function ActionFeedback({ state, onReconcile, onResume }: {
  state: { status: string; error?: RepositoryError | null; message?: string | null };
  onReconcile: () => void; onResume?: () => void;
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'submitting') return <Notice role="status" title="Waiting for a confirmed result">Keep this page or return later to check the same operation. A transaction hash alone is not confirmation.</Notice>;
  if (state.status === 'needs-verification') return <Notice tone="warning" title="This operation needs verification">
    <p>{state.error ? repositoryErrorText(state.error) : 'The result is not confirmed. A second operation will not be sent until this one is checked.'}</p>
    <div className="pf-actions"><Button variant="secondary" onClick={onReconcile}>Check the original operation</Button>{onResume && <Button variant="secondary" onClick={onResume}>Resume the known incomplete step</Button>}</div>
  </Notice>;
  if (state.status === 'confirmed') return <Notice tone="success" title="Confirmed">The repository confirmed this operation. The project is being refreshed from its current records.</Notice>;
  return <Notice tone="warning" title={state.status === 'rejected' ? 'Request cancelled' : 'The change was not confirmed'}>{state.error ? repositoryErrorText(state.error) : state.message ?? 'Your input has been retained.'}</Notice>;
}
