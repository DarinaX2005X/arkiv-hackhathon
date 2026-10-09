import { parseRoute, routeHref, routePath, type Route } from '../../app/routes';
import { helpCopy, helpTopics, type HelpTopicId } from './catalog';

export function isHelpTopic(value: unknown): value is HelpTopicId {
  return typeof value === 'string' && helpTopics.some(topic => topic.id === value);
}

/** Return targets use the app's route validator and cannot leave this app or recurse into Help. */
export function helpReturnRoute(destination?: string): Route {
  if (!destination?.startsWith('/') || destination.length > 256) return { name: 'workspace' };
  const route = parseRoute(destination);
  return route.name === 'not-found' || route.name === 'help' ? { name: 'workspace' } : route;
}

export function helpHref(topic?: HelpTopicId, returnTo?: Route): string {
  return routeHref({ name: 'help', ...(topic ? { topic } : {}),
    ...(returnTo && returnTo.name !== 'help' && returnTo.name !== 'not-found' ? { returnTo: routePath(returnTo) } : {}) });
}

export function helpReturnLabel(route: Route): string {
  switch (route.name) {
    case 'home': return helpCopy.returnHome;
    case 'demo': return helpCopy.returnDemo;
    case 'new-project': return helpCopy.returnDraft;
    case 'project': return helpCopy.returnProject;
    case 'contributions': return helpCopy.returnContributions;
    case 'requests': return helpCopy.returnRequests;
    default: return helpCopy.returnWorkspace;
  }
}
