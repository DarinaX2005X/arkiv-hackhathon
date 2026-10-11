import { key } from '@arkiv-network/sdk/attr';
import { eq } from '@arkiv-network/sdk/query';
import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { activeSource, deriveReadiness, sameSource } from '../../domain/readiness';
import { EVENTS_PROTOCOL, audienceHash, deriveEventAvailability } from '../../domain/events';
import type { AttendanceState, EventAggregate, EventPayload, EventRecord, EventRelease, EventScope, EventState } from '../../domain/events';
import type { AccountAddress, EntityKey, ProjectAggregate, SourcePlanRef } from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { CommandBase, MutationResult, OperationIntent, OperationKind, OperationPhase, ReconciliationResult } from '../types';
import { allocateOperationStep, inspectReconciliationJournal } from '../operations';
import type { OperationController, StoredOperationStep } from '../operations';
import type { NativeBatch } from '../wallet';
import { ArkivRepositoryError, assertArkiv, repositoryError } from '../arkiv/errors';
import { creatorOf, publicAddress, publicKey, sameIdentity } from '../arkiv/envelope';
import type { ReadContext } from '../arkiv/reader';
import { verifyNativeOperationStep } from '../arkiv/verification';
import type { VerifiedStep } from '../arkiv/verification';
import { EVENTS_NAMESPACE, EVENT_VERIFICATION_CODEC, eventPayload, nativeEventCreate } from './envelope';
import type { EventReader } from './reader';
import type { PublishEventCommand, ReplaceAttendanceCommand, ReplaceEventCommand } from './types';

type Verified = VerifiedStep<EventRecord>;
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const clone = <T>(input: T): T => JSON.parse(canonicalJson(input)) as T;
const orderedKeys = (keys: EntityKey[]) => canonicalJson(keys.map(publicKey).sort());
const RETENTION_MS = 30 * 86_400_000;

/** Creates immutable terms separately, then consumes exactly the reviewed current state in one native batch. */
export class EventWriter {
  constructor(readonly reader: EventReader, readonly controller?: OperationController, readonly receiptTimeoutMs = 45_000) {}
  private connected(): OperationController {
    assertArkiv(this.controller, 'not_connected', 'invalid_identity', 'Connect a Tiramisu wallet to publish this decision.'); return this.controller;
  }
  private account(operation: OperationIntent): AccountAddress {
    assertArkiv(operation.authority.mode === 'public' && operation.authority.chainId === TIRAMISU_CHAIN_ID,
      'unauthorized', 'invalid_identity', 'This operation requires a public Tiramisu wallet.');
    return publicAddress(operation.authority.actor.address);
  }
  private begin<T extends CommandBase>(input: T, kind: OperationKind): T {
    const command = clone(input); const { operation, ...fields } = command; const controller = this.connected();
    this.account(operation);
    assertArkiv(operation.kind === kind && operation.inputHash === hashCanonical(fields) && operation.inputHash === hashCanonical(operation.input),
      'invalid_input', 'hash_mismatch', 'The event command differs from its frozen operation.');
    assertArkiv(Number.isSafeInteger(command.lifetimeSeconds) && command.lifetimeSeconds > 0 && command.lifetimeSeconds % 2 === 0
      && command.lifetimeSeconds <= 10 * 366 * 86_400, 'invalid_input', 'invalid_input', 'Choose an explicit, bounded even number of seconds for retention.');
    const saved = controller.getOperation(operation.id);
    assertArkiv(saved || (!operation.transactionHash && operation.confirmedKeys.length === 0
      && operation.steps.every(step => step.status === 'prepared' || step.status === 'failed-before-send')),
    'unverified', 'evidence_unavailable', 'The original send evidence is missing. Restore its journal before creating another operation.');
    if (saved) {
      assertArkiv(saved.kind === operation.kind && saved.inputHash === operation.inputHash && equal(saved.authority, operation.authority),
        'conflict', 'hash_mismatch', 'This operation ID belongs to another event command.'); command.operation = saved;
    }
    return command;
  }
  private async finish(context: ReadContext) {
    const snapshot = await this.reader.core.finish(context);
    assertArkiv(snapshot.completeness === 'complete' && snapshot.freshness === 'fresh', 'unverified', 'incomplete_snapshot', 'A complete, fresh read is required before signing.');
  }
  private expected<T extends EventState | AttendanceState>(scope: EventScope<T>, expected: EntityKey[]): EventRecord<T> | null {
    assertArkiv(scope.status !== 'conflict' && scope.status !== 'unverified', 'conflict', 'conflicting_heads', 'The current records are ambiguous. No last-write-wins transition is allowed.');
    const actual = scope.status === 'unique' ? [scope.entity.key] : [];
    assertArkiv(new Set(expected.map(publicKey)).size === expected.length && orderedKeys(actual) === orderedKeys(expected),
      'stale_heads', 'conflicting_heads', 'The current record differs from the reviewed predecessor. Refresh before preparing another decision.');
    return scope.status === 'unique' ? scope.entity : null;
  }
  private owned(event: EventAggregate, operation: OperationIntent) {
    assertArkiv(event.root && sameIdentity(creatorOf(event.root), this.account(operation)), 'unauthorized', 'foreign_author', 'Only this project coordinator can publish its event.');
  }
  private async initialPublication(context: ReadContext, projectRoot: EntityKey, operation: OperationIntent,
    confirmedRelease?: EventRecord<EventRelease>): Promise<void> {
    // A missing head is not proof that the event has never been published. Do not reset
    // visible lineage or a terminal outcome by treating its surviving release as a new event.
    const releases = await this.reader.core.query(context, [eq('project', EVENTS_NAMESPACE), eq('entity_type', 'event_release'),
      eq('project_key', key(publicKey(projectRoot)))], this.account(operation));
    if (!confirmedRelease) {
      assertArkiv(releases.length === 0, 'unverified', 'missing_state',
        'Earlier event releases remain but the current state is unavailable. Recover the original publication instead of resetting its history.');
      return;
    }
    const original = this.connected().getOperation(operation.id);
    const releaseStep = original?.steps.find(step => step.phase === 'proposal_pending' && step.status === 'confirmed');
    const stored = releaseStep && this.connected().getStep(operation.id, releaseStep.id);
    assertArkiv(original?.kind === 'publish_event' && original.inputHash === operation.inputHash
      && stored?.step.status === 'confirmed' && stored.receipt?.entityKeys.includes(confirmedRelease.key)
      && stored.batch.creates?.length === 1 && stored.batch.creates[0]!.payloadJson === canonicalJson(confirmedRelease.payload)
      && releases.length === 1 && sameIdentity(releases[0]!.key, confirmedRelease.key),
    'unverified', 'missing_state', 'Only the original verified release and its saved publication can initialize this missing current state.');
  }
  private ready(project: ProjectAggregate | null, source: SourcePlanRef) {
    const current = project && activeSource(project);
    assertArkiv(project && current && sameSource(current, source) && deriveReadiness(project, this.reader.core.now()).status === 'ready',
      'stale_heads', 'activation_mismatch', 'The event can open only with the exact current plan and fresh agreement from every required contributor.');
  }
  private retention(lifetimeSeconds: number, endsAt: number, now: number) {
    assertArkiv(lifetimeSeconds * 1_000 >= endsAt + RETENTION_MS - now, 'invalid_input', 'expired',
      'The nominal record lifetime must cover the event and 30 days for returning participants. Block time is not a wall-clock guarantee.');
  }
  private base(operation: OperationIntent, stepId: string) {
    return { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, operationId: stepId, createdAt: operation.createdAt };
  }
  private async progress(operation: OperationIntent, phase: OperationPhase) {
    const current = this.connected().getOperation(operation.id) ?? operation; current.phase = phase;
    await this.connected().updateOperation(current); Object.assign(operation, current);
  }
  private async verify(record: StoredOperationStep, wait = false): Promise<Verified> {
    let result: Verified | null;
    try { result = await verifyNativeOperationStep(this.reader.core, record, EVENT_VERIFICATION_CODEC, wait ? { waitMs: this.receiptTimeoutMs } : {}); }
    catch (cause) { throw new ArkivRepositoryError('unverified', 'evidence_unavailable', 'The original event transaction needs reconciliation before another send.', true, repositoryError(cause).reasons); }
    assertArkiv(result, 'unverified', 'evidence_unavailable', 'The original event transaction is still unresolved.');
    if (result.reverted) {
      await this.connected().markReverted(record.operation.id, record.step.id, result.receipt);
      throw new ArkivRepositoryError('reverted', 'evidence_unavailable', 'This transaction reverted. Earlier confirmed publication steps remain recorded.');
    }
    if (record.step.status !== 'confirmed') await this.connected().markConfirmed(record.operation.id, record.step.id, result.receipt);
    return result;
  }
  private async step(operation: OperationIntent, phase: OperationPhase, build: (stepId: string) => NativeBatch,
    preflight: () => Promise<void>, expectedHeads: EntityKey[] = []): Promise<Verified> {
    const controller = this.connected(); const latest = controller.getOperation(operation.id) ?? operation; Object.assign(operation, latest);
    const previous = latest.steps.filter(step => step.phase === phase);
    assertArkiv(previous.slice(0, -1).every(step => step.status === 'reverted'), 'conflict', 'conflicting_heads', 'Several attempts exist without an authenticated revert.');
    let step = previous.at(-1); let record = step && controller.getStep(operation.id, step.id);
    if (record?.step.status === 'reverted') {
      assertArkiv(operation.kind === 'publish_event' && latest.steps.some(item => item.status === 'confirmed'), 'reverted', 'evidence_unavailable', 'Prepare a corrected operation after the verified revert.');
      const verified = await verifyNativeOperationStep(this.reader.core, record, EVENT_VERIFICATION_CODEC);
      assertArkiv(verified?.reverted, 'unverified', 'evidence_unavailable', 'The earlier revert could not be independently verified.'); step = undefined; record = undefined;
    }
    if (record?.admission && record.step.status !== 'failed-before-send') return this.verify(record, record.step.status !== 'confirmed');
    await preflight();
    if (!step) { step = allocateOperationStep(operation, phase, { inputHash: operation.inputHash, phase }, expectedHeads); operation.steps.push(step); }
    const batch = build(step.id); step.inputHash = hashCanonical(batch); operation.phase = phase;
    await controller.beforeNativeAttempt(operation.id, step);
    await controller.prepareStep({ operation, step, batch });
    await preflight(); // Provider preparation can take time: gate every actual submission again.
    record = await controller.submitStep(operation.id, step.id); return this.verify(record, true);
  }
  private created<T extends EventPayload>(verified: Verified, type: T['entityType']): EventRecord<T> {
    const records = verified.records.filter(record => record.payload.entityType === type);
    assertArkiv(records.length === 1, 'unverified', 'evidence_unavailable', 'The expected event record was not verified.'); return records[0] as EventRecord<T>;
  }
  private result<T>(value: T, verified: Verified, operation: OperationIntent): MutationResult<T> {
    return { value, receipt: verified.receipt, operation: this.connected().getOperation(operation.id) ?? operation };
  }
  async publishEvent(input: PublishEventCommand): Promise<MutationResult<EventAggregate>> {
    return this.connected().withOperationAttempt(input.operation, () => this.publishEventAttempt(input));
  }
  private async publishEventAttempt(input: PublishEventCommand): Promise<MutationResult<EventAggregate>> {
    const command = this.begin(input, 'publish_event'); const { operation } = command;
    let predecessorReleaseKey: EntityKey | null = null;
    // Validate all material fields before wallet preparation, including a provisional release envelope.
    eventPayload({ ...this.base(operation, operation.id), entityType: 'event_release', projectRoot: command.projectRoot,
      predecessorReleaseKey, terms: command.terms, audienceHash: audienceHash(command.terms), source: command.source });
    const publicationPreflight = async () => {
      const context = await this.reader.core.context(); const event = await this.reader.event(context, command.projectRoot, 'required'); this.owned(event, operation);
      const previous = this.expected(event.state, command.expectedHeads);
      if (!previous) await this.initialPublication(context, command.projectRoot, operation);
      assertArkiv(!previous || !['cancelled', 'ended'].includes(previous.payload.status), 'invalid_input', 'closed_project', 'A cancelled or ended event cannot silently reopen.');
      predecessorReleaseKey = previous?.payload.releaseKey ?? null;
      this.ready(event.sourceProject, command.source);
      assertArkiv(command.terms.endsAt > context.snapshot.blockTimestamp, 'invalid_input', 'expired', 'An event that has ended cannot open for participation.');
      this.retention(command.lifetimeSeconds, command.terms.endsAt, context.snapshot.blockTimestamp); await this.finish(context);
    };
    const releaseResult = await this.step(operation, 'proposal_pending', id => ({ creates: [nativeEventCreate({ ...this.base(operation, id),
      entityType: 'event_release', projectRoot: command.projectRoot, predecessorReleaseKey, terms: command.terms,
      audienceHash: audienceHash(command.terms), source: command.source }, command.lifetimeSeconds)] }), publicationPreflight, command.expectedHeads);
    const release = this.created<EventRelease>(releaseResult, 'event_release'); await this.progress(operation, 'proposal_confirmed');
    const stateResult = await this.replaceStateStep({ operation, lifetimeSeconds: command.lifetimeSeconds, projectRoot: command.projectRoot,
      releaseKey: release.key, audienceHash: release.payload.audienceHash, source: command.source, status: 'open', expectedHeads: command.expectedHeads }, true);
    await this.progress(operation, 'complete');
    return this.result(await this.reader.loadEvent(command.projectRoot), stateResult, operation);
  }
  private async replaceStateStep(command: ReplaceEventCommand, newRelease: boolean): Promise<Verified> {
    let release: EventRecord<EventRelease> | null = null;
    return this.step(command.operation, 'activation_pending', id => {
      assertArkiv(release, 'unverified', 'missing_proposal', 'The reviewed release is unavailable.');
      const state: EventState = { ...this.base(command.operation, id), entityType: 'event_state', projectRoot: command.projectRoot,
        releaseKey: command.releaseKey, audienceHash: command.audienceHash, source: command.source, status: command.status,
        startsAt: release.payload.terms.startsAt, endsAt: release.payload.terms.endsAt, predecessorKeys: command.expectedHeads };
      return { creates: [nativeEventCreate(state, command.lifetimeSeconds)], deletes: command.expectedHeads.map(publicKey) };
    }, async () => {
      const context = await this.reader.core.context(); const event = await this.reader.event(context, command.projectRoot,
        command.status === 'open' ? 'required' : 'skip'); this.owned(event, command.operation);
      const previous = this.expected(event.state, command.expectedHeads);
      release = await this.reader.entity<EventRelease>(context, command.releaseKey, 'event_release', this.account(command.operation));
      assertArkiv(release && release.payload.projectRoot === command.projectRoot && release.payload.audienceHash === command.audienceHash,
        'invalid_input', 'projection_mismatch', 'The release, event and audience terms must match exactly.');
      if (!previous) await this.initialPublication(context, command.projectRoot, command.operation, release);
      assertArkiv(newRelease ? release.payload.predecessorReleaseKey === (previous?.payload.releaseKey ?? null)
        : previous && previous.payload.releaseKey === release.key, 'stale_heads', 'proposal_mismatch', 'Changing public terms requires publishing a new successor release.');
      if (previous && ['cancelled', 'ended'].includes(previous.payload.status)) {
        assertArkiv(command.status === previous.payload.status && !newRelease, 'invalid_input', 'closed_project', 'A cancelled or ended event is terminal.');
      }
      if (command.status === 'open') {
        this.ready(event.sourceProject, command.source);
        assertArkiv(release.payload.terms.endsAt > context.snapshot.blockTimestamp, 'invalid_input', 'expired', 'The event has already ended.');
      } else {
        assertArkiv(previous && sameSource(previous.payload.source, command.source), 'invalid_input', 'activation_mismatch', 'Closing the event must preserve its previously published source.');
        if (command.status === 'ended') assertArkiv(context.snapshot.blockTimestamp >= release.payload.terms.endsAt, 'invalid_input', 'invalid_input', 'The scheduled end has not arrived yet.');
      }
      this.retention(command.lifetimeSeconds, release.payload.terms.endsAt, context.snapshot.blockTimestamp); await this.finish(context);
    }, command.expectedHeads);
  }
  async replaceEvent(input: ReplaceEventCommand): Promise<MutationResult<EventRecord<EventState>>> {
    return this.connected().withOperationAttempt(input.operation, () => this.replaceEventAttempt(input));
  }
  private async replaceEventAttempt(input: ReplaceEventCommand): Promise<MutationResult<EventRecord<EventState>>> {
    const command = this.begin(input, 'replace_event'); const verified = await this.replaceStateStep(command, false);
    await this.progress(command.operation, 'complete'); return this.result(this.created<EventState>(verified, 'event_state'), verified, command.operation);
  }
  async replaceAttendance(input: ReplaceAttendanceCommand): Promise<MutationResult<EventRecord<AttendanceState>>> {
    return this.connected().withOperationAttempt(input.operation, () => this.replaceAttendanceAttempt(input));
  }
  private async replaceAttendanceAttempt(input: ReplaceAttendanceCommand): Promise<MutationResult<EventRecord<AttendanceState>>> {
    const command = this.begin(input, 'replace_attendance'); const account = this.account(command.operation);
    const verified = await this.step(command.operation, 'initial_state_pending', id => ({ creates: [nativeEventCreate({ ...this.base(command.operation, id),
      entityType: 'attendance_state', projectRoot: command.projectRoot, attendee: account, releaseKey: command.releaseKey,
      audienceHash: command.audienceHash, decision: command.decision, predecessorKeys: command.expectedHeads }, command.lifetimeSeconds)],
      deletes: command.expectedHeads.map(publicKey) }), async () => {
      const context = await this.reader.core.context();
      const attendance = await this.reader.scope<AttendanceState>(context, 'attendance_state', command.projectRoot, account);
      const previous = this.expected(attendance, command.expectedHeads);
      if (command.decision === 'going') {
        const event = await this.reader.event(context, command.projectRoot);
        assertArkiv(event.state.status === 'unique' && event.release && event.release.key === command.releaseKey
          && event.release.payload.audienceHash === command.audienceHash, 'stale_heads', 'proposal_mismatch', 'The event terms changed. Review the current release before confirming.');
        assertArkiv(deriveEventAvailability(event, this.reader.core.now()) === 'open', 'stale_heads', 'activation_mismatch', 'Registration is paused until the event has a fresh, agreed plan.');
        this.retention(command.lifetimeSeconds, event.release.payload.terms.endsAt, context.snapshot.blockTimestamp);
      } else {
        assertArkiv(previous && previous.payload.releaseKey === command.releaseKey && previous.payload.audienceHash === command.audienceHash,
          'invalid_input', 'proposal_mismatch', 'Withdrawal preserves the exact terms of your existing registration.');
      }
      await this.finish(context);
    }, command.expectedHeads);
    await this.progress(command.operation, 'complete'); return this.result(this.created<AttendanceState>(verified, 'attendance_state'), verified, command.operation);
  }
  async reconcile(input: OperationIntent): Promise<ReconciliationResult> {
    const controller = this.connected(); const saved = controller.getOperation(input.id); const operation = saved ?? clone(input);
    assertArkiv(['publish_event', 'replace_event', 'replace_attendance'].includes(input.kind) && equal(operation.authority, input.authority)
      && operation.inputHash === input.inputHash, 'conflict', 'hash_mismatch', 'The original event operation does not match this recovery request.');
    const journal = inspectReconciliationJournal(input, saved, controller.getStep, controller.getAttempt(input.id));
    if (!journal.complete) return { status: 'unverified', operation, error: { code: 'unverified', reasons: [{ code: 'evidence_unavailable' }], retryable: false,
      diagnostic: 'The original native operation journal is missing or incomplete. Retain the action and recover its evidence before another send.' } };
    let lastReceipt: Verified['receipt'] | null = null;
    for (const step of operation.steps) {
      const record = controller.getStep(operation.id, step.id); if (!record?.admission || record.step.status === 'failed-before-send') continue;
      try {
        const result = await verifyNativeOperationStep(this.reader.core, record, EVENT_VERIFICATION_CODEC);
        if (!result) return { status: 'pending', operation: controller.getOperation(operation.id) ?? operation };
        if (result.reverted) { if (record.step.status !== 'reverted') await controller.markReverted(operation.id, step.id, result.receipt); }
        else { if (record.step.status !== 'confirmed') await controller.markConfirmed(operation.id, step.id, result.receipt); lastReceipt = result.receipt; }
      } catch (error) { return { status: 'unverified', operation: controller.getOperation(operation.id) ?? operation, error: { ...repositoryError(error), code: 'unverified' } }; }
    }
    const latest = controller.getOperation(operation.id) ?? operation;
    const phases = new Map(latest.steps.map(step => [step.phase, step])); const reverted = [...phases.values()].find(step => step.status === 'reverted');
    if (reverted) {
      const receipt = controller.getStep(operation.id, reverted.id)?.receipt;
      assertArkiv(receipt, 'unverified', 'evidence_unavailable', 'The reverted step has no verified receipt.');
      const partial = latest.kind === 'publish_event' && latest.steps.some(step => step.status === 'confirmed');
      return { status: partial ? 'partial_reverted' : 'reverted', operation: latest, receipt,
        error: { code: 'reverted', reasons: [{ code: 'evidence_unavailable' }], retryable: partial } };
    }
    // A crash after final readback must not require a new send merely to set the completion checkpoint.
    const finalPhase = latest.kind === 'replace_attendance' ? 'initial_state_pending' : 'activation_pending';
    if (lastReceipt && phases.get(finalPhase)?.status === 'confirmed') {
      await this.progress(latest, 'complete'); return { status: 'confirmed', operation: latest, receipt: lastReceipt };
    }
    if (latest.steps.some(step => step.status === 'confirmed' || step.status === 'submitted' || step.status === 'unverified')) return { status: 'pending', operation: latest };
    return { status: 'not_sent', operation: latest, ...(journal.notSentEvidence ? { evidence: journal.notSentEvidence } : {}) };
  }
}
