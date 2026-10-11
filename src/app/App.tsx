import { Component, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { AppProvider, useApp, useAppSession, type AppRuntime } from './context';
import { parseRoute, routeHref, type Route } from './routes';
import { BrandMark, Button, EmptyState, ErrorState, LoadingState, Notice } from '../ui';
import { workDestination } from '../features/account/account';

export interface RouteViewProps { route: Route }
export type RouteRegistry = Partial<Record<Route['name'], ComponentType<RouteViewProps>>>;

const navigation = [
  { name: 'events', label: 'events' }, { name: 'my-events', label: 'myEvents' },
  { name: 'workspace', label: 'projects' }, { name: 'contributions', label: 'contributions' },
  { name: 'requests', label: 'requests' }, { name: 'help', label: 'help' },
] as const;

/** Native hash navigation remains usable on static hosts. It never owns the app runtime. */
function HashNavigation() {
  const { session } = useApp();
  useEffect(() => {
    const read = () => {
      session.navigate(parseRoute(window.location.hash));
      document.getElementById('main-content')?.focus({ preventScroll: true });
    };
    if (window.location.hash) session.navigate(parseRoute(window.location.hash));
    else if (session.getSnapshot().destination !== '/') window.location.hash = session.getSnapshot().destination;
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [session]);
  return null;
}

export function AppShell({ children, controls, account, guide }: { children: ReactNode; controls?: ReactNode; account?: ReactNode; guide?: ReactNode }) {
  const { copy, session } = useApp();
  const state = useAppSession();
  const t = copy.text.bind(copy, 'shell');
  const route = parseRoute(state.destination);
  const visibleNavigation = route.name === 'home'
    ? navigation.filter(item => ['events', 'workspace', 'help'].includes(item.name)) : navigation;
  const needsRecovery = state.storageIssue !== null && ['invalid_json', 'unsupported_version', 'invalid_payload', 'too_large', 'recovery_required'].includes(state.storageIssue.code);
  const exportRecovery = () => {
    const original = session.exportRecovery();
    if (original === null) return;
    const url = URL.createObjectURL(new Blob([original], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'partfolk-saved-data-recovery.txt';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <>
    <a className="pf-skip" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>{t('skip')}</a>
    <header className={`pf-app-header${route.name === 'home' ? ' pf-app-header--public' : ''}`}>
      <a className="pf-brand" href={routeHref({ name: 'home' })}><BrandMark /><span className="pf-wordmark">{t('brand')}</span></a>
      <nav aria-label={t('navigation')} className="pf-app-navigation">
        {visibleNavigation.map(item => <a key={item.name} id={`nav-${item.name}`} href={routeHref(item.name === 'help' ? { name: 'help', returnTo: workDestination(route) } : { name: item.name })} aria-current={route.name === item.name || (['project', 'new-project'].includes(route.name) && item.name === 'workspace') || (route.name === 'event' && item.name === 'events') ? 'page' : undefined}>{t(item.label)}</a>)}
      </nav>
      {account}
    </header>
    {controls}
    <main className={`pf-page pf-app-main${route.name === 'home' ? ' pf-app-main--home' : ''}`} id="main-content" tabIndex={-1}>
      {state.storageIssue && <Notice tone="warning" title={t(needsRecovery ? 'recoveryTitle' : 'storageTitle')}>
        <p>{t(needsRecovery ? 'recoveryBody' : 'storageBody')}</p>
        {session.exportRecovery() !== null && <Button variant="secondary" onClick={exportRecovery}>{t('exportRecovery')}</Button>}
      </Notice>}
      {guide}
      <div id="work-surface" tabIndex={-1}>{children}</div>
    </main>
    <footer className="pf-app-footer">
      <div className="pf-footer-intro">
        <a className="pf-footer-brand pf-brand" href={routeHref({ name: 'home' })}><BrandMark /><strong>{t('brand')}</strong></a>
        <p>Bring your event together. Keep everyone in control of their part.</p>
        <p className="pf-secondary">People publish their own offers and decisions on Arkiv.</p>
      </div>
      <div className="pf-footer-links" aria-label="Footer navigation">
        <div className="pf-footer-group"><strong>Take part</strong><a href={routeHref({ name: 'events' })}>Browse events</a><a href={routeHref({ name: 'my-events' })}>My events</a><a href={routeHref({ name: 'workspace' })}>My projects</a><a href={routeHref({ name: 'contributions' })}>My contributions</a></div>
        <div className="pf-footer-group"><strong>Learn</strong><a href={routeHref({ name: 'help', topic: 'publishing', returnTo: state.destination })}>Public records and your data</a><a href={routeHref({ name: 'help', topic: 'agreement', returnTo: state.destination })}>Agreements and ownership</a><a href={routeHref({ name: 'help', returnTo: state.destination })}>Help with Partfolk</a></div>
      </div>
      <div className="pf-footer-meta"><span>Drafts stay in this browser. Published project details and decisions are public.</span></div>
    </footer>
  </>;
}

function FoundationView({ route }: RouteViewProps) {
  const { copy } = useApp();
  const t = copy.text.bind(copy, 'shell');
  if (route.name === 'home') return <div className="pf-foundation-intro pf-stack">
    <p className="pf-secondary">{t('tagline')}</p>
    <h1>{t('heading')}</h1><p>{t('description')}</p>
    <Notice title={t('foundationTitle')}>{t('foundationBody')}</Notice>
  </div>;
  if (route.name === 'help') return <article className="pf-sheet pf-stack"><h1>{t('helpTitle')}</h1><p>{t('helpBody')}</p><p>{t('helpPrivacy')}</p></article>;
  const keys = route.name === 'workspace' ? ['workspaceTitle', 'workspaceBody'] as const
    : route.name === 'contributions' ? ['contributionTitle', 'contributionBody'] as const
      : route.name === 'requests' ? ['requestsTitle', 'requestsBody'] as const
        : route.name === 'not-found' ? ['missingTitle', 'missingBody'] as const
          : ['pendingTitle', 'pendingBody'] as const;
  return <section className="pf-sheet"><h1>{t(keys[0])}</h1><EmptyState title={t(keys[0])}>{t(keys[1])}</EmptyState></section>;
}

/** A failed screen download leaves shell navigation and saved runtime state available. */
export class ViewLoadBoundary extends Component<{ destination: string; failureTitle?: string; children: ReactNode }, { failed: boolean; destination: string }> {
  state = { failed: false, destination: this.props.destination };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { destination: string }, state: { destination: string }) {
    return props.destination === state.destination ? null : { failed: false, destination: props.destination };
  }
  render() {
    return this.state.failed ? <ErrorState title={this.props.failureTitle ?? 'This page could not be opened'} description="Reload the page to try again. Work already saved on this device will be kept."
      actions={<Button onClick={() => window.location.reload()}>Reload page</Button>} /> : this.props.children;
  }
}

function RoutedApp({ routes, controls, account, guide }: { routes: RouteRegistry; controls?: ReactNode; account?: ReactNode; guide?: ReactNode }) {
  const state = useAppSession();
  const route = parseRoute(state.destination);
  const View = routes[route.name] ?? FoundationView;
  return <><HashNavigation /><AppShell controls={controls} account={account} guide={guide}>
    <ViewLoadBoundary destination={state.destination}><Suspense fallback={<LoadingState title="Opening this page" />}><View route={route} /></Suspense></ViewLoadBoundary>
  </AppShell></>;
}
/** MAIN composes the feature registry; Desk may use only AppProvider/AppShell. */
export function RootApp({ runtime, routes = {}, controls, account, guide }: { runtime: AppRuntime; routes?: RouteRegistry; controls?: ReactNode; account?: ReactNode; guide?: ReactNode }) {
  return <AppProvider runtime={runtime}><RoutedApp routes={routes} controls={controls} account={account} guide={guide} /></AppProvider>;
}
