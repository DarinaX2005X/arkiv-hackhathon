/** Public protocol DTOs. JSON only: block/wei values are decimal strings, times are UTC ms. */
export const PROTOCOL = 'partfolk/1' as const;
export const SCHEMA_VERSION = 1 as const;
export const TIRAMISU_CHAIN_ID = 7738577 as const;
export type Protocol = typeof PROTOCOL;
export type ChainId = typeof TIRAMISU_CHAIN_ID;
export type PublicEntityKey = `0x${string}`;
export type LocalEntityKey = `local:${string}`;
export type EntityKey = PublicEntityKey | LocalEntityKey;
export type AccountAddress = `0x${string}`;
export type LocalActorId = `local-actor:${string}`;
export type ContentHash = `0x${string}`;
export type TransactionHash = `0x${string}`;
export type DecimalString = `${bigint}`;
export type OperationId = string;
export type UtcMilliseconds = number;
export type Locale = 'en';
export type DataMode = 'local' | 'public';
export type Actor = { kind: 'wallet'; address: AccountAddress } | { kind: 'local'; id: LocalActorId };
export type EntityType = 'project_root' | 'project_state' | 'publisher_root' | 'book_state' | 'proposal' | 'plan_activation' | 'project_link';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Interval { start: UtcMilliseconds; end: UtcMilliseconds }
export type ResourceKind = 'person' | 'place' | 'equipment';
export interface Resource {
  id: string; name: string; kind: ResourceKind; unit: string; capacity: number;
  /** Every personal-time offer uses this publisher's resource id "self", capacity one. */
  availability: Interval[]; capabilities: string[];
}
export interface OfferRef { publisherRoot: EntityKey; offerId: string }
export interface SelectedOfferRef extends OfferRef { offerHash: ContentHash }
export type Condition =
  | { kind: 'requires_offer'; offer: OfferRef }
  | { kind: 'excludes_offer'; offer: OfferRef }
  | { kind: 'requires_capability'; capability: string }
  | { kind: 'allowed_variants'; variantIds: string[] }
  | { kind: 'allowed_venues'; venueIds: string[] };
export interface Offer {
  id: string; title: string; resourceId: string; kind: ResourceKind; unit: string;
  quantity: number; capabilities: string[]; availability: Interval[];
  /** Empty means all projects; populated scopes contain exact roots. */
  projectScope: EntityKey[]; conditions: Condition[]; instructions: string;
}
export interface Requirement {
  id: string; title: string; kind: ResourceKind; capability: string; unit: string;
  quantity: number; interval: Interval; instructions: string; dependsOn: string[];
}
export interface ProjectVariant {
  id: string; title: string; venueId: string; timeZone: string;
  requirements: Requirement[]; instructions: string;
}
export interface ProjectRecipe {
  title: string; outcome: string; timeZone: string; variants: ProjectVariant[];
  instructions: string; sourceProjectRoot?: EntityKey;
}
/** Reuse intentionally clears dates and parties. A template cannot be solved until dated. */
export interface RecipeTemplate {
  title: string; outcome: string; timeZone: string; instructions: string;
  sourceProjectRoot: EntityKey;
  variants: { id: string; title: string; venueId: string; timeZone: string; instructions: string;
    requirements: Omit<Requirement, 'interval'>[] }[];
}
export type ProjectLifecycle = 'planning' | 'in_progress' | 'closed';
export type RecordedOutcome = 'completed' | 'completed_with_outstanding' | 'cancelled';
export type EvidenceAvailability = 'available' | 'partial' | 'unavailable';
export interface SourcePlanRef {
  projectRoot: EntityKey; activationKey: EntityKey; proposalKey: EntityKey; proposalHash: ContentHash;
}
export interface CompletedWork {
  obligationId: string; source: SourcePlanRef; attestationIds: string[];
  recordedAt: UtcMilliseconds; evidenceAvailability: EvidenceAvailability;
}
export interface CompletionSummary {
  outcome: RecordedOutcome; recordedAt: UtcMilliseconds; statement: string;
  completedWork: CompletedWork[]; outstandingObligationIds: string[];
  outstandingCustodyHoldIds: string[]; source: SourcePlanRef | null;
}
export interface PayloadBase { protocol: Protocol; schemaVersion: 1; operationId: OperationId; createdAt: UtcMilliseconds }
export interface ProjectRoot extends PayloadBase { entityType: 'project_root'; coordinator: Actor }
export interface PublisherRoot extends PayloadBase { entityType: 'publisher_root'; publisher: Actor; kind: 'individual' | 'organization' }
export interface ProjectState extends PayloadBase {
  entityType: 'project_state'; projectRoot: EntityKey; predecessorKeys: EntityKey[];
  recipe: ProjectRecipe; publisherRoots: EntityKey[]; lifecycle: ProjectLifecycle;
  completedWork: CompletedWork[]; completion: CompletionSummary | null;
}
export interface Allocation {
  id: string; requirementId: string; publisherRoot: EntityKey; offerId: string;
  offerHash: ContentHash; resourceId: string; quantity: number; unit: string; interval: Interval;
}
export interface ResourceAssumption {
  publisherRoot: EntityKey; resourceId: string; capacity: number; unit: string;
}
export type RunbookObligation =
  | { kind: 'task'; id: string; title: string; publisherRoot: EntityKey; interval: Interval; allocationIds: string[]; dependsOn: string[]; instructions: string }
  | { kind: 'handover' | 'return'; id: string; transferId: string; title: string; publisherRoot: EntityKey; resourceId: string; quantity: number; unit: string; giver: EntityKey; receiver: EntityKey; interval: Interval; allocationIds: string[]; dependsOn: string[]; instructions: string };
/** Entire object is the canonical material document; no receipt/progress/cache fields. */
export interface PlanDocument {
  protocol: Protocol; validationVersion: 1; chainId: ChainId | null;
  projectRoot: EntityKey; outcome: string; variant: ProjectVariant;
  offers: SelectedOfferRef[]; resourceAssumptions: ResourceAssumption[];
  allocations: Allocation[]; requiredApprovers: EntityKey[];
  conditions: Condition[]; instructions: string; runbook: RunbookObligation[];
  predecessor: SourcePlanRef | null;
}
export interface Proposal extends PayloadBase {
  entityType: 'proposal'; projectRoot: EntityKey; requirementsHash: ContentHash;
  proposalHash: ContentHash; plan: PlanDocument; changeExplanation: string;
}
export interface PlanActivation extends PayloadBase {
  entityType: 'plan_activation'; projectRoot: EntityKey; proposalKey: EntityKey;
  proposalHash: ContentHash; predecessorActivationKeys: EntityKey[];
}
export interface Decision extends SourcePlanRef {
  status: 'accepted' | 'declined' | 'withdrawn'; reason?: string;
  decidedAt: UtcMilliseconds; operationId: OperationId;
}
export interface Grant extends SourcePlanRef {
  id: string; protocol: Protocol; chainId: ChainId | null;
  offers: SelectedOfferRef[]; allocations: Allocation[];
  validUntil: UtcMilliseconds; acceptedAt: UtcMilliseconds; operationId: OperationId;
}
export interface AttestationBase extends SourcePlanRef {
  id: string; obligationId: string; author: EntityKey; recordedAt: UtcMilliseconds;
  operationId: OperationId; correctsAttestationId?: string;
}
export type Attestation =
  | (AttestationBase & { kind: 'task_report'; status: 'done' | 'not_done'; note: string })
  | (AttestationBase & { kind: 'transfer_report'; transferId: string; action: 'handover' | 'return'; resourceId: string; quantity: number; unit: string; giver: EntityKey; receiver: EntityKey; statementHash: ContentHash })
  | (AttestationBase & { kind: 'transfer_acknowledgement'; transferId: string; statementHash: ContentHash; acknowledgedQuantity: number; giver: EntityKey; receiver: EntityKey; resourceId: string; action: 'handover' | 'return' });
/** Physical custody is independent from timed grants and coordinator closure. */
export interface CustodyHold {
  id: string; projectRoot: EntityKey; resourceId: string; quantity: number; unit: string;
  source: SourcePlanRef; transferId: string; createdAt: UtcMilliseconds;
  status: 'outstanding' | 'released'; release?: { at: UtcMilliseconds; operationId: OperationId; reason: string; acknowledgementId?: string };
}
export interface BookState extends PayloadBase {
  entityType: 'book_state'; publisherRoot: EntityKey; predecessorKeys: EntityKey[];
  name: string; description: string; resources: Resource[]; offers: Offer[];
  decisions: Decision[]; grants: Grant[]; attestations: Attestation[]; custodyHolds: CustodyHold[];
  retentionDays: number;
}
export type ProjectLink = PayloadBase & (
  | { entityType: 'project_link'; linkKind: 'offer'; projectRoot: EntityKey; publisherRoot: EntityKey; offerIds: string[] }
  | { entityType: 'project_link'; linkKind: 'request'; projectRoot: EntityKey; publisherRoot: EntityKey; activationKey: EntityKey; proposalKey: EntityKey; proposalHash: ContentHash }
);
export type EntityPayload = ProjectRoot | ProjectState | PublisherRoot | BookState | Proposal | PlanActivation | ProjectLink;

export interface EntityProvenance {
  mode: DataMode; creator: Actor; owner: Actor; readonly: boolean;
  permissionlessExtension: boolean; contentType: string;
  /** Arkiv block heights, never application UTC deadlines. Null only for local records. */
  createdAtBlock: DecimalString | null; expiresAtBlock: DecimalString | null;
  transactionHash: TransactionHash | null;
}
export interface EntityRecord<T extends EntityPayload = EntityPayload> {
  key: EntityKey; payload: T; provenance: EntityProvenance;
}
export type ScopeState<T extends EntityPayload> =
  | { status: 'unique'; entity: EntityRecord<T> }
  | { status: 'missing'; reason: 'not_initialized' | 'expired_or_deleted' | 'not_found' }
  | { status: 'conflict'; entities: EntityRecord<T>[] }
  | { status: 'unverified'; reasons: DomainReason[] };
export interface Snapshot {
  mode: DataMode; chainId: ChainId | null; blockNumber: DecimalString | null;
  blockHash: ContentHash | null;
  blockTimestamp: UtcMilliseconds; fetchedAt: UtcMilliseconds;
  completeness: 'complete' | 'incomplete'; freshness: 'fresh' | 'stale';
  source: 'local' | 'arkiv'; reasons: DomainReason[];
}
export interface PublisherAggregate {
  root: EntityRecord<PublisherRoot>; book: ScopeState<BookState>; snapshot: Snapshot;
}
export interface ProjectAggregate {
  root: EntityRecord<ProjectRoot>; state: ScopeState<ProjectState>;
  activation: ScopeState<PlanActivation>; proposal: EntityRecord<Proposal> | null;
  proposalHistory: EntityRecord<Proposal>[]; publishers: PublisherAggregate[];
  /** Historical gaps are separate from confidence in the current complete snapshot. */
  proposalHistoryStatus?: { complete: boolean; reasons: DomainReason[] };
  snapshot: Snapshot;
}
export type ReasonCode =
  | 'invalid_input' | 'invalid_schema' | 'invalid_identity' | 'foreign_author'
  | 'projection_mismatch' | 'hash_mismatch' | 'not_readonly' | 'owner_changed'
  | 'missing_root' | 'missing_state' | 'missing_activation' | 'missing_proposal'
  | 'conflicting_heads' | 'incomplete_snapshot' | 'stale_snapshot' | 'rpc_error'
  | 'page_budget' | 'cursor_error' | 'expired' | 'not_initialized'
  | 'missing_offer' | 'offer_changed' | 'scope_mismatch' | 'unit_mismatch'
  | 'shortage' | 'capacity_exceeded' | 'outside_availability' | 'condition_unsatisfied'
  | 'dependency_unsatisfied' | 'pin_conflict' | 'search_exhausted'
  | 'missing_decision' | 'declined' | 'withdrawn' | 'missing_grant' | 'grant_expired'
  | 'activation_mismatch' | 'proposal_mismatch' | 'contradictory_decision'
  | 'custody_outstanding' | 'attestation_mismatch' | 'evidence_unavailable'
  | 'closed_project' | 'unsupported' | 'payload_too_large';
/** UI translates codes; params contain data, never untranslated user-facing sentences. */
export interface DomainReason {
  code: ReasonCode; path?: string; publisherRoot?: EntityKey; requirementId?: string;
  resourceId?: string; offerId?: string; obligationId?: string;
  params?: Record<string, string | number | boolean | null>;
}
export type AgreementHealth = 'possible' | 'awaiting_approval' | 'declined' | 'ready' | 'changed' | 'conflict' | 'unverified';
export interface Readiness {
  status: AgreementHealth; lifecycle: ProjectLifecycle;
  outcome: RecordedOutcome | null; evidenceAvailability: EvidenceAvailability;
  reasons: DomainReason[]; requiredApprovers: EntityKey[]; acceptedApprovers: EntityKey[];
  snapshot: Snapshot; source: SourcePlanRef | null;
}
export interface SolverInput {
  projectRoot: EntityKey; recipe: ProjectRecipe; publishers: PublisherAggregate[];
  snapshot: Snapshot; predecessor: EntityRecord<Proposal> | null;
  predecessorSource: SourcePlanRef | null;
  completedWork: CompletedWork[];
  /** Authenticated source plans for completed obligations retained across repairs. */
  proposalHistory?: EntityRecord<Proposal>[];
}
export interface SolverPin { requirementId: string; publisherRoot: EntityKey; offerId: string; quantity?: number }
export interface SolverBudget { maxNodes: number; maxCandidates: number; maxMilliseconds?: number }
export interface PlanRank {
  removedPublishers: number; changedVariant: number; changedAllocations: number;
  changedAssignments: number; tieBreak: string;
}
export interface PlanCandidate { plan: PlanDocument; proposalHash: ContentHash; rank: PlanRank }
export interface SolverResult {
  status: 'found' | 'impossible' | 'exhausted' | 'unverified'; candidates: PlanCandidate[];
  reasons: DomainReason[]; nodesVisited: number; exhausted: boolean;
  optimality: 'proven' | 'not_proven';
}
export interface ValidationResult { valid: boolean; reasons: DomainReason[] }
export interface PlanDifference {
  addedPublishers: EntityKey[]; removedPublishers: EntityKey[];
  changedAllocationIds: string[]; changedObligationIds: string[];
  variantChanged: boolean; materialChanged: boolean; requiresFreshAgreement: EntityKey[];
}
export interface ExecutionVerdict {
  completed: CompletedWork[]; outstandingObligationIds: string[];
  outstandingCustodyHolds: CustodyHold[]; reasons: DomainReason[];
  evidenceAvailability: EvidenceAvailability;
}
