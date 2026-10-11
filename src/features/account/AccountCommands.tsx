import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAppSession } from '../../app/context';
import { parseRoute, routeHref, routePath } from '../../app/routes';
import type { StudioWorkspaces } from '../../app/workspaces';
import { Button, Link } from '../../ui';
import { createAccountPreferences, readAccountPreferences, workDestination } from './account';

/** A disclosure of ordinary links and commands, with native keyboard navigation. */
export function AccountCommands({ manager }: { manager: StudioWorkspaces }) {
  const session = useAppSession();
  const publicSession = useSyncExternalStore(manager.runtimes.public.session.subscribe, manager.runtimes.public.session.getSnapshot, manager.runtimes.public.session.getSnapshot);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const currentRoute = parseRoute(session.destination);
  const returnTo = currentRoute.name === 'home' ? undefined : workDestination(currentRoute);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (event.target instanceof Node && !disclosure.current?.contains(event.target)) disclosure.current?.removeAttribute('open'); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  useEffect(() => { disclosure.current?.removeAttribute('open'); }, [session.destination]);
  const actor = publicSession.actor;
  const label = actor?.kind === 'wallet' ? readAccountPreferences(createAccountPreferences(manager.runtimes.public, actor.address).load()).value.label : '';
  const localWork = async () => { await manager.select('local', { name: 'workspace' }); window.location.hash = '/workspace'; };
  return <div className="pf-account-header">
    {!actor && <Link className="pf-button pf-button--secondary" href={routeHref({ name: 'sign-in', returnTo })}>Sign in</Link>}
    <details ref={disclosure} className="pf-account-menu" onKeyDown={event => {
      if (event.key === 'Escape') { disclosure.current?.removeAttribute('open'); disclosure.current?.querySelector('summary')?.focus(); }
    }}>
      <summary id="account-commands">{actor ? label || 'Account' : 'Your work'}</summary>
      <div className="pf-account-menu-panel">
        <div className="pf-account-menu-identity"><strong>{actor?.kind === 'wallet' ? label || 'Connected wallet' : 'Browsing as a guest'}</strong>{actor?.kind === 'wallet' && <span className="pf-account-address">{actor.address.slice(0, 10)}…{actor.address.slice(-6)}</span>}</div>
        <Link href={routeHref({ name: 'my-events' })}>My events</Link>
        <Link href={routeHref({ name: 'workspace' })}>My projects</Link>
        <Link href={routeHref({ name: 'contributions' })}>My contributions</Link>
        <Link href={routeHref({ name: 'account', returnTo })}>Account and settings</Link>
        <Button variant="quiet" onClick={() => { void localWork(); }}>Local work on this device</Button>
        <div className="pf-account-menu-support"><Link href={routeHref({ name: 'help', returnTo })}>Help</Link>{actor && <Button variant="quiet" onClick={() => { manager.publicBinding.disconnect(); window.location.hash = routePath({ name: 'sign-in', returnTo }); }}>Sign out</Button>}</div>
      </div>
    </details>
  </div>;
}
