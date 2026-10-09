import { describe, expect, it } from 'vitest';
import type { ProjectRecipe, RecipeTemplate, Requirement } from '../../../domain/types';
import {
  addRequirement, addVariant, copyVariant, editorDraftToRecipe, isEditorDraft,
  recipeToEditorDraft, removeRequirement, removeVariant, templateToEditorDraft,
  updateRequirement, validateEditorDraft,
} from './model';

function requirement(id: string, dependsOn: string[] = []): Requirement {
  const hourOffset = id === 'record' ? 2 : id === 'pack' ? 4 : 0;
  return {
    id, title: `Requirement ${id}`, kind: 'equipment', capability: 'camera-kit',
    unit: 'custom-kit', quantity: 3, instructions: `Instructions for ${id}`,
    interval: { start: Date.UTC(2026, 9, 9, 10 + hourOffset, 45, 12, 345), end: Date.UTC(2026, 9, 9, 11 + hourOffset, 45, 56, 789) },
    dependsOn,
  };
}

function recipe(): ProjectRecipe {
  return {
    title: 'Community recording', outcome: 'A recorded community performance',
    timeZone: 'Asia/Qyzylorda', instructions: 'Keep all shared recipe instructions.',
    sourceProjectRoot: 'local:source-project',
    variants: [{
      id: 'main', title: 'Main hall', venueId: 'hall-west', timeZone: 'America/New_York',
      instructions: 'Keep the door clear.',
      requirements: [requirement('setup'), requirement('record', ['setup']), requirement('pack', ['setup', 'record'])],
    }, {
      id: 'alternative', title: 'Outdoor alternative', venueId: 'garden', timeZone: 'Asia/Qyzylorda',
      instructions: 'Bring covers.', requirements: [requirement('outside')],
    }],
  };
}

const quantityPath = 'variants[0].requirements[0].quantity';
const startPath = 'variants[0].requirements[0].startLocal';

function withQuantity(quantity: string) {
  return updateRequirement(recipeToEditorDraft(recipe()), 'main', 'setup', { quantity });
}

function timeRecipe(): ProjectRecipe {
  const value = recipe();
  value.variants[0]!.requirements = [requirement('setup')];
  return value;
}

describe('editor recipe preservation', () => {
  it('round-trips custom units, IDs, instructions, dependencies, source and exact UTC milliseconds', () => {
    const original = recipe();
    const draft = recipeToEditorDraft(original);

    expect(draft.variants[0]!.requirements[0]!.quantity).toBe('3');
    expect(draft.variants[0]!.requirements[0]!.startLocal).toBe('2026-10-09T06:45');
    expect(draft.variants[1]!.requirements[0]!.startLocal).toBe('2026-10-09T15:45');
    expect(editorDraftToRecipe(draft)).toEqual(original);
    expect(validateEditorDraft(draft)).toEqual({ valid: true, errors: {}, recipe: original });
  });

  it('preserves unrelated recipe and requirement fields when changing a requirement title', () => {
    const original = recipe();
    const draft = recipeToEditorDraft(original);
    const changed = updateRequirement(draft, 'main', 'record', { title: 'Record the performance' });
    const expected = recipe();
    expected.variants[0]!.requirements[1]!.title = 'Record the performance';

    expect(editorDraftToRecipe(changed)).toEqual(expected);
    expect(editorDraftToRecipe(draft)).toEqual(original);
  });

  it('clears scheduling on reuse while preserving template fields and dependencies', () => {
    const original = recipe();
    const template: RecipeTemplate = {
      ...original,
      sourceProjectRoot: 'local:source-project',
      variants: original.variants.map(variant => ({
        ...variant,
        requirements: variant.requirements.map(({ interval: _interval, ...rest }) => rest),
      })),
    };
    const draft = templateToEditorDraft(template);

    expect(draft.sourceProjectRoot).toBe(template.sourceProjectRoot);
    expect(draft.variants[0]).toMatchObject({ id: 'main', venueId: 'hall-west', timeZone: 'America/New_York' });
    expect(draft.variants[0]!.requirements[1]).toMatchObject({
      id: 'record', quantity: '3', unit: 'custom-kit', dependsOn: ['setup'], startLocal: '', endLocal: '',
    });
    expect(isEditorDraft(draft)).toBe(true);
    expect(validateEditorDraft(draft).valid).toBe(false);
    expect(editorDraftToRecipe(draft)).toBeNull();
  });

  it('recomputes instants when the variant time zone changes', () => {
    const draft = recipeToEditorDraft(recipe());
    draft.variants[0]!.timeZone = 'UTC';
    const changed = editorDraftToRecipe(draft);

    expect(changed).not.toBeNull();
    expect(changed!.variants[0]!.requirements[0]!.interval).toEqual({
      start: Date.UTC(2026, 9, 9, 6, 45), end: Date.UTC(2026, 9, 9, 7, 45),
    });
    expect(changed!.variants[1]).toEqual(recipe().variants[1]);
  });

  it('preserves the untouched endpoint milliseconds after changing only the start field', () => {
    const original = recipe();
    const draft = updateRequirement(recipeToEditorDraft(original), 'main', 'setup', { startLocal: '2026-10-09T06:30' });
    expect(editorDraftToRecipe(draft)!.variants[0]!.requirements[0]!.interval).toEqual({
      start: Date.UTC(2026, 9, 9, 10, 30), end: original.variants[0]!.requirements[0]!.interval.end,
    });
  });
});

describe('editor validation', () => {
  it.each(['1', '1000000'])('accepts the bounded integer quantity %s', value => {
    const result = validateEditorDraft(withQuantity(value));
    expect(result.valid).toBe(true);
    expect(result.recipe!.variants[0]!.requirements[0]!.quantity).toBe(Number(value));
  });

  it.each(['', ' ', '0', '-1', '1.5', '1e3', '0x10', 'Infinity', 'NaN', '1000001', '9007199254740992'])('rejects quantity %j without coercion', value => {
    const draft = withQuantity(value);
    const result = validateEditorDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.errors[quantityPath]).toEqual(expect.any(String));
    expect(result.recipe).toBeNull();
    expect(editorDraftToRecipe(draft)).toBeNull();
    expect(draft.variants[0]!.requirements[0]!.quantity).toBe(value);
  });

  it('reports an empty unit at its requirement field without replacing it', () => {
    const draft = updateRequirement(recipeToEditorDraft(recipe()), 'main', 'setup', { unit: '' });
    const result = validateEditorDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.errors['variants[0].requirements[0].unit']).toEqual(expect.any(String));
    expect(draft.variants[0]!.requirements[0]!.unit).toBe('');
  });

  it.each(['invalid/zone', '+05:00', ''])('rejects a variant zone of %j', zone => {
    const draft = recipeToEditorDraft(recipe());
    draft.variants[0]!.timeZone = zone;
    const result = validateEditorDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.errors['variants[0].timeZone']).toEqual(expect.any(String));
    expect(result.recipe).toBeNull();
  });

  it('rejects duplicate variant and requirement identities', () => {
    const duplicateVariants = recipeToEditorDraft(recipe());
    duplicateVariants.variants[1]!.id = duplicateVariants.variants[0]!.id;
    expect(validateEditorDraft(duplicateVariants).valid).toBe(false);

    const duplicateRequirements = recipeToEditorDraft(recipe());
    duplicateRequirements.variants[0]!.requirements[1]!.id = 'setup';
    expect(validateEditorDraft(duplicateRequirements).valid).toBe(false);
  });

  it('rejects a dependency that names no requirement in the variant', () => {
    const draft = updateRequirement(recipeToEditorDraft(recipe()), 'main', 'record', { dependsOn: ['unknown'] });
    expect(validateEditorDraft(draft).valid).toBe(false);
    expect(editorDraftToRecipe(draft)).toBeNull();
  });

  it('requires a variant containing at least one requirement', () => {
    const noVariants = recipeToEditorDraft(recipe());
    noVariants.variants = [];
    expect(validateEditorDraft(noVariants).errors.variants).toEqual(expect.any(String));
    const noRequirements = recipeToEditorDraft(recipe());
    noRequirements.variants[0]!.requirements = [];
    expect(validateEditorDraft(noRequirements).errors['variants[0].requirements']).toEqual(expect.any(String));
  });

  it('rejects self-dependencies, longer cycles, and dependencies that finish too late', () => {
    const draft = recipeToEditorDraft(recipe());
    const self = updateRequirement(draft, 'main', 'setup', { dependsOn: ['setup'] });
    expect(validateEditorDraft(self).errors['variants[0].requirements[0].dependsOn']).toEqual(expect.any(String));

    const cycle = updateRequirement(draft, 'main', 'setup', { dependsOn: ['pack'] });
    expect(validateEditorDraft(cycle).errors['variants[0].requirements[0].dependsOn']).toEqual(expect.any(String));

    const late = updateRequirement(draft, 'main', 'record', { startLocal: '2026-10-09T06:50' });
    expect(validateEditorDraft(late).errors['variants[0].requirements[1].dependsOn']).toEqual(expect.any(String));
  });
});

describe('editor explicit local-time decisions', () => {
  it.each(['reject', 'earlier', 'later'] as const)('rejects a DST gap even with %s disambiguation', disambiguation => {
    const draft = updateRequirement(recipeToEditorDraft(timeRecipe()), 'main', 'setup', {
      startLocal: '2026-03-08T02:30', endLocal: '2026-03-08T04:00',
      startDisambiguation: disambiguation,
    });
    const result = validateEditorDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.errors[startPath]).toEqual(expect.any(String));
    expect(result.recipe).toBeNull();
  });

  it('requires a fold choice instead of silently choosing an instant', () => {
    const draft = updateRequirement(recipeToEditorDraft(timeRecipe()), 'main', 'setup', {
      startLocal: '2026-11-01T01:30', endLocal: '2026-11-01T03:00', startDisambiguation: 'reject',
    });
    const result = validateEditorDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.errors[startPath]).toEqual(expect.any(String));
    expect(result.recipe).toBeNull();
  });

  it.each([
    ['earlier', Date.UTC(2026, 10, 1, 5, 30)],
    ['later', Date.UTC(2026, 10, 1, 6, 30)],
  ] as const)('honors the %s fold choice', (disambiguation, expected) => {
    const draft = updateRequirement(recipeToEditorDraft(timeRecipe()), 'main', 'setup', {
      startLocal: '2026-11-01T01:30', endLocal: '2026-11-01T03:00', startDisambiguation: disambiguation,
    });
    const result = validateEditorDraft(draft);
    expect(result.valid).toBe(true);
    expect(result.recipe!.variants[0]!.requirements[0]!.interval).toEqual({
      start: expected, end: Date.UTC(2026, 10, 1, 8),
    });
  });

  it('preserves an existing late-fold instant through an unrelated edit', () => {
    const original = timeRecipe();
    original.variants[0]!.requirements[0]!.interval = {
      start: Date.UTC(2026, 10, 1, 6, 30, 12, 345), end: Date.UTC(2026, 10, 1, 7, 30, 56, 789),
    };
    const draft = updateRequirement(recipeToEditorDraft(original), 'main', 'setup', { instructions: 'New instructions' });
    expect(editorDraftToRecipe(draft)!.variants[0]!.requirements[0]!.interval).toEqual(original.variants[0]!.requirements[0]!.interval);
  });

  it('rejects a nonpositive interval after conversion', () => {
    const draft = updateRequirement(recipeToEditorDraft(recipe()), 'main', 'setup', {
      startLocal: '2026-10-09T09:00', endLocal: '2026-10-09T08:00',
    });
    expect(validateEditorDraft(draft).valid).toBe(false);
    expect(editorDraftToRecipe(draft)).toBeNull();
  });
});

describe('editor structural changes', () => {
  it('copies a variant with independent requirement IDs and internal dependencies', () => {
    const draft = recipeToEditorDraft(recipe());
    const before = structuredClone(draft);
    let nextId = 0;
    const changed = copyVariant(draft, 'main', 'main-copy', () => `copy-requirement-${++nextId}`);
    const copy = changed.variants.find(variant => variant.id === 'main-copy')!;
    const originals = draft.variants[0]!.requirements.map(item => item.id);
    const copies = copy.requirements.map(item => item.id);

    expect(copy).toBeDefined();
    expect(copies).toHaveLength(3);
    expect(new Set(copies).size).toBe(3);
    expect(copies.every(id => !originals.includes(id))).toBe(true);
    expect(copy.requirements[1]!.dependsOn).toEqual([copies[0]]);
    expect(copy.requirements[2]!.dependsOn).toEqual([copies[0], copies[1]]);
    expect(copy).toMatchObject({ venueId: 'hall-west', timeZone: 'America/New_York', instructions: 'Keep the door clear.' });
    expect(draft).toEqual(before);
    expect(editorDraftToRecipe(changed)).not.toBeNull();

    copy.requirements[2]!.dependsOn.push('copy-only');
    expect(draft.variants[0]!.requirements[2]!.dependsOn).toEqual(['setup', 'record']);
  });

  it('removes references to a deleted requirement and preserves the other variant', () => {
    const draft = recipeToEditorDraft(recipe());
    const before = structuredClone(draft);
    const changed = removeRequirement(draft, 'main', 'setup');

    expect(changed.variants[0]!.requirements.map(item => item.id)).toEqual(['record', 'pack']);
    expect(changed.variants[0]!.requirements[0]!.dependsOn).toEqual([]);
    expect(changed.variants[0]!.requirements[1]!.dependsOn).toEqual(['record']);
    expect(changed.variants[1]).toEqual(before.variants[1]);
    expect(draft).toEqual(before);
    expect(editorDraftToRecipe(changed)).not.toBeNull();
  });

  it('adds and removes a variant while retaining existing draft content', () => {
    const draft = recipeToEditorDraft(recipe());
    const before = structuredClone(draft);
    const added = addVariant(draft, 'added');

    expect(added.variants.find(variant => variant.id === 'added')).toBeDefined();
    expect(added.variants.filter(variant => variant.id !== 'added')).toEqual(before.variants);
    expect(removeVariant(added, 'added')).toEqual(before);
    expect(draft).toEqual(before);
  });

  it('adds a requirement only to the selected variant', () => {
    const draft = recipeToEditorDraft(recipe());
    const before = structuredClone(draft);
    const added = addRequirement(draft, 'main', 'added-requirement');

    expect(added.variants[0]!.requirements.find(item => item.id === 'added-requirement')).toBeDefined();
    expect(added.variants[0]!.requirements.filter(item => item.id !== 'added-requirement')).toEqual(before.variants[0]!.requirements);
    expect(added.variants[1]).toEqual(before.variants[1]);
    expect(draft).toEqual(before);
  });
});

describe('recoverable editor draft schema', () => {
  it('allows unfinished or invalid field text to remain a recoverable draft', () => {
    const draft = withQuantity('not a number');
    draft.title = '';
    draft.timeZone = 'not a zone';
    draft.variants[0]!.requirements[0]!.startLocal = '';
    draft.variants[0]!.requirements[0]!.unit = '';

    expect(isEditorDraft(draft)).toBe(true);
    expect(validateEditorDraft(draft).valid).toBe(false);
  });

  it('rejects corrupted stable identities that cannot be corrected through text fields', () => {
    const emptyId = recipeToEditorDraft(recipe());
    emptyId.variants[0]!.requirements[0]!.id = '';
    expect(isEditorDraft(emptyId)).toBe(false);
    const overlongId = recipeToEditorDraft(recipe());
    overlongId.variants[0]!.id = 'v'.repeat(129);
    expect(isEditorDraft(overlongId)).toBe(false);
    const repeatedVariant = recipeToEditorDraft(recipe());
    repeatedVariant.variants[1]!.id = repeatedVariant.variants[0]!.id;
    expect(isEditorDraft(repeatedVariant)).toBe(false);
    const repeatedRequirement = recipeToEditorDraft(recipe());
    repeatedRequirement.variants[0]!.requirements[1]!.id = repeatedRequirement.variants[0]!.requirements[0]!.id;
    expect(isEditorDraft(repeatedRequirement)).toBe(false);
  });

  it.each([null, undefined, [], {}, { variants: [] }])('rejects an incomplete schema: %j', value => {
    expect(isEditorDraft(value)).toBe(false);
  });

  it('rejects unexpected fields, invalid resource kinds and foreign source-root values', () => {
    const draft = recipeToEditorDraft(recipe());
    expect(isEditorDraft({ ...draft, unexpected: true })).toBe(false);
    expect(isEditorDraft({ ...draft, sourceProjectRoot: 'foreign:project' })).toBe(false);
    const invalidKind = structuredClone(draft) as unknown as { variants: { requirements: { kind: unknown }[] }[] };
    invalidKind.variants[0]!.requirements[0]!.kind = 'material';
    expect(isEditorDraft(invalidKind)).toBe(false);
    const invalidMetadata = structuredClone(draft);
    invalidMetadata.variants[0]!.requirements[0]!.originalInterval!.start = Number.NaN;
    expect(isEditorDraft(invalidMetadata)).toBe(false);
  });

  it('rejects mismatched scalar and collection types without coercion', () => {
    const draft = recipeToEditorDraft(recipe());
    expect(isEditorDraft({ ...draft, title: 42 })).toBe(false);
    expect(isEditorDraft({ ...draft, variants: 'main' })).toBe(false);

    const invalidQuantity = structuredClone(draft) as unknown as { variants: { requirements: { quantity: unknown }[] }[] };
    invalidQuantity.variants[0]!.requirements[0]!.quantity = 3;
    expect(isEditorDraft(invalidQuantity)).toBe(false);

    const invalidDependency = structuredClone(draft) as unknown as { variants: { requirements: { dependsOn: unknown }[] }[] };
    invalidDependency.variants[0]!.requirements[0]!.dependsOn = ['setup', 2];
    expect(isEditorDraft(invalidDependency)).toBe(false);

    const invalidChoice = structuredClone(draft) as unknown as { variants: { requirements: { startDisambiguation: unknown }[] }[] };
    invalidChoice.variants[0]!.requirements[0]!.startDisambiguation = 'compatible';
    expect(isEditorDraft(invalidChoice)).toBe(false);
  });
});
