import { describe, expect, it } from 'vitest';
import { stringToHex, toHex } from 'viem';
import { deriveReadiness } from '../../domain/readiness';
import { independentlyValidatePlan } from '../../domain/validation';
import type { DomainReason, ProjectAggregate } from '../../domain/types';
import { ArkivReader } from '../arkiv/reader';
import type { ReaderPolicy } from '../arkiv/reader';
import type { RpcRequest } from '../arkiv/client';
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

function heldRead(rpc: ReadRpcFixture, matches: (args: Parameters<RpcRequest>[0]) => boolean) {
  let started: () => void = () => {}, complete: () => Promise<void> = async () => {};
  let observed: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const request: RpcRequest = async (args, options) => {
    if (!matches(args)) return rpc.request(args);
    observed = options?.signal;
    return new Promise((resolve, reject) => {
      const abort = () => { observed?.removeEventListener('abort', abort); reject(new DOMException('Cancelled fixture read', 'AbortError')); };
      observed?.addEventListener('abort', abort, { once: true });
      complete = async () => {
        observed?.removeEventListener('abort', abort);
        try { resolve(await rpc.request(args)); } catch (error) { reject(error); }
      };
      started(); if (observed?.aborted) abort();
    });
  };
  return { request, entered, release: () => complete(), signal: () => observed };
}

describe('strict Arkiv reader through the real SDK and a readonly RPC provider', () => {
  it.each([false, true])('overlaps only independent reads and waits for both branches before the final header (reorg=%s)', async reorg => {
    const { rpc } = readyFixture();
    const labels = ['chain', 'head', 'initial', 'root', 'state', 'activation', 'proposal', 'publisher', 'book', 'final'];
    const gates = new Map(labels.map(label => {
      let enter = () => {}, release = () => {};
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      return [label, { enter, release, entered, held }] as const;
    }));
    const started: string[] = [], completed: string[] = []; let headers = 0, active = 0, maxActive = 0;
    const request: RpcRequest = async args => {
      const query = args.method === 'arkiv_query' ? String((args.params as unknown[])[0]) : '';
      const label = args.method === 'eth_chainId' ? 'chain' : args.method === 'eth_blockNumber' ? 'head'
        : args.method === 'eth_getBlockByNumber' ? (++headers === 1 ? 'initial' : 'final')
          : query.includes(`key(${KEYS.project})`) && query.includes('$key') ? 'root'
            : query.includes("str('project_state')") ? 'state' : query.includes("str('plan_activation')") ? 'activation'
              : query.includes(`$key = key(${KEYS.proposal})`) ? 'proposal'
                : query.includes(`$key = key(${KEYS.publisher})`) ? 'publisher' : 'book';
      const gate = gates.get(label)!; started.push(label); active++; maxActive = Math.max(maxActive, active); gate.enter();
      try {
        await gate.held;
        const result = await rpc.request(args);
        return label === 'final' && reorg ? { ...result as object, hash: entityKey(9999) } : result;
      } finally { active--; completed.push(label); }
    };
    const instance = new ArkivReader({ request, now: () => NOW });
    const loading = instance.loadProject(KEYS.project).then(value => ({ value, error: null }), error => ({ value: null, error: repositoryError(error) }));
    const entered = (...names: string[]) => Promise.all(names.map(name => gates.get(name)!.entered));
    const release = (...names: string[]) => names.forEach(name => gates.get(name)!.release());
    await entered('chain', 'head'); expect(started).toEqual(['chain', 'head']); release('chain', 'head');
    await entered('initial'); expect(started).not.toContain('root'); release('initial');
    await entered('root'); expect(started).not.toContain('state'); release('root');
    await entered('state', 'activation'); expect(started).not.toContain('proposal'); release('state', 'activation');
    await entered('proposal', 'publisher'); expect(started).not.toContain('book'); release('publisher');
    await entered('book'); expect(started).not.toContain('final'); release('proposal');
    expect(started).not.toContain('final'); release('book');
    await entered('final'); expect(completed).toEqual(expect.arrayContaining(['proposal', 'book'])); release('final');
    const result = await loading;
    expect(maxActive).toBe(2); expect(active).toBe(0); expect(started).toHaveLength(10);
    expect(rpc.queries.every(call => call.options.atBlock === '0x64')).toBe(true);
    if (reorg) expect(result.error?.reasons).toContainEqual({ code: 'incomplete_snapshot' });
    else { expect(result.error).toBeNull(); expect(deriveReadiness(result.value!, NOW).status).toBe('ready'); }
  });

  it('drains an outstanding publisher read before rejecting a malformed parallel proposal', async () => {
    const { rpc } = readyFixture(); rpc.row(KEYS.proposal).payload = stringToHex('{');
    const held = heldRead(rpc, args => args.method === 'arkiv_query' && String((args.params as unknown[])[0]).includes("str('book_state')"));
    const instance = new ArkivReader({ request: held.request, now: () => NOW }); let settled = false;
    const loading = instance.loadProject(KEYS.project).then(() => null, repositoryError).finally(() => { settled = true; });
    await held.entered; await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(rpc.calls.filter(call => call.method === 'eth_getBlockByNumber')).toHaveLength(1);
    await held.release();
    expect((await loading)?.reasons).toContainEqual({ code: 'invalid_schema' });
    const count = rpc.calls.length; await new Promise(resolve => setTimeout(resolve, 0)); expect(rpc.calls).toHaveLength(count);
  });

  it('settles an independent head read before reporting the wrong chain without reading entities', async () => {
    const { rpc } = readyFixture(); rpc.chainId = 1;
    const held = heldRead(rpc, args => args.method === 'eth_blockNumber');
    const instance = new ArkivReader({ request: held.request, now: () => NOW }); let settled = false;
    const loading = instance.loadProject(KEYS.project).then(() => null, repositoryError).finally(() => { settled = true; });
    await held.entered; await new Promise(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
    await held.release(); expect((await loading)?.code).toBe('wrong_chain');
    expect(rpc.calls.map(call => call.method).sort()).toEqual(['eth_blockNumber', 'eth_chainId']);
  });

  it.each([2, 4])('preserves the shared page budget across concurrent branches (maxPages=%s)', async maxPages => {
    const { rpc } = readyFixture(); const instance = reader(rpc, { maxPages });
    await rejected(instance.loadProject(KEYS.project), 'page_budget');
    expect(rpc.queries).toHaveLength(maxPages);
    const count = rpc.calls.length; await new Promise(resolve => setTimeout(resolve, 0)); expect(rpc.calls).toHaveLength(count);
    expect(rpc.calls.filter(call => call.method === 'eth_getBlockByNumber')).toHaveLength(1);
  });

  it('reserves the shared page budget for current agreement before reading optional proposal history', async () => {
    const { rpc, predecessors } = threeProposalFixture();
    const held = heldRead(rpc, args => args.method === 'arkiv_query' && String((args.params as unknown[])[0]) === `$key = key(${KEYS.publisher})`);
    const instance = new ArkivReader({ request: held.request, now: () => NOW, policy: { maxPages: 6 } });
    const loading = instance.loadProject(KEYS.project);
    await held.entered; await new Promise(resolve => setTimeout(resolve, 0));
    expect(rpc.queries.some(call => predecessors.slice(0, -1).some(key => call.query === `$key = key(${key})`))).toBe(false);
    await held.release(); const project = await loading;
    expect(rpc.queries).toHaveLength(6);
    expect(project.publishers[0]!.book.status).toBe('unique');
    expect(deriveReadiness(project, NOW).status).toBe('ready');
    expect(project.proposalHistoryStatus).toMatchObject({ complete: false, reasons: [{ code: 'page_budget', path: 'proposalHistory' }] });
    expect(project.snapshot).toMatchObject({ completeness: 'complete', freshness: 'fresh' });
  });

  it.each(['chain', 'head', 'initial header', 'explicit snapshot header', 'query page', 'final header'] as const)('forwards cancellation into a held %s request', async stage => {
    const { rpc } = readyFixture(), owner = new AbortController(); let headers = 0;
    const snapshot = stage === 'explicit snapshot header' ? (await reader(rpc).loadProject(KEYS.project)).snapshot : undefined;
    const held = heldRead(rpc, args => {
      if (args.method === 'eth_getBlockByNumber') headers++;
      return stage === 'chain' ? args.method === 'eth_chainId' : stage === 'head' ? args.method === 'eth_blockNumber'
        : stage === 'query page' ? args.method === 'arkiv_query'
          : args.method === 'eth_getBlockByNumber' && headers === (stage === 'final header' ? 2 : 1);
    });
    const instance = new ArkivReader({ request: held.request, now: () => NOW });
    const result = instance.loadProject(KEYS.project, { snapshot, signal: owner.signal }).then(() => null, repositoryError);
    await held.entered;
    expect(held.signal()?.aborted).toBe(false); owner.abort();
    expect(held.signal()?.aborted).toBe(true);
    expect(await result).toMatchObject({ code: 'unverified', reasons: [{ code: 'incomplete_snapshot' }] });
  });

  it('lets a second traversal finish a shared pinned query after the first traversal cancels', async () => {
    const { rpc } = readyFixture(), firstOwner = new AbortController(), secondOwner = new AbortController();
    let queries = 0;
    const held = heldRead(rpc, args => { if (args.method === 'arkiv_query') { queries++; return true; } return false; });
    const instance = new ArkivReader({ request: held.request, now: () => NOW });
    const firstContext = await instance.context({ signal: firstOwner.signal });
    const secondContext = await instance.context({ signal: secondOwner.signal });
    const first = instance.entity(firstContext, KEYS.project, 'project_root').then(() => null, repositoryError);
    const second = instance.entity(secondContext, KEYS.project, 'project_root');
    await held.entered; firstOwner.abort();
    expect(await first).toMatchObject({ code: 'unverified' });
    expect(held.signal()?.aborted).toBe(false); expect(queries).toBe(1);
    await held.release(); expect((await second)?.key).toBe(KEYS.project);
    await instance.finish(secondContext);
    expect(secondContext.snapshot).toMatchObject({ freshness: 'fresh', completeness: 'complete' });
  });

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

  const responseBound = () => Object.assign(new Error('No partial response'), { status: 413,
    headers: new Headers({ 'X-Arkiv-Read-Error': 'response_too_large' }) });

  it('downshifts an oversized page by restarting the entire scope at the original block', async () => {
    const rpc = ownRoots(); rpc.pageSize = 1; let removed = false;
    rpc.queryOverride = call => {
      if (call.options.cursor && Number(BigInt(call.options.limit)) > 25) {
        if (!removed) { rpc.remove(entityKey(71)); removed = true; }
        throw responseBound();
      }
      return undefined;
    };
    const result = await reader(rpc).listOwnPublishers({ kind: 'wallet', address: PUBLISHER });
    expect(result.items.map(item => item.root.key)).toEqual([entityKey(72), entityKey(73)]);
    const listing = rpc.queries.filter(call => call.query.includes("entity_type = str('publisher_root')"));
    expect(listing.map(call => Number(BigInt(call.options.limit)))).toEqual([100, 100, 50, 50, 25, 25]);
    expect(listing.filter(call => !call.options.cursor)).toHaveLength(3);
    expect(rpc.queries.every(call => call.options.atBlock === '0x64')).toBe(true);
    expect(result.snapshot).toMatchObject({ completeness: 'complete', freshness: 'fresh' });
  });

  it('bounds response-size downshifts and fails clearly when one record still exceeds the cap', async () => {
    const rpc = ownRoots(); rpc.queryOverride = () => { throw responseBound(); };
    await rejected(reader(rpc).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'payload_too_large');
    expect(rpc.queries.map(call => Number(BigInt(call.options.limit)))).toEqual([100, 50, 25, 12, 6, 3, 1]);
    expect(rpc.queries.every(call => !call.options.cursor && call.options.atBlock === '0x64')).toBe(true);
  });

  it('continues charging failed size attempts to the original aggregate page budget', async () => {
    const rpc = ownRoots(); rpc.queryOverride = () => { throw responseBound(); };
    await rejected(reader(rpc, { maxPages: 2 }).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'page_budget');
    expect(rpc.queries).toHaveLength(2);
  });

  it('does not downshift an unrelated HTTP413 or accept a changed final canonical header', async () => {
    const generic = ownRoots(); generic.queryOverride = () => { throw Object.assign(new Error('Request rejected'), { status: 413 }); };
    await rejected(reader(generic).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'rpc_error', false);
    expect(generic.queries).toHaveLength(1);
    const changed = ownRoots();
    changed.queryOverride = call => { if (Number(BigInt(call.options.limit)) > 25) throw responseBound(); return undefined; };
    changed.blockOverride = call => call > 1 ? { hash: entityKey(1001) } : {};
    await rejected(reader(changed).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }), 'incomplete_snapshot');
    expect(changed.queries.every(call => call.options.atBlock === '0x64')).toBe(true);
  });

  it('stops after the awaited head or page when the consumer cancels', async () => {
    const { rpc } = readyFixture(), owner = new AbortController();
    const instance = new ArkivReader({ now: () => NOW, request: async args => {
      const result = await rpc.request(args); if (args.method === 'eth_blockNumber') owner.abort(); return result;
    } });
    await rejected(instance.loadProject(KEYS.project, { signal: owner.signal }), 'incomplete_snapshot', false);
    expect(rpc.calls.map(call => call.method)).toEqual(['eth_chainId', 'eth_blockNumber']);
    const listing = ownRoots(), pageOwner = new AbortController(); listing.pageSize = 1;
    listing.queryOverride = () => { pageOwner.abort(); return undefined; };
    await rejected(reader(listing).listOwnPublishers({ kind: 'wallet', address: PUBLISHER }, { signal: pageOwner.signal }), 'incomplete_snapshot');
    expect(listing.queries).toHaveLength(1);
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
