import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ProjectRecipe, ResourceKind } from '../../../domain/types';
import { localDateTimeToUtc } from '../../../app/time';
import type { TimeDisambiguation } from '../../../app/time';
import { Button, Checkbox, Field, FieldMessage, Notice, Select, Textarea } from '../../../ui';
import {
  addRequirement, addVariant, copyVariant, recipeToEditorDraft, removeRequirement, removeVariant,
  updateRequirement, validateEditorDraft,
} from './model';
import type { EditorDraft, EditorRequirementDraft, EditorVariantDraft } from './model';
import './editor.css';

export interface RecipeEditorProps {
  value: ProjectRecipe;
  /** Emitted only when every field is valid. Saving must also check onValidityChange. */
  onChange: (recipe: ProjectRecipe) => void;
  disabled?: boolean;
  /** Supply with onDraftChange to control and persist all incomplete or invalid text. */
  draft?: EditorDraft;
  onDraftChange?: (draft: EditorDraft) => void;
  onValidityChange?: (valid: boolean) => void;
}

const humanReview = 'Notes for people to review. These instructions are not checked by the plan search.';
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

export function RecipeEditor({ value, onChange, disabled = false, draft: controlledDraft, onDraftChange, onValidityChange }: RecipeEditorProps) {
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
    <fieldset className="pf-recipe-fieldset" disabled={disabled}>
      <legend className="pf-recipe-legend">Project details</legend>
      <div className="pf-recipe-fields">
        <Field label="Project title" value={draft.title} error={errors.title} onChange={event => change({ ...draft, title: event.target.value })} autoComplete="off" />
        <Textarea label="Outcome" hint="Describe what the finished project should achieve." value={draft.outcome} error={errors.outcome} rows={2} onChange={event => change({ ...draft, outcome: event.target.value })} />
        <Field label="Project time zone" hint="Use a named time zone, such as Asia/Qyzylorda, Europe/London or UTC. New variants start with this zone." value={draft.timeZone} error={errors.timeZone} onChange={event => change({ ...draft, timeZone: event.target.value })} autoComplete="off" spellCheck={false} />
        <Textarea label="Project instructions · human review" hint={humanReview} value={draft.instructions} error={errors.instructions} rows={3} onChange={event => change({ ...draft, instructions: event.target.value })} />
      </div>
    </fieldset>

    <section className="pf-recipe-variants" aria-labelledby={`${baseId}-variants`}>
      <div className="pf-recipe-section-heading">
        <div><h3 id={`${baseId}-variants`}>Ways this project could happen</h3><p className="pf-secondary">Each variant has its own venue, time zone and complete list of requirements.</p></div>
        <Button variant="secondary" disabled={disabled || draft.variants.length >= 64} onClick={() => change(addVariant(draft, newId('variant')))}>Add variant</Button>
      </div>
      {errors.variants && <FieldMessage tone="danger">{errors.variants}</FieldMessage>}
      {draft.variants.map((variant, variantIndex) => {
        const path = `variants[${variantIndex}]`;
        const variantHeading = `${baseId}-variant-${variantIndex}`;
        return <section className="pf-recipe-variant" key={variant.id} aria-labelledby={variantHeading}>
          <div className="pf-recipe-section-heading">
            <h3 id={variantHeading}>{variant.title.trim() || `Variant ${variantIndex + 1}`}</h3>
            <div className="pf-actions">
              <Button variant="quiet" size="compact" disabled={disabled || draft.variants.length >= 64} aria-label={`Copy ${variant.title || `variant ${variantIndex + 1}`}`} onClick={() => change(copyVariant(draft, variant.id, newId('variant'), () => newId('requirement')))}>Copy variant</Button>
              <Button variant="quiet" size="compact" disabled={disabled} aria-label={`Remove ${variant.title || `variant ${variantIndex + 1}`}`} onClick={() => change(removeVariant(draft, variant.id))}>Remove variant</Button>
            </div>
          </div>
          <fieldset className="pf-recipe-fieldset" disabled={disabled}>
            <legend className="pf-visually-hidden">Variant details</legend>
            <div className="pf-recipe-grid">
              <Field label="Variant title" value={variant.title} error={errors[`${path}.title`]} onChange={event => changeVariant(variant.id, { title: event.target.value })} />
              <Field label="Venue reference" hint="Use the same name or reference as offers restricted to this venue." value={variant.venueId} error={errors[`${path}.venueId`]} onChange={event => changeVariant(variant.id, { venueId: event.target.value })} />
              <Field label="Variant time zone" hint="All requirement dates below use this zone. Changing it keeps the displayed clock times." value={variant.timeZone} error={errors[`${path}.timeZone`]} onChange={event => changeVariant(variant.id, { timeZone: event.target.value })} autoComplete="off" spellCheck={false} />
            </div>
            <Textarea label="Variant instructions · human review" hint={humanReview} value={variant.instructions} error={errors[`${path}.instructions`]} rows={2} onChange={event => changeVariant(variant.id, { instructions: event.target.value })} />
          </fieldset>

          <div className="pf-recipe-requirements">
            <div className="pf-recipe-section-heading"><h4>Requirements</h4><Button variant="secondary" size="compact" disabled={disabled || variant.requirements.length >= 128} onClick={() => change(addRequirement(draft, variant.id, newId('requirement')))}>Add requirement</Button></div>
            {errors[`${path}.requirements`] && <FieldMessage tone="danger">{errors[`${path}.requirements`]}</FieldMessage>}
            {variant.requirements.map((requirement, requirementIndex) => {
              const itemPath = `${path}.requirements[${requirementIndex}]`;
              const requirementHeading = `${baseId}-variant-${variantIndex}-requirement-${requirementIndex}`;
              const dependencyErrorId = `${requirementHeading}-dependency-error`;
              const candidates = variant.requirements.filter(other => other.id !== requirement.id);
              return <section key={requirement.id} className="pf-recipe-requirement" aria-labelledby={requirementHeading}>
                <div className="pf-recipe-section-heading">
                  <h4 id={requirementHeading}>{requirement.title.trim() || `Requirement ${requirementIndex + 1}`}</h4>
                  <Button variant="quiet" size="compact" disabled={disabled} aria-label={`Remove ${requirement.title || `requirement ${requirementIndex + 1}`} from ${variant.title || `variant ${variantIndex + 1}`}`} onClick={() => change(removeRequirement(draft, variant.id, requirement.id))}>Remove requirement</Button>
                </div>
                <fieldset className="pf-recipe-fieldset" disabled={disabled}>
                  <legend className="pf-visually-hidden">Requirement details</legend>
                  <div className="pf-recipe-grid">
                    <Field label="Requirement title" value={requirement.title} error={errors[`${itemPath}.title`]} onChange={event => changeRequirement(variant.id, requirement.id, { title: event.target.value })} />
                    <Select label="Kind" value={requirement.kind} options={[{ value: 'person', label: 'Person' }, { value: 'place', label: 'Place' }, { value: 'equipment', label: 'Equipment' }]} onChange={event => changeRequirement(variant.id, requirement.id, { kind: event.target.value as ResourceKind })} />
                    <Field label="Capability" hint="Use the exact capability supplied by matching offers, such as installation or transport." value={requirement.capability} error={errors[`${itemPath}.capability`]} onChange={event => changeRequirement(variant.id, requirement.id, { capability: event.target.value })} />
                    <Field label="Quantity" hint="Whole numbers from 1 to 1,000,000." type="text" inputMode="numeric" value={requirement.quantity} error={errors[`${itemPath}.quantity`]} onChange={event => changeRequirement(variant.id, requirement.id, { quantity: event.target.value })} />
                    <Field label="Unit" hint="Must match the offer unit exactly, such as person, room or board." value={requirement.unit} error={errors[`${itemPath}.unit`]} onChange={event => changeRequirement(variant.id, requirement.id, { unit: event.target.value })} />
                  </div>
                  <div className="pf-recipe-grid">
                    <div className="pf-recipe-fields">
                      <Field label="Start · local date and time" hint={`Use YYYY-MM-DDTHH:mm, for example 2026-10-17T09:00. Time zone: ${variant.timeZone || 'not set'}.`} type="text" placeholder="YYYY-MM-DDTHH:mm" value={requirement.startLocal} error={errors[`${itemPath}.startLocal`]} onChange={event => changeRequirement(variant.id, requirement.id, { startLocal: event.target.value, startDisambiguation: 'reject' })} autoComplete="off" spellCheck={false} />
                      {needsOccurrence(requirement.startLocal, variant.timeZone) && <Select label="Start clock occurrence" value={requirement.startDisambiguation} options={occurrences} onChange={event => changeRequirement(variant.id, requirement.id, { startDisambiguation: event.target.value as TimeDisambiguation })} />}
                    </div>
                    <div className="pf-recipe-fields">
                      <Field label="End · local date and time" hint="Use the same date and time format. End must be after start." type="text" placeholder="YYYY-MM-DDTHH:mm" value={requirement.endLocal} error={errors[`${itemPath}.endLocal`]} onChange={event => changeRequirement(variant.id, requirement.id, { endLocal: event.target.value, endDisambiguation: 'reject' })} autoComplete="off" spellCheck={false} />
                      {needsOccurrence(requirement.endLocal, variant.timeZone) && <Select label="End clock occurrence" value={requirement.endDisambiguation} options={occurrences} onChange={event => changeRequirement(variant.id, requirement.id, { endDisambiguation: event.target.value as TimeDisambiguation })} />}
                    </div>
                  </div>
                  <fieldset className="pf-recipe-dependencies" aria-describedby={errors[`${itemPath}.dependsOn`] ? dependencyErrorId : undefined}>
                    <legend className="pf-field-label">Starts after these requirements</legend>
                    <p className="pf-field-message">Selected requirements must finish before this one starts.</p>
                    {candidates.length ? candidates.map(candidate => <Checkbox key={candidate.id} label={candidate.title || 'Untitled requirement'} checked={requirement.dependsOn.includes(candidate.id)} onChange={event => changeRequirement(variant.id, requirement.id, { dependsOn: event.target.checked ? [...requirement.dependsOn, candidate.id] : requirement.dependsOn.filter(id => id !== candidate.id) })} />) : <p className="pf-field-message">Add another requirement to set a dependency.</p>}
                    {requirement.dependsOn.some(id => !candidates.some(candidate => candidate.id === id)) && <Button variant="quiet" size="compact" onClick={() => changeRequirement(variant.id, requirement.id, { dependsOn: requirement.dependsOn.filter(id => candidates.some(candidate => candidate.id === id)) })}>Clear unavailable dependencies</Button>}
                    {errors[`${itemPath}.dependsOn`] && <FieldMessage id={dependencyErrorId} role="alert" tone="danger">{errors[`${itemPath}.dependsOn`]}</FieldMessage>}
                  </fieldset>
                  <Textarea label="Requirement instructions · human review" hint={humanReview} value={requirement.instructions} error={errors[`${itemPath}.instructions`]} rows={2} onChange={event => changeRequirement(variant.id, requirement.id, { instructions: event.target.value })} />
                </fieldset>
              </section>;
            })}
          </div>
        </section>;
      })}
    </section>
    {!!issueCount && <Notice tone="warning" title="Finish the recipe before planning">
      <p>{issueCount === 1 ? 'One field or section needs attention.' : `${issueCount} fields or sections need attention.`} Your unfinished input stays in this draft.</p>
      {errors.$ && <p>{errors.$}</p>}
    </Notice>}
  </div>;
}
