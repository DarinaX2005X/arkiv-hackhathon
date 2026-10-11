import { describe, expect, it } from 'vitest';
import { createLocalOperationIntent, createMemoryStorage, LocalRepository } from '../../src/data/local';
import type { OperationKind, Result } from '../../src/data/types';
import { hashPlan } from '../../src/domain/canonical';
import { activeSource, deriveReadiness, validateExactGrant } from '../../src/domain/readiness';
import { solve } from '../../src/domain/solver';
import type { Actor, BookState, EntityKey, EntityRecord, Offer, ProjectAggregate, ProjectRecipe, Resource } from '../../src/domain/types';
import { independentlyValidatePlan } from '../../src/domain/validation';
import { prepareDecisionCommand } from '../../src/features/contributions/model';
import { projectNeedsModel } from '../../src/features/projects/projectNeedsModel';
import { admitPublisherInput, authorityFor, planningInput, publishPlanInput, replaceRecipeInput } from '../../src/features/projects/selectors';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const start = Date.parse('2026-11-10T08:00:00Z');
const changeover = Date.parse('2026-11-10T09:00:00Z');
const end = Date.parse('2026-11-10T10:30:00Z');
const lifetimeSeconds = 90 * 86400;
type LocalActor = Extract<Actor, { kind: 'local' }>;
const organizer: LocalActor = { kind: 'local', id: 'local-actor:archive-organizer' };
const facilitator: LocalActor = { kind: 'local', id: 'local-actor:rowan' };
const equipmentOwner: LocalActor = { kind: 'local', id: 'local-actor:bell-archive' };
const recipe: ProjectRecipe = {
  title: 'Community listening session', outcome: 'Listen to three oral-history recordings together.', timeZone: 'Europe/Paris',
  instructions: 'Use the quiet room already available to the group.',
  variants: [{ id: 'tuesday', title: 'Tuesday morning', venueId: 'quiet-room', timeZone: 'Europe/Paris', instructions: '', requirements: [
    { id: 'prepare', title: 'Prepare the recordings', kind: 'person', capability: 'prepare-audio', unit: 'person', quantity: 1,
      interval: { start, end: changeover }, instructions: 'Check the listening stations.', dependsOn: [] },
    { id: 'facilitate', title: 'Facilitate listening', kind: 'person', capability: 'facilitate-audio', unit: 'person', quantity: 1,
      interval: { start: changeover, end }, instructions: 'Introduce each recording.', dependsOn: [] },
    { id: 'stations', title: 'Listening stations', kind: 'equipment', capability: 'audio-playback', unit: 'station', quantity: 3,
      interval: { start, end }, instructions: 'Headphones remain in the room.', dependsOn: [] },
  ] }],
};
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const command = <T extends object>(kind: OperationKind, actor: LocalActor, input: T, id: string) => ({
  ...input, operation: createLocalOperationIntent(kind, actor, input, { id, now: NOW }),
});
const bookOf = (project: ProjectAggregate, root: EntityKey): EntityRecord<BookState> => {
  const publisher = project.publishers.find(item => item.root.key === root);
  if (publisher?.book.status !== 'unique') throw new Error('Expected one current participant book.');
  return publisher.book.entity;
};
const offer = (id: string, resource: Resource, capability: string): Offer => ({
  id, title: id, resourceId: resource.id, kind: resource.kind, unit: resource.unit, quantity: resource.capacity,
  capabilities: [capability], availability: [{ start, end }], projectScope: [], conditions: [], instructions: '',
});

/** Independent adapter instances share only serialized repository storage, never aggregate objects. */
async function customWorkspace() {
  const storage = createMemoryStorage();
  let serial = 0, now = NOW;
  const fresh = () => new LocalRepository({ storage, namespace: 'custom', now: () => now, id: () => `acceptance-${++serial}` });
  const repository = fresh();
  expect(unwrap(await repository.listProjects(organizer)).items).toEqual([]);
  const created = unwrap(await repository.createProject(command('create_project', organizer, { recipe, lifetimeSeconds }, 'create-listening'))).value;
  const projectRoot = created.root.key;
  const reload = () => fresh().loadProject(projectRoot).then(unwrap);
  const needs = projectNeedsModel(await reload());
  expect(needs).toMatchObject({ available: true, title: recipe.title, timeZone: 'Europe/Paris' });

  async function share(actor: LocalActor, name: string, kind: 'individual' | 'organization', resources: Resource[], offers: Offer[]) {
    const publisher = unwrap(await fresh().registerPublisher(command('register_publisher', actor,
      { name, kind, description: 'Synthetic custom acceptance input', lifetimeSeconds }, `register-${name}`))).value;
    if (publisher.book.status !== 'unique') throw new Error('Expected initialized availability.');
    const prior = publisher.book.entity, id = `share-${name}`;
    const book: BookState = { ...prior.payload, operationId: id, predecessorKeys: [prior.key], resources,
      offers: offers.map(item => ({ ...item, projectScope: [projectRoot] })) };
    unwrap(await fresh().shareOffer(command('share_offer', actor, { projectRoot, publisherRoot: publisher.root.key,
      expectedBookHeads: [prior.key], book, offerIds: offers.map(item => item.id), lifetimeSeconds }, id)));
    return publisher.root.key;
  }
  const personalTime: Resource = { id: 'self', name: 'Rowan’s time', kind: 'person', unit: 'person', capacity: 1,
    availability: [{ start, end }], capabilities: ['prepare-audio', 'facilitate-audio'] };
  const stations: Resource = { id: 'players', name: 'Archive listening stations', kind: 'equipment', unit: 'station', capacity: 3,
    availability: [{ start, end }], capabilities: ['audio-playback'] };
  const rowan = await share(facilitator, 'Rowan', 'individual', [personalTime],
    [offer('prepare-recordings', personalTime, 'prepare-audio'), offer('host-listening', personalTime, 'facilitate-audio')]);
  const bell = await share(equipmentOwner, 'Bell', 'organization', [stations], [offer('lend-stations', stations, 'audio-playback')]);
  const roots = [rowan, bell].sort();

  // Discovery alone cannot enroll a participant or manufacture a decision.
  expect(unwrap(await fresh().listIncomingOffers(projectRoot)).items.map(item => item.publisher?.root.key).sort()).toEqual(roots);
  expect((await reload()).publishers).toEqual([]);
  expect(solve(planningInput(await reload())!).status).toBe('impossible');
  for (const root of roots) {
    const id = `admit-${root}`;
    const input = admitPublisherInput(await reload(), root, id, NOW);
    unwrap(await fresh().replaceProject(command('replace_project', organizer, input, id)));
  }
  return { fresh, reload, projectRoot, rowan, bell, roots, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('custom project integration through production repository and feature contracts', () => {
  it('keeps a newly saved draft distinct from a plan whose activation went missing', async () => {
    const storage = createMemoryStorage();
    const fresh = () => new LocalRepository({ storage, namespace: 'custom', now: () => NOW });
    const created = unwrap(await fresh().createProject(command('create_project', organizer, { recipe, lifetimeSeconds }, 'new-draft'))).value;
    const reloaded = unwrap(await fresh().loadProject(created.root.key));
    expect(reloaded.activation).toEqual({ status: 'missing', reason: 'not_initialized' });
    expect(projectNeedsModel(reloaded)).toMatchObject({ available: true, comparison: 'not_proposed' });
    expect(deriveReadiness(reloaded, NOW)).toMatchObject({ status: 'possible', reasons: [] });
  });

  it('does not relabel expired proposals as never initialized when no live history remains', async () => {
    const { fresh, reload, advance } = await customWorkspace();
    const project = await reload();
    const candidate = solve(planningInput(project)!).candidates[0]!;
    const input = { ...publishPlanInput(project, candidate, 'short-proposal', NOW, 'Explicitly short-lived test proposal'), lifetimeSeconds: 60 };
    unwrap(await fresh().publishPlan(command('publish_plan', organizer, input, 'short-proposal')));
    expect((await reload()).activation.status).toBe('unique');
    advance(60_001);
    const expired = await reload();
    expect(expired.proposalHistory).toEqual([]);
    expect(expired.proposal).toBeNull();
    expect(expired.activation).toEqual({ status: 'missing', reason: 'expired_or_deleted' });
    expect(projectNeedsModel(expired)).toMatchObject({ available: true, comparison: 'unverified' });
    expect(deriveReadiness(expired, NOW + 60_001)).toMatchObject({ status: 'changed',
      reasons: [{ code: 'missing_activation' }, { code: 'missing_proposal' }] });
  });

  it('preserves exact non-sample assignments and requires each owner’s decision after discovery, admission and reload', async () => {
    const { fresh, reload, projectRoot, rowan, bell, roots } = await customWorkspace();
    let project = await reload();
    const solved = solve(planningInput(project)!);
    expect(solved.status).toBe('found');
    expect(solved.candidates).toHaveLength(1);
    const candidate = solved.candidates[0]!, plan = candidate.plan;
    expect(plan.allocations.map(item => ({ requirement: item.requirementId, publisher: item.publisherRoot, offer: item.offerId,
      quantity: item.quantity, interval: item.interval })).sort((a, b) => a.requirement.localeCompare(b.requirement))).toEqual([
      { requirement: 'facilitate', publisher: rowan, offer: 'host-listening', quantity: 1, interval: { start: changeover, end } },
      { requirement: 'prepare', publisher: rowan, offer: 'prepare-recordings', quantity: 1, interval: { start, end: changeover } },
      { requirement: 'stations', publisher: bell, offer: 'lend-stations', quantity: 3, interval: { start, end } },
    ]);
    expect(plan.requiredApprovers).toEqual(roots);
    expect(independentlyValidatePlan(plan, project.publishers, NOW)).toMatchObject({ valid: true, reasons: [] });
    const input = publishPlanInput(project, candidate, 'publish-listening', NOW, 'First complete listening-session plan');
    unwrap(await fresh().publishPlan(command('publish_plan', organizer, input, 'publish-listening')));
    project = await reload();
    const source = activeSource(project)!;
    expect(project.proposal!.payload.plan).toEqual(plan);
    expect(project.proposal!.payload.proposalHash).toBe(hashPlan(plan));
    expect(source.proposalHash).toBe(candidate.proposalHash);
    expect(deriveReadiness(project, NOW)).toMatchObject({ status: 'awaiting_approval', acceptedApprovers: [],
      reasons: roots.map(publisherRoot => ({ code: 'missing_decision', publisherRoot })) });

    for (const root of roots) {
      const requests = unwrap(await fresh().listRequests(root)).items;
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ status: 'current', entity: { payload: { ...source, publisherRoot: root } } });
      expect(bookOf(project, root).payload.decisions).toEqual([]);
      expect(bookOf(project, root).payload.grants).toEqual([]);
    }
    const ownerAuthority = authorityFor(organizer, 'local', null)!;
    expect(() => prepareDecisionCommand(project, rowan, ownerAuthority,
      { status: 'accepted', now: NOW, id: 'foreign-acceptance', validUntil: end, reviewedSource: source })).toThrow();
    expect(deriveReadiness(await reload(), NOW).acceptedApprovers).toEqual([]);

    for (const [root, actor] of [[rowan, facilitator], [bell, equipmentOwner]] as const) {
      // An independent participant opens the request from serialized state and reviews this exact activation.
      const participantProject = unwrap(await fresh().loadProject(projectRoot));
      const own = unwrap(await fresh().listOwnPublishers(actor)).items;
      expect(own.map(item => item.root.key)).toEqual([root]);
      const decision = prepareDecisionCommand(participantProject, root, authorityFor(actor, 'local', null)!,
        { status: 'accepted', now: NOW, id: `accept-${root}`, validUntil: end, reviewedSource: source });
      unwrap(await fresh().replaceBook(decision));
      project = await reload();
      expect(activeSource(project)).toEqual(source);
      const readiness = deriveReadiness(project, NOW);
      expect(readiness.status).toBe(root === bell ? 'ready' : 'awaiting_approval');
      expect(readiness.reasons).toEqual(root === bell ? [] : [{ code: 'missing_decision', publisherRoot: bell }]);
    }
    expect(deriveReadiness(project, NOW).acceptedApprovers).toEqual(roots);
    for (const root of roots) {
      const book = bookOf(project, root).payload;
      expect(book.decisions).toEqual([expect.objectContaining({ ...source, status: 'accepted' })]);
      expect(book.grants).toHaveLength(1);
      expect(validateExactGrant(book.grants[0]!, plan, source, root, NOW)).toEqual([]);
    }
    const exported = unwrap(await fresh().exportPacket(projectRoot));
    expect(exported.project.proposal?.payload.plan).toEqual(plan);
    expect(exported.readiness).toEqual(deriveReadiness(project, NOW));
    expect(exported.mode).toBe('local');
  });

  it('rejects a saved one-millisecond overlap instead of silently releasing the preferred personal assignment', async () => {
    const { fresh, reload, rowan } = await customWorkspace();
    let project = await reload();
    const pin = { requirementId: 'facilitate', publisherRoot: rowan, offerId: 'host-listening', quantity: 1 };
    expect(solve(planningInput(project)!, [pin]).status).toBe('found');
    const overlapping = structuredClone(recipe);
    overlapping.variants[0]!.requirements.find(item => item.id === 'facilitate')!.interval.start = changeover - 1;
    const update = replaceRecipeInput(project, overlapping, 'overlap-start', NOW);
    unwrap(await fresh().replaceProject(command('replace_project', organizer, update, 'overlap-start')));
    project = await reload();
    const result = solve(planningInput(project)!, [pin]);
    expect(result.status).toBe('impossible');
    expect(result.optimality).toBe('proven');
    expect(result.candidates).toEqual([]);
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'capacity_exceeded', publisherRoot: rowan, resourceId: 'self' }));
    expect(project.state.status === 'unique' && project.state.entity.payload.recipe).toEqual(overlapping);
    expect(project.proposal).toBeNull();
    expect(deriveReadiness(project, NOW).acceptedApprovers).toEqual([]);
  });
});
