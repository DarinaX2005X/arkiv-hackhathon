import { routeBehindSignIn, routePath, type Route } from './routes';

const stateKey = 'partfolkRouteDestination';

/** A visited history entry keeps native Back/Forward scroll restoration. */
export function routeNavigation(previous: Route | undefined, next: Route, historyState: unknown) {
  const destination = routePath(next);
  const saved = historyState && typeof historyState === 'object' && !Array.isArray(historyState)
    ? historyState as Record<string, unknown> : {};
  const visited = saved[stateKey] === destination;
  const changedPage = previous !== undefined
    && routePath(routeBehindSignIn(previous)) !== routePath(routeBehindSignIn(next));
  return {
    scrollToStart: changedPage && !visited,
    focusMain: changedPage && next.name !== 'sign-in',
    historyState: visited ? null : { ...saved, [stateKey]: destination },
  };
}
