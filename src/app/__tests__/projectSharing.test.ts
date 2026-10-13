import { describe, expect, it } from 'vitest';
import { copyRecipeToPublicDraft, copyTemplateToStudioDraft } from '../projectSharing';
import { createAppRuntime } from '../context';
import { createProjectDrafts, draftScope, makeDraft } from '../../features/projects/drafts';
import { makeSmallWorksFixture } from '../../domain/fixtures';
import { createMemoryStorage } from '../../data/local';
import type { RecipeTemplate } from '../../domain/types';

const template = (): RecipeTemplate => {
  const recipe = makeSmallWorksFixture().recipe;
  return { ...recipe, sourceProjectRoot: `0x${'ab'.repeat(32)}`, variants: recipe.variants.map(variant => ({ ...variant,
    requirements: variant.requirements.map(({ interval: _interval, ...requirement }) => requirement) })) };
};

describe('local recipe to shared draft boundary', () => {
  it('retains editable input and dates but removes local identity and baseline', () => {
    const runtime = createAppRuntime({ storage: null, namespace: 'shared-test', now: () => 10 });
    runtime.session.setMode('public');
    const local = makeDraft('local:local-actor:me', makeSmallWorksFixture().recipe, 1, 'source');
    local.projectRoot = 'local:source'; local.baselineStateKey = 'local:head';
    local.editor.sourceProjectRoot = 'local:source'; local.editor.title = 'My unfinished project';
    const original = structuredClone(local);
    const { draft } = copyRecipeToPublicDraft(runtime, local);
    expect(draft.id).not.toBe(local.id);
    expect(draft.scope).toBe('public:visitor');
    expect(draft.projectRoot).toBeNull(); expect(draft.baselineStateKey).toBeNull();
    expect(draft.editor).not.toHaveProperty('sourceProjectRoot');
    expect(draft.editor.variants).toEqual(local.editor.variants);
    expect(draft.editor.title).toBe('My unfinished project');
    expect(local).toEqual(original);
    expect(createProjectDrafts(runtime, draftScope('public', null)).get(draft.id)).toEqual(draft);
    expect(runtime.session.getSnapshot().activeDraftId).toBe(draft.id);
  });
  it('uses the current wallet scope without importing participants or decisions', () => {
    const runtime = createAppRuntime({ storage: null, namespace: 'shared-test', now: () => 10 });
    runtime.session.setMode('public');
    runtime.session.setAccount({ kind: 'wallet', address: `0x${'A'.repeat(40)}` }, 60138453025);
    const { draft } = copyRecipeToPublicDraft(runtime, makeSmallWorksFixture().recipe);
    expect(draft.scope).toBe(`public:0x${'a'.repeat(40)}`);
    expect(Object.keys(draft.editor).sort()).toEqual(['instructions', 'outcome', 'timeZone', 'title', 'variants']);
    expect(draft).not.toHaveProperty('publishers'); expect(draft).not.toHaveProperty('decisions');
  });
  it('hands a Desk recipe to the ordinary Studio public draft scope without copying authority or old dates', () => {
    const storage = createMemoryStorage();
    const source = createAppRuntime({ storage, namespace: 'partfolk:partner-desk', now: () => 50 });
    source.session.setMode('public');
    source.session.setAccount({ kind: 'wallet', address: `0x${'a'.repeat(40)}` }, 7738577);
    source.session.selectDraft('keep-desk-draft');
    const before = source.session.getSnapshot(); const original = template(); const copy = structuredClone(original);
    const { draft, saved } = copyTemplateToStudioDraft(source, original);
    expect(saved.persisted).toBe(true);
    const studio = createAppRuntime({ storage, namespace: 'partfolk:studio:public' });
    expect(studio.session.getSnapshot()).toMatchObject({ mode: 'public', actor: null, chainId: null, activeDraftId: draft.id });
    expect(createProjectDrafts(studio, draft.scope).get(draft.id)).toEqual(draft);
    expect(draft.scope).toBe(`public:0x${'a'.repeat(40)}`);
    expect(draft.editor.variants.flatMap(variant => variant.requirements).every(requirement => requirement.startLocal === '' && requirement.endLocal === '')).toBe(true);
    expect(draft.projectRoot).toBeNull(); expect(draft.baselineStateKey).toBeNull();
    expect(draft).not.toHaveProperty('decisions'); expect(draft).not.toHaveProperty('allocations');
    expect(source.session.getSnapshot()).toEqual(before); expect(original).toEqual(copy);
  });
  it('keeps the previous Studio selection and the returned recipe recoverable when a cross-space save fails', () => {
    const storage = createMemoryStorage();
    const previous = createAppRuntime({ storage, namespace: 'partfolk:studio:public' });
    previous.session.setMode('public'); previous.session.selectDraft('previous-draft');
    const broken = { ...storage, setItem: () => { throw new Error('Storage full'); } };
    const source = createAppRuntime({ storage: broken, namespace: 'partfolk:partner-desk' });
    source.session.setMode('public');
    const { draft, saved } = copyTemplateToStudioDraft(source, template());
    expect(saved.persisted).toBe(false);
    expect(draft.editor.title).toBe(template().title);
    expect(createAppRuntime({ storage, namespace: 'partfolk:studio:public' }).session.getSnapshot().activeDraftId).toBe('previous-draft');
  });
});
