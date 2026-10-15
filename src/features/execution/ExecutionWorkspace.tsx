import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { routeHref } from '../../app/routes';
import { formatDateTime, utcToLocalDateTime } from '../../app/time';
import { createOperationIntent } from '../../data/operations';
import type { Actor, EntityKey, EntityRecord, ProjectAggregate, Proposal, RecipeTemplate, RecordedOutcome, RunbookObligation, SourcePlanRef } from '../../domain/types';
import type { ReplaceBookCommand, WriteAuthority } from '../../data/types';
import { activeSource, deriveReadiness, sameActor } from '../../domain/readiness';
import { deriveExecution, reuseRecipe } from '../../domain/execution';
import { Button, Checkbox, Dialog, EmptyState, Field, Notice, Select, StatusLabel, Textarea } from '../../ui';
import { ActionFeedback } from '../projects/ActionFeedback';
import { createProjectDrafts, downloadText, draftScope, makeDraft } from '../projects/drafts';
import { templateToEditorDraft } from '../projects/editor';
import { authorityFor, ownsProject, publisherName, STATE_LIFETIME_SECONDS } from '../projects/selectors';
import { reasonText } from '../projects/catalog';
import { completionReviewFingerprint, ownPublisherRoots, planVersions, prepareClosureCommand, prepareCustodyReleaseCommand, prepareProgressCommand, rowLabels, runbookRows, sourceForProposal, transferQuantity, versionStatus } from './model';
import type { ProgressInput, RunbookRow } from './model';
import { ExecutionExports } from './ExecutionExports';
import { RepairPanel } from './RepairPanel';
import './execution.css';

interface ProgressReview { actor: Actor; source: SourcePlanRef; duty: RunbookObligation; input: ProgressInput; id: string }
interface ReleaseReview { actor: Actor; publisherRoot: EntityKey; holdId: string; reason: string; title: string }

function Duty({ row, project, proposal, source, blocked, onRecord }: {
  row: RunbookRow; project: ProjectAggregate; proposal: EntityRecord<Proposal>; source: SourcePlanRef | null;
  blocked: boolean; onRecord: (obligationId: string, input: ProgressInput) => void;
}) {
  const session = useAppSession(), owned = ownPublisherRoots(project, session.actor);
  const [quantity, setQuantity] = useState<string | undefined>(), [note, setNote] = useState(''), [ackQuantities, setAckQuantities] = useState<Record<string, string>>({});
  const [correctedQuantities, setCorrectedQuantities] = useState<Record<string, string>>({});
  const duty = row.obligation, zone = proposal.payload.plan.variant.timeZone;
  const giver = duty.kind !== 'task' && owned.includes(duty.giver), receiver = duty.kind !== 'task' && owned.includes(duty.receiver);
  const canAct = !blocked && source !== null && row.status !== 'evidence_unavailable';
  const remaining = duty.kind === 'task' ? 0 : duty.quantity - row.reportedQuantity;
  const quantityRaw = quantity ?? String(remaining), parsedQuantity = transferQuantity(quantityRaw, remaining);
  useEffect(() => { setQuantity(undefined); setNote(''); setAckQuantities({}); setCorrectedQuantities({}); },
    [session.actor, session.mode, session.chainId]);
  return <article className="execution-duty" id={`runbook-duty-${duty.id}`} tabIndex={-1}>
    <div className="execution-duty-time"><time dateTime={new Date(duty.interval.start).toISOString()}>{formatDateTime(duty.interval.start, zone)}</time><span>until {formatDateTime(duty.interval.end, zone)}</span></div>
    <div className="pf-stack execution-duty-content"><header><div className="execution-duty-title"><StatusLabel>{duty.kind === 'task' ? 'Task' : duty.kind === 'handover' ? 'Handover' : 'Return'}</StatusLabel><h4>{duty.title}</h4></div><StatusLabel tone={row.status === 'evidence_unavailable' ? 'warning' : row.completed ? 'success' : row.status === 'not_reported' ? 'neutral' : 'warning'}>{rowLabels[row.status]}</StatusLabel></header>
      <p>{duty.kind === 'task' ? `Responsible: ${publisherName(project, duty.publisherRoot)}` : `${publisherName(project, duty.giver)} gives ${duty.quantity} ${duty.unit} to ${publisherName(project, duty.receiver)}`}</p>
      {duty.instructions && <p>{duty.instructions}</p>}
      {duty.dependsOn.length > 0 && <p>After: {duty.dependsOn.map(id => proposal.payload.plan.runbook.find(item => item.id === id)?.title ?? id).join(', ')}</p>}
      <ul className="execution-resource-list">{duty.allocationIds.map(id => {
        const allocation = proposal.payload.plan.allocations.find(item => item.id === id);
        if (!allocation) return <li key={id}>Referenced resource unavailable: {id}</li>;
        const publisher = project.publishers.find(item => item.root.key === allocation.publisherRoot);
        const resource = publisher?.book.status === 'unique' ? publisher.book.entity.payload.resources.find(item => item.id === allocation.resourceId) : null;
        return <li key={id}>{allocation.quantity} {allocation.unit} of {resource?.name ?? allocation.resourceId} from {publisherName(project, allocation.publisherRoot)}
          {(allocation.interval.start !== duty.interval.start || allocation.interval.end !== duty.interval.end) && <span className="execution-detail">Reserved {formatDateTime(allocation.interval.start, zone)}–{formatDateTime(allocation.interval.end, zone)}, including any transfer time.</span>}</li>;
      })}</ul>
      {row.reports.map(report => {
        const correctionRaw = correctedQuantities[report.id] ?? String(report.kind === 'transfer_report' ? report.quantity : '');
        const acknowledgementRaw = ackQuantities[report.id] ?? String(report.kind === 'transfer_report' ? report.quantity : '');
        const corrected = report.kind === 'transfer_report' ? transferQuantity(correctionRaw, remaining + report.quantity) : null;
        const acknowledged = report.kind === 'transfer_report' ? transferQuantity(acknowledgementRaw, report.quantity) : null;
        return <div className="execution-statement" key={report.id}><strong>{publisherName(project, report.author)} reported {report.kind === 'task_report' ? report.status === 'done' ? 'done' : 'incomplete' : report.kind === 'transfer_report' ? `${report.quantity} ${report.unit} given` : ''}</strong><span className="execution-detail">{formatDateTime(report.recordedAt, zone)}</span>{report.kind === 'task_report' && report.note && <p>{report.note}</p>}
        {report.kind === 'transfer_report' && <>{row.acknowledgements.filter(ack => ack.statementHash === report.statementHash).map(ack => <p key={ack.id}>{publisherName(project, ack.author)} acknowledged {ack.acknowledgedQuantity} {report.unit} at {formatDateTime(ack.recordedAt, zone)}.</p>)}
          {!row.acknowledgements.some(ack => ack.statementHash === report.statementHash) && <p className="execution-outstanding">The recipient has not acknowledged this report.</p>}
          {giver && <div className="pf-stack"><div className="pf-actions"><Field label={duty.kind === 'return' ? 'Corrected quantity I returned' : 'Corrected quantity I handed over'} type="number" min={1} max={remaining + report.quantity} step={1} value={correctionRaw} error={corrected === null ? `Enter a whole number from 1 to ${remaining + report.quantity}.` : undefined} onChange={event => setCorrectedQuantities(current => ({ ...current, [report.id]: event.target.value }))} />
            <Button variant="quiet" disabled={!canAct || corrected === null || corrected === report.quantity} onClick={() => corrected !== null && onRecord(duty.id, { kind: 'transfer_report', correctsReportId: report.id, quantity: corrected })}>Correct my transfer report</Button></div><p className="execution-detail">The original report stays in history. The recipient must confirm the corrected report separately.</p></div>}
          {receiver && <div className="pf-actions"><Field label={`Quantity received from report at ${formatDateTime(report.recordedAt, zone)}`} type="number" min={1} max={report.quantity} step={1} value={acknowledgementRaw} error={acknowledged === null ? `Enter a whole number from 1 to ${report.quantity}.` : undefined} onChange={event => setAckQuantities(current => ({ ...current, [report.id]: event.target.value }))} />
            <Button variant="secondary" disabled={!canAct || acknowledged === null} onClick={() => acknowledged !== null && onRecord(duty.id, { kind: 'transfer_acknowledgement', reportId: report.id, quantity: acknowledged })}>{row.acknowledgements.some(ack => ack.statementHash === report.statementHash) ? 'Correct my acknowledgement' : duty.kind === 'return' ? 'Confirm I received the return' : 'Confirm I received these items'}</Button></div>}
        </>}
      </div>; })}
      {row.historicalStatements.length > 0 && <details><summary>Earlier reports and acknowledgements</summary><p>These earlier statements remain in history and do not confirm a corrected transfer.</p><ul>{row.historicalStatements.map(item => <li key={item.id}>{publisherName(project, item.author)} {item.kind === 'transfer_report' ? `reported ${item.quantity} ${item.unit}` : item.kind === 'transfer_acknowledgement' ? `acknowledged ${item.acknowledgedQuantity}` : `reported ${item.status === 'done' ? 'done' : 'incomplete'}`} at {formatDateTime(item.recordedAt, zone)}.</li>)}</ul></details>}
      {duty.kind === 'task' && owned.includes(duty.publisherRoot) && <div className="pf-stack"><Textarea label="My completion note" hint="This records your own report. It does not record anyone else’s agreement or receipt." value={note} maxLength={10000} onChange={event => setNote(event.target.value)} />
        <div className="pf-actions"><Button variant="secondary" disabled={!canAct || row.completed} onClick={() => onRecord(duty.id, { kind: 'task_report', status: 'done', note })}>Report my task done</Button>
          {row.reports.length > 0 && <Button variant="quiet" disabled={!canAct || row.status === 'reported_not_done'} onClick={() => onRecord(duty.id, { kind: 'task_report', status: 'not_done', note })}>Correct my task to incomplete</Button>}</div></div>}
      {giver && remaining > 0 && <div className="pf-actions"><Field label={duty.kind === 'return' ? 'Quantity I returned' : 'Quantity I handed over'} type="number" min={1} max={remaining} step={1} value={quantityRaw} error={parsedQuantity === null ? `Enter a whole number from 1 to ${remaining}.` : undefined} onChange={event => setQuantity(event.target.value)} />
        <Button variant="secondary" disabled={!canAct || parsedQuantity === null} onClick={() => parsedQuantity !== null && onRecord(duty.id, { kind: 'transfer_report', quantity: parsedQuantity })}>{duty.kind === 'return' ? 'Report my return' : 'Report my handover'}</Button></div>}
      {duty.kind !== 'task' && <p className="execution-detail">The giver reports the transfer. Only the named recipient can acknowledge receiving it.</p>}
    </div>
  </article>;
}

export function ExecutionWorkspace({ project, onRefresh, onReuse }: { project: ProjectAggregate; onRefresh: () => void | Promise<void>; onReuse?: (template: RecipeTemplate) => void }) {
  const runtime = useApp(), session = useAppSession();
  const exportId = useId();
  const [selectedKey, setSelectedKey] = useState<EntityKey | null>(null), [mine, setMine] = useState(false), [error, setError] = useState('');
  const [reviewTransfer, setReviewTransfer] = useState<string | null>(null);
  const [progressReview, setProgressReview] = useState<ProgressReview | null>(null), [releaseReview, setReleaseReview] = useState<ReleaseReview | null>(null);
  const [checking, setChecking] = useState(false), working = useRef(false);
  const [outcome, setOutcome] = useState<RecordedOutcome>('completed_with_outstanding'), [statement, setStatement] = useState(''), [reviewedClosure, setReviewedClosure] = useState(false);
  const [releaseReasons, setReleaseReasons] = useState<Record<string, string>>({}), [draftExport, setDraftExport] = useState<string | null>(null);
  const action = useRepositoryAction(`execution:${project.root.key}`), closeAction = useRepositoryAction(`execution-close:${project.root.key}`);
  const versions = planVersions(project), selected = versions.find(item => item.key === selectedKey) ?? project.proposal ?? versions[0] ?? null;
  const source = selected ? sourceForProposal(project, selected.key) : null;
  const rows = selected ? runbookRows(project, selected, source, session.actor) : [];
  useEffect(() => {
    if (reviewTransfer && selected) {
      document.getElementById(`runbook-duty-${reviewTransfer}`)?.focus();
      setReviewTransfer(null);
    }
  }, [reviewTransfer, selected?.key, project.proposal?.key]);
  const execution = deriveExecution(project), state = project.state.status === 'unique' ? project.state.entity.payload : null;
  const authority = authorityFor(session.actor, session.mode, session.chainId), coordinator = ownsProject(project, session.actor);
  const readiness = deriveReadiness(project, runtime.now());
  const blocked = checking || [action.state.status, closeAction.state.status].some(status => status === 'submitting' || status === 'needs-verification');
  const owned = ownPublisherRoots(project, session.actor);
  const displayed = rows.filter(row => !mine || row.mine);
  const nextDuty = rows.find(row => row.mine && !row.completed);
  const grouped = new Map<string, RunbookRow[]>();
  for (const row of displayed) {
    const day = utcToLocalDateTime(row.obligation.interval.start, selected!.payload.plan.variant.timeZone).slice(0, 10);
    grouped.set(day, [...grouped.get(day) ?? [], row]);
  }
  const completionFingerprint = useMemo(() => completionReviewFingerprint(project), [project]);
  const [reviewedFingerprint, setReviewedFingerprint] = useState('');
  useEffect(() => { setProgressReview(null); setReleaseReview(null); setReviewedClosure(false); setError(''); },
    [session.actor, session.mode, session.chainId, selected?.key, source?.activationKey, source?.proposalHash]);
  async function withCurrentProject(expectedActor: Actor, perform: (fresh: ProjectAggregate, authority: WriteAuthority) => Promise<void>) {
    if (working.current || blocked || !runtime.repository) return;
    working.current = true; setChecking(true); setError('');
    try {
      const fresh = await runtime.repository.loadProject(project.root.key);
      if (!fresh.ok) throw new Error('The current project could not be checked. Your change has not been sent. Refresh and review it again.');
      const current = runtime.session.getSnapshot(), currentAuthority = authorityFor(current.actor, current.mode, current.chainId);
      if (!currentAuthority || !sameActor(currentAuthority.actor, expectedActor)) throw new Error('The connected account changed. Review this action with the current owner.');
      await perform(fresh.value, currentAuthority);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'The change could not be prepared.'); }
    finally { try { await onRefresh(); } finally { working.current = false; setChecking(false); } }
  }
  function record(obligationId: string, input: ProgressInput) {
    setError('');
    if (blocked || !selected || !source || !authority) return;
    try {
      const id = globalThis.crypto.randomUUID();
      prepareProgressCommand(project, selected, source, obligationId, authority, input, runtime.now(), id);
      const duty = selected.payload.plan.runbook.find(item => item.id === obligationId)!;
      setProgressReview(structuredClone({ actor: authority.actor, source, duty, input, id }));
    }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'The report could not be prepared.'); }
  }
  async function confirmProgress() {
    if (!progressReview) return;
    const review = progressReview;
    await withCurrentProject(review.actor, async (fresh, currentAuthority) => {
      const proposal = planVersions(fresh).find(item => item.key === review.source.proposalKey);
      if (!proposal) throw new Error('The plan you reviewed is unavailable. Refresh before recording your report.');
      const result = await action.run(prepareProgressCommand(fresh, proposal, review.source, review.duty.id, currentAuthority, review.input, runtime.now(), review.id), (repository, command) => repository.replaceBook(command));
      if (result.ok) setProgressReview(null);
    });
  }
  async function close() {
    if (!authority || !reviewedClosure || reviewedFingerprint !== completionFingerprint) return;
    await withCurrentProject(authority.actor, async (fresh, currentAuthority) => {
      if (completionReviewFingerprint(fresh) !== reviewedFingerprint) { setReviewedClosure(false); throw new Error('The completed work or outstanding items changed. Review the updated completion summary before closing the project.'); }
      await closeAction.run(prepareClosureCommand(fresh, currentAuthority, outcome, statement, runtime.now(), globalThis.crypto.randomUUID()), (repository, command) => repository.replaceProject(command));
    });
  }
  async function start() {
    if (!authority || !state || project.state.status !== 'unique' || readiness.status !== 'ready' || !coordinator) return;
    await withCurrentProject(authority.actor, async (fresh, currentAuthority) => {
      if (!ownsProject(fresh, currentAuthority.actor) || fresh.state.status !== 'unique' || fresh.state.entity.payload.lifecycle !== 'planning' || deriveReadiness(fresh, runtime.now()).status !== 'ready') throw new Error('The current plan is no longer ready to start. Review its agreement before continuing.');
      const id = globalThis.crypto.randomUUID(), now = runtime.now();
      const input = { projectRoot: fresh.root.key, expectedHeads: [fresh.state.entity.key], lifetimeSeconds: STATE_LIFETIME_SECONDS,
        state: { ...fresh.state.entity.payload, lifecycle: 'in_progress' as const, operationId: id, createdAt: now, predecessorKeys: [fresh.state.entity.key] } };
      await closeAction.run({ ...input, operation: createOperationIntent('replace_project', currentAuthority, input, { id, now }) }, (repository, command) => repository.replaceProject(command));
    });
  }
  async function confirmRelease() {
    if (!releaseReview) return;
    const review = releaseReview;
    await withCurrentProject(review.actor, async (fresh, currentAuthority) => {
      const result = await action.run(prepareCustodyReleaseCommand(fresh, review.publisherRoot, review.holdId, currentAuthority, review.reason, runtime.now(), globalThis.crypto.randomUUID()), (repository, command) => repository.replaceBook(command));
      if (result.ok) setReleaseReview(null);
    });
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
    <header className="execution-heading"><div><h2>Run sheet</h2><p>Follow the agreed times, report your work and confirm equipment transfers.</p></div><Button variant="secondary" onClick={() => { const target = document.getElementById(exportId); target?.scrollIntoView({ block: 'start' }); target?.focus({ preventScroll: true }); }}>Export run sheet</Button></header>
    {selected ? <><section className="pf-sheet execution-overview"><dl><div><dt>Duties in this version</dt><dd>{rows.length}</dd></div><div><dt>Reported complete</dt><dd>{rows.filter(row => row.completed).length}</dd></div><div><dt>Still to resolve</dt><dd>{rows.filter(row => !row.completed).length}</dd></div></dl>{nextDuty && <div className="execution-next"><div><h3>Your next unfinished duty</h3><p>{nextDuty.obligation.title}</p></div><Button onClick={() => { setMine(false); setReviewTransfer(nextDuty.obligation.id); }}>Review my duty</Button></div>}</section><div className="execution-version"><Select label="Plan version" value={selected.key} onChange={event => setSelectedKey(event.target.value as EntityKey)} options={versions.map(item => ({ value: item.key, label: `${item.payload.plan.variant.title}, ${formatDateTime(item.payload.createdAt, item.payload.plan.variant.timeZone)}${activeSource(project)?.proposalKey === item.key ? ' (current)' : ' (historical)'}` }))} />
      <Checkbox label="My tasks and transfers" checked={mine} onChange={event => setMine(event.target.checked)} /></div>
      <Notice tone={readiness.status === 'ready' && activeSource(project)?.proposalKey === selected.key ? 'success' : 'warning'} title={versionStatus(project, selected, runtime.now())}>
        <p>{state?.lifecycle === 'in_progress' ? 'The project is in progress.' : state?.lifecycle === 'planning' ? 'The project has not started yet.' : 'This is the recorded project outcome.'}</p>
        <a href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' })}>Open the complete plan and agreement</a>
      </Notice><details><summary>Advanced</summary><h3>Version and record details</h3><p>Last checked {formatDateTime(project.snapshot.fetchedAt, selected.payload.plan.variant.timeZone)} ({selected.payload.plan.variant.timeZone}). Progress is recorded separately by each contributor.</p><p className="execution-id">Proposal {selected.key}<br />Hash {selected.payload.proposalHash}<br />Activation {source?.activationKey ?? 'Not available'}</p></details>
      {displayed.length === 0 && <EmptyState title={mine ? 'No tasks for the selected account in this version' : 'No runbook duties are available'} description={mine ? 'Switch off this filter to view the complete runbook.' : 'Review the complete plan before continuing.'} />}
      {[...grouped].map(([day, duties]) => <section className="pf-sheet pf-stack execution-day" aria-label={`Runbook for ${day}`} key={day}><h3>{formatDateTime(duties[0]!.obligation.interval.start, selected.payload.plan.variant.timeZone, { dateStyle: 'full', timeStyle: undefined })}</h3>{duties.map(row => <Duty key={`${selected.key}:${row.obligation.id}`} row={row} project={project} proposal={selected} source={source} blocked={blocked || !authority} onRecord={(id, input) => void record(id, input)} />)}</section>)}
    </> : <EmptyState title="No agreed runbook yet" description="Find a complete plan, name its transfers, then ask every required owner to agree." actions={<a href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'plans' })}>Find a plan</a>} />}
    <div className="pf-actions"><Button variant="secondary" onClick={() => void onRefresh()}>Refresh current records</Button>{coordinator && state?.lifecycle === 'planning' && <Button disabled={blocked || !authority || readiness.status !== 'ready'} disabledReason="Everyone must agree to the current exact version before the project is marked started." onClick={() => void start()}>Mark project in progress</Button>}</div>
    {error && <Notice tone="warning" role="alert">{error}</Notice>}
    <ActionFeedback state={action.state} action={action} onReconcile={() => void action.reconcile().then(() => onRefresh())} onResume={() => void action.resume<ReplaceBookCommand, unknown>((repository, command) => repository.replaceBook(command)).then(() => onRefresh())} />
    <RepairPanel project={project} onRefresh={onRefresh} onReviewTransfer={id => { setSelectedKey(project.proposal?.key ?? null); setMine(false); setReviewTransfer(id); }} />
    <section className="pf-sheet pf-stack execution-completion" aria-label="Completion review"><h2>{state?.completion ? 'Recorded project outcome' : 'Completion review'}</h2>
      {state?.completion && <Notice title={state.completion.outcome.replaceAll('_', ' ')}><p>Recorded {formatDateTime(state.completion.recordedAt, state.recipe.timeZone)}.</p><p>{state.completion.statement}</p><p>{state.completion.outstandingObligationIds.length} unfinished duties and {state.completion.outstandingCustodyHoldIds.length} equipment holds were recorded at closure. Later owner updates remain separate.</p></Notice>}
      <p>{execution.completed.length} owner-reported completed duties; {execution.outstandingObligationIds.length} duties still outstanding. Supporting evidence: {execution.evidenceAvailability}.</p>
      <ul>{execution.completed.map(work => <li key={`${work.source.activationKey}:${work.obligationId}`}>Reported complete: {versions.flatMap(version => version.payload.plan.runbook).find(duty => duty.id === work.obligationId)?.title ?? work.obligationId}. Evidence is {work.evidenceAvailability}; the original version is retained.</li>)}
        {execution.outstandingObligationIds.map(id => <li key={id}>Outstanding: {versions.flatMap(version => version.payload.plan.runbook).find(duty => duty.id === id)?.title ?? id}</li>)}</ul>
      {execution.reasons.length > 0 && <ul>{execution.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul>}
      <h3>Equipment still awaiting return or owner release</h3>
      {!execution.outstandingCustodyHolds.length && <p>No outstanding custody hold appears in these records.</p>}
      {execution.outstandingCustodyHolds.map(hold => {
        const owner = project.publishers.find(publisher => publisher.book.status === 'unique' && publisher.book.entity.payload.custodyHolds.some(item => item.id === hold.id));
        const resource = owner?.book.status === 'unique' ? owner.book.entity.payload.resources.find(item => item.id === hold.resourceId) : null;
        const title = `${resource?.name ?? 'Equipment'}: ${hold.quantity} ${hold.unit}`;
        return <article className="execution-statement" key={hold.id}><p><strong>{title}</strong> from {owner ? publisherName(project, owner.root.key) : 'an unavailable owner'}</p><p>The physical return remains outstanding. Closing or cancelling the project does not release this hold.</p>
          {owner && owned.includes(owner.root.key) && <><Field label="My reason for releasing this equipment hold" value={releaseReasons[hold.id] ?? ''} maxLength={10000} onChange={event => setReleaseReasons(current => ({ ...current, [hold.id]: event.target.value }))} /><Button variant="secondary" disabled={blocked || !authority || !releaseReasons[hold.id]?.trim()} onClick={() => authority && setReleaseReview({ actor: structuredClone(authority.actor), publisherRoot: owner.root.key, holdId: hold.id, title, reason: releaseReasons[hold.id] ?? '' })}>Review my owner release</Button></>}
        </article>;
      })}
      {state?.lifecycle !== 'closed' && coordinator && <><p>Record the actual result. Outstanding work and returns remain visible; this action does not create another person’s acknowledgement. Timed commitments remain until their owner releases them or their exact deadline passes.</p>
        <Select label="Final outcome" value={outcome} onChange={event => { setOutcome(event.target.value as RecordedOutcome); setReviewedClosure(false); }} options={[{ value: 'completed', label: 'Completed with no outstanding items' }, { value: 'completed_with_outstanding', label: 'Completed with outstanding items' }, { value: 'cancelled', label: 'Cancelled' }]} />
        <Textarea label="What actually happened" value={statement} maxLength={10000} onChange={event => { setStatement(event.target.value); setReviewedClosure(false); }} />
        <Checkbox label="I reviewed the completed work, outstanding duties and equipment holds above." checked={reviewedClosure && reviewedFingerprint === completionFingerprint} onChange={event => { setReviewedClosure(event.target.checked); setReviewedFingerprint(completionFingerprint); }} />
        {session.mode === 'public' && <p>This outcome and statement will be public. Earlier network history is not erased.</p>}
        <Button disabled={blocked || !authority || !reviewedClosure || reviewedFingerprint !== completionFingerprint || !statement.trim()} onClick={() => void close()}>Record this final outcome</Button></>}
      <ActionFeedback state={closeAction.state} action={closeAction} onReconcile={() => void closeAction.reconcile().then(() => onRefresh())} />
    </section>
    <section className="pf-sheet pf-stack"><h2>Use the recipe again</h2><p>Prepare a new project in Partfolk with these needs and useful settings. Choose fresh dates and invite current contributions. Earlier assignments and agreements stay with this event.</p><Button variant="secondary" disabled={!state} onClick={reuse}>Use as a starting point</Button>{draftExport && <Button variant="secondary" onClick={() => { try { downloadText('partfolk-reused-draft.json', draftExport); } catch { setError('The draft download could not start. Keep this page open and try again.'); } }}>Download the unsaved new draft</Button>}</section>
    <ExecutionExports id={exportId} project={project} selectedProposalKey={selected?.key} />
    <Dialog open={progressReview !== null} title={progressReview?.input.kind === 'transfer_acknowledgement' ? 'Review my receipt' : 'Review my report'} closeLabel="Cancel" onClose={() => { if (!blocked) setProgressReview(null); }} footer={<><Button variant="secondary" disabled={blocked} onClick={() => setProgressReview(null)}>Cancel</Button><Button disabled={blocked || !authority || !progressReview || !sameActor(authority.actor, progressReview.actor)} onClick={() => void confirmProgress()}>{checking ? 'Checking current records…' : progressReview?.input.kind === 'transfer_acknowledgement' ? 'Publish my acknowledgement' : 'Publish my report'}</Button></>}>
      {progressReview && <div className="pf-stack"><h3>{progressReview.duty.title}</h3><p>{progressReview.input.kind === 'task_report' ? `I report my task ${progressReview.input.status === 'done' ? 'done' : 'incomplete'}.` : progressReview.duty.kind !== 'task' ? `${progressReview.input.kind === 'transfer_acknowledgement' ? 'I received' : progressReview.duty.kind === 'return' ? 'I returned' : 'I handed over'} ${progressReview.input.quantity} ${progressReview.duty.unit}.` : ''}</p>
        {progressReview.input.kind === 'task_report' && progressReview.input.note && <p>{progressReview.input.note}</p>}
        {progressReview.input.kind === 'transfer_report' && <Notice>{progressReview.input.correctsReportId ? 'This corrects your report. The recipient must acknowledge the corrected quantity separately; earlier reports stay in history.' : 'The recipient must record their own acknowledgement. Your report alone does not confirm that the items were received.'}</Notice>}
        {progressReview.input.kind === 'transfer_acknowledgement' && <Notice>This acknowledges the selected giver’s report and your received quantity. It does not acknowledge any other transfer.</Notice>}
        <p className="pf-secondary">{session.mode === 'public' ? 'Your statement will be public. Confirm this action in your own wallet.' : 'This records your side of the transfer or task in this practice project.'}</p>{error && <Notice tone="warning" role="alert">{error}</Notice>}<ActionFeedback state={action.state} action={action} onReconcile={() => void action.reconcile().then(() => onRefresh())} />
      </div>}
    </Dialog>
    <Dialog open={releaseReview !== null} title="Review my equipment release" closeLabel="Cancel" onClose={() => { if (!blocked) setReleaseReview(null); }} footer={<><Button variant="secondary" disabled={blocked} onClick={() => setReleaseReview(null)}>Cancel</Button><Button disabled={blocked || !authority || !releaseReview || !sameActor(authority.actor, releaseReview.actor)} onClick={() => void confirmRelease()}>{checking ? 'Checking current records…' : 'Publish my owner release'}</Button></>}>
      {releaseReview && <div className="pf-stack"><h3>{releaseReview.title}</h3><p>{releaseReview.reason}</p><Notice tone="warning">You are releasing your equipment hold. This records your decision as owner; it does not confirm a physical return or another person’s receipt.</Notice><p className="pf-secondary">{session.mode === 'public' ? 'Your release and reason will be public. Your own wallet must approve this action.' : 'This release applies to the current practice project.'}</p>{error && <Notice tone="warning" role="alert">{error}</Notice>}<ActionFeedback state={action.state} action={action} onReconcile={() => void action.reconcile().then(() => onRefresh())} /></div>}
    </Dialog>
  </section>;
}
