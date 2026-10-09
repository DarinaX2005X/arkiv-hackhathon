import { describe, expect, it } from 'vitest';
import { createLocalOperationIntent, createMemoryStorage, LocalRepository } from '../../../data/local';
import { SMALL_WORKS_NOW, smallWorksRecords } from '../../../domain/fixtures';
import { activeSource, deriveReadiness, sameSource, validateExactGrant } from '../../../domain/readiness';
import { solve } from '../../../domain/solver';
import type { BookState, EntityKey, ProjectAggregate, SourcePlanRef } from '../../../domain/types';
import { independentlyValidatePlan } from '../../../domain/validation';
import { loadGuidedPractice, runGuidedPracticeAction } from '../guided';

function setup() {
  const storage = createMemoryStorage();
  const fresh = () => new LocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW, logicalClock: true });
  const repository = fresh();
  const seeded = repository.seed(smallWorksRecords());
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  return { storage, fresh, repository };
}

function book(project: ProjectAggregate, root: EntityKey): BookState {
  const publisher = project.publishers.find(item => item.root.key === root);
  if (!publisher || publisher.book.status !== 'unique') throw new Error(`Expected one book for ${root}`);
  return publisher.book.entity.payload;
}

function namedRoot(project: ProjectAggregate, id: string): EntityKey {
  const publisher = project.publishers.find(item => item.root.payload.publisher.kind === 'local'
    && item.root.payload.publisher.id === `local-actor:${id}`);
  if (!publisher) throw new Error(`Expected the ${id} publisher`);
  return publisher.root.key;
}

function source(project: ProjectAggregate): SourcePlanRef {
  const value = activeSource(project);
  if (!value) throw new Error('Expected an active proposal');
  return value;
}

const readiness = (project: ProjectAggregate) => deriveReadiness(project, project.snapshot.blockTimestamp);

function expectExactAgreements(project: ProjectAggregate) {
  const current = source(project), plan = project.proposal!.payload.plan;
  expect(readiness(project).status).toBe('ready');
  expect([...readiness(project).acceptedApprovers].sort()).toEqual([...plan.requiredApprovers].sort());
  for (const root of plan.requiredApprovers) {
    const currentBook = book(project, root);
    const decisions = currentBook.decisions.filter(item => sameSource(item, current));
    const grants = currentBook.grants.filter(item => sameSource(item, current));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.status).toBe('accepted');
    expect(grants).toHaveLength(1);
    expect(grants[0]!.operationId).toBe(decisions[0]!.operationId);
    expect(validateExactGrant(grants[0]!, plan, current, root, project.snapshot.blockTimestamp)).toEqual([]);
  }
}

describe('persisted guided practice', () => {
  it('keeps custom work outside the guide and preserves manual changes to the sample', async () => {
    const { repository, storage } = setup();
    const custom = new LocalRepository({ storage, namespace: 'custom', now: () => SMALL_WORKS_NOW });
    const practiceBefore = storage.getItem(repository.storageKey);
    await expect(runGuidedPracticeAction(custom, 'add_oak', () => custom.currentTime())).rejects.toThrow('practice workspace');
    expect(storage.getItem(custom.storageKey)).toBeNull();
    expect(storage.getItem(repository.storageKey)).toBe(practiceBefore);
    const initial = await loadGuidedPractice(repository, () => repository.currentTime());
    if (initial.project.state.status !== 'unique' || initial.project.root.payload.coordinator.kind !== 'local') throw new Error('Expected sample state');
    const prior = initial.project.state.entity, now = repository.currentTime();
    const input = { projectRoot: initial.project.root.key, expectedHeads: [prior.key], lifetimeSeconds: 90 * 86_400,
      state: { ...prior.payload, operationId: 'manual-edit', createdAt: now, predecessorKeys: [prior.key],
        recipe: { ...prior.payload.recipe, title: 'My changed practice' } } };
    const changed = await repository.replaceProject({ ...input, operation: createLocalOperationIntent('replace_project',
      initial.project.root.payload.coordinator, input, { id: 'manual-edit', now }) });
    expect(changed.ok).toBe(true);
    const saved = storage.getItem(repository.storageKey);
    const resumed = await runGuidedPracticeAction(repository, 'add_oak', () => repository.currentTime());
    expect(resumed.stage).toBe('manual');
    expect(resumed.action).toBeNull();
    expect(storage.getItem(repository.storageKey)).toBe(saved);
  });

  it('moves a genuinely impossible project through owner agreement, withdrawal, repair and fresh agreement', async () => {
    const { fresh, repository } = setup();
    const initial = await loadGuidedPractice(repository, () => repository.currentTime());
    expect(initial.stage).toBe('blocked');
    expect(initial.action).toBe('add_oak');
    expect(initial.initialImpossible).toBe(true);
    expect(initial.project.proposal).toBeNull();
    expect(initial.project.publishers).toHaveLength(7);
    expect(initial.project.publishers.some(item => ['Oak', 'Juniper'].includes(book(initial.project, item.root.key).name))).toBe(false);
    if (initial.project.state.status !== 'unique') throw new Error('Expected project state');
    expect(solve({ projectRoot: initial.project.root.key, recipe: initial.project.state.entity.payload.recipe,
      publishers: initial.project.publishers, snapshot: initial.project.snapshot,
      predecessor: null, predecessorSource: null, completedWork: [] }).status).toBe('impossible');

    let client = fresh();
    const awaiting = await runGuidedPracticeAction(client, 'add_oak', () => client.currentTime());
    expect(awaiting.stage).toBe('awaiting_agreement');
    expect(awaiting.action).toBe('approve');
    expect(readiness(awaiting.project).status).toBe('awaiting_approval');
    expect(readiness(awaiting.project).acceptedApprovers).toEqual([]);
    const firstSource = source(awaiting.project), firstPlan = awaiting.project.proposal!.payload.plan;
    const oak = namedRoot(awaiting.project, 'oak');
    expect(firstPlan.variant.id).toBe('sunday');
    expect(firstPlan.allocations.filter(item => item.requirementId === 'transport').map(item => item.publisherRoot)).toEqual([oak]);
    expect(independentlyValidatePlan(firstPlan, awaiting.project.publishers, awaiting.project.snapshot.blockTimestamp).valid).toBe(true);
    const transfers = firstPlan.runbook.filter(item => item.kind !== 'task');
    expect(transfers.some(item => item.kind === 'handover')).toBe(true);
    expect(transfers.some(item => item.kind === 'return')).toBe(true);
    for (const transfer of transfers) {
      expect(transfer.giver).not.toBe(transfer.receiver);
      expect(firstPlan.requiredApprovers).toContain(transfer.giver);
      expect(firstPlan.requiredApprovers).toContain(transfer.receiver);
    }

    client = fresh();
    const ready = await runGuidedPracticeAction(client, 'approve', () => client.currentTime());
    expect(ready.stage).toBe('ready');
    expect(ready.action).toBe('withdraw_oak');
    expect(source(ready.project)).toEqual(firstSource);
    expectExactAgreements(ready.project);

    client = fresh();
    const changed = await runGuidedPracticeAction(client, 'withdraw_oak', () => client.currentTime());
    expect(changed.stage).toBe('changed');
    expect(changed.action).toBe('repair');
    expect(readiness(changed.project).status).toBe('changed');
    expect(readiness(changed.project).reasons).toContainEqual(expect.objectContaining({ code: 'withdrawn', publisherRoot: oak }));
    expect(source(changed.project)).toEqual(firstSource);
    expect(book(changed.project, oak).decisions.filter(item => sameSource(item, firstSource))).toEqual([
      expect.objectContaining({ status: 'withdrawn' }),
    ]);
    expect(book(changed.project, oak).grants.filter(item => sameSource(item, firstSource))).toEqual([]);

    client = fresh();
    const repair = await runGuidedPracticeAction(client, 'repair', () => client.currentTime());
    expect(repair.stage).toBe('repair_awaiting_agreement');
    expect(repair.action).toBe('approve');
    expect(readiness(repair.project).status).toBe('awaiting_approval');
    expect(readiness(repair.project).acceptedApprovers).toEqual([]);
    const repairedSource = source(repair.project), repairedPlan = repair.project.proposal!.payload.plan;
    expect(repairedSource.activationKey).not.toBe(firstSource.activationKey);
    expect(repairedSource.proposalHash).not.toBe(firstSource.proposalHash);
    expect(repairedPlan.predecessor).toEqual(firstSource);
    expect(repair.project.proposalHistory.map(item => item.key)).toEqual(expect.arrayContaining([firstSource.proposalKey, repairedSource.proposalKey]));
    expect(repairedPlan.requiredApprovers).not.toContain(oak);
    expect(repairedPlan.requiredApprovers).toContain(namedRoot(repair.project, 'juniper'));
    expect(repairedPlan.allocations.filter(item => item.requirementId === 'transport').map(item => item.publisherRoot)).toEqual([namedRoot(repair.project, 'cedar')]);
    expect(independentlyValidatePlan(repairedPlan, repair.project.publishers, repair.project.snapshot.blockTimestamp).valid).toBe(true);
    for (const root of repairedPlan.requiredApprovers) {
      expect(book(repair.project, root).decisions.filter(item => sameSource(item, repairedSource))).toEqual([]);
      expect(book(repair.project, root).grants.filter(item => sameSource(item, repairedSource))).toEqual([]);
    }
    // Publishing a repair preserves the original evidence without presenting it as new consent.
    for (const publisher of changed.project.publishers) {
      expect(book(repair.project, publisher.root.key).decisions).toEqual(book(changed.project, publisher.root.key).decisions);
      expect(book(repair.project, publisher.root.key).grants).toEqual(book(changed.project, publisher.root.key).grants);
    }

    client = fresh();
    const repaired = await runGuidedPracticeAction(client, 'approve', () => client.currentTime());
    expect(repaired.stage).toBe('repaired');
    expect(repaired.action).toBeNull();
    expect(source(repaired.project)).toEqual(repairedSource);
    expectExactAgreements(repaired.project);
    for (const root of repairedPlan.requiredApprovers.filter(item => firstPlan.requiredApprovers.includes(item))) {
      const previous = book(ready.project, root).decisions.find(item => sameSource(item, firstSource))!;
      const current = book(repaired.project, root).decisions.find(item => sameSource(item, repairedSource))!;
      expect(current.operationId).not.toBe(previous.operationId);
      expect(current.decidedAt).toBeGreaterThan(previous.decidedAt);
    }
    expect(book(repaired.project, oak).decisions.find(item => sameSource(item, firstSource))?.status).toBe('withdrawn');
  });

  it('derives every stage after reload and makes repeated completed actions durable no-ops', async () => {
    const { fresh, repository, storage } = setup();
    const seeded = storage.getItem(repository.storageKey);
    await loadGuidedPractice(repository, () => repository.currentTime());
    expect(storage.getItem(repository.storageKey)).toBe(seeded);
    const sequence = [
      ['add_oak', 'awaiting_agreement'],
      ['approve', 'ready'],
      ['withdraw_oak', 'changed'],
      ['repair', 'repair_awaiting_agreement'],
      ['approve', 'repaired'],
    ] as const;
    for (const [action, stage] of sequence) {
      const client = fresh();
      const state = await runGuidedPracticeAction(client, action, () => client.currentTime());
      expect(state.stage).toBe(stage);
      const saved = storage.getItem(client.storageKey);
      const reloaded = fresh();
      const current = await loadGuidedPractice(reloaded, () => reloaded.currentTime());
      expect(current.stage).toBe(stage);
      expect(current.action).toBe(state.action);
      expect(source(current.project)).toEqual(source(state.project));
      expect([...current.project.proposalHistory].sort((a, b) => a.key.localeCompare(b.key)))
        .toEqual([...state.project.proposalHistory].sort((a, b) => a.key.localeCompare(b.key)));
      expect(storage.getItem(client.storageKey)).toBe(saved);
      const repeated = await runGuidedPracticeAction(reloaded, action, () => reloaded.currentTime());
      expect(repeated.stage).toBe(stage);
      expect(source(repeated.project)).toEqual(source(state.project));
      expect(storage.getItem(client.storageKey)).toBe(saved);
    }
    const finalClient = fresh();
    const final = await loadGuidedPractice(finalClient, () => finalClient.currentTime());
    expect(final.project.proposalHistory).toHaveLength(2);
    expect(final.project.publishers).toHaveLength(9);
    expectExactAgreements(final.project);
  });
});
