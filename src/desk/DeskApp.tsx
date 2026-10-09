import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppProvider, createAppRuntime, useApp, useAppSession } from '../app/context';
import { formatDateTime } from '../app/time';
import type { PublicRuntimeBinding } from '../app/network';
import type { Result } from '../data/types';
import type { ProjectAggregate, PublisherAggregate, PublicEntityKey } from '../domain/types';
import { ContributorWorkspace, ProjectAgreementPanel, PublisherContributions, RequestsInbox } from '../features/contributions';
import { BrandMark, Button, EmptyState, Field, Link, LoadingState, Notice, Select, StatusLabel } from '../ui';
import type { DeskNavigation } from './navigation';
import { deskHref, deskPath, invitationStatus, parsePublicTarget, type DeskRoute, type TargetKind } from './routes';

export function DeskApp({ binding, navigation }: { binding: PublicRuntimeBinding; navigation: DeskNavigation }) {
  return <AppProvider runtime={binding.runtime}><DeskShell binding={binding} navigation={navigation} /></AppProvider>;
}

function DeskShell({ binding, navigation }: { binding: PublicRuntimeBinding; navigation: DeskNavigation }) {
  const route = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const connection = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  const session = useAppSession();
  useEffect(() => {
    const read = () => { navigation.readHash(window.location.hash); document.getElementById('desk-main')?.focus({ preventScroll: true }); };
    if (!window.location.hash) window.history.replaceState(null, '', deskHref(route));
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [navigation]);
  const nav = [
    { name: 'contributions', label: 'My offers' }, { name: 'requests', label: 'Requests' }, { name: 'help', label: 'Help' },
  ] as const;
  const account = session.actor?.kind === 'wallet' ? session.actor.address : null;
  return <>
    <a className="pf-desk-skip" href="#desk-main" onClick={event => { event.preventDefault(); document.getElementById('desk-main')?.focus(); }}>Skip to main content</a>
    <header className="pf-desk-header pf-page">
      <a className="pf-brand" href={deskHref({ name: 'contributions' })}><BrandMark /><span className="pf-wordmark">Partfolk <span className="pf-desk-brand-detail">Partner Desk</span></span></a>
      <nav className="pf-desk-nav" aria-label="Partner Desk navigation">{nav.map(item => <a key={item.name} href={deskHref({ name: item.name })} aria-current={route.name === item.name || (route.name === 'publisher' && item.name === 'contributions') || (route.name === 'project' && item.name === 'requests') ? 'page' : undefined}>{item.label}</a>)}</nav>
    </header>
    <div className="pf-desk-mode"><div className="pf-page pf-desk-mode-inner"><span>Public test network · Arkiv Tiramisu</span><span>English · {account ? 'Owner account connected' : 'Read without a wallet'}</span></div></div>
    <main id="desk-main" tabIndex={-1} className="pf-page pf-desk-main pf-stack">
      <section className="pf-desk-account pf-sheet" aria-label="Account and publication mode"><div className="pf-stack pf-stack--compact"><p><strong>{account ? 'Your owner account' : 'Your independent partner workspace'}</strong></p>{account ? <p className="pf-desk-identity">{account}</p> : <p className="pf-secondary">Keep your offers current and review every project’s complete plan. Connect your own wallet when you are ready to publish.</p>}<p className="pf-secondary">Published names, availability, decisions, and reasons are public. Use only synthetic information for this test-network demonstration.</p></div><div className="pf-stack pf-stack--compact">{account ? <Button variant="secondary" onClick={binding.disconnect}>Disconnect account</Button> : <Button disabled={connection.connecting || !connection.hasProvider} disabledReason={!connection.hasProvider ? 'Install or enable an injected browser wallet to publish. Public reading remains available.' : undefined} onClick={() => void binding.connect()}>{connection.connecting ? 'Connecting…' : 'Connect owner wallet'}</Button>}<StatusLabel>{account ? 'Wallet controls authorship' : 'Public reading'}</StatusLabel></div></section>
      {connection.error && <Notice tone="warning" role="alert">{connection.error}</Notice>}
      {session.storageIssue && <Notice tone="warning">Browser storage could not safely save some data. Keep this invitation link and export any unfinished draft before leaving. Publishing requires an available transaction journal.</Notice>}
      {route.name !== 'help' && <PublicTargetOpener current={route} />}
      {route.name === 'contributions' ? <ContributorWorkspace /> : route.name === 'requests' ? <RequestsInbox /> : route.name === 'project' ? <ProjectView key={route.projectRoot} route={route} /> : route.name === 'publisher' ? <PublisherView key={route.publisherRoot} route={route} /> : route.name === 'help' ? <DeskHelp /> : <EmptyState title="This invitation cannot be opened" description="Use a public project or contribution identity, or a Partfolk invitation link. Local practice identities do not belong to this public Desk." actions={<Link href={deskHref({ name: 'contributions' })}>Return to My offers</Link>} />}
    </main>
    <footer className="pf-page pf-desk-footer"><div><strong>Partfolk Partner Desk</strong><p>Offers and decisions remain with their owners.</p></div><Link href={deskHref({ name: 'help' })}>Public data and agreements</Link><span>English · partfolk/1</span></footer>
  </>;
}

function PublicTargetOpener({ current }: { current: DeskRoute }) {
  const [input, setInput] = useState(''); const [kind, setKind] = useState<TargetKind>('project'); const [error, setError] = useState('');
  const submit = () => {
    const parsed = parsePublicTarget(input, kind);
    if (parsed.name === 'not-found') { setError('Enter a full public identity (0x followed by 64 hexadecimal characters) or a valid Partfolk project or contribution link.'); return; }
    setError(''); window.location.hash = deskPath(parsed);
  };
  return <details className="pf-desk-open" open={current.name === 'not-found' || undefined}><summary>Open an invitation or public offer</summary><form className="pf-stack" onSubmit={event => { event.preventDefault(); submit(); }}><div className="pf-desk-inputs"><Select label="If pasting an identity" value={kind} onChange={event => setKind(event.target.value as TargetKind)} options={[{ value: 'project', label: 'Project' }, { value: 'publisher', label: 'Contribution owner' }]} /><Field label="Public identity or invitation link" value={input} onChange={event => setInput(event.target.value)} error={error || undefined} maxLength={2048} spellCheck={false} autoCapitalize="off" hint="Links are read here. No other website is contacted to open the invitation." /></div><Button variant="secondary" type="submit">Open in Partner Desk</Button></form></details>;
}

function usePublicRecord<T>(key: PublicEntityKey, load: (key: PublicEntityKey) => Promise<Result<T>>) {
  const [record, setRecord] = useState<T | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const revision = ++generation.current; setLoading(true); setError('');
    try {
      const result = await load(key);
      if (generation.current !== revision) return;
      if (result.ok) setRecord(result.value);
      else setError(result.error.code === 'not_found' || result.error.code === 'expired' ? 'This public record is missing or has expired. Check the invitation with its owner.' : 'The current record could not be verified. Check the connection and refresh. No decision has been sent.');
    } catch { if (generation.current === revision) setError('The network could not verify this record. Refresh to try again. No decision has been sent.'); }
    finally { if (generation.current === revision) setLoading(false); }
  }, [key, load]);
  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh]);
  return { record, loading, error, refresh };
}

function ReadOnlyView({ children }: { children: ReactNode }) {
  const parent = useApp();
  const runtime = useMemo(() => {
    const view = createAppRuntime({ repository: parent.repository, storage: null, namespace: 'partfolk:desk-read-only', now: parent.now });
    view.session.setMode('public'); return view;
  }, [parent]);
  return <AppProvider runtime={runtime}>{children}</AppProvider>;
}

function ProjectView({ route }: { route: Extract<DeskRoute, { name: 'project' }> }) {
  const runtime = useApp();
  const load = useCallback((key: PublicEntityKey) => runtime.repository!.loadProject(key), [runtime.repository]);
  const { record: project, loading, error, refresh } = usePublicRecord(route.projectRoot, load);
  const title = project?.state.status === 'unique' ? project.state.entity.payload.recipe.title : 'Project invitation';
  const status = project ? invitationStatus(project, route.revision) : null;
  const historical = status !== 'current' && route.revision?.proposalKey ? project?.proposalHistory.find(record => record.key.toLowerCase() === route.revision!.proposalKey!.toLowerCase() && (!route.revision?.proposalHash || record.payload.proposalHash.toLowerCase() === route.revision.proposalHash.toLowerCase())) : undefined;
  const panel = project && <ProjectAgreementPanel project={error ? { ...project, snapshot: { ...project.snapshot, freshness: 'stale' } } : project} onRefresh={refresh} />;
  return <article className="pf-stack"><header className="pf-stack pf-stack--compact"><div className="pf-actions"><Link href={deskHref({ name: 'requests' })}>All requests</Link><StatusLabel>Public project</StatusLabel></div><h1>{title}</h1><p className="pf-desk-identity">{route.projectRoot}</p><p className="pf-secondary">Read every contribution, dependency, and owner’s decision before making your own promise.</p></header>
    {route.revision && <Notice title="This invitation names an exact revision"><dl className="pf-desk-references">{route.revision.activationKey && <><dt>Activation</dt><dd>{route.revision.activationKey}</dd></>}{route.revision.proposalKey && <><dt>Proposal</dt><dd>{route.revision.proposalKey}</dd></>}{route.revision.proposalHash && <><dt>Plan hash</dt><dd>{route.revision.proposalHash}</dd></>}</dl><p>The invitation stays selected when you connect or change accounts.</p></Notice>}
    {loading && <LoadingState title={project ? 'Refreshing the complete project' : 'Reading the complete project'} />}
    {error && <Notice tone="warning" role="alert" actions={<Button variant="secondary" disabled={loading} onClick={() => void refresh()}>Refresh project</Button>}>{error}{project && <p>Last-known content is shown read-only below.</p>}</Notice>}
    {project && status !== 'current' ? <><Notice tone="warning" title={status === 'different' ? 'This invitation is for a different revision' : 'The invited revision is not currently verifiable'}><p>No approval is offered for a changed or unavailable invitation. Earlier decisions never transfer to a new activation.</p><Link href={deskHref({ name: 'project', projectRoot: route.projectRoot, section: 'agreement' })}>Review the current activation instead</Link></Notice>{historical ? <section className="pf-sheet pf-stack"><h2>Invited proposal · historical, read-only</h2><p>{historical.payload.plan.outcome}</p><p>{historical.payload.plan.variant.title} · {historical.payload.plan.variant.timeZone}</p><p>{historical.payload.plan.instructions}</p><h3>Requirements and selected contributions</h3>{historical.payload.plan.variant.requirements.map(requirement => <section className="pf-desk-historical-row" key={requirement.id}><h4>{requirement.title}</h4><p>{requirement.quantity} {requirement.unit} · {formatDateTime(requirement.interval.start, historical.payload.plan.variant.timeZone)} – {formatDateTime(requirement.interval.end, historical.payload.plan.variant.timeZone)}</p><p>{requirement.instructions}</p>{historical.payload.plan.allocations.filter(allocation => allocation.requirementId === requirement.id).map(allocation => <p className="pf-desk-identity" key={allocation.id}>{allocation.publisherRoot} · {allocation.offerId} · {allocation.quantity} {allocation.unit}</p>)}</section>)}<h3>Invited runbook</h3>{historical.payload.plan.runbook.map(obligation => <section key={obligation.id} className="pf-desk-historical-row"><h4>{obligation.title}</h4><p className="pf-desk-identity">{obligation.publisherRoot}</p><p>{formatDateTime(obligation.interval.start, historical.payload.plan.variant.timeZone)} – {formatDateTime(obligation.interval.end, historical.payload.plan.variant.timeZone)}</p><p>{obligation.instructions}</p></section>)}</section> : <EmptyState title="The exact invited proposal is unavailable" description="Ask the coordinator for a current invitation. Missing historical records do not prove approval, cancellation, or equipment return." />}</> : project ? <>{route.section === 'plans' && <Notice title="Review the selected plan">The complete selected plan and any changes are below. The project coordinator calculates and proposes replacement plans; each current owner then reviews the new activation here.</Notice>}{route.section === 'runbook' && <Notice title="Review your obligations">The complete runbook is included below with its dependencies, equipment handovers, and returns. This Desk handles availability and plan decisions; execution reports are recorded in the project workspace.</Notice>}<div className="pf-sheet">{error ? <ReadOnlyView>{panel}</ReadOnlyView> : panel}</div></> : !loading && !error ? <EmptyState title="The project is not available" description="Check the public identity and try again." /> : null}
  </article>;
}

function PublisherView({ route }: { route: Extract<DeskRoute, { name: 'publisher' }> }) {
  const runtime = useApp();
  const load = useCallback((key: PublicEntityKey) => runtime.repository!.loadPublisher(key), [runtime.repository]);
  const { record, loading, error, refresh } = usePublicRecord<PublisherAggregate>(route.publisherRoot, load);
  const targetedOffer = record?.book.status === 'unique' && route.offerId ? record.book.entity.payload.offers.find(offer => offer.id === route.offerId) : null;
  const panel = record && <PublisherContributions publisher={error ? { ...record, snapshot: { ...record.snapshot, freshness: 'stale' } } : record} onRefresh={refresh} />;
  return <article className="pf-stack"><header className="pf-stack pf-stack--compact"><Link href={deskHref({ name: 'contributions' })}>My offers</Link><h1>Public contribution</h1><p className="pf-desk-identity">{route.publisherRoot}</p></header>{route.offerId && <Notice title={targetedOffer?.title ?? 'Invited offer'}>{targetedOffer ? `This invitation selects offer ${route.offerId}. Its full availability and the owner’s other commitments are below.` : `Offer ${route.offerId} is not currently verified in this owner's availability. Do not rely on an old invitation as a current promise.`}</Notice>}{loading && <LoadingState title="Reading owner availability" />}{error && <Notice tone="warning" role="alert" actions={<Button variant="secondary" disabled={loading} onClick={() => void refresh()}>Refresh contribution</Button>}>{error}{record && <p>Last-known content is shown read-only.</p>}</Notice>}{error ? <ReadOnlyView>{panel}</ReadOnlyView> : panel}</article>;
}

function DeskHelp() {
  return <article className="pf-sheet pf-stack pf-desk-help"><h1>Your offers, your decisions</h1><p>Partner Desk is a separate client for a library, workshop, or anyone who contributes time, places, and equipment. It reads and publishes the same owner-authored records as Partfolk’s project workspace.</p><section className="pf-stack pf-stack--compact" id="offers"><h2>Keep your availability current</h2><p>Connect your own account, create a contribution identity, and add the resources, quantities, and times you can offer. Check “Promised across projects” before changing availability. A public name is a label; it does not prove someone’s real identity or grant access to their records.</p><Link href={deskHref({ name: 'contributions' })}>Manage My offers</Link></section><section className="pf-stack pf-stack--compact" id="agreements"><h2>Read the complete request</h2><p>Open a project invitation or find incoming requests with your owner account. Review the whole plan and your obligations. Acceptance belongs to one exact activation. When a plan changes, every current owner must agree again, including people whose assignments stayed the same.</p><p>You may decline or withdraw your own contribution. Withdrawal makes the affected plan need review or replacement; it does not erase earlier work or unresolved equipment custody.</p><Link href={deskHref({ name: 'requests' })}>Review requests</Link></section><section className="pf-stack pf-stack--compact" id="public-data"><h2>Public means public</h2><p>The test-network demonstration uses synthetic names, descriptions, and project details. Do not enter personal contact information, sensitive access instructions, or anything private. A hidden invitation link does not make a record private. Expiration stops a live record being available; it does not erase public copies or transaction history.</p></section><section className="pf-stack pf-stack--compact" id="verification"><h2>Check uncertain results first</h2><p>After an interrupted publication, use its “Check transaction” action before trying again. A timeout may happen after the network accepted the transaction. Conflicting, missing, or expired records remain visible as problems; the Desk cannot choose a winner or silently renew an old approval.</p><p>A possible plan is not an agreement. Agreement is an owner statement, not a guarantee of attendance, a physical handover, or an atomic booking across organizations.</p></section><section className="pf-stack pf-stack--compact" id="independence"><h2>Independent clients, shared records</h2><p>This client talks directly to Arkiv Tiramisu and does not need the project workspace’s server. Both clients still rely on the same public network. Refresh a project in either client to verify the current availability and decisions after a confirmed change.</p><p>The open data format is partfolk/1. Wallet authorship and current owner authority are checked before records can contribute to agreement. Your wallet signs your own public actions; the Desk never asks for a private key.</p></section></article>;
}
