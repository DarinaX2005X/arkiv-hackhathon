import { useEffect, useState } from 'react';
import { formatDateTime, useApp, useAppSession, type RouteViewProps } from '../../app';
import type { DiscoveryLink } from '../../data/types';
import type { EntityKey, ProjectAggregate, PublisherAggregate } from '../../domain/types';
import { Button, ContributionRow, EmptyState, Field, LoadingState, Notice, StatusLabel } from '../../ui';
import { actorScope, isContributionTarget, publisherName } from './model';
import { ProjectAgreementPanel } from './Agreement';
import { useReadGuard } from './shared';

export function requestProjects(publishers: PublisherAggregate[], links: DiscoveryLink[]): EntityKey[] {
  return [...new Set([...links.map(link => link.entity.payload.projectRoot), ...publishers.flatMap(p => p.book.status === 'unique'
    ? [...p.book.entity.payload.grants.map(g => g.projectRoot), ...p.book.entity.payload.decisions.map(d => d.projectRoot), ...p.book.entity.payload.custodyHolds.map(h => h.projectRoot)] : [])])];
}
export function RequestsPage(_props: RouteViewProps) { return <RequestsInbox />; }
export function RequestsInbox() {
  const runtime = useApp(); const session = useAppSession();
  const startInboxRead = useReadGuard(); const startProjectRead = useReadGuard();
  const [links, setLinks] = useState<DiscoveryLink[]>([]); const [owners, setOwners] = useState<PublisherAggregate[]>([]);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [identity, setIdentity] = useState(''); const [project, setProject] = useState<ProjectAggregate | null>(null);
  const [summaries, setSummaries] = useState<Record<string, { title: string; option: string }>>({});
  const readRequests = async () => {
    if (!runtime.repository || !session.actor) return; const current = startInboxRead(); setLoading(true); setError('');
    try {
      const own = await runtime.repository.listOwnPublishers(session.actor); if (!own.ok) throw new Error('Your contribution identities could not be read. The request inbox is incomplete.');
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
          option: plan ? `${plan.variant.title} · proposed ${formatDateTime(p.proposal!.payload.createdAt, plan.variant.timeZone)}` : 'No current complete proposal' };
      });
      setSummaries(labels);
    } catch (caught) { if (current()) setError(caught instanceof Error ? caught.message : 'The request inbox could not be read.'); } finally { if (current()) setLoading(false); }
  };
  const readProject = async (key: EntityKey) => {
    if (!isContributionTarget(key, session.mode)) { setError(session.mode === 'public' ? 'Enter a complete public project identity beginning with 0x.' : 'Enter a local project identity beginning with local:.'); return; }
    if (!runtime.repository) { setError('The selected data source is unavailable.'); return; }
    const current = startProjectRead(); setLoading(true); const result = await runtime.repository.loadProject(key); if (!current()) return; setLoading(false);
    if (!result.ok) { setProject(previous => previous ? { ...previous, snapshot: { ...previous.snapshot, freshness: 'stale', completeness: 'incomplete', reasons: [...previous.snapshot.reasons, { code: 'rpc_error' }] } } : null); setError('This project could not be read. Any retained plan below is now unverified. Its records may be unavailable or the network may need another attempt.'); return; }
    setProject(result.value); setError('');
  };
  useEffect(() => { setLinks([]); setOwners([]); setProject(null); setSummaries({}); setError(''); setLoading(false); void readRequests(); }, [runtime.repository, actorScope(session.actor), session.mode]);
  const known = requestProjects(owners, links);
  return <div className="pf-stack"><header className="pf-stack pf-stack--compact"><h1>Requests</h1><p className="pf-prose">Review the complete plan behind each request. Your decision belongs to one exact activation and is yours to accept, decline, or withdraw.</p><Button variant="secondary" disabled={loading || !session.actor} onClick={() => void readRequests()}>Refresh requests</Button></header>{!session.actor && <Notice>Connect your owner account to discover incoming requests, or open a project by its identity below. Public plans can be read without a wallet.</Notice>}{error && <Notice tone="warning" role="alert">{error}</Notice>}{loading && <LoadingState title="Reading current requests" />}
    {links.length > 0 && <section className="pf-sheet pf-stack"><h2>Plan requests</h2>{links.map(link => { const payload = link.entity.payload; return <ContributionRow key={link.entity.key} title={summaries[payload.projectRoot]?.title ?? `Project ${payload.projectRoot}`} owner={publisherName(owners.find(p => p.root.key === payload.publisherRoot), payload.publisherRoot)} status={<StatusLabel tone={link.status === 'historical' ? 'neutral' : 'warning'}>{link.status === 'historical' ? 'Earlier activation' : 'Review current plan'}</StatusLabel>} conditions={<><p>{summaries[payload.projectRoot]?.option}</p><p>{link.status === 'historical' ? 'This request points to an older activation. Open the project to inspect its current agreement.' : 'This is a coordinator-authored request. The complete current plan and all owner decisions are checked when opened.'}</p></>} action={<Button variant="secondary" onClick={() => void readProject(payload.projectRoot)}>Read complete plan</Button>} />; })}</section>}
    {session.actor && !loading && !links.length && !error && <EmptyState title="No request links found" description="A coordinator’s request appears after a plan is activated and shared with your identity. Existing commitments and direct project invitations remain available." />}
    {known.length > 0 && <section className="pf-sheet pf-stack"><h2>Known project commitments</h2><p>These project references come from your current book and requests. A missing notification does not erase an agreement or an unresolved equipment hold.</p>{known.map(key => <div className="pf-actions" key={key}><span className="pf-contribution-identity">{summaries[key]?.title ?? key}</span><Button variant="quiet" onClick={() => void readProject(key)}>Open agreement</Button></div>)}</section>}
    <section className="pf-sheet pf-stack"><h2>Open a project directly</h2><Field label="Project identity" value={identity} onChange={e => setIdentity(e.target.value)} /><Button variant="secondary" disabled={loading || !isContributionTarget(identity, session.mode)} onClick={() => { if (isContributionTarget(identity, session.mode)) void readProject(identity); }}>Read complete plan</Button></section>
    {project && <div className="pf-sheet"><ProjectAgreementPanel key={project.root.key} project={project} onRefresh={() => readProject(project.root.key)} /></div>}
  </div>;
}


