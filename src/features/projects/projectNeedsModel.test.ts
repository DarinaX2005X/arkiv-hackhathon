import { describe, expect, it } from 'vitest';
import { localRecord, makeSmallWorksFixture, makeSmallWorksProject, SMALL_WORKS_COORDINATOR, SMALL_WORKS_NOW } from '../../domain/fixtures';
import { solve } from '../../domain/solver';
import type { ProjectAggregate, ProjectRecipe } from '../../domain/types';
import { publishPlanInput } from './selectors';
import { projectNeedsModel, type ProjectNeedsModel } from './projectNeedsModel';

function recipeOf(project: ProjectAggregate): ProjectRecipe {
  if (project.state.status !== 'unique') throw new Error('Expected a saved recipe.');
  return project.state.entity.payload.recipe;
}
function readable(project: ProjectAggregate): Extract<ProjectNeedsModel, { available: true }> {
  const model = projectNeedsModel(project);
  if (!model.available) throw new Error('Expected readable needs.');
  return model;
}
function activatedProject(): ProjectAggregate {
  const project = makeSmallWorksProject({ oak: true });
  const candidate = solve(makeSmallWorksFixture({ oak: true })).candidates[0]!;
  const { proposal } = publishPlanInput(project, candidate, 'needs-test-proposal', SMALL_WORKS_NOW, 'Complete plan');
  project.proposal = localRecord('local:needs-test-proposal', structuredClone(proposal), SMALL_WORKS_COORDINATOR);
  project.activation = { status: 'unique', entity: localRecord('local:needs-test-activation', {
    protocol: 'partfolk/1', schemaVersion: 1, entityType: 'plan_activation', createdAt: SMALL_WORKS_NOW,
    operationId: 'needs-test-activation', projectRoot: project.root.key, proposalKey: project.proposal.key,
    proposalHash: proposal.proposalHash, predecessorActivationKeys: [],
  }, SMALL_WORKS_COORDINATOR) };
  return project;
}

describe('read-only project needs presentation', () => {
  it('preserves every original option and the details needed to prepare an exact offer before a proposal', () => {
    const project = makeSmallWorksProject(), recipe = recipeOf(project);
    recipe.instructions = 'Instructions for everyone\nKeep the access route clear.';
    recipe.sourceProjectRoot = 'local:earlier-project';
    const model = readable(project);
    expect(model).toMatchObject({ title: 'Small Works', outcome: recipe.outcome, timeZone: 'Europe/London',
      instructions: recipe.instructions, sourceProjectRoot: 'local:earlier-project', comparison: 'not_proposed' });
    expect(model.variants.map(option => option.id)).toEqual(['saturday', 'sunday']);
    const sunday = model.variants[1]!;
    expect(sunday).toMatchObject({ title: 'Sunday at the Library', venueId: 'library-hall', timeZone: 'Europe/London', instructions: 'Synthetic library hall.' });
    expect(sunday.requirements.find(item => item.id === 'boards')).toMatchObject({
      title: 'Display boards', kind: 'equipment', kindLabel: 'Equipment', capability: 'display-board',
      quantity: 6, unit: 'board', quantityLabel: '6 board', instructions: 'Boards are already at the venue before setup.',
      start: Date.parse('2026-10-18T09:00:00Z'), end: Date.parse('2026-10-18T15:00:00Z'),
    });
    expect(sunday.requirements.find(item => item.id === 'hosting')?.dependencies.map(item => item.label))
      .toEqual(['Install the displays (installation)', 'Bring the artworks (transport)']);
    expect(new Set(sunday.requirements.map(item => item.kind))).toEqual(new Set(['person', 'place', 'equipment']));
    expect(model.notice.message).not.toMatch(/\bagreed\b|\bready\b/i);
  });

  it('uses each option’s zone and distinguishes repeated local clock times with offsets', () => {
    const project = makeSmallWorksProject(), recipe = recipeOf(project);
    recipe.timeZone = 'Asia/Tokyo';
    recipe.variants[0]!.timeZone = 'Europe/London';
    recipe.variants[0]!.requirements[0]!.interval = { start: Date.parse('2026-10-25T00:30:00Z'), end: Date.parse('2026-10-25T01:30:00Z') };
    recipe.variants[1]!.timeZone = 'America/New_York';
    recipe.variants[1]!.requirements[0]!.interval = { start: Date.parse('2026-01-01T04:30:00Z'), end: Date.parse('2026-01-01T06:30:00Z') };
    const model = readable(project), london = model.variants[0]!.requirements[0]!, newYork = model.variants[1]!.requirements[0]!;
    expect(london.startLabel).toContain('01:30 GMT+1');
    expect(london.endLabel).toContain('01:30 GMT');
    expect(london.startLabel).not.toBe(london.endLabel);
    expect(newYork.startLabel).toContain('Dec 31, 2025');
    expect(newYork.startLabel).toContain('23:30 GMT-5');
    expect(newYork.endLabel).toContain('Jan 1, 2026');
    expect(newYork.endLabel).toContain('01:30 GMT-5');
  });

  it('resolves dependencies inside their own option and retains an unresolved reference', () => {
    const project = makeSmallWorksProject(), recipe = recipeOf(project);
    recipe.variants[0]!.requirements.find(item => item.id === 'installation')!.title = 'Saturday setup';
    recipe.variants[1]!.requirements.find(item => item.id === 'installation')!.title = 'Sunday setup';
    recipe.variants[1]!.requirements.find(item => item.id === 'hosting')!.dependsOn = ['installation', 'unavailable-dependency'];
    const model = readable(project);
    expect(model.variants[0]!.requirements.find(item => item.id === 'hosting')!.dependencies[0]!.title).toBe('Saturday setup');
    expect(model.variants[1]!.requirements.find(item => item.id === 'hosting')!.dependencies).toEqual([
      { id: 'installation', title: 'Sunday setup', label: 'Sunday setup (installation)' },
      { id: 'unavailable-dependency', title: 'unavailable-dependency', label: 'unavailable-dependency' },
    ]);
  });

  it('retains sub-minute precision in externally published requirement intervals', () => {
    const project = makeSmallWorksProject(), recipe = recipeOf(project);
    recipe.variants[0]!.requirements[0]!.interval = { start: Date.parse('2026-10-17T09:00:15.123Z'), end: Date.parse('2026-10-17T09:01:45Z') };
    const requirement = readable(project).variants[0]!.requirements[0]!;
    expect(requirement.startLabel).toContain('10:00:15.123 GMT+1');
    expect(requirement.endLabel).toContain('10:01:45 GMT+1');
    expect(requirement.startIso).toBe('2026-10-17T09:00:15.123Z');
  });

  it('keeps exact raw instants readable if public timestamps exceed the date formatter range', () => {
    const project = makeSmallWorksProject(), recipe = recipeOf(project);
    recipe.variants[0]!.requirements[0]!.interval = { start: Number.MAX_SAFE_INTEGER - 60_000, end: Number.MAX_SAFE_INTEGER };
    const requirement = readable(project).variants[0]!.requirements[0]!;
    expect(requirement.endLabel).toBe(`${Number.MAX_SAFE_INTEGER} UTC milliseconds (date display unavailable)`);
    expect(requirement.endIso).toBeUndefined();
  });

  it('shows original required intervals instead of longer equipment custody reservations', () => {
    const project = activatedProject(), recipe = recipeOf(project);
    const equipment = project.proposal!.payload.plan.allocations.find(allocation => allocation.requirementId === 'boards')!;
    equipment.interval.start -= 3_600_000; equipment.interval.end += 3_600_000;
    const required = recipe.variants.find(option => option.id === project.proposal!.payload.plan.variant.id)!.requirements.find(item => item.id === 'boards')!;
    const shown = readable(project).variants.find(option => option.id === project.proposal!.payload.plan.variant.id)!.requirements.find(item => item.id === 'boards')!;
    expect({ start: shown.start, end: shown.end }).toEqual(required.interval);
    expect(shown.start).not.toBe(equipment.interval.start);
    expect(shown.end).not.toBe(equipment.interval.end);
  });

  it('distinguishes changed saved draft terms while retaining every option and the immutable active terms', () => {
    const project = activatedProject(), recipe = recipeOf(project), originalOutcome = project.proposal!.payload.plan.outcome;
    recipe.outcome = 'A revised outcome for contributors';
    recipe.variants[1]!.requirements[0]!.capability = 'revised-space-capability';
    const model = readable(project);
    expect(model.comparison).toBe('changed');
    expect(model.notice.title).toBe('Saved draft needs differ from the active plan');
    expect(model.outcome).toBe('A revised outcome for contributors');
    expect(model.variants).toHaveLength(2);
    expect(model.variants[1]!.requirements[0]!.capability).toBe('revised-space-capability');
    expect(project.proposal!.payload.plan.outcome).toBe(originalOutcome);
    expect(project.proposal!.payload.plan.variant.requirements[0]!.capability).toBe('exhibition-space');
  });

  it('marks removal of the active option as changed instead of falling back to historical needs', () => {
    const project = activatedProject(), recipe = recipeOf(project);
    recipe.variants = recipe.variants.filter(option => option.id !== project.proposal!.payload.plan.variant.id);
    const model = readable(project);
    expect(model.comparison).toBe('changed');
    expect(model.variants.map(option => option.id)).toEqual(['saturday']);
  });

  it('labels matching selected needs without claiming agreement or treating alternative edits as active changes', () => {
    const project = activatedProject(), recipe = recipeOf(project);
    recipe.title = 'A new project label'; recipe.timeZone = 'Asia/Tokyo'; recipe.variants[0]!.instructions = 'A changed alternative';
    const model = readable(project);
    expect(model.comparison).toBe('matching');
    expect(model.notice.title).toBe('Selected option matches the active plan’s needs');
    expect(model.notice.message).toContain('owner decisions');
    expect(model.notice.message).not.toMatch(/\bagreed\b|\bready\b/i);
    expect(model.variants[0]!.instructions).toBe('A changed alternative');
  });

  it.each(['missing', 'conflict', 'unverified', 'mismatched-key', 'mismatched-hash', 'no-proposal'] as const)('cannot claim active comparison for %s activation evidence', kind => {
    const project = activatedProject();
    if (kind === 'missing') project.activation = { status: 'missing', reason: 'expired_or_deleted' };
    if (kind === 'conflict' && project.activation.status === 'unique') project.activation = { status: 'conflict', entities: [project.activation.entity] };
    if (kind === 'unverified') project.activation = { status: 'unverified', reasons: [{ code: 'incomplete_snapshot' }] };
    if (kind === 'mismatched-key' && project.activation.status === 'unique') project.activation.entity.payload.proposalKey = 'local:different-proposal';
    if (kind === 'mismatched-hash' && project.activation.status === 'unique') project.activation.entity.payload.proposalHash = `0x${'a'.repeat(64)}`;
    if (kind === 'no-proposal') project.proposal = null;
    expect(readable(project).comparison).toBe('unverified');
  });

  it('identifies stale saved content without presenting a verified current comparison', () => {
    const project = activatedProject(); project.snapshot.freshness = 'stale';
    const model = readable(project);
    expect(model.heading).toBe('Last-known saved project needs');
    expect(model.snapshotNotice).toContain('Refresh');
    expect(model.comparison).toBe('unverified');
    expect(model.variants).toHaveLength(2);
  });

  it('keeps a closed project’s needs as reference rather than an active invitation', () => {
    const project = activatedProject();
    if (project.state.status === 'unique') project.state.entity.payload.lifecycle = 'closed';
    expect(readable(project).comparison).toBe('closed');
    expect(readable(project).notice.message).toContain('do not invite new commitments');
  });

  it('does not select a recipe from conflicting or unavailable state', () => {
    const project = activatedProject();
    if (project.state.status === 'unique') project.state = { status: 'conflict', entities: [project.state.entity] };
    expect(projectNeedsModel(project)).toMatchObject({ available: false, notice: { title: 'Saved project needs are unavailable' } });
    project.state = { status: 'missing', reason: 'expired_or_deleted' };
    expect(projectNeedsModel(project).available).toBe(false);
  });
});
