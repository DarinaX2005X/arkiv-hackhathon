import type { Entity } from '@arkiv-network/sdk';
import { i32, key } from '@arkiv-network/sdk/attr';
import { eq, QueryError } from '@arkiv-network/sdk/query';
import type { Expression, QueryResult } from '@arkiv-network/sdk/query';
import type {
  AccountAddress, Actor, BookState, DomainReason, EntityKey, EntityPayload, EntityRecord,
  EntityType, PlanActivation, ProjectAggregate, ProjectLink, ProjectRoot, ProjectState,
  Proposal, PublisherAggregate, PublisherRoot, ScopeState, Snapshot, SourcePlanRef,
} from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { hashCanonical } from '../../domain/canonical';
import type { DiscoveryLink, ListResult, ProjectSummary, ReadOptions } from '../types';
import { createArkivReadClient } from './client';
import type { ArkivReadClient, RpcRequest } from './client';
import { ArkivRepositoryError, assertArkiv, readResponseTooLarge, repositoryError } from './errors';
import { creatorOf, decodeEntity, ENTITY_SELECTION, NAMESPACE, publicAddress, publicKey, sameIdentity } from './envelope';

export const REFRESH_INTERVAL_MS = 15_000;
export const MAX_CONFIDENCE_AGE_MS = 60_000;
export interface ReaderPolicy { maxPages: number; maxEntities: number; maxPublishers: number; pageSize: number; cursorRestarts: number }
export interface ReadContext {
  snapshot: Snapshot; options: ReadOptions; pages: number; entities: number;
  client: ArkivReadClient; cache: Map<string, EntityRecord>; publishers: Map<string, PublisherAggregate>;
}
export interface ArkivReaderOptions { request?: RpcRequest; now?: () => number; policy?: Partial<ReaderPolicy> }
const DEFAULT_POLICY: ReaderPolicy = { maxPages: 160, maxEntities: 4_000, maxPublishers: 50, pageSize: 100, cursorRestarts: 1 };

export class ArkivReader {
  readonly client: ArkivReadClient;
  readonly request: RpcRequest;
  readonly now: () => number;
  readonly policy: ReaderPolicy;
  private readonly createScopedClient: (signal?: AbortSignal) => ArkivReadClient;
  constructor(options: ArkivReaderOptions = {}) {
    const boundary = createArkivReadClient(options.request);
    this.client = boundary.client; this.request = boundary.request; this.now = options.now ?? Date.now;
    this.createScopedClient = boundary.createScopedClient;
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    assertArkiv(Object.values(this.policy).every(value => Number.isSafeInteger(value) && value >= 0)
      && this.policy.maxPages > 0 && this.policy.maxEntities > 0 && this.policy.maxPublishers > 0
      && this.policy.pageSize > 0 && this.policy.pageSize <= 200 && this.policy.cursorRestarts <= 2,
      'invalid_input', 'invalid_input', 'Invalid Arkiv reader bounds.');
  }

  async context(options: ReadOptions = {}): Promise<ReadContext> {
    this.checkAbort(options);
    // Each traversal owns its SDK request closure; concurrent reads never share a mutable signal
    // or viem's per-client in-flight header deduplication. The endpoint policy remains shared.
    const client = this.createScopedClient(options.signal);
    assertArkiv(await client.getChainId() === TIRAMISU_CHAIN_ID, 'wrong_chain', 'invalid_identity', 'The RPC is not Arkiv Tiramisu.');
    this.checkAbort(options);
    let snapshot: Snapshot;
    if (options.snapshot) {
      snapshot = structuredClone(options.snapshot);
      assertArkiv(snapshot.mode === 'public' && snapshot.source === 'arkiv' && snapshot.chainId === TIRAMISU_CHAIN_ID
        && typeof snapshot.blockNumber === 'string' && /^\d+$/.test(snapshot.blockNumber)
        && snapshot.blockHash !== null, 'invalid_input', 'invalid_identity', 'A public snapshot with an exact block and hash is required.');
      const block = await client.getBlock({ blockNumber: BigInt(snapshot.blockNumber) });
      this.checkAbort(options);
      assertArkiv(block.hash === snapshot.blockHash && Number(block.timestamp * 1_000n) === snapshot.blockTimestamp,
        'unverified', 'incomplete_snapshot', 'The requested snapshot is no longer canonical.');
    } else {
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      this.checkAbort(options);
      const block = await client.getBlock({ blockNumber });
      this.checkAbort(options);
      const timestamp = Number(block.timestamp * 1_000n);
      assertArkiv(block.number === blockNumber && block.hash !== null && Number.isSafeInteger(timestamp),
        'unverified', 'incomplete_snapshot', 'The provider did not return a canonical block.');
      const fetchedAt = this.now();
      assertArkiv(fetchedAt - timestamp <= MAX_CONFIDENCE_AGE_MS, 'unverified', 'stale_snapshot',
        'The latest Arkiv block is too old to verify current availability or agreement.');
      snapshot = { mode: 'public', source: 'arkiv', chainId: TIRAMISU_CHAIN_ID, blockNumber: blockNumber.toString() as `${bigint}`,
        blockHash: block.hash, blockTimestamp: timestamp, fetchedAt, completeness: 'complete', freshness: 'fresh', reasons: [] };
    }
    return { snapshot, options, client, pages: 0, entities: 0, cache: new Map(), publishers: new Map() };
  }

  checkAbort(options: ReadOptions): void {
    assertArkiv(!options.signal?.aborted, 'unverified', 'incomplete_snapshot', 'This read was cancelled; no partial snapshot is current.');
  }
  async finish(context: ReadContext): Promise<Snapshot> {
    this.checkAbort(context.options);
    const block = await context.client.getBlock({ blockNumber: BigInt(context.snapshot.blockNumber!) });
    this.checkAbort(context.options);
    assertArkiv(block.hash === context.snapshot.blockHash, 'unverified', 'incomplete_snapshot', 'The chain changed while this snapshot was being read.');
    const now = this.now();
    // Explicit snapshots also serve historical and receipt verification. Their block age
    // does not limit historical truth; a current head must remain recent for the whole walk.
    if (now - context.snapshot.fetchedAt > MAX_CONFIDENCE_AGE_MS
      || (!context.options.snapshot && now - context.snapshot.blockTimestamp > MAX_CONFIDENCE_AGE_MS)) {
      context.snapshot.freshness = 'stale';
      if (!context.snapshot.reasons.some(reason => reason.code === 'stale_snapshot')) context.snapshot.reasons.push({ code: 'stale_snapshot' });
    }
    return context.snapshot;
  }

  /** Every page is charged, including failed cursor attempts. A failure never returns accumulated rows. */
  async query(context: ReadContext, predicates: Expression[], creator?: AccountAddress,
    stopAfterTwo = false): Promise<Entity[]> {
    const block = BigInt(context.snapshot.blockNumber!);
    let pageSize = stopAfterTwo ? 2 : this.policy.pageSize, cursorRestarts = 0;
    for (;;) {
      const rows: Entity[] = []; const seenKeys = new Set<string>(); const seenCursors = new Set<string>();
      try {
        const builder = context.client.select(ENTITY_SELECTION).where(predicates).atBlock(block)
          .limit(pageSize);
        if (creator) builder.createdBy(creator);
        let next: (() => Promise<QueryResult<unknown>>) | undefined = () => builder.fetch();
        while (next) {
          this.checkAbort(context.options);
          assertArkiv(context.pages < this.policy.maxPages, 'incomplete', 'page_budget', 'The scoped read exceeded its page budget. No partial list is authoritative.');
          context.pages++;
          const page = await next();
          this.checkAbort(context.options);
          assertArkiv(page.blockNumber === block, 'unverified', 'incomplete_snapshot', 'A query page belongs to a different block.');
          for (const unknownRow of page.entities) {
            const row = unknownRow as Entity;
            const rowKey = publicKey(row.key);
            assertArkiv(!seenKeys.has(rowKey), 'unverified', 'incomplete_snapshot', 'The provider repeated an entity across pages.');
            seenKeys.add(rowKey); rows.push(row); context.entities++;
            assertArkiv(context.entities <= this.policy.maxEntities, 'incomplete', 'page_budget', 'The read exceeded its entity budget.');
          }
          if (stopAfterTwo && rows.length >= 2) return rows.slice(0, 2);
          if (!page.hasNextPage()) break;
          assertArkiv(typeof page.cursor === 'string' && page.cursor.length > 0 && !seenCursors.has(page.cursor),
            'incomplete', 'cursor_error', 'The provider returned an invalid or repeated cursor.');
          seenCursors.add(page.cursor);
          next = () => page.next();
        }
        return rows;
      } catch (error) {
        this.checkAbort(context.options);
        if (readResponseTooLarge(error)) {
          assertArkiv(pageSize > 1, 'incomplete', 'payload_too_large', 'A public record exceeds the reading service response limit. No partial list is current.');
          pageSize = Math.max(1, Math.floor(pageSize / 2));
        } else if (error instanceof QueryError && error.kind === 'cursor' && cursorRestarts < this.policy.cursorRestarts) cursorRestarts++;
        else throw error;
        // Restart the entire scoped walk at this aggregate's original block, never mix snapshots.
        // Failed pages and previously decoded rows stay charged to the aggregate's global budget.
      }
    }
  }

  base(type: EntityType): Expression[] {
    return [eq('project', NAMESPACE), eq('entity_type', type), eq('schema_version', i32(1))];
  }

  async entity<T extends EntityPayload>(context: ReadContext, entityKey: EntityKey, type: T['entityType'], creator?: AccountAddress): Promise<EntityRecord<T> | null> {
    const target = publicKey(entityKey);
    const cached = context.cache.get(target);
    if (cached) {
      assertArkiv(cached.payload.entityType === type && (!creator || sameIdentity(creatorOf(cached), creator)),
        'unverified', 'foreign_author', 'An entity reference has conflicting expected authority or type.');
      return cached as EntityRecord<T>;
    }
    // Exact key queries do not filter away malformed namespace/type/creator evidence.
    const rows = await this.query(context, [eq('$key', key(target))], undefined, true);
    assertArkiv(rows.length <= 1, 'unverified', 'incomplete_snapshot', 'An exact key query returned multiple entities.');
    if (!rows[0]) return null;
    const record = decodeEntity<T>(rows[0], type, context.snapshot, creator, target);
    context.cache.set(target, record); return record;
  }

  async scope<T extends ProjectState | BookState | PlanActivation>(context: ReadContext, type: T['entityType'],
    rootKey: EntityKey, creator: AccountAddress): Promise<ScopeState<T>> {
    const attribute = type === 'book_state' ? 'book_key' : 'project_key';
    // Do not filter schema_version: malformed authored heads must not disappear behind a valid one.
    // A publisher must be able to review every fork before consuming the complete set.
    // The same explicit page/entity budgets still fail closed for oversized scopes.
    const rows = await this.query(context, [eq('project', NAMESPACE), eq('entity_type', type), eq(attribute, key(publicKey(rootKey)))], creator, type !== 'book_state');
    if (!rows.length) return { status: 'missing', reason: 'expired_or_deleted' };
    const records: EntityRecord<T>[] = []; const invalid: DomainReason[] = [];
    for (const row of rows) {
      try { records.push(decodeEntity<T>(row, type, context.snapshot, creator)); }
      catch (error) { invalid.push(...repositoryError(error).reasons); }
    }
    if (invalid.length) return { status: 'unverified', reasons: [...(rows.length > 1 ? [{ code: 'conflicting_heads' } as DomainReason] : []), ...invalid] };
    if (records.length > 1) return { status: 'conflict', entities: records };
    return { status: 'unique', entity: records[0]! };
  }

  async publisher(context: ReadContext, rootKey: EntityKey): Promise<PublisherAggregate> {
    const target = publicKey(rootKey); const cached = context.publishers.get(target);
    if (cached) return cached;
    const root = await this.entity<PublisherRoot>(context, target, 'publisher_root');
    assertArkiv(root, 'not_found', 'missing_root', 'The publisher root is unavailable at this block.');
    const aggregate: PublisherAggregate = { root, book: await this.scope<BookState>(context, 'book_state', target, creatorOf(root)), snapshot: context.snapshot };
    context.publishers.set(target, aggregate); return aggregate;
  }

  async project(context: ReadContext, rootKey: EntityKey): Promise<ProjectAggregate> {
    const target = publicKey(rootKey);
    const root = await this.entity<ProjectRoot>(context, target, 'project_root');
    assertArkiv(root, 'not_found', 'missing_root', 'The project root is unavailable at this block.');
    const creator = creatorOf(root);
    const state = await this.scope<ProjectState>(context, 'project_state', target, creator);
    const activation = await this.scope<PlanActivation>(context, 'plan_activation', target, creator);
    let proposal: EntityRecord<Proposal> | null = null;
    if (activation.status === 'unique') {
      proposal = await this.entity<Proposal>(context, activation.entity.payload.proposalKey, 'proposal', creator);
      if (proposal) assertArkiv(sameIdentity(proposal.payload.projectRoot, target)
        && sameIdentity(proposal.payload.proposalHash, activation.entity.payload.proposalHash), 'unverified', 'proposal_mismatch', 'The active proposal does not match its activation.');
    }
    const publishers: PublisherAggregate[] = [];
    if (state.status === 'unique') {
      assertArkiv(state.entity.payload.publisherRoots.length <= this.policy.maxPublishers, 'incomplete', 'page_budget', 'The project exceeds the configured participant read budget.');
      for (const publisherRoot of state.entity.payload.publisherRoots) {
        try { publishers.push(await this.publisher(context, publisherRoot)); }
        catch (error) {
          if (!(error instanceof ArkivRepositoryError && ['not_found', 'unverified', 'expired', 'invalid_input'].includes(error.detail.code))) throw error;
          context.snapshot.completeness = 'incomplete'; context.snapshot.reasons.push(...error.detail.reasons);
        }
      }
    }
    const history = await this.proposalChain(context, target, creator, proposal,
      state.status === 'unique' ? state.entity.payload.completion?.source ?? null : null);
    return { root, state, activation, proposal, proposalHistory: history.records, proposalHistoryStatus: history.status,
      publishers, snapshot: context.snapshot };
  }

  /** Current verification does not depend on retaining unrelated old proposals. Gaps stay explicit and separate. */
  async proposalChain(context: ReadContext, projectRoot: EntityKey, creator: AccountAddress,
    active: EntityRecord<Proposal> | null, historicalSource: SourcePlanRef | null): Promise<{
      records: EntityRecord<Proposal>[]; status: { complete: boolean; reasons: DomainReason[] };
    }> {
    const records: EntityRecord<Proposal>[] = []; const reasons: DomainReason[] = []; const seen = new Set<string>();
    let current = active;
    try {
      if (!current && historicalSource) {
        assertArkiv(sameIdentity(historicalSource.projectRoot, projectRoot), 'unverified', 'scope_mismatch', 'The recorded history belongs to another project.');
        current = await this.entity<Proposal>(context, historicalSource.proposalKey, 'proposal', creator);
        assertArkiv(current && sameIdentity(current.payload.proposalHash, historicalSource.proposalHash),
          'unverified', 'evidence_unavailable', 'The recorded source proposal is unavailable.');
      }
      while (current) {
        assertArkiv(records.length < 32, 'incomplete', 'page_budget', 'The proposal history exceeds the bounded lineage depth.');
        assertArkiv(!seen.has(current.key), 'unverified', 'invalid_schema', 'The proposal history contains a cycle.');
        assertArkiv(sameIdentity(current.payload.projectRoot, projectRoot), 'unverified', 'scope_mismatch', 'The proposal history crosses project identities.');
        seen.add(current.key); records.push(current);
        const predecessor = current.payload.plan.predecessor;
        if (!predecessor) break;
        assertArkiv(sameIdentity(predecessor.projectRoot, projectRoot), 'unverified', 'scope_mismatch', 'The predecessor names another project.');
        const prior = await this.entity<Proposal>(context, predecessor.proposalKey, 'proposal', creator);
        assertArkiv(prior && sameIdentity(prior.payload.proposalHash, predecessor.proposalHash),
          'unverified', 'evidence_unavailable', 'A predecessor proposal is missing, expired or mismatched.');
        assertArkiv(BigInt(prior.provenance.createdAtBlock!) <= BigInt(current.provenance.createdAtBlock!),
          'unverified', 'invalid_schema', 'A predecessor was created after its successor.');
        current = prior;
      }
    } catch (error) {
      reasons.push(...repositoryError(error).reasons.map(reason => ({ ...reason, path: 'proposalHistory' })));
    }
    return { records: records.reverse(), status: { complete: reasons.length === 0, reasons } };
  }

  async loadProject(rootKey: EntityKey, options: ReadOptions = {}): Promise<ProjectAggregate> {
    const context = await this.context(options); const result = await this.project(context, rootKey); await this.finish(context); return result;
  }
  async loadPublisher(rootKey: EntityKey, options: ReadOptions = {}): Promise<PublisherAggregate> {
    const context = await this.context(options); const result = await this.publisher(context, rootKey); await this.finish(context); return result;
  }
  walletActor(actor: Actor): AccountAddress {
    assertArkiv(actor.kind === 'wallet', 'invalid_input', 'invalid_identity', 'A public listing requires a wallet identity.');
    return publicAddress(actor.address);
  }

  async listProjects(actor: Actor, options: ReadOptions = {}): Promise<ListResult<ProjectSummary>> {
    const account = this.walletActor(actor); const context = await this.context(options);
    const rows = await this.query(context, this.base('project_root'), account);
    const items: ProjectSummary[] = []; const diagnostics: DomainReason[] = [];
    for (const row of rows) {
      try {
        const root = decodeEntity<ProjectRoot>(row, 'project_root', context.snapshot, account);
        const state = await this.scope<ProjectState>(context, 'project_state', root.key, account);
        const reasons: DomainReason[] = state.status === 'unique' ? [] : state.status === 'unverified' ? state.reasons
          : [{ code: state.status === 'conflict' ? 'conflicting_heads' : 'missing_state' }];
        items.push({ root, state: state.status === 'unique' ? state.entity.payload : null, diagnostics: reasons });
      } catch (error) {
        if (!(error instanceof ArkivRepositoryError && ['unverified', 'invalid_input', 'expired'].includes(error.detail.code))) throw error;
        diagnostics.push(...error.detail.reasons);
      }
    }
    await this.finish(context); return { items, snapshot: context.snapshot, diagnostics };
  }
  async listOwnPublishers(actor: Actor, options: ReadOptions = {}): Promise<ListResult<PublisherAggregate>> {
    const account = this.walletActor(actor); const context = await this.context(options);
    const rows = await this.query(context, this.base('publisher_root'), account);
    const items: PublisherAggregate[] = []; const diagnostics: DomainReason[] = [];
    for (const row of rows) {
      try {
        const root = decodeEntity<PublisherRoot>(row, 'publisher_root', context.snapshot, account);
        context.cache.set(publicKey(root.key), root); items.push(await this.publisher(context, root.key));
      } catch (error) {
        if (!(error instanceof ArkivRepositoryError && ['unverified', 'invalid_input', 'expired'].includes(error.detail.code))) throw error;
        diagnostics.push(...error.detail.reasons);
      }
    }
    await this.finish(context); return { items, snapshot: context.snapshot, diagnostics };
  }

  async links(kind: 'offer' | 'request', rootKey: EntityKey, options: ReadOptions = {}): Promise<ListResult<DiscoveryLink>> {
    const target = publicKey(rootKey); const context = await this.context(options);
    if (kind === 'offer') assertArkiv(await this.entity<ProjectRoot>(context, target, 'project_root'), 'not_found', 'missing_root', 'The project root is unavailable.');
    else await this.publisher(context, target);
    const rows = await this.query(context, this.base('project_link').concat(eq('link_kind', kind), eq(kind === 'offer' ? 'project_key' : 'publisher_key', key(target))));
    const items: DiscoveryLink[] = []; const diagnostics: DomainReason[] = []; const identities = new Set<string>();
    for (const row of rows) {
      try {
        const link = decodeEntity<ProjectLink>(row, 'project_link', context.snapshot);
        const publisher = await this.publisher(context, link.payload.publisherRoot);
        const projectRoot = await this.entity<ProjectRoot>(context, link.payload.projectRoot, 'project_root');
        assertArkiv(projectRoot, 'unverified', 'missing_root', 'The discovery link references an unavailable project.');
        const expected = link.payload.linkKind === 'offer' ? creatorOf(publisher.root) : creatorOf(projectRoot);
        assertArkiv(sameIdentity(creatorOf(link), expected), 'unverified', 'foreign_author', 'The discovery hint was not authored by its required root authority.');
        assertArkiv(link.payload.linkKind === kind && sameIdentity(kind === 'offer' ? link.payload.projectRoot : link.payload.publisherRoot, target),
          'unverified', 'projection_mismatch', 'The discovery link is in the wrong scope.');
        let status: DiscoveryLink['status'] = 'current'; const linkDiagnostics: DomainReason[] = [];
        if (link.payload.linkKind === 'request') {
          const activation = await this.scope<PlanActivation>(context, 'plan_activation', link.payload.projectRoot, expected);
          if (activation.status !== 'unique' || !sameIdentity(activation.entity.key, link.payload.activationKey)) {
            status = 'historical'; linkDiagnostics.push({ code: activation.status === 'conflict' ? 'conflicting_heads' : 'activation_mismatch' });
          } else {
            assertArkiv(sameIdentity(activation.entity.payload.proposalKey, link.payload.proposalKey)
              && sameIdentity(activation.entity.payload.proposalHash, link.payload.proposalHash), 'unverified', 'proposal_mismatch', 'The request does not match its activation.');
          }
        } else if (publisher.book.status !== 'unique') {
          linkDiagnostics.push({ code: publisher.book.status === 'conflict' ? 'conflicting_heads' : 'missing_state' });
        } else if (link.payload.offerIds.some(id => {
          const book = publisher.book;
          return book.status !== 'unique' || !book.entity.payload.offers.some(offer => offer.id === id
            && (offer.projectScope.length === 0 || offer.projectScope.includes(link.payload.projectRoot)));
        })) {
          status = 'historical'; linkDiagnostics.push({ code: 'missing_offer' });
        }
        const { operationId: _operationId, createdAt: _createdAt, ...semantic } = link.payload;
        const identity = hashCanonical(semantic);
        if (identities.has(identity)) continue;
        identities.add(identity); items.push({ entity: link, status, publisher, diagnostics: linkDiagnostics });
      } catch (error) {
        if (!(error instanceof ArkivRepositoryError && ['unverified', 'invalid_input', 'not_found', 'expired'].includes(error.detail.code))) throw error;
        diagnostics.push(...error.detail.reasons);
      }
    }
    await this.finish(context); return { items, snapshot: context.snapshot, diagnostics };
  }
}
