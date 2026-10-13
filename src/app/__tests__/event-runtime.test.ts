import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringToHex, toHex } from 'viem';
import { createStudioWorkspaces } from '../workspaces';
import { parseRoute, routePath, type Route } from '../routes';
import type { StoragePort } from '../storage';
import { COORDINATOR, KEYS, NOW, entityKey, readyFixture } from '../../data/__tests__/arkiv-fixture';
import type { RawEntity } from '../../data/__tests__/arkiv-fixture';
import type { RpcRequest as WalletRequest } from '../../data/wallet/types';
import { audienceHash, deriveEventAvailability, EVENTS_PROTOCOL } from '../../domain/events';
import type { AudienceTerms, EventRelease, EventState } from '../../domain/events';
import { TIRAMISU_CHAIN_ID, type PublicEntityKey } from '../../domain/types';
import { joinTargetStore, prepareRegistration, targetForEvent } from '../../features/attendance/intent';
import { readEventForActor } from '../../features/events/hooks';

const releaseKey = entityKey(101);
const stateKey = entityKey(102);
const eventRoute = { name: 'event', projectRoot: KEYS.project } as const;
const eventPath = routePath(eventRoute);

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: StoragePort = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  return { storage, values };
}
function readonlyWallet() {
  return { request: vi.fn(async ({ method }: WalletRequest): Promise<unknown> => {
    if (method === 'eth_accounts') return [];
    if (method === 'eth_chainId') return `0x${TIRAMISU_CHAIN_ID.toString(16)}`;
    throw new Error(`This visitor journey must not prompt, approve or send wallet method ${method}`);
  }) };
}
function expectOnlyPassiveWalletReads(provider: ReturnType<typeof readonlyWallet>) {
  expect(provider.request.mock.calls.every(([request]) => ['eth_accounts', 'eth_chainId'].includes(request.method))).toBe(true);
}

/** Raw SDK response rows keep the integration fixture independent of the event writer. */
function eventRow(key: PublicEntityKey, payload: EventRelease | EventState): RawEntity {
  const dates = payload.entityType === 'event_release' ? payload.terms : payload;
  const attributes: RawEntity['attributes'] = [
    { name: 'project', type: 'str', value: 'partfolk-events' },
    { name: 'schema_version', type: 'i32', value: 1 },
    { name: 'entity_type', type: 'str', value: payload.entityType },
    { name: 'operation_id', type: 'str', value: payload.operationId },
    { name: 'created_at', type: 'u64', value: toHex(payload.createdAt) },
    { name: 'project_key', type: 'key', value: payload.projectRoot },
    { name: 'audience_hash', type: 'bytes32', value: payload.audienceHash },
    { name: 'starts_at', type: 'u64', value: toHex(dates.startsAt) },
    { name: 'ends_at', type: 'u64', value: toHex(dates.endsAt) },
    { name: 'proposal_key', type: 'key', value: payload.source.proposalKey },
  ];
  if (payload.entityType === 'event_state') attributes.push(
    { name: 'release_key', type: 'key', value: payload.releaseKey },
    { name: 'status', type: 'str', value: payload.status },
  );
  return { key, creator: COORDINATOR, owner: COORDINATOR, createdAt: toHex(95), expiresAt: toHex(10_000),
    creationFlags: 1, contentType: 'application/json', payload: stringToHex(JSON.stringify(payload)), attributes };
}

function publicEventFixture() {
  const fixture = readyFixture();
  const base = { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, createdAt: NOW - 1000, projectRoot: KEYS.project, source: fixture.source };
  const terms: AudienceTerms = { title: 'Neighbourhood workshop', description: 'Make useful things together.',
    startsAt: NOW + 3_600_000, endsAt: NOW + 7_200_000, timeZone: 'UTC', venue: 'Public library',
    instructions: 'Use the front entrance.', conditions: 'Free open participation.' };
  const release: EventRelease = { ...base, entityType: 'event_release', operationId: 'event-release-1', terms,
    audienceHash: audienceHash(terms), predecessorReleaseKey: null };
  const state: EventState = { ...base, entityType: 'event_state', operationId: 'event-state-1', releaseKey,
    audienceHash: release.audienceHash, startsAt: terms.startsAt, endsAt: terms.endsAt, status: 'open', predecessorKeys: [] };
  fixture.rpc.put(eventRow(releaseKey, release));
  fixture.rpc.put(eventRow(stateKey, state));
  return { ...fixture, release };
}

describe('event runtime routing and visitor boundaries without rendering', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The runtime test requires the injected fixture RPC; external HTTP is forbidden.'));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('constructs a public event repository without prompting a wallet, reading RPC or creating the practice sample', () => {
    const { storage, values } = memoryStorage();
    const fixture = publicEventFixture();
    const provider = readonlyWallet();
    const manager = createStudioWorkspaces({ storage, provider, request: fixture.rpc.request, now: () => NOW });
    try {
      expect(manager.storage).toBe(storage);
      expect(manager.events.mode).toBe('public');
      expect(manager.getSnapshot().kind).toBe('public');
      expect(manager.getSnapshot().runtime.session.getSnapshot()).toMatchObject({ mode: 'public', actor: null, chainId: null });
      expect(fixture.rpc.calls).toEqual([]);
      expect(provider.request).not.toHaveBeenCalled();
      expect(values.has('partfolk:local:practice')).toBe(false);
    } finally { manager.dispose(); }
  });

  for (const origin of ['practice', 'local'] as const) {
    it.each([
      { name: 'events' }, eventRoute, { name: 'my-events' },
    ] as Route[])(`selects the public runtime for $name from ${origin} without carrying sample authority`, async destination => {
      const { storage } = memoryStorage();
      const fixture = publicEventFixture();
      const provider = readonlyWallet();
      const manager = createStudioWorkspaces({ storage, provider, request: fixture.rpc.request, now: () => NOW });
      try {
        await manager.select(origin, { name: origin === 'practice' ? 'demo' : 'workspace' });
        if (origin === 'practice') manager.setLocalActor({ kind: 'local', id: 'local-actor:cedar' });
        expect(manager.getSnapshot().runtime.session.getSnapshot().actor?.kind).toBe('local');
        await manager.followRoute(parseRoute(routePath(destination)));
        expect(manager.getSnapshot()).toMatchObject({ kind: 'public', loading: false, issue: null });
        expect(manager.getSnapshot().runtime).toBe(manager.runtimes.public);
        expect(manager.getSnapshot().runtime.session.getSnapshot()).toMatchObject({ mode: 'public', actor: null, chainId: null, destination: routePath(destination) });
        await manager.publicBinding.ready;
        expectOnlyPassiveWalletReads(provider);
        expect(fixture.rpc.calls).toEqual([]);
      } finally { manager.dispose(); }
    });
  }

  it.each([true, false])('uses the supplied RPC for public catalog and event detail reads with storage=%s and no wallet prompt', async hasStorage => {
    const { storage } = memoryStorage();
    const fixture = publicEventFixture();
    const provider = readonlyWallet();
    const manager = createStudioWorkspaces({ storage: hasStorage ? storage : null, provider, request: fixture.rpc.request, now: () => NOW });
    try {
      await manager.followRoute({ name: 'events' });
      const catalog = await manager.events.listEvents();
      expect(catalog.ok).toBe(true);
      if (!catalog.ok) throw new Error(catalog.error.code);
      expect(catalog.value.items.map(item => item.projectRoot)).toEqual([KEYS.project]);
      await manager.followRoute(eventRoute);
      const detail = await readEventForActor(manager.events, KEYS.project, null);
      expect(detail.ok).toBe(true);
      if (!detail.ok) throw new Error(detail.error.code);
      expect(detail.value.event.release?.key).toBe(releaseKey);
      expect(deriveEventAvailability(detail.value.event, NOW)).toBe('open');
      expect(detail.value.attendance).toBeNull();
      expect(detail.value.actor).toBeNull();
      expect(detail.value.event.snapshot.source).toBe('arkiv');
      expect(fixture.rpc.queries.length).toBeGreaterThan(0);
      expect(fixture.rpc.calls.every(call => ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'arkiv_query'].includes(call.method))).toBe(true);
      await manager.publicBinding.ready;
      expectOnlyPassiveWalletReads(provider);
      if (!hasStorage) expect(provider.request).not.toHaveBeenCalled();
      expect(manager.runtimes.public.session.getSnapshot()).toMatchObject({ actor: null, chainId: null });
    } finally { manager.dispose(); }
  });

  it.each(['local', 'practice'] as const)('retains the exact join target through sign-in, setup, Help and reload from %s without granting authority', async origin => {
    const { storage } = memoryStorage();
    const fixture = publicEventFixture();
    const provider = readonlyWallet();
    let manager = createStudioWorkspaces({ storage, provider, request: fixture.rpc.request, now: () => NOW });
    try {
      await manager.select(origin, { name: origin === 'practice' ? 'demo' : 'workspace' });
      const read = await readEventForActor(manager.events, KEYS.project, null);
      if (!read.ok) throw new Error(read.error.code);
      const target = targetForEvent(read.value, manager.runtimes.public.session.getSnapshot(), NOW);
      expect(target).not.toBeNull();
      if (!target) throw new Error('The published event must provide a join target.');
      const store = joinTargetStore(manager.storage, KEYS.project);
      expect(store.save(target).persisted).toBe(true);
      const joinStorageKey = `partfolk:events:join:${KEYS.project.toLowerCase()}`;
      const savedBytes = storage.getItem(joinStorageKey);
      const rpcCallsBeforeNavigation = fixture.rpc.calls.length;
      manager.runtimes.public.session.selectDraft('unfinished-public-draft');

      for (const route of [
        { name: 'sign-in', returnTo: eventPath },
        { name: 'onboarding', returnTo: eventPath },
        { name: 'help', topic: 'publishing', returnTo: eventPath },
      ] as Route[]) {
        await manager.followRoute(parseRoute(routePath(route)));
        expect(manager.getSnapshot().kind).toBe('public');
        expect(manager.getSnapshot().runtime.session.currentRoute()).toEqual(route);
        expect(joinTargetStore(manager.storage, KEYS.project).load()).toMatchObject({ status: 'ready', value: target });
        expect(storage.getItem(joinStorageKey)).toBe(savedBytes);
        expect(manager.getSnapshot().runtime.session.getSnapshot()).toMatchObject({ actor: null, chainId: null, activeDraftId: 'unfinished-public-draft' });
      }

      manager.dispose();
      manager = createStudioWorkspaces({ storage, provider, request: fixture.rpc.request, now: () => NOW });
      expect(manager.initialRoute()).toEqual({ name: 'home' });
      await manager.followRoute(manager.initialRoute());
      expect(manager.getSnapshot().runtime.session.currentRoute()).toEqual({ name: 'home' });
      // An explicit Help URL still keeps its event continuation after a fresh visit.
      const explicitHelp = { name: 'help', topic: 'publishing', returnTo: eventPath } as const;
      await manager.followRoute(parseRoute(routePath(explicitHelp)));
      expect(manager.getSnapshot().runtime.session.currentRoute()).toEqual(explicitHelp);
      await manager.followRoute(parseRoute(eventPath));
      expect(manager.getSnapshot().kind).toBe('public');
      expect(manager.getSnapshot().runtime.session.getSnapshot()).toMatchObject({ destination: eventPath, actor: null, chainId: null, activeDraftId: 'unfinished-public-draft' });
      expect(joinTargetStore(manager.storage, KEYS.project).load()).toMatchObject({ status: 'ready', value: {
        projectRoot: KEYS.project, releaseKey, audienceHash: fixture.release.audienceHash, selectedAt: NOW, attendee: null,
      } });
      expect(storage.getItem(joinStorageKey)).toBe(savedBytes);
      expect(prepareRegistration(read.value, target, manager.getSnapshot().runtime.session.getSnapshot(), NOW).ok).toBe(false);
      await manager.publicBinding.ready;
      expectOnlyPassiveWalletReads(provider);
      expect(fixture.rpc.calls).toHaveLength(rpcCallsBeforeNavigation);
    } finally { manager.dispose(); }
  });
});
