import { useState } from 'react';
import type { Allocation, PlanDocument, ProjectAggregate, RunbookObligation } from '../../domain/types';
import { localDateTimeToUtc, utcToLocalDateTime, type TimeDisambiguation } from '../../app/time';
import { Button, Checkbox, Field, Notice, Select, Textarea } from '../../ui';
import { publisherName } from './selectors';

export interface TransferDraft {
  kind: 'handover' | 'return'; title: string; allocationId: string; giver: string; receiver: string;
  quantity: string; start: string; end: string; startOccurrence: TimeDisambiguation;
  endOccurrence: TimeDisambiguation; instructions: string; dependsOn: string[];
}
export function transferDutyFromDraft(draft: TransferDraft, allocation: Allocation, plan: PlanDocument, nowId: string): { duty: RunbookObligation | null; error: string | null } {
  if (!draft.title.trim() || !draft.giver || !draft.receiver || draft.giver === draft.receiver) return { duty: null, error: 'Name this duty and choose different giver and receiver contributors.' };
  if (!/^\d+$/.test(draft.quantity) || Number(draft.quantity) < 1 || Number(draft.quantity) > allocation.quantity) return { duty: null, error: `Enter a whole quantity from 1 to ${allocation.quantity} ${allocation.unit}.` };
  const start = localDateTimeToUtc(draft.start, plan.variant.timeZone, draft.startOccurrence), end = localDateTimeToUtc(draft.end, plan.variant.timeZone, draft.endOccurrence);
  if (!start.ok || !end.ok) return { duty: null, error: 'Enter valid times in the plan’s time zone. For repeated clock times, select the intended occurrence.' };
  if (start.utcMilliseconds >= end.utcMilliseconds) return { duty: null, error: 'The end must be later than the start.' };
  return { duty: { kind: draft.kind, id: `duty-${nowId}`, transferId: `transfer-${nowId}`, title: draft.title.trim(),
    publisherRoot: draft.giver as Allocation['publisherRoot'], resourceId: allocation.resourceId, quantity: Number(draft.quantity), unit: allocation.unit,
    giver: draft.giver as Allocation['publisherRoot'], receiver: draft.receiver as Allocation['publisherRoot'],
    interval: { start: start.utcMilliseconds, end: end.utcMilliseconds }, allocationIds: [allocation.id], dependsOn: draft.dependsOn,
    instructions: draft.instructions }, error: null };
}

/** Explicit named transfers are material plan terms. No receiver or return is inferred. */
export function PlanReviewEditor({ project, plan, onChange, disabled = false }: {
  project: ProjectAggregate; plan: PlanDocument; onChange: (plan: PlanDocument) => void; disabled?: boolean;
}) {
  const equipment = plan.allocations.filter(allocation => project.publishers.some(publisher => publisher.root.key === allocation.publisherRoot
    && publisher.book.status === 'unique' && publisher.book.entity.payload.resources.some(resource => resource.id === allocation.resourceId && resource.kind === 'equipment')));
  const first = equipment[0];
  const [draft, setDraft] = useState<TransferDraft>(() => ({ kind: 'handover', title: '', allocationId: first?.id ?? '', giver: first?.publisherRoot ?? '', receiver: '', quantity: first ? String(first.quantity) : '',
    start: first ? utcToLocalDateTime(first.interval.start, plan.variant.timeZone) : '', end: first ? utcToLocalDateTime(first.interval.end, plan.variant.timeZone) : '', startOccurrence: 'reject', endOccurrence: 'reject', instructions: '', dependsOn: [] }));
  const [error, setError] = useState<string | null>(null);
  const publisherOptions = [{ value: '', label: 'Choose a contributor' }, ...project.publishers.filter(publisher => project.state.status === 'unique' && project.state.entity.payload.publisherRoots.includes(publisher.root.key))
    .map(publisher => ({ value: publisher.root.key, label: publisherName(project, publisher.root.key) }))];
  const occurrences = [{ value: 'reject', label: 'Require an unambiguous time' }, { value: 'earlier', label: 'First occurrence if the clock time repeats' }, { value: 'later', label: 'Second occurrence if the clock time repeats' }];
  return <section className="pf-stack"><h3>Instructions and named handovers</h3><p>These duties are part of what everyone accepts. Reported handover and acknowledged receipt remain separate during the project.</p>
    <details><summary>Review or edit task instructions</summary><div className="pf-stack">{plan.runbook.filter(task => task.kind === 'task').map(task => <Textarea key={task.id} label={task.title} value={task.instructions} disabled={disabled} onChange={event => onChange({ ...plan, runbook: plan.runbook.map(item => item.id === task.id ? { ...item, instructions: event.target.value } : item) })} hint="Instructions are visible in the exact plan people will accept." />)}</div></details>
    {plan.runbook.filter(task => task.kind !== 'task').map(task => <div className="pf-sheet project-transfer" key={task.id}><p><strong>{task.title}</strong> · {task.kind === 'return' ? 'Return' : 'Handover'} · {task.quantity} {task.unit}</p><p>{publisherName(project, task.giver)} → {publisherName(project, task.receiver)}</p><Button variant="quiet" disabled={disabled} onClick={() => onChange({ ...plan, runbook: plan.runbook.filter(item => item.id !== task.id) })}>Remove this duty from the proposal</Button></div>)}
    {equipment.length === 0 ? <p>This plan has no allocated equipment requiring a named handover.</p> : <details><summary>Add a handover or return duty</summary><div className="pf-stack project-transfer-form">
      <div className="project-grid"><Select label="Duty" value={draft.kind} options={[{ value: 'handover', label: 'Handover' }, { value: 'return', label: 'Return' }]} onChange={event => setDraft({ ...draft, kind: event.target.value as TransferDraft['kind'] })} disabled={disabled} />
        <Field label="Duty name" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} disabled={disabled} /></div>
      <Select label="Allocated equipment" value={draft.allocationId} options={equipment.map(allocation => ({ value: allocation.id, label: `${publisherName(project, allocation.publisherRoot)} · ${allocation.resourceId} · ${allocation.quantity} ${allocation.unit}` }))} onChange={event => { const allocation = equipment.find(item => item.id === event.target.value); if (allocation) setDraft({ ...draft, allocationId: allocation.id, quantity: String(allocation.quantity), giver: allocation.publisherRoot }); }} disabled={disabled} />
      <div className="project-grid"><Select label="Giver" value={draft.giver} options={publisherOptions} onChange={event => setDraft({ ...draft, giver: event.target.value })} disabled={disabled} /><Select label="Receiver" value={draft.receiver} options={publisherOptions} onChange={event => setDraft({ ...draft, receiver: event.target.value })} disabled={disabled} /><Field label="Quantity" inputMode="numeric" value={draft.quantity} onChange={event => setDraft({ ...draft, quantity: event.target.value })} disabled={disabled} /></div>
      <p>Time zone: {plan.variant.timeZone}. Each named giver and receiver will need to agree to this plan.</p>
      <div className="project-grid"><Field label="Starts" type="datetime-local" value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })} disabled={disabled} /><Field label="Ends" type="datetime-local" value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })} disabled={disabled} /></div>
      <div className="project-grid"><Select label="Start clock-time occurrence" value={draft.startOccurrence} options={occurrences} onChange={event => setDraft({ ...draft, startOccurrence: event.target.value as TimeDisambiguation })} /><Select label="End clock-time occurrence" value={draft.endOccurrence} options={occurrences} onChange={event => setDraft({ ...draft, endOccurrence: event.target.value as TimeDisambiguation })} /></div>
      <fieldset><legend>Must follow these duties</legend>{plan.runbook.map(task => <Checkbox key={task.id} label={task.title} checked={draft.dependsOn.includes(task.id)} onChange={event => setDraft({ ...draft, dependsOn: event.target.checked ? [...draft.dependsOn, task.id] : draft.dependsOn.filter(id => id !== task.id) })} disabled={disabled} />)}</fieldset>
      <Textarea label="Handover instructions" value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} disabled={disabled} />
      {error && <Notice tone="warning" role="alert">{error}</Notice>}
      <Button variant="secondary" disabled={disabled} onClick={() => {
        const allocation = equipment.find(item => item.id === draft.allocationId); if (!allocation) return;
        if (!publisherOptions.some(item => item.value === draft.giver) || !publisherOptions.some(item => item.value === draft.receiver)) { setError('Both parties must be explicitly included contributors.'); return; }
        const result = transferDutyFromDraft(draft, allocation, plan, crypto.randomUUID()); setError(result.error);
        if (result.duty) { onChange({ ...plan, runbook: [...plan.runbook, result.duty] }); setDraft({ ...draft, title: '', dependsOn: [] }); }
      }}>Add this duty to the proposal</Button>
    </div></details>}
  </section>;
}
