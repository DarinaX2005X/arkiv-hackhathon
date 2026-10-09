import type { EntityKey, PublicEntityKey } from '../domain/types';
import { isEntityKey, isPublicEntityKey } from './ids';

export const projectTabs = ['needs', 'plans', 'agreement', 'runbook', 'history'] as const;
export type ProjectTab = (typeof projectTabs)[number];
export type Route =
  | { name: 'home' | 'demo' | 'workspace' | 'new-project' | 'contributions' | 'requests' }
  | { name: 'help'; topic?: string; returnTo?: string }
  | { name: 'project'; projectRoot: EntityKey; tab: ProjectTab }
  | { name: 'not-found'; path: string };
const simpleRoutes = { '/': 'home', '/demo': 'demo', '/workspace': 'workspace', '/projects/new': 'new-project', '/contributions': 'contributions', '/requests': 'requests', '/help': 'help' } as const;

export function parseRoute(input: string): Route {
  const raw = input.replace(/^#/, '') || '/';
  if (raw === '/help' || raw.startsWith('/help?')) {
    const query = new URLSearchParams(raw.split('?').slice(1).join('?'));
    const topic = query.get('topic');
    const returnTo = safeReturnPath(query.get('returnTo'));
    return { name: 'help', ...(topic && /^[a-z][a-z0-9-]{0,47}$/.test(topic) ? { topic } : {}), ...(returnTo ? { returnTo } : {}) };
  }
  let path: string;
  try { path = decodeURIComponent(raw); }
  catch { return { name: 'not-found', path: input.slice(0, 256) }; }
  if (Object.hasOwn(simpleRoutes, path)) return { name: simpleRoutes[path as keyof typeof simpleRoutes] };
  const match = /^\/projects\/([^/]+)(?:\/(needs|plans|agreement|runbook|history))?$/.exec(path);
  if (match && isEntityKey(match[1])) return { name: 'project', projectRoot: match[1], tab: (match[2] as ProjectTab | undefined) ?? 'needs' };
  return { name: 'not-found', path: path.slice(0, 256) };
}
function safeReturnPath(value: string | null | undefined): string | undefined {
  if (!value || value.length > 256 || !value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#') || value.startsWith('/help')) return undefined;
  const parsed = parseRoute(value);
  return parsed.name === 'not-found' || parsed.name === 'help' ? undefined : routePath(parsed);
}
export function routePath(route: Route): string {
  if (route.name === 'project') return `/projects/${encodeURIComponent(route.projectRoot)}/${route.tab}`;
  if (route.name === 'help') {
    const query = new URLSearchParams();
    if (route.topic && /^[a-z][a-z0-9-]{0,47}$/.test(route.topic)) query.set('topic', route.topic);
    const returnTo = safeReturnPath(route.returnTo);
    if (returnTo) query.set('returnTo', returnTo);
    return `/help${query.size ? `?${query}` : ''}`;
  }
  if (route.name === 'not-found') return '/';
  return Object.entries(simpleRoutes).find(([, name]) => name === route.name)?.[0] ?? '/';
}
export const routeHref = (route: Route): string => `#${routePath(route)}`;
/** Local IDs must never be presented as a public invitation. No navigation occurs here. */
export function projectInvitation(baseUrl: string, projectRoot: PublicEntityKey): string {
  if (!isPublicEntityKey(projectRoot)) throw new TypeError('A public invitation requires a public project root.');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Unsupported invitation URL.');
  url.hash = routePath({ name: 'project', projectRoot, tab: 'needs' });
  return url.toString();
}
