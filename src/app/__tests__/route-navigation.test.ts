import { describe, expect, it } from 'vitest';
import { parseRoute, type Route } from '../routes';
import { routeNavigation } from '../route-navigation';

const catalog: Route = { name: 'events' };
const event = parseRoute(`/events/0x${'a'.repeat(64)}`);

describe('page navigation and native history', () => {
  it('starts a newly opened event at the top and moves focus to the page', () => {
    const catalogState = routeNavigation(undefined, catalog, null).historyState;
    expect(routeNavigation(catalog, event, catalogState)).toMatchObject({ scrollToStart: true, focusMain: true });
  });

  it('preserves native Back and Forward restoration on visited entries', () => {
    const catalogState = routeNavigation(undefined, catalog, { unrelated: 'kept' }).historyState;
    const eventState = routeNavigation(catalog, event, null).historyState;
    expect(catalogState).toMatchObject({ unrelated: 'kept' });
    expect(routeNavigation(event, catalog, catalogState)).toMatchObject({ scrollToStart: false, focusMain: true });
    expect(routeNavigation(catalog, event, eventState)).toMatchObject({ scrollToStart: false, focusMain: true });
    // A fresh link back to the same catalogue is a new page visit.
    expect(routeNavigation(event, catalog, eventState).scrollToStart).toBe(true);
  });

  it('keeps in-page filters, first load and a sign-in overlay in place', () => {
    const initial = routeNavigation(undefined, catalog, null);
    expect(initial).toMatchObject({ scrollToStart: false, focusMain: false });
    expect(routeNavigation(catalog, catalog, initial.historyState)).toMatchObject({ scrollToStart: false, focusMain: false });
    const signIn = parseRoute('/sign-in?returnTo=%2Fevents');
    expect(routeNavigation(catalog, signIn, initial.historyState)).toMatchObject({ scrollToStart: false, focusMain: false });
    expect(routeNavigation(signIn, catalog, null)).toMatchObject({ scrollToStart: false, focusMain: false });
  });
});
