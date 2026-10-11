import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { createAppRuntime } from '../../../app/context';
import { validRepositoryActionRecord } from '../../../app/actions';
import { routePath } from '../../../app/routes';
import type { StoragePort } from '../../../app/storage';
import { createOperationIntent } from '../../../data/operations';
import { TIRAMISU_CHAIN_ID, type Actor, type JsonValue } from '../../../domain/types';
import { actorScope, isContributionDraft, type ContributionDraft } from '../model';
import { contributionDrafts, visitorDraftFingerprint } from '../drafts';

const wallet: Actor = { kind: 'wallet', address: `0x${'11'.repeat(20)}` }, other: Actor = { kind: 'wallet', address: `0x${'22'.repeat(20)}` };
const project = `0x${'33'.repeat(32)}` as const;
const destination = routePath({ name: 'contributions', projectRoot: project, returnTo: `/projects/${project}/agreement` });
const entered: ContributionDraft = { name: 'Guest maker', description: 'My own equipment', publisherKind: 'organization',
  resources: [{ id: 'kit', name: 'Display kit', kind: 'equipment', capacity: 1, unit: 'kit', availability: [], capabilities: ['display'] }],
  offers: [{ id: 'offer', title: 'Loan display kit', resourceId: 'kit', kind: 'equipment', quantity: 1, unit: 'kit', availability: [], capabilities: ['display'], conditions: [], projectScope: [project], instructions: 'Bring it back' }],
  editorNumbers: { 'resource:kit:capacity': 'half typed' }, editorWindows: { 'offer:offer': [{ id: 'first', start: 'unfinished', end: '', timeZone: 'Europe/London' }] } };
function memory() {
  const values = new Map<string, string>(); let failing: string | null = null;
  const storage: StoragePort = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (failing && key.includes(failing)) throw new Error('Storage full'); values.set(key, value); }, removeItem: key => { values.delete(key); } };
  return { storage, values, fail: (value: string | null) => { failing = value; } };
}
function runtime(storage: StoragePort | null) {
  const value = createAppRuntime({ storage, namespace: 'handoff-test' }); value.session.setMode('public');
  value.session.navigate({ name: 'contributions', projectRoot: project, returnTo: `/projects/${project}/agreement` }); return value;
}
function setup(storage: StoragePort | null) {
  const app = runtime(storage), drafts = contributionDrafts(app);
  drafts.session(null, 'new').update(entered);
  return { app, drafts, fingerprint: visitorDraftFingerprint(drafts.getVisitorSnapshot().value!) };
}
const choose = (drafts: ReturnType<typeof contributionDrafts>, fingerprint: string, replaceExisting = false, replaceRecovery = false, pending = false) =>
  drafts.adoptVisitor({ fingerprint, replaceExisting, replaceRecovery, pending });

describe('guest contribution draft handoff', () => {
  it('returns to the original invitation with raw fields and opens a usable editor only after explicit choice', () => {
    const { storage } = memory(), { app, drafts, fingerprint } = setup(storage);
    app.session.navigate({ name: 'sign-in', returnTo: destination }); app.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
    app.session.navigate({ name: 'contributions', projectRoot: project, returnTo: `/projects/${project}/agreement` });
    expect(drafts.editorOpen(wallet)).toBe(true);
    expect(drafts.session(wallet, 'new').getSnapshot().exists).toBe(false);
    expect(drafts.getVisitorSnapshot().value?.destination).toBe(destination);
    expect(choose(drafts, fingerprint)).toEqual({ ok: true });
    expect(drafts.session(wallet, 'new').getSnapshot()).toMatchObject({ draft: entered, saved: true });
    expect(app.session.getSnapshot().destination).toBe(destination);
    expect(contributionDrafts(runtime(storage)).getVisitorSnapshot().value).toMatchObject({ phase: 'adopted', owner: wallet.address });
  });
  it('preserves cancellation and failed-storage fields through editor remounts without signing', () => {
    const { storage, fail } = memory(); fail('draft:'); const { app, drafts, fingerprint } = setup(storage);
    expect(drafts.session(null, 'new').getSnapshot()).toMatchObject({ draft: entered, saved: false });
    app.session.navigate({ name: 'sign-in', returnTo: destination }); app.session.navigate({ name: 'contributions', projectRoot: project, returnTo: `/projects/${project}/agreement` });
    expect(contributionDrafts(app).session(null, 'new').getSnapshot().draft).toEqual(entered);
    app.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
    expect(choose(drafts, fingerprint).ok).toBe(false);
    expect(drafts.getVisitorSnapshot().value?.draft).toEqual(entered);
    expect(drafts.exportVisitor()).toContain('half typed');
  });
  it('keeps an exportable guest handoff and invitation through sign-in when storage is null', () => {
    const { app, drafts, fingerprint } = setup(null);
    expect(drafts.session(null, 'new').getSnapshot()).toMatchObject({ draft: entered, saved: false });
    app.session.navigate({ name: 'sign-in', returnTo: destination }); app.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
    app.session.navigate({ name: 'contributions', projectRoot: project, returnTo: `/projects/${project}/agreement` });
    const remounted = contributionDrafts(app);
    expect(remounted.editorOpen(wallet)).toBe(true);
    expect(remounted.getVisitorSnapshot()).toMatchObject({ value: { draft: entered, destination, owner: null, phase: 'available' }, issue: { code: 'unavailable' } });
    expect(JSON.parse(remounted.exportVisitor()!).payload).toMatchObject({ draft: entered, destination });
    expect(choose(remounted, fingerprint).ok).toBe(false);
    expect(remounted.session(wallet, 'new').getSnapshot().exists).toBe(false);
    expect(remounted.getVisitorSnapshot().value?.draft).toEqual(entered);
  });
  it('keeps an exportable guest handoff when storage reads throw and never writes a reservation or wallet draft', () => {
    const written: string[] = [];
    const storage: StoragePort = { getItem: () => { throw new Error('Storage read denied'); }, setItem: key => { written.push(key); }, removeItem: () => undefined };
    const { app, drafts, fingerprint } = setup(storage);
    app.session.navigate({ name: 'sign-in', returnTo: destination }); app.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
    app.session.navigate({ name: 'contributions', projectRoot: project, returnTo: `/projects/${project}/agreement` });
    const remounted = contributionDrafts(app);
    expect(remounted.editorOpen(wallet)).toBe(true);
    expect(remounted.getVisitorSnapshot()).toMatchObject({ value: { draft: entered, destination, owner: null, phase: 'available' }, issue: { code: 'unavailable' } });
    expect(JSON.parse(remounted.exportVisitor()!).payload).toMatchObject({ draft: entered, destination });
    expect(choose(remounted, fingerprint).ok).toBe(false);
    expect(remounted.session(wallet, 'new').getSnapshot().exists).toBe(false);
    expect(remounted.getVisitorSnapshot().value?.draft).toEqual(entered);
    expect(written.filter(key => key.includes(':draft:'))).toEqual([]);
  });
  it('requires a concrete choice before replacing an existing or unreadable wallet draft', () => {
    const { storage, values } = memory(), { app, drafts, fingerprint } = setup(storage);
    app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); const target = drafts.session(wallet, 'new');
    target.update({ ...entered, name: 'Existing wallet draft' });
    expect(choose(drafts, fingerprint).ok).toBe(false);
    expect(target.getSnapshot().draft.name).toBe('Existing wallet draft');
    expect(choose(drafts, fingerprint, true).ok).toBe(true);
    const second = setup(storage); second.app.session.setAccount(other, TIRAMISU_CHAIN_ID);
    const key = `handoff-test:draft:contribution:${actorScope(other)}:new`; values.set(key, 'unreadable original');
    expect(choose(second.drafts, second.fingerprint, true).ok).toBe(false);
    expect(values.get(key)).toBe('unreadable original');
    expect(choose(second.drafts, second.fingerprint, true, true).ok).toBe(true);
    expect(second.drafts.session(other, 'new').exportRecovery()).toBe('unreadable original');
  });
  it('never gives an adopted or reserved guest draft to another wallet', () => {
    const { storage } = memory(), { app, drafts, fingerprint } = setup(storage);
    app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); expect(choose(drafts, fingerprint).ok).toBe(true);
    app.session.setAccount(null); app.session.setAccount(other, TIRAMISU_CHAIN_ID);
    expect(drafts.editorOpen(other)).toBe(false); expect(choose(drafts, fingerprint).ok).toBe(false);
    expect(drafts.session(other, 'new').getSnapshot().exists).toBe(false);
    expect(drafts.session(wallet, 'new').getSnapshot().draft).toEqual(entered);
  });
  it('keeps a reserved guest snapshot after a destination save failure and permits retry only by that wallet', () => {
    const { storage, fail } = memory(), { app, drafts, fingerprint } = setup(storage);
    app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); fail(`contribution:${actorScope(wallet)}:new`);
    expect(choose(drafts, fingerprint).ok).toBe(false); expect(drafts.getVisitorSnapshot().value?.phase).toBe('reserved');
    const reopened = runtime(storage); reopened.session.setAccount(other, TIRAMISU_CHAIN_ID);
    expect(choose(contributionDrafts(reopened), fingerprint).ok).toBe(false);
    expect(drafts.getVisitorSnapshot().value?.draft).toEqual(entered);
    fail(null); expect(choose(drafts, fingerprint, true).ok).toBe(true);
  });
  it('does not move a guest draft into another project or wrong network', () => {
    const { storage } = memory(), { app, drafts, fingerprint } = setup(storage);
    app.session.setAccount(wallet, 1); expect(choose(drafts, fingerprint).ok).toBe(false);
    app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); app.session.navigate({ name: 'contributions' });
    expect(choose(drafts, fingerprint)).toMatchObject({ ok: false, message: expect.stringContaining('original invitation') });
    expect(drafts.session(wallet, 'new').getSnapshot().exists).toBe(false);
  });
  it('leaves pending operation envelopes intact and also detects a durable pending request unseen by the current UI', () => {
    const { storage, values } = memory(), { app, drafts, fingerprint } = setup(storage);
    app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); expect(choose(drafts, fingerprint, false, false, true).ok).toBe(false);
    const fields = { name: 'Already requested', description: '', kind: 'individual' as const, lifetimeSeconds: 3600 };
    const operation = createOperationIntent('register_publisher', { mode: 'public', chainId: TIRAMISU_CHAIN_ID, actor: wallet }, fields);
    const key = `action:${keccak256(toBytes(`register-contribution:wallet:${wallet.address}`)).slice(2)}`;
    app.drafts(key, 'repository-action', validRepositoryActionRecord).save({ status: 'needs-verification', command: { ...fields, operation } as unknown as JsonValue, operation });
    const before = values.get(`handoff-test:draft:${key}`);
    expect(choose(drafts, fingerprint).ok).toBe(false); expect(values.get(`handoff-test:draft:${key}`)).toBe(before);
    expect(drafts.getVisitorSnapshot().value?.phase).toBe('available');
  });
  it('blocks stale second-runtime adoption after the first wallet reserved or adopted the guest draft', () => {
    const { storage } = memory(), first = setup(storage), second = runtime(storage), stale = contributionDrafts(second);
    second.session.setAccount(other, TIRAMISU_CHAIN_ID); stale.session(other, 'new');
    first.app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); expect(choose(first.drafts, first.fingerprint).ok).toBe(true);
    expect(choose(stale, first.fingerprint)).toMatchObject({ ok: false, message: expect.stringContaining('another window') });
    expect(stale.session(other, 'new').getSnapshot().exists).toBe(false);
  });
  it('does not overwrite a wallet draft newly saved by a second runtime', () => {
    const { storage } = memory(), first = setup(storage); first.app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); first.drafts.session(wallet, 'new');
    const second = runtime(storage); second.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
    contributionDrafts(second).session(wallet, 'new').update({ ...entered, name: 'Saved in another window' });
    expect(choose(first.drafts, first.fingerprint, true)).toMatchObject({ ok: false, message: expect.stringContaining('another window') });
    expect(contributionDrafts(runtime(storage)).session(wallet, 'new').getSnapshot().draft.name).toBe('Saved in another window');
  });
  it('does not let a stale guest editor undo another tab’s adopted ownership', () => {
    const { storage } = memory(), first = setup(storage), second = runtime(storage), stale = contributionDrafts(second);
    const guest = stale.session(null, 'new');
    first.app.session.setAccount(wallet, TIRAMISU_CHAIN_ID); expect(choose(first.drafts, first.fingerprint).ok).toBe(true);
    expect(guest.update({ ...entered, name: 'A late guest edit' })).toBe(false);
    expect(guest.getSnapshot()).toMatchObject({ saved: false, draft: { name: 'A late guest edit' } });
    expect(contributionDrafts(runtime(storage)).getVisitorSnapshot().value).toMatchObject({ owner: wallet.address, phase: 'adopted' });
  });
  it('recovers legacy visitor:new data with an explicit destination choice and never rekeys an owned wallet draft', () => {
    const { storage } = memory(), app = runtime(storage);
    app.drafts('contribution:visitor:new', 'contribution', isContributionDraft).save(entered);
    const drafts = contributionDrafts(app), visitor = drafts.getVisitorSnapshot().value!;
    expect(visitor.destination).toBeNull(); app.session.setAccount(wallet, TIRAMISU_CHAIN_ID);
    expect(choose(drafts, visitorDraftFingerprint(visitor)).ok).toBe(true);
    app.session.setAccount(other, TIRAMISU_CHAIN_ID);
    expect(drafts.session(other, 'new').getSnapshot().exists).toBe(false);
    expect(drafts.session(wallet, 'new').update({ ...entered, name: 'Late old account event' })).toBe(false);
  });
});
