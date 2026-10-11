import { useState, type ComponentType, type ReactNode } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { routeHref, projectInvitation, type ProjectTab } from '../../app/routes';
import type { RouteViewProps } from '../../app/App';
import { isPublicEntityKey } from '../../app/ids';
import { formatDateTime } from '../../app/time';
import type { EntityKey, ProjectAggregate, ProjectRecipe } from '../../domain/types';
import { Button, Dialog, ErrorState, Link, LoadingState, Notice, StatusLabel } from '../../ui';
import { useProject } from './hooks';
import { repositoryErrorText } from './catalog';
import { projectStatus } from './selectors';
import { createProjectDrafts, downloadText, draftScope } from './drafts';
import { validateEditorDraft } from './editor';
import { canonicalJson } from '../../domain/canonical';
import { NeedsPanel } from './NeedsPanel';
import { OfferInbox } from './OfferInbox';
import { PlansPanel } from './PlansPanel';
import { HistoryPanel } from './HistoryPanel';
import { ProjectPlan } from './ProjectPlan';

export interface ProjectPanelProps { project: ProjectAggregate; onRefresh: () => Promise<void> }
export interface ProjectSlots { agreementView?: ComponentType<ProjectPanelProps>; runbookView?: ComponentType<ProjectPanelProps>; organizerView?: ComponentType<ProjectPanelProps> }
export interface ProjectActions { onShareRecipe?: (recipe: ProjectRecipe) => void }
export interface ProjectPageProps extends ProjectSlots, ProjectActions { projectRoot: EntityKey; tab?: ProjectTab; practice?: boolean; guidance?: ReactNode }

export function ProjectPage({ projectRoot, tab = 'needs', agreementView: Agreement, runbookView: Runbook, organizerView: Organizer, practice = false, guidance, onShareRecipe }: ProjectPageProps) {
  const runtime = useApp(), { project, loading, error, refresh } = useProject(projectRoot);
  const session = useAppSession();
  const editorScope = draftScope(session.mode, session.actor);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [sharingRecipe, setSharingRecipe] = useState<ProjectRecipe | null>(null);
  const [, setDraftRevision] = useState(0);
  if (!project) return loading ? <LoadingState title="Reading the project" description="Checking its current records and referenced contributors." />
    : <ErrorState title="This project could not be opened" description={error ? repositoryErrorText(error) : 'A project repository has not been connected.'} actions={<Button onClick={() => { void refresh(); }}>Try a fresh read</Button>} />;
  const state = project.state.status === 'unique' ? project.state.entity.payload : null;
  const { readiness, draft } = projectStatus(project, runtime.now());
  const editorDraft = createProjectDrafts(runtime, editorScope).list().find(item => item.projectRoot === project.root.key);
  const editedRecipe = editorDraft ? validateEditorDraft(editorDraft.editor).recipe : null;
  const unsavedChanges = Boolean(editorDraft && state && (!editedRecipe || canonicalJson(editedRecipe) !== canonicalJson(state.recipe)));
  const displayDraft = (draft.changed || unsavedChanges) && (tab === 'needs' || tab === 'plans');
  const recipeToShare = unsavedChanges ? editedRecipe : state?.recipe ?? null;
  const planArea = tab === 'needs' || tab === 'plans';
  const ownsPublicProject = !practice && isPublicEntityKey(projectRoot) && session.mode === 'public'
    && session.actor?.kind === 'wallet' && project.root.payload.coordinator.kind === 'wallet'
    && session.actor.address.toLowerCase() === project.root.payload.coordinator.address.toLowerCase();
  const planTab: ProjectTab = planArea ? tab : project.proposal ? 'plans' : 'needs';
  const navigation: { tab: ProjectTab; label: string; current: boolean }[] = [
    { tab: planTab, label: 'Plan', current: planArea },
    { tab: 'agreement', label: 'People', current: tab === 'agreement' },
    { tab: 'runbook', label: 'Run sheet', current: tab === 'runbook' },
  ];
  const status = !state ? 'Could not read the project' : state.lifecycle === 'closed' ? state.completion?.outcome === 'cancelled' ? 'Cancelled' : state.completion?.outcome === 'completed_with_outstanding' ? 'Finished with work outstanding' : state.completion?.outcome === 'completed' ? 'Finished' : 'Closed'
    : unsavedChanges ? 'Changes waiting to be saved' : draft.changed ? 'New needs to plan'
      : !project.proposal && readiness.status === 'possible' ? 'Still planning'
        : ({ possible: 'Plan found', awaiting_approval: 'Waiting for contributors', declined: 'A contributor cannot take part', ready: 'Everyone has agreed', changed: 'The plan needs an update', conflict: 'The plan needs a check', unverified: 'Could not check the latest plan' } as const)[readiness.status];
  const share = async () => {
    if (!isPublicEntityKey(project.root.key) || project.state.status !== 'unique') { setShareMessage('Check the saved project before copying its invitation.'); return; }
    const link = projectInvitation(window.location.href, project.root.key);
    try { await navigator.clipboard.writeText(link); setShareMessage('The public invitation link was copied.'); }
    catch { setShareMessage(`Copy this invitation link: ${link}`); }
  };
  const exportPacket = async () => {
    if (!runtime.repository) return;
    const result = await runtime.repository.exportPacket(project.root.key);
    if (!result.ok) { setShareMessage(repositoryErrorText(result.error)); return; }
    downloadText('partfolk-verification-packet.json', JSON.stringify(result.value, null, 2)); setShareMessage('Project records exported. This saved copy includes the latest information available here.');
  };
  return <div className="pf-stack project-page">
    <header className="project-heading"><div><h1>{state?.recipe.title ?? 'Check this project'}</h1><p>{state?.recipe.outcome ?? 'The saved project could not be read. Refresh it to try again.'}</p>
      <div className="project-summary"><StatusLabel tone={displayDraft ? 'warning' : readiness.status === 'ready' && state?.lifecycle !== 'closed' ? 'success' : readiness.status === 'unverified' || readiness.status === 'conflict' ? 'warning' : 'neutral'}>{status}</StatusLabel></div>
    </div><div className="pf-stack pf-stack--compact">
      {session.mode === 'local' && onShareRecipe ? <><Button variant="secondary" disabled={!recipeToShare} onClick={() => { if (recipeToShare) setSharingRecipe(structuredClone(recipeToShare)); }}>Share with contributors</Button>{!recipeToShare && <p>Complete the marked fields before sharing. Your draft is retained.</p>}</>
        : isPublicEntityKey(project.root.key) ? <Button variant="secondary" onClick={() => { void share(); }} disabled={!state}>Copy invitation</Button> : null}
      <details className="project-tools"><summary>More</summary><div className="pf-stack pf-stack--compact"><Link href={routeHref({ name: 'project', projectRoot, tab: 'history' })}>View project history</Link><Button variant="quiet" onClick={() => { void exportPacket(); }}>Export project records</Button><Button variant="quiet" onClick={() => { void refresh(); }} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh project'}</Button>
        <details><summary>Record details</summary><dl className="project-record-details"><dt>Last read</dt><dd>{formatDateTime(project.snapshot.fetchedAt, state?.recipe.timeZone ?? 'UTC')}</dd><dt>Saved in</dt><dd>{session.mode === 'public' ? 'The public test network' : practice ? 'Local practice' : 'This device'}</dd><dt>Project reference</dt><dd>{project.root.key}</dd>{project.snapshot.blockNumber && <><dt>Network block</dt><dd>{project.snapshot.blockNumber}</dd></>}</dl></details>
      </div></details>
    </div></header>
    {error && <Notice tone="warning" title="The project could not be refreshed">{repositoryErrorText(error)} The last saved view remains below.</Notice>}
    {displayDraft && project.proposal && <p className="project-change-note">{unsavedChanges ? 'Save your edited needs before finding a new plan.' : 'These needs have changed. Find a new plan for everyone to review.'} <Link href={routeHref({ name: 'project', projectRoot, tab: 'agreement' })}>See the current plan and decisions</Link></p>}
    {shareMessage && <Notice role="status">{shareMessage}</Notice>}
    {guidance}
    <nav className="project-tabs" aria-label="Project journey">{navigation.map(item => <a key={item.label} href={routeHref({ name: 'project', projectRoot, tab: item.tab })} aria-current={item.current ? 'page' : undefined}>{item.label}</a>)}</nav>
    {planArea && ownsPublicProject && Organizer && <details className="pf-sheet pf-organizer-event"><summary>Event page and registration</summary><p className="pf-secondary">Publish the details guests need, manage registration and keep event details current when plans change.</p><Organizer project={project} onRefresh={refresh} /></details>}
    {tab === 'needs' && <NeedsPanel key={`${projectRoot}:${editorScope}`} project={project} onRefresh={refresh} onDraftChange={() => setDraftRevision(value => value + 1)} />}
    {tab === 'plans' && <><div className="project-context-action"><p>Use the saved needs and available offers to find a plan everyone can take on.</p><Link href={routeHref({ name: 'project', projectRoot, tab: 'needs' })}>Edit project needs</Link></div><PlansPanel key={projectRoot} project={project} onRefresh={refresh} autoSolve={practice} /></>}
    {tab === 'history' && <HistoryPanel project={project} onRefresh={refresh} />}
    {tab === 'agreement' && <><OfferInbox project={project} onRefresh={refresh} />{Agreement ? <Agreement project={project} onRefresh={refresh} /> : project.proposal ? <ProjectPlan project={project} plan={project.proposal.payload.plan} title="The current plan" /> : <p>Find a complete plan before asking everyone to agree. <Link href={routeHref({ name: 'project', projectRoot, tab: 'plans' })}>Find a plan</Link></p>}</>}
    {tab === 'runbook' && (Runbook ? <Runbook project={project} onRefresh={refresh} /> : <Notice>The run sheet controls are being connected. No task has been marked complete by opening this view.</Notice>)}
    <Dialog open={sharingRecipe !== null} title="Share this project with contributors" closeLabel="Keep working locally" onClose={() => setSharingRecipe(null)} footer={<Button onClick={() => { if (sharingRecipe && onShareRecipe) { onShareRecipe(structuredClone(sharingRecipe)); setSharingRecipe(null); } }}>Review the public draft</Button>}>
      {sharingRecipe && <div className="pf-stack"><h3>{sharingRecipe.title}</h3><p>{sharingRecipe.outcome}</p><p>You will review a new public draft before publishing it. Only the project needs are copied. Local offers, decisions, and progress stay in this workspace.</p><p>{sharingRecipe.variants.length} date and place options will be copied with their dates and instructions.</p></div>}
    </Dialog>
  </div>;
}
export function ProjectRoute({ route, ...slots }: RouteViewProps & ProjectSlots & ProjectActions) {
  if (route.name !== 'project') return <ErrorState title="A project link is required" />;
  return <ProjectPage projectRoot={route.projectRoot} tab={route.tab} {...slots} />;
}
