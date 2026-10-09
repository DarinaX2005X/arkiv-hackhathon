import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppProvider, createAppRuntime, useApp, useAppSession } from '../app/context';
import { formatDateTime } from '../app/time';
import type { PublicRuntimeBinding } from '../app/network';
import type { Result } from '../data/types';
import type { PublisherAggregate, PublicEntityKey, Snapshot } from '../domain/types';
import { ContributorWorkspace, ProjectAgreementPanel, PublisherContributions, RequestsInbox } from '../features/contributions';
import { ProjectNeeds } from '../features/projects/ProjectNeeds';
import { createProjectReader } from '../features/projects/projectReader';
import { BrandMark, Button, EmptyState, Field, Link, LoadingState, Notice, Select } from '../ui';
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
    { name: 'contributions', label: 'My contributions' }, { name: 'requests', label: 'Requests' }, { name: 'help', label: 'Help' },
  ] as const;
  const account = session.actor?.kind === 'wallet' ? session.actor.address : null;
  return <>
    <a className="pf-desk-skip" href="#desk-main" onClick={event => { event.preventDefault(); document.getElementById('desk-main')?.focus(); }}>Skip to main content</a>
    <header className="pf-desk-header pf-page">
      <div className="pf-desk-brand-lockup"><a className="pf-brand" href={deskHref({ name: 'contributions' })}><BrandMark /><span className="pf-wordmark">Partfolk</span></a><span className="pf-desk-brand-detail">For contributors</span></div>
      <nav className="pf-desk-nav" aria-label="Contributor navigation">{nav.map(item => <a key={item.name} href={deskHref({ name: item.name })} aria-current={route.name === item.name || (route.name === 'publisher' && item.name === 'contributions') || (route.name === 'project' && item.name === 'requests') ? 'page' : undefined}>{item.label}</a>)}</nav>
    </header>
    <main id="desk-main" tabIndex={-1} className="pf-page pf-desk-main pf-stack">
      <div className="pf-desk-tools">
        {route.name !== 'help' && <PublicTargetOpener current={route} />}
        <details className="pf-desk-account">
          <summary>{account ? 'Account connected' : 'Connect your account'}</summary>
          <div className="pf-desk-account-body pf-stack pf-stack--compact">
            <p>{account ? 'Your account can update your offers and respond to project plans.' : 'Open invitations and read plans first. Connect when you want to share an offer or respond.'}</p>
            <div className="pf-actions">{account
              ? <Button variant="secondary" onClick={binding.disconnect}>Disconnect account</Button>
              : <Button disabled={connection.connecting || !connection.hasProvider} disabledReason={!connection.hasProvider ? 'Enable a browser wallet to connect. You can still open invitations and read plans.' : undefined} onClick={() => void binding.connect()}>{connection.connecting ? 'Connecting…' : 'Connect wallet'}</Button>}
            </div>
            <p className="pf-field-message">Offers and decisions are public. Use example details while trying this demonstration.</p>
            <details><summary>Account and network details</summary><dl className="pf-desk-references">{account && <><dt>Connected address</dt><dd>{account}</dd></>}<dt>Network</dt><dd>Arkiv Tiramisu public test network</dd><dt>Data format</dt><dd>partfolk/1</dd></dl><p>Your wallet signs only your own actions. An account connection does not confirm a person’s identity.</p></details>
          </div>
        </details>
      </div>
      {connection.error && <Notice tone="warning" role="alert">{connection.error}</Notice>}
      {session.storageIssue && <Notice tone="warning">This browser could not save your latest changes safely. Keep the invitation link and export unfinished drafts before leaving. Check the result of any interrupted save before trying again.</Notice>}
      {route.name === 'contributions' ? <ContributorWorkspace /> : route.name === 'requests' ? <RequestsInbox /> : route.name === 'project' ? <ProjectView key={route.projectRoot} route={route} /> : route.name === 'publisher' ? <PublisherView key={route.publisherRoot} route={route} /> : route.name === 'help' ? <DeskHelp /> : <EmptyState title="This invitation cannot be opened" description="Ask the organizer for a shared Partfolk invitation, then paste it above. A local practice project can only be opened where it was created." actions={<Link href={deskHref({ name: 'contributions' })}>Go to my contributions</Link>} />}
    </main>
    <footer className="pf-page pf-desk-footer"><div><strong>Partfolk</strong><p>Your contributions, your decisions.</p></div><Link href={deskHref({ name: 'help' })}>How contributions and agreements work</Link></footer>
  </>;
}

function PublicTargetOpener({ current }: { current: DeskRoute }) {
  const [input, setInput] = useState(''); const [kind, setKind] = useState<TargetKind>('project'); const [error, setError] = useState('');
  const submit = () => {
    const parsed = parsePublicTarget(input, kind);
    if (parsed.name === 'not-found') { setError('Paste a shared Partfolk project or contribution link. If you have a public ID, choose its type below.'); return; }
    setError(''); window.location.hash = deskPath(parsed);
  };
  const form = <form className="pf-desk-invitation-form" onSubmit={event => { event.preventDefault(); submit(); }}>
    <div className="pf-desk-inputs"><Field label="Project invitation or contribution link" placeholder="Paste your Partfolk invitation link" value={input} onChange={event => setInput(event.target.value)} error={error || undefined} maxLength={2048} spellCheck={false} autoCapitalize="off" /><Button type="submit">Open invitation</Button></div>
    <details className="pf-desk-reference-entry"><summary>Using a public ID instead?</summary><Select label="This ID belongs to" value={kind} onChange={event => setKind(event.target.value as TargetKind)} options={[{ value: 'project', label: 'A project' }, { value: 'publisher', label: 'A contribution owner' }]} hint="Paste the complete ID, beginning with 0x, in the invitation field above." /></details>
  </form>;
  return current.name === 'project' || current.name === 'publisher'
    ? <details className="pf-desk-open pf-desk-open--compact"><summary>Open another invitation</summary>{form}</details>
    : <section className="pf-desk-open" aria-label="Open a shared invitation">{form}</section>;
}

function usePublicRecord<T extends { snapshot: Snapshot }>(key: PublicEntityKey, load: (key: PublicEntityKey, signal: AbortSignal) => Promise<Result<T>>) {
  const runtime = useApp();
  const reader = useMemo(() => createProjectReader(signal => load(key, signal), runtime.now), [key, load, runtime.now]);
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => {
    reader.start(true, typeof window === 'undefined' ? undefined : window);
    return reader.stop;
  }, [reader]);
  const error = !state.error ? '' : state.error.code === 'not_found' || state.error.code === 'expired'
    ? 'This public record is missing or has expired. Check the invitation with its owner.'
    : 'The current record could not be verified. Check the connection and refresh. No decision has been sent.';
  return { record: state.project, loading: state.loading, error, refresh: reader.refresh };
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
  const load = useCallback((key: PublicEntityKey, signal: AbortSignal) => runtime.repository!.loadProject(key, { signal }), [runtime.repository]);
  const { record: project, loading, error, refresh } = usePublicRecord(route.projectRoot, load);
  const title = project?.state.status === 'unique' ? project.state.entity.payload.recipe.title : 'Project invitation';
  const visibleProject = project && error ? { ...project, snapshot: { ...project.snapshot, freshness: 'stale' as const } } : project;
  const status = project ? invitationStatus(project, route.revision) : null;
  const historical = status !== 'current' && route.revision?.proposalKey ? project?.proposalHistory.find(record => record.key.toLowerCase() === route.revision!.proposalKey!.toLowerCase() && (!route.revision?.proposalHash || record.payload.proposalHash.toLowerCase() === route.revision.proposalHash.toLowerCase())) : undefined;
  const panel = visibleProject && <ProjectAgreementPanel project={visibleProject} onRefresh={refresh} />;
  const contributorName = (root: string) => {
    const publisher = project?.publishers.find(item => item.root.key === root);
    return publisher?.book.status === 'unique' ? publisher.book.entity.payload.name : 'Contributor';
  };
  return <article className="pf-stack">
    <header className="pf-stack pf-stack--compact"><h1>{title}</h1><p className="pf-secondary">See what the project needs, then review your part before agreeing.</p><Link href={deskHref({ name: 'requests' })}>All requests</Link></header>
    <details className="pf-desk-record-details"><summary>Invitation details</summary><dl className="pf-desk-references"><dt>Project reference</dt><dd>{route.projectRoot}</dd>{route.revision?.activationKey && <><dt>Activation reference</dt><dd>{route.revision.activationKey}</dd></>}{route.revision?.proposalKey && <><dt>Plan reference</dt><dd>{route.revision.proposalKey}</dd></>}{route.revision?.proposalHash && <><dt>Plan hash</dt><dd>{route.revision.proposalHash}</dd></>}</dl><p>This invitation stays selected when you connect or change accounts.</p></details>
    {loading && <LoadingState title={project ? 'Refreshing the complete project' : 'Reading the complete project'} />}
    {error && <Notice tone="warning" role="alert" actions={<Button variant="secondary" disabled={loading} onClick={() => void refresh()}>Refresh project</Button>}>{error}{project && <p>Last-known content is shown read-only below.</p>}</Notice>}
    {visibleProject && <ProjectNeeds project={visibleProject} />}
    {project && status !== 'current' ? <>
      <Notice tone="warning" title={status === 'different' ? 'This invitation names a different plan' : 'This plan cannot currently be verified'}><p>You cannot approve this version here. Each new plan needs fresh agreement from its contributors.</p><Link href={deskHref({ name: 'project', projectRoot: route.projectRoot, section: 'agreement' })}>Review the current plan</Link></Notice>
      {historical ? <section className="pf-sheet pf-stack">
        <header className="pf-stack pf-stack--compact"><h2>The plan in your invitation</h2><p>This version is available to read only. Open the current plan to respond.</p><p>{historical.payload.plan.outcome}</p><h3>{historical.payload.plan.variant.title}</h3><p className="pf-secondary">Times shown in {historical.payload.plan.variant.timeZone}.</p>{historical.payload.plan.instructions && <p>{historical.payload.plan.instructions}</p>}</header>
        <h3>What was needed and who offered it</h3>
        {historical.payload.plan.variant.requirements.map(requirement => <section className="pf-desk-historical-row" key={requirement.id}>
          <h4>{requirement.title}</h4><p>{requirement.quantity} {requirement.unit}</p><p>{formatDateTime(requirement.interval.start, historical.payload.plan.variant.timeZone)} to {formatDateTime(requirement.interval.end, historical.payload.plan.variant.timeZone)}</p>{requirement.instructions && <p>{requirement.instructions}</p>}
          {historical.payload.plan.allocations.filter(allocation => allocation.requirementId === requirement.id).map(allocation => <p key={allocation.id}>{contributorName(allocation.publisherRoot)}: {allocation.quantity} {allocation.unit}</p>)}
        </section>)}
        <h3>Run sheet for this version</h3>
        {historical.payload.plan.runbook.map(obligation => <section key={obligation.id} className="pf-desk-historical-row"><h4>{obligation.title}</h4><p>{contributorName(obligation.publisherRoot)}</p><p>{formatDateTime(obligation.interval.start, historical.payload.plan.variant.timeZone)} to {formatDateTime(obligation.interval.end, historical.payload.plan.variant.timeZone)}</p>{obligation.instructions && <p>{obligation.instructions}</p>}</section>)}
        <details><summary>Contribution references for this version</summary><dl className="pf-desk-references">{historical.payload.plan.allocations.map(allocation => <div key={allocation.id}><dt>{allocation.offerId}</dt><dd>{allocation.publisherRoot}</dd></div>)}{historical.payload.plan.runbook.map(obligation => <div key={`task:${obligation.id}`}><dt>Contributor for {obligation.title}</dt><dd>{obligation.publisherRoot}</dd></div>)}</dl></details>
      </section> : <EmptyState title="The invited plan is unavailable" description="Ask the organizer for a current invitation. Missing past records do not confirm approval, cancellation, or equipment return." />}
    </> : project ? <>
      {route.section === 'plans' && <Notice title="Review the proposed plan">Read the assignments and changes below. The organizer proposes replacements, and each contributor decides whether to take part.</Notice>}
      {route.section === 'runbook' && <Notice title="Check your part in the day">The run sheet below includes tasks, handovers, and returns. Record completed work in the project workspace.</Notice>}
      <div className="pf-sheet">{error ? <ReadOnlyView>{panel}</ReadOnlyView> : panel}</div>
    </> : !loading && !error ? <EmptyState title="The project is not available" description="Check the invitation and try again." /> : null}
  </article>;
}

function PublisherView({ route }: { route: Extract<DeskRoute, { name: 'publisher' }> }) {
  const runtime = useApp();
  const load = useCallback((key: PublicEntityKey, signal: AbortSignal) => runtime.repository!.loadPublisher(key, { signal }), [runtime.repository]);
  const { record, loading, error, refresh } = usePublicRecord<PublisherAggregate>(route.publisherRoot, load);
  const targetedOffer = record?.book.status === 'unique' && route.offerId ? record.book.entity.payload.offers.find(offer => offer.id === route.offerId) : null;
  const panel = record && <PublisherContributions publisher={error ? { ...record, snapshot: { ...record.snapshot, freshness: 'stale' } } : record} onRefresh={refresh} />;
  const title = record?.book.status === 'unique' ? record.book.entity.payload.name : 'Shared contribution';
  return <article className="pf-stack">
    <header className="pf-stack pf-stack--compact"><h1>{title}</h1><Link href={deskHref({ name: 'contributions' })}>My contributions</Link></header>
    {route.offerId && <Notice tone={targetedOffer ? 'neutral' : 'warning'} title={targetedOffer?.title ?? 'This offer needs checking'}>{targetedOffer ? 'Check when this offer is available and what its owner has already promised.' : 'The invited offer is not currently listed as available. Check with its owner before relying on it.'}</Notice>}
    {loading && <LoadingState title="Reading owner availability" />}
    {error && <Notice tone="warning" role="alert" actions={<Button variant="secondary" disabled={loading} onClick={() => void refresh()}>Refresh contribution</Button>}>{error}{record && <p>Last-known content is shown read-only.</p>}</Notice>}
    {error ? <ReadOnlyView>{panel}</ReadOnlyView> : panel}
    <details className="pf-desk-record-details"><summary>Contribution references</summary><dl className="pf-desk-references"><dt>Owner reference</dt><dd>{route.publisherRoot}</dd>{route.offerId && <><dt>Offer reference</dt><dd>{route.offerId}</dd></>}</dl></details>
  </article>;
}

function DeskHelp() {
  return <article className="pf-sheet pf-stack pf-desk-help">
    <header className="pf-stack pf-stack--compact"><h1>Bring your part to the project</h1><p>Use Partfolk to offer your time, a place, or equipment. Open an invitation to see what is needed and decide what you can promise.</p></header>
    <section className="pf-stack pf-stack--compact" id="offers"><h2>Share what you can offer</h2><p>Connect your account, add your resources, and choose when they are available. Check what you have already promised before changing your availability.</p><Link href={deskHref({ name: 'contributions' })}>Manage my contributions</Link></section>
    <section className="pf-stack pf-stack--compact" id="agreements"><h2>Review the whole plan</h2><p>Open a project invitation or find incoming requests. Check the date, the other contributions, and your own tasks before agreeing. When the plan changes, everyone must confirm the new version, even if their own task stayed the same.</p><p>You can decline a request or withdraw your contribution. The organizer will need to review or replace your part. Tasks already completed and equipment still due back remain recorded.</p><Link href={deskHref({ name: 'requests' })}>Review requests</Link></section>
    <section className="pf-stack pf-stack--compact" id="public-data"><h2>Choose what you share</h2><p>Offers, project plans, and decisions here are public. Use example names and details while trying this demonstration. Keep private contact details and access instructions out of public offers.</p><details><summary>What public records include</summary><p>Keeping an invitation link private does not make its records private. When a record expires, public copies and transaction history can still exist. A public display name does not verify a person’s identity or give anyone control of their account.</p></details></section>
    <section className="pf-stack pf-stack--compact" id="verification"><h2>If a save is interrupted</h2><p>Check the result before trying again. A request may have reached the network even when a confirmation did not arrive. Partfolk keeps uncertain results visible so that you can verify what happened.</p><p>A proposed plan still needs everyone’s agreement. Agreeing to a plan does not record attendance, complete a task, or confirm an equipment handover.</p></section>
    <details id="independence" className="pf-desk-record-details"><summary>How shared records stay independent</summary><div className="pf-stack pf-stack--compact"><p>This contributor view connects directly to Arkiv Tiramisu. It does not need the project workspace’s server, and both views use the same public records. Refresh either view to check current offers and decisions.</p><p>The open format is partfolk/1. Authorship and current account authority are verified before an agreement is shown. Your wallet signs your own actions; Partfolk never asks for a private key.</p><p>Uncertain, conflicting, missing, or expired records cannot silently become an approval. An agreement is a contributor’s statement, not an atomic booking across organizations.</p></div></details>
  </article>;
}
