import { ExpirationTime } from '@arkiv-network/sdk';
import { key } from '@arkiv-network/sdk/attr';
import { eq } from '@arkiv-network/sdk/query';
import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { activeSource, validateExactGrant } from '../../domain/readiness';
import { prepareAttestation, prepareCloseProject } from '../../domain/operations';
import { independentlyValidatePlan, validateBookCapacity, validateRecipe } from '../../domain/validation';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { AccountAddress, BookState, DomainReason, EntityKey, EntityPayload, EntityRecord, PlanActivation,
  ProjectAggregate, ProjectLink, ProjectRoot, ProjectState, Proposal, PublisherAggregate, PublisherRoot, SourcePlanRef } from '../../domain/types';
import type { ActivateProposalCommand, CommandBase, CreateProjectCommand, MutationResult, OperationIntent, OperationKind,
  OperationPhase, PublicationProgress, PublishPlanCommand, PublishProjectLinkCommand, PublishProposalCommand, ReconciliationResult,
  RegisterPublisherCommand, RenewEntityCommand, ReplaceBookCommand, ReplaceProjectCommand, ShareOfferCommand } from '../types';
import { allocateOperationStep } from '../operations';
import type { OperationController, StoredOperationStep } from '../operations';
import type { NativeBatch } from '../wallet';
import { ArkivRepositoryError, assertArkiv, repositoryError } from './errors';
import { creatorOf, decodeEntity, entityType, NAMESPACE, publicAddress, publicKey, sameIdentity, validatePayloadForNetwork } from './envelope';
import { ArkivReader } from './reader';
import type { ReadContext } from './reader';
import { createdRecord, nativeCreate, verifyOperationStep } from './verification';
import type { VerifiedStep } from './verification';

const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const set = (keys: EntityKey[]): string => canonicalJson(keys.map(publicKey).sort());
const DAY_SECONDS = 86_400;
function valid(reasons: DomainReason[], diagnostic: string): void {
  if (reasons.length) throw new ArkivRepositoryError('invalid_input', reasons[0]!.code, diagnostic, false, reasons);
}

/** Native writes are admitted through one journalled wallet port; success always requires independent readback. */
export class ArkivWriter {
  constructor(readonly reader: ArkivReader, readonly controller?: OperationController, readonly receiptTimeoutMs = 45_000) {}

  private connected(): OperationController {
    assertArkiv(this.controller, 'not_connected', 'invalid_identity', 'Connect a Tiramisu wallet before writing.');
    return this.controller;
  }
  private begin<T extends CommandBase>(input: T, kinds: OperationKind[]): T {
    const command = clone(input); const { operation, ...fields } = command;
    this.connected();
    assertArkiv(operation.authority.mode === 'public' && operation.authority.actor.kind === 'wallet', 'unauthorized', 'invalid_identity', 'This operation requires a public wallet authority.');
    assertArkiv(operation.authority.chainId === TIRAMISU_CHAIN_ID, 'wrong_chain', 'invalid_identity', 'This operation requires Arkiv Tiramisu.');
    publicAddress(operation.authority.actor.address);
    assertArkiv(kinds.includes(operation.kind) && operation.inputHash === hashCanonical(fields)
      && operation.inputHash === hashCanonical(operation.input), 'invalid_input', 'hash_mismatch', 'The command differs from its frozen operation intent.');
    assertArkiv(Number.isSafeInteger(command.lifetimeSeconds) && command.lifetimeSeconds > 0
      && command.lifetimeSeconds <= 10 * 366 * DAY_SECONDS, 'invalid_input', 'invalid_input', 'Choose an explicit positive entity lifetime.');
    const saved = this.controller!.getOperation(operation.id);
    assertArkiv(saved || (!operation.transactionHash && operation.confirmedKeys.length === 0
      && operation.steps.every(step => step.status === 'prepared' || step.status === 'failed-before-send')),
    'unverified', 'evidence_unavailable', 'This operation carries send evidence but its local verification journal is missing. Restore that journal or inspect the original transaction; do not create a replacement.');
    if (saved) {
      assertArkiv(saved.kind === operation.kind && saved.inputHash === operation.inputHash && equal(saved.authority, operation.authority),
        'conflict', 'hash_mismatch', 'This operation ID is already bound to different input.');
      command.operation = saved;
    }
    return command;
  }
  private account(operation: OperationIntent): AccountAddress {
    assertArkiv(operation.authority.mode === 'public', 'unauthorized', 'invalid_identity', 'A public authority is required.');
    return publicAddress(operation.authority.actor.address);
  }
  private owned(record: EntityRecord, operation: OperationIntent): void {
    assertArkiv(sameIdentity(creatorOf(record), this.account(operation)), 'unauthorized', 'foreign_author', 'Only the immutable root creator can publish this transition.');
  }
  private async finish(context: ReadContext): Promise<void> {
    const snapshot = await this.reader.finish(context);
    assertArkiv(snapshot.completeness === 'complete' && snapshot.freshness === 'fresh', 'unverified', 'incomplete_snapshot', 'A fresh, complete snapshot is required before sending.');
  }
  private async heads<T extends ProjectState | BookState | PlanActivation>(context: ReadContext, type: T['entityType'], root: EntityKey, owner: AccountAddress): Promise<EntityRecord<T>[]> {
    const rows = await this.reader.query(context, [eq('project', NAMESPACE), eq('entity_type', type),
      eq(type === 'book_state' ? 'book_key' : 'project_key', key(publicKey(root)))], owner);
    return rows.map(row => decodeEntity<T>(row, type, context.snapshot, owner));
  }
  private expected(actual: EntityRecord[], expected: EntityKey[]): void {
    assertArkiv(new Set(expected.map(publicKey)).size === expected.length && set(actual.map(record => record.key)) === set(expected),
      'stale_heads', 'conflicting_heads', 'The current authored heads differ from the reviewed predecessors. Refresh and prepare a new operation.');
  }
  private async progress(operation: OperationIntent, phase: OperationPhase, pendingPublisherRoots?: EntityKey[]): Promise<OperationIntent> {
    const current = this.connected().getOperation(operation.id) ?? operation;
    current.phase = phase;
    if (pendingPublisherRoots) current.pendingPublisherRoots = [...pendingPublisherRoots];
    await this.connected().updateOperation(current);
    Object.assign(operation, current);
    return current;
  }
  private payload<T extends EntityPayload>(payload: T, operation: OperationIntent, stepId: string): T {
    return validatePayloadForNetwork({ ...payload, operationId: stepId, createdAt: operation.createdAt }) as T;
  }
  private async verify(record: StoredOperationStep, wait = false): Promise<VerifiedStep> {
    let result: VerifiedStep | null;
    try { result = await verifyOperationStep(this.reader, record, wait ? { waitMs: this.receiptTimeoutMs } : {}); }
    catch (error) {
      const detail = repositoryError(error);
      throw new ArkivRepositoryError('unverified', 'evidence_unavailable', 'The admitted transaction could not be verified. Reconcile its original intent before another send.', true, detail.reasons);
    }
    assertArkiv(result, 'unverified', 'evidence_unavailable', 'The admitted operation is unresolved. Its original ID and transaction must be reconciled before sending again.');
    if (result.reverted) {
      await this.connected().markReverted(record.operation.id, record.step.id, result.receipt);
      throw new ArkivRepositoryError('reverted', 'evidence_unavailable', 'The transaction reverted. No entity changes were applied; prepare a new corrected operation.');
    }
    if (record.step.status !== 'confirmed') await this.connected().markConfirmed(record.operation.id, record.step.id, result.receipt);
    return result;
  }
  private async step(operation: OperationIntent, phase: OperationPhase, build: (stepId: string) => NativeBatch,
    preflight: () => Promise<void>, expectedHeads: EntityKey[] = [], publisherRoot?: EntityKey): Promise<VerifiedStep> {
    const controller = this.connected();
    const latest = controller.getOperation(operation.id) ?? operation;
    Object.assign(operation, latest);
    const existing = latest.steps.filter(item => item.phase === phase && item.publisherRoot === publisherRoot);
    assertArkiv(existing.length <= 1, 'conflict', 'conflicting_heads', 'This operation has ambiguous phase checkpoints.');
    let step = existing[0];
    let record = step ? controller.getStep(operation.id, step.id) : undefined;
    if (record?.step.status === 'reverted') throw new ArkivRepositoryError('reverted', 'evidence_unavailable', 'This operation reverted. Start a corrected operation instead of resending it.');
    if (record?.admission && record.step.status !== 'failed-before-send') return this.verify(record, record.step.status !== 'confirmed');
    await preflight();
    if (!step) {
      step = allocateOperationStep(operation, phase, { inputHash: operation.inputHash, phase, publisherRoot: publisherRoot ?? null }, expectedHeads, publisherRoot);
      operation.steps.push(step);
    }
    const batch = build(step.id);
    step.inputHash = hashCanonical(batch);
    operation.phase = phase;
    record = await controller.prepareStep({ operation, step, batch });
    // Wallet preparation can involve asynchronous provider work. Re-read the complete scoped heads before admission.
    await preflight();
    record = await controller.submitStep(operation.id, step.id);
    return this.verify(record, true);
  }
  private result<T>(value: T, verified: VerifiedStep, operation: OperationIntent): MutationResult<T> {
    return { value, receipt: verified.receipt, operation: this.connected().getOperation(operation.id) ?? operation };
  }
  private base(operation: OperationIntent) {
    return { protocol: PROTOCOL, schemaVersion: 1 as const, operationId: operation.id, createdAt: operation.createdAt };
  }

  async createProject(input: CreateProjectCommand): Promise<MutationResult<ProjectAggregate>> {
    const command = this.begin(input, ['create_project']); const operation = command.operation;
    valid(validateRecipe(command.recipe).reasons, 'The project recipe is invalid.');
    validatePayloadForNetwork({ ...this.base(operation), entityType: 'project_state', projectRoot: `0x${'00'.repeat(32)}`,
      predecessorKeys: [], recipe: command.recipe, publisherRoots: [], lifecycle: 'planning', completedWork: [], completion: null });
    let rootKey = command.rootKey;
    if (!rootKey) {
      const root: ProjectRoot = { ...this.base(operation), entityType: 'project_root', coordinator: operation.authority.actor };
      const verified = await this.step(operation, 'root_pending', id => ({ creates: [nativeCreate(this.payload(root, operation, id), command.lifetimeSeconds)] }),
        async () => { const context = await this.reader.context(); await this.finish(context); });
      rootKey = createdRecord<ProjectRoot>(verified, 'project_root').key;
      await this.progress(operation, 'root_confirmed');
    }
    const target = publicKey(rootKey);
    const state: ProjectState = { ...this.base(operation), entityType: 'project_state', projectRoot: target, predecessorKeys: [],
      recipe: command.recipe, publisherRoots: [], lifecycle: 'planning', completedWork: [], completion: null };
    const verified = await this.step(operation, 'initial_state_pending', id => ({ creates: [nativeCreate(this.payload(state, operation, id), command.lifetimeSeconds)] }), async () => {
      const context = await this.reader.context(); const root = await this.reader.entity<ProjectRoot>(context, target, 'project_root');
      assertArkiv(root, 'not_found', 'missing_root', 'The project root is unavailable.'); this.owned(root, operation);
      this.expected(await this.heads(context, 'project_state', target, creatorOf(root)), []); await this.finish(context);
    });
    await this.progress(operation, 'complete');
    return this.result(await this.reader.loadProject(target), verified, operation);
  }

  async registerPublisher(input: RegisterPublisherCommand): Promise<MutationResult<PublisherAggregate>> {
    const command = this.begin(input, ['register_publisher']); const operation = command.operation;
    // Validate initial book fields before charging for a root that could not be initialized.
    validatePayloadForNetwork({ ...this.base(operation), entityType: 'book_state', publisherRoot: `0x${'00'.repeat(32)}`,
      predecessorKeys: [], name: command.name, description: command.description, resources: [], offers: [], decisions: [],
      grants: [], attestations: [], custodyHolds: [], retentionDays: 90 });
    assertArkiv(command.lifetimeSeconds >= 90 * DAY_SECONDS, 'invalid_input', 'expired', 'The initial publisher book needs the declared 90-day nominal retention lifetime.');
    let rootKey = command.rootKey;
    if (!rootKey) {
      const root: PublisherRoot = { ...this.base(operation), entityType: 'publisher_root', publisher: operation.authority.actor, kind: command.kind };
      const verified = await this.step(operation, 'root_pending', id => ({ creates: [nativeCreate(this.payload(root, operation, id), command.lifetimeSeconds)] }),
        async () => { const context = await this.reader.context(); await this.finish(context); });
      rootKey = createdRecord<PublisherRoot>(verified, 'publisher_root').key; await this.progress(operation, 'root_confirmed');
    }
    const target = publicKey(rootKey);
    const book: BookState = { ...this.base(operation), entityType: 'book_state', publisherRoot: target, predecessorKeys: [],
      name: command.name, description: command.description, resources: [], offers: [], decisions: [], grants: [], attestations: [], custodyHolds: [], retentionDays: 90 };
    const verified = await this.step(operation, 'initial_state_pending', id => ({ creates: [nativeCreate(this.payload(book, operation, id), command.lifetimeSeconds)] }), async () => {
      const context = await this.reader.context(); const root = await this.reader.entity<PublisherRoot>(context, target, 'publisher_root');
      assertArkiv(root && root.payload.kind === command.kind, 'not_found', 'missing_root', 'The publisher root is unavailable or has a different kind.'); this.owned(root, operation);
      this.expected(await this.heads(context, 'book_state', target, creatorOf(root)), []); await this.finish(context);
    });
    await this.progress(operation, 'complete');
    return this.result(await this.reader.loadPublisher(target), verified, operation);
  }

  private async projectPreflight(command: ReplaceProjectCommand): Promise<void> {
    const context = await this.reader.context(); const root = await this.reader.entity<ProjectRoot>(context, command.projectRoot, 'project_root');
    assertArkiv(root, 'not_found', 'missing_root', 'The project root is unavailable.'); this.owned(root, command.operation);
    assertArkiv(command.state.projectRoot === command.projectRoot && set(command.state.predecessorKeys) === set(command.expectedHeads), 'invalid_input', 'projection_mismatch', 'The project state must identify every reviewed predecessor.');
    const heads = await this.heads<ProjectState>(context, 'project_state', command.projectRoot, creatorOf(root));
    this.expected(heads, command.expectedHeads);
    assertArkiv(heads.length > 0, 'not_found', 'missing_state', 'Initialize this project through its original create operation.');
    for (const previous of heads) {
      // A closed plan remains the predecessor anchor after an explicit reopening.
      if (previous.payload.lifecycle === 'closed' && command.state.lifecycle !== 'closed') {
        assertArkiv(equal(command.state.completion?.source ?? null, previous.payload.completion?.source ?? null), 'invalid_input', 'activation_mismatch', 'Reopening must retain the closed plan as its lineage anchor.');
      }
    }
    for (const publisherRoot of command.state.publisherRoots) await this.reader.publisher(context, publisherRoot);
    if (command.state.lifecycle === 'closed') {
      assertArkiv(command.expectedActivationHeads !== undefined && command.state.completion !== null,
        'invalid_input', 'missing_activation', 'Terminal closure requires every current activation head and a completion summary.');
      const activations = await this.heads<PlanActivation>(context, 'plan_activation', command.projectRoot, creatorOf(root));
      this.expected(activations, command.expectedActivationHeads);
      if (activations.length === 1) {
        const active = activations[0]!;
        assertArkiv(equal(command.state.completion.source, { projectRoot: command.projectRoot, activationKey: active.key,
          proposalKey: active.payload.proposalKey, proposalHash: active.payload.proposalHash }), 'invalid_input', 'activation_mismatch', 'Closure must identify the exact current agreement.');
      }
      if (heads.length === 1) {
        const project = await this.reader.project(context, command.projectRoot);
        const prepared = prepareCloseProject(project, command.operation.authority.actor, {
          outcome: command.state.completion.outcome, statement: command.state.completion.statement,
          operationId: command.operation.id, now: command.state.completion.recordedAt,
        });
        if (!prepared.ok) valid(prepared.reasons, 'The closure summary does not match verified participant evidence.');
        else assertArkiv(equal(prepared.value.state.completion, command.state.completion)
          && equal(prepared.value.state.completedWork, command.state.completedWork), 'invalid_input', 'attestation_mismatch', 'The closure summary must retain the verified completed and outstanding work.');
      } else assertArkiv(command.state.completion.outcome === 'cancelled', 'invalid_input', 'conflicting_heads', 'Resolve project-state conflicts before claiming completion.');
    }
    await this.finish(context);
  }
  async replaceProject(input: ReplaceProjectCommand): Promise<MutationResult<EntityRecord<ProjectState>>> {
    const command = this.begin(input, ['replace_project', 'close_project']);
    assertArkiv(command.operation.kind !== 'close_project' || command.state.lifecycle === 'closed', 'invalid_input', 'closed_project', 'A close operation must produce a terminal project state.');
    const deletes = [...command.expectedHeads, ...(command.state.lifecycle === 'closed' ? command.expectedActivationHeads ?? [] : [])].map(publicKey);
    const verified = await this.step(command.operation, 'initial_state_pending', id => ({ creates: [nativeCreate(this.payload(command.state, command.operation, id), command.lifetimeSeconds)], deletes }),
      () => this.projectPreflight(command), deletes);
    await this.progress(command.operation, 'complete');
    return this.result(createdRecord<ProjectState>(verified, 'project_state'), verified, command.operation);
  }

  private async bookPreflight(command: ReplaceBookCommand): Promise<void> {
    const context = await this.reader.context(); const publisher = await this.reader.publisher(context, command.publisherRoot);
    this.owned(publisher.root, command.operation);
    const heads = await this.heads<BookState>(context, 'book_state', command.publisherRoot, creatorOf(publisher.root));
    this.expected(heads, command.expectedHeads);
    const book = command.book;
    assertArkiv(book.publisherRoot === command.publisherRoot && set(book.predecessorKeys) === set(command.expectedHeads), 'invalid_input', 'projection_mismatch', 'The book must identify every reviewed predecessor.');
    if (!heads.length) {
      assertArkiv(command.recovery?.acknowledgedMissingState === true && command.recovery.redeclaredAvailability === true,
        'invalid_input', 'missing_state', 'An empty head scope requires explicit missing-state recovery under this owned root.');
      assertArkiv([book.resources, book.offers, book.decisions, book.grants, book.attestations, book.custodyHolds].every(items => items.length === 0),
        'invalid_input', 'evidence_unavailable', 'Recovery starts with an empty book. Re-declare availability before making new offers; cached approvals and custody history cannot be restored as authority.');
    } else {
      assertArkiv(command.recovery === undefined, 'invalid_input', 'conflicting_heads', 'Recovery is only available when the fresh authored scope is empty.');
      const candidate: PublisherAggregate = { ...publisher, book: { status: 'unique', entity: { ...heads[0]!, payload: book } } };
      valid(validateBookCapacity(candidate, book, context.snapshot.blockTimestamp).reasons, 'The book would exceed its resource capacity.');
      // Re-run domain admission for new participant assertions against current authentic books.
      // The generated custody changes distinguish a partial return from an arbitrary quantity edit.
      const oldAttestations = heads.flatMap(record => record.payload.attestations);
      let assertedBook = clone(heads[0]!.payload);
      assertedBook.attestations = [...new Map(oldAttestations.map(item => [item.id, item])).values()];
      assertedBook.custodyHolds = [...new Map(heads.flatMap(record => record.payload.custodyHolds).map(item => [item.id, item])).values()];
      const newAttestations = book.attestations.filter(item => !oldAttestations.some(old => old.id === item.id));
      for (const attestation of newAttestations) {
        const project = await this.reader.project(context, attestation.projectRoot);
        const own: PublisherAggregate = { ...publisher, book: { status: 'unique', entity: { ...heads[0]!, payload: assertedBook } } };
        project.publishers = [...project.publishers.filter(item => item.root.key !== command.publisherRoot), own];
        if (attestation.kind !== 'task_report') for (const party of [attestation.giver, attestation.receiver]) {
          if (!project.publishers.some(item => item.root.key === party)) project.publishers.push(await this.reader.publisher(context, party));
        }
        const prepared = prepareAttestation(project, command.publisherRoot, command.operation.authority.actor, attestation);
        if (!prepared.ok) valid(prepared.reasons, 'The new assertion does not match the named plan obligation and participant authority.');
        else assertedBook = prepared.value.book;
      }
      const preserveAfter = context.snapshot.blockTimestamp - book.retentionDays * DAY_SECONDS * 1_000;
      for (const previous of heads) {
        for (const attestation of previous.payload.attestations) {
          const next = book.attestations.find(item => item.id === attestation.id);
          assertArkiv(!next || equal(next, attestation), 'invalid_input', 'attestation_mismatch', 'An existing assertion cannot be rewritten under its original ID. Publish an explicit correction.');
        }
        for (const attestation of previous.payload.attestations.filter(item => item.recordedAt >= preserveAfter)) {
          assertArkiv(book.attestations.some(item => item.id === attestation.id && equal(item, attestation)), 'invalid_input', 'evidence_unavailable', 'Recent attestations are append-only. Add a correction instead of removing or rewriting one.');
        }
        for (const hold of previous.payload.custodyHolds.filter(item => item.status === 'outstanding')) {
          const next = book.custodyHolds.find(item => item.id === hold.id);
          const { status: _status, release: _release, quantity: _quantity, ...assertion } = hold;
          const { status: _nextStatus, release: _nextRelease, quantity: _nextQuantity, ...nextAssertion } = next ?? {};
          assertArkiv(next && equal(nextAssertion, assertion),
            'invalid_input', 'custody_outstanding', 'An outstanding custody hold cannot disappear or change its physical resource assertion.');
          if (next.quantity !== hold.quantity || next.release?.acknowledgementId) assertArkiv(equal(next, assertedBook.custodyHolds.find(item => item.id === hold.id) ?? null),
            'invalid_input', 'custody_outstanding', 'A changed outstanding quantity needs the corresponding verified return or correction assertions.');
          assertArkiv(next.status === 'outstanding' || (next.release && next.release.reason.trim().length > 0),
            'invalid_input', 'custody_outstanding', 'Releasing custody requires an explicit owner statement.');
        }
      }
      for (const hold of book.custodyHolds.filter(item => !heads.some(record => record.payload.custodyHolds.some(old => old.id === item.id)))) {
        assertArkiv(equal(hold, assertedBook.custodyHolds.find(item => item.id === hold.id) ?? null), 'invalid_input', 'attestation_mismatch', 'A new custody hold must follow its verified owner handover report.');
      }
      const oldGrants = heads.flatMap(record => record.payload.grants);
      for (const old of oldGrants.filter(item => item.validUntil > context.snapshot.blockTimestamp)) {
        if (book.grants.some(item => equal(item, old))) continue;
        const replacement = book.grants.some(item => item.projectRoot === old.projectRoot && !oldGrants.some(previous => equal(previous, item)));
        const release = book.decisions.some(item => item.projectRoot === old.projectRoot && item.activationKey === old.activationKey
          && item.proposalKey === old.proposalKey && item.proposalHash === old.proposalHash && (item.status === 'withdrawn' || item.status === 'declined'));
        assertArkiv(replacement || release, 'invalid_input', 'missing_decision', 'Removing a live reservation requires its durable withdrawal decision or an exact validated replacement agreement.');
      }
      const oldDecisions = heads.flatMap(record => record.payload.decisions);
      for (const decision of book.decisions.filter(item => item.status === 'accepted' && !oldDecisions.some(old => equal(old, item)))) {
        assertArkiv(book.grants.some(grant => grant.projectRoot === decision.projectRoot && grant.activationKey === decision.activationKey
          && grant.proposalKey === decision.proposalKey && grant.proposalHash === decision.proposalHash), 'invalid_input', 'missing_grant', 'A new accepted decision must be recorded atomically with its exact grant.');
      }
      for (const grant of book.grants.filter(grant => !oldGrants.some(old => equal(old, grant)))) {
        const project = await this.reader.project(context, grant.projectRoot); const source = activeSource(project);
        assertArkiv(project.state.status === 'unique' && project.state.entity.payload.lifecycle !== 'closed' && source && project.proposal,
          'invalid_input', 'missing_activation', 'A fresh approval needs one current active proposal.');
        assertArkiv(project.state.entity.payload.publisherRoots.includes(command.publisherRoot)
          && project.proposal.payload.plan.requiredApprovers.includes(command.publisherRoot), 'unauthorized', 'scope_mismatch', 'This publisher is not an admitted required approver.');
        valid(validateExactGrant(grant, project.proposal.payload.plan, source, command.publisherRoot, context.snapshot.blockTimestamp), 'The grant does not match the exact current proposal and activation.');
        const decision = book.decisions.filter(item => item.projectRoot === grant.projectRoot && item.activationKey === grant.activationKey);
        assertArkiv(decision.length === 1 && decision[0]!.status === 'accepted', 'invalid_input', 'missing_decision', 'Every new grant needs its matching accepted decision.');
        valid(independentlyValidatePlan(project.proposal.payload.plan,
          project.publishers.map(item => item.root.key === command.publisherRoot ? candidate : item), context.snapshot.blockTimestamp).reasons,
        'The accepted plan is no longer feasible against current books.');
      }
    }
    if (publisher.root.payload.kind === 'individual') assertArkiv(book.resources.filter(resource => resource.kind === 'person').every(resource => resource.id === 'self' && resource.capacity === 1),
      'invalid_input', 'capacity_exceeded', 'Individual time uses one shared self resource of capacity one.');
    const retentionEnd = Math.max(context.snapshot.blockTimestamp + book.retentionDays * DAY_SECONDS * 1_000,
      ...book.grants.map(grant => grant.validUntil + 60_000));
    assertArkiv(command.lifetimeSeconds * 1_000 >= retentionEnd - context.snapshot.blockTimestamp,
      'invalid_input', 'expired', 'The nominal book lifetime must cover its consent horizon and evidence-retention margin. This is not a UTC liveness guarantee.');
    await this.finish(context);
  }
  private async replaceBookStep(command: ReplaceBookCommand): Promise<VerifiedStep> {
    return this.step(command.operation, 'book_pending', id => ({ creates: [nativeCreate(this.payload(command.book, command.operation, id), command.lifetimeSeconds)], deletes: command.expectedHeads.map(publicKey) }),
      () => this.bookPreflight(command), command.expectedHeads, command.publisherRoot);
  }
  async replaceBook(input: ReplaceBookCommand): Promise<MutationResult<EntityRecord<BookState>>> {
    const command = this.begin(input, ['replace_book']); const verified = await this.replaceBookStep(command);
    await this.progress(command.operation, 'complete'); return this.result(createdRecord<BookState>(verified, 'book_state'), verified, command.operation);
  }

  private predecessor(project: ProjectAggregate): SourcePlanRef | null {
    assertArkiv(project.activation.status !== 'conflict' && project.activation.status !== 'unverified', 'conflict', 'conflicting_heads', 'Resolve activation conflicts before publishing a successor.');
    return activeSource(project) ?? (project.state.status === 'unique' ? project.state.entity.payload.completion?.source ?? null : null);
  }
  private async proposalPreflight(operation: OperationIntent, projectRoot: EntityKey, proposal: Proposal): Promise<void> {
    const context = await this.reader.context(); const project = await this.reader.project(context, projectRoot);
    this.owned(project.root, operation);
    assertArkiv(project.state.status === 'unique' && project.state.entity.payload.lifecycle !== 'closed', 'invalid_input', 'closed_project', 'Reopen the project before proposing another plan.');
    assertArkiv(proposal.projectRoot === projectRoot && equal(proposal.plan.predecessor, this.predecessor(project)),
      'stale_heads', 'activation_mismatch', 'A new proposal must name the current exact agreement as its predecessor. Restoring old terms requires a new proposal.');
    assertArkiv(proposal.plan.requiredApprovers.every(root => project.state.status === 'unique' && project.state.entity.payload.publisherRoots.includes(root)),
      'invalid_input', 'missing_root', 'Admit every required publisher before proposing this plan.');
    valid(independentlyValidatePlan(proposal.plan, project.publishers, context.snapshot.blockTimestamp).reasons, 'The proposal is not feasible against current authored books.');
    await this.finish(context);
  }
  private async proposalStep(command: PublishProposalCommand): Promise<VerifiedStep> {
    return this.step(command.operation, 'proposal_pending', id => ({ creates: [nativeCreate(this.payload(command.proposal, command.operation, id), command.lifetimeSeconds)] }),
      () => this.proposalPreflight(command.operation, command.projectRoot, command.proposal));
  }
  async publishProposal(input: PublishProposalCommand): Promise<MutationResult<EntityRecord<Proposal>>> {
    const command = this.begin(input, ['publish_proposal']); const verified = await this.proposalStep(command);
    await this.progress(command.operation, 'complete'); return this.result(createdRecord<Proposal>(verified, 'proposal'), verified, command.operation);
  }
  private async activationStep(command: ActivateProposalCommand): Promise<VerifiedStep> {
    const activation: PlanActivation = { ...this.base(command.operation), entityType: 'plan_activation', projectRoot: command.projectRoot,
      proposalKey: command.proposalKey, proposalHash: command.proposalHash, predecessorActivationKeys: command.expectedActivationHeads };
    return this.step(command.operation, 'activation_pending', id => ({ creates: [nativeCreate(this.payload(activation, command.operation, id), command.lifetimeSeconds)], deletes: command.expectedActivationHeads.map(publicKey) }), async () => {
      const context = await this.reader.context(); const project = await this.reader.project(context, command.projectRoot);
      this.owned(project.root, command.operation);
      assertArkiv(project.state.status === 'unique' && project.state.entity.payload.lifecycle !== 'closed', 'invalid_input', 'closed_project', 'A closed project cannot activate a plan.');
      this.expected(await this.heads(context, 'plan_activation', command.projectRoot, creatorOf(project.root)), command.expectedActivationHeads);
      const proposal = await this.reader.entity<Proposal>(context, command.proposalKey, 'proposal', creatorOf(project.root));
      assertArkiv(proposal && proposal.payload.projectRoot === command.projectRoot && sameIdentity(proposal.payload.proposalHash, command.proposalHash),
        'invalid_input', 'proposal_mismatch', 'This proposal is unavailable or does not match the requested project and hash.');
      assertArkiv(equal(proposal.payload.plan.predecessor, this.predecessor(project)), 'stale_heads', 'activation_mismatch', 'The proposal no longer descends from the current activation. Publish a new revision.');
      assertArkiv(proposal.payload.plan.requiredApprovers.every(root => project.state.status === 'unique' && project.state.entity.payload.publisherRoots.includes(root)), 'invalid_input', 'missing_root', 'A required approver is no longer admitted.');
      valid(independentlyValidatePlan(proposal.payload.plan, project.publishers, context.snapshot.blockTimestamp).reasons, 'The proposal is no longer feasible.');
      await this.finish(context);
    }, command.expectedActivationHeads);
  }
  async activateProposal(input: ActivateProposalCommand): Promise<MutationResult<EntityRecord<PlanActivation>>> {
    const command = this.begin(input, ['activate_proposal']); const verified = await this.activationStep(command);
    await this.progress(command.operation, 'complete'); return this.result(createdRecord<PlanActivation>(verified, 'plan_activation'), verified, command.operation);
  }

  private async linkStep(command: PublishProjectLinkCommand, fanout = false): Promise<VerifiedStep> {
    const link = command.link;
    return this.step(command.operation, fanout ? 'fanout_pending' : 'link_pending', id => ({ creates: [nativeCreate(this.payload(link, command.operation, id), command.lifetimeSeconds)] }), async () => {
      const context = await this.reader.context(); const project = await this.reader.project(context, link.projectRoot);
      const publisher = await this.reader.publisher(context, link.publisherRoot);
      if (link.linkKind === 'offer') {
        this.owned(publisher.root, command.operation);
        assertArkiv(publisher.book.status === 'unique' && link.offerIds.every(id => publisher.book.status === 'unique' && publisher.book.entity.payload.offers.some(offer => offer.id === id)),
          'invalid_input', 'missing_offer', 'Every shared offer must exist in the current owned book.');
      } else {
        this.owned(project.root, command.operation); const source = activeSource(project);
        assertArkiv(source && project.proposal && equal(source, { projectRoot: link.projectRoot, activationKey: link.activationKey,
          proposalKey: link.proposalKey, proposalHash: link.proposalHash }) && project.proposal.payload.plan.requiredApprovers.includes(link.publisherRoot),
          'stale_heads', 'activation_mismatch', 'The request must reference the current exact agreement and one required approver.');
      }
      await this.finish(context);
    }, [], link.publisherRoot);
  }
  async publishProjectLink(input: PublishProjectLinkCommand): Promise<MutationResult<EntityRecord<ProjectLink>>> {
    const command = this.begin(input, ['publish_project_link']); const verified = await this.linkStep(command);
    await this.progress(command.operation, 'complete'); return this.result(createdRecord<ProjectLink>(verified, 'project_link'), verified, command.operation);
  }
  async publishPlan(input: PublishPlanCommand): Promise<PublicationProgress> {
    const command = this.begin(input, ['publish_plan']); const operation = command.operation;
    assertArkiv(set(command.requestPublisherRoots) === set(command.proposal.plan.requiredApprovers), 'invalid_input', 'missing_root', 'Request fan-out must include every exact required approver.');
    const proposalResult = await this.proposalStep(command); const proposal = createdRecord<Proposal>(proposalResult, 'proposal');
    await this.progress(operation, 'proposal_confirmed', command.requestPublisherRoots);
    const activationResult = await this.activationStep({ ...command, proposalKey: proposal.key, proposalHash: proposal.payload.proposalHash });
    const activation = createdRecord<PlanActivation>(activationResult, 'plan_activation');
    await this.progress(operation, 'activation_confirmed', command.requestPublisherRoots);
    const publishedRequestKeys: EntityKey[] = [];
    for (let index = 0; index < command.requestPublisherRoots.length; index++) {
      const publisherRoot = command.requestPublisherRoots[index]!;
      const link: ProjectLink = { ...this.base(operation), entityType: 'project_link', linkKind: 'request', projectRoot: command.projectRoot,
        publisherRoot, activationKey: activation.key, proposalKey: proposal.key, proposalHash: proposal.payload.proposalHash };
      const verified = await this.linkStep({ operation, lifetimeSeconds: command.lifetimeSeconds, link }, true);
      publishedRequestKeys.push(createdRecord<ProjectLink>(verified, 'project_link').key);
      await this.progress(operation, 'fanout_pending', command.requestPublisherRoots.slice(index + 1));
    }
    await this.progress(operation, 'complete', []);
    return { operation, proposalKey: proposal.key, activationKey: activation.key, publishedRequestKeys, pendingPublisherRoots: [] };
  }
  async shareOffer(input: ShareOfferCommand): Promise<MutationResult<EntityRecord<ProjectLink>>> {
    const command = this.begin(input, ['share_offer']); const operation = command.operation;
    await this.replaceBookStep({ operation, lifetimeSeconds: command.lifetimeSeconds, publisherRoot: command.publisherRoot,
      expectedHeads: command.expectedBookHeads, book: command.book });
    await this.progress(operation, 'book_confirmed');
    const link: ProjectLink = { ...this.base(operation), entityType: 'project_link', linkKind: 'offer', projectRoot: command.projectRoot,
      publisherRoot: command.publisherRoot, offerIds: command.offerIds };
    const verified = await this.linkStep({ operation, lifetimeSeconds: command.lifetimeSeconds, link });
    await this.progress(operation, 'complete'); return this.result(createdRecord<ProjectLink>(verified, 'project_link'), verified, operation);
  }

  async renewEntity(input: RenewEntityCommand): Promise<MutationResult<EntityRecord>> {
    const command = this.begin(input, ['renew_entity']);
    assertArkiv(Number.isSafeInteger(command.extendBySeconds) && command.extendBySeconds > 0 && command.extendBySeconds <= 10 * 366 * DAY_SECONDS,
      'invalid_input', 'invalid_input', 'The extension must be a positive bounded whole number of seconds.');
    let expiresAtBlock: `${bigint}` | undefined;
    const saved = this.connected().getOperation(command.operation.id)?.steps.find(step => step.phase === 'initial_state_pending');
    if (saved) expiresAtBlock = this.connected().getStep(command.operation.id, saved.id)?.batch.extensions?.[0]?.expiresAtBlock;
    const verified = await this.step(command.operation, 'initial_state_pending', () => {
      assertArkiv(expiresAtBlock, 'invalid_input', 'invalid_input', 'The absolute renewal target is missing.');
      return { extensions: [{ entityKey: publicKey(command.entityKey), expiresAtBlock }] };
    }, async () => {
      const context = await this.reader.context(); const rows = await this.reader.query(context, [eq('$key', key(publicKey(command.entityKey)))], undefined, true);
      assertArkiv(rows.length === 1, 'not_found', 'expired', 'Expired or unavailable entities cannot be extended.');
      const type = entityType(rows[0]!.attributes?.entity_type?.value);
      const entity = decodeEntity(rows[0]!, type, context.snapshot, this.account(command.operation), publicKey(command.entityKey));
      if (!expiresAtBlock) expiresAtBlock = (BigInt(entity.provenance.expiresAtBlock!) + ExpirationTime.fromSeconds(command.extendBySeconds).minLifetime).toString() as `${bigint}`;
      assertArkiv(BigInt(expiresAtBlock) > BigInt(entity.provenance.expiresAtBlock!), 'stale_heads', 'expired', 'The reviewed renewal target is already reached. Reconcile the original transaction.');
      await this.finish(context);
    });
    await this.progress(command.operation, 'complete');
    assertArkiv(verified.records.length === 1, 'unverified', 'evidence_unavailable', 'The renewed entity was not verified.');
    return this.result(verified.records[0]!, verified, command.operation);
  }
  async reconcile(input: OperationIntent): Promise<ReconciliationResult> {
    const controller = this.connected(); const saved = controller.getOperation(input.id); const operation = saved ?? clone(input);
    assertArkiv(operation.inputHash === input.inputHash && equal(operation.authority, input.authority), 'conflict', 'hash_mismatch', 'The reconciliation intent does not match its saved operation.');
    if (!saved && (input.transactionHash || input.confirmedKeys.length || input.steps.some(step =>
      step.transactionHash || ['submitted', 'confirmed', 'unverified', 'reverted'].includes(step.status)))) {
      return { status: 'unverified', operation, error: { code: 'unverified', reasons: [{ code: 'evidence_unavailable' }], retryable: false,
        diagnostic: 'The send evidence exists but its local verification journal is missing.' } };
    }
    let lastReceipt: VerifiedStep['receipt'] | null = null; let admitted = false;
    for (const step of operation.steps) {
      const record = controller.getStep(operation.id, step.id);
      if (!record?.admission || record.step.status === 'failed-before-send') continue;
      admitted = true;
      try {
        const verified = await verifyOperationStep(this.reader, record);
        if (!verified) return { status: 'unverified', operation, error: { code: 'unverified', reasons: [{ code: 'evidence_unavailable' }], retryable: true } };
        if (verified.reverted) {
          await controller.markReverted(operation.id, step.id, verified.receipt);
          return { status: 'reverted', operation: controller.getOperation(operation.id)!, receipt: verified.receipt,
            error: { code: 'reverted', reasons: [{ code: 'evidence_unavailable' }], retryable: false } };
        }
        if (record.step.status !== 'confirmed') await controller.markConfirmed(operation.id, step.id, verified.receipt);
        lastReceipt = verified.receipt;
      } catch (error) { return { status: 'unverified', operation: controller.getOperation(operation.id) ?? operation, error: { ...repositoryError(error), code: 'unverified' } }; }
    }
    const latest = controller.getOperation(operation.id) ?? operation;
    if (lastReceipt && latest.phase === 'complete') return { status: 'confirmed', operation: latest, receipt: lastReceipt };
    return { status: admitted ? 'pending' : 'not_sent', operation: latest };
  }
}
