import { useMemo, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { routeHref } from '../../app/routes';
import { canonicalJson } from '../../domain/canonical';
import type { ProjectAggregate } from '../../domain/types';
import type { ReplaceProjectCommand } from '../../data/types';
import { createOperationIntent } from '../../data/operations';
import { Button, Link, Notice } from '../../ui';
import { RecipeEditor, recipeToEditorDraft, validateEditorDraft } from './editor';
import { createProjectDrafts, downloadText, draftScope, makeDraft, type SavedProjectDraft } from './drafts';
import { authorityFor, ownsProject, replaceRecipeInput } from './selectors';
import { projectsCopy as copy } from './catalog';
import { ActionFeedback } from './ActionFeedback';

export function NeedsPanel({ project, onRefresh }: { project: ProjectAggregate; onRefresh: () => Promise<void> }) {
  const runtime = useApp(), session = useAppSession();
  const scope = useRef(draftScope(session.mode, session.actor));
  const store = useMemo(() => createProjectDrafts(runtime, scope.current), [runtime]);
  const state = project.state.status === 'unique' ? project.state.entity : null;
  const [draft, setDraft] = useState<SavedProjectDraft | null>(() => {
    if (!state) return null;
    return store.list().find(item => item.projectRoot === project.root.key) ?? { ...makeDraft(scope.current, state.payload.recipe, runtime.now()), projectRoot: project.root.key, baselineStateKey: state.key };
  });
  const [saveStatus, setSaveStatus] = useState(store.status());
  const action = useRepositoryAction(`project-edit:${project.root.key}`);
  const [failure, setFailure] = useState<string | null>(null);
  if (!state || !draft) return <Notice tone="warning">A unique current project record is required to edit these needs.</Notice>;
  const validation = validateEditorDraft(draft.editor), owner = ownsProject(project, session.actor);
  const authority = authorityFor(session.actor, session.mode, session.chainId);
  const staleBase = draft.baselineStateKey !== state.key;
  const dirty = !validation.recipe || canonicalJson(validation.recipe) !== canonicalJson(state.payload.recipe);
  const waiting = action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const retain = (next: SavedProjectDraft) => { setDraft(next); store.upsert(next); setSaveStatus(store.status()); runtime.session.selectDraft(next.id); };
  const submit = async (resume = false) => {
    if (!authority || (!resume && !validation.recipe) || !owner) return;
    try {
      if (resume) {
        const result = await action.resume((repository, frozen: ReplaceProjectCommand) => repository.replaceProject(frozen));
        if (result.ok && result.value.operation.phase === 'complete') { retain({ ...draft, baselineStateKey: result.value.value.key, updatedAt: runtime.now() }); setFailure(null); await onRefresh(); }
        return;
      }
      const id = crypto.randomUUID(), now = runtime.now();
      const input = replaceRecipeInput(project, validation.recipe!, id, now);
      if (!resume && staleBase) { setFailure('This editor was opened against an earlier record. Export the draft, then reload the current needs before applying it.'); return; }
      const command: ReplaceProjectCommand = { ...input, operation: createOperationIntent('replace_project', authority, input, { id, now }) };
      const result = await action.run(command, (repository, frozen) => repository.replaceProject(frozen));
      if (result.ok && result.value.operation.phase === 'complete') {
        retain({ ...draft, baselineStateKey: result.value.value.key, updatedAt: runtime.now() });
        setFailure(null); await onRefresh();
      }
    } catch (error) { setFailure(error instanceof Error ? error.message : 'The change could not be prepared. Your draft is retained.'); }
  };
  if (!owner) return <section className="pf-stack"><h2>What this project needs</h2><p>{state.payload.recipe.outcome}</p>{state.payload.recipe.variants.map(variant => <section className="pf-sheet pf-stack" key={variant.id}><h3>{variant.title}</h3><p>{variant.timeZone}</p><ul>{variant.requirements.map(requirement => <li key={requirement.id}>{requirement.quantity} {requirement.unit} · {requirement.title}</li>)}</ul></section>)}<p>Only the coordinator can change these needs. You can offer your own contribution.</p><Link href={routeHref({ name: 'contributions' })}>Prepare my contribution</Link></section>;
  return <section className="pf-stack">
    <div className="project-heading"><div><h2>Project needs and options</h2><p>Changes here remain draft terms until a new complete plan is proposed.</p></div><Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'plans' })}>Find and compare plans</Link></div>
    {staleBase && <Notice tone="warning" title="This project changed since the editor was opened"><p>Your input is retained. Export it before choosing to load the current needs.</p><Button variant="secondary" onClick={() => retain({ ...draft, editor: recipeToEditorDraft(state.payload.recipe), baselineStateKey: state.key, updatedAt: runtime.now() })}>Load current needs into the editor</Button></Notice>}
    <RecipeEditor value={state.payload.recipe} draft={draft.editor} onChange={() => {}} disabled={waiting || state.payload.lifecycle === 'closed'} onDraftChange={editor => retain({ ...draft, editor, updatedAt: runtime.now() })} />
    {!saveStatus.persisted && <Notice tone="warning">{copy.memoryOnly}</Notice>}
    {failure && <Notice tone="warning">{failure}</Notice>}
    <div className="pf-actions"><Button onClick={() => { void submit(); }} disabled={!validation.valid || !dirty || staleBase || waiting || !authority || state.payload.lifecycle === 'closed'} disabledReason={staleBase ? 'The saved project changed. Review the current needs first.' : !authority ? 'Select the coordinator account in this mode.' : !validation.valid ? 'Complete the marked fields first.' : undefined}>{session.mode === 'public' ? 'Publish updated draft needs' : 'Save updated needs'}</Button>
      <Button variant="secondary" onClick={() => downloadText('partfolk-project-draft.json', store.exportDraft(draft))}>{copy.exportDraft}</Button>
      <Button variant="quiet" disabled={waiting} onClick={() => retain({ ...draft, editor: recipeToEditorDraft(state.payload.recipe), baselineStateKey: state.key, updatedAt: runtime.now() })}>Discard my unsaved edits</Button>
    </div>
    <p role="status">{dirty ? 'The editor contains draft changes.' : 'The editor matches the saved needs.'} {saveStatus.persisted ? copy.saved : copy.memoryOnly}</p>
    <ActionFeedback state={action.state} onReconcile={() => { void action.reconcile().then(() => onRefresh()); }} onResume={action.recoverableCommand ? () => { void submit(true); } : undefined} />
  </section>;
}
