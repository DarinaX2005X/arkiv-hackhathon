import { useEffect, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import type { RouteViewProps } from '../../app/App';
import { routeHref } from '../../app/routes';
import { isPublicEntityKey } from '../../app/ids';
import { formatDateTime } from '../../app/time';
import type { ProjectSummary, Repository } from '../../data/types';
import type { Actor } from '../../domain/types';
import { Button, Dialog, EmptyState, Field, Link, Notice, Select, StatusLabel } from '../../ui';
import { downloadText, type SavedProjectDraft } from './drafts';
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
export function WorkspaceRoute({ eventsAvailable = false }: RouteViewProps & { eventsAvailable?: boolean }) {
  const runtime = useApp(), session = useAppSession();
  const { storage, changed } = useProjectDrafts();
  const [{ projects, loading, error }, setProjectList] = useState<WorkspaceProjectList>({ projects: [], loading: false, error: null });
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState('');
  const [publicId, setPublicId] = useState(''), [importError, setImportError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedProjectDraft | null>(null), [deleteError, setDeleteError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState(''), [readVersion, setReadVersion] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => readWorkspaceProjects(runtime.repository, session.actor, setProjectList), [runtime.repository, session.actor, readVersion]);
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
    <header className="project-heading"><div><h1>My projects</h1><p>Pick up your event, bring in contributions and keep everyone working from the same agreement.</p></div><Button onClick={create}>Start new project</Button></header>
    {error && <Notice tone="warning" title="Your projects could not be fully checked"><p>{error}</p><Button variant="secondary" onClick={() => setReadVersion(value => value + 1)}>Try again</Button></Notice>}
    {feedback && <p role="status">{feedback}</p>}
    {(drafts.length > 0 || projects.length > 0) && <div className="project-filters"><Field label="Find a project" value={search} placeholder="Search by title or outcome" onChange={event => setSearch(event.target.value)} /><Select label="Show" value={filter} onChange={event => setFilter(event.target.value)} options={[{ value: 'all', label: 'All my work' }, { value: 'drafts', label: 'Drafts' }, { value: 'planning', label: 'Planning' }, { value: 'in_progress', label: 'In progress' }, { value: 'closed', label: 'Closed' }]} /></div>}
    {!storage.status().persisted && <Notice tone="warning">{copy.memoryOnly}</Notice>}
    {storage.exportRecovery() !== null && <Button variant="secondary" onClick={() => downloadText('partfolk-drafts-recovery.txt', storage.exportRecovery()!, 'text/plain')}>Export original unreadable data</Button>}
    {shownDrafts.length > 0 && <section className="pf-stack" aria-labelledby="workspace-drafts"><div className="project-section-heading"><h2 id="workspace-drafts">Drafts</h2><p>Saved on this device</p></div><ul className="project-list project-library">{shownDrafts.map(draft => <li key={draft.id} className="pf-sheet project-card project-card--draft">
      <div className="project-card-top"><StatusLabel>{draft.projectRoot ? 'Unpublished edits' : 'Draft'}</StatusLabel><span className="pf-secondary">{formatDateTime(draft.updatedAt, 'UTC', { dateStyle: 'medium', timeStyle: undefined })}</span></div>
      <h3>{draft.editor.title || 'Untitled project draft'}</h3><p className="project-card-description">{draft.editor.outcome || 'Describe your event and the help you need.'}</p>
      <dl className="project-card-facts"><div><dt>Date and place options</dt><dd>{draft.editor.variants.length || 'To be added'}</dd></div><div><dt>Needs described</dt><dd>{draft.editor.variants.reduce((total, variant) => total + variant.requirements.length, 0)}</dd></div></dl>
      <div className="pf-actions project-card-actions"><Button variant="secondary" onClick={() => { runtime.session.selectDraft(draft.id); window.location.hash = draft.projectRoot ? routeHref({ name: 'project', projectRoot: draft.projectRoot, tab: 'needs' }).slice(1) : '/projects/new'; }}>Continue draft</Button><Button variant="quiet" onClick={() => downloadText('partfolk-project-draft.json', storage.exportDraft(draft))}>Export</Button><Button variant="quiet" className="project-draft-delete" onClick={() => { setDeleting(draft); setDeleteError(null); }}>Delete</Button></div>
    </li>)}</ul></section>}
    {shownProjects.length > 0 && <section className="pf-stack" aria-labelledby="workspace-projects"><h2 id="workspace-projects">Projects</h2><ul className="project-list project-library">{shownProjects.map(project => <SavedProjectCard key={project.root.key} project={project} />)}</ul></section>}
    {loading && <p role="status">Reading your projects…</p>}
    {!loading && !error && !shownDrafts.length && !shownProjects.length && (drafts.length > 0 || projects.length > 0) && <EmptyState title="No projects match this view" description="Try another title or show all your work." actions={<Button variant="secondary" onClick={() => { setFilter('all'); setSearch(''); }}>Clear filters</Button>} />}
    {!loading && !drafts.length && !projects.length && <section className="pf-sheet project-start"><div className="pf-stack"><h2>Give your event a starting point</h2><p>Describe what you want to make happen. Add possible dates and the people, place or equipment you need.</p><p className="pf-secondary">Your draft is saved here as you write. You decide when to publish it.</p><Button onClick={create}>Create my first draft</Button></div><ProjectFolio /></section>}
    {!session.actor && <div className="project-returning"><p>Already have a project?</p><Link href={routeHref({ name: 'sign-in', returnTo: session.destination })}>Sign in with its wallet</Link></div>}
    <div className="project-library-tools"><Button variant="secondary" onClick={() => importRef.current?.click()}>Import a draft</Button><details className="project-open-by-id"><summary>Open a shared project</summary><form className="pf-sheet project-open" onSubmit={event => { event.preventDefault(); if (!isPublicEntityKey(publicId.trim())) { setImportError('Enter the full public project ID.'); return; } window.location.hash = routeHref({ name: 'project', projectRoot: publicId.trim() as `0x${string}`, tab: 'needs' }).slice(1); }}><Field label="Project ID" value={publicId} onChange={event => setPublicId(event.target.value)} hint="Use the ID from the organizer’s invitation." placeholder="0x…" /><Button type="submit" variant="secondary">Open project</Button></form></details></div>
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
