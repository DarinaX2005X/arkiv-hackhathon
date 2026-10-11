import { describe, expect, it } from 'vitest';
import { hashOffer, hashPlan, hashRequirements } from '../canonical';
import { createLocalSnapshot, localRecord, makePublisher } from '../fixtures';
import { solve } from '../solver';
import { independentlyValidatePlan, solverCompletedWorkContext } from '../validation';
import type { Actor, CompletedWork, EntityRecord, PlanDocument, Proposal, SolverInput, SourcePlanRef } from '../types';

const NOW = 1_000_000;
const ROOT = 'local:completed-capacity' as const;
const coordinator: Actor = { kind: 'local', id: 'local-actor:organizer' };

function fixture(capacity = 3, quantity = 2) {
  const snapshot = createLocalSnapshot(NOW);
  const publisher = makePublisher('crew', { kind: 'organization', resources: [{ id: 'crew', name: 'Crew', kind: 'person',
    unit: 'person', capacity, capabilities: ['work'], availability: [{ start: NOW, end: NOW + 100 }] }],
  offers: [{ id: 'work', title: 'Work', resourceId: 'crew', kind: 'person', unit: 'person', quantity: capacity,
    capabilities: ['work'], availability: [{ start: NOW, end: NOW + 100 }], projectScope: [], conditions: [], instructions: '' }] }, NOW);
  if (publisher.book.status !== 'unique') throw new Error('fixture');
  const offerHash = hashOffer(publisher.root.key, publisher.book.entity.payload.offers[0]!);
  const plan: PlanDocument = { protocol: 'partfolk/1', validationVersion: 1, chainId: null, projectRoot: ROOT, outcome: 'Finish the work',
    variant: { id: 'shift', title: 'Work shift', venueId: 'room', timeZone: 'UTC', instructions: '',
      requirements: [{ id: 'past', title: 'Original work', kind: 'person', capability: 'work', unit: 'person', quantity,
        interval: { start: NOW + 10, end: NOW + 20 }, instructions: '', dependsOn: [] }] },
    offers: [{ publisherRoot: publisher.root.key, offerId: 'work', offerHash }],
    resourceAssumptions: [{ publisherRoot: publisher.root.key, resourceId: 'crew', capacity, unit: 'person' }],
    allocations: [{ id: 'past-allocation', requirementId: 'past', publisherRoot: publisher.root.key, resourceId: 'crew', offerId: 'work', offerHash,
      quantity, unit: 'person', interval: { start: NOW + 10, end: NOW + 20 } }],
    requiredApprovers: [publisher.root.key], conditions: [], instructions: '', predecessor: null,
    runbook: [{ kind: 'task', id: 'past-task', title: 'Original work', publisherRoot: publisher.root.key,
      interval: { start: NOW + 10, end: NOW + 20 }, allocationIds: ['past-allocation'], dependsOn: [], instructions: '' }] };
  const proposal = proposalRecord('local:past-proposal', plan);
  const source: SourcePlanRef = { projectRoot: ROOT, activationKey: 'local:past-activation', proposalKey: proposal.key, proposalHash: proposal.payload.proposalHash };
  const completed: CompletedWork = { obligationId: 'past-task', source, attestationIds: ['past-done'], recordedAt: NOW, evidenceAvailability: 'available' };
  publisher.book.entity.payload.attestations.push({ ...source, kind: 'task_report', id: 'past-done', operationId: 'done',
    obligationId: 'past-task', author: publisher.root.key, recordedAt: NOW, status: 'done', note: '' });
  const input: SolverInput = { projectRoot: ROOT, snapshot, publishers: [publisher], predecessor: proposal, predecessorSource: source,
    completedWork: [completed], recipe: { title: 'Remaining work', outcome: plan.outcome, instructions: '', timeZone: 'UTC', variants: [] } };
  function next(amount: number, start = NOW + 10, end = NOW + 20) {
    const candidate = structuredClone(plan);
    candidate.predecessor = source;
    candidate.variant.requirements[0] = { ...candidate.variant.requirements[0]!, id: 'remaining', title: 'Remaining work', quantity: amount, interval: { start, end } };
    candidate.allocations[0] = { ...candidate.allocations[0]!, id: 'remaining-allocation', requirementId: 'remaining', quantity: amount, interval: { start, end } };
    candidate.runbook[0] = { ...candidate.runbook[0]!, id: 'remaining-task', title: 'Remaining work', interval: { start, end }, allocationIds: ['remaining-allocation'] };
    input.recipe.variants = [candidate.variant];
    return candidate;
  }
  return { input, plan, proposal, source, completed, next };
}

function proposalRecord(key: `local:${string}`, plan: PlanDocument): EntityRecord<Proposal> {
  return localRecord(key, { protocol: 'partfolk/1', schemaVersion: 1, entityType: 'proposal', projectRoot: ROOT,
    operationId: key, createdAt: NOW, plan, proposalHash: hashPlan(plan), requirementsHash: hashRequirements(ROOT, plan.variant.requirements),
    changeExplanation: 'Test revision' }, coordinator);
}

describe('completed work occupies its original capacity during repair', () => {
  it('checks completed quantities in both search and an independently constructed candidate', () => {
    const { input, next } = fixture(3, 2);
    const tooMuch = next(2);
    const checked = independentlyValidatePlan(tooMuch, input.publishers, NOW, [], solverCompletedWorkContext(input));
    expect(checked.valid).toBe(false);
    expect(checked.reasons).toContainEqual(expect.objectContaining({ code: 'capacity_exceeded', resourceId: 'crew', params: { capacity: 3, required: 4 } }));
    expect(solve(input).status).toBe('impossible');
    const remainingCapacity = next(1);
    expect(independentlyValidatePlan(remainingCapacity, input.publishers, NOW, [], solverCompletedWorkContext(input)).valid).toBe(true);
    expect(solve(input).status).toBe('found');
  });

  it('allows the full resource in the next adjacent shift but rejects even a one-millisecond overlap', () => {
    const { input, next } = fixture(3, 3);
    const adjacent = next(3, NOW + 20, NOW + 30);
    expect(independentlyValidatePlan(adjacent, input.publishers, NOW, [], solverCompletedWorkContext(input)).valid).toBe(true);
    expect(solve(input).status).toBe('found');
    const overlapping = next(1, NOW + 19, NOW + 30);
    expect(independentlyValidatePlan(overlapping, input.publishers, NOW, [], solverCompletedWorkContext(input)).valid).toBe(false);
    expect(solve(input).status).toBe('impossible');
  });

  it('counts a completion once and does not add current-plan progress on top of its own allocation', () => {
    const { input, next, completed, plan } = fixture(3, 2);
    input.completedWork.push(structuredClone(completed));
    next(1);
    expect(solve(input).status).toBe('found');
    expect(independentlyValidatePlan(plan, input.publishers, NOW, [], solverCompletedWorkContext(input)).valid).toBe(true);
  });

  it('requires historical source terms after another revision and never turns missing evidence into free capacity', () => {
    const { input, next, proposal } = fixture(3, 2);
    const second = proposalRecord('local:second-proposal', next(1, NOW + 20, NOW + 30));
    input.predecessor = second;
    input.predecessorSource = { projectRoot: ROOT, activationKey: 'local:second-activation', proposalKey: second.key, proposalHash: second.payload.proposalHash };
    next(1);
    expect(solve(input)).toMatchObject({ status: 'unverified', candidates: [], reasons: [expect.objectContaining({ code: 'evidence_unavailable' })] });
    input.proposalHistory = [proposal];
    expect(solve(input).status).toBe('found');
    input.completedWork[0]!.evidenceAvailability = 'unavailable';
    const candidate = next(1);
    expect(solve(input).status).toBe('unverified');
    expect(independentlyValidatePlan(candidate, input.publishers, NOW, [], solverCompletedWorkContext(input)).reasons)
      .toContainEqual(expect.objectContaining({ code: 'evidence_unavailable' }));
  });
});
