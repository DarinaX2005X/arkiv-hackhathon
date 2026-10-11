import { hashCanonical, hashPlan } from '../../domain/canonical';
import { completedWorkContext, remainingWork } from '../../domain/execution';
import { activeSource, sameSource } from '../../domain/readiness';
import { solve } from '../../domain/solver';
import { finalizePlan } from '../../domain/validation';
import type { PlanCandidate, ProjectAggregate, SolverBudget, SolverInput, SolverPin, SolverResult } from '../../domain/types';
import { createPlanningController } from '../projects/planning';
import { planningFingerprint, STATE_LIFETIME_SECONDS } from '../projects/selectors';
import type { ReplaceProjectCommand, WriteAuthority } from '../../data/types';
import { createOperationIntent } from '../../data/operations';

export function repairInput(project: ProjectAggregate): SolverInput | null {
  if (project.state.status !== 'unique' || project.state.entity.payload.lifecycle === 'closed') return null;
  const remainder = remainingWork(project), source = activeSource(project);
  if (!remainder || !source || !remainder.plan.allocations.length || remainder.unresolvedTransfers.length
    || remainder.execution.reasons.some(reason => reason.code === 'attestation_mismatch')) return null;
  const state = project.state.entity.payload;
  const withdrawn = new Set(project.publishers.filter(publisher => publisher.book.status === 'unique'
    && publisher.book.entity.payload.decisions.some(decision => sameSource(decision, source) && (decision.status === 'withdrawn' || decision.status === 'declined'))).map(publisher => publisher.root.key));
  return {
    projectRoot: project.root.key, recipe: { ...state.recipe, outcome: remainder.plan.outcome, instructions: remainder.plan.instructions, variants: [remainder.plan.variant] },
    publishers: project.publishers.filter(publisher => state.publisherRoots.includes(publisher.root.key) && !withdrawn.has(publisher.root.key)),
    snapshot: project.snapshot, predecessor: project.proposal, predecessorSource: source,
    proposalHistory: project.proposalHistory, completedWork: remainder.completedWork,
  };
}
/** Keep named transfer duties. The solver cannot invent a receiver or silently drop a return. */
export function solveRepair(project: ProjectAggregate, input: SolverInput, pins: SolverPin[], budget: SolverBudget): SolverResult {
  const remainder = remainingWork(project);
  if (!remainder) return { status: 'unverified', candidates: [], reasons: [{ code: 'missing_proposal' }], nodesVisited: 0, exhausted: false, optimality: 'not_proven' };
  const mismatches = remainder.execution.reasons.filter(reason => reason.code === 'attestation_mismatch');
  if (remainder.unresolvedTransfers.length || mismatches.length) return { status: 'unverified', candidates: [], reasons: [...mismatches, ...remainder.unresolvedTransfers.map(transfer => ({
    code: 'attestation_mismatch', obligationId: transfer.obligationId,
    params: { reported: transfer.reportedQuantity, acknowledged: transfer.acknowledgedQuantity },
  } as const))], nodesVisited: 0, exhausted: false, optimality: 'not_proven' };
  const transferDuties = remainder.plan.runbook.filter(duty => duty.kind !== 'task');
  const taskRequirements = new Set(remainder.plan.runbook.filter(duty => duty.kind === 'task').flatMap(duty => duty.allocationIds)
    .map(id => remainder.plan.allocations.find(allocation => allocation.id === id)?.requirementId));
  const context = completedWorkContext(project);
  // Validate the actual remaining runbook during search. In particular, equipment
  // retained solely for a return must not be mistaken for another completed use.
  const result = solve(input, pins, budget, plan => {
    plan.runbook = plan.runbook.filter(duty => duty.allocationIds.some(id => taskRequirements.has(plan.allocations.find(allocation => allocation.id === id)?.requirementId)));
    for (const duty of transferDuties) {
      const ids = duty.allocationIds.flatMap(id => {
        const prior = remainder.plan.allocations.find(allocation => allocation.id === id);
        return prior ? plan.allocations.filter(allocation => allocation.requirementId === prior.requirementId && allocation.publisherRoot === prior.publisherRoot
          && allocation.resourceId === prior.resourceId && allocation.unit === prior.unit).map(allocation => allocation.id) : [];
      });
      if (!ids.length) return { ok: false, reasons: [{ code: 'attestation_mismatch', obligationId: duty.id, resourceId: duty.resourceId }] };
      plan.runbook.push({ ...structuredClone(duty), allocationIds: [...new Set(ids)] });
    }
    const present = new Set(plan.runbook.map(duty => duty.id));
    for (const duty of plan.runbook) duty.dependsOn = duty.dependsOn.filter(id => present.has(id));
    return finalizePlan(plan, project.publishers, project.snapshot, context);
  });
  return { ...result, optimality: transferDuties.length ? 'not_proven' : result.optimality };
}
export function createRepairController(evaluate: (project: ProjectAggregate, input: SolverInput, pins: SolverPin[], budget: SolverBudget) => SolverResult | Promise<SolverResult> = solveRepair) {
  let project: ProjectAggregate | null = null;
  const controller = createPlanningController((input, pins, budget) => project ? evaluate(structuredClone(project), input, pins, budget)
    : { status: 'unverified', candidates: [], reasons: [{ code: 'missing_root' }], nodesVisited: 0, exhausted: false, optimality: 'not_proven' });
  return { ...controller, update(next: ProjectAggregate, pins: SolverPin[]) { project = structuredClone(next); controller.update(repairInput(next), pins, repairFingerprint(next, pins)); } };
}
export function repairFingerprint(project: ProjectAggregate, pins: SolverPin[] = []): string {
  const input = repairInput(project);
  const remaining = remainingWork(project);
  return hashCanonical({ input: input ? planningFingerprint(input, pins) : null, remaining: remaining?.plan ?? null,
    unresolvedTransfers: remaining?.unresolvedTransfers ?? [] });
}
export function prepareExecutionCheckpoint(project: ProjectAggregate, authority: WriteAuthority, now: number, id: string): ReplaceProjectCommand {
  if (project.state.status !== 'unique') throw new Error('Refresh the project before retaining completed work.');
  const remaining = remainingWork(project);
  if (!remaining) throw new Error('The current plan needs verification before repair.');
  if (remaining.unresolvedTransfers.length) throw new Error('Reconcile the reported transfer first. The sender can correct their report, and the recipient must confirm the matching quantity.');
  if (remaining.execution.reasons.some(reason => reason.code === 'attestation_mismatch')) throw new Error('The current reports need verification before repair.');
  const previous = project.state.entity;
  const command = { projectRoot: project.root.key, expectedHeads: [previous.key], lifetimeSeconds: STATE_LIFETIME_SECONDS,
    state: { ...structuredClone(previous.payload), operationId: id, createdAt: now, predecessorKeys: [previous.key], completedWork: remaining.completedWork } };
  return { ...command, operation: createOperationIntent('replace_project', authority, command, { id, now }) };
}

export function candidateIsCurrent(candidate: PlanCandidate, project: ProjectAggregate, expectedFingerprint: string, pins: SolverPin[]): boolean {
  return candidate.proposalHash === hashPlan(candidate.plan) && repairFingerprint(project, pins) === expectedFingerprint;
}
