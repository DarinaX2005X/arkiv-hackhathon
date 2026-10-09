import { describe, expect, it } from 'vitest';
import { createAppRuntime, type AppRuntime } from '../../app/context';
import type { StoragePort } from '../../app/storage';
import { createMemoryStorage } from '../../data/local';
import { TIRAMISU_CHAIN_ID, type Actor, type ProjectRecipe } from '../../domain/types';
import { newProjectDraftForSharing, openNewProjectDraft, saveNewProjectDraft, startNewProjectDraft } from './draft-session';
import { createProjectDrafts, draftScope, makeDraft, type SavedProjectDraft } from './drafts';
import { validateEditorDraft } from './editor';

const NOW = Date.UTC(2026, 9, 9, 12);
const WALLET_A: Actor = { kind: 'wallet', address: '0xAa00000000000000000000000000000000000001' };
const WALLET_B: Actor = { kind: 'wallet', address: '0xbb00000000000000000000000000000000000002' };
const SCOPE_A = draftScope('public', WALLET_A);
const SCOPE_B = draftScope('public', WALLET_B);
const RECIPE: ProjectRecipe = {
  title: '  Unfinished exhibition  ', outcome: 'Keep every raw field', timeZone: 'UTC',
  instructions: 'Project instructions\nwith a second line.', sourceProjectRoot: 'local:recipe-source',
  variants: [{
    id: 'variant-one', title: 'Sunday', venueId: 'hall-one', timeZone: 'Europe/London',
    instructions: 'Variant instructions', requirements: [{
      id: 'requirement-one', title: 'Carry boards', kind: 'person', capability: 'carrying',
      unit: 'person', quantity: 2, interval: { start: NOW + 123, end: NOW + 3_600_456 },
      instructions: 'Requirement instructions', dependsOn: [],
    }, {
      id: 'requirement-two', title: 'Install boards', kind: 'equipment', capability: 'display',
      unit: 'board', quantity: 6, interval: { start: NOW + 7_200_789, end: NOW + 10_800_987 },
      instructions: 'Keep this dependency', dependsOn: ['requirement-one'],
    }],
  }],
};

function runtimeWith(storage: StoragePort | null = createMemoryStorage()) {
  return createAppRuntime({ storage, namespace: 'draft-session-test', now: () => NOW });
}

function openAndSelect(runtime: AppRuntime) {
  const opened = openNewProjectDraft(runtime);
  runtime.session.selectDraft(opened.draft.id);
  return opened;
}

function rawDraft(scope: string, id: string): SavedProjectDraft {
  const draft = makeDraft(scope, RECIPE, NOW, id);
  draft.editor.variants[0]!.requirements[0]!.quantity = '  1.5e-nope  ';
  draft.editor.variants[0]!.requirements[0]!.startLocal = '2026-13-99T25:70';
  draft.editor.variants[0]!.requirements[0]!.endLocal = 'unfinished date';
  draft.editor.variants[0]!.requirements[0]!.startDisambiguation = 'later';
  return draft;
}

function saveVisibleRaw(runtime: AppRuntime): SavedProjectDraft {
  const opened = openAndSelect(runtime);
  const draft = rawDraft(opened.draft.scope, opened.draft.id);
  saveNewProjectDraft(runtime, draft);
  return draft;
}

function connect(runtime: AppRuntime, actor: Actor = WALLET_A) {
  runtime.session.setAccount(actor, TIRAMISU_CHAIN_ID);
}

describe('new project draft session ownership', () => {
  it('opens without selecting a draft on behalf of the component', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    const opened = openNewProjectDraft(runtime);
    expect(runtime.session.getSnapshot().activeDraftId).toBeNull();
    expect(opened.draft.scope).toBe('public:visitor');
    expect(opened.draft.projectRoot).toBeNull();
    expect(opened.draft.baselineStateKey).toBeNull();
    expect(opened.foreign).toBe(false);
    expect(opened.transferred).toBe(false);
  });

  it('assigns the current visitor draft to the connected wallet without changing its raw recipe', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    const before = saveVisibleRaw(runtime);
    expect(validateEditorDraft(before.editor).valid).toBe(false);

    connect(runtime);
    const opened = openAndSelect(runtime);
    expect(opened.foreign).toBe(false);
    expect(opened.transferred).toBe(true);
    expect(opened.draft.id).toBe(before.id);
    expect(opened.draft.scope).toBe(SCOPE_A);
    expect(opened.draft.createdAt).toBe(before.createdAt);
    expect(opened.draft.editor).toEqual(before.editor);
    expect(opened.draft.projectRoot).toBeNull();
    expect(opened.draft.baselineStateKey).toBeNull();
    expect(opened.store.get(before.id)).toEqual(opened.draft);
    expect(createProjectDrafts(runtime, SCOPE_A).get(before.id)).toEqual(opened.draft);
    expect(openAndSelect(runtime).transferred).toBe(false);
  });

  it('retains the visitor draft when connecting is cancelled', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    const before = saveVisibleRaw(runtime);
    runtime.session.setAccount(null);
    const opened = openAndSelect(runtime);
    expect(opened.draft).toEqual(before);
    expect(opened.foreign).toBe(false);
    expect(opened.transferred).toBe(false);
    expect(createProjectDrafts(runtime, SCOPE_A).list()).toEqual([]);
  });

  it('keeps wallet A work foreign to wallet B and rejects saving it under another account', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    connect(runtime);
    const before = saveVisibleRaw(runtime);

    connect(runtime, WALLET_B);
    const opened = openAndSelect(runtime);
    expect(opened.foreign).toBe(true);
    expect(opened.transferred).toBe(false);
    expect(opened.draft).toEqual(before);
    expect(opened.store).toBe(createProjectDrafts(runtime, SCOPE_A));
    expect(createProjectDrafts(runtime, SCOPE_B).list()).toEqual([]);

    const stillVisible = { ...opened.draft, editor: { ...opened.draft.editor, title: 'Raw visible work' } };
    expect(() => saveNewProjectDraft(runtime, stillVisible)).toThrow();
    expect(createProjectDrafts(runtime, SCOPE_A).get(before.id)).toEqual(before);
    expect(createProjectDrafts(runtime, SCOPE_B).list()).toEqual([]);
    expect(openAndSelect(runtime).draft).toEqual(before);
  });

  it('preserves the account origin through disconnect and Help remount, then reconnects exactly', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    connect(runtime);
    const before = saveVisibleRaw(runtime);

    runtime.session.setAccount(null);
    runtime.session.navigate({ name: 'help', topic: 'wallet', returnTo: '/projects/new' });
    runtime.session.navigate({ name: 'new-project' });
    const disconnected = openAndSelect(runtime);
    expect(disconnected.draft).toEqual(before);
    expect(disconnected.foreign).toBe(true);
    expect(disconnected.transferred).toBe(false);
    expect(createProjectDrafts(runtime, 'public:visitor').list()).toEqual([]);

    connect(runtime, WALLET_B);
    const differentAccount = openAndSelect(runtime);
    expect(differentAccount.draft).toEqual(before);
    expect(differentAccount.foreign).toBe(true);
    expect(differentAccount.transferred).toBe(false);
    expect(createProjectDrafts(runtime, SCOPE_B).list()).toEqual([]);

    connect(runtime);
    const reconnected = openAndSelect(runtime);
    expect(reconnected.draft).toEqual(before);
    expect(reconnected.foreign).toBe(false);
    expect(reconnected.transferred).toBe(false);
  });

  it('does not transfer local work when the mode changes to public', () => {
    const runtime = runtimeWith();
    runtime.session.setAccount({ kind: 'local', id: 'local-actor:coordinator' });
    const before = saveVisibleRaw(runtime);

    runtime.session.setMode('public');
    const visitor = openAndSelect(runtime);
    expect(visitor.draft).toEqual(before);
    expect(visitor.foreign).toBe(true);
    expect(visitor.transferred).toBe(false);
    connect(runtime);
    const connected = openAndSelect(runtime);
    expect(connected.draft).toEqual(before);
    expect(connected.foreign).toBe(true);
    expect(connected.transferred).toBe(false);
    expect(createProjectDrafts(runtime, SCOPE_A).list()).toEqual([]);
  });

  it('recovers the original wallet scope and exact raw values in a fresh runtime', () => {
    const storage = createMemoryStorage();
    const first = runtimeWith(storage);
    first.session.setMode('public');
    connect(first);
    const before = saveVisibleRaw(first);

    const reloaded = runtimeWith(storage);
    expect(reloaded.session.getSnapshot().actor).toBeNull();
    expect(reloaded.session.getSnapshot().activeDraftId).toBe(before.id);
    const disconnected = openAndSelect(reloaded);
    expect(disconnected.draft).toEqual(before);
    expect(disconnected.foreign).toBe(true);
    expect(disconnected.transferred).toBe(false);

    connect(reloaded);
    const reconnected = openAndSelect(reloaded);
    expect(reconnected.draft).toEqual(before);
    expect(reconnected.foreign).toBe(false);
    expect(reconnected.transferred).toBe(false);
  });

  it('retains the claimed wallet owner across reload when the visitor handoff cannot persist its destination', () => {
    const backing = createMemoryStorage();
    let failDestination = false;
    const storage: StoragePort = {
      getItem: key => backing.getItem(key),
      setItem: (key, value) => {
        const envelope = JSON.parse(value) as { kind: string; payload: { drafts?: SavedProjectDraft[] } };
        if (failDestination && envelope.kind === 'project-workspace' && envelope.payload.drafts?.some(draft => draft.scope === SCOPE_A)) {
          throw new Error('Account draft write failed');
        }
        backing.setItem(key, value);
      },
      removeItem: key => backing.removeItem(key),
    };
    const first = runtimeWith(storage);
    first.session.setMode('public');
    const before = saveVisibleRaw(first);
    failDestination = true;
    connect(first);
    const attempted = openAndSelect(first);
    expect(attempted.transferred).toBe(true);
    expect(attempted.status.persisted).toBe(false);
    expect(createProjectDrafts(first, 'public:visitor').get(before.id)).toEqual(before);

    failDestination = false;
    const reloaded = runtimeWith(storage);
    connect(reloaded, WALLET_B);
    const opened = openAndSelect(reloaded);
    expect(opened.draft.id).toBe(before.id);
    expect(opened.draft.scope).toBe(SCOPE_A);
    expect(opened.draft.editor).toEqual(before.editor);
    expect(opened.foreign).toBe(true);
    expect(opened.transferred).toBe(false);
    expect(createProjectDrafts(reloaded, SCOPE_B).list()).toEqual([]);
    connect(reloaded);
    expect(openAndSelect(reloaded).draft).toEqual(opened.draft);
    expect(openAndSelect(reloaded).foreign).toBe(false);
  });

  it('does not persist wallet edits beside an unclaimed visitor backup when the location write fails', () => {
    const backing = createMemoryStorage();
    let rejectClaim = false;
    const storage: StoragePort = {
      getItem: key => backing.getItem(key),
      setItem: (key, value) => {
        const envelope = JSON.parse(value) as { kind: string };
        if (rejectClaim && envelope.kind === 'project-new-draft-origin') throw new Error('Location write blocked');
        backing.setItem(key, value);
      },
      removeItem: key => backing.removeItem(key),
    };
    const first = runtimeWith(storage);
    first.session.setMode('public');
    const visitor = saveVisibleRaw(first);
    rejectClaim = true;
    connect(first);
    const connected = openAndSelect(first);
    const walletEdit = { ...connected.draft, editor: { ...connected.draft.editor, title: 'Wallet A private draft edit' } };
    expect(saveNewProjectDraft(first, walletEdit).persisted).toBe(false);
    expect(openAndSelect(first).draft.editor.title).toBe(walletEdit.editor.title);
    // Saving another draft in the same scope must not flush the withheld copy.
    createProjectDrafts(first, SCOPE_A).upsert(rawDraft(SCOPE_A, 'another-wallet-draft'));
    const reloaded = runtimeWith(storage);
    expect(createProjectDrafts(reloaded, SCOPE_A).get(visitor.id)).toBeUndefined();
    expect(createProjectDrafts(reloaded, 'public:visitor').get(visitor.id)?.editor).toEqual(visitor.editor);
    connect(reloaded, WALLET_B);
    const reopened = openAndSelect(reloaded);
    expect(reopened.draft.editor).toEqual(visitor.editor);
    expect(reopened.draft.editor.title).not.toBe(walletEdit.editor.title);
  });

  it.each(['null', 'blocked', 'write-failed'] as const)('keeps raw work across same-runtime remounts with %s storage', kind => {
    const backing = createMemoryStorage();
    const blocked: StoragePort = {
      getItem: () => { throw new Error('Storage blocked'); },
      setItem: () => { throw new Error('Storage blocked'); },
      removeItem: () => { throw new Error('Storage blocked'); },
    };
    const writeFailed: StoragePort = {
      getItem: key => backing.getItem(key),
      setItem: () => { throw new Error('Storage full'); },
      removeItem: key => backing.removeItem(key),
    };
    const runtime = runtimeWith(kind === 'null' ? null : kind === 'blocked' ? blocked : writeFailed);
    runtime.session.setMode('public');
    const before = saveVisibleRaw(runtime);
    expect(saveNewProjectDraft(runtime, before).persisted).toBe(false);
    runtime.session.navigate({ name: 'help', returnTo: '/projects/new' });
    runtime.session.navigate({ name: 'new-project' });
    expect(openAndSelect(runtime).draft).toEqual(before);

    connect(runtime);
    const transferred = openAndSelect(runtime);
    expect(transferred.draft.id).toBe(before.id);
    expect(transferred.draft.editor).toEqual(before.editor);
    expect(transferred.draft.scope).toBe(SCOPE_A);
    expect(transferred.foreign).toBe(false);
    expect(transferred.transferred).toBe(true);
    expect(transferred.store.status().persisted).toBe(false);
    runtime.session.setAccount(null);
    expect(openAndSelect(runtime).draft).toEqual(transferred.draft);
    connect(runtime);
    expect(openAndSelect(runtime).draft).toEqual(transferred.draft);
  });

  it('opens an explicitly selected current-account draft instead of the retained foreign origin', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    connect(runtime);
    const original = saveVisibleRaw(runtime);
    connect(runtime, WALLET_B);
    const selected = rawDraft(SCOPE_B, 'wallet-b-selected');
    selected.editor.title = 'The explicitly selected recipe';
    createProjectDrafts(runtime, SCOPE_B).upsert(selected);
    runtime.session.selectDraft(selected.id);

    const opened = openAndSelect(runtime);
    expect(opened.draft).toEqual(selected);
    expect(opened.foreign).toBe(false);
    expect(opened.transferred).toBe(false);
    expect(createProjectDrafts(runtime, SCOPE_A).get(original.id)).toEqual(original);
    runtime.session.setAccount(null);
    const remounted = openAndSelect(runtime);
    expect(remounted.draft).toEqual(selected);
    expect(remounted.foreign).toBe(true);
  });

  it('starts a new draft explicitly in wallet B without replacing wallet A work', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    connect(runtime);
    const original = saveVisibleRaw(runtime);
    connect(runtime, WALLET_B);
    expect(openAndSelect(runtime).foreign).toBe(true);

    const started = startNewProjectDraft(runtime);
    expect(started.draft.id).not.toBe(original.id);
    expect(started.draft.scope).toBe(SCOPE_B);
    expect(started.draft.editor.title).toBe('');
    expect(started.draft.projectRoot).toBeNull();
    expect(started.foreign).toBe(false);
    expect(started.transferred).toBe(false);
    expect(runtime.session.getSnapshot().activeDraftId).toBe(original.id);
    expect(createProjectDrafts(runtime, SCOPE_A).get(original.id)).toEqual(original);
    runtime.session.selectDraft(started.draft.id);
    expect(openAndSelect(runtime).draft).toEqual(started.draft);
  });

  it('starts fresh when the selected draft is already bound to a published project', () => {
    const runtime = runtimeWith();
    runtime.session.setMode('public');
    connect(runtime);
    const before = saveVisibleRaw(runtime);
    const published: SavedProjectDraft = {
      ...before, projectRoot: 'local:published-project', baselineStateKey: 'local:published-state',
    };
    createProjectDrafts(runtime, SCOPE_A).upsert(published);
    runtime.session.selectDraft(published.id);

    const opened = openNewProjectDraft(runtime);
    expect(opened.draft.id).not.toBe(published.id);
    expect(opened.draft.scope).toBe(SCOPE_A);
    expect(opened.draft.projectRoot).toBeNull();
    expect(opened.draft.baselineStateKey).toBeNull();
    expect(opened.draft.editor.title).toBe('');
    expect(opened.foreign).toBe(false);
    expect(opened.transferred).toBe(false);
    expect(runtime.session.getSnapshot().activeDraftId).toBe(published.id);
    expect(createProjectDrafts(runtime, SCOPE_A).get(published.id)).toEqual(published);
  });
});

describe('local draft sharing boundary', () => {
  it('copies valid raw local recipe input without normalizing it or carrying an authority', () => {
    const runtime = runtimeWith();
    runtime.session.setAccount({ kind: 'local', id: 'local-actor:coordinator' });
    const draft = makeDraft(draftScope('local', runtime.session.getSnapshot().actor), RECIPE, NOW, 'share-this');
    const shared = newProjectDraftForSharing(runtime, draft);
    expect(shared).toEqual(draft);
    expect(shared).not.toBe(draft);
    expect(shared!.editor.title).toBe('  Unfinished exhibition  ');
    expect(shared).not.toHaveProperty('authority');
    shared!.editor.instructions = 'Changed by the destination';
    expect(draft.editor.instructions).toBe(RECIPE.instructions);
  });

  it('rejects invalid, foreign and already-public draft handoffs', () => {
    const runtime = runtimeWith();
    runtime.session.setAccount({ kind: 'local', id: 'local-actor:coordinator' });
    const scope = draftScope('local', runtime.session.getSnapshot().actor);
    expect(newProjectDraftForSharing(runtime, rawDraft(scope, 'invalid'))).toBeNull();
    expect(newProjectDraftForSharing(runtime, makeDraft('local:local-actor:other', RECIPE, NOW, 'foreign'))).toBeNull();
    runtime.session.setMode('public');
    connect(runtime);
    expect(newProjectDraftForSharing(runtime, makeDraft(SCOPE_A, RECIPE, NOW, 'public'))).toBeNull();
  });
});
