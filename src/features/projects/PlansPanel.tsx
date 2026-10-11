import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { routeHref } from '../../app/routes';
import type { ProjectAggregate, SolverPin } from '../../domain/types';
import type { PublishPlanCommand } from '../../data/types';
import { createOperationIntent } from '../../data/operations';
import { finalizePlan, offerFits } from '../../domain/validation';
import { completedWorkContext } from '../../domain/execution';
import { Button, Dialog, Field, Link, Notice, PlanDiff, Select, Textarea } from '../../ui';
import { createPlanningController } from './planning';
import { authorityFor, comparePlans, ownsProject, planningFingerprint, planningInput, publisherName, publishPlanInput, solverSummary } from './selectors';
import { projectsCopy as copy, reasonText } from './catalog';
import { ActionFeedback } from './ActionFeedback';
import { ProjectPlan } from './ProjectPlan';
import { PlanReviewEditor } from './PlanReview';
import { createProjectDrafts, downloadText, draftScope } from './drafts';
import { validateEditorDraft } from './editor';
import { canonicalJson } from '../../domain/canonical';
import { solve } from '../../domain/solver';
import { captureProjectContinuation, continueProjectPublication, createPlanReviewStore } from './review';

export function PlansPanel({ project, onRefresh, autoSolve = false }: { project: ProjectAggregate; onRefresh: () => Promise<void>; autoSolve?: boolean }) {
  const runtime = useApp(), session = useAppSession();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const controller = useMemo(() => createPlanningController(async (input, pins, budget) => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    return solve(input, pins, budget);
  }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const input = planningInput(project), [pins, setPins] = useState<SolverPin[]>([]);
  const localDrafts = useMemo(() => createProjectDrafts(runtime, draftScope(session.mode, session.actor)), [runtime, session.mode, session.actor]);
  const localDraft = localDrafts.list().find(draft => draft.projectRoot === project.root.key);
  const localRecipe = localDraft ? validateEditorDraft(localDraft.editor).recipe : null;
  const hasUnsavedNeeds = Boolean(localDraft && input && (!localRecipe || canonicalJson(localRecipe) !== canonicalJson(input.recipe)));
  const fingerprint = input ? planningFingerprint(input, pins) : null;
  useEffect(() => { controller.update(input, pins); }, [controller, fingerprint, project.snapshot.fetchedAt]);
  useEffect(() => { if (autoSolve && input) void controller.run(); }, [autoSolve, controller, fingerprint]);
  const action = useRepositoryAction(`project-plan:${project.root.key}`);
  const scope = draftScope(session.mode, session.actor);
  const reviewStore = useMemo(() => createPlanReviewStore(runtime, project.root.key, scope), [runtime, project.root.key, scope]);
  const { draft: reviewDraft, persisted: savedReview } = useSyncExternalStore(reviewStore.subscribe, reviewStore.getSnapshot, reviewStore.getSnapshot);
  const explanation = reviewDraft?.explanation ?? '';
  const [reviewOpen, setReviewOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [compareIndex, setCompareIndex] = useState(0), [pinRequirement, setPinRequirement] = useState(''), [pinOffer, setPinOffer] = useState(''), [pinQuantity, setPinQuantity] = useState('1');
  useEffect(() => { setReviewOpen(false); setFormError(null); }, [reviewStore]);
  const selected = state.result?.candidates[state.selected] ?? null;
  const authority = authorityFor(session.actor, session.mode, session.chainId), owner = ownsProject(project, session.actor);
  const waiting = action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const requirements = [...new Map(input?.recipe.variants.flatMap(variant => variant.requirements).map(requirement => [requirement.id, requirement]) ?? []).values()];
  const selectedRequirement = requirements.find(requirement => requirement.id === pinRequirement);
  const choices = input && selectedRequirement ? input.publishers.flatMap(publisher => publisher.book.status !== 'unique' ? [] : publisher.book.entity.payload.offers.flatMap(offer => {
    const resource = publisher.book.status === 'unique' ? publisher.book.entity.payload.resources.find(item => item.id === offer.resourceId) : undefined;
    const matches = resource && input.recipe.variants.some(variant => { const requirement = variant.requirements.find(item => item.id === selectedRequirement.id); return requirement && offerFits(offer, resource, requirement, project.root.key, variant.id, variant.venueId); });
    return matches ? [{ value: JSON.stringify([publisher.root.key, offer.id]), publisherRoot: publisher.root.key, offerId: offer.id, label: `${publisherName(project, publisher.root.key)}: ${offer.title}` }] : [];
  })) : [];
  const reviewPlan = reviewDraft && reviewDraft.fingerprint === fingerprint ? reviewDraft.plan : selected?.plan ?? null;
  const finalized = reviewPlan && input ? finalizePlan(reviewPlan, input.publishers, project.snapshot, completedWorkContext(project)) : null;
  const openReview = () => {
    const candidate = controller.candidate();
    if (!candidate || !fingerprint) { setFormError(copy.staleResult); return; }
    const next = reviewDraft?.fingerprint === fingerprint ? reviewDraft : { fingerprint, plan: candidate.plan, explanation };
    reviewStore.save(next); setReviewOpen(true); setFormError(null);
  };
  const publish = async (resume = false) => {
    if (!authority) return;
    const canContinue = captureProjectContinuation(runtime, () => mounted.current, () => window.location.hash);
    const finish = () => continueProjectPublication(canContinue, onRefresh, () => {
      setReviewOpen(false);
      window.location.hash = routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' }).slice(1);
    });
    try {
      if (resume) {
        const result = await action.resume((repository, frozen: PublishPlanCommand) => repository.publishPlan(frozen));
        if (result.ok && result.value.operation.phase === 'complete') await finish();
        return;
      }
      const current = controller.candidate();
      if (!current || !finalized?.ok || !fingerprint || reviewDraft?.fingerprint !== fingerprint || hasUnsavedNeeds) { setFormError(hasUnsavedNeeds ? 'Save your edited needs before proposing a plan.' : copy.staleResult); return; }
      const id = crypto.randomUUID(), now = runtime.now();
      const candidate = { ...current, plan: finalized.value.plan, proposalHash: finalized.value.proposalHash };
      const fields = publishPlanInput(project, candidate, id, now, explanation.trim());
      const result = await action.run({ ...fields, operation: createOperationIntent('publish_plan', authority, fields, { id, now }) }, (repository, command) => repository.publishPlan(command));
      if (result.ok && result.value.operation.phase === 'complete') await finish();
      else if (result.ok && result.value.activationKey && canContinue()) setFormError('The plan is activated, but some request deliveries remain pending. Resume the original publication to finish delivery; do not propose another plan.');
    } catch (error) { if (canContinue()) setFormError(error instanceof Error ? error.message : 'The selected plan could not be prepared.'); }
  };
  const reconcile = async () => {
    const canContinue = captureProjectContinuation(runtime, () => mounted.current, () => window.location.hash);
    await action.reconcile();
    if (canContinue()) await onRefresh();
  };
  const usefulHelp = state.result?.reasons.filter(reason => reason.params?.additionalHelpSufficient === true) ?? [];
  return <section className="pf-sheet pf-stack">
    <header><h2>Find a plan everyone can take on</h2><p>We check who is available, what they can offer, and whether every part of your project is covered.</p></header>
    {hasUnsavedNeeds && <Notice tone="warning" title="Your needs editor contains changes"><p>This search uses the currently saved needs. Save or discard the editor changes before proposing a plan.</p><Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'needs' })}>Return to the needs editor</Link></Notice>}
    <details><summary>Keep a preferred assignment</summary><div className="pf-stack"><p>Choose someone for a particular job. The search will keep this assignment and tell you if it prevents a complete plan.</p>
      <div className="project-grid"><Select label="Requirement" value={pinRequirement} options={[{ value: '', label: 'Choose a requirement' }, ...requirements.map(requirement => ({ value: requirement.id, label: requirement.title }))]} onChange={event => { setPinRequirement(event.target.value); setPinOffer(''); }} />
        <Select label="Contributor offer" value={pinOffer} options={[{ value: '', label: 'Choose an eligible offer' }, ...choices]} onChange={event => setPinOffer(event.target.value)} />
        <Field label="Quantity for this assignment" value={pinQuantity} inputMode="numeric" onChange={event => setPinQuantity(event.target.value)} /></div>
      <Button variant="secondary" onClick={() => { const choice = choices.find(item => item.value === pinOffer); const quantity = Number(pinQuantity); if (!selectedRequirement || !choice || !/^\d+$/.test(pinQuantity) || quantity < 1 || quantity > selectedRequirement.quantity) { setFormError('Choose an offer and a positive whole quantity within the requirement.'); return; } setPins([...pins.filter(pin => !(pin.requirementId === pinRequirement && pin.publisherRoot === choice.publisherRoot && pin.offerId === choice.offerId)), { requirementId: pinRequirement, publisherRoot: choice.publisherRoot, offerId: choice.offerId, quantity }]); setFormError(null); }}>Keep this assignment</Button>
      {pins.length > 0 && <ul>{pins.map((pin, index) => <li key={`${pin.requirementId}:${pin.publisherRoot}:${pin.offerId}`}>{requirements.find(item => item.id === pin.requirementId)?.title ?? pin.requirementId}: {publisherName(project, pin.publisherRoot)} supplies {pin.quantity ?? 1}<Button variant="quiet" onClick={() => setPins(pins.filter((_, i) => i !== index))}>Remove preference</Button></li>)}</ul>}
    </div></details>
    <div className="pf-actions"><Button variant={selected ? 'secondary' : 'primary'} onClick={() => { setReviewOpen(false); void controller.run(); }} disabled={!input || waiting} {...(state.running ? { pending: true as const, pendingLabel: copy.searching } : { pending: false as const })}>{selected ? 'Check for other plans' : copy.search}</Button></div>
    {formError && <Notice tone="warning">{formError}</Notice>}{state.failure && <Notice tone="warning">{state.failure}</Notice>}
    {reviewStore.exportRecovery() !== null && <Notice tone="warning" title="A saved proposal review needs recovery"><p>Its original data is preserved.</p><Button variant="secondary" onClick={() => downloadText('partfolk-plan-review-recovery.txt', reviewStore.exportRecovery()!, 'text/plain')}>Export original review data</Button></Notice>}
    {state.stale && <Notice tone="warning">{copy.staleResult}</Notice>}
    {state.result && <>
      <Notice tone={solverSummary(state.result) === 'found' ? 'neutral' : 'warning'} title={copy[solverSummary(state.result)]}>
        <p>{state.result.candidates.length ? 'Review the assignments, then ask each contributor to agree.' : 'Review what is missing below, then change the needs or add an offer.'}</p>
      </Notice>
      {usefulHelp.length > 0 && <Notice title="Here is what would help"><ul>{usefulHelp.map((reason, index) => <li key={index}>Adding {reason.params?.missing ?? 1} {String(reason.params?.requirementTitle ?? reason.requirementId ?? 'additional contribution')} would make {String(reason.params?.variantId ?? 'this option')} work.</li>)}</ul></Notice>}
      {state.result.reasons.length > 0 && <details open={!state.result.candidates.length}><summary>Why options are blocked or need attention</summary><ul>{state.result.reasons.map((reason, index) => <li key={index}>{reason.requirementId && <strong>{requirements.find(item => item.id === reason.requirementId)?.title ?? reason.requirementId}: </strong>}{reasonText(reason)}{typeof reason.params?.publisherName === 'string' && <span> {reason.params.publisherName} cannot cover the overlapping duties alone.</span>}</li>)}</ul></details>}
      {state.result.candidates.length > 0 && <Select label="Choose a plan" value={String(state.selected)} onChange={event => {
        controller.select(Number(event.target.value));
        const candidate = controller.candidate();
        if (reviewDraft && fingerprint && candidate) reviewStore.save({ fingerprint, plan: candidate.plan, explanation });
        setReviewOpen(false);
      }} options={state.result.candidates.map((candidate, index) => ({ value: String(index), label: `${index + 1}. ${candidate.plan.variant.title} with ${candidate.plan.requiredApprovers.map(root => publisherName(project, root)).join(', ')}` }))} />}
      {selected && <>
        <Button onClick={openReview} disabled={state.stale || state.running || waiting || !owner || !authority || hasUnsavedNeeds} disabledReason={hasUnsavedNeeds ? 'Save or discard the needs editor changes first.' : !owner ? 'The project coordinator proposes a plan.' : !authority ? 'Select the coordinator account to continue.' : undefined}>{copy.preview}</Button>
        <ProjectPlan project={project} plan={selected.plan} />
        {state.result.candidates.length > 1 && <details><summary>Compare with another complete plan</summary><Select label="Compare against" value={String(compareIndex)} options={state.result.candidates.map((candidate, index) => ({ value: String(index), label: `${index + 1}. ${candidate.plan.variant.title}` }))} onChange={event => setCompareIndex(Number(event.target.value))} /><PlanDiff title="Assignment comparison" labels={{ requirement: 'Requirement', before: 'Selected plan', after: 'Comparison plan' }} rows={comparePlans(selected.plan, state.result.candidates[compareIndex]?.plan ?? selected.plan, project)} /></details>}
      </>}
      <details><summary>About this search</summary><p>{state.result.candidates.length} complete plans found after checking {state.result.nodesVisited} possibilities. When replacing a plan, the search first keeps compatible contributors, then the date and place, then assignments.</p>{state.result.optimality === 'not_proven' && <p>The search did not check every possible repair. Any plan shown passed the full checks.</p>}</details>
    </>}
    <ActionFeedback action={action} state={action.state} onReconcile={() => { void reconcile(); }} onResume={action.recoverableCommand ? () => { void publish(true); } : undefined} />
    <Dialog open={reviewOpen && owner && reviewDraft !== null} title="Review the plan with everyone’s part" closeLabel="Keep reviewing later" onClose={() => setReviewOpen(false)} footer={<Button disabled={!finalized?.ok || state.stale || waiting || !authority || !owner || hasUnsavedNeeds} onClick={() => { void publish(); }}>{copy.propose}</Button>}>
      {reviewPlan && <div className="pf-stack"><p>Everyone in this plan will review this version and agree again, including people whose assignments have stayed the same.</p>
        {!savedReview && <Notice tone="warning">This review is only retained in memory. Export your work before closing the page.</Notice>}
        <Button variant="quiet" onClick={() => downloadText('partfolk-proposal-review.json', JSON.stringify({ format: 'partfolk-proposal-review', version: 1, plan: reviewPlan, explanation, agreement: 'not_requested' }, null, 2))}>Export proposed terms for review</Button>
        <ProjectPlan project={project} plan={finalized?.ok ? finalized.value.plan : reviewPlan} />
        <PlanReviewEditor project={project} plan={reviewPlan} disabled={waiting || !owner} onChange={plan => { if (!fingerprint || !input) return; const result = finalizePlan(plan, input.publishers, project.snapshot, completedWorkContext(project)); reviewStore.save({ fingerprint, plan: result.ok ? result.value.plan : plan, explanation }); }} />
        {finalized && !finalized.ok && <Notice tone="warning" title="Review these plan terms"><ul>{finalized.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul></Notice>}
        <Textarea label="Explain this version to contributors" value={explanation} onChange={event => { if (reviewDraft) reviewStore.save({ ...reviewDraft, explanation: event.target.value }); }} hint="This note is public. It does not replace the full agreed terms." disabled={waiting || !owner} />
        {project.proposal && <PlanDiff title="Changes from the active plan" labels={{ requirement: 'Requirement', before: 'Active plan', after: 'New proposal' }} rows={comparePlans(project.proposal.payload.plan, reviewPlan, project)} />}
        <Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' })}>Review the currently active agreement</Link>
        {formError && <Notice tone="warning">{formError}</Notice>}
      </div>}
    </Dialog>
  </section>;
}
