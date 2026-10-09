import { describe, expect, it } from 'vitest';
import { hashOffer, hashPlan, hashRequirements } from '../canonical';
import { deriveExecution, planDiff, remainingWork, reuseRecipe, transferStatementHash } from '../execution';
import { prepareAttestation, prepareCloseProject, prepareDecision, prepareReleaseCommitment, prepareReleaseCustodyHold } from '../operations';
import type { OperationResult, PreparedBookChange } from '../operations';
import { activeSource, deriveDraftStatus, deriveReadiness } from '../readiness';
import { deriveRequiredApprovers } from '../validation';
import type { Actor, Attestation, BookState, EntityKey, EntityPayload, EntityRecord, PlanDocument, ProjectAggregate, PublisherAggregate, Snapshot } from '../types';

const NOW = 1_000_000;
const ROOT: EntityKey = 'local:project';
const OWNER: EntityKey = 'local:owner';
const RECEIVER: EntityKey = 'local:receiver';
const coordinator: Actor = { kind: 'local', id: 'local-actor:coordinator' };
const owner: Actor = { kind: 'local', id: 'local-actor:owner' };
const receiver: Actor = { kind: 'local', id: 'local-actor:receiver' };
const base = { protocol: 'partfolk/1' as const, schemaVersion: 1 as const, createdAt: NOW - 100, operationId: 'seed' };
const snapshot = (): Snapshot => ({ mode: 'local', chainId: null, blockNumber: null, blockHash: null,
  blockTimestamp: NOW, fetchedAt: NOW, completeness: 'complete', freshness: 'fresh', source: 'local', reasons: [] });
function record<T extends EntityPayload>(key: EntityKey, payload: T, actor: Actor): EntityRecord<T> {
  return { key, payload, provenance: { mode: 'local', creator: actor, owner: actor, readonly: true,
    permissionlessExtension: false, contentType: 'application/json', createdAtBlock: null, expiresAtBlock: null, transactionHash: null } };
}
function publisher(key: EntityKey, actor: Actor, equipment = false): PublisherAggregate {
  const resourceId = equipment ? 'boards' : 'self';
  const kind = equipment ? 'equipment' : 'person';
  const book: BookState = { ...base, entityType: 'book_state', publisherRoot: key, predecessorKeys: [], name: key, description: '',
    resources: [{ id: resourceId, name: resourceId, kind, unit: equipment ? 'board' : 'person', capacity: equipment ? 2 : 1,
      capabilities: ['work'], availability: [{ start: NOW, end: NOW + 10_000 }] }],
    offers: [{ id: 'offer', title: 'Offer', resourceId, kind, unit: equipment ? 'board' : 'person', quantity: equipment ? 2 : 1,
      capabilities: ['work'], availability: [{ start: NOW, end: NOW + 10_000 }], projectScope: [], conditions: [], instructions: '' }],
    decisions: [], grants: [], attestations: [], custodyHolds: [], retentionDays: 90 };
  return { root: record(key, { ...base, entityType: 'publisher_root', publisher: actor, kind: equipment ? 'organization' : 'individual' }, actor),
    book: { status: 'unique', entity: record(`${key}:book`, book, actor) }, snapshot: snapshot() };
}
function fixture(equipment = false): ProjectAggregate {
  const publishers = [publisher(OWNER, owner, equipment)];
  if (equipment) publishers.push(publisher(RECEIVER, receiver));
  const book = publishers[0]!.book;
  if (book.status !== 'unique') throw new Error('fixture');
  const offer = book.entity.payload.offers[0]!;
  const interval = { start: NOW + 100, end: NOW + 900 };
  const variant = { id: 'v', title: 'Variant', venueId: 'hall', timeZone: 'UTC', instructions: '',
    requirements: [{ id: 'r', title: 'Work', kind: offer.kind, capability: 'work', unit: offer.unit, quantity: offer.quantity, interval, instructions: '', dependsOn: [] }] };
  const allocation = { id: 'a', requirementId: 'r', publisherRoot: OWNER, offerId: 'offer', offerHash: hashOffer(OWNER, offer),
    resourceId: offer.resourceId, quantity: offer.quantity, unit: offer.unit,
    interval: equipment ? { start: NOW + 10, end: NOW + 990 } : interval };
  const plan: PlanDocument = { protocol: 'partfolk/1', validationVersion: 1, chainId: null, projectRoot: ROOT,
    outcome: 'Work complete', variant, offers: [{ publisherRoot: OWNER, offerId: 'offer', offerHash: allocation.offerHash }],
    resourceAssumptions: [{ publisherRoot: OWNER, resourceId: offer.resourceId, capacity: offer.quantity, unit: offer.unit }],
    allocations: [allocation], requiredApprovers: [], conditions: [], instructions: '', predecessor: null,
    runbook: [{ kind: 'task', id: 'task', title: 'Work', publisherRoot: OWNER, interval, allocationIds: ['a'], dependsOn: [], instructions: '' }] };
  if (equipment) plan.runbook.push(
    { kind: 'handover', id: 'send', transferId: 'delivery', title: 'Deliver boards', publisherRoot: OWNER, resourceId: 'boards',
      quantity: 2, unit: 'board', giver: OWNER, receiver: RECEIVER, interval: { start: NOW + 10, end: NOW + 50 }, allocationIds: ['a'], dependsOn: [], instructions: '' },
    { kind: 'return', id: 'return', transferId: 'return-delivery', title: 'Return boards', publisherRoot: RECEIVER, resourceId: 'boards',
      quantity: 2, unit: 'board', giver: RECEIVER, receiver: OWNER, interval: { start: NOW + 950, end: NOW + 990 }, allocationIds: ['a'], dependsOn: ['task'], instructions: '' });
  plan.requiredApprovers = deriveRequiredApprovers(plan);
  const proposalHash = hashPlan(plan);
  const proposal = record('local:proposal', { ...base, entityType: 'proposal' as const, projectRoot: ROOT,
    requirementsHash: hashRequirements(ROOT, variant.requirements), proposalHash, plan, changeExplanation: '' }, coordinator);
  return { root: record(ROOT, { ...base, entityType: 'project_root', coordinator }, coordinator),
    state: { status: 'unique', entity: record('local:state', { ...base, entityType: 'project_state', projectRoot: ROOT,
      predecessorKeys: [], recipe: { title: 'Test', outcome: 'Work complete', timeZone: 'UTC', variants: [variant], instructions: '' },
      publisherRoots: publishers.map(p => p.root.key), lifecycle: 'planning', completedWork: [], completion: null }, coordinator) },
    activation: { status: 'unique', entity: record('local:activation', { ...base, entityType: 'plan_activation', projectRoot: ROOT,
      proposalKey: proposal.key, proposalHash, predecessorActivationKeys: [] }, coordinator) },
    proposal, proposalHistory: [proposal], publishers, snapshot: snapshot() };
}
function value<T>(result: OperationResult<T>): T {
  expect(result.ok ? [] : result.reasons).toEqual([]);
  if (!result.ok) throw new Error(JSON.stringify(result.reasons));
  return result.value;
}
function apply(project: ProjectAggregate, root: EntityKey, result: OperationResult<PreparedBookChange>): void {
  const { book } = value(result);
  const p = project.publishers.find(p => p.root.key === root)!;
  p.book = { status: 'unique', entity: record(`${root}:book:${book.operationId}`, book, p.root.payload.publisher) };
}
function accept(project: ProjectAggregate, root: EntityKey = OWNER, actor = owner): void {
  apply(project, root, prepareDecision(project, root, actor, { status: 'accepted', operationId: `accept-${root}`, now: NOW, validUntil: NOW + 2000 }));
}
function book(project: ProjectAggregate, root: EntityKey = OWNER): BookState {
  const p = project.publishers.find(p => p.root.key === root)!;
  if (p.book.status !== 'unique') throw new Error('missing book');
  return p.book.entity.payload;
}
function report(project: ProjectAggregate, quantity = 2, action: 'handover' | 'return' = 'handover'): Extract<Attestation, { kind: 'transfer_report' }> {
  const item = { ...activeSource(project)!, id: `${action}-${quantity}`, kind: 'transfer_report' as const,
    obligationId: action === 'handover' ? 'send' : 'return', author: action === 'handover' ? OWNER : RECEIVER,
    recordedAt: NOW - 10, operationId: `${action}-${quantity}`, transferId: action === 'handover' ? 'delivery' : 'return-delivery',
    action, resourceId: 'boards', quantity, unit: 'board', giver: action === 'handover' ? OWNER : RECEIVER,
    receiver: action === 'handover' ? RECEIVER : OWNER };
  return { ...item, statementHash: transferStatementHash(item) };
}
function acknowledgement(project: ProjectAggregate, sent: Extract<Attestation, { kind: 'transfer_report' }>, quantity: number): Extract<Attestation, { kind: 'transfer_acknowledgement' }> {
  return { ...activeSource(project)!, id: `ack-${sent.id}`, operationId: `ack-${sent.id}`, kind: 'transfer_acknowledgement',
    obligationId: sent.obligationId, author: sent.receiver, recordedAt: NOW, transferId: sent.transferId, statementHash: sent.statementHash,
    acknowledgedQuantity: quantity, giver: sent.giver, receiver: sent.receiver, resourceId: sent.resourceId, action: sent.action };
}

describe('exact-activation consent', () => {
  it('distinguishes a never-activated planning project from an expired active plan', () => {
    const p = fixture();
    p.proposal = null; p.proposalHistory = [];
    p.activation = { status: 'missing', reason: 'not_initialized' };
    expect(deriveReadiness(p, NOW).status).toBe('possible');
    p.activation = { status: 'missing', reason: 'expired_or_deleted' };
    expect(deriveReadiness(p, NOW).status).toBe('changed');
  });
  it('has no inferred agreement; only the owner can accept and decision+grant count together', () => {
    const p = fixture();
    expect(deriveReadiness(p, NOW).status).toBe('awaiting_approval');
    expect(prepareDecision(p, OWNER, coordinator, { status: 'accepted', operationId: 'forged', now: NOW, validUntil: NOW + 2000 }).ok).toBe(false);
    accept(p);
    expect(deriveReadiness(p, NOW).status).toBe('ready');
    book(p).grants = [];
    expect(deriveReadiness(p, NOW).status).toBe('changed');
  });

  it('stamps consent with canonical block time even when the action clock is slightly later', () => {
    const p = fixture();
    const prepared = value(prepareDecision(p, OWNER, owner, { status: 'accepted', operationId: 'later-clock', now: NOW + 2000, validUntil: NOW + 4000 }));
    expect(prepared.book.decisions[0]?.decidedAt).toBe(NOW);
    expect(prepared.book.grants[0]?.acceptedAt).toBe(NOW);
    expect(prepared.book.createdAt).toBe(NOW + 2000);
  });

  it('retains decline and withdrawal across JSON reload and permits fresh reacceptance', () => {
    const p = fixture();
    apply(p, OWNER, prepareDecision(p, OWNER, owner, { status: 'declined', operationId: 'decline', now: NOW, reason: 'Unavailable' }));
    expect(deriveReadiness(JSON.parse(JSON.stringify(p)), NOW).status).toBe('declined');
    accept(p);
    apply(p, OWNER, prepareDecision(p, OWNER, owner, { status: 'withdrawn', operationId: 'withdraw', now: NOW }));
    expect(deriveReadiness(JSON.parse(JSON.stringify(p)), NOW).status).toBe('changed');
    expect(book(p).grants).toEqual([]);
  });

  it('requires fresh decisions when old material terms return under a new activation', () => {
    const p = fixture(); accept(p);
    if (p.activation.status !== 'unique') throw new Error('fixture');
    p.activation.entity.key = 'local:activation-third';
    expect(deriveReadiness(p, NOW).status).toBe('awaiting_approval');
    expect(book(p).decisions[0]?.activationKey).toBe('local:activation');
    accept(p);
    expect(book(p).decisions).toHaveLength(2);
    expect(book(p).grants).toHaveLength(1);
    expect(deriveReadiness(p, NOW).status).toBe('ready');
  });

  it('preserves readiness for unrelated offers and changes it for selected terms', () => {
    const p = fixture(); accept(p);
    book(p).offers.push({ ...book(p).offers[0]!, id: 'unselected', instructions: 'New option' });
    expect(deriveReadiness(p, NOW).status).toBe('ready');
    book(p).offers[0]!.instructions = 'Changed selected condition';
    expect(deriveReadiness(p, NOW).status).toBe('changed');
  });

  it('keeps active consent bound to immutable terms while exposing selected draft changes', () => {
    const p = fixture(); accept(p);
    if (p.state.status !== 'unique') throw new Error('fixture');
    p.state.entity.payload.recipe = structuredClone(p.state.entity.payload.recipe);
    p.state.entity.payload.recipe.variants.push({ ...structuredClone(p.state.entity.payload.recipe.variants[0]!), id: 'unselected' });
    expect(deriveDraftStatus(p)).toEqual({ changed: false, changedFields: [] });
    p.state.entity.payload.recipe.variants[0]!.requirements[0]!.quantity = 2;
    expect(deriveReadiness(p, NOW).status).toBe('ready');
    expect(deriveDraftStatus(p)).toEqual({ changed: true, changedFields: ['variant.requirements'] });
  });

  it('compares draft requirement sets canonically and keeps unrelated lineage gaps separate', () => {
    const p = fixture(); accept(p);
    p.proposalHistoryStatus = { complete: false, reasons: [{ code: 'evidence_unavailable' }] };
    expect(deriveReadiness(p, NOW).status).toBe('ready');
    expect(deriveReadiness(p, NOW).evidenceAvailability).toBe('partial');
    if (p.state.status !== 'unique') throw new Error('fixture');
    const second = { ...p.proposal!.payload.plan.variant.requirements[0]!, id: 'second' };
    p.proposal!.payload.plan.variant.requirements.push(second);
    p.state.entity.payload.recipe.variants[0] = structuredClone(p.proposal!.payload.plan.variant);
    p.state.entity.payload.recipe.variants[0]!.requirements.reverse();
    expect(deriveDraftStatus(p).changed).toBe(false);
  });

  it('never presents missing, incomplete, stale or forked data as current agreement', () => {
    const p = fixture(); accept(p);
    const missing = structuredClone(p); missing.publishers[0]!.book = { status: 'missing', reason: 'expired_or_deleted' };
    expect(deriveReadiness(missing, NOW).status).toBe('changed');
    const incomplete = structuredClone(p); incomplete.snapshot.completeness = 'incomplete';
    expect(deriveReadiness(incomplete, NOW).status).toBe('unverified');
    expect(deriveReadiness(p, NOW + 60_001).status).toBe('unverified');
    const fork = structuredClone(p); if (fork.activation.status !== 'unique') throw new Error('fixture');
    fork.activation = { status: 'conflict', entities: [fork.activation.entity, { ...fork.activation.entity, key: 'local:fork' }] };
    expect(deriveReadiness(fork, NOW).status).toBe('conflict');
  });

  it('returns unverified for malformed material or book arrays instead of throwing', () => {
    const proposal = fixture();
    (proposal.proposal!.payload.plan as unknown as { allocations: null }).allocations = null;
    expect(deriveReadiness(proposal, NOW).status).toBe('unverified');
    const malformedBook = fixture();
    (book(malformedBook) as unknown as { decisions: null }).decisions = null;
    expect(deriveReadiness(malformedBook, NOW).status).toBe('unverified');
  });

  it('does not make unrelated, unselected publisher history an active agreement dependency', () => {
    const p = fixture(); accept(p);
    const unrelated = publisher('local:unselected', receiver);
    unrelated.book = { status: 'missing', reason: 'expired_or_deleted' };
    p.publishers.push(unrelated);
    expect(deriveReadiness(p, NOW).status).toBe('ready');
  });

  it('rejects a deadline before the last duty, expires exact holds, and detects contradictory decisions', () => {
    const p = fixture(true);
    expect(prepareDecision(p, OWNER, owner, { status: 'accepted', operationId: 'too-short', now: NOW, validUntil: NOW + 950 }).ok).toBe(false);
    accept(p); accept(p, RECEIVER, receiver);
    p.snapshot.blockTimestamp = NOW + 2000; p.snapshot.fetchedAt = NOW + 2000;
    p.publishers.forEach(publisher => { publisher.snapshot = { ...p.snapshot }; });
    expect(deriveReadiness(p, NOW + 2000).reasons.some(r => r.code === 'grant_expired')).toBe(true);
    const fresh = fixture(); accept(fresh);
    book(fresh).decisions.push({ ...book(fresh).decisions[0]!, status: 'declined' });
    expect(deriveReadiness(fresh, NOW).status).toBe('conflict');
  });

  it('counts another project hold while accepting and replaces same-project allocation once', () => {
    const p = fixture(); accept(p);
    const current = book(p).grants[0]!;
    book(p).grants.push({ ...structuredClone(current), id: 'other', projectRoot: 'local:other', activationKey: 'local:other-activation' });
    book(p).decisions.push({ ...book(p).decisions[0]!, projectRoot: 'local:other', activationKey: 'local:other-activation' });
    expect(deriveReadiness(p, NOW).reasons.some(r => r.code === 'capacity_exceeded')).toBe(true);
    expect(prepareDecision(p, OWNER, owner, { status: 'accepted', operationId: 'replace', now: NOW, validUntil: NOW + 2000 }).ok).toBe(false);
    book(p).grants.pop(); book(p).decisions.pop();
    accept(p);
    expect(book(p).grants).toHaveLength(1);
    expect(deriveReadiness(p, NOW).status).toBe('ready');
  });
});

describe('execution, closure and reuse', () => {
  it('never upgrades a coordinator completion list into participant evidence', () => {
    const p = fixture();
    if (p.state.status !== 'unique') throw new Error('fixture');
    p.state.entity.payload.completedWork = [{ source: activeSource(p)!, obligationId: 'task', attestationIds: [], recordedAt: NOW, evidenceAvailability: 'available' }];
    expect(deriveExecution(p).evidenceAvailability).toBe('unavailable');
    expect(deriveExecution(p).outstandingObligationIds).toContain('task');
    expect(prepareCloseProject(p, coordinator, { outcome: 'completed', statement: '', operationId: 'close-forged', now: NOW }).ok).toBe(false);
  });
  it('keeps completed history on withdrawal, retains degraded evidence, and repairs remaining duties', () => {
    const p = fixture(); accept(p);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, { ...activeSource(p)!, id: 'done', operationId: 'done',
      kind: 'task_report', obligationId: 'task', author: OWNER, recordedAt: NOW, status: 'done', note: 'Installed' }));
    const complete = deriveExecution(p).completed;
    expect(complete).toHaveLength(1);
    if (p.state.status !== 'unique') throw new Error('fixture');
    p.state.entity.payload.completedWork = complete;
    apply(p, OWNER, prepareDecision(p, OWNER, owner, { status: 'withdrawn', operationId: 'withdraw', now: NOW }));
    expect(deriveExecution(p).completed[0]?.evidenceAvailability).toBe('available');
    expect(remainingWork(p)?.plan.runbook).toEqual([]);
    expect(remainingWork(p)?.plan.predecessor).toEqual(activeSource(p));
    book(p).attestations = [];
    expect(deriveExecution(p).completed[0]?.evidenceAvailability).toBe('unavailable');
    expect(remainingWork(p)?.plan.runbook).toEqual([]);
  });

  it('distinguishes reported, partially acknowledged and fully acknowledged handovers', () => {
    const p = fixture(true);
    const sent = report(p);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, sent));
    expect(deriveExecution(p).outstandingObligationIds).toContain('send');
    const ack = acknowledgement(p, sent, 1);
    apply(p, RECEIVER, prepareAttestation(p, RECEIVER, receiver, ack));
    expect(deriveExecution(p).outstandingObligationIds).toContain('send');
    expect(book(p).custodyHolds[0]?.quantity).toBe(2);
    expect(prepareAttestation(p, OWNER, owner, { ...ack, id: 'foreign', operationId: 'foreign' }).ok).toBe(false);
    const full = fixture(true); const fullSent = report(full);
    apply(full, OWNER, prepareAttestation(full, OWNER, owner, fullSent));
    apply(full, RECEIVER, prepareAttestation(full, RECEIVER, receiver, acknowledgement(full, fullSent, 2)));
    expect(deriveExecution(full).completed.map(c => c.obligationId)).toContain('send');
  });

  it('repairs only the acknowledged quantity still outstanding and reduces its allocations', () => {
    const p = fixture(true);
    if (p.activation.status !== 'unique') throw new Error('fixture');
    p.proposal!.payload.plan.runbook = p.proposal!.payload.plan.runbook.filter(o => o.id === 'send');
    p.proposal!.payload.proposalHash = hashPlan(p.proposal!.payload.plan);
    p.activation.entity.payload.proposalHash = p.proposal!.payload.proposalHash;
    const sent = report(p);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, sent));
    apply(p, RECEIVER, prepareAttestation(p, RECEIVER, receiver, acknowledgement(p, sent, 1)));
    const repair = remainingWork(p)!;
    expect(repair.plan.runbook[0]).toMatchObject({ id: 'send', quantity: 1 });
    expect(repair.plan.allocations[0]?.quantity).toBe(1);
    expect(repair.plan.variant.requirements[0]?.quantity).toBe(1);
    book(p).offers[0]!.instructions = 'Owner changed current terms';
    expect(remainingWork(p)?.execution.reasons.some(r => r.code === 'offer_changed')).toBe(true);
  });

  it('removes conditions belonging solely to completed offers from a remaining-work package', () => {
    const p = fixture();
    if (p.activation.status !== 'unique') throw new Error('fixture');
    const condition = { kind: 'allowed_variants' as const, variantIds: ['v'] };
    book(p).offers[0]!.conditions = [condition];
    const plan = p.proposal!.payload.plan;
    plan.conditions = [condition];
    const offerHash = hashOffer(OWNER, book(p).offers[0]!);
    plan.offers[0]!.offerHash = offerHash; plan.allocations[0]!.offerHash = offerHash;
    p.proposal!.payload.proposalHash = hashPlan(plan); p.activation.entity.payload.proposalHash = p.proposal!.payload.proposalHash;
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, { ...activeSource(p)!, id: 'done', operationId: 'done',
      kind: 'task_report', obligationId: 'task', author: OWNER, recordedAt: NOW, status: 'done', note: '' }));
    expect(remainingWork(p)?.plan.conditions).toEqual([]);
  });

  it('rejects an acknowledgement beyond quantity and a mismatched statement digest', () => {
    const p = fixture(true); const sent = report(p, 1);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, sent));
    expect(prepareAttestation(p, RECEIVER, receiver, acknowledgement(p, sent, 2)).ok).toBe(false);
    const wrong = acknowledgement(p, sent, 1); wrong.statementHash = `0x${'0'.repeat(64)}`;
    expect(prepareAttestation(p, RECEIVER, receiver, wrong).ok).toBe(false);
    expect(deriveExecution(p).completed).toEqual([]);
  });

  it('requires the asset owner to acknowledge return and keeps partial custody unavailable', () => {
    const p = fixture(true); const sent = report(p);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, sent));
    const returned = report(p, 1, 'return');
    apply(p, RECEIVER, prepareAttestation(p, RECEIVER, receiver, returned));
    expect(book(p).custodyHolds[0]?.quantity).toBe(2);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, acknowledgement(p, returned, 1)));
    expect(book(p).custodyHolds[0]?.status).toBe('outstanding');
    expect(book(p).custodyHolds[0]?.quantity).toBe(1);
    expect(prepareReleaseCustodyHold(p.publishers[0]!, coordinator, sent.id, 'bad-release', NOW, 'Claimed returned').ok).toBe(false);
    apply(p, OWNER, prepareReleaseCustodyHold(p.publishers[0]!, owner, sent.id, 'release', NOW, 'Owner corrected inventory after physical return'));
    expect(book(p).custodyHolds[0]?.status).toBe('released');
  });

  it('rejects duplicate receipts and reconciles corrections without releasing custody twice', () => {
    const p = fixture(true);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, report(p)));
    const returned = report(p, 2, 'return');
    apply(p, RECEIVER, prepareAttestation(p, RECEIVER, receiver, returned));
    const first = { ...acknowledgement(p, returned, 1), recordedAt: NOW - 6 };
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, first));
    expect(book(p).custodyHolds[0]?.quantity).toBe(1);
    expect(prepareAttestation(p, OWNER, owner, { ...first, id: 'duplicate', operationId: 'duplicate', recordedAt: NOW }).ok).toBe(false);
    const same = { ...first, id: 'correction-same', operationId: 'correction-same', correctsAttestationId: first.id, recordedAt: NOW - 4 };
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, same));
    expect(book(p).custodyHolds[0]?.status).toBe('outstanding');
    expect(book(p).custodyHolds[0]?.quantity).toBe(1);
    const full = { ...same, id: 'correction-full', operationId: 'correction-full', correctsAttestationId: same.id, recordedAt: NOW - 2, acknowledgedQuantity: 2 };
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, full));
    expect(book(p).custodyHolds[0]?.status).toBe('released');
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, { ...full, id: 'correction-partial', operationId: 'correction-partial',
      correctsAttestationId: full.id, recordedAt: NOW, acknowledgedQuantity: 1 }));
    expect(book(p).custodyHolds[0]?.status).toBe('outstanding');
    expect(book(p).custodyHolds[0]?.quantity).toBe(1);
  });

  it('does not reuse an earlier return to release a later handover after corrected availability', () => {
    const p = fixture(true);
    const plan = p.proposal!.payload.plan;
    const firstObligation = plan.runbook.find(o => o.id === 'send')!;
    if (firstObligation.kind === 'task' || p.activation.status !== 'unique') throw new Error('fixture');
    plan.runbook.push({ ...firstObligation, id: 'send-again', transferId: 'second-delivery', quantity: 1 });
    p.proposal!.payload.proposalHash = hashPlan(plan); p.activation.entity.payload.proposalHash = hashPlan(plan);
    const first = report(p);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, first));
    const returned = report(p, 1, 'return');
    apply(p, RECEIVER, prepareAttestation(p, RECEIVER, receiver, returned));
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, { ...acknowledgement(p, returned, 1), recordedAt: NOW - 2 }));
    apply(p, OWNER, prepareReleaseCustodyHold(p.publishers[0]!, owner, first.id, 'correct-availability', NOW - 1, 'Owner corrected inventory'));
    const second = { ...report(p, 1), id: 'second-send', operationId: 'second-send', obligationId: 'send-again', transferId: 'second-delivery', recordedAt: NOW };
    second.statementHash = transferStatementHash(second);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, second));
    const secondHold = book(p).custodyHolds.find(h => h.id === second.id)!;
    expect(secondHold.status).toBe('outstanding');
    expect(secondHold.quantity).toBe(1);
  });

  it('preserves another project custody ledger when recording progress in this project', () => {
    const first = fixture(true);
    apply(first, OWNER, prepareAttestation(first, OWNER, owner, report(first)));
    const returned = report(first, 2, 'return');
    apply(first, RECEIVER, prepareAttestation(first, RECEIVER, receiver, returned));
    apply(first, OWNER, prepareAttestation(first, OWNER, owner, acknowledgement(first, returned, 2)));
    const held = structuredClone(book(first).custodyHolds);
    const second = fixture(true);
    if (second.state.status !== 'unique' || second.activation.status !== 'unique') throw new Error('fixture');
    second.root.key = 'local:other-project';
    second.state.entity.payload.projectRoot = second.root.key;
    second.proposal!.payload.projectRoot = second.root.key;
    second.proposal!.payload.plan.projectRoot = second.root.key;
    second.proposal!.payload.plan.runbook = second.proposal!.payload.plan.runbook.filter(o => o.kind === 'task');
    second.proposal!.payload.plan.requiredApprovers = [OWNER];
    second.proposal!.payload.proposalHash = hashPlan(second.proposal!.payload.plan);
    second.proposal!.payload.requirementsHash = hashRequirements(second.root.key, second.proposal!.payload.plan.variant.requirements);
    second.activation.entity.payload.projectRoot = second.root.key;
    second.activation.entity.payload.proposalHash = second.proposal!.payload.proposalHash;
    second.publishers = [structuredClone(first.publishers[0]!)];
    apply(second, OWNER, prepareAttestation(second, OWNER, owner, { ...activeSource(second)!, id: 'other-done', operationId: 'other-done',
      kind: 'task_report', obligationId: 'task', author: OWNER, recordedAt: NOW, status: 'done', note: '' }));
    expect(book(second).custodyHolds).toEqual(held);
  });

  it('verifies each retained completion against its own source after a repair', () => {
    const p = fixture();
    const source = activeSource(p)!;
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, { ...source, id: 'first-done', operationId: 'first-done',
      kind: 'task_report', obligationId: 'task', author: OWNER, recordedAt: NOW, status: 'done', note: '' }));
    const completed = deriveExecution(p).completed;
    if (p.state.status !== 'unique' || p.activation.status !== 'unique') throw new Error('fixture');
    p.state.entity.payload.completedWork = completed;
    const plan = structuredClone(p.proposal!.payload.plan);
    plan.predecessor = source;
    plan.runbook[0]!.id = 'second-task';
    const proposalHash = hashPlan(plan);
    const proposal = record('local:proposal-two', { ...p.proposal!.payload, plan, proposalHash }, coordinator);
    p.proposal = proposal; p.proposalHistory.push(proposal);
    p.activation = { status: 'unique', entity: record('local:activation-two', { ...p.activation.entity.payload,
      proposalKey: proposal.key, proposalHash, predecessorActivationKeys: [source.activationKey] }, coordinator) };
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, { ...activeSource(p)!, id: 'second-done', operationId: 'second-done',
      kind: 'task_report', obligationId: 'second-task', author: OWNER, recordedAt: NOW, status: 'done', note: '' }));
    expect(deriveExecution(p).completed.map(w => w.evidenceAvailability)).toEqual(['available', 'available']);
    expect(prepareCloseProject(p, coordinator, { outcome: 'completed', statement: 'Both tasks recorded', operationId: 'close', now: NOW }).ok).toBe(true);
    p.proposalHistory = [proposal];
    expect(deriveExecution(p).completed.find(w => w.obligationId === 'task')?.evidenceAvailability).toBe('unavailable');
  });

  it('closes by consuming activation while leaving owner grants and custody unchanged', () => {
    const p = fixture(true); accept(p); accept(p, RECEIVER, receiver);
    apply(p, OWNER, prepareAttestation(p, OWNER, owner, report(p)));
    expect(prepareCloseProject(p, coordinator, { outcome: 'completed', statement: '', operationId: 'bad-close', now: NOW }).ok).toBe(false);
    const closed = value(prepareCloseProject(p, coordinator, { outcome: 'cancelled', statement: 'Cancelled', operationId: 'close', now: NOW }));
    expect(closed.expectedActivationHeads).toEqual(['local:activation']);
    const source = activeSource(p)!;
    p.state = { status: 'unique', entity: record('local:closed', closed.state, coordinator) };
    p.activation = { status: 'missing', reason: 'expired_or_deleted' };
    expect(deriveReadiness(p, NOW).reasons.map(r => r.code)).not.toContain('missing_activation');
    expect(deriveReadiness(p, NOW).outcome).toBe('cancelled');
    expect(book(p).grants).toHaveLength(1);
    expect(book(p).custodyHolds[0]?.status).toBe('outstanding');
    apply(p, OWNER, prepareReleaseCommitment(p.publishers[0]!, owner, book(p).grants[0]!, 'release', NOW));
    expect(book(p).grants).toHaveLength(0);
    expect(book(p).attestations).toHaveLength(1);
    if (p.state.status !== 'unique') throw new Error('fixture');
    p.state.entity.payload.lifecycle = 'planning';
    expect(deriveReadiness(p, NOW).outcome).toBe(null);
    expect(p.state.entity.payload.completion?.outcome).toBe('cancelled');
  });

  it('compares whole material plans and copies only the recipe without dates or promises', () => {
    const p = fixture(); accept(p);
    const before = p.proposal!.payload.plan;
    const after = structuredClone(before); after.instructions = 'Changed instructions';
    expect(planDiff(before, after).requiresFreshAgreement).toEqual([OWNER]);
    expect(planDiff(before, structuredClone(before)).materialChanged).toBe(false);
    const reused = reuseRecipe(p)!;
    expect(reused.sourceProjectRoot).toBe(ROOT);
    expect(reused.variants[0]!.requirements[0]).not.toHaveProperty('interval');
    expect(reused).not.toHaveProperty('publishers');
    expect(reused).not.toHaveProperty('grants');
    expect(reused).not.toHaveProperty('completedWork');
  });
});
