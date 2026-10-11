import { parseRoute, routeHref, routePath, safeReturnPath, type Route } from '../../app/routes';
import { helpCopy, helpTopics, type HelpTopicId } from './catalog';

export function isHelpTopic(value: unknown): value is HelpTopicId {
  return typeof value === 'string' && helpTopics.some(topic => topic.id === value);
}

/** Return targets use the app's route validator and cannot leave this app or recurse into Help. */
export function helpReturnRoute(destination?: string): Route {
  return parseRoute(safeReturnPath(destination) ?? '/workspace');
}

export function helpHref(topic?: HelpTopicId, returnTo?: Route): string {
  const workPath = returnTo?.name === 'not-found' ? undefined : returnTo && ['help', 'sign-in', 'account', 'onboarding'].includes(returnTo.name)
    ? 'returnTo' in returnTo ? safeReturnPath(returnTo.returnTo) : undefined
    : returnTo ? safeReturnPath(routePath(returnTo)) : undefined;
  return routeHref({ name: 'help', ...(topic ? { topic } : {}),
    ...(workPath ? { returnTo: workPath } : {}) });
}

/** A Help detour must not drop the project that invited this contribution. */
export function helpContributionRoute(context: Route): Route {
  if (context.name === 'contributions') return context;
  return context.name === 'project'
    ? { name: 'contributions', projectRoot: context.projectRoot, returnTo: routePath(context) }
    : { name: 'contributions' };
}

export function helpReturnLabel(route: Route): string {
  switch (route.name) {
    case 'home': return helpCopy.returnHome;
    case 'demo': return helpCopy.returnDemo;
    case 'new-project': return helpCopy.returnDraft;
    case 'project': return helpCopy.returnProject;
    case 'contributions': return helpCopy.returnContributions;
    case 'requests': return helpCopy.returnRequests;
    case 'events': return helpCopy.returnEvents;
    case 'event': return helpCopy.returnEvent;
    case 'my-events': return helpCopy.returnMyEvents;
    default: return helpCopy.returnWorkspace;
  }
}
