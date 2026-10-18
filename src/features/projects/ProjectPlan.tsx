import type { PlanDocument, ProjectAggregate } from '../../domain/types';
import { formatDateTime, formatQuantity } from '../../app/time';
import { StatusLabel } from '../../ui';
import { planCoverage, publisherName } from './selectors';
import { conditionText, resourceName } from './terms';
import './projectNeeds.css';

export function ProjectPlan({ project, plan, title = 'Assignments in this plan' }: { project: ProjectAggregate; plan: PlanDocument; title?: string }) {
  return <section className="project-plan pf-surface-light" aria-label={title}>
    <header className="project-plan-heading"><div><h2>{title}</h2><p>{plan.outcome}</p></div><div className="project-plan-place"><strong>{plan.variant.title}</strong><span>{plan.variant.venueId}</span><span>Times in {plan.variant.timeZone}</span></div></header>
    {plan.variant.instructions && <p className="project-plan-instructions"><strong>For this date and place:</strong> {plan.variant.instructions}</p>}
    <div className="project-plan-assignments">
      {planCoverage(plan, project).map(row => <section className={`project-assignment${row.missing ? ' project-assignment--gap' : ''}`} key={row.requirement.id}>
        <div className="project-assignment-heading"><div><h3>{row.requirement.title}</h3><p>{formatQuantity(row.assigned)} of {formatQuantity(row.requirement.quantity)} {row.requirement.unit}</p></div><StatusLabel tone={row.missing === 0 ? 'neutral' : 'warning'}>{row.missing === 0 ? 'Assigned' : `${row.missing} still needed`}</StatusLabel></div>
        <p className="project-assignment-time">{formatDateTime(row.requirement.interval.start, plan.variant.timeZone)} to {formatDateTime(row.requirement.interval.end, plan.variant.timeZone)}</p>
        <ul className="project-assignment-people">{row.allocations.map(allocation => {
          const ownerName = publisherName(project, allocation.publisherRoot), contributionName = resourceName(project, allocation.publisherRoot, allocation.resourceId);
          return <li key={allocation.id}>
          <div><strong>{ownerName}</strong>{contributionName !== ownerName && <span>{contributionName}</span>}</div><span className="project-assignment-quantity">{formatQuantity(allocation.quantity)} {allocation.unit}</span>
          {(allocation.interval.start !== row.requirement.interval.start || allocation.interval.end !== row.requirement.interval.end) && <p>Reserved from {formatDateTime(allocation.interval.start, plan.variant.timeZone)} to {formatDateTime(allocation.interval.end, plan.variant.timeZone)}, including handover and return.</p>}
        </li>; })}</ul>
        <div className="project-assignment-terms"><p><strong>Skill or use:</strong> {row.requirement.capability}</p>{row.requirement.instructions && <p>{row.requirement.instructions}</p>}{row.requirement.dependsOn.length > 0 && <p><strong>Starts after:</strong> {row.requirement.dependsOn.map(id => plan.variant.requirements.find(item => item.id === id)?.title ?? id).join(', ')}</p>}</div>
      </section>)}
    </div>
    <div className="project-plan-terms">
      {plan.instructions && <p className="project-plan-instructions"><strong>Instructions for everyone:</strong> {plan.instructions}</p>}
      <p><strong>Owners who must agree:</strong> {plan.requiredApprovers.map(root => publisherName(project, root)).join(', ')}</p>
      {plan.conditions.length > 0 && <section className="pf-stack pf-stack--compact"><h3>Conditions in this plan</h3><ul>{plan.conditions.map((condition, index) => <li key={index}>{conditionText(condition, project)}</li>)}</ul></section>}
      {plan.resourceAssumptions.length > 0 && <section className="pf-stack pf-stack--compact"><h3>Shared resource limits</h3><ul>{plan.resourceAssumptions.map(resource => <li key={`${resource.publisherRoot}:${resource.resourceId}`}>{resourceName(project, resource.publisherRoot, resource.resourceId)} from {publisherName(project, resource.publisherRoot)}: {resource.capacity} {resource.unit} available at one time.</li>)}</ul></section>}
      <details className="project-plan-run-sheet"><summary>Run sheet included in this plan ({plan.runbook.length})</summary><ol className="project-run-sheet">{plan.runbook.map(task => <li key={task.id}><strong>{task.title}</strong><p>{task.kind === 'task' ? publisherName(project, task.publisherRoot) : `${task.kind === 'return' ? 'Return' : 'Handover'}: ${task.quantity} ${task.unit}, from ${publisherName(project, task.giver)} to ${publisherName(project, task.receiver)}`}</p><p>{formatDateTime(task.interval.start, plan.variant.timeZone)} to {formatDateTime(task.interval.end, plan.variant.timeZone)}</p>{task.dependsOn.length > 0 && <p>After: {task.dependsOn.map(id => plan.runbook.find(item => item.id === id)?.title ?? id).join(', ')}</p>}{task.instructions && <p>{task.instructions}</p>}</li>)}</ol>{!plan.runbook.length && <p>This plan has no scheduled duties.</p>}</details>
    </div>
  </section>;
}
