import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createRepositoryActionController } from '../../app/actions';
import type { EventRepositoryContract, ReplaceAttendanceCommand } from '../../data/events/types';
import type { AttendanceState, EventRecord } from '../../domain/events';

type Controller = ReturnType<typeof createRepositoryActionController<EventRepositoryContract>>;
const env = vi.hoisted(() => ({ controller: null as Controller | null }));
// Invoke component callbacks with persistent hook state; no DOM or browser renderer is used.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; current?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const slots: Slot[] = [], pending: (() => void)[] = [];
  let cursor = 0;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a?.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  return {
    reset() { slots.length = 0; cursor = 0; pending.length = 0; },
    render<T>(read: () => T) { cursor = 0; return read(); },
    effects() { for (const run of pending.splice(0)) run(); },
    useState<T>(initial: T | (() => T)) {
      const id = cursor++;
      slots[id] ??= { value: typeof initial === 'function' ? (initial as () => T)() : initial };
      return [slots[id]!.value as T, (next: T | ((previous: T) => T)) => { slots[id]!.value = typeof next === 'function' ? (next as (previous: T) => T)(slots[id]!.value as T) : next; }] as const;
    },
    useRef<T>(initial: T) { const id = cursor++; slots[id] ??= { current: initial }; return slots[id] as { current: T }; },
    useMemo<T>(create: () => T, deps: readonly unknown[]) { const id = cursor++; if (!slots[id] || !same(slots[id]!.deps, deps)) slots[id] = { value: create(), deps }; return slots[id]!.value as T; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const id = cursor++;
      if (!slots[id] || !same(slots[id]!.deps, deps)) {
        const previous = slots[id], slot: Slot = { deps }; slots[id] = slot;
        pending.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
      }
    },
  };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...hooks }));
vi.mock('../events/useEventAction', () => ({ browserEventStorage: () => null,
  useEventAction: () => ({ controller: env.controller!, state: env.controller!.getSnapshot() }) }));

import { createRepositoryActionController as createController, validRepositoryActionRecord } from '../../app/actions';
import type { AppSession } from '../../app/session';
import { createDraftStore } from '../../app/storage';
import { createArkivRepository } from '../../data/arkiv';
import { createMemoryStorage } from '../../data/local';
import { COORDINATOR, KEYS, NOW, STRANGER, entityKey, readyFixture } from '../../data/__tests__/arkiv-fixture';
import { audienceHash, EVENTS_PROTOCOL, type EventAggregate, type EventRelease } from '../../domain/events';
import type { EntityProvenance } from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { Button, Checkbox } from '../../ui';
import type { EventRead } from '../events/hooks';
import { joinTargetStore } from './intent';
import { RegistrationPanel, type RegistrationPanelProps } from './RegistrationPanel';

type Element = { type: unknown; props: Record<string, unknown> };
function nodes(element: unknown, match: (item: Element) => boolean): Element[] {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(item => nodes(item, match));
  const item = element as Element;
  return [...(item.props && match(item) ? [item] : []), ...nodes(item.props?.children, match)];
}
function button(tree: unknown, label: string) {
  const found = nodes(tree, item => item.type === Button && item.props.children === label)[0];
  expect(found, label).toBeDefined(); return found!;
}
function checkbox(tree: unknown, labelPrefix: string, checked: boolean) {
  const found = nodes(tree, item => item.type === Checkbox && String(item.props.label).startsWith(labelPrefix))[0];
  expect(found, labelPrefix).toBeDefined();
  (found!.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked } });
}
function click(item: Element) { (item.props.onClick as () => void)(); }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

const account = { kind: 'wallet' as const, address: STRANGER };
async function eventRead(): Promise<EventRead> {
  const { rpc, source } = readyFixture();
  const project = await createArkivRepository({ request: rpc.request, now: () => NOW }).loadProject(KEYS.project);
  if (!project.ok) throw new Error('Invalid core fixture');
  const provenance: EntityProvenance = { mode: 'public', creator: { kind: 'wallet', address: COORDINATOR }, owner: { kind: 'wallet', address: COORDINATOR }, readonly: true,
    contentType: 'application/json', permissionlessExtension: false, createdAtBlock: '95', expiresAtBlock: '10000', transactionHash: entityKey(100) };
  const base = { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, operationId: 'panel-fixture', createdAt: NOW - 1000 };
  const terms = { title: 'An open workshop', description: 'Make things together.', startsAt: NOW + 3_600_000, endsAt: NOW + 7_200_000,
    timeZone: 'UTC', venue: 'Library hall', instructions: 'Use the front entrance.', conditions: 'Free open event.' };
  const release: EventRecord<EventRelease> = { key: entityKey(101), provenance, payload: { ...base, entityType: 'event_release',
    projectRoot: KEYS.project, terms, audienceHash: audienceHash(terms), predecessorReleaseKey: null, source } };
  const event: EventAggregate = { projectRoot: KEYS.project, root: project.value.root, sourceProject: project.value, release, snapshot: project.value.snapshot, diagnostics: [],
    state: { status: 'unique', entity: { key: entityKey(102), provenance, payload: { ...base, entityType: 'event_state', projectRoot: KEYS.project,
      releaseKey: release.key, audienceHash: release.payload.audienceHash, source, status: 'open', predecessorKeys: [], startsAt: terms.startsAt, endsAt: terms.endsAt } } } };
  return { event, actor: account, myEvent: null, attendance: { status: 'missing', reason: 'not_initialized' } };
}
function attendance(read: EventRead, command: ReplaceAttendanceCommand): EventRecord<AttendanceState> {
  return { key: entityKey(103), provenance: { ...read.event.release!.provenance, creator: account, owner: account }, payload: {
    protocol: EVENTS_PROTOCOL, schemaVersion: 1, operationId: command.operation.id, createdAt: Date.now() - 1000, entityType: 'attendance_state',
    projectRoot: command.projectRoot, releaseKey: command.releaseKey, audienceHash: command.audienceHash, attendee: account.address,
    decision: command.decision, predecessorKeys: command.expectedHeads, ...(command.joinWaitlist ? { joinWaitlist: true } : {}),
  } };
}

async function setup() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const read = await eventRead(), original = structuredClone(read), storage = createMemoryStorage(), order: string[] = [];
  let lastCommand: ReplaceAttendanceCommand | null = null;
  const replaceAttendance = vi.fn<EventRepositoryContract['replaceAttendance']>(async command => {
    order.push('write'); lastCommand = command;
    const value = attendance(original, command);
    return { ok: true, value: { value, operation: { ...command.operation, phase: 'complete', confirmedKeys: [value.key] },
      receipt: { operationId: command.operation.id, transactionHash: null, entityKeys: [value.key], consumedKeys: command.expectedHeads, blockNumber: '100', confirmedAt: Date.now() } } };
  });
  const repository = { mode: 'public', replaceAttendance, reconcile: vi.fn() } as unknown as EventRepositoryContract;
  const freshRead = () => {
    const next = structuredClone(original);
    Object.assign(next.event.snapshot, { fetchedAt: Date.now(), blockTimestamp: Date.now() });
    Object.assign(next.event.sourceProject!.snapshot, next.event.snapshot);
    if (lastCommand) {
      next.attendance = { status: 'unique', entity: attendance(next, lastCommand) };
      next.myEvent = { projectRoot: KEYS.project, attendance: next.attendance, event: next.event, registeredRelease: next.event.release, diagnostics: [] };
    }
    return next;
  };
  const refresh = vi.fn(async () => { order.push('refresh'); return freshRead(); });
  const refreshWithdrawal = vi.fn(async () => freshRead());
  const session: AppSession = { mode: 'public', actor: account, chainId: TIRAMISU_CHAIN_ID, activeDraftId: null, destination: '/events', storageIssue: null };
  const props: RegistrationPanelProps = { repository, session, projectRoot: KEYS.project, read, now: NOW, refresh, refreshWithdrawal, storage };
  const controller = createController({ repository, getActor: () => props.session.actor,
    store: createDraftStore({ storage, key: 'panel-action', kind: 'repository-action', validate: validRepositoryActionRecord }) });
  env.controller = controller;
  const render = () => { hooks.render(() => RegistrationPanel(props)); hooks.effects(); return hooks.render(() => RegistrationPanel(props)); };
  const review = () => {
    click(button(render(), 'Join event'));
    checkbox(render(), 'I reviewed the event details', true);
    const confirm = button(render(), 'Confirm my registration'); expect(confirm.props.disabled).toBe(false);
    return confirm;
  };
  return { props, read, storage, order, controller, clock, render, review, replaceAttendance, refresh, refreshWithdrawal };
}

describe('registration reuses only the current verified event review', () => {
  beforeEach(() => hooks.reset());
  afterEach(() => vi.restoreAllMocks());

  it('skips the redundant pre-confirm read but still checks the registration after its receipt', async () => {
    const view = await setup(); click(view.review()); await settle();
    expect(view.controller.getSnapshot().status).toBe('confirmed');
    expect(view.replaceAttendance).toHaveBeenCalledOnce();
    expect(view.order).toEqual(['write', 'refresh']);
    expect(view.refreshWithdrawal).not.toHaveBeenCalled();
    expect(joinTargetStore(view.storage, KEYS.project).load().status).toBe('missing');
    expect(view.replaceAttendance.mock.calls[0]![0].releaseKey).toBe(view.read.event.release!.key);
  });

  it.each(['elapsed', 'future', 'incomplete', 'stale block', 'future block', 'diagnostic'] as const)('refreshes a %s snapshot at click time before preparing a write', async kind => {
    const view = await setup(), confirm = view.review();
    if (kind === 'elapsed') view.clock.mockReturnValue(NOW + 60_001);
    else if (kind === 'future') view.clock.mockReturnValue(NOW - 1);
    else if (kind === 'incomplete') view.read.event.snapshot.completeness = 'incomplete';
    else if (kind === 'stale block') view.read.event.snapshot.blockTimestamp = NOW - 60_001;
    else if (kind === 'future block') view.read.event.snapshot.blockTimestamp = NOW + 1;
    else view.read.event.snapshot.reasons = [{ code: 'evidence_unavailable' }];
    click(confirm); await settle();
    expect(view.replaceAttendance).toHaveBeenCalledOnce();
    expect(view.order).toEqual(['refresh', 'write', 'refresh']);
    expect(view.replaceAttendance.mock.calls[0]![0].operation.createdAt).toBe(Date.now());
  });

  it.each(['actor', 'release', 'personal scope', 'source agreement'] as const)('still blocks a changed %s on a fresh snapshot', async kind => {
    const view = await setup(), confirm = view.review();
    if (kind === 'actor') view.read.actor = { kind: 'wallet', address: COORDINATOR };
    else if (kind === 'release') view.read.event.release!.key = entityKey(999);
    else if (kind === 'personal scope') view.read.attendance = { status: 'conflict', entities: [] };
    else view.read.event.sourceProject = null;
    click(confirm); await settle();
    expect(view.replaceAttendance).not.toHaveBeenCalled();
    expect(view.refresh).not.toHaveBeenCalled();
    expect(view.controller.recoverableCommand).toBeNull();
    expect(joinTargetStore(view.storage, KEYS.project).load().status).toBe('ready');
  });

  it.each(['wallet', 'chain'] as const)('does not continue an earlier click after the %s changes', async kind => {
    const view = await setup(), confirm = view.review();
    view.props.session = { ...view.props.session, ...(kind === 'wallet' ? { actor: { kind: 'wallet' as const, address: COORDINATOR } } : { chainId: 1 }) };
    view.render(); click(confirm); await settle();
    expect(view.replaceAttendance).not.toHaveBeenCalled(); expect(view.refresh).not.toHaveBeenCalled();
  });

  it('requires acknowledgement and keeps an explicitly unverified display from submitting', async () => {
    const view = await setup(); click(button(view.render(), 'Join event'));
    const unacknowledged = button(view.render(), 'Confirm my registration');
    expect(unacknowledged.props.disabled).toBe(true); click(unacknowledged); await settle();
    expect(view.replaceAttendance).not.toHaveBeenCalled();
    checkbox(view.render(), 'I reviewed the event details', true);
    view.props.unverified = true;
    const unverified = button(view.render(), 'Confirm my registration');
    expect(unverified.props.disabled).toBe(true); click(unverified); await settle();
    expect(view.replaceAttendance).not.toHaveBeenCalled(); expect(view.refresh).not.toHaveBeenCalled();
  });

  it.each(['stale_heads', 'conflict'] as const)('refreshes a writer %s rejection once while retaining the exact review and original command', async code => {
    const view = await setup(), confirm = view.review();
    const selected = joinTargetStore(view.storage, KEYS.project).load();
    view.replaceAttendance.mockImplementationOnce(async () => { view.order.push('write'); return { ok: false, error: { code, reasons: [], retryable: false } }; });
    click(confirm); await settle();
    expect(view.order).toEqual(['write', 'refresh']);
    expect(view.replaceAttendance).toHaveBeenCalledOnce(); expect(view.refresh).toHaveBeenCalledOnce();
    expect(view.controller.getSnapshot().status).toBe('needs-verification');
    expect(view.controller.recoverableCommand?.operation.id).toBe(view.replaceAttendance.mock.calls[0]![0].operation.id);
    expect(joinTargetStore(view.storage, KEYS.project).load()).toEqual(selected);
    click(confirm); await settle();
    expect(view.replaceAttendance).toHaveBeenCalledOnce();
  });
});
