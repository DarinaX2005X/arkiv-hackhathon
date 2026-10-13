import { isTimeZone, localDateTimeToUtc, utcToLocalDateTime } from '../../../app/time';
import type { TimeDisambiguation, TimeError } from '../../../app/time';
import type { ProjectRecipe, ProjectVariant, RecipeTemplate, Requirement } from '../../../domain/types';
import { MAX_QUANTITY, validateRecipe } from '../../../domain/validation';

export interface OriginalInterval {
  start: number;
  end: number;
  timeZone: string;
  startLocal: string;
  endLocal: string;
  startDisambiguation: TimeDisambiguation;
  endDisambiguation: TimeDisambiguation;
}

export interface EditorRequirementDraft extends Omit<Requirement, 'quantity' | 'interval'> {
  quantity: string;
  startLocal: string;
  endLocal: string;
  startDisambiguation: TimeDisambiguation;
  endDisambiguation: TimeDisambiguation;
  /** Keeps seconds and milliseconds intact until the corresponding date field changes. */
  originalInterval?: OriginalInterval;
}
export interface EditorScheduleDraft {
  startLocal: string;
  endLocal: string;
  startDisambiguation: TimeDisambiguation;
  endDisambiguation: TimeDisambiguation;
}
export interface EditorVariantDraft extends Omit<ProjectVariant, 'requirements'> {
  requirements: EditorRequirementDraft[];
  /** Form defaults for new needs, never an extra field in an agreed recipe. */
  schedule?: EditorScheduleDraft;
}
export interface EditorDraft extends Omit<ProjectRecipe, 'variants'> {
  variants: EditorVariantDraft[];
}
export interface EditorValidation {
  valid: boolean;
  errors: Record<string, string>;
  recipe: ProjectRecipe | null;
}

const dateErrors: Record<TimeError, string> = {
  invalid_datetime: 'Enter a valid date and time.',
  invalid_timezone: 'Enter a named time zone, such as Europe/London or UTC.',
  ambiguous_time: 'This clock time occurs twice. Choose the first or second occurrence.',
  nonexistent_time: 'This clock time does not exist because the clocks move forward. Choose another time.',
};

function occurrence(local: string, timeZone: string, instant: number): TimeDisambiguation {
  const rejected = localDateTimeToUtc(local, timeZone);
  if (rejected.ok || rejected.error !== 'ambiguous_time') return 'reject';
  const earlier = localDateTimeToUtc(local, timeZone, 'earlier');
  return earlier.ok && instant >= earlier.utcMilliseconds && instant < earlier.utcMilliseconds + 60_000 ? 'earlier' : 'later';
}

export function recipeToEditorDraft(recipe: ProjectRecipe): EditorDraft {
  return {
    ...recipe,
    variants: recipe.variants.map(variant => ({
      ...variant,
      requirements: variant.requirements.map(requirement => {
        const { interval, quantity, ...fields } = requirement;
        const startLocal = utcToLocalDateTime(interval.start, variant.timeZone);
        const endLocal = utcToLocalDateTime(interval.end, variant.timeZone);
        const startDisambiguation = occurrence(startLocal, variant.timeZone, interval.start);
        const endDisambiguation = occurrence(endLocal, variant.timeZone, interval.end);
        return {
          ...fields, dependsOn: [...fields.dependsOn], quantity: String(quantity), startLocal, endLocal,
          startDisambiguation, endDisambiguation,
          originalInterval: { ...interval, timeZone: variant.timeZone, startLocal, endLocal, startDisambiguation, endDisambiguation },
        };
      }),
    })),
  };
}

/** Reuse has no invented dates. The editor must be dated before it can emit a recipe. */
export function templateToEditorDraft(template: RecipeTemplate): EditorDraft {
  return {
    ...template,
    variants: template.variants.map(variant => ({
      ...variant,
      requirements: variant.requirements.map(requirement => ({
        ...requirement, dependsOn: [...requirement.dependsOn], quantity: String(requirement.quantity),
        startLocal: '', endLocal: '', startDisambiguation: 'reject', endDisambiguation: 'reject',
      })),
    })),
  };
}

function normalizedText(value: string, max: number, path: string, errors: Record<string, string>, required = true): string {
  const normalized = value.trim();
  if (required && !normalized) errors[path] = 'Enter a value.';
  else if (normalized.length > max) errors[path] = `Use ${max} characters or fewer.`;
  return normalized;
}

function instructions(value: string, path: string, errors: Record<string, string>): string {
  if (value.length > 10_000) errors[path] = 'Use 10,000 characters or fewer.';
  return value;
}

function namedZone(value: string, path: string, errors: Record<string, string>): string {
  const zone = normalizedText(value, 100, path, errors);
  if (!isTimeZone(zone)) errors[path] = dateErrors.invalid_timezone;
  return zone;
}

function instant(requirement: EditorRequirementDraft, edge: 'start' | 'end', zone: string, path: string, errors: Record<string, string>): number {
  const local = edge === 'start' ? requirement.startLocal : requirement.endLocal;
  const disambiguation = edge === 'start' ? requirement.startDisambiguation : requirement.endDisambiguation;
  const result = localDateTimeToUtc(local, zone, disambiguation);
  if (!result.ok) { errors[path] = dateErrors[result.error]; return 0; }
  const original = requirement.originalInterval;
  if (original && original.timeZone === zone
    && original[`${edge}Local`] === local && original[`${edge}Disambiguation`] === disambiguation) {
    // Only reuse metadata when it describes the displayed minute and occurrence.
    const prior = original[edge];
    if (Number.isSafeInteger(prior) && prior >= result.utcMilliseconds && prior < result.utcMilliseconds + 60_000) return prior;
  }
  return result.utcMilliseconds;
}

export function validateEditorDraft(draft: EditorDraft): EditorValidation {
  const errors: Record<string, string> = {};
  const recipe: ProjectRecipe = {
    title: normalizedText(draft.title, 200, 'title', errors),
    outcome: normalizedText(draft.outcome, 200, 'outcome', errors),
    timeZone: namedZone(draft.timeZone, 'timeZone', errors),
    instructions: instructions(draft.instructions, 'instructions', errors),
    ...(draft.sourceProjectRoot === undefined ? {} : { sourceProjectRoot: draft.sourceProjectRoot }),
    variants: draft.variants.map((variant, variantIndex) => {
      const path = `variants[${variantIndex}]`;
      const timeZone = namedZone(variant.timeZone, `${path}.timeZone`, errors);
      if (variant.schedule) {
        const start = localDateTimeToUtc(variant.schedule.startLocal, timeZone, variant.schedule.startDisambiguation);
        const end = localDateTimeToUtc(variant.schedule.endLocal, timeZone, variant.schedule.endDisambiguation);
        if (!start.ok) errors[`${path}.schedule.startLocal`] = dateErrors[start.error];
        else if (start.utcMilliseconds < 0) errors[`${path}.schedule.startLocal`] = 'Choose a date on or after 1 January 1970.';
        if (!end.ok) errors[`${path}.schedule.endLocal`] = dateErrors[end.error];
        else if (end.utcMilliseconds < 0) errors[`${path}.schedule.endLocal`] = 'Choose a date on or after 1 January 1970.';
        if (start.ok && end.ok && end.utcMilliseconds <= start.utcMilliseconds) errors[`${path}.schedule.endLocal`] = 'End must be after start.';
      }
      if (!variant.requirements.length) errors[`${path}.requirements`] = 'Add at least one requirement.';
      if (variant.requirements.length > 128) errors[`${path}.requirements`] = 'Use 128 requirements or fewer in each variant.';
      const converted: ProjectVariant = {
        id: variant.id,
        title: normalizedText(variant.title, 200, `${path}.title`, errors),
        venueId: normalizedText(variant.venueId, 128, `${path}.venueId`, errors),
        timeZone, instructions: instructions(variant.instructions, `${path}.instructions`, errors),
        requirements: variant.requirements.map((requirement, requirementIndex) => {
          const itemPath = `${path}.requirements[${requirementIndex}]`;
          const quantityText = requirement.quantity.trim();
          const quantity = Number(quantityText);
          if (!/^\d+$/.test(quantityText) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
            errors[`${itemPath}.quantity`] = `Enter a whole number from 1 to ${MAX_QUANTITY.toLocaleString('en')}.`;
          }
          const start = instant(requirement, 'start', timeZone, `${itemPath}.startLocal`, errors);
          const end = instant(requirement, 'end', timeZone, `${itemPath}.endLocal`, errors);
          if (start < 0) errors[`${itemPath}.startLocal`] = 'Choose a date on or after 1 January 1970.';
          if (end < 0) errors[`${itemPath}.endLocal`] = 'Choose a date on or after 1 January 1970.';
          if (!errors[`${itemPath}.startLocal`] && !errors[`${itemPath}.endLocal`] && end <= start) errors[`${itemPath}.endLocal`] = 'End must be after start.';
          return {
            id: requirement.id,
            title: normalizedText(requirement.title, 200, `${itemPath}.title`, errors),
            kind: requirement.kind,
            capability: normalizedText(requirement.capability, 128, `${itemPath}.capability`, errors),
            unit: normalizedText(requirement.unit, 128, `${itemPath}.unit`, errors),
            quantity, interval: { start, end },
            instructions: instructions(requirement.instructions, `${itemPath}.instructions`, errors),
            dependsOn: [...requirement.dependsOn],
          };
        }),
      };
      const byId = new Map(converted.requirements.map(requirement => [requirement.id, requirement]));
      converted.requirements.forEach((requirement, index) => {
        const dependencyPath = `${path}.requirements[${index}].dependsOn`;
        const seen = new Set<string>();
        const visits = (id: string): boolean => {
          if (id === requirement.id) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return byId.get(id)?.dependsOn.some(visits) ?? false;
        };
        if (new Set(requirement.dependsOn).size !== requirement.dependsOn.length) errors[dependencyPath] = 'Choose each dependency once.';
        else if (requirement.dependsOn.some(id => !byId.has(id))) errors[dependencyPath] = 'Choose dependencies from this variant.';
        else if (requirement.dependsOn.some(visits)) errors[dependencyPath] = 'Dependencies must not form a loop or refer to this requirement.';
        else if (requirement.dependsOn.some(id => byId.get(id)!.interval.end > requirement.interval.start)) errors[dependencyPath] = 'Each dependency must finish before this requirement starts.';
      });
      return converted;
    }),
  };
  if (!draft.variants.length) errors.variants = 'Add at least one variant.';
  if (draft.variants.length > 64) errors.variants = 'Use 64 variants or fewer.';
  if (!Object.keys(errors).length) {
    const domain = validateRecipe(recipe);
    domain.reasons.forEach(reason => {
      const path = reason.path?.replace(/^\$\.?/, '') || '$';
      errors[path] = reason.code === 'payload_too_large' ? 'This recipe is too large. Shorten its instructions or remove requirements.' : 'Review this value before saving the recipe.';
    });
  }
  const valid = !Object.keys(errors).length;
  return { valid, errors, recipe: valid ? recipe : null };
}

export function editorDraftToRecipe(draft: EditorDraft): ProjectRecipe | null {
  return validateEditorDraft(draft).recipe;
}

export function variantSchedule(variant: EditorVariantDraft): EditorScheduleDraft {
  if (variant.schedule) return variant.schedule;
  const first = [...variant.requirements].filter(item => item.startLocal).sort((left, right) => left.startLocal.localeCompare(right.startLocal))[0];
  const last = [...variant.requirements].filter(item => item.endLocal).sort((left, right) => right.endLocal.localeCompare(left.endLocal))[0];
  return { startLocal: first?.startLocal ?? '', endLocal: last?.endLocal ?? '',
    startDisambiguation: first?.startDisambiguation ?? 'reject', endDisambiguation: last?.endDisambiguation ?? 'reject' };
}

/** Move only needs that still share a schedule edge. Individually set times stay intact. */
export function updateVariantSchedule(draft: EditorDraft, variantId: string, patch: Partial<EditorScheduleDraft>): EditorDraft {
  return { ...draft, variants: draft.variants.map(variant => {
    if (variant.id !== variantId) return variant;
    const previous = variantSchedule(variant), schedule = { ...previous, ...patch };
    return { ...variant, schedule, requirements: variant.requirements.map(requirement => ({
      ...requirement,
      ...(requirement.startLocal === previous.startLocal && requirement.startDisambiguation === previous.startDisambiguation
        ? { startLocal: schedule.startLocal, startDisambiguation: schedule.startDisambiguation } : {}),
      ...(requirement.endLocal === previous.endLocal && requirement.endDisambiguation === previous.endDisambiguation
        ? { endLocal: schedule.endLocal, endDisambiguation: schedule.endDisambiguation } : {}),
    })) };
  }) };
}

export function createEventEditorDraft(timeZone: string, variantId: string): EditorDraft {
  return { title: '', outcome: '', timeZone, instructions: '', variants: [{
    id: variantId, title: 'Main date', venueId: '', timeZone, instructions: '', requirements: [],
    schedule: { startLocal: '', endLocal: '', startDisambiguation: 'reject', endDisambiguation: 'reject' },
  }] };
}

/** The first step is complete without requiring the later contribution editor. */
export function eventDetailsReady(draft: EditorDraft): boolean {
  const first = draft.variants[0];
  if (!first || !draft.title.trim() || draft.title.trim().length > 200 || !draft.outcome.trim() || draft.outcome.trim().length > 200
    || !isTimeZone(draft.timeZone) || !isTimeZone(first.timeZone) || draft.instructions.length > 10_000) return false;
  const schedule = variantSchedule(first);
  const start = localDateTimeToUtc(schedule.startLocal, first.timeZone, schedule.startDisambiguation);
  const end = localDateTimeToUtc(schedule.endLocal, first.timeZone, schedule.endDisambiguation);
  return start.ok && end.ok && start.utcMilliseconds >= 0 && end.utcMilliseconds > start.utcMilliseconds;
}

export function addVariant(draft: EditorDraft, id: string): EditorDraft {
  return { ...draft, variants: [...draft.variants, { id, title: '', venueId: '', timeZone: draft.timeZone, instructions: '', requirements: [],
    schedule: { startLocal: '', endLocal: '', startDisambiguation: 'reject', endDisambiguation: 'reject' } }] };
}

export function copyVariant(draft: EditorDraft, variantId: string, newVariantId: string, idFactory: () => string): EditorDraft {
  const variant = draft.variants.find(item => item.id === variantId);
  if (!variant) return draft;
  const identities = new Map(variant.requirements.map(requirement => [requirement.id, idFactory()]));
  const copy: EditorVariantDraft = {
    ...variant, id: newVariantId, title: `${variant.title} (copy)`,
    requirements: variant.requirements.map(requirement => ({
      ...requirement, id: identities.get(requirement.id)!,
      dependsOn: requirement.dependsOn.map(id => identities.get(id) ?? id),
      ...(requirement.originalInterval ? { originalInterval: { ...requirement.originalInterval } } : {}),
    })),
  };
  return { ...draft, variants: [...draft.variants, copy] };
}

export function removeVariant(draft: EditorDraft, variantId: string): EditorDraft {
  return { ...draft, variants: draft.variants.filter(variant => variant.id !== variantId) };
}

export function addRequirement(draft: EditorDraft, variantId: string, id: string): EditorDraft {
  const variant = draft.variants.find(item => item.id === variantId);
  const requirement: EditorRequirementDraft = {
    id, title: '', kind: 'person', capability: '', unit: 'person', quantity: '1',
    ...(variant ? variantSchedule(variant) : { startLocal: '', endLocal: '', startDisambiguation: 'reject' as const, endDisambiguation: 'reject' as const }),
    instructions: '', dependsOn: [],
  };
  return { ...draft, variants: draft.variants.map(variant => variant.id === variantId ? { ...variant, requirements: [...variant.requirements, requirement] } : variant) };
}

export function removeRequirement(draft: EditorDraft, variantId: string, requirementId: string): EditorDraft {
  return {
    ...draft, variants: draft.variants.map(variant => variant.id === variantId ? {
      ...variant, requirements: variant.requirements.filter(requirement => requirement.id !== requirementId).map(requirement => ({
        ...requirement, dependsOn: requirement.dependsOn.filter(id => id !== requirementId),
      })),
    } : variant),
  };
}

export function updateRequirement(draft: EditorDraft, variantId: string, requirementId: string, patch: Partial<Omit<EditorRequirementDraft, 'id'>>): EditorDraft {
  return {
    ...draft, variants: draft.variants.map(variant => variant.id === variantId ? {
      ...variant, requirements: variant.requirements.map(requirement => requirement.id === requirementId ? { ...requirement, ...patch } : requirement),
    } : variant),
  };
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: RecordValue, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function strings(value: RecordValue, fields: string[]): boolean { return fields.every(field => typeof value[field] === 'string'); }
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function uniqueIdentities(values: { id: string }[]): boolean { return new Set(values.map(value => value.id)).size === values.length; }
function disambiguation(value: unknown): value is TimeDisambiguation { return value === 'reject' || value === 'earlier' || value === 'later'; }
function originalInterval(value: unknown): value is OriginalInterval {
  return record(value) && exact(value, ['start', 'end', 'timeZone', 'startLocal', 'endLocal', 'startDisambiguation', 'endDisambiguation'])
    && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
    && strings(value, ['timeZone', 'startLocal', 'endLocal']) && disambiguation(value.startDisambiguation) && disambiguation(value.endDisambiguation);
}
function requirementDraft(value: unknown): value is EditorRequirementDraft {
  const fields = ['id', 'title', 'kind', 'capability', 'unit', 'quantity', 'startLocal', 'endLocal', 'startDisambiguation', 'endDisambiguation', 'instructions', 'dependsOn'];
  return record(value) && exact(value, fields, ['originalInterval'])
    && strings(value, ['id', 'title', 'capability', 'unit', 'quantity', 'startLocal', 'endLocal', 'instructions'])
    && identity(value.id)
    && (value.kind === 'person' || value.kind === 'place' || value.kind === 'equipment')
    && disambiguation(value.startDisambiguation) && disambiguation(value.endDisambiguation)
    && Array.isArray(value.dependsOn) && value.dependsOn.every(id => typeof id === 'string')
    && (value.originalInterval === undefined || originalInterval(value.originalInterval));
}
function variantDraft(value: unknown): value is EditorVariantDraft {
  return record(value) && exact(value, ['id', 'title', 'venueId', 'timeZone', 'instructions', 'requirements'], ['schedule'])
    && strings(value, ['id', 'title', 'venueId', 'timeZone', 'instructions'])
    && identity(value.id)
    && Array.isArray(value.requirements) && value.requirements.length <= 128 && value.requirements.every(requirementDraft)
    && uniqueIdentities(value.requirements)
    && (value.schedule === undefined || record(value.schedule)
      && exact(value.schedule, ['startLocal', 'endLocal', 'startDisambiguation', 'endDisambiguation'])
      && strings(value.schedule, ['startLocal', 'endLocal'])
      && disambiguation(value.schedule.startDisambiguation) && disambiguation(value.schedule.endDisambiguation));
}

/** Checks persisted form structure, deliberately allowing invalid and unfinished text. */
export function isEditorDraft(value: unknown): value is EditorDraft {
  return record(value) && exact(value, ['title', 'outcome', 'timeZone', 'instructions', 'variants'], ['sourceProjectRoot'])
    && strings(value, ['title', 'outcome', 'timeZone', 'instructions'])
    && (value.sourceProjectRoot === undefined || typeof value.sourceProjectRoot === 'string' && /^(?:0x[0-9a-f]{64}|local:[a-zA-Z0-9._:-]{1,150})$/.test(value.sourceProjectRoot))
    && Array.isArray(value.variants) && value.variants.length <= 64 && value.variants.every(variantDraft)
    && uniqueIdentities(value.variants);
}
