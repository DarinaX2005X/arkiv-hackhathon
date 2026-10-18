import { useEffect, useRef, useState } from 'react';
import { formatDateTime, routeHref, useApp, useAppSession, type RouteViewProps } from '../../app';
import type { DiscoveryLink } from '../../data/types';
import type { EntityKey, ProjectAggregate, PublisherAggregate } from '../../domain/types';
import { Button, EmptyState, Field, Link, LoadingState, Notice, StatusLabel } from '../../ui';
import { actorScope, isContributionTarget, publisherName } from './model';
import { ProjectAgreementPanel } from './Agreement';
import { useReadGuard } from './shared';
import { contributionProjectTarget } from './invitation';
import './contributions.css';

export function requestProjects(publishers: PublisherAggregate[], links: DiscoveryLink[]): EntityKey[] {
  return [...new Set([...links.map(link => link.entity.payload.projectRoot), ...publishers.flatMap(p => p.book.status === 'unique'
    ? [...p.book.entity.payload.grants.map(g => g.projectRoot), ...p.book.entity.payload.decisions.map(d => d.projectRoot), ...p.book.entity.payload.custodyHolds.map(h => h.projectRoot)] : [])])];
}
export function RequestsPage(_props: RouteViewProps) { return <RequestsInbox />; }
export function RequestsInbox({ onSignIn }: { onSignIn?: () => void } = {}) {
  const runtime = useApp(); const session = useAppSession();
  const startInboxRead = useReadGuard(); const startProjectRead = useReadGuard();
  const [links, setLinks] = useState<DiscoveryLink[]>([]); const [owners, setOwners] = useState<PublisherAggregate[]>([]);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [identity, setIdentity] = useState(''); const [project, setProject] = useState<ProjectAggregate | null>(null);
  const [identityTouched, setIdentityTouched] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, { title: string; option: string }>>({});
  const selectedPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (project) { selectedPanel.current?.scrollIntoView({ block: 'start' }); selectedPanel.current?.focus({ preventScroll: true }); } }, [project?.root.key]);
  const readRequests = async () => {
    if (!runtime.repository || !session.actor) return; const current = startInboxRead(); setLoading(true); setError('');
    try {
      const own = await runtime.repository.listOwnPublishers(session.actor); if (!own.ok) throw new Error('Your contributions could not be read. Some requests may be missing.');
      if (!current()) return; setOwners(own.value.items);
      const results = await Promise.allSettled(own.value.items.map(p => runtime.repository!.listRequests(p.root.key)));
      if (!current()) return; const next: DiscoveryLink[] = []; let incomplete = own.value.snapshot.completeness !== 'complete' || own.value.diagnostics.length > 0;
      for (const result of results) { if (result.status !== 'fulfilled' || !result.value.ok) { incomplete = true; continue; } next.push(...result.value.value.items); incomplete ||= result.value.value.snapshot.completeness !== 'complete' || result.value.value.diagnostics.length > 0; }
      setLinks(next);
      if (incomplete) setError('Some request records could not be read. This inbox is incomplete; known project commitments remain listed below. You can also open a project directly.');
      // Name hydration is a convenience. Missing summaries never remove a request or prove an empty inbox.
      const projectKeys = requestProjects(own.value.items, next).slice(0, 8);
      const projects = await Promise.allSettled(projectKeys.map(key => runtime.repository!.loadProject(key)));
      if (!current()) return;
      const labels: Record<string, { title: string; option: string }> = {};
      projects.forEach((result, index) => { if (result.status !== 'fulfilled' || !result.value.ok) return;
        const p = result.value.value; const plan = p.proposal?.payload.plan;
        labels[projectKeys[index]!] = { title: p.state.status === 'unique' ? p.state.entity.payload.recipe.title : `Project ${p.root.key}`,
          option: plan ? `${plan.variant.title}, proposed ${formatDateTime(p.proposal!.payload.createdAt, plan.variant.timeZone)}` : 'No current complete plan' };
      });
      setSummaries(labels);
    } catch (caught) { if (current()) setError(caught instanceof Error ? caught.message : 'The request inbox could not be read.'); } finally { if (current()) setLoading(false); }
  };
  const readProject = async (key: EntityKey) => {
    if (!isContributionTarget(key, session.mode)) { setError(session.mode === 'public' ? 'Enter a complete public project identity beginning with 0x.' : 'Enter a local project identity beginning with local:.'); return; }
    if (!runtime.repository) { setError('The selected data source is unavailable.'); return; }
    const current = startProjectRead(); setLoading(true); setError('');
    try {
      const result = await runtime.repository.loadProject(key); if (!current()) return;
      if (!result.ok) throw new Error('Current project unavailable');
      setProject(result.value);
    } catch {
      if (!current()) return;
      setProject(previous => previous ? { ...previous, snapshot: { ...previous.snapshot, freshness: 'stale', completeness: 'incomplete', reasons: [...previous.snapshot.reasons, { code: 'rpc_error' }] } } : null);
      setError('This project could not be read. Any retained plan below is now unverified. Check the invitation or try again.');
    } finally { if (current()) setLoading(false); }
  };
  useEffect(() => {
    setLinks([]); setOwners([]); setSummaries({}); setError(''); setLoading(false); void readRequests();
    if (project && isContributionTarget(project.root.key, session.mode)) {
      setProject({ ...project, snapshot: { ...project.snapshot, freshness: 'stale' } });
      void readProject(project.root.key);
    } else setProject(null);
  }, [runtime.repository, actorScope(session.actor), session.mode]);
  const known = requestProjects(owners, links);
  const pastedTarget = contributionProjectTarget(identity, session.mode);
  const invitationError = identityTouched && !pastedTarget
    ? session.mode === 'public' ? 'Paste a Partfolk project link or a complete public project reference beginning with 0x.'
      : 'Paste a Partfolk project link or a local project reference beginning with local:.' : undefined;
  return <div className="pf-stack pf-requests-workspace">
    <header className="pf-contribution-page-heading"><div><h1>Requests</h1><p>See where your help is needed, read the whole plan, and decide what you can promise.</p></div><Button variant="secondary" disabled={loading || !session.actor} onClick={() => void readRequests()}>Refresh requests</Button></header>
    {!session.actor && <Notice title="Your requests follow your wallet"><p>Sign in to find plans sent to your contribution profiles. A shared project can be read below without signing in.</p>{onSignIn ? <Button variant="secondary" onClick={onSignIn}>Sign in with your wallet</Button> : <Link href={routeHref({ name: 'sign-in', returnTo: session.destination })}>Sign in with your wallet</Link>}</Notice>}
    {error && <Notice tone="warning" role="alert">{error}</Notice>}
    <form className="pf-sheet pf-request-invitation" onSubmit={event => { event.preventDefault(); setIdentityTouched(true); if (pastedTarget) void readProject(pastedTarget); }}><div><h2>Have an invitation?</h2><p className="pf-secondary">Open the current plan and check what has changed before making a decision.</p></div><Field label="Project invitation or reference" value={identity} error={invitationError} onBlur={() => setIdentityTouched(true)} onChange={e => setIdentity(e.target.value)} placeholder="Paste a Partfolk project link" /><Button type="submit" variant="secondary" disabled={loading}>Open current plan</Button></form>
    {loading && <LoadingState title="Reading current requests" />}
    {known.length > 0 && <section className="pf-stack"><div className="pf-contribution-section-heading"><h2>Projects asking for your part</h2><p className="pf-secondary">{known.length} project{known.length === 1 ? '' : 's'}</p></div><div className="pf-request-grid">{known.map(key => {
      const invitations = links.filter(link => link.entity.payload.projectRoot === key);
      const current = invitations.filter(link => link.status !== 'historical');
      const contributorRoots = [...new Set(invitations.map(link => link.entity.payload.publisherRoot))];
      const contributorNames = contributorRoots.map(root => publisherName(owners.find(p => p.root.key === root), root));
      const hasCustody = owners.some(owner => owner.book.status === 'unique' && owner.book.entity.payload.custodyHolds.some(hold => hold.projectRoot === key && hold.status === 'outstanding'));
      return <article className={`pf-sheet pf-request-card${project?.root.key === key ? ' is-selected' : ''}`} key={key}>
        <div className="pf-actions"><StatusLabel tone={current.length ? 'warning' : 'neutral'}>{current.length ? 'Plan to review' : invitations.length ? 'Earlier invitation' : 'Your commitment'}</StatusLabel>{hasCustody && <StatusLabel tone="warning">Return unresolved</StatusLabel>}</div>
        <h3>{summaries[key]?.title ?? 'Project invitation'}</h3>
        {summaries[key]?.option && <p className="pf-secondary">{summaries[key]?.option}</p>}
        {contributorNames.length > 0 && <p className="pf-request-recipient">For {contributorNames.join(', ')}</p>}
        <p>{current.length ? 'Review the proposed work, your assignments, and everyone else involved before deciding.' : invitations.length ? 'This invitation is for an earlier version. Check the current plan before responding.' : 'Your decisions or equipment records connect you to this project.'}</p>
        <Button variant={project?.root.key === key ? 'secondary' : 'primary'} disabled={loading} onClick={() => void readProject(key)}>{project?.root.key === key ? 'Refresh selected plan' : 'Review complete plan'}</Button>
        <details className="pf-contribution-details"><summary>Advanced</summary><p>Project reference: {key}</p>{invitations.map(link => <p key={link.entity.key}>Invited plan: {link.entity.payload.linkKind === 'request' ? link.entity.payload.activationKey : 'Not specified'}</p>)}</details>
      </article>;
    })}</div></section>}
    {session.actor && !loading && !known.length && !error && <EmptyState title="No requests yet" description="Share an offer with an organizer. Their proposed plan will appear here when they invite your contribution." actions={<Link href={routeHref({ name: 'contributions' })}>Open my contributions</Link>} />}
    {project && <section ref={selectedPanel} tabIndex={-1} className="pf-sheet pf-request-selected" aria-label="Selected project plan"><ProjectAgreementPanel key={project.root.key} project={project} onRefresh={() => readProject(project.root.key)} /></section>}
  </div>;
}
