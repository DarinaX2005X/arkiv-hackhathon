import { canonicalJson, hashPlan, hashRequirements } from './canonical';
import { deriveRequiredApprovers, independentlyValidatePlan, validateBookState, validateEntityPayload } from './validation';
import { completedWorkContext } from './execution';
import type {
  Actor, AgreementHealth, DomainReason, EntityKey, EntityPayload, EntityRecord,
  Grant, PlanDocument, ProjectAggregate, Readiness, Snapshot, SourcePlanRef, ValidationResult,
} from './types';

export function sameActor(left: Actor | undefined, right: Actor | undefined): boolean {
  if (!left || !right || !['wallet', 'local'].includes(left.kind) || !['wallet', 'local'].includes(right.kind)) return false;
  return left.kind === right.kind && (left.kind === 'local'
    ? left.id === (right as Extract<Actor, { kind: 'local' }>).id
    : typeof left.address === 'string' && typeof (right as Extract<Actor, { kind: 'wallet' }>).address === 'string'
      && left.address.toLowerCase() === (right as Extract<Actor, { kind: 'wallet' }>).address.toLowerCase());
}

export function sameSource(left: SourcePlanRef, right: SourcePlanRef): boolean {
  return left.projectRoot === right.projectRoot && left.activationKey === right.activationKey
    && left.proposalKey === right.proposalKey && left.proposalHash === right.proposalHash;
}

/** Structural callers may pass a Grant/Decision; persist only the exact source-reference fields. */
export function sourcePlanRef(source: SourcePlanRef): SourcePlanRef {
  return { projectRoot: source.projectRoot, activationKey: source.activationKey,
    proposalKey: source.proposalKey, proposalHash: source.proposalHash };
}

/** Current point-in-time liveness only. Never converts block height into a UTC deadline. */
export function validateCurrentEntity(record: EntityRecord<EntityPayload>, snapshot: Snapshot, authority?: Actor): ValidationResult {
  const reasons: DomainReason[] = [];
  const p = record.provenance;
  if (!p.readonly || p.permissionlessExtension) reasons.push({ code: 'not_readonly' });
  if (!sameActor(p.creator, p.owner)) reasons.push({ code: 'owner_changed' });
  if (authority && !sameActor(p.creator, authority)) reasons.push({ code: 'foreign_author' });
  if (p.contentType !== 'application/json' || p.mode !== snapshot.mode) reasons.push({ code: 'invalid_schema' });
  if ((snapshot.mode === 'local') !== record.key.startsWith('local:')
    || (snapshot.mode === 'local') !== (p.creator.kind === 'local')) reasons.push({ code: 'invalid_identity' });
  if (snapshot.mode === 'public') {
    try {
      if (snapshot.blockNumber === null || p.createdAtBlock === null || p.expiresAtBlock === null) {
        reasons.push({ code: 'incomplete_snapshot' });
      } else if (BigInt(p.createdAtBlock) > BigInt(snapshot.blockNumber)
        || BigInt(p.expiresAtBlock) <= BigInt(snapshot.blockNumber)) reasons.push({ code: 'expired' });
    } catch { reasons.push({ code: 'invalid_schema' }); }
  }
  const payload = validateEntityPayload(record.payload);
  reasons.push(...payload.reasons);
  return { valid: reasons.length === 0, reasons };
}

export function lastAcceptedDuty(plan: PlanDocument, publisherRoot: EntityKey): number {
  return Math.max(0, ...plan.allocations.filter(a => a.publisherRoot === publisherRoot).map(a => a.interval.end),
    ...plan.runbook.filter(o => o.publisherRoot === publisherRoot
      || (o.kind !== 'task' && (o.giver === publisherRoot || o.receiver === publisherRoot))).map(o => o.interval.end));
}

function stableSet<T>(values: T[]): string {
  return canonicalJson(values.map(value => canonicalJson(value)).sort());
}

export function validateExactGrant(grant: Grant, plan: PlanDocument, source: SourcePlanRef, publisherRoot: EntityKey, now: number): DomainReason[] {
  const reasons: DomainReason[] = [];
  if (!sameSource(grant, source)) reasons.push({ code: 'activation_mismatch', publisherRoot });
  if (grant.protocol !== plan.protocol || grant.chainId !== plan.chainId) reasons.push({ code: 'invalid_schema', publisherRoot });
  if (!Number.isSafeInteger(grant.validUntil) || grant.validUntil <= now
    || grant.validUntil < lastAcceptedDuty(plan, publisherRoot)) reasons.push({ code: 'grant_expired', publisherRoot });
  if (!Number.isSafeInteger(grant.acceptedAt) || grant.acceptedAt > now) reasons.push({ code: 'invalid_input', publisherRoot });
  if (stableSet(grant.allocations) !== stableSet(plan.allocations.filter(a => a.publisherRoot === publisherRoot))
    || stableSet(grant.offers) !== stableSet(plan.offers.filter(o => o.publisherRoot === publisherRoot))) {
    reasons.push({ code: 'proposal_mismatch', publisherRoot });
  }
  return reasons;
}

export function activeSource(project: ProjectAggregate): SourcePlanRef | null {
  if (project.activation.status !== 'unique') return null;
  const activation = project.activation.entity;
  return { projectRoot: project.root.key, activationKey: activation.key,
    proposalKey: activation.payload.proposalKey, proposalHash: activation.payload.proposalHash };
}

/** Editable project recipe is a draft. Only the active immutable proposal carries current agreement. */
export function deriveDraftStatus(project: ProjectAggregate): { changed: boolean; changedFields: string[] } {
  if (project.state.status !== 'unique' || !project.proposal || !activeSource(project)) return { changed: false, changedFields: [] };
  const recipe = project.state.entity.payload.recipe;
  const plan = project.proposal.payload.plan;
  const selected = recipe.variants.find(v => v.id === plan.variant.id);
  const changedFields: string[] = [];
  if (canonicalJson(recipe.outcome) !== canonicalJson(plan.outcome)) changedFields.push('outcome');
  if (canonicalJson(recipe.instructions) !== canonicalJson(plan.instructions)) changedFields.push('instructions');
  if (!selected) changedFields.push('variant');
  else for (const field of ['title', 'venueId', 'timeZone', 'requirements', 'instructions'] as const) {
    try {
      const changed = field === 'requirements'
        ? hashRequirements(plan.projectRoot, selected.requirements) !== hashRequirements(plan.projectRoot, plan.variant.requirements)
        : canonicalJson(selected[field]) !== canonicalJson(plan.variant[field]);
      if (changed) changedFields.push(`variant.${field}`);
    } catch { changedFields.push(`variant.${field}`); }
  }
  return { changed: changedFields.length > 0, changedFields };
}

const uncertain = new Set<DomainReason['code']>([
  'invalid_schema', 'invalid_identity', 'foreign_author', 'projection_mismatch', 'hash_mismatch',
  'not_readonly', 'owner_changed', 'missing_root', 'incomplete_snapshot', 'stale_snapshot',
  'rpc_error', 'page_budget', 'cursor_error', 'not_initialized', 'evidence_unavailable',
]);

function health(reasons: DomainReason[], fallback: AgreementHealth): AgreementHealth {
  if (reasons.some(r => r.code === 'conflicting_heads' || r.code === 'contradictory_decision')) return 'conflict';
  if (reasons.some(r => uncertain.has(r.code))) return 'unverified';
  if (reasons.some(r => !['missing_decision', 'declined'].includes(r.code))) return 'changed';
  if (reasons.some(r => r.code === 'declined')) return 'declined';
  if (reasons.some(r => r.code === 'missing_decision')) return 'awaiting_approval';
  return fallback;
}

/** Uses the pinned block timestamp for all consent checks; now is only a cache-age check. */
export function deriveReadiness(project: ProjectAggregate, now = Date.now()): Readiness {
  const snapshot = project.snapshot;
  const reasons: DomainReason[] = [...snapshot.reasons];
  const state = project.state.status === 'unique' ? project.state.entity.payload : null;
  const result: Readiness = { status: 'unverified', lifecycle: state?.lifecycle ?? 'planning',
    outcome: state?.lifecycle === 'closed' ? state.completion?.outcome ?? null : null,
    evidenceAvailability: project.proposalHistoryStatus?.complete === false ? 'partial' : 'available', reasons,
    requiredApprovers: [], acceptedApprovers: [], snapshot, source: activeSource(project) };
  if (snapshot.completeness !== 'complete') reasons.push({ code: 'incomplete_snapshot' });
  if (snapshot.freshness !== 'fresh' || now - snapshot.fetchedAt > 60_000 || now < snapshot.fetchedAt) reasons.push({ code: 'stale_snapshot' });
  const rootValidation = validateCurrentEntity(project.root, snapshot, project.root.payload.coordinator);
  reasons.push(...rootValidation.reasons);
  if (!rootValidation.valid) { result.evidenceAvailability = 'partial'; return result; }
  if (project.state.status === 'conflict') reasons.push({ code: 'conflicting_heads', path: 'state' });
  else if (project.state.status === 'unverified') reasons.push({ code: 'incomplete_snapshot' }, ...project.state.reasons);
  else if (project.state.status === 'missing') reasons.push({ code: project.state.reason === 'not_initialized' ? 'not_initialized' : 'missing_state' });
  else {
    const stateValidation = validateCurrentEntity(project.state.entity, snapshot, project.root.payload.coordinator);
    reasons.push(...stateValidation.reasons);
    if (!stateValidation.valid) { result.evidenceAvailability = 'partial'; return result; }
    if (state?.projectRoot !== project.root.key) reasons.push({ code: 'projection_mismatch', path: 'state.projectRoot' });
  }
  // A closed record has historical outcomes, not a current agreement. Missing activation is expected.
  if (state?.lifecycle === 'closed') {
    result.source = state.completion?.source ?? null;
    if (project.activation.status === 'unique' || project.activation.status === 'conflict') reasons.push({ code: 'conflicting_heads', path: 'activation' });
    if (project.activation.status === 'unverified') reasons.push({ code: 'incomplete_snapshot' }, ...project.activation.reasons);
    reasons.push({ code: 'closed_project' });
    const history = state.completion?.completedWork ?? state.completedWork;
    const available = history.filter(work => {
      const sourceAvailable = project.proposalHistory.some(p => p.key === work.source.proposalKey && p.payload.proposalHash === work.source.proposalHash);
      const statementsAvailable = work.attestationIds.every(id => project.publishers.some(p => p.book.status === 'unique'
        && p.book.entity.payload.attestations.some(a => a.id === id && sameSource(a, work.source))));
      return sourceAvailable && statementsAvailable;
    }).length;
    result.evidenceAvailability = history.length === 0 || available === history.length
      ? project.proposalHistoryStatus?.complete === false ? 'partial' : 'available' : available === 0 ? 'unavailable' : 'partial';
    result.status = health(reasons, 'changed');
    return result;
  }
  if (state?.lifecycle === 'planning' && !state.completion && project.proposalHistory.length === 0
    && !project.proposal && project.activation.status === 'missing' && project.activation.reason === 'not_initialized') {
    result.status = health(reasons, 'possible');
    return result;
  }
  if (project.activation.status === 'conflict') reasons.push({ code: 'conflicting_heads', path: 'activation' });
  else if (project.activation.status === 'unverified') reasons.push({ code: 'incomplete_snapshot' }, ...project.activation.reasons);
  else if (project.activation.status === 'missing') reasons.push({ code: 'missing_activation' });
  else {
    reasons.push(...validateCurrentEntity(project.activation.entity, snapshot, project.root.payload.coordinator).reasons);
    if (project.activation.entity.payload.projectRoot !== project.root.key) reasons.push({ code: 'projection_mismatch', path: 'activation.projectRoot' });
  }
  const proposal = project.proposal;
  if (!proposal) reasons.push({ code: 'missing_proposal' });
  if (!proposal || !result.source || !state) { result.status = health(reasons, 'possible'); return result; }
  const proposalValidation = validateCurrentEntity(proposal, snapshot, project.root.payload.coordinator);
  reasons.push(...proposalValidation.reasons);
  if (!proposalValidation.valid) { result.evidenceAvailability = 'partial'; return result; }
  if (proposal.key !== result.source.proposalKey || proposal.payload.proposalHash !== result.source.proposalHash
    || proposal.payload.projectRoot !== project.root.key || proposal.payload.plan.projectRoot !== project.root.key) reasons.push({ code: 'proposal_mismatch' });
  const plan = proposal.payload.plan;
  try { if (hashPlan(plan) !== proposal.payload.proposalHash) reasons.push({ code: 'hash_mismatch' }); }
  catch { reasons.push({ code: 'invalid_schema' }); }
  if (plan.chainId !== snapshot.chainId) reasons.push({ code: 'invalid_identity', path: 'chainId' });
  result.requiredApprovers = deriveRequiredApprovers(plan);
  const required = new Set(result.requiredApprovers);
  for (const publisherRoot of required) {
    if (!state.publisherRoots.includes(publisherRoot)) reasons.push({ code: 'scope_mismatch', publisherRoot });
    const matches = project.publishers.filter(p => p.root.key === publisherRoot);
    if (matches.length > 1) { reasons.push({ code: 'conflicting_heads', publisherRoot }); continue; }
    const publisher = matches[0];
    if (!publisher) { reasons.push({ code: 'missing_root', publisherRoot }); continue; }
    if (publisher.snapshot.completeness !== 'complete' || publisher.snapshot.blockNumber !== snapshot.blockNumber
      || publisher.snapshot.blockHash !== snapshot.blockHash || publisher.snapshot.blockTimestamp !== snapshot.blockTimestamp
      || publisher.snapshot.mode !== snapshot.mode || publisher.snapshot.chainId !== snapshot.chainId) reasons.push({ code: 'incomplete_snapshot', publisherRoot });
    if (publisher.snapshot.freshness !== 'fresh') reasons.push({ code: 'stale_snapshot', publisherRoot });
    reasons.push(...publisher.snapshot.reasons.map(r => ({ ...r, publisherRoot })));
    const publisherValidation = validateCurrentEntity(publisher.root, snapshot, publisher.root.payload.publisher);
    reasons.push(...publisherValidation.reasons.map(r => ({ ...r, publisherRoot })));
    if (!publisherValidation.valid) continue;
    if (publisher.book.status === 'conflict') { reasons.push({ code: 'conflicting_heads', publisherRoot }); continue; }
    if (publisher.book.status === 'unverified') { reasons.push({ code: 'incomplete_snapshot', publisherRoot }, ...publisher.book.reasons); continue; }
    if (publisher.book.status === 'missing') { reasons.push({ code: 'missing_state', publisherRoot }); continue; }
    const bookValidation = validateCurrentEntity(publisher.book.entity, snapshot, publisher.root.payload.publisher);
    reasons.push(...bookValidation.reasons.map(r => ({ ...r, publisherRoot })));
    if (!bookValidation.valid) continue;
    const book = publisher.book.entity.payload;
    reasons.push(...validateBookState(book).reasons.map(r => ({ ...r, publisherRoot })));
    if (book.publisherRoot !== publisherRoot) reasons.push({ code: 'projection_mismatch', publisherRoot });
    const decisions = book.decisions.filter(d => d.projectRoot === project.root.key && d.activationKey === result.source!.activationKey);
    const grants = book.grants.filter(g => g.projectRoot === project.root.key && g.activationKey === result.source!.activationKey);
    if (decisions.length > 1 || grants.length > 1) { reasons.push({ code: 'contradictory_decision', publisherRoot }); continue; }
    const decision = decisions[0];
    if (!decision) { reasons.push({ code: grants.length ? 'contradictory_decision' : 'missing_decision', publisherRoot }); continue; }
    if (!sameSource(decision, result.source) || decision.decidedAt > snapshot.blockTimestamp) { reasons.push({ code: 'proposal_mismatch', publisherRoot }); continue; }
    if (decision.status !== 'accepted') {
      reasons.push({ code: decision.status, publisherRoot, ...(decision.reason ? { params: { reason: decision.reason } } : {}) });
      if (grants.length) reasons.push({ code: 'contradictory_decision', publisherRoot });
      continue;
    }
    const grant = grants[0];
    if (!grant) { reasons.push({ code: 'missing_grant', publisherRoot }); continue; }
    const grantReasons = validateExactGrant(grant, plan, result.source, publisherRoot, snapshot.blockTimestamp);
    if (grant.operationId !== decision.operationId || grant.acceptedAt !== decision.decidedAt) grantReasons.push({ code: 'contradictory_decision', publisherRoot });
    reasons.push(...grantReasons);
    if (!grantReasons.length) result.acceptedApprovers.push(publisherRoot);
  }
  reasons.push(...independentlyValidatePlan(plan, project.publishers.filter(p => required.has(p.root.key)), snapshot.blockTimestamp, [], completedWorkContext(project)).reasons);
  result.status = health(reasons, 'ready');
  if (result.status === 'unverified') result.evidenceAvailability = 'partial';
  return result;
}
