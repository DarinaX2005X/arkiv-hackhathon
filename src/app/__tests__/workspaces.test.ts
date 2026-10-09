import { describe, expect, it } from 'vitest';
import { createStudioWorkspaces, LOCAL_COORDINATOR, workspaceForRoute } from '../workspaces';
import { createLocalOperationIntent } from '../../data/local';
import { SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW, SMALL_WORKS_PROJECT_ROOT } from '../../domain/fixtures';
import type { ProjectRecipe } from '../../domain/types';
import type { StoragePort } from '../storage';
import type { Route } from '../routes';

function storagePort() {
  const values = new Map<string, string>();
  const storage: StoragePort = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  return { values, storage };
}
const neverNetwork = async (): Promise<never> => { throw new Error('This local workspace test must never call RPC.'); };
const textDraft = (value: unknown): value is { text: string } => Boolean(value && typeof value === 'object' && 'text' in value && typeof value.text === 'string');
const customRecipe = (): ProjectRecipe => ({ title: 'My own project', outcome: 'Make a useful thing', timeZone: 'UTC', variants: [], instructions: '' });

describe('Studio workspace isolation without rendering', () => {
  it('resets only practice records and practice role, preserving custom work, drafts, public state and current route', async () => {
    const { storage, values } = storagePort();
    const workspaces = createStudioWorkspaces({ storage, request: neverNetwork, now: () => SMALL_WORKS_NOW });
    const customInput = { recipe: customRecipe(), lifetimeSeconds: 90 * 86400 };
    const created = await workspaces.localRepository.createProject({ ...customInput,
      operation: createLocalOperationIntent('create_project', LOCAL_COORDINATOR as { kind: 'local'; id: 'local-actor:me' }, customInput, { id: 'custom-project', now: SMALL_WORKS_NOW }) });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.code);
    const customRoot = created.value.value.root.key;
    const localDraft = workspaces.runtimes.local.drafts('same-id', 'text', textDraft);
    const publicDraft = workspaces.runtimes.public.drafts('same-id', 'text', textDraft);
    localDraft.save({ text: 'Keep my custom draft' });
    publicDraft.save({ text: 'Keep my public draft' });
    workspaces.runtimes.public.session.selectDraft('public-selected');
    workspaces.runtimes.public.session.navigate({ name: 'requests' });
    workspaces.runtimes.local.session.selectDraft('custom-selected');
    workspaces.runtimes.local.session.navigate({ name: 'project', projectRoot: customRoot, tab: 'needs' });

    await workspaces.select('practice', { name: 'demo' });
    const practice = await workspaces.practiceRepository.loadProject(SMALL_WORKS_PROJECT_ROOT);
    expect(practice.ok).toBe(true);
    if (!practice.ok || practice.value.state.status !== 'unique') throw new Error('Missing seeded practice');
    const head = practice.value.state.entity;
    const state = { ...head.payload, predecessorKeys: [head.key], operationId: 'edit-practice', createdAt: SMALL_WORKS_NOW,
      recipe: { ...head.payload.recipe, title: 'Edited practice' } };
    const editInput = { projectRoot: SMALL_WORKS_PROJECT_ROOT, expectedHeads: [head.key], state, lifetimeSeconds: 90 * 86400 };
    const edited = await workspaces.practiceRepository.replaceProject({ ...editInput,
      operation: createLocalOperationIntent('replace_project', SMALL_WORKS_COORDINATOR as { kind: 'local'; id: 'local-actor:coordinator' }, editInput, { id: 'edit-practice', now: SMALL_WORKS_NOW }) });
    expect(edited.ok).toBe(true);
    workspaces.setLocalActor({ kind: 'local', id: 'local-actor:cedar' });
    await workspaces.followRoute({ name: 'project', projectRoot: customRoot, tab: 'history' });
    const prior = new Map([...values].filter(([key]) => !key.includes('practice')));
    const destination = workspaces.getSnapshot().runtime.session.getSnapshot().destination;

    await workspaces.resetPractice();

    expect(workspaces.getSnapshot().kind).toBe('local');
    expect(workspaces.getSnapshot().runtime.session.getSnapshot().destination).toBe(destination);
    for (const [key, value] of prior) expect(values.get(key), key).toBe(value);
    expect((await workspaces.localRepository.loadProject(customRoot)).ok).toBe(true);
    expect(localDraft.load()).toMatchObject({ status: 'ready', value: { text: 'Keep my custom draft' } });
    expect(publicDraft.load()).toMatchObject({ status: 'ready', value: { text: 'Keep my public draft' } });
    expect(workspaces.runtimes.public.session.getSnapshot()).toMatchObject({ destination: '/requests', activeDraftId: 'public-selected', actor: null });
    const reset = await workspaces.practiceRepository.loadProject(SMALL_WORKS_PROJECT_ROOT);
    expect(reset.ok && reset.value.state.status === 'unique' && reset.value.state.entity.payload.recipe.title).toBe('Small Works');
    expect(workspaces.runtimes.practice.session.getSnapshot().actor).toEqual(SMALL_WORKS_COORDINATOR);
    workspaces.dispose();
  });

  it.each([
    [{ name: 'demo' }, 'public', 'practice'],
    [{ name: 'project', projectRoot: SMALL_WORKS_PROJECT_ROOT, tab: 'plans' }, 'local', 'practice'],
    [{ name: 'project', projectRoot: 'local:custom-project', tab: 'needs' }, 'practice', 'local'],
    [{ name: 'project', projectRoot: `0x${'1'.repeat(64)}`, tab: 'agreement' }, 'practice', 'public'],
    [{ name: 'new-project' }, 'practice', 'local'],
    [{ name: 'new-project' }, 'public', 'public'],
    [{ name: 'contributions' }, 'practice', 'practice'],
  ] as const)('selects route workspace %#', (route, current, expected) => {
    expect(workspaceForRoute(route as Route, current)).toBe(expected);
  });

  it('follows a restored practice route by seeding once, then new-project leaves the practice namespace', async () => {
    const { storage } = storagePort();
    storage.setItem('partfolk:studio:workspace', 'practice');
    const first = createStudioWorkspaces({ storage, request: neverNetwork, now: () => SMALL_WORKS_NOW });
    await first.followRoute({ name: 'demo' });
    expect(first.getSnapshot()).toMatchObject({ kind: 'practice', loading: false, issue: null });
    expect((await first.practiceRepository.loadProject(SMALL_WORKS_PROJECT_ROOT)).ok).toBe(true);
    first.dispose();
    const restored = createStudioWorkspaces({ storage, request: neverNetwork, now: () => SMALL_WORKS_NOW });
    expect(restored.initialRoute()).toEqual({ name: 'demo' });
    await restored.followRoute(restored.initialRoute());
    expect(restored.getSnapshot().issue).toBeNull();
    await restored.followRoute({ name: 'new-project' });
    expect(restored.getSnapshot().kind).toBe('local');
    expect(restored.getSnapshot().runtime.session.currentRoute()).toEqual({ name: 'new-project' });
    const customProjects = await restored.localRepository.listProjects(LOCAL_COORDINATOR);
    expect(customProjects.ok && customProjects.value.items).toEqual([]);
    restored.dispose();
  });

  it.each(['{not JSON', JSON.stringify({ format: 'partfolk-local', version: 9, records: {}, operations: {}, drafts: {} })])(
    'preserves unreadable practice bytes and reports recovery instead of reseeding', async broken => {
      const { storage, values } = storagePort();
      storage.setItem('partfolk:local:practice', broken);
      const workspaces = createStudioWorkspaces({ storage, request: neverNetwork, now: () => SMALL_WORKS_NOW });
      await workspaces.select('practice', { name: 'demo' });
      expect(workspaces.getSnapshot().issue).toMatch(/could not be read|recovery/i);
      expect(values.get('partfolk:local:practice')).toBe(broken);
      expect(workspaces.practiceRepository.exportRecovery()).toBe(broken);
      expect((await workspaces.practiceRepository.loadProject(SMALL_WORKS_PROJECT_ROOT)).ok).toBe(false);
      workspaces.dispose();
    },
  );

  it('reports failed practice persistence and retains recoverable input without claiming saved records', async () => {
    const { storage, values } = storagePort();
    const failing: StoragePort = { ...storage, setItem: (key, value) => {
      if (key === 'partfolk:local:practice') throw new Error('Quota exceeded');
      storage.setItem(key, value);
    } };
    const workspaces = createStudioWorkspaces({ storage: failing, request: neverNetwork, now: () => SMALL_WORKS_NOW });
    await workspaces.select('practice');
    expect(workspaces.getSnapshot().issue).toMatch(/could not be saved/i);
    expect(values.has('partfolk:local:practice')).toBe(false);
    expect(workspaces.practiceRepository.exportRecovery()).toContain(SMALL_WORKS_PROJECT_ROOT);
    workspaces.dispose();
  });

  it('keeps missing-storage work explicitly unsaved and does not allow local roles in public mode', async () => {
    const workspaces = createStudioWorkspaces({ storage: null, request: neverNetwork, now: () => SMALL_WORKS_NOW });
    expect(workspaces.runtimes.local.session.getSnapshot().storageIssue?.code).toBe('unavailable');
    const draft = workspaces.runtimes.local.drafts('unsaved', 'text', textDraft);
    expect(draft.save({ text: 'Retain in memory' })).toMatchObject({ persisted: false, issue: { code: 'unavailable' } });
    expect(draft.peek()).toEqual({ text: 'Retain in memory' });
    await workspaces.select('public');
    expect(() => workspaces.setLocalActor({ kind: 'local', id: 'local-actor:cedar' })).toThrow();
    expect(workspaces.runtimes.public.session.getSnapshot().actor).toBeNull();
    workspaces.dispose();
  });

  it('a later route choice wins over an earlier asynchronous practice selection', async () => {
    const { storage } = storagePort();
    const workspaces = createStudioWorkspaces({ storage, request: neverNetwork, now: () => SMALL_WORKS_NOW });
    const practiceSelection = workspaces.select('practice', { name: 'demo' });
    await workspaces.select('local', { name: 'workspace' });
    await practiceSelection;
    expect(workspaces.getSnapshot()).toMatchObject({ kind: 'local', loading: false });
    expect(workspaces.getSnapshot().runtime.session.currentRoute()).toEqual({ name: 'workspace' });
    workspaces.dispose();
  });
});
