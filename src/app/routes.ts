import type { EntityKey, PublicEntityKey } from '../domain/types';
import { isEntityKey, isPublicEntityKey } from './ids';

export const projectTabs = ['needs', 'plans', 'agreement', 'runbook', 'history'] as const;
export type ProjectTab = (typeof projectTabs)[number];
export type Route =
  | { name: 'home' | 'demo' | 'workspace' | 'new-project' | 'requests' | 'events' | 'my-events' }
  | { name: 'contributions'; projectRoot?: EntityKey; returnTo?: string }
  | { name: 'sign-in' | 'account' | 'onboarding'; returnTo?: string }
  | { name: 'event'; projectRoot: PublicEntityKey }
  | { name: 'help'; topic?: string; returnTo?: string }
  | { name: 'project'; projectRoot: EntityKey; tab: ProjectTab }
  | { name: 'not-found'; path: string };
const simpleRoutes = { '/': 'home', '/demo': 'demo', '/workspace': 'workspace', '/projects/new': 'new-project', '/contributions': 'contributions', '/requests': 'requests', '/help': 'help', '/sign-in': 'sign-in', '/account': 'account', '/onboarding': 'onboarding', '/events': 'events', '/my-events': 'my-events' } as const;

export function parseRoute(input: string, depth = 0): Route {
  const raw = input.replace(/^#/, '') || '/';
  let path: string;
  try { path = decodeURIComponent(raw.split('?')[0] ?? '/'); }
  catch { return { name: 'not-found', path: input.slice(0, 256) }; }
  const query = new URLSearchParams(raw.split('?').slice(1).join('?'));
  const returnTo = depth < 3 ? safeReturnPath(query.get('returnTo'), depth + 1) : undefined;
  const returned = returnTo ? { returnTo } : {};
  if (path === '/help') {
    const topic = query.get('topic');
    return { name: 'help', ...(topic && /^[a-z][a-z0-9-]{0,47}$/.test(topic) ? { topic } : {}), ...returned };
  }
  if (path === '/contributions') {
    const projectRoot = query.get('projectRoot');
    return { name: 'contributions', ...(projectRoot && isEntityKey(projectRoot) ? { projectRoot } : {}), ...returned };
  }
  if (path === '/sign-in' || path === '/account' || path === '/onboarding') return { name: simpleRoutes[path], ...returned };
  if (Object.hasOwn(simpleRoutes, path)) return { name: simpleRoutes[path as keyof typeof simpleRoutes] };
  const event = /^\/events\/([^/]+)$/.exec(path);
  if (event && isPublicEntityKey(event[1])) return { name: 'event', projectRoot: event[1] };
  const match = /^\/projects\/([^/]+)(?:\/(needs|plans|agreement|runbook|history))?$/.exec(path);
  if (match && isEntityKey(match[1])) return { name: 'project', projectRoot: match[1], tab: (match[2] as ProjectTab | undefined) ?? 'needs' };
  return { name: 'not-found', path: path.slice(0, 256) };
}
export function safeReturnPath(value: string | null | undefined, depth = 0): string | undefined {
  if (!value || value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || /[\\#\u0000-\u001f]/.test(value) || depth > 3) return undefined;
  const parsed = parseRoute(value, depth);
  return ['not-found', 'help', 'sign-in', 'account', 'onboarding'].includes(parsed.name) ? undefined : routePath(parsed);
}
export function routePath(route: Route): string {
  if (route.name === 'project') return `/projects/${encodeURIComponent(route.projectRoot)}/${route.tab}`;
  if (route.name === 'event') return `/events/${encodeURIComponent(route.projectRoot)}`;
  if (route.name === 'help' || route.name === 'contributions' || route.name === 'sign-in' || route.name === 'account' || route.name === 'onboarding') {
    const query = new URLSearchParams();
    if (route.name === 'help' && route.topic && /^[a-z][a-z0-9-]{0,47}$/.test(route.topic)) query.set('topic', route.topic);
    if (route.name === 'contributions' && route.projectRoot && isEntityKey(route.projectRoot)) query.set('projectRoot', route.projectRoot);
    const returnTo = safeReturnPath(route.returnTo);
    if (returnTo) query.set('returnTo', returnTo);
    return `/${route.name}${query.size ? `?${query}` : ''}`;
  }
  if (route.name === 'not-found') return '/';
  return Object.entries(simpleRoutes).find(([, name]) => name === route.name)?.[0] ?? '/';
}
export const routeHref = (route: Route): string => `#${routePath(route)}`;
/** A blank landing URL must never inherit another visit's saved destination. */
export function routeFromLocation(location: { pathname: string; search?: string; hash: string }): Route {
  if (location.hash.startsWith('#/')) return parseRoute(location.hash);
  return parseRoute(`${location.pathname || '/'}${location.search ?? ''}`);
}
/** Local IDs must never be presented as a public invitation. No navigation occurs here. */
export function projectInvitation(baseUrl: string, projectRoot: PublicEntityKey): string {
  if (!isPublicEntityKey(projectRoot)) throw new TypeError('A public invitation requires a public project root.');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Unsupported invitation URL.');
  url.hash = routePath({ name: 'project', projectRoot, tab: 'needs' });
  return url.toString();
}
