import { useEffect, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import type { RouteViewProps } from '../../app/App';
import { routeHref, routePath } from '../../app/routes';
import { formatDateTime } from '../../app/time';
import { createOperationIntent } from '../../data/operations';
import type { CreateProjectCommand } from '../../data/types';
import type { ProjectAggregate } from '../../domain/types';
import { Button, Checkbox, Dialog, Link, Notice } from '../../ui';
import { RecipeEditor, validateEditorDraft } from './editor';
import { eventDetailsReady } from './editor/model';
import { createProjectDrafts, DraftChangedError, draftScope, downloadText, type SavedProjectDraft } from './drafts';
import { newProjectDraftForSharing, openNewProjectDraft, saveNewProjectDraft, startNewProjectDraft } from './draft-session';
import { authorityFor, PROJECT_LIFETIME_SECONDS } from './selectors';
import { projectsCopy as copy } from './catalog';
import { ActionFeedback } from './ActionFeedback';
import './projects.css';

export interface NewProjectRouteProps extends Partial<RouteViewProps> {
  onShareDraft?: (draft: SavedProjectDraft) => void;
}

export function NewProjectRoute({ onShareDraft }: NewProjectRouteProps) {
  const runtime = useApp(), session = useAppSession();
  const currentScope = draftScope(session.mode, session.actor);
  const [draftSession, setDraftSession] = useState(() => openNewProjectDraft(runtime));
  const { draft, store, status: saveStatus } = draftSession;
  const mounted = useRef(true), activeDraft = useRef(draft.id);
  activeDraft.current = draft.id;
  const [review, setReview] = useState(false), [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const [step, setStep] = useState<'event' | 'needs'>('event');
  const action = useRepositoryAction(`project-create:${draft.id}`);
  const validation = validateEditorDraft(draft.editor), authority = authorityFor(session.actor, session.mode, session.chainId);
  const ownerChanged = draft.scope !== currentScope;
  const detailsReady = eventDetailsReady(draft.editor);
  const signInHref = routeHref({ name: 'sign-in', returnTo: routePath({ name: 'new-project' }) });
  const waiting = action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const [openError, setOpenError] = useState<string | null>(null);
  const save = (next: SavedProjectDraft) => {
    try {
      const status = saveNewProjectDraft(runtime, next, draft);
      setDraftSession(previous => ({ ...previous, draft: next, store: createProjectDrafts(runtime, next.scope), status }));
      runtime.session.selectDraft(next.id);
    } catch (error) {
      setDraftSession(previous => ({ ...previous, draft: next, status: { persisted: false, issue: { code: 'write_failed', recoverableText: null } } }));
      setOpenError(error instanceof DraftChangedError ? error.message : 'Reconnect the account that owns this draft before changing it. Its original input has been retained.');
    }
  };
  useEffect(() => {
    const opened = openNewProjectDraft(runtime);
    setDraftSession(opened);
    if (runtime.session.getSnapshot().activeDraftId !== opened.draft.id) runtime.session.selectDraft(opened.draft.id);
  }, [runtime, currentScope, session.activeDraftId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setReview(false); setPublicAcknowledged(false); }, [session.actor, session.mode, session.chainId]);
  const ownsCurrentDraft = () => {
    const current = runtime.session.getSnapshot();
    if (draft.scope !== draftScope(current.mode, current.actor) || activeDraft.current !== draft.id) return false;
    const conflict = store.currentConflict(draft);
    if (conflict) {
      setOpenError(new DraftChangedError(conflict).message);
      return false;
    }
    return true;
  };
  const bindConfirmedProject = (project: ProjectAggregate, origin: SavedProjectDraft) => {
    const originStore = createProjectDrafts(runtime, origin.scope);
    originStore.refresh();
    const latest = originStore.get(origin.id) ?? origin;
    const bound = { ...latest, projectRoot: project.root.key,
      baselineStateKey: project.state.status === 'unique' ? project.state.entity.key : null,
      updatedAt: Math.max(latest.updatedAt, runtime.now()) };
    // A late confirmation belongs to its original draft, even after navigation
    // or an account switch. Never replace another form or redirect its owner.
    // Deleting a local draft cannot cancel an already submitted publication.
    // Keep the confirmed project accessible without restoring deleted text.
    try { originStore.upsert(bound); } catch (error) { if (!(error instanceof DraftChangedError)) throw error; }
    const current = runtime.session.getSnapshot();
    if (!mounted.current || activeDraft.current !== origin.id || current.activeDraftId !== origin.id
      || draftScope(current.mode, current.actor) !== origin.scope) return;
    setDraftSession(previous => ({ ...previous, draft: bound, store: originStore, status: originStore.status() }));
    setReview(false);
    window.location.hash = routeHref({ name: 'project', projectRoot: project.root.key, tab: 'needs' }).slice(1);
  };
  const submit = async (command?: CreateProjectCommand) => {
    if (action.state.status === 'confirmed') return;
    if (session.mode !== 'public' || !ownsCurrentDraft() || !authority || (!command && !validation.recipe)) return;
    const origin = structuredClone(draft);
    const input = { recipe: validation.recipe!, lifetimeSeconds: PROJECT_LIFETIME_SECONDS };
    const next = command ?? { ...input, operation: createOperationIntent('create_project', authority, input, { now: runtime.now() }) };
    const result = command ? await action.resume((repository, frozen: CreateProjectCommand) => repository.createProject(frozen))
      : await action.run(next, (repository, frozen) => repository.createProject(frozen));
    if (result?.ok && result.value.operation.phase === 'complete' && result.value.value.state.status === 'unique') {
      bindConfirmedProject(result.value.value, origin);
    }
  };
  const checkOriginal = async () => {
    if (!ownsCurrentDraft() || !authority) return;
    const origin = structuredClone(draft);
    const result = await action.reconcile();
    if (!result.ok || result.value.status !== 'confirmed' || result.value.operation.phase !== 'complete' || !runtime.repository) return;
    for (const key of result.value.operation.confirmedKeys) {
      const loaded = await runtime.repository.loadProject(key);
      if (!loaded.ok) continue;
      bindConfirmedProject(loaded.value, origin); return;
    }
    setOpenError('The original publication is confirmed, but its project could not be read yet. Check it again; this form will not create a second project.');
  };
  return <div className="pf-stack project-create">
    <header className="project-heading"><div><h1>Create your event project</h1><p>Set the date and bring together the help you need. Your project is created publicly on Arkiv with your wallet.</p></div><Link href={routeHref({ name: 'workspace' })}>My projects</Link></header>
    <nav className="project-creation-nav" aria-label="Project creation"><ol className="project-steps"><li aria-current={step === 'event' ? 'step' : undefined}><Button variant={step === 'event' ? 'primary' : 'quiet'} onClick={() => setStep('event')}>Event and date</Button></li><li aria-current={step === 'needs' ? 'step' : undefined}><Button variant={step === 'needs' ? 'primary' : 'quiet'} disabled={!detailsReady} onClick={() => setStep('needs')}>Place and help</Button></li><li>Review and create</li></ol></nav>
    {ownerChanged && <Notice tone="warning" title="This draft belongs to another account context"><p>Your original input is retained. Reconnect its account to continue editing or publishing. Connecting a different account does not transfer this draft.</p><Button variant="secondary" onClick={() => { const next = startNewProjectDraft(runtime); setDraftSession(next); runtime.session.selectDraft(next.draft.id); setOpenError(null); }}>Start a separate draft in this account</Button></Notice>}
    {!saveStatus.persisted && <Notice tone="warning">{copy.memoryOnly}</Notice>}
    {store.exportRecovery() !== null && <Notice tone="warning" title="Saved drafts need recovery"><p>The unreadable data is preserved and has not been replaced.</p><Button variant="secondary" onClick={() => downloadText('partfolk-drafts-recovery.txt', store.exportRecovery()!, 'text/plain')}>Export original data</Button></Notice>}
    {draftSession.recoveryText !== null && <Notice tone="warning" title="The saved draft location needs recovery"><p>The original location data is preserved. Export it before closing this page.</p><Button variant="secondary" onClick={() => downloadText('partfolk-draft-location-recovery.txt', draftSession.recoveryText!, 'text/plain')}>Export original draft location</Button></Notice>}
    <RecipeEditor value={validation.recipe ?? { title: '', outcome: '', timeZone: draft.editor.timeZone, variants: [], instructions: '' }} draft={draft.editor}
      onDraftChange={editor => save({ ...draft, editor, updatedAt: runtime.now() })} onChange={() => {}} disabled={waiting || ownerChanged} section={step} />
    <div className="pf-sheet pf-stack project-create-continuation"><h2>{step === 'event' ? 'Next, bring the plan together' : 'Create a shared starting point'}</h2><p>{step === 'event' ? 'Choose the place and describe at least one contribution. Contributors will offer their help and decide on the complete plan.' : 'Contributors can read the public project and offer help. After everyone agrees, you can publish the visitor page and open registration.'}</p><div className="project-form-actions">
      {step === 'event' && <Button onClick={() => setStep('needs')} disabled={!detailsReady || waiting || ownerChanged}>Continue to place and help</Button>}
      {step === 'needs' && <Button variant="secondary" onClick={() => setStep('event')}>Back to event and date</Button>}
      {session.mode === 'local' && onShareDraft && <Button onClick={() => {
        if (waiting || !ownsCurrentDraft()) return;
        const shared = newProjectDraftForSharing(runtime, draft);
        if (shared) onShareDraft(shared);
      }} disabled={!validation.valid || ownerChanged || waiting}
        disabledReason={!validation.valid ? 'Complete the marked fields before sharing. Your input is retained.' : ownerChanged ? 'Reconnect the account that owns this draft.' : undefined}>Continue as a public project</Button>}
      {step === 'needs' && session.mode === 'public' && <Button onClick={() => { if (ownsCurrentDraft()) setReview(true); }} disabled={ownerChanged || !validation.valid || waiting || action.state.status === 'confirmed'}>Review public project</Button>}
    </div>
    {step === 'event' && !detailsReady && <p className="pf-field-message">Add the event name, purpose, start and end before continuing.</p>}
    {step === 'needs' && !validation.valid && <p className="pf-field-message">Complete the marked details before reviewing the public project.</p>}
    <p className="project-create-status" role="status">{saveStatus.persisted ? 'Your unfinished input is saved automatically on this device. Nothing is published until you confirm with your wallet.' : copy.memoryOnly}</p></div>
    <ActionFeedback state={action.state} action={action} onReconcile={() => { void checkOriginal(); }} onResume={action.recoverableCommand ? () => { void submit(action.recoverableCommand as CreateProjectCommand); } : undefined} />
    {action.state.status === 'confirmed' && draft.projectRoot === null && <Button variant="secondary" disabled={ownerChanged || !authority} onClick={() => { void checkOriginal(); }}>Open the confirmed project</Button>}
    {openError && <Notice tone="warning"><p>{openError}</p>{!ownerChanged && <div className="pf-actions"><Button variant="secondary" onClick={() => downloadText('partfolk-project-draft.json', store.exportDraft(draft))}>Export my open copy</Button><Button variant="secondary" disabled={waiting} onClick={() => {
      try {
        const saved = store.reloadSaved(draft.id);
        if (!saved) { setOpenError('This draft is no longer saved. Export your open copy or start a new draft from My projects.'); return; }
        setDraftSession(previous => ({ ...previous, draft: saved, status: store.status() })); setReview(false); setOpenError(null);
      } catch (error) { setOpenError(error instanceof Error ? error.message : 'The saved draft could not be read. Your open copy is retained.'); }
    }}>Reload saved draft</Button></div>}</Notice>}
    <Link href={routeHref({ name: 'workspace' })}>Return to My projects</Link>
    <details className="project-recovery-tools"><summary>Advanced: input recovery</summary><p>Keep a backup of this unfinished input or recover it after a storage problem.</p><Button variant="secondary" onClick={() => downloadText('partfolk-project-draft.json', store.exportDraft(draft))}>Export input backup</Button></details>
    <Dialog open={review && !ownerChanged} title={copy.publicPreview} closeLabel="Keep editing" onClose={() => setReview(false)} footer={authority && session.mode === 'public' ? <Button onClick={() => { void submit(); }} disabled={ownerChanged || !validation.valid || waiting || action.state.status === 'confirmed' || !publicAcknowledged}>Create public project</Button> : <Link className="pf-button pf-button--primary" href={signInHref} onClick={() => setReview(false)}>Sign in to create public project</Link>}>
      <div className="pf-stack"><h3>{draft.editor.title}</h3><p>{draft.editor.outcome}</p><p>{draft.editor.variants.length} date and place options. Project time zone: {draft.editor.timeZone}.</p>
        <p>{copy.publicNote}</p>
        <p>Acting as: {session.actor?.kind === 'wallet' ? session.actor.address : session.actor?.id ?? 'No account selected'}</p>
        {validation.recipe?.variants.map(variant => <section className="pf-sheet pf-stack" key={variant.id}><h3>{variant.title}</h3><p>Place option: {variant.venueId}. Time zone: {variant.timeZone}.</p><ul>{variant.requirements.map(requirement => <li key={requirement.id}><strong>{requirement.title}</strong><p>{requirement.quantity} {requirement.unit}</p><p>{formatDateTime(requirement.interval.start, variant.timeZone)} to {formatDateTime(requirement.interval.end, variant.timeZone)}</p><p>Skill or use: {requirement.capability}</p>{requirement.dependsOn.length > 0 && <p>Starts after: {requirement.dependsOn.map(id => variant.requirements.find(item => item.id === id)?.title ?? id).join(', ')}</p>}{requirement.instructions && <p>{requirement.instructions}</p>}</li>)}</ul>{variant.instructions && <p>{variant.instructions}</p>}</section>)}
        {validation.recipe?.instructions && <p>Instructions for everyone: {validation.recipe.instructions}</p>}
        {authority ? <Checkbox label="I have reviewed these public details and the connected account." checked={publicAcknowledged} onChange={event => setPublicAcknowledged(event.target.checked)} /> : <p>Sign in with your wallet to create this project. Your input stays here while you connect.</p>}
      </div>
    </Dialog>
  </div>;
}
