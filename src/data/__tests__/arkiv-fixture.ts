import { stringToHex, toHex } from 'viem';
import { hashOffer, hashPlan, hashRequirements } from '../../domain/canonical';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from '../../domain/types';
import type {
  AccountAddress, BookState, EntityPayload, Offer, PlanActivation, PlanDocument,
  ProjectLink, ProjectRoot, ProjectState, Proposal, PublicEntityKey, PublisherRoot,
  SourcePlanRef,
} from '../../domain/types';
import type { RpcRequest } from '../arkiv/client';

export const NOW = Date.parse('2026-10-09T12:00:00.000Z');
export const COORDINATOR: AccountAddress = `0x${'11'.repeat(20)}`;
export const PUBLISHER: AccountAddress = `0x${'22'.repeat(20)}`;
export const STRANGER: AccountAddress = `0x${'33'.repeat(20)}`;
export const entityKey = (number: number): PublicEntityKey => `0x${number.toString(16).padStart(64, '0')}`;
export const KEYS = {
  project: entityKey(1), state: entityKey(2), publisher: entityKey(3), book: entityKey(4),
  proposal: entityKey(5), activation: entityKey(6), offerLink: entityKey(7), requestLink: entityKey(8),
};
export const BLOCK_HASH = entityKey(1000);

/** Actual SDK 0.8.1 JSON-RPC shapes, deliberately independent from the production envelope encoder. */
export interface RawAttribute { name: string; type: string; value: string | number | boolean }
export interface RawEntity {
  key: PublicEntityKey; creator: AccountAddress; owner: AccountAddress;
  createdAt: `0x${string}`; expiresAt: `0x${string}`; creationFlags: number;
  contentType: string; payload: `0x${string}`; attributes: RawAttribute[];
}
export interface RawPage { data: RawEntity[]; blockNumber: `0x${string}`; cursor?: string }
export interface QueryCall {
  query: string;
  options: { atBlock: string; limit: string; cursor?: string; select: Record<string, unknown> };
}
export const basePayload = (operationId: string) => ({ protocol: PROTOCOL, schemaVersion: 1 as const, operationId, createdAt: NOW - 1_000 });

export function rawEntity(entityKey: PublicEntityKey, payload: EntityPayload, creator: AccountAddress,
  overrides: Partial<RawEntity> = {}): RawEntity {
  const attributes: RawAttribute[] = [
    { name: 'project', type: 'str', value: 'partfolk' },
    { name: 'schema_version', type: 'i32', value: 1 },
    { name: 'entity_type', type: 'str', value: payload.entityType },
    { name: 'created_at', type: 'u64', value: toHex(payload.createdAt) },
    { name: 'operation_id', type: 'str', value: payload.operationId },
  ];
  const add = (name: string, type: string, value: string) => attributes.push({ name, type, value });
  if ('projectRoot' in payload) add('project_key', 'key', payload.projectRoot);
  if (payload.entityType === 'book_state') add('book_key', 'key', payload.publisherRoot);
  if (payload.entityType === 'proposal') {
    add('requirements_hash', 'bytes32', payload.requirementsHash);
    add('proposal_hash', 'bytes32', payload.proposalHash);
  }
  if (payload.entityType === 'plan_activation') add('proposal_key', 'key', payload.proposalKey);
  if (payload.entityType === 'project_link') {
    add('link_kind', 'str', payload.linkKind);
    add('publisher_key', 'key', payload.publisherRoot);
    if (payload.linkKind === 'request') add('activation_key', 'key', payload.activationKey);
  }
  return { key: entityKey, creator, owner: creator, createdAt: toHex(80), expiresAt: toHex(10_000),
    creationFlags: 1, contentType: 'application/json', payload: stringToHex(JSON.stringify(payload)), attributes, ...overrides };
}

function matches(row: RawEntity, query: string): boolean {
  // This fixture accepts only the SDK's rendered equality subset. No eval or broad pseudo-query fallback.
  const predicates = [...query.matchAll(/(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(str|i32|key|addr)\((?:'((?:[^']|'')*)'|(0x[0-9a-fA-F]+|-?\d+))\)/g)];
  const remainder = query.replace(/(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(str|i32|key|addr)\((?:'((?:[^']|'')*)'|(0x[0-9a-fA-F]+|-?\d+))\)/g, '').replace(/\bAND\b|[()\s]/g, '');
  if (!predicates.length || remainder) throw new Error(`Fixture does not implement this query: ${query}`);
  return predicates.every(([, name, type, quoted, scalar]) => {
    const expected = type === 'str' ? quoted!.replace(/''/g, "'") : type === 'i32' ? Number(scalar) : scalar!.toLowerCase();
    const actual = name === '$key' ? { type: 'key', value: row.key }
      : name === '$creator' ? { type: 'addr', value: row.creator }
      : row.attributes.find(attribute => attribute.name === name);
    const value = actual && ['addr', 'key'].includes(actual.type) ? String(actual.value).toLowerCase() : actual?.value;
    return actual?.type === type && value === expected;
  });
}

/** An in-memory RPC provider: all production SDK decoding and query building still execute. */
export class ReadRpcFixture {
  rows: RawEntity[];
  block = 100;
  timestamp = NOW;
  chainId = TIRAMISU_CHAIN_ID as number;
  blockHash = BLOCK_HASH;
  pageSize = 200;
  readonly calls: { method: string; params?: readonly unknown[] | object }[] = [];
  readonly queries: QueryCall[] = [];
  queryOverride?: (call: QueryCall, response: RawPage) => RawPage | undefined;
  blockOverride?: (callNumber: number) => Partial<{ hash: string; number: string; timestamp: string }>;
  failure?: Error;
  private blockCalls = 0;
  private readonly cursors = new Map<string, { binding: string; offset: number }>();
  constructor(rows: RawEntity[] = []) { this.rows = structuredClone(rows); }

  row(key: PublicEntityKey): RawEntity {
    const row = this.rows.find(candidate => candidate.key === key);
    if (!row) throw new Error(`No fixture entity ${key}`);
    return row;
  }
  remove(key: PublicEntityKey): void { this.rows = this.rows.filter(row => row.key !== key); }
  put(row: RawEntity): void { this.remove(row.key); this.rows.push(structuredClone(row)); }
  update(key: PublicEntityKey, payload: EntityPayload): void {
    const old = this.row(key);
    this.put(rawEntity(key, payload, old.creator, { owner: old.owner, createdAt: old.createdAt, expiresAt: old.expiresAt, creationFlags: old.creationFlags }));
  }

  readonly request: RpcRequest = async args => {
    this.calls.push(structuredClone(args));
    if (this.failure) throw this.failure;
    if (args.method === 'eth_chainId') return toHex(this.chainId);
    if (args.method === 'eth_blockNumber') return toHex(this.block);
    if (args.method === 'eth_getBlockByNumber') {
      return { number: toHex(this.block), hash: this.blockHash, timestamp: toHex(this.timestamp / 1_000), transactions: [],
        ...this.blockOverride?.(++this.blockCalls) };
    }
    if (args.method !== 'arkiv_query') throw new Error(`Fixture forbids RPC method ${args.method}`);
    if (!Array.isArray(args.params) || typeof args.params[0] !== 'string') throw new Error('Invalid query parameters');
    const call = { query: args.params[0], options: args.params[1] } as QueryCall;
    if (!call.options?.atBlock || !call.options.select) throw new Error('Every query must pin its block and select an envelope');
    this.queries.push(structuredClone(call));
    const binding = JSON.stringify([call.query, call.options.atBlock, call.options.select, call.options.limit]);
    const cursor = call.options.cursor ? this.cursors.get(call.options.cursor) : undefined;
    if (call.options.cursor && (!cursor || cursor.binding !== binding)) throw Object.assign(new Error('Invalid fixture cursor'), { code: -32005 });
    const offset = cursor?.offset ?? 0;
    const block = BigInt(call.options.atBlock);
    const found = this.rows.filter(row => BigInt(row.createdAt) <= block && BigInt(row.expiresAt) > block && matches(row, call.query));
    const size = Math.min(this.pageSize, Number(BigInt(call.options.limit)));
    const response: RawPage = { data: structuredClone(found.slice(offset, offset + size)), blockNumber: toHex(block) };
    if (offset + size < found.length) {
      response.cursor = `fixture-cursor-${this.cursors.size + 1}`;
      this.cursors.set(response.cursor, { binding, offset: offset + size });
    }
    return this.queryOverride?.(call, response) ?? response;
  };
}

export function readyFixture() {
  const interval = { start: NOW + 3_600_000, end: NOW + 7_200_000 };
  const offer: Offer = { id: 'host', title: 'Host the workshop', resourceId: 'self', kind: 'person', unit: 'person', quantity: 1,
    capabilities: ['hosting'], availability: [interval], projectScope: [KEYS.project], conditions: [], instructions: 'Welcome the visitors.' };
  const offerHash = hashOffer(KEYS.publisher, offer);
  const root: ProjectRoot = { ...basePayload('project-root'), entityType: 'project_root', coordinator: { kind: 'wallet', address: COORDINATOR } };
  const publisher: PublisherRoot = { ...basePayload('publisher-root'), entityType: 'publisher_root', kind: 'individual', publisher: { kind: 'wallet', address: PUBLISHER } };
  const plan: PlanDocument = {
    protocol: PROTOCOL, validationVersion: 1, chainId: TIRAMISU_CHAIN_ID, projectRoot: KEYS.project,
    outcome: 'One hosted workshop', variant: { id: 'morning', title: 'Workshop', venueId: 'library', timeZone: 'UTC',
      requirements: [{ id: 'hosting', title: 'Welcome visitors', kind: 'person', capability: 'hosting', unit: 'person', quantity: 1, interval, instructions: 'Welcome the visitors.', dependsOn: [] }], instructions: 'Use the front entrance.' },
    offers: [{ publisherRoot: KEYS.publisher, offerId: offer.id, offerHash }],
    resourceAssumptions: [{ publisherRoot: KEYS.publisher, resourceId: 'self', capacity: 1, unit: 'person' }],
    allocations: [{ id: 'host-allocation', requirementId: 'hosting', publisherRoot: KEYS.publisher, offerId: offer.id, offerHash, resourceId: 'self', quantity: 1, unit: 'person', interval }],
    requiredApprovers: [KEYS.publisher], conditions: [], instructions: 'Host the scheduled workshop.',
    runbook: [{ kind: 'task', id: 'welcome', title: 'Welcome visitors', publisherRoot: KEYS.publisher, interval, allocationIds: ['host-allocation'], dependsOn: [], instructions: 'Welcome the visitors.' }], predecessor: null,
  };
  const proposal: Proposal = { ...basePayload('proposal-1'), entityType: 'proposal', projectRoot: KEYS.project,
    requirementsHash: hashRequirements(KEYS.project, plan.variant.requirements), proposalHash: hashPlan(plan), plan, changeExplanation: 'Initial proposal.' };
  const source: SourcePlanRef = { projectRoot: KEYS.project, activationKey: KEYS.activation, proposalKey: KEYS.proposal, proposalHash: proposal.proposalHash };
  const activation: PlanActivation = { ...basePayload('activation-1'), entityType: 'plan_activation', projectRoot: KEYS.project,
    proposalKey: KEYS.proposal, proposalHash: proposal.proposalHash, predecessorActivationKeys: [] };
  const state: ProjectState = { ...basePayload('project-state'), entityType: 'project_state', projectRoot: KEYS.project, predecessorKeys: [],
    recipe: { title: 'Workshop', outcome: plan.outcome, timeZone: 'UTC', variants: [plan.variant], instructions: plan.instructions },
    publisherRoots: [KEYS.publisher], lifecycle: 'planning', completedWork: [], completion: null };
  const book: BookState = { ...basePayload('book-state'), entityType: 'book_state', publisherRoot: KEYS.publisher, predecessorKeys: [], name: 'Host', description: 'Workshop host',
    resources: [{ id: 'self', name: 'My time', kind: 'person', unit: 'person', capacity: 1, availability: [interval], capabilities: ['hosting'] }], offers: [offer],
    decisions: [{ ...source, status: 'accepted', decidedAt: NOW - 500, operationId: 'accept-1' }],
    grants: [{ ...source, id: 'grant-1', protocol: PROTOCOL, chainId: TIRAMISU_CHAIN_ID, offers: plan.offers, allocations: plan.allocations,
      validUntil: NOW + 10_800_000, acceptedAt: NOW - 500, operationId: 'accept-1' }], attestations: [], custodyHolds: [], retentionDays: 90 };
  const offerLink: ProjectLink = { ...basePayload('offer-link'), entityType: 'project_link', linkKind: 'offer', projectRoot: KEYS.project, publisherRoot: KEYS.publisher, offerIds: ['host'] };
  const requestLink: ProjectLink = { ...basePayload('request-link'), entityType: 'project_link', linkKind: 'request', ...source, publisherRoot: KEYS.publisher };
  const rpc = new ReadRpcFixture([
    rawEntity(KEYS.project, root, COORDINATOR), rawEntity(KEYS.state, state, COORDINATOR),
    rawEntity(KEYS.publisher, publisher, PUBLISHER), rawEntity(KEYS.book, book, PUBLISHER),
    rawEntity(KEYS.proposal, proposal, COORDINATOR, { createdAt: toHex(90) }),
    rawEntity(KEYS.activation, activation, COORDINATOR, { createdAt: toHex(91) }),
    rawEntity(KEYS.offerLink, offerLink, PUBLISHER), rawEntity(KEYS.requestLink, requestLink, COORDINATOR),
  ]);
  return { rpc, root, state, publisher, book, plan, proposal, activation, source, offerLink, requestLink };
}

export function threeProposalFixture() {
  const fixture = readyFixture();
  const predecessors: PublicEntityKey[] = [];
  let predecessor: SourcePlanRef | null = null;
  for (let revision = 1; revision <= 3; revision++) {
    const key = revision === 3 ? KEYS.proposal : entityKey(20 + revision);
    const plan = structuredClone(fixture.plan);
    plan.instructions = `Workshop instruction revision ${revision}.`;
    plan.predecessor = predecessor;
    const proposal: Proposal = { ...fixture.proposal, operationId: `proposal-${revision}`, plan, proposalHash: hashPlan(plan) };
    fixture.rpc.put(rawEntity(key, proposal, COORDINATOR, { createdAt: toHex(82 + revision) }));
    predecessor = { projectRoot: KEYS.project, proposalKey: key, proposalHash: proposal.proposalHash,
      activationKey: revision === 3 ? KEYS.activation : entityKey(30 + revision) };
    predecessors.push(key);
    if (revision === 3) {
      fixture.proposal = proposal; fixture.plan = plan; fixture.source = predecessor;
      fixture.activation.proposalHash = proposal.proposalHash;
      fixture.book.decisions = [{ ...predecessor, status: 'accepted', decidedAt: NOW - 500, operationId: 'accept-3' }];
      fixture.book.grants = [{ ...fixture.book.grants[0]!, ...predecessor, operationId: 'accept-3' }];
      fixture.rpc.update(KEYS.activation, fixture.activation);
      fixture.rpc.update(KEYS.book, fixture.book);
    }
  }
  return { ...fixture, predecessors };
}
