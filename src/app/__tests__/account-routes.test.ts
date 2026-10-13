import { describe, expect, it } from 'vitest';
import { parseRoute, routeBehindSignIn, routeFromLocation, routeHref, routePath, safeReturnPath } from '../routes';
import { createSessionStore } from '../session';
import type { StoragePort } from '../storage';

const publicRoot = `0x${'ab'.repeat(32)}` as const;
const eventPath = `/events/${publicRoot}`;
const contribution = { name: 'contributions', projectRoot: publicRoot, returnTo: eventPath } as const;

function memoryStorage(): StoragePort {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

describe('service entry routes and safe continuation without rendering', () => {
  it('keeps an event publisher and its exact Guests destination behind sign-in', () => {
    const guests = { name: 'project', projectRoot: publicRoot, tab: 'guests' } as const;
    expect(parseRoute(routeHref(guests))).toEqual(guests);
    expect(routeBehindSignIn(parseRoute(routeHref({ name: 'sign-in', returnTo: routePath(guests) })))).toEqual(guests);
    expect(routeBehindSignIn({ name: 'sign-in' })).toEqual({ name: 'home' });
    expect(routePath({ name: 'not-found', path: '/missing' })).toBe('/404');
  });
  it('lets the current URL choose landing or a deep link regardless of the saved last destination', () => {
    const storage = memoryStorage(); const session = createSessionStore({ storage });
    session.navigate({ name: 'events' }); session.selectDraft('keep-this-draft');
    const restored = createSessionStore({ storage });
    expect(restored.getSnapshot().destination).toBe('/events');
    restored.navigate(routeFromLocation({ pathname: '/', hash: '' }));
    expect(restored.currentRoute()).toEqual({ name: 'home' });
    expect(restored.getSnapshot().activeDraftId).toBe('keep-this-draft');
    expect(routeFromLocation({ pathname: '/', hash: `#${eventPath}` })).toEqual({ name: 'event', projectRoot: publicRoot });
    expect(routeFromLocation({ pathname: eventPath, hash: '', search: '' })).toEqual({ name: 'event', projectRoot: publicRoot });
    expect(routeFromLocation({ pathname: '/unknown-page', hash: '' })).toEqual({ name: 'not-found', path: '/unknown-page' });
  });
  it('preserves a selected event and contribution target through account setup and a restored session', () => {
    const storage = memoryStorage();
    const session = createSessionStore({ storage });
    session.selectDraft('contribution-in-progress');
    session.navigate(contribution);
    const intendedDestination = session.getSnapshot().destination;

    for (const name of ['sign-in', 'onboarding', 'account'] as const) {
      const route = { name, returnTo: intendedDestination };
      expect(parseRoute(routeHref(route))).toEqual(route);
      session.navigate(route);
      const restored = createSessionStore({ storage });
      expect(restored.currentRoute()).toEqual(route);
      expect(restored.getSnapshot()).toMatchObject({ activeDraftId: 'contribution-in-progress', actor: null, chainId: null });
    }

    const restored = createSessionStore({ storage });
    restored.navigate(parseRoute(intendedDestination));
    expect(restored.currentRoute()).toEqual(contribution);
    expect(restored.getSnapshot().activeDraftId).toBe('contribution-in-progress');
  });

  it('exposes the public event catalog and only permits public keys in an event detail route', () => {
    expect(parseRoute('#/events')).toEqual({ name: 'events' });
    expect(parseRoute('#/my-events')).toEqual({ name: 'my-events' });
    const event = { name: 'event', projectRoot: publicRoot } as const;
    expect(routePath(event)).toBe(eventPath);
    expect(parseRoute(routeHref(event))).toEqual(event);
    for (const root of ['local:practice', `0x${'ab'.repeat(20)}`, '0x123', '%E0%A4%A', '../workspace']) {
      expect(parseRoute(`/events/${root}`)).toMatchObject({ name: 'not-found' });
    }
  });

  it('accepts canonical work destinations, including a contribution target and its event return', () => {
    for (const path of ['/', '/demo', '/workspace', '/projects/new', '/requests', '/events', '/my-events', eventPath]) {
      expect(safeReturnPath(path)).toBe(path);
    }
    expect(safeReturnPath('/projects/local%3Aunfinished')).toBe('/projects/local%3Aunfinished/needs');
    expect(safeReturnPath(routePath(contribution))).toBe(routePath(contribution));
    const localContribution = { name: 'contributions', projectRoot: 'local:unfinished' } as const;
    expect(parseRoute(routeHref(localContribution))).toEqual(localContribution);
  });

  it('rejects external, malformed, unknown and recursive account return destinations', () => {
    for (const path of [
      null, undefined, '', 'https://example.org/workspace', '//example.org', '\\example.org', '#/workspace',
      '/workspace#fragment', '/workspace\n', '/\\example.org', '/not-a-route', '/projects/0x123',
      '/events/local:practice', '/projects/%E0%A4%A', '/help', '/help?returnTo=%2Fworkspace',
      '/sign-in', '/sign-in?returnTo=%2Fworkspace', '/account', '/onboarding', `/workspace${'x'.repeat(1024)}`,
    ]) {
      expect(safeReturnPath(path), String(path)).toBeUndefined();
    }
    for (const name of ['sign-in', 'onboarding', 'account'] as const) {
      expect(parseRoute(`/${name}?returnTo=${encodeURIComponent('https://example.org')}`)).toEqual({ name });
      expect(routePath({ name, returnTo: '/sign-in?returnTo=%2Fworkspace' })).toBe(`/${name}`);
    }
  });

  it('drops invalid contribution targets without turning them into project identities', () => {
    for (const target of ['https://example.org', 'local:../../wallet', '0x123', `0x${'ab'.repeat(20)}`]) {
      expect(parseRoute(`/contributions?projectRoot=${encodeURIComponent(target)}`)).toEqual({ name: 'contributions' });
    }
    expect(parseRoute('/contributions?returnTo=%2Faccount')).toEqual({ name: 'contributions' });
  });
});
