import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { RouteViewProps } from '../../app/App';
import { useApp, useAppSession } from '../../app/context';
import type { PublicRuntimeBinding } from '../../app/network';
import { routeHref, routePath, type Route } from '../../app/routes';
import { Button, Field, Link, Notice, Select } from '../../ui';
import { accountReturnRoute, createAccountPreferences, readAccountPreferences, type AccountPreferences } from './account';

const navigate = (route: Route) => { window.location.hash = routePath(route); };
const returned = (route: Route) => 'returnTo' in route ? route.returnTo : undefined;
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function SignInPage({ binding, route }: RouteViewProps & { binding: PublicRuntimeBinding }) {
  const runtime = useApp(), session = useAppSession();
  const connection = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  const returnTo = returned(route);
  const continueToWork = () => {
    const current = runtime.session.getSnapshot();
    if (current.actor?.kind !== 'wallet') return;
    const preferences = readAccountPreferences(createAccountPreferences(runtime, current.actor.address).load()).value;
    navigate(preferences.setupComplete ? accountReturnRoute(returnTo, preferences) : { name: 'onboarding', returnTo });
  };
  const connect = async () => {
    const destination = runtime.session.getSnapshot().destination;
    if (await binding.connect() && runtime.session.getSnapshot().destination === destination
      && window.location.hash === `#${destination}`) continueToWork();
  };
  return <div className="pf-account-layout">
    <section className="pf-sheet pf-stack pf-account-main">
      <h1>Sign in to your work</h1>
      <p>Your wallet identifies the projects, offers and decisions you own. Return with the same wallet to read them from Arkiv on another device.</p>
      {session.actor?.kind === 'wallet' ? <><p className="pf-account-address">Connected as {session.actor.address}</p><Button onClick={continueToWork}>Continue to my work</Button></>
        : <Button disabled={connection.connecting} onClick={() => { void connect(); }}>{connection.connecting ? 'Waiting for your wallet…' : 'Sign in with a wallet'}</Button>}
      {connection.error && <Notice tone="warning" role="alert" title="Sign-in needs your attention">{connection.error}</Notice>}
      {!connection.hasProvider && <p>Open Partfolk in a browser with an Ethereum-compatible wallet, then reload this page to sign in. You can keep reading public projects here.</p>}
      <p className="pf-secondary">Connecting requests your wallet address and Arkiv Tiramisu network. It does not publish a profile, create a project or approve a plan.</p>
      <div className="pf-actions"><Button variant="quiet" onClick={() => { if (connection.connecting) binding.disconnect(); navigate(accountReturnRoute(returnTo)); }}>{session.actor ? 'Return to my work' : 'Return without signing in'}</Button><Link href={routeHref({ name: 'help', topic: 'publishing', returnTo })}>How public data works</Link></div>
    </section>
    <aside className="pf-account-context pf-stack"><h2>Your part stays yours</h2><p>Only you can publish your offers and confirm your contribution. A display label is not proof of a person's real identity.</p><p>Public records can be read without signing in. Drafts and device settings stay in this browser; export drafts before moving devices.</p></aside>
  </div>;
}

function AccountForm({ address, onboarding, returnTo, binding }: { address: string; onboarding: boolean; returnTo?: string; binding: PublicRuntimeBinding }) {
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
  const signOut = () => { binding.disconnect(); navigate({ name: 'sign-in', returnTo: routePath(accountReturnRoute(returnTo, preferences)) }); };
  return <div className="pf-account-layout">
    <section className="pf-sheet pf-stack pf-account-main">
      <h1>{onboarding ? 'Make this your workspace' : 'Account and settings'}</h1>
      <p>{onboarding ? 'Choose where to begin. These optional settings are saved only on this device.' : 'Your wallet owns your public work. These preferences belong to this browser.'}</p>
      <div className="pf-account-identity"><strong>Connected wallet</strong><span className="pf-account-address">{address}</span><span className="pf-secondary">Arkiv Tiramisu</span></div>
      <form className="pf-stack" onSubmit={event => { event.preventDefault(); save(); }}>
        <Field label="Label on this device (optional)" value={preferences.label} maxLength={80} autoComplete="off" onChange={event => update({ ...preferences, label: event.target.value.replace(/[\u0000-\u001f]/g, '') })} hint="For recognizing this wallet here. This is not published as a public profile." />
        <Select label="Start here after signing in" value={preferences.defaultDestination} onChange={event => update({ ...preferences, defaultDestination: event.target.value as AccountPreferences['defaultDestination'] })} options={[{ value: 'workspace', label: 'My projects' }, { value: 'contributions', label: 'My contributions' }]} hint="An invitation or unfinished action always returns to its original destination." />
        {issue && <Notice tone="warning" title="These settings have not been saved">Your entries remain on this page. {store.exportRecovery() !== null ? 'Existing unreadable settings were kept. Export them before attempting recovery.' : 'Browser storage is unavailable or full. Export your settings before leaving.'}<div className="pf-actions"><Button variant="secondary" onClick={() => download('partfolk-device-settings.json', store.export(preferences))}>Export settings</Button>{store.exportRecovery() !== null && <Button variant="quiet" onClick={() => download('partfolk-settings-recovery.txt', store.exportRecovery()!)}>Export original data</Button>}</div></Notice>}
        {saved && <p role="status">Settings saved on this device.</p>}
        <div className="pf-actions"><Button type="submit">{onboarding ? 'Save and continue' : 'Save settings'}</Button>{onboarding ? <Button variant="quiet" onClick={() => { const result = store.save({ ...preferences, setupComplete: true }); setIssue(result.issue); navigate(accountReturnRoute(returnTo, preferences)); }}>Skip setup</Button> : <Link href={routeHref(accountReturnRoute(returnTo, preferences))}>Return to my work</Link>}</div>
      </form>
      {!onboarding && <div className="pf-account-signout pf-stack"><h2>Session</h2><p>Sign out to stop this Partfolk session from publishing with your wallet. Your drafts, pending operations and public records are kept.</p><div className="pf-actions"><Button variant="secondary" onClick={signOut}>Sign out</Button><Button variant="quiet" onClick={() => { binding.disconnect(); navigate({ name: 'sign-in', returnTo: routePath(accountReturnRoute(returnTo, preferences)) }); }}>Use another wallet</Button></div></div>}
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
      const offers = publishers.ok && publishers.value.items.every(item => item.book.status === 'unique')
        ? publishers.value.items.reduce((count, item) => count + (item.book.status === 'unique' ? item.book.entity.payload.offers.length : 0), 0) : undefined;
      setState({ ...(projects.ok ? { projects: projects.value.items.length } : {}), ...(offers !== undefined ? { offers } : {}),
        ...(!projects.ok || !publishers.ok || projects.value.snapshot.completeness !== 'complete' || publishers.value.snapshot.completeness !== 'complete' ? { error: 'Some public records could not be fully read. Open your work to refresh and review it.' } : {}) });
    }).catch(() => { if (!cancelled) setState({ error: 'Your public work could not be read. Your local drafts are still available.' }); });
    return () => { cancelled = true; };
  }, [runtime, address]);
  return <><div className="pf-account-work-links"><Link href={routeHref({ name: 'workspace' })}>My projects{state.projects !== undefined ? ` (${state.projects})` : ''}</Link><Link href={routeHref({ name: 'contributions' })}>My contributions{state.offers !== undefined ? ` (${state.offers} offers)` : ''}</Link><Link href={routeHref({ name: 'requests' })}>Requests for my contributions</Link></div>{state.error && <Notice tone="warning">{state.error}</Notice>}</>;
}

export function AccountPage({ binding, route }: RouteViewProps & { binding: PublicRuntimeBinding }) {
  const session = useAppSession();
  if (session.actor?.kind !== 'wallet') return <SignInPage binding={binding} route={route} />;
  return <AccountForm key={session.actor.address.toLowerCase()} address={session.actor.address} binding={binding} onboarding={route.name === 'onboarding'} returnTo={returned(route)} />;
}
