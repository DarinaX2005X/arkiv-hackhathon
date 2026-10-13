import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { PublicRuntimeBinding } from '../../app/network';
import { parseRoute, routeBehindSignIn, routeHref } from '../../app/routes';
import { BrandMark, Button, Link } from '../../ui';
import { AccountAvatar } from './AccountAvatar';
import { ACCOUNT_PREFERENCES_EVENT, createAccountPreferences, readAccountPreferences, workDestination } from './account';
import { WalletSignInDialog } from './WalletSignInDialog';

export interface ProductNavigationLink { key: string; label: string; href: string; current?: boolean }
export interface ProductHeaderProps {
  binding: PublicRuntimeBinding;
  space?: 'studio' | 'desk';
  currentDestination: string;
  links?: readonly ProductNavigationLink[];
  accountHref?: string;
  helpHref?: string;
  switchHref?: string;
  brandHref?: string;
  onSignIn?: () => void;
}

/** Shared by the independently built Studio and Desk; it only needs the live wallet binding. */
export function ProductHeader({ binding, space = 'studio', currentDestination, links, accountHref, helpHref, switchHref, brandHref, onSignIn }: ProductHeaderProps) {
  const session = useSyncExternalStore(binding.runtime.session.subscribe, binding.runtime.session.getSnapshot, binding.runtime.session.getSnapshot);
  const [signInOpen, setSignInOpen] = useState(false), [navigationOpen, setNavigationOpen] = useState(false);
  const [, refreshPreferences] = useState(0);
  const disclosure = useRef<HTMLDetailsElement>(null), summary = useRef<HTMLElement>(null);
  const navigationId = useId();
  const route = routeBehindSignIn(parseRoute(currentDestination));
  const returnTo = workDestination(route);
  const actor = session.actor?.kind === 'wallet' ? session.actor : null;
  const label = actor ? readAccountPreferences(createAccountPreferences(binding.runtime, actor.address).load()).value.label : '';
  const account = accountHref ?? routeHref({ name: 'account', returnTo });
  const help = helpHref ?? routeHref({ name: 'help', returnTo });
  const navigation: readonly ProductNavigationLink[] = links ?? [
    { key: 'events', label: 'Events', href: routeHref({ name: 'events' }), current: ['events', 'event'].includes(route.name) },
    { key: 'my-events', label: 'My events', href: routeHref({ name: 'my-events' }), current: route.name === 'my-events' },
    { key: 'workspace', label: 'My projects', href: routeHref({ name: 'workspace' }), current: ['workspace', 'new-project', 'project'].includes(route.name) },
    { key: 'contributions', label: 'My contributions', href: routeHref({ name: 'contributions' }), current: route.name === 'contributions' },
    { key: 'requests', label: 'Requests', href: routeHref({ name: 'requests' }), current: route.name === 'requests' },
    { key: 'help', label: 'Help', href: help, current: route.name === 'help' },
  ];
  const closeMenu = () => { if (disclosure.current) disclosure.current.open = false; };
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (event.target instanceof Node && !disclosure.current?.contains(event.target)) closeMenu(); };
    const refresh = () => refreshPreferences(value => value + 1);
    const fromStorage = (event: StorageEvent) => { if (!event.key || event.key.startsWith('partfolk:account:')) refresh(); };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener(ACCOUNT_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', fromStorage);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener(ACCOUNT_PREFERENCES_EVENT, refresh);
      window.removeEventListener('storage', fromStorage);
    };
  }, []);
  useEffect(() => { closeMenu(); setNavigationOpen(false); setSignInOpen(false); }, [currentDestination]);
  const signIn = () => { closeMenu(); (onSignIn ?? (() => setSignInOpen(true)))(); };
  const menuKey = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); summary.current?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const details = disclosure.current;
    if (!details) return;
    event.preventDefault(); details.open = true;
    const commands = [...details.querySelectorAll<HTMLElement>('.pf-account-menu-panel a[href], .pf-account-menu-panel button:not(:disabled)')];
    const active = commands.indexOf(document.activeElement as HTMLElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? commands.length - 1
      : event.key === 'ArrowDown' ? (active + 1) % commands.length : (active < 0 ? commands.length - 1 : (active - 1 + commands.length) % commands.length);
    commands[index]?.focus();
  };
  return <>
    <header className={`pf-app-header pf-product-header pf-product-header--${space}`}>
      <a className="pf-brand" href={brandHref ?? routeHref({ name: 'home' })}><BrandMark /><span className="pf-wordmark">Partfolk</span>{space === 'desk' && <span className="pf-product-space">Desk</span>}</a>
      <nav id={navigationId} aria-label={space === 'desk' ? 'Desk navigation' : 'Main navigation'} className="pf-app-navigation" data-expanded={navigationOpen}>
        {navigation.map(item => <a key={item.key} id={`nav-${item.key}`} href={item.href} aria-current={item.current ? 'page' : undefined}>{item.label}</a>)}
      </nav>
      <div className="pf-account-header">
        {!actor && <Button size="compact" onClick={signIn}>Sign in</Button>}
        <details ref={disclosure} className="pf-account-menu" onToggle={event => { if (event.currentTarget.open) setNavigationOpen(false); }} onKeyDown={menuKey} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(); }}>
          <summary ref={summary} id="account-commands" aria-label={actor ? `Account menu for ${label || actor.address}` : 'Account and workspaces'}>
            {actor ? <AccountAvatar address={actor.address} /> : <svg className="pf-account-guest-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" /><path d="M5 20v-2a7 7 0 0 1 14 0v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}
            <svg className="pf-account-chevron" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </summary>
          <div className="pf-account-menu-panel pf-surface-light" onClick={event => { if (event.target instanceof Element && event.target.closest('a')) closeMenu(); }}>
            <div className="pf-account-menu-identity">
              {actor && <AccountAvatar address={actor.address} />}
              <div><strong>{actor ? label || 'Your wallet' : 'Welcome to Partfolk'}</strong><span className="pf-account-address">{actor ? `${actor.address.slice(0, 8)}…${actor.address.slice(-6)}` : 'Sign in to find your own work.'}</span></div>
            </div>
            {!actor && <Button onClick={signIn}>Sign in with a wallet</Button>}
            <div className="pf-account-menu-group" role="group" aria-label="Your work">
              {navigation.filter(item => item.key !== 'help').map(item => <Link key={item.key} href={item.href} aria-current={item.current ? 'page' : undefined}>{item.label}</Link>)}
            </div>
            <Link className="pf-space-switch" href={switchHref ?? (space === 'desk' ? '/#/events' : '/desk/')}>
              <span className="pf-space-switch-mark" aria-hidden="true">{space === 'desk' ? <BrandMark /> : <svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 5h16v12H4zM8 17v3m8-3v3M8 9h8M8 13h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}</span>
              <span><strong>{space === 'desk' ? 'Back to Partfolk' : 'Switch to Desk'}</strong><span>{space === 'desk' ? 'Explore and organize events' : 'Focus on your contributions'}</span></span><span aria-hidden="true">↗</span>
            </Link>
            <div className="pf-account-menu-support"><Link href={account}>Account and settings</Link><Link href={help}>Help</Link>{actor && <Button variant="quiet" onClick={() => { closeMenu(); binding.disconnect(); summary.current?.focus(); }}>Sign out</Button>}</div>
          </div>
        </details>
        <Button className="pf-navigation-toggle" variant="quiet" size="compact" aria-expanded={navigationOpen} aria-controls={navigationId} onClick={() => setNavigationOpen(value => !value)}>{navigationOpen ? 'Close menu' : 'Menu'}</Button>
      </div>
    </header>
    {!onSignIn && <WalletSignInDialog binding={binding} open={signInOpen} onClose={() => setSignInOpen(false)} />}
  </>;
}
