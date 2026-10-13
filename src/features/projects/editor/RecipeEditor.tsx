import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ProjectRecipe, ResourceKind } from '../../../domain/types';
import { localDateTimeToUtc } from '../../../app/time';
import type { TimeDisambiguation } from '../../../app/time';
import { Button, Checkbox, Field, FieldMessage, Select, Textarea } from '../../../ui';
import {
  addRequirement, addVariant, copyVariant, recipeToEditorDraft, removeRequirement, removeVariant,
  updateRequirement, updateVariantSchedule, validateEditorDraft, variantSchedule,
} from './model';
import type { EditorDraft, EditorRequirementDraft, EditorScheduleDraft, EditorVariantDraft } from './model';
import './editor.css';
import { LocalDateField, TimeZoneField } from './DateFields';
import { needPresets } from './needPresets';

export interface RecipeEditorProps {
  value: ProjectRecipe;
  /** Emitted only when every field is valid. Saving must also check onValidityChange. */
  onChange: (recipe: ProjectRecipe) => void;
  disabled?: boolean;
  /** Supply with onDraftChange to control and persist all incomplete or invalid text. */
  draft?: EditorDraft;
  onDraftChange?: (draft: EditorDraft) => void;
  onValidityChange?: (valid: boolean) => void;
  /** Creation uses two visible steps; existing project editing shows both. */
  section?: 'event' | 'needs';
}

const humanReview = 'Helpful details for the people taking part.';
const occurrences = [
  { value: 'reject', label: 'Choose an occurrence' },
  { value: 'earlier', label: 'First occurrence, before clocks move back' },
  { value: 'later', label: 'Second occurrence, after clocks move back' },
] as const;

function needsOccurrence(value: string, timeZone: string): boolean {
  const result = localDateTimeToUtc(value, timeZone.trim());
  return !result.ok && result.error === 'ambiguous_time';
}

function newId(prefix: string): string { return `${prefix}-${globalThis.crypto.randomUUID()}`; }

function ScheduleFields({ variant, path, errors, onChange }: { variant: EditorVariantDraft; path: string; errors: Record<string, string>; onChange: (patch: Partial<EditorScheduleDraft>) => void }) {
  const schedule = variantSchedule(variant);
  return <div className="pf-recipe-grid pf-recipe-schedule">
    <div className="pf-recipe-fields"><LocalDateField label="Starts" value={schedule.startLocal} error={errors[`${path}.schedule.startLocal`]} onChange={startLocal => onChange({ startLocal, startDisambiguation: 'reject' })} />
      {needsOccurrence(schedule.startLocal, variant.timeZone) && <Select label="Which repeated start time?" value={schedule.startDisambiguation} options={occurrences} onChange={event => onChange({ startDisambiguation: event.target.value as TimeDisambiguation })} />}</div>
    <div className="pf-recipe-fields"><LocalDateField label="Ends" value={schedule.endLocal} error={errors[`${path}.schedule.endLocal`]} onChange={endLocal => onChange({ endLocal, endDisambiguation: 'reject' })} />
      {needsOccurrence(schedule.endLocal, variant.timeZone) && <Select label="Which repeated end time?" value={schedule.endDisambiguation} options={occurrences} onChange={event => onChange({ endDisambiguation: event.target.value as TimeDisambiguation })} />}</div>
  </div>;
}

export function RecipeEditor({ value, onChange, disabled = false, draft: controlledDraft, onDraftChange, onValidityChange, section }: RecipeEditorProps) {
  const baseId = useId();
  const [localDraft, setLocalDraft] = useState(() => controlledDraft ?? recipeToEditorDraft(value));
  const valueKey = JSON.stringify(value);
  const lastValueKey = useRef(valueKey);
  const draft = controlledDraft ?? localDraft;
  const validation = useMemo(() => validateEditorDraft(draft), [draft]);
  const errors = validation.errors;

  useEffect(() => {
    if (controlledDraft || valueKey === lastValueKey.current) return;
    lastValueKey.current = valueKey;
    setLocalDraft(recipeToEditorDraft(value));
  }, [controlledDraft, value, valueKey]);

  useEffect(() => { onValidityChange?.(validation.valid); }, [onValidityChange, validation.valid]);

  function change(next: EditorDraft) {
    if (disabled) return;
    if (!controlledDraft) setLocalDraft(next);
    onDraftChange?.(next);
    const result = validateEditorDraft(next);
    onValidityChange?.(result.valid);
    if (result.recipe) {
      lastValueKey.current = JSON.stringify(result.recipe);
      onChange(result.recipe);
    }
  }

  function changeVariant(id: string, patch: Partial<Omit<EditorVariantDraft, 'id' | 'requirements'>>) {
    change({ ...draft, variants: draft.variants.map(variant => variant.id === id ? { ...variant, ...patch } : variant) });
  }
  function changeRequirement(variantId: string, id: string, patch: Partial<Omit<EditorRequirementDraft, 'id'>>) {
    change(updateRequirement(draft, variantId, id, patch));
  }

  const issueCount = Object.keys(errors).length;
  return <div className="pf-recipe-editor">
    {section !== 'needs' && <section className="pf-sheet pf-recipe-outline"><h2>Your event</h2><p className="pf-secondary">Start with a name, the date and what people will come together to do.</p><fieldset className="pf-recipe-fieldset" disabled={disabled}>
      <legend className="pf-visually-hidden">Event details</legend>
      <div className="pf-recipe-fields">
        <Field label="Event name" placeholder="Community workshop, online talk, film night…" value={draft.title} error={errors.title} onChange={event => change({ ...draft, title: event.target.value })} autoComplete="off" />
        <Textarea label="What will happen?" hint="A short description of the event and the result you want." placeholder="Bring neighbors together to learn bicycle repairs." value={draft.outcome} error={errors.outcome} rows={2} onChange={event => change({ ...draft, outcome: event.target.value })} />
        <TimeZoneField label="Event time zone" hint="Dates use this clock time. Each alternative can have its own zone." value={draft.timeZone} error={errors.timeZone} onChange={timeZone => change({ ...draft, timeZone, variants: draft.variants.map(variant => variant.timeZone === draft.timeZone ? { ...variant, timeZone } : variant) })} />
        {draft.variants[0] && <div className="pf-recipe-fields"><h3>When are you planning it?</h3><ScheduleFields variant={draft.variants[0]} path="variants[0]" errors={errors} onChange={patch => change(updateVariantSchedule(draft, draft.variants[0]!.id, patch))} /><p className="pf-field-message">New needs start with these times. Adjust setup, transport or cleanup times below. You will review guest hours before publishing the visitor page.</p></div>}
        {!draft.variants.length && <Button variant="secondary" onClick={() => change(addVariant(draft, newId('variant')))}>Add event dates</Button>}
        <Textarea label="Instructions for everyone (optional)" hint={humanReview} value={draft.instructions} error={errors.instructions} rows={2} onChange={event => change({ ...draft, instructions: event.target.value })} />
      </div>
    </fieldset></section>}

    {section !== 'event' && <section className="pf-recipe-variants" aria-labelledby={`${baseId}-variants`}>
      <div className="pf-recipe-section-heading">
        <div><h2 id={`${baseId}-variants`}>Place and help needed</h2><p className="pf-secondary">Add the people, place or equipment needed to make your event happen. Compare another date or venue when useful.</p></div>
        <Button variant="secondary" disabled={disabled || draft.variants.length >= 64} onClick={() => change(addVariant(draft, newId('variant')))}>{draft.variants.length ? 'Add another option' : 'Add date and place'}</Button>
      </div>
      {errors.variants && <FieldMessage tone="danger">{errors.variants}</FieldMessage>}
      {draft.variants.map((variant, variantIndex) => {
        const path = `variants[${variantIndex}]`;
        const variantHeading = `${baseId}-variant-${variantIndex}`;
        return <section className="pf-recipe-variant pf-surface-light" key={variant.id} aria-labelledby={variantHeading}>
          <div className="pf-recipe-section-heading">
            <h3 id={variantHeading}>{variant.title.trim() || `Option ${variantIndex + 1}`}</h3>
            <div className="pf-actions">
              <Button variant="quiet" size="compact" disabled={disabled || draft.variants.length >= 64} aria-label={`Copy ${variant.title || `option ${variantIndex + 1}`}`} onClick={() => change(copyVariant(draft, variant.id, newId('variant'), () => newId('requirement')))}>Copy option</Button>
              {draft.variants.length > 1 && <Button variant="quiet" size="compact" disabled={disabled} aria-label={`Remove ${variant.title || `option ${variantIndex + 1}`}`} onClick={() => change(removeVariant(draft, variant.id))}>Remove option</Button>}
            </div>
          </div>
          <fieldset className="pf-recipe-fieldset" disabled={disabled}>
            <legend className="pf-visually-hidden">Option details</legend>
            <div className="pf-recipe-grid">
              <Field label="Option name" placeholder="Saturday afternoon or online session" value={variant.title} error={errors[`${path}.title`]} onChange={event => changeVariant(variant.id, { title: event.target.value })} />
              <Field label="Venue or online meeting space" placeholder="Community hall or online" hint="Use a recognizable name. Guest location and joining details are added when you publish the event page." value={variant.venueId} error={errors[`${path}.venueId`]} onChange={event => changeVariant(variant.id, { venueId: event.target.value })} />
              <TimeZoneField label="Time zone for these dates" hint="Changing the zone keeps the clock times you entered." value={variant.timeZone} error={errors[`${path}.timeZone`]} onChange={timeZone => changeVariant(variant.id, { timeZone })} />
            </div>
            {variantIndex > 0 && <ScheduleFields variant={variant} path={path} errors={errors} onChange={patch => change(updateVariantSchedule(draft, variant.id, patch))} />}
            <Textarea label="Option notes (optional)" hint={humanReview} value={variant.instructions} error={errors[`${path}.instructions`]} rows={2} onChange={event => changeVariant(variant.id, { instructions: event.target.value })} />
          </fieldset>

          <div className="pf-recipe-requirements">
            <div className="pf-recipe-section-heading"><div><h4>What help do you need?</h4><p className="pf-secondary">Describe each contribution and when you need it.</p></div><Button variant="secondary" size="compact" disabled={disabled || variant.requirements.length >= 128} onClick={() => change(addRequirement(draft, variant.id, newId('requirement')))}>Add a need</Button></div>
            {errors[`${path}.requirements`] && <FieldMessage tone="danger">{errors[`${path}.requirements`]}</FieldMessage>}
            {variant.requirements.map((requirement, requirementIndex) => {
              const itemPath = `${path}.requirements[${requirementIndex}]`;
              const requirementHeading = `${baseId}-variant-${variantIndex}-requirement-${requirementIndex}`;
              const dependencyErrorId = `${requirementHeading}-dependency-error`;
              const candidates = variant.requirements.filter(other => other.id !== requirement.id);
              return <section key={requirement.id} className="pf-recipe-requirement" aria-labelledby={requirementHeading}>
                <div className="pf-recipe-section-heading">
                  <h4 id={requirementHeading}>{requirement.title.trim() || `Requirement ${requirementIndex + 1}`}</h4>
                  <Button variant="quiet" size="compact" disabled={disabled} aria-label={`Remove ${requirement.title || `requirement ${requirementIndex + 1}`} from ${variant.title || `option ${variantIndex + 1}`}`} onClick={() => change(removeRequirement(draft, variant.id, requirement.id))}>Remove requirement</Button>
                </div>
                <fieldset className="pf-recipe-fieldset" disabled={disabled}>
                  <legend className="pf-visually-hidden">Requirement details</legend>
                  <div className="pf-recipe-grid">
                    <Select label="Kind of help" value={needPresets.some(preset => preset.value === requirement.capability && preset.kind === requirement.kind && preset.unit === requirement.unit) ? requirement.capability : 'custom'} options={[{ value: 'custom', label: 'Choose help or describe my own' }, ...needPresets.map(preset => ({ value: preset.value, label: preset.label }))]} onChange={event => { const preset = needPresets.find(item => item.value === event.target.value); if (preset) changeRequirement(variant.id, requirement.id, { kind: preset.kind, capability: preset.value, unit: preset.unit, title: requirement.title || preset.label }); else changeRequirement(variant.id, requirement.id, { capability: '' }); }} />
                    <Field label="Give this need a name" placeholder="Help guests join the online workshop" value={requirement.title} error={errors[`${itemPath}.title`]} onChange={event => changeRequirement(variant.id, requirement.id, { title: event.target.value })} />
                    <Field label={`How many ${requirement.unit || 'units'}?`} hint="Use a whole number." type="text" inputMode="numeric" value={requirement.quantity} error={errors[`${itemPath}.quantity`]} onChange={event => changeRequirement(variant.id, requirement.id, { quantity: event.target.value })} />
                  </div>
                  <div className="pf-recipe-grid">
                    <div className="pf-recipe-fields">
                      <LocalDateField label="Needed from" hint={`Times use ${variant.timeZone || 'the option’s time zone'}.`} value={requirement.startLocal} error={errors[`${itemPath}.startLocal`]} onChange={startLocal => changeRequirement(variant.id, requirement.id, { startLocal, startDisambiguation: 'reject' })} />
                      {needsOccurrence(requirement.startLocal, variant.timeZone) && <Select label="Which repeated start time?" value={requirement.startDisambiguation} options={occurrences} onChange={event => changeRequirement(variant.id, requirement.id, { startDisambiguation: event.target.value as TimeDisambiguation })} />}
                    </div>
                    <div className="pf-recipe-fields">
                      <LocalDateField label="Needed until" hint="Include any setup or packing time." value={requirement.endLocal} error={errors[`${itemPath}.endLocal`]} onChange={endLocal => changeRequirement(variant.id, requirement.id, { endLocal, endDisambiguation: 'reject' })} />
                      {needsOccurrence(requirement.endLocal, variant.timeZone) && <Select label="Which repeated end time?" value={requirement.endDisambiguation} options={occurrences} onChange={event => changeRequirement(variant.id, requirement.id, { endDisambiguation: event.target.value as TimeDisambiguation })} />}
                    </div>
                  </div>
                  <section className="pf-recipe-fields"><h5>Matching and task order</h5><div className="pf-recipe-grid">
                    <Select label="Contribution type" value={requirement.kind} options={[{ value: 'person', label: 'Person' }, { value: 'place', label: 'Place' }, { value: 'equipment', label: 'Equipment' }]} onChange={event => { const kind = event.target.value as ResourceKind; changeRequirement(variant.id, requirement.id, { kind, unit: kind === 'person' ? 'person' : kind === 'place' ? 'space' : 'item' }); }} />
                    <Field label="Skill or use to match" hint="Use the same term as a contributor’s offer, for example translation or catering." value={requirement.capability} error={errors[`${itemPath}.capability`]} onChange={event => changeRequirement(variant.id, requirement.id, { capability: event.target.value })} />
                    <Field label="Unit to match" hint="Use the offer’s unit, for example person, space or chair." value={requirement.unit} error={errors[`${itemPath}.unit`]} onChange={event => changeRequirement(variant.id, requirement.id, { unit: event.target.value })} />
                  </div><fieldset className="pf-recipe-dependencies" aria-describedby={errors[`${itemPath}.dependsOn`] ? dependencyErrorId : undefined}>
                    <legend className="pf-field-label">Starts after these requirements</legend>
                    <p className="pf-field-message">Selected requirements must finish before this one starts.</p>
                    {candidates.length ? candidates.map(candidate => <Checkbox key={candidate.id} label={candidate.title || 'Untitled requirement'} checked={requirement.dependsOn.includes(candidate.id)} onChange={event => changeRequirement(variant.id, requirement.id, { dependsOn: event.target.checked ? [...requirement.dependsOn, candidate.id] : requirement.dependsOn.filter(id => id !== candidate.id) })} />) : <p className="pf-field-message">Add another requirement to choose what must finish first.</p>}
                    {requirement.dependsOn.some(id => !candidates.some(candidate => candidate.id === id)) && <Button variant="quiet" size="compact" onClick={() => changeRequirement(variant.id, requirement.id, { dependsOn: requirement.dependsOn.filter(id => candidates.some(candidate => candidate.id === id)) })}>Clear unavailable dependencies</Button>}
                    {errors[`${itemPath}.dependsOn`] && <FieldMessage id={dependencyErrorId} role="alert" tone="danger">{errors[`${itemPath}.dependsOn`]}</FieldMessage>}
                  </fieldset></section>
                  <Textarea label="Requirement instructions" hint={humanReview} value={requirement.instructions} error={errors[`${itemPath}.instructions`]} rows={2} onChange={event => changeRequirement(variant.id, requirement.id, { instructions: event.target.value })} />
                </fieldset>
              </section>;
            })}
          </div>
        </section>;
      })}
    </section>}
    {section !== 'event' && !!issueCount && <div className="pf-recipe-validation" role="status">
      <p>{issueCount === 1 ? 'One detail is still needed.' : `${issueCount} details are still needed.`} Your draft is kept as you write.</p>
      {errors.$ && <p>{errors.$}</p>}
    </div>}
  </div>;
}
