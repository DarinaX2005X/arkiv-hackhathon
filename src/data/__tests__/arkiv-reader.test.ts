import { describe, expect, it } from 'vitest';
import { stringToHex, toHex } from 'viem';
import { deriveReadiness } from '../../domain/readiness';
import { independentlyValidatePlan } from '../../domain/validation';
import type { DomainReason, ProjectAggregate } from '../../domain/types';
import { ArkivReader } from '../arkiv/reader';
import type { ReaderPolicy } from '../arkiv/reader';
import { ArkivRepositoryError, repositoryError } from '../arkiv/errors';
import {
  BLOCK_HASH, COORDINATOR, KEYS, NOW, PUBLISHER, STRANGER, ReadRpcFixture,
  basePayload, entityKey, rawEntity, readyFixture, threeProposalFixture,
} from './arkiv-fixture';
import type { RawEntity } from './arkiv-fixture';

const reader = (rpc: ReadRpcFixture, policy: Partial<ReaderPolicy> = {}) =>
  new ArkivReader({ request: rpc.request, now: () => NOW, policy });
const codes = (reasons: DomainReason[]) => reasons.map(reason => reason.code);
async function rejected(task: Promise<unknown>, reason: DomainReason['code'], typed = true): Promise<void> {
  let caught: unknown;
  try { await task; } catch (error) { caught = error; }
  expect(caught, 'The operation must reject instead of returning a partial or cached value').toBeDefined();
  if (typed) expect(caught).toBeInstanceOf(ArkivRepositoryError);
  expect(codes(repositoryError(caught).reasons)).toContain(reason);
}
function attribute(row: RawEntity, name: string) {
  const found = row.attributes.find(item => item.name === name);
  if (!found) throw new Error(`Missing fixture attribute ${name}`);
  return found;
}

describe('strict Arkiv reader through the real SDK and a readonly RPC provider', () => {
  it('returns the complete bounded book fork set so its owner can review every consumed head', async () => {
    const { rpc, book } = readyFixture(); rpc.pageSize = 1;
    rpc.put(rawEntity(entityKey(90), { ...book, operationId: 'fork-two' }, PUBLISHER));
    rpc.put(rawEntity(entityKey(91), { ...book, operationId: 'fork-three' }, PUBLISHER));
    const publisher = await reader(rpc).loadPublisher(KEYS.publisher);
    expect(publisher.book.status).toBe('conflict');
    if (publisher.book.status === 'conflict') expect(publisher.book.entities.map(item => item.key).sort()).toEqual([KEYS.book, entityKey(90), entityKey(91)].sort());
    expect(publisher.snapshot.completeness).toBe('complete');
  });
  it('recovers a fully agreed plan from public entities with one canonical block and independent domain checks', async () => {
    const { rpc } = readyFixture();
    const project = await reader(rpc).loadProject(KEYS.project);
    expect(project.snapshot).toMatchObject({ mode: 'public', source: 'arkiv', blockNumber: '100', blockHash: BLOCK_HASH,
      blockTimestamp: NOW, fetchedAt: NOW, completeness: 'complete', freshness: 'fresh', reasons: [] });
    expect(project.publishers).toHaveLength(1);
    expect(project.proposal?.payload.plan.allocations).toMatchObject([{ requirementId: 'hosting', quantity: 1, resourceId: 'self' }]);
    expect(independentlyValidatePlan(project.proposal!.payload.plan, project.publishers, NOW)).toEqual({ valid: true, reasons: [] });
    expect(deriveReadiness(project, NOW)).toMatchObject({ status: 'ready', reasons: [], acceptedApprovers: [KEYS.publisher] });
    expect(rpc.queries.length).toBeGreaterThan(5);
    for (const query of rpc.queries) {
      expect(query.options.atBlock).toBe('0x64');
      expect(query.options.select).toMatchObject({ key: true, creator: true, owner: true, createdAt: true,
        expiresAt: true, creationFlags: true, contentType: true, payload: true, attributes: true });
    }
    expect(rpc.calls.every(call => ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'arkiv_query'].includes(call.method))).toBe(true);
  });

  it('rejects a stalled latest head before querying instead of reviving expired consent as current Ready', async () => {
    const { rpc } = readyFixture();
    const instance = new ArkivReader({ request: rpc.request, now: () => NOW + 7 * 86_400_000 });
    await rejected(instance.loadProject(KEYS.project), 'stale_snapshot');
    expect(rpc.queries).toHaveLength(0);
  });

  it('marks a current snapshot stale when its block ages out during the complete walk', async () => {
    const { rpc } = readyFixture(); let now = NOW + 55_000;
    const instance = new ArkivReader({ request: rpc.request, now: () => now });
    rpc.queryOverride = () => { now = NOW + 60_001; return undefined; };
    const project = await instance.loadProject(KEYS.project);
    expect(project.snapshot).toMatchObject({ blockTimestamp: NOW, fetchedAt: NOW + 55_000,
      completeness: 'complete', freshness: 'stale', reasons: [{ code: 'stale_snapshot' }] });
    expect(deriveReadiness(project, now).status).toBe('unverified');
    expect(rpc.queries.length).toBeGreaterThan(5);
  });

  it('keeps a recent current head fresh without replacing its canonical timestamp with retrieval time', async () => {
    const { rpc } = readyFixture(); const now = NOW + 60_000;
    const project = await new ArkivReader({ request: rpc.request, now: () => now }).loadProject(KEYS.project);
    expect(project.snapshot).toMatchObject({ blockTimestamp: NOW, fetchedAt: now, freshness: 'fresh', reasons: [] });
    expect(deriveReadiness(project, now).status).toBe('ready');
  });

  it('still verifies an explicitly requested historical block using its own consent time', async () => {
    const { rpc } = readyFixture();
    const original = await reader(rpc).loadProject(KEYS.project);
    const now = NOW + 7 * 86_400_000;
    const project = await new ArkivReader({ request: rpc.request, now: () => now }).loadProject(KEYS.project,
      { snapshot: { ...original.snapshot, fetchedAt: now } });
    expect(project.snapshot).toMatchObject({ blockNumber: '100', blockTimestamp: NOW, fetchedAt: now, freshness: 'fresh', reasons: [] });
    expect(deriveReadiness(project, now).status).toBe('ready');
    expect(rpc.queries.every(query => query.options.atBlock === '0x64')).toBe(true);
  });

  it.each<[string, (row: RawEntity) => void, DomainReason['code']]>([
    ['foreign root creator', row => { row.creator = STRANGER; row.owner = STRANGER; }, 'foreign_author'],
    ['transferred owner', row => { row.owner = STRANGER; }, 'owner_changed'],
    ['mutable creation', row => { row.creationFlags = 0; }, 'not_readonly'],
    ['permissionless extension', row => { row.creationFlags = 3; }, 'not_readonly'],
    ['unexpected creation flag', row => { row.creationFlags = 5; }, 'not_readonly'],
    ['wrong typed schema projection', row => { Object.assign(attribute(row, 'schema_version'), { type: 'u64', value: '0x1' }); }, 'projection_mismatch'],
    ['wrong typed timestamp projection', row => { attribute(row, 'created_at').type = 'u256'; }, 'projection_mismatch'],
    ['copied namespace', row => { attribute(row, 'project').value = 'foreign-project'; }, 'projection_mismatch'],
    ['extra indexed field', row => { row.attributes.push({ name: 'trusted', type: 'str', value: 'yes' }); }, 'projection_mismatch'],
    ['missing indexed field', row => { row.attributes = row.attributes.filter(item => item.name !== 'operation_id'); }, 'projection_mismatch'],
    ['wrong content type', row => { row.contentType = 'text/plain'; }, 'invalid_schema'],
    ['invalid JSON', row => { row.payload = stringToHex('{'); }, 'invalid_schema'],
  ])('rejects %s instead of trusting a matching key', async (_name, mutate, reason) => {
    const { rpc } = readyFixture();
    mutate(rpc.row(KEYS.project));
    await rejected(reader(rpc).loadProject(KEYS.project), reason);
  });

  it('rejects a proposal whose displayed instructions no longer match its material hash', async () => {
    const { rpc, proposal } = readyFixture();
    proposal.plan.instructions = 'Material terms changed after hashing.';
    rpc.row(KEYS.proposal).payload = stringToHex(JSON.stringify(proposal));
    await rejected(reader(rpc).loadProject(KEYS.project), 'hash_mismatch');
  });

  it('rejects a foreign-created proposal even when it is transferred to the coordinator', async () => {
    const { rpc } = readyFixture();
    rpc.row(KEYS.proposal).creator = STRANGER;
    await rejected(reader(rpc).loadProject(KEYS.project), 'foreign_author');
  });

  it.each(['state', 'activation', 'book'] as const)('reports duplicate %s heads without choosing the greatest revision', async kind => {
    const { rpc } = readyFixture();
    rpc.rows.push({ ...structuredClone(rpc.row(KEYS[kind])), key: entityKey(50), createdAt: toHex(99) });
    const project = await reader(rpc).loadProject(KEYS.project);
    const scope = kind === 'book' ? project.publishers[0]!.book : project[kind];
    expect(scope.status).toBe('conflict');
    expect(deriveReadiness(project, NOW).status).toBe('conflict');
  });

  it.each(['state', 'activation', 'book'] as const)('does not filter away an invalid %s head beside a valid one', async kind => {
    const { rpc } = readyFixture();
    const invalid = { ...structuredClone(rpc.row(KEYS[kind])), key: entityKey(51) };
    attribute(invalid, 'schema_version').value = 2;
    rpc.rows.push(invalid);
    const project = await reader(rpc).loadProject(KEYS.project);
    const scope = kind === 'book' ? project.publishers[0]!.book : project[kind];
    expect(scope.status).toBe('unverified');
    if (scope.status === 'unverified') expect(codes(scope.reasons)).toEqual(expect.arrayContaining(['conflicting_heads', 'projection_mismatch']));
    expect(deriveReadiness(project, NOW).status).toBe('conflict');
    const scopedQueries = rpc.queries.filter(call => call.query.includes(`entity_type = str('${kind === 'state' ? 'project_state' : kind === 'book' ? 'book_state' : 'plan_activation'}')`));
    expect(scopedQueries.every(call => !call.query.includes('schema_version'))).toBe(true);
  });

  it('treats a missing project root as unavailable', async () => {
    const { rpc } = readyFixture(); rpc.remove(KEYS.project);
    await rejected(reader(rpc).loadProject(KEYS.project), 'missing_root');
  });

  it.each(['publisher', 'book'] as const)('never calls the plan Ready when a required %s is missing', async missing => {
    const { rpc } = readyFixture(); rpc.remove(KEYS[missing]);
    const project = await reader(rpc).loadProject(KEYS.project);
    expect(deriveReadiness(project, NOW).status).not.toBe('ready');
    expect(codes(deriveReadiness(project, NOW).reasons)).toContain(missing === 'publisher' ? 'missing_root' : 'missing_state');
    if (missing === 'publisher') expect(project.snapshot.completeness).toBe('incomplete');
    else expect(project.publishers[0]!.book).toEqual({ status: 'missing', reason: 'expired_or_deleted' });
  });

  it('refreshes natural expiry without events, never reviving old approval or the last good read', async () => {
    const { rpc, book } = readyFixture();
    rpc.row(KEYS.book).expiresAt = toHex(101);
    book.predecessorKeys = [entityKey(60)]; rpc.update(KEYS.book, book);
    const instance = reader(rpc);
    expect(deriveReadiness(await instance.loadProject(KEYS.project), NOW).status).toBe('ready');
    rpc.block = 101; rpc.timestamp = NOW + 1_000; rpc.blockHash = entityKey(1001);
    const after = await instance.loadProject(KEYS.project);
    expect(after.snapshot.blockNumber).toBe('101');
    expect(after.publishers[0]!.book.status).toBe('missing');
    expect(deriveReadiness(after, NOW).status).not.toBe('ready');
    expect(rpc.queries.some(call => call.query.includes(`$key = key(${entityKey(60)})`))).toBe(false);
  });

  it('rejects a failed fresh read after Ready rather than returning cached success', async () => {
    const { rpc } = readyFixture(); const instance = reader(rpc);
    const first = await instance.loadProject(KEYS.project);
    expect(deriveReadiness(first, NOW).status).toBe('ready');
    rpc.failure = new Error('Provider unavailable');
    await rejected(instance.loadProject(KEYS.project), 'rpc_error', false);
    expect(deriveReadiness(first, NOW + 60_001).status).toBe('unverified');
  });

  it('rejects query block mismatch and a canonical hash change during the walk', async () => {
    const first = readyFixture().rpc;
    first.queryOverride = (_call, page) => ({ ...page, blockNumber: '0x65' });
    await rejected(reader(first).loadProject(KEYS.project), 'incomplete_snapshot');
    const second = readyFixture().rpc;
    second.blockOverride = call => call > 1 ? { hash: entityKey(2000) } : {};
    await rejected(reader(second).loadProject(KEYS.project), 'incomplete_snapshot');
  });

  it('rejects the wrong chain before querying any entities', async () => {
    const { rpc } = readyFixture(); rpc.chainId = 1;
    await rejected(reader(rpc).loadProject(KEYS.project), 'invalid_identity');
    expect(rpc.queries).toHaveLength(0);
  });

  it('rejects a provider-returned expired entity even when the provider ignores liveness filtering', async () => {
    const { rpc } = readyFixture();
    rpc.queryOverride = (call, page) => call.query === `$key = key(${KEYS.project})`
      ? { ...page, data: [{ ...rpc.row(KEYS.project), expiresAt: toHex(100) }] } : undefined;
    await rejected(reader(rpc).loadProject(KEYS.project), 'expired');
  });

  it('rejects a supplied snapshot whose recorded timestamp no longer matches the canonical block', async () => {
    const { rpc } = readyFixture();
    const first = await reader(rpc).loadProject(KEYS.project);
    await rejected(reader(rpc).loadProject(KEYS.project, { snapshot: { ...first.snapshot, blockTimestamp: NOW - 1_000 } }), 'incomplete_snapshot');
  });
});

describe('complete scoped pagination', () => {
  function ownRoots() {
    const { publisher } = readyFixture();
    return new ReadRpcFixture([1, 2, 3].map(index => rawEntity(entityKey(70 + index),
      { ...publisher, ...basePayload(`publisher-${index}`) }, PUBLISHER)));
  }

  it('follows every cursor even when the provider returns short pages', async () => {
    const rpc = ownRoots(); rpc.pageSize = 1;
    const result = await reader(rpc, { pageSize: 100 }).listOwnPublishers({ kind: 'wallet', address: PUBLISHER });
    expect(result.items.map(item => item.root.key)).toEqual([entityKey(71), entityKey(72), entityKey(73)]);
    const listing = rpc.queries.filter(call => call.query.includes("entity_type = str('publisher_root')"));
    expect(listing).toHaveLength(3);
    expect(listing.every(call => call.query.includes(`$creator = addr(${PUBLISHER})`))).toBe(true);
    expect(listing[1]!.options.cursor).toBeDefined();
    expect(result.snapshot.completeness).toBe('complete');
  });

  it('discards accumulated rows after a cursor error and restarts the entire same-block scope once', async () => {
    const rpc = ownRoots(); rpc.pageSize = 1; let failed = false;
    rpc.queryOverride = (call, _page) => {
      if (call.options.cursor && !failed) {
        failed = true; rpc.remove(entityKey(71));
        throw Object.assign(new Error('Cursor no longer valid'), { code: -32005 });
      }
      return undefined;
    };
    const result = await reader(rpc).listOwnPublishers({ kind: 'wallet', address: PUBLISHER });
    expect(result.items.map(item => item.root.key)).toEqual([entityKey(72), entityKey(73)]);
    expect(rpc.queries.every(call => call.options.atBlock === '0x64')).toBe(true);
    expect(rpc.queries.filter(call => call.query.includes("entity_type = str('publisher_root')") && !call.options.cursor)).toHaveLength(2);
  });

  it('rejects cursor retry exhaustion without an empty or partial success', async () => {
    const rpc = ownRoots(); rpc.pageSize = 1;
    rpc.queryOverride = call => { if (call.options.cursor) throw Object.assign(new Error('Expired cursor'), { code: -32005 }); return undefined; };
    await rejected(reader(rpc, { cursorRestarts: 1 }).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'cursor_error', false);
    expect(rpc.queries.filter(call => !call.options.cursor)).toHaveLength(2);
  });

  it.each([{ maxPages: 1 }, { maxEntities: 1 }])('rejects an exhausted global read budget %j', async policy => {
    const rpc = ownRoots(); rpc.pageSize = 1;
    await rejected(reader(rpc, policy).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'page_budget');
  });

  it('rejects repeated entities across cursor pages', async () => {
    const rpc = ownRoots(); rpc.pageSize = 1;
    rpc.queryOverride = (call, page) => call.options.cursor ? { ...page, data: [structuredClone(rpc.row(entityKey(71)))] } : undefined;
    await rejected(reader(rpc).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'incomplete_snapshot');
  });

  it('does not declare a scope unique before checking its short first page cursor', async () => {
    const { rpc } = readyFixture(); rpc.pageSize = 1;
    rpc.rows.push({ ...structuredClone(rpc.row(KEYS.book)), key: entityKey(74) });
    const project = await reader(rpc).loadProject(KEYS.project);
    expect(project.publishers[0]!.book.status).toBe('conflict');
    expect(rpc.queries.filter(call => call.query.includes("entity_type = str('book_state')"))).toHaveLength(2);
    expect(deriveReadiness(project, NOW).status).toBe('conflict');
  });

  it('rejects a repeated cursor even on empty pages', async () => {
    const rpc = ownRoots(); rpc.pageSize = 1;
    rpc.queryOverride = (call, page) => call.options.cursor ? { ...page, data: [], cursor: call.options.cursor } : undefined;
    await rejected(reader(rpc).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'cursor_error');
  });
});

describe('fresh independent public discovery', () => {
  it('discovers an unseeded participant, requires coordinator admission and fresh consent across independent reader instances', async () => {
    const fixture = readyFixture();
    const { root, state, publisher, book, offerLink, proposal, activation, requestLink } = fixture;
    const initialState = { ...state, publisherRoots: [] };
    const rpc = new ReadRpcFixture([rawEntity(KEYS.project, root, COORDINATOR), rawEntity(entityKey(90), initialState, COORDINATOR)]);
    expect((await reader(rpc).listOwnPublishers({ kind: 'wallet', address: PUBLISHER })).items).toEqual([]);
    expect((await reader(rpc).loadProject(KEYS.project)).publishers).toEqual([]);

    // Provider snapshots stand for other independently authored writes; these tests only execute reads.
    rpc.put(rawEntity(KEYS.publisher, publisher, PUBLISHER));
    rpc.put(rawEntity(entityKey(91), { ...book, decisions: [], grants: [] }, PUBLISHER));
    rpc.put(rawEntity(KEYS.offerLink, offerLink, PUBLISHER));
    const offered = await reader(rpc).links('offer', KEYS.project);
    expect(offered.items[0]!.publisher?.root.key).toBe(KEYS.publisher);
    expect((await reader(rpc).loadProject(KEYS.project)).publishers).toEqual([]);

    rpc.remove(entityKey(90));
    rpc.put(rawEntity(KEYS.state, { ...state, predecessorKeys: [entityKey(90)] }, COORDINATOR));
    rpc.put(rawEntity(KEYS.proposal, proposal, COORDINATOR));
    rpc.put(rawEntity(KEYS.activation, activation, COORDINATOR));
    rpc.put(rawEntity(KEYS.requestLink, requestLink, COORDINATOR));
    const requested = await reader(rpc).links('request', KEYS.publisher);
    expect(requested.items).toHaveLength(1);
    expect(requested.items[0]!.status).toBe('current');
    expect(deriveReadiness(await reader(rpc).loadProject(KEYS.project), NOW).status).toBe('awaiting_approval');

    rpc.remove(entityKey(91));
    rpc.put(rawEntity(KEYS.book, { ...book, predecessorKeys: [entityKey(91)] }, PUBLISHER));
    const freshStudio = await reader(rpc).loadProject(KEYS.project);
    expect(deriveReadiness(freshStudio, NOW)).toMatchObject({ status: 'ready', acceptedApprovers: [KEYS.publisher], reasons: [] });
  });

  it('finds own roots, incoming offers and current requests without any shared client cache', async () => {
    const { rpc } = readyFixture();
    const own = await reader(rpc).listOwnPublishers({ kind: 'wallet', address: PUBLISHER });
    const incoming = await reader(rpc).links('offer', KEYS.project);
    const requests = await reader(rpc).links('request', KEYS.publisher);
    const projects = await reader(rpc).listProjects({ kind: 'wallet', address: COORDINATOR });
    expect(own.items.map(item => item.root.key)).toEqual([KEYS.publisher]);
    expect(incoming.items.map(item => [item.entity.key, item.status])).toEqual([[KEYS.offerLink, 'current']]);
    expect(requests.items.map(item => [item.entity.key, item.status])).toEqual([[KEYS.requestLink, 'current']]);
    expect(projects.items.map(item => item.root.key)).toEqual([KEYS.project]);
    expect(deriveReadiness(await reader(rpc).loadProject(projects.items[0]!.root.key), NOW).status).toBe('ready');
  });

  it.each(['offer', 'request'] as const)('excludes foreign-authored %s links and collapses valid duplicates', async kind => {
    const { rpc, offerLink, requestLink } = readyFixture();
    const link = kind === 'offer' ? offerLink : requestLink;
    const creator = kind === 'offer' ? PUBLISHER : COORDINATOR;
    rpc.put(rawEntity(entityKey(80), { ...link, operationId: 'duplicate-link', createdAt: NOW - 100 }, creator));
    rpc.put(rawEntity(entityKey(81), { ...link, operationId: 'malicious-link' }, STRANGER));
    const result = await reader(rpc).links(kind, kind === 'offer' ? KEYS.project : KEYS.publisher);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe('current');
    expect(codes(result.diagnostics)).toContain('foreign_author');
  });

  it.each([[], [KEYS.project], [entityKey(999), KEYS.project]].map(projectScope => ({ projectScope })))('keeps an offer link current when its project is allowed by scope %j', async ({ projectScope }) => {
    const { rpc, book } = readyFixture();
    book.offers[0]!.projectScope = projectScope;
    rpc.update(KEYS.book, book);
    const result = await reader(rpc).links('offer', KEYS.project);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'current', diagnostics: [] });
  });

  it('marks an offer link historical when any named offer no longer allows the linked project', async () => {
    const { rpc, book, offerLink } = readyFixture();
    book.offers.push({ ...structuredClone(book.offers[0]!), id: 'scoped-elsewhere', projectScope: [entityKey(999)] });
    rpc.update(KEYS.book, book);
    rpc.update(KEYS.offerLink, { ...offerLink, offerIds: ['host', 'scoped-elsewhere'] });
    const result = await reader(rpc).links('offer', KEYS.project);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'historical', diagnostics: [{ code: 'missing_offer' }] });
  });

  it('marks consumed activation request links historical and never turns them into agreement', async () => {
    const { rpc, activation } = readyFixture();
    rpc.remove(KEYS.activation);
    rpc.put(rawEntity(entityKey(82), { ...activation, operationId: 'activation-replayed', predecessorActivationKeys: [KEYS.activation] }, COORDINATOR));
    const requests = await reader(rpc).links('request', KEYS.publisher);
    expect(requests.items[0]).toMatchObject({ status: 'historical', diagnostics: [{ code: 'activation_mismatch' }] });
    expect(deriveReadiness(await reader(rpc).loadProject(KEYS.project), NOW).status).toBe('awaiting_approval');
  });
});

describe('immutable proposal predecessor history', () => {
  it('reconstructs P1 → P2 → P3 from P3 using a fresh reader without old activations or cached heads', async () => {
    const { rpc, predecessors } = threeProposalFixture();
    const project = await reader(rpc).loadProject(KEYS.project);
    expect(project.proposalHistory.map(item => item.key)).toEqual(predecessors);
    expect(project.proposalHistory.map(item => item.payload.plan.instructions)).toEqual([
      'Workshop instruction revision 1.', 'Workshop instruction revision 2.', 'Workshop instruction revision 3.',
    ]);
    expect(project.proposalHistoryStatus).toEqual({ complete: true, reasons: [] });
    expect(project.proposal?.key).toBe(KEYS.proposal);
    expect(deriveReadiness(project, NOW).status).toBe('ready');
    expect(rpc.queries.filter(call => call.query.startsWith('$key = key(')).map(call => call.query)).toEqual(expect.arrayContaining([
      `$key = key(${predecessors[0]})`, `$key = key(${predecessors[1]})`,
    ]));
    expect(rpc.rows.some(row => row.key === entityKey(31) || row.key === entityKey(32))).toBe(false);
  });

  it.each(['missing', 'expired', 'foreign creator', 'wrong hash'] as const)('exposes a %s predecessor gap separately from current Ready confidence', async cause => {
    const { rpc, predecessors } = threeProposalFixture();
    const prior = predecessors[1]!;
    if (cause === 'missing') rpc.remove(prior);
    else if (cause === 'expired') rpc.row(prior).expiresAt = toHex(100);
    else if (cause === 'foreign creator') { rpc.row(prior).creator = STRANGER; rpc.row(prior).owner = STRANGER; }
    else {
      // Keep a structurally valid proposal with a different material hash under the expected predecessor key.
      const original = readyFixture();
      rpc.put(rawEntity(prior, original.proposal, COORDINATOR, { createdAt: toHex(84) }));
    }
    const project = await reader(rpc).loadProject(KEYS.project);
    expect(project.proposalHistory.map(item => item.key)).toEqual([KEYS.proposal]);
    expect(project.proposalHistoryStatus?.complete).toBe(false);
    expect(project.proposalHistoryStatus?.reasons.length).toBeGreaterThan(0);
    expect(project.proposalHistoryStatus?.reasons.every(reason => reason.path === 'proposalHistory')).toBe(true);
    expect(project.snapshot).toMatchObject({ completeness: 'complete', freshness: 'fresh', reasons: [] });
    expect(deriveReadiness(project, NOW)).toMatchObject({ status: 'ready', reasons: [] });
  });

  it('does not follow a predecessor that was created after its successor', async () => {
    const { rpc, predecessors } = threeProposalFixture();
    rpc.row(predecessors[1]!).createdAt = toHex(99);
    const project = await reader(rpc).loadProject(KEYS.project);
    expect(project.proposalHistoryStatus?.complete).toBe(false);
    expect(codes(project.proposalHistoryStatus!.reasons)).toContain('invalid_schema');
    expect(project.proposalHistory.map(item => item.key)).toEqual([KEYS.proposal]);
  });

  it('loads closed-project lineage from the recorded source even after activation consumption', async () => {
    const { rpc, state, source, predecessors } = threeProposalFixture();
    state.lifecycle = 'closed';
    state.completion = { outcome: 'cancelled', recordedAt: NOW, statement: 'Workshop cancelled.', completedWork: [],
      outstandingObligationIds: ['welcome'], outstandingCustodyHoldIds: [], source };
    rpc.update(KEYS.state, state); rpc.remove(KEYS.activation);
    const project: ProjectAggregate = await reader(rpc).loadProject(KEYS.project);
    expect(project.proposal).toBeNull();
    expect(project.proposalHistory.map(item => item.key)).toEqual(predecessors);
    expect(project.proposalHistoryStatus?.complete).toBe(true);
    expect(deriveReadiness(project, NOW)).toMatchObject({ lifecycle: 'closed', outcome: 'cancelled', status: 'changed' });
  });
});
