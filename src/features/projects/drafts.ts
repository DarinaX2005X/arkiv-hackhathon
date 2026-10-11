import type { AppRuntime } from '../../app/context';
import type { Actor, DataMode, EntityKey, ProjectRecipe } from '../../domain/types';
import { isEntityKey } from '../../app/ids';
import { isEditorDraft, recipeToEditorDraft, templateToEditorDraft, type EditorDraft } from './editor/model';
import { validateEntityPayload } from '../../domain/validation';
import type { ProjectState } from '../../domain/types';
import type { StorageIssue } from '../../app/storage';
import { hashCanonical } from '../../domain/canonical';

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
interface DeletedDraft { id: string; deletedAt: number }
function isDeletedDraft(value: unknown): value is DeletedDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') === 'deletedAt,id' && safeId(item.id)
    && Number.isSafeInteger(item.deletedAt) && Number(item.deletedAt) >= 0;
}
export class DraftChangedError extends Error {
  constructor(public readonly reason: 'deleted' | 'changed') {
    super(reason === 'deleted' ? 'This draft was deleted in another tab. Export your open copy if you want to keep it.'
      : 'This draft changed in another tab. Export your open copy, then reopen the saved draft before editing.');
  }
}
function makeProjectDraftStore(runtime: AppRuntime, scope: string) {
  const store = runtime.drafts(`projects:${scope}`, 'project-workspace', isDraftCollection);
  const loaded = store.load();
  let drafts = loaded.status === 'ready' ? loaded.value.drafts : [];
  const memoryOnly = new Map<string, SavedProjectDraft>();
  const pending = new Map<string, SavedProjectDraft>();
  const pendingBase = new Map<string, SavedProjectDraft | null>();
  const same = (left: SavedProjectDraft | null | undefined, right: SavedProjectDraft | null | undefined) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  const deleted = new Set<string>();
  const marker = (id: string) => runtime.drafts(`project-deleted:${hashCanonical(id)}`, 'project-deleted', isDeletedDraft);
  const isDeleted = (id: string) => {
    const result = marker(id).load();
    if (result.status === 'ready' && result.value.id === id) deleted.add(id);
    return deleted.has(id);
  };
  let issue: StorageIssue | null = loaded.status === 'recovery' || loaded.status === 'unavailable' ? loaded.issue : null;
  let persisted = loaded.status === 'ready' || loaded.status === 'missing';
  const fresh = () => {
    const current = store.load();
    if (current.status === 'ready' || current.status === 'missing') {
      drafts = (current.status === 'ready' ? current.value.drafts : []).filter(item => !isDeleted(item.id));
    } else { issue = current.issue; persisted = false; }
    return current;
  };
  const save = (next: SavedProjectDraft[]) => {
    const result = store.save({ drafts: next }); issue = result.issue; persisted = result.persisted;
    if (result.persisted) {
      drafts = next;
      for (const [id, draft] of pending) {
        if (deleted.has(id) || same(next.find(item => item.id === id), draft)) { pending.delete(id); pendingBase.delete(id); }
      }
    }
    return result;
  };
  const mergePending = () => {
    const merged = new Map(drafts.map(item => [item.id, item]));
    for (const item of pending.values()) {
      const deletion = marker(item.id).load();
      if (deletion.status === 'unavailable' || deletion.status === 'recovery' || isDeleted(item.id)) continue;
      // A failed edit stays exportable, but cannot overwrite another tab's newer edit.
      if (same(merged.get(item.id), pendingBase.get(item.id))) merged.set(item.id, item);
    }
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  };
  const validate = (draft: SavedProjectDraft) => {
    if (!isSavedProjectDraft(draft) || draft.scope !== scope) throw new TypeError('This draft belongs to a different account context.');
  };
  const list = () => {
    const merged = new Map(drafts.map(draft => [draft.id, draft]));
    for (const draft of [...pending.values(), ...memoryOnly.values()]) merged.set(draft.id, draft);
    return structuredClone([...merged.values()].filter(draft => !isDeleted(draft.id)).sort((a, b) => b.updatedAt - a.updatedAt));
  };
  const upsert = (draft: SavedProjectDraft, expected?: SavedProjectDraft) => {
    validate(draft);
    const deletion = marker(draft.id).load();
    if (isDeleted(draft.id)) throw new DraftChangedError('deleted');
    const current = fresh();
    const latest = drafts.find(item => item.id === draft.id);
    const baseline = pendingBase.has(draft.id) ? pendingBase.get(draft.id) : expected;
    if (baseline !== undefined && (latest || pendingBase.has(draft.id)) && !same(latest, baseline)) throw new DraftChangedError(latest ? 'changed' : 'deleted');
    if (expected && !latest && !pending.has(draft.id) && !memoryOnly.has(draft.id) && current.status !== 'unavailable' && current.status !== 'recovery') throw new DraftChangedError('deleted');
    if (!pendingBase.has(draft.id)) pendingBase.set(draft.id, latest ? structuredClone(latest) : null);
    pending.set(draft.id, structuredClone(draft)); memoryOnly.delete(draft.id);
    if (current.status === 'unavailable' || current.status === 'recovery') {
      issue = current.issue; persisted = false; return { value: { drafts: list() }, persisted: false, issue };
    }
    // A failed tombstone read cannot authorize a durable resurrection.
    if (deletion.status === 'unavailable' || deletion.status === 'recovery') {
      issue = deletion.issue; persisted = false; return { value: { drafts: list() }, persisted: false, issue };
    }
    return save(mergePending());
  };
  return {
    list,
    get: (id: string | null) => id === null ? undefined : list().find(draft => draft.id === id),
    refresh() { fresh(); return list(); },
    /** Called by an open editor before publication; a pending edit is not a fresh saved baseline. */
    currentConflict(expected: SavedProjectDraft) {
      const current = fresh();
      if (isDeleted(expected.id)) return 'deleted' as const;
      if (current.status !== 'unavailable' && current.status !== 'recovery' && pendingBase.has(expected.id)
        && !same(drafts.find(item => item.id === expected.id), pendingBase.get(expected.id))) return 'changed' as const;
      const latest = list().find(item => item.id === expected.id);
      return !latest ? 'deleted' as const : !same(latest, expected) ? 'changed' as const : null;
    },
    /** Explicit editor recovery, after giving the user an export action. */
    reloadSaved(id: string) {
      const current = fresh();
      if (current.status === 'unavailable' || current.status === 'recovery') throw new Error('The saved draft could not be read. Your open copy is retained; export it before leaving.');
      pending.delete(id); pendingBase.delete(id); memoryOnly.delete(id);
      persisted = true; issue = null;
      const saved = drafts.find(item => item.id === id);
      return saved ? structuredClone(saved) : undefined;
    },
    isDeleted,
    hasStored(id: string) { const current = store.load(); return current.status === 'ready' && current.value.drafts.some(item => item.id === id); },
    status: () => ({ persisted: persisted && memoryOnly.size === 0 && pending.size === 0, issue }),
    upsert,
    /** A draft handoff must save its owner/location claim before persisting a new account copy. */
    retainInMemory(draft: SavedProjectDraft, reason: StorageIssue | null) {
      validate(draft);
      if (isDeleted(draft.id)) throw new DraftChangedError('deleted');
      memoryOnly.set(draft.id, structuredClone(draft)); issue = reason ?? { code: 'write_failed', recoverableText: null };
      return { value: draft, persisted: false as const, issue };
    },
    /** Removes a handoff backup only. User deletion uses deleteDraft and a durable marker. */
    remove(id: string) {
      const current = fresh();
      if (current.status === 'unavailable' || current.status === 'recovery') return { value: { drafts: list() }, persisted: false, issue: current.issue };
      const result = save(mergePending().filter(item => item.id !== id && !isDeleted(item.id)));
      if (result.persisted) { memoryOnly.delete(id); pending.delete(id); pendingBase.delete(id); }
      return result;
    },
    deleteDraft(expected: SavedProjectDraft) {
      validate(expected); const current = fresh();
      if (current.status === 'unavailable' || current.status === 'recovery') return { value: { drafts: list() }, persisted: false, issue: current.issue, deleted: false };
      const latest = memoryOnly.get(expected.id) ?? pending.get(expected.id) ?? drafts.find(item => item.id === expected.id);
      if (!isDeleted(expected.id) && (latest && !same(latest, expected)
        || pendingBase.has(expected.id) && !same(drafts.find(item => item.id === expected.id), pendingBase.get(expected.id)))) throw new DraftChangedError('changed');
      // The marker contains no project text. All copies of this draft identity,
      // including a visitor handoff backup, stop being eligible for restoration.
      const marked = marker(expected.id).save({ id: expected.id, deletedAt: runtime.now() });
      if (!marked.persisted) { issue = marked.issue; return { ...marked, deleted: false }; }
      deleted.add(expected.id);
      const result = save(mergePending().filter(item => item.id !== expected.id && !isDeleted(item.id)));
      if (result.persisted) { memoryOnly.delete(expected.id); pending.delete(expected.id); pendingBase.delete(expected.id); }
      return { ...result, deleted: true };
    },
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
        const result = upsert(recipeDraft);
        return { status: 'imported' as const, draft: recipeDraft, persisted: result.persisted, issue: result.issue };
      }
      // A draft import only copies editable recipe data. It never imports a root or another owner's promises.
      const clone: SavedProjectDraft = { ...imported.value, id: globalThis.crypto.randomUUID(), scope,
        projectRoot: null, baselineStateKey: null, createdAt: runtime.now(), updatedAt: runtime.now() };
      const result = upsert(clone);
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
