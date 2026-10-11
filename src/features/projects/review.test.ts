import { describe, expect, it, vi } from 'vitest';
import { createAppRuntime } from '../../app/context';
import { createRepositoryActionController, validRepositoryActionRecord } from '../../app/actions';
import { routePath } from '../../app/routes';
import type { StoragePort } from '../../app/storage';
import { createLocalRepository, createMemoryStorage } from '../../data/local';
import { createOperationIntent } from '../../data/operations';
import { hashCanonical } from '../../domain/canonical';
import { makeSmallWorksFixture, SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, smallWorksRecords } from '../../domain/fixtures';
import { solve } from '../../domain/solver';
import { TIRAMISU_CHAIN_ID, type Actor } from '../../domain/types';
import { draftScope } from './drafts';
import { authorityFor, planningInput, publishPlanInput } from './selectors';
import { captureProjectContinuation, continueProjectPublication, createPlanReviewStore } from './review';

const A: Actor = { kind: 'wallet', address: '0xAa00000000000000000000000000000000000001' };
const B: Actor = { kind: 'wallet', address: '0xbb00000000000000000000000000000000000002' };
const PLAN = solve(makeSmallWorksFixture({ oak: true })).candidates[0]!.plan;
const DRAFT = { fingerprint: 'current-needs-and-offers', plan: PLAN, explanation: '  Deliver the artwork first.\nKeep the handover with its owners.  ' };
const SCOPE_A = draftScope('public', A), SCOPE_B = draftScope('public', B);
const PATH = routePath({ name: 'project', projectRoot: PLAN.projectRoot, tab: 'plans' });
const requireOk = <T,>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value;
};
function setup(storage: StoragePort | null = createMemoryStorage()) {
  const runtime = createAppRuntime({ storage, namespace: 'review-test', now: () => SMALL_WORKS_NOW });
  runtime.session.setMode('public'); runtime.session.setAccount(A, TIRAMISU_CHAIN_ID);
  runtime.session.navigate({ name: 'project', projectRoot: PLAN.projectRoot, tab: 'plans' });
  return runtime;
}

describe('account-owned plan review recovery', () => {
  it('restores the exact explanation and terms after disconnect, account swap and a new runtime', () => {
    const storage = createMemoryStorage(), runtime = setup(storage);
    const own = createPlanReviewStore(runtime, PLAN.projectRoot, SCOPE_A);
    expect(own.save(DRAFT).persisted).toBe(true);
    runtime.session.setAccount(null);
    expect(createPlanReviewStore(runtime, PLAN.projectRoot, 'public:visitor').getSnapshot().draft).toBeNull();
    runtime.session.setAccount(B, TIRAMISU_CHAIN_ID);
    expect(createPlanReviewStore(runtime, PLAN.projectRoot, SCOPE_B).getSnapshot().draft).toBeNull();
    expect(() => own.save({ ...DRAFT, explanation: 'Wrong account edit' })).toThrow('own this review');
    runtime.session.setAccount(A, TIRAMISU_CHAIN_ID);
    expect(createPlanReviewStore(runtime, PLAN.projectRoot, SCOPE_A).getSnapshot().draft).toEqual(DRAFT);
    const reopened = setup(storage);
    expect(createPlanReviewStore(reopened, PLAN.projectRoot, SCOPE_A).getSnapshot()).toMatchObject({ draft: DRAFT, persisted: true, issue: null });
  });

  it('reads a legacy saved review without overwriting its original record', () => {
    const storage = createMemoryStorage(), runtime = setup(storage);
    const key = `review-test:draft:plan-review:${hashCanonical({ projectRoot: PLAN.projectRoot, scope: SCOPE_A }).slice(2)}`;
    const original = JSON.stringify({ format: 'partfolk-draft', version: 1, kind: 'plan-review', updatedAt: SMALL_WORKS_NOW,
      payload: { fingerprint: DRAFT.fingerprint, plan: PLAN } });
    storage.setItem(key, original);
    const review = createPlanReviewStore(runtime, PLAN.projectRoot, SCOPE_A);
    expect(review.getSnapshot()).toMatchObject({ draft: { ...DRAFT, explanation: '' }, persisted: true, issue: null });
    expect(storage.getItem(key)).toBe(original);
    review.save(DRAFT);
    expect(createPlanReviewStore(setup(storage), PLAN.projectRoot, SCOPE_A).getSnapshot().draft).toEqual(DRAFT);
  });

  it('retains edited notes across same-runtime remounts when storage cannot save', () => {
    const runtime = setup(null), review = createPlanReviewStore(runtime, PLAN.projectRoot, SCOPE_A);
    expect(review.save(DRAFT)).toMatchObject({ persisted: false, issue: { code: 'unavailable' } });
    runtime.session.setAccount(null); runtime.session.navigate({ name: 'help', returnTo: PATH });
    runtime.session.setAccount(A, TIRAMISU_CHAIN_ID);
    runtime.session.navigate({ name: 'project', projectRoot: PLAN.projectRoot, tab: 'plans' });
    expect(createPlanReviewStore(runtime, PLAN.projectRoot, SCOPE_A).getSnapshot().draft).toEqual(DRAFT);
  });

  it('preserves malformed saved data while keeping a new review in memory', () => {
    const storage = createMemoryStorage(), runtime = setup(storage);
    const key = `review-test:draft:plan-review:${hashCanonical({ projectRoot: PLAN.projectRoot, scope: SCOPE_A }).slice(2)}`;
    storage.setItem(key, '{ original unreadable review');
    const review = createPlanReviewStore(runtime, PLAN.projectRoot, SCOPE_A);
    expect(review.save(DRAFT)).toMatchObject({ draft: DRAFT, persisted: false, issue: { code: 'recovery_required' } });
    expect(review.exportRecovery()).toBe('{ original unreadable review');
    expect(storage.getItem(key)).toBe('{ original unreadable review');
  });
});

describe('publication continuation belongs to its original page and account', () => {
  it.each(['unmounted', 'different-route', 'hash-before-session', 'disconnected', 'different-account', 'different-chain'] as const)('does not navigate after %s', async change => {
    const runtime = setup(); let mounted = true, visible = `#${PATH}`;
    const canContinue = captureProjectContinuation(runtime, () => mounted, () => visible);
    expect(canContinue()).toBe(true);
    if (change === 'unmounted') mounted = false;
    if (change === 'different-route') runtime.session.navigate({ name: 'workspace' });
    if (change === 'hash-before-session') visible = '#/workspace';
    if (change === 'disconnected') runtime.session.setAccount(null);
    if (change === 'different-account') runtime.session.setAccount(B, TIRAMISU_CHAIN_ID);
    if (change === 'different-chain') runtime.session.setAccount(A, 1);
    const refresh = vi.fn(async () => {}), navigate = vi.fn();
    await continueProjectPublication(canContinue, refresh, navigate);
    expect(refresh).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });

  it('checks again when a refresh finishes after an account change', async () => {
    const runtime = setup();
    const canContinue = captureProjectContinuation(runtime, () => true, () => PATH);
    let release!: () => void;
    const refreshed = new Promise<void>(resolve => { release = resolve; });
    const navigate = vi.fn();
    const pending = continueProjectPublication(canContinue, () => refreshed, navigate);
    runtime.session.setAccount(B, TIRAMISU_CHAIN_ID); release(); await pending;
    expect(navigate).not.toHaveBeenCalled();
  });

  it('continues normally from the same page after the fresh read completes', async () => {
    const runtime = setup(), calls: string[] = [];
    const canContinue = captureProjectContinuation(runtime, () => true, () => `#${PATH}`);
    await continueProjectPublication(canContinue, async () => { calls.push('refresh'); }, () => { calls.push('agreement'); });
    expect(calls).toEqual(['refresh', 'agreement']);
  });

  it('records a late confirmed publication without redirecting the new account or clearing its journal', async () => {
    const storage = createMemoryStorage(), repository = createLocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW });
    requireOk(repository.seed(smallWorksRecords({ oak: true })));
    const runtime = createAppRuntime({ repository, storage, now: () => SMALL_WORKS_NOW });
    runtime.session.setAccount(SMALL_WORKS_COORDINATOR);
    runtime.session.navigate({ name: 'project', projectRoot: PLAN.projectRoot, tab: 'plans' });
    const journal = runtime.drafts('test-original-publication', 'repository-action', validRepositoryActionRecord);
    const action = createRepositoryActionController({ repository, store: journal, getActor: () => runtime.session.getSnapshot().actor });
    const project = requireOk(await repository.loadProject(PLAN.projectRoot));
    const candidate = solve(planningInput(project)!).candidates[0]!;
    const authority = authorityFor(SMALL_WORKS_COORDINATOR, 'local', null)!;
    const fields = publishPlanInput(project, candidate, 'review-late-publication', SMALL_WORKS_NOW, DRAFT.explanation.trim());
    const command = { ...fields, operation: createOperationIntent('publish_plan', authority, fields, { id: 'review-late-publication', now: SMALL_WORKS_NOW }) };
    let release!: () => void;
    const submitted = new Promise<void>(resolve => { release = resolve; });
    const canContinue = captureProjectContinuation(runtime, () => true, () => PATH);
    const pending = action.run(command, async (repo, frozen) => { await submitted; return repo.publishPlan(frozen); });
    runtime.session.setAccount({ kind: 'local', id: 'local-actor:someone-else' });
    runtime.session.navigate({ name: 'workspace' });
    release(); const result = requireOk(await pending);
    expect(result.operation.phase).toBe('complete');
    const navigate = vi.fn();
    await continueProjectPublication(canContinue, async () => {}, navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(runtime.session.currentRoute()).toEqual({ name: 'workspace' });
    expect(action.getSnapshot().status).toBe('confirmed');
    const restored = createRepositoryActionController({ repository, store: journal, getActor: () => runtime.session.getSnapshot().actor });
    expect(restored.getSnapshot()).toMatchObject({ status: 'confirmed', operation: { id: command.operation.id, phase: 'complete' } });
  });
});
