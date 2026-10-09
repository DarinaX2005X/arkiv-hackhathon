import { describe, expect, it } from 'vitest';
import { createRepositoryActionController } from './actions';
import type { Actor } from '../domain/types';
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
