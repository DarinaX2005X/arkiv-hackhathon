import { useEffect, useState } from 'react';
import { formatDateTime, isEntityKey, routeHref, useApp, useAppSession } from '../../app';
import type { RouteViewProps } from '../../app';
import { useRepositoryAction } from '../../app/actions';
import { createOperationIntent } from '../../data/operations';
import type { OperationIntent } from '../../data/types';
import { PROTOCOL } from '../../domain/types';
import type { BookState, EntityKey, Grant, Offer, ProjectLink, PublisherAggregate, Resource } from '../../domain/types';
import { validateBookCapacity } from '../../domain/validation';
import { Button, Checkbox, ContributionRow, Dialog, EmptyState, Field, Link, LoadingState, Notice, Select, StatusLabel, Textarea } from '../../ui';
import { actorScope, affectedProjects, bookLifetime, conditionText, contributionDraft, DEFAULT_LIFETIME, isContributionTarget, ownsPublisher, prepareAvailability, prepareEmptyRecovery, prepareReleaseCommand, publisherName, writeAuthority } from './model';
import type { ContributionTemplate } from './model';
import { OfferEditor } from './OfferEditor';
import { ActionFeedback } from './OperationFeedback';
import { KeepContributionAvailable } from './Renewal';
import { ResolveContributionConflict } from './ResolveConflict';
import { ContributionPreview, DraftStatus, intervalText, Reasons, useContributionDraft, useCurrentTime, useReadGuard } from './shared';
import { contributionDrafts } from './drafts';
import { VisitorDraftHandoff } from './VisitorDraftHandoff';
import './contributions.css';

interface WorkspaceProps { projectRoot?: EntityKey; template?: ContributionTemplate }
function OfferCard({ offer, resource }: { offer: Offer; resource?: Resource }) {
  return <article className="pf-sheet pf-offer-card">
    <div className="pf-offer-card-top"><StatusLabel>Availability offered</StatusLabel><span className="pf-secondary">{offer.kind === 'person' ? 'Time and skills' : offer.kind === 'place' ? 'Space' : 'Equipment'}</span></div>
    <h4>{offer.title}</h4><p className="pf-offer-quantity"><strong>{offer.quantity}</strong> {offer.unit}<span>{resource?.name ?? offer.resourceId}</span></p>
    <div className="pf-offer-times"><h5>Available times</h5>{offer.availability.slice(0, 2).map((window, index) => <p key={index}>{intervalText(window)}</p>)}{offer.availability.length > 2 && <details><summary>{offer.availability.length - 2} more time windows</summary>{offer.availability.slice(2).map((window, index) => <p key={index}>{intervalText(window)}</p>)}</details>}</div>
    <p className="pf-secondary">{offer.capabilities.join(', ')}</p>
    <details><summary>Use and conditions</summary><div className="pf-stack pf-stack--compact">{offer.conditions.map((condition, index) => <p key={index}>{conditionText(condition)}</p>)}<p>{offer.instructions || 'No additional instructions.'}</p><p>{offer.projectScope.length ? `Available to these project references: ${offer.projectScope.join(', ')}` : 'Can be offered to any project you join.'}</p></div></details>
  </article>;
}
export function ContributionsPage(props: RouteViewProps & WorkspaceProps) { return <ContributorWorkspace projectRoot={props.projectRoot} template={props.template} />; }
export function ContributorWorkspace({ projectRoot, template }: WorkspaceProps = {}) {
  const runtime = useApp(); const session = useAppSession();
  const draftRegistry = contributionDrafts(runtime);
  const startListRead = useReadGuard(); const startIdentityRead = useReadGuard();
  const registrationAction = useRepositoryAction('register-contribution');
  const [publishers, setPublishers] = useState<PublisherAggregate[]>([]); const [selected, setSelected] = useState<EntityKey | ''>('');
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [identity, setIdentity] = useState(''); const [inspected, setInspected] = useState<PublisherAggregate | null>(null); const [create, setCreate] = useState(() => draftRegistry.editorOpen(session.actor));
  const chooseCreate = (open: boolean) => { draftRegistry.setEditorOpen(session.actor, open); setCreate(open); };
  const [prepared, setPrepared] = useState<{ rootKey: EntityKey; template: ContributionTemplate } | null>(null);
  const refresh = async () => {
    if (!runtime.repository) { setError('The selected data source is unavailable.'); return; }
    const currentRead = startListRead();
    setLoading(true); setError('');
    try {
      if (session.actor) {
        const result = await runtime.repository.listOwnPublishers(session.actor);
        if (!currentRead()) return;
        if (!result.ok) throw new Error('Your contributions could not be completely read. Refresh to try again.');
        setPublishers(result.value.items);
        if (result.value.snapshot.completeness !== 'complete' || result.value.diagnostics.length) setError('The contribution list may be incomplete. Existing records remain available by identity.');
        if (result.value.items[0]) setSelected(current => current || result.value.items[0]!.root.key);
      } else setPublishers([]);
      if (inspected) { const result = await runtime.repository.loadPublisher(inspected.root.key); if (!currentRead()) return; if (result.ok) setInspected(result.value); else setError('This publisher is unavailable. If its identity expired, a new identity must be invited into projects again.'); }
    } catch (caught) { if (currentRead()) { setPublishers(previous => previous.map(p => ({ ...p, snapshot: { ...p.snapshot, freshness: 'stale', completeness: 'incomplete' } }))); setError(caught instanceof Error ? caught.message : 'Contributions could not be refreshed.'); } }
    finally { if (currentRead()) setLoading(false); }
  };
  useEffect(() => { setPublishers([]); setSelected(''); setInspected(null); setCreate(draftRegistry.editorOpen(session.actor)); setPrepared(null); setLoading(false); void refresh(); }, [runtime.repository, actorScope(session.actor), session.mode]);
  const inspect = async () => {
    if (!isContributionTarget(identity, session.mode)) { setError(session.mode === 'public' ? 'Enter a complete public contribution identity beginning with 0x.' : 'Enter a local contribution identity beginning with local:.'); return; }
    if (!runtime.repository) return; const current = startIdentityRead(); setLoading(true);
    const result = await runtime.repository.loadPublisher(identity); if (!current()) return; setLoading(false);
    if (!result.ok) { setError('That contribution could not be read. A missing publisher identity cannot be recovered; its owner must create a new identity and be invited again.'); return; }
    setInspected(result.value); setError('');
  };
  const current = inspected ?? publishers.find(p => p.root.key === selected) ?? publishers[0];
  return <div className="pf-stack pf-contributions-workspace"><header className="pf-stack pf-stack--compact"><h1>My contributions</h1><p className="pf-prose">Keep your time, spaces, and equipment in one place. Share offers with projects, review requests, and see what you have already promised.</p><div className="pf-actions"><Button variant={current ? "quiet" : "primary"} onClick={() => chooseCreate(!create)}>{create ? "Close new profile" : current ? "Add another contribution profile" : "Offer a contribution"}</Button><Link href={routeHref({ name: 'requests' })}>Review requests</Link><Button variant="quiet" disabled={loading} onClick={() => void refresh()}>Refresh</Button></div></header>
    {!session.actor && <p>Have contributions already? <Link href={routeHref({ name: 'sign-in', returnTo: session.destination })}>Sign in with your wallet</Link> to return to them.</p>}
    {error && <Notice tone="warning" role="alert">{error}</Notice>}{!create && registrationAction.state.status === 'needs-verification' && <section className="pf-stack"><ActionFeedback action={registrationAction} onRefresh={refresh} /><Button variant="secondary" onClick={() => setCreate(true)}>Open the saved identity draft</Button></section>}
    {create && <NewPublisher key={actorScope(session.actor)} template={template} onCreated={async (key, nextTemplate) => { chooseCreate(false); setSelected(key); setInspected(null); setPrepared({ rootKey: key, template: nextTemplate }); await refresh(); }} />}
    {publishers.length > 1 && <Select label="My contribution profile" value={selected} onChange={e => { setSelected(e.target.value as EntityKey); setInspected(null); }} options={publishers.map(p => ({ value: p.root.key, label: publisherName(p, p.root.key) }))} />}
    {loading && !current && <LoadingState title="Reading contributions" />}
    {current ? <PublisherContributions key={`${actorScope(session.actor)}:${current.root.key}`} publisher={current} onRefresh={refresh} projectRoot={projectRoot} template={prepared?.rootKey === current.root.key ? prepared.template : undefined} /> : !loading && <EmptyState title="Your first contribution starts here" description="Add your name and what you can offer. You will review each project plan before agreeing." />}
    <details className="pf-sheet"><summary>Read a shared contribution</summary><div className="pf-stack"><Field label="Contribution identity" value={identity} onChange={e => setIdentity(e.target.value)} hint="Use the public identity from an invitation or another client." /><Button variant="secondary" disabled={loading || !isContributionTarget(identity, session.mode)} onClick={() => void inspect()}>Read contribution</Button></div></details>
  </div>;
}
function NewPublisher({ template, onCreated }: { template?: ContributionTemplate; onCreated: (key: EntityKey, prepared: ContributionTemplate) => void | Promise<void> }) {
  const runtime = useApp(); const session = useAppSession(); const authority = writeAuthority(session.actor, session.mode, session.chainId);
  const action = useRepositoryAction('register-contribution');
  const draft = useContributionDraft('new', template ?? { name: '', description: '', resources: [], offers: [] });
  const kind = draft.draft.publisherKind ?? template?.kind ?? 'individual';
  const [review, setReview] = useState(false); const [error, setError] = useState(''); const [invalid, setInvalid] = useState(false);
  const submit = async () => {
    if (!authority || !draft.draft.name.trim()) return;
    const input = { kind, name: draft.draft.name.trim(), description: draft.draft.description, lifetimeSeconds: DEFAULT_LIFETIME * 2 };
    const command = { ...input, operation: createOperationIntent('register_publisher', authority, input, { now: runtime.now() }) };
    const result = await action.run(command, (repo, value) => repo.registerPublisher(value));
    if (result.ok && actorScope(runtime.session.getSnapshot().actor) === actorScope(authority.actor)) { setReview(false); await onCreated(result.value.value.root.key, { ...draft.draft, kind }); }
  };
  const recoverRegistration = async (operation = action.state.operation) => {
    if (!runtime.repository || !session.actor || !operation || actorScope(runtime.session.getSnapshot().actor) !== actorScope(session.actor)) return;
    const own = await runtime.repository.listOwnPublishers(session.actor);
    if (actorScope(runtime.session.getSnapshot().actor) !== actorScope(session.actor)) return;
    if (own.ok) { const created = own.value.items.find(p => operation.confirmedKeys.includes(p.root.key) || p.root.payload.operationId === operation.id); if (created) await onCreated(created.root.key, { ...draft.draft, kind }); }
  };
  return <section className="pf-sheet pf-stack"><h2>Create my contribution profile</h2><VisitorDraftHandoff pending={action.state.status === 'submitting' || action.state.status === 'needs-verification'} onUse={() => { setReview(false); setError(''); }} /><fieldset className="pf-contribution-handoff-fields pf-stack" disabled={draft.locked}><legend className="pf-visually-hidden">Contribution draft</legend><Field label="Public name" value={draft.draft.name} onChange={e => draft.setDraft({ ...draft.draft, name: e.target.value })} error={error || undefined} /><Select label="I am contributing as" value={kind} onChange={e => draft.setDraft({ ...draft.draft, publisherKind: e.target.value as typeof kind })} options={[{ value: 'individual', label: 'An individual' }, { value: 'organization', label: 'An organization or group' }]} /><Textarea label="Public description" value={draft.draft.description} onChange={e => draft.setDraft({ ...draft.draft, description: e.target.value })} /><OfferEditor draft={draft.draft} onChange={draft.setDraft} kind={kind} now={runtime.now()} onInvalid={setInvalid} showProfileFields={false} /></fieldset><DraftStatus saved={draft.saved} onExport={draft.exportDraft} recovery={draft.recovery} onExportRecovery={draft.exportRecovery} onReplaceRecovery={draft.replaceRecovery} /><Button disabled={!authority || action.state.status === 'submitting' || action.state.status === 'needs-verification'} disabledReason={!authority ? session.mode === 'public' ? 'Connect your owner wallet on Tiramisu. Your draft stays on this device.' : 'Select your practice role. Your draft stays on this device.' : undefined} onClick={() => { if (!draft.draft.name.trim()) setError('Enter a public name.'); else { setError(''); setReview(true); } }}>Review profile</Button><ActionFeedback action={action} onRefresh={recoverRegistration} />
    <Dialog open={review} title="Publish my contribution profile" closeLabel="Cancel" onClose={() => setReview(false)} footer={<><Button variant="secondary" onClick={() => setReview(false)}>Cancel</Button><Button disabled={action.state.status === 'submitting' || action.state.status === 'needs-verification'} onClick={() => void submit()}>Create my profile</Button></>}><div className="pf-stack"><p><strong>{draft.draft.name}</strong>, {kind}</p><p>{draft.draft.description}</p><Notice>{session.mode === 'public' ? 'Your name and description will be public. Use details you are comfortable sharing.' : 'This creates a contribution in the practice example.'}</Notice>{invalid && <Notice tone="warning">Some resource fields still need correction. They remain saved as drafts and cannot be published as availability yet.</Notice>}<p>Your profile is saved first. Next, review and publish the offers you prepared.</p></div></Dialog>
  </section>;
}
export function PublisherContributions({ publisher, onRefresh, projectRoot, template }: { publisher: PublisherAggregate; onRefresh?: () => void | Promise<void> } & WorkspaceProps) {
  const session = useAppSession(); const runtime = useApp(); const action = useRepositoryAction(`contribution:${publisher.root.key}`);
  const availabilityAction = useRepositoryAction(`availability:${publisher.root.key}`);
  const now = useCurrentTime();
  const owned = ownsPublisher(publisher, session.actor); const authority = writeAuthority(session.actor, session.mode, session.chainId);
  const [edit, setEdit] = useState(Boolean(template)); const [recover, setRecover] = useState(false); const [recoveryName, setRecoveryName] = useState(''); const [understood, setUnderstood] = useState(false);
  const [release, setRelease] = useState<Grant | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const blocked = busy || action.state.status === 'submitting' || action.state.status === 'needs-verification' || availabilityAction.state.status === 'submitting' || availabilityAction.state.status === 'needs-verification';
  const book = publisher.book.status === 'unique' ? publisher.book.entity.payload : null;
  const fresh = async () => { if (!runtime.repository) throw new Error('The data source is unavailable.'); const result = await runtime.repository.loadPublisher(publisher.root.key); if (!result.ok) throw new Error('The publisher identity is unavailable. If it expired, create a new identity and ask the coordinator to invite it.'); return result.value; };
  const recoverBook = async () => {
    if (!authority || !understood) return; setBusy(true); setError('');
    try { const command = prepareEmptyRecovery(await fresh(), authority, recoveryName, runtime.now(), crypto.randomUUID()); await action.run(command, (repo, input) => repo.replaceBook(input)); setRecover(false); await onRefresh?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Recovery could not be prepared.'); } finally { setBusy(false); }
  };
  const releaseGrant = async () => {
    if (!authority || !release) return; setBusy(true); setError('');
    try { const command = prepareReleaseCommand(await fresh(), authority, release, runtime.now(), crypto.randomUUID()); await action.run(command, (repo, input) => repo.replaceBook(input)); setRelease(null); await onRefresh?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The release could not be prepared.'); } finally { setBusy(false); }
  };
  return <section className="pf-stack pf-contribution-profile"><header className="pf-sheet pf-stack pf-stack--compact"><h2>{publisherName(publisher, publisher.root.key)}</h2>{book?.description && <p>{book.description}</p>}<p className="pf-secondary">{publisher.root.payload.kind === 'individual' ? 'Individual contribution' : 'Organization contribution'}, {owned ? 'My profile' : 'Read-only view'}, checked {formatDateTime(publisher.snapshot.fetchedAt, 'UTC')} UTC</p></header>
    {publisher.snapshot.freshness !== 'fresh' || publisher.snapshot.completeness !== 'complete' ? <Notice tone="warning">Current availability is unverified. Refresh before relying on this contribution.</Notice> : null}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}<ActionFeedback action={action} onRefresh={onRefresh} />{!edit && <ActionFeedback action={availabilityAction} onRefresh={onRefresh} />}
    <ResolveContributionConflict publisher={publisher} onRefresh={onRefresh} />{book ? <><section className="pf-stack"><div className="pf-actions"><h3>Available offers</h3>{owned && <Button variant={edit ? "secondary" : "primary"} disabled={!authority || blocked} onClick={() => setEdit(!edit)}>{edit ? 'Close editor' : 'Edit my offers'}</Button>}</div>{book.offers.length ? <div className="pf-offer-grid">{book.offers.map(offer => <OfferCard key={offer.id} offer={offer} resource={book.resources.find(r => r.id === offer.resourceId)} />)}</div> : <EmptyState title="No current offers" description="The owner must declare current resources and availability before a project can use them." />}</section>
      {owned && edit && <EditAvailability key={publisher.book.status === 'unique' ? publisher.book.entity.key : ''} publisher={publisher} template={template} onRefresh={onRefresh} />}
      {owned && book.offers.length > 0 && <ShareOffers publisher={publisher} projectRoot={projectRoot} onRefresh={onRefresh} />}
      <section className="pf-sheet pf-stack"><h3>Promised across projects</h3><p className="pf-secondary">These promises reserve your time or equipment until their deadline. You can review and withdraw a promise here.</p>{book.grants.length ? book.grants.map(grant => <ContributionRow key={grant.id} title={`Commitment to ${grant.projectRoot}`} owner={`Approval valid until ${formatDateTime(grant.validUntil, 'UTC')} UTC`} conditions={<div className="pf-stack pf-stack--compact">{grant.allocations.map(a => <p key={a.id}>{a.quantity} {a.unit}, {book.resources.find(r => r.id === a.resourceId)?.name ?? a.resourceId}, {intervalText(a.interval)}</p>)}<Link href={routeHref({ name: 'project', projectRoot: grant.projectRoot, tab: 'agreement' })}>Open complete agreement</Link></div>} status={<StatusLabel tone={grant.validUntil <= now ? 'warning' : 'neutral'}>{grant.validUntil <= now ? 'Approval deadline passed' : 'Capacity held'}</StatusLabel>} action={owned && authority && <Button variant="quiet" disabled={blocked} onClick={() => setRelease(grant)}>Review release</Button>} />) : <p>You have no current project promises.</p>}<Reasons reasons={validateBookCapacity(publisher, book, publisher.snapshot.blockTimestamp).reasons} /></section>
      <section className="pf-sheet pf-stack"><h3>Equipment custody</h3>{book.custodyHolds.length ? book.custodyHolds.map(hold => <ContributionRow key={hold.id} title={`${hold.quantity} ${hold.unit}, ${book.resources.find(r => r.id === hold.resourceId)?.name ?? hold.resourceId}`} owner={`Project ${hold.projectRoot}`} status={<StatusLabel tone={hold.status === 'outstanding' ? 'warning' : 'neutral'}>{hold.status === 'outstanding' ? 'Return unresolved' : 'Owner recorded release'}</StatusLabel>} conditions={<p>{hold.release?.reason ?? 'This capacity remains held even after the approval deadline or project closure.'}</p>} action={<Link href={routeHref({ name: 'project', projectRoot: hold.projectRoot, tab: 'runbook' })}>Review handover and return</Link>} />) : <p>No equipment holds are recorded here.</p>}</section>
      <details><summary>Decision history ({book.decisions.length})</summary><div className="pf-stack">{book.decisions.map(d => <article key={`${d.projectRoot}:${d.activationKey}`}><p>{d.status}, {d.projectRoot}, {formatDateTime(d.decidedAt, 'UTC')} UTC</p><p>{d.reason}</p><p className="pf-contribution-identity">Activation: {d.activationKey}</p><Link href={routeHref({ name: 'project', projectRoot: d.projectRoot, tab: 'agreement' })}>Check current agreement</Link></article>)}</div></details>
    </> : <>{publisher.book.status !== 'conflict' && <Notice tone="warning" title={publisher.book.status === 'missing' ? 'Your saved offers are missing' : 'Your offers could not be checked'}>Refresh to try again. If your saved offers have expired, start with empty offers and add your current availability.</Notice>}{owned && publisher.book.status === 'missing' && <Button disabled={!authority || blocked} onClick={() => setRecover(true)}>Restore my offers</Button>}</>}
    {owned && <details><summary>Keep my offers available longer</summary><KeepContributionAvailable publisher={publisher} onRefresh={onRefresh} /></details>}<details className="pf-contribution-details"><summary>Account and record details</summary><dl><dt>Publisher identity</dt><dd>{publisher.root.key}</dd><dt>Creator account</dt><dd>{publisher.root.provenance.creator.kind === 'wallet' ? publisher.root.provenance.creator.address : publisher.root.provenance.creator.id}</dd><dt>Root expiration block</dt><dd>{publisher.root.provenance.expiresAtBlock ?? 'Local practice lifetime'}</dd>{publisher.book.status === 'unique' && <><dt>Availability expiration block</dt><dd>{publisher.book.entity.provenance.expiresAtBlock ?? 'Local practice lifetime'}</dd><dt>Book</dt><dd>{publisher.book.entity.key}</dd></>}</dl><p>Record lifetime and approval deadlines are separate. Renewing a record never revives expired approval.</p></details>
    <Dialog open={recover} title="Restore my offers" closeLabel="Cancel" onClose={() => { if (!busy) setRecover(false); }} footer={<><Button variant="secondary" onClick={() => setRecover(false)} disabled={busy}>Cancel</Button><Button disabled={!understood || !recoveryName.trim() || blocked} onClick={() => void recoverBook()}>Start with empty offers</Button></>}><div className="pf-stack"><Notice tone="warning">Start again under your existing profile, then add what you can offer now. Previous promises and work records cannot be restored from missing data. Any equipment still with another project must be resolved there.</Notice><Field label="Current public name" value={recoveryName} onChange={e => setRecoveryName(e.target.value)} /><Checkbox label="I understand that availability and approvals must be declared again, and missing records do not prove equipment was returned." checked={understood} onChange={e => setUnderstood(e.target.checked)} /></div></Dialog>
    <Dialog open={release !== null} title="Release this project commitment" closeLabel="Cancel" onClose={() => { if (!busy) setRelease(null); }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setRelease(null)}>Cancel</Button><Button variant="danger" disabled={blocked} onClick={() => void releaseGrant()}>Publish my release</Button></>}><div className="pf-stack"><p>Project: {release?.projectRoot}</p>{release?.allocations.map(a => <p key={a.id}>{a.quantity} {a.unit}, {intervalText(a.interval)}</p>)}<Notice tone="warning">This removes this exact timed commitment and records your withdrawal. The project may need a replacement. Equipment custody and work history remain unchanged. A public release and withdrawal are visible to others.</Notice></div></Dialog>
  </section>;
}
function EditAvailability({ publisher, template, onRefresh }: { publisher: PublisherAggregate; template?: ContributionTemplate; onRefresh?: () => void | Promise<void> }) {
  const runtime = useApp(); const session = useAppSession(); const action = useRepositoryAction(`availability:${publisher.root.key}`); const authority = writeAuthority(session.actor, session.mode, session.chainId);
  const book = publisher.book.status === 'unique' ? publisher.book.entity.payload : null;
  const initial = book ? contributionDraft(book) : { name: '', description: '', resources: [], offers: [] };
  const draft = useContributionDraft(`${publisher.root.key}:${publisher.book.status === 'unique' ? publisher.book.entity.key.slice(-16) : 'missing'}`, template && book && !book.resources.length && !book.offers.length ? { ...initial, resources: structuredClone(template.resources), offers: structuredClone(template.offers), ...(template.editorWindows ? { editorWindows: structuredClone(template.editorWindows) } : {}), ...(template.editorNumbers ? { editorNumbers: structuredClone(template.editorNumbers) } : {}) } : initial);
  const [invalid, setInvalid] = useState(false); const [review, setReview] = useState(false); const [reviewBook, setReviewBook] = useState<BookState | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  if (!book) return null;
  const affected = affectedProjects(book, draft.draft);
  const check = () => { if (!authority) return false; try { const command = prepareAvailability(publisher, draft.draft, authority, runtime.now(), crypto.randomUUID()); const capacity = validateBookCapacity(publisher, command.book, publisher.snapshot.blockTimestamp); if (!capacity.valid) throw new Error('The current commitments exceed the edited capacity. Release the affected commitment explicitly first.'); setReviewBook(command.book); setError(''); return true; } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check the contribution.'); return false; } };
  const submit = async () => {
    if (!runtime.repository || !authority) return; setBusy(true); setError('');
    try {
      const fresh = await runtime.repository.loadPublisher(publisher.root.key); if (!fresh.ok) throw new Error('The current book could not be refreshed.');
      if (fresh.value.book.status !== 'unique' || publisher.book.status !== 'unique' || fresh.value.book.entity.key !== publisher.book.entity.key) throw new Error('Availability changed in another session. Refresh and review it before publishing this draft.');
      const command = prepareAvailability(fresh.value, draft.draft, authority, runtime.now(), crypto.randomUUID());
      const capacity = validateBookCapacity(fresh.value, command.book, fresh.value.snapshot.blockTimestamp); if (!capacity.valid) throw new Error('Current promises exceed this resource capacity. Resolve the commitment before editing capacity.');
      await action.run(command, (repo, input) => repo.replaceBook(input)); setReview(false); await onRefresh?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The availability update could not be prepared.'); } finally { setBusy(false); }
  };
  return <section className="pf-sheet pf-stack"><h3>Edit my resources and offers</h3><OfferEditor draft={draft.draft} onChange={draft.setDraft} kind={publisher.root.payload.kind} now={runtime.now()} onInvalid={setInvalid} /><DraftStatus saved={draft.saved} onExport={draft.exportDraft} recovery={draft.recovery} onExportRecovery={draft.exportRecovery} onReplaceRecovery={draft.replaceRecovery} />{error && <Notice tone="danger" role="alert">{error}</Notice>}<ActionFeedback action={action} onRefresh={onRefresh} /><Button disabled={invalid || busy || action.state.status === 'submitting' || action.state.status === 'needs-verification'} disabledReason={invalid ? 'Correct the availability times first.' : undefined} onClick={() => { if (check()) setReview(true); }}>Review availability changes</Button><Dialog open={review} title="Publish my current availability" closeLabel="Cancel" onClose={() => { if (!busy) setReview(false); }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setReview(false)}>Cancel</Button><Button disabled={busy || action.state.status === 'submitting' || action.state.status === 'needs-verification'} onClick={() => void submit()}>Publish availability</Button></>}><div className="pf-stack">{reviewBook && <ContributionPreview draft={reviewBook} />}{affected.length > 0 && <Notice tone="warning" title="Current agreements will need review"><p>These projects use terms or resources you are changing: {affected.join(', ')}. Their existing approvals will not agree to your new terms. This update preserves the existing commitments until you explicitly release them.</p></Notice>}<Notice>{session.mode === 'public' ? 'The complete resource and offer descriptions will be public. Only publish information you intend to share.' : 'This updates local practice only.'}</Notice><p>Your promises and work records are kept. This requests about {Math.ceil(bookLifetime(book, runtime.now()) / 86400)} days of storage to cover current approval deadlines. Network expiry is measured in blocks, so the duration is an estimate.</p></div></Dialog></section>;
}
function ShareOffers({ publisher, projectRoot, onRefresh }: { publisher: PublisherAggregate; projectRoot?: EntityKey; onRefresh?: () => void | Promise<void> }) {
  const runtime = useApp(); const session = useAppSession(); const authority = writeAuthority(session.actor, session.mode, session.chainId); const action = useRepositoryAction(`share:${publisher.root.key}`);
  const [target, setTarget] = useState<string>(projectRoot ?? ''); const [selected, setSelected] = useState<string[]>([]); const [error, setError] = useState(''); const [review, setReview] = useState(false);
  const book = publisher.book.status === 'unique' ? publisher.book.entity.payload : null; if (!book) return null;
  const publish = async () => {
    if (!authority || !runtime.repository || !isContributionTarget(target, session.mode)) return; setError('');
    const project = await runtime.repository.loadProject(target); if (!project.ok) { setError('The project could not be read. Check its identity and try again.'); return; }
    const now = runtime.now(); const id = crypto.randomUUID();
    const link: ProjectLink = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'project_link', operationId: id, createdAt: now,
      linkKind: 'offer', projectRoot: target, publisherRoot: publisher.root.key, offerIds: selected };
    const input = { link, lifetimeSeconds: DEFAULT_LIFETIME };
    await action.run({ ...input, operation: createOperationIntent('publish_project_link', authority, input, { id, now }) }, (repo, command) => repo.publishProjectLink(command)); setReview(false); await onRefresh?.();
  };
  return <section className="pf-sheet pf-stack"><h3>Introduce my offers to a project</h3><p>Highlight the offers you want the organizer to notice. Once you join the project, its planner can consider all your eligible current offers. You still approve the complete plan yourself.</p><Field label="Project code" value={target} onChange={e => setTarget(e.target.value)} hint="Paste the code from your project invitation." />{book.offers.map(o => <Checkbox key={o.id} label={o.title} checked={selected.includes(o.id)} onChange={e => setSelected(e.target.checked ? [...selected, o.id] : selected.filter(id => id !== o.id))} />)}{error && <Notice tone="danger">{error}</Notice>}<ActionFeedback action={action} onRefresh={onRefresh} /><Button variant="secondary" disabled={!authority || !isContributionTarget(target, session.mode) || !selected.length || action.state.status === 'submitting' || action.state.status === 'needs-verification'} onClick={() => setReview(true)}>Review introduction</Button><Dialog open={review} title="Introduce my offers" closeLabel="Cancel" onClose={() => setReview(false)} footer={<><Button variant="secondary" onClick={() => setReview(false)}>Cancel</Button><Button disabled={action.state.status === 'submitting' || action.state.status === 'needs-verification'} onClick={() => void publish()}>Share with project</Button></>}><div className="pf-stack"><p>Project: {target}</p><p>Highlighted offers: {selected.map(id => book.offers.find(o => o.id === id)?.title ?? id).join(', ')}</p><Notice>{session.mode === 'public' ? 'Your introduction is public. The highlighted offers are a starting point, not a limit on which eligible offers the planner may consider. You approve any complete plan yourself.' : 'This introduces the highlighted offers in the example. The planner may also consider your other eligible offers; you still approve the complete plan yourself.'}</Notice></div></Dialog></section>;
}
