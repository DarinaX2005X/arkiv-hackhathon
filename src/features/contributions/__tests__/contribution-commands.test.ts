import { describe, expect, it } from 'vitest';
import { createLocalRepository, createMemoryStorage } from '../../../data/local';
import { createOperationIntent } from '../../../data/operations';
import { hashPlan, hashRequirements } from '../../../domain/canonical';
import { makeSmallWorksFixture, smallWorksRecords, SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, SMALL_WORKS_PROJECT_ROOT } from '../../../domain/fixtures';
import { activeSource, deriveDraftStatus, deriveReadiness } from '../../../domain/readiness';
import { solve } from '../../../domain/solver';
import type { Actor, BookState, EntityKey, ProjectAggregate, Proposal, PublisherAggregate } from '../../../domain/types';
import type { Result, WriteAuthority } from '../../../data/types';
import { addDraftOffer, affectedProjects, availabilityWindowError, contributionDraft, copyResourceAvailability, DEFAULT_LIFETIME, editableWindows, hasVerifiedApproval, isContributionDraft, isContributionTarget, materializeContributionDraft, prepareAvailability, prepareDecisionCommand, prepareEmptyRecovery, prepareReleaseCommand, removeDraftResource, startDraftContribution, writeAuthority } from '../model';
import { requestProjects } from '../Requests';
import { createDraftStore } from '../../../app/storage';
import { agreementDifference } from '../difference';

function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
const authority = (actor: Actor): WriteAuthority => { if (actor.kind !== 'local') throw new Error('fixture actor'); return { mode: 'local', actor, chainId: null }; };
function book(publisher: PublisherAggregate): BookState { if (publisher.book.status !== 'unique') throw new Error('fixture book'); return publisher.book.entity.payload; }
async function activeFixture() {
  const repository = createLocalRepository({ namespace: 'practice', storage: createMemoryStorage(), now: () => SMALL_WORKS_NOW });
  value(repository.seed(smallWorksRecords({ oak: true })));
  const input = makeSmallWorksFixture({ oak: true }); const candidate = solve(input).candidates[0]!;
  const proposal: Proposal = { protocol: 'partfolk/1', schemaVersion: 1, entityType: 'proposal', operationId: 'proposal', createdAt: SMALL_WORKS_NOW,
    projectRoot: input.projectRoot, requirementsHash: hashRequirements(input.projectRoot, candidate.plan.variant.requirements), proposalHash: hashPlan(candidate.plan), plan: candidate.plan, changeExplanation: 'Initial complete plan.' };
  const pubInput = { projectRoot: input.projectRoot, proposal, lifetimeSeconds: DEFAULT_LIFETIME };
  const published = value(await repository.publishProposal({ ...pubInput, operation: createOperationIntent('publish_proposal', authority(SMALL_WORKS_COORDINATOR), pubInput, { id: 'proposal', now: SMALL_WORKS_NOW }) }));
  const activation = { projectRoot: input.projectRoot, expectedActivationHeads: [], proposalKey: published.value.key, proposalHash: proposal.proposalHash, lifetimeSeconds: DEFAULT_LIFETIME };
  value(await repository.activateProposal({ ...activation, operation: createOperationIntent('activate_proposal', authority(SMALL_WORKS_COORDINATOR), activation, { id: 'activation', now: SMALL_WORKS_NOW }) }));
  return { repository, project: value(await repository.loadProject(input.projectRoot)) };
}
function firstOwner(project: ProjectAggregate) { return project.publishers.find(p => project.proposal!.payload.plan.requiredApprovers.includes(p.root.key))!; }

describe('owner contribution commands', () => {
  it('shows a recorded acceptance as verified only while its current exact terms and grant can be checked', async () => {
    const { repository, project } = await activeFixture(); const owner = firstOwner(project);
    value(await repository.replaceBook(prepareDecisionCommand(project, owner.root.key, authority(owner.root.payload.publisher), {
      status: 'accepted', validUntil: SMALL_WORKS_NOW + 15 * 86400000, id: 'approval-display', now: SMALL_WORKS_NOW, reviewedSource: activeSource(project)!,
    })));
    const current = value(await repository.loadProject(project.root.key));
    expect(hasVerifiedApproval(deriveReadiness(current, SMALL_WORKS_NOW), owner.root.key)).toBe(true);
    const stale = structuredClone(current); stale.snapshot.freshness = 'stale';
    const missingGrant = structuredClone(current); book(firstOwner(missingGrant)).grants = [];
    const changedOffer = structuredClone(current); book(firstOwner(changedOffer)).offers[0]!.instructions += ' Different return terms.';
    const newActivation = structuredClone(current); if (newActivation.activation.status !== 'unique') throw new Error('fixture'); newActivation.activation.entity.key = 'local:replacement-activation';
    for (const changed of [stale, missingGrant, changedOffer, newActivation]) {
      expect(book(firstOwner(changed)).decisions[0]!.status).toBe('accepted');
      expect(hasVerifiedApproval(deriveReadiness(changed, SMALL_WORKS_NOW), owner.root.key)).toBe(false);
    }
    expect(hasVerifiedApproval(deriveReadiness(current, SMALL_WORKS_NOW + 16 * 86400000), owner.root.key)).toBe(false);
  });
  it('preserves current commitments and flags affected projects when the owner changes offer terms', async () => {
    const { repository, project } = await activeFixture(); const owner = firstOwner(project); const actor = authority(owner.root.payload.publisher);
    const command = prepareDecisionCommand(project, owner.root.key, actor, { status: 'accepted', validUntil: SMALL_WORKS_NOW + 15 * 86400000,
      id: 'accept-current', now: SMALL_WORKS_NOW, reviewedSource: activeSource(project)! });
    value(await repository.replaceBook(command));
    const current = value(await repository.loadPublisher(owner.root.key)); const previous = structuredClone(book(current)); const draft = contributionDraft(previous);
    draft.offers[0]!.instructions = 'Changed return instructions.';
    expect(affectedProjects(previous, draft)).toContain(project.root.key);
    const update = prepareAvailability(current, draft, actor, SMALL_WORKS_NOW, 'change-terms');
    expect(update.book.grants).toEqual(previous.grants); expect(update.book.decisions).toEqual(previous.decisions);
    expect(update.book.attestations).toEqual(previous.attestations); expect(update.book.custodyHolds).toEqual(previous.custodyHolds);
    value(await repository.replaceBook(update));
    const fresh = value(await repository.loadProject(project.root.key));
    expect(deriveReadiness(fresh, SMALL_WORKS_NOW).status).toBe('changed');
  });
  it('refuses a foreign actor and an invalid quantity or second personal resource', async () => {
    const { project } = await activeFixture(); const owner = project.publishers.find(p => p.root.key === 'local:cedar')!; const draft = contributionDraft(book(owner));
    expect(() => prepareAvailability(owner, draft, authority(SMALL_WORKS_COORDINATOR), SMALL_WORKS_NOW, 'foreign')).toThrow('Only the current owner');
    draft.offers[0]!.quantity = 1.5;
    expect(() => prepareAvailability(owner, draft, authority(owner.root.payload.publisher), SMALL_WORKS_NOW, 'fraction')).toThrow('Check the contribution');
    draft.offers[0]!.quantity = 1; draft.resources.push({ ...draft.resources[0]!, id: 'second-person' });
    expect(() => prepareAvailability(owner, draft, authority(owner.root.payload.publisher), SMALL_WORKS_NOW, 'second-person')).toThrow('personal time');
  });
  it('binds acceptance to the reviewed activation and rejects old consent after a new activation', async () => {
    const { project } = await activeFixture(); const owner = firstOwner(project); const actor = authority(owner.root.payload.publisher); const reviewed = activeSource(project)!;
    const command = prepareDecisionCommand(project, owner.root.key, actor, { status: 'accepted', validUntil: SMALL_WORKS_NOW + 15 * 86400000, id: 'accept', now: SMALL_WORKS_NOW, reviewedSource: reviewed });
    expect(command.book.grants[0]!.activationKey).toBe(reviewed.activationKey);
    expect(command.book.grants[0]!.proposalKey).toBe(reviewed.proposalKey);
    expect(command.book.grants[0]!.proposalHash).toBe(reviewed.proposalHash);
    expect(command.book.decisions[0]!.operationId).toBe(command.operation.id);
    if (project.activation.status !== 'unique') throw new Error('fixture'); project.activation.entity.key = 'local:new-activation';
    expect(() => prepareDecisionCommand(project, owner.root.key, actor, { status: 'accepted', validUntil: SMALL_WORKS_NOW + 15 * 86400000, id: 'stale', now: SMALL_WORKS_NOW, reviewedSource: reviewed })).toThrow('active plan changed');
  });
  it('stores decline and withdrawal durably and permits owner release of an exact historical hold', async () => {
    const { repository, project } = await activeFixture(); const owner = firstOwner(project); const actor = authority(owner.root.payload.publisher);
    const decision = (p: ProjectAggregate, status: 'accepted' | 'declined' | 'withdrawn', id: string) => prepareDecisionCommand(p, owner.root.key, actor, { status, reason: 'Owner-authored reason', validUntil: SMALL_WORKS_NOW + 15 * 86400000, id, now: SMALL_WORKS_NOW, reviewedSource: activeSource(p)! });
    value(await repository.replaceBook(decision(project, 'declined', 'decline')));
    let fresh = value(await repository.loadProject(project.root.key)); expect(book(firstOwner(fresh)).decisions[0]!.status).toBe('declined');
    value(await repository.replaceBook(decision(fresh, 'accepted', 'accept')));
    fresh = value(await repository.loadProject(project.root.key));
    value(await repository.replaceBook(decision(fresh, 'withdrawn', 'withdraw')));
    fresh = value(await repository.loadProject(project.root.key)); expect(book(firstOwner(fresh)).grants).toHaveLength(0); expect(book(firstOwner(fresh)).decisions[0]!.status).toBe('withdrawn');
    value(await repository.replaceBook(decision(fresh, 'accepted', 'reaccept')));
    const publisher = value(await repository.loadPublisher(owner.root.key)); const source = book(publisher).grants[0]!;
    expect(() => prepareReleaseCommand(publisher, authority(SMALL_WORKS_COORDINATOR), source, SMALL_WORKS_NOW, 'foreign-release')).toThrow('Only the owner');
    const released = prepareReleaseCommand(publisher, actor, source, SMALL_WORKS_NOW, 'release'); value(await repository.replaceBook(released));
    expect(book(value(await repository.loadPublisher(owner.root.key))).grants).toHaveLength(0);
  });
  it('keeps edited project requirements separate from an active proposal', async () => {
    const { project } = await activeFixture(); if (project.state.status !== 'unique') throw new Error('fixture');
    project.state.entity.payload.recipe.outcome = 'A changed draft outcome';
    expect(deriveDraftStatus(project)).toEqual({ changed: true, changedFields: ['outcome'] });
    expect(project.proposal!.payload.plan.outcome).not.toBe(project.state.entity.payload.recipe.outcome);
  });
  it('requires every current owner and only becomes agreed after the last confirmed book update', async () => {
    const { repository, project } = await activeFixture(); const required = project.proposal!.payload.plan.requiredApprovers;
    for (let index = 0; index < required.length; index++) {
      const fresh = value(await repository.loadProject(project.root.key)); const owner = fresh.publishers.find(p => p.root.key === required[index])!;
      expect(deriveReadiness(fresh, SMALL_WORKS_NOW).status).toBe('awaiting_approval');
      const command = prepareDecisionCommand(fresh, owner.root.key, authority(owner.root.payload.publisher), { status: 'accepted', validUntil: SMALL_WORKS_NOW + 15 * 86400000, id: `accept-${index}`, now: SMALL_WORKS_NOW, reviewedSource: activeSource(fresh)! });
      expect(deriveReadiness(fresh, SMALL_WORKS_NOW).acceptedApprovers).toHaveLength(index);
      value(await repository.replaceBook(command));
    }
    expect(deriveReadiness(value(await repository.loadProject(project.root.key)), SMALL_WORKS_NOW).status).toBe('ready');
  });
  it('shows the whole changed requirement, instructions, and return obligation in the agreement diff', async () => {
    const { project } = await activeFixture(); const before = project.proposal!.payload.plan; const after = structuredClone(before);
    after.variant.requirements[0]!.quantity += 1; after.instructions = 'The revised instructions are material.';
    after.runbook[0]!.instructions = 'New owner task instructions.';
    const rows = agreementDifference(before, after);
    expect(rows.some(row => row.id.startsWith('Requirement:') && row.after.includes(String(after.variant.requirements[0]!.quantity)))).toBe(true);
    expect(rows.find(row => row.id === 'instructions')!.after).toBe('The revised instructions are material.');
    expect(rows.some(row => row.id.startsWith('Runbook:') && row.after.includes('New owner task instructions.'))).toBe(true);
  });
  it('discovers projects from retained decisions and custody even when request links are missing', async () => {
    const { project } = await activeFixture(); const owner = firstOwner(project); const command = prepareDecisionCommand(project, owner.root.key, authority(owner.root.payload.publisher), { status: 'declined', id: 'decline', now: SMALL_WORKS_NOW, reviewedSource: activeSource(project)! });
    if (owner.book.status !== 'unique') throw new Error('fixture'); owner.book.entity.payload = command.book;
    expect(requestProjects([owner], [])).toEqual([SMALL_WORKS_PROJECT_ROOT]);
  });
});

describe('availability editor drafts', () => {
  it('starts a resource and offer together while keeping unfinished availability unpublished', () => {
    const draft = startDraftContribution({ name: 'Oak', description: '', resources: [], offers: [] }, { kind: 'equipment', publisherKind: 'individual', id: 'boards' });
    expect(draft.resources).toHaveLength(1); expect(draft.offers).toHaveLength(1);
    expect(draft.offers[0]!.resourceId).toBe(draft.resources[0]!.id);
    expect(draft.offers[0]!.availability).toEqual([]);
    const store = createDraftStore({ storage: createMemoryStorage(), key: 'new-offer', kind: 'contribution', validate: isContributionDraft });
    expect(store.save(draft).persisted).toBe(true);
    const restored = store.load(); if (restored.status !== 'ready') throw new Error('draft');
    expect(restored.value.editorWindows!['offer:offer-boards']![0]!.start).toBe('');
    expect(() => materializeContributionDraft(restored.value)).toThrow('invalid datetime');
    expect(() => startDraftContribution(draft, { kind: 'equipment', publisherKind: 'individual', id: 'boards' })).toThrow('already');
  });
  it('shares one capacity-one personal resource across several offers without replacing edited dates', () => {
    let draft = startDraftContribution({ name: 'Oak', description: '', resources: [], offers: [] }, { kind: 'person', publisherKind: 'individual', id: 'first' });
    draft.editorWindows!['resource:self']![0]!.start = '2026-10-18T10:00';
    draft = startDraftContribution(draft, { kind: 'person', publisherKind: 'individual', id: 'second' });
    expect(draft.resources).toHaveLength(1); expect(draft.resources[0]).toMatchObject({ id: 'self', capacity: 1 });
    expect(draft.offers.map(offer => offer.resourceId)).toEqual(['self', 'self']);
    expect(draft.editorWindows!['offer:offer-second']![0]!.start).toBe('2026-10-18T10:00');
    expect(draft.editorWindows!['offer:offer-first']![0]!.start).toBe('');
  });
  it('copies the edited resource windows only into the selected offer without sharing mutable window objects', () => {
    let draft = startDraftContribution({ name: 'Oak', description: '', resources: [], offers: [] }, { kind: 'place', publisherKind: 'organization', id: 'hall' });
    draft = addDraftOffer(draft, 'resource-hall', 'evening');
    draft.editorWindows!['resource:resource-hall'] = [{ id: 'new-time', start: '2026-10-18T18:00', end: '', timeZone: 'Europe/London' }];
    const copied = copyResourceAvailability(draft, 'offer-hall');
    expect(copied.editorWindows!['offer:offer-hall']![0]).toMatchObject({ start: '2026-10-18T18:00', end: '', timeZone: 'Europe/London' });
    expect(copied.editorWindows!['offer:evening']![0]!.start).toBe('');
    expect(copied.editorWindows!['offer:offer-hall']![0]).not.toBe(draft.editorWindows!['resource:resource-hall']![0]);
    expect(() => materializeContributionDraft(copied)).toThrow('invalid datetime');
  });
  it('persists and restores invalid raw times without silently publishing the previous valid value', () => {
    const owner = makeSmallWorksFixture({ oak: true }).publishers.find(p => p.root.key === 'local:oak')!;
    const draft = contributionDraft(book(owner)); const windows = editableWindows(draft.resources[0]!.availability);
    windows[0]!.start = ''; draft.editorWindows = { 'resource:self': windows };
    const storage = createMemoryStorage(); const store = createDraftStore({ storage, key: 'test', kind: 'contribution', validate: isContributionDraft });
    expect(store.save(draft).persisted).toBe(true);
    const restored = createDraftStore({ storage, key: 'test', kind: 'contribution', validate: isContributionDraft }).load();
    expect(restored.status).toBe('ready'); if (restored.status !== 'ready') throw new Error('draft');
    expect(restored.value.editorWindows!['resource:self']![0]!.start).toBe('');
    expect(() => prepareAvailability(owner, restored.value, authority(owner.root.payload.publisher), SMALL_WORKS_NOW, 'invalid-time')).toThrow('invalid datetime');
  });
  it('retains stable remaining window identity and validation when another window is removed', () => {
    const owner = makeSmallWorksFixture().publishers.find(p => p.root.key === 'local:cedar')!; const draft = contributionDraft(book(owner));
    const windows = editableWindows(draft.resources[0]!.availability); expect(windows).toHaveLength(2);
    windows[1]!.end = ''; const kept = windows.filter(window => window.id !== windows[0]!.id);
    draft.editorWindows = { 'resource:self': kept };
    expect(kept[0]!.id).toBe('window-1'); expect(availabilityWindowError(kept[0]!)).not.toBe('');
    expect(() => materializeContributionDraft(draft)).toThrow('invalid datetime');
  });
  it('keeps fractional and empty quantity text safely saved, while refusing publication', () => {
    const owner = makeSmallWorksFixture().publishers[0]!; const draft = contributionDraft(book(owner));
    draft.editorNumbers = { [`resource:${draft.resources[0]!.id}:capacity`]: '1.5' };
    const store = createDraftStore({ storage: createMemoryStorage(), key: 'quantity', kind: 'contribution', validate: isContributionDraft });
    expect(store.save(draft).persisted).toBe(true);
    expect(() => materializeContributionDraft(draft)).toThrow('whole quantity');
  });
  it('uses an explicit named time zone and refuses ambiguous local time', () => {
    const owner = makeSmallWorksFixture().publishers[0]!; const draft = contributionDraft(book(owner));
    draft.editorWindows = { [`resource:${draft.resources[0]!.id}`]: [{ id: 'current', start: '2026-10-18T10:00', end: '2026-10-18T11:00', timeZone: 'Europe/London' }] };
    expect(materializeContributionDraft(draft).resources[0]!.availability[0]!.start).toBe(Date.parse('2026-10-18T09:00:00Z'));
    draft.editorWindows[`resource:${draft.resources[0]!.id}`]![0]!.start = '2026-10-25T01:30';
    expect(() => materializeContributionDraft(draft)).toThrow('ambiguous time');
  });
  it('rejects malformed restored offers and preserves the original raw recovery data', () => {
    const bad = { name: 'Saved', description: '', resources: [], offers: [{ id: 'broken', title: 'Broken', availability: [], conditions: [] }] };
    expect(isContributionDraft(bad)).toBe(false);
    const storage = createMemoryStorage(); const raw = JSON.stringify({ format: 'partfolk-draft', version: 1, kind: 'contribution', updatedAt: 1, payload: bad });
    storage.setItem('bad', raw); const store = createDraftStore({ storage, key: 'bad', kind: 'contribution', validate: isContributionDraft });
    expect(store.load().status).toBe('recovery'); expect(store.exportRecovery()).toBe(raw);
    expect(store.save({ name: 'Current', description: '', resources: [], offers: [] }).persisted).toBe(false);
    expect(storage.getItem('bad')).toBe(raw);
  });
  it('copies currently edited resource windows into a new offer and does not revive removed resource drafts', () => {
    const owner = makeSmallWorksFixture().publishers.find(p => p.root.key === 'local:cedar')!; const draft = contributionDraft(book(owner));
    draft.editorWindows = { 'resource:self': [{ id: 'current', start: '2026-10-18T13:00', end: '2026-10-18T15:00', timeZone: 'Europe/London' }] };
    draft.editorNumbers = { 'resource:self:capacity': '1', 'offer:new:quantity': '2' };
    const added = addDraftOffer(draft, 'self', 'new');
    expect(added.editorWindows!['offer:new']![0]!.start).toBe('2026-10-18T13:00');
    expect(added.editorWindows!['offer:new']![0]!.id).not.toBe('current');
    const removed = removeDraftResource(added, 'self');
    expect(removed.resources).toHaveLength(0); expect(removed.offers).toHaveLength(0);
    expect(removed.editorWindows).toEqual({}); expect(removed.editorNumbers).toEqual({});
  });
  it('rejects local targets before any public repository read', () => {
    expect(isContributionTarget('local:small-works', 'public')).toBe(false);
    expect(isContributionTarget(`0x${'a'.repeat(64)}`, 'public')).toBe(true);
    expect(isContributionTarget(`0x${'a'.repeat(64)}`, 'local')).toBe(false);
    expect(isContributionTarget('local:small-works', 'local')).toBe(true);
  });
});

describe('empty missing-book recovery', () => {
  it('creates the empty fresh book under the same owned live root without restoring prior grants or resources', async () => {
    let now = SMALL_WORKS_NOW; const storage = createMemoryStorage();
    const repository = createLocalRepository({ namespace: 'recovery-test', storage, now: () => now });
    const actor: WriteAuthority = { mode: 'local', actor: { kind: 'local', id: 'local-actor:owner' }, chainId: null };
    const register = { kind: 'individual' as const, name: 'My current name', description: '', lifetimeSeconds: DEFAULT_LIFETIME };
    const publisher = value(await repository.registerPublisher({ ...register, operation: createOperationIntent('register_publisher', actor, register, { id: 'register', now }) })).value;
    const current = book(publisher); const shortInput = { publisherRoot: publisher.root.key, expectedHeads: publisher.book.status === 'unique' ? [publisher.book.entity.key] : [], book: { ...current, predecessorKeys: publisher.book.status === 'unique' ? [publisher.book.entity.key] : [], operationId: 'short', createdAt: now }, lifetimeSeconds: 1 };
    value(await repository.replaceBook({ ...shortInput, operation: createOperationIntent('replace_book', actor, shortInput, { id: 'short', now }) }));
    now += 1001; const missing = value(await repository.loadPublisher(publisher.root.key)); expect(missing.book.status).toBe('missing');
    const recovery = prepareEmptyRecovery(missing, actor, 'Redeclared current name', now, 'recover');
    expect(recovery.publisherRoot).toBe(publisher.root.key); expect(recovery.expectedHeads).toEqual([]); expect(recovery.recovery).toEqual({ acknowledgedMissingState: true, redeclaredAvailability: true });
    for (const field of ['resources', 'offers', 'grants', 'decisions', 'attestations', 'custodyHolds'] as const) expect(recovery.book[field]).toEqual([]);
    value(await repository.replaceBook(recovery)); const reread = value(await repository.loadPublisher(publisher.root.key)); expect(book(reread).name).toBe('Redeclared current name');
    expect(() => prepareEmptyRecovery(reread, actor, 'Duplicate', now, 'duplicate')).toThrow('confirmed missing book');
  });
  it('never creates authority from a disconnected or wrong-chain wallet', () => {
    expect(writeAuthority(null, 'public', 7738577)).toBeNull();
    expect(writeAuthority({ kind: 'wallet', address: `0x${'1'.repeat(40)}` }, 'public', 1)).toBeNull();
    expect(writeAuthority({ kind: 'local', id: 'local-actor:sample' }, 'public', 7738577)).toBeNull();
  });
});
