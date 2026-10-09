import { describe, expect, it } from 'vitest';
import { copyRecipeToPublicDraft } from '../projectSharing';
import { createAppRuntime } from '../context';
import { createProjectDrafts, draftScope, makeDraft } from '../../features/projects/drafts';
import { makeSmallWorksFixture } from '../../domain/fixtures';

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
});
