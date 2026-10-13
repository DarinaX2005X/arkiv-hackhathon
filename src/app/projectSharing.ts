import { createAppRuntime, type AppRuntime } from './context';
import type { ProjectRecipe, RecipeTemplate } from '../domain/types';
import { createProjectDrafts, draftScope, makeDraft, type SavedProjectDraft } from '../features/projects/drafts';
import { recipeToEditorDraft, templateToEditorDraft } from '../features/projects/editor/model';

/** A public draft copies only editable recipe fields; publication still requires review and a wallet. */
export function copyRecipeToPublicDraft(runtime: AppRuntime, source: ProjectRecipe | SavedProjectDraft) {
  const session = runtime.session.getSnapshot();
  if (session.mode !== 'public') throw new TypeError('Choose the shared workspace before preparing a public draft.');
  const scope = draftScope('public', session.actor);
  const editor = structuredClone('editor' in source ? source.editor : recipeToEditorDraft(source));
  if (editor.sourceProjectRoot?.startsWith('local:')) delete editor.sourceProjectRoot;
  const draft = { ...makeDraft(scope, undefined, runtime.now()), editor };
  const drafts = createProjectDrafts(runtime, scope);
  const saved = drafts.upsert(draft);
  runtime.session.selectDraft(draft.id);
  return { draft, saved };
}

/** Desk hands editable work to Studio through storage only, never transferring a signer. */
export function copyTemplateToStudioDraft(sourceRuntime: AppRuntime, template: RecipeTemplate) {
  const source = sourceRuntime.session.getSnapshot();
  if (source.mode !== 'public' || source.actor?.kind === 'local') throw new TypeError('A public workspace is required to reuse this project.');
  const target = createAppRuntime({ storage: sourceRuntime.storage, namespace: 'partfolk:studio:public', now: sourceRuntime.now });
  target.session.setMode('public');
  const scope = draftScope('public', source.actor);
  const editor = templateToEditorDraft(structuredClone(template));
  if (editor.sourceProjectRoot?.startsWith('local:')) delete editor.sourceProjectRoot;
  const draft = { ...makeDraft(scope, undefined, sourceRuntime.now()), editor };
  const saved = createProjectDrafts(target, scope).upsert(draft);
  if (!saved.persisted) return { draft, saved };
  target.session.selectDraft(draft.id);
  const issue = target.session.getSnapshot().storageIssue;
  return { draft, saved: issue ? { ...saved, persisted: false, issue } : saved };
}
