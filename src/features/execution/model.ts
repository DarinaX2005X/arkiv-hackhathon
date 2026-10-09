import type { Actor, Attestation, EntityKey, EntityRecord, ProjectAggregate, Proposal, RunbookObligation, SourcePlanRef } from '../../domain/types';
import type { ReplaceBookCommand, ReplaceProjectCommand, WriteAuthority } from '../../data/types';
import { activeSource, deriveReadiness, sameActor, sameSource } from '../../domain/readiness';
import { evaluateExecution, transferStatementHash } from '../../domain/execution';
import { prepareAttestation, prepareCloseProject, prepareReleaseCustodyHold } from '../../domain/operations';
import { createOperationIntent } from '../../data/operations';
import { bookLifetime } from '../contributions/model';
import { reasonText } from '../projects/catalog';
import { STATE_LIFETIME_SECONDS } from '../projects/selectors';

export type TransferReport = Extract<Attestation, { kind: 'transfer_report' }>;
export type TransferAcknowledgement = Extract<Attestation, { kind: 'transfer_acknowledgement' }>;
export interface RunbookRow {
  obligation: RunbookObligation; reports: Exclude<Attestation, TransferAcknowledgement>[]; acknowledgements: TransferAcknowledgement[];
  status: 'not_reported' | 'reported_not_done' | 'reported_done' | 'awaiting_acknowledgement' | 'partially_acknowledged' | 'confirmed_handover' | 'confirmed_return' | 'evidence_unavailable';
  completed: boolean; mine: boolean; reportedQuantity: number; acknowledgedQuantity: number;
}
export function planVersions(project: ProjectAggregate): EntityRecord<Proposal>[] {
  return [...new Map([...(project.proposal ? [project.proposal] : []), ...project.proposalHistory].map(item => [item.key, item])).values()]
    .sort((a, b) => b.payload.createdAt - a.payload.createdAt || a.key.localeCompare(b.key));
}
/** A historical source is evidence retained in lineage, never a recreated activation. */
export function sourceForProposal(project: ProjectAggregate, key: EntityKey): SourcePlanRef | null {
  const current = activeSource(project);
  if (current?.proposalKey === key) return current;
  const completion = project.state.status === 'unique' ? project.state.entity.payload.completion?.source : null;
  if (completion?.proposalKey === key) return completion;
  for (const proposal of planVersions(project)) if (proposal.payload.plan.predecessor?.proposalKey === key) return proposal.payload.plan.predecessor;
  for (const publisher of project.publishers) if (publisher.book.status === 'unique') {
    const record = [...publisher.book.entity.payload.decisions, ...publisher.book.entity.payload.attestations].find(item => item.proposalKey === key);
    if (record) return { projectRoot: record.projectRoot, activationKey: record.activationKey, proposalKey: record.proposalKey, proposalHash: record.proposalHash };
  }
  return null;
}
export function effectiveAttestations(project: ProjectAggregate, source: SourcePlanRef): Attestation[] {
  return project.publishers.flatMap(publisher => {
    if (publisher.book.status !== 'unique') return [];
    const statements = publisher.book.entity.payload.attestations.filter(item => item.author === publisher.root.key && sameSource(item, source));
    const corrected = new Set(statements.map(item => item.correctsAttestationId).filter(Boolean));
    return statements.filter(item => !corrected.has(item.id));
  });
}
export function ownPublisherRoots(project: ProjectAggregate, actor: Actor | null): EntityKey[] {
  return actor ? project.publishers.filter(publisher => sameActor(publisher.root.payload.publisher, actor)
    && sameActor(publisher.root.provenance.creator, actor)).map(publisher => publisher.root.key) : [];
}
export function runbookRows(project: ProjectAggregate, proposal: EntityRecord<Proposal>, source: SourcePlanRef | null, actor: Actor | null): RunbookRow[] {
  const owned = ownPublisherRoots(project, actor);
  const statements = source ? effectiveAttestations(project, source) : [];
  const evaluation = source ? evaluateExecution(proposal.payload.plan, source, project.publishers, [], project.snapshot) : null;
  return [...proposal.payload.plan.runbook].sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end || a.id.localeCompare(b.id)).map(obligation => {
    const own = statements.filter(item => item.obligationId === obligation.id);
    const reports = own.filter(item => item.kind !== 'transfer_acknowledgement');
    const acknowledgements = own.filter((item): item is TransferAcknowledgement => item.kind === 'transfer_acknowledgement');
    const completed = evaluation?.completed.some(work => work.obligationId === obligation.id && work.evidenceAvailability === 'available') ?? false;
    const reportedQuantity = reports.reduce((total, report) => total + (report.kind === 'transfer_report' ? report.quantity : 0), 0);
    const acknowledgedQuantity = acknowledgements.reduce((total, ack) => total + ack.acknowledgedQuantity, 0);
    const uncertain = !source || evaluation?.reasons.some(reason => reason.code === 'evidence_unavailable' || reason.obligationId === obligation.id)
      || project.snapshot.freshness !== 'fresh' || project.snapshot.completeness !== 'complete';
    const status: RunbookRow['status'] = uncertain ? 'evidence_unavailable' : obligation.kind === 'task'
      ? completed ? 'reported_done' : reports.some(item => item.kind === 'task_report' && item.status === 'not_done') ? 'reported_not_done' : 'not_reported'
      : completed ? obligation.kind === 'handover' ? 'confirmed_handover' : 'confirmed_return'
        : acknowledgedQuantity ? 'partially_acknowledged' : reportedQuantity ? 'awaiting_acknowledgement' : 'not_reported';
    return { obligation, reports, acknowledgements, completed, status, reportedQuantity, acknowledgedQuantity,
      mine: obligation.kind === 'task' ? owned.includes(obligation.publisherRoot) : owned.includes(obligation.giver) || owned.includes(obligation.receiver) };
  });
}
export const rowLabels: Record<RunbookRow['status'], string> = {
  not_reported: 'Not reported', reported_not_done: 'Owner reported incomplete', reported_done: 'Owner reported done',
  awaiting_acknowledgement: 'Reported, awaiting recipient acknowledgement', partially_acknowledged: 'Partly acknowledged, still outstanding',
  confirmed_handover: 'Handover confirmed by both sides', confirmed_return: 'Return confirmed by both sides', evidence_unavailable: 'Evidence needs verification',
};
export function versionStatus(project: ProjectAggregate, proposal: EntityRecord<Proposal>, now: number): string {
  const closed = project.state.status === 'unique' && project.state.entity.payload.lifecycle === 'closed';
  if (closed && project.state.status === 'unique') return `${project.state.entity.payload.completion?.source?.proposalKey === proposal.key ? 'Closed record' : 'Historical version, project closed'}, ${project.state.entity.payload.completion?.outcome.replaceAll('_', ' ') ?? 'outcome unavailable'}`;
  if (activeSource(project)?.proposalKey !== proposal.key) return 'Historical version, not the current agreement';
  const readiness = deriveReadiness(project, now);
  return { ready: 'Agreed by everyone', possible: 'Proposed, agreement not recorded', awaiting_approval: 'Proposed, awaiting everyone’s agreement',
    declined: 'Declined, not ready', changed: 'Changed, needs repair', conflict: 'Conflicting records, not verified', unverified: 'Current status unverified' }[readiness.status];
}

export type ProgressInput =
  | { kind: 'task_report'; status: 'done' | 'not_done'; note: string }
  | { kind: 'transfer_report'; quantity: number }
  | { kind: 'transfer_acknowledgement'; reportId: string; quantity: number };
export function prepareProgressCommand(project: ProjectAggregate, proposal: EntityRecord<Proposal>, source: SourcePlanRef,
  obligationId: string, authority: WriteAuthority, input: ProgressInput, now: number, id: string): ReplaceBookCommand {
  if (source.proposalKey !== proposal.key || source.proposalHash !== proposal.payload.proposalHash) throw new Error('This action belongs to a different plan version.');
  if (project.snapshot.completeness !== 'complete' || project.snapshot.freshness !== 'fresh') throw new Error('Refresh complete current data before recording progress.');
  const obligation = proposal.payload.plan.runbook.find(item => item.id === obligationId);
  if (!obligation) throw new Error('This task is no longer available in the selected plan.');
  const author = input.kind === 'task_report' ? obligation.publisherRoot : obligation.kind !== 'task'
    ? input.kind === 'transfer_report' ? obligation.giver : obligation.receiver : null;
  if (!author || !ownPublisherRoots(project, authority.actor).includes(author)) throw new Error('Only the named owner can record their side of this action.');
  const statements = effectiveAttestations(project, source);
  const base = { ...source, id: `report:${id}`, operationId: id, obligationId, author, recordedAt: project.snapshot.blockTimestamp };
  let attestation: Attestation;
  if (input.kind === 'task_report') {
    const prior = statements.filter(item => item.obligationId === obligationId && item.kind === 'task_report' && item.author === author);
    if (prior.length > 1) throw new Error('Conflicting earlier reports need verification.');
    if (prior[0]?.recordedAt === base.recordedAt) throw new Error('Refresh to a later snapshot before correcting this report.');
    attestation = { ...base, ...input, ...(prior[0] ? { correctsAttestationId: prior[0].id } : {}) };
  } else {
    if (obligation.kind === 'task') throw new Error('This is not a transfer.');
    const transfer = { transferId: obligation.transferId, action: obligation.kind, resourceId: obligation.resourceId, giver: obligation.giver, receiver: obligation.receiver };
    if (input.kind === 'transfer_report') {
      const report = { ...base, kind: 'transfer_report' as const, ...transfer, quantity: input.quantity, unit: obligation.unit };
      attestation = { ...report, statementHash: transferStatementHash(report) };
    } else {
      const report = statements.find((item): item is TransferReport => item.id === input.reportId && item.kind === 'transfer_report');
      if (!report || report.obligationId !== obligation.id) throw new Error('The giver’s exact report must be available before it can be acknowledged.');
      const prior = statements.find(item => item.kind === 'transfer_acknowledgement' && item.statementHash === report.statementHash && item.author === author);
      if (prior?.recordedAt === base.recordedAt) throw new Error('Refresh to a later snapshot before correcting this acknowledgement.');
      attestation = { ...base, kind: 'transfer_acknowledgement', ...transfer, statementHash: report.statementHash, acknowledgedQuantity: input.quantity,
        ...(prior ? { correctsAttestationId: prior.id } : {}) };
    }
  }
  const prepared = prepareAttestation(project, author, authority.actor, attestation);
  if (!prepared.ok) throw new Error(prepared.reasons.map(reasonText).join(' '));
  const command = { publisherRoot: author, ...prepared.value, lifetimeSeconds: bookLifetime(prepared.value.book, now) };
  return { ...command, operation: createOperationIntent('replace_book', authority, command, { id, now }) };
}
export function prepareClosureCommand(project: ProjectAggregate, authority: WriteAuthority, outcome: 'completed' | 'completed_with_outstanding' | 'cancelled', statement: string, now: number, id: string): ReplaceProjectCommand {
  const prepared = prepareCloseProject(project, authority.actor, { outcome, statement, operationId: id, now });
  if (!prepared.ok) throw new Error(prepared.reasons.map(reasonText).join(' '));
  const command = { projectRoot: project.root.key, ...prepared.value, lifetimeSeconds: STATE_LIFETIME_SECONDS };
  return { ...command, operation: createOperationIntent('close_project', authority, command, { id, now }) };
}
export function prepareCustodyReleaseCommand(project: ProjectAggregate, publisherRoot: EntityKey, holdId: string, authority: WriteAuthority, reason: string, now: number, id: string): ReplaceBookCommand {
  const publisher = project.publishers.find(item => item.root.key === publisherRoot);
  if (!publisher) throw new Error('The equipment owner’s current record is missing.');
  const prepared = prepareReleaseCustodyHold(publisher, authority.actor, holdId, id, now, reason);
  if (!prepared.ok) throw new Error(prepared.reasons.map(reasonText).join(' '));
  const command = { publisherRoot, ...prepared.value, lifetimeSeconds: bookLifetime(prepared.value.book, now) };
  return { ...command, operation: createOperationIntent('replace_book', authority, command, { id, now }) };
}
