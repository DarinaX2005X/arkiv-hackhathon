import type { PlanDocument, ProjectAggregate } from '../../domain/types';
import { formatDateTime, formatQuantity } from '../../app/time';
import { RequirementRow, StatusLabel } from '../../ui';
import { planCoverage, publisherName } from './selectors';
import { conditionText, resourceName } from './terms';

export function ProjectPlan({ project, plan, title = 'The complete plan' }: { project: ProjectAggregate; plan: PlanDocument; title?: string }) {
  return <section className="pf-stack project-plan" aria-label={title}>
    <header><h2>{title}</h2><p>{plan.outcome}</p><p><strong>{plan.variant.title}</strong> at {plan.variant.venueId}</p><p>Times shown in {plan.variant.timeZone}.</p>{plan.variant.instructions && <p><strong>For this date and place:</strong> {plan.variant.instructions}</p>}</header>
    {planCoverage(plan, project).map(row => <RequirementRow key={row.requirement.id}
      title={row.requirement.title} coverage={`${formatQuantity(row.assigned)} of ${formatQuantity(row.requirement.quantity)} ${row.requirement.unit}`}
      status={<StatusLabel tone={row.missing === 0 ? 'success' : 'warning'}>{row.missing === 0 ? 'Assigned in this plan' : `${row.missing} still needed`}</StatusLabel>}
      contributions={<ul>{row.allocations.map(allocation => <li key={allocation.id}>{publisherName(project, allocation.publisherRoot)} supplies {allocation.quantity} {allocation.unit}
        {(allocation.interval.start !== row.requirement.interval.start || allocation.interval.end !== row.requirement.interval.end) && <p>Reserved from {formatDateTime(allocation.interval.start, plan.variant.timeZone)} to {formatDateTime(allocation.interval.end, plan.variant.timeZone)}, including handover and return.</p>}</li>)}</ul>}
      conditions={<><p>{formatDateTime(row.requirement.interval.start, plan.variant.timeZone)} to {formatDateTime(row.requirement.interval.end, plan.variant.timeZone)}</p>
        <p>Skill or use needed: {row.requirement.capability}.</p>
        {row.requirement.instructions && <p>{row.requirement.instructions}</p>}
        {row.requirement.dependsOn.length > 0 && <p>Starts after: {row.requirement.dependsOn.map(id => plan.variant.requirements.find(item => item.id === id)?.title ?? id).join(', ')}</p>}</>}
    />)}
    {plan.instructions && <p><strong>Instructions for everyone:</strong> {plan.instructions}</p>}
    <p><strong>Owners who must agree:</strong> {plan.requiredApprovers.map(root => publisherName(project, root)).join(', ')}</p>
    {plan.conditions.length > 0 && <section className="pf-stack pf-stack--compact"><h3>Conditions everyone is agreeing to</h3><ul>{plan.conditions.map((condition, index) => <li key={index}>{conditionText(condition, project)}</li>)}</ul></section>}
    {plan.resourceAssumptions.length > 0 && <section className="pf-stack pf-stack--compact"><h3>Shared resource limits</h3><ul>{plan.resourceAssumptions.map(resource => <li key={`${resource.publisherRoot}:${resource.resourceId}`}>{resourceName(project, resource.publisherRoot, resource.resourceId)} from {publisherName(project, resource.publisherRoot)}: {resource.capacity} {resource.unit} available at one time.</li>)}</ul></section>}
    <section className="pf-stack pf-stack--compact"><h3>Run sheet included in this agreement</h3><ol className="project-run-sheet">{plan.runbook.map(task => <li key={task.id}><strong>{task.title}</strong><p>{task.kind === 'task' ? publisherName(project, task.publisherRoot) : `${task.kind === 'return' ? 'Return' : 'Handover'}: ${task.quantity} ${task.unit}, from ${publisherName(project, task.giver)} to ${publisherName(project, task.receiver)}`}</p><p>{formatDateTime(task.interval.start, plan.variant.timeZone)} to {formatDateTime(task.interval.end, plan.variant.timeZone)}</p>{task.dependsOn.length > 0 && <p>After: {task.dependsOn.map(id => plan.runbook.find(item => item.id === id)?.title ?? id).join(', ')}</p>}{task.instructions && <p>{task.instructions}</p>}</li>)}</ol>{!plan.runbook.length && <p>This plan has no scheduled duties.</p>}</section>
  </section>;
}
