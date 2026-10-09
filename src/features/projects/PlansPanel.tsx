import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp, useAppSession, type AppRuntime } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { routeHref } from '../../app/routes';
import type { PlanDocument, ProjectAggregate, SolverPin } from '../../domain/types';
import type { PublishPlanCommand } from '../../data/types';
import { createOperationIntent } from '../../data/operations';
import { finalizePlan, offerFits, validatePlanDocument } from '../../domain/validation';
import { Button, Dialog, Field, Link, Notice, PlanDiff, Select, StatusLabel, Textarea } from '../../ui';
import { createPlanningController } from './planning';
import { authorityFor, comparePlans, ownsProject, planningFingerprint, planningInput, publisherName, publishPlanInput, solverSummary } from './selectors';
import { projectsCopy as copy, reasonText } from './catalog';
import { ActionFeedback } from './ActionFeedback';
import { ProjectPlan } from './ProjectPlan';
import { PlanReviewEditor } from './PlanReview';
import { createProjectDrafts, downloadText, draftScope } from './drafts';
import { validateEditorDraft } from './editor';
import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { solve } from '../../domain/solver';

interface ReviewDraft { fingerprint: string; plan: PlanDocument }
const isReviewDraft = (value: unknown): value is ReviewDraft => value !== null && typeof value === 'object'
  && Object.keys(value).sort().join(',') === 'fingerprint,plan' && typeof (value as ReviewDraft).fingerprint === 'string'
  && validatePlanDocument((value as ReviewDraft).plan).valid;
const makeReviewStore = (runtime: AppRuntime, key: string) => runtime.drafts(key, 'plan-review', isReviewDraft);
const reviewStores = new WeakMap<AppRuntime, Map<string, ReturnType<typeof makeReviewStore>>>();
function retainedReviewStore(runtime: AppRuntime, key: string) {
  let stores = reviewStores.get(runtime); if (!stores) { stores = new Map(); reviewStores.set(runtime, stores); }
  let store = stores.get(key); if (!store) { store = makeReviewStore(runtime, key); stores.set(key, store); }
  return store;
}

export function PlansPanel({ project, onRefresh, autoSolve = false }: { project: ProjectAggregate; onRefresh: () => Promise<void>; autoSolve?: boolean }) {
  const runtime = useApp(), session = useAppSession();
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
  const reviewStore = useMemo(() => retainedReviewStore(runtime, `plan-review:${hashCanonical({ projectRoot: project.root.key, scope: draftScope(session.mode, session.actor) }).slice(2)}`), [runtime, project.root.key, session.mode, session.actor]);
  const [reviewDraft, setReviewDraft] = useState<ReviewDraft | null>(() => { const memory = reviewStore.peek(); if (memory) return memory; const loaded = reviewStore.load(); return loaded.status === 'ready' ? loaded.value : null; });
  const [reviewOpen, setReviewOpen] = useState(false), [explanation, setExplanation] = useState('');
  const [formError, setFormError] = useState<string | null>(null), [savedReview, setSavedReview] = useState(true);
  const [compareIndex, setCompareIndex] = useState(0), [pinRequirement, setPinRequirement] = useState(''), [pinOffer, setPinOffer] = useState(''), [pinQuantity, setPinQuantity] = useState('1');
  useEffect(() => { const memory = reviewStore.peek(); const saved = memory ? null : reviewStore.load(); setReviewDraft(memory ?? (saved?.status === 'ready' ? saved.value : null)); setReviewOpen(false); setExplanation(''); }, [reviewStore]);
  const selected = state.result?.candidates[state.selected] ?? null;
  const authority = authorityFor(session.actor, session.mode, session.chainId), owner = ownsProject(project, session.actor);
  const waiting = action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const requirements = [...new Map(input?.recipe.variants.flatMap(variant => variant.requirements).map(requirement => [requirement.id, requirement]) ?? []).values()];
  const selectedRequirement = requirements.find(requirement => requirement.id === pinRequirement);
  const choices = input && selectedRequirement ? input.publishers.flatMap(publisher => publisher.book.status !== 'unique' ? [] : publisher.book.entity.payload.offers.flatMap(offer => {
    const resource = publisher.book.status === 'unique' ? publisher.book.entity.payload.resources.find(item => item.id === offer.resourceId) : undefined;
    const matches = resource && input.recipe.variants.some(variant => { const requirement = variant.requirements.find(item => item.id === selectedRequirement.id); return requirement && offerFits(offer, resource, requirement, project.root.key, variant.id, variant.venueId); });
    return matches ? [{ value: JSON.stringify([publisher.root.key, offer.id]), publisherRoot: publisher.root.key, offerId: offer.id, label: `${publisherName(project, publisher.root.key)} · ${offer.title}` }] : [];
  })) : [];
  const reviewPlan = reviewDraft && reviewDraft.fingerprint === fingerprint ? reviewDraft.plan : selected?.plan ?? null;
  const finalized = reviewPlan && input ? finalizePlan(reviewPlan, input.publishers, project.snapshot) : null;
  const openReview = () => {
    const candidate = controller.candidate();
    if (!candidate || !fingerprint) { setFormError(copy.staleResult); return; }
    const next = reviewDraft?.fingerprint === fingerprint ? reviewDraft : { fingerprint, plan: candidate.plan };
    setReviewDraft(next); setSavedReview(reviewStore.save(next).persisted); setReviewOpen(true); setFormError(null);
  };
  const publish = async (resume = false) => {
    if (!authority) return;
    try {
      if (resume) {
        const result = await action.resume((repository, frozen: PublishPlanCommand) => repository.publishPlan(frozen));
        if (result.ok && result.value.operation.phase === 'complete') { setReviewOpen(false); await onRefresh(); window.location.hash = routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' }).slice(1); }
        return;
      }
      const current = controller.candidate();
      if (!current || !finalized?.ok || !fingerprint || reviewDraft?.fingerprint !== fingerprint || hasUnsavedNeeds) { setFormError(hasUnsavedNeeds ? 'Save your edited needs before proposing a plan.' : copy.staleResult); return; }
      const id = crypto.randomUUID(), now = runtime.now();
      const candidate = { ...current, plan: finalized.value.plan, proposalHash: finalized.value.proposalHash };
      const fields = publishPlanInput(project, candidate, id, now, explanation.trim());
      const result = await action.run({ ...fields, operation: createOperationIntent('publish_plan', authority, fields, { id, now }) }, (repository, command) => repository.publishPlan(command));
      if (result.ok && result.value.operation.phase === 'complete') { setReviewOpen(false); await onRefresh(); window.location.hash = routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' }).slice(1); }
      else if (result.ok && result.value.activationKey) setFormError('The plan is activated, but some request deliveries remain pending. Resume the original publication to finish delivery; do not propose another plan.');
    } catch (error) { setFormError(error instanceof Error ? error.message : 'The selected plan could not be prepared.'); }
  };
  const usefulHelp = state.result?.reasons.filter(reason => reason.params?.additionalHelpSufficient === true) ?? [];
  return <section className="pf-stack">
    <header><h2>Find a complete plan</h2><p>Every requirement, offer condition, shared resource and current commitment is checked together. Finding a plan does not imply agreement.</p></header>
    {hasUnsavedNeeds && <Notice tone="warning" title="Your needs editor contains changes"><p>This search uses the currently saved needs. Save or discard the editor changes before proposing a plan.</p><Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'needs' })}>Return to the needs editor</Link></Notice>}
    <details><summary>Keep a preferred assignment</summary><div className="pf-stack"><p>A pin is a real constraint. If it prevents a complete plan, it will be explained rather than silently removed.</p>
      <div className="project-grid"><Select label="Requirement" value={pinRequirement} options={[{ value: '', label: 'Choose a requirement' }, ...requirements.map(requirement => ({ value: requirement.id, label: requirement.title }))]} onChange={event => { setPinRequirement(event.target.value); setPinOffer(''); }} />
        <Select label="Contributor offer" value={pinOffer} options={[{ value: '', label: 'Choose an eligible offer' }, ...choices]} onChange={event => setPinOffer(event.target.value)} />
        <Field label="Pinned quantity" value={pinQuantity} inputMode="numeric" onChange={event => setPinQuantity(event.target.value)} /></div>
      <Button variant="secondary" onClick={() => { const choice = choices.find(item => item.value === pinOffer); const quantity = Number(pinQuantity); if (!selectedRequirement || !choice || !/^\d+$/.test(pinQuantity) || quantity < 1 || quantity > selectedRequirement.quantity) { setFormError('Choose an offer and a positive whole quantity within the requirement.'); return; } setPins([...pins.filter(pin => !(pin.requirementId === pinRequirement && pin.publisherRoot === choice.publisherRoot && pin.offerId === choice.offerId)), { requirementId: pinRequirement, publisherRoot: choice.publisherRoot, offerId: choice.offerId, quantity }]); setFormError(null); }}>Pin this assignment</Button>
      {pins.length > 0 && <ul>{pins.map((pin, index) => <li key={`${pin.requirementId}:${pin.publisherRoot}:${pin.offerId}`}>{requirements.find(item => item.id === pin.requirementId)?.title ?? pin.requirementId} · {publisherName(project, pin.publisherRoot)} · {pin.quantity ?? 1}<Button variant="quiet" onClick={() => setPins(pins.filter((_, i) => i !== index))}>Remove pin</Button></li>)}</ul>}
    </div></details>
    <div className="pf-actions"><Button onClick={() => { setReviewOpen(false); void controller.run(); }} disabled={!input || waiting} {...(state.running ? { pending: true as const, pendingLabel: copy.searching } : { pending: false as const })}>{copy.search}</Button><p>Preserve compatible contributors, then the date and place option, then assignments.</p></div>
    {formError && <Notice tone="warning">{formError}</Notice>}{state.failure && <Notice tone="warning">{state.failure}</Notice>}
    {reviewStore.exportRecovery() !== null && <Notice tone="warning" title="A saved proposal review needs recovery"><p>Its original data is preserved.</p><Button variant="secondary" onClick={() => downloadText('partfolk-plan-review-recovery.txt', reviewStore.exportRecovery()!, 'text/plain')}>Export original review data</Button></Notice>}
    {state.stale && <Notice tone="warning">{copy.staleResult}</Notice>}
    {state.result && <>
      <Notice tone={solverSummary(state.result) === 'found' ? 'neutral' : 'warning'} title={copy[solverSummary(state.result)]}>
        <p>{state.result.candidates.length} complete {state.result.candidates.length === 1 ? 'plan' : 'plans'} found · {state.result.nodesVisited} search nodes checked.</p>
        {state.result.optimality === 'not_proven' && <p>This result is valid if shown, but the search has not proved the best possible repair.</p>}
      </Notice>
      {usefulHelp.length > 0 && <Notice title="A concrete way to make an option work"><ul>{usefulHelp.map((reason, index) => <li key={index}>Adding {reason.params?.missing ?? 1} {String(reason.params?.requirementTitle ?? reason.requirementId ?? 'additional contribution')} would make {String(reason.params?.variantId ?? 'this option')} feasible. This is a missing contribution, not an invented offer.</li>)}</ul></Notice>}
      {state.result.reasons.length > 0 && <details open={!state.result.candidates.length}><summary>Why options are blocked or need attention</summary><ul>{state.result.reasons.map((reason, index) => <li key={index}>{reason.requirementId && <strong>{requirements.find(item => item.id === reason.requirementId)?.title ?? reason.requirementId}: </strong>}{reasonText(reason)}{typeof reason.params?.publisherName === 'string' && <span> {reason.params.publisherName} cannot cover the overlapping duties alone.</span>}</li>)}</ul></details>}
      {state.result.candidates.length > 0 && <Select label="Complete plan" value={String(state.selected)} onChange={event => { controller.select(Number(event.target.value)); setReviewDraft(null); setReviewOpen(false); }} options={state.result.candidates.map((candidate, index) => ({ value: String(index), label: `${index + 1}. ${candidate.plan.variant.title} · ${candidate.plan.requiredApprovers.map(root => publisherName(project, root)).join(', ')}` }))} />}
      {selected && <>
        <StatusLabel>Computed plan · no agreement inferred</StatusLabel><ProjectPlan project={project} plan={selected.plan} />
        {state.result.candidates.length > 1 && <details><summary>Compare with another complete plan</summary><Select label="Compare against" value={String(compareIndex)} options={state.result.candidates.map((candidate, index) => ({ value: String(index), label: `${index + 1}. ${candidate.plan.variant.title}` }))} onChange={event => setCompareIndex(Number(event.target.value))} /><PlanDiff title="Assignment comparison" labels={{ requirement: 'Requirement', before: 'Selected plan', after: 'Comparison plan' }} rows={comparePlans(selected.plan, state.result.candidates[compareIndex]?.plan ?? selected.plan, project)} /></details>}
        <Button onClick={openReview} disabled={state.stale || state.running || waiting || !owner || !authority || hasUnsavedNeeds} disabledReason={hasUnsavedNeeds ? 'Save or discard the needs editor changes first.' : !owner ? 'The project coordinator proposes a plan.' : !authority ? 'Select the coordinator account to continue.' : undefined}>{copy.preview}</Button>
      </>}
    </>}
    <ActionFeedback state={action.state} onReconcile={() => { void action.reconcile().then(() => onRefresh()); }} onResume={action.recoverableCommand ? () => { void publish(true); } : undefined} />
    <Dialog open={reviewOpen} title="Review the exact plan everyone will accept" closeLabel="Keep reviewing later" onClose={() => setReviewOpen(false)} footer={<Button disabled={!finalized?.ok || state.stale || waiting || !authority || !owner || hasUnsavedNeeds} onClick={() => { void publish(); }}>{copy.propose}</Button>}>
      {reviewPlan && <div className="pf-stack"><Notice title="Every required owner needs to agree">This publication creates a new activation. Earlier decisions stay historical, including decisions from people whose assignments are unchanged.</Notice>
        {!savedReview && <Notice tone="warning">This review is only retained in memory. Export your work before closing the page.</Notice>}
        <Button variant="quiet" onClick={() => downloadText('partfolk-proposal-review.json', JSON.stringify({ format: 'partfolk-proposal-review', version: 1, plan: reviewPlan, agreement: 'not_requested' }, null, 2))}>Export proposed terms for review</Button>
        <ProjectPlan project={project} plan={finalized?.ok ? finalized.value.plan : reviewPlan} />
        <PlanReviewEditor project={project} plan={reviewPlan} disabled={waiting} onChange={plan => { if (!fingerprint || !input) return; const result = finalizePlan(plan, input.publishers, project.snapshot); const next = { fingerprint, plan: result.ok ? result.value.plan : plan }; setReviewDraft(next); setSavedReview(reviewStore.save(next).persisted); }} />
        {finalized && !finalized.ok && <Notice tone="warning" title="Review these plan terms"><ul>{finalized.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul></Notice>}
        <Textarea label="Explain this version to contributors" value={explanation} onChange={event => setExplanation(event.target.value)} hint="This note is public. It does not replace the full agreed terms." disabled={waiting} />
        {project.proposal && <PlanDiff title="Changes from the active plan" labels={{ requirement: 'Requirement', before: 'Active plan', after: 'New proposal' }} rows={comparePlans(project.proposal.payload.plan, reviewPlan, project)} />}
        <Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'agreement' })}>Review the currently active agreement</Link>
        {formError && <Notice tone="warning">{formError}</Notice>}
      </div>}
    </Dialog>
  </section>;
}
