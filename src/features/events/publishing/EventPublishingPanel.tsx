import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionRecovery } from '../../../app/ActionRecovery';
import { routeHref, routePath } from '../../../app/routes';
import type { AppSession } from '../../../app/session';
import type { StoragePort } from '../../../app/storage';
import { formatDateTime, type TimeDisambiguation } from '../../../app/time';
import type { EventRepositoryContract } from '../../../data/events/types';
import type { RepositoryError } from '../../../data/types';
import { deriveEventAvailability, type AudienceTerms, type EventAggregate } from '../../../domain/events';
import { sameActor } from '../../../domain/readiness';
import { TIRAMISU_CHAIN_ID, type PublicEntityKey } from '../../../domain/types';
import { Button, Checkbox, Field, Link, Notice, PlanDiff, Select, StatusLabel, Textarea } from '../../../ui';
import { downloadText } from '../../projects/drafts';
import { useEventClock } from '../hooks';
import { availabilityCopy, eventDate } from '../presentation';
import { browserEventStorage, useEventAction } from '../useEventAction';
import { confirmPublishingReview, draftAfterPublication, emptyPublishingFields, organizerAccess, preparePublishingReview, publishingDraftMemory, publishingDraftStore, publishingFields,
  reviewOriginalCommand, submitPublishingCommand, type PublishingCommand, type PublishingDraft, type PublishingFields, type PublishingKind, type PublishingReview } from './model';
import '../events.css';
import './publishing.css';

export interface EventPublishingPanelProps {
  projectRoot: PublicEntityKey; repository: EventRepositoryContract | null; session: AppSession;
  storage?: StoragePort | null; onRefresh?: () => void;
}
const labels: Record<keyof AudienceTerms, string> = { title: 'Event title', description: 'About the event', startsAt: 'Start time', endsAt: 'End time',
  timeZone: 'Time zone', venue: 'Place', instructions: 'Before you come', conditions: 'Participation conditions' };
const actionCopy: Record<PublishingKind, { title: string; confirm: string; effect: string }> = {
  publish: { title: 'Publish visitor details', confirm: 'Publish event and open registration', effect: 'These details become the current public event version. Anyone registered for an earlier version will need to review and confirm this version themselves.' },
  repair: { title: 'Use the agreed plan', confirm: 'Open registration with this plan', effect: 'Registration will use the current agreed preparations. The public event version and existing registrations stay the same.' },
  close: { title: 'Close registration', confirm: 'Close registration', effect: 'New registrations will stop. The event page and existing registrations stay available. You can reopen registration while the event is still upcoming and its plan is agreed.' },
  cancel: { title: 'Cancel this event', confirm: 'Cancel event', effect: 'The event page and My events will show that this event is cancelled. This is final; the event cannot reopen. No one’s registration is rewritten on their behalf.' },
  end: { title: 'Mark the event ended', confirm: 'Mark event ended', effect: 'The event page and My events will show that this event has ended. This is final. It does not confirm that any registered visitor was physically present.' },
};
function publishingError(error: RepositoryError): string {
  if (error.code === 'rejected') return 'The wallet request was cancelled. Your draft is kept. Check the original request before trying again.';
  if (error.code === 'unauthorized' || error.code === 'not_connected') return 'Connect the project creator’s wallet before continuing. Your draft is kept.';
  if (error.code === 'wrong_chain') return 'Switch your wallet to Arkiv Tiramisu before continuing.';
  if (error.code === 'stale_heads' || error.code === 'conflict') return 'The event or its preparations changed. Check the original request, then review the current event.';
  if (error.code === 'storage') return 'The original request could not be saved safely. Keep this page open and export its recovery file.';
  return 'The event request could not be verified. Your draft and original request are kept. Check that request before starting another.';
}

export function EventPublishingPanel({ projectRoot, repository, session, storage: suppliedStorage, onRefresh }: EventPublishingPanelProps) {
  const storage = suppliedStorage === undefined ? browserEventStorage() : suppliedStorage;
  const account = session.actor?.kind === 'wallet' ? session.actor.address : null;
  const scope = `${projectRoot}:${account?.toLowerCase() ?? 'signed-out'}`;
  const store = useMemo(() => account ? publishingDraftStore(storage, projectRoot, account) : null, [storage, projectRoot, account]);
  const cache = useMemo(() => publishingDraftMemory(repository), [repository]);
  const [draft, setDraft] = useState<PublishingDraft | null>(null);
  const [storageIssue, setStorageIssue] = useState(false);
  const [event, setEvent] = useState<EventAggregate | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState<PublishingReview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const importFile = useRef<HTMLInputElement>(null);
  const sequence = useRef(0), abort = useRef<AbortController | null>(null), busy = useRef(false), mounted = useRef(true);
  const live = useRef({ projectRoot, repository, scope, session }); live.current = { projectRoot, repository, scope, session };
  const { controller: action, state } = useEventAction(repository, session, `publishing:${projectRoot}`, storage);
  const now = useEventClock();
  const snapshot = event?.projectRoot === projectRoot ? event : null;
  const currentDraft = draft?.projectRoot === projectRoot && draft.organizer.toLowerCase() === account?.toLowerCase() ? draft : null;
  const unresolved = state.status === 'submitting' || state.status === 'needs-verification';
  const submitting = checking || state.status === 'submitting';
  const correctChain = session.mode === 'public' && account !== null && session.chainId === TIRAMISU_CHAIN_ID;
  const owner = snapshot?.root && sameActor(snapshot.root.provenance.creator, session.actor ?? undefined);
  const availability = snapshot?.state.status === 'unique' ? deriveEventAvailability(snapshot, now) : null;
  const currentState = snapshot?.state.status === 'unique' ? snapshot.state.entity.payload : null;
  const terminal = currentState?.status === 'cancelled' || currentState?.status === 'ended';
  const draftChangedOutside = Boolean(currentDraft && currentDraft.baselineReleaseKey !== (snapshot?.release?.key ?? null));
  const access = snapshot ? organizerAccess(snapshot, session, now) : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; abort.current?.abort(); }; }, []);
  const stillHere = (token: typeof live.current) => mounted.current && live.current.projectRoot === token.projectRoot && live.current.repository === token.repository
    && live.current.scope === token.scope && live.current.session.chainId === token.session.chainId && live.current.session.mode === token.session.mode;

  const refresh = useCallback(async (includeSource = true, fallback = false): Promise<EventAggregate | null> => {
    const serial = ++sequence.current;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    if (!repository) { setReading(false); setReadError('Connect to the public network to read this event. Your draft stays here.'); return null; }
    setReading(true); setReadError(null);
    try {
      let result = await repository.loadEvent(projectRoot, { includeSource, signal: controller.signal });
      if (!result.ok && fallback && includeSource) result = await repository.loadEvent(projectRoot, { includeSource: false, signal: controller.signal });
      if (!mounted.current || serial !== sequence.current || live.current.projectRoot !== projectRoot || live.current.repository !== repository) return null;
      if (!result.ok) { setReadError('The current event could not be read completely. Refresh before making a decision.'); return null; }
      setEvent(result.value); return result.value;
    } catch {
      if (mounted.current && serial === sequence.current) setReadError('The event read was interrupted. Your draft is kept.');
      return null;
    } finally { if (mounted.current && serial === sequence.current) setReading(false); }
  }, [repository, projectRoot]);
  useEffect(() => { setEvent(null); void refresh(true, true); return () => { ++sequence.current; abort.current?.abort(); }; }, [refresh]);
  useEffect(() => {
    const loaded = store?.load();
    const restored = cache.get(scope) ?? (loaded?.status === 'ready' ? loaded.value : null);
    if (restored) cache.set(scope, restored);
    setDraft(restored);
    setStorageIssue(loaded?.status === 'unavailable' || loaded?.status === 'recovery');
    setReview(null); setAcknowledged(false); setMessage(null);
  }, [store, scope, cache]);
  useEffect(() => { setReview(null); setAcknowledged(false); }, [session.chainId, session.mode, repository]);
  useEffect(() => {
    if (!snapshot || !account || currentDraft) return;
    const restored = cache.get(scope);
    if (restored) { setDraft(restored); return; }
    const fields = snapshot.release ? publishingFields(snapshot.release.payload.terms) : emptyPublishingFields();
    if (!snapshot.release && snapshot.sourceProject?.state.status === 'unique') fields.title = snapshot.sourceProject.state.entity.payload.recipe.title;
    const next: PublishingDraft = { projectRoot, organizer: account, baselineReleaseKey: snapshot.release?.key as PublicEntityKey ?? null, fields };
    cache.set(scope, next); setDraft(next);
  }, [snapshot, account, currentDraft, projectRoot, scope, cache]);

  function keepDraft(next: PublishingDraft, replaceRecovery = false) {
    cache.set(scope, next); setDraft(next); setReview(null); setAcknowledged(false);
    const saved = store?.save(next, { replaceRecovery }); setStorageIssue(!saved?.persisted);
  }
  function edit<K extends keyof PublishingFields>(field: K, value: PublishingFields[K]) {
    if (currentDraft) keepDraft({ ...currentDraft, fields: { ...currentDraft.fields, [field]: value } });
  }
  async function prepare(kind: PublishingKind) {
    if (busy.current || unresolved) return;
    busy.current = true; setChecking(true); setMessage(null); setAcknowledged(false);
    const token = live.current;
    try {
      if (kind === 'publish' && currentDraft && store && !store.save(currentDraft).persisted) {
        setStorageIssue(true); setMessage('Save a backup and restore browser storage before publishing. Your draft remains on this page.'); return;
      }
      const fresh = await refresh(kind === 'publish' || kind === 'repair');
      if (!stillHere(token)) return;
      if (!fresh) return;
      const prepared = preparePublishingReview(fresh, live.current.session, kind, currentDraft);
      if (!prepared.ok) { setReview(null); setMessage(prepared.message); return; }
      if (!action.clear()) { setMessage('The original request still needs verification. Keep it before preparing another.'); return; }
      setReview(prepared.review);
    } finally { if (mounted.current) setChecking(false); busy.current = false; }
  }
  async function checkOriginal() {
    if (busy.current) return;
    busy.current = true; setChecking(true); setMessage(null); setReview(null); setAcknowledged(false);
    const token = live.current;
    try {
      const result = await action.reconcile();
      if (!stillHere(token)) return;
      if (!result.ok || result.value.status === 'unverified') { setMessage('The original request cannot yet be verified. Keep its recovery file and check again later.'); return; }
      if (action.getSnapshot().status === 'confirmed') { await refresh(true, true); onRefresh?.(); return; }
      if (action.getSnapshot().status === 'reverted') { setMessage('The original request reverted. Your draft is kept; review a corrected request when ready.'); return; }
      const command = action.recoverableCommand as PublishingCommand | null;
      if (!command || command.projectRoot !== projectRoot) return;
      const fresh = await refresh('terms' in command || command.status === 'open');
      if (!fresh || !stillHere(token)) return;
      const prepared = reviewOriginalCommand(command, fresh, live.current.session);
      if (!prepared.ok) setMessage(prepared.message); else setReview(prepared.review);
    } finally { if (mounted.current) setChecking(false); busy.current = false; }
  }
  async function confirm() {
    if (!review || !acknowledged || busy.current || !correctChain) return;
    const selected = review, token = live.current;
    busy.current = true; setChecking(true); setMessage(null);
    try {
      const result = await confirmPublishingReview(selected, { read: () => refresh(selected.kind === 'publish' || selected.kind === 'repair'),
        session: () => live.current.session, isCurrent: () => stillHere(token),
        submit: command => selected.resume ? action.resume(submitPublishingCommand) : action.run(command, submitPublishingCommand) });
      if (!stillHere(token)) return;
      setAcknowledged(false);
      if (!result.ok) { setMessage(result.message); return; }
      if (!result.value.ok) { setMessage(publishingError(result.value.error)); return; }
      setReview(null);
      const verified = await refresh(true, true);
      if (!stillHere(token)) return;
      if (action.getSnapshot().status === 'confirmed' && verified?.release && selected.kind === 'publish') {
        // The signed terms become the next editing baseline only after fresh readback.
        const next = draftAfterPublication(cache.get(scope), selected.terms, verified);
        if (next) keepDraft(next);
      }
      if (!verified) setMessage('The request was recorded. Refresh the event page to verify its current public details.');
      onRefresh?.();
    } finally { if (mounted.current) setChecking(false); busy.current = false; }
  }

  const termsValue = (terms: AudienceTerms, field: keyof AudienceTerms) => field === 'startsAt' || field === 'endsAt'
    ? `${formatDateTime(terms[field], terms.timeZone)} (${terms.timeZone}; ${new Date(terms[field]).toISOString()})` : String(terms[field]) || 'Not provided';
  const fields = currentDraft?.fields;
  const foldOptions = [{ value: 'reject', label: 'Ask if the clock repeats' }, { value: 'earlier', label: 'First occurrence' }, { value: 'later', label: 'Second occurrence' }];
  return <section className="pf-event-publishing" aria-label="Event page and registration" aria-busy={submitting || reading}>
    <div className="pf-publishing-heading"><h2>Invite people to your event</h2><p>Turn an agreed project into a public event page. Visitors can read the details and decide to attend with their own wallet.</p></div>
    {availability && <div className="pf-event-title-status"><StatusLabel tone={availabilityCopy[availability].tone}>{availabilityCopy[availability].label}</StatusLabel>
      <Link href={routeHref({ name: 'event', projectRoot })}>View event page</Link></div>}
    {snapshot?.state.status === 'missing' && <p>No current event publication is available. Before a first publication is signed, any earlier records are checked to protect its history.</p>}
    {readError && <Notice tone="warning" role="status">{readError}</Notice>}
    {!snapshot && !readError && <p role="status">Reading the event and its preparations…</p>}
    <div className="pf-actions"><Button variant="secondary" onClick={() => void refresh(true, true)} disabled={submitting || reading}>Refresh event</Button></div>
    {access && <Notice tone="warning">{access}</Notice>}
    {!account && <Link href={routeHref({ name: 'sign-in', returnTo: routePath({ name: 'project', projectRoot, tab: 'plans' }) })}>Sign in to manage this event</Link>}
    {message && <Notice tone="warning" role="status">{message}</Notice>}
    {state.status === 'confirmed' && <Notice tone="success" role="status">Your original event request is confirmed. Refresh to check the current public version before making another change.</Notice>}
    {state.status === 'rejected' && <Notice role="status">No transaction was sent. You can continue the saved request or correct your draft and review it again.</Notice>}
    {unresolved && <Notice tone="warning" title={state.status === 'submitting' ? 'Waiting for the wallet and network' : 'Check your saved event request'}>
      <p>{state.message || 'The original request may already be recorded. Check it before starting another.'}</p>
      {!state.operation && <ActionRecovery action={{ recoveryText: action.recoveryText, restoreRecovery: action.restoreRecovery }} />}
    </Notice>}
    {state.operation && state.status !== 'confirmed' && state.status !== 'submitting' && <div className="pf-actions">
      <Button variant="secondary" onClick={() => void checkOriginal()} disabled={submitting || !correctChain}>Check and review original request</Button>
      <Button variant="quiet" onClick={() => { if (action.recoveryText) downloadText('partfolk-event-request.json', action.recoveryText); }}>Save request backup</Button>
    </div>}
    {owner && fields && !terminal && <form onSubmit={event => { event.preventDefault(); void prepare('publish'); }}>
      <h3>What visitors need to know</h3><p>These details will be public. Keep private addresses, access codes and personal contact information out of the event page.</p>
      {storageIssue && <Notice tone="warning">This browser could not keep the draft safely. The text remains here. Save a backup before leaving or changing browsers.</Notice>}
      {draftChangedOutside && <Notice tone="warning" title="A newer event version is available">Your draft is kept. Review the published page, then choose whether to keep your edits against that version or load its visitor details.
        <div className="pf-actions"><Button variant="secondary" disabled={submitting || unresolved} onClick={() => currentDraft && keepDraft({ ...currentDraft, baselineReleaseKey: snapshot?.release?.key as PublicEntityKey ?? null })}>Keep my edits for the latest version</Button>
          <Button variant="quiet" disabled={submitting || unresolved} onClick={() => currentDraft && snapshot?.release && keepDraft({ ...currentDraft, baselineReleaseKey: snapshot.release.key as PublicEntityKey, fields: publishingFields(snapshot.release.payload.terms) })}>Load published details</Button></div></Notice>}
      <Field label="Event title" value={fields.title} maxLength={200} required disabled={submitting || unresolved} onChange={event => edit('title', event.target.value)} />
      <Textarea label="About the event" value={fields.description} maxLength={10000} rows={4} disabled={submitting || unresolved} onChange={event => edit('description', event.target.value)} />
      <Field label="Event time zone" value={fields.timeZone} maxLength={100} required hint="Use a named time zone, such as Europe/London or Asia/Almaty. Dates below use this zone." disabled={submitting || unresolved} onChange={event => edit('timeZone', event.target.value)} />
      <div className="pf-event-form-columns"><Field label="Starts" type="datetime-local" step="0.001" value={fields.startsLocal} required disabled={submitting || unresolved} onChange={event => edit('startsLocal', event.target.value)} />
        <Field label="Ends" type="datetime-local" step="0.001" value={fields.endsLocal} required disabled={submitting || unresolved} onChange={event => edit('endsLocal', event.target.value)} /></div>
      <details className="pf-event-evidence"><summary>If a clock time occurs twice</summary><p>When daylight saving ends, a local time can occur twice. Choose which occurrence the event uses if the review asks you to.</p>
        <div className="pf-event-form-columns"><Select label="Start occurrence" value={fields.startOccurrence} options={foldOptions} disabled={submitting || unresolved} onChange={event => edit('startOccurrence', event.target.value as TimeDisambiguation)} />
          <Select label="End occurrence" value={fields.endOccurrence} options={foldOptions} disabled={submitting || unresolved} onChange={event => edit('endOccurrence', event.target.value as TimeDisambiguation)} /></div></details>
      <Field label="Public place or meeting point" value={fields.venue} maxLength={1000} required disabled={submitting || unresolved} onChange={event => edit('venue', event.target.value)} />
      <Textarea label="Before you come" value={fields.instructions} maxLength={10000} rows={3} hint="Arrival instructions, what to bring and useful accessibility information." disabled={submitting || unresolved} onChange={event => edit('instructions', event.target.value)} />
      <Textarea label="Participation conditions" value={fields.conditions} maxLength={10000} rows={3} hint="Registration is free and records an intention to attend. It does not guarantee a limited seat." disabled={submitting || unresolved} onChange={event => edit('conditions', event.target.value)} />
      <div className="pf-actions"><Button type="submit" disabled={submitting || unresolved || !correctChain || draftChangedOutside}>{snapshot?.release ? 'Review changes for visitors' : 'Review event publication'}</Button>
        <Button variant="quiet" onClick={() => currentDraft && store && downloadText('partfolk-event-draft.json', store.export(currentDraft))}>Save draft backup</Button>
        <Button variant="quiet" disabled={submitting || unresolved} onClick={() => importFile.current?.click()}>Restore draft backup</Button>
        {store?.exportRecovery() && <Button variant="quiet" onClick={() => downloadText('partfolk-original-event-draft.json', store.exportRecovery()!)}>Save unreadable original</Button>}</div>
      <input ref={importFile} type="file" className="pf-visually-hidden" accept="application/json,.json" aria-label="Event draft backup" onChange={async inputEvent => {
        const input = inputEvent.currentTarget, file = input.files?.[0], token = live.current; if (!file || !store) return;
        try {
          if (file.size > 1024 * 1024) { setMessage('Choose a draft backup smaller than 1 MB.'); return; }
          const imported = store.inspectImport(await file.text());
          if (!stillHere(token)) return;
          if (imported.status !== 'ready') { setMessage('This backup does not match this event and organizer. The original draft is kept.'); return; }
          keepDraft(imported.value, true); setMessage('Draft restored. Review its details before publishing.');
        } catch { if (stillHere(token)) setMessage('The backup could not be read. The original draft is kept.'); }
        finally { input.value = ''; }
      }} />
    </form>}
    {owner && currentState && !terminal && <section className="pf-publishing-lifecycle" aria-label="Registration and event status"><h3>Registration and event status</h3>
      <p>Use an agreed replacement plan to restore registration without changing visitor details. Closing registration, cancelling the event and marking it ended have different effects.</p>
      <div className="pf-actions"><Button variant="secondary" disabled={submitting || unresolved || !correctChain} onClick={() => void prepare('repair')}>{currentState.status === 'closed' ? 'Review reopening registration' : 'Review the agreed plan'}</Button>
        {currentState.status !== 'closed' && <Button variant="secondary" disabled={submitting || unresolved || !correctChain} onClick={() => void prepare('close')}>Review closing registration</Button>}
        <Button variant="quiet" disabled={submitting || unresolved || !correctChain} onClick={() => void prepare('cancel')}>Review event cancellation</Button>
        <Button variant="quiet" disabled={submitting || unresolved || !correctChain} onClick={() => void prepare('end')}>Review event completion</Button></div>
    </section>}
    {terminal && <p>This event is {currentState?.status}. Its public page remains available while its records are retained. Registrations are intentions to attend, not proof of presence.</p>}
    {review && <section className="pf-event-public-preview pf-publishing-review" aria-label="Review public event request"><h3>{actionCopy[review.kind].title}</h3>
      <p>{review.kind === 'publish' && !review.previous ? 'Your event page will become public and registration will open while the project plan remains agreed.' : actionCopy[review.kind].effect}</p>
      {review.kind === 'publish' && review.previous && review.changed.length > 0 && <PlanDiff title="Changes visitors will review" labels={{ requirement: 'Detail', before: 'Published version', after: 'This version' }}
        rows={review.changed.map(field => ({ id: field, label: labels[field], before: <span className="pf-event-prose">{termsValue(review.previous!, field)}</span>, after: <span className="pf-event-prose">{termsValue(review.terms, field)}</span> }))} />}
      <dl className="pf-event-facts">{(['title', 'description', 'startsAt', 'endsAt', 'timeZone', 'venue', 'instructions', 'conditions'] as const).map(field => <div key={field}><dt>{labels[field]}</dt><dd className="pf-event-prose">{termsValue(review.terms, field)}</dd></div>)}</dl>
      <p>Your wallet address, these event details, the plan reference and this status will be publicly readable on Arkiv. Publishing can require two wallet confirmations: the details first, then the current event page. Keep the original request if either step is interrupted.</p>
      <dl className="pf-event-facts"><div><dt>Organizer wallet</dt><dd className="pf-event-reference">{review.command.operation.authority.actor.kind === 'wallet' ? review.command.operation.authority.actor.address : ''}</dd></div></dl>
      <details className="pf-event-evidence"><summary>Plan reference and record lifetime</summary><p className="pf-event-reference">{review.command.source.proposalKey}</p>
        <p>This request asks for {Math.ceil(review.command.lifetimeSeconds / 86_400)} days of storage, covering the event and at least 30 days afterward at preparation time. References have their own lifetimes; expiry does not erase downloaded copies or guarantee permanent history.</p>
        <p>{eventDate(review.terms)}</p></details>
      <Checkbox label="I reviewed these public details and the effect of this action." checked={acknowledged} disabled={submitting || !correctChain} onChange={event => setAcknowledged(event.target.checked)} />
      <div className="pf-actions"><Button variant={review.kind === 'cancel' ? 'danger' : 'primary'} onClick={() => void confirm()} disabled={!acknowledged || submitting || !correctChain || unresolved && !review.resume}
        {...(submitting ? { pending: true as const, pendingLabel: 'Checking the original event request' } : { pending: false as const })}>{review.resume ? 'Continue original request' : actionCopy[review.kind].confirm}</Button>
        <Button variant="quiet" disabled={submitting} onClick={() => { setReview(null); setAcknowledged(false); }}>Back to event draft</Button></div>
    </section>}
  </section>;
}
