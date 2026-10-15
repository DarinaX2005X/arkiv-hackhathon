import { useEffect, useMemo, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { routeHref } from '../../app/routes';
import { formatDateTime } from '../../app/time';
import { finalizePlan } from '../../domain/validation';
import { completedWorkContext } from '../../domain/execution';
import { rankPlan } from '../../domain/solver';
import type { EntityRecord, ProjectAggregate, Proposal } from '../../domain/types';
import type { PublishPlanCommand } from '../../data/types';
import { createOperationIntent } from '../../data/operations';
import { Button, Dialog, Link, Notice, PlanDiff, Select, StatusLabel } from '../../ui';
import { authorityFor, comparePlans, ownsProject, planningInput, publishPlanInput, restoreTerms } from './selectors';
import { projectsCopy as copy, reasonText } from './catalog';
import { ProjectPlan } from './ProjectPlan';
import { ActionFeedback } from './ActionFeedback';

export function HistoryPanel({ project, onRefresh }: { project: ProjectAggregate; onRefresh: () => Promise<void> }) {
  const runtime = useApp(), session = useAppSession();
  const action = useRepositoryAction(`project-restore:${project.root.key}`);
  const [selected, setSelected] = useState<EntityRecord<Proposal> | null>(null), [error, setError] = useState<string | null>(null);
  const [viewedKey, setViewedKey] = useState<string | null>(null);
  const records = project.proposal && !project.proposalHistory.some(record => record.key === project.proposal!.key) ? [...project.proposalHistory, project.proposal] : project.proposalHistory;
  const viewed = records.find(record => record.key === viewedKey) ?? records.find(record => record.key === project.proposal?.key) ?? records.at(-1);
  const restored = useMemo(() => { if (!selected) return null; try { return restoreTerms(project, selected); } catch { return null; } }, [project, selected]);
  const input = planningInput(project), finalized = restored && input ? finalizePlan(restored, input.publishers, project.snapshot, completedWorkContext(project)) : null;
  const authority = authorityFor(session.actor, session.mode, session.chainId), owner = ownsProject(project, session.actor);
  useEffect(() => { setSelected(null); setError(null); }, [session.actor, session.mode, session.chainId, project.root.key]);
  const open = project.state.status === 'unique' && project.state.entity.payload.lifecycle !== 'closed' && project.activation.status === 'unique';
  const waiting = action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const publish = async (resume = false) => {
    if (!authority || !owner) return;
    try {
      if (resume) {
        const result = await action.resume((repository, frozen: PublishPlanCommand) => repository.publishPlan(frozen));
        if (result.ok && result.value.operation.phase === 'complete') { setSelected(null); await onRefresh(); window.location.hash = routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' }).slice(1); }
        return;
      }
      if (!finalized?.ok || !selected || !restored) return;
      const id = crypto.randomUUID(), now = runtime.now(), plan = finalized.value.plan;
      const sourceRecipe = { title: project.state.status === 'unique' ? project.state.entity.payload.recipe.title : '', outcome: plan.outcome,
        timeZone: plan.variant.timeZone, variants: [plan.variant], instructions: plan.instructions };
      const fields = publishPlanInput(project, { plan, proposalHash: finalized.value.proposalHash, rank: rankPlan(plan, project.proposal?.payload.plan ?? null) }, id, now,
        `Restored terms from proposal ${selected.key}; all current owners must agree again.`, { sourceRecipe });
      const result = await action.run({ ...fields, operation: createOperationIntent('publish_plan', authority, fields, { id, now }) }, (repository, command) => repository.publishPlan(command));
      if (result.ok && result.value.operation.phase === 'complete') { setSelected(null); await onRefresh(); window.location.hash = routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' }).slice(1); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'These terms could not be prepared for a new version.'); }
  };
  return <section className="pf-stack"><h2>{copy.history}</h2><p>Review earlier plans and how they changed. Each person’s decision stays with the version they reviewed.</p>
    {project.proposalHistoryStatus?.complete !== true && records.length > 0 && <Notice tone="warning">{copy.historyGap}</Notice>}
    {records.length === 0 && <div className="pf-stack pf-stack--compact"><p>{project.proposalHistoryStatus?.complete ? 'No plan has been published here yet. Find a complete plan and ask contributors to review the first version.' : 'No plan history is available in this read. Refresh the project to check its records.'}</p><Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'plans' })}>Find a plan</Link></div>}
    {records.length > 0 && <Select label="Choose a plan version" value={viewed?.key ?? ''} onChange={event => setViewedKey(event.target.value)} options={records.map((record, index) => ({ value: record.key, label: `${project.proposalHistoryStatus?.complete ? `Plan ${index + 1}` : 'Available plan'}: ${record.payload.plan.variant.title}, ${formatDateTime(record.payload.createdAt, record.payload.plan.variant.timeZone)}${record.key === project.proposal?.key ? ' (current plan)' : ''}` }))} />}
    {viewed && (() => {
      const record = viewed, index = records.indexOf(record);
      const predecessor = record.payload.plan.predecessor;
      const prior = predecessor ? records.find(item => item.key === predecessor.proposalKey && item.payload.proposalHash === predecessor.proposalHash) : null;
      const current = project.proposal?.key === record.key && project.activation.status === 'unique';
      return <article className="pf-sheet pf-stack" key={record.key}>
        <header className="project-heading"><div><h3>{project.proposalHistoryStatus?.complete ? `Plan ${index + 1}` : 'Available plan'}: {record.payload.plan.variant.title}</h3><p>{formatDateTime(record.payload.createdAt, record.payload.plan.variant.timeZone)}</p></div><StatusLabel tone={current ? 'neutral' : undefined}>{current ? 'Current plan' : 'Earlier plan'}</StatusLabel></header>
        {record.payload.changeExplanation && <p>{record.payload.changeExplanation}</p>}
        <ProjectPlan project={project} plan={record.payload.plan} title="The terms in this version" />
        {prior && <PlanDiff title="Changes from the preceding version" labels={{ requirement: 'Requirement', before: 'Preceding plan', after: 'This plan' }} rows={comparePlans(prior.payload.plan, record.payload.plan, project)} />}
        {predecessor && !prior && <Notice tone="warning">The predecessor proposal is unavailable. This gap does not mean there was no earlier plan.</Notice>}
        {owner && !current && <Button variant="secondary" disabled={!open || waiting || !authority} onClick={() => { setSelected(record); setError(null); }}>{copy.restore}</Button>}
        <details><summary>Advanced: exact version references</summary><p>Proposal: {record.key}</p><p>Terms hash: {record.payload.proposalHash}</p></details>
      </article>;
    })()}
    <ActionFeedback action={action} state={action.state} onReconcile={() => { void action.reconcile().then(() => onRefresh()); }} onResume={action.recoverableCommand ? () => { void publish(true); } : undefined} />
    <Dialog open={selected !== null} title="Restore terms with fresh agreement" closeLabel="Keep current plan" onClose={() => setSelected(null)} footer={<Button onClick={() => { void publish(); }} disabled={!finalized?.ok || !authority || !owner || waiting}>Publish these terms as a new version</Button>}>
      <div className="pf-stack"><Notice>{copy.restoreNote} The editable project recipe remains separate from this active agreement.</Notice>
        {restored && <ProjectPlan project={project} plan={finalized?.ok ? finalized.value.plan : restored} />}
        {project.proposal && restored && <PlanDiff title="Changes from the current plan" labels={{ requirement: 'Requirement', before: 'Current plan', after: 'Restored terms' }} rows={comparePlans(project.proposal.payload.plan, restored, project)} />}
        {finalized && !finalized.ok && <Notice tone="warning" title="These historical terms are not currently feasible"><ul>{finalized.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul></Notice>}
        {!restored && <Notice tone="warning">A unique current plan is required before earlier terms can be restored.</Notice>}{error && <Notice tone="warning">{error}</Notice>}
      </div>
    </Dialog>
  </section>;
}
