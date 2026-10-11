import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { RootApp, ViewLoadBoundary, type RouteRegistry, type RouteViewProps } from './App';
import { useAppSession } from './context';
import { parseRoute, routeHref } from './routes';
import { createStudioWorkspaces, LOCAL_COORDINATOR, type StudioWorkspaces } from './workspaces';
import { injectedProvider } from './network';
import { isPublicEntityKey } from './ids';
import { copyRecipeToPublicDraft } from './projectSharing';
import type { StoragePort } from './storage';
import { makeSmallWorksFixture, SMALL_WORKS_PROJECT_ROOT } from '../domain/fixtures';
import type { Actor, ProjectRecipe, RecipeTemplate } from '../domain/types';
import { Button, Dialog, Link, LoadingState, Notice, Select } from '../ui';
import { LandingRoute } from '../features/landing';
import { createProjectDrafts, draftScope, makeDraft, type SavedProjectDraft } from '../features/projects/drafts';
import { templateToEditorDraft } from '../features/projects/editor/model';
import type { ProjectPanelProps } from '../features/projects/ProjectPage';
import type { ContributionTemplate } from '../features/contributions/model';
import { AccountCommands } from '../features/account/AccountCommands';
import { workDestination } from '../features/account/account';
import { selectNewProjectDraft } from '../features/projects/draft-session';
import { canShowTour, workspaceTour } from '../features/onboarding/tour';

// Module-scoped lazy components retain their identity across route and account updates.
// Each screen owns its CSS; draft helpers remain synchronous and independent of screens.
const HelpRoute = lazy(() => import('../features/help/Help').then(module => ({ default: module.HelpRoute })));
const WorkspaceRoute = lazy(() => import('../features/projects/Workspace').then(module => ({ default: module.WorkspaceRoute })));
const NewProjectRoute = lazy(() => import('../features/projects/NewProject').then(module => ({ default: module.NewProjectRoute })));
const ProjectPage = lazy(() => import('../features/projects/ProjectPage').then(module => ({ default: module.ProjectPage })));
const ContributionsPage = lazy(() => import('../features/contributions/Contributions').then(module => ({ default: module.ContributionsPage })));
const ProjectAgreementPanel = lazy(() => import('../features/contributions/Agreement').then(module => ({ default: module.ProjectAgreementPanel })));
const RequestsPage = lazy(() => import('../features/contributions/Requests').then(module => ({ default: module.RequestsPage })));
const ExecutionWorkspace = lazy(() => import('../features/execution/ExecutionWorkspace').then(module => ({ default: module.ExecutionWorkspace })));
const GuidedPractice = lazy(() => import('../features/practice/GuidedPractice').then(module => ({ default: module.GuidedPractice })));
const SignInPage = lazy(() => import('../features/account/AccountPages').then(module => ({ default: module.SignInPage })));
const AccountPage = lazy(() => import('../features/account/AccountPages').then(module => ({ default: module.AccountPage })));
const EventCatalog = lazy(() => import('../features/events/EventCatalog').then(module => ({ default: module.EventCatalog })));
const EventDetail = lazy(() => import('../features/events/EventDetail').then(module => ({ default: module.EventDetail })));
const MyEvents = lazy(() => import('../features/attendance/MyEvents').then(module => ({ default: module.MyEvents })));
const EventPublishingPanel = lazy(() => import('../features/events/publishing/EventPublishingPanel').then(module => ({ default: module.EventPublishingPanel })));
const WorkspaceTour = lazy(() => import('../features/onboarding/WorkspaceTour').then(module => ({ default: module.WorkspaceTour })));

const sampleRoles = [
  ['coordinator', 'Exhibition coordinator'], ['library', 'Library (exhibition space)'],
  ['courtyard', 'Courtyard (outdoor space)'], ['makerspace', 'Makerspace (boards and kit)'],
  ['cedar', 'Cedar (installation or transport)'], ['willow', 'Willow (installation)'],
  ['ash', 'Ash (hosting)'], ['elm', 'Elm (hosting)'], ['oak', 'Oak (transport)'], ['juniper', 'Juniper (installation)'],
] as const;
const templates = makeSmallWorksFixture({ oak: true, juniper: true }).publishers;

export function practiceTemplate(actor: Actor | null): ContributionTemplate | undefined {
  if (actor?.kind !== 'local') return undefined;
  const publisher = templates.find(item => item.root.payload.publisher.kind === 'local' && item.root.payload.publisher.id === actor.id);
  if (!publisher || publisher.book.status !== 'unique') return undefined;
  const { name, description, resources, offers } = publisher.book.entity.payload;
  return structuredClone({ name, description, resources, offers, kind: publisher.root.payload.kind });
}

function WorkspaceControls({ manager }: { manager: StudioWorkspaces }) {
  const selected = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const connection = useSyncExternalStore(manager.publicBinding.subscribe, manager.publicBinding.getSnapshot, manager.publicBinding.getSnapshot);
  const session = useAppSession();
  const route = parseRoute(session.destination);
  if (['home', 'sign-in', 'account', 'onboarding'].includes(route.name)) return null;
  const signIn = { name: 'sign-in' as const, returnTo: workDestination(route) };
  // Ordinary public browsing needs no repeated connection or mode banner.
  if (selected.kind === 'public' && !connection.error && !selected.issue) return null;
  return <div className="pf-workspace-bar">
    {selected.kind === 'practice' ? <details className="pf-workspace-controls">
      <summary><span className="pf-workspace-summary"><strong>Practice only</strong><span className="pf-secondary">Sample people and decisions. Nothing is published.</span></span><span className="pf-workspace-change">Choose a practice role</span></summary>
      <Select label="Practice as" value={session.actor?.kind === 'local' ? session.actor.id : ''} onChange={event => manager.setLocalActor({ kind: 'local', id: event.target.value as `local-actor:${string}` })} options={sampleRoles.map(([id, label]) => ({ value: `local-actor:${id}`, label }))} />
    </details> : selected.kind === 'local' ? <div className="pf-workspace-status"><strong>Saved on this device</strong><span className="pf-secondary">These local projects are available in this browser. You can publish a copy when it is ready.</span></div> : null}
    {selected.kind === 'local' && <Button variant="secondary" onClick={() => { void manager.select('public', { name: 'workspace' }).then(() => { window.location.hash = '/workspace'; }); }}>Open my public work</Button>}
    {connection.error && selected.kind === 'public' && <Notice tone="warning">{connection.error} <Link href={routeHref(signIn)}>Reconnect wallet</Link></Notice>}
    {selected.issue && <Notice tone="warning">{selected.issue}</Notice>}
  </div>;
}

function PracticeGuidance() {
  return <details className="pf-sheet"><summary>Follow the complete practice</summary><ol className="pf-practice-steps">
    <li>Open the full project and find a plan. Cedar cannot install the displays and bring the artworks at the same time.</li>
    <li>Open Change above and choose Oak. In My contributions, create Oak’s identity and edit availability using the transport template. Share the offer with Small Works.</li>
    <li>Return as the exhibition coordinator. In People, review the incoming offer and admit Oak. In Plan, find an arrangement, name the equipment handover and return duties, then publish it.</li>
    <li>Switch to each requested role and open People. Read the exact plan and confirm that role’s own part.</li>
    <li>As Oak, withdraw the transport commitment. As Juniper, create and share the installation offer; as coordinator, admit it and find the repair. Every required role reviews the new version.</li>
    <li>Open Run sheet to record work, equipment handovers and returns. Review the outcome, export it and use the recipe for a new project.</li>
  </ol><p>These are real local domain operations. Resetting practice never clears your own projects.</p></details>;
}

function PracticeRoute({ manager, onStartProject }: { manager: StudioWorkspaces; onStartProject: () => void }) {
  const [revision, setRevision] = useState(0), [resetOpen, setResetOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const openProject = () => { window.location.hash = routeHref({ name: 'project', projectRoot: SMALL_WORKS_PROJECT_ROOT, tab: 'plans' }).slice(1); };
  return <div className="pf-stack"><header className="pf-foundation-intro"><h1>Bring a small exhibition together</h1><p>Bring together a place, equipment and a crew. Then see how the plan changes when someone steps away.</p></header>
    <GuidedPractice repository={manager.practiceRepository} now={manager.runtimes.practice.now} refreshKey={revision} onRefresh={() => setRevision(value => value + 1)} onOpenProject={openProject} />
    <div className="pf-actions"><Link href={routeHref({ name: 'new-project' })} onClick={event => { event.preventDefault(); onStartProject(); }}>Start my own project</Link><Button variant="quiet" onClick={() => setResetOpen(true)}>Start the example again</Button></div>
    <PracticeGuidance />
    {error && <Notice tone="warning">{error}</Notice>}
    <Dialog open={resetOpen} title="Start the example again?" closeLabel="Keep this example" onClose={() => setResetOpen(false)} footer={<Button disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await manager.resetPractice(); setResetOpen(false); setRevision(value => value + 1); }
      catch { setError('The example could not be reset. Your saved records have been kept.'); }
      finally { setBusy(false); }
    }}>Reset the example</Button>}><p>This clears the sample offers, decisions and progress. Your own projects stay as they are.</p></Dialog>
  </div>;
}

export function createStudioRoutes(manager: StudioWorkspaces): RouteRegistry {
  const startProject = () => {
    // Explicit creation always starts personal work and never copies sample actors.
    selectNewProjectDraft(manager.runtimes.public);
    void manager.select('public', { name: 'new-project' }).then(() => { window.location.hash = '/projects/new'; });
  };
  const share = (source: ProjectRecipe | SavedProjectDraft) => {
    copyRecipeToPublicDraft(manager.runtimes.public, source);
    void manager.select('public', { name: 'new-project' }).then(() => { window.location.hash = '/projects/new'; });
  };
  const Help = (props: RouteViewProps) => <HelpRoute {...props} onCreateProject={startProject} onReplayTour={() => {
    const current = manager.getSnapshot();
    if (current.kind === 'public') workspaceTour(current.runtime).start();
    else void manager.select('public', props.route).then(() => workspaceTour(manager.getSnapshot().runtime).start());
  }} />;
  const reuse = (template: RecipeTemplate) => {
    const runtime = manager.runtimes.local;
    runtime.session.setAccount(LOCAL_COORDINATOR);
    const scope = draftScope('local', LOCAL_COORDINATOR);
    const drafts = createProjectDrafts(runtime, scope);
    const draft = { ...makeDraft(scope, undefined, runtime.now()), editor: templateToEditorDraft(template) };
    drafts.upsert(draft);
    runtime.session.selectDraft(draft.id);
    void manager.select('local', { name: 'new-project' }).then(() => { window.location.hash = '/projects/new'; });
  };
  const Runbook = (props: Parameters<typeof ExecutionWorkspace>[0]) => <Suspense fallback={<LoadingState title="Opening the run sheet" />}><ExecutionWorkspace {...props} onReuse={reuse} /></Suspense>;
  const Organizer = ({ project, onRefresh }: ProjectPanelProps) => {
    const session = useAppSession();
    return isPublicEntityKey(project.root.key) ? <Suspense fallback={<LoadingState title="Opening event details" />}><EventPublishingPanel projectRoot={project.root.key} repository={manager.events} session={session} storage={manager.storage} onRefresh={onRefresh} /></Suspense> : null;
  };
  const Agreement = (props: ProjectPanelProps) => <Suspense fallback={<LoadingState title="Opening agreements" />}><ProjectAgreementPanel {...props} /></Suspense>;
  const slots = { agreementView: Agreement, runbookView: Runbook, organizerView: Organizer };
  const Project = ({ route }: RouteViewProps) => route.name === 'project' ? <ProjectPage key={route.projectRoot} projectRoot={route.projectRoot} tab={route.tab} practice={route.projectRoot === SMALL_WORKS_PROJECT_ROOT} guidance={route.projectRoot === SMALL_WORKS_PROJECT_ROOT ? <PracticeGuidance /> : undefined} onShareRecipe={share} {...slots} /> : null;
  const Contributions = (props: RouteViewProps) => {
    const session = useAppSession();
    const practice = manager.getSnapshot().kind === 'practice';
    return <ContributionsPage key={`${practice}:${session.actor?.kind === 'local' ? session.actor.id : session.actor?.address ?? 'visitor'}`} {...props}
      projectRoot={props.route.name === 'contributions' ? props.route.projectRoot ?? (practice ? SMALL_WORKS_PROJECT_ROOT : undefined) : undefined} template={practice ? practiceTemplate(session.actor) : undefined} />;
  };
  const Events = () => <EventCatalog repository={manager.events} />;
  const Event = ({ route }: RouteViewProps) => {
    const session = useAppSession();
    return route.name === 'event' ? <EventDetail key={route.projectRoot} projectRoot={route.projectRoot} repository={manager.events} session={session} storage={manager.storage} /> : null;
  };
  const Attendance = () => <MyEvents repository={manager.events} session={useAppSession()} storage={manager.storage} />;
  return {
    home: props => <LandingRoute {...props} onCreateProject={startProject} />, help: Help, workspace: props => <WorkspaceRoute {...props} eventsAvailable />, 'new-project': () => <NewProjectRoute onShareDraft={share} />,
    events: Events, event: Event, 'my-events': Attendance,
    'sign-in': props => <SignInPage {...props} binding={manager.publicBinding} />,
    account: props => <AccountPage {...props} binding={manager.publicBinding} />,
    onboarding: props => <AccountPage {...props} binding={manager.publicBinding} />,
    contributions: Contributions, requests: RequestsPage, project: Project,
    demo: () => <PracticeRoute manager={manager} onStartProject={startProject} />,
  };
}

export function Studio({ manager }: { manager: StudioWorkspaces }) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const session = useSyncExternalStore(state.runtime.session.subscribe, state.runtime.session.getSnapshot, state.runtime.session.getSnapshot);
  useEffect(() => {
    const follow = () => { void manager.followRoute(parseRoute(window.location.hash)); };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [manager]);
  // Stable per manager: switching a role never remounts the project or loses a draft.
  const routes = routeRegistry(manager);
  if (state.loading) return <main className="pf-page pf-app-main"><LoadingState title="Opening your workspace" description="Your other projects and drafts are kept separately." /></main>;
  const tourEligible = state.kind !== 'practice' && canShowTour(parseRoute(session.destination), session.mode, session.actor);
  const guide = tourEligible ? <ViewLoadBoundary destination={session.destination} failureTitle="The welcome tour could not open"><Suspense fallback={null}><WorkspaceTour /></Suspense></ViewLoadBoundary> : undefined;
  return <RootApp key={`${state.kind}:${state.generation}`} runtime={state.runtime} routes={routes} controls={<WorkspaceControls manager={manager} />} account={<AccountCommands manager={manager} />} guide={guide} />;
}
const registries = new WeakMap<StudioWorkspaces, RouteRegistry>();
function routeRegistry(manager: StudioWorkspaces) {
  let registry = registries.get(manager);
  if (!registry) { registry = createStudioRoutes(manager); registries.set(manager, registry); }
  return registry;
}

export async function bootstrapStudio(storage: StoragePort | null, scope: unknown = window) {
  const manager = createStudioWorkspaces({ storage, provider: injectedProvider(scope) });
  await manager.followRoute(window.location.hash ? parseRoute(window.location.hash) : manager.initialRoute());
  return manager;
}
