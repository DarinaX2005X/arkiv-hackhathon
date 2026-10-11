import { describe, expect, it } from 'vitest';
import { createRepositoryActionController, validRepositoryActionRecord } from './actions';
import { createDraftStore } from './storage';
import { createOperationIntent } from '../data/operations';
import { TIRAMISU_CHAIN_ID, type Actor } from '../domain/types';
import type { CommandBase, OperationIntent, ReconciliationResult, Repository, Result } from '../data/types';

type Port = Parameters<typeof createRepositoryActionController>[0]['store'];
type Record = Parameters<Port['save']>[0];
const actor: Actor = { kind: 'local', id: 'local-actor:test' };
const intent = (id = 'one'): OperationIntent => ({ id, kind: 'replace_book', authority: { mode: 'local', actor, chainId: null },
  createdAt: 1, input: {}, inputHash: `0x${'a'.repeat(64)}`, expectedHeads: [], phase: 'prepared', transactionHash: null,
  confirmedKeys: [], pendingPublisherRoots: [], steps: [] });
const command = (id = 'one'): CommandBase => ({ operation: intent(id), lifetimeSeconds: 3600 });
function store(persisted = true) {
  let value: Record | undefined;
  const port: Port = {
    load: () => value ? { status: 'ready', value: structuredClone(value), updatedAt: 1 } : { status: 'missing' },
    save: next => { if (persisted) value = structuredClone(next); return { value: next, persisted, issue: persisted ? null : { code: 'write_failed', recoverableText: null } }; },
  };
  return port;
}
const receipt = (operation: OperationIntent) => ({ operationId: operation.id, transactionHash: null, entityKeys: [], consumedKeys: [], blockNumber: null, confirmedAt: 1 });
function repository(reconcile: (operation: OperationIntent) => Promise<Result<ReconciliationResult>>) {
  return { mode: 'local', reconcile } as unknown as Repository;
}
const pendingRepository = () => repository(async operation => ({ ok: true, value: { status: 'pending', operation } }));

describe('shared request persistence and reconciliation', () => {
  it('keeps confirmed roots through a reverted later step and resumes the same request', async () => {
    const partial = { ...intent(), kind: 'create_project' as const, phase: 'root_confirmed' as const, confirmedKeys: ['local:root' as const] };
    const error = { code: 'reverted' as const, reasons: [], retryable: false };
    const repo = repository(async () => ({ ok: true, value: { status: 'partial_reverted', operation: partial, receipt: receipt(partial), error } }));
    const controller = createRepositoryActionController({ repository: repo, store: store(), getActor: () => actor });
    await controller.run({ ...command(), operation: partial }, async () => ({ ok: false, error }));
    await controller.reconcile();
    expect(controller.getSnapshot().status).toBe('needs-verification');
    expect(controller.clear()).toBe(false);
    let resumed: CommandBase | undefined;
    await controller.resume<CommandBase, unknown>(async (_, saved) => { resumed = saved; return { ok: true, value: { operation: { ...partial, phase: 'complete' } } }; });
    expect(resumed?.operation.id).toBe('one');
    expect(resumed?.operation.confirmedKeys).toEqual(['local:root']);
    expect(controller.getSnapshot().status).toBe('confirmed');
  });
  it('does not invoke the repository mutation when durable persistence fails', async () => {
    let sends = 0;
    const controller = createRepositoryActionController({ repository: pendingRepository(), store: store(false), getActor: () => actor });
    const result = await controller.run(command(), async () => { sends++; throw new Error('must not run'); });
    expect(result.ok).toBe(false); expect(sends).toBe(0);
    expect(controller.getSnapshot().status).toBe('needs-verification');
  });
  it('blocks another request and preserves the original identity after an unknown response', async () => {
    let sends = 0;
    const journal = store();
    const controller = createRepositoryActionController({ repository: pendingRepository(), store: journal, getActor: () => actor });
    await controller.run(command(), async () => { sends++; throw new Error('lost response'); });
    await controller.run(command('two'), async () => { sends++; throw new Error('duplicate'); });
    expect(sends).toBe(1); expect(controller.clear()).toBe(false);
    const restored = createRepositoryActionController({ repository: pendingRepository(), store: journal, getActor: () => actor });
    expect(restored.getSnapshot().operation?.id).toBe('one');
    await restored.reconcile();
    expect(restored.getSnapshot().status).toBe('needs-verification');
  });
  it('does not submit twice while the first callback is running', async () => {
    let resolve!: (value: Result<{ operation: OperationIntent }>) => void;
    let sends = 0;
    const controller = createRepositoryActionController({ repository: pendingRepository(), store: store(), getActor: () => actor });
    const first = controller.run<CommandBase, { operation: OperationIntent }>(command(), () => { sends++; return new Promise(done => { resolve = done; }); });
    await controller.run(command('two'), async () => { sends++; throw new Error('must not run'); });
    resolve({ ok: true, value: { operation: { ...intent(), phase: 'complete' } } });
    await first;
    expect(sends).toBe(1); expect(controller.getSnapshot().status).toBe('confirmed');
  });
  it('does not call a confirmed root a completed multi-step publication', async () => {
    const partial = { ...intent(), kind: 'create_project' as const, phase: 'root_confirmed' as const, confirmedKeys: ['local:root' as const] };
    const repo = repository(async () => ({ ok: true, value: { status: 'confirmed', operation: partial, receipt: receipt(partial) } }));
    const controller = createRepositoryActionController({ repository: repo, store: store(), getActor: () => actor });
    await controller.run({ ...command(), operation: partial }, async () => ({ ok: false, error: { code: 'rejected', reasons: [], retryable: false } }));
    await controller.reconcile();
    expect(controller.getSnapshot().status).toBe('needs-verification');
    expect(controller.clear()).toBe(false);
  });
  it('a verified reverted transaction is terminal and cannot be resumed under the same intent', async () => {
    const op = intent();
    const error = { code: 'reverted' as const, reasons: [], retryable: false };
    const repo = repository(async () => ({ ok: true, value: { status: 'reverted', operation: op, receipt: receipt(op), error } }));
    const controller = createRepositoryActionController({ repository: repo, store: store(), getActor: () => actor });
    await controller.run(command(), async () => ({ ok: false, error }));
    await controller.reconcile();
    let sends = 0;
    await controller.resume(async () => { sends++; return { ok: true, value: null }; });
    expect(sends).toBe(0); expect(controller.getSnapshot().status).toBe('reverted');
  });
  it('retains a saved request but refuses to resume it with a different actor', async () => {
    let current = actor;
    const controller = createRepositoryActionController({ repository: pendingRepository(), store: store(), getActor: () => current });
    await controller.run(command(), async () => { throw new Error('interrupted'); });
    current = { kind: 'local', id: 'local-actor:someone-else' };
    let sends = 0;
    await controller.resume(async () => { sends++; return { ok: true, value: null }; });
    expect(sends).toBe(0); expect(controller.recoverableCommand?.operation.id).toBe('one');
  });
});

describe('unreadable request recovery', () => {
  const goodRecord = () => {
    const input = { lifetimeSeconds: 3600 };
    const operation = createOperationIntent('replace_book', { mode: 'local', actor: actor as { kind: 'local'; id: `local-actor:${string}` }, chainId: null }, input, { id: 'saved-one', now: 1 });
    return { status: 'needs-verification' as const, command: { ...input, operation }, operation } as unknown as Record;
  };
  function setup() {
    const values = new Map<string, string>([['saved', '{corrupt original']]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const journal = createDraftStore({ storage, key: 'saved', kind: 'repository-action', validate: validRepositoryActionRecord, now: () => 1 });
    const backup = journal.export(goodRecord());
    let current = actor;
    const reconciled: string[] = [];
    const controller = createRepositoryActionController({ store: journal, getActor: () => current,
      repository: repository(async operation => { reconciled.push(operation.id); return { ok: true, value: { status: 'pending', operation } }; }) });
    return { controller, backup, values, reconciled, setActor: (next: Actor) => { current = next; } };
  }
  it('retains original bytes, restores a validated backup, and checks the same original request', async () => {
    const { controller, backup, values, reconciled } = setup();
    expect(controller.recoveryText).toBe('{corrupt original');
    expect(controller.clear()).toBe(false);
    let sends = 0;
    await controller.run(command(), async () => { sends++; return { ok: true, value: null }; });
    expect(sends).toBe(0);
    expect(controller.restoreRecovery(backup).ok).toBe(true);
    expect(controller.recoveryText).toBeNull();
    expect(values.get('saved')).not.toBe('{corrupt original');
    expect(controller.getSnapshot().status).toBe('needs-verification');
    await controller.reconcile();
    expect(reconciled).toEqual(['saved-one']);
    expect(sends).toBe(0);
  });
  it('rejects changed command data and another owner without overwriting the unreadable file', () => {
    const { controller, backup, values, setActor } = setup();
    const changed = JSON.parse(backup); changed.payload.command.lifetimeSeconds++;
    expect(controller.restoreRecovery(JSON.stringify(changed)).ok).toBe(false);
    setActor({ kind: 'local', id: 'local-actor:another' });
    expect(controller.restoreRecovery(backup).ok).toBe(false);
    expect(controller.restoreRecovery('{broken').ok).toBe(false);
    expect(values.get('saved')).toBe('{corrupt original');
    expect(controller.recoveryText).toBe('{corrupt original');
  });
});

describe('public request journal loss', () => {
  const publicActor = { kind: 'wallet' as const, address: `0x${'12'.repeat(20)}` as const };
  const publicCommand = () => {
    const input = { lifetimeSeconds: 3600, expectedHeads: [] };
    return { ...input, operation: createOperationIntent('replace_attendance', { mode: 'public', actor: publicActor, chainId: TIRAMISU_CHAIN_ID }, input) };
  };
  it('does not turn an ambiguous original intent into no-send proof when its native journal disappeared', async () => {
    const command = publicCommand();
    const journal = store();
    const repo = { mode: 'public' as const, reconcile: async (operation: OperationIntent): Promise<Result<ReconciliationResult>> => ({ ok: true, value: { status: 'not_sent', operation } }) };
    const action = createRepositoryActionController({ repository: repo, store: journal, getActor: () => publicActor });
    await action.run(command, async () => { throw new Error('The send response was lost'); });
    const reopened = createRepositoryActionController({ repository: repo, store: journal, getActor: () => publicActor });
    const result = await reopened.reconcile();
    expect(result.ok && result.value.status).toBe('unverified');
    expect(reopened.getSnapshot().status).toBe('needs-verification');
    expect(reopened.clear()).toBe(false);
    let callbacks = 0;
    await reopened.resume(async () => { callbacks++; return { ok: true, value: null }; });
    expect(callbacks).toBe(0);
  });
  it('reconciles a saved request before a resume callback can use the repository', async () => {
    const command = publicCommand(); const order: string[] = [];
    const operation: OperationIntent = { ...command.operation, steps: [{ id: 'kept-step', phase: 'initial_state_pending', status: 'failed-before-send',
      transactionHash: null, confirmedKeys: [], expectedHeads: [], inputHash: command.operation.inputHash }] };
    const repo = { mode: 'public' as const, reconcile: async (): Promise<Result<ReconciliationResult>> => {
      order.push('reconcile'); return { ok: true, value: { status: 'not_sent', operation, evidence: 'native-journal' } };
    } };
    const action = createRepositoryActionController({ repository: repo, store: store(), getActor: () => publicActor });
    await action.run(command, async () => ({ ok: false, error: { code: 'rejected', reasons: [], retryable: false } }));
    await action.resume(async (_repo, saved) => { order.push('resume'); expect(saved.operation.id).toBe(command.operation.id); return { ok: true, value: { operation: { ...operation, phase: 'complete' } } }; });
    expect(order).toEqual(['reconcile', 'resume']);
  });
  it('rejects caller steps echoed without native journal evidence after a rejected request was retried', async () => {
    const command = publicCommand();
    command.operation.steps = [{ id: 'old-rejection', phase: 'initial_state_pending', status: 'failed-before-send',
      transactionHash: null, confirmedKeys: [], expectedHeads: [], inputHash: command.operation.inputHash }];
    const repo = { mode: 'public' as const, reconcile: async (operation: OperationIntent): Promise<Result<ReconciliationResult>> => ({ ok: true, value: { status: 'not_sent', operation } }) };
    const action = createRepositoryActionController({ repository: repo, store: store(), getActor: () => publicActor });
    await action.run(command, async () => { throw new Error('Retried send has an unknown outcome'); });
    let callbacks = 0;
    await action.resume(async () => { callbacks++; return { ok: true, value: null }; });
    expect(callbacks).toBe(0); expect(action.getSnapshot().status).toBe('needs-verification'); expect(action.clear()).toBe(false);
  });
  it.each(['native-journal', 'preflight-journal'] as const)('never downgrades observed send evidence to not sent even if %s claims it', async evidence => {
    const command = publicCommand();
    command.operation.steps = [{ id: 'known-send', phase: 'initial_state_pending', status: 'unverified',
      transactionHash: null, confirmedKeys: [], expectedHeads: [], inputHash: command.operation.inputHash }];
    const repo = { mode: 'public' as const, reconcile: async (operation: OperationIntent): Promise<Result<ReconciliationResult>> => ({ ok: true, value: { status: 'not_sent', operation: { ...operation, steps: [] }, evidence } }) };
    const action = createRepositoryActionController({ repository: repo, store: store(), getActor: () => publicActor });
    await action.run(command, async () => { throw new Error('Lost response'); });
    await action.reconcile();
    expect(action.getSnapshot().operation?.steps[0]?.status).toBe('unverified');
    expect(action.getSnapshot().status).toBe('needs-verification'); expect(action.clear()).toBe(false);
  });
  it('rechecks a public rejected envelope on return before allowing it to be cleared', async () => {
    const command = publicCommand(); const journal = store();
    journal.save({ status: 'rejected', command: command as unknown as Record['command'], operation: command.operation });
    const repo = { mode: 'public' as const, reconcile: async (operation: OperationIntent): Promise<Result<ReconciliationResult>> => ({ ok: true, value: { status: 'not_sent', operation } }) };
    const reopened = createRepositoryActionController({ repository: repo, store: journal, getActor: () => publicActor });
    expect(reopened.getSnapshot().status).toBe('needs-verification'); expect(reopened.clear()).toBe(false);
    await reopened.reconcile();
    expect(reopened.getSnapshot().status).toBe('needs-verification'); expect(reopened.clear()).toBe(false);
  });
  it('retries the same frozen request after durable preflight rejection and retains it if the retry becomes unknown', async () => {
    const command = publicCommand(); const journal = store();
    let preflightOnly = true; let checks = 0;
    const repo = { mode: 'public' as const, reconcile: async (operation: OperationIntent): Promise<Result<ReconciliationResult>> => {
      checks++;
      return preflightOnly
        ? { ok: true, value: { status: 'not_sent', operation, evidence: 'preflight-journal' } }
        : { ok: true, value: { status: 'unverified', operation, error: { code: 'unverified', reasons: [{ code: 'evidence_unavailable' }], retryable: false } } };
    } };
    const action = createRepositoryActionController({ repository: repo, store: journal, getActor: () => publicActor });
    await action.run(command, async () => ({ ok: false, error: { code: 'network', reasons: [], retryable: true } }));
    expect(action.getSnapshot().status).toBe('needs-verification');
    await action.reconcile();
    expect(action.getSnapshot().status).toBe('rejected');
    const reopened = createRepositoryActionController({ repository: repo, store: journal, getActor: () => publicActor });
    expect(reopened.getSnapshot().status).toBe('needs-verification');
    let resumed = 0;
    await reopened.resume(async (_, saved) => {
      resumed++; expect(checks).toBe(2); expect(saved).toEqual(command);
      preflightOnly = false; throw new Error('The wallet response was interrupted');
    });
    expect(resumed).toBe(1); expect(reopened.getSnapshot().operation?.id).toBe(command.operation.id);
    await reopened.resume(async () => { resumed++; return { ok: true, value: null }; });
    expect(resumed).toBe(1); expect(reopened.getSnapshot().status).toBe('needs-verification'); expect(reopened.clear()).toBe(false);
  });
});
