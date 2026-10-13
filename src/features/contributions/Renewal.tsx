import { useEffect, useState } from 'react';
import { useApp, useAppSession } from '../../app';
import { useRepositoryAction } from '../../app/actions';
import { createOperationIntent } from '../../data/operations';
import type { RenewEntityCommand, WriteAuthority } from '../../data/types';
import { sameActor, validateCurrentEntity } from '../../domain/readiness';
import type { EntityKey, PublisherAggregate } from '../../domain/types';
import { Button, Dialog, Notice, Select } from '../../ui';
import { actorScope, ownsPublisher, writeAuthority } from './model';
import { ActionFeedback } from './OperationFeedback';

export function prepareRenewalCommand(publisher: PublisherAggregate, authority: WriteAuthority, target: 'root' | 'book',
  reviewedKey: EntityKey, extendBySeconds: number, now: number, id: string): RenewEntityCommand {
  if (!ownsPublisher(publisher, authority.actor)) throw new Error('Only the owner can keep this contribution available.');
  if (publisher.snapshot.completeness !== 'complete' || publisher.snapshot.freshness !== 'fresh') throw new Error('Refresh your contribution before extending it.');
  const record = target === 'root' ? publisher.root : publisher.book.status === 'unique' ? publisher.book.entity : null;
  if (!record || record.key !== reviewedKey) throw new Error('Your saved offers changed. Refresh and review the current version.');
  if (!validateCurrentEntity(publisher.root, publisher.snapshot, authority.actor).valid || !validateCurrentEntity(record, publisher.snapshot, authority.actor).valid) throw new Error('This record is no longer available to extend. Refresh to see the recovery options.');
  if (!Number.isSafeInteger(extendBySeconds) || extendBySeconds <= 0 || extendBySeconds > 365 * 86400) throw new Error('Choose an extension of up to one year.');
  const input = { entityKey: record.key, extendBySeconds, lifetimeSeconds: extendBySeconds };
  return { ...input, operation: createOperationIntent('renew_entity', authority, input, { id, now }) };
}

export function KeepContributionAvailable({ publisher, onRefresh }: { publisher: PublisherAggregate; onRefresh?: () => void | Promise<void> }) {
  const runtime = useApp(); const session = useAppSession(); const action = useRepositoryAction(`renew-contribution:${publisher.root.key}`);
  const [target, setTarget] = useState<'root' | 'book'>(publisher.book.status === 'unique' ? 'book' : 'root');
  const [days, setDays] = useState('90'); const [reviewed, setReviewed] = useState<{ key: EntityKey; actor: NonNullable<typeof session.actor>; target: 'root' | 'book'; days: number } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const authority = writeAuthority(session.actor, session.mode, session.chainId);
  useEffect(() => { setReviewed(null); setError(''); }, [actorScope(session.actor)]);
  if (!ownsPublisher(publisher, session.actor)) return null;
  const pending = busy || action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const review = () => {
    const key = target === 'root' ? publisher.root.key : publisher.book.status === 'unique' ? publisher.book.entity.key : null;
    if (!key || !session.actor) return;
    setError(''); setReviewed({ key, actor: structuredClone(session.actor), target, days: Number(days) });
  };
  const submit = async () => {
    if (!runtime.repository || !authority || !reviewed) return;
    setBusy(true); setError('');
    try {
      const fresh = await runtime.repository.loadPublisher(publisher.root.key);
      if (!fresh.ok) throw new Error('Your contribution could not be refreshed. Nothing has been extended.');
      const current = runtime.session.getSnapshot();
      const currentAuthority = writeAuthority(current.actor, current.mode, current.chainId);
      if (!currentAuthority || !sameActor(currentAuthority.actor, reviewed.actor)) throw new Error('The account changed. Review this extension with the owner account.');
      const command = prepareRenewalCommand(fresh.value, currentAuthority, reviewed.target, reviewed.key, reviewed.days * 86400, runtime.now(), crypto.randomUUID());
      const result = await action.run(command, (repo, input) => repo.renewEntity(input));
      if (result.ok) setReviewed(null);
      await onRefresh?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The extension could not be prepared.'); }
    finally { setBusy(false); }
  };
  return <section className="pf-sheet pf-stack pf-contribution-renewal">
    <h3>Keep my offers available</h3>
    <p>Extend how long your saved contribution can be read. Keep both your profile and its current offers available. Availability dates and project approvals stay the same.</p>
    <div className="pf-contribution-fields">
      <Select label="Keep available" value={target} onChange={event => setTarget(event.target.value as 'root' | 'book')}
        options={[{ value: 'book', label: 'My current offers and promises', disabled: publisher.book.status !== 'unique' }, { value: 'root', label: 'My contribution profile' }]} />
      <Select label="Add about" value={days} onChange={event => setDays(event.target.value)}
        options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }]} />
    </div>
    {publisher.book.status !== 'unique' && <p>Restore or resolve your offers before extending them. You can still extend your profile.</p>}
    <Button variant="secondary" disabled={!authority || pending || (target === 'book' && publisher.book.status !== 'unique')} onClick={review}>Review extension</Button>
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
    <ActionFeedback action={action} onRefresh={onRefresh} />
    <Dialog open={reviewed !== null} title="Keep my contribution available" closeLabel="Cancel" onClose={() => { if (!pending) setReviewed(null); }}
      footer={<><Button variant="secondary" disabled={pending} onClick={() => setReviewed(null)}>Cancel</Button><Button disabled={pending} onClick={() => void submit()}>{busy ? 'Extending…' : 'Confirm extension'}</Button></>}>
      <div className="pf-stack">
        <p>Add about {reviewed?.days} days to {reviewed?.target === 'root' ? 'my contribution profile' : 'my current offers and promises'}.</p>
        <p>{session.mode === 'public' ? 'The network measures expiry in blocks, so this is an estimated duration. Your wallet will show the transaction before you approve it.' : 'This extends the saved local example.'}</p>
        <p>This does not renew an expired approval or make you available on new dates.</p>
        <details><summary>Advanced</summary><dl className="pf-contribution-details"><dt>Record</dt><dd>{reviewed?.key}</dd><dt>Current expiration block</dt><dd>{reviewed?.target === 'root' ? publisher.root.provenance.expiresAtBlock ?? 'Local example' : publisher.book.status === 'unique' ? publisher.book.entity.provenance.expiresAtBlock ?? 'Local example' : 'Unavailable'}</dd><dt>Requested nominal extension</dt><dd>{(reviewed?.days ?? 0) * 86400} seconds</dd></dl></details>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <ActionFeedback action={action} onRefresh={onRefresh} />
      </div>
    </Dialog>
  </section>;
}

