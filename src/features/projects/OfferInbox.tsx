import { useEffect, useState } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { useRepositoryAction } from '../../app/actions';
import { formatDateTime } from '../../app/time';
import type { EntityKey, ProjectAggregate } from '../../domain/types';
import type { DiscoveryLink, ReplaceProjectCommand } from '../../data/types';
import { createOperationIntent } from '../../data/operations';
import { Button, ContributionRow, Notice, StatusLabel } from '../../ui';
import { admitPublisherInput, authorityFor, ownsProject } from './selectors';
import { projectsCopy as copy, repositoryErrorText } from './catalog';
import { ActionFeedback } from './ActionFeedback';
import { conditionText } from './terms';

export function OfferInbox({ project, onRefresh }: { project: ProjectAggregate; onRefresh: () => Promise<void> }) {
  const runtime = useApp(), session = useAppSession();
  const [links, setLinks] = useState<DiscoveryLink[]>([]), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const action = useRepositoryAction(`project-admission:${project.root.key}`);
  useEffect(() => {
    let cancelled = false;
    if (!runtime.repository) return;
    setLoading(true);
    runtime.repository.listIncomingOffers(project.root.key).then(result => {
      if (cancelled) return;
      if (result.ok) { setLinks(result.value.items); setError(result.value.snapshot.completeness === 'complete' ? null : 'The offer inbox is incomplete. Missing entries are not a statement that nobody offered to help.'); }
      else setError(repositoryErrorText(result.error));
    }).catch(() => { if (!cancelled) setError('The offer inbox could not be read completely. Try a fresh read.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runtime.repository, project.root.key, project.snapshot.fetchedAt]);
  const authority = authorityFor(session.actor, session.mode, session.chainId), owner = ownsProject(project, session.actor);
  const waiting = action.state.status === 'submitting' || action.state.status === 'needs-verification';
  const admit = async (publisherRoot: EntityKey, resume = false) => {
    if (!authority || !owner) return;
    const id = crypto.randomUUID(), now = runtime.now();
    try {
      if (resume) {
        const result = await action.resume((repository, frozen: ReplaceProjectCommand) => repository.replaceProject(frozen));
        if (result.ok && result.value.operation.phase === 'complete') await onRefresh();
        return;
      }
      const input = admitPublisherInput(project, publisherRoot, id, now);
      const command = { ...input, operation: createOperationIntent('replace_project', authority, input, { id, now }) };
      const result = await action.run(command, (repository, frozen) => repository.replaceProject(frozen));
      if (result.ok && result.value.operation.phase === 'complete') await onRefresh();
    } catch { setError('These offers could not be added. Refresh the project before trying again.'); }
  };
  const admitted = project.state.status === 'unique' ? project.state.entity.payload.publisherRoots : [];
  const timeZone = project.state.status === 'unique' ? project.state.entity.payload.recipe.timeZone : 'UTC';
  const unique = [...new Map(links.filter(link => link.status === 'current' && link.publisher).map(link => [link.entity.payload.publisherRoot, link])).values()];
  return <section className="pf-sheet pf-stack"><h2>{copy.offerInbox}</h2><p>{copy.admissionNote}</p>
    {loading && <p role="status">Reading submitted offers…</p>}{error && <Notice tone="warning">{error}</Notice>}
    {!loading && !error && unique.length === 0 && <p>No offers have arrived yet. Share the project invitation with people who can help.</p>}
    {unique.map(link => { const publisher = link.publisher!; const book = publisher.book.status === 'unique' ? publisher.book.entity.payload : null; const included = admitted.includes(publisher.root.key);
      return <ContributionRow key={publisher.root.key} title={book?.offers.map(offer => offer.title).join(', ') || 'Contribution details unavailable'} owner={book?.name ?? publisher.root.key}
        conditions={<div className="pf-stack pf-stack--compact">{book?.description && <p>{book.description}</p>}{book?.offers.map(offer => <section className="project-offer-terms pf-stack pf-stack--compact" key={offer.id}><h4>{offer.title}</h4><p><strong>{offer.quantity} {offer.unit}</strong></p><p>{offer.kind === 'person' ? 'Personal time' : offer.kind === 'place' ? 'Place' : 'Equipment'}</p><p>Skills or uses: {offer.capabilities.join(', ') || 'None specified'}.</p><div><p>Available times ({timeZone}):</p><ul>{offer.availability.map((interval, index) => <li key={index}>{formatDateTime(interval.start, timeZone)} to {formatDateTime(interval.end, timeZone)}</li>)}</ul>{!offer.availability.length && <p>No availability intervals were supplied.</p>}</div>{offer.instructions && <p>{offer.instructions}</p>}{offer.conditions.length > 0 && <div><p><strong>Conditions</strong></p><ul>{offer.conditions.map((condition, index) => <li key={index}>{conditionText(condition, project)}</li>)}</ul></div>}{offer.projectScope.length > 0 && !offer.projectScope.includes(project.root.key) && <Notice tone="warning">This offer is currently restricted to other projects.</Notice>}</section>)}<details><summary>Advanced: contributor reference</summary><p>{publisher.root.key}</p><p>These offers come from this contributor’s account. The display name is their own label.</p></details></div>}
        status={<StatusLabel tone={included ? 'success' : 'neutral'}>{included ? 'Included in planning' : book ? 'Waiting for review' : 'Offer unavailable'}</StatusLabel>}
        action={owner && !included && book ? <Button variant="secondary" disabled={waiting || !authority} onClick={() => { void admit(publisher.root.key); }}>{copy.admission}</Button> : undefined} />;
    })}
    <ActionFeedback action={action} state={action.state} onReconcile={() => { void action.reconcile().then(() => onRefresh()); }} onResume={action.recoverableCommand ? () => { const saved = action.recoverableCommand as ReplaceProjectCommand; void admit(saved.state.publisherRoots.at(-1) ?? project.root.key, true); } : undefined} />
  </section>;
}
