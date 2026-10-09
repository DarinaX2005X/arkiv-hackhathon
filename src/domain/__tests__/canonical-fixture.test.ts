import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalJson, canonicalPlan, hashCanonical, hashOffer, hashPlan } from '../canonical';
import { makeSmallWorksFixture, SMALL_WORKS_NOW } from '../fixtures';
import { solve } from '../solver';
import { independentlyValidatePlan, validateBookState, validateEntityPayload, validatePlanDocument } from '../validation';
import type { PlanDocument, PublisherAggregate } from '../types';

const full = (): PlanDocument => {
  const result = solve(makeSmallWorksFixture({ oak: true }));
  expect(result.status).toBe('found');
  return result.candidates[0]!.plan;
};

describe('Small Works domain demonstration', () => {
  it('explains Saturday two-board shortage and Sunday simultaneous Cedar capacity', () => {
    const result = solve(makeSmallWorksFixture());
    expect(result.status).toBe('impossible');
    expect(result.optimality).toBe('proven');
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'shortage', requirementId: 'boards', params: expect.objectContaining({ variantId: 'saturday', missing: 2 }) }),
      expect.objectContaining({ code: 'capacity_exceeded', publisherRoot: 'local:cedar', resourceId: 'self', params: expect.objectContaining({ variantId: 'sunday' }) }),
      expect.objectContaining({ code: 'shortage', requirementId: 'installation', params: expect.objectContaining({ additionalHelpSufficient: true }) }),
      expect.objectContaining({ code: 'shortage', requirementId: 'transport', params: expect.objectContaining({ additionalHelpSufficient: true }) }),
    ]));
  });

  it('Oak transport makes Sunday feasible without pretending boards are transported simultaneously', () => {
    const input = makeSmallWorksFixture({ oak: true });
    const result = solve(input);
    expect(result.candidates.length).toBe(1);
    const plan = result.candidates[0]!.plan;
    expect(plan.variant.id).toBe('sunday');
    expect(plan.allocations.filter(item => item.requirementId === 'installation').map(item => item.publisherRoot).sort()).toEqual(['local:cedar', 'local:willow']);
    expect(plan.allocations.find(item => item.requirementId === 'transport')?.publisherRoot).toBe('local:oak');
    expect(plan.runbook.filter(item => item.title === 'Host the exhibition').every(item => item.dependsOn.length === 3)).toBe(true);
    expect(independentlyValidatePlan(plan, input.publishers, input.snapshot.blockTimestamp).valid).toBe(true);
  });

  it('one-minute-short transport cannot cover the requirement', () => {
    const input = makeSmallWorksFixture({ oak: true });
    const oak = input.publishers.find(publisher => publisher.root.key === 'local:oak')!;
    if (oak.book.status !== 'unique') throw new Error('fixture');
    oak.book.entity.payload.offers[0]!.availability[0]!.end -= 60_000;
    expect(solve(input).status).toBe('impossible');
  });

  it('Juniper repairs the unavailable driver by freeing Cedar for transport', () => {
    const input = makeSmallWorksFixture({ juniper: true });
    const plan = solve(input).candidates[0]!.plan;
    expect(plan.allocations.find(item => item.requirementId === 'transport')?.publisherRoot).toBe('local:cedar');
    expect(plan.allocations.filter(item => item.requirementId === 'installation').map(item => item.publisherRoot).sort()).toEqual(['local:juniper', 'local:willow']);
  });

  it('selected offer changes invalidate a candidate; unrelated offer additions do not', () => {
    const input = makeSmallWorksFixture({ oak: true });
    const plan = solve(input).candidates[0]!.plan;
    const oak = input.publishers.find(publisher => publisher.root.key === 'local:oak')!;
    if (oak.book.status !== 'unique') throw new Error('fixture');
    oak.book.entity.payload.offers.push({ ...structuredClone(oak.book.entity.payload.offers[0]!), id: 'unselected', title: 'Another option' });
    expect(independentlyValidatePlan(plan, input.publishers, SMALL_WORKS_NOW).valid).toBe(true);
    oak.book.entity.payload.offers[0]!.instructions = 'Changed accepted transport instructions.';
    expect(independentlyValidatePlan(plan, input.publishers, SMALL_WORKS_NOW).reasons.some(reason => reason.code === 'offer_changed')).toBe(true);
  });
});

describe('canonical protocol boundary', () => {
  it('matches the shipped complete public plan interoperability vector', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/canonical-plan.json', import.meta.url), 'utf8')) as { plan: PlanDocument; expectedHash: string };
    expect(validatePlanDocument(fixture.plan).valid).toBe(true);
    expect(hashPlan(fixture.plan)).toBe(fixture.expectedHash);
  });
  it('sorts object keys, normalizes NFC/line endings and has a fixed keccak golden vector', () => {
    expect(canonicalJson({ z: 'e\u0301\r\n', a: 1 })).toBe('{"a":1,"z":"é\\n"}');
    expect(hashCanonical({ z: 'e\u0301\r\n', a: 1 })).toBe('0x399f57728314671597ee24c287545ab0d30ac1e55b25b810ba2c971619eea366');
  });

  it('rejects fractions, infinity, undefined, normalized duplicate keys and duplicate set identities', () => {
    for (const value of [1.5, NaN, Infinity, { a: undefined }, { ['e\u0301']: 1, ['é']: 2 }]) expect(() => canonicalJson(value)).toThrow();
    const plan = full();
    plan.requiredApprovers.push(plan.requiredApprovers[0]!);
    expect(() => hashPlan(plan)).toThrow();
    expect(validatePlanDocument(plan).valid).toBe(false);
  });

  it('is invariant to property and set ordering but retains meaningful task sequence', () => {
    const plan = full();
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as unknown as PlanDocument;
    reordered.allocations = [...plan.allocations].reverse();
    reordered.offers = [...plan.offers].reverse();
    reordered.requiredApprovers = [...plan.requiredApprovers].reverse();
    reordered.resourceAssumptions = [...plan.resourceAssumptions].reverse();
    reordered.variant = { ...plan.variant, requirements: [...plan.variant.requirements].reverse() };
    reordered.runbook = plan.runbook.map(task => ({ ...task, dependsOn: [...task.dependsOn].reverse(), allocationIds: [...task.allocationIds].reverse() }));
    expect(canonicalPlan(reordered)).toBe(canonicalPlan(plan));
    expect(hashPlan(reordered)).toBe(hashPlan(plan));
    expect(hashPlan({ ...plan, runbook: [...plan.runbook].reverse() })).not.toBe(hashPlan(plan));
  });

  it('covers outcome, instructions, selected time, offer terms, capacity and predecessor', () => {
    const plan = full();
    const hash = hashPlan(plan);
    for (const change of [
      { ...plan, outcome: 'Another outcome' },
      { ...plan, instructions: 'New instructions' },
      { ...plan, variant: { ...plan.variant, venueId: 'another-venue' } },
      { ...plan, allocations: plan.allocations.map((item, index) => index === 0 ? { ...item, quantity: item.quantity + 1 } : item) },
      { ...plan, resourceAssumptions: plan.resourceAssumptions.map((item, index) => index === 0 ? { ...item, capacity: item.capacity + 1 } : item) },
      { ...plan, predecessor: { projectRoot: plan.projectRoot, activationKey: 'local:a1', proposalKey: 'local:p1', proposalHash: hash } },
    ] as PlanDocument[]) expect(hashPlan(change)).not.toBe(hash);
  });

  it('selected offer hash ignores unrelated book progress and includes owner identity', () => {
    const publisher = makeSmallWorksFixture().publishers[0]!;
    if (publisher.book.status !== 'unique') throw new Error('fixture');
    const offer = publisher.book.entity.payload.offers[0]!;
    const before = hashOffer(publisher.root.key, offer);
    publisher.book.entity.payload.description = 'Unrelated publisher profile update';
    expect(hashOffer(publisher.root.key, offer)).toBe(before);
    expect(hashOffer('local:someone-else', offer)).not.toBe(before);
  });
});

describe('strict domain schemas', () => {
  it('rejects fractional quantities, invalid timezone, unknown payload fields and contradictory decisions', () => {
    const fixture = makeSmallWorksFixture({ oak: true });
    const publisher = fixture.publishers[0]!;
    if (publisher.book.status !== 'unique') throw new Error('fixture');
    expect(validateEntityPayload({ ...publisher.book.entity.payload, injected: true }).valid).toBe(false);
    const fractional = structuredClone(publisher.book.entity.payload);
    fractional.offers[0]!.quantity = 0.5;
    expect(validateBookState(fractional).valid).toBe(false);
    const plan = full();
    plan.variant.timeZone = 'Definitely/Not_a_zone';
    expect(validatePlanDocument(plan).valid).toBe(false);
    const duplicate = structuredClone(publisher.book.entity.payload);
    const decision = { projectRoot: fixture.projectRoot, activationKey: 'local:activation' as const, proposalKey: 'local:proposal' as const,
      proposalHash: hashCanonical('fixture'), status: 'declined' as const, decidedAt: SMALL_WORKS_NOW, operationId: 'decision' };
    duplicate.decisions = [decision, { ...decision, status: 'withdrawn' }];
    expect(validateBookState(duplicate).reasons.some(reason => reason.code === 'contradictory_decision')).toBe(true);
  });

  it('a missing publisher book makes search unverified, never a proven impossible result', () => {
    const input = makeSmallWorksFixture({ oak: true });
    input.publishers[0] = { ...input.publishers[0]!, book: { status: 'missing', reason: 'expired_or_deleted' } } as PublisherAggregate;
    expect(solve(input).status).toBe('unverified');
    expect(solve(input).optimality).toBe('not_proven');
  });
});
