import { canonicalJson } from '../../domain/canonical';
import { makeSmallWorksFixture, SMALL_WORKS_COORDINATOR, SMALL_WORKS_PROJECT_ROOT, smallWorksRecipe } from '../../domain/fixtures';
import { prepareDecision } from '../../domain/operations';
import { activeSource, deriveReadiness, lastAcceptedDuty, sameActor, sameSource } from '../../domain/readiness';
import { solve } from '../../domain/solver';
import { finalizePlan } from '../../domain/validation';
import { completedWorkContext } from '../../domain/execution';
import { PROTOCOL } from '../../domain/types';
import type { Actor, BookState, EntityKey, PlanDocument, ProjectAggregate, Proposal, PublisherAggregate, SolverPin } from '../../domain/types';
import { createLocalOperationIntent, LocalRepository } from '../../data/local';
import type { OperationKind, Result } from '../../data/types';

export type GuidedAction = 'add_oak' | 'approve' | 'withdraw_oak' | 'repair';
export type GuidedStage = 'blocked' | 'awaiting_agreement' | 'ready' | 'changed' | 'repair_awaiting_agreement' | 'repaired' | 'manual';
export interface GuidedPracticeState {
  project: ProjectAggregate; stage: GuidedStage; action: GuidedAction | null;
  names: string[]; changes: string[]; initialImpossible: boolean;
}
const lifetimeSeconds = 90 * 86_400;
const sampleActors = new Set(['library', 'courtyard', 'makerspace', 'cedar', 'willow', 'ash', 'elm', 'oak', 'juniper']);
const root = (id: string): EntityKey => `local:${id}`;
const actor = (id: string): Extract<Actor, { kind: 'local' }> => ({ kind: 'local', id: `local-actor:${id}` });
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.code === 'storage'
    ? 'The sample could not be saved or read. Your existing records are kept. Try a fresh read before continuing.'
    : 'The sample changed while this step was running. Read it again and continue from its saved state.');
  return result.value;
};
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const operationId = (step: string, now: number) => `guided-${step}-${now}`;
function command<T extends object>(kind: OperationKind, owner: Extract<Actor, { kind: 'local' }>, input: T, id: string, now: number) {
  return { ...input, operation: createLocalOperationIntent(kind, owner, input, { id, now }) };
}
function coordinator(): Extract<Actor, { kind: 'local' }> {
  ensure(SMALL_WORKS_COORDINATOR.kind === 'local', 'The sample coordinator is unavailable.');
  return SMALL_WORKS_COORDINATOR;
}
function checkedRepository(repository: LocalRepository): void {
  ensure(repository.mode === 'local' && repository.namespace === 'practice', 'The guided sample only runs in the practice workspace.');
}
async function read(repository: LocalRepository): Promise<ProjectAggregate> {
  checkedRepository(repository);
  const project = unwrap(await repository.loadProject(SMALL_WORKS_PROJECT_ROOT));
  ensure(sameActor(project.root.payload.coordinator, coordinator()), 'This project has a different coordinator. Continue in the full project.');
  return project;
}
function sampleOwner(publisher: PublisherAggregate): Extract<Actor, { kind: 'local' }> {
  const owner = publisher.root.payload.publisher;
  ensure(owner.kind === 'local' && owner.id.startsWith('local-actor:') && sampleActors.has(owner.id.slice('local-actor:'.length))
    && sameActor(owner, publisher.root.provenance.creator) && sameActor(owner, publisher.root.provenance.owner),
  'This contributor is outside the guided sample. Continue with their decision in the full project.');
  return owner;
}
function publisherName(project: ProjectAggregate, key: EntityKey): string {
  const publisher = project.publishers.find(item => item.root.key === key);
  return publisher?.book.status === 'unique' ? publisher.book.entity.payload.name : 'A contributor';
}
function assignments(project: ProjectAggregate): string[] {
  const plan = project.proposal?.payload.plan;
  if (!plan) return [];
  return ['transport', 'installation', 'hosting'].map(id => {
    const requirement = plan.variant.requirements.find(item => item.id === id);
    const names = [...new Set(plan.allocations.filter(item => item.requirementId === id).map(item => publisherName(project, item.publisherRoot)))];
    return requirement && names.length ? `${requirement.title}: ${names.join(' and ')}` : '';
  }).filter(Boolean);
}

/** Read-only stage derivation: opening the guide never resets the sample or authors consent. */
export async function loadGuidedPractice(repository: LocalRepository, now: () => number): Promise<GuidedPracticeState> {
  const project = await read(repository), state = project.state;
  const result: GuidedPracticeState = { project, stage: 'manual', action: null, names: [], changes: assignments(project), initialImpossible: false };
  if (state.status !== 'unique' || state.entity.payload.lifecycle === 'closed'
    || canonicalJson(state.entity.payload.recipe) !== canonicalJson(smallWorksRecipe())) return result;
  if (!project.proposal && project.activation.status === 'missing') {
    const solved = solve({ projectRoot: project.root.key, recipe: state.entity.payload.recipe, publishers: project.publishers,
      snapshot: project.snapshot, predecessor: null, predecessorSource: null, completedWork: state.entity.payload.completedWork });
    result.initialImpossible = solved.status === 'impossible';
    return { ...result, stage: 'blocked', action: 'add_oak' };
  }
  const plan = project.proposal?.payload.plan, source = activeSource(project);
  if (!plan || !source || plan.variant.id !== 'sunday') return result;
  const initial = plan.allocations.some(item => item.requirementId === 'transport' && item.publisherRoot === root('oak'));
  const repaired = !initial && plan.allocations.some(item => item.requirementId === 'transport' && item.publisherRoot === root('cedar'))
    && plan.allocations.some(item => item.requirementId === 'installation' && item.publisherRoot === root('juniper'));
  if (!initial && !repaired) return result;
  const readiness = deriveReadiness(project, now());
  result.names = plan.requiredApprovers.map(key => publisherName(project, key));
  if (readiness.status === 'ready') return { ...result, stage: repaired ? 'repaired' : 'ready', action: repaired ? null : 'withdraw_oak' };
  const oak = project.publishers.find(item => item.root.key === root('oak'));
  const withdrew = oak?.book.status === 'unique' && oak.book.entity.payload.decisions.some(item => sameSource(item, source) && item.status === 'withdrawn');
  if (initial && withdrew && readiness.status === 'changed') return { ...result, stage: 'changed', action: 'repair' };
  if (readiness.status === 'awaiting_approval') return { ...result,
    stage: repaired ? 'repair_awaiting_agreement' : 'awaiting_agreement', action: 'approve' };
  return result;
}

async function addContributor(repository: LocalRepository, id: 'oak' | 'juniper', now: () => number): Promise<void> {
  const template = makeSmallWorksFixture({ oak: true, juniper: true }).publishers.find(item => item.root.key === root(id))!;
  ensure(template.book.status === 'unique', 'The sample offer is unavailable.');
  let loaded = await repository.loadPublisher(root(id));
  if (!loaded.ok) {
    ensure(loaded.error.code === 'not_found', 'The saved sample contributor could not be read.');
    const time = now(), operation = operationId(`register-${id}`, time);
    const input = { rootKey: root(id), kind: template.root.payload.kind, name: template.book.entity.payload.name,
      description: 'A fictional contributor for practice on this device.', lifetimeSeconds };
    unwrap(await repository.registerPublisher(command('register_publisher', actor(id), input, operation, time)));
    loaded = await repository.loadPublisher(root(id));
  }
  const publisher = unwrap(loaded);
  ensure(sameActor(sampleOwner(publisher), actor(id)) && publisher.book.status === 'unique', 'The saved sample contributor needs a check.');
  const current = publisher.book.entity, material = template.book.entity.payload;
  if (!current.payload.resources.length && !current.payload.offers.length && !current.payload.grants.length && !current.payload.decisions.length) {
    const time = now(), operation = operationId(`offer-${id}`, time);
    const book: BookState = { ...current.payload, operationId: operation, createdAt: time, predecessorKeys: [current.key],
      resources: material.resources, offers: material.offers.map(offer => ({ ...offer, projectScope: [SMALL_WORKS_PROJECT_ROOT] })) };
    const input = { projectRoot: SMALL_WORKS_PROJECT_ROOT, publisherRoot: publisher.root.key, expectedBookHeads: [current.key],
      book, offerIds: book.offers.map(offer => offer.id), lifetimeSeconds };
    unwrap(await repository.shareOffer(command('share_offer', actor(id), input, operation, time)));
  }
  const project = await read(repository);
  ensure(project.state.status === 'unique', 'The sample project needs a fresh read.');
  if (project.state.entity.payload.publisherRoots.includes(publisher.root.key)) return;
  const prior = project.state.entity, time = now(), operation = operationId(`admit-${id}`, time);
  const state = { ...prior.payload, operationId: operation, createdAt: time, predecessorKeys: [prior.key],
    publisherRoots: [...prior.payload.publisherRoots, publisher.root.key] };
  const input = { projectRoot: project.root.key, state, expectedHeads: [prior.key], lifetimeSeconds };
  unwrap(await repository.replaceProject(command('replace_project', coordinator(), input, operation, time)));
}

async function prepareEquipment(repository: LocalRepository, now: () => number): Promise<void> {
  const publisher = unwrap(await repository.loadPublisher(root('makerspace')));
  ensure(publisher.book.status === 'unique', 'The Makerspace offer needs a fresh read.');
  const owner = sampleOwner(publisher), current = publisher.book.entity;
  const windows = [17, 18].map(day => ({ start: Date.parse(`2026-10-${day}T08:30:00.000Z`), end: Date.parse(`2026-10-${day}T15:30:00.000Z`) }));
  const resources = current.payload.resources.map(item => ({ ...item, availability: windows }));
  const offers = current.payload.offers.map(item => ({ ...item, availability: item.id === 'boards-saturday' ? [windows[0]!]
    : item.id === 'boards-sunday' ? [windows[1]!] : windows }));
  if (canonicalJson(resources) === canonicalJson(current.payload.resources) && canonicalJson(offers) === canonicalJson(current.payload.offers)) return;
  ensure(!current.payload.grants.length && !current.payload.attestations.length && !current.payload.custodyHolds.length,
    'The equipment already has commitments. Continue with its owner in the full project.');
  const time = now(), operation = operationId('equipment', time);
  const book = { ...current.payload, operationId: operation, createdAt: time, predecessorKeys: [current.key], resources, offers };
  const input = { publisherRoot: publisher.root.key, expectedHeads: [current.key], book, lifetimeSeconds };
  unwrap(await repository.replaceBook(command('replace_book', owner, input, operation, time)));
}

function withEquipmentTransfers(plan: PlanDocument): PlanDocument {
  const result = structuredClone(plan), maker = root('makerspace'), library = root('library');
  for (const allocation of result.allocations.filter(item => item.publisherRoot === maker && ['boards', 'kit'].includes(item.resourceId))) {
    const requirement = result.variant.requirements.find(item => item.id === allocation.requirementId)!;
    const handoverId = `guided-handover-${allocation.resourceId}`, returnId = `guided-return-${allocation.resourceId}`;
    result.runbook.push({ kind: 'handover', id: handoverId, transferId: `${allocation.resourceId}:out`, title: `Makerspace delivers ${allocation.resourceId} to Library`,
      publisherRoot: maker, resourceId: allocation.resourceId, quantity: allocation.quantity, unit: allocation.unit, giver: maker, receiver: library,
      interval: { start: requirement.interval.start - 30 * 60_000, end: requirement.interval.start }, allocationIds: [allocation.id], dependsOn: [],
      instructions: 'Library receives and checks the equipment before it is used.' },
    { kind: 'return', id: returnId, transferId: `${allocation.resourceId}:back`, title: `Library returns ${allocation.resourceId} to Makerspace`,
      publisherRoot: library, resourceId: allocation.resourceId, quantity: allocation.quantity, unit: allocation.unit, giver: library, receiver: maker,
      interval: { start: requirement.interval.end, end: requirement.interval.end + 30 * 60_000 }, allocationIds: [allocation.id], dependsOn: [handoverId],
      instructions: 'Makerspace checks and acknowledges the returned equipment. A scheduled return does not record an actual return.' });
  }
  return result;
}

async function publish(repository: LocalRepository, repair: boolean, now: () => number): Promise<void> {
  const project = await read(repository);
  ensure(project.state.status === 'unique', 'The sample project needs a fresh read.');
  const state = project.state.entity.payload, source = activeSource(project);
  const pins: SolverPin[] = [
    { requirementId: 'transport', publisherRoot: root(repair ? 'cedar' : 'oak'), offerId: 'artwork-transport', quantity: 1 },
    { requirementId: 'installation', publisherRoot: root(repair ? 'juniper' : 'cedar'), offerId: 'installation', quantity: 1 },
    { requirementId: 'installation', publisherRoot: root('willow'), offerId: 'installation', quantity: 1 },
  ];
  const solved = solve({ projectRoot: project.root.key, recipe: state.recipe,
    publishers: project.publishers.filter(item => !repair || item.root.key !== root('oak')), snapshot: project.snapshot,
    predecessor: project.proposal, predecessorSource: source, completedWork: state.completedWork }, pins,
  { maxNodes: 100_000, maxCandidates: 32, maxMilliseconds: 5_000 });
  const candidate = solved.candidates.find(item => item.plan.variant.id === 'sunday');
  ensure(candidate, 'These saved offers no longer make the sample plan work. Review them in the full project.');
  const finalized = finalizePlan(withEquipmentTransfers(candidate.plan), project.publishers, project.snapshot, completedWorkContext(project));
  ensure(finalized.ok, 'The complete sample plan could not be checked. Review the offers in the full project.');
  const time = now(), operation = operationId(repair ? 'repair' : 'plan', time);
  const proposal: Proposal = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'proposal', operationId: operation, createdAt: time,
    projectRoot: project.root.key, ...finalized.value, changeExplanation: repair
      ? 'Oak withdrew. Cedar brings the artworks; Juniper installs with Willow. Everyone reviews this complete changed plan again.'
      : 'Oak brings the artworks so Cedar and Willow can install. Makerspace delivers the equipment to Library and receives it back after use.' };
  const input = { projectRoot: project.root.key, proposal, expectedActivationHeads: source ? [source.activationKey] : [],
    requestPublisherRoots: proposal.plan.requiredApprovers, lifetimeSeconds };
  unwrap(await repository.publishPlan(command('publish_plan', coordinator(), input, operation, time)));
}

async function decide(repository: LocalRepository, publisherRoot: EntityKey, status: 'accepted' | 'withdrawn', now: () => number): Promise<void> {
  const project = await read(repository), publisher = project.publishers.find(item => item.root.key === publisherRoot);
  ensure(publisher && project.proposal, 'The sample contributor or current plan could not be read.');
  const owner = sampleOwner(publisher), time = now(), operation = operationId(`${status}-${publisherRoot.slice(6)}`, time);
  const prepared = prepareDecision(project, publisherRoot, owner, { status, operationId: operation, now: time,
    ...(status === 'accepted' ? { validUntil: lastAcceptedDuty(project.proposal.payload.plan, publisherRoot) + 60 * 60_000 }
      : { reason: 'In this sample, Oak is no longer available.' }) });
  ensure(prepared.ok, 'This sample decision no longer matches the saved plan. Read the project again before continuing.');
  const input = { ...prepared.value, publisherRoot, lifetimeSeconds };
  unwrap(await repository.replaceBook(command('replace_book', owner, input, operation, time)));
}

/** Each call represents one explicit sample action. Owners retain separate real local books. */
export async function runGuidedPracticeAction(repository: LocalRepository, action: GuidedAction, now: () => number): Promise<GuidedPracticeState> {
  const current = await loadGuidedPractice(repository, now);
  if (current.action !== action) return current;
  if (action === 'add_oak') {
    await addContributor(repository, 'oak', now);
    await prepareEquipment(repository, now);
    await publish(repository, false, now);
  } else if (action === 'repair') {
    await addContributor(repository, 'juniper', now);
    await publish(repository, true, now);
  } else if (action === 'withdraw_oak') {
    await decide(repository, root('oak'), 'withdrawn', now);
  } else {
    for (const publisherRoot of current.project.proposal!.payload.plan.requiredApprovers) {
      const project = await read(repository);
      if (!deriveReadiness(project, now()).acceptedApprovers.includes(publisherRoot)) await decide(repository, publisherRoot, 'accepted', now);
    }
  }
  return loadGuidedPractice(repository, now);
}
