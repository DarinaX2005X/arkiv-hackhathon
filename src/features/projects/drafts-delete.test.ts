import { describe, expect, it, vi } from 'vitest';
import { createAppRuntime } from '../../app/context';
import type { StoragePort } from '../../app/storage';
import { createMemoryStorage } from '../../data/local';
import { TIRAMISU_CHAIN_ID, type Actor } from '../../domain/types';
import { createProjectDrafts, draftScope, makeDraft } from './drafts';
import { deleteProjectDraft, openNewProjectDraft, saveNewProjectDraft } from './draft-session';

const NOW = Date.UTC(2026, 9, 11);
const wallet: Actor = { kind: 'wallet', address: '0xAa00000000000000000000000000000000000001' };
const scope = draftScope('public', wallet);
function runtime(storage: StoragePort | null = createMemoryStorage()) {
  const app = createAppRuntime({ storage, namespace: 'draft-delete', now: () => NOW });
  app.session.setMode('public'); app.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
  return app;
}
function example(id = 'draft-one') { const draft = makeDraft(scope, undefined, NOW, id); draft.editor.title = 'Community workshop'; return draft; }

describe('project draft deletion and concurrent tabs', () => {
  it('deletes a confirmed draft persistently and clears its active selection', () => {
    const storage = createMemoryStorage(), app = runtime(storage), draft = example();
    saveNewProjectDraft(app, draft); app.session.selectDraft(draft.id);
    expect(deleteProjectDraft(app, draft)).toMatchObject({ persisted: true, deleted: true });
    expect(createProjectDrafts(app, scope).list()).toEqual([]);
    expect(app.session.getSnapshot().activeDraftId).toBeNull();
    const restarted = runtime(storage);
    expect(createProjectDrafts(restarted, scope).list()).toEqual([]);
    expect(openNewProjectDraft(restarted).draft.id).not.toBe(draft.id);
    expect(storage.getItem(`draft-delete:draft:projects:${scope}`)).not.toContain('Community workshop');
  });
  it('keeps saved text unchanged while preparing and exporting a deletion review', () => {
    const storage = createMemoryStorage(), app = runtime(storage), draft = example();
    const store = createProjectDrafts(app, scope); store.upsert(draft);
    const review = store.get(draft.id)!;
    expect(store.exportDraft(review)).toContain('Community workshop');
    expect(createProjectDrafts(runtime(storage), scope).get(draft.id)).toEqual(draft);
  });
  it('keeps the draft when persistence rejects deletion and allows a later retry', () => {
    const backing = createMemoryStorage(); let fail = false;
    const storage: StoragePort = { getItem: key => backing.getItem(key), setItem: (key, value) => { if (fail) throw Error('Storage full'); backing.setItem(key, value); }, removeItem: key => backing.removeItem(key) };
    const app = runtime(storage), draft = example(), store = createProjectDrafts(app, scope); store.upsert(draft);
    fail = true;
    expect(deleteProjectDraft(app, draft)).toMatchObject({ persisted: false, deleted: false });
    expect(store.get(draft.id)).toEqual(draft);
    fail = false;
    expect(deleteProjectDraft(app, draft).persisted).toBe(true);
    expect(createProjectDrafts(runtime(storage), scope).get(draft.id)).toBeUndefined();
  });
  it('retains a memory-only draft if browser storage cannot record its deletion', () => {
    const app = runtime(null), draft = example(), store = createProjectDrafts(app, scope); store.upsert(draft);
    expect(deleteProjectDraft(app, draft)).toMatchObject({ persisted: false, deleted: false });
    expect(store.get(draft.id)).toEqual(draft);
  });
  it('fails closed when the current collection cannot be read, even if writes still work', () => {
    const backing = createMemoryStorage(); let failRead = false;
    const storage: StoragePort = { getItem: key => { if (failRead && key.endsWith(`projects:${scope}`)) throw Error('Read denied'); return backing.getItem(key); }, setItem: (key, value) => backing.setItem(key, value), removeItem: key => backing.removeItem(key) };
    const app = runtime(storage), draft = example(), store = createProjectDrafts(app, scope); store.upsert(draft);
    const other = example('another-tab'); createProjectDrafts(runtime(backing), scope).upsert(other);
    const before = backing.getItem(`draft-delete:draft:projects:${scope}`);
    failRead = true;
    expect(store.upsert({ ...draft, editor: { ...draft.editor, title: 'Memory edit' } }, draft).persisted).toBe(false);
    expect(deleteProjectDraft(app, draft)).toMatchObject({ persisted: false, deleted: false });
    expect(backing.getItem(`draft-delete:draft:projects:${scope}`)).toBe(before);
  });
  it('preserves a failed local edit without overwriting newer work on retry', () => {
    const backing = createMemoryStorage(); let failWrite = false;
    const storage: StoragePort = { getItem: key => backing.getItem(key), setItem: (key, value) => { if (failWrite && key.endsWith(`projects:${scope}`)) throw Error('Full'); backing.setItem(key, value); }, removeItem: key => backing.removeItem(key) };
    const app = runtime(storage), draft = example(), store = createProjectDrafts(app, scope); store.upsert(draft);
    failWrite = true;
    const memoryEdit = { ...draft, editor: { ...draft.editor, title: 'Unsaved local edit' } };
    expect(store.upsert(memoryEdit, draft).persisted).toBe(false);
    const remoteEdit = { ...draft, editor: { ...draft.editor, title: 'Saved elsewhere' } };
    createProjectDrafts(runtime(backing), scope).upsert(remoteEdit, draft);
    failWrite = false;
    expect(() => store.upsert(memoryEdit, memoryEdit)).toThrow(/changed/);
    expect(store.currentConflict(memoryEdit)).toBe('changed');
    expect(() => deleteProjectDraft(app, memoryEdit)).toThrow(/changed/);
    expect(store.get(draft.id)).toEqual(memoryEdit);
    expect(createProjectDrafts(runtime(backing), scope).get(draft.id)).toEqual(remoteEdit);
    expect(store.reloadSaved(draft.id)).toEqual(remoteEdit);
    expect(store.get(draft.id)).toEqual(remoteEdit);
    expect(store.currentConflict(remoteEdit)).toBeNull();
  });
  it('saves unrelated drafts without writing a conflicted pending edit or losing its export', () => {
    const backing = createMemoryStorage(); let failWrite = false;
    const storage: StoragePort = { getItem: key => backing.getItem(key), setItem: (key, value) => { if (failWrite && key.endsWith(`projects:${scope}`)) throw Error('Full'); backing.setItem(key, value); }, removeItem: key => backing.removeItem(key) };
    const app = runtime(storage), draft = example(), store = createProjectDrafts(app, scope); store.upsert(draft);
    failWrite = true;
    const pending = { ...draft, editor: { ...draft.editor, title: 'Keep this unsaved text' } };
    store.upsert(pending, draft);
    const remote = { ...draft, editor: { ...draft.editor, title: 'Newer saved work' } };
    createProjectDrafts(runtime(backing), scope).upsert(remote, draft);
    failWrite = false;
    const another = example('separate'); expect(store.upsert(another).persisted).toBe(true);
    expect(createProjectDrafts(runtime(backing), scope).get(draft.id)).toEqual(remote);
    expect(store.get(draft.id)).toEqual(pending);
    expect(store.status().persisted).toBe(false);
    expect(store.exportDraft(store.get(draft.id)!)).toContain('Keep this unsaved text');
    deleteProjectDraft(app, another);
    expect(createProjectDrafts(runtime(backing), scope).get(draft.id)).toEqual(remote);
    expect(store.get(draft.id)).toEqual(pending);
  });
  it('retains pending text if an explicit saved-copy reload cannot read storage', () => {
    const backing = createMemoryStorage(); let failRead = false;
    const storage: StoragePort = { getItem: key => { if (failRead) throw Error('Read failed'); return backing.getItem(key); }, setItem: (key, value) => backing.setItem(key, value), removeItem: key => backing.removeItem(key) };
    const store = createProjectDrafts(runtime(storage), scope), draft = example(); store.upsert(draft);
    failRead = true;
    const pending = { ...draft, editor: { ...draft.editor, title: 'Not yet saved' } };
    store.upsert(pending, draft);
    expect(() => store.reloadSaved(draft.id)).toThrow(/could not be read/);
    expect(store.get(draft.id)).toEqual(pending);
  });
  it('keeps a deletion marker when collection cleanup fails and completes cleanup on retry', () => {
    const backing = createMemoryStorage(); let failCleanup = false;
    const storage: StoragePort = { getItem: key => backing.getItem(key), setItem: (key, value) => { if (failCleanup && key.endsWith(`projects:${scope}`)) throw Error('Cleanup failed'); backing.setItem(key, value); }, removeItem: key => backing.removeItem(key) };
    const app = runtime(storage), draft = example(); createProjectDrafts(app, scope).upsert(draft);
    failCleanup = true;
    expect(deleteProjectDraft(app, draft)).toMatchObject({ deleted: true, persisted: false });
    const other = createProjectDrafts(runtime(backing), scope);
    expect(other.get(draft.id)).toBeUndefined();
    expect(() => other.upsert(draft)).toThrow(/deleted/);
    failCleanup = false;
    expect(deleteProjectDraft(app, draft).persisted).toBe(true);
    expect(backing.getItem(`draft-delete:draft:projects:${scope}`)).not.toContain('Community workshop');
  });
  it('keeps another tab’s newly created drafts when editing or deleting an older draft', () => {
    const storage = createMemoryStorage(), first = runtime(storage), second = runtime(storage);
    const firstStore = createProjectDrafts(first, scope), secondStore = createProjectDrafts(second, scope);
    const original = example(), another = example('other-tab');
    firstStore.upsert(original); secondStore.refresh(); secondStore.upsert(another);
    const edited = { ...original, editor: { ...original.editor, title: 'Updated workshop' }, updatedAt: NOW + 1 };
    firstStore.upsert(edited, original);
    expect(createProjectDrafts(runtime(storage), scope).get(another.id)).toEqual(another);
    deleteProjectDraft(first, edited);
    expect(createProjectDrafts(runtime(storage), scope).list()).toEqual([another]);
  });
  it('refuses a stale editor save after deletion and never restores it via another draft save', () => {
    const storage = createMemoryStorage(), first = runtime(storage), second = runtime(storage), draft = example();
    const firstStore = createProjectDrafts(first, scope); firstStore.upsert(draft);
    const secondStore = createProjectDrafts(second, scope); expect(secondStore.get(draft.id)).toEqual(draft);
    deleteProjectDraft(first, draft);
    expect(() => secondStore.upsert({ ...draft, editor: { ...draft.editor, title: 'Old tab edit' } }, draft)).toThrow(/deleted/);
    secondStore.upsert(example('still-here'));
    expect(createProjectDrafts(runtime(storage), scope).list().map(item => item.id)).toEqual(['still-here']);
  });
  it('requires reviewing a changed draft again before deleting or overwriting it', () => {
    const storage = createMemoryStorage(), first = runtime(storage), second = runtime(storage), draft = example();
    const firstStore = createProjectDrafts(first, scope); firstStore.upsert(draft);
    const secondStore = createProjectDrafts(second, scope); const stale = secondStore.get(draft.id)!;
    const edited = { ...draft, editor: { ...draft.editor, title: 'Newer title' } }; firstStore.upsert(edited, draft);
    expect(() => deleteProjectDraft(second, stale)).toThrow(/changed/);
    expect(() => secondStore.upsert({ ...stale, updatedAt: NOW + 1 }, stale)).toThrow(/changed/);
    expect(createProjectDrafts(runtime(storage), scope).get(draft.id)).toEqual(edited);
  });
  it('deletes a local edit without calling the repository or touching a published project', () => {
    const storage = createMemoryStorage(), app = runtime(storage), draft = { ...example(), projectRoot: 'local:published-project' as const, baselineStateKey: 'local:published-state' as const };
    const repository = new Proxy({}, { get: vi.fn(() => { throw Error('No network mutation allowed'); }) });
    Object.assign(app, { repository }); createProjectDrafts(app, scope).upsert(draft);
    expect(deleteProjectDraft(app, draft).persisted).toBe(true);
    expect(createProjectDrafts(runtime(storage), scope).get(draft.id)).toBeUndefined();
  });
  it('does not let another account delete the draft', () => {
    const app = runtime(), draft = example(); createProjectDrafts(app, scope).upsert(draft);
    app.session.setAccount({ kind: 'wallet', address: '0xbb00000000000000000000000000000000000002' }, TIRAMISU_CHAIN_ID);
    expect(() => deleteProjectDraft(app, draft)).toThrow(/owns this draft/);
    expect(createProjectDrafts(app, scope).get(draft.id)).toEqual(draft);
  });
  it('cannot restore a deleted wallet draft from a failed visitor handoff backup', () => {
    const backing = createMemoryStorage(); let failVisitorRemoval = false;
    const storage: StoragePort = { getItem: key => backing.getItem(key), setItem: (key, value) => { if (failVisitorRemoval && key.endsWith('projects:public:visitor')) throw Error('Cannot remove backup'); backing.setItem(key, value); }, removeItem: key => backing.removeItem(key) };
    const app = runtime(storage); app.session.setAccount(null);
    const visitor = openNewProjectDraft(app); app.session.selectDraft(visitor.draft.id);
    failVisitorRemoval = true; app.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
    const handedOff = openNewProjectDraft(app); expect(handedOff.transferred).toBe(true);
    failVisitorRemoval = false;
    expect(deleteProjectDraft(app, handedOff.draft).persisted).toBe(true);
    const restarted = runtime(storage);
    expect(createProjectDrafts(restarted, 'public:visitor').get(visitor.draft.id)).toBeUndefined();
    expect(openNewProjectDraft(restarted).draft.id).not.toBe(visitor.draft.id);
    expect(backing.getItem('draft-delete:draft:projects:public:visitor')).not.toContain(visitor.draft.id);
  });
});
