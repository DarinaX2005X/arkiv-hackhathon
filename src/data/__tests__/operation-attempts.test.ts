import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { OperationIntent } from '../types';
import { allocateOperationStep, BrowserOperationStore, createOperationController, createOperationIntent,
  inspectReconciliationJournal, MemoryOperationStore } from '../operations';
import type { OperationStore, StoredOperationAttempt } from '../operations';
import { ARKIV_NATIVE_ADDRESS, WalletOperationError } from '../wallet';
import type { NativeBatch, NativeTransactionOptions, NativeWalletGateway } from '../wallet';
import { createFileStorage } from '../../../tests/arkiv-live/safety';

const NOW = 1_791_532_800_000;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const KEY = `0x${'a'.repeat(64)}` as const;
const HASH = `0x${'b'.repeat(64)}` as const;
const batch: NativeBatch = { deletes: [KEY] };

function fixture(store: OperationStore = new MemoryOperationStore()) {
  const control = { preparations: 0, sends: 0 };
  const gateway: NativeWalletGateway = {
    async prepare(value, account, transactionOptions = {}) {
      control.preparations++;
      return { batch: structuredClone(value), account, chainId: TIRAMISU_CHAIN_ID, transactionOptions,
        request: { from: account, to: ARKIV_NATIVE_ADDRESS, data: '0x1234', value: '0x0', chainId: '0x7614d1' },
        estimatedGas: '100000', preparedAtBlock: '100', estimatedCostWei: null, estimatedMaximumCostWei: null, estimatePolicy: 'gas-only' };
    },
    async submit(prepared, hooks) {
      await hooks.onAdmission(prepared.request); control.sends++;
      await hooks.onHash(HASH); return { status: 'submitted', transactionHash: HASH };
    },
    dispose() {},
  };
  const controller = createOperationController({ store, gateway, now: () => NOW });
  const operation = createOperationIntent('replace_book', { mode: 'public', actor: { kind: 'wallet', address: ACCOUNT }, chainId: TIRAMISU_CHAIN_ID },
    { expectedHeads: [KEY], lifetimeSeconds: 3600 }, { id: 'attempt-one', now: NOW });
  const step = allocateOperationStep(operation, 'book_pending', batch, [KEY]);
  const journal = (input = operation) => inspectReconciliationJournal(input, controller.getOperation(input.id), controller.getStep, controller.getAttempt(input.id));
  const prepare = (resolveTransactionOptions?: () => Promise<NativeTransactionOptions>) =>
    controller.prepareStep({ operation: { ...operation, phase: 'book_pending', steps: [step] }, step, batch }, resolveTransactionOptions);
  return { store, gateway, controller, operation, step, control, journal, prepare };
}

describe('durable writer attempts before native preparation', () => {
  it.each(['memory', 'browser'] as const)('settles a concurrent read failure in %s storage before allowing a deliberate retry', async kind => {
    const values = new Map<string, string>();
    const store = kind === 'memory' ? new MemoryOperationStore() : new BrowserOperationStore({
      getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    }, { locks: new MemoryOperationStore() });
    const f = fixture(store), second = { ...f.operation, id: 'concurrent-read' };
    let enteredRead!: () => void, failRead!: () => void, enteredPrepare!: () => void, finishPrepare!: () => void;
    const reading = new Promise<void>(resolve => { enteredRead = resolve; });
    const failedRead = new Promise<void>(resolve => { failRead = resolve; });
    const preparing = new Promise<void>(resolve => { enteredPrepare = resolve; });
    const prepared = new Promise<void>(resolve => { finishPrepare = resolve; });
    const originalPrepare = f.gateway.prepare.bind(f.gateway);
    f.gateway.prepare = async (...args) => { enteredPrepare(); await prepared; return originalPrepare(...args); };
    const originalFailure = new Error('Independent read failed');
    const failed = f.controller.withOperationAttempt(second, async () => {
      enteredRead(); await failedRead; throw originalFailure;
    }).catch(error => error as unknown);
    await reading;
    const first = f.controller.withOperationAttempt(f.operation, f.prepare);
    await preparing;
    failRead();
    // Settlement remains pending while another operation owns the journal.
    await Promise.resolve(); await Promise.resolve();
    expect(f.controller.getAttempt(second.id)?.state).toBe('preflight');
    expect(f.control.sends).toBe(0);
    finishPrepare(); await first;
    expect(await failed).toBe(originalFailure);
    expect(f.controller.getAttempt(second.id)).toMatchObject({ state: 'rejected-before-native', nativeStepIds: [] });
    expect(f.journal(second)).toEqual({ complete: true, notSentEvidence: 'preflight-journal' });
    expect(f.control).toEqual({ preparations: 1, sends: 0 });

    const step = allocateOperationStep(second, 'book_pending', batch, [KEY]);
    await f.controller.withOperationAttempt(second, async () => {
      await f.controller.beforeNativeAttempt(second.id, step);
      await f.controller.prepareStep({ operation: { ...second, phase: 'book_pending', steps: [step] }, step, batch });
      await f.controller.submitStep(second.id, step.id);
    });
    expect(f.controller.getStep(second.id, step.id)?.step.status).toBe('submitted');
    expect(f.control).toEqual({ preparations: 2, sends: 1 });
  });

  it.each(['checkpoint', 'prepare'] as const)('can settle lock contention before the %s callback entered native preparation', async boundary => {
    const f = fixture(), second = { ...f.operation, id: `busy-${boundary}` };
    let enteredRead!: () => void, finishRead!: () => void, enteredPrepare!: () => void, finishPrepare!: () => void;
    const reading = new Promise<void>(resolve => { enteredRead = resolve; });
    const read = new Promise<void>(resolve => { finishRead = resolve; });
    const preparing = new Promise<void>(resolve => { enteredPrepare = resolve; });
    const prepared = new Promise<void>(resolve => { finishPrepare = resolve; });
    const originalPrepare = f.gateway.prepare.bind(f.gateway);
    f.gateway.prepare = async (...args) => { enteredPrepare(); await prepared; return originalPrepare(...args); };
    const step = allocateOperationStep(second, 'book_pending', batch, [KEY]);
    const failed = f.controller.withOperationAttempt(second, async () => {
      enteredRead(); await read;
      if (boundary === 'checkpoint') await f.controller.beforeNativeAttempt(second.id, step);
      else await f.controller.prepareStep({ operation: { ...second, phase: 'book_pending', steps: [step] }, step, batch });
    }).catch(error => error as WalletOperationError);
    await reading;
    const first = f.controller.withOperationAttempt(f.operation, f.prepare); await preparing;
    finishRead(); await Promise.resolve(); await Promise.resolve();
    finishPrepare(); await first;
    expect(await failed).toMatchObject({ kind: 'not_sent', code: 'conflict' });
    expect(f.journal(second)).toEqual({ complete: true, notSentEvidence: 'preflight-journal' });
    expect(f.controller.getAttempt(second.id)?.nativeStepIds).toEqual([]);
    expect(f.control).toEqual({ preparations: 1, sends: 0 });
  });

  it('preserves the original read error and fails closed when its settlement cannot be stored', async () => {
    const originalFailure = new Error('Read unavailable'), writeFailure = new WalletOperationError('Disk full', { kind: 'not_sent', code: 'storage' });
    class FailingSettlementStore extends MemoryOperationStore {
      override putAttemptCAS(record: StoredOperationAttempt, revision: number | null) {
        if (record.state === 'rejected-before-native') throw writeFailure;
        super.putAttemptCAS(record, revision);
      }
    }
    const f = fixture(new FailingSettlementStore());
    const failed = await f.controller.withOperationAttempt(f.operation, async () => { throw originalFailure; }).catch(error => error as WalletOperationError);
    expect(failed).toMatchObject({ kind: 'unverified', code: 'storage' });
    expect(failed.cause).toBeInstanceOf(AggregateError);
    expect((failed.cause as AggregateError).errors).toEqual([originalFailure, writeFailure]);
    expect(f.journal().complete).toBe(false);
    expect(f.controller.getAttempt(f.operation.id)?.state).toBe('preflight');
    expect(f.control).toEqual({ preparations: 0, sends: 0 });
  });

  it('retains no-send evidence when preparation loses the lock after its native marker was saved', async () => {
    const f = fixture(), second = { ...f.operation, id: 'native-marker-contention' };
    const step = allocateOperationStep(second, 'book_pending', batch, [KEY]);
    let marked!: () => void, continueSecond!: () => void, enteredPrepare!: () => void, finishPrepare!: () => void;
    const nativeMarked = new Promise<void>(resolve => { marked = resolve; });
    const continuePreparation = new Promise<void>(resolve => { continueSecond = resolve; });
    const preparing = new Promise<void>(resolve => { enteredPrepare = resolve; });
    const prepared = new Promise<void>(resolve => { finishPrepare = resolve; });
    const originalPrepare = f.gateway.prepare.bind(f.gateway);
    f.gateway.prepare = async (...args) => { enteredPrepare(); await prepared; return originalPrepare(...args); };
    const prepareSecond = () => f.controller.prepareStep({ operation: { ...second, phase: 'book_pending', steps: [step] }, step, batch });
    const failed = f.controller.withOperationAttempt(second, async () => {
      await f.controller.beforeNativeAttempt(second.id, step); marked(); await continuePreparation;
      await prepareSecond();
    }).catch(error => error as WalletOperationError);
    await nativeMarked;
    const first = f.controller.withOperationAttempt(f.operation, f.prepare); await preparing;
    continueSecond(); await Promise.resolve(); await Promise.resolve();
    finishPrepare(); await first;
    expect(await failed).toMatchObject({ kind: 'not_sent', code: 'conflict' });
    expect(f.controller.getStep(second.id, step.id)).toMatchObject({
      step: { status: 'failed-before-send' }, prepared: null, admission: null,
    });
    expect(f.journal(second)).toEqual({ complete: true, notSentEvidence: 'native-journal' });
    expect(f.control).toEqual({ preparations: 1, sends: 0 });
    await f.controller.withOperationAttempt(second, async () => {
      await f.controller.beforeNativeAttempt(second.id, step); await prepareSecond();
      await f.controller.submitStep(second.id, step.id);
    });
    expect(f.control).toEqual({ preparations: 2, sends: 1 });
  });

  it('settles a thrown preflight failure and replaces its generation only on a deliberate unchanged retry', async () => {
    const f = fixture();
    await expect(f.controller.withOperationAttempt(f.operation, async () => { throw new Error('Read unavailable'); })).rejects.toThrow('Read unavailable');
    const first = f.controller.getAttempt(f.operation.id)!;
    expect(first).toMatchObject({ state: 'rejected-before-native', nativeStepIds: [], revision: 2, settledAt: NOW });
    expect(f.journal()).toEqual({ complete: true, notSentEvidence: 'preflight-journal' });
    await expect(f.controller.withOperationAttempt(f.operation, async () => {
      expect(f.controller.getAttempt(f.operation.id)).toMatchObject({ state: 'preflight', revision: 3 });
      expect(f.journal().complete).toBe(false);
      throw new Error('Still unavailable');
    })).rejects.toThrow('Still unavailable');
    const second = f.controller.getAttempt(f.operation.id)!;
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.revision).toBe(4);
    expect(f.store.list()).toEqual([]);
    expect(f.control).toEqual({ preparations: 0, sends: 0 });
  });

  it('rejects callbacks that return a failure Result instead of throwing before result conversion', async () => {
    const f = fixture();
    await expect(f.controller.withOperationAttempt(f.operation, async () => ({ ok: false, error: 'preflight failure' }))).rejects.toThrow('must throw');
    expect(f.journal()).toEqual({ complete: true, notSentEvidence: 'preflight-journal' });
  });

  it('does not replace a live attempt from another controller or reset its orphan after restart', async () => {
    const f = fixture(); let entered!: () => void; let rejectRead!: (reason: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = f.controller.withOperationAttempt(f.operation, async () => {
      entered(); return new Promise<void>((_resolve, reject) => { rejectRead = reject; });
    });
    await started;
    const other = createOperationController({ store: f.store, gateway: f.gateway, now: () => NOW });
    await expect(other.withOperationAttempt(f.operation, async () => 'must not run')).rejects.toMatchObject({ code: 'conflict' });
    expect(f.journal().complete).toBe(false);
    const crashStore = new MemoryOperationStore(); crashStore.putAttemptCAS(f.controller.getAttempt(f.operation.id)!, null);
    const restarted = createOperationController({ store: crashStore, gateway: f.gateway, now: () => NOW });
    await expect(restarted.withOperationAttempt(f.operation, async () => 'must not run')).rejects.toMatchObject({ kind: 'unverified' });
    rejectRead(new Error('Read failed')); await expect(pending).rejects.toThrow('Read failed');
    expect(f.journal().notSentEvidence).toBe('preflight-journal');
    expect(crashStore.getAttempt(f.operation.id)?.state).toBe('preflight');
  });

  it('blocks preparation when persisting the native boundary fails and leaves no preflight proof', async () => {
    class FailingStore extends MemoryOperationStore {
      override putAttemptCAS(record: StoredOperationAttempt, revision: number | null) {
        if (record.state === 'native-started') throw new WalletOperationError('Checkpoint failed', { kind: 'not_sent', code: 'storage' });
        super.putAttemptCAS(record, revision);
      }
    }
    const f = fixture(new FailingStore());
    await expect(f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step); await f.prepare();
    })).rejects.toMatchObject({ code: 'storage' });
    expect(f.controller.getAttempt(f.operation.id)?.state).toBe('preflight');
    expect(f.journal().complete).toBe(false);
    await expect(f.controller.withOperationAttempt(f.operation, f.prepare)).rejects.toMatchObject({ kind: 'unverified' });
    expect(f.control.preparations).toBe(0);
  });

  it('retains native entry when an outer estimate fails before a native step exists and blocks direct retry', async () => {
    const f = fixture();
    await expect(f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step); throw new Error('Outer estimate failed');
    })).rejects.toThrow('Outer estimate failed');
    expect(f.controller.getAttempt(f.operation.id)).toMatchObject({ state: 'native-started', nativeStepIds: [f.step.id] });
    expect(f.store.list()).toEqual([]); expect(f.journal().complete).toBe(false);
    await expect(f.controller.withOperationAttempt(f.operation, f.prepare)).rejects.toMatchObject({ kind: 'unverified' });
    await expect(f.prepare()).rejects.toMatchObject({ kind: 'unverified' });
    expect(f.control.preparations).toBe(0);
  });

  it('journals an unsigned option resolver failure and retries the same native step with actual no-admission evidence', async () => {
    const f = fixture();
    await expect(f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step);
      await f.prepare(async () => {
        expect(f.controller.getStep(f.operation.id, f.step.id)).toMatchObject({
          step: { id: f.step.id, status: 'prepared', inputHash: hashCanonical(batch) }, prepared: null, admission: null,
        });
        throw new Error('Unsigned cap estimate unavailable');
      });
    })).rejects.toThrow('could not be prepared');
    expect(f.controller.getAttempt(f.operation.id)?.state).toBe('native-started');
    expect(f.controller.getStep(f.operation.id, f.step.id)).toMatchObject({ step: { status: 'failed-before-send' }, admission: null });
    expect(f.journal()).toEqual({ complete: true, notSentEvidence: 'native-journal' });
    const caps = { gas: '120000' as const, maxFeePerGas: '2000000000' as const, maxPriorityFeePerGas: '1' as const };
    const recovered = await f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step);
      return f.prepare(async () => caps);
    });
    expect(recovered.step.id).toBe(f.step.id); expect(recovered.prepared?.transactionOptions).toEqual(caps);
    expect(f.store.list()).toHaveLength(1); expect(f.control).toEqual({ preparations: 1, sends: 0 });
  });

  it('does not invoke an option resolver until the native step checkpoint succeeds', async () => {
    class FailingNativeStore extends MemoryOperationStore {
      override put() { throw new WalletOperationError('Native checkpoint failed', { kind: 'not_sent', code: 'storage' }); }
    }
    const f = fixture(new FailingNativeStore()); let resolutions = 0;
    await expect(f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step);
      await f.prepare(async () => { resolutions++; return { gas: '120000' }; });
    })).rejects.toMatchObject({ code: 'storage' });
    expect(resolutions).toBe(0); expect(f.control.preparations).toBe(0);
    expect(f.journal().complete).toBe(false);
    await expect(f.controller.withOperationAttempt(f.operation, () => f.prepare())).rejects.toMatchObject({ kind: 'unverified' });
  });

  it('allows intact unsigned native preparation to resume without downgrading its attempt marker', async () => {
    const f = fixture();
    await expect(f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step); await f.prepare(); throw new Error('Read changed');
    })).rejects.toThrow('Read changed');
    const native = f.controller.getAttempt(f.operation.id)!;
    expect(native.state).toBe('native-started'); expect(f.journal().notSentEvidence).toBe('native-journal');
    await f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step); await f.prepare();
      await f.controller.submitStep(f.operation.id, f.step.id);
    });
    expect(f.controller.getAttempt(f.operation.id)).toEqual(native);
    expect(f.journal()).toEqual({ complete: true }); expect(f.control.sends).toBe(1);
  });

  it('refuses stale CAS writes and native-to-preflight downgrades', async () => {
    const f = fixture(); let original!: StoredOperationAttempt;
    await expect(f.controller.withOperationAttempt(f.operation, async () => {
      original = f.controller.getAttempt(f.operation.id)!;
      await f.controller.beforeNativeAttempt(f.operation.id, f.step); await f.prepare(); throw new Error('Read changed');
    })).rejects.toThrow('Read changed');
    expect(() => f.store.putAttemptCAS({ ...original, revision: 2, state: 'rejected-before-native', settledAt: NOW }, 1)).toThrow();
    const native = f.controller.getAttempt(f.operation.id)!;
    expect(() => f.store.putAttemptCAS({ ...original, revision: native.revision + 1 }, native.revision)).toThrow();
    expect(f.controller.getAttempt(f.operation.id)).toEqual(native);
  });

  it('includes observed native progress from an adopted legacy attempt when checking rolled-back records', async () => {
    const f = fixture(); const prepared = await f.prepare();
    await f.controller.submitStep(f.operation.id, f.step.id);
    const submitted = f.controller.getOperation(f.operation.id)!;
    await expect(f.controller.withOperationAttempt(submitted, async () => { throw new Error('Read failed'); })).rejects.toThrow('Read failed');
    f.store.put(prepared);
    expect(f.journal().complete).toBe(false);
  });

  it('requires matching immutable binding and no caller progress for preflight evidence', async () => {
    const f = fixture();
    await expect(f.controller.withOperationAttempt(f.operation, async () => { throw new Error('Read failed'); })).rejects.toThrow();
    const changed: OperationIntent = { ...f.operation, createdAt: NOW + 1 };
    expect(f.journal(changed).complete).toBe(false);
    expect(f.journal({ ...f.operation, transactionHash: HASH }).complete).toBe(false);
    expect(f.journal({ ...f.operation, steps: [f.step] }).complete).toBe(false);
    expect(inspectReconciliationJournal(f.operation, undefined, f.controller.getStep).complete).toBe(false);
  });
});

describe('single-document attempt storage', () => {
  it('opts in to waiting Web Locks only for journal work and retains fail-fast admission', async () => {
    const coordinator = new MemoryOperationStore(), requests: { mode: string; ifAvailable?: boolean }[] = [];
    vi.stubGlobal('navigator', { locks: {
      request<T>(name: string, options: { mode: string; ifAvailable?: boolean }, callback: (lock: object | null) => Promise<T>) {
        requests.push(options);
        return coordinator.runExclusive(name, () => callback({ name }), { wait: !options.ifAvailable })
          .catch(error => { if (error instanceof WalletOperationError && error.code === 'conflict') return callback(null); throw error; });
      },
    } });
    try {
      const store = new BrowserOperationStore({ getItem: () => null, setItem() {} });
      let release!: () => void; const order: number[] = [];
      const first = store.runExclusive('account', () => new Promise<void>(resolve => { release = resolve; }));
      const second = store.runExclusive('account', async () => { order.push(2); }, { wait: true });
      const third = store.runExclusive('account', async () => { order.push(3); }, { wait: true });
      await expect(store.runExclusive('account', async () => { order.push(4); })).rejects.toMatchObject({ code: 'conflict' });
      expect(order).toEqual([]);
      release(); await Promise.all([first, second, third]);
      expect(order).toEqual([2, 3]);
      expect(requests).toEqual([{ mode: 'exclusive', ifAvailable: true }, { mode: 'exclusive' }, { mode: 'exclusive' }, { mode: 'exclusive', ifAvailable: true }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('reads a records-only legacy document and preserves both journals across later writes', async () => {
    const legacy = fixture(); const prepared = await legacy.prepare();
    let raw = canonicalJson({ version: 1, records: { [JSON.stringify([prepared.operation.id, prepared.step.id])]: prepared } });
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
    const locks = new MemoryOperationStore();
    const store = new BrowserOperationStore(storage, { key: 'attempt-test', locks });
    expect(store.list()).toEqual([prepared]); expect(store.getAttempt('attempt-one')).toBeUndefined();
    const f = fixture(store); const fresh = { ...f.operation, id: 'other-attempt' };
    await expect(f.controller.withOperationAttempt(fresh, async () => { throw new Error('Preflight failed'); })).rejects.toThrow('Preflight failed');
    const saved = store.getAttempt(fresh.id)!; store.put(prepared);
    const reloaded = new BrowserOperationStore(storage, { key: 'attempt-test', locks });
    expect(reloaded.getAttempt(fresh.id)).toEqual(saved); expect(reloaded.list()).toEqual([prepared]);
    const document = JSON.parse(raw) as { version: number; records: object; attempts: object };
    expect(document.version).toBe(1); expect(Object.keys(document.attempts)).toEqual([fresh.id]);
  });

  it('uses a separate operation mutex across independent store instances without deadlocking journal writes', async () => {
    let raw: string | null = null;
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
    const locks = new MemoryOperationStore();
    const options = { key: 'same-journal', lockKey: 'shared-wallet-lock', locks };
    const f = fixture(new BrowserOperationStore(storage, options));
    const other = fixture(new BrowserOperationStore(storage, options));
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = f.controller.withOperationAttempt(f.operation, async () => {
      await f.controller.beforeNativeAttempt(f.operation.id, f.step); await f.prepare(); entered();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await started;
    await expect(other.controller.withOperationAttempt(f.operation, async () => 'must not run')).rejects.toMatchObject({ code: 'conflict' });
    release(); await pending;
    expect(other.controller.getAttempt(f.operation.id)?.state).toBe('native-started');
    expect(other.controller.getStep(f.operation.id, f.step.id)?.step.inputHash).toBe(hashCanonical(batch));
  });

  it('round-trips attempts through the production single-key file adapter without a signer or network', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'partfolk-attempt-')); const path = join(directory, 'operations.json');
    try {
      const store = new BrowserOperationStore(createFileStorage(path), { key: 'proof-test', locks: new MemoryOperationStore() });
      const f = fixture(store);
      await expect(f.controller.withOperationAttempt(f.operation, async () => { throw new Error('Read unavailable'); })).rejects.toThrow('Read unavailable');
      const reloaded = new BrowserOperationStore(createFileStorage(path), { key: 'proof-test', locks: new MemoryOperationStore() });
      expect(inspectReconciliationJournal(f.operation, undefined, () => undefined, reloaded.getAttempt(f.operation.id)))
        .toEqual({ complete: true, notSentEvidence: 'preflight-journal' });
      expect(reloaded.list()).toEqual([]);
    } finally { unlinkSync(path); rmdirSync(directory); }
  });
});
