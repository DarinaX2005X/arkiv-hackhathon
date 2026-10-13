import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useAppSession, type AppRuntime } from '../../app/context';
import type { RouteViewProps } from '../../app/App';
import { routeHref } from '../../app/routes';
import { isPublicEntityKey } from '../../app/ids';
import { formatDateTime } from '../../app/time';
import type { ProjectSummary, Repository } from '../../data/types';
import type { Actor } from '../../domain/types';
import { Button, Dialog, EmptyState, Field, Link, Notice, Select, StatusLabel } from '../../ui';
import { createProjectDrafts, draftScope, downloadText, type SavedProjectDraft } from './drafts';
import { deleteProjectDraft, selectNewProjectDraft } from './draft-session';
import { useProjectDrafts } from './hooks';
import { projectsCopy as copy, repositoryErrorText } from './catalog';
import { ProjectFolio } from './ProjectFolio';
import './projects.css';

export interface WorkspaceProjectList { projects: ProjectSummary[]; loading: boolean; error: string | null }
/** Each read owns its result until the account or route changes. */
export function readWorkspaceProjects(repository: Pick<Repository, 'listProjects'> | null, actor: Actor | null, update: (state: WorkspaceProjectList) => void) {
  let cancelled = false;
  update({ projects: [], error: null, loading: Boolean(repository && actor) });
  if (repository && actor) void repository.listProjects(actor).then(result => {
    if (cancelled) return;
    update(result.ok ? { projects: result.value.items, loading: false, error: result.value.snapshot.completeness === 'complete' ? null : 'The project list is incomplete. Existing drafts remain available below.' }
      : { projects: [], loading: false, error: repositoryErrorText(result.error) });
  }).catch(() => { if (!cancelled) update({ projects: [], loading: false, error: 'The project list could not be read. Your drafts remain available below.' }); });
  return () => { cancelled = true; };
}
function SavedProjectCard({ project }: { project: ProjectSummary }) {
  const state = project.state, recipe = state?.recipe;
  const closed = state?.lifecycle === 'closed', running = state?.lifecycle === 'in_progress';
  const href = routeHref({ name: 'project', projectRoot: project.root.key, tab: closed ? 'history' : running ? 'runbook' : 'needs' });
  const dates = recipe?.variants.flatMap(variant => variant.requirements.map(requirement => requirement.interval.start)) ?? [];
  const venues = [...new Set(recipe?.variants.map(variant => variant.venueId).filter(Boolean) ?? [])];
  return <li className="pf-sheet project-card">
    <div className="project-card-top"><StatusLabel>{closed ? state?.completion?.outcome.replaceAll('_', ' ') ?? 'Closed' : running ? 'In progress' : 'Planning'}</StatusLabel><span className="pf-secondary">{project.root.provenance.mode === 'local' ? 'On this device' : 'Public project'}</span></div>
    <h3><Link href={href}>{recipe?.title ?? 'Project awaiting initialization'}</Link></h3><p className="project-card-description">{recipe?.outcome}</p>
    <dl className="project-card-facts"><div><dt>First required time</dt><dd>{dates.length ? formatDateTime(Math.min(...dates), recipe!.timeZone) : 'Dates to be added'}</dd></div><div><dt>Place</dt><dd>{venues.length === 1 ? venues[0] : venues.length ? `${venues.length} place options` : 'Place to be added'}</dd></div></dl>
    {project.diagnostics.length > 0 && <p className="project-card-warning">Some saved details need a fresh check.</p>}
    <div className="pf-actions project-card-actions"><Link className="pf-button pf-button--secondary" href={href}>{closed ? 'View outcome' : running ? 'Open run sheet' : 'Continue planning'}</Link></div>
  </li>;
}
export function WorkspaceRoute({ eventsAvailable = false, recoveryRuntime, onShareDraft }: RouteViewProps & { eventsAvailable?: boolean; recoveryRuntime?: AppRuntime; onShareDraft?: (draft: SavedProjectDraft) => void }) {
  const runtime = useApp(), session = useAppSession();
  const { storage, changed } = useProjectDrafts();
  const [{ projects, loading, error }, setProjectList] = useState<WorkspaceProjectList>({ projects: [], loading: false, error: null });
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState('');
  const [publicId, setPublicId] = useState(''), [importError, setImportError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedProjectDraft | null>(null), [deleteError, setDeleteError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState(''), [readVersion, setReadVersion] = useState(0);
  const [legacyProjects, setLegacyProjects] = useState<WorkspaceProjectList>({ projects: [], loading: false, error: null });
  const recoveryStores = useMemo(() => recoveryRuntime ? [...new Set([draftScope('local', recoveryRuntime.session.getSnapshot().actor), 'local:visitor'])].map(scope => createProjectDrafts(recoveryRuntime, scope)) : [], [recoveryRuntime]);
  const recoveryDrafts = recoveryStores.flatMap(store => store.refresh().map(draft => ({ draft, store })));
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => readWorkspaceProjects(runtime.repository, session.actor, setProjectList), [runtime.repository, session.actor, readVersion]);
  useEffect(() => recoveryRuntime ? readWorkspaceProjects(recoveryRuntime.repository, recoveryRuntime.session.getSnapshot().actor, setLegacyProjects) : undefined, [recoveryRuntime]);
  useEffect(() => { setDeleting(null); setDeleteError(null); setFeedback(''); }, [session.actor, session.mode]);
  const drafts = storage.list();
  const matches = (title: string, outcome: string) => `${title} ${outcome}`.toLowerCase().includes(search.trim().toLowerCase());
  const shownDrafts = ['all', 'drafts'].includes(filter) ? drafts.filter(draft => matches(draft.editor.title, draft.editor.outcome)) : [];
  const shownProjects = projects.filter(project => filter === 'all' || filter === project.state?.lifecycle).filter(project => matches(project.state?.recipe.title ?? '', project.state?.recipe.outcome ?? '')).sort((left, right) => (right.state?.createdAt ?? 0) - (left.state?.createdAt ?? 0));
  const create = () => { selectNewProjectDraft(runtime); window.location.hash = '/projects/new'; };
  const remove = () => {
    if (!deleting) return;
    try {
      const result = deleteProjectDraft(runtime, deleting); changed();
      if (!result.persisted) { setDeleteError(result.deleted ? 'The draft is marked deleted, but its saved copy could not be cleared. Keep this window open and try again.' : 'The draft could not be deleted from this device. It is still available. Check browser storage and try again.'); return; }
      setFeedback(`Deleted “${deleting.editor.title || 'Untitled project draft'}” from this device.`); setDeleting(null); setDeleteError(null);
    } catch (problem) { setDeleteError(problem instanceof Error ? problem.message : 'The draft could not be deleted. Try again.'); changed(); }
  };
  return <div className="pf-stack project-workspace">
    <header className="project-heading"><div><h1>My projects</h1><p>Pick up your public event project, bring in contributions and keep everyone working from the same agreement.</p></div><Button onClick={create}>Create event project</Button></header>
    {error && <Notice tone="warning" title="Your projects could not be fully checked"><p>{error}</p><Button variant="secondary" onClick={() => setReadVersion(value => value + 1)}>Try again</Button></Notice>}
    {feedback && <p role="status">{feedback}</p>}
    {(drafts.length > 0 || projects.length > 0) && <div className="project-filters"><Field label="Find a project" value={search} placeholder="Search by title or outcome" onChange={event => setSearch(event.target.value)} /><Select label="Show" value={filter} onChange={event => setFilter(event.target.value)} options={[{ value: 'all', label: 'All my work' }, { value: 'drafts', label: 'Unfinished input' }, { value: 'planning', label: 'Planning' }, { value: 'in_progress', label: 'In progress' }, { value: 'closed', label: 'Closed' }]} /></div>}
    {!storage.status().persisted && <Notice tone="warning">{copy.memoryOnly}</Notice>}
    {storage.exportRecovery() !== null && <Button variant="secondary" onClick={() => downloadText('partfolk-drafts-recovery.txt', storage.exportRecovery()!, 'text/plain')}>Export original unreadable data</Button>}
    {shownProjects.length > 0 && <section className="pf-stack" aria-labelledby="workspace-projects"><h2 id="workspace-projects">Public projects</h2><ul className="project-list project-library">{shownProjects.map(project => <SavedProjectCard key={project.root.key} project={project} />)}</ul></section>}
    {shownDrafts.length > 0 && <section className="pf-stack" aria-labelledby="workspace-drafts"><div className="project-section-heading"><h2 id="workspace-drafts">Continue unfinished input</h2><p>Recovered from this device. These changes are not published yet.</p></div><ul className="project-list project-library">{shownDrafts.map(draft => <li key={draft.id} className="pf-sheet project-card project-card--draft">
      <div className="project-card-top"><StatusLabel>{draft.projectRoot ? 'Unpublished edits' : 'Not yet published'}</StatusLabel><span className="pf-secondary">{formatDateTime(draft.updatedAt, 'UTC', { dateStyle: 'medium', timeStyle: undefined })}</span></div>
      <h3>{draft.editor.title || 'Untitled project draft'}</h3><p className="project-card-description">{draft.editor.outcome || 'Describe your event and the help you need.'}</p>
      <dl className="project-card-facts"><div><dt>Date and place options</dt><dd>{draft.editor.variants.length || 'To be added'}</dd></div><div><dt>Needs described</dt><dd>{draft.editor.variants.reduce((total, variant) => total + variant.requirements.length, 0)}</dd></div></dl>
      <div className="pf-actions project-card-actions"><Button variant="secondary" onClick={() => { runtime.session.selectDraft(draft.id); window.location.hash = draft.projectRoot ? routeHref({ name: 'project', projectRoot: draft.projectRoot, tab: 'needs' }).slice(1) : '/projects/new'; }}>Continue to publication</Button><Button variant="quiet" onClick={() => downloadText('partfolk-project-draft.json', storage.exportDraft(draft))}>Backup</Button><Button variant="quiet" className="project-draft-delete" onClick={() => { setDeleting(draft); setDeleteError(null); }}>Delete input</Button></div>
    </li>)}</ul></section>}
    {loading && <p role="status">Reading your projects…</p>}
    {!loading && !error && !shownDrafts.length && !shownProjects.length && (drafts.length > 0 || projects.length > 0) && <EmptyState title="No projects match this view" description="Try another title or show all your work." actions={<Button variant="secondary" onClick={() => { setFilter('all'); setSearch(''); }}>Clear filters</Button>} />}
    {!loading && !drafts.length && !projects.length && <section className="pf-sheet project-start"><div className="pf-stack"><h2>Give your event a starting point</h2><p>Set the date, describe the help you need and create a public project for contributors to join.</p><p className="pf-secondary">Your wallet confirms publication to Arkiv. Unfinished input is kept for recovery.</p><Button onClick={create}>Create my first event project</Button></div><ProjectFolio /></section>}
    {(recoveryDrafts.length > 0 || legacyProjects.projects.length > 0 || recoveryStores.some(store => store.exportRecovery())) && <section className="pf-sheet pf-stack project-legacy-recovery" aria-labelledby="legacy-project-recovery"><h2 id="legacy-project-recovery">Recover earlier device-only work</h2><p>Your earlier work is still here. Continue with a public copy to invite contributors through Arkiv. Original files and records are kept.</p>
      {recoveryDrafts.length > 0 && <ul className="project-recovery-list">{recoveryDrafts.map(({ draft, store }) => <li key={`${draft.scope}:${draft.id}`}><div><h3>{draft.editor.title || 'Untitled unfinished project'}</h3><p>{draft.editor.outcome || 'Unfinished event details'}</p></div><div className="pf-actions">{onShareDraft && <Button variant="secondary" onClick={() => onShareDraft(structuredClone(draft))}>Continue as public project</Button>}<Button variant="quiet" onClick={() => downloadText('partfolk-earlier-project-input.json', store.exportDraft(draft))}>Export original input</Button></div></li>)}</ul>}
      {legacyProjects.projects.length > 0 && <ul className="project-recovery-list">{legacyProjects.projects.map(project => <li key={project.root.key}><div><h3>{project.state?.recipe.title || 'Earlier project'}</h3><p>{project.state?.recipe.outcome}</p></div><Link className="pf-button pf-button--secondary" href={routeHref({ name: 'project', projectRoot: project.root.key, tab: 'needs' })}>Open for recovery</Link></li>)}</ul>}
      {recoveryStores.map((store, index) => store.exportRecovery() ? <Button key={index} variant="secondary" onClick={() => downloadText('partfolk-earlier-input-recovery.txt', store.exportRecovery()!, 'text/plain')}>Export unreadable original data</Button> : null)}
    </section>}
    {legacyProjects.error && <Notice tone="warning" title="Earlier device-only work needs recovery">Your original data is retained. Some older project records could not be read.</Notice>}
    {!session.actor && <div className="project-returning"><p>Already have a project?</p><Link href={routeHref({ name: 'sign-in', returnTo: session.destination })}>Sign in with its wallet</Link></div>}
    <details className="project-recovery-tools"><summary>Advanced: recovery and project references</summary><div className="pf-stack"><Button variant="secondary" onClick={() => importRef.current?.click()}>Import an input backup</Button><form className="project-open" onSubmit={event => { event.preventDefault(); if (!isPublicEntityKey(publicId.trim())) { setImportError('Enter the full public project ID.'); return; } window.location.hash = routeHref({ name: 'project', projectRoot: publicId.trim() as `0x${string}`, tab: 'needs' }).slice(1); }}><Field label="Open a public project by reference" value={publicId} onChange={event => setPublicId(event.target.value)} hint="Paste the complete reference from the organizer’s invitation." placeholder="0x…" /><Button type="submit" variant="secondary">Open project</Button></form></div></details>
    <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={async event => {
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 1024 * 1024) { setImportError('The file exceeds the 1 MiB draft limit.'); event.target.value = ''; return; }
      try { const result = storage.importDraft(await file.text()); if (result.status === 'imported') { changed(); setImportError(result.persisted ? null : copy.memoryOnly); setFeedback('Your imported draft is ready in My projects.'); runtime.session.selectDraft(result.draft.id); } else setImportError('This file could not be imported safely. Your existing work is unchanged.'); }
      catch { setImportError('The file could not be read. Your existing work is unchanged.'); }
      event.target.value = '';
    }} />
    {importError && <Notice tone="warning">{importError}</Notice>}
    <div className="project-returning"><Link href={routeHref({ name: 'contributions' })}>Offer time, a place or equipment</Link>{eventsAvailable && <Link href={routeHref({ name: 'events' })}>Browse events to attend</Link>}</div>
    <Dialog open={deleting !== null} title="Delete this draft?" closeLabel="Cancel deletion" onClose={() => { setDeleting(null); setDeleteError(null); }} footer={<><Button variant="secondary" onClick={() => { setDeleting(null); setDeleteError(null); }}>Cancel</Button><Button variant="danger" onClick={remove}>Delete draft</Button></>}>
      {deleting && <div className="pf-stack"><h3>{deleting.editor.title || 'Untitled project draft'}</h3><p>This removes the draft from this device. You can export a copy before deleting it.</p>{deleting.projectRoot && <p>The published project, its agreements and its history will remain. Only these local edits are deleted.</p>}<Button variant="secondary" onClick={() => downloadText('partfolk-project-draft.json', storage.exportDraft(deleting))}>Export this draft</Button>{deleteError && <Notice tone="danger" role="alert">{deleteError}</Notice>}</div>}
    </Dialog>
  </div>;
}
