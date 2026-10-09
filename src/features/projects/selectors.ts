import type { Actor, Allocation, EntityKey, EntityRecord, PlanCandidate, PlanDocument, ProjectAggregate, ProjectRecipe, Proposal, Requirement, SolverInput, SolverPin, SolverResult } from '../../domain/types';
import { activeSource, deriveDraftStatus, deriveReadiness, sameActor } from '../../domain/readiness';
import { canonicalJson, hashCanonical, hashPlan, hashRequirements } from '../../domain/canonical';
import { independentlyValidatePlan } from '../../domain/validation';
import type { PublishPlanCommand, ReplaceProjectCommand, WriteAuthority } from '../../data/types';
import { formatDateTime } from '../../app/time';

export const PROJECT_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
export const STATE_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
export function authorityFor(actor: Actor | null, mode: 'local' | 'public', chainId: number | null): WriteAuthority | null {
  if (mode === 'local' && actor?.kind === 'local') return { mode: 'local', actor, chainId: null };
  if (mode === 'public' && actor?.kind === 'wallet' && chainId === 7738577) return { mode: 'public', actor, chainId: 7738577 };
  return null;
}
export const ownsProject = (project: ProjectAggregate, actor: Actor | null): boolean => actor !== null && sameActor(project.root.payload.coordinator, actor);
export function planningInput(project: ProjectAggregate, recipe?: ProjectRecipe): SolverInput | null {
  if (project.state.status !== 'unique') return null;
  const state = project.state.entity.payload;
  return { projectRoot: project.root.key, recipe: recipe ?? state.recipe,
    publishers: project.publishers.filter(publisher => state.publisherRoots.includes(publisher.root.key)),
    snapshot: project.snapshot, predecessor: project.proposal, predecessorSource: activeSource(project), completedWork: state.completedWork };
}
export function planningFingerprint(input: SolverInput, pins: SolverPin[]): string {
  return hashCanonical({ projectRoot: input.projectRoot, recipe: input.recipe, pins, predecessor: input.predecessorSource,
    completedWork: input.completedWork, completeness: input.snapshot.completeness, freshness: input.snapshot.freshness,
    publishers: input.publishers.map(publisher => ({ root: publisher.root.key, book: publisher.book.status === 'unique'
      ? { status: 'unique', resources: publisher.book.entity.payload.resources, offers: publisher.book.entity.payload.offers,
        grants: publisher.book.entity.payload.grants.filter(grant => grant.validUntil > input.snapshot.blockTimestamp), custodyHolds: publisher.book.entity.payload.custodyHolds }
      : publisher.book })) });
}
export function projectStatus(project: ProjectAggregate, now: number) {
  return { readiness: deriveReadiness(project, now), draft: deriveDraftStatus(project) };
}
export function publisherName(project: ProjectAggregate, root: EntityKey): string {
  const publisher = project.publishers.find(item => item.root.key === root);
  return publisher?.book.status === 'unique' ? publisher.book.entity.payload.name : root;
}
export interface CoverageRow { requirement: Requirement; allocations: Allocation[]; assigned: number; missing: number; names: string[] }
export function planCoverage(plan: PlanDocument, project: ProjectAggregate): CoverageRow[] {
  return plan.variant.requirements.map(requirement => {
    const allocations = plan.allocations.filter(allocation => allocation.requirementId === requirement.id);
    const assigned = allocations.reduce((total, allocation) => total + allocation.quantity, 0);
    return { requirement, allocations, assigned, missing: Math.max(0, requirement.quantity - assigned),
      names: [...new Set(allocations.map(allocation => publisherName(project, allocation.publisherRoot)))] };
  });
}
export function comparePlans(before: PlanDocument, after: PlanDocument, project: ProjectAggregate) {
  const beforeCoverage = planCoverage(before, project), afterCoverage = planCoverage(after, project);
  const requirementIds = [...new Set([...beforeCoverage.map(row => row.requirement.id), ...afterCoverage.map(row => row.requirement.id)])];
  const time = (interval: { start: number; end: number }, zone: string) => `${formatDateTime(interval.start, zone)} – ${formatDateTime(interval.end, zone)} (${zone})`;
  const describe = (row: CoverageRow | undefined, plan: PlanDocument) => row ? `${row.requirement.title}: ${row.requirement.quantity} ${row.requirement.unit}; ${row.requirement.kind}, capability ${row.requirement.capability}; ${time(row.requirement.interval, plan.variant.timeZone)}. ${row.allocations.map(allocation => `${publisherName(project, allocation.publisherRoot)} / ${allocation.offerId}, ${allocation.quantity} ${allocation.unit}; resource ${allocation.resourceId}; reserved ${time(allocation.interval, plan.variant.timeZone)}; offer terms ${allocation.offerHash.slice(0, 12)}`).join(' | ') || 'Unassigned'}. Instructions: ${row.requirement.instructions || 'None'}. Must follow: ${row.requirement.dependsOn.join(', ') || 'None'}.` : 'Not required';
  const dutyIds = [...new Set([...before.runbook, ...after.runbook].map(duty => duty.id))];
  const describeDuty = (plan: PlanDocument, id: string) => {
    const duty = plan.runbook.find(item => item.id === id); if (!duty) return 'Not included';
    return `${duty.title}; ${duty.kind}; ${publisherName(project, duty.publisherRoot)}; ${time(duty.interval, plan.variant.timeZone)}.${duty.kind !== 'task' ? ` ${duty.quantity} ${duty.unit} of ${duty.resourceId}, ${publisherName(project, duty.giver)} → ${publisherName(project, duty.receiver)}.` : ''} Instructions: ${duty.instructions || 'None'}. Must follow: ${duty.dependsOn.join(', ') || 'None'}.`;
  };
  const conditions = (plan: PlanDocument) => plan.conditions.map(condition => condition.kind === 'requires_offer' ? `Requires ${publisherName(project, condition.offer.publisherRoot)} / ${condition.offer.offerId}`
    : condition.kind === 'excludes_offer' ? `Cannot combine with ${publisherName(project, condition.offer.publisherRoot)} / ${condition.offer.offerId}`
      : condition.kind === 'requires_capability' ? `Requires capability ${condition.capability}`
        : condition.kind === 'allowed_variants' ? `Only options: ${condition.variantIds.join(', ')}` : `Only places: ${condition.venueIds.join(', ')}`).join('; ') || 'No additional supported conditions';
  return [
    { id: 'outcome', label: 'Outcome', before: before.outcome, after: after.outcome },
    { id: 'variant', label: 'Date and place option', before: before.variant.title, after: after.variant.title },
    { id: 'place', label: 'Place', before: before.variant.venueId, after: after.variant.venueId },
    { id: 'zone', label: 'Time zone', before: before.variant.timeZone, after: after.variant.timeZone },
    { id: 'instructions', label: 'Instructions for everyone', before: before.instructions || 'None', after: after.instructions || 'None' },
    { id: 'variant-instructions', label: 'Option instructions', before: before.variant.instructions || 'None', after: after.variant.instructions || 'None' },
    ...requirementIds.map(id => ({ id, label: afterCoverage.find(row => row.requirement.id === id)?.requirement.title ?? beforeCoverage.find(row => row.requirement.id === id)?.requirement.title ?? id,
      before: describe(beforeCoverage.find(row => row.requirement.id === id), before), after: describe(afterCoverage.find(row => row.requirement.id === id), after) })),
    { id: 'conditions', label: 'Supported offer conditions', before: conditions(before), after: conditions(after) },
    { id: 'offer-revisions', label: 'Exact offer revisions', before: before.offers.map(offer => `${publisherName(project, offer.publisherRoot)} / ${offer.offerId}: ${offer.offerHash}`).join('; '), after: after.offers.map(offer => `${publisherName(project, offer.publisherRoot)} / ${offer.offerId}: ${offer.offerHash}`).join('; ') },
    { id: 'capacity', label: 'Resource capacities used', before: before.resourceAssumptions.map(resource => `${publisherName(project, resource.publisherRoot)} / ${resource.resourceId}: ${resource.capacity} ${resource.unit}`).join('; '), after: after.resourceAssumptions.map(resource => `${publisherName(project, resource.publisherRoot)} / ${resource.resourceId}: ${resource.capacity} ${resource.unit}`).join('; ') },
    ...dutyIds.map(id => ({ id: `duty:${id}`, label: `Duty: ${after.runbook.find(duty => duty.id === id)?.title ?? before.runbook.find(duty => duty.id === id)?.title ?? id}`, before: describeDuty(before, id), after: describeDuty(after, id) })),
    { id: 'approvers', label: 'Everyone who must agree', before: before.requiredApprovers.map(root => publisherName(project, root)).join(', '), after: after.requiredApprovers.map(root => publisherName(project, root)).join(', ') },
  ];
}
export function replaceRecipeInput(project: ProjectAggregate, recipe: ProjectRecipe, id: string, now: number): Omit<ReplaceProjectCommand, 'operation'> {
  if (project.state.status !== 'unique' || project.state.entity.payload.lifecycle === 'closed') throw new Error('This project does not have an editable current state.');
  const previous = project.state.entity;
  return { projectRoot: project.root.key, expectedHeads: [previous.key], lifetimeSeconds: STATE_LIFETIME_SECONDS,
    state: { ...previous.payload, recipe, predecessorKeys: [previous.key], operationId: id, createdAt: now } };
}
export function admitPublisherInput(project: ProjectAggregate, publisherRoot: EntityKey, id: string, now: number): Omit<ReplaceProjectCommand, 'operation'> {
  if (project.state.status !== 'unique') throw new Error('A unique current project is required.');
  const input = replaceRecipeInput(project, project.state.entity.payload.recipe, id, now);
  return { ...input, state: { ...input.state, publisherRoots: [...new Set([...input.state.publisherRoots, publisherRoot])].sort() } };
}
export function publishPlanInput(project: ProjectAggregate, candidate: PlanCandidate, id: string, now: number, explanation: string, options?: { sourceRecipe: ProjectRecipe }): Omit<PublishPlanCommand, 'operation'> {
  if (project.state.status !== 'unique' || project.state.entity.payload.lifecycle === 'closed') throw new Error('An open project with one current state is required.');
  if (project.activation.status === 'conflict' || project.activation.status === 'unverified') throw new Error('The current agreement needs verification before publication.');
  const input = planningInput(project);
  if (!input || !independentlyValidatePlan(candidate.plan, input.publishers, project.snapshot.blockTimestamp).valid) throw new Error('The selected plan no longer matches current offers.');
  const sourceRecipe = options?.sourceRecipe ?? project.state.entity.payload.recipe;
  const selectedVariant = sourceRecipe.variants.find(variant => variant.id === candidate.plan.variant.id);
  if (!selectedVariant || canonicalJson(selectedVariant) !== canonicalJson(candidate.plan.variant)
    || candidate.plan.outcome !== sourceRecipe.outcome || candidate.plan.instructions !== sourceRecipe.instructions) throw new Error('Save the selected plan’s draft terms before publication.');
  if (candidate.proposalHash !== hashPlan(candidate.plan) || canonicalJson(candidate.plan.predecessor) !== canonicalJson(activeSource(project))) throw new Error('This selection belongs to an earlier plan. Run the search again.');
  const proposal: Proposal = { protocol: 'partfolk/1', schemaVersion: 1, entityType: 'proposal', operationId: id, createdAt: now,
    projectRoot: project.root.key, plan: candidate.plan, proposalHash: candidate.proposalHash,
    requirementsHash: hashRequirements(project.root.key, candidate.plan.variant.requirements), changeExplanation: explanation };
  return { projectRoot: project.root.key, proposal, expectedActivationHeads: project.activation.status === 'unique' ? [project.activation.entity.key] : [],
    requestPublisherRoots: [...candidate.plan.requiredApprovers], lifetimeSeconds: PROJECT_LIFETIME_SECONDS };
}
export function restoreTerms(project: ProjectAggregate, historical: EntityRecord<Proposal>): PlanDocument {
  if (historical.payload.projectRoot !== project.root.key) throw new Error('This plan belongs to another project.');
  const source = activeSource(project);
  if (!source) throw new Error('A current plan is required to restore earlier terms.');
  return { ...structuredClone(historical.payload.plan), predecessor: source };
}
export function solverSummary(result: SolverResult): 'found' | 'impossible' | 'exhausted' | 'unverified' {
  if (result.status === 'unverified') return 'unverified';
  if (result.candidates.length > 0) return 'found';
  return result.exhausted || result.status === 'exhausted' ? 'exhausted' : 'impossible';
}
