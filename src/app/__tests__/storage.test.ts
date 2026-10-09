import { describe, expect, it } from 'vitest';
import { createDraftStore, decodeDraft, type StoragePort } from '../storage';

interface Draft { title: string; quantity: number }
const validate = (value: unknown): value is Draft => value !== null && typeof value === 'object'
  && Object.keys(value).sort().join(',') === 'quantity,title'
  && typeof (value as Draft).title === 'string' && Number.isSafeInteger((value as Draft).quantity);
const makeStorage = (): StoragePort & { records: Map<string, string> } => {
  const records = new Map<string, string>();
  return { records, getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); }, removeItem: key => { records.delete(key); } };
};
const setup = (storage: StoragePort | null) => createDraftStore({ storage, key: 'draft:1', kind: 'project', validate, now: () => 1791500000000 });

describe('strict draft retention and recovery', () => {
  it('exports validated work and restores it in a separate store instance', () => {
    const storage = makeStorage();
    const first = setup(storage);
    const draft = { title: 'An exhibition — Ё', quantity: 6 };
    expect(first.save(draft).persisted).toBe(true);
    expect(setup(storage).load()).toEqual({ status: 'ready', value: draft, updatedAt: 1791500000000 });
    const restored = setup(makeStorage());
    expect(restored.import(first.export())).toEqual({ value: draft, persisted: true, issue: null });
  });

  it('keeps a future format unchanged and retains new work in memory until explicit recovery', () => {
    const storage = makeStorage();
    const raw = '{"format":"partfolk-draft","version":99,"kind":"project","updatedAt":1,"payload":{"title":"Future","quantity":6}}';
    storage.records.set('draft:1', raw);
    const store = setup(storage);
    expect(store.load()).toMatchObject({ status: 'recovery', issue: { code: 'unsupported_version' } });
    const draft = { title: 'New work', quantity: 2 };
    expect(store.save(draft)).toMatchObject({ persisted: false, issue: { code: 'recovery_required' } });
    expect(store.peek()).toEqual(draft);
    expect(store.exportRecovery()).toBe(raw);
    expect(storage.records.get('draft:1')).toBe(raw);
    expect(store.import(store.export(), { replaceRecovery: true })).toMatchObject({ persisted: true });
    expect(setup(storage).load()).toMatchObject({ status: 'ready', value: draft });
  });

  it('keeps in-memory work after quota errors, including before any previous save', () => {
    const storage = makeStorage();
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    const store = setup(storage);
    const draft = { title: 'Retain this', quantity: 3 };
    expect(store.save(draft)).toMatchObject({ persisted: false, issue: { code: 'write_failed' } });
    draft.title = 'Mutated elsewhere';
    expect(store.peek()?.title).toBe('Retain this');
    expect(decodeDraft(store.export(), 'project', validate)).toMatchObject({ status: 'ready', value: { title: 'Retain this' } });
  });

  it('does not report success when storage cannot be accessed', () => {
    const store = setup(null);
    expect(store.load()).toMatchObject({ status: 'unavailable' });
    expect(store.save({ title: 'In memory', quantity: 1 })).toMatchObject({ persisted: false, issue: { code: 'unavailable' } });
    expect(store.peek()?.title).toBe('In memory');
  });

  it('rejects corrupt imports, extra envelope fields and noninteger data without replacing work', () => {
    const store = setup(makeStorage());
    const draft = { title: 'Keep', quantity: 6 };
    store.save(draft);
    for (const raw of ['{', store.export().replace('"version":1', '"version":1,"extra":true'), store.export().replace('"quantity":6', '"quantity":1.5')]) {
      expect(store.import(raw)).toMatchObject({ status: 'recovery' });
      expect(store.peek()).toEqual(draft);
    }
  });

  it('refuses oversized UTF-8 input and preserves original corrupt data for export', () => {
    const storage = makeStorage();
    storage.records.set('draft:1', '{broken');
    const store = setup(storage);
    store.load();
    expect(store.exportRecovery()).toBe('{broken');
    expect(store.inspectImport('Ж'.repeat(524289))).toMatchObject({ status: 'recovery', issue: { code: 'too_large' } });
  });
});
