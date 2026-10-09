import { useMemo, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { routeHref } from '../../app/routes';
import { formatDateTime, utcToLocalDateTime } from '../../app/time';
import { createOperationIntent } from '../../data/operations';
import type { EntityKey, EntityRecord, ProjectAggregate, Proposal, RecipeTemplate, RecordedOutcome, SourcePlanRef } from '../../domain/types';
import type { ReplaceBookCommand } from '../../data/types';
import { activeSource, deriveReadiness } from '../../domain/readiness';
import { deriveExecution, reuseRecipe } from '../../domain/execution';
import { Button, Checkbox, EmptyState, Field, Notice, Select, StatusLabel, Textarea } from '../../ui';
import { ActionFeedback } from '../projects/ActionFeedback';
import { createProjectDrafts, downloadText, draftScope, makeDraft } from '../projects/drafts';
import { templateToEditorDraft } from '../projects/editor';
import { authorityFor, ownsProject, publisherName, STATE_LIFETIME_SECONDS } from '../projects/selectors';
import { reasonText } from '../projects/catalog';
import { ownPublisherRoots, planVersions, prepareClosureCommand, prepareCustodyReleaseCommand, prepareProgressCommand, rowLabels, runbookRows, sourceForProposal, versionStatus } from './model';
import type { ProgressInput, RunbookRow } from './model';
import { ExecutionExports } from './ExecutionExports';
import { RepairPanel } from './RepairPanel';
import './execution.css';

function Duty({ row, project, proposal, source, blocked, onRecord }: {
  row: RunbookRow; project: ProjectAggregate; proposal: EntityRecord<Proposal>; source: SourcePlanRef | null;
  blocked: boolean; onRecord: (obligationId: string, input: ProgressInput) => void;
}) {
  const session = useAppSession(), owned = ownPublisherRoots(project, session.actor);
  const [quantity, setQuantity] = useState(''), [note, setNote] = useState(''), [ackQuantities, setAckQuantities] = useState<Record<string, string>>({});
  const duty = row.obligation, zone = proposal.payload.plan.variant.timeZone;
  const giver = duty.kind !== 'task' && owned.includes(duty.giver), receiver = duty.kind !== 'task' && owned.includes(duty.receiver);
  const canAct = !blocked && source !== null && row.status !== 'evidence_unavailable';
  const remaining = duty.kind === 'task' ? 0 : duty.quantity - row.reportedQuantity;
  return <article className="execution-duty">
    <div className="execution-duty-time"><time dateTime={new Date(duty.interval.start).toISOString()}>{formatDateTime(duty.interval.start, zone)}</time><span>until {formatDateTime(duty.interval.end, zone)}</span></div>
    <div className="pf-stack execution-duty-content"><header><h3>{duty.title}</h3><StatusLabel tone={row.status === 'evidence_unavailable' ? 'warning' : row.completed ? 'success' : row.status === 'not_reported' ? 'neutral' : 'warning'}>{rowLabels[row.status]}</StatusLabel></header>
      <p>{duty.kind === 'task' ? `Responsible: ${publisherName(project, duty.publisherRoot)}` : `${duty.quantity} ${duty.unit} · ${publisherName(project, duty.giver)} gives to ${publisherName(project, duty.receiver)}`}</p>
      {duty.instructions && <p>{duty.instructions}</p>}
      {duty.dependsOn.length > 0 && <p>After: {duty.dependsOn.map(id => proposal.payload.plan.runbook.find(item => item.id === id)?.title ?? id).join(', ')}</p>}
      <ul className="execution-resource-list">{duty.allocationIds.map(id => {
        const allocation = proposal.payload.plan.allocations.find(item => item.id === id);
        if (!allocation) return <li key={id}>Referenced resource unavailable: {id}</li>;
        const publisher = project.publishers.find(item => item.root.key === allocation.publisherRoot);
        const resource = publisher?.book.status === 'unique' ? publisher.book.entity.payload.resources.find(item => item.id === allocation.resourceId) : null;
        return <li key={id}>{allocation.quantity} {allocation.unit} · {resource?.name ?? allocation.resourceId} · {publisherName(project, allocation.publisherRoot)}
          {(allocation.interval.start !== duty.interval.start || allocation.interval.end !== duty.interval.end) && <span className="execution-detail">Reserved {formatDateTime(allocation.interval.start, zone)}–{formatDateTime(allocation.interval.end, zone)}, including any transfer time.</span>}</li>;
      })}</ul>
      {row.reports.map(report => <div className="execution-statement" key={report.id}><strong>{publisherName(project, report.author)} reported {report.kind === 'task_report' ? report.status === 'done' ? 'done' : 'incomplete' : report.kind === 'transfer_report' ? `${report.quantity} ${report.unit} given` : ''}</strong><span className="execution-detail">{formatDateTime(report.recordedAt, zone)}</span>{report.kind === 'task_report' && report.note && <p>{report.note}</p>}
        {report.kind === 'transfer_report' && <>{row.acknowledgements.filter(ack => ack.statementHash === report.statementHash).map(ack => <p key={ack.id}>{publisherName(project, ack.author)} acknowledged {ack.acknowledgedQuantity} {report.unit} at {formatDateTime(ack.recordedAt, zone)}.</p>)}
          {!row.acknowledgements.some(ack => ack.statementHash === report.statementHash) && <p className="execution-outstanding">The recipient has not acknowledged this report.</p>}
          {receiver && <div className="pf-actions"><Field label={`Quantity received from report at ${formatDateTime(report.recordedAt, zone)}`} type="number" min={1} max={report.quantity} step={1} value={ackQuantities[report.id] ?? String(report.quantity)} onChange={event => setAckQuantities(current => ({ ...current, [report.id]: event.target.value }))} />
            <Button variant="secondary" disabled={!canAct} onClick={() => onRecord(duty.id, { kind: 'transfer_acknowledgement', reportId: report.id, quantity: Number(ackQuantities[report.id] ?? report.quantity) })}>{row.acknowledgements.some(ack => ack.statementHash === report.statementHash) ? 'Correct my acknowledgement' : duty.kind === 'return' ? 'Confirm I received the return' : 'Confirm I received these items'}</Button></div>}
        </>}
      </div>)}
      {duty.kind === 'task' && owned.includes(duty.publisherRoot) && <div className="pf-stack"><Textarea label="My completion note" hint="This records your own report. It does not record anyone else’s agreement or receipt." value={note} maxLength={10000} onChange={event => setNote(event.target.value)} />
        <div className="pf-actions"><Button variant="secondary" disabled={!canAct || row.completed} onClick={() => onRecord(duty.id, { kind: 'task_report', status: 'done', note })}>Report my task done</Button>
          {row.reports.length > 0 && <Button variant="quiet" disabled={!canAct || row.status === 'reported_not_done'} onClick={() => onRecord(duty.id, { kind: 'task_report', status: 'not_done', note })}>Correct my task to incomplete</Button>}</div></div>}
      {giver && remaining > 0 && <div className="pf-actions"><Field label={duty.kind === 'return' ? 'Quantity I returned' : 'Quantity I handed over'} type="number" min={1} max={remaining} step={1} value={quantity || String(remaining)} onChange={event => setQuantity(event.target.value)} />
        <Button variant="secondary" disabled={!canAct} onClick={() => onRecord(duty.id, { kind: 'transfer_report', quantity: Number(quantity || remaining) })}>{duty.kind === 'return' ? 'Report my return' : 'Report my handover'}</Button></div>}
      {duty.kind !== 'task' && <p className="execution-detail">The giver reports the transfer. Only the named recipient can acknowledge receiving it.</p>}
    </div>
  </article>;
}

export function ExecutionWorkspace({ project, onRefresh, onReuse }: { project: ProjectAggregate; onRefresh: () => void | Promise<void>; onReuse?: (template: RecipeTemplate) => void }) {
  const runtime = useApp(), session = useAppSession();
  const [selectedKey, setSelectedKey] = useState<EntityKey | null>(null), [mine, setMine] = useState(false), [error, setError] = useState('');
  const [outcome, setOutcome] = useState<RecordedOutcome>('completed_with_outstanding'), [statement, setStatement] = useState(''), [reviewedClosure, setReviewedClosure] = useState(false);
  const [releaseReasons, setReleaseReasons] = useState<Record<string, string>>({}), [draftExport, setDraftExport] = useState<string | null>(null);
  const action = useRepositoryAction(`execution:${project.root.key}`), closeAction = useRepositoryAction(`execution-close:${project.root.key}`);
  const versions = planVersions(project), selected = versions.find(item => item.key === selectedKey) ?? project.proposal ?? versions[0] ?? null;
  const source = selected ? sourceForProposal(project, selected.key) : null;
  const rows = selected ? runbookRows(project, selected, source, session.actor) : [];
  const execution = deriveExecution(project), state = project.state.status === 'unique' ? project.state.entity.payload : null;
  const authority = authorityFor(session.actor, session.mode, session.chainId), coordinator = ownsProject(project, session.actor);
  const readiness = deriveReadiness(project, runtime.now());
  const blocked = [action.state.status, closeAction.state.status].some(status => status === 'submitting' || status === 'needs-verification');
  const owned = ownPublisherRoots(project, session.actor);
  const displayed = rows.filter(row => !mine || row.mine);
  const grouped = new Map<string, RunbookRow[]>();
  for (const row of displayed) {
    const day = utcToLocalDateTime(row.obligation.interval.start, selected!.payload.plan.variant.timeZone).slice(0, 10);
    grouped.set(day, [...grouped.get(day) ?? [], row]);
  }
  const completionFingerprint = useMemo(() => JSON.stringify({ root: project.root.key, completed: execution.completed, outstanding: execution.outstandingObligationIds, custody: execution.outstandingCustodyHolds }), [project, execution.completed, execution.outstandingObligationIds, execution.outstandingCustodyHolds]);
  const [reviewedFingerprint, setReviewedFingerprint] = useState('');
  async function record(obligationId: string, input: ProgressInput) {
    setError('');
    if (!selected || !source || !authority) return;
    try { const id = globalThis.crypto.randomUUID(); await action.run(prepareProgressCommand(project, selected, source, obligationId, authority, input, runtime.now(), id), (repository, command) => repository.replaceBook(command)); await onRefresh(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'The report could not be prepared.'); }
  }
  async function close() {
    setError('');
    if (!authority || !reviewedClosure || reviewedFingerprint !== completionFingerprint) return;
    try { await closeAction.run(prepareClosureCommand(project, authority, outcome, statement, runtime.now(), globalThis.crypto.randomUUID()), (repository, command) => repository.replaceProject(command)); await onRefresh(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'The outcome could not be recorded.'); }
  }
  async function start() {
    setError('');
    if (!authority || !state || project.state.status !== 'unique' || readiness.status !== 'ready' || !coordinator) return;
    try {
      const id = globalThis.crypto.randomUUID(), now = runtime.now();
      const input = { projectRoot: project.root.key, expectedHeads: [project.state.entity.key], lifetimeSeconds: STATE_LIFETIME_SECONDS,
        state: { ...state, lifecycle: 'in_progress' as const, operationId: id, createdAt: now, predecessorKeys: [project.state.entity.key] } };
      await closeAction.run({ ...input, operation: createOperationIntent('replace_project', authority, input, { id, now }) }, (repository, command) => repository.replaceProject(command)); await onRefresh();
    } catch { setError('The start could not be confirmed. Check the original request.'); }
  }
  async function release(publisherRoot: EntityKey, holdId: string) {
    if (!authority) return;
    setError('');
    try { await action.run(prepareCustodyReleaseCommand(project, publisherRoot, holdId, authority, releaseReasons[holdId] ?? '', runtime.now(), globalThis.crypto.randomUUID()), (repository, command) => repository.replaceBook(command)); await onRefresh(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'The owner release could not be recorded.'); }
  }
  function reuse() {
    setError('');
    const template = reuseRecipe(project);
    if (!template) { setError('The project recipe is unavailable. Refresh the project before reusing it.'); return; }
    if (onReuse) { onReuse(template); return; }
    const scope = draftScope(session.mode, session.actor), drafts = createProjectDrafts(runtime, scope);
    const draft = { ...makeDraft(scope, undefined, runtime.now()), editor: templateToEditorDraft(template) };
    const saved = drafts.upsert(draft);
    if (!saved.persisted) { setDraftExport(drafts.exportDraft(draft)); setError('The new draft could not be saved on this device. Download it below before leaving; your existing projects are retained.'); return; }
    runtime.session.selectDraft(draft.id); runtime.session.navigate({ name: 'new-project' });
    window.location.hash = routeHref({ name: 'new-project' });
  }
  return <section className="pf-stack execution-workspace" aria-label="Project runbook">
    <header><p className="pf-eyebrow">Conduct the project</p><h2>The shared runbook</h2><p>Follow the agreed times, report your own work, and confirm transfers from each side.</p></header>
    {selected ? <><Select label="Plan version" value={selected.key} onChange={event => setSelectedKey(event.target.value as EntityKey)} options={versions.map(item => ({ value: item.key, label: `${formatDateTime(item.payload.createdAt, item.payload.plan.variant.timeZone)} · ${item.payload.plan.variant.title}${activeSource(project)?.proposalKey === item.key ? ' · current' : ' · historical'}` }))} />
      <Notice tone={readiness.status === 'ready' && activeSource(project)?.proposalKey === selected.key ? 'success' : 'warning'} title={versionStatus(project, selected, runtime.now())}>
        <p>Data checked {formatDateTime(project.snapshot.fetchedAt, selected.payload.plan.variant.timeZone)} · {selected.payload.plan.variant.timeZone}. {state?.lifecycle === 'in_progress' ? 'Project in progress.' : state?.lifecycle === 'planning' ? 'Project has not been marked started.' : ''}</p>
        {readiness.status !== 'ready' && state?.lifecycle !== 'closed' && <p>Viewing this version does not make it ready. Actual progress remains a separate owner report.</p>}
        <a href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' })}>Open the complete plan and agreement</a>
      </Notice><details><summary>Exact version references</summary><p className="execution-id">Proposal {selected.key}<br />Hash {selected.payload.proposalHash}<br />Activation {source?.activationKey ?? 'Not available'}</p></details>
      <Checkbox label="My tasks and transfers" checked={mine} onChange={event => setMine(event.target.checked)} />
      {displayed.length === 0 && <EmptyState title={mine ? 'No tasks for the selected account in this version' : 'No runbook duties are available'} description={mine ? 'Switch off this filter to view the complete runbook.' : 'Review the complete plan before continuing.'} />}
      {[...grouped].map(([day, duties]) => <section className="pf-stack execution-day" aria-label={`Runbook for ${day}`} key={day}><h3>{formatDateTime(duties[0]!.obligation.interval.start, selected.payload.plan.variant.timeZone, { dateStyle: 'full', timeStyle: undefined })}</h3>{duties.map(row => <Duty key={`${selected.key}:${row.obligation.id}`} row={row} project={project} proposal={selected} source={source} blocked={blocked || !authority} onRecord={(id, input) => void record(id, input)} />)}</section>)}
    </> : <EmptyState title="No agreed runbook yet" description="Find a complete plan, name its transfers, then ask every required owner to agree." actions={<a href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'plans' })}>Find a plan</a>} />}
    <div className="pf-actions"><Button variant="secondary" onClick={() => void onRefresh()}>Refresh current records</Button>{coordinator && state?.lifecycle === 'planning' && <Button disabled={blocked || !authority || readiness.status !== 'ready'} disabledReason="Everyone must agree to the current exact version before the project is marked started." onClick={() => void start()}>Mark project in progress</Button>}</div>
    {error && <Notice tone="warning" role="alert">{error}</Notice>}
    <ActionFeedback state={action.state} onReconcile={() => void action.reconcile().then(() => onRefresh())} onResume={() => void action.resume<ReplaceBookCommand, unknown>((repository, command) => repository.replaceBook(command)).then(() => onRefresh())} />
    <RepairPanel project={project} onRefresh={onRefresh} />
    <section className="pf-stack execution-completion" aria-label="Completion review"><h2>{state?.completion ? 'Recorded project outcome' : 'Completion review'}</h2>
      {state?.completion && <Notice title={state.completion.outcome.replaceAll('_', ' ')}><p>Recorded {formatDateTime(state.completion.recordedAt, state.recipe.timeZone)}.</p><p>{state.completion.statement}</p><p>{state.completion.outstandingObligationIds.length} unfinished duties and {state.completion.outstandingCustodyHoldIds.length} equipment holds were recorded at closure. Later owner updates remain separate.</p></Notice>}
      <p>{execution.completed.length} owner-reported completed duties; {execution.outstandingObligationIds.length} duties still outstanding. Supporting evidence: {execution.evidenceAvailability}.</p>
      <ul>{execution.completed.map(work => <li key={`${work.source.activationKey}:${work.obligationId}`}>Reported complete: {versions.flatMap(version => version.payload.plan.runbook).find(duty => duty.id === work.obligationId)?.title ?? work.obligationId} · {work.evidenceAvailability} evidence · original version retained.</li>)}
        {execution.outstandingObligationIds.map(id => <li key={id}>Outstanding: {versions.flatMap(version => version.payload.plan.runbook).find(duty => duty.id === id)?.title ?? id}</li>)}</ul>
      {execution.reasons.length > 0 && <ul>{execution.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul>}
      <h3>Equipment still awaiting return or owner release</h3>
      {!execution.outstandingCustodyHolds.length && <p>No outstanding custody hold appears in these records.</p>}
      {execution.outstandingCustodyHolds.map(hold => {
        const owner = project.publishers.find(publisher => publisher.book.status === 'unique' && publisher.book.entity.payload.custodyHolds.some(item => item.id === hold.id));
        return <article className="execution-statement" key={hold.id}><p><strong>{hold.quantity} {hold.unit} · {hold.resourceId}</strong> · {owner ? publisherName(project, owner.root.key) : 'Owner unavailable'}</p><p>The physical return remains outstanding. Closing or cancelling the project does not release this hold.</p>
          {owner && owned.includes(owner.root.key) && <><Field label="My reason for releasing this equipment hold" value={releaseReasons[hold.id] ?? ''} maxLength={10000} onChange={event => setReleaseReasons(current => ({ ...current, [hold.id]: event.target.value }))} /><Button variant="secondary" disabled={blocked || !authority || !releaseReasons[hold.id]?.trim()} onClick={() => void release(owner.root.key, hold.id)}>Record my owner release</Button></>}
        </article>;
      })}
      {state?.lifecycle !== 'closed' && coordinator && <><p>Record the actual result. Outstanding work and returns remain visible; this action does not create another person’s acknowledgement. Timed commitments remain until their owner releases them or their exact deadline passes.</p>
        <Select label="Final outcome" value={outcome} onChange={event => { setOutcome(event.target.value as RecordedOutcome); setReviewedClosure(false); }} options={[{ value: 'completed', label: 'Completed · no outstanding items' }, { value: 'completed_with_outstanding', label: 'Completed with outstanding items' }, { value: 'cancelled', label: 'Cancelled' }]} />
        <Textarea label="What actually happened" value={statement} maxLength={10000} onChange={event => setStatement(event.target.value)} />
        <Checkbox label="I reviewed the completed work, outstanding duties and equipment holds above." checked={reviewedClosure && reviewedFingerprint === completionFingerprint} onChange={event => { setReviewedClosure(event.target.checked); setReviewedFingerprint(completionFingerprint); }} />
        {session.mode === 'public' && <p>This outcome and statement will be public. Earlier network history is not erased.</p>}
        <Button disabled={blocked || !authority || !reviewedClosure || reviewedFingerprint !== completionFingerprint || !statement.trim()} onClick={() => void close()}>Record this final outcome</Button></>}
      <ActionFeedback state={closeAction.state} onReconcile={() => void closeAction.reconcile().then(() => onRefresh())} />
    </section>
    <section className="pf-stack"><h2>Use the recipe again</h2><p>Create a separate local draft with these needs and useful settings. Choose new dates and invite current contributions. Old assignments, occupied times, decisions and progress are not copied.</p><Button variant="secondary" disabled={!state} onClick={reuse}>Use as a starting point</Button>{draftExport && <Button variant="secondary" onClick={() => { try { downloadText('partfolk-reused-draft.json', draftExport); } catch { setError('The draft download could not start. Keep this page open and try again.'); } }}>Download the unsaved new draft</Button>}</section>
    <ExecutionExports project={project} selectedProposalKey={selected?.key} />
  </section>;
}
