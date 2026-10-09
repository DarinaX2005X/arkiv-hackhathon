import { hashPlan } from './canonical';
import { deriveExecution, transferStatementHash } from './execution';
import { activeSource, deriveReadiness, lastAcceptedDuty, sameActor, sameSource, sourcePlanRef, validateCurrentEntity } from './readiness';
import { deriveRequiredApprovers, independentlyValidatePlan, validateBookState } from './validation';
import type {
  Actor, Attestation, BookState, Decision, DomainReason, EntityKey, Grant, ProjectAggregate,
  ProjectState, PublisherAggregate, RecordedOutcome, SourcePlanRef,
} from './types';

export type OperationResult<T> = { ok: true; value: T } | { ok: false; reasons: DomainReason[] };
export interface PreparedBookChange { book: BookState; expectedHeads: EntityKey[] }
export interface DecisionInput { status: Decision['status']; operationId: string; now: number; validUntil?: number; reason?: string }

function failure<T>(...reasons: DomainReason[]): OperationResult<T> { return { ok: false, reasons }; }

function ownedBook(publisher: PublisherAggregate, actor: Actor): OperationResult<PreparedBookChange> {
  if (!sameActor(actor, publisher.root.payload.publisher) || !sameActor(actor, publisher.root.provenance.creator)) return failure({ code: 'foreign_author', publisherRoot: publisher.root.key });
  if (publisher.book.status !== 'unique') return failure({ code: publisher.book.status === 'conflict' ? 'conflicting_heads' : 'missing_state', publisherRoot: publisher.root.key });
  const reasons = [...validateCurrentEntity(publisher.root, publisher.snapshot, actor).reasons,
    ...validateCurrentEntity(publisher.book.entity, publisher.snapshot, actor).reasons];
  if (publisher.snapshot.completeness !== 'complete' || publisher.snapshot.freshness !== 'fresh') reasons.push({ code: 'incomplete_snapshot' });
  if (publisher.book.entity.payload.publisherRoot !== publisher.root.key) reasons.push({ code: 'projection_mismatch' });
  return reasons.length ? { ok: false, reasons } : { ok: true,
    value: { book: structuredClone(publisher.book.entity.payload), expectedHeads: [publisher.book.entity.key] } };
}

function finalizeBook(change: PreparedBookChange, operationId: string, now: number): OperationResult<PreparedBookChange> {
  if (!operationId.trim() || !Number.isSafeInteger(now) || now < 0) return failure({ code: 'invalid_input' });
  change.book.operationId = operationId;
  change.book.createdAt = now;
  change.book.predecessorKeys = [...change.expectedHeads];
  const validation = validateBookState(change.book);
  if (!validation.valid) return { ok: false, reasons: validation.reasons };
  if (new TextEncoder().encode(JSON.stringify(change.book)).byteLength > 120 * 1024) return failure({ code: 'payload_too_large' });
  return { ok: true, value: change };
}

function effectiveOwnStatements(book: BookState): Attestation[] {
  const superseded = new Set(book.attestations.map(a => a.correctsAttestationId).filter((id): id is string => Boolean(id)));
  return book.attestations.filter(a => !superseded.has(a.id));
}

/** Derive custody from effective acknowledgements, so corrections cannot release the same quantity twice. */
function reconcileReturnedCustody(project: ProjectAggregate, book: BookState): void {
  const statements = effectiveOwnStatements(book);
  const originalTime = (statement: Attestation): number => {
    let current = statement;
    const visited = new Set<string>();
    while (current.correctsAttestationId && !visited.has(current.id)) {
      visited.add(current.id);
      const prior = book.attestations.find(a => a.id === current.correctsAttestationId);
      if (!prior) break;
      current = prior;
    }
    return current.recordedAt;
  };
  const returned: { quantity: number; at: number; acknowledgement: Extract<Attestation, { kind: 'transfer_acknowledgement' }> }[] = [];
  const counted = new Set<string>();
  // These are the owner's retained assertions already admitted against the sender statement.
  // Losing another project's book must not reverse an already authored return acknowledgement.
  for (const ack of statements) {
    if (ack.kind !== 'transfer_acknowledgement' || ack.action !== 'return' || ack.projectRoot !== project.root.key
      || ack.author !== book.publisherRoot || ack.receiver !== book.publisherRoot || counted.has(ack.statementHash)) continue;
    counted.add(ack.statementHash);
    returned.push({ quantity: ack.acknowledgedQuantity, at: originalTime(ack), acknowledgement: ack });
  }
  returned.sort((a, b) => a.at - b.at || (a.acknowledgement.id < b.acknowledgement.id ? -1 : 1));
  const holds = book.custodyHolds.filter(h => h.projectRoot === project.root.key)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const hold of holds) {
    const sent = statements.find(a => a.id === hold.id && a.kind === 'transfer_report' && a.action === 'handover');
    if (sent?.kind !== 'transfer_report') continue;
    let releasedQuantity = 0;
    let lastAcknowledgement: Extract<Attestation, { kind: 'transfer_acknowledgement' }> | null = null;
    const explicitRelease = hold.status === 'released' && !hold.release?.acknowledgementId ? hold.release : undefined;
    for (const credit of returned) {
      if (credit.at < originalTime(sent) || credit.acknowledgement.resourceId !== sent.resourceId || credit.acknowledgement.giver !== sent.receiver) continue;
      if (explicitRelease && credit.at > explicitRelease.at) continue;
      const amount = Math.min(sent.quantity - releasedQuantity, credit.quantity);
      if (amount <= 0) continue;
      credit.quantity -= amount; releasedQuantity += amount; lastAcknowledgement = credit.acknowledgement;
    }
    // An explicit corrected-availability release remains released, but prior return quantities
    // still belong to this earlier handover and cannot be borrowed by a later handover.
    if (explicitRelease) continue;
    if (releasedQuantity === sent.quantity && lastAcknowledgement) {
      hold.quantity = sent.quantity;
      hold.status = 'released';
      hold.release = { at: lastAcknowledgement.recordedAt, operationId: lastAcknowledgement.operationId,
        reason: 'Owner acknowledged return', acknowledgementId: lastAcknowledgement.id };
    } else {
      hold.quantity = sent.quantity - releasedQuantity;
      hold.status = 'outstanding';
      delete hold.release;
    }
  }
}

/** Produces the complete next owner book. The repository atomically creates it and consumes expectedHeads. */
export function prepareDecision(project: ProjectAggregate, publisherRoot: EntityKey, actor: Actor, input: DecisionInput): OperationResult<PreparedBookChange> {
  if (project.state.status !== 'unique' || project.state.entity.payload.lifecycle === 'closed') return failure({ code: 'closed_project' });
  const source = activeSource(project);
  const proposal = project.proposal;
  if (!source || !proposal) return failure({ code: 'missing_activation' });
  if (proposal.key !== source.proposalKey || proposal.payload.proposalHash !== source.proposalHash
    || proposal.payload.projectRoot !== project.root.key || hashPlan(proposal.payload.plan) !== source.proposalHash) return failure({ code: 'proposal_mismatch' });
  const publisher = project.publishers.find(p => p.root.key === publisherRoot);
  if (!publisher) return failure({ code: 'missing_root', publisherRoot });
  const change = ownedBook(publisher, actor);
  if (!change.ok) return change;
  const required = deriveRequiredApprovers(proposal.payload.plan);
  if (!required.includes(publisherRoot)) return failure({ code: 'scope_mismatch', publisherRoot });
  if (!Number.isSafeInteger(input.now) || input.now < project.snapshot.blockTimestamp) return failure({ code: 'invalid_input', path: 'now' });
  const readiness = deriveReadiness(project, input.now);
  const consentCodes: DomainReason['code'][] = ['missing_decision', 'declined', 'withdrawn', 'missing_grant', 'grant_expired', 'activation_mismatch'];
  const currentReasons = readiness.reasons.filter(r => !consentCodes.includes(r.code)
    && !(r.code === 'proposal_mismatch' && r.publisherRoot !== undefined));
  // Decline and withdrawal must remain available even if offers or capacities have changed.
  const authorityCodes: DomainReason['code'][] = ['foreign_author', 'invalid_identity', 'not_readonly', 'owner_changed', 'projection_mismatch',
    'hash_mismatch', 'incomplete_snapshot', 'stale_snapshot', 'conflicting_heads', 'missing_activation', 'missing_proposal'];
  const blocked = input.status === 'accepted' ? currentReasons : currentReasons.filter(r => authorityCodes.includes(r.code));
  if (blocked.length) return { ok: false, reasons: blocked };
  if (input.status === 'accepted') {
    const validity = independentlyValidatePlan(proposal.payload.plan, project.publishers.filter(p => required.includes(p.root.key)), project.snapshot.blockTimestamp);
    if (!validity.valid) return { ok: false, reasons: validity.reasons };
    if (!Number.isSafeInteger(input.validUntil) || input.validUntil! <= project.snapshot.blockTimestamp
      || input.validUntil! < lastAcceptedDuty(proposal.payload.plan, publisherRoot)) return failure({ code: 'grant_expired', publisherRoot });
  }
  const book = change.value.book;
  const decision: Decision = { ...sourcePlanRef(source), status: input.status, decidedAt: project.snapshot.blockTimestamp, operationId: input.operationId,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) };
  book.decisions = [...book.decisions.filter(d => !(d.projectRoot === source.projectRoot && d.activationKey === source.activationKey)), decision];
  // Acceptance replaces this owner's previous project allocation exactly once. Decline/withdraw releases only this activation.
  book.grants = book.grants.filter(g => input.status === 'accepted' ? g.projectRoot !== source.projectRoot
    : !(g.projectRoot === source.projectRoot && g.activationKey === source.activationKey));
  if (input.status === 'accepted') {
    const grant: Grant = { ...sourcePlanRef(source), id: input.operationId, protocol: proposal.payload.plan.protocol,
      chainId: proposal.payload.plan.chainId, offers: structuredClone(proposal.payload.plan.offers.filter(o => o.publisherRoot === publisherRoot)),
      allocations: structuredClone(proposal.payload.plan.allocations.filter(a => a.publisherRoot === publisherRoot)),
      validUntil: input.validUntil!, acceptedAt: project.snapshot.blockTimestamp, operationId: input.operationId };
    book.grants.push(grant);
  }
  return finalizeBook(change.value, input.operationId, input.now);
}

/** Owners may release a historical hold even after the coordinator consumed its activation. */
export function prepareReleaseCommitment(publisher: PublisherAggregate, actor: Actor, source: SourcePlanRef, operationId: string, now: number): OperationResult<PreparedBookChange> {
  const change = ownedBook(publisher, actor);
  if (!change.ok) return change;
  const book = change.value.book;
  if (!book.grants.some(g => sameSource(g, source))) return failure({ code: 'missing_grant' });
  book.grants = book.grants.filter(g => !sameSource(g, source));
  book.decisions = [...book.decisions.filter(d => !(d.projectRoot === source.projectRoot && d.activationKey === source.activationKey)),
    { ...sourcePlanRef(source), status: 'withdrawn', decidedAt: publisher.snapshot.blockTimestamp, operationId }];
  return finalizeBook(change.value, operationId, now);
}

/** Explicit owner-corrected availability, retained visibly as a release record. */
export function prepareReleaseCustodyHold(publisher: PublisherAggregate, actor: Actor, holdId: string, operationId: string, now: number, reason: string): OperationResult<PreparedBookChange> {
  const change = ownedBook(publisher, actor);
  if (!change.ok) return change;
  const hold = change.value.book.custodyHolds.find(h => h.id === holdId && h.status === 'outstanding');
  if (!hold || !reason.trim()) return failure({ code: 'invalid_input' });
  hold.status = 'released';
  hold.release = { at: now, operationId, reason: reason.trim() };
  return finalizeBook(change.value, operationId, now);
}

export function prepareAttestation(project: ProjectAggregate, publisherRoot: EntityKey, actor: Actor, attestation: Attestation): OperationResult<PreparedBookChange> {
  const publisher = project.publishers.find(p => p.root.key === publisherRoot);
  if (!publisher) return failure({ code: 'missing_root', publisherRoot });
  const change = ownedBook(publisher, actor);
  if (!change.ok) return change;
  if (attestation.author !== publisherRoot || attestation.projectRoot !== project.root.key) return failure({ code: 'foreign_author', publisherRoot });
  const proposal = [project.proposal, ...project.proposalHistory].find(p => p?.key === attestation.proposalKey && p.payload.proposalHash === attestation.proposalHash);
  if (!proposal || hashPlan(proposal.payload.plan) !== attestation.proposalHash
    || !validateCurrentEntity(proposal, project.snapshot, project.root.payload.coordinator).valid) return failure({ code: 'missing_proposal' });
  const knownSource = activeSource(project);
  const sourceKnown = (knownSource && sameSource(knownSource, attestation))
    || change.value.book.decisions.some(d => sameSource(d, attestation))
    || change.value.book.attestations.some(a => sameSource(a, attestation))
    || (project.state.status === 'unique' && project.state.entity.payload.completedWork.some(w => sameSource(w.source, attestation)));
  if (!sourceKnown) return failure({ code: 'activation_mismatch' });
  const obligation = proposal.payload.plan.runbook.find(o => o.id === attestation.obligationId);
  if (!obligation || change.value.book.attestations.some(a => a.id === attestation.id)) return failure({ code: 'attestation_mismatch' });
  if (attestation.correctsAttestationId) {
    const prior = change.value.book.attestations.find(a => a.id === attestation.correctsAttestationId);
    if (!prior || prior.author !== publisherRoot || prior.kind !== attestation.kind || prior.obligationId !== attestation.obligationId
      || !sameSource(prior, attestation) || prior.recordedAt >= attestation.recordedAt
      || change.value.book.attestations.some(a => a.correctsAttestationId === prior.id)) return failure({ code: 'attestation_mismatch' });
  }
  if (attestation.kind === 'task_report') {
    if (obligation.kind !== 'task' || obligation.publisherRoot !== publisherRoot) return failure({ code: 'attestation_mismatch' });
  } else {
    if (obligation.kind === 'task' || obligation.transferId !== attestation.transferId || obligation.kind !== attestation.action
      || obligation.giver !== attestation.giver || obligation.receiver !== attestation.receiver
      || obligation.resourceId !== attestation.resourceId) return failure({ code: 'attestation_mismatch' });
    if (attestation.kind === 'transfer_report') {
      if (publisherRoot !== obligation.giver || attestation.unit !== obligation.unit || !Number.isSafeInteger(attestation.quantity)
        || attestation.quantity <= 0 || attestation.quantity > obligation.quantity
        || attestation.statementHash !== transferStatementHash(attestation)) return failure({ code: 'attestation_mismatch' });
      const previouslyReported = effectiveOwnStatements(change.value.book).filter(a => a.kind === 'transfer_report'
        && a.obligationId === attestation.obligationId && sameSource(a, attestation) && a.id !== attestation.correctsAttestationId)
        .reduce((total, a) => total + (a.kind === 'transfer_report' ? a.quantity : 0), 0);
      if (previouslyReported + attestation.quantity > obligation.quantity) return failure({ code: 'attestation_mismatch' });
      if (attestation.action === 'handover' && change.value.book.resources.some(r => r.id === attestation.resourceId && r.kind === 'equipment')) {
        // Correction replaces the authored physical claim while keeping its prior release visible.
        const priorHold = attestation.correctsAttestationId ? change.value.book.custodyHolds.find(h => h.id === attestation.correctsAttestationId) : undefined;
        if (priorHold) { priorHold.status = 'released'; priorHold.release = { at: attestation.recordedAt, operationId: attestation.operationId, reason: `Corrected by ${attestation.id}` }; }
        change.value.book.custodyHolds.push({ id: attestation.id, projectRoot: attestation.projectRoot,
          resourceId: attestation.resourceId, quantity: attestation.quantity, unit: attestation.unit,
          source: { projectRoot: attestation.projectRoot, activationKey: attestation.activationKey, proposalKey: attestation.proposalKey, proposalHash: attestation.proposalHash },
          transferId: attestation.transferId, createdAt: attestation.recordedAt, status: 'outstanding' });
      }
    } else {
      const priorAcknowledgements = effectiveOwnStatements(change.value.book).filter(a => a.kind === 'transfer_acknowledgement'
        && a.statementHash === attestation.statementHash && a.id !== attestation.correctsAttestationId);
      if (priorAcknowledgements.length) return failure({ code: 'attestation_mismatch' });
      const reports = project.publishers.flatMap(p => p.book.status === 'unique'
        && validateCurrentEntity(p.root, p.snapshot, p.root.payload.publisher).valid
        && validateCurrentEntity(p.book.entity, p.snapshot, p.root.payload.publisher).valid ? effectiveOwnStatements(p.book.entity.payload) : [])
        .filter((a): a is Extract<Attestation, { kind: 'transfer_report' }> => a.kind === 'transfer_report' && a.statementHash === attestation.statementHash);
      const report = reports[0];
      if (publisherRoot !== obligation.receiver || reports.length !== 1 || !report || !sameSource(report, attestation)
        || report.author !== obligation.giver || report.obligationId !== obligation.id || report.statementHash !== transferStatementHash(report)
        || report.giver !== obligation.giver || report.receiver !== obligation.receiver || report.resourceId !== obligation.resourceId
        || report.transferId !== obligation.transferId || report.action !== obligation.kind || report.unit !== obligation.unit
        || report.quantity > obligation.quantity || report.quantity <= 0
        || !Number.isSafeInteger(attestation.acknowledgedQuantity) || attestation.acknowledgedQuantity <= 0
        || attestation.acknowledgedQuantity > report.quantity || attestation.recordedAt < report.recordedAt) return failure({ code: 'attestation_mismatch' });
    }
  }
  change.value.book.attestations.push(structuredClone(attestation));
  if (attestation.kind !== 'task_report') reconcileReturnedCustody(project, change.value.book);
  return finalizeBook(change.value, attestation.operationId, attestation.recordedAt);
}

export function prepareCloseProject(project: ProjectAggregate, actor: Actor,
  input: { outcome: RecordedOutcome; statement: string; operationId: string; now: number },
): OperationResult<{ state: ProjectState; expectedHeads: EntityKey[]; expectedActivationHeads: EntityKey[] }> {
  if (!sameActor(actor, project.root.payload.coordinator)) return failure({ code: 'foreign_author' });
  if (project.state.status !== 'unique' || project.activation.status === 'conflict' || project.activation.status === 'unverified') return failure({ code: 'conflicting_heads' });
  const current = project.state.entity;
  const reasons = [...validateCurrentEntity(project.root, project.snapshot, actor).reasons, ...validateCurrentEntity(current, project.snapshot, actor).reasons];
  if (project.activation.status === 'unique') reasons.push(...validateCurrentEntity(project.activation.entity, project.snapshot, actor).reasons);
  if (project.snapshot.completeness !== 'complete' || project.snapshot.freshness !== 'fresh') reasons.push({ code: 'incomplete_snapshot' });
  if (reasons.length) return { ok: false, reasons };
  if (current.payload.lifecycle === 'closed') return failure({ code: 'closed_project' });
  if (!Number.isSafeInteger(input.now) || input.now < project.snapshot.blockTimestamp || !input.operationId.trim()) return failure({ code: 'invalid_input' });
  const execution = deriveExecution(project);
  if (input.outcome === 'completed' && (execution.outstandingObligationIds.length || execution.outstandingCustodyHolds.length
    || execution.evidenceAvailability !== 'available' || execution.reasons.length || !activeSource(project))) return failure({ code: 'custody_outstanding' }, ...execution.reasons);
  const state: ProjectState = { ...structuredClone(current.payload), predecessorKeys: [current.key],
    operationId: input.operationId, createdAt: input.now, lifecycle: 'closed', completedWork: execution.completed,
    completion: { outcome: input.outcome, recordedAt: input.now, statement: input.statement,
      completedWork: execution.completed, outstandingObligationIds: execution.outstandingObligationIds,
      outstandingCustodyHoldIds: execution.outstandingCustodyHolds.map(h => h.id), source: activeSource(project) } };
  return { ok: true, value: { state, expectedHeads: [current.key],
    expectedActivationHeads: project.activation.status === 'unique' ? [project.activation.entity.key] : [] } };
}
