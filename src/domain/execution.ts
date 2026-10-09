import { canonicalConditions, canonicalJson, hashCanonical, hashOffer, hashPlan, normalizedPlan } from './canonical';
import { activeSource, sameSource, sourcePlanRef, validateCurrentEntity } from './readiness';
import { deriveRequiredApprovers } from './validation';
import type {
  Attestation, CompletedWork, ContentHash, DomainReason, ExecutionVerdict, PlanDifference,
  PlanDocument, ProjectAggregate, PublisherAggregate, RecipeTemplate, Snapshot, SourcePlanRef,
} from './types';

type TransferReport = Extract<Attestation, { kind: 'transfer_report' }>;

/** Hash the complete immutable authored transfer, excluding its own digest. */
export function transferStatementHash(report: Omit<TransferReport, 'statementHash'> | TransferReport): ContentHash {
  const { statementHash: _digest, ...statement } = report as TransferReport;
  return hashCanonical({ protocol: 'partfolk/1', purpose: 'transfer_statement', statement });
}

function effectiveStatements(statements: Attestation[], reasons: DomainReason[]): Attestation[] {
  const removed = new Set<string>();
  const ids = new Set<string>();
  const invalid = new Set<string>();
  for (const statement of statements) {
    if (ids.has(statement.id)) { invalid.add(statement.id); reasons.push({ code: 'attestation_mismatch', obligationId: statement.obligationId }); }
    ids.add(statement.id);
    if (!statement.correctsAttestationId) continue;
    const previous = statements.find(s => s.id === statement.correctsAttestationId);
    if (!previous || previous.id === statement.id || previous.author !== statement.author
      || previous.kind !== statement.kind || previous.obligationId !== statement.obligationId
      || !sameSource(previous, statement) || previous.recordedAt >= statement.recordedAt
      || removed.has(previous.id)) {
      invalid.add(statement.id); reasons.push({ code: 'attestation_mismatch', obligationId: statement.obligationId });
    } else removed.add(previous.id);
  }
  return statements.filter(s => !removed.has(s.id) && !invalid.has(s.id));
}

export function evaluateExecution(
  plan: PlanDocument, source: SourcePlanRef, publishers: PublisherAggregate[], recordedCompleted: CompletedWork[] = [], snapshot?: Snapshot,
  transferProgress?: Map<string, number>,
): ExecutionVerdict {
  const reasons: DomainReason[] = [];
  const statements: Attestation[] = [];
  const outstandingCustodyHolds = publishers.flatMap(p => p.book.status === 'unique'
    ? p.book.entity.payload.custodyHolds.filter(h => h.projectRoot === source.projectRoot && h.status === 'outstanding') : []);
  const required = new Set(deriveRequiredApprovers(plan));
  const commonSnapshot = snapshot ?? publishers.find(p => required.has(p.root.key))?.snapshot;
  for (const publisher of publishers.filter(p => required.has(p.root.key))) {
    if (publisher.book.status !== 'unique' || publisher.snapshot.completeness !== 'complete'
      || publisher.snapshot.freshness !== 'fresh' || (commonSnapshot && (publisher.snapshot.blockNumber !== commonSnapshot.blockNumber
        || publisher.snapshot.blockHash !== commonSnapshot.blockHash || publisher.snapshot.blockTimestamp !== commonSnapshot.blockTimestamp))
      || !validateCurrentEntity(publisher.root, publisher.snapshot, publisher.root.payload.publisher).valid
      || !validateCurrentEntity(publisher.book.entity, publisher.snapshot, publisher.root.payload.publisher).valid) {
      reasons.push({ code: 'evidence_unavailable', publisherRoot: publisher.root.key }); continue;
    }
    for (const statement of publisher.book.entity.payload.attestations) {
      if (!sameSource(statement, source)) continue;
      if (statement.author !== publisher.root.key || !Number.isSafeInteger(statement.recordedAt)
        || statement.recordedAt > publisher.snapshot.blockTimestamp) {
        reasons.push({ code: 'attestation_mismatch', obligationId: statement.obligationId }); continue;
      }
      statements.push(statement);
    }
  }
  for (const root of required) if (!publishers.some(p => p.root.key === root)) reasons.push({ code: 'evidence_unavailable', publisherRoot: root });
  const effective = effectiveStatements(statements, reasons);
  const completed: CompletedWork[] = [];
  const outstandingObligationIds: string[] = [];
  for (const obligation of plan.runbook) {
    const matches = effective.filter(s => s.obligationId === obligation.id);
    let evidence: Attestation[] = [];
    let done = false;
    if (obligation.kind === 'task') {
      const reports = matches.filter(s => s.kind === 'task_report' && s.author === obligation.publisherRoot);
      if (reports.length === 1 && reports[0]?.kind === 'task_report' && reports[0].status === 'done') {
        done = true; evidence = reports;
      }
      if (matches.length !== reports.length || reports.length > 1) reasons.push({ code: 'attestation_mismatch', obligationId: obligation.id });
    } else {
      const reports = matches.filter((s): s is TransferReport => s.kind === 'transfer_report');
      let sent = 0;
      let acknowledged = 0;
      for (const report of reports) {
        const valid = report.transferId === obligation.transferId && report.action === obligation.kind
          && report.resourceId === obligation.resourceId && report.unit === obligation.unit
          && report.giver === obligation.giver && report.receiver === obligation.receiver
          && report.author === obligation.giver && Number.isSafeInteger(report.quantity)
          && report.quantity > 0 && report.quantity <= obligation.quantity
          && report.statementHash === transferStatementHash(report);
        if (!valid) { reasons.push({ code: 'attestation_mismatch', obligationId: obligation.id }); continue; }
        sent += report.quantity;
        const acknowledgements = matches.filter(s => s.kind === 'transfer_acknowledgement' && s.statementHash === report.statementHash);
        const ack = acknowledgements[0];
        if (ack?.kind !== 'transfer_acknowledgement' || acknowledgements.length !== 1) continue;
        if (ack.author !== obligation.receiver || ack.giver !== obligation.giver || ack.receiver !== obligation.receiver
          || ack.action !== obligation.kind || ack.resourceId !== obligation.resourceId || ack.transferId !== obligation.transferId
          || !Number.isSafeInteger(ack.acknowledgedQuantity) || ack.acknowledgedQuantity <= 0
          || ack.acknowledgedQuantity > report.quantity || ack.recordedAt < report.recordedAt) {
          reasons.push({ code: 'attestation_mismatch', obligationId: obligation.id }); continue;
        }
        acknowledged += ack.acknowledgedQuantity;
        evidence.push(report, ack);
      }
      for (const match of matches) {
        if (match.kind === 'task_report' || (match.kind === 'transfer_acknowledgement'
          && !reports.some(r => r.statementHash === match.statementHash))) reasons.push({ code: 'attestation_mismatch', obligationId: obligation.id });
      }
      if (sent > obligation.quantity) reasons.push({ code: 'attestation_mismatch', obligationId: obligation.id });
      transferProgress?.set(obligation.id, sent <= obligation.quantity ? acknowledged : 0);
      done = sent === obligation.quantity && acknowledged === obligation.quantity;
    }
    if (done) completed.push({ obligationId: obligation.id, source: sourcePlanRef(source), attestationIds: evidence.map(a => a.id).sort(),
      recordedAt: Math.max(...evidence.map(a => a.recordedAt)), evidenceAvailability: 'available' });
    else outstandingObligationIds.push(obligation.id);
  }
  for (const prior of recordedCompleted) {
    if (completed.some(c => c.obligationId === prior.obligationId && sameSource(c.source, prior.source))) continue;
    // Retained history remains a recorded assertion even if the source has become unavailable.
    // Only the independently matched effective reports above establish available completion evidence.
    // A coordinator's historical list is retained as a claim, never promoted by an empty/forged ID list.
    completed.push({ ...prior, source: sourcePlanRef(prior.source), attestationIds: [...prior.attestationIds], evidenceAvailability: 'unavailable' });
    // A missing old statement lowers evidence confidence, not the recorded fact that the duty was completed.
    const explicitlyCorrected = effective.some(a => a.obligationId === prior.obligationId && a.kind === 'task_report' && a.status === 'not_done');
    if (sameSource(prior.source, source) && prior.attestationIds.length > 0 && !explicitlyCorrected) {
      const index = outstandingObligationIds.indexOf(prior.obligationId);
      if (index >= 0) outstandingObligationIds.splice(index, 1);
    }
  }
  const unavailable = completed.filter(c => c.evidenceAvailability !== 'available').length;
  return { completed, outstandingObligationIds, outstandingCustodyHolds, reasons,
    evidenceAvailability: reasons.some(r => r.code === 'evidence_unavailable') || unavailable
      ? completed.length > 0 && unavailable === completed.length ? 'unavailable' : 'partial' : 'available' };
}

export function deriveExecution(project: ProjectAggregate): ExecutionVerdict {
  const state = project.state.status === 'unique' ? project.state.entity.payload : null;
  const source = activeSource(project) ?? state?.completion?.source ?? null;
  const proposal = source ? [project.proposal, ...project.proposalHistory].find(p => p?.key === source.proposalKey && p.payload.proposalHash === source.proposalHash) : null;
  const prior = state?.completion?.completedWork ?? state?.completedWork ?? [];
  const trustedProposal = (candidate: typeof proposal, reference: SourcePlanRef): boolean => Boolean(candidate
    && candidate.key === reference.proposalKey && candidate.payload.proposalHash === reference.proposalHash
    && candidate.payload.projectRoot === reference.projectRoot && candidate.payload.plan.projectRoot === reference.projectRoot
    && validateCurrentEntity(candidate, project.snapshot, project.root.payload.coordinator).valid);
  if (source && trustedProposal(proposal, source) && proposal) {
    const execution = evaluateExecution(proposal.payload.plan, source, project.publishers, prior.filter(w => sameSource(w.source, source)), project.snapshot);
    for (const previous of prior.filter(w => !sameSource(w.source, source))) {
      const previousProposal = project.proposalHistory.find(p => p.key === previous.source.proposalKey && p.payload.proposalHash === previous.source.proposalHash);
      const historical = previousProposal && trustedProposal(previousProposal, previous.source)
        ? evaluateExecution(previousProposal.payload.plan, previous.source, project.publishers, [], project.snapshot) : null;
      const verified = historical?.completed.some(work => work.obligationId === previous.obligationId
        && previous.attestationIds.every(id => project.publishers.some(p => p.book.status === 'unique'
          && p.book.entity.payload.attestations.some(a => a.id === id && sameSource(a, previous.source)))));
      execution.completed.push({ ...previous, source: sourcePlanRef(previous.source), attestationIds: [...previous.attestationIds],
        evidenceAvailability: verified ? 'available' : 'unavailable' });
      if (!verified) execution.reasons.push({ code: 'evidence_unavailable', obligationId: previous.obligationId });
    }
    const unavailable = execution.completed.filter(work => work.evidenceAvailability !== 'available').length;
    if (unavailable) execution.evidenceAvailability = unavailable === execution.completed.length ? 'unavailable' : 'partial';
    return execution;
  }
  return { completed: prior.map(c => ({ ...c, source: sourcePlanRef(c.source), attestationIds: [...c.attestationIds], evidenceAvailability: 'unavailable' })),
    outstandingObligationIds: state?.completion?.outstandingObligationIds ?? [],
    outstandingCustodyHolds: project.publishers.flatMap(p => p.book.status === 'unique'
      ? p.book.entity.payload.custodyHolds.filter(h => h.projectRoot === project.root.key && h.status === 'outstanding') : []),
    reasons: source || prior.length ? [{ code: 'evidence_unavailable' }] : [],
    evidenceAvailability: source || prior.length ? 'unavailable' : 'available' };
}

export function planDiff(before: PlanDocument, after: PlanDocument): PlanDifference {
  before = normalizedPlan(before);
  after = normalizedPlan(after);
  const prior = deriveRequiredApprovers(before);
  const next = deriveRequiredApprovers(after);
  const changed = <T extends { id: string }>(a: T[], b: T[]): string[] => [...new Set([...a, ...b].map(v => v.id))]
    .filter(id => canonicalJson(a.find(v => v.id === id) ?? null) !== canonicalJson(b.find(v => v.id === id) ?? null)).sort();
  const materialChanged = hashPlan(before) !== hashPlan(after);
  return { addedPublishers: next.filter(p => !prior.includes(p)), removedPublishers: prior.filter(p => !next.includes(p)),
    changedAllocationIds: changed(before.allocations, after.allocations), changedObligationIds: changed(before.runbook, after.runbook),
    variantChanged: canonicalJson(before.variant) !== canonicalJson(after.variant), materialChanged,
    requiresFreshAgreement: materialChanged ? next : [] };
}

/** Outstanding duties become a new material package; completed assertions stay in lineage. */
export function remainingWork(project: ProjectAggregate): { plan: PlanDocument; completedWork: CompletedWork[]; execution: ExecutionVerdict } | null {
  const source = activeSource(project);
  if (!source || !project.proposal || project.proposal.key !== source.proposalKey || project.proposal.payload.proposalHash !== source.proposalHash
    || !validateCurrentEntity(project.proposal, project.snapshot, project.root.payload.coordinator).valid) return null;
  const execution = deriveExecution(project);
  const previous = project.proposal.payload.plan;
  const transferProgress = new Map<string, number>();
  evaluateExecution(previous, source, project.publishers, [], project.snapshot, transferProgress);
  const outstanding = new Set(execution.outstandingObligationIds);
  const runbook = previous.runbook.filter(o => outstanding.has(o.id)).map(o => ({ ...o,
    ...(o.kind === 'task' ? {} : { quantity: o.quantity - (transferProgress.get(o.id) ?? 0) }),
    dependsOn: o.dependsOn.filter(id => outstanding.has(id)) }));
  const demanded = new Map<string, number>();
  for (const obligation of runbook) {
    let remaining = obligation.kind === 'task' ? Number.MAX_SAFE_INTEGER : obligation.quantity;
    for (const id of [...obligation.allocationIds].sort()) {
      const allocation = previous.allocations.find(a => a.id === id);
      if (!allocation) continue;
      const amount = Math.min(allocation.quantity, remaining);
      demanded.set(id, Math.max(demanded.get(id) ?? 0, amount));
      if (obligation.kind !== 'task') remaining -= amount;
    }
  }
  const allocations = previous.allocations.filter(a => (demanded.get(a.id) ?? 0) > 0).map(a => ({ ...a, quantity: demanded.get(a.id)! }));
  const allocationIds = new Set(allocations.map(a => a.id));
  for (const obligation of runbook) obligation.allocationIds = obligation.allocationIds.filter(id => allocationIds.has(id));
  const requirementIds = new Set(allocations.map(a => a.requirementId));
  const offers = previous.offers.filter(o => allocations.some(a => a.publisherRoot === o.publisherRoot && a.offerId === o.offerId));
  const selected = offers.map(ref => {
    const publisher = project.publishers.find(p => p.root.key === ref.publisherRoot);
    const current = publisher?.book.status === 'unique' ? publisher.book.entity.payload.offers.find(o => o.id === ref.offerId) : null;
    if (!current || hashOffer(ref.publisherRoot, current) !== ref.offerHash) {
      execution.reasons.push({ code: current ? 'offer_changed' : 'missing_offer', publisherRoot: ref.publisherRoot, offerId: ref.offerId });
      return null;
    }
    return current;
  });
  const conditionMap = new Map(selected.flatMap(offer => offer?.conditions ?? []).map(condition => [canonicalJson(condition), condition]));
  const conditions = selected.every(offer => offer !== null) ? canonicalConditions([...conditionMap.values()]) : previous.conditions;
  const outstandingTaskRequirements = new Set(runbook.filter(obligation => obligation.kind === 'task')
    .flatMap(obligation => allocations.filter(allocation => obligation.allocationIds.includes(allocation.id)).map(allocation => allocation.requirementId)));
  const requirements = previous.variant.requirements.filter(r => requirementIds.has(r.id)).map(r => ({ ...r,
    quantity: allocations.filter(a => a.requirementId === r.id).reduce((sum, a) => sum + a.quantity, 0),
    // A completed prerequisite may retain an equipment allocation solely for its return.
    dependsOn: r.dependsOn.filter(id => outstandingTaskRequirements.has(id)) }));
  const plan: PlanDocument = structuredClone({ ...previous, predecessor: source, runbook, allocations, offers, conditions,
    resourceAssumptions: previous.resourceAssumptions.filter(r => allocations.some(a => a.publisherRoot === r.publisherRoot && a.resourceId === r.resourceId)),
    variant: { ...previous.variant, requirements }, requiredApprovers: [] });
  plan.requiredApprovers = deriveRequiredApprovers(plan);
  return { plan, completedWork: execution.completed, execution };
}

export function reuseRecipe(project: ProjectAggregate): RecipeTemplate | null {
  if (project.state.status !== 'unique') return null;
  const recipe = project.state.entity.payload.recipe;
  return structuredClone({ title: recipe.title, outcome: recipe.outcome, timeZone: recipe.timeZone,
    instructions: recipe.instructions, sourceProjectRoot: project.root.key,
    variants: recipe.variants.map(variant => ({ ...variant,
      requirements: variant.requirements.map(({ interval: _dates, ...requirement }) => requirement) })) });
}
