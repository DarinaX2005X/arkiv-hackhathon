import { describe, expect, it } from 'vitest';
import { createSessionStore } from '../session';
import { createAppRuntime } from '../context';
import { isAccountAddress, isEntityKey, isLocalActorId, isLocalEntityKey, isPublicEntityKey, requirePublicEntityKey } from '../ids';
import { parseRoute, projectInvitation, routeHref } from '../routes';
import type { StoragePort } from '../storage';

const publicKey = `0x${'a1'.repeat(32)}` as const;
function storage(): StoragePort {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

describe('identity and independent app sessions', () => {
  it('never admits local identities or account addresses as public entity keys', () => {
    expect(isPublicEntityKey(publicKey)).toBe(true);
    expect(isLocalEntityKey('local:sample-1')).toBe(true);
    expect(isLocalActorId('local-actor:oak')).toBe(true);
    for (const value of ['local:sample-1', 'local-actor:oak', `0x${'a1'.repeat(20)}`, '0xabc', 'https://example.com']) {
      expect(isPublicEntityKey(value)).toBe(false);
      expect(() => requirePublicEntityKey(value)).toThrow();
    }
    expect(isAccountAddress(publicKey)).toBe(false);
    expect(isEntityKey('local:../../wallet')).toBe(false);
  });

  it('preserves destination and draft through mode/account changes but never restores signing authority', () => {
    const persistent = storage();
    const session = createSessionStore({ storage: persistent });
    session.selectDraft('draft-42');
    session.navigate({ name: 'project', projectRoot: publicKey, tab: 'agreement' });
    session.setMode('public');
    session.setAccount({ kind: 'wallet', address: `0x${'12'.repeat(20)}` }, 7738577);
    session.setAccount(null);
    expect(session.getSnapshot()).toMatchObject({ destination: `/projects/${publicKey}/agreement`, activeDraftId: 'draft-42', actor: null });
    session.setAccount({ kind: 'wallet', address: `0x${'34'.repeat(20)}` }, 7738577);
    expect(createSessionStore({ storage: persistent }).getSnapshot()).toMatchObject({ activeDraftId: 'draft-42', actor: null, chainId: null });
    expect(() => session.setAccount({ kind: 'local', id: 'local-actor:oak' })).toThrow();
  });

  it('separates Studio and Desk runtime state without changing their shared storage', () => {
    const persistent = storage();
    const studio = createAppRuntime({ storage: persistent, namespace: 'studio' });
    const desk = createAppRuntime({ storage: persistent, namespace: 'desk' });
    studio.session.selectDraft('studio-draft');
    studio.session.navigate({ name: 'new-project' });
    expect(desk.session.getSnapshot().activeDraftId).toBeNull();
    expect(desk.session.getSnapshot().destination).toBe('/');
    expect(createAppRuntime({ storage: persistent, namespace: 'studio' }).session.getSnapshot().activeDraftId).toBe('studio-draft');
  });

  it('round-trips valid hash routes and rejects malformed public invitation input', () => {
    const route = { name: 'project', projectRoot: publicKey, tab: 'runbook' } as const;
    expect(parseRoute(routeHref(route))).toEqual(route);
    expect(parseRoute('#/projects/local%3Atest/plans')).toMatchObject({ name: 'project', projectRoot: 'local:test' });
    expect(parseRoute('#/projects/%E0%A4%A')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/projects/0x123')).toMatchObject({ name: 'not-found' });
    expect(projectInvitation('https://example.org/partfolk/', publicKey)).toBe(`https://example.org/partfolk/#/projects/${publicKey}/needs`);
    // Runtime validation applies even to plain JS consumers bypassing TypeScript.
    expect(() => projectInvitation('https://example.org', 'local:sample' as typeof publicKey)).toThrow();
    expect(() => projectInvitation('javascript:alert(1)', publicKey)).toThrow();
  });
});
