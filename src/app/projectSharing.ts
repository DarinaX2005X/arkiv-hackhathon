import type { AppRuntime } from './context';
import type { ProjectRecipe } from '../domain/types';
import { createProjectDrafts, draftScope, makeDraft, type SavedProjectDraft } from '../features/projects/drafts';
import { recipeToEditorDraft } from '../features/projects/editor/model';

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
