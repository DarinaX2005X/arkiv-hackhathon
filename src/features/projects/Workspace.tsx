import { useEffect, useRef, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import type { RouteViewProps } from '../../app/App';
import { parseRoute, routeHref } from '../../app/routes';
import { isPublicEntityKey } from '../../app/ids';
import type { ProjectSummary } from '../../data/types';
import { Button, EmptyState, Field, Link, Notice, Select, StatusLabel } from '../../ui';
import { downloadText, makeDraft } from './drafts';
import { useProjectDrafts } from './hooks';
import { projectsCopy as copy, repositoryErrorText } from './catalog';

export function WorkspaceRoute(_props: RouteViewProps) {
  const runtime = useApp(), session = useAppSession();
  const { storage, scope, changed } = useProjectDrafts();
  const [projects, setProjects] = useState<ProjectSummary[]>([]), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [filter, setFilter] = useState('active'), [search, setSearch] = useState('');
  const [publicId, setPublicId] = useState(''), [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let cancelled = false;
    setProjects([]); setError(null);
    if (!runtime.repository || !session.actor) return;
    setLoading(true);
    runtime.repository.listProjects(session.actor).then(result => {
      if (cancelled) return;
      if (result.ok) { setProjects(result.value.items); if (result.value.snapshot.completeness !== 'complete') setError('The project list is incomplete. Existing drafts remain available below.'); }
      else setError(repositoryErrorText(result.error));
    }).catch(() => { if (!cancelled) setError('The project list could not be read. Your drafts remain available below.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runtime.repository, session.actor]);
  const shown = projects.filter(project => filter === 'all' || (filter === 'archived' ? project.state?.lifecycle === 'closed' : project.state?.lifecycle !== 'closed'))
    .filter(project => `${project.state?.recipe.title ?? ''} ${project.state?.recipe.outcome ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => (right.state?.createdAt ?? 0) - (left.state?.createdAt ?? 0));
  const create = () => { const draft = makeDraft(scope, undefined, runtime.now()); storage.upsert(draft); runtime.session.selectDraft(draft.id); window.location.hash = '/projects/new'; };
  return <div className="pf-stack project-workspace">
    <header className="project-heading"><div><h1>{copy.title}</h1><p>Shape the work, choose a complete plan and ask each owner to agree.</p></div><Button onClick={create}>{copy.create}</Button></header>
    <form className="pf-sheet project-open" onSubmit={event => { event.preventDefault(); if (!isPublicEntityKey(publicId.trim())) { setImportError('Enter the full public project ID.'); return; } window.location.hash = routeHref({ name: 'project', projectRoot: publicId.trim() as `0x${string}`, tab: 'needs' }).slice(1); }}>
      <Field label="Open a public project" value={publicId} onChange={event => setPublicId(event.target.value)} hint="A project ID is included in its public invitation link. Reading does not require a wallet." placeholder="0x…" />
      <Button type="submit" variant="secondary">Open project</Button>
    </form>
    {error && <Notice tone="warning" title="Project list needs a fresh read">{error}</Notice>}
    <section className="pf-stack" aria-label="Published or local projects">
      <div className="project-filters"><Field label="Find a project" value={search} onChange={event => setSearch(event.target.value)} /><Select label="Show" value={filter} onChange={event => setFilter(event.target.value)} options={[{ value: 'active', label: 'Active projects' }, { value: 'archived', label: 'Closed projects' }, { value: 'all', label: 'All projects' }]} /></div>
      {loading ? <p role="status">Reading your projects…</p> : shown.length === 0 ? <EmptyState title={projects.length === 0 ? copy.noProjects : 'No projects match this view.'} description={projects.length === 0 ? copy.noProjectsBody : 'Change the filter or search text.'} /> : <ul className="project-list">{shown.map(project => <li className="pf-sheet" key={project.root.key}>
        <h2><Link href={routeHref({ name: 'project', projectRoot: project.root.key, tab: project.state?.lifecycle === 'closed' ? 'history' : 'needs' })}>{project.state?.recipe.title ?? 'Project awaiting initialization'}</Link></h2>
        <p>{project.state?.recipe.outcome}</p><StatusLabel>{project.state?.lifecycle === 'closed' ? project.state.completion?.outcome.replaceAll('_', ' ') ?? 'Closed' : project.root.provenance.mode === 'local' ? 'Local project' : 'Public project'}</StatusLabel>
        {project.diagnostics.length > 0 && <p>Some project data needs verification.</p>}
      </li>)}</ul>}
      {!session.actor && <p>Connect to read your own public project list. A known public project can always be opened by its ID.</p>}
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
      {storage.list().length === 0 ? <p>No draft has been saved in this account context.</p> : <ul className="project-list">{storage.list().map(draft => <li key={draft.id} className="pf-sheet"><h3>{draft.editor.title || 'Untitled project draft'}</h3><p>{draft.editor.outcome || 'Continue describing your project.'}</p><div className="pf-actions">
        <Button variant="secondary" onClick={() => { runtime.session.selectDraft(draft.id); window.location.hash = draft.projectRoot ? routeHref({ name: 'project', projectRoot: draft.projectRoot, tab: 'needs' }).slice(1) : '/projects/new'; }}>Continue draft</Button>
        <Button variant="quiet" onClick={() => downloadText('partfolk-project-draft.json', storage.exportDraft(draft))}>Export</Button>
      </div></li>)}</ul>}
    </section>
    <Link href={routeHref(parseRoute('/demo'))}>Try the exhibition practice</Link>
  </div>;
}
