import { Button, Notice } from '../../ui';
import type { RepositoryError } from '../../data/types';
import { repositoryErrorText } from './catalog';
import type { useRepositoryAction } from '../../app/actions';
import { ActionRecovery } from '../../app/ActionRecovery';
import type { ReactNode } from 'react';

export function ActionFeedback({ state, onReconcile, onResume, action }: {
  state: { status: string; error?: RepositoryError | null; message?: string | null };
  onReconcile: () => void; onResume?: () => void;
  action?: Pick<ReturnType<typeof useRepositoryAction>, 'recoveryText' | 'restoreRecovery'>;
}) {
  if (state.status === 'idle' && (!action || action.recoveryText === null)) return null;
  let feedback: ReactNode = null;
  if (state.status === 'submitting') feedback = <Notice role="status" title="Saving your change">Keep this page open or return later. The original request will be checked before another is sent.</Notice>;
  else if (state.status === 'needs-verification') feedback = <Notice tone="warning" title="Check whether this was saved">
    <p>{state.error ? repositoryErrorText(state.error) : 'The result is not confirmed. A second operation will not be sent until this one is checked.'}</p>
    <div className="pf-actions"><Button variant="secondary" onClick={onReconcile}>Check this request</Button>{onResume && <Button variant="secondary" onClick={onResume}>Continue saving</Button>}</div>
  </Notice>;
  else if (state.status === 'confirmed') feedback = <Notice tone="success" title="Saved">The project is being updated with your saved change.</Notice>;
  else if (state.status !== 'idle') feedback = <Notice tone="warning" title={state.status === 'rejected' ? 'Request cancelled' : 'The change was not confirmed'}>{state.error ? repositoryErrorText(state.error) : state.message ?? 'Your input has been retained.'}</Notice>;
  return <div className="pf-stack">{feedback}{action && <ActionRecovery action={action} />}</div>;
}
