import { describe, expect, it } from 'vitest';
import { hashPlan, hashRequirements } from '../../domain/canonical';
import { makeSmallWorksProject, makeSmallWorksFixture, localRecord, SMALL_WORKS_COORDINATOR } from '../../domain/fixtures';
import { activeSource, deriveReadiness } from '../../domain/readiness';
import { completedWorkContext, deriveExecution, reuseRecipe } from '../../domain/execution';
import { prepareDecision } from '../../domain/operations';
import { solve } from '../../domain/solver';
import { finalizePlan, independentlyValidatePlan } from '../../domain/validation';
import type { EntityKey, ProjectAggregate, SolverResult } from '../../domain/types';
import type { ReplaceBookCommand, WriteAuthority } from '../../data/types';
import { templateToEditorDraft } from '../projects/editor';
import { publishPlanInput } from '../projects/selectors';
import { prepareClosureCommand, prepareProgressCommand, rowLabels, runbookRows, sourceForProposal, versionStatus } from './model';
import { createRepairController, prepareExecutionCheckpoint, repairFingerprint, repairInput, solveRepair } from './repair';
import { buildExecutionExports, packetFromProject, parseExecutionExport } from './export';

const budget = { maxNodes: 100000, maxCandidates: 20 };
function fixture(transfers = false) {
  const project = makeSmallWorksProject({ oak: true });
  const candidate = solve(makeSmallWorksFixture({ oak: true }), [], budget).candidates[0]!;
  expect(candidate).toBeDefined();
  const plan = structuredClone(candidate.plan), now = project.snapshot.blockTimestamp;
  if (transfers) {
    const allocation = plan.allocations.find(item => item.resourceId === 'boards')!;
    const base = { publisherRoot: allocation.publisherRoot, resourceId: allocation.resourceId, quantity: allocation.quantity, unit: allocation.unit,
      allocationIds: [allocation.id], dependsOn: [], instructions: 'Count the boards together.' };
    plan.runbook.push({ ...base, kind: 'handover', id: 'handover-boards', transferId: 'send-boards', title: 'Hand over boards', giver: 'local:makerspace', receiver: 'local:cedar', interval: { start: allocation.interval.start, end: allocation.interval.start + 60_000 } },
      { ...base, publisherRoot: 'local:cedar', kind: 'return', id: 'return-boards', transferId: 'return-boards', title: 'Return boards', giver: 'local:cedar', receiver: 'local:makerspace', interval: { start: allocation.interval.end - 60_000, end: allocation.interval.end } });
  }
  const checked = finalizePlan(plan, project.publishers, project.snapshot);
  if (!checked.ok) throw new Error(JSON.stringify(checked.reasons));
  const proposal = { protocol: 'partfolk/1' as const, schemaVersion: 1 as const, entityType: 'proposal' as const, operationId: 'proposal-one', createdAt: now,
    projectRoot: project.root.key, plan: checked.value.plan, proposalHash: checked.value.proposalHash, requirementsHash: checked.value.requirementsHash, changeExplanation: 'Initial plan' };
  project.proposal = localRecord('local:proposal-one', proposal, SMALL_WORKS_COORDINATOR);
  project.activation = { status: 'unique', entity: localRecord('local:activation-one', { protocol: 'partfolk/1', schemaVersion: 1, entityType: 'plan_activation', operationId: 'activation-one', createdAt: now,
    projectRoot: project.root.key, proposalKey: project.proposal.key, proposalHash: proposal.proposalHash, predecessorActivationKeys: [] }, SMALL_WORKS_COORDINATOR) };
  return project;
}
function authority(project: ProjectAggregate, root: EntityKey): WriteAuthority {
  const actor = project.publishers.find(item => item.root.key === root)!.root.payload.publisher;
  if (actor.kind !== 'local') throw new Error('fixture');
  return { mode: 'local', actor, chainId: null };
}
function apply(project: ProjectAggregate, command: ReplaceBookCommand) {
  const publisher = project.publishers.find(item => item.root.key === command.publisherRoot)!;
  publisher.book = { status: 'unique', entity: localRecord(`local:book:${command.operation.id}`, command.book, command.operation.authority.actor) };
}
function agree(project: ProjectAggregate) {
  for (const root of project.proposal!.payload.plan.requiredApprovers) {
    const prepared = prepareDecision(project, root, authority(project, root).actor, { status: 'accepted', now: project.snapshot.blockTimestamp, operationId: `accept-${root}`, validUntil: Math.max(...project.proposal!.payload.plan.runbook.map(duty => duty.interval.end)) + 60_000 });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    const publisher = project.publishers.find(item => item.root.key === root)!;
    publisher.book = { status: 'unique', entity: localRecord(`local:book:accept:${root}`, prepared.value.book, publisher.root.payload.publisher) };
  }
}
function progress(project: ProjectAggregate, root: EntityKey, duty: string, input: Parameters<typeof prepareProgressCommand>[5], id: string) {
  const command = prepareProgressCommand(project, project.proposal!, activeSource(project)!, duty, authority(project, root), input, project.snapshot.blockTimestamp, id);
  apply(project, command); return command;
}
function advance(project: ProjectAggregate) { project.snapshot.blockTimestamp++; project.snapshot.fetchedAt++; project.publishers.forEach(publisher => { publisher.snapshot = { ...project.snapshot }; }); }

describe('execution presentation and commands', () => {
  it('orders actual task times and shows no readiness just from viewing a proposal', () => {
    const project = fixture();
    const rows = runbookRows(project, project.proposal!, activeSource(project), null);
    expect(rows.map(row => row.obligation.interval.start)).toEqual(rows.map(row => row.obligation.interval.start).sort((a, b) => a - b));
    expect(versionStatus(project, project.proposal!, project.snapshot.fetchedAt)).toContain('awaiting');
    expect(rows.every(row => !row.completed && !row.mine)).toBe(true);
    agree(project); expect(versionStatus(project, project.proposal!, project.snapshot.fetchedAt)).toBe('Agreed by everyone');
  });
  it('records only the actor’s task and keeps self-report separate from acknowledgement', () => {
    const project = fixture(); agree(project);
    const duty = project.proposal!.payload.plan.runbook.find(item => item.publisherRoot === 'local:cedar')!;
    expect(() => prepareProgressCommand(project, project.proposal!, activeSource(project)!, duty.id, { mode: 'local', actor: SMALL_WORKS_COORDINATOR as { kind: 'local'; id: `local-actor:${string}` }, chainId: null }, { kind: 'task_report', status: 'done', note: '' }, project.snapshot.fetchedAt, 'forged')).toThrow('Only the named owner');
    progress(project, 'local:cedar', duty.id, { kind: 'task_report', status: 'done', note: 'Installed my part.' }, 'task-done');
    const row = runbookRows(project, project.proposal!, activeSource(project), authority(project, 'local:cedar').actor).find(item => item.obligation.id === duty.id)!;
    expect(row.status).toBe('reported_done'); expect(row.mine).toBe(true); expect(row.acknowledgements).toEqual([]);
    advance(project); progress(project, 'local:cedar', duty.id, { kind: 'task_report', status: 'not_done', note: 'One panel needs correction.' }, 'correct-done');
    expect(runbookRows(project, project.proposal!, activeSource(project), null).find(item => item.obligation.id === duty.id)?.status).toBe('reported_not_done');
  });
  it('requires two authored sides through handover and return, preserving an unacknowledged return at closure', () => {
    const project = fixture(true); agree(project);
    const handed = progress(project, 'local:makerspace', 'handover-boards', { kind: 'transfer_report', quantity: 6 }, 'give');
    const report = handed.book.attestations.find(item => item.id === 'report:give')!;
    const rows = () => runbookRows(project, project.proposal!, activeSource(project), null);
    expect(rows().find(row => row.obligation.id === 'handover-boards')?.status).toBe('awaiting_acknowledgement');
    expect(() => progress(project, 'local:makerspace', 'handover-boards', { kind: 'transfer_acknowledgement', reportId: report.id, quantity: 6 }, 'forged-ack')).toThrow('Only the named owner');
    progress(project, 'local:cedar', 'handover-boards', { kind: 'transfer_acknowledgement', reportId: report.id, quantity: 6 }, 'receive');
    expect(rows().find(row => row.obligation.id === 'handover-boards')?.status).toBe('confirmed_handover');
    progress(project, 'local:cedar', 'return-boards', { kind: 'transfer_report', quantity: 6 }, 'return');
    expect(rows().find(row => row.obligation.id === 'return-boards')?.status).toBe('awaiting_acknowledgement');
    const coordinator = { mode: 'local' as const, actor: SMALL_WORKS_COORDINATOR as { kind: 'local'; id: `local-actor:${string}` }, chainId: null };
    const closed = prepareClosureCommand(project, coordinator, 'completed_with_outstanding', 'One return still awaiting acknowledgement.', project.snapshot.fetchedAt, 'close');
    expect(closed.state.completion?.outstandingObligationIds).toContain('return-boards');
    expect(closed.state.completion?.outstandingCustodyHoldIds).toContain('report:give');
    expect(closed.expectedActivationHeads).toEqual(['local:activation-one']);
    expect(prepareClosureCommand(project, coordinator, 'cancelled', 'Weather cancellation.', project.snapshot.fetchedAt, 'cancel').state.completion?.outcome).toBe('cancelled');
    progress(project, 'local:makerspace', 'return-boards', { kind: 'transfer_acknowledgement', reportId: 'report:return', quantity: 6 }, 'returned');
    expect(rows().find(row => row.obligation.id === 'return-boards')?.status).toBe('confirmed_return');
    expect(deriveExecution(project).outstandingCustodyHolds).toEqual([]);
  });
  it('retains historical content and labels network gaps honestly', () => {
    const project = fixture(); const original = JSON.stringify(project.proposal);
    project.proposalHistory = [structuredClone(project.proposal!)];
    project.proposal = null; project.activation = { status: 'missing', reason: 'expired_or_deleted' };
    expect(versionStatus(project, project.proposalHistory[0]!, project.snapshot.fetchedAt)).toContain('Historical');
    runbookRows(project, project.proposalHistory[0]!, null, null);
    expect(JSON.stringify(project.proposalHistory[0])).toBe(original);
    expect(sourceForProposal(project, project.proposalHistory[0]!.key)).toBeNull();
    const current = fixture(); current.snapshot.freshness = 'stale';
    expect(versionStatus(current, current.proposal!, current.snapshot.fetchedAt)).toContain('unverified');
    expect(runbookRows(current, current.proposal!, activeSource(current), null).every(row => row.status === 'evidence_unavailable')).toBe(true);
  });
});

describe('remaining-work repair', () => {
  function withdrawn(juniper: boolean) {
    const project = fixture(); agree(project);
    const oak = project.publishers.find(publisher => publisher.root.key === 'local:oak')!;
    const result = prepareDecision(project, oak.root.key, oak.root.payload.publisher, { status: 'withdrawn', now: project.snapshot.fetchedAt, operationId: 'withdraw' });
    if (!result.ok) throw new Error(JSON.stringify(result.reasons));
    oak.book = { status: 'unique', entity: localRecord('local:oak:withdrawn', result.value.book, oak.root.payload.publisher) };
    if (juniper) {
      const person = makeSmallWorksFixture({ juniper: true }).publishers.find(publisher => publisher.root.key === 'local:juniper')!;
      project.publishers.push(person);
      if (project.state.status === 'unique') project.state.entity.payload.publisherRoots.push(person.root.key);
    }
    return project;
  }
  it('cannot fill Willow’s unfinished installation by assigning the already-completed Cedar slot again', () => {
    const project = fixture(); agree(project);
    const installation = project.proposal!.payload.plan.runbook.find(duty => duty.kind === 'task'
      && duty.publisherRoot === 'local:cedar' && duty.title === 'Install the displays')!;
    progress(project, 'local:cedar', installation.id, { kind: 'task_report', status: 'done', note: 'My section is complete.' }, 'cedar-complete');
    const willow = project.publishers.find(publisher => publisher.root.key === 'local:willow')!;
    const withdrawal = prepareDecision(project, willow.root.key, willow.root.payload.publisher,
      { status: 'withdrawn', now: project.snapshot.fetchedAt, operationId: 'willow-withdraws' });
    if (!withdrawal.ok) throw new Error(JSON.stringify(withdrawal.reasons));
    willow.book = { status: 'unique', entity: localRecord('local:willow-withdrawn', withdrawal.value.book, willow.root.payload.publisher) };
    const input = repairInput(project)!;
    expect(input.recipe.variants[0]!.requirements.find(requirement => requirement.id === 'installation')?.quantity).toBe(1);
    const result = solveRepair(project, input, [], budget);
    expect(result.status).toBe('impossible'); expect(result.candidates).toEqual([]);
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'capacity_exceeded', publisherRoot: 'local:cedar', resourceId: 'self' }));

    // A hand-crafted caller must not bypass the rule by supplying the old solver's
    // structurally valid answer without its recorded completed-work input.
    const unsafe = solve({ ...input, completedWork: [] }, [], budget).candidates[0]!;
    expect(unsafe.plan.allocations.find(allocation => allocation.requirementId === 'installation')?.publisherRoot).toBe('local:cedar');
    expect(independentlyValidatePlan(unsafe.plan, project.publishers, project.snapshot.blockTimestamp, [], completedWorkContext(project)).valid).toBe(false);

    const replacement = makeSmallWorksFixture({ juniper: true }).publishers.find(publisher => publisher.root.key === 'local:juniper')!;
    project.publishers.push(replacement);
    if (project.state.status !== 'unique') throw new Error('fixture');
    project.state.entity.payload.publisherRoots.push(replacement.root.key);
    const repaired = solveRepair(project, repairInput(project)!, [], budget).candidates[0]!;
    expect(repaired.plan.allocations.find(allocation => allocation.requirementId === 'installation')?.publisherRoot).toBe('local:juniper');
    expect(repairInput(project)!.completedWork.some(work => work.obligationId === installation.id)).toBe(true);
    const prior = project.proposal!;
    project.proposalHistory.push(prior);
    project.state.entity.payload.completedWork = deriveExecution(project).completed;
    project.proposal = localRecord('local:replacement-after-completion', { ...prior.payload, plan: repaired.plan,
      proposalHash: repaired.proposalHash, requirementsHash: hashRequirements(project.root.key, repaired.plan.variant.requirements) }, SMALL_WORKS_COORDINATOR);
    if (project.activation.status !== 'unique') throw new Error('fixture');
    project.activation.entity = localRecord('local:new-completed-activation', { ...project.activation.entity.payload,
      proposalKey: project.proposal.key, proposalHash: repaired.proposalHash, predecessorActivationKeys: [project.activation.entity.key] }, SMALL_WORKS_COORDINATOR);
    const readiness = deriveReadiness(project, project.snapshot.fetchedAt);
    expect(readiness.status).toBe('awaiting_approval'); expect(readiness.acceptedApprovers).toEqual([]);
    agree(project);
    expect(deriveReadiness(project, project.snapshot.fetchedAt).status).toBe('ready');
  });
  it('retains an equipment reservation solely for its return after its use is completed', () => {
    const project = fixture(true); agree(project);
    progress(project, 'local:makerspace', 'handover-boards', { kind: 'transfer_report', quantity: 6 }, 'boards-given');
    progress(project, 'local:cedar', 'handover-boards', { kind: 'transfer_acknowledgement', reportId: 'report:boards-given', quantity: 6 }, 'boards-received');
    const boardsTask = project.proposal!.payload.plan.runbook.find(duty => duty.kind === 'task'
      && duty.allocationIds.some(id => project.proposal!.payload.plan.allocations.find(allocation => allocation.id === id)?.resourceId === 'boards'))!;
    progress(project, 'local:makerspace', boardsTask.id, { kind: 'task_report', status: 'done', note: 'Boards used.' }, 'boards-used');
    const result = solveRepair(project, repairInput(project)!, [], budget);
    expect(result.status).toBe('found');
    const candidate = result.candidates[0]!;
    expect(candidate.plan.runbook.some(duty => duty.id === 'return-boards')).toBe(true);
    expect(candidate.plan.runbook.some(duty => duty.id === boardsTask.id)).toBe(false);
    expect(independentlyValidatePlan(candidate.plan, project.publishers, project.snapshot.blockTimestamp, [], completedWorkContext(project)).valid).toBe(true);
    expect(deriveExecution(project).outstandingCustodyHolds.map(hold => hold.quantity)).toEqual([6]);
  });
  it('finds Cedar transport, Juniper installation, Willow unchanged and resets all agreement', () => {
    const project = withdrawn(true), input = repairInput(project)!;
    const result = solveRepair(project, input, [], budget), candidate = result.candidates[0]!;
    expect(result.status).toBe('found');
    expect(candidate.plan.allocations.filter(item => item.requirementId === 'transport').map(item => item.publisherRoot)).toEqual(['local:cedar']);
    expect(candidate.plan.allocations.filter(item => item.requirementId === 'installation').map(item => item.publisherRoot).sort()).toEqual(['local:juniper', 'local:willow']);
    const old = project.proposal!; project.proposalHistory.push(old);
    project.proposal = localRecord('local:proposal-two', { ...old.payload, plan: candidate.plan, proposalHash: candidate.proposalHash, requirementsHash: hashRequirements(project.root.key, candidate.plan.variant.requirements) }, SMALL_WORKS_COORDINATOR);
    if (project.activation.status === 'unique') project.activation.entity = localRecord('local:activation-two', { ...project.activation.entity.payload, proposalKey: project.proposal.key, proposalHash: candidate.proposalHash, predecessorActivationKeys: ['local:activation-one'] }, SMALL_WORKS_COORDINATOR);
    const ready = deriveReadiness(project, project.snapshot.fetchedAt);
    expect(ready.status).toBe('awaiting_approval'); expect(ready.acceptedApprovers).toEqual([]); expect(ready.requiredApprovers).not.toContain('local:oak'); expect(ready.requiredApprovers).toContain('local:library');
  });
  it('does not invent a missing replacement, and preserves already completed installation', () => {
    const project = withdrawn(false), input = repairInput(project)!;
    expect(solveRepair(project, input, [], budget).candidates).toEqual([]);
    const duty = project.proposal!.payload.plan.runbook.find(item => item.kind === 'task' && item.publisherRoot === 'local:willow' && item.title === 'Install the displays')!;
    progress(project, 'local:willow', duty.id, { kind: 'task_report', status: 'done', note: 'My section is complete.' }, 'install-done');
    const reduced = repairInput(project)!;
    expect(reduced.completedWork.some(work => work.obligationId === duty.id)).toBe(true);
    expect(reduced.recipe.variants[0]!.requirements.find(item => item.id === 'installation')?.quantity).toBe(1);
  });
  it('checkpoints completed work without changing repair inputs before publishing an exact remaining-work revision', () => {
    const project = withdrawn(true);
    const duty = project.proposal!.payload.plan.runbook.find(item => item.kind === 'task' && item.publisherRoot === 'local:willow' && item.title === 'Install the displays')!;
    progress(project, 'local:willow', duty.id, { kind: 'task_report', status: 'done', note: 'Done before the change.' }, 'prior-completion');
    const input = repairInput(project)!, selected = solveRepair(project, input, [], budget).candidates[0]!, fingerprint = repairFingerprint(project);
    expect(selected).toBeDefined();
    const authority: WriteAuthority = { mode: 'local', actor: { kind: 'local', id: 'local-actor:coordinator' }, chainId: null };
    const checkpoint = prepareExecutionCheckpoint(project, authority, project.snapshot.fetchedAt, 'checkpoint');
    project.state = { status: 'unique', entity: localRecord('local:checkpoint', checkpoint.state, authority.actor) };
    expect(repairFingerprint(project)).toBe(fingerprint);
    const command = publishPlanInput(project, selected, 'new-proposal', project.snapshot.fetchedAt, 'Replace the missing contribution.', { sourceRecipe: repairInput(project)!.recipe });
    expect(command.proposal.plan.predecessor).toEqual(activeSource(project));
    expect(command.proposal.plan.variant.requirements.find(requirement => requirement.id === 'installation')?.quantity).toBe(1);
    expect(checkpoint.state.completedWork[0]?.attestationIds).toContain('report:prior-completion');
  });
  it('invalidates a late result and retains the caller’s pins', async () => {
    const project = withdrawn(true);
    let finish!: (result: SolverResult) => void;
    const controller = createRepairController(() => new Promise<SolverResult>(resolve => { finish = resolve; }));
    controller.update(project, []); const pending = controller.run();
    const changed = structuredClone(project); if (changed.state.status === 'unique') changed.state.entity.payload.publisherRoots = changed.state.entity.payload.publisherRoots.filter(root => root !== 'local:juniper');
    controller.update(changed, []);
    finish(solveRepair(project, repairInput(project)!, [], budget)); await pending;
    expect(controller.candidate()).toBeNull(); expect(controller.getSnapshot().result).toBeNull(); expect(repairFingerprint(project)).not.toBe(repairFingerprint(changed));
  });
  it('invalidates a repair when only a partial transfer acknowledgement changes', async () => {
    const project = fixture(true); agree(project);
    progress(project, 'local:makerspace', 'handover-boards', { kind: 'transfer_report', quantity: 6 }, 'partial-send');
    progress(project, 'local:cedar', 'handover-boards', { kind: 'transfer_acknowledgement', reportId: 'report:partial-send', quantity: 2 }, 'partial-receive');
    const fingerprint = repairFingerprint(project);
    let finish!: (result: SolverResult) => void;
    const controller = createRepairController(() => new Promise<SolverResult>(resolve => { finish = resolve; }));
    controller.update(project, []); const pending = controller.run();
    const changed = structuredClone(project); advance(changed);
    progress(changed, 'local:cedar', 'handover-boards', { kind: 'transfer_acknowledgement', reportId: 'report:partial-send', quantity: 3 }, 'partial-correction');
    expect(repairFingerprint(changed)).not.toBe(fingerprint);
    controller.update(changed, []);
    finish({ status: 'impossible', candidates: [], reasons: [], nodesVisited: 0, exhausted: false, optimality: 'proven' });
    await pending; expect(controller.getSnapshot().result).toBeNull();
  });
});

describe('portable execution exports and recipe reuse', () => {
  it('includes shared and venue instructions as escaped text in the printable run sheet', () => {
    const project = fixture();
    project.proposal!.payload.plan.instructions = 'Everyone: <bring water> & share the lift.';
    project.proposal!.payload.plan.variant.instructions = 'Venue: use the <side door> & ring once.';
    project.proposal!.payload.proposalHash = hashPlan(project.proposal!.payload.plan);
    if (project.activation.status === 'unique') project.activation.entity.payload.proposalHash = project.proposal!.payload.proposalHash;
    const exported = buildExecutionExports(packetFromProject(project, project.snapshot.fetchedAt));
    expect(exported.html.text).toContain('Everyone: &lt;bring water&gt; &amp; share the lift.');
    expect(exported.html.text).toContain('Venue: use the &lt;side door&gt; &amp; ring once.');
    expect(exported.html.text).not.toContain('<side door>');
    expect(JSON.parse(exported.json.text).project.proposal.payload.plan.instructions).toContain('<bring water>');
  });
  it('exports exact English status, timezone, integer units, reports and escaped standalone HTML', () => {
    const project = fixture(true); if (project.state.status === 'unique') project.state.entity.payload.recipe.title = 'Café <script>alert(1)</script>';
    const exported = buildExecutionExports(packetFromProject(project, project.snapshot.fetchedAt), project.proposal!.key);
    const json = JSON.parse(exported.json.text);
    expect(json.selection.proposalKey).toBe(project.proposal!.key); expect(json.selection.status).toContain('awaiting');
    expect(json.project.proposal.payload.plan.variant.timeZone).toBe('Europe/London'); expect(json.project.proposal.payload.plan.allocations.some((item: { quantity: number; unit: string }) => item.quantity === 6 && item.unit === 'board')).toBe(true);
    expect(parseExecutionExport(exported.json.text).project.proposal?.payload.proposalHash).toBe(hashPlan(project.proposal!.payload.plan));
    expect(exported.html.text).toContain('Café &lt;script&gt;'); expect(exported.html.text).not.toContain('<script>'); expect(exported.html.text).not.toMatch(/<link|<img|<script|https?:\/\//);
    expect(exported.html.text).toContain('Europe/London'); expect(exported.html.text).toContain('Giver: Makerspace'); expect(exported.html.text).toContain('Recipient: Cedar');
  });
  it('rejects corrupt content as a whole and resets dates and all promises in reuse', () => {
    const project = fixture(); agree(project);
    const packet = packetFromProject(project, project.snapshot.fetchedAt); packet.project.proposal!.payload.plan.allocations[0]!.quantity++;
    expect(() => parseExecutionExport(JSON.stringify(packet))).toThrow();
    const template = reuseRecipe(project)!; const draft = templateToEditorDraft(template);
    expect(template.sourceProjectRoot).toBe(project.root.key); expect(template.variants[0]!.requirements[0]).not.toHaveProperty('interval');
    expect(draft.variants.every(variant => variant.requirements.every(requirement => !requirement.startLocal && !requirement.endLocal))).toBe(true);
    expect(draft).not.toHaveProperty('allocations'); expect(draft).not.toHaveProperty('decisions'); expect(draft).not.toHaveProperty('completedWork');
    expect(Object.values(rowLabels).every(label => !/[А-Яа-я]/.test(label))).toBe(true);
  });
});
