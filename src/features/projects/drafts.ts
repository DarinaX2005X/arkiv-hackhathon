import type { AppRuntime } from '../../app/context';
import type { Actor, DataMode, EntityKey, ProjectRecipe } from '../../domain/types';
import { isEntityKey } from '../../app/ids';
import { isEditorDraft, recipeToEditorDraft, templateToEditorDraft, type EditorDraft } from './editor';
import { validateEntityPayload } from '../../domain/validation';
import type { ProjectState } from '../../domain/types';
import type { StorageIssue } from '../../app/storage';

export interface SavedProjectDraft {
  id: string; scope: string; createdAt: number; updatedAt: number;
  projectRoot: EntityKey | null; baselineStateKey: EntityKey | null; editor: EditorDraft;
}
export interface DraftCollection { drafts: SavedProjectDraft[] }
export function draftScope(mode: DataMode, actor: Actor | null): string {
  return `${mode}:${actor === null ? 'visitor' : actor.kind === 'wallet' ? actor.address.toLowerCase() : actor.id}`;
}
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
export function isSavedProjectDraft(value: unknown): value is SavedProjectDraft {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') === 'baselineStateKey,createdAt,editor,id,projectRoot,scope,updatedAt'
    && safeId(item.id) && safeId(item.scope) && Number.isSafeInteger(item.createdAt) && Number.isSafeInteger(item.updatedAt)
    && Number(item.createdAt) >= 0 && Number(item.updatedAt) >= Number(item.createdAt)
    && (item.projectRoot === null || isEntityKey(item.projectRoot))
    && (item.baselineStateKey === null || isEntityKey(item.baselineStateKey)) && isEditorDraft(item.editor);
}
export function isDraftCollection(value: unknown): value is DraftCollection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).join(',') === 'drafts' && Array.isArray(item.drafts) && item.drafts.length <= 100
    && item.drafts.every(isSavedProjectDraft) && new Set(item.drafts.map(draft => draft.id)).size === item.drafts.length;
}
export function blankRecipe(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): ProjectRecipe {
  return { title: '', outcome: '', timeZone, variants: [], instructions: '' };
}
export function makeDraft(scope: string, recipe = blankRecipe(), now = Date.now(), id: string = globalThis.crypto.randomUUID()): SavedProjectDraft {
  return { id, scope, createdAt: now, updatedAt: now, projectRoot: null, baselineStateKey: null, editor: recipeToEditorDraft(recipe) };
}
/** Verification packets can supply a recipe, never imported agreement or authority. */
export function draftFromRecipePacket(raw: string, scope: string, now: number, id: string = globalThis.crypto.randomUUID()): SavedProjectDraft | null {
  if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) return null;
  let data: unknown; try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const packet = data as Record<string, unknown>;
  if (packet.format !== 'partfolk-export' || packet.version !== 1 || !packet.project || typeof packet.project !== 'object') return null;
  const project = packet.project as Record<string, unknown>;
  const scopeState = project.state as { status?: unknown; entity?: { payload?: unknown } } | undefined;
  const root = project.root as { key?: unknown } | undefined;
  if (scopeState?.status !== 'unique' || !isEntityKey(root?.key) || !validateEntityPayload(scopeState.entity?.payload).valid) return null;
  const state = scopeState.entity!.payload as ProjectState;
  if (state.entityType !== 'project_state' || state.projectRoot !== root.key) return null;
  return { id, scope, createdAt: now, updatedAt: now, projectRoot: null, baselineStateKey: null,
    editor: templateToEditorDraft({ ...state.recipe, sourceProjectRoot: root.key,
      variants: state.recipe.variants.map(variant => ({ ...variant, requirements: variant.requirements.map(({ interval: _dates, ...requirement }) => requirement) })) }) };
}
function makeProjectDraftStore(runtime: AppRuntime, scope: string) {
  const store = runtime.drafts(`projects:${scope}`, 'project-workspace', isDraftCollection);
  const loaded = store.load();
  let drafts = loaded.status === 'ready' ? loaded.value.drafts : [];
  const memoryOnly = new Map<string, SavedProjectDraft>();
  let issue: StorageIssue | null = loaded.status === 'recovery' || loaded.status === 'unavailable' ? loaded.issue : null;
  let persisted = loaded.status === 'ready' || loaded.status === 'missing';
  const save = () => {
    const result = store.save({ drafts }); issue = result.issue; persisted = result.persisted;
    return result;
  };
  const retain = (draft: SavedProjectDraft) => {
    if (!isSavedProjectDraft(draft) || draft.scope !== scope) throw new TypeError('This draft belongs to a different account context.');
    drafts = [...drafts.filter(item => item.id !== draft.id), structuredClone(draft)].sort((a, b) => b.updatedAt - a.updatedAt);
  };
  return {
    list: () => structuredClone([...drafts.filter(draft => !memoryOnly.has(draft.id)), ...memoryOnly.values()].sort((a, b) => b.updatedAt - a.updatedAt)),
    get: (id: string | null) => id === null ? undefined : memoryOnly.get(id) ?? drafts.find(draft => draft.id === id),
    status: () => ({ persisted: persisted && memoryOnly.size === 0, issue }),
    upsert(draft: SavedProjectDraft) {
      retain(draft);
      memoryOnly.delete(draft.id);
      return save();
    },
    /** A draft handoff must save its owner/location claim before persisting a new account copy. */
    retainInMemory(draft: SavedProjectDraft, reason: StorageIssue | null) {
      if (!isSavedProjectDraft(draft) || draft.scope !== scope) throw new TypeError('This draft belongs to a different account context.');
      memoryOnly.set(draft.id, structuredClone(draft)); issue = reason ?? { code: 'write_failed', recoverableText: null };
      return { value: draft, persisted: false as const, issue };
    },
    remove(id: string) { memoryOnly.delete(id); drafts = drafts.filter(item => item.id !== id); return save(); },
    exportDraft(draft: SavedProjectDraft) {
      const single = runtime.drafts(`project-export:${draft.id}`, 'project-draft', isSavedProjectDraft);
      return single.export(draft);
    },
    importDraft(raw: string) {
      const single = runtime.drafts('project-import', 'project-draft', isSavedProjectDraft);
      const imported = single.inspectImport(raw);
      if (imported.status !== 'ready') {
        const recipeDraft = draftFromRecipePacket(raw, scope, runtime.now());
        if (!recipeDraft) return imported;
        drafts = [recipeDraft, ...drafts]; const result = save();
        return { status: 'imported' as const, draft: recipeDraft, persisted: result.persisted, issue: result.issue };
      }
      // A draft import only copies editable recipe data. It never imports a root or another owner's promises.
      const clone: SavedProjectDraft = { ...imported.value, id: globalThis.crypto.randomUUID(), scope,
        projectRoot: null, baselineStateKey: null, createdAt: runtime.now(), updatedAt: runtime.now() };
      drafts = [clone, ...drafts];
      const result = save();
      return { status: 'imported' as const, draft: clone, persisted: result.persisted, issue: result.issue };
    },
    exportRecovery: store.exportRecovery,
  };
}
const projectDraftStores = new WeakMap<AppRuntime, Map<string, ReturnType<typeof makeProjectDraftStore>>>();
/** One memory collection survives route changes even when persistent storage is blocked. */
export function createProjectDrafts(runtime: AppRuntime, scope: string): ReturnType<typeof makeProjectDraftStore> {
  let stores = projectDraftStores.get(runtime);
  if (!stores) { stores = new Map(); projectDraftStores.set(runtime, stores); }
  let store = stores.get(scope);
  if (!store) { store = makeProjectDraftStore(runtime, scope); stores.set(scope, store); }
  return store;
}
export function downloadText(filename: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
