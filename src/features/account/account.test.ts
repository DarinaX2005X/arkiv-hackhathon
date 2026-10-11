import { describe, expect, it } from 'vitest';
import { createAppRuntime } from '../../app/context';
import { routePath } from '../../app/routes';
import type { StoragePort } from '../../app/storage';
import {
  accountReturnRoute, createAccountPreferences, defaultAccountPreferences,
  readAccountPreferences, workDestination, type AccountPreferences,
} from './account';

const walletA = `0x${'ab'.repeat(20)}`;
const walletB = `0x${'cd'.repeat(20)}`;
const now = 1791700000000;
const preferences: AccountPreferences = { label: 'My workshop', defaultDestination: 'contributions', setupComplete: true };
function memoryStorage() {
  const values = new Map<string, string>();
  const storage: StoragePort = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  return { storage, values };
}
const runtimeFor = (storage: StoragePort | null) => createAppRuntime({ storage, namespace: 'account-test', now: () => now });

describe('device account preferences without rendering or wallet authority', () => {
  it('starts with unsaved defaults without creating a profile or work merely by reading', () => {
    const { storage, values } = memoryStorage();
    const store = createAccountPreferences(runtimeFor(storage), walletA);
    expect(store.load()).toEqual({ status: 'missing' });
    const first = readAccountPreferences(store.load());
    expect(first).toEqual({ value: defaultAccountPreferences, issue: null });
    first.value.label = 'Unsaved input';
    expect(readAccountPreferences(store.load()).value.label).toBe('');
    expect(defaultAccountPreferences.label).toBe('');
    expect(values.size).toBe(0);
  });

  it('restores each wallet profile independently and treats address letter case as the same account', () => {
    const { storage } = memoryStorage();
    const first = runtimeFor(storage);
    expect(createAccountPreferences(first, walletA).save(preferences)).toMatchObject({ persisted: true, issue: null });
    const other: AccountPreferences = { label: 'Another account', defaultDestination: 'my-events', setupComplete: false };
    expect(createAccountPreferences(first, walletB).save(other).persisted).toBe(true);
    const restored = runtimeFor(storage);
    expect(createAccountPreferences(restored, `0x${walletA.slice(2).toUpperCase()}`).load()).toEqual({ status: 'ready', value: preferences, updatedAt: now });
    expect(createAccountPreferences(restored, walletB).load()).toEqual({ status: 'ready', value: other, updatedAt: now });
    expect(restored.session.getSnapshot()).toMatchObject({ actor: null, chainId: null, activeDraftId: null });
  });

  it('never turns a completed local profile into live authority or navigates away from unfinished work', () => {
    const { storage } = memoryStorage();
    const runtime = runtimeFor(storage);
    runtime.session.setMode('public');
    runtime.session.navigate({ name: 'new-project' });
    runtime.session.selectDraft('unfinished-project');
    const before = runtime.session.getSnapshot();
    const account = createAccountPreferences(runtime, walletA);
    expect(account.save(preferences).persisted).toBe(true);
    expect(runtime.session.getSnapshot()).toEqual(before);
    expect(account.load()).toMatchObject({ status: 'ready', value: preferences });
    const restored = runtimeFor(storage);
    expect(restored.session.getSnapshot()).toMatchObject({ actor: null, chainId: null, destination: '/projects/new', activeDraftId: 'unfinished-project' });
  });

  it.each(['0x123', `0x${'ab'.repeat(32)}`, 'local-actor:me', 'https://example.org', ''])('rejects a non-wallet preference identity: %s', address => {
    const { storage, values } = memoryStorage();
    expect(() => createAccountPreferences(runtimeFor(storage), address)).toThrow(TypeError);
    expect(values.size).toBe(0);
  });

  it('rejects malformed preferences without replacing the previously saved profile', () => {
    const { storage } = memoryStorage();
    const store = createAccountPreferences(runtimeFor(storage), walletA);
    expect(store.save(preferences).persisted).toBe(true);
    const invalid: unknown[] = [
      { ...preferences, label: 'x'.repeat(81) },
      { ...preferences, label: 'hidden\u0000value' },
      { ...preferences, label: 'two\nlines' },
      { ...preferences, defaultDestination: 'https://example.org' },
      { ...preferences, defaultDestination: ['workspace'] },
      { ...preferences, setupComplete: 'true' },
      { ...preferences, actor: { kind: 'wallet', address: walletA } },
    ];
    for (const value of invalid) {
      expect(store.save(value as AccountPreferences)).toMatchObject({ persisted: false, issue: { code: 'invalid_payload' } });
      expect(store.peek()).toEqual(preferences);
      expect(store.load()).toMatchObject({ status: 'ready', value: preferences });
    }
    expect(store.save({ ...preferences, label: 'x'.repeat(80) }).persisted).toBe(true);
  });

  it.each(['future', 'corrupt'] as const)('preserves %s preference bytes for recovery and refuses an implicit overwrite', kind => {
    const { storage, values } = memoryStorage();
    const runtime = runtimeFor(storage);
    const store = createAccountPreferences(runtime, walletA);
    store.save(preferences);
    const [key, current] = [...values.entries()][0]!;
    const raw = kind === 'future' ? current.replace('"version":1', '"version":99') : '{broken';
    storage.setItem(key, raw);
    const restored = createAccountPreferences(runtimeFor(storage), walletA);
    const loaded = restored.load();
    expect(loaded).toMatchObject({ status: 'recovery', issue: { code: kind === 'future' ? 'unsupported_version' : 'invalid_json' } });
    expect(readAccountPreferences(loaded)).toMatchObject({ value: defaultAccountPreferences, issue: { recoverableText: raw } });
    expect(restored.save({ ...preferences, label: 'Retain new input' })).toMatchObject({ persisted: false, issue: { code: 'recovery_required' } });
    expect(restored.peek()?.label).toBe('Retain new input');
    expect(restored.exportRecovery()).toBe(raw);
    expect(values.get(key)).toBe(raw);
  });

  it('reports unavailable storage and quota failure honestly while retaining editable preferences in memory', () => {
    const missing = createAccountPreferences(runtimeFor(null), walletA);
    expect(readAccountPreferences(missing.load())).toMatchObject({ value: defaultAccountPreferences, issue: { code: 'unavailable' } });
    expect(missing.save(preferences)).toMatchObject({ persisted: false, issue: { code: 'unavailable' } });
    expect(missing.peek()).toEqual(preferences);

    const { storage } = memoryStorage();
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    const failed = createAccountPreferences(runtimeFor(storage), walletA);
    expect(failed.save(preferences)).toMatchObject({ persisted: false, issue: { code: 'write_failed' } });
    expect(failed.peek()).toEqual(preferences);
    expect(failed.inspectImport(failed.export())).toMatchObject({ status: 'ready', value: preferences });
  });

  it('gives the selected work destination priority over preferences and rejects unsafe account continuations', () => {
    const publicRoot = `0x${'ef'.repeat(32)}` as const;
    const contribution = { name: 'contributions', projectRoot: publicRoot, returnTo: `/events/${publicRoot}` } as const;
    const intended = routePath(contribution);
    expect(accountReturnRoute(intended, preferences)).toEqual(contribution);
    expect(workDestination(contribution)).toBe(intended);
    for (const unsafe of [undefined, 'https://example.org', '/onboarding', '/help', '/account?returnTo=%2Fworkspace']) {
      expect(accountReturnRoute(unsafe, preferences)).toEqual({ name: 'contributions' });
    }
    expect(accountReturnRoute(undefined, { ...preferences, defaultDestination: 'my-events' })).toEqual({ name: 'my-events' });
    expect(workDestination({ name: 'account', returnTo: intended })).toBe(intended);
    expect(workDestination({ name: 'help', topic: 'publishing', returnTo: intended })).toBe(intended);
    expect(workDestination({ name: 'account' })).toBeUndefined();
  });
});
