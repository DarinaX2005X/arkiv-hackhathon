import { useEffect, useState } from 'react';
import type { Condition, Offer, Resource } from '../../domain/types';
import { Button, Field, Notice, Select, Textarea } from '../../ui';
import type { AvailabilityWindowDraft, ContributionDraft } from './model';
import { addDraftOffer, availabilityWindowError, conditionText, editableWindows, quantityError, removeDraftOffer, removeDraftResource } from './model';

const kinds = [{ value: 'person', label: 'People / my time' }, { value: 'place', label: 'Place' }, { value: 'equipment', label: 'Equipment' }];
const comma = (text: string) => [...new Set(text.split(',').map(s => s.trim()).filter(Boolean))];
function WindowEditor({ value, onChange }: { value: AvailabilityWindowDraft; onChange: (value: AvailabilityWindowDraft) => void }) {
  const error = availabilityWindowError(value);
  return <div className="pf-contribution-fields">
    <Field label="Starts" type="datetime-local" value={value.start} onChange={e => onChange({ ...value, start: e.target.value })} error={error || undefined} />
    <Field label="Ends" type="datetime-local" value={value.end} onChange={e => onChange({ ...value, end: e.target.value })} />
    <Field label="Time zone" value={value.timeZone} onChange={e => onChange({ ...value, timeZone: e.target.value })} hint="A named zone, for example Europe/London. Ambiguous clock times must be corrected." />
  </div>;
}
function Windows({ windows, onChange, now }: { windows: AvailabilityWindowDraft[]; onChange: (windows: AvailabilityWindowDraft[]) => void; now: number }) {
  return <div className="pf-stack pf-stack--compact"><p className="pf-field-label">Availability windows</p>
    {windows.map((window, index) => <div className="pf-contribution-window" key={window.id}>
      <WindowEditor value={window} onChange={next => onChange(windows.map(w => w.id === window.id ? next : w))} />
      <Button variant="quiet" onClick={() => onChange(windows.filter(w => w.id !== window.id))}>Remove window {index + 1}</Button>
    </div>)}
    <Button variant="secondary" onClick={() => onChange([...windows, { ...editableWindows([{ start: Math.ceil(now / 3600000) * 3600000 + 86400000, end: Math.ceil(now / 3600000) * 3600000 + 90000000 }])[0]!, id: crypto.randomUUID() }])}>Add availability window</Button>
  </div>;
}
function ConditionEditor({ conditions, onChange }: { conditions: Condition[]; onChange: (value: Condition[]) => void }) {
  const [kind, setKind] = useState<Condition['kind']>('requires_capability'); const [value, setValue] = useState(''); const [publisher, setPublisher] = useState(''); const [error, setError] = useState('');
  const add = () => {
    if (!value.trim()) { setError('Enter a condition value.'); return; }
    let condition: Condition;
    if (kind === 'requires_offer' || kind === 'excludes_offer') {
      if (!/^(local:.+|0x[\da-fA-F]{64})$/.test(publisher)) { setError('Enter the exact publisher identity.'); return; }
      condition = { kind, offer: { publisherRoot: publisher as `local:${string}` | `0x${string}`, offerId: value.trim() } };
    } else if (kind === 'allowed_variants') condition = { kind, variantIds: comma(value) };
    else if (kind === 'allowed_venues') condition = { kind, venueIds: comma(value) };
    else condition = { kind, capability: value.trim() };
    onChange([...conditions, condition]); setValue(''); setError('');
  };
  return <details><summary>Conditions checked when finding a plan ({conditions.length})</summary><div className="pf-stack pf-stack--compact">{conditions.map((condition, index) => <div className="pf-actions" key={index}><p>{conditionText(condition)}</p><Button variant="quiet" onClick={() => onChange(conditions.filter((_, i) => i !== index))}>Remove condition {index + 1}</Button></div>)}<Select label="Condition" value={kind} onChange={e => setKind(e.target.value as Condition['kind'])} options={[{ value: 'requires_capability', label: 'Needs another capability' }, { value: 'allowed_variants', label: 'Only specified plan options' }, { value: 'allowed_venues', label: 'Only specified venues' }, { value: 'requires_offer', label: 'Requires another offer' }, { value: 'excludes_offer', label: 'Cannot combine with another offer' }]} />{(kind === 'requires_offer' || kind === 'excludes_offer') && <Field label="Other publisher identity" value={publisher} onChange={e => setPublisher(e.target.value)} />}<Field label={kind === 'requires_capability' ? 'Capability' : kind === 'requires_offer' || kind === 'excludes_offer' ? 'Offer ID' : 'IDs, separated by commas'} value={value} onChange={e => setValue(e.target.value)} error={error || undefined} /><Button variant="secondary" onClick={add}>Add condition</Button></div></details>;
}
export function OfferEditor({ draft, onChange, kind, now, onInvalid }: { draft: ContributionDraft; onChange: (draft: ContributionDraft) => void; kind: 'individual' | 'organization'; now: number; onInvalid: (invalid: boolean) => void }) {
  const [newResourceKind, setNewResourceKind] = useState<Resource['kind']>(kind === 'individual' ? 'person' : 'equipment');
  const activeKeys = [...draft.resources.map(r => `resource:${r.id}`), ...draft.offers.map(o => `offer:${o.id}`)];
  const invalid = activeKeys.some(key => draft.editorWindows?.[key]?.some(window => Boolean(availabilityWindowError(window))))
    || [...draft.resources.map(r => `resource:${r.id}:capacity`), ...draft.offers.map(o => `offer:${o.id}:quantity`)].some(key => draft.editorNumbers?.[key] !== undefined && Boolean(quantityError(draft.editorNumbers[key]!)));
  useEffect(() => { onInvalid(invalid); }, [invalid, onInvalid]);
  const updateWindows = (key: string, windows: AvailabilityWindowDraft[]) => onChange({ ...draft, editorWindows: { ...draft.editorWindows, [key]: windows } });
  const updateNumber = (key: string, value: string) => onChange({ ...draft, editorNumbers: { ...draft.editorNumbers, [key]: value } });
  const resource = (id: string, patch: Partial<Resource>) => onChange({ ...draft, resources: draft.resources.map(r => r.id === id ? { ...r, ...patch } : r) });
  const offer = (id: string, patch: Partial<Offer>) => onChange({ ...draft, offers: draft.offers.map(o => o.id === id ? { ...o, ...patch } : o) });
  const addResource = () => {
    const person = kind === 'individual' && newResourceKind === 'person';
    if (person && draft.resources.some(r => r.id === 'self')) return;
    onChange({ ...draft, resources: [...draft.resources, { id: person ? 'self' : `resource-${crypto.randomUUID().slice(0, 8)}`, name: '', kind: newResourceKind, capacity: 1, unit: newResourceKind === 'person' ? 'person' : newResourceKind === 'place' ? 'space' : 'item', availability: [], capabilities: [] }] });
  };
  return <div className="pf-stack"><div className="pf-contribution-fields"><Field label="Public contribution name" required value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} /><Textarea label="Description" value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} /></div><Notice>Use public project information only. Do not enter private calendars, addresses, contact details, or wallet secrets.</Notice><section className="pf-stack"><h3>Resources I control</h3><p className="pf-secondary">Offers that use the same resource share its capacity. All of your personal time uses one resource with capacity one.</p>{draft.resources.map(r => <fieldset className="pf-contribution-editor pf-stack" key={r.id}><legend>{r.name || 'New resource'}</legend><div className="pf-contribution-fields"><Field label="Resource name" value={r.name} onChange={e => resource(r.id, { name: e.target.value })} /><Select label="Resource type" value={r.kind} disabled={r.id === 'self'} options={kinds.filter(k => kind !== 'individual' || r.id === 'self' || k.value !== 'person')} onChange={e => resource(r.id, { kind: e.target.value as Resource['kind'] })} /><Field label="Capacity" type="number" min="1" step="1" disabled={r.id === 'self'} value={draft.editorNumbers?.[`resource:${r.id}:capacity`] ?? r.capacity} onChange={e => updateNumber(`resource:${r.id}:capacity`, e.target.value)} error={draft.editorNumbers?.[`resource:${r.id}:capacity`] === undefined ? undefined : quantityError(draft.editorNumbers[`resource:${r.id}:capacity`]!) || undefined} /><Field label="Unit" value={r.unit} onChange={e => resource(r.id, { unit: e.target.value })} hint="Use the same unit as the project requirement, such as person, board, or space." /><Field label="Capabilities, separated by commas" value={r.capabilities.join(', ')} onChange={e => resource(r.id, { capabilities: e.target.value.split(',').map(s => s.trim()) })} /></div><Windows windows={draft.editorWindows?.[`resource:${r.id}`] ?? editableWindows(r.availability)} now={now} onChange={windows => updateWindows(`resource:${r.id}`, windows)} /><Button variant="quiet" onClick={() => { onChange(removeDraftResource(draft, r.id)); }}>Remove resource and its offers</Button></fieldset>)}<Select label="New resource type" value={newResourceKind} options={kinds} onChange={e => setNewResourceKind(e.target.value as Resource['kind'])} /><Button variant="secondary" disabled={kind === 'individual' && newResourceKind === 'person' && draft.resources.some(r => r.id === 'self')} disabledReason="Your personal time already has one shared resource. Add another offer using it, or choose place or equipment." onClick={addResource}>Add a resource</Button></section><section className="pf-stack"><h3>Offers for projects</h3>{draft.offers.map(o => <fieldset className="pf-contribution-editor pf-stack" key={o.id}><legend>{o.title || 'New offer'}</legend><div className="pf-contribution-fields"><Field label="Offer title" value={o.title} onChange={e => offer(o.id, { title: e.target.value })} /><Select label="Uses resource" value={o.resourceId} options={draft.resources.map(r => ({ value: r.id, label: r.name || r.id }))} onChange={e => { const r = draft.resources.find(r => r.id === e.target.value)!; offer(o.id, { resourceId: r.id, kind: r.kind, unit: r.unit }); }} /><Field label={`Quantity (${o.unit})`} type="number" min="1" step="1" value={draft.editorNumbers?.[`offer:${o.id}:quantity`] ?? o.quantity} onChange={e => updateNumber(`offer:${o.id}:quantity`, e.target.value)} error={draft.editorNumbers?.[`offer:${o.id}:quantity`] === undefined ? undefined : quantityError(draft.editorNumbers[`offer:${o.id}:quantity`]!) || undefined} /><Field label="Offered capabilities, separated by commas" value={o.capabilities.join(', ')} onChange={e => offer(o.id, { capabilities: e.target.value.split(',').map(s => s.trim()) })} /><Field label="Project identities, separated by commas" value={o.projectScope.join(', ')} hint="Leave empty to make this offer usable in projects you choose to share it with." onChange={e => offer(o.id, { projectScope: (e.target.value ? e.target.value.split(',').map(s => s.trim()) : []) as Offer['projectScope'] })} /></div><Windows windows={draft.editorWindows?.[`offer:${o.id}`] ?? editableWindows(o.availability)} now={now} onChange={windows => updateWindows(`offer:${o.id}`, windows)} /><Textarea label="Usage and return instructions" value={o.instructions} hint="Instructions are visible to people; only the structured conditions below are checked by the planner." onChange={e => offer(o.id, { instructions: e.target.value })} /><ConditionEditor conditions={o.conditions} onChange={conditions => offer(o.id, { conditions })} /><Button variant="quiet" onClick={() => { onChange(removeDraftOffer(draft, o.id)); }}>Remove offer</Button></fieldset>)}<Button variant="secondary" disabled={!draft.resources.length} disabledReason="Add a resource first." onClick={() => { const r = draft.resources[0]!; onChange(addDraftOffer(draft, r.id, `offer-${crypto.randomUUID().slice(0, 8)}`)); }}>Add an offer</Button></section></div>;
}




