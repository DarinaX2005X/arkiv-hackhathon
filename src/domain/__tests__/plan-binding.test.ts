import { describe, expect, it } from 'vitest';
import { hashPlan } from '../canonical';
import { transferStatementHash } from '../execution';
import { makeSmallWorksFixture } from '../fixtures';
import { solve } from '../solver';
import { finalizePlan, independentlyValidatePlan, validatePlanDocument } from '../validation';
import type { Attestation, ContentHash, RunbookObligation } from '../types';

function fixture() {
  const input = makeSmallWorksFixture({ oak: true });
  const plan = solve(input).candidates[0]!.plan;
  const allocation = plan.allocations.find(item => item.resourceId === 'boards')!;
  const publisher = input.publishers.find(item => item.root.key === allocation.publisherRoot)!;
  if (publisher.book.status !== 'unique') throw new Error('Fixture book');
  const book = publisher.book.entity.payload;
  const start = allocation.interval.start;
  const transfer = (id: string, action: 'handover' | 'return', quantity: number, receiver = 'local:library', offset = 0): Extract<RunbookObligation, { kind: 'handover' | 'return' }> => ({
    kind: action, id, transferId: id, title: id, publisherRoot: action === 'handover' ? publisher.root.key : receiver as `local:${string}`,
    resourceId: 'boards', quantity, unit: 'board', giver: action === 'handover' ? publisher.root.key : receiver as `local:${string}`,
    receiver: action === 'handover' ? receiver as `local:${string}` : publisher.root.key,
    interval: { start: start + offset, end: start + offset + 1 }, allocationIds: [allocation.id], dependsOn: [], instructions: '',
  });
  const held = (quantity: number, transferId = 'old-delivery', currentPlan = false) => {
    const source = { projectRoot: input.projectRoot, activationKey: 'local:old-activation', proposalKey: 'local:old-proposal',
      proposalHash: currentPlan ? hashPlan(plan) : `0x${'1'.repeat(64)}` as ContentHash } as const;
    const content: Omit<Extract<Attestation, { kind: 'transfer_report' }>, 'statementHash'> = { ...source,
      id: 'old-report', kind: 'transfer_report', obligationId: transferId, author: publisher.root.key,
      recordedAt: input.snapshot.blockTimestamp, operationId: 'old-operation', transferId, action: 'handover',
      resourceId: 'boards', quantity, unit: 'board', giver: publisher.root.key, receiver: 'local:library' };
    book.attestations.push({ ...content, statementHash: transferStatementHash(content) });
    book.custodyHolds.push({ id: 'old-hold', projectRoot: input.projectRoot, resourceId: 'boards', quantity, unit: 'board',
      source, transferId, createdAt: input.snapshot.blockTimestamp, status: 'outstanding' });
  };
  return { input, plan, transfer, held, book, finalize: () => finalizePlan(plan, input.publishers, input.snapshot) };
}

describe('runbook tasks are bound to allocated requirement work', () => {
  it('rejects a task moved away from its requirement interval through either validator', () => {
    const { input, plan, finalize } = fixture();
    plan.runbook[0]!.interval = { start: 1, end: 2 };
    expect(validatePlanDocument(plan).valid).toBe(false);
    expect(independentlyValidatePlan(plan, input.publishers, input.snapshot.blockTimestamp).valid).toBe(false);
    expect(finalize().ok).toBe(false);
  });

  it('rejects omitted mandatory predecessors even when each remaining edge is well formed', () => {
    const { plan, finalize } = fixture();
    const dependent = plan.runbook.find(item => item.kind === 'task' && item.dependsOn.length)!;
    dependent.dependsOn = [];
    expect(finalize().ok).toBe(false);
  });

  it('rejects duplicate work charged to the same allocation', () => {
    const { plan, finalize } = fixture();
    plan.runbook.push({ ...structuredClone(plan.runbook.find(item => item.kind === 'task')!), id: 'duplicate-personal-task' });
    expect(finalize().ok).toBe(false);
  });

  it('rejects unallocated tasks', () => {
    const { plan, finalize } = fixture();
    plan.runbook[0]!.allocationIds = [];
    expect(finalize().ok).toBe(false);
  });
});

describe('planned transfers conserve stock by owner, resource, recipient and time', () => {
  it('rejects returning six boards after receiving one', () => {
    const { plan, transfer, finalize } = fixture();
    plan.runbook.push(transfer('out', 'handover', 1), transfer('back', 'return', 6, 'local:library', 1));
    expect(finalize().ok).toBe(false);
  });

  it.each([0, 1])('rejects duplicate six-board handovers with offset %s', offset => {
    const { plan, transfer, finalize } = fixture();
    plan.runbook.push(transfer('out-one', 'handover', 6), transfer('out-two', 'handover', 6, 'local:courtyard', offset));
    expect(finalize().ok).toBe(false);
  });

  it('allows a conserved split to two recipients and separate returns', () => {
    const { plan, transfer, finalize } = fixture();
    plan.runbook.push(transfer('out-one', 'handover', 3), transfer('out-two', 'handover', 3, 'local:courtyard'),
      transfer('back-one', 'return', 3, 'local:library', 1), transfer('back-two', 'return', 3, 'local:courtyard', 1));
    expect(finalize().ok).toBe(true);
  });

  it('rejects duplicate returns exceeding one recipient balance', () => {
    const { plan, transfer, finalize } = fixture();
    plan.runbook.push(transfer('out', 'handover', 6), transfer('back-one', 'return', 4, 'local:library', 1),
      transfer('back-two', 'return', 4, 'local:library', 1));
    expect(finalize().ok).toBe(false);
  });

  it('requires delivery to finish before returned stock can be sent again', () => {
    const { plan, transfer, finalize } = fixture();
    plan.runbook.push(transfer('out', 'handover', 6), transfer('back', 'return', 6, 'local:library', 0));
    expect(finalize().ok).toBe(false);
  });

  it('allows sequential reuse only after a completed return', () => {
    const { plan, transfer, finalize } = fixture();
    plan.runbook.push(transfer('out', 'handover', 6), transfer('back', 'return', 6, 'local:library', 1),
      transfer('out-again', 'handover', 6, 'local:courtyard', 2));
    expect(finalize().ok).toBe(true);
  });

  it('uses authenticated earlier custody to permit a remaining return', () => {
    const { plan, transfer, held, finalize } = fixture();
    held(6);
    plan.runbook.push(transfer('back', 'return', 6));
    expect(finalize().ok).toBe(true);
  });

  it('cannot return more than the earlier outstanding custody', () => {
    const { plan, transfer, held, finalize } = fixture();
    held(1);
    plan.runbook.push(transfer('back', 'return', 6));
    expect(finalize().ok).toBe(false);
  });

  it('does not assign an unknown earlier hold to a chosen return giver', () => {
    const { plan, transfer, held, book, finalize } = fixture();
    held(6); book.attestations = [];
    plan.runbook.push(transfer('back', 'return', 6));
    expect(finalize().ok).toBe(false);
  });

  it('does not lend stock again while it remains in earlier custody', () => {
    const { plan, transfer, held, finalize } = fixture();
    held(6);
    plan.runbook.push(transfer('new-out', 'handover', 6, 'local:courtyard'));
    expect(finalize().ok).toBe(false);
  });

  it('allows remaining acknowledgement of the same earlier transfer without lending twice', () => {
    const { plan, transfer, held, finalize } = fixture();
    held(6);
    plan.runbook.push(transfer('old-delivery', 'handover', 1));
    expect(finalize().ok).toBe(true);
  });

  it('keeps agreed terms valid when their own handover creates a live custody hold', () => {
    const { plan, transfer, held, finalize } = fixture();
    plan.runbook.push(transfer('out', 'handover', 6), transfer('back', 'return', 6, 'local:library', 1));
    const ready = finalize();
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error('Expected initial plan');
    Object.assign(plan, ready.value.plan);
    held(6, 'out', true);
    expect(finalize().ok).toBe(true);
  });
});
