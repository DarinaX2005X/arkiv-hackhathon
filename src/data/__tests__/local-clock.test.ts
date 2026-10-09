import { describe, expect, it } from 'vitest';
import { hashPlan, hashRequirements } from '../../domain/canonical';
import { deriveExecution } from '../../domain/execution';
import { SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, SMALL_WORKS_PROJECT_ROOT, smallWorksRecipe, smallWorksRecords } from '../../domain/fixtures';
import { prepareAttestation } from '../../domain/operations';
import { activeSource } from '../../domain/readiness';
import { solve } from '../../domain/solver';
import { PROTOCOL } from '../../domain/types';
import type { Attestation, Proposal } from '../../domain/types';
import { createLocalOperationIntent, createMemoryStorage, LocalRepository } from '../local';
import type { Result } from '../types';

const NOW = SMALL_WORKS_NOW;
const lifetimeSeconds = 90 * 24 * 60 * 60;
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe('LocalRepository opt-in logical clock', () => {
  it('keeps task reports visible on fresh reads and permits corrections after reloading practice', async () => {
    const storage = createMemoryStorage();
    const fresh = () => new LocalRepository({ storage, namespace: 'practice', now: () => NOW, logicalClock: true });
    const repo = fresh();
    unwrap(repo.seed(smallWorksRecords({ oak: true })));
    let project = unwrap(await repo.loadProject(SMALL_WORKS_PROJECT_ROOT));
    const solved = solve({ projectRoot: project.root.key, recipe: smallWorksRecipe(), publishers: project.publishers,
      snapshot: project.snapshot, predecessor: null, predecessorSource: null, completedWork: [] });
    if (solved.status !== 'found') throw new Error(JSON.stringify(solved));
    const plan = solved.candidates[0]!.plan, now = repo.currentTime();
    const proposal: Proposal = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'proposal', operationId: 'publish-clock',
      createdAt: now, projectRoot: project.root.key, plan, proposalHash: hashPlan(plan),
      requirementsHash: hashRequirements(project.root.key, plan.variant.requirements), changeExplanation: '' };
    const publish = { projectRoot: project.root.key, proposal, expectedActivationHeads: [],
      requestPublisherRoots: plan.requiredApprovers, lifetimeSeconds };
    if (SMALL_WORKS_COORDINATOR.kind !== 'local') throw new Error('Expected local coordinator');
    unwrap(await repo.publishPlan({ ...publish,
      operation: createLocalOperationIntent('publish_plan', SMALL_WORKS_COORDINATOR, publish, { id: 'publish-clock', now }) }));
    project = unwrap(await repo.loadProject(project.root.key));
    const source = activeSource(project), task = plan.runbook.find(item => item.kind === 'task' && !item.dependsOn.length);
    if (!source || !task) throw new Error('Expected active task');
    const author = project.publishers.find(item => item.root.key === task.publisherRoot)!.root.payload.publisher;
    if (author.kind !== 'local') throw new Error('Expected local publisher');
    const done: Attestation = { ...source, id: 'task-done', operationId: 'task-done', kind: 'task_report',
      author: task.publisherRoot, obligationId: task.id, recordedAt: repo.currentTime(), status: 'done', note: 'Completed' };
    const prepared = prepareAttestation(project, task.publisherRoot, author, done);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    const input = { ...prepared.value, publisherRoot: task.publisherRoot, lifetimeSeconds };
    unwrap(await repo.replaceBook({ ...input,
      operation: createLocalOperationIntent('replace_book', author, input, { id: done.operationId, now: repo.currentTime() }) }));
    project = unwrap(await repo.loadProject(project.root.key));
    expect(project.snapshot.blockTimestamp).toBeGreaterThan(done.recordedAt);
    expect(deriveExecution(project).completed.map(item => item.obligationId)).toContain(task.id);
    expect(deriveExecution(project).reasons).not.toContainEqual(expect.objectContaining({ code: 'attestation_mismatch' }));

    const reloaded = fresh();
    project = unwrap(await reloaded.loadProject(project.root.key));
    const correction: Attestation = { ...done, id: 'task-correction', operationId: 'task-correction',
      recordedAt: reloaded.currentTime(), correctsAttestationId: done.id, status: 'not_done', note: 'Correction' };
    expect(correction.recordedAt).toBeGreaterThan(done.recordedAt);
    const corrected = prepareAttestation(project, task.publisherRoot, author, correction);
    if (!corrected.ok) throw new Error(JSON.stringify(corrected.reasons));
    const correctedInput = { ...corrected.value, publisherRoot: task.publisherRoot, lifetimeSeconds };
    unwrap(await reloaded.replaceBook({ ...correctedInput,
      operation: createLocalOperationIntent('replace_book', author, correctedInput,
        { id: correction.operationId, now: reloaded.currentTime() }) }));
    const final = unwrap(await fresh().loadProject(project.root.key));
    expect(final.snapshot.blockTimestamp).toBeGreaterThan(correction.recordedAt);
    expect(deriveExecution(final).completed.map(item => item.obligationId)).not.toContain(task.id);
    expect(deriveExecution(final).reasons).not.toContainEqual(expect.objectContaining({ code: 'attestation_mismatch' }));
  });

  it('refreshes durable event times across clients without advancing to future schedules or expiry', async () => {
    const storage = createMemoryStorage();
    const repo = new LocalRepository({ storage, namespace: 'practice', now: () => NOW, logicalClock: true });
    const records = smallWorksRecords();
    records[0]!.payload.createdAt = NOW + 10_000;
    unwrap(repo.seed(records));
    const time = repo.currentTime();
    expect(time).toBe(NOW + 10_001);
    const other = new LocalRepository({ storage, namespace: 'practice', now: () => NOW, logicalClock: true });
    const draft = unwrap(other.prepareProjectDraft(smallWorksRecipe()));
    expect(repo.currentTime()).toBeGreaterThan(draft.updatedAt);
    const project = unwrap(await other.loadProject(SMALL_WORKS_PROJECT_ROOT));
    expect(project.snapshot.blockTimestamp).toBeLessThan(smallWorksRecipe().variants[0]!.requirements[0]!.interval.start);
    expect(project.root.key).toBe(SMALL_WORKS_PROJECT_ROOT);
  });

  it('preserves configured wallclock behavior when the logical clock is not enabled', async () => {
    let now = NOW;
    const repo = new LocalRepository({ now: () => now });
    expect(repo.currentTime()).toBe(NOW);
    expect(repo.currentTime()).toBe(NOW);
    expect(unwrap(await repo.listProjects(SMALL_WORKS_COORDINATOR)).snapshot.blockTimestamp).toBe(NOW);
    now -= 100;
    expect(repo.currentTime()).toBe(NOW - 100);
  });

  it('surfaces corrupt durable storage instead of substituting a practice timestamp', async () => {
    const storage = createMemoryStorage();
    const repo = new LocalRepository({ storage, namespace: 'practice', now: () => NOW, logicalClock: true });
    expect(repo.currentTime()).toBe(NOW + 1);
    storage.setItem(repo.storageKey, '{broken');
    expect(() => repo.currentTime()).toThrow('Saved local data is malformed');
    expect(await repo.listProjects(SMALL_WORKS_COORDINATOR)).toMatchObject({ ok: false, error: { code: 'storage' } });
    expect(repo.exportRecovery()).toBe('{broken');
    expect(storage.getItem(repo.storageKey)).toBe('{broken');
  });
});
