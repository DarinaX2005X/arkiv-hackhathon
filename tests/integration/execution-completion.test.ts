import { describe, expect, it } from 'vitest';
import { createLocalOperationIntent, createMemoryStorage, LocalRepository } from '../../src/data/local';
import type { OperationKind, Result, WriteAuthority } from '../../src/data/types';
import { deriveExecution, reuseRecipe } from '../../src/domain/execution';
import { activeSource, deriveReadiness } from '../../src/domain/readiness';
import { solve } from '../../src/domain/solver';
import type { Actor, BookState, EntityKey, ProjectAggregate, ProjectRecipe, RecordedOutcome, Resource, SourcePlanRef } from '../../src/domain/types';
import { finalizePlan } from '../../src/domain/validation';
import { prepareDecisionCommand } from '../../src/features/contributions/model';
import { buildExecutionExports, packetFromProject, parseExecutionExport } from '../../src/features/execution/export';
import { prepareClosureCommand, prepareProgressCommand, runbookRows } from '../../src/features/execution/model';
import type { ProgressInput } from '../../src/features/execution/model';
import { templateToEditorDraft, validateEditorDraft } from '../../src/features/projects/editor';
import { createProjectReader } from '../../src/features/projects/projectReader';
import { admitPublisherInput, planningInput, publishPlanInput } from '../../src/features/projects/selectors';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const start = Date.parse('2026-11-10T08:00:00Z'), end = Date.parse('2026-11-10T10:00:00Z');
const nextEnd = Date.parse('2026-11-17T10:00:00Z');
const lifetimeSeconds = 90 * 86400;
type LocalActor = Extract<Actor, { kind: 'local' }>;
const coordinator: LocalActor = { kind: 'local', id: 'local-actor:printing-organizer' };
const host: LocalActor = { kind: 'local', id: 'local-actor:printing-host' };
const lender: LocalActor = { kind: 'local', id: 'local-actor:tray-lender' };
const authority = (actor: LocalActor): WriteAuthority => ({ mode: 'local', actor, chainId: null });
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; };
const recipe: ProjectRecipe = {
  title: 'Community printing table', outcome: 'Introduce neighbours to hand printing.', timeZone: 'Europe/Paris',
  instructions: 'Use washable ink and protect the table.',
  variants: [{ id: 'morning', title: 'Tuesday morning', venueId: 'community-room', timeZone: 'Europe/Paris', instructions: 'Use the side door.',
    requirements: [
      { id: 'hosting', title: 'Host the table', kind: 'person', capability: 'print-hosting', unit: 'person', quantity: 1,
        interval: { start, end }, instructions: 'Explain how to print.', dependsOn: [] },
      { id: 'trays', title: 'Ink trays', kind: 'equipment', capability: 'hold-ink', unit: 'tray', quantity: 2,
        interval: { start, end }, instructions: 'Keep both trays on the table.', dependsOn: [] },
    ] }],
};

async function workspace() {
  const memory = createMemoryStorage();
  let serial = 0, unavailable = false;
  const storage = { ...memory, getItem(key: string) { if (unavailable) throw new Error('Synthetic storage outage'); return memory.getItem(key); } };
  const fresh = () => new LocalRepository({ storage, namespace: 'completion', logicalClock: true, now: () => NOW, id: () => `execution-${++serial}` });
  const command = <T extends object>(kind: OperationKind, actor: LocalActor, input: T, id: string) => ({
    ...input, operation: createLocalOperationIntent(kind, actor, input, { id, now: fresh().currentTime() }),
  });
  const root = unwrap(await fresh().createProject(command('create_project', coordinator, { recipe, lifetimeSeconds }, 'create'))).value.root.key;
  const reload = (key = root) => fresh().loadProject(key).then(unwrap);
  const owners = new Map<EntityKey, LocalActor>();
  async function register(actor: LocalActor, resource: Resource) {
    const publisher = unwrap(await fresh().registerPublisher(command('register_publisher', actor,
      { kind: resource.kind === 'person' ? 'individual' as const : 'organization' as const, name: resource.name, description: '', lifetimeSeconds }, `register-${resource.id}`))).value;
    if (publisher.book.status !== 'unique') throw new Error('Expected an initialized book.');
    const previous = publisher.book.entity;
    const book: BookState = { ...previous.payload, predecessorKeys: [previous.key], operationId: `share-${resource.id}`, resources: [resource],
      offers: [{ id: `offer-${resource.id}`, title: resource.name, resourceId: resource.id, kind: resource.kind, unit: resource.unit,
        quantity: resource.capacity, capabilities: resource.capabilities, availability: resource.availability,
        projectScope: [], conditions: [], instructions: 'Standing availability, each plan still needs its own consent.' }] };
    unwrap(await fresh().shareOffer(command('share_offer', actor, { projectRoot: root, publisherRoot: publisher.root.key,
      expectedBookHeads: [previous.key], book, offerIds: [book.offers[0]!.id], lifetimeSeconds }, `share-${resource.id}`)));
    owners.set(publisher.root.key, actor);
    const admission = admitPublisherInput(await reload(), publisher.root.key, `admit-${resource.id}`, fresh().currentTime());
    unwrap(await fresh().replaceProject(command('replace_project', coordinator, admission, `admit-${resource.id}`)));
    return publisher.root.key;
  }
  const hostRoot = await register(host, { id: 'self', name: 'Printing host', kind: 'person', unit: 'person', capacity: 1,
    capabilities: ['print-hosting'], availability: [{ start, end: nextEnd }] });
  const lenderRoot = await register(lender, { id: 'trays', name: 'Tray lender', kind: 'equipment', unit: 'tray', capacity: 2,
    capabilities: ['hold-ink'], availability: [{ start, end: nextEnd }] });
  let project = await reload();
  const candidate = solve(planningInput(project)!).candidates[0]!;
  const plan = structuredClone(candidate.plan), allocation = plan.allocations.find(item => item.resourceId === 'trays')!;
  const common = { resourceId: 'trays', quantity: 2, unit: 'tray', allocationIds: [allocation.id], dependsOn: [], instructions: 'Count both trays together.' };
  plan.runbook.push({ ...common, id: 'give-trays', transferId: 'trays-out', kind: 'handover', title: 'Hand over trays',
    publisherRoot: lenderRoot, giver: lenderRoot, receiver: hostRoot, interval: { start, end: start + 1 } },
  { ...common, id: 'return-trays', transferId: 'trays-back', kind: 'return', title: 'Return trays',
    publisherRoot: hostRoot, giver: hostRoot, receiver: lenderRoot, interval: { start: end - 1, end } });
  const finalized = finalizePlan(plan, project.publishers, project.snapshot);
  if (!finalized.ok) throw new Error(JSON.stringify(finalized.reasons));
  const publication = publishPlanInput(project, { ...candidate, ...finalized.value }, 'publish', fresh().currentTime(), 'Both sides will record delivery and return.');
  unwrap(await fresh().publishPlan(command('publish_plan', coordinator, publication, 'publish')));
  project = await reload();
  const source = activeSource(project)!;
  async function progress(root: EntityKey, duty: string, input: ProgressInput, id: string) {
    const repo = fresh(), current = unwrap(await repo.loadProject(project.root.key));
    unwrap(await repo.replaceBook(prepareProgressCommand(current, current.proposal!, source, duty,
      authority(owners.get(root)!), input, repo.currentTime(), id)));
    return reload();
  }
  return { fresh, reload, command, root, hostRoot, lenderRoot, owners, source, progress,
    setUnavailable(value: boolean) { unavailable = value; } };
}

function inspectExport(packet: ReturnType<typeof packetFromProject>, source: SourcePlanRef, status: string) {
  const files = buildExecutionExports(packet, source.proposalKey);
  const json = JSON.parse(files.json.text), restored = parseExecutionExport(files.json.text);
  expect(json.selection).toEqual({ proposalKey: source.proposalKey, source, status });
  expect(restored.snapshot).toEqual(packet.snapshot);
  expect(restored.exportedAt).toBe(packet.exportedAt);
  expect(restored.readiness).toEqual(packet.readiness);
  expect(json.project.proposal ?? json.project.proposalHistory.find((item: { key: string }) => item.key === source.proposalKey))
    .toMatchObject({ key: source.proposalKey, payload: { proposalHash: source.proposalHash, plan: { variant: { timeZone: 'Europe/Paris' } } } });
  for (const text of [status, 'Europe/Paris', source.proposalHash, 'This dated document does not guarantee attendance or physical return.']) expect(files.html.text).toContain(text);
  expect(files.html.text).not.toMatch(/<script|<img|<link/);
  return restored;
}

describe('persisted execution, honest closure, export and recipe reuse', () => {
  it.each<[RecordedOutcome, number, string]>([
    ['completed', 2, 'confirmed_return'],
    ['completed_with_outstanding', 1, 'partially_acknowledged'],
    ['cancelled', 0, 'awaiting_acknowledgement'],
  ])('preserves the authored facts of %s through export and a reused project that requires fresh agreement', async (outcome, returned, returnStatus) => {
    const f = await workspace();
    let project = await f.reload();
    const originalPlan = structuredClone(project.proposal!.payload.plan);
    inspectExport(unwrap(await f.fresh().exportPacket(f.root)), f.source, 'Proposed, awaiting everyone’s agreement');
    for (const [root, actor] of f.owners) {
      const repo = f.fresh(), current = unwrap(await repo.loadProject(f.root));
      unwrap(await repo.replaceBook(prepareDecisionCommand(current, root, authority(actor),
        { id: `accept-${root}`, status: 'accepted', now: repo.currentTime(), validUntil: end, reviewedSource: f.source })));
    }
    const ready = unwrap(await f.fresh().exportPacket(f.root));
    expect(ready.readiness.status).toBe('ready');
    inspectExport(ready, f.source, 'Agreed by everyone');
    const reader = createProjectReader(() => f.fresh().loadProject(f.root), () => ready.exportedAt);
    try {
      reader.start(false); await reader.refresh(); f.setUnavailable(true); await reader.refresh();
      expect(reader.getSnapshot().error?.code).toBe('storage');
      const retained = reader.getSnapshot().project!;
      expect(retained.snapshot).toMatchObject({ freshness: 'stale', completeness: 'incomplete' });
      inspectExport(packetFromProject(retained, retained.snapshot.fetchedAt), f.source, 'Current status unverified');
    } finally { f.setUnavailable(false); reader.stop(); }

    for (const duty of originalPlan.runbook.filter(item => item.kind === 'task')) {
      await f.progress(duty.publisherRoot, duty.id, { kind: 'task_report', status: 'done', note: 'Owner-reported work.' }, `done-${duty.id}`);
    }
    await f.progress(f.lenderRoot, 'give-trays', { kind: 'transfer_report', quantity: 2 }, 'give');
    await f.progress(f.hostRoot, 'give-trays', { kind: 'transfer_acknowledgement', reportId: 'report:give', quantity: 2 }, 'receive');
    project = await f.progress(f.hostRoot, 'return-trays', { kind: 'transfer_report', quantity: 2 }, 'return');
    if (returned) project = await f.progress(f.lenderRoot, 'return-trays',
      { kind: 'transfer_acknowledgement', reportId: 'report:return', quantity: returned }, 'receive-return');
    expect(project.proposal!.payload.plan).toEqual(originalPlan);
    expect(runbookRows(project, project.proposal!, f.source, null).find(row => row.obligation.id === 'return-trays')?.status).toBe(returnStatus);
    expect(deriveExecution(project).outstandingCustodyHolds.reduce((sum, hold) => sum + hold.quantity, 0)).toBe(2 - returned);
    if (outcome !== 'completed') expect(() => prepareClosureCommand(project, authority(coordinator), 'completed', '', f.fresh().currentTime(), 'false-completion')).toThrow();
    const booksBefore = project.publishers.map(publisher => publisher.book);
    const closing = prepareClosureCommand(project, authority(coordinator), outcome, 'Synthetic owner statements retained.', f.fresh().currentTime(), 'close');
    const receipt = unwrap(await f.fresh().replaceProject(closing)).receipt;
    expect(receipt.consumedKeys).toContain(f.source.activationKey);
    const closed = await f.reload();
    expect(closed.publishers.map(publisher => publisher.book)).toEqual(booksBefore);
    expect(closed.proposal).toBeNull(); expect(activeSource(closed)).toBeNull();
    expect(deriveReadiness(closed, closed.snapshot.fetchedAt)).toMatchObject({ status: 'changed', lifecycle: 'closed', outcome,
      evidenceAvailability: 'available', reasons: [{ code: 'closed_project' }] });
    if (closed.state.status !== 'unique') throw new Error('The saved closure is missing.');
    expect(closed.state.entity.payload.completion).toMatchObject({ source: f.source, outcome,
      outstandingObligationIds: returned === 2 ? [] : ['return-trays'], outstandingCustodyHoldIds: returned === 2 ? [] : ['report:give'] });
    const exported = inspectExport(unwrap(await f.fresh().exportPacket(f.root)), f.source, `Closed record, ${outcome.replaceAll('_', ' ')}`);
    expect(exported.project.state).toEqual(closed.state);

    const template = reuseRecipe(exported.project)!, draft = templateToEditorDraft(template);
    expect(template.sourceProjectRoot).toBe(f.root);
    expect(template.variants.flatMap(variant => variant.requirements).every(requirement => !('interval' in requirement))).toBe(true);
    expect(draft.variants.flatMap(variant => variant.requirements).every(requirement => !requirement.startLocal && !requirement.endLocal)).toBe(true);
    expect(JSON.stringify(template)).not.toMatch(/decisions|grants|attestations|completedWork|custodyHolds/);
    draft.title = 'Printing introduction, one week later';
    draft.variants[0]!.requirements = draft.variants[0]!.requirements.filter(requirement => requirement.kind === 'person')
      .map(requirement => ({ ...requirement, startLocal: '2026-11-17T09:00', endLocal: '2026-11-17T11:00' }));
    const validation = validateEditorDraft(draft);
    if (!validation.recipe) throw new Error(JSON.stringify(validation.errors));
    const reused = unwrap(await f.fresh().createProject(f.command('create_project', coordinator,
      { recipe: validation.recipe, lifetimeSeconds }, 'reused-project'))).value;
    expect(reused.root.key).not.toBe(f.root);
    expect(reused).toMatchObject({ proposal: null, publishers: [], activation: { status: 'missing', reason: 'not_initialized' },
      state: { status: 'unique', entity: { payload: { completedWork: [], completion: null, publisherRoots: [],
        recipe: { sourceProjectRoot: f.root, title: draft.title } } } } });
    expect(solve(planningInput(reused)!).status).toBe('impossible');
    const admitted = admitPublisherInput(reused, f.hostRoot, 'admit-reused', f.fresh().currentTime());
    unwrap(await f.fresh().replaceProject(f.command('replace_project', coordinator, admitted, 'admit-reused')));
    const next = await f.reload(reused.root.key), solved = solve(planningInput(next)!);
    expect(solved.status).toBe('found');
    const candidate = solved.candidates[0]!;
    expect(candidate.plan.allocations).toHaveLength(1);
    expect(candidate.plan.allocations[0]).toMatchObject({ publisherRoot: f.hostRoot, interval: { start: nextEnd - 2 * 3600_000, end: nextEnd } });
    const publication = publishPlanInput(next, candidate, 'publish-reused', f.fresh().currentTime(), 'New date and a host-only introduction.');
    unwrap(await f.fresh().publishPlan(f.command('publish_plan', coordinator, publication, 'publish-reused')));
    const reopened = await f.reload(reused.root.key);
    expect(reopened.proposal?.payload.proposalHash).not.toBe(f.source.proposalHash);
    expect(reopened.proposal?.payload.plan.predecessor).toBeNull();
    expect(deriveReadiness(reopened, reopened.snapshot.fetchedAt)).toMatchObject({ status: 'awaiting_approval', acceptedApprovers: [],
      requiredApprovers: [f.hostRoot], reasons: [{ code: 'missing_decision', publisherRoot: f.hostRoot }] });
    expect((await f.reload()).publishers.map(publisher => publisher.book)).toEqual(booksBefore);
  });
});
