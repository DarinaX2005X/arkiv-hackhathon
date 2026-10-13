import { Button, Notice } from '../../ui';
import { useRepositoryAction } from '../../app/actions';
import { ActionRecovery } from '../../app/ActionRecovery';
import type { CommandBase, OperationIntent, PublishProjectLinkCommand, RegisterPublisherCommand, RenewEntityCommand, ReplaceBookCommand, Repository, Result } from '../../data/types';
import { contributionErrors } from './catalog';
/** Resume dispatch is bounded to commands this feature creates; the original frozen intent is reused. */
export function submitSavedContribution(repository: Repository, command: CommandBase): Promise<Result<{ operation: OperationIntent }>> {
  switch (command.operation.kind) {
    case 'register_publisher': return repository.registerPublisher(command as RegisterPublisherCommand);
    case 'replace_book': return repository.replaceBook(command as ReplaceBookCommand);
    case 'publish_project_link': return repository.publishProjectLink(command as PublishProjectLinkCommand);
    case 'renew_entity': return repository.renewEntity(command as RenewEntityCommand);
    default: return Promise.resolve({ ok: false, error: { code: 'unsupported', reasons: [], retryable: false } });
  }
}
export function ActionFeedback({ action, onRefresh }: { action: ReturnType<typeof useRepositoryAction>; onRefresh?: (operation?: OperationIntent) => void | Promise<void> }) {
  const state = action.state;
  if (state.status === 'idle') return null;
  return <Notice role="status" tone={state.status === 'confirmed' ? 'success' : state.status === 'rejected' || state.status === 'needs-verification' ? 'warning' : 'neutral'} title={state.status === 'confirmed' ? 'Your change is confirmed' : state.status === 'submitting' ? 'Saving your change' : state.status === 'needs-verification' ? 'Check whether your change was saved' : state.status === 'rejected' ? 'The request was not approved' : 'Your change was not completed'}>
    <p>{state.message}</p>
    <ActionRecovery action={action} />
    {state.status === 'needs-verification' && <div className="pf-actions">
      <Button variant="secondary" onClick={async () => { const result = await action.reconcile(); await onRefresh?.(result.ok ? result.value.operation : undefined); }}>Check the original request</Button>
      {action.recoverableCommand && <Button variant="secondary" onClick={async () => { const checked = await action.reconcile(); const resumed = await action.resume(submitSavedContribution); await onRefresh?.(resumed.ok ? resumed.value.operation : checked.ok ? checked.value.operation : undefined); }}>Continue saved request</Button>}
    </div>}
    {state.error && <p>{contributionErrors[state.error.code]}</p>}
    {state.error?.diagnostic && <details><summary>Advanced</summary><p>{state.error.diagnostic}</p></details>}
  </Notice>;
}
