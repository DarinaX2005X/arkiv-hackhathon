import type { AppRuntime } from '../../app/context';
import type { AppSession } from '../../app/session';
import type { StorageIssue } from '../../app/storage';
import { createProjectDrafts, draftScope, makeDraft, type SavedProjectDraft } from './drafts';
import { validateEditorDraft } from './editor';

type DraftSession = Pick<AppSession, 'mode' | 'actor' | 'activeDraftId'>;
type ProjectDraftStore = ReturnType<typeof createProjectDrafts>;
interface DraftHandle {
  id: string;
  /** Account context that owns this draft, never a wallet/signing authority. */
  scope: string;
  /** Retained until a visitor handoff has been saved in its destination. */
  originScope: string | null;
}
export interface NewProjectDraftState {
  draft: SavedProjectDraft;
  store: ProjectDraftStore;
  foreign: boolean;
  transferred: boolean;
  status: { persisted: boolean; issue: StorageIssue | null };
  recoveryText: string | null;
}

const scopePattern = /^(?:public:(?:visitor|0x[0-9a-f]{40})|local:(?:visitor|local-actor:[a-zA-Z0-9._:-]{1,100}))$/;
function isHandle(value: unknown): value is DraftHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'id,originScope,scope'
    && typeof record.id === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(record.id)
    && typeof record.scope === 'string' && scopePattern.test(record.scope)
    && (record.originScope === null || record.originScope === 'public:visitor')
    && (record.originScope === null || /^public:0x[0-9a-f]{40}$/.test(record.scope));
}

function makeHandleStore(runtime: AppRuntime) {
  const store = runtime.drafts('project-new-draft-origin', 'project-new-draft-origin', isHandle);
  const loaded = store.load();
  let handle = loaded.status === 'ready' ? loaded.value : null;
  let status: NewProjectDraftState['status'] = {
    persisted: loaded.status === 'ready' || loaded.status === 'missing',
    issue: loaded.status === 'unavailable' || loaded.status === 'recovery' ? loaded.issue : null,
  };
  return {
    get: () => handle,
    status: () => status,
    save(next: DraftHandle) {
      handle = structuredClone(next);
      const result = store.save(next);
      status = { persisted: result.persisted, issue: result.issue };
      return status;
    },
    recovery: store.exportRecovery,
  };
}
const handles = new WeakMap<AppRuntime, ReturnType<typeof makeHandleStore>>();
function handleStore(runtime: AppRuntime) {
  let store = handles.get(runtime);
  if (!store) { store = makeHandleStore(runtime); handles.set(runtime, store); }
  return store;
}

function state(runtime: AppRuntime, draft: SavedProjectDraft, session: DraftSession, transferred: boolean): NewProjectDraftState {
  const store = createProjectDrafts(runtime, draft.scope);
  const handle = handleStore(runtime);
  const draftStatus = store.status(), handleStatus = handle.status();
  return {
    draft: structuredClone(draft), store, foreign: draft.scope !== draftScope(session.mode, session.actor), transferred,
    status: { persisted: draftStatus.persisted && handleStatus.persisted, issue: draftStatus.issue ?? handleStatus.issue },
    recoveryText: handle.recovery(),
  };
}

function followHandle(runtime: AppRuntime, handle: DraftHandle): SavedProjectDraft | null {
  const owned = createProjectDrafts(runtime, handle.scope).get(handle.id);
  if (owned) return owned;
  if (!handle.originScope) return null;
  const origin = createProjectDrafts(runtime, handle.originScope).get(handle.id);
  if (!origin || origin.projectRoot !== null) return null;
  // A handoff claim is already associated with the original wallet. It cannot
  // become a new visitor draft merely because that wallet disconnected.
  const recovered = { ...origin, scope: handle.scope };
  createProjectDrafts(runtime, handle.scope).upsert(recovered);
  return recovered;
}

/**
 * Resolve the explicitly selected new-project draft across connection and route
 * changes. Only an unowned public visitor draft may move to a connected wallet.
 * A different wallet's data remains in its original scope and read-only.
 */
export function openNewProjectDraft(runtime: AppRuntime, session: DraftSession = runtime.session.getSnapshot()): NewProjectDraftState {
  const targetScope = draftScope(session.mode, session.actor);
  const handles = handleStore(runtime), remembered = handles.get();
  const selectedId = session.activeDraftId ?? remembered?.id ?? null;
  let draft: SavedProjectDraft | null = null;
  if (remembered && remembered.id === selectedId) draft = followHandle(runtime, remembered);
  if (!draft && selectedId) draft = createProjectDrafts(runtime, targetScope).get(selectedId) ?? null;
  if (!draft && selectedId && session.mode === 'public' && session.actor?.kind === 'wallet'
    && (!remembered || remembered.id !== selectedId)) {
    // Supports an existing visitor draft from before origin handles were added.
    // No account stores are enumerated or searched.
    draft = createProjectDrafts(runtime, 'public:visitor').get(selectedId) ?? null;
  }
  if (!draft || draft.projectRoot !== null) {
    draft = makeDraft(targetScope, undefined, runtime.now());
    createProjectDrafts(runtime, targetScope).upsert(draft);
    handles.save({ id: draft.id, scope: draft.scope, originScope: null });
    return state(runtime, draft, session, false);
  }

  if (draft.scope === 'public:visitor' && session.mode === 'public' && session.actor?.kind === 'wallet') {
    const origin = createProjectDrafts(runtime, draft.scope);
    // Record the intended owner before touching either copy. If destination
    // persistence fails, reconnecting another wallet cannot claim the backup.
    const claim = handles.save({ id: draft.id, scope: targetScope, originScope: draft.scope });
    const transferred = { ...draft, scope: targetScope, updatedAt: Math.max(draft.updatedAt, runtime.now()) };
    const destination = createProjectDrafts(runtime, targetScope);
    // Without a durable claim, do not leave a durable wallet copy beside an
    // unclaimed visitor backup. Keep this handoff in the runtime cache instead.
    const saved = claim.persisted ? destination.upsert(transferred) : destination.retainInMemory(transferred, claim.issue);
    if (saved.persisted && handles.status().persisted) {
      const removed = origin.remove(draft.id);
      if (removed.persisted) handles.save({ id: draft.id, scope: targetScope, originScope: null });
    }
    return state(runtime, transferred, session, true);
  }

  if (!remembered || remembered.id !== draft.id || remembered.scope !== draft.scope) {
    handles.save({ id: draft.id, scope: draft.scope, originScope: null });
  }
  return state(runtime, draft, session, false);
}

/** Save only in the live account's scope. Public authority is never stored here. */
export function saveNewProjectDraft(runtime: AppRuntime, draft: SavedProjectDraft): NewProjectDraftState['status'] {
  const session = runtime.session.getSnapshot();
  if (draft.scope !== draftScope(session.mode, session.actor)) throw new TypeError('Reconnect the account that owns this draft before editing it.');
  const handles = handleStore(runtime), remembered = handles.get();
  const originScope = remembered?.id === draft.id && remembered.scope === draft.scope ? remembered.originScope : null;
  const handle = handles.save({ id: draft.id, scope: draft.scope,
    originScope });
  const destination = createProjectDrafts(runtime, draft.scope);
  const saved = originScope && !handle.persisted ? destination.retainInMemory(draft, handle.issue) : destination.upsert(draft);
  if (originScope && handle.persisted && saved.persisted) {
    const removed = createProjectDrafts(runtime, originScope).remove(draft.id);
    if (removed.persisted) handles.save({ id: draft.id, scope: draft.scope, originScope: null });
  }
  return { persisted: saved.persisted && handle.persisted, issue: saved.issue ?? handle.issue };
}

/** Explicitly start another draft; the previous account's draft remains intact. */
export function startNewProjectDraft(runtime: AppRuntime): NewProjectDraftState {
  const session = runtime.session.getSnapshot();
  const draft = makeDraft(draftScope(session.mode, session.actor), undefined, runtime.now());
  saveNewProjectDraft(runtime, draft);
  return state(runtime, draft, session, false);
}

/** Explicit creation chooses its new identity. Clearing a selection only resumes remembered work. */
export function selectNewProjectDraft(runtime: AppRuntime): NewProjectDraftState {
  const created = startNewProjectDraft(runtime);
  runtime.session.selectDraft(created.draft.id);
  return created;
}

/** The caller chooses a destination. This copy carries draft text, never signing authority. */
export function newProjectDraftForSharing(runtime: AppRuntime, draft: SavedProjectDraft): SavedProjectDraft | null {
  const session = runtime.session.getSnapshot();
  if (session.mode !== 'local' || draft.scope !== draftScope(session.mode, session.actor) || !validateEditorDraft(draft.editor).valid) return null;
  return structuredClone(draft);
}
