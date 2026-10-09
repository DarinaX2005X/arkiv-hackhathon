import { useEffect, useSyncExternalStore } from 'react';
import { RootApp, type RouteRegistry, type RouteViewProps } from './App';
import { useAppSession } from './context';
import { parseRoute, routeHref } from './routes';
import { createStudioWorkspaces, LOCAL_COORDINATOR, type StudioWorkspaces, type WorkspaceKind } from './workspaces';
import { injectedProvider } from './network';
import type { StoragePort } from './storage';
import { makeSmallWorksFixture, SMALL_WORKS_COORDINATOR, SMALL_WORKS_PROJECT_ROOT } from '../domain/fixtures';
import type { Actor, RecipeTemplate } from '../domain/types';
import { Button, Link, LoadingState, Notice, Select } from '../ui';
import { LandingRoute } from '../features/landing';
import { HelpRoute } from '../features/help';
import { DemoRoute, NewProjectRoute, ProjectPage, WorkspaceRoute, createProjectDrafts, draftScope, makeDraft, templateToEditorDraft } from '../features/projects';
import { ContributionsPage, ProjectAgreementPanel, RequestsPage, type ContributionTemplate } from '../features/contributions';
import { ExecutionWorkspace } from '../features/execution';

const sampleRoles = [
  ['coordinator', 'Exhibition coordinator'], ['library', 'Library · exhibition space'],
  ['courtyard', 'Courtyard · outdoor space'], ['makerspace', 'Makerspace · boards and kit'],
  ['cedar', 'Cedar · installation or transport'], ['willow', 'Willow · installation'],
  ['ash', 'Ash · hosting'], ['elm', 'Elm · hosting'], ['oak', 'Oak · transport'], ['juniper', 'Juniper · installation'],
] as const;
const localRoles = [['me', 'Me · project coordinator'], ['participant-1', 'Local contributor 1'], ['participant-2', 'Local contributor 2'], ['participant-3', 'Local contributor 3']] as const;
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
  const change = async (kind: WorkspaceKind) => {
    const route = kind === 'practice' ? { name: 'demo' as const } : { name: 'workspace' as const };
    await manager.select(kind, route);
    window.location.hash = routeHref(route).slice(1);
  };
  if (route.name === 'home') return <div className="pf-mode-line"><span>Explore without a wallet. Each contributor controls their own part.</span><Link href={routeHref({ name: 'demo' })}>Try local practice</Link></div>;
  const roles = selected.kind === 'practice' ? sampleRoles : localRoles;
  return <section className="pf-workspace-controls" aria-label="Workspace and account">
    <div className="pf-workspace-controls-row"><Select label="Workspace" value={selected.kind} onChange={event => { void change(event.target.value as WorkspaceKind); }} options={[
      { value: 'practice', label: 'Local practice · Small Works' }, { value: 'local', label: 'My local projects' }, { value: 'public', label: 'Public projects · Arkiv Tiramisu' },
    ]} />
      {selected.kind !== 'public' ? <Select label={selected.kind === 'practice' ? 'Practice as' : 'Local role'} value={session.actor?.kind === 'local' ? session.actor.id : ''}
        onChange={event => manager.setLocalActor({ kind: 'local', id: event.target.value as `local-actor:${string}` })}
        options={roles.map(([id, label]) => ({ value: `local-actor:${id}`, label }))} />
        : <div className="pf-stack pf-stack--compact"><span>{session.actor?.kind === 'wallet' ? `Connected: ${session.actor.address.slice(0, 8)}…${session.actor.address.slice(-6)}` : 'Reading without a wallet'}</span><div className="pf-actions">
          <Button variant="secondary" disabled={connection.connecting} onClick={() => { void manager.publicBinding.connect(); }}>{connection.connecting ? 'Connecting…' : session.actor ? 'Reconnect wallet' : 'Connect wallet'}</Button>
          {session.actor && <Button variant="quiet" onClick={() => manager.publicBinding.disconnect()}>Disconnect</Button>}
        </div></div>}
    </div>
    <p className="pf-secondary">{selected.kind === 'practice' ? 'Synthetic local roles and records. No wallet, tokens, or public approvals. Practice uses a fixed 9 October 2026 clock.'
      : selected.kind === 'local' ? 'Saved on this device. Local roles simulate separate contributors; their decisions are not public wallet approvals.'
        : 'Public records on Arkiv Tiramisu. Each owner signs their own changes with free testnet GLM.'}</p>
    {connection.error && selected.kind === 'public' && <Notice tone="warning">{connection.error}</Notice>}
    {selected.issue && <Notice tone="warning">{selected.issue}</Notice>}
  </section>;
}

function PracticeGuidance() {
  return <details className="pf-sheet"><summary>Follow the complete practice</summary><ol className="pf-practice-steps">
    <li>Find a plan. Cedar cannot install the displays and bring the artworks at the same time.</li>
    <li>Choose Oak above. Open My contributions, create Oak’s identity and edit availability using the transport template. Share the offer with Small Works.</li>
    <li>Return as the exhibition coordinator. In Needs, review the incoming offer and admit Oak. Find a plan, name any equipment handover and return duties, then publish it.</li>
    <li>Switch to each requested role and open Agreement. Read the exact plan and confirm that role’s own part.</li>
    <li>As Oak, withdraw the transport commitment. As Juniper, create and share the installation offer; as coordinator, admit it and find the repair. Every required role reviews the new version.</li>
    <li>Open Run sheet to record work, equipment handovers and returns. Review the outcome, export it and use the recipe for a new project.</li>
  </ol><p>These are real local domain operations. Resetting practice never clears your own projects.</p></details>;
}

export function createStudioRoutes(manager: StudioWorkspaces): RouteRegistry {
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
  const Runbook = (props: Parameters<typeof ExecutionWorkspace>[0]) => <ExecutionWorkspace {...props} onReuse={reuse} />;
  const slots = { agreementView: ProjectAgreementPanel, runbookView: Runbook };
  const Project = ({ route }: RouteViewProps) => route.name === 'project' ? <ProjectPage key={route.projectRoot} projectRoot={route.projectRoot} tab={route.tab} practice={route.projectRoot === SMALL_WORKS_PROJECT_ROOT} {...slots} /> : null;
  const Contributions = (props: RouteViewProps) => {
    const session = useAppSession();
    const practice = manager.getSnapshot().kind === 'practice';
    return <ContributionsPage key={`${practice}:${session.actor?.kind === 'local' ? session.actor.id : session.actor?.address ?? 'visitor'}`} {...props}
      projectRoot={practice ? SMALL_WORKS_PROJECT_ROOT : undefined} template={practice ? practiceTemplate(session.actor) : undefined} />;
  };
  return {
    home: LandingRoute, help: HelpRoute, workspace: WorkspaceRoute, 'new-project': NewProjectRoute,
    contributions: Contributions, requests: RequestsPage, project: Project,
    demo: props => <DemoRoute {...props} {...slots} controls={<PracticeGuidance />} onReset={async () => { await manager.resetPractice(); manager.runtimes.practice.session.setAccount(SMALL_WORKS_COORDINATOR); }} />,
  };
}

export function Studio({ manager }: { manager: StudioWorkspaces }) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  useEffect(() => {
    const follow = () => { void manager.followRoute(parseRoute(window.location.hash)); };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [manager]);
  // Stable per manager: switching a role never remounts the project or loses a draft.
  const routes = routeRegistry(manager);
  if (state.loading) return <main className="pf-page pf-app-main"><LoadingState title="Opening your workspace" description="Your other projects and drafts are kept separately." /></main>;
  return <RootApp key={`${state.kind}:${state.generation}`} runtime={state.runtime} routes={routes} controls={<WorkspaceControls manager={manager} />} />;
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
