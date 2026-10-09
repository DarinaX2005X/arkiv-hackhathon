import { useState, type ComponentType } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { routeHref, projectInvitation, type ProjectTab } from '../../app/routes';
import type { RouteViewProps } from '../../app/App';
import { isPublicEntityKey } from '../../app/ids';
import { formatDateTime } from '../../app/time';
import type { EntityKey, ProjectAggregate } from '../../domain/types';
import { Button, ErrorState, Link, LoadingState, Notice, StatusLabel } from '../../ui';
import { useProject } from './hooks';
import { agreementLabels, projectsCopy as copy, repositoryErrorText } from './catalog';
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
export interface ProjectSlots { agreementView?: ComponentType<ProjectPanelProps>; runbookView?: ComponentType<ProjectPanelProps> }
export interface ProjectPageProps extends ProjectSlots { projectRoot: EntityKey; tab?: ProjectTab; practice?: boolean }
const tabs: { tab: ProjectTab; label: string }[] = [{ tab: 'needs', label: 'Needs' }, { tab: 'plans', label: 'Plans' }, { tab: 'agreement', label: 'Agreement' }, { tab: 'runbook', label: 'Run sheet' }, { tab: 'history', label: 'History' }];

export function ProjectPage({ projectRoot, tab = 'needs', agreementView: Agreement, runbookView: Runbook, practice = false }: ProjectPageProps) {
  const runtime = useApp(), { project, loading, error, refresh } = useProject(projectRoot);
  const session = useAppSession();
  const editorScope = draftScope(session.mode, session.actor);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  if (!project) return loading ? <LoadingState title="Reading the project" description="Checking its current records and referenced contributors." />
    : <ErrorState title="This project could not be opened" description={error ? repositoryErrorText(error) : 'A project repository has not been connected.'} actions={<Button onClick={() => { void refresh(); }}>Try a fresh read</Button>} />;
  const state = project.state.status === 'unique' ? project.state.entity.payload : null;
  const { readiness, draft } = projectStatus(project, runtime.now());
  const editorDraft = createProjectDrafts(runtime, editorScope).list().find(item => item.projectRoot === project.root.key);
  const editedRecipe = editorDraft ? validateEditorDraft(editorDraft.editor).recipe : null;
  const unsavedChanges = Boolean(editorDraft && state && (!editedRecipe || canonicalJson(editedRecipe) !== canonicalJson(state.recipe)));
  const displayDraft = (draft.changed || unsavedChanges) && (tab === 'needs' || tab === 'plans');
  const share = async () => {
    if (!isPublicEntityKey(project.root.key) || project.state.status !== 'unique') { setShareMessage('Only a confirmed public project has a public invitation. Export local work instead.'); return; }
    const link = projectInvitation(window.location.href, project.root.key);
    try { await navigator.clipboard.writeText(link); setShareMessage('The public invitation link was copied.'); }
    catch { setShareMessage(`Copy this invitation link: ${link}`); }
  };
  const exportPacket = async () => {
    if (!runtime.repository) return;
    const result = await runtime.repository.exportPacket(project.root.key);
    if (!result.ok) { setShareMessage(repositoryErrorText(result.error)); return; }
    downloadText('partfolk-verification-packet.json', JSON.stringify(result.value, null, 2)); setShareMessage('A dated verification packet was exported. It does not update itself or create new agreement.');
  };
  return <div className="pf-stack project-page">
    {practice && <Notice title={copy.practice}>Change real inputs and review each synthetic owner’s own decisions. Practice is isolated from your projects.</Notice>}
    <header className="project-heading"><div><h1>{state?.recipe.title ?? 'Project data needs verification'}</h1><p>{state?.recipe.outcome ?? 'The current project record is unavailable.'}</p></div><div className="pf-actions"><Button variant="secondary" onClick={() => { void refresh(); }} disabled={loading}>{loading ? 'Refreshing…' : copy.refresh}</Button>{isPublicEntityKey(project.root.key) ? <Button variant="secondary" onClick={() => { void share(); }} disabled={project.state.status !== 'unique'}>Copy invitation</Button> : null}<Button variant="quiet" onClick={() => { void exportPacket(); }}>Export project packet</Button></div></header>
    {error && <Notice tone="warning" title="Current data could not be verified">{repositoryErrorText(error)} Last-known content remains below with its original read time.</Notice>}
    <div className="project-summary"><StatusLabel tone={displayDraft ? 'warning' : readiness.status === 'ready' && state?.lifecycle !== 'closed' ? 'success' : readiness.status === 'unverified' || readiness.status === 'conflict' ? 'warning' : 'neutral'}>
      {state?.lifecycle === 'closed' ? state.completion?.outcome.replaceAll('_', ' ') ?? 'Closed' : displayDraft ? copy.changed : project.proposal ? agreementLabels[readiness.status] : 'Project draft · no active agreement'}
    </StatusLabel><span className="pf-secondary">Read {formatDateTime(project.snapshot.fetchedAt, state?.recipe.timeZone ?? 'UTC')}{project.snapshot.blockNumber ? ` · block ${project.snapshot.blockNumber}` : ' · local data'}</span></div>
    {displayDraft && <Notice tone="warning" title={copy.changed}><p>{copy.changedBody}</p><Link href={routeHref({ name: 'project', projectRoot, tab: 'agreement' })}>{copy.agreedLink}</Link></Notice>}
    {shareMessage && <Notice role="status">{shareMessage}</Notice>}
    <nav className="project-tabs" aria-label="Project sections">{tabs.map(item => <a key={item.tab} href={routeHref({ name: 'project', projectRoot, tab: item.tab })} aria-current={tab === item.tab ? 'page' : undefined}>{item.label}</a>)}</nav>
    {tab === 'needs' && <><NeedsPanel key={`${projectRoot}:${editorScope}`} project={project} onRefresh={refresh} /><OfferInbox project={project} onRefresh={refresh} /></>}
    {tab === 'plans' && <PlansPanel key={projectRoot} project={project} onRefresh={refresh} autoSolve={practice} />}
    {tab === 'history' && <HistoryPanel project={project} onRefresh={refresh} />}
    {tab === 'agreement' && (Agreement ? <Agreement project={project} onRefresh={refresh} /> : project.proposal ? <><Notice>The personal decision controls are being connected. This view records no decision by itself.</Notice><ProjectPlan project={project} plan={project.proposal.payload.plan} title="Active plan terms" /></> : <Notice>No proposal has been activated. Find a complete plan first.</Notice>)}
    {tab === 'runbook' && (Runbook ? <Runbook project={project} onRefresh={refresh} /> : <Notice>The run sheet controls are being connected. No task has been marked complete by opening this view.</Notice>)}
  </div>;
}
export function ProjectRoute({ route, ...slots }: RouteViewProps & ProjectSlots) {
  if (route.name !== 'project') return <ErrorState title="A project link is required" />;
  return <ProjectPage projectRoot={route.projectRoot} tab={route.tab} {...slots} />;
}
