import { describe, expect, it } from 'vitest';
import { createLocalOperationIntent, createMemoryStorage, LocalRepository } from '../../src/data/local';
import type { OperationKind, Result } from '../../src/data/types';
import { prepareDecision } from '../../src/domain/operations';
import { activeSource, deriveReadiness, validateExactGrant } from '../../src/domain/readiness';
import { solve } from '../../src/domain/solver';
import type { Actor, BookState, EntityKey, EntityRecord, Offer, ProjectAggregate, ProjectRecipe, Resource } from '../../src/domain/types';
import { prepareDecisionCommand } from '../../src/features/contributions/model';
import { admitPublisherInput, authorityFor, planningInput, publishPlanInput } from '../../src/features/projects/selectors';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const interval = { start: Date.parse('2026-11-12T09:00:00Z'), end: Date.parse('2026-11-12T10:00:00Z') };
const lifetimeSeconds = 90 * 86400;
type LocalActor = Extract<Actor, { kind: 'local' }>;
const organizer: LocalActor = { kind: 'local', id: 'local-actor:competing-organizer' };
const equipmentOwner: LocalActor = { kind: 'local', id: 'local-actor:shared-equipment' };
const facilitator: LocalActor = { kind: 'local', id: 'local-actor:pending-facilitator' };

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const command = <T extends object>(kind: OperationKind, actor: LocalActor, input: T, id: string) => ({
  ...input, operation: createLocalOperationIntent(kind, actor, input, { id, now: NOW }),
});
const bookOf = (project: ProjectAggregate, publisherRoot: EntityKey): EntityRecord<BookState> => {
  const publisher = project.publishers.find(item => item.root.key === publisherRoot);
  if (publisher?.book.status !== 'unique') throw new Error('Expected one current participant book.');
  return publisher.book.entity;
};
const recipe = (title: string, needsFacilitator: boolean): ProjectRecipe => ({
  title, outcome: 'Project one complete hour of community recordings.', timeZone: 'UTC', instructions: '',
  variants: [{ id: 'morning', title: 'Morning session', venueId: 'community-room', timeZone: 'UTC', instructions: '', requirements: [
    { id: 'projection', title: 'Projector', kind: 'equipment', capability: 'project-recordings', unit: 'projector',
      quantity: 1, interval, instructions: '', dependsOn: [] },
    ...(needsFacilitator ? [{ id: 'host', title: 'Session host', kind: 'person' as const, capability: 'host-session', unit: 'person',
      quantity: 1, interval, instructions: '', dependsOn: [] }] : []),
  ] }],
});

describe('competing project commitments across independent local clients', () => {
  it('reserves capacity before full consensus and rejects both stale and freshly reviewed competing acceptance', async () => {
    // Only serialized strings cross the client boundary; neither adapter receives another client's aggregates.
    const storage = createMemoryStorage();
    let firstId = 0, secondId = 0;
    const first = new LocalRepository({ storage, namespace: 'competing-projects', now: () => NOW, id: () => `first-${++firstId}` });
    const second = new LocalRepository({ storage, namespace: 'competing-projects', now: () => NOW, id: () => `second-${++secondId}` });
    const reload = async (client: LocalRepository, root: EntityKey) => unwrap(await client.loadProject(root));
    expect(unwrap(await first.listProjects(organizer)).items).toEqual([]);
    const p1 = unwrap(await first.createProject(command('create_project', organizer,
      { recipe: recipe('Hosted archive screening', true), lifetimeSeconds }, 'create-p1'))).value.root.key;
    const p2 = unwrap(await second.createProject(command('create_project', organizer,
      { recipe: recipe('Independent archive screening', false), lifetimeSeconds }, 'create-p2'))).value.root.key;

    async function share(actor: LocalActor, name: string, resource: Resource, projects: EntityKey[]) {
      const publisher = unwrap(await first.registerPublisher(command('register_publisher', actor,
        { name, kind: resource.kind === 'person' ? 'individual' as const : 'organization' as const,
          description: 'Synthetic competing-project acceptance input', lifetimeSeconds }, `register-${name}`))).value;
      if (publisher.book.status !== 'unique') throw new Error('Expected initialized publisher book.');
      const offer: Offer = { id: `${name}-offer`, title: name, resourceId: resource.id, kind: resource.kind,
        unit: resource.unit, quantity: 1, capabilities: resource.capabilities, availability: [interval],
        projectScope: projects, conditions: [], instructions: '' };
      let prior = publisher.book.entity;
      for (const projectRoot of projects) {
        const id = `share-${name}-${projectRoot}`;
        const book: BookState = { ...prior.payload, operationId: id, predecessorKeys: [prior.key], resources: [resource], offers: [offer] };
        unwrap(await first.shareOffer(command('share_offer', actor, { projectRoot, publisherRoot: publisher.root.key,
          expectedBookHeads: [prior.key], book, offerIds: [offer.id], lifetimeSeconds }, id)));
        const owned = unwrap(await second.listOwnPublishers(actor)).items.find(item => item.root.key === publisher.root.key)!;
        if (owned.book.status !== 'unique') throw new Error('Expected shared publisher book.');
        prior = owned.book.entity;
        const admissionId = `admit-${name}-${projectRoot}`;
        const admission = admitPublisherInput(await reload(second, projectRoot), publisher.root.key, admissionId, NOW);
        unwrap(await second.replaceProject(command('replace_project', organizer, admission, admissionId)));
      }
      return publisher.root.key;
    }

    const projector = await share(equipmentOwner, 'projector', { id: 'single-projector', name: 'The only projector', kind: 'equipment',
      unit: 'projector', capacity: 1, capabilities: ['project-recordings'], availability: [interval] }, [p1, p2]);
    const host = await share(facilitator, 'host', { id: 'self', name: 'Host time', kind: 'person', unit: 'person', capacity: 1,
      capabilities: ['host-session'], availability: [interval] }, [p1]);

    for (const [client, projectRoot, id] of [[first, p1, 'publish-p1'], [second, p2, 'publish-p2']] as const) {
      const project = await reload(client, projectRoot);
      const solved = solve(planningInput(project)!);
      expect(solved.status).toBe('found');
      expect(solved.candidates).toHaveLength(1);
      const input = publishPlanInput(project, solved.candidates[0]!, id, NOW, 'Complete proposal before any acceptance');
      unwrap(await client.publishPlan(command('publish_plan', organizer, input, id)));
    }

    const firstReview = await reload(first, p1), secondReview = await reload(second, p2);
    expect(firstReview.proposal!.payload.plan.requiredApprovers).toEqual([projector, host].sort());
    expect(secondReview.proposal!.payload.plan.requiredApprovers).toEqual([projector]);
    expect(deriveReadiness(firstReview, NOW)).toMatchObject({ status: 'awaiting_approval', acceptedApprovers: [] });
    expect(deriveReadiness(secondReview, NOW)).toMatchObject({ status: 'awaiting_approval', acceptedApprovers: [] });
    expect(bookOf(firstReview, projector)).toEqual(bookOf(secondReview, projector));
    expect(bookOf(firstReview, projector)).not.toBe(bookOf(secondReview, projector));
    const firstSource = activeSource(firstReview)!, secondSource = activeSource(secondReview)!;
    const authority = authorityFor(equipmentOwner, 'local', null)!;
    const acceptFirst = prepareDecisionCommand(firstReview, projector, authority,
      { status: 'accepted', now: NOW, id: 'accept-p1-projector', validUntil: interval.end, reviewedSource: firstSource });
    const staleAcceptSecond = prepareDecisionCommand(secondReview, projector, authority,
      { status: 'accepted', now: NOW, id: 'accept-p2-projector-stale', validUntil: interval.end, reviewedSource: secondSource });
    expect(acceptFirst.expectedHeads).toEqual(staleAcceptSecond.expectedHeads);
    expect(acceptFirst.book.grants).toHaveLength(1);
    expect(staleAcceptSecond.book.grants).toHaveLength(1);

    unwrap(await first.replaceBook(acceptFirst));
    const pendingFirst = await reload(second, p1);
    expect(deriveReadiness(pendingFirst, NOW)).toMatchObject({ status: 'awaiting_approval', acceptedApprovers: [projector],
      reasons: [{ code: 'missing_decision', publisherRoot: host }] });
    const reserved = bookOf(pendingFirst, projector);
    expect(reserved.payload.grants).toHaveLength(1);
    expect(validateExactGrant(reserved.payload.grants[0]!, pendingFirst.proposal!.payload.plan, firstSource, projector, NOW)).toEqual([]);

    const staleWrite = await second.replaceBook(staleAcceptSecond);
    expect(staleWrite).toMatchObject({ ok: false, error: { code: 'stale_heads', reasons: [{ code: 'conflicting_heads' }] } });
    const freshSecond = await reload(second, p2);
    expect(bookOf(freshSecond, projector)).toEqual(reserved);
    expect(bookOf(freshSecond, projector).payload.decisions).toEqual([expect.objectContaining({ ...firstSource, status: 'accepted' })]);
    const freshDecision = prepareDecision(freshSecond, projector, equipmentOwner,
      { status: 'accepted', now: NOW, operationId: 'accept-p2-projector-refreshed', validUntil: interval.end });
    expect(freshDecision.ok).toBe(false);
    if (freshDecision.ok) throw new Error('The existing reservation must block a competing project.');
    expect(freshDecision.reasons).toContainEqual(expect.objectContaining({ code: 'capacity_exceeded', publisherRoot: projector, resourceId: 'single-projector' }));
    expect(deriveReadiness(freshSecond, NOW).status).not.toBe('ready');

    const hostReview = await reload(first, p1);
    const acceptHost = prepareDecisionCommand(hostReview, host, authorityFor(facilitator, 'local', null)!,
      { status: 'accepted', now: NOW, id: 'accept-p1-host', validUntil: interval.end, reviewedSource: firstSource });
    unwrap(await first.replaceBook(acceptHost));
    expect(deriveReadiness(await reload(second, p1), NOW)).toMatchObject({ status: 'ready', acceptedApprovers: [projector, host].sort(), reasons: [] });
    const finalSecond = await reload(first, p2);
    expect(activeSource(finalSecond)).toEqual(secondSource);
    expect(deriveReadiness(finalSecond, NOW).status).not.toBe('ready');
    expect(deriveReadiness(finalSecond, NOW).acceptedApprovers).toEqual([]);
    expect(bookOf(finalSecond, projector).payload.grants).toEqual(reserved.payload.grants);
    expect(bookOf(finalSecond, projector).payload.decisions).toEqual(reserved.payload.decisions);
  });
});
