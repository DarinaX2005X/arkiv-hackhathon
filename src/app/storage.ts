export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export type Validator<T> = (value: unknown) => value is T;
export type StorageIssueCode = 'unavailable' | 'invalid_json' | 'unsupported_version' | 'invalid_payload' | 'too_large' | 'write_failed' | 'recovery_required';
export interface StorageIssue { code: StorageIssueCode; recoverableText: string | null }
export type LoadResult<T> =
  | { status: 'missing' }
  | { status: 'ready'; value: T; updatedAt: number }
  | { status: 'recovery'; issue: StorageIssue }
  | { status: 'unavailable'; issue: StorageIssue };
export interface SaveResult<T> { value: T; persisted: boolean; issue: StorageIssue | null }
interface Envelope<T> { format: 'partfolk-draft'; version: 1; kind: string; updatedAt: number; payload: T }
const MAX_BYTES = 1024 * 1024;
const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(item => safeJson(item, depth + 1));
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([key, item]) => !['__proto__', 'prototype', 'constructor'].includes(key) && safeJson(item, depth + 1));
}
export function decodeDraft<T>(raw: string, kind: string, validate: Validator<T>): LoadResult<T> {
  const fail = (code: StorageIssueCode): LoadResult<T> => ({ status: 'recovery', issue: { code, recoverableText: raw } });
  if (utf8Size(raw) > MAX_BYTES) return fail('too_large');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return fail('invalid_json'); }
  if (!isRecord(data) || data.format !== 'partfolk-draft') return fail('invalid_payload');
  if (data.version !== 1) return fail('unsupported_version');
  if (Object.keys(data).sort().join(',') !== 'format,kind,payload,updatedAt,version'
    || data.kind !== kind || typeof data.updatedAt !== 'number' || !Number.isSafeInteger(data.updatedAt)
    || data.updatedAt < 0 || !safeJson(data.payload) || !validate(data.payload)) return fail('invalid_payload');
  return { status: 'ready', value: data.payload, updatedAt: data.updatedAt };
}

/** Storage failure never discards in-memory work. Unsupported/corrupt data requires explicit recovery. */
export function createDraftStore<T>({ storage, key, kind, validate, now = Date.now }: {
  storage: StoragePort | null; key: string; kind: string; validate: Validator<T>; now?: () => number;
}) {
  let memory: T | undefined;
  let recovery: StorageIssue | null = null;
  let loaded = false;
  const encode = (value: T): string => {
    if (!safeJson(value) || !validate(value)) throw new TypeError('Draft does not match its schema.');
    const envelope: Envelope<T> = { format: 'partfolk-draft', version: 1, kind, updatedAt: now(), payload: value };
    const raw = JSON.stringify(envelope);
    if (utf8Size(raw) > MAX_BYTES) throw new RangeError('Draft exceeds the export size limit.');
    return raw;
  };
  const load = (): LoadResult<T> => {
    loaded = true;
    if (!storage) return { status: 'unavailable', issue: { code: 'unavailable', recoverableText: null } };
    let raw: string | null;
    try { raw = storage.getItem(key); }
    catch { return { status: 'unavailable', issue: { code: 'unavailable', recoverableText: null } }; }
    if (raw === null) return { status: 'missing' };
    const result = decodeDraft(raw, kind, validate);
    if (result.status === 'ready') memory = result.value;
    if (result.status === 'recovery') recovery = result.issue;
    return result;
  };
  const save = (value: T, options?: { replaceRecovery: boolean }): SaveResult<T> => {
    let raw: string;
    try { raw = encode(value); }
    catch (error) { return { value, persisted: false, issue: { code: error instanceof RangeError ? 'too_large' : 'invalid_payload', recoverableText: null } }; }
    if (!loaded) load();
    memory = structuredClone(value);
    if (recovery && !options?.replaceRecovery) return { value: memory, persisted: false, issue: { code: 'recovery_required', recoverableText: recovery.recoverableText } };
    if (!storage) return { value: memory, persisted: false, issue: { code: 'unavailable', recoverableText: null } };
    try { storage.setItem(key, raw); recovery = null; return { value: memory, persisted: true, issue: null }; }
    catch { return { value: memory, persisted: false, issue: { code: 'write_failed', recoverableText: raw } }; }
  };
  return {
    load, save,
    peek: (): T | undefined => memory === undefined ? undefined : structuredClone(memory),
    export: (value?: T): string => { const selected = value ?? memory; if (selected === undefined) throw new Error('No draft is available to export.'); return encode(selected); },
    exportRecovery: (): string | null => recovery?.recoverableText ?? null,
    inspectImport: (raw: string): LoadResult<T> => decodeDraft(raw, kind, validate),
    import: (raw: string, options?: { replaceRecovery: boolean }): LoadResult<T> | SaveResult<T> => {
      const result = decodeDraft(raw, kind, validate);
      return result.status === 'ready' ? save(result.value, options) : result;
    },
  };
}
