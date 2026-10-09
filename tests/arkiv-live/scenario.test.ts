import { describe, expect, it } from 'vitest';
import { makeSmallWorksProject } from '../../src/domain/fixtures';
import { hashPlan } from '../../src/domain/canonical';
import { prepareDecision } from '../../src/domain/operations';
import { activeSource, deriveReadiness } from '../../src/domain/readiness';
import { validateEntityPayload } from '../../src/domain/validation';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from '../../src/domain/types';
import type { AccountAddress, EntityPayload, EntityRecord, PlanActivation, ProjectAggregate, Proposal, PublicEntityKey, Snapshot } from '../../src/domain/types';
import { ACTOR_IDS, assertProofState, buildProofProposal, materialBook, proofConsentDeadline, publicRecipe } from './scenario';
import type { ProofRoots } from './scenario';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const entityKey = (number: number): PublicEntityKey => `0x${number.toString(16).padStart(64, '0')}`;
const address = (number: number): AccountAddress => `0x${number.toString(16).padStart(40, '0')}`;
const snapshot: Snapshot = { mode: 'public', chainId: TIRAMISU_CHAIN_ID, blockNumber: '100', blockHash: entityKey(900),
  blockTimestamp: NOW, fetchedAt: NOW + 2_000, completeness: 'complete', freshness: 'fresh', source: 'arkiv', reasons: [] };
const record = <T extends EntityPayload>(key: PublicEntityKey, payload: T, author: AccountAddress): EntityRecord<T> => ({ key, payload,
  provenance: { mode: 'public', creator: { kind: 'wallet', address: author }, owner: { kind: 'wallet', address: author }, readonly: true,
    permissionlessExtension: false, contentType: 'application/json', createdAtBlock: '50', expiresAtBlock: '50000000', transactionHash: null } });

function fixture() {
  const local = makeSmallWorksProject({ oak: true, juniper: true, now: NOW });
  const roots: ProofRoots = Object.fromEntries(ACTOR_IDS.map((id, index) => [id, entityKey(index + 10)]));
  const root = entityKey(1); const coordinator = address(1);
  const publishers = local.publishers.map((publisher, index) => {
    const id = ACTOR_IDS[index]!; const key = roots[id]!; const account = address(index + 10);
    if (publisher.book.status !== 'unique') throw new Error('Invalid local fixture.');
    return { root: record(key, { ...publisher.root.payload, publisher: { kind: 'wallet' as const, address: account } }, account),
      book: { status: 'unique' as const, entity: record(entityKey(index + 100), materialBook({ ...publisher.book.entity.payload, publisherRoot: key }, id, root), account) }, snapshot };
  });
  if (local.state.status !== 'unique') throw new Error('Invalid local project.');
  const project: ProjectAggregate = { root: record(root, { ...local.root.payload, coordinator: { kind: 'wallet', address: coordinator } }, coordinator),
    state: { status: 'unique', entity: record(entityKey(2), { ...local.state.entity.payload, projectRoot: root,
      recipe: publicRecipe(), publisherRoots: Object.values(roots) }, coordinator) }, activation: { status: 'missing', reason: 'not_initialized' },
    proposal: null, proposalHistory: [], proposalHistoryStatus: { complete: true, reasons: [] }, publishers, snapshot };
  return { project, roots, coordinator };
}
function activate(project: ProjectAggregate, proposal: Proposal, number: number) {
  const author = project.root.provenance.creator;
  if (author.kind !== 'wallet') throw new Error('Public fixture required.');
  const previous = activeSource(project);
  const next = record(entityKey(number), proposal, author.address);
  const activation: PlanActivation = { protocol: PROTOCOL, schemaVersion: 1, operationId: `activate-${number}`, createdAt: NOW,
    entityType: 'plan_activation', projectRoot: project.root.key, proposalKey: next.key, proposalHash: proposal.proposalHash,
    predecessorActivationKeys: previous ? [previous.activationKey] : [] };
  project.activation = { status: 'unique', entity: record(entityKey(number + 1), activation, author.address) };
  project.proposal = next; project.proposalHistory.push(next);
}
function acceptAll(project: ProjectAggregate) {
  for (const root of project.proposal!.payload.plan.requiredApprovers) {
    const publisher = project.publishers.find(item => item.root.key === root)!;
    const prepared = prepareDecision(project, root, publisher.root.payload.publisher, { status: 'accepted', operationId: `accept-${project.proposal!.key.slice(-8)}-${root.slice(-8)}`,
      now: NOW + 2_000, validUntil: proofConsentDeadline(project.proposal!.payload.plan, root) });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    if (publisher.book.status !== 'unique') throw new Error('Missing test book.');
    publisher.book.entity.payload = prepared.value.book;
  }
}

describe('public proof scenario uses production domain contracts', () => {
  it('makes only public validated payloads with independent synthetic authorities', () => {
    const { project } = fixture();
    const records = [project.root, ...(project.state.status === 'unique' ? [project.state.entity] : []),
      ...project.publishers.flatMap(publisher => [publisher.root, ...(publisher.book.status === 'unique' ? [publisher.book.entity] : [])])];
    expect(records.every(item => validateEntityPayload(item.payload).valid)).toBe(true);
    expect(new Set(project.publishers.map(item => JSON.stringify(item.root.provenance.creator))).size).toBe(9);
    expect(JSON.stringify(records)).not.toContain('local:');
    expect(project.publishers.every(item => item.book.status === 'unique' && !('kind' in item.book.entity.payload))).toBe(true);
  });
  it('proves P1 agreement, Oak withdrawal, P2 repair, and P3 restore with three distinct exact agreements', () => {
    const { project, roots } = fixture();
    // Juniper is deliberately unknown until the repair phase.
    project.publishers = project.publishers.filter(item => item.root.key !== roots.juniper);
    if (project.state.status === 'unique') project.state.entity.payload.publisherRoots = project.state.entity.payload.publisherRoots.filter(key => key !== roots.juniper);
    const p1 = buildProofProposal(project, 'p1', roots, { operationId: 'p1', createdAt: NOW });
    expect(p1.plan.requiredApprovers).toHaveLength(7);
    expect(p1.plan.allocations.find(item => item.requirementId === 'transport')!.publisherRoot).toBe(roots.oak);
    const boards = p1.plan.allocations.find(item => item.requirementId === 'boards')!;
    expect(boards.interval).toEqual({ start: Date.parse('2026-10-18T08:30:00.000Z'), end: Date.parse('2026-10-18T15:30:00.000Z') });
    activate(project, p1, 200); assertProofState(project, 'awaiting_approval', 0, NOW + 2_000);
    acceptAll(project); assertProofState(project, 'ready', 7, NOW + 2_000);
    const oak = project.publishers.find(item => item.root.key === roots.oak)!;
    const withdrawn = prepareDecision(project, roots.oak!, oak.root.payload.publisher, { status: 'withdrawn', operationId: 'oak-withdraw', now: NOW + 2_000, reason: 'Synthetic withdrawal.' });
    if (!withdrawn.ok || oak.book.status !== 'unique') throw new Error('Withdrawal failed.');
    oak.book.entity.payload = withdrawn.value.book;
    assertProofState(project, 'changed', 6, NOW + 2_000);
    const juniper = fixture().project.publishers.find(item => item.root.key === roots.juniper)!;
    project.publishers.push(juniper); if (project.state.status === 'unique') project.state.entity.payload.publisherRoots.push(roots.juniper!);
    const p2 = buildProofProposal(project, 'p2', roots, { operationId: 'p2', createdAt: NOW });
    expect(p2.plan.predecessor?.proposalKey).toBe(entityKey(200));
    expect(p2.plan.allocations.find(item => item.requirementId === 'transport')!.publisherRoot).toBe(roots.cedar);
    expect(p2.plan.allocations.some(item => item.requirementId === 'installation' && item.publisherRoot === roots.juniper)).toBe(true);
    activate(project, p2, 202); assertProofState(project, 'awaiting_approval', 0, NOW + 2_000);
    acceptAll(project); assertProofState(project, 'ready', 7, NOW + 2_000);
    const p3 = buildProofProposal(project, 'p3', roots, { operationId: 'p3', createdAt: NOW, initialPlan: p1.plan });
    expect(p3.plan.predecessor?.proposalKey).toBe(entityKey(202));
    expect(p3.plan.allocations).toEqual(p1.plan.allocations);
    expect(p3.proposalHash).not.toBe(p1.proposalHash); expect(hashPlan(p3.plan)).toBe(p3.proposalHash);
    activate(project, p3, 204); assertProofState(project, 'awaiting_approval', 0, NOW + 2_000);
    acceptAll(project); const final = assertProofState(project, 'ready', 7, NOW + 2_000);
    expect(final.history.map(item => item.key)).toEqual([entityKey(200), entityKey(202), entityKey(204)]);
  });
  it('uses wall time for cache freshness while business consent uses the pinned block time', () => {
    const { project, roots } = fixture();
    activate(project, buildProofProposal(project, 'p1', roots, { operationId: 'p1', createdAt: NOW }), 200);
    expect(deriveReadiness(project, NOW + 2_000).status).toBe('awaiting_approval');
    expect(deriveReadiness(project, NOW).status).toBe('unverified');
  });
});
