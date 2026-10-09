import { canonicalJson, hashCanonical, hashPlan } from '../domain/canonical';
import { deriveReadiness, sameActor, validateExactGrant } from '../domain/readiness';
import { independentlyValidatePlan, validateBookCapacity, validateEntityPayload, validateRecipe } from '../domain/validation';
import { PROTOCOL } from '../domain/types';
import { createOperationIntent } from './operations';
import type {
  Actor, BookState, DomainReason, EntityKey, EntityPayload, EntityRecord,
  LocalActorId, PlanActivation, ProjectAggregate, ProjectLink, ProjectRecipe,
  ProjectRoot, ProjectState, Proposal, PublisherAggregate, PublisherRoot, ScopeState, Snapshot, SourcePlanRef,
} from '../domain/types';
import type {
  ActivateProposalCommand, CommandBase, CreateProjectCommand, DiscoveryLink, ExportPacket,
  ListResult, MutationResult, OperationIntent, OperationKind, OperationReceipt, ProjectDraft,
  ProjectSummary, PublicationProgress, PublishPlanCommand, PublishProjectLinkCommand,
  PublishProposalCommand, ReadOptions, ReconciliationResult, RegisterPublisherCommand,
  RenewEntityCommand, ReplaceBookCommand, ReplaceProjectCommand, Repository, RepositoryError,
  RepositoryErrorCode, Result, ShareOfferCommand,
} from './types';

export interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface LocalRepositoryOptions {
  storage?: LocalStorageLike | null;
  namespace?: string;
  now?: () => number;
  /** Advance synthetic practice time after persisted events, including across reloads. */
  logicalClock?: boolean;
  id?: () => string;
}
interface StoredEntity { entity: EntityRecord; expiresAt: number }
interface StoredOperation {
  operation: OperationIntent;
  receipt: OperationReceipt | null;
  result: unknown;
}
interface LocalStore {
  format: 'partfolk-local'; version: 1;
  records: Record<string, StoredEntity>;
  operations: Record<string, StoredOperation>;
  drafts: Record<string, ProjectDraft>;
}
interface MutationContext {
  store: LocalStore; actor: Extract<Actor, { kind: 'local' }>;
  operation: OperationIntent; now: number; lifetimeSeconds: number;
  created: EntityKey[]; consumed: EntityKey[];
}
const emptyStore = (): LocalStore => ({ format: 'partfolk-local', version: 1, records: {}, operations: {}, drafts: {} });
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const validLocalActor = (actor: Actor): actor is Extract<Actor, { kind: 'local' }> =>
  actor?.kind === 'local' && typeof actor.id === 'string' && /^local-actor:[A-Za-z0-9._:-]{1,100}$/.test(actor.id);
const localKey = (key: unknown): key is EntityKey => typeof key === 'string' && /^local:[A-Za-z0-9._:-]{1,150}$/.test(key);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const equalKeys = (left: EntityKey[], right: EntityKey[]): boolean =>
  left.length === new Set(left).size && canonicalJson([...left].sort()) === canonicalJson([...right].sort());
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const randomId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
class LocalFailure extends Error {
  constructor(readonly error: RepositoryError) { super(error.diagnostic ?? error.code); }
}
function reject(code: RepositoryErrorCode, reason: DomainReason['code'] = 'invalid_input', diagnostic?: string): never {
  throw new LocalFailure({ code, reasons: [{ code: reason }], retryable: code === 'storage', ...(diagnostic ? { diagnostic } : {}) });
}
function validation(reasons: DomainReason[]): never {
  throw new LocalFailure({ code: 'invalid_input', reasons, retryable: false });
}

/** Explicitly injected storage lets independent local clients share one durable store. */
export function createMemoryStorage(): LocalStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

/** Freeze the complete command (including lifetimeSeconds), excluding its operation field. */
export function createLocalOperationIntent(
  kind: OperationKind,
  actor: Extract<Actor, { kind: 'local' }> | LocalActorId,
  input: unknown,
  options: { id?: string; now?: number } = {},
): OperationIntent {
  const authorityActor = typeof actor === 'string' ? { kind: 'local' as const, id: actor } : actor;
  if (!validLocalActor(authorityActor)) reject('unauthorized', 'invalid_identity');
  return createOperationIntent(kind, { mode: 'local', actor: authorityActor, chainId: null }, input, options);
}

/** Local simulation of immutable, owner-controlled records; never creates wallet authority. */
export class LocalRepository implements Repository {
  readonly mode = 'local' as const;
  readonly namespace: string;
  readonly storageKey: string;
  private readonly storage: LocalStorageLike;
  private readonly baseNow: () => number;
  private readonly logicalClock: boolean;
  private lastTime = 0;
  private readonly id: () => string;
  private store = emptyStore();
  private raw: string | null = null;
  private recoveryRaw: string | null = null;
  private dirty = false;

  constructor(options: LocalRepositoryOptions = {}) {
    this.storage = options.storage ?? createMemoryStorage();
    this.namespace = options.namespace ?? 'custom';
    if (!/^[A-Za-z0-9._-]+$/.test(this.namespace)) throw new Error('Invalid local namespace');
    this.storageKey = `partfolk:local:${this.namespace}`;
    this.baseNow = options.now ?? Date.now;
    this.logicalClock = options.logicalClock ?? false;
    this.id = options.id ?? randomId;
  }

  /** Use the same clock for authored events and repository snapshots. Storage errors remain visible. */
  currentTime(): number {
    this.refresh();
    return this.now();
  }

  private now(): number {
    const base = this.baseNow();
    if (!this.logicalClock) return base;
    if (!integer(base)) reject('invalid_input', 'invalid_input', 'Local clock must return a nonnegative safe integer.');
    let latest = Math.max(base, this.lastTime);
    const observe = (time: number): void => { latest = Math.max(latest, time); };
    // Only authored event times advance practice. Future schedules, grant deadlines and
    // entity expiration must not fast-forward the workspace or expire its records.
    for (const { entity } of Object.values(this.store.records)) {
      const payload = entity.payload;
      observe(payload.createdAt);
      if (payload.entityType === 'book_state') {
        payload.decisions.forEach(value => observe(value.decidedAt));
        payload.grants.forEach(value => observe(value.acceptedAt));
        payload.attestations.forEach(value => observe(value.recordedAt));
        payload.custodyHolds.forEach(value => { observe(value.createdAt); if (value.release) observe(value.release.at); });
      } else if (payload.entityType === 'project_state') {
        payload.completedWork.forEach(value => observe(value.recordedAt));
        if (payload.completion) {
          observe(payload.completion.recordedAt);
          payload.completion.completedWork.forEach(value => observe(value.recordedAt));
        }
      }
    }
    for (const { operation, receipt } of Object.values(this.store.operations)) {
      observe(operation.createdAt);
      if (receipt) observe(receipt.confirmedAt);
    }
    for (const draft of Object.values(this.store.drafts)) { observe(draft.createdAt); observe(draft.updatedAt); }
    if (!integer(latest + 1)) reject('invalid_input', 'invalid_input', 'Local logical clock exceeded its supported range.');
    this.lastTime = latest + 1;
    return this.lastTime;
  }

  private result<T>(action: () => T): Result<T> {
    try { return ok(copy(action())); }
    catch (error) {
      if (error instanceof LocalFailure) return { ok: false, error: error.error };
      return { ok: false, error: { code: 'invalid_input', reasons: [{ code: 'invalid_input' }], retryable: false,
        diagnostic: error instanceof Error ? error.message : String(error) } };
    }
  }

  private decode(raw: string): LocalStore {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { reject('storage', 'invalid_schema', 'Saved local data is malformed; export it before recovery.'); }
    if (!value || typeof value !== 'object') reject('storage', 'invalid_schema');
    const data = value as Partial<LocalStore>;
    if (data.format !== 'partfolk-local' || data.version !== 1) {
      reject('storage', 'unsupported', 'Unknown saved format; preserve or export the original data.');
    }
    if (!data.records || !data.operations || !data.drafts || Array.isArray(data.records) || Array.isArray(data.operations) || Array.isArray(data.drafts)
      || typeof data.records !== 'object' || typeof data.operations !== 'object' || typeof data.drafts !== 'object') reject('storage', 'invalid_schema');
    for (const [key, stored] of Object.entries(data.records)) {
      if (!stored || !localKey(key) || stored.entity?.key !== key || !integer(stored.expiresAt)) reject('storage', 'invalid_schema');
      const entity = stored.entity;
      if (!entity.provenance || entity.provenance.mode !== 'local' || !validLocalActor(entity.provenance.creator)
        || !validLocalActor(entity.provenance.owner) || !entity.provenance.readonly
        || entity.provenance.permissionlessExtension || entity.provenance.contentType !== 'application/json'
        || entity.provenance.createdAtBlock !== null || entity.provenance.expiresAtBlock !== null
        || entity.provenance.transactionHash !== null) reject('storage', 'invalid_schema');
      if (!validateEntityPayload(entity.payload).valid) reject('storage', 'invalid_schema');
    }
    for (const [id, entry] of Object.entries(data.operations)) {
      if (!entry?.operation || entry.operation.id !== id || entry.operation.authority?.mode !== 'local'
        || entry.operation.authority.chainId !== null || !validLocalActor(entry.operation.authority.actor)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || !integer(entry.operation.createdAt)
        || !Array.isArray(entry.operation.confirmedKeys) || !entry.operation.confirmedKeys.every(localKey)
        || !Array.isArray(entry.operation.steps) || !Array.isArray(entry.operation.expectedHeads)
        || !entry.operation.expectedHeads.every(localKey) || !Array.isArray(entry.operation.pendingPublisherRoots)
        || !entry.operation.pendingPublisherRoots.every(localKey)
        || entry.operation.inputHash !== hashCanonical(entry.operation.input)) reject('storage', 'invalid_schema');
      if (entry.receipt && (entry.receipt.operationId !== id || entry.receipt.transactionHash !== null
        || entry.receipt.blockNumber !== null || !integer(entry.receipt.confirmedAt)
        || !Array.isArray(entry.receipt.entityKeys) || !entry.receipt.entityKeys.every(localKey)
        || !Array.isArray(entry.receipt.consumedKeys) || !entry.receipt.consumedKeys.every(localKey))) reject('storage', 'invalid_schema');
    }
    for (const [id, draft] of Object.entries(data.drafts)) {
      if (!draft || draft.id !== id || !integer(draft.createdAt) || !integer(draft.updatedAt) || !validateRecipe(draft.recipe).valid) reject('storage', 'invalid_schema');
    }
    return data as LocalStore;
  }

  private refresh(options?: ReadOptions): void {
    if (options?.signal?.aborted) reject('rejected');
    if (this.dirty) reject('storage', 'incomplete_snapshot', 'Unsaved local work is retained in memory; retry persistence or export recovery.');
    if (options?.snapshot && (options.snapshot.mode !== 'local' || options.snapshot.chainId !== null)) reject('invalid_input', 'invalid_identity');
    let raw: string | null;
    try { raw = this.storage.getItem(this.storageKey); } catch { reject('storage', 'incomplete_snapshot', 'Local storage could not be read.'); }
    if (raw !== this.raw) {
      this.recoveryRaw = raw;
      this.store = raw === null ? emptyStore() : this.decode(raw);
      this.raw = raw;
    }
  }

  private persist(stage: LocalStore): void {
    const encoded = canonicalJson(stage);
    this.store = stage;
    try { this.storage.setItem(this.storageKey, encoded); }
    catch { this.dirty = true; reject('storage', 'incomplete_snapshot', 'Save failed; unsaved work remains in memory and has not been durably confirmed.'); }
    this.raw = encoded;
    this.recoveryRaw = encoded;
    this.dirty = false;
  }

  /** Recovery export includes pending intents and unsaved work; it never imports public authority. */
  exportRecovery(): string { return this.dirty ? canonicalJson(this.store) : this.recoveryRaw ?? canonicalJson(this.store); }
  retryPersistence(): Result<void> {
    return this.result(() => {
      if (!this.dirty) return;
      let actual: string | null;
      try { actual = this.storage.getItem(this.storageKey); } catch { reject('storage', 'incomplete_snapshot'); }
      if (actual !== this.raw) reject('stale_heads', 'conflicting_heads', 'Another client saved newer data. Export unsaved work before reconciliation.');
      this.persist(this.store);
    });
  }
  resetPractice(): Result<void> {
    return this.result(() => {
      if (this.namespace !== 'practice') reject('unauthorized', 'invalid_identity');
      this.refresh(); this.persist(emptyStore());
    });
  }
  /** Fixtures must explicitly opt into practice; custom work always starts empty. */
  seed(records: EntityRecord[], lifetimeSeconds = 90 * 24 * 60 * 60): Result<void> {
    return this.result(() => {
      if (this.namespace !== 'practice') reject('unauthorized', 'invalid_identity');
      this.refresh();
      if (Object.keys(this.store.records).length) reject('conflict', 'conflicting_heads');
      this.lifetime(lifetimeSeconds);
      const stage = copy(this.store);
      for (const entity of records) {
        if (stage.records[entity.key]) reject('invalid_input');
        stage.records[entity.key] = { entity: copy(entity), expiresAt: this.now() + lifetimeSeconds * 1000 };
      }
      this.decode(canonicalJson(stage));
      this.persist(stage);
    });
  }

  private snapshot(now = this.now()): Snapshot {
    return { mode: 'local', chainId: null, blockNumber: null, blockHash: null, blockTimestamp: now,
      fetchedAt: now, completeness: 'complete', freshness: 'fresh', source: 'local', reasons: [] };
  }
  private live(store: LocalStore, now: number): EntityRecord[] {
    return Object.values(store.records).filter(item => item.expiresAt > now).map(item => item.entity);
  }
  private get<T extends EntityPayload>(store: LocalStore, key: EntityKey, type: T['entityType'], now: number): EntityRecord<T> {
    if (!localKey(key)) reject('invalid_input', 'invalid_identity');
    const stored = store.records[key];
    if (!stored || stored.expiresAt <= now) reject(stored ? 'expired' : 'not_found', stored ? 'expired' : 'missing_root');
    if (stored.entity.payload.entityType !== type) reject('invalid_input', 'invalid_schema');
    const entity = stored.entity as EntityRecord<T>;
    if (!sameActor(entity.provenance.creator, entity.provenance.owner)) reject('unverified', 'owner_changed');
    if (entity.payload.entityType === 'project_root' && !sameActor(entity.payload.coordinator, entity.provenance.creator)) reject('unverified', 'foreign_author');
    if (entity.payload.entityType === 'publisher_root' && !sameActor(entity.payload.publisher, entity.provenance.creator)) reject('unverified', 'foreign_author');
    return entity;
  }
  private owner(root: EntityRecord, actor: Actor): void {
    if (!sameActor(root.provenance.creator, actor) || !sameActor(root.provenance.owner, actor)) reject('unauthorized', 'foreign_author');
  }
  private scope<T extends ProjectState | BookState | PlanActivation>(store: LocalStore, type: T['entityType'], root: EntityRecord, now: number): ScopeState<T> {
    const entities = this.live(store, now).filter(entity => entity.payload.entityType === type
      && ('publisherRoot' in entity.payload ? entity.payload.publisherRoot : 'projectRoot' in entity.payload ? entity.payload.projectRoot : null) === root.key
      && sameActor(entity.provenance.creator, root.provenance.creator)
      && sameActor(entity.provenance.owner, root.provenance.creator)) as EntityRecord<T>[];
    if (entities.length === 1) return { status: 'unique', entity: entities[0]! };
    if (entities.length > 1) return { status: 'conflict', entities };
    return { status: 'missing', reason: 'expired_or_deleted' };
  }
  private scopeKeys(scope: ScopeState<ProjectState | BookState | PlanActivation>): EntityKey[] {
    return scope.status === 'unique' ? [scope.entity.key] : scope.status === 'conflict' ? scope.entities.map(entity => entity.key) : [];
  }
  private heads(actual: EntityKey[], expected: EntityKey[]): void {
    if (!equalKeys(actual, expected)) reject('stale_heads', 'conflicting_heads');
  }
  private publisher(store: LocalStore, key: EntityKey, snapshot: Snapshot): PublisherAggregate {
    const root = this.get<PublisherRoot>(store, key, 'publisher_root', snapshot.blockTimestamp);
    return { root, book: this.scope<BookState>(store, 'book_state', root, snapshot.blockTimestamp), snapshot };
  }
  private project(store: LocalStore, key: EntityKey, snapshot: Snapshot): ProjectAggregate {
    const root = this.get<ProjectRoot>(store, key, 'project_root', snapshot.blockTimestamp);
    const state = this.scope<ProjectState>(store, 'project_state', root, snapshot.blockTimestamp);
    const activation = this.scope<PlanActivation>(store, 'plan_activation', root, snapshot.blockTimestamp);
    const history = this.live(store, snapshot.blockTimestamp).filter(entity => entity.payload.entityType === 'proposal'
      && entity.payload.projectRoot === key && sameActor(entity.provenance.creator, root.provenance.creator)
      && sameActor(entity.provenance.owner, root.provenance.creator)) as EntityRecord<Proposal>[];
    const proposal = activation.status === 'unique' ? history.find(entity => entity.key === activation.entity.payload.proposalKey) ?? null : null;
    const roots = unique([...(state.status === 'unique' ? state.entity.payload.publisherRoots : []), ...(proposal?.payload.plan.requiredApprovers ?? [])]);
    const publishers: PublisherAggregate[] = [];
    for (const publisherRoot of roots) {
      try { publishers.push(this.publisher(store, publisherRoot, snapshot)); }
      catch (error) { if (!(error instanceof LocalFailure) || !['not_found', 'expired'].includes(error.error.code)) throw error; }
    }
    const historyReasons: DomainReason[] = [];
    const sources = [...history.map(entry => entry.payload.plan.predecessor), state.status === 'unique' ? state.entity.payload.completion?.source : null];
    for (const source of sources) {
      if (source && !history.some(prior => prior.key === source.proposalKey && prior.payload.proposalHash === source.proposalHash)) {
        historyReasons.push({ code: 'evidence_unavailable', params: { proposalKey: source.proposalKey } });
      }
    }
    return { root, state, activation, proposal, proposalHistory: history, proposalHistoryStatus: { complete: !historyReasons.length, reasons: historyReasons }, publishers, snapshot };
  }

  async listProjects(actor: Actor, options?: ReadOptions): Promise<Result<ListResult<ProjectSummary>>> {
    return this.result(() => {
      this.refresh(options);
      if (!validLocalActor(actor)) reject('unauthorized', 'invalid_identity');
      const snapshot = this.snapshot();
      const items = this.live(this.store, snapshot.blockTimestamp).filter(entity => entity.payload.entityType === 'project_root'
        && sameActor(entity.provenance.creator, actor)).map(entity => {
        const project = this.project(this.store, entity.key, snapshot);
        return { root: project.root, state: project.state.status === 'unique' ? project.state.entity.payload : null,
          diagnostics: project.state.status === 'conflict' ? [{ code: 'conflicting_heads' as const }] : project.state.status !== 'unique' ? [{ code: 'missing_state' as const }] : [] };
      });
      return { items, snapshot, diagnostics: [] };
    });
  }
  async loadProject(rootKey: EntityKey, options?: ReadOptions): Promise<Result<ProjectAggregate>> {
    return this.result(() => { this.refresh(options); return this.project(this.store, rootKey, this.snapshot()); });
  }
  async loadPublisher(rootKey: EntityKey, options?: ReadOptions): Promise<Result<PublisherAggregate>> {
    return this.result(() => { this.refresh(options); return this.publisher(this.store, rootKey, this.snapshot()); });
  }
  async listOwnPublishers(actor: Actor, options?: ReadOptions): Promise<Result<ListResult<PublisherAggregate>>> {
    return this.result(() => {
      this.refresh(options);
      if (!validLocalActor(actor)) reject('unauthorized', 'invalid_identity');
      const snapshot = this.snapshot();
      return { items: this.live(this.store, snapshot.blockTimestamp).filter(entity => entity.payload.entityType === 'publisher_root'
        && sameActor(entity.provenance.creator, actor)).map(entity => this.publisher(this.store, entity.key, snapshot)), snapshot, diagnostics: [] };
    });
  }

  private discovery(kind: ProjectLink['linkKind'], rootKey: EntityKey, options?: ReadOptions): Result<ListResult<DiscoveryLink>> {
    return this.result(() => {
      this.refresh(options);
      const snapshot = this.snapshot();
      this.get(this.store, rootKey, kind === 'offer' ? 'project_root' : 'publisher_root', snapshot.blockTimestamp);
      const diagnostics: DomainReason[] = [], items: DiscoveryLink[] = [], identities = new Set<string>();
      for (const entity of this.live(this.store, snapshot.blockTimestamp)) {
        const payload = entity.payload;
        if (payload.entityType !== 'project_link' || payload.linkKind !== kind
          || (kind === 'offer' ? payload.projectRoot : payload.publisherRoot) !== rootKey) continue;
        try {
          const project = this.project(this.store, payload.projectRoot, snapshot);
          const publisher = this.publisher(this.store, payload.publisherRoot, snapshot);
          const authority = kind === 'offer' ? publisher.root.provenance.creator : project.root.provenance.creator;
          this.owner(entity, authority);
          const identity = payload.linkKind === 'offer'
            ? canonicalJson({ kind, projectRoot: payload.projectRoot, publisherRoot: payload.publisherRoot, offerIds: [...payload.offerIds].sort() })
            : canonicalJson({ kind, projectRoot: payload.projectRoot, publisherRoot: payload.publisherRoot, activationKey: payload.activationKey, proposalKey: payload.proposalKey, proposalHash: payload.proposalHash });
          if (identities.has(identity)) continue;
          identities.add(identity);
          const current = payload.linkKind === 'offer'
            ? publisher.book.status === 'unique' && payload.offerIds.every(id => publisher.book.status === 'unique' && publisher.book.entity.payload.offers.some(offer => offer.id === id && (!offer.projectScope.length || offer.projectScope.includes(payload.projectRoot))))
            : project.activation.status === 'unique' && project.activation.entity.key === payload.activationKey
              && project.activation.entity.payload.proposalKey === payload.proposalKey && project.activation.entity.payload.proposalHash === payload.proposalHash;
          items.push({ entity: entity as EntityRecord<ProjectLink>, status: current ? 'current' : 'historical', publisher,
            diagnostics: current ? [] : [{ code: payload.linkKind === 'offer' ? 'missing_offer' : 'activation_mismatch' }] });
        } catch (error) {
          if (error instanceof LocalFailure) diagnostics.push(...error.error.reasons); else throw error;
        }
      }
      return { items, snapshot, diagnostics };
    });
  }
  async listIncomingOffers(projectRoot: EntityKey, options?: ReadOptions): Promise<Result<ListResult<DiscoveryLink>>> { return this.discovery('offer', projectRoot, options); }
  async listRequests(publisherRoot: EntityKey, options?: ReadOptions): Promise<Result<ListResult<DiscoveryLink>>> { return this.discovery('request', publisherRoot, options); }

  prepareProjectDraft(recipe: ProjectRecipe): Result<ProjectDraft> {
    return this.result(() => {
      this.refresh(); const checked = validateRecipe(recipe); if (!checked.valid) validation(checked.reasons);
      const now = this.now(), draft = { id: this.id(), recipe: copy(recipe), createdAt: now, updatedAt: now };
      const stage = copy(this.store); stage.drafts[draft.id] = draft; this.persist(stage); return draft;
    });
  }
  private lifetime(seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 315_360_000) reject('invalid_input');
  }
  private bind(command: CommandBase, kind: OperationKind): Extract<Actor, { kind: 'local' }> {
    const op = command.operation;
    if (!op || op.kind !== kind || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(op.id) || !integer(op.createdAt) || op.authority?.mode !== 'local'
      || op.authority.chainId !== null || op.transactionHash !== null || !validLocalActor(op.authority.actor)) reject('unauthorized', 'invalid_identity');
    this.lifetime(command.lifetimeSeconds);
    const { operation: _operation, ...input } = command;
    if (hashCanonical(op.input) !== op.inputHash || canonicalJson(input) !== canonicalJson(op.input)) reject('invalid_input', 'hash_mismatch', 'Frozen operation input does not match this command.');
    return op.authority.actor;
  }
  private begin(command: CommandBase, kind: OperationKind): StoredOperation {
    this.refresh(); this.bind(command, kind);
    const existing = this.store.operations[command.operation.id];
    if (existing) {
      if (existing.operation.kind !== kind || existing.operation.inputHash !== command.operation.inputHash
        || !sameActor(existing.operation.authority.actor, command.operation.authority.actor)) reject('conflict', 'hash_mismatch');
      return existing;
    }
    const stage = copy(this.store);
    const entry: StoredOperation = { operation: copy(command.operation), receipt: null, result: null };
    stage.operations[command.operation.id] = entry; this.persist(stage); return entry;
  }
  private newKey(store: LocalStore): EntityKey {
    const key: EntityKey = `local:${this.id()}`;
    if (!localKey(key) || this.usedKey(store, key)) reject('conflict', 'invalid_identity');
    return key;
  }
  private usedKey(store: LocalStore, key: EntityKey): boolean {
    return Boolean(store.records[key]) || Object.values(store.operations).some(entry => entry.receipt?.entityKeys.includes(key));
  }
  private create<T extends EntityPayload>(ctx: MutationContext, payload: T, suppliedKey?: EntityKey): EntityRecord<T> {
    const checked = validateEntityPayload(payload); if (!checked.valid) validation(checked.reasons);
    if (payload.operationId !== ctx.operation.id) reject('invalid_input', 'hash_mismatch');
    const bytes = new TextEncoder().encode(canonicalJson(payload)).byteLength;
    if (bytes > 120 * 1024) reject('payload_too_large', 'payload_too_large');
    const key = suppliedKey ?? this.newKey(ctx.store);
    if (!localKey(key) || this.usedKey(ctx.store, key)) reject('conflict', 'invalid_identity');
    const entity: EntityRecord<T> = { key, payload: copy(payload), provenance: {
      mode: 'local', creator: copy(ctx.actor), owner: copy(ctx.actor), readonly: true,
      permissionlessExtension: false, contentType: 'application/json', createdAtBlock: null,
      expiresAtBlock: null, transactionHash: null,
    } };
    const expiresAt = ctx.now + ctx.lifetimeSeconds * 1000;
    if (!integer(expiresAt)) reject('invalid_input');
    ctx.store.records[key] = { entity, expiresAt }; ctx.created.push(key); return entity;
  }
  private consume(ctx: MutationContext, keys: EntityKey[]): void {
    for (const key of keys) {
      const record = ctx.store.records[key];
      if (!record || record.expiresAt <= ctx.now) reject('stale_heads', 'expired');
      this.owner(record.entity, ctx.actor); delete ctx.store.records[key]; ctx.consumed.push(key);
    }
  }
  private mutate<T>(command: CommandBase, kind: OperationKind, action: (ctx: MutationContext) => T): Result<MutationResult<T>> {
    return this.result(() => {
      const existing = this.begin(command, kind);
      if (existing.receipt) return { value: existing.result as T, receipt: existing.receipt, operation: existing.operation };
      const stage = copy(this.store), actor = this.bind(command, kind), now = this.now();
      const ctx: MutationContext = { store: stage, actor, operation: command.operation, now, lifetimeSeconds: command.lifetimeSeconds, created: [], consumed: [] };
      const value = action(ctx);
      const receipt: OperationReceipt = { operationId: command.operation.id, transactionHash: null,
        entityKeys: ctx.created, consumedKeys: ctx.consumed, blockNumber: null, confirmedAt: now };
      const operation: OperationIntent = { ...copy(existing.operation), phase: 'complete', confirmedKeys: ctx.created };
      stage.operations[operation.id] = { operation, receipt, result: value }; this.persist(stage);
      return { value, receipt, operation };
    });
  }
  private base(ctx: MutationContext) { return { protocol: PROTOCOL, schemaVersion: 1 as const, operationId: ctx.operation.id, createdAt: ctx.now }; }
  private predecessor(project: ProjectAggregate): SourcePlanRef | null {
    if (project.activation.status === 'conflict' || project.activation.status === 'unverified') reject('conflict', 'conflicting_heads');
    return project.activation.status === 'unique' ? {
      projectRoot: project.root.key, activationKey: project.activation.entity.key,
      proposalKey: project.activation.entity.payload.proposalKey, proposalHash: project.activation.entity.payload.proposalHash,
    } : project.state.status === 'unique' ? project.state.entity.payload.completion?.source ?? null : null;
  }

  async createProject(command: CreateProjectCommand): Promise<Result<MutationResult<ProjectAggregate>>> {
    return this.mutate(command, 'create_project', ctx => {
      const checked = validateRecipe(command.recipe); if (!checked.valid) validation(checked.reasons);
      const root = this.create<ProjectRoot>(ctx, { ...this.base(ctx), entityType: 'project_root', coordinator: ctx.actor }, command.rootKey);
      this.create<ProjectState>(ctx, { ...this.base(ctx), entityType: 'project_state', projectRoot: root.key, predecessorKeys: [],
        recipe: command.recipe, publisherRoots: [], lifecycle: 'planning', completedWork: [], completion: null });
      return this.project(ctx.store, root.key, this.snapshot(ctx.now));
    });
  }
  async registerPublisher(command: RegisterPublisherCommand): Promise<Result<MutationResult<PublisherAggregate>>> {
    return this.mutate(command, 'register_publisher', ctx => {
      const root = this.create<PublisherRoot>(ctx, { ...this.base(ctx), entityType: 'publisher_root', publisher: ctx.actor, kind: command.kind }, command.rootKey);
      this.create<BookState>(ctx, { ...this.base(ctx), entityType: 'book_state', publisherRoot: root.key, predecessorKeys: [],
        name: command.name, description: command.description, resources: [], offers: [], decisions: [], grants: [], attestations: [], custodyHolds: [], retentionDays: 90 });
      return this.publisher(ctx.store, root.key, this.snapshot(ctx.now));
    });
  }
  async replaceProject(command: ReplaceProjectCommand): Promise<Result<MutationResult<EntityRecord<ProjectState>>>> {
    const kind = command.operation.kind === 'close_project' ? 'close_project' : 'replace_project';
    return this.mutate(command, kind, ctx => {
      const root = this.get<ProjectRoot>(ctx.store, command.projectRoot, 'project_root', ctx.now); this.owner(root, ctx.actor);
      const current = this.scope<ProjectState>(ctx.store, 'project_state', root, ctx.now);
      const keys = this.scopeKeys(current); if (!keys.length) reject('not_found', 'missing_state'); this.heads(keys, command.expectedHeads);
      if (command.state.projectRoot !== root.key || !equalKeys(command.state.predecessorKeys, keys)) reject('invalid_input', 'scope_mismatch');
      const activationKeys = this.scopeKeys(this.scope<PlanActivation>(ctx.store, 'plan_activation', root, ctx.now));
      if (command.state.lifecycle === 'closed') {
        if (!command.expectedActivationHeads) reject('invalid_input', 'activation_mismatch');
        this.heads(activationKeys, command.expectedActivationHeads); this.consume(ctx, activationKeys);
      } else if (command.expectedActivationHeads?.length) reject('invalid_input', 'activation_mismatch');
      for (const publisherRoot of command.state.publisherRoots) this.get<PublisherRoot>(ctx.store, publisherRoot, 'publisher_root', ctx.now);
      const state = this.create(ctx, command.state); this.consume(ctx, keys); return state;
    });
  }
  async replaceBook(command: ReplaceBookCommand): Promise<Result<MutationResult<EntityRecord<BookState>>>> {
    return this.mutate(command, 'replace_book', ctx => this.changeBook(ctx, command));
  }
  private changeBook(ctx: MutationContext, command: Pick<ReplaceBookCommand, 'publisherRoot' | 'expectedHeads' | 'book' | 'recovery'>): EntityRecord<BookState> {
    const root = this.get<PublisherRoot>(ctx.store, command.publisherRoot, 'publisher_root', ctx.now); this.owner(root, ctx.actor);
    const keys = this.scopeKeys(this.scope<BookState>(ctx.store, 'book_state', root, ctx.now));
    if (!keys.length) {
      if (!command.recovery?.acknowledgedMissingState || !command.recovery.redeclaredAvailability) reject('not_found', 'missing_state');
      if (command.book.resources.length || command.book.offers.length || command.book.decisions.length || command.book.grants.length
        || command.book.attestations.length || command.book.custodyHolds.length) reject('invalid_input', 'evidence_unavailable');
    } else if (command.recovery) reject('conflict', 'conflicting_heads');
    this.heads(keys, command.expectedHeads);
    if (command.book.publisherRoot !== root.key || !equalKeys(command.book.predecessorKeys, keys)) reject('invalid_input', 'scope_mismatch');
    const schema = validateEntityPayload(command.book); if (!schema.valid) validation(schema.reasons);
    if (keys.length === 1) {
      const capacity = validateBookCapacity(this.publisher(ctx.store, root.key, this.snapshot(ctx.now)), command.book, ctx.now);
      if (!capacity.valid) validation(capacity.reasons);
    }
    if (command.book.grants.some(grant => grant.validUntil > ctx.now + ctx.lifetimeSeconds * 1000)) reject('invalid_input', 'grant_expired');
    const oldGrants = keys.flatMap(key => (ctx.store.records[key]!.entity.payload as BookState).grants);
    for (const grant of command.book.grants) {
      if (oldGrants.some(previous => canonicalJson(previous) === canonicalJson(grant))) continue;
      const project = this.project(ctx.store, grant.projectRoot, this.snapshot(ctx.now));
      if (project.activation.status !== 'unique' || !project.proposal || project.activation.entity.key !== grant.activationKey) reject('invalid_input', 'activation_mismatch');
      const reasons = validateExactGrant(grant, project.proposal.payload.plan, {
        projectRoot: project.root.key, activationKey: project.activation.entity.key,
        proposalKey: project.proposal.key, proposalHash: project.proposal.payload.proposalHash,
      }, root.key, ctx.now);
      if (reasons.length) validation(reasons);
      if ([root.key, project.root.key, project.activation.entity.key, project.proposal.key].some(key => ctx.store.records[key]!.expiresAt < grant.validUntil)) reject('invalid_input', 'grant_expired');
      const publishers = project.publishers.map(publisher => publisher.root.key === root.key
        ? { ...publisher, book: { status: 'unique' as const, entity: { ...ctx.store.records[keys[0]!]!.entity, payload: command.book } as EntityRecord<BookState> } }
        : publisher);
      const checked = independentlyValidatePlan(project.proposal.payload.plan, publishers, ctx.now); if (!checked.valid) validation(checked.reasons);
    }
    const book = this.create(ctx, command.book); this.consume(ctx, keys); return book;
  }
  async publishProposal(command: PublishProposalCommand): Promise<Result<MutationResult<EntityRecord<Proposal>>>> {
    return this.mutate(command, 'publish_proposal', ctx => {
      const project = this.project(ctx.store, command.projectRoot, this.snapshot(ctx.now)); this.owner(project.root, ctx.actor);
      if (project.state.status !== 'unique') reject('conflict', 'missing_state');
      if (project.state.entity.payload.lifecycle === 'closed') reject('conflict', 'closed_project');
      if (command.proposal.projectRoot !== project.root.key || command.proposal.plan.projectRoot !== project.root.key
        || command.proposal.plan.chainId !== null) reject('invalid_input', 'scope_mismatch');
      if (hashPlan(command.proposal.plan) !== command.proposal.proposalHash) reject('invalid_input', 'hash_mismatch');
      const admitted = project.state.entity.payload.publisherRoots;
      if (command.proposal.plan.requiredApprovers.some(key => !admitted.includes(key))) reject('invalid_input', 'scope_mismatch');
      if (canonicalJson(command.proposal.plan.predecessor) !== canonicalJson(this.predecessor(project))) reject('stale_heads', 'proposal_mismatch');
      const checked = independentlyValidatePlan(command.proposal.plan, project.publishers, ctx.now); if (!checked.valid) validation(checked.reasons);
      return this.create(ctx, command.proposal);
    });
  }
  async activateProposal(command: ActivateProposalCommand): Promise<Result<MutationResult<EntityRecord<PlanActivation>>>> {
    return this.mutate(command, 'activate_proposal', ctx => {
      const project = this.project(ctx.store, command.projectRoot, this.snapshot(ctx.now)); this.owner(project.root, ctx.actor);
      if (project.state.status !== 'unique' || project.state.entity.payload.lifecycle === 'closed') reject('conflict', 'closed_project');
      const keys = this.scopeKeys(project.activation); this.heads(keys, command.expectedActivationHeads);
      const proposal = this.get<Proposal>(ctx.store, command.proposalKey, 'proposal', ctx.now); this.owner(proposal, ctx.actor);
      if (proposal.payload.projectRoot !== command.projectRoot || proposal.payload.proposalHash !== command.proposalHash) reject('invalid_input', 'proposal_mismatch');
      if (canonicalJson(proposal.payload.plan.predecessor) !== canonicalJson(this.predecessor(project))) reject('stale_heads', 'proposal_mismatch');
      const checked = independentlyValidatePlan(proposal.payload.plan, project.publishers, ctx.now); if (!checked.valid) validation(checked.reasons);
      const activation = this.create<PlanActivation>(ctx, { ...this.base(ctx), entityType: 'plan_activation', projectRoot: command.projectRoot,
        proposalKey: proposal.key, proposalHash: proposal.payload.proposalHash, predecessorActivationKeys: keys });
      this.consume(ctx, keys); return activation;
    });
  }
  private link(ctx: MutationContext, link: ProjectLink): EntityRecord<ProjectLink> {
    const project = this.project(ctx.store, link.projectRoot, this.snapshot(ctx.now));
    const publisher = this.publisher(ctx.store, link.publisherRoot, this.snapshot(ctx.now));
    this.owner(link.linkKind === 'offer' ? publisher.root : project.root, ctx.actor);
    if (link.linkKind === 'offer') {
      if (publisher.book.status !== 'unique' || !link.offerIds.length
        || link.offerIds.some(id => publisher.book.status !== 'unique' || !publisher.book.entity.payload.offers.some(offer => offer.id === id && (!offer.projectScope.length || offer.projectScope.includes(project.root.key))))) reject('invalid_input', 'missing_offer');
    } else if (project.activation.status !== 'unique' || project.activation.entity.key !== link.activationKey
      || project.activation.entity.payload.proposalKey !== link.proposalKey || project.activation.entity.payload.proposalHash !== link.proposalHash
      || !project.proposal?.payload.plan.requiredApprovers.includes(link.publisherRoot)) reject('invalid_input', 'activation_mismatch');
    return this.create(ctx, link);
  }
  async publishProjectLink(command: PublishProjectLinkCommand): Promise<Result<MutationResult<EntityRecord<ProjectLink>>>> {
    return this.mutate(command, 'publish_project_link', ctx => this.link(ctx, command.link));
  }

  private child(parent: OperationIntent, kind: OperationKind, suffix: string, input: unknown): OperationIntent {
    if (parent.authority.mode !== 'local') reject('unauthorized', 'invalid_identity');
    return createLocalOperationIntent(kind, parent.authority.actor, input, { id: this.stepId(parent, suffix), now: parent.createdAt });
  }
  private stepId(parent: OperationIntent, suffix: string): string {
    return `step-${hashCanonical({ domain: 'partfolk/local-step', operationId: parent.id, suffix }).slice(2)}`;
  }
  private step(parent: OperationIntent, child: OperationIntent, phase: OperationIntent['phase'], receipt?: OperationReceipt, publisherRoot?: EntityKey): Result<void> {
    return this.result(() => {
      this.refresh(); const stage = copy(this.store), entry = stage.operations[parent.id]; if (!entry) reject('not_found');
      let step = entry.operation.steps.find(value => value.id === child.id);
      if (!step) {
        step = { id: child.id, phase, status: 'prepared', transactionHash: null, confirmedKeys: [],
          expectedHeads: child.expectedHeads, inputHash: child.inputHash, ...(publisherRoot ? { publisherRoot } : {}) };
        entry.operation.steps.push(step);
      } else if (step.inputHash !== child.inputHash) reject('conflict', 'hash_mismatch');
      if (receipt) {
        step.status = 'confirmed'; step.confirmedKeys = receipt.entityKeys;
        entry.operation.confirmedKeys = unique([...entry.operation.confirmedKeys, ...receipt.entityKeys]);
      }
      entry.operation.phase = phase; this.persist(stage);
    });
  }
  private progress(parent: OperationIntent, keys: EntityKey[], pending: EntityKey[], phase: OperationIntent['phase']): Result<OperationIntent> {
    return this.result(() => {
      this.refresh(); const stage = copy(this.store), entry = stage.operations[parent.id]; if (!entry) reject('not_found');
      entry.operation = { ...entry.operation, confirmedKeys: unique(keys), pendingPublisherRoots: pending, phase };
      if (phase === 'complete') entry.receipt = { operationId: parent.id, transactionHash: null, entityKeys: unique(keys),
        consumedKeys: unique(entry.operation.steps.flatMap(step => stage.operations[step.id]?.receipt?.consumedKeys ?? [])), blockNumber: null, confirmedAt: this.now() };
      this.persist(stage); return entry.operation;
    });
  }
  async publishPlan(command: PublishPlanCommand): Promise<Result<PublicationProgress>> {
    const started = this.result(() => this.begin(command, 'publish_plan')); if (!started.ok) return started;
    if (started.value.receipt) return ok({ operation: started.value.operation,
      proposalKey: started.value.operation.confirmedKeys[0] ?? null, activationKey: started.value.operation.confirmedKeys[1] ?? null,
      publishedRequestKeys: started.value.operation.confirmedKeys.slice(2), pendingPublisherRoots: [] });
    const parent = command.operation;
    if (!equalKeys(command.requestPublisherRoots, command.proposal.plan.requiredApprovers)) return {
      ok: false, error: { code: 'invalid_input', reasons: [{ code: 'scope_mismatch' }], retryable: false },
    };
    const proposalInput = { projectRoot: command.projectRoot, proposal: { ...command.proposal, operationId: this.stepId(parent, 'proposal') }, lifetimeSeconds: command.lifetimeSeconds };
    const proposalOperation = this.child(parent, 'publish_proposal', 'proposal', proposalInput);
    let step = this.step(parent, proposalOperation, 'proposal_pending'); if (!step.ok) return step;
    const published = await this.publishProposal({ ...proposalInput, operation: proposalOperation }); if (!published.ok) return published;
    step = this.step(parent, proposalOperation, 'proposal_confirmed', published.value.receipt); if (!step.ok) return step;
    const proposalKey = published.value.value.key;
    const activationInput = { projectRoot: command.projectRoot, expectedActivationHeads: command.expectedActivationHeads,
      proposalKey, proposalHash: command.proposal.proposalHash, lifetimeSeconds: command.lifetimeSeconds };
    const activationOperation = this.child(parent, 'activate_proposal', 'activation', activationInput);
    step = this.step(parent, activationOperation, 'activation_pending'); if (!step.ok) return step;
    const activated = await this.activateProposal({ ...activationInput, operation: activationOperation }); if (!activated.ok) return activated;
    step = this.step(parent, activationOperation, 'activation_confirmed', activated.value.receipt); if (!step.ok) return step;
    const activationKey = activated.value.value.key, requestKeys: EntityKey[] = [], pending = unique(command.requestPublisherRoots);
    let latest = this.progress(parent, [proposalKey, activationKey], pending, 'fanout_pending'); if (!latest.ok) return latest;
    for (const publisherRoot of [...pending]) {
      const suffix = `request:${publisherRoot}`;
      const link: ProjectLink = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'project_link', operationId: this.stepId(parent, suffix),
        createdAt: parent.createdAt, linkKind: 'request', projectRoot: command.projectRoot, publisherRoot, activationKey,
        proposalKey, proposalHash: command.proposal.proposalHash };
      const input = { link, lifetimeSeconds: command.lifetimeSeconds };
      const linkOperation = this.child(parent, 'publish_project_link', suffix, input);
      step = this.step(parent, linkOperation, 'fanout_pending', undefined, publisherRoot); if (!step.ok) return step;
      const result = await this.publishProjectLink({ ...input, operation: linkOperation });
      if (!result.ok) return result;
      step = this.step(parent, linkOperation, 'fanout_pending', result.value.receipt, publisherRoot); if (!step.ok) return step;
      requestKeys.push(result.value.value.key); pending.splice(pending.indexOf(publisherRoot), 1);
      latest = this.progress(parent, [proposalKey, activationKey, ...requestKeys], pending, pending.length ? 'fanout_pending' : 'complete'); if (!latest.ok) return latest;
    }
    if (!pending.length && latest.ok && latest.value.phase !== 'complete') latest = this.progress(parent, [proposalKey, activationKey, ...requestKeys], [], 'complete');
    if (!latest.ok) return latest;
    return ok({ operation: latest.value, proposalKey, activationKey, publishedRequestKeys: requestKeys, pendingPublisherRoots: [] });
  }
  async shareOffer(command: ShareOfferCommand): Promise<Result<MutationResult<EntityRecord<ProjectLink>>>> {
    const started = this.result(() => this.begin(command, 'share_offer')); if (!started.ok) return started;
    if (started.value.receipt) return ok({ value: copy(started.value.result) as EntityRecord<ProjectLink>, operation: started.value.operation, receipt: started.value.receipt });
    const parent = command.operation;
    const bookInput = { publisherRoot: command.publisherRoot, expectedHeads: command.expectedBookHeads,
      book: { ...command.book, operationId: this.stepId(parent, 'book') }, lifetimeSeconds: command.lifetimeSeconds };
    const bookOperation = this.child(parent, 'replace_book', 'book', bookInput);
    let step = this.step(parent, bookOperation, 'book_pending'); if (!step.ok) return step;
    const replaced = await this.replaceBook({ ...bookInput, operation: bookOperation }); if (!replaced.ok) return replaced;
    step = this.step(parent, bookOperation, 'book_confirmed', replaced.value.receipt); if (!step.ok) return step;
    const link: ProjectLink = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'project_link', operationId: this.stepId(parent, 'link'), createdAt: parent.createdAt,
      linkKind: 'offer', projectRoot: command.projectRoot, publisherRoot: command.publisherRoot, offerIds: command.offerIds };
    const linkInput = { link, lifetimeSeconds: command.lifetimeSeconds };
    const linkOperation = this.child(parent, 'publish_project_link', 'link', linkInput);
    step = this.step(parent, linkOperation, 'link_pending'); if (!step.ok) return step;
    const linked = await this.publishProjectLink({ ...linkInput, operation: linkOperation }); if (!linked.ok) return linked;
    step = this.step(parent, linkOperation, 'complete', linked.value.receipt); if (!step.ok) return step;
    return this.result(() => {
      this.refresh(); const stage = copy(this.store), entry = stage.operations[parent.id]!;
      entry.operation = { ...entry.operation, phase: 'complete', confirmedKeys: [replaced.value.value.key, linked.value.value.key] };
      entry.receipt = { ...linked.value.receipt, operationId: parent.id, entityKeys: entry.operation.confirmedKeys, consumedKeys: replaced.value.receipt.consumedKeys };
      entry.result = linked.value.value; this.persist(stage);
      return { value: linked.value.value, operation: entry.operation, receipt: entry.receipt };
    });
  }
  async renewEntity(command: RenewEntityCommand): Promise<Result<MutationResult<EntityRecord<EntityPayload>>>> {
    return this.mutate(command, 'renew_entity', ctx => {
      this.lifetime(command.extendBySeconds);
      const stored = ctx.store.records[command.entityKey]; if (!stored || stored.expiresAt <= ctx.now) reject('expired', 'expired');
      this.owner(stored.entity, ctx.actor); stored.expiresAt += command.extendBySeconds * 1000;
      if (!integer(stored.expiresAt)) reject('invalid_input');
      ctx.created.push(stored.entity.key); return stored.entity;
    });
  }
  async reconcile(operation: OperationIntent): Promise<Result<ReconciliationResult>> {
    return this.result(() => {
      this.refresh(); const entry = this.store.operations[operation.id];
      if (hashCanonical(operation.input) !== operation.inputHash || operation.authority.mode !== 'local' || !validLocalActor(operation.authority.actor)) reject('invalid_input', 'hash_mismatch');
      if (!entry) return { status: 'not_sent', operation };
      if (entry.operation.kind !== operation.kind || entry.operation.inputHash !== operation.inputHash || !sameActor(entry.operation.authority.actor, operation.authority.actor)) reject('conflict', 'hash_mismatch');
      if (entry.receipt) return { status: 'confirmed', operation: entry.operation, receipt: entry.receipt };
      const reconciled = copy(entry.operation);
      for (const step of reconciled.steps) {
        const receipt = this.store.operations[step.id]?.receipt;
        if (receipt) { step.status = 'confirmed'; step.confirmedKeys = receipt.entityKeys;
          reconciled.confirmedKeys = unique([...reconciled.confirmedKeys, ...receipt.entityKeys]); }
      }
      return { status: reconciled.confirmedKeys.length ? 'pending' : 'not_sent', operation: reconciled };
    });
  }
  async exportPacket(rootKey: EntityKey, options?: ReadOptions): Promise<Result<ExportPacket>> {
    return this.result(() => {
      this.refresh(options); const snapshot = this.snapshot(), project = this.project(this.store, rootKey, snapshot);
      return { format: 'partfolk-export', version: 1, exportedAt: snapshot.fetchedAt, mode: 'local', project,
        readiness: deriveReadiness(project, snapshot.blockTimestamp), snapshot };
    });
  }
}
export const createLocalRepository = (options: LocalRepositoryOptions = {}): LocalRepository => new LocalRepository(options);
