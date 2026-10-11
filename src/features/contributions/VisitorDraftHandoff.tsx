import { useState, useSyncExternalStore } from 'react';
import { routeHref, useApp, useAppSession } from '../../app';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { Button, Link, Notice } from '../../ui';
import { contributionDrafts, visitorDraftFingerprint } from './drafts';
import { downloadText } from './shared';

export function VisitorDraftHandoff({ pending, onUse }: { pending: boolean; onUse: () => void }) {
  const runtime = useApp(), session = useAppSession(), registry = contributionDrafts(runtime);
  const state = useSyncExternalStore(registry.subscribeVisitor, registry.getVisitorSnapshot, registry.getVisitorSnapshot);
  const [dismissed, setDismissed] = useState(''), [message, setMessage] = useState('');
  const visitor = state.value;
  const backup = () => { const raw = registry.exportVisitor(); if (raw) downloadText('partfolk-guest-contribution.json', raw); };
  if (session.mode !== 'public') return null;
  if (!visitor) return state.issue?.recoverableText ? <Notice tone="warning" title="The pre-sign-in draft needs recovery">
    <p>The original handoff data is kept. Save it before continuing with another draft.</p><Button variant="secondary" onClick={backup}>Save original guest draft data</Button>
  </Notice> : null;
  if (visitor.phase === 'adopted') return null;
  const fingerprint = visitorDraftFingerprint(visitor);
  if (!session.actor) return <Notice title={visitor.owner ? 'Reconnect to finish your draft' : 'Continue this draft after signing in'}>
    <p>{visitor.owner ? `This draft is reserved for ${visitor.owner}. Reconnect that wallet to finish saving it.` : 'Your name, resources and unfinished offer fields will return here. Signing in does not publish them.'}</p>
    <div className="pf-actions"><Link href={routeHref({ name: 'sign-in', returnTo: visitor.destination ?? session.destination })}>Sign in to continue this draft</Link><Button variant="quiet" onClick={backup}>Save guest draft backup</Button></div>
  </Notice>;
  if (session.actor.kind !== 'wallet' || visitor.owner && visitor.owner.toLowerCase() !== session.actor.address.toLowerCase() || dismissed === fingerprint) return null;
  if (visitor.destination && visitor.destination !== session.destination) return <Notice title="Your saved draft belongs to another invitation">
    <p>Return to where you started to keep its project and next step.</p><div className="pf-actions"><Link href={`#${visitor.destination}`}>Return to the saved contribution draft</Link><Button variant="quiet" onClick={backup}>Save guest draft backup</Button></div>
  </Notice>;
  const target = registry.session(session.actor, 'new').getSnapshot();
  const useVisitor = () => {
    const result = registry.adoptVisitor({ fingerprint, replaceExisting: target.exists, replaceRecovery: target.recovery, pending });
    if (result.ok) { setMessage(''); onUse(); } else setMessage(result.message);
  };
  return <Notice title={target.exists ? 'Choose the draft to continue' : 'Your draft from before sign-in is ready'}>
    <p>Guest draft: <strong>{visitor.draft.name || 'Untitled contribution'}</strong>, {visitor.draft.resources.length} resources and {visitor.draft.offers.length} offers. Unfinished fields are kept too.</p>
    {target.recovery ? <><p>The saved wallet draft could not be read. Save its original data below before choosing to replace it with the guest draft.</p>
      <Button variant="secondary" onClick={() => { const raw = registry.session(session.actor, 'new').exportRecovery(); if (raw) downloadText('partfolk-original-wallet-draft.json', raw); }}>Save original wallet draft data</Button></>
      : target.exists && <><p>This wallet already has <strong>{target.draft.name || 'an untitled contribution draft'}</strong>. Choosing the guest draft will replace that local draft.</p>
        <Button variant="secondary" onClick={() => downloadText('partfolk-wallet-contribution-draft.json', registry.session(session.actor, 'new').exportDraft())}>Save wallet draft backup</Button></>}
    {visitor.destination === null && <p>This older draft has no saved invitation. Choosing it here continues it at your current destination.</p>}
    {pending && <p>Check the saved profile request before selecting another draft.</p>}
    <div className="pf-actions"><Button disabled={pending || session.chainId !== TIRAMISU_CHAIN_ID} onClick={useVisitor}>{target.exists ? 'Replace wallet draft with guest draft' : 'Continue guest draft with this wallet'}</Button>
      <Button variant="quiet" onClick={() => setDismissed(fingerprint)}>Keep this wallet draft</Button><Button variant="quiet" onClick={backup}>Save guest draft backup</Button></div>
    {message && <p role="alert">{message}</p>}
  </Notice>;
}
