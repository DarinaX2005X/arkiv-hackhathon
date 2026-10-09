import { useEffect, useState } from 'react';
import { formatDateTime, localDateTimeToUtc, routeHref, useApp, useAppSession, utcToLocalDateTime } from '../../app';
import { useRepositoryAction } from '../../app/actions';
import { activeSource, deriveDraftStatus, deriveReadiness, lastAcceptedDuty, sameActor, sameSource } from '../../domain/readiness';
import { hashOffer, hashPlan } from '../../domain/canonical';
import type { Actor, Decision, EntityKey, ProjectAggregate, SourcePlanRef } from '../../domain/types';
import { Button, ContributionRow, Dialog, EmptyState, Field, Link, Notice, PlanDiff, RequirementRow, Select, StatusLabel, Textarea } from '../../ui';
import { conditionText, ownsPublisher, prepareDecisionCommand, publisherName, writeAuthority } from './model';
import { intervalText, Reasons, useCurrentTime } from './shared';
import { ActionFeedback } from './OperationFeedback';
import { agreementDifference } from './difference';

export interface ProjectAgreementPanelProps { project: ProjectAggregate; onRefresh?: () => void | Promise<void>; publisherRoot?: EntityKey }
const statusText = { possible: 'Possible', awaiting_approval: 'Waiting for owners', declined: 'Declined', ready: 'Agreed', changed: 'Changed', conflict: 'Conflicting records', unverified: 'Unverified' };
export function ProjectAgreementPanel({ project, onRefresh, publisherRoot }: ProjectAgreementPanelProps) {
  const runtime = useApp(); const session = useAppSession();
  const now = useCurrentTime();
  const action = useRepositoryAction(`agreement:${project.root.key}`);
  const owned = project.publishers.filter(p => ownsPublisher(p, session.actor));
  const [selected, setSelected] = useState<EntityKey | ''>(publisherRoot ?? owned[0]?.root.key ?? '');
  useEffect(() => { if (!owned.some(p => p.root.key === selected)) setSelected(publisherRoot && owned.some(p => p.root.key === publisherRoot) ? publisherRoot : owned[0]?.root.key ?? ''); }, [session.actor, project, publisherRoot]);
  const authority = writeAuthority(session.actor, session.mode, session.chainId);
  const source = activeSource(project); const proposal = project.proposal;
  const readiness = deriveReadiness(project, now); const draft = deriveDraftStatus(project);
  const owner = project.publishers.find(p => p.root.key === selected);
  const ownBook = owner?.book.status === 'unique' ? owner.book.entity.payload : null;
  const ownDecision = source ? ownBook?.decisions.find(d => sameSource(d, source)) : undefined;
  const [dialog, setDialog] = useState<Decision['status'] | null>(null); const [reviewedSource, setReviewedSource] = useState<SourcePlanRef | null>(null);
  const [reviewedOwner, setReviewedOwner] = useState<{ actor: Actor; publisherRoot: EntityKey } | null>(null);
  const [reason, setReason] = useState(''); const [deadline, setDeadline] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setDialog(null); setReviewedSource(null); setReviewedOwner(null); setReason(''); setError(''); }, [session.actor, selected]);
  const timeZone = proposal?.payload.plan.variant.timeZone ?? 'UTC';
  const name = (key: EntityKey) => publisherName(project.publishers.find(p => p.root.key === key), key);
  const begin = (status: Decision['status']) => {
    if (!source || !proposal || !selected || !session.actor) return;
    setReviewedOwner({ actor: structuredClone(session.actor), publisherRoot: selected });
    setReviewedSource(structuredClone(source)); setDialog(status); setError('');
    setDeadline(utcToLocalDateTime(Math.max(runtime.now() + 3600000, lastAcceptedDuty(proposal.payload.plan, selected)), timeZone));
  };
  const submit = async () => {
    if (!runtime.repository || !authority || !selected || !dialog || !reviewedSource || !reviewedOwner) return;
    setBusy(true); setError('');
    try {
      const fresh = await runtime.repository.loadProject(project.root.key);
      if (!fresh.ok) throw new Error('The project could not be refreshed. Your decision has not been sent.');
      const currentAuthority = writeAuthority(runtime.session.getSnapshot().actor, runtime.session.getSnapshot().mode, runtime.session.getSnapshot().chainId);
      if (!currentAuthority || !sameActor(currentAuthority.actor, reviewedOwner.actor) || selected !== reviewedOwner.publisherRoot) throw new Error('The connected account changed. Review the decision with the current owner.');
      const until = dialog === 'accepted' ? localDateTimeToUtc(deadline, timeZone) : null;
      if (until && !until.ok) throw new Error(`Check the approval deadline: ${until.error.replaceAll('_', ' ')}.`);
      const command = prepareDecisionCommand(fresh.value, selected, authority, { status: dialog, reason, validUntil: until?.ok ? until.utcMilliseconds : undefined,
        reviewedSource, now: runtime.now(), id: crypto.randomUUID() });
      const result = await action.run(command, (repo, input) => repo.replaceBook(input));
      if (result.ok) setDialog(null);
      await onRefresh?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The decision could not be prepared.'); }
    finally { setBusy(false); }
  };
  if (!source || !proposal) return <section className="pf-stack"><h2>Agreement</h2><EmptyState title={project.activation.status === 'conflict' ? 'Competing active plans' : 'No current plan to approve'} description={project.state.status === 'unique' && project.state.entity.payload.lifecycle === 'closed' ? 'This project is closed. Restarting requires a new version of the plan and new approvals.' : 'The coordinator must select a complete plan before owners can decide.'} /><Reasons reasons={readiness.reasons} /><ActionFeedback action={action} onRefresh={onRefresh} /><Button variant="secondary" onClick={() => void onRefresh?.()}>Refresh project</Button></section>;
  const plan = proposal.payload.plan;
  const predecessor = plan.predecessor ? project.proposalHistory.find(p => p.key === plan.predecessor!.proposalKey && p.payload.proposalHash === plan.predecessor!.proposalHash && hashPlan(p.payload.plan) === plan.predecessor!.proposalHash) : null;
  const changes = predecessor ? agreementDifference(predecessor.payload.plan, plan) : [];
  const ownObligations = plan.runbook.filter(o => o.publisherRoot === selected || (o.kind !== 'task' && (o.giver === selected || o.receiver === selected)));
  const pending = busy || action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const canDecide = authority && selected && plan.requiredApprovers.includes(selected) && owner?.book.status === 'unique';
  return <section className="pf-stack pf-agreement"><header className="pf-stack pf-stack--compact"><div className="pf-actions"><h2>The complete agreement</h2><StatusLabel tone={readiness.status === 'ready' ? 'success' : readiness.status === 'unverified' || readiness.status === 'conflict' ? 'warning' : 'neutral'}>{statusText[readiness.status]}</StatusLabel></div><p>{plan.outcome}</p><p className="pf-secondary">{plan.variant.title}, proposed {formatDateTime(proposal.payload.createdAt, timeZone)}, checked {formatDateTime(project.snapshot.fetchedAt, timeZone)}</p></header>
    {draft.changed && <Notice tone="warning" title="The project draft has changed"><p>The changes are not part of this version of the plan. The coordinator must share the updated terms for every required owner to review again.</p></Notice>}
    <Reasons reasons={readiness.reasons} /><div className="pf-actions"><Button variant="secondary" onClick={() => void onRefresh?.()}>Refresh agreement</Button><Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'plans' })}>Review replacement plans</Link></div>
    <Notice>Approval applies to this version of the plan. Each owner records their own commitment; attendance and availability still need coordination.</Notice>
    {plan.predecessor && <section className="pf-stack"><h3>Changes from the previous plan</h3>{predecessor ? changes.length ? <PlanDiff title="Review changed terms" labels={{ requirement: 'Term', before: 'Previous version', after: 'This version' }} rows={changes} footer={<p>Every required owner must approve this version, even if their assignments stayed the same.</p>} /> : <Notice>The terms are unchanged, but every required owner must approve this new version of the plan.</Notice> : <Notice tone="warning">The previous plan is unavailable for comparison. Review all current terms; previous approvals do not carry over.</Notice>}</section>}
    {owned.length > 1 && <Select label="Review as contribution owner" value={selected} options={owned.map(p => ({ value: p.root.key, label: publisherName(p, p.root.key) }))} onChange={e => setSelected(e.target.value as EntityKey)} />}
    {selected && <section className="pf-sheet pf-stack"><h3>My obligations, {name(selected)}</h3>{ownObligations.length ? ownObligations.map(o => <article key={o.id} className="pf-stack pf-stack--compact"><h4>{o.title}</h4><p>{intervalText(o.interval, timeZone)}</p>{o.kind !== 'task' && <p>{o.kind === 'handover' ? 'Handover' : 'Return'}: {o.quantity} {o.unit}, {name(o.giver)} → {name(o.receiver)}</p>}<p>{o.instructions || 'No additional instructions.'}</p>{o.dependsOn.length > 0 && <p>After: {o.dependsOn.map(id => plan.runbook.find(entry => entry.id === id)?.title ?? id).join(', ')}</p>}</article>) : <p>No runbook assignments are listed for this owner.</p>}{plan.allocations.filter(a => a.publisherRoot === selected).map(a => <p key={a.id}>{a.quantity} {a.unit} from offer {a.offerId}, {intervalText(a.interval, timeZone)}</p>)}{ownDecision && <p>My current decision: <strong>{ownDecision.status}</strong>{ownDecision.reason && `: ${ownDecision.reason}`}</p>}{ownBook && ownBook.decisions.some(d => d.projectRoot === project.root.key && d.activationKey !== source.activationKey) && <Notice tone="warning">Your earlier decision does not approve this version of the plan.</Notice>}</section>}
    <section className="pf-stack"><h3>All requirements and contributions</h3><p>{plan.variant.instructions}</p>{plan.variant.requirements.map(requirement => <RequirementRow key={requirement.id} title={requirement.title} coverage={`${requirement.quantity} ${requirement.unit} required`} conditions={<><p>{intervalText(requirement.interval, timeZone)}</p><p>{requirement.instructions}</p>{requirement.dependsOn.length > 0 && <p>Depends on: {requirement.dependsOn.map(id => plan.variant.requirements.find(r => r.id === id)?.title ?? id).join(', ')}</p>}</>} status={<StatusLabel>{requirement.capability}</StatusLabel>} contributions={plan.allocations.filter(a => a.requirementId === requirement.id).map(a => <ContributionRow key={a.id} title={`${a.quantity} ${a.unit}, ${a.offerId}`} owner={name(a.publisherRoot)} conditions={<p>Resource: {a.resourceId}, {intervalText(a.interval, timeZone)}</p>} status={<StatusLabel tone={readiness.acceptedApprovers.includes(a.publisherRoot) ? 'success' : 'neutral'}>{readiness.acceptedApprovers.includes(a.publisherRoot) ? 'Approved this version' : 'Approval needed'}</StatusLabel>} />)} />)}</section>
    <section className="pf-stack"><h3>Shared terms</h3><p>{plan.instructions || 'No additional shared instructions.'}</p>{plan.conditions.map((condition, index) => <p key={index}>{conditionText(condition)}</p>)}<h3>Full runbook</h3>{plan.runbook.map(o => <article className="pf-contribution-runbook" key={o.id}><div><h4>{o.title}</h4><p>{name(o.publisherRoot)}, {intervalText(o.interval, timeZone)}</p>{o.kind !== 'task' && <p>{o.quantity} {o.unit}, {name(o.giver)} → {name(o.receiver)}</p>}<p>{o.instructions}</p>{o.dependsOn.length > 0 && <p>After: {o.dependsOn.map(id => plan.runbook.find(item => item.id === id)?.title ?? id).join(', ')}</p>}</div></article>)}</section>
    <section className="pf-stack"><h3>Selected offer terms</h3>{plan.offers.map(ref => {
      const owner = project.publishers.find(p => p.root.key === ref.publisherRoot);
      const offer = owner?.book.status === 'unique' ? owner.book.entity.payload.offers.find(o => o.id === ref.offerId) : undefined;
      if (!offer || hashOffer(ref.publisherRoot, offer) !== ref.offerHash) return <Notice key={`${ref.publisherRoot}:${ref.offerId}`} tone="warning" title={`${name(ref.publisherRoot)}, ${ref.offerId}`}>The original offer terms are not available in the current book. This plan cannot be approved while the selected offer terms have changed or are missing.</Notice>;
      return <ContributionRow key={`${ref.publisherRoot}:${ref.offerId}`} title={offer.title} owner={name(ref.publisherRoot)} conditions={<div className="pf-stack pf-stack--compact"><p>{offer.quantity} {offer.unit}, {offer.capabilities.join(', ')}</p>{offer.availability.map((window, index) => <p key={index}>{intervalText(window, timeZone)}</p>)}<p>{offer.instructions || 'No additional usage instructions.'}</p>{offer.conditions.map((condition, index) => <p key={index}>{conditionText(condition)}</p>)}<p>{offer.projectScope.length ? `Project scope: ${offer.projectScope.join(', ')}` : 'No project scope restriction.'}</p></div>} />;
    })}</section>
    <section className="pf-stack"><h3>Each owner’s decision</h3>{plan.requiredApprovers.map(key => { const p = project.publishers.find(x => x.root.key === key); const decision = p?.book.status === 'unique' ? p.book.entity.payload.decisions.find(d => sameSource(d, source)) : undefined; return <ContributionRow key={key} title={name(key)} owner={key} status={<StatusLabel tone={readiness.acceptedApprovers.includes(key) ? 'success' : 'neutral'}>{readiness.acceptedApprovers.includes(key) ? 'Approved this version' : decision?.status === 'accepted' ? 'Approval requires verification' : decision?.status ?? 'Waiting for owner'}</StatusLabel>} conditions={decision?.reason && <p>{decision.reason}</p>} />; })}</section>
    <details className="pf-contribution-details"><summary>Agreement records and capacity assumptions</summary><dl><dt>Project</dt><dd>{source.projectRoot}</dd><dt>Activation</dt><dd>{source.activationKey}</dd><dt>Proposal</dt><dd>{source.proposalKey}</dd><dt>Plan hash</dt><dd>{source.proposalHash}</dd><dt>Proposal author</dt><dd>{proposal.provenance.creator.kind === 'wallet' ? proposal.provenance.creator.address : proposal.provenance.creator.id}</dd><dt>Last checked</dt><dd>{formatDateTime(project.snapshot.fetchedAt, timeZone)}{project.snapshot.blockNumber ? ` at block ${project.snapshot.blockNumber}` : ' in local practice'}</dd><dt>Publication</dt><dd>{proposal.provenance.mode === 'public' ? 'Public on Arkiv' : 'Synthetic local practice'}</dd></dl><p>{proposal.payload.changeExplanation}</p><h4>Capacity assumptions</h4>{plan.resourceAssumptions.map(a => <p key={`${a.publisherRoot}:${a.resourceId}`}>{name(a.publisherRoot)}, {a.resourceId}: {a.capacity} {a.unit}</p>)}</details>
    <ActionFeedback action={action} onRefresh={onRefresh} />
    {!session.actor && <Notice>{session.mode === 'public' ? 'Read the complete plan without a wallet. Connect your own wallet on Tiramisu to record your decision.' : 'Select a synthetic practice role to record a local owner decision.'}</Notice>}
    {session.actor && !authority && <Notice tone="warning">Use the connected owner account on Tiramisu to publish a decision.</Notice>}
    {session.actor && authority && !selected && <Notice>Your current account does not control any required contribution in this project.</Notice>}
    {owner && owner.book.status !== 'unique' && <Notice tone="warning">Your availability book is {owner.book.status}. Resolve or recover it in My contributions, then review the plan again.</Notice>}
    {canDecide && <div className="pf-actions"><Button disabled={pending} onClick={() => begin('accepted')}>{ownDecision?.status === 'accepted' ? 'Review and renew my approval' : 'Confirm my contribution'}</Button><Button variant="secondary" disabled={pending} onClick={() => begin('declined')}>Decline this plan</Button>{ownDecision?.status === 'accepted' && <Button variant="danger" disabled={pending} onClick={() => begin('withdrawn')}>Withdraw my contribution</Button>}</div>}
    <Dialog open={dialog !== null} title={dialog === 'accepted' ? 'Confirm my contribution to this plan' : dialog === 'withdrawn' ? 'Withdraw my contribution' : 'Decline this plan'} closeLabel="Cancel" onClose={() => { if (!busy) setDialog(null); }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button variant={dialog === 'withdrawn' ? 'danger' : 'primary'} disabled={pending} onClick={() => void submit()}>{busy ? 'Checking and submitting…' : dialog === 'accepted' ? 'Publish my approval' : dialog === 'withdrawn' ? 'Publish my withdrawal' : 'Publish my decision'}</Button></>}>
      <div className="pf-stack"><p>{name(selected as EntityKey)}, {plan.variant.title}</p>{dialog === 'accepted' ? <><p>I approve my obligations and the complete plan shown above. My approval applies only to this version of the plan.</p><Field label={`Approval valid until (${timeZone})`} type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} hint="Must cover the end of all your duties. Renewing the stored record does not extend your approval." /></> : <><Notice tone="warning">{dialog === 'withdrawn' ? 'Your matching approval will be removed. The project will need a replacement or a new plan. Outstanding equipment custody remains visible until resolved.' : 'The coordinator and other participants will see that you declined. Your approval will not apply to this version of the plan.'}</Notice><p>Affected assignments: {plan.allocations.filter(a => a.publisherRoot === selected).map(a => plan.variant.requirements.find(r => r.id === a.requirementId)?.title ?? a.requirementId).join(', ') || 'Shared runbook obligations'}.</p></>}<Textarea label="Public reason (optional)" value={reason} onChange={e => setReason(e.target.value)} /><p className="pf-secondary">{session.mode === 'public' ? 'This decision and reason will be public. Your own wallet must approve the transaction.' : 'This is a synthetic local decision. Nothing is published to the network.'}</p>{error && <Notice tone="danger" role="alert">{error}</Notice>}<ActionFeedback action={action} onRefresh={onRefresh} /></div>
    </Dialog>
  </section>;
}
