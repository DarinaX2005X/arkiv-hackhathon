/** Reproducible synthetic export samples. No network, wallet, browser or renderer is used. */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeSmallWorksProject, makeSmallWorksFixture, localRecord, SMALL_WORKS_COORDINATOR } from '../../../domain/fixtures';
import { solve } from '../../../domain/solver';
import { finalizePlan } from '../../../domain/validation';
import { activeSource } from '../../../domain/readiness';
import { prepareDecision } from '../../../domain/operations';
import type { EntityKey } from '../../../domain/types';
import type { ReplaceBookCommand, WriteAuthority } from '../../../data/types';
import { prepareClosureCommand, prepareProgressCommand } from '../model';
import { buildExecutionExports, packetFromProject } from '../export';

const project = makeSmallWorksProject({ oak: true });
const now = project.snapshot.blockTimestamp;
const candidate = solve(makeSmallWorksFixture({ oak: true })).candidates[0]!;
const plan = candidate.plan, boards = plan.allocations.find(allocation => allocation.resourceId === 'boards')!;
const shared = { resourceId: boards.resourceId, quantity: boards.quantity, unit: boards.unit, allocationIds: [boards.id], dependsOn: [], instructions: 'Count the six synthetic boards together.' };
plan.runbook.push({ ...shared, kind: 'handover', id: 'handover-boards', transferId: 'send-boards', title: 'Hand over display boards', publisherRoot: 'local:makerspace', giver: 'local:makerspace', receiver: 'local:cedar', interval: { start: boards.interval.start, end: boards.interval.start + 60_000 } },
  { ...shared, kind: 'return', id: 'return-boards', transferId: 'return-boards', title: 'Return display boards', publisherRoot: 'local:cedar', giver: 'local:cedar', receiver: 'local:makerspace', interval: { start: boards.interval.end - 60_000, end: boards.interval.end } });
const finalized = finalizePlan(plan, project.publishers, project.snapshot);
if (!finalized.ok) throw new Error(JSON.stringify(finalized.reasons));
project.proposal = localRecord('local:export-example:proposal', { protocol: 'partfolk/1', schemaVersion: 1, entityType: 'proposal', operationId: 'sample-proposal', createdAt: now,
  projectRoot: project.root.key, plan: finalized.value.plan, proposalHash: finalized.value.proposalHash, requirementsHash: finalized.value.requirementsHash, changeExplanation: 'Synthetic export example: one outstanding return acknowledgement.' }, SMALL_WORKS_COORDINATOR);
project.activation = { status: 'unique', entity: localRecord('local:export-example:activation', { protocol: 'partfolk/1', schemaVersion: 1, entityType: 'plan_activation', operationId: 'sample-activation', createdAt: now,
  projectRoot: project.root.key, proposalKey: project.proposal.key, proposalHash: project.proposal.payload.proposalHash, predecessorActivationKeys: [] }, SMALL_WORKS_COORDINATOR) };
const authority = (root: EntityKey): WriteAuthority => {
  const actor = project.publishers.find(publisher => publisher.root.key === root)!.root.payload.publisher;
  if (actor.kind !== 'local') throw new Error('Synthetic local actor required.');
  return { mode: 'local', actor, chainId: null };
};
const apply = (command: ReplaceBookCommand) => {
  const publisher = project.publishers.find(item => item.root.key === command.publisherRoot)!;
  publisher.book = { status: 'unique', entity: localRecord(`local:sample-book:${command.operation.id}`, command.book, command.operation.authority.actor) };
};
for (const root of plan.requiredApprovers) {
  const owner = authority(root), prepared = prepareDecision(project, root, owner.actor, { status: 'accepted', operationId: `sample-accept-${root}`, now, validUntil: boards.interval.end + 60_000 });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
  const publisher = project.publishers.find(item => item.root.key === root)!;
  publisher.book = { status: 'unique', entity: localRecord(`local:sample-book:${root}`, prepared.value.book, owner.actor) };
}
for (const duty of plan.runbook.filter(duty => duty.kind === 'task')) apply(prepareProgressCommand(project, project.proposal, activeSource(project)!, duty.id, authority(duty.publisherRoot), { kind: 'task_report', status: 'done', note: 'Synthetic owner report for the example.' }, now, `sample-task-${duty.id}`));
apply(prepareProgressCommand(project, project.proposal, activeSource(project)!, 'handover-boards', authority('local:makerspace'), { kind: 'transfer_report', quantity: 6 }, now, 'sample-give'));
apply(prepareProgressCommand(project, project.proposal, activeSource(project)!, 'handover-boards', authority('local:cedar'), { kind: 'transfer_acknowledgement', reportId: 'report:sample-give', quantity: 6 }, now, 'sample-receive'));
apply(prepareProgressCommand(project, project.proposal, activeSource(project)!, 'return-boards', authority('local:cedar'), { kind: 'transfer_report', quantity: 6 }, now, 'sample-return'));
if (SMALL_WORKS_COORDINATOR.kind !== 'local') throw new Error('Local coordinator required.');
const closed = prepareClosureCommand(project, { mode: 'local', actor: SMALL_WORKS_COORDINATOR, chainId: null }, 'completed_with_outstanding', 'Synthetic example: all tasks were reported done; the equipment owner has not yet acknowledged the six returned boards.', now, 'sample-close');
project.state = { status: 'unique', entity: localRecord('local:sample-closed-state', closed.state, SMALL_WORKS_COORDINATOR) };
const selected = project.proposal.key;
project.proposalHistory = [project.proposal]; project.proposal = null; project.activation = { status: 'missing', reason: 'expired_or_deleted' };
const files = buildExecutionExports(packetFromProject(project, now), selected);
for (const [kind, file] of Object.entries(files)) await writeFile(fileURLToPath(new URL(`./completed-with-outstanding.${kind === 'json' ? 'json' : 'html'}`, import.meta.url)), file.text, 'utf8');
process.stdout.write('Wrote synthetic JSON and standalone HTML samples with one outstanding return acknowledgement.\n');
