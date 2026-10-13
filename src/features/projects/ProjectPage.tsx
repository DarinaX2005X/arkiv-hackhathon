import { useState, type ComponentType, type ReactNode } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { routeHref, routePath, projectInvitation, type ProjectTab } from '../../app/routes';
import type { RouteViewProps } from '../../app/App';
import { isPublicEntityKey } from '../../app/ids';
import { formatDateTime } from '../../app/time';
import type { EntityKey, ProjectAggregate, ProjectRecipe } from '../../domain/types';
import { Button, Dialog, ErrorState, Link, LoadingState, Notice, StatusLabel } from '../../ui';
import { useProject } from './hooks';
import { repositoryErrorText } from './catalog';
import { projectStatus } from './selectors';
import { createProjectDrafts, downloadText, draftScope, type SavedProjectDraft } from './drafts';
import { validateEditorDraft } from './editor';
import { canonicalJson } from '../../domain/canonical';
import { NeedsPanel } from './NeedsPanel';
import { OfferInbox } from './OfferInbox';
import { PlansPanel } from './PlansPanel';
import { HistoryPanel } from './HistoryPanel';
import { ProjectPlan } from './ProjectPlan';
import { ProjectNeeds } from './ProjectNeeds';
import './projects.css';

export interface ProjectPanelProps { project: ProjectAggregate; onRefresh: () => Promise<void> }
export interface ProjectSlots { agreementView?: ComponentType<ProjectPanelProps>; runbookView?: ComponentType<ProjectPanelProps>; organizerView?: ComponentType<ProjectPanelProps> }
export interface ProjectActions { onShareRecipe?: (recipe: ProjectRecipe) => void; onShareDraft?: (draft: SavedProjectDraft) => void }
export interface ProjectPageProps extends ProjectSlots, ProjectActions { projectRoot: EntityKey; tab?: ProjectTab; practice?: boolean; guidance?: ReactNode }

export function ProjectPage({ projectRoot, tab = 'needs', agreementView: Agreement, runbookView: Runbook, organizerView: Organizer, practice = false, guidance, onShareRecipe, onShareDraft }: ProjectPageProps) {
  const runtime = useApp(), { project, loading, error, refresh } = useProject(projectRoot);
  const session = useAppSession();
  const editorScope = draftScope(session.mode, session.actor);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [sharing, setSharing] = useState<ProjectRecipe | SavedProjectDraft | null>(null);
  const [, setDraftRevision] = useState(0);
  if (!project) return loading ? <LoadingState title="Reading the project" description="Checking its current records and referenced contributors." />
    : <ErrorState title="This project could not be opened" description={error ? repositoryErrorText(error) : 'The project source is unavailable. Try again in a moment.'} actions={<Button onClick={() => { void refresh(); }}>Try a fresh read</Button>} />;
  const state = project.state.status === 'unique' ? project.state.entity.payload : null;
  const { readiness, draft } = projectStatus(project, runtime.now());
  const editorDraft = createProjectDrafts(runtime, editorScope).list().find(item => item.projectRoot === project.root.key);
  const editedRecipe = editorDraft ? validateEditorDraft(editorDraft.editor).recipe : null;
  const unsavedChanges = Boolean(editorDraft && state && (!editedRecipe || canonicalJson(editedRecipe) !== canonicalJson(state.recipe)));
  const displayDraft = (draft.changed || unsavedChanges) && (tab === 'needs' || tab === 'plans');
  const recipeToShare = unsavedChanges ? editedRecipe : state?.recipe ?? null;
  const recoverySource = editorDraft && onShareDraft ? editorDraft : recipeToShare;
  const canContinueRecovery = recoverySource && ('editor' in recoverySource ? Boolean(onShareDraft) : Boolean(onShareRecipe));
  const legacyLocalProject = !practice && session.mode === 'local';
  const planArea = tab === 'needs' || tab === 'plans';
  const ownsPublicProject = !practice && isPublicEntityKey(projectRoot) && session.mode === 'public'
    && session.actor?.kind === 'wallet' && project.root.payload.coordinator.kind === 'wallet'
    && session.actor.address.toLowerCase() === project.root.payload.coordinator.address.toLowerCase();
  const guestsAvailable = !practice && isPublicEntityKey(projectRoot) && Boolean(Organizer);
  const planTab: ProjectTab = planArea ? tab : project.proposal ? 'plans' : 'needs';
  const navigation: { tab: ProjectTab; label: string; current: boolean }[] = [
    { tab: planTab, label: 'Plan', current: planArea },
    { tab: 'agreement', label: 'People', current: tab === 'agreement' },
    { tab: 'runbook', label: 'Run sheet', current: tab === 'runbook' },
    ...(guestsAvailable ? [{ tab: 'guests' as const, label: 'Guests & registration', current: tab === 'guests' }] : []),
    { tab: 'history', label: 'History', current: tab === 'history' },
  ];
  const status = !state ? 'Could not read the project' : state.lifecycle === 'closed' ? state.completion?.outcome === 'cancelled' ? 'Cancelled' : state.completion?.outcome === 'completed_with_outstanding' ? 'Finished with work outstanding' : state.completion?.outcome === 'completed' ? 'Finished' : 'Closed'
    : unsavedChanges ? 'Changes waiting to be saved' : draft.changed ? 'New needs to plan'
      : !project.proposal && readiness.status === 'possible' ? 'Still planning'
        : ({ possible: 'Plan found', awaiting_approval: 'Waiting for contributors', declined: 'A contributor cannot take part', ready: 'Everyone has agreed', changed: 'The plan needs an update', conflict: 'The plan needs a check', unverified: 'Could not check the latest plan' } as const)[readiness.status];
  const nextStep = state?.lifecycle === 'closed'
    ? { title: 'Review what happened', description: 'Your outcome and earlier decisions stay available in the project history.', tab: 'history' as const, action: 'View project outcome' }
    : unsavedChanges || draft.changed
      ? { title: 'Finish updating your event', description: 'Save the changed needs before asking people to review a new plan.', tab: 'needs' as const, action: 'Review project needs' }
      : readiness.status === 'ready'
        ? ownsPublicProject && guestsAvailable
          ? { title: 'Welcome your guests', description: 'Publish or update the visitor page, set how people join and manage registration. Your agreed work remains in the run sheet.', tab: 'guests' as const, action: 'Manage guest page' }
          : { title: 'Bring the event together', description: 'Use the agreed run sheet to follow the times, report work and confirm equipment transfers.', tab: 'runbook' as const, action: 'Open run sheet' }
        : project.proposal
          ? { title: readiness.status === 'awaiting_approval' ? 'Collect each owner’s decision' : 'Review the current agreement', description: 'Check who can take part and whether the saved terms still match their offers.', tab: 'agreement' as const, action: 'Review contributions' }
          : { title: 'Bring in the help you need', description: 'Invite contributors to offer their time, space or equipment, then find a complete plan.', tab: 'agreement' as const, action: 'Open contributions' };
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
  const recoveryDialog = <Dialog open={sharing !== null} title="Continue this project publicly" closeLabel="Keep the recovery copy" onClose={() => setSharing(null)} footer={<Button onClick={() => {
    if (!sharing) return;
    if ('editor' in sharing && onShareDraft) onShareDraft(structuredClone(sharing));
    else if (!('editor' in sharing) && onShareRecipe) onShareRecipe(structuredClone(sharing));
    setSharing(null);
  }}>Continue to the public editor</Button>}>
    {sharing && <div className="pf-stack"><h3>{'editor' in sharing ? sharing.editor.title || 'Untitled project' : sharing.title}</h3><p>Continue with a new public project draft. You can finish incomplete fields, review the details and sign with your wallet before anything is published.</p><p>Your original device copy stays available. Offers, decisions and progress belong to that original project and are not copied into the new one.</p></div>}
  </Dialog>;
  if (legacyLocalProject) return <div className="pf-stack project-page project-recovery">
    <header className="project-heading"><div><h1>{state?.recipe.title ?? 'Recover this project'}</h1><p>This project was saved in an earlier device workspace. Continue with a public project to invite contributors and publish an event.</p></div><Link href={routeHref({ name: 'workspace' })}>Back to My projects</Link></header>
    <Notice title="Your original work is retained"><p>{editorDraft ? 'The unfinished input in this editor can be carried into the public draft.' : 'The saved project needs can be carried into a public draft.'} Your earlier offers, decisions and progress stay with this copy.</p></Notice>
    <div className="pf-actions"><Button disabled={!canContinueRecovery} onClick={() => { if (recoverySource) setSharing(structuredClone(recoverySource)); }}>Continue as a public project</Button><Button variant="secondary" onClick={() => { void exportPacket(); }}>Export original project records</Button>{editorDraft && <Button variant="quiet" onClick={() => downloadText('partfolk-recovered-input.json', createProjectDrafts(runtime, editorScope).exportDraft(editorDraft))}>Export unfinished input</Button>}</div>
    {!recoverySource && <p>The current project needs could not be read. Export the original records before trying another recovery.</p>}
    {shareMessage && <Notice role="status">{shareMessage}</Notice>}
    <ProjectNeeds project={project} />
    {recoveryDialog}
  </div>;
  return <div className="pf-stack project-page">
    <header className="project-heading"><div><h1>{state?.recipe.title ?? 'Check this project'}</h1><p>{state?.recipe.outcome ?? 'The saved project could not be read. Refresh it to try again.'}</p>
      <div className="project-summary"><StatusLabel tone={displayDraft ? 'warning' : readiness.status === 'ready' && state?.lifecycle !== 'closed' ? 'success' : readiness.status === 'unverified' || readiness.status === 'conflict' ? 'warning' : 'neutral'}>{status}</StatusLabel></div>
    </div><div className="pf-stack pf-stack--compact">
      {isPublicEntityKey(project.root.key) && <Button variant="secondary" onClick={() => { void share(); }} disabled={!state}>Copy invitation</Button>}
      <Button variant="quiet" onClick={() => { void refresh(); }} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh project'}</Button>
      <details className="project-tools"><summary>Advanced</summary><div className="pf-stack pf-stack--compact"><Button variant="quiet" onClick={() => { void exportPacket(); }}>Export project records</Button>
        <dl className="project-record-details"><dt>Last read</dt><dd>{formatDateTime(project.snapshot.fetchedAt, state?.recipe.timeZone ?? 'UTC')}</dd><dt>Saved in</dt><dd>{session.mode === 'public' ? 'The public test network' : 'Local practice'}</dd><dt>Project reference</dt><dd>{project.root.key}</dd>{project.snapshot.blockNumber && <><dt>Network block</dt><dd>{project.snapshot.blockNumber}</dd></>}</dl>
      </div></details>
    </div></header>
    {error && <Notice tone="warning" title="The project could not be refreshed">{repositoryErrorText(error)} The last saved view remains below.</Notice>}
    {displayDraft && project.proposal && <p className="project-change-note">{unsavedChanges ? 'Save your edited needs before finding a new plan.' : 'These needs have changed. Find a new plan for everyone to review.'} <Link href={routeHref({ name: 'project', projectRoot, tab: 'agreement' })}>See the current plan and decisions</Link></p>}
    {shareMessage && <Notice role="status">{shareMessage}</Notice>}
    {guidance}
    {tab !== nextStep.tab && state && <section className="pf-sheet project-next"><div><h2>{nextStep.title}</h2><p>{nextStep.description}</p></div><Link className="pf-button pf-button--primary" href={routeHref({ name: 'project', projectRoot, tab: nextStep.tab })}>{nextStep.action}</Link></section>}
    {!practice && !ownsPublicProject && state?.lifecycle !== 'closed' && <div className="project-context-action"><p>Help make this event happen with your time, space or equipment.</p><Link className="pf-button pf-button--secondary" href={routeHref({ name: 'contributions', projectRoot, returnTo: routePath({ name: 'project', projectRoot, tab }) })}>Offer a contribution</Link></div>}
    <nav className="project-tabs" aria-label="Project journey">{navigation.map(item => <a key={item.label} href={routeHref({ name: 'project', projectRoot, tab: item.tab })} aria-current={item.current ? 'page' : undefined}>{item.label}</a>)}</nav>
    {tab === 'guests' && guestsAvailable && Organizer && <section className="pf-stack pf-organizer-event"><Organizer project={project} onRefresh={refresh} /></section>}
    {tab !== 'guests' && <div className="pf-stack">
    {tab === 'needs' && <NeedsPanel key={`${projectRoot}:${editorScope}`} project={project} onRefresh={refresh} onDraftChange={() => setDraftRevision(value => value + 1)} />}
    {tab === 'plans' && <><div className="project-context-action"><p>Use the saved needs and available offers to find a plan everyone can take on.</p><Link href={routeHref({ name: 'project', projectRoot, tab: 'needs' })}>Edit project needs</Link></div><PlansPanel key={projectRoot} project={project} onRefresh={refresh} autoSolve={practice} /></>}
    {tab === 'history' && <HistoryPanel project={project} onRefresh={refresh} />}
    {tab === 'agreement' && <><OfferInbox project={project} onRefresh={refresh} />{Agreement ? <Agreement project={project} onRefresh={refresh} /> : project.proposal ? <ProjectPlan project={project} plan={project.proposal.payload.plan} title="The current plan" /> : <p>Find a complete plan before asking everyone to agree. <Link href={routeHref({ name: 'project', projectRoot, tab: 'plans' })}>Find a plan</Link></p>}</>}
    {tab === 'runbook' && (Runbook ? <Runbook project={project} onRefresh={refresh} /> : <section className="pf-sheet pf-stack"><h2>Run sheet</h2><p>Read the duties and equipment transfers in the complete agreement.</p><Link href={routeHref({ name: 'project', projectRoot, tab: 'agreement' })}>Open the complete agreement</Link></section>)}
    </div>}
  </div>;
}
export function ProjectRoute({ route, ...slots }: RouteViewProps & ProjectSlots & ProjectActions) {
  if (route.name !== 'project') return <ErrorState title="A project link is required" />;
  return <ProjectPage projectRoot={route.projectRoot} tab={route.tab} {...slots} />;
}
