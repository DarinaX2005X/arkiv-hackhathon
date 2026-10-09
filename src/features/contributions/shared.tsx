import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime, useApp, useAppSession } from '../../app';
import type { DomainReason, Interval } from '../../domain/types';
import { Button, Notice } from '../../ui';
import { actorScope, conditionText, isContributionDraft, type ContributionDraft } from './model';
import { contributionReasons } from './catalog';

export function useCurrentTime() {
  const { now } = useApp(); const [current, setCurrent] = useState(now);
  useEffect(() => { const timer = setInterval(() => setCurrent(now()), 30_000); return () => clearInterval(timer); }, [now]);
  return current;
}
/** Async readers cannot repopulate a new account or a later request with stale results. */
export function useReadGuard() {
  const runtime = useApp(); const session = useAppSession(); const version = useRef(0);
  const scope = `${session.mode}:${actorScope(session.actor)}`;
  useEffect(() => () => { version.current += 1; }, [runtime, scope]);
  return () => {
    const ownVersion = ++version.current;
    return () => ownVersion === version.current && scope === `${runtime.session.getSnapshot().mode}:${actorScope(runtime.session.getSnapshot().actor)}`;
  };
}

export function intervalText(interval: Interval, timeZone = 'UTC'): string {
  return `${formatDateTime(interval.start, timeZone)} – ${formatDateTime(interval.end, timeZone)} (${timeZone})`;
}
export function Reasons({ reasons }: { reasons: DomainReason[] }) {
  return reasons.length ? <ul className="pf-contribution-reasons">{reasons.map((reason, index) => <li key={index}>{contributionReasons[reason.code]}{reason.resourceId && <span> Resource: {reason.resourceId}.</span>}{reason.offerId && <span> Offer: {reason.offerId}.</span>}{reason.params?.required !== undefined && <span> Needed: {String(reason.params.required)}; capacity: {String(reason.params.capacity)}.</span>}</li>)}</ul> : null;
}
export function ContributionPreview({ draft }: { draft: ContributionDraft }) {
  return <div className="pf-stack"><p><strong>{draft.name}</strong></p><p>{draft.description}</p>
    <h4>Resources</h4>{draft.resources.map(resource => <article key={resource.id}><p>{resource.name} · {resource.capacity} {resource.unit} · {resource.kind}</p><p>Capabilities: {resource.capabilities.join(', ')}</p>{resource.availability.map((window, index) => <p key={index}>{intervalText(window)}</p>)}</article>)}
    <h4>Offers</h4>{draft.offers.map(offer => <article key={offer.id}><p><strong>{offer.title}</strong> · {offer.quantity} {offer.unit}</p><p>Uses: {draft.resources.find(r => r.id === offer.resourceId)?.name ?? offer.resourceId}</p><p>Capabilities: {offer.capabilities.join(', ')}</p>{offer.availability.map((window, index) => <p key={index}>{intervalText(window)}</p>)}<p>{offer.instructions}</p>{offer.conditions.map((condition, index) => <p key={index}>{conditionText(condition)}</p>)}<p>{offer.projectScope.length ? `Limited to projects: ${offer.projectScope.join(', ')}` : 'No project scope restriction.'}</p></article>)}
  </div>;
}
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function useContributionDraft(id: string, initial: ContributionDraft) {
  const { drafts } = useApp(); const { actor } = useAppSession();
  const store = useMemo(() => drafts(`contribution:${actorScope(actor)}:${id.slice(-50).replace(/[^a-zA-Z0-9._:-]/g, '_')}`, 'contribution', isContributionDraft), [drafts, id, actorScope(actor)]);
  const [loaded] = useState(() => store.load());
  const [draft, setDraft] = useState(() => loaded.status === 'ready' ? loaded.value : structuredClone(initial));
  const [saved, setSaved] = useState(false);
  const [recovery, setRecovery] = useState(() => loaded.status === 'recovery');
  useEffect(() => { setSaved(store.save(draft).persisted); }, [draft, store]);
  return { draft, setDraft, saved, recovery, exportDraft: () => downloadText('partfolk-contribution-draft.json', store.export(draft)),
    exportRecovery: () => { const raw = store.exportRecovery(); if (raw !== null) downloadText('partfolk-original-draft-recovery.json', raw); },
    replaceRecovery: () => { const result = store.save(draft, { replaceRecovery: true }); setSaved(result.persisted); if (result.persisted) setRecovery(false); } };
}
export function DraftStatus({ saved, onExport, recovery, onExportRecovery, onReplaceRecovery }: { saved: boolean; onExport: () => void; recovery?: boolean; onExportRecovery?: () => void; onReplaceRecovery?: () => void }) {
  return recovery ? <Notice tone="warning" title="The previous saved draft needs recovery"><p>The original data was kept intact. Export it before replacing it with the current draft.</p><div className="pf-actions"><Button variant="secondary" onClick={onExportRecovery}>Export original saved data</Button><Button variant="secondary" onClick={onExport}>Export current draft</Button><Button variant="quiet" onClick={onReplaceRecovery}>Use current draft on this device</Button></div></Notice>
    : saved ? <p className="pf-secondary" role="status">Draft saved on this device for this account.</p>
    : <Notice tone="warning" title="This draft is only in memory"><p>Local storage is unavailable or needs recovery. Export the draft before leaving.</p><Button variant="secondary" onClick={onExport}>Export draft</Button></Notice>;
}
