import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { formatDateTime } from '../../app/time';
import { createOperationIntent } from '../../data/operations';
import type { PublishPlanCommand } from '../../data/types';
import type { PlanDocument, ProjectAggregate, SolverPin } from '../../domain/types';
import { activeSource, deriveReadiness, sameSource } from '../../domain/readiness';
import { planDiff, remainingWork } from '../../domain/execution';
import { Button, Checkbox, Field, Notice, PlanDiff, Select } from '../../ui';
import { authorityFor, ownsProject, publishPlanInput, publisherName } from '../projects/selectors';
import { ProjectPlan } from '../projects/ProjectPlan';
import { ActionFeedback } from '../projects/ActionFeedback';
import { reasonText } from '../projects/catalog';
import { candidateIsCurrent, createRepairController, prepareExecutionCheckpoint, repairFingerprint, repairInput } from './repair';

function changeRows(before: PlanDocument, after: PlanDocument, project: ProjectAggregate) {
  const ids = [...new Set([...before.variant.requirements, ...after.variant.requirements].map(requirement => requirement.id))];
  const text = (plan: PlanDocument, id: string) => {
    const requirement = plan.variant.requirements.find(item => item.id === id);
    if (!requirement) return 'Already reported complete; retained in history';
    return `${plan.allocations.filter(allocation => allocation.requirementId === id).map(allocation => `${publisherName(project, allocation.publisherRoot)}: ${allocation.quantity} ${allocation.unit}`).join('; ')}, ${formatDateTime(requirement.interval.start, plan.variant.timeZone)}–${formatDateTime(requirement.interval.end, plan.variant.timeZone)}`;
  };
  return ids.map(id => ({ id, label: after.variant.requirements.find(item => item.id === id)?.title ?? before.variant.requirements.find(item => item.id === id)?.title ?? id,
    before: text(before, id), after: text(after, id) }));
}
export function RepairPanel({ project, onRefresh, onReviewTransfer }: {
  project: ProjectAggregate; onRefresh: () => void | Promise<void>; onReviewTransfer: (obligationId: string) => void;
}) {
  const runtime = useApp(), session = useAppSession();
  const controller = useMemo(() => createRepairController(), [project.root.key]);
  const [pins, setPins] = useState<SolverPin[]>([]), [explanation, setExplanation] = useState('Replace withdrawn contributions and finish the remaining work.'), [reviewed, setReviewed] = useState(false), [error, setError] = useState('');
  const fingerprint = repairFingerprint(project, pins);
  useEffect(() => { controller.update(project, pins); }, [controller, project, pins, fingerprint]);
  useEffect(() => { setReviewed(false); }, [fingerprint]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const checkpoint = useRepositoryAction(`execution-checkpoint:${project.root.key}`), proposalAction = useRepositoryAction(`execution-repair:${project.root.key}`);
  const input = repairInput(project), remaining = remainingWork(project), source = activeSource(project);
  const candidate = controller.candidate();
  const changes = candidate && project.proposal ? planDiff(project.proposal.payload.plan, candidate.plan) : null;
  const authority = authorityFor(session.actor, session.mode, session.chainId);
  const blocked = [checkpoint.state.status, proposalAction.state.status].some(status => status === 'submitting' || status === 'needs-verification');
  const readiness = deriveReadiness(project, runtime.now());
  const withdrawn = project.publishers.filter(publisher => publisher.book.status === 'unique' && publisher.book.entity.payload.decisions.some(decision => source && sameSource(decision, source) && ['withdrawn', 'declined'].includes(decision.status)));
  if (!project.proposal || (project.state.status === 'unique' && project.state.entity.payload.lifecycle === 'closed')) return null;
  async function propose() {
    setError('');
    if (!candidate || !authority || !runtime.repository || !reviewed || !input) return;
    try {
      const captured = fingerprint;
      const latest = await runtime.repository.loadProject(project.root.key);
      if (!latest.ok || !candidateIsCurrent(candidate, latest.value, captured, pins)) throw new Error('Offers or completed work changed. Refresh and find a replacement again; your selected pins remain.');
      const id = globalThis.crypto.randomUUID(), now = runtime.now();
      const retained = await checkpoint.run(prepareExecutionCheckpoint(latest.value, authority, now, id), (repository, command) => repository.replaceProject(command));
      if (!retained.ok) { await onRefresh(); return; }
      const refreshed = await runtime.repository.loadProject(project.root.key);
      if (!refreshed.ok || !candidateIsCurrent(candidate, refreshed.value, captured, pins)) throw new Error('Current inputs changed while completed work was saved. Refresh and recalculate before publishing.');
      const freshInput = repairInput(refreshed.value);
      if (!freshInput) throw new Error('There is no verifiable remaining work to propose.');
      const proposalId = globalThis.crypto.randomUUID(), proposedAt = runtime.now();
      const commandInput = publishPlanInput(refreshed.value, candidate, proposalId, proposedAt, explanation, { sourceRecipe: freshInput.recipe });
      await proposalAction.run({ ...commandInput, operation: createOperationIntent('publish_plan', authority, commandInput, { id: proposalId, now: proposedAt }) }, (repository, command) => repository.publishPlan(command));
      await onRefresh();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'The repair could not be proposed. Refresh before trying again.'); }
  }
  return <section className="pf-stack execution-repair" aria-label="Replace withdrawn contributions">
    <header><h2>Finish the remaining work</h2><p>Keep compatible people and assignments where possible, while checking every remaining need. Work already reported complete stays with its original version.</p></header>
    {withdrawn.length > 0 && <Notice tone="warning" title="A contribution is no longer agreed"><ul>{withdrawn.map(publisher => <li key={publisher.root.key}>{publisherName(project, publisher.root.key)} withdrew or declined. Affected work: {project.proposal!.payload.plan.allocations.filter(allocation => allocation.publisherRoot === publisher.root.key).map(allocation => project.proposal!.payload.plan.variant.requirements.find(requirement => requirement.id === allocation.requirementId)?.title ?? allocation.requirementId).join(', ')}.</li>)}</ul></Notice>}
    {readiness.reasons.length > 0 && <ul>{readiness.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul>}
    <p>{remaining?.completedWork.length ?? 0} completed records retained. Withdrawn and declined contributors are excluded from this calculation.</p>
    {Boolean(remaining?.unresolvedTransfers.length) && <Notice tone="warning" title="Reconcile the transfer before changing the plan"><ul>{remaining!.unresolvedTransfers.map(transfer => {
      const duty = project.proposal!.payload.plan.runbook.find(item => item.id === transfer.obligationId);
      return <li key={transfer.reportId}><Button variant="quiet" onClick={() => onReviewTransfer(transfer.obligationId)}>{duty?.title ?? transfer.obligationId}</Button>: the sender reported {transfer.reportedQuantity}, and the recipient acknowledged {transfer.acknowledgedQuantity}.</li>;
    })}</ul><p>Check what actually changed hands. The sender can correct their report above, or the recipient can correct their acknowledgement if more arrived. A corrected report needs the recipient’s own confirmation before the remaining quantity can be planned.</p></Notice>}
    <details><summary>Keep specific assignments</summary><p>These are strict pins. Leaving them open lets the search prefer familiar people without accepting an impossible result.</p>
      {input?.recipe.variants[0]?.requirements.map(requirement => <Select key={requirement.id} label={requirement.title} value={pins.find(pin => pin.requirementId === requirement.id) ? JSON.stringify(pins.find(pin => pin.requirementId === requirement.id)) : ''}
        onChange={event => { const value = event.target.value; setPins(current => [...current.filter(pin => pin.requirementId !== requirement.id), ...(value ? [JSON.parse(value) as SolverPin] : [])]); }}>
        <option value="">Prefer existing assignments when feasible</option>{input.publishers.flatMap(publisher => publisher.book.status === 'unique' ? publisher.book.entity.payload.offers.filter(offer => offer.kind === requirement.kind && offer.unit === requirement.unit && offer.capabilities.includes(requirement.capability)).map(offer => {
          const pin: SolverPin = { requirementId: requirement.id, publisherRoot: publisher.root.key, offerId: offer.id };
          return <option key={`${publisher.root.key}:${offer.id}`} value={JSON.stringify(pin)}>{publisherName(project, publisher.root.key)}, {offer.title}</option>;
        }) : [])}</Select>)}
    </details>
    <Button disabled={!input || blocked || state.running} onClick={() => { controller.update(project, pins); void controller.run(); }}>{state.running ? 'Checking remaining work…' : 'Find a replacement'}</Button>
    {!input && !remaining?.unresolvedTransfers.length && <p>There is no verifiable remaining plan to calculate. Review the outstanding items or refresh current data.</p>}
    {state.stale && <Notice tone="warning">The previous result describes older input. Run the search again. Your selected pins are retained.</Notice>}
    {state.failure && <Notice tone="warning">{state.failure}</Notice>}
    {state.result && !state.stale && !candidate && <Notice tone="warning" title={state.result.status === 'exhausted' ? 'The search did not finish' : 'No complete replacement was found'}><ul>{state.result.reasons.map((reason, index) => <li key={index}>{reason.requirementId ? `${input?.recipe.variants.flatMap(variant => variant.requirements).find(requirement => requirement.id === reason.requirementId)?.title ?? reason.requirementId}: ` : ''}{reasonText(reason)}{reason.resourceId ? ` Resource: ${reason.resourceId}.` : ''}</li>)}</ul><p>Change an actual offer or requirement before recalculating. No new participant has been invented.</p></Notice>}
    {candidate && <><Notice title="Replacement found, awaiting a new agreement"><p>Preference: keep compatible contributors, then the date and place, then assignments and quantities. {state.result?.optimality === 'proven' ? 'The search checked its full space.' : 'This is a feasible result; minimum change has not been proved.'}</p><p>Everyone in the new plan must agree again, including unchanged contributors.</p></Notice>
      {(state.result?.candidates.length ?? 0) > 1 && <Select label="Replacement option" value={state.selected} onChange={event => { controller.select(Number(event.target.value)); setReviewed(false); }} options={state.result!.candidates.map((item, index) => ({ value: String(index), label: `Option ${index + 1}, ${item.rank.removedPublishers} contributor changes, ${item.rank.changedAssignments} assignment changes` }))} />}
      {project.proposal && <PlanDiff title="What changes in the remaining work" labels={{ requirement: 'Need', before: 'Previous plan', after: 'Replacement plan' }} rows={changeRows(project.proposal.payload.plan, candidate.plan, project)} />}
      {changes && <p>Added: {changes.addedPublishers.map(root => publisherName(project, root)).join(', ') || 'none'}. Removed: {changes.removedPublishers.map(root => publisherName(project, root)).join(', ') || 'none'}. Earlier decisions stay in history.</p>}
      <ProjectPlan project={project} plan={candidate.plan} title="Review the replacement plan" />
      <Field label="Why the plan is changing" value={explanation} maxLength={10000} onChange={event => setExplanation(event.target.value)} />
      <Checkbox label="I reviewed the whole replacement, including named transfers and the fresh agreement required from everyone." checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
      {session.mode === 'public' && <Notice>Proposing publishes this complete plan and explanation as public records.</Notice>}
      <Button disabled={!authority || !ownsProject(project, session.actor) || !reviewed || !explanation.trim() || blocked} disabledReason="The organizer reviews and proposes the exact replacement." onClick={() => void propose()}>Ask everyone to agree to the replacement</Button>
    </>}
    {error && <Notice tone="warning" role="alert">{error}</Notice>}
    <ActionFeedback state={checkpoint.state} action={checkpoint} onReconcile={() => void checkpoint.reconcile().then(() => onRefresh())} />
    <ActionFeedback state={proposalAction.state} action={proposalAction} onReconcile={() => void proposalAction.reconcile().then(() => onRefresh())}
      onResume={() => void proposalAction.resume<PublishPlanCommand, unknown>((repository, command) => repository.publishPlan(command)).then(() => onRefresh())} />
  </section>;
}
