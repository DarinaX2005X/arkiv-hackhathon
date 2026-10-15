import type {
  AccountAddress, Actor, BookState, ChainId, ContentHash, DataMode, DecimalString,
  DomainReason, EntityKey, EntityPayload, EntityRecord, JsonValue, LocalActorId,
  OperationId, PlanActivation, ProjectAggregate, ProjectLink, ProjectRecipe,
  ProjectRoot, ProjectState, Proposal, PublisherAggregate, PublisherRoot,
  Readiness, Snapshot, TransactionHash, UtcMilliseconds,
} from '../domain/types';

export type RepositoryErrorCode =
  | 'invalid_input' | 'unauthorized' | 'wrong_chain' | 'not_connected' | 'not_found'
  | 'conflict' | 'stale_heads' | 'expired' | 'incomplete' | 'network' | 'rate_limited'
  | 'insufficient_funds' | 'rejected' | 'reverted' | 'storage' | 'payload_too_large' | 'unverified' | 'unsupported';
export interface RepositoryError {
  code: RepositoryErrorCode; reasons: DomainReason[]; retryable: boolean;
  /** Diagnostic only; translate the error code for product UI. */
  diagnostic?: string;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: RepositoryError };
export interface ReadOptions { snapshot?: Snapshot; signal?: AbortSignal }
export interface ListResult<T> { items: T[]; snapshot: Snapshot; diagnostics: DomainReason[] }
export type WriteAuthority =
  | { mode: 'public'; actor: { kind: 'wallet'; address: AccountAddress }; chainId: ChainId }
  | { mode: 'local'; actor: { kind: 'local'; id: LocalActorId }; chainId: null };
export type OperationKind =
  | 'create_project' | 'register_publisher' | 'replace_project' | 'replace_book'
  | 'publish_proposal' | 'activate_proposal' | 'publish_project_link'
  | 'close_project' | 'renew_entity' | 'publish_plan' | 'share_offer'
  | 'publish_event' | 'replace_event' | 'replace_attendance';
export type OperationPhase =
  | 'prepared' | 'root_pending' | 'root_confirmed' | 'initial_state_pending' | 'initialized'
  | 'proposal_pending' | 'proposal_confirmed' | 'activation_pending' | 'activation_confirmed'
  | 'book_pending' | 'book_confirmed' | 'link_pending' | 'fanout_pending' | 'complete';
/** Frozen BEFORE asking a signer. Reconcile this same ID/hash; never blind-create after uncertainty. */
export interface OperationIntent {
  id: OperationId; kind: OperationKind; authority: WriteAuthority;
  createdAt: UtcMilliseconds; input: JsonValue; inputHash: ContentHash;
  expectedHeads: EntityKey[]; phase: OperationPhase;
  transactionHash: TransactionHash | null;
  confirmedKeys: EntityKey[]; pendingPublisherRoots: EntityKey[];
  steps: OperationStep[];
}
/** Allocate each step ID once and persist before sending; fanout has one step per publisher. */
export interface OperationStep {
  id: OperationId; phase: OperationPhase; publisherRoot?: EntityKey;
  status: 'prepared' | 'submitted' | 'confirmed' | 'unverified' | 'failed-before-send' | 'reverted';
  transactionHash: TransactionHash | null; confirmedKeys: EntityKey[];
  expectedHeads: EntityKey[]; inputHash: ContentHash;
}
export interface OperationReceipt {
  operationId: OperationId; transactionHash: TransactionHash | null;
  entityKeys: EntityKey[]; consumedKeys: EntityKey[];
  blockNumber: DecimalString | null; confirmedAt: UtcMilliseconds;
}
export type ActionState =
  | { status: 'idle' }
  | { status: 'validating'; operation: OperationIntent }
  | { status: 'awaiting-wallet'; operation: OperationIntent }
  | { status: 'submitted'; operation: OperationIntent; transactionHash: TransactionHash }
  | { status: 'reconciling'; operation: OperationIntent }
  | { status: 'confirmed'; operation: OperationIntent; receipt: OperationReceipt }
  | { status: 'rejected'; operation: OperationIntent; error: RepositoryError }
  | { status: 'reverted'; operation: OperationIntent; receipt: OperationReceipt; error: RepositoryError }
  | { status: 'failed-before-send'; operation: OperationIntent; error: RepositoryError }
  | { status: 'unverified'; operation: OperationIntent; error: RepositoryError };
export interface MutationResult<T> { value: T; receipt: OperationReceipt; operation: OperationIntent }
export type ReconciliationResult =
  | { status: 'confirmed'; operation: OperationIntent; receipt: OperationReceipt }
  | { status: 'reverted'; operation: OperationIntent; receipt: OperationReceipt; error: RepositoryError }
  | { status: 'partial_reverted'; operation: OperationIntent; receipt: OperationReceipt; error: RepositoryError }
  | { status: 'pending'; operation: OperationIntent }
  | { status: 'not_sent'; operation: OperationIntent; evidence?: 'native-journal' | 'preflight-journal' }
  | { status: 'unverified'; operation: OperationIntent; error: RepositoryError };
export interface CommandBase { operation: OperationIntent; lifetimeSeconds: number }
export interface CreateProjectCommand extends CommandBase { recipe: ProjectRecipe; rootKey?: EntityKey }
export interface RegisterPublisherCommand extends CommandBase {
  kind: PublisherRoot['kind']; name: string; description: string; rootKey?: EntityKey;
}
export interface ReplaceProjectCommand extends CommandBase {
  projectRoot: EntityKey; expectedHeads: EntityKey[]; state: ProjectState;
  /** Required on terminal close/cancel; consumed atomically with project state. */
  expectedActivationHeads?: EntityKey[];
}
export interface ReplaceBookCommand extends CommandBase {
  publisherRoot: EntityKey; expectedHeads: EntityKey[]; book: BookState;
  /** Explicit recovery of a missing book under the same still-live owned root. */
  recovery?: { acknowledgedMissingState: true; redeclaredAvailability: true };
}
export interface PublishProposalCommand extends CommandBase { projectRoot: EntityKey; proposal: Proposal }
export interface ActivateProposalCommand extends CommandBase {
  projectRoot: EntityKey; expectedActivationHeads: EntityKey[];
  proposalKey: EntityKey; proposalHash: ContentHash;
}
export interface PublishProjectLinkCommand extends CommandBase { link: ProjectLink }
export interface PublishPlanCommand extends CommandBase {
  projectRoot: EntityKey; proposal: Proposal; expectedActivationHeads: EntityKey[];
  requestPublisherRoots: EntityKey[];
}
export interface ShareOfferCommand extends CommandBase {
  projectRoot: EntityKey; publisherRoot: EntityKey; expectedBookHeads: EntityKey[];
  book: BookState; offerIds: string[];
}
export interface RenewEntityCommand extends CommandBase { entityKey: EntityKey; extendBySeconds: number }
export interface ProjectDraft { id: string; recipe: ProjectRecipe; createdAt: UtcMilliseconds; updatedAt: UtcMilliseconds }
export interface ProjectSummary { root: EntityRecord<ProjectRoot>; state: ProjectState | null; diagnostics: DomainReason[] }
export interface DiscoveryLink {
  entity: EntityRecord<ProjectLink>; status: 'current' | 'historical';
  publisher: PublisherAggregate | null; diagnostics: DomainReason[];
}
export interface PublicationProgress {
  operation: OperationIntent; proposalKey: EntityKey | null;
  activationKey: EntityKey | null; publishedRequestKeys: EntityKey[];
  pendingPublisherRoots: EntityKey[];
}
export interface ExportPacket {
  format: 'partfolk-export'; version: 1; exportedAt: UtcMilliseconds;
  mode: DataMode; project: ProjectAggregate; readiness: Readiness;
  /** A dated snapshot. Import never creates third-party authorizations. */
  snapshot: Snapshot;
}
/** Both adapters implement the same contract; network readers authenticate before returning DTOs. */
export interface Repository {
  readonly mode: DataMode;
  listProjects(actor: Actor, options?: ReadOptions): Promise<Result<ListResult<ProjectSummary>>>;
  loadProject(rootKey: EntityKey, options?: ReadOptions): Promise<Result<ProjectAggregate>>;
  loadPublisher(rootKey: EntityKey, options?: ReadOptions): Promise<Result<PublisherAggregate>>;
  listOwnPublishers(actor: Actor, options?: ReadOptions): Promise<Result<ListResult<PublisherAggregate>>>;
  listIncomingOffers(projectRoot: EntityKey, options?: ReadOptions): Promise<Result<ListResult<DiscoveryLink>>>;
  listRequests(publisherRoot: EntityKey, options?: ReadOptions): Promise<Result<ListResult<DiscoveryLink>>>;
  prepareProjectDraft(recipe: ProjectRecipe): Result<ProjectDraft>;
  createProject(command: CreateProjectCommand): Promise<Result<MutationResult<ProjectAggregate>>>;
  registerPublisher(command: RegisterPublisherCommand): Promise<Result<MutationResult<PublisherAggregate>>>;
  replaceProject(command: ReplaceProjectCommand): Promise<Result<MutationResult<EntityRecord<ProjectState>>>>;
  replaceBook(command: ReplaceBookCommand): Promise<Result<MutationResult<EntityRecord<BookState>>>>;
  publishProposal(command: PublishProposalCommand): Promise<Result<MutationResult<EntityRecord<Proposal>>>>;
  activateProposal(command: ActivateProposalCommand): Promise<Result<MutationResult<EntityRecord<PlanActivation>>>>;
  publishProjectLink(command: PublishProjectLinkCommand): Promise<Result<MutationResult<EntityRecord<ProjectLink>>>>;
  publishPlan(command: PublishPlanCommand): Promise<Result<PublicationProgress>>;
  shareOffer(command: ShareOfferCommand): Promise<Result<MutationResult<EntityRecord<ProjectLink>>>>;
  renewEntity(command: RenewEntityCommand): Promise<Result<MutationResult<EntityRecord<EntityPayload>>>>;
  reconcile(operation: OperationIntent): Promise<Result<ReconciliationResult>>;
  exportPacket(rootKey: EntityKey, options?: ReadOptions): Promise<Result<ExportPacket>>;
}
