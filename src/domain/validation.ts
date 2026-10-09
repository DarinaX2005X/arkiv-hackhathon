import { canonicalConditions, canonicalJson, compareText, hashOffer, hashPlan, hashRequirements, offerIdentity, resourceIdentity } from './canonical';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from './types';
import type {
  Allocation, BookState, Condition, DomainReason, EntityKey, EntityPayload, Interval,
  ContentHash, Offer, PlanDocument, ProjectRecipe, PublisherAggregate, Requirement, Resource,
  Snapshot, SolverInput, SolverPin, ValidationResult,
} from './types';

export const MAX_PAYLOAD_BYTES = 120 * 1024;
export const MAX_QUANTITY = 1_000_000;
type Check = (value: unknown, path: string, reasons: DomainReason[]) => void;
type Shape = Record<string, Check>;
const problem = (reasons: DomainReason[], path: string, code: DomainReason['code'] = 'invalid_schema'): void => { reasons.push({ code, path }); };
const string = (max = 10000, min = 0): Check => (value, path, reasons) => {
  if (typeof value !== 'string' || value.length < min || value.length > max) problem(reasons, path);
};
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Check => (value, path, reasons) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) problem(reasons, path);
};
const literal = (...allowed: readonly unknown[]): Check => (value, path, reasons) => { if (!allowed.includes(value)) problem(reasons, path); };
const optional = (check: Check): Check => (value, path, reasons) => { if (value !== undefined) check(value, path, reasons); };
const nullable = (check: Check): Check => (value, path, reasons) => { if (value !== null) check(value, path, reasons); };
const list = (check: Check, max = 1024): Check => (value, path, reasons) => {
  if (!Array.isArray(value) || value.length > max) return problem(reasons, path);
  value.forEach((entry, index) => check(entry, `${path}[${index}]`, reasons));
};
const object = (shape: Shape): Check => (value, path, reasons) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return problem(reasons, path);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!Object.hasOwn(shape, key)) problem(reasons, `${path}.${key}`);
  for (const [key, check] of Object.entries(shape)) check(record[key], `${path}.${key}`, reasons);
};
const choose = (field: string, variants: Record<string, Check>): Check => (value, path, reasons) => {
  if (!value || typeof value !== 'object') return problem(reasons, path);
  const discriminator = (value as Record<string, unknown>)[field];
  if (typeof discriminator !== 'string' || !Object.hasOwn(variants, discriminator)) return problem(reasons, `${path}.${field}`);
  variants[discriminator]!(value, path, reasons);
};
const id: Check = (value, path, reasons) => {
  string(128, 1)(value, path, reasons);
  if (typeof value === 'string' && value !== value.replace(/\r\n/g, '\n').normalize('NFC')) problem(reasons, path, 'invalid_identity');
};
const label = string(200, 1);
const time = integer();
const quantity = integer(1, MAX_QUANTITY);
const key: Check = (value, path, reasons) => {
  if (typeof value !== 'string' || !(/^0x[0-9a-f]{64}$/.test(value) || /^local:[a-zA-Z0-9._:-]{1,150}$/.test(value))) problem(reasons, path, 'invalid_identity');
};
const hash: Check = (value, path, reasons) => { if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) problem(reasons, path, 'invalid_identity'); };
const interval: Check = (value, path, reasons) => {
  object({ start: time, end: time })(value, path, reasons);
  if (value && typeof value === 'object' && 'start' in value && 'end' in value) {
    const item = value as Interval;
    if (!(item.start < item.end)) problem(reasons, path, 'invalid_input');
  }
};
const zone: Check = (value, path, reasons) => {
  string(100, 1)(value, path, reasons);
  if (typeof value === 'string') try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { problem(reasons, path, 'invalid_input'); }
};
const actor = choose('kind', {
  local: object({ kind: literal('local'), id: (value, path, reasons) => {
    if (typeof value !== 'string' || !/^local-actor:[a-zA-Z0-9._:-]{1,100}$/.test(value)) problem(reasons, path, 'invalid_identity');
  } }),
  wallet: object({ kind: literal('wallet'), address: (value, path, reasons) => {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) problem(reasons, path, 'invalid_identity');
  } }),
});
const offerRef = { publisherRoot: key, offerId: id };
const selectedOffer = object({ ...offerRef, offerHash: hash });
const condition = choose('kind', {
  requires_offer: object({ kind: literal('requires_offer'), offer: object(offerRef) }),
  excludes_offer: object({ kind: literal('excludes_offer'), offer: object(offerRef) }),
  requires_capability: object({ kind: literal('requires_capability'), capability: id }),
  allowed_variants: object({ kind: literal('allowed_variants'), variantIds: list(id, 64) }),
  allowed_venues: object({ kind: literal('allowed_venues'), venueIds: list(id, 64) }),
});
const resource = object({ id, name: label, kind: literal('person', 'place', 'equipment'), unit: id,
  capacity: quantity, availability: list(interval, 256), capabilities: list(id, 128) });
const offer = object({ id, title: label, resourceId: id, kind: literal('person', 'place', 'equipment'), unit: id,
  quantity, capabilities: list(id, 128), availability: list(interval, 256), projectScope: list(key, 256),
  conditions: list(condition, 128), instructions: string() });
const requirement = object({ id, title: label, kind: literal('person', 'place', 'equipment'), capability: id, unit: id,
  quantity, interval, instructions: string(), dependsOn: list(id, 128) });
const variant = object({ id, title: label, venueId: id, timeZone: zone, requirements: list(requirement, 128), instructions: string() });
const recipe = object({ title: label, outcome: label, timeZone: zone, variants: list(variant, 64), instructions: string(), sourceProjectRoot: optional(key) });
const source = { projectRoot: key, activationKey: key, proposalKey: key, proposalHash: hash };
const completed = object({ obligationId: id, source: object(source), attestationIds: list(id), recordedAt: time,
  evidenceAvailability: literal('available', 'partial', 'unavailable') });
const completion = object({ outcome: literal('completed', 'completed_with_outstanding', 'cancelled'), recordedAt: time,
  statement: string(), completedWork: list(completed), outstandingObligationIds: list(id), outstandingCustodyHoldIds: list(id), source: nullable(object(source)) });
const allocation = object({ id, requirementId: id, publisherRoot: key, offerId: id, offerHash: hash,
  resourceId: id, quantity, unit: id, interval });
const taskShape = { id, title: label, publisherRoot: key, interval, allocationIds: list(id), dependsOn: list(id), instructions: string() };
const transferShape = { ...taskShape, transferId: id, resourceId: id, quantity, unit: id, giver: key, receiver: key };
const obligation = choose('kind', {
  task: object({ ...taskShape, kind: literal('task') }),
  handover: object({ ...transferShape, kind: literal('handover') }),
  return: object({ ...transferShape, kind: literal('return') }),
});
const plan = object({ protocol: literal(PROTOCOL), validationVersion: literal(1), chainId: literal(TIRAMISU_CHAIN_ID, null),
  projectRoot: key, outcome: label, variant, offers: list(selectedOffer),
  resourceAssumptions: list(object({ publisherRoot: key, resourceId: id, capacity: quantity, unit: id })),
  allocations: list(allocation), requiredApprovers: list(key), conditions: list(condition), instructions: string(),
  runbook: list(obligation), predecessor: nullable(object(source)) });
const decision = object({ ...source, status: literal('accepted', 'declined', 'withdrawn'), reason: optional(string()), decidedAt: time, operationId: id });
const grant = object({ ...source, id, protocol: literal(PROTOCOL), chainId: literal(TIRAMISU_CHAIN_ID, null),
  offers: list(selectedOffer), allocations: list(allocation), validUntil: time, acceptedAt: time, operationId: id });
const attestationBase = { ...source, id, obligationId: id, author: key, recordedAt: time, operationId: id, correctsAttestationId: optional(id) };
const attestation = choose('kind', {
  task_report: object({ ...attestationBase, kind: literal('task_report'), status: literal('done', 'not_done'), note: string() }),
  transfer_report: object({ ...attestationBase, kind: literal('transfer_report'), transferId: id, action: literal('handover', 'return'),
    resourceId: id, quantity, unit: id, giver: key, receiver: key, statementHash: hash }),
  transfer_acknowledgement: object({ ...attestationBase, kind: literal('transfer_acknowledgement'), transferId: id, statementHash: hash,
    acknowledgedQuantity: quantity, giver: key, receiver: key, resourceId: id, action: literal('handover', 'return') }),
});
const custody = object({ id, projectRoot: key, resourceId: id, quantity, unit: id, source: object(source), transferId: id, createdAt: time,
  status: literal('outstanding', 'released'), release: optional(object({ at: time, operationId: id, reason: string(), acknowledgementId: optional(id) })) });
const base = { protocol: literal(PROTOCOL), schemaVersion: literal(1), operationId: id, createdAt: time };
const book = object({ ...base, entityType: literal('book_state'), publisherRoot: key, predecessorKeys: list(key), name: label, description: string(),
  resources: list(resource, 128), offers: list(offer, 512), decisions: list(decision), grants: list(grant, 256),
  attestations: list(attestation, 2048), custodyHolds: list(custody), retentionDays: integer(90, 36500) });
const payload = choose('entityType', {
  project_root: object({ ...base, entityType: literal('project_root'), coordinator: actor }),
  publisher_root: object({ ...base, entityType: literal('publisher_root'), publisher: actor, kind: literal('individual', 'organization') }),
  project_state: object({ ...base, entityType: literal('project_state'), projectRoot: key, predecessorKeys: list(key), recipe,
    publisherRoots: list(key, 256), lifecycle: literal('planning', 'in_progress', 'closed'), completedWork: list(completed), completion: nullable(completion) }),
  book_state: book,
  proposal: object({ ...base, entityType: literal('proposal'), projectRoot: key, requirementsHash: hash, proposalHash: hash, plan, changeExplanation: string() }),
  plan_activation: object({ ...base, entityType: literal('plan_activation'), projectRoot: key, proposalKey: key, proposalHash: hash,
    predecessorActivationKeys: list(key) }),
  project_link: choose('linkKind', {
    offer: object({ ...base, entityType: literal('project_link'), linkKind: literal('offer'), projectRoot: key, publisherRoot: key, offerIds: list(id, 512) }),
    request: object({ ...base, entityType: literal('project_link'), linkKind: literal('request'), ...source, publisherRoot: key }),
  }),
});

function checked(value: unknown, check: Check): ValidationResult {
  const reasons: DomainReason[] = [];
  try {
    const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (bytes > MAX_PAYLOAD_BYTES) reasons.push({ code: 'payload_too_large', params: { bytes, maximumBytes: MAX_PAYLOAD_BYTES } });
    check(value, '$', reasons);
  } catch { reasons.push({ code: 'invalid_schema', path: '$' }); }
  return { valid: reasons.length === 0, reasons };
}

function unique<T>(items: readonly T[], identity: (item: T) => string, reasons: DomainReason[], path: string, code: DomainReason['code'] = 'invalid_input'): void {
  const seen = new Set<string>();
  for (const item of items) { const value = identity(item); if (seen.has(value)) problem(reasons, path, code); seen.add(value); }
}
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const sourceKey = (value: { projectRoot: EntityKey; activationKey: EntityKey }): string => canonicalJson([value.projectRoot, value.activationKey]);
const keyFields = new Set(['projectRoot', 'publisherRoot', 'activationKey', 'proposalKey', 'giver', 'receiver', 'sourceProjectRoot']);
const keyListFields = new Set(['publisherRoots', 'requiredApprovers', 'predecessorKeys', 'predecessorActivationKeys', 'projectScope']);
function checkKeyMode(value: unknown, local: boolean, reasons: DomainReason[], path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((entry, index) => checkKeyMode(entry, local, reasons, `${path}[${index}]`)); return; }
  for (const [field, entry] of Object.entries(value)) {
    if (keyFields.has(field) && typeof entry === 'string' && entry.startsWith('local:') !== local) problem(reasons, `${path}.${field}`, 'invalid_identity');
    if (keyListFields.has(field) && Array.isArray(entry) && entry.some(key => typeof key === 'string' && key.startsWith('local:') !== local)) problem(reasons, `${path}.${field}`, 'invalid_identity');
    checkKeyMode(entry, local, reasons, `${path}.${field}`);
  }
}

function validateRequirements(requirements: Requirement[], reasons: DomainReason[], path: string, checkTiming = false): void {
  unique(requirements, item => item.id, reasons, path);
  const byId = new Map(requirements.map(item => [item.id, item]));
  for (const requirement of requirements) {
    unique(requirement.dependsOn, item => item, reasons, `${path}.${requirement.id}.dependsOn`);
    for (const dependency of requirement.dependsOn) {
      const prior = byId.get(dependency);
      if (!prior || (checkTiming && prior.interval.end > requirement.interval.start)) reasons.push({ code: 'dependency_unsatisfied', requirementId: requirement.id, params: { dependency } });
    }
  }
}

export function validateRecipe(value: unknown): ValidationResult {
  const result = checked(value, recipe);
  if (!result.valid) return result;
  const item = value as ProjectRecipe;
  unique(item.variants, entry => entry.id, result.reasons, '$.variants');
  for (const variant of item.variants) validateRequirements(variant.requirements, result.reasons, `$.variants.${variant.id}.requirements`);
  return { valid: result.reasons.length === 0, reasons: result.reasons };
}

export const validateOffer = (value: unknown): ValidationResult => checked(value, offer);

export function validateBookState(value: unknown): ValidationResult {
  const result = checked(value, book);
  if (!result.valid) return result;
  const item = value as BookState;
  const reasons = result.reasons;
  checkKeyMode(item, item.publisherRoot.startsWith('local:'), reasons);
  unique(item.resources, entry => entry.id, reasons, '$.resources');
  unique(item.offers, entry => entry.id, reasons, '$.offers');
  unique(item.decisions, sourceKey, reasons, '$.decisions', 'contradictory_decision');
  unique(item.grants, entry => entry.id, reasons, '$.grants');
  unique(item.attestations, entry => entry.id, reasons, '$.attestations');
  unique(item.custodyHolds, entry => entry.id, reasons, '$.custodyHolds');
  for (const entry of item.resources) {
    unique(entry.capabilities, capability => capability, reasons, `$.resources.${entry.id}.capabilities`);
    if (entry.id === 'self' && (entry.capacity !== 1 || entry.kind !== 'person')) problem(reasons, `$.resources.${entry.id}`, 'capacity_exceeded');
  }
  for (const entry of item.offers) {
    const target = item.resources.find(resource => resource.id === entry.resourceId);
    if (!target) { reasons.push({ code: 'invalid_input', offerId: entry.id, resourceId: entry.resourceId }); continue; }
    if (entry.unit !== target.unit || entry.kind !== target.kind) reasons.push({ code: 'unit_mismatch', offerId: entry.id });
    if (entry.quantity > target.capacity) reasons.push({ code: 'capacity_exceeded', offerId: entry.id, resourceId: target.id });
    if (entry.capabilities.some(capability => !target.capabilities.includes(capability))) reasons.push({ code: 'condition_unsatisfied', offerId: entry.id });
    try { hashOffer(item.publisherRoot, entry); } catch { problem(reasons, `$.offers.${entry.id}`, 'invalid_input'); }
  }
  for (const entry of item.grants) {
    if (entry.allocations.some(allocation => allocation.publisherRoot !== item.publisherRoot) || entry.offers.some(offer => offer.publisherRoot !== item.publisherRoot)) {
      reasons.push({ code: 'foreign_author', publisherRoot: item.publisherRoot });
    }
    const matching = item.decisions.find(decision => sourceKey(decision) === sourceKey(entry));
    if (!matching || matching.status !== 'accepted' || matching.proposalKey !== entry.proposalKey || matching.proposalHash !== entry.proposalHash) {
      reasons.push({ code: 'contradictory_decision', publisherRoot: item.publisherRoot });
    }
    if (entry.validUntil <= entry.acceptedAt) problem(reasons, '$.grants.validUntil', 'invalid_input');
    if ((entry.chainId === null) !== item.publisherRoot.startsWith('local:')) problem(reasons, '$.grants.chainId', 'invalid_identity');
    for (const allocation of entry.allocations) {
      const target = item.resources.find(resource => resource.id === allocation.resourceId);
      if (!target || target.unit !== allocation.unit) reasons.push({ code: 'unit_mismatch', resourceId: allocation.resourceId });
    }
  }
  for (const entry of item.attestations) {
    if (entry.author !== item.publisherRoot || (entry.kind === 'transfer_report' && entry.giver !== item.publisherRoot) || (entry.kind === 'transfer_acknowledgement' && entry.receiver !== item.publisherRoot)) {
      reasons.push({ code: 'foreign_author', publisherRoot: item.publisherRoot, obligationId: entry.obligationId });
    }
    if (entry.correctsAttestationId && !item.attestations.some(prior => prior.id === entry.correctsAttestationId && prior.author === entry.author && prior.id !== entry.id)) {
      reasons.push({ code: 'attestation_mismatch', obligationId: entry.obligationId });
    }
  }
  for (const hold of item.custodyHolds) {
    if (hold.projectRoot !== hold.source.projectRoot || (hold.status === 'released') !== Boolean(hold.release)) problem(reasons, '$.custodyHolds', 'invalid_input');
    const target = item.resources.find(resource => resource.id === hold.resourceId);
    if (!target || target.unit !== hold.unit || hold.quantity > target.capacity) reasons.push({ code: 'custody_outstanding', resourceId: hold.resourceId });
  }
  return { valid: reasons.length === 0, reasons };
}

export function deriveRequiredApprovers(plan: PlanDocument): EntityKey[] {
  const parties = new Set<EntityKey>(plan.allocations.map(entry => entry.publisherRoot));
  for (const obligation of plan.runbook) {
    parties.add(obligation.publisherRoot);
    if (obligation.kind !== 'task') { parties.add(obligation.giver); parties.add(obligation.receiver); }
  }
  return [...parties].sort();
}

export function validatePlanDocument(value: unknown): ValidationResult {
  const result = checked(value, plan);
  if (!result.valid) return result;
  const item = value as PlanDocument;
  const reasons = result.reasons;
  checkKeyMode(item, item.projectRoot.startsWith('local:'), reasons);
  if (item.variant.requirements.length === 0 || item.allocations.length === 0) problem(reasons, '$.allocations', 'invalid_input');
  if ((item.chainId === null) !== item.projectRoot.startsWith('local:')) problem(reasons, '$.chainId', 'invalid_identity');
  if (item.predecessor && item.predecessor.projectRoot !== item.projectRoot) problem(reasons, '$.predecessor.projectRoot', 'invalid_identity');
  validateRequirements(item.variant.requirements, reasons, '$.variant.requirements', true);
  unique(item.allocations, entry => entry.id, reasons, '$.allocations');
  unique(item.runbook, entry => entry.id, reasons, '$.runbook');
  unique(item.offers, offerIdentity, reasons, '$.offers');
  unique(item.resourceAssumptions, resourceIdentity, reasons, '$.resourceAssumptions');
  unique(item.requiredApprovers, entry => entry, reasons, '$.requiredApprovers');
  if (!equal([...item.requiredApprovers].sort(), deriveRequiredApprovers(item))) problem(reasons, '$.requiredApprovers', 'invalid_input');
  const taskIds = new Map(item.runbook.map(entry => [entry.id, entry]));
  for (const obligation of item.runbook) {
    unique(obligation.allocationIds, entry => entry, reasons, `$.runbook.${obligation.id}.allocationIds`);
    unique(obligation.dependsOn, entry => entry, reasons, `$.runbook.${obligation.id}.dependsOn`);
    for (const id of obligation.allocationIds) if (!item.allocations.some(entry => entry.id === id)) reasons.push({ code: 'attestation_mismatch', obligationId: obligation.id });
    if (obligation.kind === 'task' && obligation.allocationIds.some(id => item.allocations.find(entry => entry.id === id)?.publisherRoot !== obligation.publisherRoot)) {
      reasons.push({ code: 'foreign_author', publisherRoot: obligation.publisherRoot, obligationId: obligation.id });
    }
    for (const id of obligation.dependsOn) {
      const prior = taskIds.get(id);
      if (!prior || prior.interval.end > obligation.interval.start) reasons.push({ code: 'dependency_unsatisfied', obligationId: obligation.id, params: { dependency: id } });
    }
    if (obligation.kind !== 'task') {
      const owner = obligation.kind === 'handover' ? obligation.giver : obligation.receiver;
      const linked = item.allocations.filter(allocation => obligation.allocationIds.includes(allocation.id));
      const owned = linked.filter(allocation => allocation.publisherRoot === owner && allocation.resourceId === obligation.resourceId && allocation.unit === obligation.unit
        && item.variant.requirements.find(requirement => requirement.id === allocation.requirementId)?.kind === 'equipment');
      const capacity = item.resourceAssumptions.find(resource => resource.publisherRoot === owner && resource.resourceId === obligation.resourceId)?.capacity ?? 0;
      if (obligation.giver === obligation.receiver || obligation.publisherRoot !== obligation.giver || owned.length === 0 || owned.length !== linked.length
        || obligation.quantity > owned.reduce((sum, allocation) => sum + allocation.quantity, 0) || obligation.quantity > capacity) {
        problem(reasons, `$.runbook.${obligation.id}`, 'attestation_mismatch');
      }
    }
  }
  for (const allocation of item.allocations) if (!item.runbook.some(obligation => obligation.allocationIds.includes(allocation.id))) {
    problem(reasons, `$.allocations.${allocation.id}`, 'attestation_mismatch');
  }
  try { hashPlan(item); } catch { problem(reasons, '$', 'invalid_input'); }
  return { valid: reasons.length === 0, reasons };
}

export function validateEntityPayload(value: unknown): ValidationResult {
  const result = checked(value, payload);
  if (!result.valid) return result;
  const item = value as EntityPayload;
  if ('projectRoot' in item) checkKeyMode(item, item.projectRoot.startsWith('local:'), result.reasons);
  if (item.entityType === 'book_state') return validateBookState(item);
  if (item.entityType === 'project_state') {
    result.reasons.push(...validateRecipe(item.recipe).reasons);
    unique(item.publisherRoots, entry => entry, result.reasons, '$.publisherRoots');
    if (item.lifecycle === 'closed' && item.completion === null) problem(result.reasons, '$.completion', 'invalid_input');
  }
  if (item.entityType === 'proposal') {
    result.reasons.push(...validatePlanDocument(item.plan).reasons);
    if (item.projectRoot !== item.plan.projectRoot) problem(result.reasons, '$.projectRoot', 'invalid_identity');
    if (result.reasons.length === 0 && (item.proposalHash !== hashPlan(item.plan) || item.requirementsHash !== hashRequirements(item.projectRoot, item.plan.variant.requirements))) {
      result.reasons.push({ code: 'hash_mismatch' });
    }
  }
  return { valid: result.reasons.length === 0, reasons: result.reasons };
}

export const isEntityPayload = (value: unknown): value is EntityPayload => validateEntityPayload(value).valid;

/** Adjacent windows cover continuously; a one-millisecond gap does not. */
export function coversInterval(windows: readonly Interval[], target: Interval): boolean {
  let cursor = target.start;
  for (const window of [...windows].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (window.end <= cursor) continue;
    if (window.start > cursor) return false;
    cursor = Math.max(cursor, window.end);
    if (cursor >= target.end) return true;
  }
  return false;
}

export function offerFits(offer: Offer, resource: Resource, requirement: Requirement, projectRoot: EntityKey, variantId: string, venueId: string): boolean {
  return offer.kind === requirement.kind && resource.kind === requirement.kind && offer.unit === requirement.unit && resource.unit === requirement.unit
    && offer.capabilities.includes(requirement.capability) && resource.capabilities.includes(requirement.capability)
    && (offer.projectScope.length === 0 || offer.projectScope.includes(projectRoot))
    && coversInterval(offer.availability, requirement.interval) && coversInterval(resource.availability, requirement.interval)
    && offer.conditions.every(condition => condition.kind === 'allowed_variants' ? condition.variantIds.includes(variantId)
      : condition.kind === 'allowed_venues' ? condition.venueIds.includes(venueId) : true);
}

interface Load { quantity: number; interval: Interval; projectRoot: EntityKey | null }
function peakLoad(loads: readonly Load[], holds: number): number {
  const events: { at: number; delta: number }[] = [];
  for (const load of loads) events.push({ at: load.interval.start, delta: load.quantity }, { at: load.interval.end, delta: -load.quantity });
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let total = holds, peak = holds;
  for (const event of events) { total += event.delta; peak = Math.max(peak, total); }
  return peak;
}

/** Candidate allocations replace this publisher's previous project grant exactly once. */
export function capacityConflicts(allocations: readonly Allocation[], publishers: readonly PublisherAggregate[], projectRoot: EntityKey | null, now: number): DomainReason[] {
  const reasons: DomainReason[] = [];
  for (const publisher of publishers) {
    if (publisher.book.status !== 'unique') continue;
    const book = publisher.book.entity.payload;
    const own = allocations.filter(entry => entry.publisherRoot === publisher.root.key);
    if (projectRoot !== null && own.length === 0) continue;
    const foreignGrants = book.grants.filter(grant => grant.projectRoot !== projectRoot && grant.validUntil > now);
    for (const resource of book.resources) {
      const loads: Load[] = own.filter(entry => entry.resourceId === resource.id).map(entry => ({ ...entry, projectRoot }));
      for (const grant of foreignGrants) for (const allocation of grant.allocations) {
        if (allocation.resourceId === resource.id) loads.push({ ...allocation, projectRoot: grant.projectRoot });
      }
      // An outstanding assertion takes capacity even after its former consent expires.
      // When its project's grant is still active, max(grant,custody) avoids counting it twice.
      const holdsByProject = new Map<EntityKey, number>();
      for (const hold of book.custodyHolds) if (hold.status === 'outstanding' && hold.resourceId === resource.id) {
        holdsByProject.set(hold.projectRoot, (holdsByProject.get(hold.projectRoot) ?? 0) + hold.quantity);
      }
      const endpoints = [...new Set(loads.flatMap(load => [load.interval.start, load.interval.end]))].sort((a, b) => a - b);
      let peak = [...holdsByProject.values()].reduce((sum, amount) => sum + amount, 0);
      for (const at of endpoints) {
        const perProject = new Map<EntityKey | null, number>();
        for (const load of loads) if (load.interval.start <= at && at < load.interval.end) perProject.set(load.projectRoot, (perProject.get(load.projectRoot) ?? 0) + load.quantity);
        for (const [root, held] of holdsByProject) perProject.set(root, Math.max(perProject.get(root) ?? 0, held));
        peak = Math.max(peak, [...perProject.values()].reduce((sum, amount) => sum + amount, 0));
      }
      const capacity = publisher.root.payload.kind === 'individual' && resource.kind === 'person' ? 1 : resource.capacity;
      if (peak > capacity) reasons.push({ code: holdsByProject.size ? 'custody_outstanding' : 'capacity_exceeded', publisherRoot: publisher.root.key,
        resourceId: resource.id, params: { capacity, required: peak } });
    }
    for (const offer of book.offers) {
      const loads: Load[] = own.filter(entry => entry.offerId === offer.id).map(entry => ({ ...entry, projectRoot }));
      for (const grant of foreignGrants) for (const allocation of grant.allocations) if (allocation.offerId === offer.id) loads.push({ ...allocation, projectRoot: grant.projectRoot });
      if (peakLoad(loads, 0) > offer.quantity) reasons.push({ code: 'capacity_exceeded', publisherRoot: publisher.root.key, offerId: offer.id, params: { capacity: offer.quantity } });
    }
  }
  return reasons;
}

/** For owner book edits, check every project reservation and outstanding custody assertion. */
export function validateBookCapacity(publisher: PublisherAggregate, nextBook: BookState, now: number): ValidationResult {
  const validation = validateBookState(nextBook);
  if (!validation.valid) return validation;
  if (publisher.root.payload.kind === 'individual' && nextBook.resources.some(resource => resource.kind === 'person' && (resource.id !== 'self' || resource.capacity !== 1))) {
    return { valid: false, reasons: [{ code: 'capacity_exceeded', publisherRoot: publisher.root.key, resourceId: 'self' }] };
  }
  if (publisher.book.status !== 'unique') return { valid: false, reasons: [{ code: publisher.book.status === 'conflict' ? 'conflicting_heads' : 'missing_state', publisherRoot: publisher.root.key }] };
  const candidate: PublisherAggregate = { ...publisher, book: { status: 'unique', entity: { ...publisher.book.entity, payload: nextBook } } };
  const reasons = capacityConflicts([], [candidate], null, now);
  return { valid: reasons.length === 0, reasons };
}

export function checkConditions(conditions: readonly Condition[], selected: readonly { publisherRoot: EntityKey; offer: Offer }[], variantId: string, venueId: string): DomainReason[] {
  const refs = new Set(selected.map(entry => offerIdentity({ publisherRoot: entry.publisherRoot, offerId: entry.offer.id })));
  const capabilities = new Set(selected.flatMap(entry => entry.offer.capabilities));
  const reasons: DomainReason[] = [];
  for (const condition of conditions) {
    const valid = condition.kind === 'requires_offer' ? refs.has(offerIdentity(condition.offer))
      : condition.kind === 'excludes_offer' ? !refs.has(offerIdentity(condition.offer))
      : condition.kind === 'requires_capability' ? capabilities.has(condition.capability)
      : condition.kind === 'allowed_variants' ? condition.variantIds.includes(variantId)
      : condition.venueIds.includes(venueId);
    if (!valid) reasons.push({ code: 'condition_unsatisfied', params: { condition: condition.kind } });
  }
  return reasons;
}

export function independentlyValidatePlan(plan: PlanDocument, publishers: readonly PublisherAggregate[], now: number, pins: readonly SolverPin[] = []): ValidationResult {
  const shape = validatePlanDocument(plan);
  if (!shape.valid) return shape;
  const reasons: DomainReason[] = [];
  const books = new Map<EntityKey, BookState>();
  unique(publishers, entry => entry.root.key, reasons, '$.publishers');
  for (const publisher of publishers) {
    if (publisher.book.status === 'unique') {
      const result = validateBookState(publisher.book.entity.payload);
      if (!result.valid) {
        reasons.push(...result.reasons.map(reason => ({ ...reason, publisherRoot: publisher.root.key })));
        continue;
      }
      books.set(publisher.root.key, publisher.book.entity.payload);
      if (publisher.book.entity.payload.publisherRoot !== publisher.root.key) reasons.push({ code: 'invalid_identity', publisherRoot: publisher.root.key });
      if (publisher.root.payload.kind === 'individual' && publisher.book.entity.payload.resources.some(resource => resource.kind === 'person' && (resource.id !== 'self' || resource.capacity !== 1))) {
        reasons.push({ code: 'capacity_exceeded', publisherRoot: publisher.root.key, resourceId: 'self' });
      }
    } else reasons.push({ code: publisher.book.status === 'conflict' ? 'conflicting_heads' : 'missing_state', publisherRoot: publisher.root.key });
  }
  for (const publisherRoot of plan.requiredApprovers) if (!publishers.some(publisher => publisher.root.key === publisherRoot)) reasons.push({ code: 'missing_root', publisherRoot });
  const usedOffers = new Map<string, { publisherRoot: EntityKey; offer: Offer }>();
  const usedResources = new Map<string, { publisherRoot: EntityKey; resource: Resource }>();
  for (const allocation of plan.allocations) {
    const requirement = plan.variant.requirements.find(item => item.id === allocation.requirementId);
    const book = books.get(allocation.publisherRoot);
    const offer = book?.offers.find(item => item.id === allocation.offerId);
    const resource = book?.resources.find(item => item.id === allocation.resourceId);
    if (!requirement) { reasons.push({ code: 'invalid_input', requirementId: allocation.requirementId }); continue; }
    if (!offer || !resource || offer.resourceId !== allocation.resourceId) { reasons.push({ code: 'missing_offer', publisherRoot: allocation.publisherRoot, offerId: allocation.offerId }); continue; }
    if (hashOffer(allocation.publisherRoot, offer) !== allocation.offerHash) reasons.push({ code: 'offer_changed', publisherRoot: allocation.publisherRoot, offerId: offer.id });
    const correctInterval = requirement.kind === 'equipment'
      ? allocation.interval.start <= requirement.interval.start && allocation.interval.end >= requirement.interval.end
      : equal(allocation.interval, requirement.interval);
    if (!correctInterval || allocation.unit !== requirement.unit) reasons.push({ code: 'unit_mismatch', requirementId: requirement.id });
    if (!offerFits(offer, resource, requirement, plan.projectRoot, plan.variant.id, plan.variant.venueId)) {
      reasons.push({ code: coversInterval(offer.availability, requirement.interval) && coversInterval(resource.availability, requirement.interval) ? 'condition_unsatisfied' : 'outside_availability', publisherRoot: allocation.publisherRoot, offerId: offer.id, requirementId: requirement.id });
    }
    if (!coversInterval(offer.availability, allocation.interval) || !coversInterval(resource.availability, allocation.interval)) {
      reasons.push({ code: 'outside_availability', publisherRoot: allocation.publisherRoot, resourceId: allocation.resourceId, offerId: offer.id, requirementId: requirement.id });
    }
    usedOffers.set(offerIdentity(allocation), { publisherRoot: allocation.publisherRoot, offer });
    usedResources.set(resourceIdentity(allocation), { publisherRoot: allocation.publisherRoot, resource });
  }
  for (const requirement of plan.variant.requirements) {
    const amount = plan.allocations.filter(item => item.requirementId === requirement.id).reduce((sum, item) => sum + item.quantity, 0);
    if (amount !== requirement.quantity) reasons.push({ code: 'shortage', requirementId: requirement.id, params: { required: requirement.quantity, allocated: amount, missing: Math.max(0, requirement.quantity - amount) } });
  }
  for (const obligation of plan.runbook) if (obligation.kind !== 'task') {
    const owner = obligation.kind === 'handover' ? obligation.giver : obligation.receiver;
    const reservations = plan.allocations.filter(allocation => obligation.allocationIds.includes(allocation.id)
      && allocation.publisherRoot === owner && allocation.resourceId === obligation.resourceId && allocation.unit === obligation.unit);
    const covered = reservations.filter(allocation => coversInterval([allocation.interval], obligation.interval)).reduce((sum, allocation) => sum + allocation.quantity, 0);
    if (covered < obligation.quantity) reasons.push({ code: 'outside_availability', obligationId: obligation.id, publisherRoot: owner, resourceId: obligation.resourceId });
    if (obligation.kind === 'return') {
      const matchingHandover = plan.runbook.some(prior => prior.kind === 'handover' && prior.giver === obligation.receiver && prior.receiver === obligation.giver
        && prior.resourceId === obligation.resourceId && prior.unit === obligation.unit && prior.interval.end <= obligation.interval.start);
      const ownerBook = books.get(owner);
      const heldEarlier = ownerBook?.custodyHolds.some(hold => hold.projectRoot === plan.projectRoot && hold.resourceId === obligation.resourceId
        && hold.status === 'outstanding' && ownerBook.attestations.some(statement => statement.kind === 'transfer_report' && statement.action === 'handover'
          && statement.transferId === hold.transferId && statement.projectRoot === plan.projectRoot && statement.resourceId === obligation.resourceId
          && statement.giver === obligation.receiver && statement.receiver === obligation.giver));
      if (!matchingHandover && !heldEarlier) reasons.push({ code: 'attestation_mismatch', obligationId: obligation.id });
    }
  }
  const expectedOffers = [...usedOffers.values()].map(({ publisherRoot, offer }) => ({ publisherRoot, offerId: offer.id, offerHash: hashOffer(publisherRoot, offer) }));
  if (!equal([...plan.offers].sort((a, b) => compareText(offerIdentity(a), offerIdentity(b))), expectedOffers.sort((a, b) => compareText(offerIdentity(a), offerIdentity(b))))) {
    reasons.push({ code: 'offer_changed' });
  }
  const expectedResources = [...usedResources.values()].map(({ publisherRoot, resource }) => ({ publisherRoot, resourceId: resource.id, capacity: resource.capacity, unit: resource.unit }));
  if (!equal([...plan.resourceAssumptions].sort((a, b) => compareText(resourceIdentity(a), resourceIdentity(b))), expectedResources.sort((a, b) => compareText(resourceIdentity(a), resourceIdentity(b))))) {
    reasons.push({ code: 'capacity_exceeded', path: '$.resourceAssumptions' });
  }
  const conditionsByContent = new Map<string, Condition>();
  for (const { offer } of usedOffers.values()) for (const condition of canonicalConditions(offer.conditions)) conditionsByContent.set(canonicalJson(condition), condition);
  if (!equal(canonicalConditions(plan.conditions), canonicalConditions([...conditionsByContent.values()]))) reasons.push({ code: 'condition_unsatisfied', path: '$.conditions' });
  reasons.push(...checkConditions(plan.conditions, [...usedOffers.values()], plan.variant.id, plan.variant.venueId));
  reasons.push(...capacityConflicts(plan.allocations, publishers, plan.projectRoot, now));
  for (const pin of pins) {
    const amount = plan.allocations.filter(item => item.requirementId === pin.requirementId && item.publisherRoot === pin.publisherRoot && item.offerId === pin.offerId).reduce((sum, item) => sum + item.quantity, 0);
    if (pin.quantity === undefined ? amount < 1 : amount !== pin.quantity) reasons.push({ code: 'pin_conflict', requirementId: pin.requirementId, publisherRoot: pin.publisherRoot, offerId: pin.offerId });
  }
  return { valid: reasons.length === 0, reasons };
}

export type FinalizedPlanResult =
  | { ok: true; value: { plan: PlanDocument; proposalHash: ContentHash; requirementsHash: ContentHash } }
  | { ok: false; reasons: DomainReason[] };

/** Explicit transfer duties are entered by the organizer; their parties are never guessed. */
export function finalizePlan(document: PlanDocument, publishers: readonly PublisherAggregate[], snapshot: Snapshot): FinalizedPlanResult {
  const plan = structuredClone(document);
  // Reservation time includes custody in transit. Required-use and task time stay explicit.
  for (const allocation of plan.allocations) {
    const requirement = plan.variant.requirements.find(requirement => requirement.id === allocation.requirementId);
    if (requirement?.kind !== 'equipment') continue;
    const transfers = plan.runbook.filter(obligation => obligation.kind !== 'task' && obligation.allocationIds.includes(allocation.id)
      && (obligation.kind === 'handover' ? obligation.giver : obligation.receiver) === allocation.publisherRoot
      && obligation.resourceId === allocation.resourceId);
    allocation.interval = {
      start: Math.min(allocation.interval.start, requirement.interval.start, ...transfers.map(obligation => obligation.interval.start)),
      end: Math.max(allocation.interval.end, requirement.interval.end, ...transfers.map(obligation => obligation.interval.end)),
    };
  }
  plan.requiredApprovers = deriveRequiredApprovers(plan);
  const validation = independentlyValidatePlan(plan, publishers, snapshot.blockTimestamp);
  if (snapshot.completeness !== 'complete') validation.reasons.push({ code: 'incomplete_snapshot' });
  if (snapshot.freshness !== 'fresh') validation.reasons.push({ code: 'stale_snapshot' });
  if (plan.chainId !== snapshot.chainId) validation.reasons.push({ code: 'invalid_identity' });
  for (const publisher of publishers.filter(publisher => plan.requiredApprovers.includes(publisher.root.key))) {
    if (publisher.snapshot.blockNumber !== snapshot.blockNumber || publisher.snapshot.blockHash !== snapshot.blockHash || publisher.snapshot.blockTimestamp !== snapshot.blockTimestamp
      || publisher.snapshot.completeness !== 'complete' || publisher.snapshot.freshness !== 'fresh') validation.reasons.push({ code: 'incomplete_snapshot', publisherRoot: publisher.root.key });
  }
  return validation.reasons.length ? { ok: false, reasons: validation.reasons } : { ok: true, value: {
    plan, proposalHash: hashPlan(plan), requirementsHash: hashRequirements(plan.projectRoot, plan.variant.requirements),
  } };
}

export function validateSolverInput(input: SolverInput): ValidationResult {
  const result = validateRecipe(input.recipe);
  if (input.snapshot.completeness !== 'complete') result.reasons.push({ code: 'incomplete_snapshot' });
  if (input.snapshot.freshness !== 'fresh') result.reasons.push({ code: 'stale_snapshot' });
  if (!Number.isSafeInteger(input.snapshot.blockTimestamp) || input.snapshot.blockTimestamp < 0) result.reasons.push({ code: 'invalid_input', path: '$.snapshot.blockTimestamp' });
  if ((input.snapshot.mode === 'local') !== input.projectRoot.startsWith('local:') || (input.snapshot.mode === 'local') !== (input.snapshot.chainId === null)) result.reasons.push({ code: 'invalid_identity' });
  for (const publisher of input.publishers) {
    if (publisher.root.key.startsWith('local:') !== (input.snapshot.mode === 'local')) result.reasons.push({ code: 'invalid_identity', publisherRoot: publisher.root.key });
    if (publisher.book.status !== 'unique') result.reasons.push({ code: publisher.book.status === 'conflict' ? 'conflicting_heads' : 'missing_state', publisherRoot: publisher.root.key });
    else result.reasons.push(...validateBookState(publisher.book.entity.payload).reasons);
    if (publisher.snapshot.blockNumber !== input.snapshot.blockNumber || publisher.snapshot.blockHash !== input.snapshot.blockHash || publisher.snapshot.blockTimestamp !== input.snapshot.blockTimestamp
      || publisher.snapshot.completeness !== 'complete' || publisher.snapshot.freshness !== 'fresh') result.reasons.push({ code: 'incomplete_snapshot', publisherRoot: publisher.root.key });
  }
  if (input.predecessor) result.reasons.push(...validateEntityPayload(input.predecessor.payload).reasons);
  if ((input.predecessor === null) !== (input.predecessorSource === null)) result.reasons.push({ code: 'proposal_mismatch' });
  if (input.predecessor && input.predecessorSource && (input.predecessor.key !== input.predecessorSource.proposalKey || input.predecessor.payload.proposalHash !== input.predecessorSource.proposalHash || input.projectRoot !== input.predecessorSource.projectRoot)) result.reasons.push({ code: 'proposal_mismatch' });
  return { valid: result.reasons.length === 0, reasons: result.reasons };
}
