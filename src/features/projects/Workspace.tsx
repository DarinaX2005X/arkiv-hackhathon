import { useEffect, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import type { RouteViewProps } from '../../app/App';
import { parseRoute, routeHref } from '../../app/routes';
import { isPublicEntityKey } from '../../app/ids';
import type { ProjectSummary, Repository } from '../../data/types';
import type { Actor } from '../../domain/types';
import { Button, EmptyState, Field, Link, Notice, Select, StatusLabel } from '../../ui';
import { downloadText } from './drafts';
import { selectNewProjectDraft } from './draft-session';
import { useProjectDrafts } from './hooks';
import { projectsCopy as copy, repositoryErrorText } from './catalog';

export interface WorkspaceProjectList { projects: ProjectSummary[]; loading: boolean; error: string | null }

/** Each read owns its result until the account or route changes. Disconnect ends loading immediately. */
export function readWorkspaceProjects(repository: Pick<Repository, 'listProjects'> | null, actor: Actor | null, update: (state: WorkspaceProjectList) => void) {
  let cancelled = false;
  update({ projects: [], error: null, loading: Boolean(repository && actor) });
  if (repository && actor) {
    void repository.listProjects(actor).then(result => {
      if (cancelled) return;
      update(result.ok ? { projects: result.value.items, loading: false,
        error: result.value.snapshot.completeness === 'complete' ? null : 'The project list is incomplete. Existing drafts remain available below.' }
        : { projects: [], loading: false, error: repositoryErrorText(result.error) });
    }).catch(() => {
      if (!cancelled) update({ projects: [], loading: false, error: 'The project list could not be read. Your drafts remain available below.' });
    });
  }
  return () => { cancelled = true; };
}

export function WorkspaceRoute({ eventsAvailable = false }: RouteViewProps & { eventsAvailable?: boolean }) {
  const runtime = useApp(), session = useAppSession();
  const { storage, changed } = useProjectDrafts();
  const [{ projects, loading, error }, setProjectList] = useState<WorkspaceProjectList>({ projects: [], loading: false, error: null });
  const [filter, setFilter] = useState('active'), [search, setSearch] = useState('');
  const [publicId, setPublicId] = useState(''), [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => readWorkspaceProjects(runtime.repository, session.actor, setProjectList), [runtime.repository, session.actor]);
  const shown = projects.filter(project => filter === 'all' || (filter === 'archived' ? project.state?.lifecycle === 'closed' : project.state?.lifecycle !== 'closed'))
    .filter(project => `${project.state?.recipe.title ?? ''} ${project.state?.recipe.outcome ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => (right.state?.createdAt ?? 0) - (left.state?.createdAt ?? 0));
  const create = () => { selectNewProjectDraft(runtime); window.location.hash = '/projects/new'; };
  return <div className="pf-stack project-workspace">
    <header className="project-heading"><div><h1>{copy.title}</h1><p>Shape the work, choose a complete plan and ask each owner to agree.</p></div><Button onClick={create}>{copy.create}</Button></header>
    <details className="project-open-by-id"><summary>Have a project reference?</summary><form className="pf-sheet project-open" onSubmit={event => { event.preventDefault(); if (!isPublicEntityKey(publicId.trim())) { setImportError('Enter the full public project ID.'); return; } window.location.hash = routeHref({ name: 'project', projectRoot: publicId.trim() as `0x${string}`, tab: 'needs' }).slice(1); }}>
      <Field label="Open a public project" value={publicId} onChange={event => setPublicId(event.target.value)} hint="A project ID is included in its public invitation link. Reading does not require a wallet." placeholder="0x…" />
      <Button type="submit" variant="secondary">Open project</Button>
    </form></details>
    {error && <Notice tone="warning" title="Project list needs a fresh read">{error}</Notice>}
    <section className="pf-stack" aria-label="Published or local projects">
      {projects.length > 0 && <div className="project-filters"><Field label="Find a project" value={search} onChange={event => setSearch(event.target.value)} /><Select label="Show" value={filter} onChange={event => setFilter(event.target.value)} options={[{ value: 'active', label: 'Active projects' }, { value: 'archived', label: 'Closed projects' }, { value: 'all', label: 'All projects' }]} /></div>}
      {!session.actor ? <EmptyState title="Find the work you already own" description="Sign in with the wallet you used before to read your public projects. You can also begin a new draft here without signing in." actions={<Link className="pf-button pf-button--secondary" href={routeHref({ name: 'sign-in', returnTo: session.destination })}>Sign in to my projects</Link>} />
        : loading ? <p role="status">Reading your projects…</p> : shown.length === 0 && !error ? <EmptyState title={projects.length === 0 ? copy.noProjects : 'No projects match this view.'} description={projects.length === 0 ? 'Start with your event’s outcome and the help it needs. A new draft contains no sample people or promises.' : 'Change the filter or search text.'} /> : <ul className="project-list">{shown.map(project => <li className="pf-sheet" key={project.root.key}>
        <h2><Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: project.state?.lifecycle === 'closed' ? 'history' : 'needs' })}>{project.state?.recipe.title ?? 'Project awaiting initialization'}</Link></h2>
        <p>{project.state?.recipe.outcome}</p><StatusLabel>{project.state?.lifecycle === 'closed' ? project.state.completion?.outcome.replaceAll('_', ' ') ?? 'Closed' : project.root.provenance.mode === 'local' ? 'Local project' : 'Public project'}</StatusLabel>
        {project.diagnostics.length > 0 && <p>Some project data needs verification.</p>}
      </li>)}</ul>}
      {projects.length === 0 && !loading && <div className="pf-workspace-other-paths"><p>Here to help someone else?</p><Link href={routeHref({ name: 'contributions' })}>Offer your time, place or equipment</Link>{eventsAvailable && <Link href={routeHref({ name: 'events' })}>Browse events to attend</Link>}</div>}
    </section>
    <section className="pf-stack"><div className="project-heading"><h2>Drafts on this device</h2><Button variant="secondary" onClick={() => importRef.current?.click()}>{copy.importDraft}</Button></div>
      <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={async event => {
        const file = event.target.files?.[0]; if (!file) return;
        if (file.size > 1024 * 1024) { setImportError('The file exceeds the 1 MiB draft limit.'); return; }
        try { const result = storage.importDraft(await file.text()); if (result.status === 'imported') { changed(); setImportError(result.persisted ? null : copy.memoryOnly); runtime.session.selectDraft(result.draft.id); } else setImportError('This file could not be imported safely. Your existing work is unchanged.'); }
        catch { setImportError('The file could not be read. Your existing work is unchanged.'); }
        event.target.value = '';
      }} />
      {importError && <Notice tone="warning">{importError}</Notice>}
      {!storage.status().persisted && <Notice tone="warning">{copy.memoryOnly}</Notice>}
      {storage.exportRecovery() !== null && <Button variant="secondary" onClick={() => downloadText('partfolk-drafts-recovery.txt', storage.exportRecovery()!, 'text/plain')}>Export original unreadable data</Button>}
      {storage.list().length === 0 ? <p>No drafts saved here yet. Create a project to start one, or import a draft you exported earlier.</p> : <ul className="project-list">{storage.list().map(draft => <li key={draft.id} className="pf-sheet"><h3>{draft.editor.title || 'Untitled project draft'}</h3><p>{draft.editor.outcome || 'Continue describing your project.'}</p><div className="pf-actions">
        <Button variant="secondary" onClick={() => { runtime.session.selectDraft(draft.id); window.location.hash = draft.projectRoot ? routeHref({ name: 'project', projectRoot: draft.projectRoot, tab: 'needs' }).slice(1) : '/projects/new'; }}>Continue draft</Button>
        <Button variant="quiet" onClick={() => downloadText('partfolk-project-draft.json', storage.exportDraft(draft))}>Export</Button>
      </div></li>)}</ul>}
    </section>
    <Link href={routeHref(parseRoute('/demo'))}>Try the exhibition practice</Link>
  </div>;
}
