import { describe, expect, it } from 'vitest';
import { hashOffer } from '../canonical';
import { makeSmallWorksFixture } from '../fixtures';
import { solve } from '../solver';
import {
  capacityConflicts, finalizePlan, validateBookCapacity, validateBookState,
  validatePlanDocument, validateRecipe,
} from '../validation';
import type { BookState, Grant, PublisherAggregate, RunbookObligation, SourcePlanRef } from '../types';

function book(publisher: PublisherAggregate): BookState {
  if (publisher.book.status !== 'unique') throw new Error('Expected a unique fixture book');
  return publisher.book.entity.payload;
}

function solvedFixture() {
  const input = makeSmallWorksFixture({ oak: true });
  const candidate = solve(input).candidates[0];
  if (!candidate) throw new Error('Expected the baseline fixture to be feasible');
  return { input, plan: candidate.plan };
}

describe('adversarial schema and finalized-plan regressions', () => {
  it('rejects own unknown fields whose names are inherited by ordinary schema objects', () => {
    const { input, plan } = solvedFixture();
    expect(validatePlanDocument(plan).valid).toBe(true);
    Object.defineProperty(plan, 'constructor', { value: 'unexpected material data', enumerable: true });
    expect(validatePlanDocument(plan).valid).toBe(false);
    expect(finalizePlan(plan, input.publishers, input.snapshot).ok).toBe(false);
  });

  it.each(['offers', 'resources'] as const)('rejects canonically equivalent Unicode identities in book %s', (collection) => {
    const input = makeSmallWorksFixture({ oak: true });
    const state = book(input.publishers.find((publisher) => publisher.root.key === 'local:library')!);
    expect(validateBookState(state).valid).toBe(true);
    if (collection === 'offers') {
      const entry = state.offers[0]!;
      entry.id = 'e\u0301';
      state.offers.push({ ...structuredClone(entry), id: '\u00e9' });
    } else {
      const entry = state.resources[0]!;
      entry.id = 'e\u0301';
      state.offers[0]!.resourceId = entry.id;
      state.resources.push({ ...structuredClone(entry), id: '\u00e9' });
    }
    expect(validateBookState(state).valid).toBe(false);
  });

  it('rejects canonically equivalent requirement IDs before they enter a plan hash', () => {
    const input = makeSmallWorksFixture({ oak: true });
    const selected = input.recipe.variants[0]!;
    const requirement = { ...structuredClone(selected.requirements[0]!), id: 'e\u0301', dependsOn: [] };
    selected.requirements = [requirement, { ...structuredClone(requirement), id: '\u00e9' }];
    expect(validateRecipe(input.recipe).valid).toBe(false);
  });

  it.each(['resource', 'unit', 'quantity'] as const)('rejects an explicit handover with an unbacked %s', (field) => {
    const { input, plan } = solvedFixture();
    const allocation = plan.allocations.find((item) => item.resourceId === 'boards')!;
    const transfer: Extract<RunbookObligation, { kind: 'handover' | 'return' }> = {
      kind: 'handover', id: 'handover-boards', transferId: 'boards-delivery', title: 'Deliver display boards',
      publisherRoot: allocation.publisherRoot, resourceId: allocation.resourceId,
      quantity: allocation.quantity, unit: allocation.unit, giver: allocation.publisherRoot,
      receiver: 'local:library', interval: { start: allocation.interval.start, end: allocation.interval.start + 1 },
      allocationIds: [allocation.id], dependsOn: [], instructions: '',
    };
    plan.runbook.push(transfer);
    expect(finalizePlan(plan, input.publishers, input.snapshot).ok).toBe(true);
    if (field === 'resource') transfer.resourceId = 'does-not-exist';
    if (field === 'unit') transfer.unit = 'invented-unit';
    if (field === 'quantity') transfer.quantity = allocation.quantity + 1;
    expect(finalizePlan(plan, input.publishers, input.snapshot).ok).toBe(false);
  });

  it('counts excess same-project custody when a repair uses fewer units than remain outstanding', () => {
    const input = makeSmallWorksFixture({ oak: true });
    const publisher = input.publishers.find((item) => item.root.key === 'local:makerspace')!;
    input.publishers = [publisher];
    const selected = input.recipe.variants.find((item) => item.id === 'sunday')!;
    const requirement = selected.requirements.find((item) => item.capability === 'display-board')!;
    requirement.quantity = 1;
    selected.requirements = [requirement];
    input.recipe.variants = [selected];
    const state = book(publisher);
    state.resources = state.resources.filter((item) => item.id === 'boards');
    state.offers = state.offers.filter((item) => item.id === 'boards-sunday');
    const offer = state.offers[0]!;
    const offerHash = hashOffer(publisher.root.key, offer);
    const source: SourcePlanRef = { projectRoot: 'local:foreign-project', activationKey: 'local:foreign-activation',
      proposalKey: 'local:foreign-proposal', proposalHash: `0x${'1'.repeat(64)}` };
    const grant: Grant = { ...source, id: 'foreign-grant', protocol: 'partfolk/1', chainId: null,
      offers: [{ publisherRoot: publisher.root.key, offerId: offer.id, offerHash }],
      allocations: [{ id: 'foreign-allocation', requirementId: 'foreign-requirement', publisherRoot: publisher.root.key,
        offerId: offer.id, offerHash, resourceId: offer.resourceId, quantity: 1, unit: offer.unit, interval: requirement.interval }],
      validUntil: requirement.interval.end + 1_000, acceptedAt: input.snapshot.blockTimestamp, operationId: 'foreign-accept' };
    state.grants = [grant];
    state.decisions = [{ ...source, status: 'accepted', decidedAt: input.snapshot.blockTimestamp, operationId: 'foreign-accept' }];
    state.custodyHolds = [{ id: 'six-outstanding-boards', projectRoot: input.projectRoot, resourceId: 'boards', quantity: 6,
      unit: 'board', source: { ...source, projectRoot: input.projectRoot }, transferId: 'previous-boards-delivery',
      createdAt: input.snapshot.blockTimestamp, status: 'outstanding' }];

    expect(validateBookState(state).valid).toBe(true);
    expect(validateBookCapacity(publisher, state, input.snapshot.blockTimestamp).valid).toBe(false);
    const candidateAllocation = { ...grant.allocations[0]!, id: 'repair-allocation', requirementId: requirement.id };
    expect(capacityConflicts([candidateAllocation], [publisher], input.projectRoot, input.snapshot.blockTimestamp).length).toBeGreaterThan(0);
    const result = solve(input);
    expect(result.candidates).toEqual([]);
    expect(['impossible', 'unverified']).toContain(result.status);
  });

  it('reserves equipment from early handover through a later return and rejects an overlapping foreign grant', () => {
    const input = makeSmallWorksFixture({ oak: true });
    const publisher = input.publishers.find((item) => item.root.key === 'local:makerspace')!;
    const state = book(publisher);
    const requirement = input.recipe.variants.find((item) => item.id === 'sunday')!.requirements.find((item) => item.id === 'boards')!;
    const halfHour = 30 * 60 * 1_000;
    const reservationInterval = { start: requirement.interval.start - halfHour, end: requirement.interval.end + halfHour };
    state.resources.find((item) => item.id === 'boards')!.availability.push(reservationInterval);
    const offer = state.offers.find((item) => item.id === 'boards-sunday')!;
    offer.availability = [reservationInterval];
    const plan = solve(input).candidates[0]!.plan;
    const allocation = plan.allocations.find((item) => item.resourceId === 'boards')!;
    plan.runbook.push({ kind: 'handover', id: 'early-handover', transferId: 'boards-out', title: 'Deliver boards before use',
      publisherRoot: publisher.root.key, resourceId: 'boards', quantity: 6, unit: 'board', giver: publisher.root.key,
      receiver: 'local:library', interval: { start: reservationInterval.start, end: requirement.interval.start },
      allocationIds: [allocation.id], dependsOn: [], instructions: '' },
    { kind: 'return', id: 'later-return', transferId: 'boards-back', title: 'Return boards after use',
      publisherRoot: 'local:library', resourceId: 'boards', quantity: 6, unit: 'board', giver: 'local:library',
      receiver: publisher.root.key, interval: { start: requirement.interval.end, end: reservationInterval.end },
      allocationIds: [allocation.id], dependsOn: ['early-handover'], instructions: '' });
    const finalized = finalizePlan(plan, input.publishers, input.snapshot);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error('Expected valid handover and return to finalize');
    expect(finalized.value.plan.allocations.find((item) => item.id === allocation.id)!.interval).toEqual(reservationInterval);

    const source: SourcePlanRef = { projectRoot: 'local:next-project', activationKey: 'local:next-activation',
      proposalKey: 'local:next-proposal', proposalHash: `0x${'2'.repeat(64)}` };
    const offerHash = hashOffer(publisher.root.key, offer);
    state.grants = [{ ...source, id: 'next-grant', protocol: 'partfolk/1', chainId: null,
      offers: [{ publisherRoot: publisher.root.key, offerId: offer.id, offerHash }],
      allocations: [{ ...allocation, id: 'next-allocation', quantity: 1,
        interval: { start: requirement.interval.end, end: reservationInterval.end } }],
      validUntil: reservationInterval.end + 1_000, acceptedAt: input.snapshot.blockTimestamp, operationId: 'next-accept' }];
    state.decisions = [{ ...source, status: 'accepted', decidedAt: input.snapshot.blockTimestamp, operationId: 'next-accept' }];
    // Resource use alone ends exactly when the other reservation starts.
    expect(solve(input).status).toBe('found');
    const conflict = finalizePlan(plan, input.publishers, input.snapshot);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reasons.some((reason) => reason.code === 'capacity_exceeded')).toBe(true);
  });
});
