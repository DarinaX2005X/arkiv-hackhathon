import { useEffect, useState } from 'react';
import type { Condition, Offer, Resource } from '../../domain/types';
import { Button, Field, Select, Textarea } from '../../ui';
import type { AvailabilityWindowDraft, ContributionDraft } from './model';
import { addDraftOffer, availabilityWindowError, conditionText, copyResourceAvailability, editableWindows, quantityError, removeDraftOffer, removeDraftResource, startDraftContribution } from './model';
import { LocalDateField, TimeZoneField } from '../projects/editor/DateFields';
import { needPresets } from '../projects/editor/needPresets';
import { ContributionArt } from './ContributionArt';

const kinds = [{ value: 'person', label: 'Time and skills' }, { value: 'place', label: 'A space' }, { value: 'equipment', label: 'Equipment' }] as const;
const comma = (text: string) => [...new Set(text.split(',').map(s => s.trim()).filter(Boolean))];
function WindowEditor({ value, onChange }: { value: AvailabilityWindowDraft; onChange: (value: AvailabilityWindowDraft) => void }) {
  const error = value.start || value.end ? availabilityWindowError(value) : '';
  return <div className="pf-contribution-fields">
    <LocalDateField label="Available from" value={value.start} onChange={start => onChange({ ...value, start })} error={error || undefined} />
    <LocalDateField label="Available until" value={value.end} onChange={end => onChange({ ...value, end })} />
    <TimeZoneField value={value.timeZone} onChange={timeZone => onChange({ ...value, timeZone })} />
  </div>;
}
function Windows({ windows, onChange }: { windows: AvailabilityWindowDraft[]; onChange: (windows: AvailabilityWindowDraft[]) => void }) {
  return <div className="pf-stack pf-stack--compact">
    {windows.length === 0 && <p className="pf-field-message">Add an available time before publishing this contribution.</p>}
    {windows.map((window, index) => <div className="pf-contribution-window" key={window.id}>
      <WindowEditor value={window} onChange={next => onChange(windows.map(w => w.id === window.id ? next : w))} />
      {windows.length > 1 && <Button variant="quiet" onClick={() => onChange(windows.filter(w => w.id !== window.id))}>Remove time {index + 1}</Button>}
    </div>)}
    <Button variant="secondary" onClick={() => onChange([...windows, { id: crypto.randomUUID(), start: '', end: '', timeZone: windows[0]?.timeZone ?? 'UTC' }])}>{windows.length ? 'Add another time' : 'Add available time'}</Button>
  </div>;
}
function ConditionEditor({ conditions, onChange }: { conditions: Condition[]; onChange: (value: Condition[]) => void }) {
  const [kind, setKind] = useState<Condition['kind']>('requires_capability'); const [value, setValue] = useState(''); const [publisher, setPublisher] = useState(''); const [error, setError] = useState('');
  const add = () => {
    if (!value.trim()) { setError('Enter a condition value.'); return; }
    let condition: Condition;
    if (kind === 'requires_offer' || kind === 'excludes_offer') {
      if (!/^(local:.+|0x[\da-fA-F]{64})$/.test(publisher)) { setError('Enter the exact contributor reference.'); return; }
      condition = { kind, offer: { publisherRoot: publisher as `local:${string}` | `0x${string}`, offerId: value.trim() } };
    } else if (kind === 'allowed_variants') condition = { kind, variantIds: comma(value) };
    else if (kind === 'allowed_venues') condition = { kind, venueIds: comma(value) };
    else condition = { kind, capability: value.trim() };
    onChange([...conditions, condition]); setValue(''); setError('');
  };
  return <div className="pf-stack pf-stack--compact">
    <h5>Conditions for a compatible plan</h5>
    {conditions.map((condition, index) => <div className="pf-actions" key={index}><p>{conditionText(condition)}</p><Button variant="quiet" onClick={() => onChange(conditions.filter((_, i) => i !== index))}>Remove condition {index + 1}</Button></div>)}
    <Select label="Condition" value={kind} onChange={e => setKind(e.target.value as Condition['kind'])} options={[{ value: 'requires_capability', label: 'Needs another skill or use' }, { value: 'allowed_variants', label: 'Only specified plan options' }, { value: 'allowed_venues', label: 'Only specified venues' }, { value: 'requires_offer', label: 'Requires another offer' }, { value: 'excludes_offer', label: 'Cannot combine with another offer' }]} />
    {(kind === 'requires_offer' || kind === 'excludes_offer') && <Field label="Other contributor reference" value={publisher} onChange={e => setPublisher(e.target.value)} />}
    <Field label={kind === 'requires_capability' ? 'Skill or use' : kind === 'requires_offer' || kind === 'excludes_offer' ? 'Offer reference' : 'References, separated by commas'} value={value} onChange={e => setValue(e.target.value)} error={error || undefined} />
    <Button variant="secondary" onClick={add}>Add condition</Button>
  </div>;
}
export function OfferEditor({ draft, onChange, kind, onInvalid, showProfileFields = true }: { draft: ContributionDraft; onChange: (draft: ContributionDraft) => void; kind: 'individual' | 'organization'; now: number; onInvalid: (invalid: boolean) => void; showProfileFields?: boolean }) {
  const [selected, setSelected] = useState(draft.resources[0]?.id ?? '');
  const active = draft.resources.find(resource => resource.id === selected) ?? draft.resources[0];
  const activeKeys = [...draft.resources.map(r => `resource:${r.id}`), ...draft.offers.map(o => `offer:${o.id}`)];
  const invalid = activeKeys.some(key => draft.editorWindows?.[key]?.some(window => Boolean(availabilityWindowError(window))))
    || [...draft.resources.map(r => `resource:${r.id}:capacity`), ...draft.offers.map(o => `offer:${o.id}:quantity`)].some(key => draft.editorNumbers?.[key] !== undefined && Boolean(quantityError(draft.editorNumbers[key]!)));
  useEffect(() => { onInvalid(invalid); }, [invalid, onInvalid]);
  const updateWindows = (key: string, windows: AvailabilityWindowDraft[]) => onChange({ ...draft, editorWindows: { ...draft.editorWindows, [key]: windows } });
  const updateNumber = (key: string, value: string) => onChange({ ...draft, editorNumbers: { ...draft.editorNumbers, [key]: value } });
  const resource = (id: string, patch: Partial<Resource>) => onChange({ ...draft, resources: draft.resources.map(r => r.id === id ? { ...r, ...patch } : r), offers: draft.offers.map(o => o.resourceId === id ? { ...o, ...(patch.unit === undefined ? {} : { unit: patch.unit }), ...(patch.kind === undefined ? {} : { kind: patch.kind }) } : o) });
  const offer = (id: string, patch: Partial<Offer>) => onChange({ ...draft, offers: draft.offers.map(o => o.id === id ? { ...o, ...patch } : o) });
  const add = (resourceKind: Resource['kind']) => {
    const id = crypto.randomUUID().slice(0, 8);
    onChange(startDraftContribution(draft, { kind: resourceKind, publisherKind: kind, id }));
    setSelected(resourceKind === 'person' && kind === 'individual' ? 'self' : `resource-${id}`);
  };
  return <div className="pf-stack pf-offer-editor">
    {showProfileFields && <div className="pf-contribution-fields"><Field label="Public contribution name" required value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} /><Textarea label="Public description" value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} /></div>}
    <div className="pf-contribution-starts" aria-label="Add a contribution">
      {kinds.map(item => <button className="pf-contribution-start" type="button" key={item.value} onClick={() => add(item.value)}><ContributionArt kind={item.value} /><span><strong>{item.label}</strong><span>{item.value === 'person' ? 'Offer help with a task or shift' : item.value === 'place' ? 'Make a venue available' : 'Lend what the event needs'}</span><span className="pf-contribution-start-label">Add contribution</span></span></button>)}
    </div>
    {draft.resources.length > 0 && <div className="pf-offer-editor-layout">
      <nav className="pf-resource-collection" aria-label="Your resources">{draft.resources.map(item => <button key={item.id} type="button" aria-pressed={active?.id === item.id} onClick={() => setSelected(item.id)}><strong>{item.name || 'Untitled resource'}</strong><span>{draft.offers.filter(offer => offer.resourceId === item.id).length} offer{draft.offers.filter(offer => offer.resourceId === item.id).length === 1 ? '' : 's'}</span></button>)}</nav>
      {active && <section className="pf-stack pf-resource-context" aria-label={`Edit ${active.name || 'resource'}`}>
        <fieldset className="pf-contribution-editor pf-stack"><legend>What you can provide</legend>
          <div className="pf-contribution-fields"><Field label="Resource name" value={active.name} onChange={e => resource(active.id, { name: e.target.value })} /><Select label="Type" value={active.kind} disabled={active.id === 'self'} options={kinds.filter(k => kind !== 'individual' || active.id === 'self' || k.value !== 'person')} onChange={e => resource(active.id, { kind: e.target.value as Resource['kind'] })} />
            <Field label="Total quantity available" type="number" min="1" step="1" disabled={active.id === 'self'} value={draft.editorNumbers?.[`resource:${active.id}:capacity`] ?? active.capacity} onChange={e => updateNumber(`resource:${active.id}:capacity`, e.target.value)} error={draft.editorNumbers?.[`resource:${active.id}:capacity`] === undefined ? undefined : quantityError(draft.editorNumbers[`resource:${active.id}:capacity`]!) || undefined} />
            <Field label="Unit" value={active.unit} onChange={e => resource(active.id, { unit: e.target.value })} hint="Match the project, for example person, board, or space." />
            <Field label="Skills or uses" value={active.capabilities.join(', ')} onChange={e => resource(active.id, { capabilities: e.target.value.split(',').map(s => s.trim()) })} hint="Separate multiple skills or uses with commas." />
          </div>
          <h4>Available times</h4><Windows windows={draft.editorWindows?.[`resource:${active.id}`] ?? editableWindows(active.availability)} onChange={windows => updateWindows(`resource:${active.id}`, windows)} />
          <p className="pf-field-message">All offers of this resource share its total quantity. Your personal time can only be promised once at the same time.</p>
        </fieldset>
        {draft.offers.filter(o => o.resourceId === active.id).map(o => <fieldset className="pf-contribution-editor pf-contribution-editor--offer pf-stack" key={o.id}><legend>{o.title || 'New offer'}</legend>
          <div className="pf-contribution-fields"><Field label="Offer title" value={o.title} onChange={e => offer(o.id, { title: e.target.value })} /><Select label="Offer a familiar skill or item" value={needPresets.some(preset => preset.value === o.capabilities[0]) ? o.capabilities[0] : ''} options={[{ value: '', label: 'Describe my own offer' }, ...needPresets.filter(preset => preset.kind === o.kind).map(preset => ({ value: preset.value, label: preset.label }))]} onChange={e => { const preset = needPresets.find(item => item.value === e.target.value); if (preset) { onChange({ ...draft, resources: draft.resources.map(r => r.id === active.id ? { ...r, unit: preset.unit, capabilities: [...new Set([...r.capabilities, preset.value])] } : r), offers: draft.offers.map(item => item.resourceId !== active.id ? item : item.id === o.id ? { ...item, title: preset.label, unit: preset.unit, capabilities: [preset.value] } : { ...item, unit: preset.unit }) }); } }} />
            <Field label={`Quantity offered (${o.unit})`} type="number" min="1" step="1" value={draft.editorNumbers?.[`offer:${o.id}:quantity`] ?? o.quantity} onChange={e => updateNumber(`offer:${o.id}:quantity`, e.target.value)} error={draft.editorNumbers?.[`offer:${o.id}:quantity`] === undefined ? undefined : quantityError(draft.editorNumbers[`offer:${o.id}:quantity`]!) || undefined} />
            <Field label="Offered skills or uses" value={o.capabilities.join(', ')} onChange={e => offer(o.id, { capabilities: e.target.value.split(',').map(s => s.trim()) })} hint="Use the skill or item named in the project's needs." />
          </div>
          <div className="pf-contribution-section-heading"><h4>When projects can use this offer</h4><Button variant="secondary" onClick={() => onChange(copyResourceAvailability(draft, o.id))}>Use resource availability</Button></div>
          <Windows windows={draft.editorWindows?.[`offer:${o.id}`] ?? editableWindows(o.availability)} onChange={windows => updateWindows(`offer:${o.id}`, windows)} />
          <Textarea label="Use and return instructions" value={o.instructions} hint="Keep private addresses, contact details, and access codes out of public offers." onChange={e => offer(o.id, { instructions: e.target.value })} />
          {o.conditions.length > 0 && <div className="pf-offer-conditions"><h5>Conditions attached to this offer</h5>{o.conditions.map((condition, index) => <p key={index}>{conditionText(condition)}</p>)}</div>}
          {o.projectScope.length > 0 && <p className="pf-contribution-identity">Limited to {o.projectScope.length} project{o.projectScope.length === 1 ? '' : 's'}: {o.projectScope.join(', ')}</p>}
          <details className="pf-contribution-advanced"><summary>Advanced</summary><div className="pf-stack"><Select label="Uses resource" value={o.resourceId} options={draft.resources.map(r => ({ value: r.id, label: r.name || r.id }))} onChange={e => { const r = draft.resources.find(r => r.id === e.target.value)!; offer(o.id, { resourceId: r.id, kind: r.kind, unit: r.unit }); }} /><Field label="Limit to project references" value={o.projectScope.join(', ')} hint="Optional. Separate references with commas. Leave empty for projects you join." onChange={e => offer(o.id, { projectScope: (e.target.value ? e.target.value.split(',').map(s => s.trim()) : []) as Offer['projectScope'] })} /><ConditionEditor conditions={o.conditions} onChange={conditions => offer(o.id, { conditions })} /></div></details>
          <Button variant="quiet" onClick={() => onChange(removeDraftOffer(draft, o.id))}>Remove this offer</Button>
        </fieldset>)}
        <div className="pf-actions"><Button variant="secondary" onClick={() => onChange(addDraftOffer(draft, active.id, `offer-${crypto.randomUUID().slice(0, 8)}`))}>Add another offer of this resource</Button><Button variant="quiet" onClick={() => onChange(removeDraftResource(draft, active.id))}>Remove resource and its offers</Button></div>
      </section>}
    </div>}
  </div>;
}
