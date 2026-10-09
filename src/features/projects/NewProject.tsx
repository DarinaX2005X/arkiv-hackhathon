import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import type { RouteViewProps } from '../../app/App';
import { routeHref } from '../../app/routes';
import { formatDateTime } from '../../app/time';
import { createOperationIntent } from '../../data/operations';
import type { CreateProjectCommand } from '../../data/types';
import { Button, Checkbox, Dialog, Link, Notice } from '../../ui';
import { RecipeEditor, validateEditorDraft } from './editor';
import { createProjectDrafts, draftScope, downloadText, makeDraft, type SavedProjectDraft } from './drafts';
import { authorityFor, PROJECT_LIFETIME_SECONDS } from './selectors';
import { projectsCopy as copy } from './catalog';
import { ActionFeedback } from './ActionFeedback';

export function NewProjectRoute(_props: RouteViewProps) {
  const runtime = useApp(), session = useAppSession();
  const initialScope = useRef(draftScope(session.mode, session.actor));
  const store = useMemo(() => createProjectDrafts(runtime, initialScope.current), [runtime]);
  const [draft, setDraft] = useState<SavedProjectDraft>(() => { const saved = store.get(session.activeDraftId); return saved && saved.projectRoot === null ? saved : makeDraft(initialScope.current, undefined, runtime.now()); });
  const [saveStatus, setSaveStatus] = useState(store.status());
  const [review, setReview] = useState(false), [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const action = useRepositoryAction(`project-create:${draft.id}`);
  const validation = validateEditorDraft(draft.editor), authority = authorityFor(session.actor, session.mode, session.chainId);
  const ownerChanged = draft.scope !== draftScope(session.mode, session.actor);
  const waiting = action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const [openError, setOpenError] = useState<string | null>(null);
  const save = (next: SavedProjectDraft) => { setDraft(next); store.upsert(next); setSaveStatus(store.status()); runtime.session.selectDraft(next.id); };
  useEffect(() => { if (!store.get(draft.id)) save(draft); }, [store, draft.id]);
  useEffect(() => { setReview(false); setPublicAcknowledged(false); }, [session.actor, session.mode]);
  const submit = async (command?: CreateProjectCommand) => {
    if (action.state.status === 'confirmed') return;
    if (!authority || (!command && !validation.recipe)) return;
    const input = { recipe: validation.recipe!, lifetimeSeconds: PROJECT_LIFETIME_SECONDS };
    const next = command ?? { ...input, operation: createOperationIntent('create_project', authority, input, { now: runtime.now() }) };
    const result = command ? await action.resume((repository, frozen: CreateProjectCommand) => repository.createProject(frozen))
      : await action.run(next, (repository, frozen) => repository.createProject(frozen));
    if (result?.ok && result.value.operation.phase === 'complete' && result.value.value.state.status === 'unique') {
      const project = result.value.value;
      save({ ...draft, projectRoot: project.root.key, baselineStateKey: project.state.status === 'unique' ? project.state.entity.key : null, updatedAt: runtime.now() });
      setReview(false); window.location.hash = routeHref({ name: 'project', projectRoot: project.root.key, tab: 'needs' }).slice(1);
    }
  };
  const checkOriginal = async () => {
    const result = await action.reconcile();
    if (!result.ok || result.value.status !== 'confirmed' || result.value.operation.phase !== 'complete' || !runtime.repository) return;
    for (const key of result.value.operation.confirmedKeys) {
      const loaded = await runtime.repository.loadProject(key);
      if (!loaded.ok) continue;
      save({ ...draft, projectRoot: loaded.value.root.key, baselineStateKey: loaded.value.state.status === 'unique' ? loaded.value.state.entity.key : null, updatedAt: runtime.now() });
      window.location.hash = routeHref({ name: 'project', projectRoot: loaded.value.root.key, tab: 'needs' }).slice(1); return;
    }
    setOpenError('The original publication is confirmed, but its project could not be read yet. Check it again; this form will not create a second project.');
  };
  return <div className="pf-stack">
    <header><h1>Start your project</h1><p>Describe the outcome and the people, place and equipment it needs. Contributors bring their own offers.</p></header>
    <Notice title={session.mode === 'public' ? 'Prepare locally before publishing' : copy.local}>Editing this form does not publish anything or create agreement.</Notice>
    {ownerChanged && <Notice tone="warning">This draft was opened in a different account context. Your input is retained. Review the account shown in the publication preview before continuing.</Notice>}
    {!saveStatus.persisted && <Notice tone="warning">{copy.memoryOnly}</Notice>}
    {store.exportRecovery() !== null && <Notice tone="warning" title="Saved drafts need recovery"><p>The unreadable data is preserved and has not been replaced.</p><Button variant="secondary" onClick={() => downloadText('partfolk-drafts-recovery.txt', store.exportRecovery()!, 'text/plain')}>Export original data</Button></Notice>}
    <RecipeEditor value={validation.recipe ?? { title: '', outcome: '', timeZone: draft.editor.timeZone, variants: [], instructions: '' }} draft={draft.editor}
      onDraftChange={editor => save({ ...draft, editor, updatedAt: runtime.now() })} onChange={() => {}} disabled={waiting} />
    <div className="pf-actions">
      <Button variant="secondary" onClick={() => save({ ...draft, updatedAt: runtime.now() })}>{copy.saveDraft}</Button>
      <Button variant="secondary" onClick={() => downloadText('partfolk-project-draft.json', store.exportDraft(draft))}>{copy.exportDraft}</Button>
      <Button onClick={() => setReview(true)} disabled={!validation.valid || waiting || action.state.status === 'confirmed' || !runtime.repository || !authority} disabledReason={!authority ? session.mode === 'public' ? 'Connect your wallet on Tiramisu to publish. Your draft is retained.' : 'Choose your local organizer context to create a local project.' : !validation.valid ? 'Complete the marked fields first.' : undefined}>{session.mode === 'public' ? 'Review public project' : 'Create local project'}</Button>
    </div>
    <p role="status">{saveStatus.persisted ? copy.saved : copy.memoryOnly}</p>
    <ActionFeedback state={action.state} onReconcile={() => { void checkOriginal(); }} onResume={action.recoverableCommand ? () => { void submit(action.recoverableCommand as CreateProjectCommand); } : undefined} />
    {action.state.status === 'confirmed' && draft.projectRoot === null && <Button variant="secondary" onClick={() => { void checkOriginal(); }}>Open the confirmed project</Button>}
    {openError && <Notice tone="warning">{openError}</Notice>}
    <Link href={routeHref({ name: 'workspace' })}>Return to Projects</Link>
    <Dialog open={review} title={session.mode === 'public' ? copy.publicPreview : 'Create this local project'} closeLabel="Keep editing" onClose={() => setReview(false)} footer={<Button onClick={() => { void submit(); }} disabled={!validation.valid || !authority || waiting || action.state.status === 'confirmed' || (session.mode === 'public' && !publicAcknowledged)}>{session.mode === 'public' ? 'Publish project' : 'Create local project'}</Button>}>
      <div className="pf-stack"><h3>{draft.editor.title}</h3><p>{draft.editor.outcome}</p><p>{draft.editor.variants.length} date and place options · {draft.editor.timeZone}</p>
        <p>{session.mode === 'public' ? copy.publicNote : 'This creates a project in your local workspace. Other people have not offered or accepted anything.'}</p>
        <p>Acting as: {session.actor?.kind === 'wallet' ? session.actor.address : session.actor?.id ?? 'No account selected'}</p>
        {validation.recipe?.variants.map(variant => <section className="pf-sheet pf-stack" key={variant.id}><h3>{variant.title}</h3><p>Place option: {variant.venueId} · {variant.timeZone}</p><ul>{variant.requirements.map(requirement => <li key={requirement.id}><strong>{requirement.title}</strong> · {requirement.quantity} {requirement.unit}<p>{formatDateTime(requirement.interval.start, variant.timeZone)} – {formatDateTime(requirement.interval.end, variant.timeZone)}</p><p>Capability: {requirement.capability}</p>{requirement.instructions && <p>{requirement.instructions}</p>}</li>)}</ul>{variant.instructions && <p>{variant.instructions}</p>}</section>)}
        {validation.recipe?.instructions && <p>Instructions for everyone: {validation.recipe.instructions}</p>}
        {session.mode === 'public' && <Checkbox label="I have reviewed these public details and the connected account." checked={publicAcknowledged} onChange={event => setPublicAcknowledged(event.target.checked)} />}
      </div>
    </Dialog>
  </div>;
}
