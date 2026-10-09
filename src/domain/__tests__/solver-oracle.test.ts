import { describe, expect, it } from 'vitest';
import { hashOffer, hashPlan, hashRequirements } from '../canonical';
import { solve } from '../solver';
import type {
  Allocation, BookState, Condition, CustodyHold, EntityKey, EntityProvenance,
  Grant, Interval, Offer, PlanDocument, ProjectVariant, PublisherAggregate,
  Requirement, Resource, SolverInput, SolverPin, SourcePlanRef,
} from '../types';

const NOW = 1_800_000_000_000;
const PROJECT: EntityKey = 'local:oracle-project';
const WINDOW: Interval = { start: NOW + 10, end: NOW + 20 };
const WIDE: Interval = { start: NOW - 1_000, end: NOW + 1_000 };
const HASH = `0x${'1'.repeat(64)}` as const;

function requirement(id: string, capability = 'build', quantity = 1, interval = WINDOW): Requirement {
  return { id, title: id, kind: 'equipment', capability, unit: 'item', quantity,
    interval: { ...interval }, instructions: '', dependsOn: [] };
}

function resource(id = 'kit', capacity = 1, capabilities = ['build']): Resource {
  return { id, name: id, kind: 'equipment', unit: 'item', capacity,
    capabilities, availability: [{ ...WIDE }] };
}

function offer(id = 'offer', resourceId = 'kit', quantity = 1, capabilities = ['build']): Offer {
  return { id, title: id, resourceId, kind: 'equipment', unit: 'item', quantity,
    capabilities, availability: [{ ...WIDE }], projectScope: [], conditions: [], instructions: '' };
}

function publisher(id: string, resources = [resource()], offers = [offer()]): PublisherAggregate {
  const root: EntityKey = `local:oracle-publisher-${id}`;
  const actor = { kind: 'local', id: `local-actor:oracle-${id}` } as const;
  const provenance: EntityProvenance = { mode: 'local', creator: actor, owner: actor,
    readonly: true, permissionlessExtension: false, contentType: 'application/json',
    createdAtBlock: null, expiresAtBlock: null, transactionHash: null };
  const base = { protocol: 'partfolk/1', schemaVersion: 1, operationId: `oracle-${id}`, createdAt: NOW - 100 } as const;
  return {
    root: { key: root, payload: { ...base, entityType: 'publisher_root', publisher: actor, kind: 'organization' }, provenance },
    book: { status: 'unique', entity: { key: `local:oracle-book-${id}`, provenance,
      payload: { ...base, entityType: 'book_state', publisherRoot: root, predecessorKeys: [],
        name: id, description: '', resources, offers, decisions: [], grants: [], attestations: [],
        custodyHolds: [], retentionDays: 90 } } },
    snapshot: { mode: 'local', chainId: null, blockNumber: null, blockHash: null,
      blockTimestamp: NOW, fetchedAt: NOW, completeness: 'complete', freshness: 'fresh', source: 'local', reasons: [] },
  };
}

function book(p: PublisherAggregate): BookState {
  if (p.book.status !== 'unique') throw new Error('Oracle fixture requires a unique book');
  return p.book.entity.payload;
}

function variant(id: string, requirements: Requirement[], venueId = 'workshop'): ProjectVariant {
  return { id, title: id, venueId, timeZone: 'UTC', requirements, instructions: '' };
}

function input(publishers: PublisherAggregate[], requirements = [requirement('build')], variants?: ProjectVariant[]): SolverInput {
  return { projectRoot: PROJECT,
    recipe: { title: 'Oracle project', outcome: 'Build a useful object', timeZone: 'UTC',
      variants: variants ?? [variant('main', requirements)], instructions: '' },
    publishers, snapshot: { mode: 'local', chainId: null, blockNumber: null, blockHash: null,
      blockTimestamp: NOW, fetchedAt: NOW, completeness: 'complete', freshness: 'fresh', source: 'local', reasons: [] },
    predecessor: null, predecessorSource: null, completedWork: [] };
}

type Choice = { publisher: PublisherAggregate; offer: Offer; resource: Resource };
type OracleCandidate = { variant: ProjectVariant; allocations: Allocation[] };
type RankNumbers = [number, number, number, number];

function choices(value: SolverInput): Choice[] {
  return value.publishers.flatMap((p) => book(p).offers.map((o) => {
    const r = book(p).resources.find((candidate) => candidate.id === o.resourceId);
    if (!r) throw new Error('Oracle fixture references a missing resource');
    return { publisher: p, offer: o, resource: r };
  }));
}

function sameOffer(a: { publisherRoot: EntityKey; offerId: string }, b: { publisherRoot: EntityKey; offerId: string }): boolean {
  return a.publisherRoot === b.publisherRoot && a.offerId === b.offerId;
}

function covers(windows: Interval[], interval: Interval): boolean {
  // A union of windows must cover every elementary segment, including internal gaps.
  const points = [...new Set([interval.start, interval.end, ...windows.flatMap((w) => [w.start, w.end])])]
    .filter((point) => point >= interval.start && point <= interval.end).sort((a, b) => a - b);
  return points.slice(0, -1).every((point, index) =>
    windows.some((window) => window.start <= point && window.end >= points[index + 1]!));
}

function activeAt(a: { interval: Interval }, time: number): boolean {
  return a.interval.start <= time && time < a.interval.end;
}

function independentFeasible(value: SolverInput, candidate: OracleCandidate, pins: SolverPin[]): boolean {
  const { allocations, variant: selectedVariant } = candidate;
  const available = choices(value);
  for (const r of selectedVariant.requirements) {
    const matches = allocations.filter((a) => a.requirementId === r.id);
    if (matches.reduce((sum, a) => sum + a.quantity, 0) !== r.quantity) return false;
    if (r.dependsOn.some((id) => {
      const before = selectedVariant.requirements.find((item) => item.id === id);
      return !before || before.interval.end > r.interval.start;
    })) return false;
  }
  for (const a of allocations) {
    const r = selectedVariant.requirements.find((item) => item.id === a.requirementId);
    const c = available.find((item) => item.publisher.root.key === a.publisherRoot && item.offer.id === a.offerId);
    if (!r || !c || !Number.isSafeInteger(a.quantity) || a.quantity <= 0) return false;
    if (a.resourceId !== c.resource.id || a.unit !== r.unit || a.unit !== c.offer.unit || a.unit !== c.resource.unit) return false;
    if (r.kind !== c.offer.kind || r.kind !== c.resource.kind || !c.offer.capabilities.includes(r.capability)) return false;
    if (a.interval.start !== r.interval.start || a.interval.end !== r.interval.end) return false;
    if (c.offer.projectScope.length && !c.offer.projectScope.includes(value.projectRoot)) return false;
    if (!covers(c.offer.availability, r.interval) || !covers(c.resource.availability, r.interval)) return false;
  }
  const selected = available.filter((c) => allocations.some((a) => a.publisherRoot === c.publisher.root.key && a.offerId === c.offer.id));
  const conditionSatisfied = (condition: Condition): boolean => {
    switch (condition.kind) {
      case 'requires_offer': return allocations.some((a) => sameOffer(a, condition.offer));
      case 'excludes_offer': return !allocations.some((a) => sameOffer(a, condition.offer));
      case 'requires_capability': return selected.some((c) => c.offer.capabilities.includes(condition.capability));
      case 'allowed_variants': return condition.variantIds.includes(selectedVariant.id);
      case 'allowed_venues': return condition.venueIds.includes(selectedVariant.venueId);
    }
  };
  if (selected.some((c) => c.offer.conditions.some((condition) => !conditionSatisfied(condition)))) return false;
  if (pins.some((pin) => {
    const quantity = allocations.filter((a) => a.requirementId === pin.requirementId && sameOffer(a, pin))
      .reduce((sum, a) => sum + a.quantity, 0);
    return pin.quantity === undefined ? quantity < 1 : quantity !== pin.quantity;
  })) return false;
  for (const c of selected) {
    const same = allocations.filter((a) => a.publisherRoot === c.publisher.root.key && a.offerId === c.offer.id);
    if (same.some((at) => same.filter((a) => activeAt(a, at.interval.start)).reduce((sum, a) => sum + a.quantity, 0) > c.offer.quantity)) return false;
  }
  // Capacity is a rectangular load table over all endpoints, not the searcher's pruning routine.
  // Group custody and timed allocations by project so an outstanding item is counted once.
  for (const p of value.publishers) {
    const state = book(p);
    for (const r of state.resources) {
      const selectedLoads = allocations.filter((a) => a.publisherRoot === p.root.key && a.resourceId === r.id);
      const foreign = state.grants.filter((g) => g.validUntil > value.snapshot.blockTimestamp && g.projectRoot !== value.projectRoot);
      const holds = state.custodyHolds.filter((h) => h.status === 'outstanding' && h.resourceId === r.id);
      const timed = [
        ...selectedLoads.map((a) => ({ ...a, projectRoot: value.projectRoot })),
        ...foreign.flatMap((g) => g.allocations.filter((a) => a.resourceId === r.id).map((a) => ({ ...a, projectRoot: g.projectRoot }))),
      ];
      const projects = [...new Set([...timed.map((a) => a.projectRoot), ...holds.map((h) => h.projectRoot)])];
      const endpoints = [...new Set(timed.flatMap((a) => [a.interval.start, a.interval.end]))].sort((a, b) => a - b);
      for (const time of endpoints.slice(0, -1)) {
        if (!selectedLoads.some((a) => activeAt(a, time))) continue;
        const total = projects.reduce((sum, root) => {
          const reserved = timed.filter((a) => a.projectRoot === root && activeAt(a, time)).reduce((n, a) => n + a.quantity, 0);
          const inCustody = holds.filter((h) => h.projectRoot === root).reduce((n, h) => n + h.quantity, 0);
          return sum + Math.max(reserved, inCustody);
        }, 0);
        const capacity = p.root.payload.kind === 'individual' && r.kind === 'person' ? 1 : r.capacity;
        if (total > capacity) return false;
      }
    }
  }
  return true;
}

function enumerate(value: SolverInput, pins: SolverPin[] = []): OracleCandidate[] {
  const available = choices(value);
  const feasible: OracleCandidate[] = [];
  for (const selectedVariant of value.recipe.variants) {
    const axes = selectedVariant.requirements.flatMap((r) => available.map((c) => ({ r, c, radix: Math.min(r.quantity, c.offer.quantity) + 1 })));
    const tableSize = axes.reduce((size, axis) => size * axis.radix, 1);
    if (tableSize > 1_000_000) throw new Error('Keep exhaustive oracle fixtures intentionally small');
    // Direct mixed-radix enumeration visits every complete integer table. It neither
    // backtracks nor asks production validation/search helpers to accept a table.
    for (let row = 0; row < tableSize; row += 1) {
      let digits = row;
      const allocations: Allocation[] = [];
      for (const [index, { r, c, radix }] of axes.entries()) {
        const quantity = digits % radix;
        digits = Math.floor(digits / radix);
        if (quantity) allocations.push({ id: `oracle-${index}`, requirementId: r.id,
          publisherRoot: c.publisher.root.key, offerId: c.offer.id,
          offerHash: hashOffer(c.publisher.root.key, c.offer), resourceId: c.resource.id,
          quantity, unit: r.unit, interval: { ...r.interval } });
      }
      const candidate = { variant: selectedVariant, allocations };
      if (independentFeasible(value, candidate, pins)) feasible.push(candidate);
    }
  }
  return feasible;
}

function assignmentKey(a: Allocation): string {
  return JSON.stringify([a.requirementId, a.publisherRoot, a.offerId, a.resourceId]);
}

function candidateKey(candidate: OracleCandidate): string {
  return JSON.stringify([candidate.variant.id, candidate.allocations.map((a) => [assignmentKey(a), a.quantity])
    .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)]);
}

function independentRank(value: SolverInput, candidate: OracleCandidate): RankNumbers {
  const previous = value.predecessor?.payload.plan;
  if (!previous) return [0, 0, 0, 0];
  const retained = new Set(candidate.allocations.map((a) => a.publisherRoot));
  const removed = new Set(previous.allocations.map((a) => a.publisherRoot).filter((root) => !retained.has(root))).size;
  const oldAmounts = new Map(previous.allocations.map((a) => [assignmentKey(a), a.quantity]));
  const amounts = new Map(candidate.allocations.map((a) => [assignmentKey(a), a.quantity]));
  const keys = [...new Set([...oldAmounts.keys(), ...amounts.keys()])];
  const changed = keys.map((key) => Math.abs((oldAmounts.get(key) ?? 0) - (amounts.get(key) ?? 0)));
  // A stable assignment identity does not imply unchanged acceptance terms. A
  // different return bound, unit or immutable offer content also needs agreement.
  const terms = (allocations: Allocation[], key: string): string => JSON.stringify(allocations
    .filter((allocation) => assignmentKey(allocation) === key)
    .map((allocation) => JSON.stringify([allocation.interval.start, allocation.interval.end, allocation.unit, allocation.offerHash]))
    .sort());
  const changedAssignments = keys.filter((key, index) => changed[index] !== 0
    || terms(previous.allocations, key) !== terms(candidate.allocations, key)).length;
  return [removed, previous.variant.id === candidate.variant.id ? 0 : 1,
    changed.reduce((sum, n) => sum + n, 0), changedAssignments];
}

function compareRank(a: RankNumbers, b: RankNumbers): number {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function expectOracleAgreement(value: SolverInput, pins: SolverPin[] = []): OracleCandidate[] {
  const expected = enumerate(value, pins);
  const result = solve(value, pins, { maxNodes: 1_000_000, maxCandidates: Math.max(1, expected.length + 1) });
  expect(result.status, JSON.stringify(result.reasons)).toBe(expected.length ? 'found' : 'impossible');
  expect(result.exhausted).toBe(false);
  expect(result.optimality).toBe('proven');
  expect(new Set(result.candidates.map((c) => candidateKey(c.plan))))
    .toEqual(new Set(expected.map(candidateKey)));
  for (const candidate of result.candidates) {
    expect(independentFeasible(value, candidate.plan, pins)).toBe(true);
    expect([candidate.rank.removedPublishers, candidate.rank.changedVariant,
      candidate.rank.changedAllocations, candidate.rank.changedAssignments]).toEqual(independentRank(value, candidate.plan));
  }
  if (expected.length) {
    const best = expected.map((candidate) => independentRank(value, candidate)).sort(compareRank)[0];
    expect(independentRank(value, result.candidates[0]!.plan)).toEqual(best);
  }
  return expected;
}

function reservation(p: PublisherAggregate, projectRoot: EntityKey, quantity = 1, interval = WINDOW, validUntil = NOW + 100): Grant {
  const o = book(p).offers[0]!;
  const source: SourcePlanRef = { projectRoot, activationKey: `local:activation-${projectRoot}`,
    proposalKey: `local:proposal-${projectRoot}`, proposalHash: HASH };
  book(p).decisions = [...book(p).decisions.filter((d) => d.projectRoot !== projectRoot || d.activationKey !== source.activationKey),
    { ...source, status: 'accepted', decidedAt: NOW - 1, operationId: `accept-${projectRoot}` }];
  return { ...source, id: `grant-${projectRoot}`, protocol: 'partfolk/1', chainId: null,
    offers: [{ publisherRoot: p.root.key, offerId: o.id, offerHash: hashOffer(p.root.key, o) }],
    allocations: [{ id: 'reserved', requirementId: 'reserved', publisherRoot: p.root.key,
      offerId: o.id, offerHash: hashOffer(p.root.key, o), resourceId: o.resourceId,
      quantity, unit: o.unit, interval: { ...interval } }], validUntil, acceptedAt: NOW - 1,
    operationId: `reserve-${projectRoot}` };
}

function custody(p: PublisherAggregate, projectRoot: EntityKey, quantity = 1): CustodyHold {
  return { id: `custody-${projectRoot}`, projectRoot, resourceId: book(p).resources[0]!.id,
    quantity, unit: 'item', source: { projectRoot, activationKey: 'local:old-activation',
      proposalKey: 'local:old-proposal', proposalHash: HASH }, transferId: 'delivered',
    createdAt: NOW - 10_000, status: 'outstanding' };
}

function preserve(value: SolverInput, previous: OracleCandidate): void {
  const selected = choices(value).filter((c) => previous.allocations.some((a) => a.publisherRoot === c.publisher.root.key && a.offerId === c.offer.id));
  const plan: PlanDocument = { protocol: 'partfolk/1', validationVersion: 1, chainId: null,
    projectRoot: value.projectRoot, outcome: value.recipe.outcome, variant: previous.variant,
    offers: selected.map((c) => ({ publisherRoot: c.publisher.root.key, offerId: c.offer.id, offerHash: hashOffer(c.publisher.root.key, c.offer) })),
    resourceAssumptions: selected.map((c) => ({ publisherRoot: c.publisher.root.key, resourceId: c.resource.id, capacity: c.resource.capacity, unit: c.resource.unit })),
    allocations: previous.allocations, requiredApprovers: [...new Set(previous.allocations.map((a) => a.publisherRoot))],
    conditions: selected.flatMap((c) => c.offer.conditions), instructions: value.recipe.instructions,
    runbook: previous.allocations.map((a) => ({ kind: 'task', id: `task-${a.id}`, title: a.requirementId,
      publisherRoot: a.publisherRoot, interval: previous.variant.requirements.find(requirement => requirement.id === a.requirementId)!.interval,
      allocationIds: [a.id], dependsOn: [], instructions: '' })), predecessor: null };
  const proposalHash = hashPlan(plan);
  const owner = value.publishers[0]!.root.provenance;
  value.predecessor = { key: 'local:previous-proposal', provenance: owner,
    payload: { protocol: 'partfolk/1', schemaVersion: 1, operationId: 'previous', createdAt: NOW - 10,
      entityType: 'proposal', projectRoot: value.projectRoot,
      requirementsHash: hashRequirements(value.projectRoot, previous.variant.requirements),
      proposalHash, plan, changeExplanation: '' } };
  value.predecessorSource = { projectRoot: value.projectRoot, activationKey: 'local:previous-activation',
    proposalKey: value.predecessor.key, proposalHash };
}

describe('generic solver against an independent exhaustive integer-table oracle', () => {
  it('finds all split-quantity allocations, without treating one offer as a complete requirement', () => {
    const value = input([publisher('a'), publisher('b'), publisher('c')], [requirement('build', 'build', 2)]);
    expect(expectOracleAgreement(value)).toHaveLength(3);
  });

  it('checks resource identity by publisher root and resource id, including shared personal time', () => {
    const a = publisher('a', [resource('self', 1, ['install', 'transport'])],
      [offer('install', 'self', 1, ['install']), offer('transport', 'self', 1, ['transport'])]);
    a.root.payload.kind = 'individual';
    book(a).resources[0]!.kind = 'person';
    book(a).resources[0]!.unit = 'person';
    for (const o of book(a).offers) { o.kind = 'person'; o.unit = 'person'; }
    const requirements = [requirement('install', 'install'), requirement('transport', 'transport')];
    for (const r of requirements) { r.kind = 'person'; r.unit = 'person'; }
    expect(expectOracleAgreement(input([a], requirements))).toHaveLength(0);
    const b = structuredClone(a);
    b.root.key = 'local:oracle-publisher-b';
    b.root.payload.publisher = { kind: 'local', id: 'local-actor:oracle-b' };
    b.root.provenance.creator = b.root.payload.publisher;
    b.root.provenance.owner = b.root.payload.publisher;
    if (b.book.status === 'unique') {
      b.book.entity.key = 'local:oracle-book-b';
      b.book.entity.payload.publisherRoot = b.root.key;
      b.book.entity.provenance = { ...b.root.provenance };
    }
    expect(expectOracleAgreement(input([a, b], requirements))).toHaveLength(2);
  });

  it('allows adjacent reuse and rejects overlap and availability gaps', () => {
    const a = publisher('a');
    const adjacent = [requirement('first'), requirement('second', 'build', 1, { start: WINDOW.end, end: WINDOW.end + 10 })];
    book(a).offers[0]!.availability = [{ start: WINDOW.start, end: WINDOW.end }, { start: WINDOW.end, end: WINDOW.end + 10 }];
    expect(expectOracleAgreement(input([a], adjacent))).toHaveLength(1);
    adjacent[1]!.interval.start -= 1;
    expect(expectOracleAgreement(input([a], adjacent))).toHaveLength(0);
    const gap = input([a], [requirement('long', 'build', 1, { start: WINDOW.start, end: WINDOW.end + 10 })]);
    book(a).offers[0]!.availability[1]!.start += 1;
    expect(expectOracleAgreement(gap)).toHaveLength(0);
  });

  it('requires the entire availability end boundary', () => {
    const a = publisher('a');
    book(a).resources[0]!.availability = [{ ...WINDOW }];
    expect(expectOracleAgreement(input([a]))).toHaveLength(1);
    book(a).resources[0]!.availability[0]!.end -= 1;
    expect(expectOracleAgreement(input([a]))).toHaveLength(0);
  });

  it('respects an offer quantity below its resource capacity across simultaneous requirements', () => {
    const a = publisher('a', [resource('kit', 3)], [offer('offer', 'kit', 1)]);
    const value = input([a], [requirement('first'), requirement('second')]);
    expect(expectOracleAgreement(value)).toHaveLength(0);
    book(a).offers[0]!.quantity = 2;
    expect(expectOracleAgreement(value)).toHaveLength(1);
  });

  it('evaluates contribution dependencies, capability conditions and exclusions together', () => {
    const room = publisher('room', [resource('room', 1, ['room'])], [offer('room', 'room', 1, ['room'])]);
    const host = publisher('host', [resource('host', 1, ['host'])], [offer('host', 'host', 1, ['host'])]);
    const alternate = publisher('alternate', [resource('host', 1, ['host'])], [offer('host', 'host', 1, ['host'])]);
    book(room).offers[0]!.conditions = [{ kind: 'requires_offer', offer: { publisherRoot: host.root.key, offerId: 'host' } },
      { kind: 'requires_capability', capability: 'host' }];
    const value = input([room, host, alternate], [requirement('room', 'room'), requirement('host', 'host')]);
    expect(expectOracleAgreement(value)).toHaveLength(1);
    book(host).offers[0]!.conditions = [{ kind: 'excludes_offer', offer: { publisherRoot: room.root.key, offerId: 'room' } }];
    expect(expectOracleAgreement(value)).toHaveLength(0);
  });

  it('enforces end-before-start task dependencies independently of available capacity', () => {
    const a = publisher('a', [resource('kit', 2)], [offer('offer', 'kit', 2)]);
    const first = requirement('first');
    const second = requirement('second', 'build', 1, { start: WINDOW.end, end: WINDOW.end + 10 });
    second.dependsOn = [first.id];
    const value = input([a], [first, second]);
    expect(expectOracleAgreement(value)).toHaveLength(1);
    second.interval.start -= 1;
    expect(expectOracleAgreement(value)).toHaveLength(0);
  });

  it('uses exact project scope, allowed variant and venue conditions', () => {
    const a = publisher('a');
    book(a).offers[0]!.conditions = [{ kind: 'allowed_variants', variantIds: ['later'] }, { kind: 'allowed_venues', venueIds: ['library'] }];
    const value = input([a], [], [variant('first', [requirement('build')]), variant('later', [requirement('build')], 'library')]);
    expect(expectOracleAgreement(value)).toHaveLength(1);
    book(a).offers[0]!.projectScope = ['local:another-project'];
    expect(expectOracleAgreement(value)).toHaveLength(0);
  });

  it('honors quantity pins and never drops an incompatible pin', () => {
    const a = publisher('a', [resource('kit', 2)], [offer('offer', 'kit', 2)]);
    const b = publisher('b', [resource('kit', 2)], [offer('offer', 'kit', 2)]);
    const value = input([a, b], [requirement('build', 'build', 2)]);
    const pin: SolverPin = { requirementId: 'build', publisherRoot: a.root.key, offerId: 'offer' };
    expect(expectOracleAgreement(value, [pin])).toHaveLength(2);
    expect(expectOracleAgreement(value, [{ ...pin, quantity: 1 }])).toHaveLength(1);
    expect(expectOracleAgreement(value, [{ ...pin, quantity: 3 }])).toHaveLength(0);
    expect(expectOracleAgreement(value, [{ ...pin, requirementId: 'missing' }])).toHaveLength(0);
  });

  it('counts current foreign grants, expires them at the deadline, and replaces same-project grants once', () => {
    const a = publisher('a');
    const value = input([a]);
    book(a).grants = [reservation(a, 'local:foreign-project')];
    expect(expectOracleAgreement(value)).toHaveLength(0);
    value.snapshot.blockTimestamp = NOW + 100;
    a.snapshot.blockTimestamp = NOW + 100;
    expect(expectOracleAgreement(value)).toHaveLength(1);
    value.snapshot.blockTimestamp = NOW;
    a.snapshot.blockTimestamp = NOW;
    book(a).grants = [reservation(a, PROJECT)];
    expect(expectOracleAgreement(value)).toHaveLength(1);
  });

  it('retains physical custody after grant expiry and avoids counting a project hold twice', () => {
    const a = publisher('a');
    const value = input([a]);
    book(a).grants = [reservation(a, 'local:closed-project', 1, { start: NOW - 20, end: NOW - 10 }, NOW)];
    book(a).custodyHolds = [custody(a, 'local:closed-project')];
    expect(expectOracleAgreement(value)).toHaveLength(0);
    book(a).custodyHolds = [custody(a, PROJECT)];
    expect(expectOracleAgreement(value)).toHaveLength(1);
    book(a).resources[0]!.capacity = 2;
    book(a).offers[0]!.quantity = 2;
    book(a).grants = [reservation(a, 'local:foreign-project')];
    book(a).custodyHolds = [custody(a, 'local:foreign-project')];
    expect(expectOracleAgreement(value)).toHaveLength(1);
    book(a).resources[0]!.capacity = 1;
    book(a).offers[0]!.quantity = 1;
    book(a).grants = [];
    book(a).custodyHolds[0]!.status = 'released';
    book(a).custodyHolds[0]!.release = { at: NOW, operationId: 'returned', reason: 'Owner acknowledged return' };
    expect(expectOracleAgreement(value)).toHaveLength(1);
  });

  it('matches exhaustive optima for deterministic arbitrary small domains', () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const a = publisher(`a-${seed}`, [resource('kit', 1 + seed % 2, ['build', 'move'])],
        [offer('offer', 'kit', 1 + seed % 2, ['build', 'move'])]);
      const b = publisher(`b-${seed}`, [resource('kit', 1 + (seed >> 1) % 2, ['build', 'move'])],
        [offer('offer', 'kit', 1 + (seed >> 1) % 2, seed % 3 === 0 ? ['build'] : ['build', 'move'])]);
      const first = requirement('build', 'build', 1 + (seed >> 2) % 2);
      const second = requirement('move', 'move', 1, seed % 2 ? WINDOW : { start: WINDOW.end, end: WINDOW.end + 10 });
      if (seed % 4 === 0) second.dependsOn = ['build'];
      if (seed % 5 === 0) book(a).offers[0]!.conditions = [{ kind: 'excludes_offer', offer: { publisherRoot: b.root.key, offerId: 'offer' } }];
      if (seed % 6 === 0) book(a).grants = [reservation(a, 'local:foreign-project')];
      if (seed % 7 === 0) book(b).custodyHolds = [custody(b, 'local:foreign-project')];
      expectOracleAgreement(input([a, b], [first, second]));
    }
  });

  it('uses the documented repair rank before deterministic tie-breaking', () => {
    const a = publisher('a', [resource('kit', 2)], [offer('offer', 'kit', 2)]);
    const b = publisher('b', [resource('kit', 2)], [offer('offer', 'kit', 2)]);
    const value = input([a, b], [], [variant('first', [requirement('build', 'build', 2)]), variant('later', [requirement('build', 'build', 2)])]);
    const before = enumerate(value).find((c) => c.variant.id === 'later' && c.allocations.length === 2)!;
    preserve(value, before);
    expectOracleAgreement(value);
    book(a).offers[0]!.conditions = [{ kind: 'allowed_variants', variantIds: ['first'] }];
    expectOracleAgreement(value);
  });

  it('counts a changed equipment return bound even when owner, offer and quantity are preserved', () => {
    const value = input([publisher('a')]);
    const before = enumerate(value)[0]!;
    before.allocations[0]!.interval.end += 30;
    preserve(value, before);
    const candidates = expectOracleAgreement(value);
    expect(candidates).toHaveLength(1);
    expect(independentRank(value, candidates[0]!)).toEqual([0, 0, 0, 1]);
  });

  it('returns repeatable ordered results across input order and limits retained candidates without truncating search', () => {
    const value = input([publisher('accent'), publisher('z'), publisher('a')]);
    book(value.publishers[0]!).name = 'Équipe';
    const first = solve(value, [], { maxNodes: 100_000, maxCandidates: 1 });
    const reversed = structuredClone(value);
    reversed.publishers.reverse();
    expect(solve(reversed, [], { maxNodes: 100_000, maxCandidates: 1 })).toEqual(first);
    expect(first.candidates).toHaveLength(1);
    expect(first.status).toBe('found');
    expect(first.exhausted).toBe(false);
    expect(first.optimality).toBe('proven');
    expect(enumerate(value).map(candidateKey)).toContain(candidateKey(first.candidates[0]!.plan));
  });

  it('never claims impossibility or proven optimality after a node budget is exhausted', () => {
    const value = input([publisher('a'), publisher('b'), publisher('c')], [requirement('build', 'build', 2)]);
    const feasible = new Set(enumerate(value).map(candidateKey));
    expect(feasible.size).toBeGreaterThan(0);
    const result = solve(value, [], { maxNodes: 1, maxCandidates: 20 });
    expect(result.status).not.toBe('impossible');
    expect(result.exhausted).toBe(true);
    expect(result.optimality).toBe('not_proven');
    expect(result.reasons.some((reason) => reason.code === 'search_exhausted')).toBe(true);
    for (const candidate of result.candidates) expect(feasible.has(candidateKey(candidate.plan))).toBe(true);
  });
});
