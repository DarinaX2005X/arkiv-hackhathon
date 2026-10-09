import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, hashOffer } from '../canonical';
import { createLocalSnapshot, makePublisher, SMALL_WORKS_NOW } from '../fixtures';
import { solve } from '../solver';
import { validateSolverInput } from '../validation';
import type { Resource, SolverInput } from '../types';

function fixture(quantity: number, reserved = true): SolverInput {
  const interval = { start: SMALL_WORKS_NOW + 1_000, end: SMALL_WORKS_NOW + 2_000 };
  const resource: Resource = { id: 'kit', name: 'Kit', kind: 'equipment', capacity: quantity,
    unit: 'item', capabilities: ['build'], availability: [interval] };
  const publisher = makePublisher('budget', { kind: 'organization', resources: [resource],
    offers: ['a', 'b'].map(id => ({ id, title: id, resourceId: resource.id, kind: resource.kind,
      quantity, unit: resource.unit, capabilities: resource.capabilities, availability: [interval],
      projectScope: [], conditions: [], instructions: '' })) });
  if (reserved && publisher.book.status === 'unique') {
    const book = publisher.book.entity.payload;
    const source = { projectRoot: 'local:foreign', activationKey: 'local:foreign-activation',
      proposalKey: 'local:foreign-proposal', proposalHash: `0x${'1'.repeat(64)}` } as const;
    const selected = { publisherRoot: publisher.root.key, offerId: 'a', offerHash: hashOffer(publisher.root.key, book.offers[0]!) };
    book.decisions.push({ ...source, status: 'accepted', decidedAt: SMALL_WORKS_NOW, operationId: 'accept' });
    book.grants.push({ ...source, id: 'foreign-reservation', protocol: 'partfolk/1', chainId: null,
      offers: [selected], allocations: [{ ...selected, id: 'reserved', requirementId: 'reserved',
        resourceId: resource.id, quantity, unit: resource.unit, interval }],
      validUntil: SMALL_WORKS_NOW + 10_000, acceptedAt: SMALL_WORKS_NOW, operationId: 'reserve' });
  }
  return { projectRoot: 'local:budget-project', publishers: [publisher], snapshot: createLocalSnapshot(),
    recipe: { title: 'Budget fixture', outcome: 'Build', timeZone: 'UTC', instructions: '',
      variants: [{ id: 'main', title: 'Main', venueId: 'workshop', timeZone: 'UTC', instructions: '',
        requirements: [{ id: 'build', title: 'Build', kind: 'equipment', capability: 'build', unit: 'item',
          quantity, interval, instructions: '', dependsOn: [] }] }] },
    predecessor: null, predecessorSource: null, completedWork: [] };
}

afterEach(() => vi.restoreAllMocks());

describe('solver work budgets', () => {
  it('counts capacity-rejected integer quantities against the node budget', () => {
    const input = fixture(20_000);
    expect(validateSolverInput(input).valid).toBe(true);
    const result = solve(input, [], { maxNodes: 64, maxCandidates: 1 });
    expect(result.status).toBe('exhausted');
    expect(result.exhausted).toBe(true);
    expect(result.optimality).toBe('not_proven');
    expect(result.nodesVisited).toBe(64);
    expect(result.reasons.some(reason => reason.code === 'capacity_exceeded')).toBe(true);
    expect(result.reasons.some(reason => reason.code === 'search_exhausted')).toBe(true);
  });

  it('bounds a large rejected-quantity loop with the elapsed-time budget', () => {
    const input = fixture(20_000);
    const start = performance.now();
    const result = solve(input, [], { maxNodes: 1_000_000, maxCandidates: 1, maxMilliseconds: 10 });
    const elapsed = performance.now() - start;
    expect(result.status).toBe('exhausted');
    expect(result.optimality).toBe('not_proven');
    expect(result.reasons.some(reason => reason.code === 'search_exhausted')).toBe(true);
    // Allow scheduler jitter and one synchronous evaluator call, but reject the
    // multi-second loop that previously ignored the ten-millisecond budget.
    expect(elapsed).toBeLessThan(500);
  });

  it('includes input validation in elapsed time', () => {
    const input = fixture(1, false);
    const recipe = input.recipe;
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    Object.defineProperty(input, 'recipe', { get: () => { elapsed = 20; return recipe; } });
    const result = solve(input, [], { maxNodes: 1_000, maxCandidates: 1, maxMilliseconds: 10 });
    expect(result.status).toBe('exhausted');
    expect(result.candidates).toHaveLength(0);
    expect(result.nodesVisited).toBe(1);
  });

  it('charges preprocessing work even before allocation search starts', () => {
    const result = solve(fixture(1, false), [], { maxNodes: 5, maxCandidates: 1 });
    expect(result.status).toBe('exhausted');
    expect(result.nodesVisited).toBe(5);
    expect(result.optimality).toBe('not_proven');
  });

  it('caps distinct explanations during rejection and keeps exhaustion visible', () => {
    const result = solve(fixture(20_000), [], { maxNodes: 2_000, maxCandidates: 1 });
    expect(result.status).toBe('exhausted');
    expect(result.reasons).toHaveLength(128);
    expect(new Set(result.reasons.map(canonicalJson)).size).toBe(result.reasons.length);
    expect(result.reasons.at(-1)?.code).toBe('search_exhausted');
  });

  it('proves complete small integer searches with sufficient budget', () => {
    const result = solve(fixture(2, false), [], { maxNodes: 1_000, maxCandidates: 10 });
    expect(result.status).toBe('found');
    expect(result.exhausted).toBe(false);
    expect(result.optimality).toBe('proven');
    expect(result.candidates.map(candidate => candidate.plan.allocations.map(allocation =>
      `${allocation.offerId}:${allocation.quantity}`).sort().join(',')).sort()).toEqual(['a:1,b:1', 'a:2', 'b:2']);
  });
});
