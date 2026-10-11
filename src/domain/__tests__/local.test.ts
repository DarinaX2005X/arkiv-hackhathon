import { describe, expect, it } from 'vitest';
import { createLocalOperationIntent, createMemoryStorage, LocalRepository } from '../../data/local';
import type { LocalStorageLike } from '../../data/local';
import type { OperationKind, Result } from '../../data/types';
import { hashPlan, hashRequirements } from '../canonical';
import { prepareCloseProject, prepareDecision } from '../operations';
import { activeSource, deriveReadiness } from '../readiness';
import { deriveExecution } from '../execution';
import { SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, SMALL_WORKS_PROJECT_ROOT, smallWorksRecipe, smallWorksRecords } from '../fixtures';
import { finalizePlan, independentlyValidatePlan } from '../validation';
import { prepareProgressCommand, runbookRows } from '../../features/execution/model';
import type { ProgressInput } from '../../features/execution/model';
import { repairInput, solveRepair } from '../../features/execution/repair';
import { publishPlanInput } from '../../features/projects/selectors';
import { solve } from '../solver';
import { PROTOCOL } from '../types';
import type { Actor, BookState, EntityKey, EntityRecord, ProjectAggregate, ProjectRecipe, ProjectState, Proposal } from '../types';

const NOW = 1_900_000_000_000;
const owner = { kind: 'local', id: 'local-actor:organizer' } as const;
const partner = { kind: 'local', id: 'local-actor:partner' } as const;
const stranger = { kind: 'local', id: 'local-actor:stranger' } as const;
const lifetimeSeconds = 90 * 24 * 60 * 60;
const recipe: ProjectRecipe = {
  title: 'Custom exhibition', outcome: 'A small display', timeZone: 'UTC', instructions: 'Place a board safely.',
  variants: [{ id: 'morning', title: 'Morning', venueId: 'library', timeZone: 'UTC', instructions: '',
    requirements: [{ id: 'display', title: 'Display board', kind: 'equipment', capability: 'display', unit: 'board',
      quantity: 1, interval: { start: NOW + 60_000, end: NOW + 120_000 }, instructions: '', dependsOn: [] }] }],
};
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const actorCommand = <T extends object>(kind: OperationKind, actor: Extract<Actor, { kind: 'local' }>, input: T, id: string) => ({
  ...input, operation: createLocalOperationIntent(kind, actor, input, { id, now: NOW }),
});
const command = <T extends object>(kind: OperationKind, input: T, id: string) => actorCommand(kind, owner, input, id);
const currentState = (project: ProjectAggregate): EntityRecord<ProjectState> => {
  if (project.state.status !== 'unique') throw new Error('Expected unique project state');
  return project.state.entity;
};

function setup(storage: LocalStorageLike = createMemoryStorage()) {
  let serial = 0, now = NOW;
  const repo = new LocalRepository({ storage, now: () => now, id: () => `entity-${++serial}` });
  const fresh = () => new LocalRepository({ storage, now: () => now });
  return { repo, fresh, storage, advance: (milliseconds: number) => { now += milliseconds; } };
}

async function create(repo: LocalRepository, id = 'create-project') {
  return unwrap(await repo.createProject(command('create_project', { recipe, lifetimeSeconds }, id))).value;
}

async function participatingProject(storage?: LocalStorageLike) {
  const state = setup(storage);
  let project = await create(state.repo);
  const registered = unwrap(await state.fresh().registerPublisher(actorCommand('register_publisher', partner,
    { kind: 'organization' as const, name: 'Synthetic partner', description: 'Local test publisher', lifetimeSeconds }, 'register-partner'))).value;
  if (registered.book.status !== 'unique') throw new Error('Expected book');
  const publisherRoot = registered.root.key, originalBook = registered.book.entity;
  const book: BookState = { ...originalBook.payload, operationId: 'share-board', predecessorKeys: [originalBook.key],
    resources: [{ id: 'board', name: 'Board', kind: 'equipment', unit: 'board', capacity: 1,
      availability: [{ start: NOW, end: NOW + 180_000 }], capabilities: ['display'] }],
    offers: [{ id: 'board-offer', title: 'One board', resourceId: 'board', kind: 'equipment', unit: 'board', quantity: 1,
      capabilities: ['display'], availability: [{ start: NOW, end: NOW + 180_000 }], projectScope: [project.root.key], conditions: [], instructions: '' }] };
  unwrap(await state.fresh().shareOffer(actorCommand('share_offer', partner, { projectRoot: project.root.key, publisherRoot,
    expectedBookHeads: [originalBook.key], book, offerIds: ['board-offer'], lifetimeSeconds }, 'share-board')));
  const prior = currentState(project);
  const admitted: ProjectState = { ...prior.payload, operationId: 'admit-partner', predecessorKeys: [prior.key], publisherRoots: [publisherRoot] };
  unwrap(await state.repo.replaceProject(command('replace_project', { projectRoot: project.root.key, state: admitted, expectedHeads: [prior.key], lifetimeSeconds }, 'admit-partner')));
  project = unwrap(await state.fresh().loadProject(project.root.key));
  const result = solve({ projectRoot: project.root.key, recipe, publishers: project.publishers, snapshot: project.snapshot,
    predecessor: null, predecessorSource: null, completedWork: [] });
  if (result.status !== 'found') throw new Error(JSON.stringify(result));
  const plan = result.candidates[0]!.plan;
  const proposal: Proposal = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'proposal', operationId: 'publish-first', createdAt: NOW,
    projectRoot: project.root.key, requirementsHash: hashRequirements(project.root.key, plan.variant.requirements), proposalHash: hashPlan(plan), plan, changeExplanation: '' };
  return { ...state, project, publisherRoot, proposal };
}

async function activateFirst() {
  const state = await participatingProject();
  const published = unwrap(await state.repo.publishPlan(command('publish_plan', { projectRoot: state.project.root.key, proposal: state.proposal,
    expectedActivationHeads: [], requestPublisherRoots: [state.publisherRoot], lifetimeSeconds }, 'publish-first')));
  return { ...state, published, project: unwrap(await state.fresh().loadProject(state.project.root.key)) };
}

describe('LocalRepository durable owner protocol', () => {
  it('saves full-quantity sender corrections and a reconciled remaining transfer through complete local repository commands', async () => {
    const storage = createMemoryStorage();
    const fresh = () => new LocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW, logicalClock: true });
    const repo = fresh(); unwrap(repo.seed(smallWorksRecords({ oak: true })));
    let project = unwrap(await repo.loadProject(SMALL_WORKS_PROJECT_ROOT));
    const solved = solve({ projectRoot: project.root.key, recipe: smallWorksRecipe(), publishers: project.publishers,
      snapshot: project.snapshot, predecessor: null, predecessorSource: null, completedWork: [] });
    const plan = structuredClone(solved.candidates[0]!.plan), allocation = plan.allocations.find(item => item.resourceId === 'boards')!;
    const shared = { publisherRoot: allocation.publisherRoot, resourceId: allocation.resourceId, quantity: 6, unit: allocation.unit,
      allocationIds: [allocation.id], dependsOn: [], instructions: 'Count each transfer.' };
    plan.runbook.push({ ...shared, kind: 'handover', id: 'send', transferId: 'delivery', title: 'Deliver boards', giver: 'local:makerspace', receiver: 'local:cedar',
      interval: { start: allocation.interval.start, end: allocation.interval.start + 1 } },
    { ...shared, kind: 'return', id: 'return', transferId: 'return-delivery', title: 'Return boards', publisherRoot: 'local:cedar', giver: 'local:cedar', receiver: 'local:makerspace',
      interval: { start: allocation.interval.end - 1, end: allocation.interval.end } });
    const finalized = finalizePlan(plan, project.publishers, project.snapshot);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.reasons));
    if (SMALL_WORKS_COORDINATOR.kind !== 'local') throw new Error('fixture');
    const first = publishPlanInput(project, { ...solved.candidates[0]!, ...finalized.value }, 'initial-transfers', repo.currentTime(), 'Delivery and return.');
    unwrap(await repo.publishPlan({ ...first, operation: createLocalOperationIntent('publish_plan', SMALL_WORKS_COORDINATOR, first, { id: 'initial-transfers', now: repo.currentTime() }) }));
    async function progress(root: EntityKey, duty: string, input: ProgressInput, id: string) {
      const currentRepo = fresh(), current = unwrap(await currentRepo.loadProject(SMALL_WORKS_PROJECT_ROOT));
      const actor = current.publishers.find(publisher => publisher.root.key === root)!.root.payload.publisher;
      if (actor.kind !== 'local') throw new Error('fixture');
      const command = prepareProgressCommand(current, current.proposal!, activeSource(current)!, duty,
        { mode: 'local', actor, chainId: null }, input, currentRepo.currentTime(), id);
      unwrap(await currentRepo.replaceBook(command));
      return unwrap(await fresh().loadProject(SMALL_WORKS_PROJECT_ROOT));
    }
    await progress('local:makerspace', 'send', { kind: 'transfer_report', quantity: 6 }, 'reported-six');
    await progress('local:cedar', 'send', { kind: 'transfer_acknowledgement', reportId: 'report:reported-six', quantity: 2 }, 'received-two');
    project = await progress('local:makerspace', 'send', { kind: 'transfer_report', correctsReportId: 'report:reported-six', quantity: 4 }, 'correct-four');
    let row = runbookRows(project, project.proposal!, activeSource(project), null).find(item => item.obligation.id === 'send')!;
    expect(row).toMatchObject({ reportedQuantity: 4, acknowledgedQuantity: 0 });
    expect(row.historicalStatements.map(item => item.id)).toEqual(expect.arrayContaining(['report:reported-six', 'report:received-two']));
    expect(deriveExecution(project).outstandingCustodyHolds.map(hold => hold.quantity)).toEqual([4]);
    project = await progress('local:cedar', 'send', { kind: 'transfer_acknowledgement', reportId: 'report:correct-four', quantity: 2 }, 'still-two');
    expect(repairInput(project)).toBeNull();
    await progress('local:makerspace', 'send', { kind: 'transfer_report', correctsReportId: 'report:correct-four', quantity: 2 }, 'correct-two');
    project = await progress('local:cedar', 'send', { kind: 'transfer_acknowledgement', reportId: 'report:correct-two', quantity: 2 }, 'confirm-two');
    row = runbookRows(project, project.proposal!, activeSource(project), null).find(item => item.obligation.id === 'send')!;
    expect(row).toMatchObject({ reportedQuantity: 2, acknowledgedQuantity: 2 });
    const input = repairInput(project)!, candidate = solveRepair(project, input, [], { maxNodes: 100000, maxCandidates: 1 }).candidates[0]!;
    const replacement = publishPlanInput(project, candidate, 'remaining-transfers', fresh().currentTime(), 'Deliver the remaining four.', { sourceRecipe: input.recipe });
    unwrap(await fresh().publishPlan({ ...replacement, operation: createLocalOperationIntent('publish_plan', SMALL_WORKS_COORDINATOR, replacement, { id: 'remaining-transfers', now: fresh().currentTime() }) }));
    project = await progress('local:makerspace', 'send', { kind: 'transfer_report', quantity: 4 }, 'remaining-four');
    expect(deriveExecution(project).outstandingCustodyHolds.reduce((sum, hold) => sum + hold.quantity, 0)).toBe(6);
    await progress('local:cedar', 'send', { kind: 'transfer_acknowledgement', reportId: 'report:remaining-four', quantity: 4 }, 'received-four');
    await progress('local:cedar', 'return', { kind: 'transfer_report', quantity: 6 }, 'return-six');
    project = await progress('local:makerspace', 'return', { kind: 'transfer_acknowledgement', reportId: 'report:return-six', quantity: 6 }, 'confirm-return');
    expect(deriveExecution(project).outstandingCustodyHolds).toEqual([]);
    expect(deriveExecution(project).completed.map(work => work.obligationId)).toEqual(expect.arrayContaining(['send', 'return']));
    expect(independentlyValidatePlan(project.proposal!.payload.plan, project.publishers, project.snapshot.blockTimestamp).valid).toBe(true);
  });
  it('starts custom work empty, scopes directories to the actor and reloads independently', async () => {
    const { repo, fresh } = setup();
    expect(unwrap(await repo.listProjects(owner)).items).toEqual([]);
    const project = await create(repo);
    expect(currentState(project).payload.publisherRoots).toEqual([]);
    expect(project.publishers).toEqual([]);
    expect(unwrap(await fresh().listProjects(owner)).items.map(item => item.root.key)).toEqual([project.root.key]);
    expect(unwrap(await fresh().listProjects(stranger)).items).toEqual([]);
    expect(unwrap(await fresh().loadProject(project.root.key)).root.provenance.creator).toEqual(owner);
    expect(project.root.key).toMatch(/^local:/);
    expect(project.root.provenance.createdAtBlock).toBeNull();
    currentState(project).payload.recipe.title = 'Mutating a returned copy';
    expect(currentState(unwrap(await repo.loadProject(project.root.key))).payload.recipe.title).toBe(recipe.title);
  });

  it('rejects foreign owners and stale replacement without creating a successor', async () => {
    const { repo, fresh } = setup();
    const project = await create(repo), prior = currentState(project);
    const next: ProjectState = { ...prior.payload, operationId: 'next-state', predecessorKeys: [prior.key], recipe: { ...recipe, title: 'Edited' } };
    const input = { projectRoot: project.root.key, state: next, expectedHeads: [prior.key], lifetimeSeconds };
    const foreign = await fresh().replaceProject(actorCommand('replace_project', stranger,
      { ...input, state: { ...next, operationId: 'foreign-state' } }, 'foreign-state'));
    expect(foreign).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    const saved = unwrap(await repo.replaceProject(command('replace_project', input, 'next-state')));
    const staleInput = { ...input, state: { ...next, operationId: 'stale-state', recipe: { ...recipe, title: 'Stale' } } };
    expect(await fresh().replaceProject(command('replace_project', staleInput, 'stale-state'))).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(currentState(unwrap(await fresh().loadProject(project.root.key))).key).toBe(saved.value.key);
    expect(saved.receipt.consumedKeys).toEqual([prior.key]);
    expect(saved.value.key).not.toBe(prior.key);
  });

  it('reconciles one frozen operation and refuses changed commands or reused IDs', async () => {
    const { repo, fresh } = setup();
    const request = command('create_project', { recipe, lifetimeSeconds }, 'one-intent');
    const first = unwrap(await repo.createProject(request));
    const retry = unwrap(await fresh().createProject(request));
    expect(retry.receipt).toEqual(first.receipt);
    expect(unwrap(await fresh().listProjects(owner)).items).toHaveLength(1);
    expect(await repo.reconcile(request.operation)).toMatchObject({ ok: true, value: { status: 'confirmed', receipt: first.receipt } });
    expect(await repo.createProject({ ...request, recipe: { ...recipe, title: 'Changed behind frozen hash' } }))
      .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const changed = command('create_project', { recipe: { ...recipe, title: 'Another input' }, lifetimeSeconds }, 'one-intent');
    expect(await repo.createProject(changed)).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('keeps practice reset isolated and rejects wallet authority in local mode', async () => {
    const storage = createMemoryStorage(), custom = new LocalRepository({ storage, now: () => NOW });
    const practice = new LocalRepository({ storage, namespace: 'practice', now: () => NOW });
    const project = await create(custom), sample = await create(practice);
    expect(custom.resetPractice()).toMatchObject({ ok: false });
    expect(practice.resetPractice()).toEqual({ ok: true, value: undefined });
    expect(await practice.loadProject(sample.root.key)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect((await custom.loadProject(project.root.key)).ok).toBe(true);
    expect(await custom.listOwnPublishers({ kind: 'wallet', address: `0x${'1'.repeat(40)}` })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });

  it('preserves unsaved work, makes storage failure visible and confirms only after retry', async () => {
    const backing = createMemoryStorage(); let writes = 0, fail = true;
    const storage: LocalStorageLike = { ...backing, setItem: (key, value) => { writes++; if (writes === 2 && fail) throw new Error('Quota'); backing.setItem(key, value); } };
    const { repo, fresh } = setup(storage);
    const request = command('create_project', { recipe, lifetimeSeconds }, 'quota-project');
    expect(await repo.createProject(request)).toMatchObject({ ok: false, error: { code: 'storage' } });
    expect(repo.exportRecovery()).toContain(recipe.title);
    expect(await repo.listProjects(owner)).toMatchObject({ ok: false, error: { code: 'storage' } });
    expect(unwrap(await fresh().listProjects(owner)).items).toEqual([]);
    expect(await fresh().reconcile(request.operation)).toMatchObject({ ok: true, value: { status: 'not_sent' } });
    fail = false;
    expect(repo.retryPersistence()).toEqual({ ok: true, value: undefined });
    expect(unwrap(await fresh().listProjects(owner)).items).toHaveLength(1);
    expect(await fresh().reconcile(request.operation)).toMatchObject({ ok: true, value: { status: 'confirmed' } });
  });

  it('does not overwrite newer shared data when recovering unsaved memory', async () => {
    const backing = createMemoryStorage(); let writes = 0;
    const storage: LocalStorageLike = { ...backing, setItem: (key, value) => { if (++writes === 2) throw new Error('Quota'); backing.setItem(key, value); } };
    const { repo } = setup(storage);
    await repo.createProject(command('create_project', { recipe, lifetimeSeconds }, 'interrupted'));
    const independent = new LocalRepository({ storage: backing, now: () => NOW });
    await create(independent, 'other-project');
    expect(repo.retryPersistence()).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(unwrap(await independent.listProjects(owner)).items).toHaveLength(1);
  });

  it('preserves unsupported or malformed saved data for recovery without resetting it', async () => {
    const storage = createMemoryStorage(), repo = new LocalRepository({ storage });
    const unknown = '{"format":"partfolk-local","version":42,"future":"keep me"}';
    storage.setItem(repo.storageKey, unknown);
    expect(await repo.listProjects(owner)).toMatchObject({ ok: false, error: { code: 'storage' } });
    expect(repo.exportRecovery()).toBe(unknown);
    expect(storage.getItem(repo.storageKey)).toBe(unknown);
    storage.setItem(repo.storageKey, '{broken');
    expect(await repo.listProjects(owner)).toMatchObject({ ok: false, error: { code: 'storage' } });
    expect(repo.exportRecovery()).toBe('{broken');
  });

  it('discovers a previously unknown publisher and exact requests across independent clients', async () => {
    const { repo, fresh, project, publisherRoot } = await activateFirst();
    expect(unwrap(await fresh().listOwnPublishers(partner)).items.map(item => item.root.key)).toEqual([publisherRoot]);
    const incoming = unwrap(await fresh().listIncomingOffers(project.root.key));
    expect(incoming.items).toHaveLength(1);
    expect(incoming.items[0]).toMatchObject({ status: 'current', publisher: { root: { key: publisherRoot } } });
    const requests = unwrap(await fresh().listRequests(publisherRoot));
    expect(requests.items).toHaveLength(1);
    expect(requests.items[0]!.status).toBe('current');
    expect(deriveReadiness(project, NOW).status).toBe('awaiting_approval');
    const prepared = prepareDecision(project, publisherRoot, partner, { status: 'accepted', operationId: 'accept-first', now: NOW, validUntil: NOW + 180_000 });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    unwrap(await fresh().replaceBook(actorCommand('replace_book', partner, { ...prepared.value, publisherRoot, lifetimeSeconds }, 'accept-first')));
    expect(deriveReadiness(unwrap(await repo.loadProject(project.root.key)), NOW).status).toBe('ready');
    expect(unwrap(await fresh().exportPacket(project.root.key)).readiness.status).toBe('ready');
  });

  it('records decline and withdrawal durably without another publisher gaining authority', async () => {
    const { fresh, project, publisherRoot } = await activateFirst();
    expect(prepareDecision(project, publisherRoot, owner, { status: 'accepted', operationId: 'foreign', now: NOW, validUntil: NOW + 180_000 }).ok).toBe(false);
    for (const status of ['declined', 'accepted', 'withdrawn'] as const) {
      const current = unwrap(await fresh().loadProject(project.root.key)), id = `decision-${status}`;
      const prepared = prepareDecision(current, publisherRoot, partner, { status, operationId: id, now: NOW, validUntil: NOW + 180_000, reason: status });
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
      unwrap(await fresh().replaceBook(actorCommand('replace_book', partner, { ...prepared.value, publisherRoot, lifetimeSeconds }, id)));
      expect(deriveReadiness(unwrap(await fresh().loadProject(project.root.key)), NOW).status).toBe(status === 'accepted' ? 'ready' : status === 'declined' ? 'declined' : 'changed');
    }
  });

  it('resumes an interrupted request fanout using the already confirmed proposal and activation', async () => {
    const backing = createMemoryStorage(); let interrupt = false;
    const storage: LocalStorageLike = { ...backing, setItem: (key, value) => {
      const parsed = JSON.parse(value) as { records: Record<string, { entity: { payload: { entityType: string; linkKind?: string } } }> };
      if (interrupt && Object.values(parsed.records).some(entry => entry.entity.payload.entityType === 'project_link' && entry.entity.payload.linkKind === 'request')) {
        interrupt = false; throw new Error('Interrupted fanout persistence');
      }
      backing.setItem(key, value);
    } };
    const { repo, fresh, project, proposal, publisherRoot } = await participatingProject(storage);
    const request = command('publish_plan', { projectRoot: project.root.key, proposal, expectedActivationHeads: [],
      requestPublisherRoots: [publisherRoot], lifetimeSeconds }, 'publish-interrupted');
    interrupt = true;
    expect(await repo.publishPlan(request)).toMatchObject({ ok: false, error: { code: 'storage' } });
    const before = unwrap(await fresh().loadProject(project.root.key));
    expect(before.proposalHistory).toHaveLength(1);
    expect(before.activation.status).toBe('unique');
    expect(await fresh().reconcile(request.operation)).toMatchObject({ ok: true, value: { status: 'pending' } });
    const resumed = unwrap(await fresh().publishPlan(request));
    expect(resumed.proposalKey).toBe(before.proposal!.key);
    if (before.activation.status !== 'unique') throw new Error('Expected activation');
    expect(resumed.activationKey).toBe(before.activation.entity.key);
    expect(resumed.operation.steps).toHaveLength(3);
    expect(resumed.operation.steps.every(step => step.status === 'confirmed')).toBe(true);
    expect(unwrap(await fresh().listRequests(publisherRoot)).items).toHaveLength(1);
    expect(unwrap(await fresh().loadProject(project.root.key)).proposalHistory).toHaveLength(1);
    expect(await fresh().reconcile(request.operation)).toMatchObject({ ok: true, value: { status: 'confirmed' } });
  });

  it('deduplicates valid discovery hints and excludes a forged publisher author', async () => {
    const { repo, fresh, storage, project, publisherRoot } = await participatingProject();
    const first = unwrap(await fresh().listIncomingOffers(project.root.key)).items[0]!.entity;
    const duplicate = { ...first.payload, operationId: 'duplicate-hint' };
    unwrap(await repo.publishProjectLink(actorCommand('publish_project_link', partner, { link: duplicate, lifetimeSeconds }, 'duplicate-hint')));
    const envelope = JSON.parse(storage.getItem(repo.storageKey)!) as { records: Record<string, unknown> };
    envelope.records['local:forged-hint'] = { entity: { ...first, key: 'local:forged-hint',
      provenance: { ...first.provenance, creator: stranger, owner: stranger } }, expiresAt: NOW + 60_000 };
    storage.setItem(repo.storageKey, JSON.stringify(envelope));
    const inbox = unwrap(await fresh().listIncomingOffers(project.root.key));
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.publisher!.root.key).toBe(publisherRoot);
    expect(inbox.diagnostics).toContainEqual({ code: 'foreign_author' });
  });

  it('keeps active consent through a draft recipe edit and an unrelated offer edit', async () => {
    const { repo, fresh, project, publisherRoot } = await activateFirst();
    const accepted = prepareDecision(project, publisherRoot, partner, { status: 'accepted', operationId: 'accept-draft', now: NOW, validUntil: NOW + 180_000 });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.reasons));
    unwrap(await repo.replaceBook(actorCommand('replace_book', partner, { ...accepted.value, publisherRoot, lifetimeSeconds }, 'accept-draft')));
    const before = unwrap(await fresh().loadProject(project.root.key)), prior = currentState(before);
    const state = { ...prior.payload, operationId: 'edit-draft', predecessorKeys: [prior.key], recipe: { ...recipe, title: 'Draft title', instructions: 'Future instructions' } };
    unwrap(await repo.replaceProject(command('replace_project', { projectRoot: project.root.key, state, expectedHeads: [prior.key], lifetimeSeconds }, 'edit-draft')));
    const publisher = unwrap(await fresh().loadPublisher(publisherRoot));
    if (publisher.book.status !== 'unique') throw new Error('Expected book');
    const book = { ...publisher.book.entity.payload, operationId: 'edit-unselected', predecessorKeys: [publisher.book.entity.key],
      offers: [...publisher.book.entity.payload.offers, { ...publisher.book.entity.payload.offers[0]!, id: 'future-offer', title: 'An unselected offer' }] };
    unwrap(await repo.replaceBook(actorCommand('replace_book', partner, { publisherRoot, book, expectedHeads: [publisher.book.entity.key], lifetimeSeconds }, 'edit-unselected')));
    const after = unwrap(await fresh().loadProject(project.root.key));
    expect(after.activation).toEqual(before.activation);
    expect(after.proposal).toEqual(before.proposal);
    expect(deriveReadiness(after, NOW).status).toBe('ready');
  });

  it('requires exact current proposal lineage and consumes activation on terminal close', async () => {
    const { repo, fresh, project, publisherRoot, proposal } = await activateFirst();
    if (project.activation.status !== 'unique' || !project.proposal) throw new Error('Expected active proposal');
    const accepted = prepareDecision(project, publisherRoot, partner, { status: 'accepted', operationId: 'accept-replay', now: NOW, validUntil: NOW + 180_000 });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.reasons));
    unwrap(await repo.replaceBook(actorCommand('replace_book', partner, { ...accepted.value, publisherRoot, lifetimeSeconds }, 'accept-replay')));
    expect(deriveReadiness(unwrap(await fresh().loadProject(project.root.key)), NOW).status).toBe('ready');
    const firstActivation = project.activation.entity.key;
    const oldProposalKey = project.proposal.key;
    const predecessor = { projectRoot: project.root.key, activationKey: firstActivation, proposalKey: oldProposalKey, proposalHash: project.proposal.payload.proposalHash };
    const nextPlan = { ...proposal.plan, instructions: 'New agreed instructions', predecessor };
    const next: Proposal = { ...proposal, operationId: 'second-plan', plan: nextPlan, proposalHash: hashPlan(nextPlan) };
    const published = unwrap(await repo.publishPlan(command('publish_plan', { projectRoot: project.root.key, proposal: next,
      expectedActivationHeads: [firstActivation], requestPublisherRoots: [publisherRoot], lifetimeSeconds }, 'second-plan')));
    expect(published.activationKey).not.toBe(firstActivation);
    expect(await repo.activateProposal(command('activate_proposal', { projectRoot: project.root.key,
      expectedActivationHeads: [published.activationKey!], proposalKey: oldProposalKey, proposalHash: proposal.proposalHash, lifetimeSeconds }, 'reactivate-old')))
      .toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(unwrap(await fresh().listRequests(publisherRoot)).items.map(item => item.status).sort()).toEqual(['current', 'historical']);
    const oldTermsPlan = { ...proposal.plan, predecessor: { projectRoot: project.root.key,
      activationKey: published.activationKey!, proposalKey: published.proposalKey!, proposalHash: next.proposalHash } };
    const oldTerms: Proposal = { ...proposal, operationId: 'third-plan', plan: oldTermsPlan, proposalHash: hashPlan(oldTermsPlan) };
    const third = unwrap(await repo.publishPlan(command('publish_plan', { projectRoot: project.root.key, proposal: oldTerms,
      expectedActivationHeads: [published.activationKey!], requestPublisherRoots: [publisherRoot], lifetimeSeconds }, 'third-plan')));
    expect(third.activationKey).not.toBe(firstActivation);
    expect(third.proposalKey).not.toBe(oldProposalKey);
    expect(deriveReadiness(unwrap(await fresh().loadProject(project.root.key)), NOW).status).toBe('awaiting_approval');
    const current = unwrap(await fresh().loadProject(project.root.key));
    const close = prepareCloseProject(current, owner, { outcome: 'cancelled', statement: 'Cancelled explicitly', operationId: 'close', now: NOW });
    if (!close.ok) throw new Error(JSON.stringify(close.reasons));
    const result = unwrap(await repo.replaceProject(command('close_project', { ...close.value, projectRoot: project.root.key, lifetimeSeconds }, 'close')));
    expect(result.receipt.consumedKeys).toContain(third.activationKey);
    expect(unwrap(await fresh().loadProject(project.root.key)).activation.status).toBe('missing');
    const retained = unwrap(await fresh().loadPublisher(publisherRoot));
    if (retained.book.status !== 'unique') throw new Error('Expected retained book');
    expect(retained.book.entity.payload.grants).toHaveLength(1);
    expect(retained.book.entity.payload.grants[0]!.activationKey).toBe(firstActivation);
    const closed = unwrap(await fresh().loadProject(project.root.key)), closedState = currentState(closed);
    const reopened: ProjectState = { ...closedState.payload, operationId: 'reopen', lifecycle: 'planning', predecessorKeys: [closedState.key] };
    unwrap(await repo.replaceProject(command('replace_project', { projectRoot: project.root.key, state: reopened, expectedHeads: [closedState.key], lifetimeSeconds }, 'reopen')));
    const restartPlan = { ...proposal.plan, predecessor: closedState.payload.completion!.source };
    const restartProposal: Proposal = { ...proposal, operationId: 'restart', plan: restartPlan, proposalHash: hashPlan(restartPlan) };
    const restarted = unwrap(await repo.publishPlan(command('publish_plan', { projectRoot: project.root.key, proposal: restartProposal,
      expectedActivationHeads: [], requestPublisherRoots: [publisherRoot], lifetimeSeconds }, 'restart')));
    expect(restarted.activationKey).not.toBe(firstActivation);
    expect(restarted.activationKey).not.toBe(third.activationKey);
    expect(deriveReadiness(unwrap(await fresh().loadProject(project.root.key)), NOW).status).toBe('awaiting_approval');
  });

  it('reports missing proposal history separately from the current agreement snapshot', async () => {
    const { repo, fresh, storage, project, publisherRoot, proposal } = await activateFirst();
    if (project.activation.status !== 'unique' || !project.proposal) throw new Error('Expected active proposal');
    const oldKey = project.proposal.key;
    const nextPlan = { ...proposal.plan, predecessor: { projectRoot: project.root.key, activationKey: project.activation.entity.key,
      proposalKey: oldKey, proposalHash: project.proposal.payload.proposalHash } };
    const next: Proposal = { ...proposal, operationId: 'history-next', plan: nextPlan, proposalHash: hashPlan(nextPlan) };
    unwrap(await repo.publishPlan(command('publish_plan', { projectRoot: project.root.key, proposal: next,
      expectedActivationHeads: [project.activation.entity.key], requestPublisherRoots: [publisherRoot], lifetimeSeconds }, 'history-next')));
    const saved = JSON.parse(storage.getItem(repo.storageKey)!) as { records: Record<string, { expiresAt: number }> };
    saved.records[oldKey]!.expiresAt = NOW;
    storage.setItem(repo.storageKey, JSON.stringify(saved));
    const loaded = unwrap(await fresh().loadProject(project.root.key));
    expect(loaded.proposalHistoryStatus).toMatchObject({ complete: false, reasons: [{ code: 'evidence_unavailable' }] });
    expect(loaded.snapshot.completeness).toBe('complete');
    expect(deriveReadiness(loaded, NOW).status).toBe('awaiting_approval');
  });

  it('recovers a missing book only explicitly under the same live owner root, with empty consent', async () => {
    const { repo, fresh, advance } = setup();
    const registered = unwrap(await repo.registerPublisher(actorCommand('register_publisher', partner,
      { kind: 'organization' as const, name: 'Partner', description: '', lifetimeSeconds: 10 }, 'temporary-publisher'))).value;
    if (registered.book.status !== 'unique') throw new Error('Expected book');
    unwrap(await repo.renewEntity(actorCommand('renew_entity', partner, { entityKey: registered.root.key, extendBySeconds: 100, lifetimeSeconds }, 'renew-root')));
    advance(11_000);
    const publisher = unwrap(await fresh().loadPublisher(registered.root.key));
    expect(publisher.book.status).toBe('missing');
    const book = { ...registered.book.entity.payload, operationId: 'recover-book', createdAt: NOW + 11_000, predecessorKeys: [] };
    const input = { publisherRoot: registered.root.key, expectedHeads: [], book, lifetimeSeconds };
    expect(await repo.replaceBook(actorCommand('replace_book', partner, input, 'missing-no-recovery'))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    unwrap(await repo.replaceBook(actorCommand('replace_book', partner, { ...input,
      recovery: { acknowledgedMissingState: true as const, redeclaredAvailability: true as const } }, 'recover-book')));
    const recovered = unwrap(await fresh().loadPublisher(registered.root.key));
    expect(recovered.root.key).toBe(registered.root.key);
    expect(recovered.book).toMatchObject({ status: 'unique', entity: { payload: { grants: [], decisions: [], offers: [] } } });
  });
});
