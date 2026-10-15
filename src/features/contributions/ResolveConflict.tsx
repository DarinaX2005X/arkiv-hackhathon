import { useEffect, useState } from 'react';
import { formatDateTime, routeHref, useApp, useAppSession } from '../../app';
import { useRepositoryAction } from '../../app/actions';
import { createOperationIntent } from '../../data/operations';
import type { ReplaceBookCommand, WriteAuthority } from '../../data/types';
import { inspectBookConflict, prepareResolveBook } from '../../domain/operations';
import type { BookDecisionChoice, ResolveBookInput } from '../../domain/operations';
import { sameActor } from '../../domain/readiness';
import { canonicalJson } from '../../domain/canonical';
import type { BookState, DomainReason, EntityKey, PublisherAggregate } from '../../domain/types';
import { Button, Dialog, Link, Notice, Select, Textarea } from '../../ui';
import { actorScope, bookLifetime, ownsPublisher, writeAuthority } from './model';
import { ContributionPreview, intervalText, Reasons } from './shared';
import { ActionFeedback } from './OperationFeedback';

export function prepareConflictCommand(publisher: PublisherAggregate, authority: WriteAuthority, input: ResolveBookInput):
  { ok: true; command: ReplaceBookCommand } | { ok: false; reasons: DomainReason[] } {
  const merged = prepareResolveBook(publisher, authority.actor, input);
  if (!merged.ok) return merged;
  const value = { ...merged.value, publisherRoot: publisher.root.key, lifetimeSeconds: bookLifetime(merged.value.book, input.now) };
  return { ok: true, command: { ...value, operation: createOperationIntent('replace_book', authority, value, { id: input.operationId, now: input.now }) } };
}
export function resolutionReviewContent(book: BookState, operationId: string): string {
  return canonicalJson({ ...book, createdAt: 0, decisions: book.decisions.map(decision => decision.operationId === operationId ? { ...decision, decidedAt: 0 } : decision) });
}

export function ResolveContributionConflict({ publisher, onRefresh }: { publisher: PublisherAggregate; onRefresh?: () => void | Promise<void> }) {
  const runtime = useApp(); const session = useAppSession(); const action = useRepositoryAction(`resolve-contribution:${publisher.root.key}`);
  const authority = writeAuthority(session.actor, session.mode, session.chainId);
  const [availability, setAvailability] = useState(''); const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [resources, setResources] = useState<Record<string, string>>({}); const [reasons, setReasons] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<DomainReason[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ input: ResolveBookInput; command: ReplaceBookCommand; actor: NonNullable<typeof session.actor> } | null>(null);
  useEffect(() => { setPreview(null); setAvailability(''); setDecisions({}); setResources({}); setReasons({}); setError(''); },
    [actorScope(session.actor), session.mode, session.chainId, publisher.root.key]);
  if (publisher.book.status !== 'conflict') return <ActionFeedback action={action} onRefresh={onRefresh} />;
  const heads = publisher.book.entities; const review = inspectBookConflict(publisher);
  const owned = ownsPublisher(publisher, session.actor); const pending = busy || action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const headName = (key: EntityKey) => `Copy ${heads.findIndex(head => head.key === key) + 1}`;
  const selected = heads.find(head => head.key === availability);
  const prepare = () => {
    if (!authority || !session.actor || !selected) return; setError('');
    const chosenDecisions: BookDecisionChoice[] = review.decisions.flatMap(group => {
      const choice = decisions[group.key];
      if (!choice) return [];
      return choice === 'withdraw' ? [{ key: group.key, kind: 'withdraw', reason: reasons[group.key] ?? '' } as BookDecisionChoice]
        : [{ key: group.key, kind: 'recorded', headKey: choice as EntityKey } as BookDecisionChoice];
    });
    const input: ResolveBookInput = { reviewedHeads: review.heads, availabilityHeadKey: selected.key, decisions: chosenDecisions,
      resources: Object.entries(resources).filter(([, value]) => value).map(([resourceId, headKey]) => ({ resourceId, headKey: headKey as EntityKey })),
      operationId: crypto.randomUUID(), now: runtime.now() };
    const result = prepareConflictCommand(publisher, authority, input);
    if (!result.ok) { setProblems(result.reasons); return; }
    setProblems([]); setPreview({ input, command: result.command, actor: structuredClone(session.actor) });
  };
  const submit = async () => {
    if (!runtime.repository || !authority || !preview) return; setBusy(true); setError('');
    try {
      const current = await runtime.repository.loadPublisher(publisher.root.key);
      if (!current.ok) throw new Error('Your contribution could not be refreshed. The copies have been kept.');
      const sessionNow = runtime.session.getSnapshot(), currentAuthority = writeAuthority(sessionNow.actor, sessionNow.mode, sessionNow.chainId);
      if (!currentAuthority || !sameActor(currentAuthority.actor, preview.actor)) throw new Error('The account changed. Review these choices with the owner account.');
      // Revalidate the reviewed choices against the complete fresh head set before freezing the send command.
      const checked = prepareConflictCommand(current.value, currentAuthority, { ...preview.input, now: runtime.now() });
      if (!checked.ok) { setProblems(checked.reasons); throw new Error('The contribution changed or these choices no longer fit. Close this review and refresh before trying again.'); }
      // A deadline crossing between preview and send also changes the records retained by the merge.
      if (resolutionReviewContent(checked.command.book, preview.input.operationId) !== resolutionReviewContent(preview.command.book, preview.input.operationId)) throw new Error('A promise changed since this review. Refresh and review the combined contribution again.');
      const result = await action.run(checked.command, (repo, command) => repo.replaceBook(command));
      if (result.ok) setPreview(null); await onRefresh?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The copies could not be combined.'); }
    finally { setBusy(false); }
  };
  return <section className="pf-stack">
    <h3>Resolve competing copies</h3>
    <p>{heads.length} copies of this contribution are saved. Choose the offers to use from now on. Work reports, equipment custody and active promises from every copy will be kept.</p>
    <div className="pf-conflict-copies">{heads.map(head => <article key={head.key} className={`pf-conflict-copy pf-stack${availability === head.key ? ' is-selected' : ''}`}>
      <header className="pf-stack pf-stack--compact"><h4>{headName(head.key)}: {head.payload.name}</h4><p className="pf-secondary">Saved {formatDateTime(head.payload.createdAt, 'UTC')} UTC</p>{owned && <Button variant={availability === head.key ? 'primary' : 'secondary'} aria-pressed={availability === head.key} disabled={pending} onClick={() => { setAvailability(head.key); setPreview(null); }}>{availability === head.key ? 'Selected offer copy' : `Use offers from ${headName(head.key).toLowerCase()}`}</Button>}</header>
      <ContributionPreview draft={head.payload} />
      <p>{head.payload.grants.filter(grant => grant.validUntil > publisher.snapshot.blockTimestamp).length} active promises. {head.payload.custodyHolds.filter(hold => hold.status === 'outstanding').length} unresolved equipment holds.</p>
      <details><summary>Advanced</summary><p className="pf-contribution-identity">Record: {head.key}</p></details>
    </article>)}</div>
    {!owned && <p>Only the contribution owner can resolve these copies.</p>}
    {owned && <>
      {!selected && <p>Compare the offers above and choose which copy to use from now on.</p>}
      {review.decisions.length > 0 && <section className="pf-stack"><h4>Project promises</h4>{review.decisions.map(group => <div className="pf-stack pf-stack--compact" key={group.key}>
        <Link href={routeHref({ name: 'project', projectRoot: group.source.projectRoot, tab: 'agreement' })}>Read this project’s agreement</Link>
        {group.liveGrants.flatMap(grant => grant.allocations.map(allocation => <p key={`${grant.id}:${allocation.id}`}>{allocation.quantity} {allocation.unit}, {intervalText(allocation.interval)}</p>))}
        <Select label={group.records.length > 1 ? 'These copies disagree. Choose the decision to keep.' : 'Keep or withdraw this promise'} value={decisions[group.key] ?? (group.records.length === 1 ? group.records[0]!.headKey : '')}
          onChange={event => setDecisions(previous => ({ ...previous, [group.key]: event.target.value }))} disabled={pending}
          options={[...(group.records.length > 1 ? [{ value: '', label: 'Choose a decision' }] : []), ...group.records.map(record => ({ value: record.headKey, label: `${record.decision.status === 'accepted' ? 'Keep recorded approval' : record.decision.status === 'declined' ? 'Keep recorded decline' : 'Keep recorded withdrawal'} from ${headName(record.headKey)}` })), { value: 'withdraw', label: 'Withdraw this plan’s promises now' }]} />
        {decisions[group.key] === 'withdraw' && <Textarea label="Reason for withdrawing" value={reasons[group.key] ?? ''} onChange={event => setReasons(previous => ({ ...previous, [group.key]: event.target.value }))} hint="This reason will be visible to the project. Equipment custody is kept." />}
      </div>)}</section>}
      {selected && review.resources.some(group => group.records.length > 1) && <section className="pf-stack"><h4>Check resource capacities</h4><p>The copies give different resource details. Choose the quantities you can provide while keeping existing promises.</p><div className="pf-contribution-fields">{review.resources.filter(group => group.records.length > 1).map(group => <Select key={group.id} label={group.records[0]!.resource.name} value={resources[group.id] ?? ''} disabled={pending} onChange={event => setResources(previous => ({ ...previous, [group.id]: event.target.value }))}
        options={[{ value: '', label: 'Use the selected offer copy when available' }, ...group.records.map(record => ({ value: record.headKey, label: `${headName(record.headKey)}: ${record.resource.capacity} ${record.resource.unit}` }))]} />)}</div></section>}
      <Reasons reasons={problems} />
      {problems.some(reason => reason.path === 'attestations' || reason.path === 'custodyHolds') && <p>The copies disagree about the contents of the same work or custody statement. They cannot be combined safely here. No statement or return will be guessed.</p>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      <Button disabled={!authority || pending || !selected} onClick={prepare}>Review combined contribution</Button>
    </>}
    <ActionFeedback action={action} onRefresh={onRefresh} />
    <Dialog open={preview !== null} title="Use this combined contribution" closeLabel="Cancel" onClose={() => { if (!pending) setPreview(null); }}
      footer={<><Button variant="secondary" disabled={pending} onClick={() => setPreview(null)}>Cancel</Button><Button disabled={pending || !authority || !preview || !sameActor(authority.actor, preview.actor)} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save combined contribution'}</Button></>}>
      {preview && <div className="pf-stack">
        <ContributionPreview draft={preview.command.book} />
        <p>Keep {preview.command.book.grants.length} active promises, {preview.command.book.attestations.length} work statements and {preview.command.book.custodyHolds.length} equipment custody records.</p>
        {preview.input.decisions.filter(choice => choice.kind === 'withdraw').map(choice => <p key={choice.key}>Withdraw a project promise: {choice.kind === 'withdraw' ? choice.reason : ''}</p>)}
        <p>This replaces all {preview.input.reviewedHeads.length} reviewed copies together. Any competing update will stop this change for another review.</p>
        {session.mode === 'public' && <p>Your selected offers and decisions will be public. Your wallet will ask you to approve this change.</p>}
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <ActionFeedback action={action} onRefresh={onRefresh} />
      </div>}
    </Dialog>
  </section>;
}

