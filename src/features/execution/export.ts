import type { ExportPacket } from '../../data/types';
import type { EntityKey, EntityPayload, EntityRecord, ProjectAggregate, SourcePlanRef } from '../../domain/types';
import { validateEntityPayload } from '../../domain/validation';
import { hashPlan } from '../../domain/canonical';
import { deriveExecution } from '../../domain/execution';
import { deriveReadiness } from '../../domain/readiness';
import { formatDateTime } from '../../app/time';
import { publisherName } from '../projects/selectors';
import { planVersions, rowLabels, runbookRows, sourceForProposal, versionStatus } from './model';

export interface ExecutionExport extends ExportPacket {
  selection: { proposalKey: EntityKey | null; source: SourcePlanRef | null; status: string };
}
export interface TextDownload { filename: string; mime: string; text: string }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Import validates all record content before copying any recipe. It never imports authorizations. */
export function parseExecutionExport(raw: string): ExportPacket {
  if (new TextEncoder().encode(raw).byteLength > 8 * 1024 * 1024) throw new Error('This export is larger than the supported 8 MB limit.');
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.format !== 'partfolk-export' || value.version !== 1 || !Number.isSafeInteger(value.exportedAt)
    || !['local', 'public'].includes(String(value.mode)) || !object(value.project) || !object(value.snapshot) || !object(value.readiness)) throw new Error('This file is not a supported Partfolk project export.');
  const record = (item: unknown, expected?: string): item is EntityRecord<EntityPayload> => object(item) && typeof item.key === 'string'
    && /^(local:[A-Za-z0-9._:-]+|0x[\da-fA-F]{64})$/.test(item.key) && object(item.payload)
    && (!expected || item.payload.entityType === expected) && validateEntityPayload(item.payload).valid
    && object(item.provenance) && object(item.provenance.creator) && object(item.provenance.owner);
  const scope = (item: unknown, expected: string) => object(item) && (item.status === 'unique' ? record(item.entity, expected)
    : item.status === 'conflict' ? Array.isArray(item.entities) && item.entities.every(entry => record(entry, expected))
      : item.status === 'missing' ? typeof item.reason === 'string' : item.status === 'unverified' && Array.isArray(item.reasons));
  const project = value.project;
  if (!record(project.root, 'project_root') || !scope(project.state, 'project_state') || !scope(project.activation, 'plan_activation')
    || (project.proposal !== null && !record(project.proposal, 'proposal')) || !Array.isArray(project.proposalHistory)
    || !project.proposalHistory.every(item => record(item, 'proposal')) || !Array.isArray(project.publishers)
    || !project.publishers.every(item => object(item) && record(item.root, 'publisher_root') && scope(item.book, 'book_state') && object(item.snapshot))
    || !object(project.snapshot) || !Number.isSafeInteger(project.snapshot.fetchedAt) || !Number.isSafeInteger(project.snapshot.blockTimestamp)
    || project.snapshot.mode !== value.mode || !['complete', 'incomplete'].includes(String(project.snapshot.completeness))
    || !['fresh', 'stale'].includes(String(project.snapshot.freshness))) throw new Error('This export contains invalid project records. Nothing was imported.');
  const packet = value as unknown as ExportPacket;
  if (packet.project.state.status === 'unique' && packet.project.state.entity.payload.projectRoot !== packet.project.root.key) throw new Error('The project records do not belong together.');
  for (const proposal of planVersions(packet.project)) if (proposal.payload.projectRoot !== packet.project.root.key
    || proposal.payload.plan.projectRoot !== packet.project.root.key || hashPlan(proposal.payload.plan) !== proposal.payload.proposalHash) throw new Error('An exported plan does not match its exact version.');
  return packet;
}

export function packetFromProject(project: ProjectAggregate, now: number): ExportPacket {
  return { format: 'partfolk-export', version: 1, exportedAt: now, mode: project.snapshot.mode,
    project: structuredClone(project), readiness: deriveReadiness(project, now), snapshot: structuredClone(project.snapshot) };
}
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export function buildExecutionExports(packet: ExportPacket, selectedProposalKey?: EntityKey): { json: TextDownload; html: TextDownload } {
  const checked = parseExecutionExport(JSON.stringify(packet)), project = checked.project;
  const selected = selectedProposalKey ? planVersions(project).find(item => item.key === selectedProposalKey) : project.proposal ?? planVersions(project)[0];
  if (selectedProposalKey && !selected) throw new Error('The selected plan is not available in this export. Refresh or choose an available version.');
  const source = selected ? sourceForProposal(project, selected.key) : null;
  const status = selected ? versionStatus(project, selected, packet.exportedAt) : 'No agreed plan';
  const content: ExecutionExport = { ...checked, selection: { proposalKey: selected?.key ?? null, source, status } };
  const title = project.state.status === 'unique' ? project.state.entity.payload.recipe.title : 'Partfolk project';
  const zone = selected?.payload.plan.variant.timeZone ?? (project.state.status === 'unique' ? project.state.entity.payload.recipe.timeZone : 'UTC');
  const time = (value: number) => escape(formatDateTime(value, zone));
  const rows = selected ? runbookRows(project, selected, source, null) : [];
  const execution = deriveExecution(project);
  const completion = project.state.status === 'unique' ? project.state.entity.payload.completion : null;
  const name = (root: EntityKey) => escape(publisherName(project, root));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}; Partfolk run sheet</title>
<style>body{font:15px/1.5 Arial,sans-serif;color:#202922;max-width:1100px;margin:2rem auto;padding:0 1rem}h1,h2,h3{line-height:1.2}h2{margin-top:2rem}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{text-align:left;vertical-align:top;padding:.6rem;border-bottom:1px solid #bbb}th{font-weight:600}small{display:block}code{overflow-wrap:anywhere}.status{border:2px solid #555;padding:.75rem}.duty{break-inside:avoid;border-top:1px solid #bbb;padding:1rem 0}.note{white-space:pre-wrap}ul{padding-left:1.2rem}@page{margin:15mm}@media print{body{margin:0;max-width:none;padding:0;font-size:10pt}thead{display:table-header-group}a{color:inherit}}</style></head><body>
<header><h1>${escape(title)}</h1><p>${escape(selected?.payload.plan.outcome ?? '')}</p>
<p class="status"><strong>${escape(status)}</strong><br>${packet.mode === 'local' ? 'Local record; not network evidence' : 'Public record snapshot'}; ${escape(zone)}</p>
<p>Exported ${time(packet.exportedAt)}. Data read ${time(project.snapshot.fetchedAt)}. ${project.snapshot.freshness === 'fresh' && project.snapshot.completeness === 'complete' ? 'Complete snapshot at the recorded time.' : 'Last-known data; current status is unverified.'}</p>
<p>Project: <code>${escape(project.root.key)}</code><br>Proposal: <code>${escape(selected?.key ?? 'None')}</code><br>Plan hash: <code>${escape(selected?.payload.proposalHash ?? 'None')}</code><br>Activation: <code>${escape(source?.activationKey ?? 'Unavailable')}</code></p></header>
${selected?.payload.plan.instructions ? `<section><h2>For everyone</h2><p class="note">${escape(selected.payload.plan.instructions)}</p></section>` : ''}${selected?.payload.plan.variant.instructions ? `<section><h2>At the venue</h2><p class="note">${escape(selected.payload.plan.variant.instructions)}</p></section>` : ''}
<h2>Assignments</h2><table><thead><tr><th>Requirement</th><th>Owner and quantity</th><th>Time (${escape(zone)})</th></tr></thead><tbody>${selected?.payload.plan.allocations.map(allocation => `<tr><th>${escape(selected.payload.plan.variant.requirements.find(requirement => requirement.id === allocation.requirementId)?.title ?? allocation.requirementId)}</th><td>${name(allocation.publisherRoot)}<br>${allocation.quantity} ${escape(allocation.unit)}<small>${escape(allocation.resourceId)}; ${escape(allocation.id)}</small></td><td>${time(allocation.interval.start)}–${time(allocation.interval.end)}</td></tr>`).join('') ?? '<tr><td colspan="3">No selected plan.</td></tr>'}</tbody></table>
<h2>Runbook</h2>${rows.map(row => `<section class="duty"><h3>${escape(row.obligation.title)}</h3><p>${time(row.obligation.interval.start)}–${time(row.obligation.interval.end)}; ${escape(rowLabels[row.status])}</p><p>${row.obligation.kind === 'task' ? `Owner: ${name(row.obligation.publisherRoot)}. Completion is this owner’s report.` : `${row.obligation.quantity} ${escape(row.obligation.unit)}; Giver: ${name(row.obligation.giver)}; Recipient: ${name(row.obligation.receiver)}.<br>Reported: ${row.reportedQuantity}; acknowledged: ${row.acknowledgedQuantity}.`}</p><p class="note">${escape(row.obligation.instructions)}</p>${row.obligation.dependsOn.length ? `<p>After: ${row.obligation.dependsOn.map(id => escape(selected?.payload.plan.runbook.find(duty => duty.id === id)?.title ?? id)).join(', ')}</p>` : ''}<ul>${row.reports.map(report => `<li>Owner report ${escape(report.id)}; ${name(report.author)}; ${time(report.recordedAt)}${report.kind === 'task_report' ? `; ${escape(report.status)}; ${escape(report.note)}` : `; ${report.quantity} ${escape(report.unit)}`}</li>`).join('')}${row.acknowledgements.map(ack => `<li>Recipient acknowledgement ${escape(ack.id)}; ${name(ack.author)}; ${time(ack.recordedAt)}; ${ack.acknowledgedQuantity}</li>`).join('')}</ul></section>`).join('')}
<h2>Outcome and exceptions</h2><p>${completion ? `Recorded outcome: ${escape(completion.outcome.replaceAll('_', ' '))}. ${escape(completion.statement)}` : 'The project has no recorded final outcome.'}</p><p>Completed records: ${execution.completed.length}. Evidence: ${escape(execution.evidenceAvailability)}.</p>
<ul>${execution.outstandingObligationIds.map(id => `<li>Outstanding duty: ${escape(planVersions(project).flatMap(plan => plan.payload.plan.runbook).find(duty => duty.id === id)?.title ?? id)} (${escape(id)})</li>`).join('')}${execution.outstandingCustodyHolds.map(hold => `<li>Outstanding equipment: ${hold.quantity} ${escape(hold.unit)}; ${escape(hold.resourceId)}; hold ${escape(hold.id)}</li>`).join('')}${completion?.outstandingCustodyHoldIds.filter(id => !execution.outstandingCustodyHolds.some(hold => hold.id === id)).map(id => `<li>Outstanding at closure: ${escape(id)}. See the owner’s current release record for later updates.</li>`).join('') ?? ''}</ul>
<p>Reports and acknowledgements remain distinct. This dated document does not guarantee attendance or physical return. Historical, proposed and unverified versions are not current agreement.</p></body></html>`;
  const stem = `partfolk-${title.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'project'}-${selected?.payload.createdAt ?? packet.exportedAt}`;
  return { json: { filename: `${stem}.json`, mime: 'application/json', text: JSON.stringify(content, null, 2) }, html: { filename: `${stem}.html`, mime: 'text/html', text: html } };
}
