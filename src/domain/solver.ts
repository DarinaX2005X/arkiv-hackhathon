import {
  canonicalConditions, canonicalJson, compareText, hashCanonical, hashOffer, hashPlan,
  offerIdentity, resourceIdentity,
} from './canonical';
import {
  capacityConflicts, checkConditions, deriveRequiredApprovers, independentlyValidatePlan,
  offerFits, validateSolverInput,
} from './validation';
import { PROTOCOL } from './types';
import type {
  Actor, Allocation, BookState, Condition, DomainReason, EntityKey, EntityRecord, Offer, PlanCandidate, PlanDocument,
  PlanRank, ProjectVariant, PublisherAggregate, Requirement, Resource, RunbookObligation,
  PublisherRoot, SolverBudget, SolverInput, SolverPin, SolverResult,
} from './types';

interface Choice { publisherRoot: EntityKey; offer: Offer; resource: Resource }
const choiceId = (choice: Choice): string => offerIdentity({ publisherRoot: choice.publisherRoot, offerId: choice.offer.id });
const assignmentKey = (allocation: Allocation): string => canonicalJson([allocation.requirementId, allocation.publisherRoot, allocation.offerId, allocation.resourceId]);
const datedVariant = (variant: ProjectVariant): string => canonicalJson({
  id: variant.id, venueId: variant.venueId, timeZone: variant.timeZone,
  times: [...variant.requirements].sort((a, b) => compareText(a.id, b.id)).map(requirement => ({ id: requirement.id, interval: requirement.interval })),
});

/** Owners retained first, then date/variant, then integer allocation and assignment changes. */
export function rankPlan(plan: PlanDocument, predecessor: PlanDocument | null): PlanRank {
  let changedAllocations = 0, changedAssignments = 0;
  if (predecessor) {
    const old = new Map<string, number>(), next = new Map<string, number>();
    for (const allocation of predecessor.allocations) old.set(assignmentKey(allocation), (old.get(assignmentKey(allocation)) ?? 0) + allocation.quantity);
    for (const allocation of plan.allocations) next.set(assignmentKey(allocation), (next.get(assignmentKey(allocation)) ?? 0) + allocation.quantity);
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const difference = Math.abs((old.get(key) ?? 0) - (next.get(key) ?? 0));
      changedAllocations += difference;
      const beforeTerms = predecessor.allocations.filter(allocation => assignmentKey(allocation) === key)
        .map(allocation => ({ interval: allocation.interval, unit: allocation.unit, offerHash: allocation.offerHash })).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
      const afterTerms = plan.allocations.filter(allocation => assignmentKey(allocation) === key)
        .map(allocation => ({ interval: allocation.interval, unit: allocation.unit, offerHash: allocation.offerHash })).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
      if (difference > 0 || canonicalJson(beforeTerms) !== canonicalJson(afterTerms)) changedAssignments++;
    }
  }
  return {
    removedPublishers: predecessor ? predecessor.requiredApprovers.filter(root => !plan.requiredApprovers.includes(root)).length : 0,
    changedVariant: predecessor && datedVariant(predecessor.variant) !== datedVariant(plan.variant) ? 1 : 0,
    changedAllocations, changedAssignments, tieBreak: hashPlan(plan),
  };
}

export function compareRank(left: PlanRank, right: PlanRank): number {
  return left.removedPublishers - right.removedPublishers || left.changedVariant - right.changedVariant
    || left.changedAllocations - right.changedAllocations || left.changedAssignments - right.changedAssignments
    || compareText(left.tieBreak, right.tieBreak);
}

function makeAllocation(requirement: Requirement, choice: Choice, quantity: number): Allocation {
  const identity = [requirement.id, choice.publisherRoot, choice.offer.id, choice.resource.id];
  return {
    id: `allocation:${hashCanonical(identity).slice(2, 26)}`, requirementId: requirement.id,
    publisherRoot: choice.publisherRoot, offerId: choice.offer.id, offerHash: hashOffer(choice.publisherRoot, choice.offer),
    resourceId: choice.resource.id, quantity, unit: requirement.unit, interval: { ...requirement.interval },
  };
}

function assemblePlan(input: SolverInput, variant: ProjectVariant, allocations: Allocation[], choices: Choice[]): PlanDocument {
  const used = choices.filter(choice => allocations.some(allocation => allocation.publisherRoot === choice.publisherRoot && allocation.offerId === choice.offer.id));
  const resources = new Map(used.map(choice => [resourceIdentity({ publisherRoot: choice.publisherRoot, resourceId: choice.resource.id }), choice]));
  const conditions = new Map<string, Condition>();
  for (const choice of used) for (const condition of canonicalConditions(choice.offer.conditions)) conditions.set(canonicalJson(condition), condition);
  const obligations: RunbookObligation[] = [];
  const requirements = [...variant.requirements].sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end || compareText(a.id, b.id));
  for (const requirement of requirements) {
    const parties = [...new Set(allocations.filter(allocation => allocation.requirementId === requirement.id).map(allocation => allocation.publisherRoot))].sort(compareText);
    for (const publisherRoot of parties) {
      const ownAllocations = allocations.filter(allocation => allocation.requirementId === requirement.id && allocation.publisherRoot === publisherRoot);
      obligations.push({
        kind: 'task', id: `task:${hashCanonical([requirement.id, publisherRoot]).slice(2, 26)}`,
        title: requirement.title, publisherRoot, interval: { ...requirement.interval },
        allocationIds: ownAllocations.map(allocation => allocation.id).sort(compareText), dependsOn: [],
        instructions: requirement.instructions,
      });
    }
  }
  for (const obligation of obligations) {
    const requirementId = allocations.find(allocation => obligation.allocationIds.includes(allocation.id))?.requirementId;
    const requirement = variant.requirements.find(requirement => requirement.id === requirementId);
    obligation.dependsOn = obligations.filter(other => other.allocationIds.some(id => {
      const allocated = allocations.find(allocation => allocation.id === id);
      return allocated && requirement?.dependsOn.includes(allocated.requirementId);
    })).map(other => other.id).sort(compareText);
  }
  const plan: PlanDocument = {
    protocol: PROTOCOL, validationVersion: 1, chainId: input.snapshot.chainId,
    projectRoot: input.projectRoot, outcome: input.recipe.outcome, variant,
    offers: used.map(choice => ({ publisherRoot: choice.publisherRoot, offerId: choice.offer.id, offerHash: hashOffer(choice.publisherRoot, choice.offer) }))
      .sort((a, b) => compareText(offerIdentity(a), offerIdentity(b))),
    resourceAssumptions: [...resources.values()].map(choice => ({ publisherRoot: choice.publisherRoot, resourceId: choice.resource.id, capacity: choice.resource.capacity, unit: choice.resource.unit }))
      .sort((a, b) => compareText(resourceIdentity(a), resourceIdentity(b))),
    allocations: [...allocations].sort((a, b) => compareText(a.id, b.id)), requiredApprovers: [],
    conditions: canonicalConditions([...conditions.values()]), instructions: input.recipe.instructions,
    runbook: obligations, predecessor: input.predecessorSource,
  };
  plan.requiredApprovers = deriveRequiredApprovers(plan);
  return plan;
}

function allChoices(publishers: PublisherAggregate[], step: () => void, checkpoint: () => void): Choice[] {
  const choices: Choice[] = [];
  for (const publisher of publishers) {
    step();
    if (publisher.book.status !== 'unique') continue;
    const resources = new Map<string, Resource>();
    for (const resource of publisher.book.entity.payload.resources) { step(); resources.set(resource.id, resource); }
    for (const offer of publisher.book.entity.payload.offers) {
      step();
      const resource = resources.get(offer.resourceId);
      if (resource) choices.push({ publisherRoot: publisher.root.key, offer, resource });
    }
  }
  return choices.sort((a, b) => { checkpoint(); return compareText(choiceId(a), choiceId(b)); });
}

/** Finite integer search. Every emitted candidate passes the independent evaluator. */
export function solve(input: SolverInput, pins: SolverPin[] = [], budget: SolverBudget = { maxNodes: 100000, maxCandidates: 20 }): SolverResult {
  return solveInternal(input, pins, budget, true);
}

function solveInternal(input: SolverInput, pins: SolverPin[], budget: SolverBudget, explain: boolean): SolverResult {
  // Validation and preprocessing are part of the elapsed budget, too. Synchronous
  // domain helpers cannot be interrupted, so check both sides of every such call.
  const start = Date.now();
  if (!Number.isSafeInteger(budget.maxNodes) || budget.maxNodes < 0 || !Number.isSafeInteger(budget.maxCandidates) || budget.maxCandidates < 1
    || (budget.maxMilliseconds !== undefined && (!Number.isSafeInteger(budget.maxMilliseconds) || budget.maxMilliseconds <= 0))) {
    return { status: 'unverified', candidates: [], reasons: [{ code: 'invalid_input' }], nodesVisited: 0, exhausted: false, optimality: 'not_proven' };
  }
  let nodesVisited = 0, exhausted = false;
  const candidates: PlanCandidate[] = [];
  const seen = new Set<string>();
  const reasons: DomainReason[] = [];
  const reasonKeys = new Set<string>();
  const addReason = (reason: DomainReason): void => {
    // Retain bounded diagnostics while searching, rather than constructing an
    // unbounded rejection history and slicing it only after search completes.
    if (reasons.length >= 128) return;
    const key = canonicalJson(reason);
    if (!reasonKeys.has(key)) { reasonKeys.add(key); reasons.push(reason); }
  };
  const stopped = Symbol('solver budget exhausted');
  const checkpoint = (): void => {
    if (budget.maxMilliseconds !== undefined && Date.now() - start >= budget.maxMilliseconds) throw stopped;
  };
  const step = (): void => {
    checkpoint();
    if (nodesVisited >= budget.maxNodes) throw stopped;
    nodesVisited++;
  };
  const work = <T>(operation: () => T): T => {
    step();
    const result = operation();
    checkpoint();
    return result;
  };
  try {
    const initial = work(() => validateSolverInput(input));
    let invalidPins = false;
    const pinKeys = new Set<string>();
    const pinsByRequirement = new Map<string, SolverPin[]>();
    const pinsByChoice = new Map<string, SolverPin>();
    let duplicatePins = false;
    for (const pin of pins) {
      step();
      if (typeof pin.requirementId !== 'string' || typeof pin.publisherRoot !== 'string' || typeof pin.offerId !== 'string'
        || (pin.quantity !== undefined && (!Number.isSafeInteger(pin.quantity) || pin.quantity <= 0))) {
        invalidPins = true;
        continue;
      }
      const key = canonicalJson([pin.requirementId, pin.publisherRoot, pin.offerId]);
      if (pinKeys.has(key)) duplicatePins = true;
      pinKeys.add(key);
      pinsByChoice.set(key, pin);
      const requirementPins = pinsByRequirement.get(pin.requirementId) ?? [];
      requirementPins.push(pin);
      pinsByRequirement.set(pin.requirementId, requirementPins);
    }
    if (!initial.valid || invalidPins) {
      for (const reason of initial.reasons) { checkpoint(); addReason(reason); }
      if (invalidPins) addReason({ code: 'invalid_input' });
      return { status: 'unverified', candidates: [], reasons, nodesVisited, exhausted: false, optimality: 'not_proven' };
    }
    if (duplicatePins) return { status: 'impossible', candidates: [], reasons: [{ code: 'pin_conflict' }], nodesVisited, exhausted: false, optimality: 'proven' };
    const now = input.snapshot.blockTimestamp;
    const choices = allChoices(input.publishers, step, checkpoint);
    const variants = work(() => [...input.recipe.variants].sort((a, b) => { checkpoint(); return compareText(a.id, b.id); }));
    for (const variant of variants) {
      step();
      const eligible = new Map<string, Choice[]>();
      const tails = new Map<string, number[]>();
      const requirementIds = new Set<string>();
      for (const requirement of variant.requirements) {
        step();
        requirementIds.add(requirement.id);
        const available: Choice[] = [];
        for (const choice of choices) {
          if (work(() => offerFits(choice.offer, choice.resource, requirement, input.projectRoot, variant.id, variant.venueId))) available.push(choice);
        }
        eligible.set(requirement.id, available);
        // A suffix bound avoids rescanning all remaining choices at every node.
        const suffix = new Array<number>(available.length + 1).fill(0);
        for (let i = available.length - 1; i >= 0; i--) {
          step();
          const choice = available[i]!;
          suffix[i] = suffix[i + 1]! + Math.min(choice.offer.quantity, choice.resource.capacity);
        }
        tails.set(requirement.id, suffix);
      }
      let conflictingPins = false;
      for (const pin of pins) {
        step();
        if (!requirementIds.has(pin.requirementId)) {
          addReason({ code: 'pin_conflict', requirementId: pin.requirementId, params: { variantId: variant.id } });
          conflictingPins = true;
        }
      }
      if (conflictingPins) continue;
      let trivialShortage = false;
      for (const requirement of variant.requirements) {
        step();
        const available = eligible.get(requirement.id)!;
        // Upper bound intentionally ignores shared resource contention. It never proves feasibility.
        const upper = tails.get(requirement.id)![0]!;
        if (upper < requirement.quantity) {
          addReason({ code: 'shortage', requirementId: requirement.id, params: { variantId: variant.id, required: requirement.quantity, available: upper, missing: requirement.quantity - upper } });
          trivialShortage = true;
        }
        for (const pin of pinsByRequirement.get(requirement.id) ?? []) {
          step();
          let present = false;
          for (const choice of available) {
            step();
            if (choice.publisherRoot === pin.publisherRoot && choice.offer.id === pin.offerId) { present = true; break; }
          }
          if (!present) {
            addReason({ code: 'pin_conflict', requirementId: pin.requirementId, publisherRoot: pin.publisherRoot, offerId: pin.offerId, params: { variantId: variant.id } });
            trivialShortage = true;
          }
        }
      }
      if (trivialShortage) continue;
      const requirements = work(() => [...variant.requirements].sort((a, b) => {
        checkpoint();
        return eligible.get(a.id)!.length - eligible.get(b.id)!.length || compareText(a.id, b.id);
      }));
      const allocations: Allocation[] = [];
      let variantFound = false;
      const exploreRequirement = (index: number): void => {
        step();
        if (index === requirements.length) {
          const used = work(() => choices.filter(choice => {
            step();
            return allocations.some(allocation => { checkpoint(); return allocation.publisherRoot === choice.publisherRoot && allocation.offerId === choice.offer.id; });
          }));
          const conditionReasons = work(() => checkConditions(used.flatMap(choice => choice.offer.conditions), used, variant.id, variant.venueId));
          if (conditionReasons.length) {
            for (const reason of conditionReasons) { step(); addReason({ ...reason, params: { ...reason.params, variantId: variant.id } }); }
            return;
          }
          const plan = work(() => assemblePlan(input, variant, allocations, choices));
          const validation = work(() => independentlyValidatePlan(plan, input.publishers, now, pins));
          if (!validation.valid) {
            for (const reason of validation.reasons) { step(); addReason(reason); }
            return;
          }
          variantFound = true;
          const proposalHash = work(() => hashPlan(plan));
          if (seen.has(proposalHash)) return;
          const candidate = work(() => ({ plan, proposalHash, rank: rankPlan(plan, input.predecessor?.payload.plan ?? null) }));
          const retained = work(() => [...candidates, candidate].sort((a, b) => {
            checkpoint(); return compareRank(a.rank, b.rank);
          }).slice(0, budget.maxCandidates));
          seen.add(proposalHash);
          candidates.splice(0, candidates.length, ...retained);
          return;
        }
        const requirement = requirements[index]!;
        const available = eligible.get(requirement.id)!;
        const assign = (choiceIndex: number, remaining: number): void => {
          step();
          if (choiceIndex === available.length) { if (remaining === 0) exploreRequirement(index + 1); return; }
          const choice = available[choiceIndex]!;
          const pin = pinsByChoice.get(canonicalJson([requirement.id, choice.publisherRoot, choice.offer.id]));
          const maximum = Math.min(remaining, choice.offer.quantity, choice.resource.capacity);
          const minimum = pin ? pin.quantity ?? 1 : 0;
          const upper = pin?.quantity ?? maximum;
          if (upper > maximum || minimum > upper) return;
          const tail = tails.get(requirement.id)![choiceIndex + 1]!;
          for (let amount = upper; amount >= minimum; amount--) {
            // Rejected quantities are search attempts, including tail-bound and
            // capacity rejection paths that never recurse into another node.
            step();
            if (remaining - amount > tail) continue;
            if (amount > 0) allocations.push(work(() => makeAllocation(requirement, choice, amount)));
            const conflicts = amount > 0 ? work(() => capacityConflicts(allocations, input.publishers, input.projectRoot, now)) : [];
            if (conflicts.length === 0) assign(choiceIndex + 1, remaining - amount);
            else for (const reason of conflicts) {
              step();
              // Stop collecting once diagnostics are full, while still searching.
              if (reasons.length >= 128) continue;
              const conflicting = work(() => [...new Set(allocations.filter(allocation => allocation.publisherRoot === reason.publisherRoot
                && (!reason.resourceId || allocation.resourceId === reason.resourceId)
                && (!reason.offerId || allocation.offerId === reason.offerId)).map(allocation => allocation.requirementId))].sort(compareText));
              const publisher = work(() => input.publishers.find(publisher => publisher.root.key === reason.publisherRoot));
              addReason({ ...reason, requirementId: requirement.id, params: { ...reason.params, variantId: variant.id,
                publisherName: publisher?.book.status === 'unique' ? publisher.book.entity.payload.name : reason.publisherRoot ?? '',
                conflictingRequirementIds: conflicting.join('|'),
                conflictingRequirementTitles: work(() => conflicting.map(id => variant.requirements.find(item => item.id === id)?.title ?? id).join(' | ')),
              } });
            }
            if (amount > 0) allocations.pop();
          }
        };
        assign(0, requirement.quantity);
      };
      exploreRequirement(0);
      if (!variantFound && !reasons.some(reason => reason.params?.variantId === variant.id)) addReason({ code: 'condition_unsatisfied', params: { variantId: variant.id } });
    }
    // Hypothetical explanations share the total budget and never become offers.
    if (explain && candidates.length === 0) {
      const targets = new Set<string>();
      for (const reason of reasons) {
        step();
        if (reason.code === 'capacity_exceeded' && typeof reason.params?.variantId === 'string' && typeof reason.params.conflictingRequirementIds === 'string') {
          for (const requirementId of reason.params.conflictingRequirementIds.split('|').filter(Boolean)) { step(); targets.add(canonicalJson([reason.params.variantId, requirementId])); }
        }
      }
      for (const target of targets) {
        step();
        const [variantId, requirementId] = JSON.parse(target) as [string, string];
        const variant = work(() => input.recipe.variants.find(variant => variant.id === variantId));
        const requirement = work(() => variant?.requirements.find(requirement => requirement.id === requirementId));
        if (!variant || !requirement) continue;
        const hypothetical = work(() => hypotheticalPublisher(input, requirement));
        const remainingBudget = budget.maxNodes - nodesVisited;
        const remainingTime = budget.maxMilliseconds === undefined ? undefined : budget.maxMilliseconds - (Date.now() - start);
        if (remainingBudget <= 0 || (remainingTime !== undefined && remainingTime <= 0)) throw stopped;
        const result = solveInternal({ ...input, recipe: { ...input.recipe, variants: [variant] }, publishers: [...input.publishers, hypothetical] }, pins,
          { maxNodes: Math.min(remainingBudget, 2000), maxCandidates: 1, ...(remainingTime === undefined ? {} : { maxMilliseconds: remainingTime }) }, false);
        nodesVisited += result.nodesVisited;
        checkpoint();
        if (result.exhausted) throw stopped;
        if (result.candidates.length > 0) addReason({ code: 'shortage', requirementId, params: {
          variantId, missing: 1, unit: requirement.unit, additionalHelpSufficient: true,
          requirementTitle: requirement.title,
        } });
      }
    }
    checkpoint();
  } catch (error) {
    if (error !== stopped) throw error;
    exhausted = true;
  }
  if (exhausted) {
    // The truncation reason must remain visible even with 128 distinct failures.
    if (reasons.length === 128) reasonKeys.delete(canonicalJson(reasons.pop()!));
    addReason({ code: 'search_exhausted', params: { maxNodes: budget.maxNodes, ...(budget.maxMilliseconds === undefined ? {} : { maxMilliseconds: budget.maxMilliseconds }) } });
  }
  return {
    status: candidates.length ? 'found' : exhausted ? 'exhausted' : 'impossible', candidates,
    reasons: candidates.length && !exhausted ? [] : reasons, nodesVisited, exhausted,
    optimality: exhausted ? 'not_proven' : 'proven',
  };
}

function hypotheticalPublisher(input: SolverInput, requirement: Requirement): PublisherAggregate {
  const suffix = hashCanonical({ domain: 'partfolk/hypothetical-resource', projectRoot: input.projectRoot, requirementId: requirement.id }).slice(2);
  const rootKey: EntityKey = input.snapshot.mode === 'local' ? `local:hypothetical:${suffix}` : `0x${suffix}`;
  const actor: Actor = input.snapshot.mode === 'local' ? { kind: 'local', id: 'local-actor:hypothetical-helper' } : { kind: 'wallet', address: '0x0000000000000000000000000000000000000000' };
  const now = input.snapshot.blockTimestamp;
  const root: PublisherRoot = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'publisher_root', operationId: 'hypothetical-root', createdAt: now,
    publisher: actor, kind: requirement.kind === 'person' ? 'individual' : 'organization' };
  const resource: Resource = { id: requirement.kind === 'person' ? 'self' : 'resource', name: 'Hypothetical additional resource', kind: requirement.kind,
    unit: requirement.unit, capacity: 1, availability: [requirement.interval], capabilities: [requirement.capability] };
  const offer: Offer = { id: 'hypothetical', title: 'Hypothetical additional contribution', resourceId: resource.id, kind: resource.kind,
    unit: resource.unit, quantity: 1, capabilities: resource.capabilities, availability: resource.availability, projectScope: [input.projectRoot], conditions: [], instructions: '' };
  const book: BookState = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'book_state', operationId: 'hypothetical-book', createdAt: now,
    publisherRoot: rootKey, predecessorKeys: [], name: 'Hypothetical helper', description: '', resources: [resource], offers: [offer], decisions: [], grants: [], attestations: [], custodyHolds: [], retentionDays: 90 };
  const provenance: EntityRecord['provenance'] = { mode: input.snapshot.mode, creator: actor, owner: actor, readonly: true, permissionlessExtension: false, contentType: 'application/json',
    createdAtBlock: input.snapshot.blockNumber, expiresAtBlock: null, transactionHash: null };
  return { root: { key: rootKey, payload: root, provenance }, book: { status: 'unique', entity: {
    key: input.snapshot.mode === 'local' ? `local:hypothetical-book:${suffix}` : hashCanonical(['hypothetical-book', suffix]), payload: book, provenance,
  } }, snapshot: input.snapshot };
}
