import { describe, expect, it } from 'vitest';
import { createPublicRuntime, injectedProvider } from '../network';
import { createMemoryStorage } from '../../data/local';
import { COORDINATOR, KEYS, NOW, PUBLISHER, readyFixture } from '../../data/__tests__/arkiv-fixture';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { InjectedWalletProvider, RpcRequest } from '../../data/wallet/types';
import { WALLET_SESSION_KEY, type WalletSessionChannel, type WalletSessionMessage } from '../../features/account/wallet-session';

type Event = 'accountsChanged' | 'chainChanged' | 'disconnect';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeProvider implements InjectedWalletProvider {
  accounts = [COORDINATOR];
  chain = `0x${TIRAMISU_CHAIN_ID.toString(16)}`;
  readonly calls: RpcRequest[] = [];
  readonly listeners = new Map<Event, Set<(...args: unknown[]) => void>>();
  accountResponse: Promise<unknown> | null = null;
  accountFailure: unknown = null;
  switchFailure: unknown = null;
  passiveResponse: Promise<unknown> | null = null;
  async request(args: RpcRequest): Promise<unknown> {
    this.calls.push(structuredClone(args));
    if (args.method === 'eth_requestAccounts') {
      if (this.accountFailure) throw this.accountFailure;
      return this.accountResponse ?? [...this.accounts];
    }
    if (args.method === 'wallet_switchEthereumChain') { if (this.switchFailure) throw this.switchFailure; return null; }
    if (args.method === 'eth_accounts') return this.passiveResponse ?? [...this.accounts];
    if (args.method === 'eth_chainId') return this.chain;
    throw new Error(`The fake provider prohibits ${args.method}`);
  }
  on(event: Event, listener: (...args: unknown[]) => void): void {
    const current = this.listeners.get(event) ?? new Set(); current.add(listener); this.listeners.set(event, current);
  }
  removeListener(event: Event, listener: (...args: unknown[]) => void): void { this.listeners.get(event)?.delete(listener); }
  emit(event: Event, ...args: unknown[]): void { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
  listenerCount(): number { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
const textDraft = (value: unknown): value is { text: string } => Boolean(value && typeof value === 'object' && 'text' in value && typeof value.text === 'string');
function binding(provider?: FakeProvider) {
  const fixture = readyFixture();
  const runtime = createPublicRuntime({ storage: createMemoryStorage(), namespace: 'network-test', provider,
    request: fixture.rpc.request, now: () => NOW });
  return { binding: runtime, fixture };
}
function retainWork(runtime: ReturnType<typeof createPublicRuntime>['runtime']) {
  runtime.session.navigate({ name: 'project', projectRoot: KEYS.project, tab: 'agreement' });
  runtime.session.selectDraft('my-draft');
  const draft = runtime.drafts('my-draft', 'text', textDraft);
  draft.save({ text: 'My contribution terms' });
  return { draft, destination: runtime.session.getSnapshot().destination };
}

describe('public runtime connection boundary without browser automation', () => {
  it('reads a genuine fixture through the SDK/RPC path without requesting a wallet', async () => {
    const provider = new FakeProvider();
    const { binding: publicBinding, fixture } = binding(provider);
    expect(provider.calls).toEqual([]);
    const result = await publicBinding.runtime.repository!.loadProject(KEYS.project);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.root.key).toBe(KEYS.project);
    expect(result.value.snapshot.source).toBe('arkiv');
    expect(fixture.rpc.calls.some(call => call.method === 'arkiv_query')).toBe(true);
    await publicBinding.ready;
    expect(provider.calls.map(call => call.method)).toEqual(['eth_accounts', 'eth_chainId']);
    expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ mode: 'public', actor: { kind: 'wallet', address: COORDINATOR }, chainId: TIRAMISU_CHAIN_ID });
    publicBinding.dispose();
  });

  it('public reads also work when no provider or storage exists; connecting remains explicit and unavailable', async () => {
    const fixture = readyFixture();
    const publicBinding = createPublicRuntime({ storage: null, namespace: 'no-storage', request: fixture.rpc.request, now: () => NOW });
    expect((await publicBinding.runtime.repository!.loadProject(KEYS.project)).ok).toBe(true);
    expect(await publicBinding.connect()).toBe(false);
    expect(publicBinding.getSnapshot()).toMatchObject({ connecting: false, hasProvider: false });
    expect(publicBinding.getSnapshot().error).toMatch(/wallet/i);
    expect(publicBinding.runtime.session.getSnapshot().actor).toBeNull();
    publicBinding.dispose();
  });

  it('does not prompt an available provider when a durable operation journal cannot be saved', async () => {
    const fixture = readyFixture();
    const provider = new FakeProvider();
    const publicBinding = createPublicRuntime({ storage: null, namespace: 'no-storage', provider, request: fixture.rpc.request, now: () => NOW });
    const { draft, destination } = retainWork(publicBinding.runtime);
    expect(await publicBinding.connect()).toBe(false);
    expect(publicBinding.getSnapshot().error).toMatch(/storage/i);
    expect(provider.calls).toEqual([]);
    expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ destination, activeDraftId: 'my-draft', actor: null });
    expect(draft.peek()).toEqual({ text: 'My contribution terms' });
    publicBinding.dispose();
  });

  it('clears stale authority immediately on wallet events, then passively reads changed accounts and networks', async () => {
    const provider = new FakeProvider();
    const { binding: publicBinding } = binding(provider);
    const { draft, destination } = retainWork(publicBinding.runtime);
    expect(await publicBinding.connect()).toBe(true);
    expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ actor: { kind: 'wallet', address: COORDINATOR }, chainId: TIRAMISU_CHAIN_ID });
    expect(provider.listenerCount()).toBe(6);
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect'] as const) {
      if (event === 'accountsChanged') provider.accounts = [PUBLISHER];
      provider.emit(event, event === 'accountsChanged' ? [PUBLISHER] : event === 'chainChanged' ? '0x1' : { code: 4900 });
      expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ actor: null, chainId: null, destination, activeDraftId: 'my-draft' });
      expect(provider.listenerCount()).toBe(3);
      expect(draft.peek()).toEqual({ text: 'My contribution terms' });
      expect(await publicBinding.connect()).toBe(true);
      expect(publicBinding.runtime.session.getSnapshot().actor).toEqual({ kind: 'wallet', address: PUBLISHER });
      expect(provider.listenerCount()).toBe(6);
    }
    expect(provider.calls.every(call => !call.method.includes('sendTransaction'))).toBe(true);
    publicBinding.dispose();
    expect(provider.listenerCount()).toBe(0);
  });

  it('a rejected account request preserves the selected destination and saved draft', async () => {
    const provider = new FakeProvider();
    provider.accountFailure = Object.assign(new Error('User cancelled'), { code: 4001 });
    const { binding: publicBinding } = binding(provider);
    const { draft, destination } = retainWork(publicBinding.runtime);
    expect(await publicBinding.connect()).toBe(false);
    expect(publicBinding.getSnapshot().error).toMatch(/cancelled/i);
    expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ actor: null, chainId: null, destination, activeDraftId: 'my-draft' });
    expect(draft.load()).toMatchObject({ status: 'ready', value: { text: 'My contribution terms' } });
    expect(provider.calls.map(call => call.method)).toEqual(['eth_requestAccounts']);
    publicBinding.dispose();
  });

  it('a denied network switch or unchanged wrong chain keeps the intended event and draft without authority', async () => {
    const provider = new FakeProvider();
    const { binding: publicBinding } = binding(provider);
    const { draft } = retainWork(publicBinding.runtime);
    const destination = `/events/${KEYS.project}`;
    publicBinding.runtime.session.navigate({ name: 'sign-in', returnTo: destination });
    provider.switchFailure = Object.assign(new Error('Declined switch'), { code: 4001 });
    expect(await publicBinding.connect()).toBe(false);
    expect(publicBinding.runtime.session.currentRoute()).toEqual({ name: 'sign-in', returnTo: destination });
    expect(publicBinding.getSnapshot().error).toMatch(/cancelled/i);
    provider.switchFailure = null;
    provider.chain = '0x1';
    expect(await publicBinding.connect()).toBe(false);
    expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ actor: null, activeDraftId: 'my-draft' });
    expect(draft.peek()).toEqual({ text: 'My contribution terms' });
    provider.chain = `0x${TIRAMISU_CHAIN_ID.toString(16)}`;
    expect(await publicBinding.connect()).toBe(true);
    publicBinding.disconnect();
    expect(publicBinding.runtime.session.currentRoute()).toEqual({ name: 'sign-in', returnTo: destination });
    expect(provider.calls.every(call => !call.method.includes('sendTransaction'))).toBe(true);
    publicBinding.dispose();
  });

  it('a pending reconnect immediately invalidates old authority and cancellation disposes its old gateway', async () => {
    const provider = new FakeProvider();
    const { binding: publicBinding } = binding(provider);
    expect(await publicBinding.connect()).toBe(true);
    const { draft, destination } = retainWork(publicBinding.runtime);
    const pending = deferred<unknown>();
    provider.accountResponse = pending.promise;
    const reconnect = publicBinding.connect();
    expect(publicBinding.getSnapshot().connecting).toBe(true);
    expect(publicBinding.runtime.session.getSnapshot().actor).toBeNull();
    expect(provider.listenerCount()).toBe(3);
    pending.reject(Object.assign(new Error('User cancelled'), { code: 4001 }));
    expect(await reconnect).toBe(false);
    const cancelled = publicBinding.getSnapshot().error;
    provider.emit('disconnect', { code: 4900 });
    expect(cancelled).toMatch(/cancelled/i);
    expect(publicBinding.getSnapshot().error).toMatch(/disconnected/i);
    expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ destination, activeDraftId: 'my-draft', actor: null, chainId: null });
    expect(draft.peek()).toEqual({ text: 'My contribution terms' });
    publicBinding.dispose();
  });

  it.each(['disconnect', 'dispose'] as const)('a late connection response cannot restore authority after %s', async cancel => {
    const provider = new FakeProvider();
    const pending = deferred<unknown>();
    provider.accountResponse = pending.promise;
    const { binding: publicBinding } = binding(provider);
    const { draft, destination } = retainWork(publicBinding.runtime);
    const connect = publicBinding.connect();
    expect(await publicBinding.connect()).toBe(false);
    expect(provider.calls.filter(call => call.method === 'eth_requestAccounts')).toHaveLength(1);
    publicBinding[cancel]();
    pending.resolve([COORDINATOR]);
    expect(await connect).toBe(false);
    expect(publicBinding.runtime.session.getSnapshot()).toMatchObject({ destination, activeDraftId: 'my-draft', actor: null, chainId: null });
    expect(publicBinding.getSnapshot().connecting).toBe(false);
    expect(provider.listenerCount()).toBe(cancel === 'dispose' ? 0 : 3);
    expect(draft.peek()).toEqual({ text: 'My contribution terms' });
    publicBinding.dispose();
  });

  it('provider discovery inspects capability without requesting accounts', () => {
    const provider = new FakeProvider();
    expect(injectedProvider({ ethereum: provider })).toBe(provider);
    for (const scope of [null, {}, { ethereum: null }, { ethereum: { request: 'not-callable' } }]) expect(injectedProvider(scope)).toBeUndefined();
    expect(provider.calls).toEqual([]);
  });

  it('reload restores only the live provider account, ignoring saved account-shaped data and remembered destinations', async () => {
    const storage = createMemoryStorage();
    const provider = new FakeProvider();
    const first = createPublicRuntime({ storage, namespace: 'refresh', provider, request: readyFixture().rpc.request });
    await first.ready;
    first.runtime.session.navigate({ name: 'events' });
    first.runtime.session.selectDraft('keep-this');
    first.dispose();
    storage.setItem('old-wallet-address', PUBLISHER);
    provider.accounts = [PUBLISHER];
    const restored = createPublicRuntime({ storage, namespace: 'refresh', provider, request: readyFixture().rpc.request });
    expect(restored.runtime.session.getSnapshot().actor).toBeNull();
    expect(await restored.ready).toBe(true);
    expect(restored.runtime.session.getSnapshot()).toMatchObject({ actor: { kind: 'wallet', address: PUBLISHER }, activeDraftId: 'keep-this' });
    expect(provider.calls.every(call => ['eth_accounts', 'eth_chainId'].includes(call.method))).toBe(true);
    restored.dispose();
  });

  it('explicit sign-out survives reload and wallet events until an explicit connection succeeds', async () => {
    const storage = createMemoryStorage(); const provider = new FakeProvider();
    const first = createPublicRuntime({ storage, namespace: 'signout', provider, request: readyFixture().rpc.request });
    await first.ready; first.disconnect(); first.dispose(); provider.calls.length = 0;
    const second = createPublicRuntime({ storage, namespace: 'signout', provider, request: readyFixture().rpc.request });
    expect(await second.ready).toBe(false);
    provider.emit('accountsChanged', [COORDINATOR]);
    expect(await second.restore()).toBe(false);
    expect(provider.calls).toEqual([]);
    expect(second.runtime.session.getSnapshot().actor).toBeNull();
    expect(await second.connect()).toBe(true);
    expect(storage.getItem(WALLET_SESSION_KEY)).toBe('"enabled"');
    second.dispose();
  });

  it('never prompts on a wrong-chain restore and passively resumes when the provider changes to Tiramisu', async () => {
    const provider = new FakeProvider(); provider.chain = '0x1';
    const { binding: publicBinding } = binding(provider);
    expect(await publicBinding.ready).toBe(false);
    expect(publicBinding.getSnapshot().error).toMatch(/another network/i);
    expect(publicBinding.runtime.session.getSnapshot().actor).toBeNull();
    provider.chain = `0x${TIRAMISU_CHAIN_ID.toString(16)}`;
    provider.emit('chainChanged', provider.chain);
    await publicBinding.restore();
    expect(publicBinding.runtime.session.getSnapshot().actor).toEqual({ kind: 'wallet', address: COORDINATOR });
    provider.accounts = [];
    provider.emit('accountsChanged', []);
    expect(publicBinding.runtime.session.getSnapshot().actor).toBeNull();
    await publicBinding.restore();
    expect(publicBinding.runtime.session.getSnapshot().actor).toBeNull();
    expect(provider.calls.every(call => ['eth_accounts', 'eth_chainId'].includes(call.method))).toBe(true);
    publicBinding.dispose();
  });

  it('shares sign-out and explicit sign-in between independent Studio and Desk runtimes without trusting broadcast identity', async () => {
    const peers = new Set<(message: WalletSessionMessage) => void>();
    const channel = (): WalletSessionChannel => {
      let own: ((message: WalletSessionMessage) => void) | undefined;
      return { publish(message) { for (const peer of peers) if (peer !== own) peer(message); },
        subscribe(listener) { own = listener; peers.add(listener); return () => { peers.delete(listener); }; } };
    };
    const storage = createMemoryStorage(); const studioProvider = new FakeProvider(); const deskProvider = new FakeProvider();
    deskProvider.accounts = [PUBLISHER];
    const studio = createPublicRuntime({ storage, namespace: 'studio-sync', provider: studioProvider, sessionChannel: channel(), request: readyFixture().rpc.request });
    const desk = createPublicRuntime({ storage, namespace: 'desk-sync', provider: deskProvider, sessionChannel: channel(), request: readyFixture().rpc.request });
    await Promise.all([studio.ready, desk.ready]);
    const { draft } = retainWork(desk.runtime);
    studio.disconnect();
    expect(desk.runtime.session.getSnapshot().actor).toBeNull();
    expect(await desk.restore()).toBe(false);
    expect(await studio.connect()).toBe(true);
    await desk.restore();
    expect(desk.runtime.session.getSnapshot().actor).toEqual({ kind: 'wallet', address: PUBLISHER });
    expect(deskProvider.calls.every(call => ['eth_accounts', 'eth_chainId'].includes(call.method))).toBe(true);
    expect(draft.peek()).toEqual({ text: 'My contribution terms' });
    studio.dispose(); desk.dispose();
  });

  it('a late passive response cannot restore authority after sign-out', async () => {
    const provider = new FakeProvider(); const pending = deferred<unknown>(); provider.passiveResponse = pending.promise;
    const { binding: publicBinding } = binding(provider);
    await Promise.resolve(); publicBinding.disconnect(); pending.resolve([COORDINATOR]);
    expect(await publicBinding.ready).toBe(false);
    expect(publicBinding.runtime.session.getSnapshot().actor).toBeNull();
    publicBinding.dispose();
  });

  it('storage write failures cannot restore or create wallet authority and do not prompt the provider', async () => {
    const provider = new FakeProvider();
    const storage = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    const publicBinding = createPublicRuntime({ storage, namespace: 'full-storage', provider, request: readyFixture().rpc.request });
    expect(await publicBinding.ready).toBe(false);
    expect(await publicBinding.connect()).toBe(false);
    expect(publicBinding.runtime.session.getSnapshot().actor).toBeNull();
    expect(provider.calls).toEqual([]);
    publicBinding.dispose();
  });
});
