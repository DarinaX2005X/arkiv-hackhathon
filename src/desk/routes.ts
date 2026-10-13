import { isPublicEntityKey } from '../app/ids';
import { parseRoute, safeReturnPath, type Route } from '../app/routes';
import { activeSource } from '../domain/readiness';
import type { ContentHash, ProjectAggregate, PublicEntityKey } from '../domain/types';

export interface InvitationRevision { activationKey?: PublicEntityKey; proposalKey?: PublicEntityKey; proposalHash?: ContentHash }
export type DeskRoute =
  | { name: 'contributions'; projectRoot?: PublicEntityKey; returnTo?: string }
  | { name: 'requests' | 'help' }
  | { name: 'project'; projectRoot: PublicEntityKey; section: 'needs' | 'agreement' | 'plans' | 'runbook'; revision?: InvitationRevision }
  | { name: 'publisher'; publisherRoot: PublicEntityKey; offerId?: string }
  | { name: 'not-found' };
export type TargetKind = 'project' | 'publisher';
const sections = ['agreement', 'plans', 'runbook', 'needs', 'history'];
const offerIdValid = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
function publicReturnPath(value: string | null, depth = 0): string | undefined {
  const path = safeReturnPath(value);
  if (!path || depth > 3) return undefined;
  const route = parseRoute(path);
  if ((route.name === 'project' || route.name === 'contributions') && route.projectRoot && !isPublicEntityKey(route.projectRoot)) return undefined;
  if (route.name === 'contributions' && route.returnTo && !publicReturnPath(route.returnTo, depth + 1)) return undefined;
  return ['home', 'events', 'event', 'my-events', 'requests', 'project', 'contributions', 'new-project'].includes(route.name) ? path : undefined;
}

/** Treat pasted URLs as data: read their public target; never follow their origin. */
export function parseDeskRoute(input: string): DeskRoute {
  if (input.length > 2048 || /[\u0000-\u001f]/.test(input)) return { name: 'not-found' };
  let raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.username || url.password) return { name: 'not-found' };
      raw = url.hash || `${url.pathname}${url.search}`;
    } catch { return { name: 'not-found' }; }
  }
  raw = raw.replace(/^#/, '');
  if (!raw || raw === '/' || raw === '/contributions' || raw === '/offers') return { name: 'contributions' };
  if (raw === '/requests') return { name: 'requests' };
  if (raw === '/help') return { name: 'help' };
  const separator = raw.indexOf('?');
  let path: string;
  try { path = decodeURIComponent(separator < 0 ? raw : raw.slice(0, separator)); }
  catch { return { name: 'not-found' }; }
  const query = new URLSearchParams(separator < 0 ? '' : raw.slice(separator + 1));
  if ([...query.keys()].some(key => query.getAll(key).length !== 1)) return { name: 'not-found' };
  if (path === '/contributions' || path === '/offers') {
    const projectRoot = query.get('projectRoot'), returnTo = publicReturnPath(query.get('returnTo'));
    if ([...query.keys()].some(key => !['projectRoot', 'returnTo'].includes(key)) || projectRoot !== null && !isPublicEntityKey(projectRoot)
      || query.has('returnTo') && !returnTo) return { name: 'not-found' };
    return { name: 'contributions', ...(projectRoot ? { projectRoot: projectRoot as PublicEntityKey } : {}), ...(returnTo ? { returnTo } : {}) };
  }
  const project = /^\/projects\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (project && isPublicEntityKey(project[1]) && (!project[2] || sections.includes(project[2]))) {
    if ([...query.keys()].some(key => !['activation', 'proposal', 'revision', 'hash'].includes(key))) return { name: 'not-found' };
    const activationKey = query.get('activation'); const proposalKey = query.get('proposal') ?? query.get('revision'); const proposalHash = query.get('hash');
    if ((query.has('proposal') && query.has('revision')) || [activationKey, proposalKey, proposalHash].some(key => key !== null && !isPublicEntityKey(key))) return { name: 'not-found' };
    const revision = { ...(activationKey ? { activationKey: activationKey as PublicEntityKey } : {}), ...(proposalKey ? { proposalKey: proposalKey as PublicEntityKey } : {}), ...(proposalHash ? { proposalHash: proposalHash as ContentHash } : {}) };
    return { name: 'project', projectRoot: project[1], section: project[2] === 'needs' ? 'needs' : project[2] === 'runbook' ? 'runbook' : project[2] === 'plans' ? 'plans' : 'agreement', ...(Object.keys(revision).length ? { revision } : {}) };
  }
  const publisher = /^\/(?:publishers|contributions|offers)\/([^/]+)$/.exec(path);
  if (publisher && isPublicEntityKey(publisher[1]) && [...query.keys()].every(key => key === 'offer')) {
    const offerId = query.get('offer');
    if (offerId !== null && !offerIdValid(offerId)) return { name: 'not-found' };
    return { name: 'publisher', publisherRoot: publisher[1], ...(offerId ? { offerId } : {}) };
  }
  return { name: 'not-found' };
}

export function parsePublicTarget(input: string, kind: TargetKind): DeskRoute {
  const text = input.trim();
  if (isPublicEntityKey(text)) return kind === 'project' ? { name: 'project', projectRoot: text, section: 'agreement' } : { name: 'publisher', publisherRoot: text };
  const route = parseDeskRoute(text);
  return route.name === 'project' || route.name === 'publisher' ? route : { name: 'not-found' };
}

export function deskPath(route: DeskRoute): string {
  if (route.name === 'not-found') return '/not-found';
  if (route.name === 'publisher') return `/publishers/${route.publisherRoot}${route.offerId ? `?offer=${encodeURIComponent(route.offerId)}` : ''}`;
  if (route.name === 'contributions') {
    const query = new URLSearchParams();
    if (route.projectRoot) query.set('projectRoot', route.projectRoot);
    if (route.returnTo) query.set('returnTo', route.returnTo);
    return `/contributions${query.size ? `?${query}` : ''}`;
  }
  if (route.name !== 'project') return `/${route.name}`;
  const query = new URLSearchParams();
  if (route.revision?.activationKey) query.set('activation', route.revision.activationKey);
  if (route.revision?.proposalKey) query.set('proposal', route.revision.proposalKey);
  if (route.revision?.proposalHash) query.set('hash', route.revision.proposalHash);
  return `/projects/${route.projectRoot}/${route.section}${query.size ? `?${query}` : ''}`;
}
export const deskHref = (route: DeskRoute) => `#${deskPath(route)}`;
/** The separate hash router retains exact invitation revisions; shared draft handoff needs its current contribution destination. */
export function deskSessionRoute(route: DeskRoute): Route {
  if (route.name === 'project') return { name: 'project', projectRoot: route.projectRoot, tab: route.section };
  if (route.name === 'publisher') return { name: 'contributions' };
  if (route.name === 'not-found') return { name: 'not-found', path: '/not-found' };
  return route;
}
export function invitationStatus(project: ProjectAggregate, revision?: InvitationRevision): 'current' | 'different' | 'unavailable' {
  if (!revision) return 'current';
  const source = activeSource(project);
  if (!source) return 'unavailable';
  return Object.entries(revision).every(([key, value]) => source[key as keyof InvitationRevision]?.toLowerCase() === value.toLowerCase()) ? 'current' : 'different';
}

export function isSavedDeskRoute(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && parseDeskRoute(value).name !== 'not-found';
}
