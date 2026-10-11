import { makeSmallWorksFixture, smallWorksRecipe } from '../../src/domain/fixtures';
import { canonicalJson, hashPlan } from '../../src/domain/canonical';
import { activeSource, deriveReadiness, lastAcceptedDuty } from '../../src/domain/readiness';
import { solve } from '../../src/domain/solver';
import { finalizePlan } from '../../src/domain/validation';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from '../../src/domain/types';
import type { AgreementHealth, BookState, EntityKey, PlanDocument, ProjectAggregate, ProjectRecipe, Proposal,
  PublicEntityKey, PublisherRoot, SolverInput, SolverPin, SourcePlanRef } from '../../src/domain/types';
import { publicKey } from '../../src/data/arkiv/envelope';

export const ACTOR_IDS = ['library', 'courtyard', 'makerspace', 'cedar', 'willow', 'ash', 'elm', 'oak', 'juniper'] as const;
export const BASE_ACTORS = ACTOR_IDS.slice(0, 7);
export type ProofActor = typeof ACTOR_IDS[number];
export type ProofRoots = Partial<Record<ProofActor, PublicEntityKey>>;
export const LIFETIME_SECONDS = 90 * 86_400;
export const CHILD_FUNDING_WEI = '5000000000000000'; // Conservative ledger also counts all child transaction fees.
export const REVISION_NAMES = ['p1', 'p2', 'p3'] as const;
export type RevisionName = typeof REVISION_NAMES[number];

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const copy = <T>(value: T): T => structuredClone(value);
const roleRoot = (roots: ProofRoots, actor: ProofActor): PublicEntityKey => publicKey(roots[actor]);

export function publicRecipe(): ProjectRecipe {
  const recipe = smallWorksRecipe();
  recipe.title = 'Small Works: synthetic public proof';
  recipe.instructions = 'Synthetic demonstration only. Every publisher reviews the complete exact plan before accepting. No real people, locations, promises, or equipment are represented.';
  return recipe;
}

/** Templates are material only. Runtime-created public roots and books supply all authority. */
export function publisherTemplate(actor: ProofActor, projectRoot: PublicEntityKey): {
  kind: PublisherRoot['kind']; name: string; description: string; resources: BookState['resources']; offers: BookState['offers'];
} {
  const fixture = makeSmallWorksFixture({ oak: true, juniper: true });
  const publisher = fixture.publishers.find(item => item.root.key === `local:${actor}`);
  ensure(publisher?.book.status === 'unique', 'Unknown synthetic contributor template.');
  const book = copy(publisher.book.entity.payload);
  for (const offer of book.offers) offer.projectScope = [publicKey(projectRoot)];
  if (actor === 'makerspace') {
    // Storage and consent reserve physical equipment before use through its planned return.
    const extended = [17, 18].map(day => ({ start: Date.parse(`2026-10-${day}T08:30:00.000Z`), end: Date.parse(`2026-10-${day}T15:30:00.000Z`) }));
    for (const resource of book.resources) resource.availability = copy(extended);
    for (const offer of book.offers) offer.availability = offer.id === 'boards-saturday' ? [copy(extended[0]!)]
      : offer.id === 'boards-sunday' ? [copy(extended[1]!)] : copy(extended);
  }
  return { kind: publisher.root.payload.kind, name: `Synthetic ${book.name}`, description: 'Synthetic testnet participant controlled by a dedicated local demonstration signer. No real-world identity or availability claim.',
    resources: book.resources, offers: book.offers };
}

export function materialBook(current: BookState, actor: ProofActor, projectRoot: PublicEntityKey): BookState {
  const { kind: _kind, ...material } = publisherTemplate(actor, projectRoot);
  return { ...copy(current), ...material };
}

function withNamedEquipmentTransfers(plan: PlanDocument, roots: ProofRoots): PlanDocument {
  const result = copy(plan); const owner = roleRoot(roots, 'makerspace'), receiver = roleRoot(roots, 'library');
  for (const allocation of result.allocations.filter(item => item.publisherRoot === owner && ['boards', 'kit'].includes(item.resourceId))) {
    const requirement = result.variant.requirements.find(item => item.id === allocation.requirementId)!;
    const handoverId = `handover:${allocation.resourceId}`, returnId = `return:${allocation.resourceId}`;
    result.runbook.push({ kind: 'handover', id: handoverId, transferId: `${allocation.resourceId}:out`, title: `Receive ${allocation.resourceId} before setup`,
      publisherRoot: owner, resourceId: allocation.resourceId, quantity: allocation.quantity, unit: allocation.unit,
      giver: owner, receiver, interval: { start: requirement.interval.start - 30 * 60_000, end: requirement.interval.start },
      allocationIds: [allocation.id], dependsOn: [], instructions: 'Synthetic prearranged equipment delivery; the Library explicitly receives it before required use.' },
    { kind: 'return', id: returnId, transferId: `${allocation.resourceId}:back`, title: `Return ${allocation.resourceId} after use`,
      publisherRoot: receiver, resourceId: allocation.resourceId, quantity: allocation.quantity, unit: allocation.unit,
      giver: receiver, receiver: owner, interval: { start: requirement.interval.end, end: requirement.interval.end + 30 * 60_000 },
      allocationIds: [allocation.id], dependsOn: [handoverId], instructions: 'Synthetic return. The owner must acknowledge actual returned quantities; a deadline alone does not prove return.' });
  }
  return result;
}

/** Uses the product solver and final validator, with explicit assignments/transfer parties for this proof. */
export function buildProofProposal(project: ProjectAggregate, revision: RevisionName, roots: ProofRoots, options: {
  operationId: string; createdAt: number; initialPlan?: PlanDocument;
}): Proposal {
  ensure(project.snapshot.mode === 'public' && project.snapshot.chainId === TIRAMISU_CHAIN_ID && project.state.status === 'unique', 'The proof requires a fresh public project.');
  const parent = activeSource(project);
  ensure(revision === 'p1' ? parent === null : parent !== null, 'The requested revision has the wrong current predecessor.');
  let document: PlanDocument;
  if (revision === 'p3') {
    ensure(options.initialPlan?.projectRoot === project.root.key, 'Restoring terms needs the original authenticated P1 document.');
    document = { ...copy(options.initialPlan), predecessor: parent };
  } else {
    const input: SolverInput = { projectRoot: project.root.key, recipe: copy(project.state.entity.payload.recipe),
      publishers: project.publishers.filter(item => revision !== 'p2' || item.root.key !== roots.oak), snapshot: project.snapshot,
      predecessor: project.proposal, predecessorSource: parent, completedWork: copy(project.state.entity.payload.completedWork) };
    const pins: SolverPin[] = revision === 'p1' ? [
      { requirementId: 'transport', publisherRoot: roleRoot(roots, 'oak'), offerId: 'artwork-transport', quantity: 1 },
      { requirementId: 'installation', publisherRoot: roleRoot(roots, 'cedar'), offerId: 'installation', quantity: 1 },
    ] : [
      { requirementId: 'transport', publisherRoot: roleRoot(roots, 'cedar'), offerId: 'artwork-transport', quantity: 1 },
      { requirementId: 'installation', publisherRoot: roleRoot(roots, 'juniper'), offerId: 'installation', quantity: 1 },
    ];
    pins.push({ requirementId: 'installation', publisherRoot: roleRoot(roots, 'willow'), offerId: 'installation', quantity: 1 });
    const solved = solve(input, pins, { maxNodes: 100_000, maxCandidates: 32, maxMilliseconds: 5_000 });
    const candidate = solved.candidates.find(item => item.plan.variant.id === 'sunday');
    ensure(candidate, `The real solver could not produce ${revision}: ${solved.status}.`);
    document = withNamedEquipmentTransfers(candidate.plan, roots);
  }
  const finalized = finalizePlan(document, project.publishers, project.snapshot);
  ensure(finalized.ok, `The finalized proof plan is invalid: ${finalized.ok ? '' : finalized.reasons.map(reason => reason.code).join(', ')}.`);
  return { protocol: PROTOCOL, schemaVersion: 1, entityType: 'proposal', operationId: options.operationId, createdAt: options.createdAt,
    projectRoot: publicKey(project.root.key), requirementsHash: finalized.value.requirementsHash,
    proposalHash: finalized.value.proposalHash, plan: finalized.value.plan,
    changeExplanation: revision === 'p1' ? 'Oak provides independent artwork transport so Cedar and Willow can install simultaneously.'
      : revision === 'p2' ? 'Oak withdrew. Juniper installs with Willow; Cedar transports the artworks. Every required owner must approve this revision again.'
      : 'Restore the original P1 material terms as a new P3 revision, explicitly parented to P2. All owners must approve P3 afresh.' };
}

export function proofConsentDeadline(plan: PlanDocument, publisherRoot: EntityKey): number {
  return lastAcceptedDuty(plan, publisherRoot) + 60 * 60_000;
}

/** Proof checkpoints require the saved revision chain even when current product readiness can survive an old history gap. */
export function assertProofLineage(project: ProjectAggregate, expected: readonly SourcePlanRef[]): void {
  ensure(expected.length >= 1 && expected.length <= REVISION_NAMES.length
    && new Set(expected.map(source => source.proposalKey)).size === expected.length
    && new Set(expected.map(source => source.activationKey)).size === expected.length,
  'The proof needs distinct saved references for every expected revision.');
  ensure(project.proposalHistoryStatus?.complete === true && project.proposalHistoryStatus.reasons.length === 0,
    'The proof proposal lineage is incomplete.');
  ensure(project.proposalHistory.length === expected.length, 'The proof proposal lineage does not contain every expected revision.');
  for (const [index, source] of expected.entries()) {
    const proposal = project.proposalHistory[index]!;
    ensure(source.projectRoot === project.root.key && proposal.key === source.proposalKey
      && proposal.payload.projectRoot === source.projectRoot && proposal.payload.plan.projectRoot === source.projectRoot
      && proposal.payload.proposalHash === source.proposalHash && hashPlan(proposal.payload.plan) === source.proposalHash,
    'The proof proposal lineage differs from the saved revision identities.');
    ensure(canonicalJson(proposal.payload.plan.predecessor) === canonicalJson(index === 0 ? null : expected[index - 1]),
      'The proof proposal predecessor differs from the saved revision chain.');
  }
  const current = expected.at(-1)!;
  ensure(project.proposal?.key === current.proposalKey && project.proposal.payload.proposalHash === current.proposalHash
    && canonicalJson(activeSource(project)) === canonicalJson(current), 'The active proof revision differs from the saved revision chain.');
}

export function assertProofState(project: ProjectAggregate, expectedStatus: AgreementHealth, accepted: number, now: number,
  expectedLineage: readonly SourcePlanRef[]) {
  assertProofLineage(project, expectedLineage);
  const readiness = deriveReadiness(project, now);
  ensure(readiness.status === expectedStatus, `Expected ${expectedStatus}; read ${readiness.status}: ${readiness.reasons.map(reason => reason.code).join(', ')}.`);
  ensure(readiness.acceptedApprovers.length === accepted, `Expected ${accepted} exact current approvals; read ${readiness.acceptedApprovers.length}.`);
  ensure(project.snapshot.completeness === 'complete' && project.snapshot.freshness === 'fresh', 'The proof snapshot is incomplete or stale.');
  ensure(project.proposal && hashPlan(project.proposal.payload.plan) === project.proposal.payload.proposalHash, 'The current proposal hash is not authentic.');
  return { readiness, snapshot: copy(project.snapshot), projectRoot: project.root.key,
    proposalKey: project.proposal.key, proposalHash: project.proposal.payload.proposalHash, source: activeSource(project),
    assignmentMap: project.proposal.payload.plan.allocations.map(item => ({ requirementId: item.requirementId,
      publisherRoot: item.publisherRoot, offerId: item.offerId, quantity: item.quantity, unit: item.unit, reservation: item.interval })),
    history: project.proposalHistory.map(item => ({ key: item.key, proposalHash: item.payload.proposalHash, predecessor: item.payload.plan.predecessor })),
    historyStatus: project.proposalHistoryStatus ?? { complete: false, reasons: [{ code: 'evidence_unavailable' as const }] } };
}
