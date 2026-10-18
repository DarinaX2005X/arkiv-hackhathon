import { describe, expect, it, vi } from 'vitest';
import type { AppRuntime } from '../../app/context';

const env = vi.hoisted(() => ({ runtime: null as AppRuntime | null, run: vi.fn(), slots: [] as unknown[], cursor: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState<T>(initial: T | (() => T)) { const id = env.cursor++; if (!(id in env.slots)) env.slots[id] = typeof initial === 'function' ? (initial as () => T)() : initial; return [env.slots[id], (next: T | ((previous: T) => T)) => { env.slots[id] = typeof next === 'function' ? (next as (previous: T) => T)(env.slots[id] as T) : next; }]; },
  useRef<T>(initial: T) { const id = env.cursor++; if (!(id in env.slots)) env.slots[id] = { current: initial }; return env.slots[id]; },
  useMemo(create: () => unknown) { const id = env.cursor++; if (!(id in env.slots)) env.slots[id] = create(); return env.slots[id]; },
  useEffect() {},
}));
vi.mock('../../app/context', async original => ({ ...await original<typeof import('../../app/context')>(), useApp: () => env.runtime, useAppSession: () => env.runtime!.session.getSnapshot() }));
vi.mock('../../app/actions', async original => ({ ...await original<typeof import('../../app/actions')>(), useRepositoryAction: () => ({ state: { status: 'idle' }, run: env.run }) }));
import { createAppRuntime } from '../../app/context';
import { createMemoryStorage } from '../../data/local';
import { makeSmallWorksProject, SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW } from '../../domain/fixtures';
import { createProjectDrafts, draftScope, makeDraft } from './drafts';
import { NeedsPanel } from './NeedsPanel';
import { Button } from '../../ui';

type Element = { type: unknown; props: { children?: unknown; onClick?: () => void } };
function find(element: unknown, type: unknown, text: string): Element | undefined {
  if (!element || typeof element !== 'object') return undefined;
  if (Array.isArray(element)) return element.map(item => find(item, type, text)).find(Boolean);
  const item = element as Element;
  if (item.type === type && item.props.children === text) return item;
  return find(item.props?.children, type, text);
}

function setup() {
  env.slots.length = 0; env.cursor = 0; env.run.mockReset();
  const project = makeSmallWorksProject();
  if (project.state.status !== 'unique') throw new Error('Expected one fixture state');
  const runtime = createAppRuntime({ storage: createMemoryStorage(), now: () => SMALL_WORKS_NOW });
  runtime.session.setMode('local'); runtime.session.setAccount(SMALL_WORKS_COORDINATOR);
  runtime.session.navigate({ name: 'project', projectRoot: project.root.key, tab: 'needs' });
  const draft = { ...makeDraft(draftScope('local', SMALL_WORKS_COORDINATOR), project.state.entity.payload.recipe, SMALL_WORKS_NOW), projectRoot: project.root.key, baselineStateKey: project.state.entity.key };
  draft.editor.outcome += ' Updated';
  const store = createProjectDrafts(runtime, draft.scope); store.upsert(draft); runtime.session.selectDraft(draft.id);
  let finish!: (value: unknown) => void;
  env.runtime = runtime; env.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const refresh = vi.fn(async () => {});
  const tree = NeedsPanel({ project, onRefresh: refresh });
  find(tree, Button, 'Save project needs')!.props.onClick!();
  expect(env.run).toHaveBeenCalledOnce();
  const confirm = async () => {
    finish({ ok: true, value: { operation: { phase: 'complete' }, value: { key: 'local:confirmed-needs' } } });
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { runtime, draft, store, refresh, confirm };
}

describe('needs save continuation', () => {
  it('records the original confirmation without replacing another account’s active draft', async () => {
    const { runtime, draft, store, refresh, confirm } = setup();
    runtime.session.setAccount({ kind: 'local', id: 'local-actor:new-owner' });
    runtime.session.navigate({ name: 'new-project' }); runtime.session.selectDraft('new-owner-draft');
    await confirm();
    expect(runtime.session.getSnapshot().activeDraftId).toBe('new-owner-draft');
    expect(refresh).not.toHaveBeenCalled();
    expect(store.get(draft.id)?.baselineStateKey).toBe('local:confirmed-needs');
  });

  it('preserves newer input saved while the same account’s earlier command was pending', async () => {
    const { draft, store, confirm } = setup();
    const newer = { ...draft, editor: { ...draft.editor, outcome: 'Keep the newer description' }, updatedAt: draft.updatedAt + 1 };
    store.upsert(newer, draft); await confirm();
    expect(store.get(draft.id)).toEqual(newer);
  });

  it('does not resurrect a deleted draft when the original command confirms', async () => {
    const { draft, store, confirm } = setup();
    expect(store.deleteDraft(draft).deleted).toBe(true);
    await confirm();
    expect(store.get(draft.id)).toBeUndefined();
    expect(store.isDeleted(draft.id)).toBe(true);
  });
});
