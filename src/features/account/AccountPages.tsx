import { useEffect, useMemo, useState } from 'react';
import type { RouteViewProps } from '../../app/App';
import { useApp, useAppSession } from '../../app/context';
import type { PublicRuntimeBinding } from '../../app/network';
import { routeBehindSignIn, routeHref, routePath, type Route } from '../../app/routes';
import { Button, Field, Link, Notice, Select } from '../../ui';
import { accountReturnRoute, createAccountPreferences, readAccountPreferences, type AccountPreferences } from './account';
import { AccountAvatar } from './AccountAvatar';
import { WalletSignInDialog } from './WalletSignInDialog';

const navigate = (route: Route) => { window.location.hash = routePath(route); };
const returned = (route: Route) => 'returnTo' in route ? route.returnTo : undefined;
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function SignInPage({ binding, route }: RouteViewProps & { binding: PublicRuntimeBinding }) {
  return <WalletSignInDialog binding={binding} open onClose={() => navigate(routeBehindSignIn(route))} />;
}

function AccountForm({ address, onboarding, returnTo, binding, onChangeWallet }: { address: string; onboarding: boolean; returnTo?: string; binding: PublicRuntimeBinding; onChangeWallet: () => void }) {
  const runtime = useApp();
  const store = useMemo(() => createAccountPreferences(runtime, address), [runtime, address]);
  const initial = useMemo(() => readAccountPreferences(store.load()), [store]);
  const [preferences, setPreferences] = useState(initial.value);
  const [issue, setIssue] = useState(initial.issue), [saved, setSaved] = useState(false);
  const update = (value: AccountPreferences) => {
    setPreferences(value); setSaved(false);
    const result = store.save(value); setIssue(result.issue);
  };
  const save = () => {
    // A stale component cannot finish setup on behalf of another connected wallet.
    const actor = runtime.session.getSnapshot().actor;
    if (actor?.kind !== 'wallet' || actor.address.toLowerCase() !== address.toLowerCase()) return;
    const value = { ...preferences, label: preferences.label.trim(), setupComplete: true };
    const result = store.save(value); setPreferences(value); setIssue(result.issue); setSaved(result.persisted);
    if (onboarding && result.persisted) navigate(accountReturnRoute(returnTo, value));
  };
  const signOut = () => { binding.disconnect(); };
  return <div className="pf-account-layout">
    <section className="pf-sheet pf-stack pf-account-main">
      <h1>{onboarding ? 'Welcome to Partfolk' : 'Account and settings'}</h1>
      <p>{onboarding ? 'Choose where to begin. You can organize, contribute and attend with this same account.' : 'One wallet connects your projects, contributions and event registrations. These preferences are saved only in this browser.'}</p>
      <div className="pf-account-identity"><AccountAvatar address={address} /><div><strong>Connected wallet</strong><span className="pf-account-address">{address}</span><span className="pf-secondary">Arkiv Tiramisu</span></div></div>
      <form className="pf-stack" onSubmit={event => { event.preventDefault(); save(); }}>
        <Field label="Label on this device (optional)" value={preferences.label} maxLength={80} autoComplete="off" onChange={event => update({ ...preferences, label: event.target.value.replace(/[\u0000-\u001f]/g, '') })} hint="For recognizing this wallet here. This is not published as a public profile." />
        <Select label="Preferred workspace" value={preferences.defaultDestination} onChange={event => update({ ...preferences, defaultDestination: event.target.value as AccountPreferences['defaultDestination'] })} options={[{ value: 'workspace', label: 'My projects' }, { value: 'contributions', label: 'My contributions' }, { value: 'my-events', label: 'My events' }]} hint="Used by the Return to my work link. Signing in keeps your current page and unfinished action." />
        {issue && <Notice tone="warning" title="These settings have not been saved">Your entries remain on this page. {store.exportRecovery() !== null ? 'Existing unreadable settings were kept. Export them before attempting recovery.' : 'Browser storage is unavailable or full. Export your settings before leaving.'}<div className="pf-actions"><Button variant="secondary" onClick={() => download('partfolk-device-settings.json', store.export(preferences))}>Export settings</Button>{store.exportRecovery() !== null && <Button variant="quiet" onClick={() => download('partfolk-settings-recovery.txt', store.exportRecovery()!)}>Export original data</Button>}</div></Notice>}
        {saved && <p role="status">Settings saved on this device.</p>}
        <div className="pf-actions"><Button type="submit">{onboarding ? 'Save and continue' : 'Save settings'}</Button>{onboarding ? <Button variant="quiet" onClick={() => { const result = store.save({ ...preferences, setupComplete: true }); setIssue(result.issue); navigate(accountReturnRoute(returnTo, preferences)); }}>Skip setup</Button> : <Link href={routeHref(accountReturnRoute(returnTo, preferences))}>Return to my work</Link>}</div>
      </form>
      {!onboarding && <div className="pf-account-signout pf-stack"><h2>Session</h2><p>Sign out to stop this Partfolk session from publishing with your wallet. Your drafts, pending operations and public records are kept.</p><div className="pf-actions"><Button variant="secondary" onClick={signOut}>Sign out</Button><Button variant="quiet" onClick={onChangeWallet}>Use another wallet</Button></div></div>}
    </section>
    <aside className="pf-account-context pf-stack"><h2>Find your own work</h2><OwnRecords address={address} /><p>Published records are public. Signing out does not make them private or remove them from Arkiv.</p><Link href={routeHref({ name: 'help', topic: 'publishing', returnTo })}>Understand public records and local drafts</Link></aside>
  </div>;
}

function OwnRecords({ address }: { address: string }) {
  const runtime = useApp();
  const [state, setState] = useState<{ projects?: number; offers?: number; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    setState({});
    const actor = runtime.session.getSnapshot().actor;
    if (!runtime.repository || actor?.kind !== 'wallet' || actor.address !== address) return;
    void Promise.all([runtime.repository.listProjects(actor), runtime.repository.listOwnPublishers(actor)]).then(([projects, publishers]) => {
      if (cancelled) return;
      const projectsComplete = projects.ok && projects.value.snapshot.completeness === 'complete';
      const publishersComplete = publishers.ok && publishers.value.snapshot.completeness === 'complete';
      const offers = publishersComplete && publishers.value.items.every(item => item.book.status === 'unique')
        ? publishers.value.items.reduce((count, item) => count + (item.book.status === 'unique' ? item.book.entity.payload.offers.length : 0), 0) : undefined;
      setState({ ...(projectsComplete ? { projects: projects.value.items.length } : {}), ...(offers !== undefined ? { offers } : {}),
        ...(!projectsComplete || !publishersComplete || offers === undefined ? { error: 'Some public records could not be fully read. Open your work to refresh and review it.' } : {}) });
    }).catch(() => { if (!cancelled) setState({ error: 'Your public work could not be read. Your local drafts are still available.' }); });
    return () => { cancelled = true; };
  }, [runtime, address]);
  return <><div className="pf-account-work-links"><Link href={routeHref({ name: 'my-events' })}>My events</Link><Link href={routeHref({ name: 'workspace' })}>My projects{state.projects !== undefined ? ` (${state.projects})` : ''}</Link><Link href={routeHref({ name: 'contributions' })}>My contributions{state.offers !== undefined ? ` (${state.offers} offers)` : ''}</Link><Link href={routeHref({ name: 'requests' })}>Requests for my contributions</Link></div>{state.error && <Notice tone="warning">{state.error}</Notice>}</>;
}

export function AccountPage({ binding, route }: RouteViewProps & { binding: PublicRuntimeBinding }) {
  const session = useAppSession();
  const [signInOpen, setSignInOpen] = useState(false);
  return <>{session.actor?.kind === 'wallet'
    ? <AccountForm key={session.actor.address.toLowerCase()} address={session.actor.address} binding={binding} onboarding={route.name === 'onboarding'} returnTo={returned(route)} onChangeWallet={() => { binding.disconnect(); setSignInOpen(true); }} />
    : <AccountGuest onSignIn={() => setSignInOpen(true)} />}
    <WalletSignInDialog binding={binding} open={signInOpen} onClose={() => setSignInOpen(false)} />
  </>;
}

function AccountGuest({ onSignIn }: { onSignIn: () => void }) {
  return <section className="pf-sheet pf-stack pf-account-main"><h1>Account and settings</h1><p>Sign in to recognize your wallet, set your preferences and find your events and contributions.</p><Button onClick={onSignIn}>Sign in with a wallet</Button><Link href={routeHref({ name: 'events' })}>Browse events</Link></section>;
}
