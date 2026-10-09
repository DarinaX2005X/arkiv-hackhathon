import type { PlanDocument, ProjectAggregate } from '../../domain/types';
import { formatDateTime, formatQuantity } from '../../app/time';
import { RequirementRow, StatusLabel } from '../../ui';
import { planCoverage, publisherName } from './selectors';

export function ProjectPlan({ project, plan, title = 'The complete plan' }: { project: ProjectAggregate; plan: PlanDocument; title?: string }) {
  return <section className="pf-stack project-plan" aria-label={title}>
    <header><h2>{title}</h2><p>{plan.outcome}</p><p><strong>{plan.variant.title}</strong></p><p>Times shown in {plan.variant.timeZone}.</p></header>
    {planCoverage(plan, project).map(row => <RequirementRow key={row.requirement.id}
      title={row.requirement.title} coverage={`${formatQuantity(row.assigned)} of ${formatQuantity(row.requirement.quantity)} ${row.requirement.unit}`}
      status={<StatusLabel tone={row.missing === 0 ? 'success' : 'warning'}>{row.missing === 0 ? 'Assigned in this plan' : `${row.missing} still needed`}</StatusLabel>}
      contributions={<ul>{row.allocations.map(allocation => <li key={allocation.id}>{publisherName(project, allocation.publisherRoot)} supplies {allocation.quantity} {allocation.unit}
        {(allocation.interval.start !== row.requirement.interval.start || allocation.interval.end !== row.requirement.interval.end) && <p>Reserved from {formatDateTime(allocation.interval.start, plan.variant.timeZone)} to {formatDateTime(allocation.interval.end, plan.variant.timeZone)}, including handover and return.</p>}</li>)}</ul>}
      conditions={<><p>{formatDateTime(row.requirement.interval.start, plan.variant.timeZone)} – {formatDateTime(row.requirement.interval.end, plan.variant.timeZone)}</p>
        {row.requirement.instructions && <p>{row.requirement.instructions}</p>}
        {row.requirement.dependsOn.length > 0 && <p>Starts after: {row.requirement.dependsOn.map(id => plan.variant.requirements.find(item => item.id === id)?.title ?? id).join(', ')}</p>}</>}
    />)}
    {plan.instructions && <p><strong>Instructions for everyone:</strong> {plan.instructions}</p>}
    <p><strong>Owners who must agree:</strong> {plan.requiredApprovers.map(root => publisherName(project, root)).join(', ')}</p>
    {plan.conditions.length > 0 && <details><summary>Conditions included in this plan ({plan.conditions.length})</summary><ul>{plan.conditions.map((condition, index) => <li key={index}>{condition.kind === 'requires_offer' ? `Requires ${publisherName(project, condition.offer.publisherRoot)}: ${condition.offer.offerId}`
      : condition.kind === 'excludes_offer' ? `Cannot combine with ${publisherName(project, condition.offer.publisherRoot)}: ${condition.offer.offerId}`
        : condition.kind === 'requires_capability' ? `Requires capability: ${condition.capability}`
          : condition.kind === 'allowed_variants' ? `Allowed options: ${condition.variantIds.join(', ')}` : `Allowed places: ${condition.venueIds.join(', ')}`}</li>)}</ul></details>}
    <details><summary>Run sheet included in this agreement</summary><ol>{plan.runbook.map(task => <li key={task.id}><strong>{task.title}</strong><p>{publisherName(project, task.publisherRoot)}</p>{formatDateTime(task.interval.start, plan.variant.timeZone)} – {formatDateTime(task.interval.end, plan.variant.timeZone)}{task.instructions && <p>{task.instructions}</p>}</li>)}</ol></details>
  </section>;
}
