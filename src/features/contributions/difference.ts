import { canonicalJson } from '../../domain/canonical';
import type { PlanDocument, RunbookObligation } from '../../domain/types';
import { formatDateTime } from '../../app/time';
import { conditionText } from './model';

export interface AgreementDifferenceRow { id: string; label: string; before: string; after: string }
/** Human-readable complete material groups; equality uses the canonical protocol representation. */
export function agreementDifference(before: PlanDocument, after: PlanDocument): AgreementDifferenceRow[] {
  const rows: AgreementDifferenceRow[] = [];
  const time = (interval: { start: number; end: number }, zone: string) => `${formatDateTime(interval.start, zone)} – ${formatDateTime(interval.end, zone)} (${zone})`;
  const add = (id: string, label: string, old: unknown, next: unknown, text: (value: never, zone: string) => string) => {
    if (canonicalJson(old ?? null) !== canonicalJson(next ?? null)) rows.push({ id, label,
      before: old === undefined ? 'Not included' : text(old as never, before.variant.timeZone),
      after: next === undefined ? 'Not included' : text(next as never, after.variant.timeZone) });
  };
  const list = <T extends { id: string }>(name: string, old: T[], next: T[], label: (item: T) => string, text: (item: T, zone: string) => string) => {
    for (const id of [...new Set([...old.map(x => x.id), ...next.map(x => x.id)])]) {
      const a = old.find(x => x.id === id), b = next.find(x => x.id === id);
      add(`${name}:${id}`, `${name}: ${label((b ?? a)!)}`, a, b, text);
    }
  };
  add('outcome', 'Project outcome', before.outcome, after.outcome, String);
  for (const field of ['id', 'title', 'venueId', 'timeZone', 'instructions'] as const) add(`option:${field}`, `Plan option ${field === 'venueId' ? 'venue' : field === 'timeZone' ? 'time zone' : field}`, before.variant[field], after.variant[field], String);
  list('Requirement', before.variant.requirements, after.variant.requirements, r => r.title,
    (r, zone) => `${r.title}: ${r.quantity} ${r.unit} of ${r.capability}; ${time(r.interval, zone)}. ${r.instructions} After: ${r.dependsOn.join(', ') || 'none'}.`);
  list('Assignment', before.allocations, after.allocations, a => a.requirementId,
    (a, zone) => `${a.quantity} ${a.unit} from ${a.publisherRoot}, offer ${a.offerId}, resource ${a.resourceId}; ${time(a.interval, zone)}. Offer terms: ${a.offerHash}.`);
  const obligation = (o: RunbookObligation, zone: string) => `${o.title}; owner ${o.publisherRoot}; ${time(o.interval, zone)}. ${o.kind === 'task' ? '' : `${o.kind}: ${o.quantity} ${o.unit}, ${o.giver} → ${o.receiver}, resource ${o.resourceId}, transfer ${o.transferId}. `}${o.instructions} After: ${o.dependsOn.join(', ') || 'none'}. Allocations: ${o.allocationIds.join(', ')}.`;
  list('Runbook', before.runbook, after.runbook, o => o.title, obligation);
  add('offers', 'Selected offer terms', before.offers, after.offers, (refs: PlanDocument['offers']) => refs.map(r => `${r.publisherRoot}: ${r.offerId} (${r.offerHash})`).join('\n'));
  add('capacity', 'Capacity assumptions', before.resourceAssumptions, after.resourceAssumptions, (assumptions: PlanDocument['resourceAssumptions']) => assumptions.map(a => `${a.publisherRoot}, ${a.resourceId}: ${a.capacity} ${a.unit}`).join('\n'));
  add('approvers', 'Required owners', before.requiredApprovers, after.requiredApprovers, (owners: PlanDocument['requiredApprovers']) => owners.join('\n'));
  add('conditions', 'Checked conditions', before.conditions, after.conditions, (conditions: PlanDocument['conditions']) => conditions.map(conditionText).join('\n') || 'No structured conditions');
  add('instructions', 'Shared instructions', before.instructions, after.instructions, String);
  return rows;
}
