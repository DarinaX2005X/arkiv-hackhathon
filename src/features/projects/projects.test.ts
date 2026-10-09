import { describe, expect, it } from 'vitest';
import { makeSmallWorksFixture, makeSmallWorksProject, SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, smallWorksRecords } from '../../domain/fixtures';
import { solve } from '../../domain/solver';
import { hashPlan } from '../../domain/canonical';
import { finalizePlan } from '../../domain/validation';
import { createMemoryStorage, createLocalRepository } from '../../data/local';
import { createOperationIntent } from '../../data/operations';
import { createAppRuntime } from '../../app/context';
import type { PlanDocument, ProjectAggregate, SolverResult } from '../../domain/types';
import { authorityFor, comparePlans, planCoverage, planningFingerprint, planningInput, projectStatus, publishPlanInput, replaceRecipeInput, restoreTerms, solverSummary } from './selectors';
import { createPlanningController } from './planning';
import { createProjectDrafts, draftFromRecipePacket, makeDraft } from './drafts';
import { validateEditorDraft } from './editor';
import { transferDutyFromDraft } from './PlanReview';

const authority = authorityFor(SMALL_WORKS_COORDINATOR, 'local', null)!;
const requireOk = <T,>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value;
};

describe('project consumer contracts', () => {
  it('uses the actual generic Small Works conflict and full Oak assignments', () => {
    const blocked = solve(makeSmallWorksFixture());
    expect(solverSummary(blocked)).toBe('impossible');
    expect(blocked.reasons.some(reason => reason.code === 'capacity_exceeded')).toBe(true);
    const project = makeSmallWorksProject({ oak: true });
    const result = solve(planningInput(project)!);
    expect(result.candidates.length).toBeGreaterThan(0);
    const plan = result.candidates[0]!.plan;
    const coverage = planCoverage(plan, project);
    expect(coverage.every(row => row.assigned === row.requirement.quantity && row.missing === 0)).toBe(true);
    expect(coverage.find(row => row.requirement.id === 'transport')?.names).toEqual(['Oak']);
    expect(result.candidates.every(candidate => candidate.plan.variant.id === 'sunday')).toBe(true);
  });

  it('shows real alternatives and keeps partial search separate from impossibility', () => {
    const project = makeSmallWorksProject({ oak: true, juniper: true });
    const result = solve(planningInput(project)!);
    expect(result.candidates.length).toBeGreaterThan(1);
    const comparison = comparePlans(result.candidates[0]!.plan, result.candidates[1]!.plan, project);
    expect(comparison.some(row => row.before !== row.after)).toBe(true);
    expect(solverSummary({ ...result, candidates: [], status: 'exhausted', exhausted: true, optimality: 'not_proven' })).toBe('exhausted');
    expect(solverSummary({ ...result, candidates: [], status: 'unverified' })).toBe('unverified');
  });

  it('retains newer inputs when an older async search finishes', async () => {
    let release: (result: SolverResult) => void = () => {};
    const controller = createPlanningController(() => new Promise(resolve => { release = resolve; }));
    const original = makeSmallWorksFixture({ oak: true });
    controller.update(original, []);
    const pending = controller.run();
    const edited = structuredClone(original); edited.recipe.outcome = 'A different exhibition outcome';
    controller.update(edited, []); release(solve(original)); await pending;
    expect(controller.getSnapshot().result).toBeNull();
    expect(controller.candidate()).toBeNull();
    expect(controller.getSnapshot().running).toBe(false);
  });

  it('exposes changed time, place, outcome, instructions and transfer duties even with unchanged names', () => {
    const project = makeSmallWorksProject({ oak: true });
    const plan = solve(planningInput(project)!).candidates[0]!.plan;
    const changed = structuredClone(plan);
    changed.outcome = 'A different outcome'; changed.variant.venueId = 'another-place'; changed.instructions = 'Different instructions';
    changed.variant.requirements[0]!.interval.start += 60_000;
    changed.runbook[0]!.instructions = 'A changed task instruction';
    const difference = comparePlans(plan, changed, project).filter(row => row.before !== row.after);
    expect(difference.map(row => row.id)).toEqual(expect.arrayContaining(['outcome', 'place', 'instructions', changed.variant.requirements[0]!.id, `duty:${changed.runbook[0]!.id}`]));
  });

  it('invalidates an execution result when partial progress changes its fingerprint salt', async () => {
    const input = makeSmallWorksFixture({ oak: true }), controller = createPlanningController();
    controller.update(input, [], 'partial-receipt-1'); await controller.run(); expect(controller.candidate()).not.toBeNull();
    controller.update(input, [], 'partial-receipt-2'); expect(controller.candidate()).toBeNull();
  });

  it('invalidates a selected result after a pin change but not an unchanged fresh read', async () => {
    const input = makeSmallWorksFixture({ oak: true });
    const controller = createPlanningController(); controller.update(input, []); await controller.run();
    expect(controller.candidate()).not.toBeNull();
    const fresh = structuredClone(input); fresh.snapshot.fetchedAt++; fresh.snapshot.blockTimestamp++;
    fresh.publishers.forEach(publisher => { publisher.snapshot.fetchedAt++; publisher.snapshot.blockTimestamp++; });
    controller.update(fresh, []); expect(controller.candidate()).not.toBeNull();
    controller.update(fresh, [{ requirementId: 'transport', publisherRoot: 'local:cedar', offerId: 'artwork-transport', quantity: 1 }]);
    expect(controller.candidate()).toBeNull(); expect(controller.getSnapshot().stale).toBe(true);
    expect(planningFingerprint(input, [])).toBe(planningFingerprint(fresh, []));
  });

  it('publishes exact candidate terms through the repository without importing decisions', async () => {
    const storage = createMemoryStorage(), repo = createLocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW });
    requireOk(repo.seed(smallWorksRecords({ oak: true })));
    const project = requireOk(await repo.loadProject('local:small-works'));
    const candidate = solve(planningInput(project)!).candidates[0]!;
    const fields = publishPlanInput(project, candidate, 'publish-one', SMALL_WORKS_NOW, 'First complete plan');
    const published = requireOk(await repo.publishPlan({ ...fields, operation: createOperationIntent('publish_plan', authority, fields, { id: 'publish-one', now: SMALL_WORKS_NOW }) }));
    expect(published.operation.phase).toBe('complete');
    const freshRepo = createLocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW });
    const fresh = requireOk(await freshRepo.loadProject('local:small-works'));
    const status = projectStatus(fresh, SMALL_WORKS_NOW);
    expect(status.readiness.status).toBe('awaiting_approval');
    expect(status.readiness.acceptedApprovers).toEqual([]);
    expect(fresh.proposal?.payload.proposalHash).toBe(candidate.proposalHash);
    expect(fresh.activation.status).toBe('unique');
  });

  it('separates edited needs from active agreement and restores with the current predecessor', async () => {
    const storage = createMemoryStorage(), repo = createLocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW });
    requireOk(repo.seed(smallWorksRecords({ oak: true })));
    let project = requireOk(await repo.loadProject('local:small-works'));
    const first = solve(planningInput(project)!).candidates[0]!;
    const p1 = publishPlanInput(project, first, 'p1', SMALL_WORKS_NOW, 'First');
    requireOk(await repo.publishPlan({ ...p1, operation: createOperationIntent('publish_plan', authority, p1, { id: 'p1', now: SMALL_WORKS_NOW }) }));
    project = requireOk(await repo.loadProject(project.root.key)); const firstProposal = project.proposal!;
    const recipe = structuredClone(project.state.status === 'unique' ? project.state.entity.payload.recipe : makeSmallWorksFixture().recipe);
    recipe.outcome = 'A revised project outcome';
    const edit = replaceRecipeInput(project, recipe, 'edit', SMALL_WORKS_NOW);
    requireOk(await repo.replaceProject({ ...edit, operation: createOperationIntent('replace_project', authority, edit, { id: 'edit', now: SMALL_WORKS_NOW }) }));
    project = requireOk(await repo.loadProject(project.root.key));
    expect(projectStatus(project, SMALL_WORKS_NOW).draft.changed).toBe(true);
    expect(project.proposal!.payload.plan.outcome).not.toBe(recipe.outcome);
    expect(() => publishPlanInput(project, first, 'bad', SMALL_WORKS_NOW, '')).toThrow();
    const second = solve(planningInput(project)!).candidates[0]!;
    const p2 = publishPlanInput(project, second, 'p2', SMALL_WORKS_NOW, 'Revised');
    requireOk(await repo.publishPlan({ ...p2, operation: createOperationIntent('publish_plan', authority, p2, { id: 'p2', now: SMALL_WORKS_NOW }) }));
    project = requireOk(await repo.loadProject(project.root.key));
    const restored = restoreTerms(project, firstProposal);
    expect(restored.predecessor?.proposalKey).toBe(project.proposal!.key);
    expect(restored.predecessor?.activationKey).toBe(project.activation.status === 'unique' ? project.activation.entity.key : null);
    expect(hashPlan(restored)).not.toBe(firstProposal.payload.proposalHash);
    expect(restored.outcome).toBe(firstProposal.payload.plan.outcome);
  });
});

describe('draft and transfer preservation', () => {
  it('round-trips invalid text and exact original dates without moving another account’s draft', () => {
    const memory = createMemoryStorage(), runtime = createAppRuntime({ storage: memory, now: () => SMALL_WORKS_NOW });
    const drafts = createProjectDrafts(runtime, 'local:local-actor:coordinator');
    const draft = makeDraft('local:local-actor:coordinator', makeSmallWorksFixture().recipe, SMALL_WORKS_NOW, 'draft-one');
    draft.editor.variants[0]!.requirements[0]!.quantity = 'not yet a number';
    expect(drafts.upsert(draft).persisted).toBe(true);
    const fresh = createProjectDrafts(createAppRuntime({ storage: memory, now: () => SMALL_WORKS_NOW }), draft.scope);
    expect(fresh.get('draft-one')?.editor.variants[0]!.requirements[0]!.quantity).toBe('not yet a number');
    expect(validateEditorDraft(fresh.get('draft-one')!.editor).valid).toBe(false);
    const other = createProjectDrafts(runtime, 'local:local-actor:oak');
    expect(other.list()).toEqual([]);
    expect(() => other.upsert(draft)).toThrow('different account');
    const imported = other.importDraft(fresh.exportDraft(draft));
    expect(imported.status).toBe('imported');
    if (imported.status === 'imported') { expect(imported.draft.id).not.toBe(draft.id); expect(imported.draft.scope).toBe('local:local-actor:oak'); }
  });

  it('keeps drafts exportable without claiming persistence when storage is blocked', () => {
    const runtime = createAppRuntime({ storage: null, now: () => SMALL_WORKS_NOW });
    const drafts = createProjectDrafts(runtime, 'local:visitor');
    const draft = makeDraft('local:visitor', makeSmallWorksFixture().recipe, SMALL_WORKS_NOW, 'unsaved');
    expect(drafts.upsert(draft).persisted).toBe(false);
    expect(drafts.status().persisted).toBe(false);
    expect(JSON.parse(drafts.exportDraft(draft)).payload.editor.title).toBe('Small Works');
    expect(createProjectDrafts(runtime, 'local:visitor').get('unsaved')?.editor.title).toBe('Small Works');
    expect(createProjectDrafts(runtime, 'local:local-actor:another').list()).toEqual([]);
  });

  it('imports only an undated recipe from a verification packet, never its root or decisions', () => {
    const project = makeSmallWorksProject({ oak: true });
    const imported = draftFromRecipePacket(JSON.stringify({ format: 'partfolk-export', version: 1, project, readiness: { status: 'ready' } }), 'local:visitor', SMALL_WORKS_NOW, 'copy');
    expect(imported?.projectRoot).toBeNull(); expect(imported?.baselineStateKey).toBeNull();
    expect(imported?.editor.sourceProjectRoot).toBe(project.root.key);
    expect(imported?.editor.variants.flatMap(variant => variant.requirements).every(requirement => requirement.startLocal === '' && requirement.endLocal === '')).toBe(true);
    expect(JSON.stringify(imported)).not.toContain('decisions');
  });

  it('adds explicit named transfer terms and rejects equal parties or fractional units', () => {
    const project = makeSmallWorksProject({ oak: true });
    const plan = solve(planningInput(project)!).candidates[0]!.plan;
    const allocation = plan.allocations.find(item => item.resourceId === 'boards')!;
    const draft = { kind: 'handover' as const, title: 'Hand over display boards', allocationId: allocation.id, giver: allocation.publisherRoot, receiver: 'local:cedar', quantity: '6',
      start: '2026-10-18T10:00', end: '2026-10-18T10:15', startOccurrence: 'reject' as const, endOccurrence: 'reject' as const, instructions: 'Both owners record their own statement.', dependsOn: [] };
    const duty = transferDutyFromDraft(draft, allocation, plan, 'one'); expect(duty.error).toBeNull();
    const next: PlanDocument = { ...plan, runbook: [...plan.runbook, duty.duty!] };
    const finalized = finalizePlan(next, project.publishers, project.snapshot);
    expect(finalized.ok).toBe(true);
    if (finalized.ok) { expect(finalized.value.plan.requiredApprovers).toContain('local:cedar'); expect(finalized.value.proposalHash).not.toBe(hashPlan(plan)); }
    expect(transferDutyFromDraft({ ...draft, receiver: draft.giver }, allocation, plan, 'bad').duty).toBeNull();
    expect(transferDutyFromDraft({ ...draft, quantity: '1.5' }, allocation, plan, 'bad').duty).toBeNull();
  });
});
