import { describe, expect, it, vi } from 'vitest';
import type { AppRuntime } from '../../app/context';
import type { Repository, Result } from '../../data/types';
import type { EntityKey, JsonValue } from '../../domain/types';
import type { createRepositoryActionController } from '../../app/actions';
import type { ProgressInput } from './model';

type Controller = ReturnType<typeof createRepositoryActionController<Repository>>;
const env = vi.hoisted(() => ({ runtime: null as AppRuntime | null, controllers: new Map<string, Controller>(), slots: [] as unknown[], cursor: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useId: () => 'execution-review-test',
  useState<T>(initial: T | (() => T)) { const id = env.cursor++; if (!(id in env.slots)) env.slots[id] = typeof initial === 'function' ? (initial as () => T)() : initial; return [env.slots[id], (next: T | ((value: T) => T)) => { env.slots[id] = typeof next === 'function' ? (next as (value: T) => T)(env.slots[id] as T) : next; }]; },
  useRef<T>(initial: T) { const id = env.cursor++; if (!(id in env.slots)) env.slots[id] = { current: initial }; return env.slots[id]; },
  useMemo(create: () => unknown) { env.cursor++; return create(); },
  useEffect() {},
}));
vi.mock('../../app/context', async original => ({ ...await original<typeof import('../../app/context')>(), useApp: () => env.runtime, useAppSession: () => env.runtime!.session.getSnapshot() }));
vi.mock('../../app/actions', async original => ({ ...await original<typeof import('../../app/actions')>(), useRepositoryAction: (channel: string) => {
  const controller = env.controllers.get(channel)!;
  return { state: controller.getSnapshot(), run: controller.run, reconcile: controller.reconcile, resume: controller.resume,
    clear: controller.clear, recoverableCommand: controller.recoverableCommand, recoveryText: controller.recoveryText, restoreRecovery: controller.restoreRecovery };
} }));

import { createAppRuntime } from '../../app/context';
import { createRepositoryActionController as createController, validRepositoryActionRecord } from '../../app/actions';
import { createMemoryStorage, LocalRepository } from '../../data/local';
import { SMALL_WORKS_NOW, smallWorksRecords } from '../../domain/fixtures';
import { activeSource } from '../../domain/readiness';
import { runGuidedPracticeAction } from '../practice/guided';
import { ActionFeedback } from '../projects/ActionFeedback';
import { Button, Dialog, Field } from '../../ui';
import { prepareProgressCommand } from './model';
import { ExecutionWorkspace } from './ExecutionWorkspace';

type Element = { type: unknown; props: Record<string, unknown> };
function nodes(element: unknown, match: (item: Element) => boolean): Element[] {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(item => nodes(item, match));
  const item = element as Element;
  return [...(item.props && match(item) ? [item] : []), ...nodes(item.props?.children, match)];
}
const matching = (tree: unknown, type: unknown) => nodes(tree, item => item.type === type);
const click = (tree: unknown, label: string) => {
  const button = matching(tree, Button).find(item => item.props.children === label);
  expect(button, label).toBeDefined(); (button!.props.onClick as () => void)();
};
const dialog = (tree: unknown, title: string) => matching(tree, Dialog).find(item => item.props.title === title)!;
const record = (tree: unknown, dutyId: string, input: ProgressInput) => {
  const duty = nodes(tree, item => (item.props.row as { obligation?: { id?: string } } | undefined)?.obligation?.id === dutyId)[0];
  expect(duty).toBeDefined(); (duty!.props.onRecord as (id: string, input: ProgressInput) => void)(dutyId, input);
};
const cancelled: Result<never> = { ok: false, error: { code: 'rejected', reasons: [], retryable: false } };

async function setup(actorName: 'library' | 'makerspace', terminal?: 'confirmed' | 'rejected' | 'reverted') {
  env.slots.length = 0; env.cursor = 0; env.controllers.clear();
  const storage = createMemoryStorage();
  const repository = new LocalRepository({ storage, namespace: 'practice', now: () => SMALL_WORKS_NOW, logicalClock: true });
  expect(repository.seed(smallWorksRecords()).ok).toBe(true);
  const now = () => repository.currentTime();
  await runGuidedPracticeAction(repository, 'add_oak', now);
  let project = (await runGuidedPracticeAction(repository, 'approve', now)).project;
  const root = (name: string) => project.publishers.find(p => p.root.payload.publisher.kind === 'local' && p.root.payload.publisher.id === `local-actor:${name}`)!.root.key;
  const authority = (key: EntityKey) => {
    const actor = project.publishers.find(p => p.root.key === key)!.root.payload.publisher;
    if (actor.kind !== 'local') throw new Error('Expected local actor');
    return { mode: 'local' as const, actor, chainId: null };
  };
  const command = prepareProgressCommand(project, project.proposal!, activeSource(project)!, 'guided-handover-boards', authority(root('makerspace')),
    { kind: 'transfer_report', quantity: 6 }, now(), 'seed-delivery');
  const sent = await repository.replaceBook(command);
  if (!sent.ok) throw new Error('Expected initial delivery');
  const refresh = async () => { const read = await repository.loadProject(project.root.key); if (!read.ok) throw new Error('Expected project'); project = read.value; };
  await refresh();
  const runtime = createAppRuntime({ repository, storage, now });
  runtime.session.setMode('local'); runtime.session.setAccount(authority(root(actorName)).actor);
  env.runtime = runtime;
  const actionStore = runtime.drafts('execution-review-test', 'repository-action', validRepositoryActionRecord);
  if (terminal) {
    const operation = terminal === 'confirmed' ? sent.value.operation : command.operation;
    actionStore.save({ status: terminal, operation, command: { ...command, operation } as unknown as JsonValue });
  }
  const controller = createController({ repository, store: actionStore, getActor: () => runtime.session.getSnapshot().actor });
  const closeController = createController({ repository, store: runtime.drafts('execution-close-review-test', 'repository-action', validRepositoryActionRecord), getActor: () => runtime.session.getSnapshot().actor });
  env.controllers.set(`execution:${project.root.key}`, controller); env.controllers.set(`execution-close:${project.root.key}`, closeController);
  const render = () => { env.cursor = 0; return ExecutionWorkspace({ project, onRefresh: refresh }); };
  const openRelease = () => {
    const field = matching(render(), Field).find(item => item.props.label === 'My reason for releasing this equipment hold')!;
    (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'Owner chooses to release this hold.' } });
    click(render(), 'Review my owner release');
    return dialog(render(), 'Review my equipment release');
  };
  return { repository, controller, render, openRelease, getProject: () => project, authority, root, now };
}

describe('execution review feedback belongs to its own operation', () => {
  it('does not show an earlier saved receipt inside a different unsubmitted return review', async () => {
    const { controller, render } = await setup('library');
    record(render(), 'guided-handover-boards', { kind: 'transfer_acknowledgement', reportId: 'report:seed-delivery', quantity: 6 });
    click(dialog(render(), 'Review my receipt').props.footer, 'Publish my acknowledgement');
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('confirmed'));
    await vi.waitFor(() => expect(dialog(render(), 'Review my report').props.open).toBe(false));
    const previous = controller.recoverableCommand;
    record(render(), 'guided-return-boards', { kind: 'transfer_report', quantity: 6 });
    const next = dialog(render(), 'Review my report');
    expect(next.props.open).toBe(true);
    expect(matching(next.props.children, ActionFeedback).length).toBe(0);
    expect(controller.recoverableCommand).toEqual(previous);
    expect(controller.getSnapshot().status).toBe('confirmed');
  });

  it.each(['confirmed', 'rejected', 'reverted'] as const)('does not attach an earlier %s outcome to a new owner release', async terminal => {
    const { controller, openRelease } = await setup('makerspace', terminal);
    const previous = controller.recoverableCommand;
    const review = openRelease();
    expect(review.props.open).toBe(true);
    expect(matching(review.props.children, ActionFeedback).length).toBe(0);
    expect(controller.recoverableCommand).toEqual(previous);
    expect(controller.getSnapshot().status).toBe(terminal);
  });

  it('shows recovery for the submitted owner release without erasing its original command', async () => {
    const { repository, controller, openRelease, render } = await setup('makerspace', 'confirmed');
    const previousId = controller.getSnapshot().operation!.id;
    const review = openRelease();
    vi.spyOn(repository, 'replaceBook').mockResolvedValueOnce(cancelled);
    click(review.props.footer, 'Publish my owner release');
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('needs-verification'));
    const next = dialog(render(), 'Review my equipment release');
    const feedback = matching(next.props.children, ActionFeedback);
    expect(next.props.open).toBe(true); expect(feedback).toHaveLength(1);
    expect(controller.getSnapshot().operation!.id).not.toBe(previousId);
    expect((feedback[0]!.props.state as { operation: { id: string } }).operation.id).toBe(controller.recoverableCommand!.operation.id);
  });

  it('keeps an in-flight or uncertain original operation and blocks new progress and release reviews', async () => {
    const { controller, render, openRelease, getProject, authority, root, now } = await setup('makerspace');
    const project = getProject(), duty = project.proposal!.payload.plan.runbook.find(item => item.kind === 'task' && item.publisherRoot === root('makerspace'))!;
    const command = prepareProgressCommand(project, project.proposal!, activeSource(project)!, duty.id, authority(root('makerspace')), { kind: 'task_report', status: 'done', note: '' }, now(), 'pending-task');
    let finish!: (result: Result<never>) => void;
    const pending = controller.run(command, () => new Promise<Result<never>>(resolve => { finish = resolve; }));
    expect(controller.getSnapshot().status).toBe('submitting');
    record(render(), duty.id, { kind: 'task_report', status: 'done', note: 'Another intent' });
    expect(dialog(render(), 'Review my report').props.open).toBe(false);
    expect(openRelease().props.open).toBe(false);
    expect(controller.recoverableCommand?.operation.id).toBe('pending-task');
    finish(cancelled); await pending;
    expect(controller.getSnapshot().status).toBe('needs-verification');
    expect(openRelease().props.open).toBe(false);
    expect(controller.recoverableCommand?.operation.id).toBe('pending-task');
  });
});
