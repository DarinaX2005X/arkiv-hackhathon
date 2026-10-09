import { useMemo, useSyncExternalStore } from 'react';
import { keccak256, toBytes } from 'viem';
import type { Actor, JsonValue } from '../domain/types';
import type { CommandBase, OperationIntent, Repository, RepositoryError, Result } from '../data/types';
import { useApp, useAppSession, type AppRuntime } from './context';
import type { LoadResult, SaveResult } from './storage';

export type RepositoryActionStatus = 'idle' | 'submitting' | 'needs-verification' | 'confirmed' | 'rejected' | 'reverted';
export interface RepositoryActionState {
  status: RepositoryActionStatus;
  operation: OperationIntent | null;
  error?: RepositoryError;
  message: string;
}
interface ActionRecord {
  status: Exclude<RepositoryActionStatus, 'submitting'>;
  command: JsonValue | null;
  operation: OperationIntent | null;
}
interface ActionStore {
  load(): LoadResult<ActionRecord>;
  save(value: ActionRecord): SaveResult<ActionRecord>;
}
type Submit<C extends CommandBase, T> = (repository: Repository, command: C) => Promise<Result<T>>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const actorKey = (actor: Actor | null): string => !actor ? 'disconnected' : actor.kind === 'wallet' ? `wallet:${actor.address.toLowerCase()}` : actor.id;
const failure = (code: RepositoryError['code'], diagnostic: string): Result<never> => ({ ok: false, error: { code, diagnostic, reasons: [], retryable: false } });

function validRecord(value: unknown): value is ActionRecord {
  if (!object(value) || !['idle', 'needs-verification', 'confirmed', 'rejected', 'reverted'].includes(String(value.status))) return false;
  if (value.status === 'idle') return value.command === null && value.operation === null;
  if (!object(value.command) || !object(value.operation)) return false;
  const operation = value.operation;
  return typeof operation.id === 'string' && operation.id.length > 0 && typeof operation.kind === 'string'
    && object(operation.authority) && object(operation.authority.actor)
    && typeof operation.inputHash === 'string' && Number.isSafeInteger(operation.createdAt)
    && Array.isArray(operation.steps) && Array.isArray(operation.expectedHeads)
    && Array.isArray(operation.confirmedKeys) && typeof operation.phase === 'string'
    && object(value.command.operation) && value.command.operation.id === operation.id;
}

/** UI persistence and duplicate-submit control. The repository remains the signing authority. */
export function createRepositoryActionController({ repository, store, getActor }: {
  repository: Repository | null; store: ActionStore; getActor: () => Actor | null;
}) {
  let state: RepositoryActionState = { status: 'idle', operation: null, message: '' };
  let record: ActionRecord = { status: 'idle', command: null, operation: null };
  let busy = false;
  const listeners = new Set<() => void>();
  const emit = (next: RepositoryActionState) => { state = next; for (const listener of listeners) listener(); };
  const loaded = store.load();
  if (loaded.status === 'ready') {
    record = loaded.value;
    state = { status: record.status, operation: record.operation,
      message: record.status === 'needs-verification' ? 'A previous request needs verification before another can be sent.' : '' };
  } else if (loaded.status === 'recovery') {
    state = { status: 'needs-verification', operation: null,
      message: 'Saved request data needs recovery. Keep its recovery export before starting another request.' };
  }
  const persist = (next: ActionRecord): boolean => {
    record = structuredClone(next);
    const saved = store.save(record);
    if (saved.persisted) return true;
    emit({ status: 'needs-verification', operation: next.operation,
      error: { code: 'storage', reasons: [], retryable: false },
      message: 'This request could not be saved safely. Keep this page open and verify its status before continuing.' });
    return false;
  };
  const sameActor = (operation: OperationIntent): boolean => actorKey(operation.authority.actor) === actorKey(getActor())
    && operation.authority.mode === repository?.mode;
  const finish = (status: ActionRecord['status'], operation: OperationIntent | null, message: string, error?: RepositoryError) => {
    const nextCommand = object(record.command) && operation ? { ...record.command, operation } as unknown as JsonValue : record.command;
    if (!persist({ ...record, command: nextCommand, operation, status })) return;
    emit({ status, operation, message, ...(error ? { error } : {}) });
  };
  const execute = async <C extends CommandBase, T>(command: C, submit: Submit<C, T>): Promise<Result<T>> => {
    if (!repository) return failure('not_connected', 'No repository is available.');
    if (!sameActor(command.operation)) return failure('unauthorized', 'The current account does not own this request.');
    busy = true;
    emit({ status: 'submitting', operation: command.operation, message: 'Submitting your request. Keep this page open while it is checked.' });
    try {
      const result = await submit(repository, command);
      if (!result.ok) {
        // Even a rejected later wallet prompt can follow an already-created root.
        // The repository must reconcile the entire operation before a new intent is allowed.
        finish('needs-verification', command.operation, 'The request was not completed. Check its status before trying again.', result.error);
        return result;
      }
      const value: unknown = result.value;
      const operation = object(value) && object(value.operation) ? value.operation as unknown as OperationIntent : command.operation;
      if (operation.phase === 'complete') finish('confirmed', operation, 'Your request is confirmed.');
      else finish('needs-verification', operation, 'Some steps are still pending. Check the request to continue safely.');
      return result;
    } catch {
      const result = failure('unverified', 'The response was interrupted; the original request must be reconciled.');
      if (!result.ok) finish('needs-verification', command.operation, 'The connection was interrupted. Your request may already have been recorded. Check its status.', result.error);
      return result;
    } finally { busy = false; }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    get recoverableCommand(): CommandBase | null { return object(record.command) ? structuredClone(record.command) as unknown as CommandBase : null; },
    async run<C extends CommandBase, T>(command: C, submit: Submit<C, T>): Promise<Result<T>> {
      if (busy || state.status === 'needs-verification' || state.status === 'submitting') return failure('unverified', 'Resolve the existing request before sending a new one.');
      if (!repository || !sameActor(command.operation)) return failure('unauthorized', 'Connect the account that owns this request.');
      let frozen: C;
      try { frozen = JSON.parse(JSON.stringify(command)) as C; }
      catch { return failure('invalid_input', 'The request must contain valid JSON data.'); }
      if (!persist({ status: 'needs-verification', operation: frozen.operation, command: frozen as unknown as JsonValue })) return failure('storage', 'The request was not persisted; no send was attempted.');
      return execute(frozen, submit);
    },
    async reconcile() {
      if (busy) return failure('unverified', 'A request is already being checked.');
      if (!repository || !record.operation) return failure('unverified', 'No recoverable request is available.');
      if (!sameActor(record.operation)) return failure('unauthorized', 'Connect the account that owns this request.');
      busy = true;
      try {
        const result = await repository.reconcile(structuredClone(record.operation));
        if (!result.ok) { finish('needs-verification', record.operation, 'The current status could not be verified. Keep the original request.', result.error); return result; }
        const value = result.value;
        if (value.status === 'confirmed' && value.operation.phase === 'complete') finish('confirmed', value.operation, 'Your original request is confirmed.');
        else if (value.status === 'confirmed') finish('needs-verification', value.operation, 'A step is confirmed. Continue the remaining steps of this saved request.');
        else if (value.status === 'reverted') finish('reverted', value.operation, 'The transaction did not apply. Review the latest data before creating a new request.', value.error);
        else if (value.status === 'not_sent' && (value.operation.confirmedKeys.length > 0 || value.operation.steps.some(step => step.status === 'confirmed')))
          finish('needs-verification', value.operation, 'Earlier steps are already recorded. Continue this saved request to finish publishing.');
        else if (value.status === 'not_sent') finish('rejected', value.operation, 'No transaction was sent. You can review your input and try again.');
        else finish('needs-verification', value.operation, value.status === 'pending' ? 'The original request is still pending. Continue only this saved request.' : 'The original request cannot yet be verified.', value.status === 'unverified' ? value.error : undefined);
        return result;
      } catch {
        finish('needs-verification', record.operation, 'The status check was interrupted. The original request has been kept.');
        return failure('unverified', 'Reconciliation was interrupted.');
      } finally { busy = false; }
    },
    async resume<C extends CommandBase, T>(submit: Submit<C, T>): Promise<Result<T>> {
      if (busy || state.status === 'reverted' || state.status === 'confirmed' || !object(record.command) || !record.operation) return failure('unverified', 'This request cannot be resumed.');
      // Repositories reconcile each saved step before sending a remaining one.
      return execute(structuredClone(record.command) as unknown as C, submit);
    },
    clear(): boolean {
      if (busy || !['idle', 'confirmed', 'rejected', 'reverted'].includes(state.status)) return false;
      if (!persist({ status: 'idle', command: null, operation: null })) return false;
      emit({ status: 'idle', operation: null, message: '' });
      return true;
    },
  };
}

const controllers = new WeakMap<AppRuntime, Map<string, ReturnType<typeof createRepositoryActionController>>>();
export function useRepositoryAction(channel: string) {
  const runtime = useApp();
  const session = useAppSession();
  const key = `${channel}:${actorKey(session.actor)}`;
  const controller = useMemo(() => {
    let registry = controllers.get(runtime);
    if (!registry) { registry = new Map(); controllers.set(runtime, registry); }
    let existing = registry.get(key);
    if (!existing) {
      existing = createRepositoryActionController({ repository: runtime.repository,
        store: runtime.drafts(`action:${keccak256(toBytes(key)).slice(2)}`, 'repository-action', validRecord),
        getActor: () => runtime.session.getSnapshot().actor });
      registry.set(key, existing);
    }
    return existing;
  }, [runtime, key]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { state, run: controller.run, reconcile: controller.reconcile, resume: controller.resume,
    clear: controller.clear, recoverableCommand: controller.recoverableCommand };
}
