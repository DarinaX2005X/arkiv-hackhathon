import { createArkivReadClient, createArkivRepository, type RpcRequest } from '../data/arkiv';
import { BrowserOperationStore, createOperationController } from '../data/operations';
import { connectWallet, createWalletGateway } from '../data/wallet';
import { WalletOperationError, type InjectedWalletProvider, type NativeWalletGateway } from '../data/wallet/types';
import { createAppRuntime } from './context';
import type { StoragePort } from './storage';
import { TIRAMISU_CHAIN_ID } from '../domain/types';
import { isAccountAddress } from './ids';
import { browserWalletSessionChannel, canSaveWalletSession, readWalletPreference, saveWalletPreference, type WalletSessionChannel } from '../features/account/wallet-session';
import { createWalletDiscovery, preferredWallet, rememberWallet, walletProvider, type WalletDiscovery } from '../features/account/wallet-discovery';

export interface ConnectionSnapshot {
  connecting: boolean; restoring: boolean; error: string | null; hasProvider: boolean;
  wallets: readonly { id: string; name: string }[]; selectedWalletId: string | null;
}
export interface PublicRuntimeOptions {
  storage: StoragePort | null; namespace: string; provider?: InjectedWalletProvider;
  request?: RpcRequest; now?: () => number;
  sessionChannel?: WalletSessionChannel;
  walletDiscovery?: WalletDiscovery;
}
/** Each independent client constructs its own connection. Reads never need a wallet. */
export function createPublicRuntime({ storage, namespace, provider: initialProvider, request, now = Date.now, sessionChannel, walletDiscovery }: PublicRuntimeOptions) {
  let gateway: NativeWalletGateway | null = null;
  let disposed = false;
  let version = 0;
  let allowed = readWalletPreference(storage) === 'enabled';
  const discovery = walletDiscovery ?? createWalletDiscovery(typeof window === 'undefined' ? undefined : window, initialProvider);
  const preferred = preferredWallet(storage);
  const initialWallet = discovery.getSnapshot().find(wallet => wallet.id === preferred)
    ?? (!preferred || preferred === 'injected' ? discovery.getSnapshot().find(wallet => wallet.provider === initialProvider) ?? discovery.getSnapshot()[0] : undefined);
  let provider = initialWallet?.provider;
  let state: ConnectionSnapshot = { connecting: false, restoring: false, error: null, hasProvider: discovery.getSnapshot().length > 0,
    wallets: discovery.getSnapshot().map(({ id, name }) => ({ id, name })), selectedWalletId: initialWallet?.id ?? null };
  const channel = sessionChannel ?? browserWalletSessionChannel();
  const listeners = new Set<() => void>();
  const update = (next: Partial<ConnectionSnapshot>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
  const readClient = createArkivReadClient(request);
  const rpc = readClient.request;
  const requireGateway = () => {
    if (!gateway) throw new WalletOperationError('Connect your wallet before publishing.', { kind: 'not_sent', code: 'not_connected' });
    return gateway;
  };
  const forwardingGateway: NativeWalletGateway = {
    prepare: (...args) => requireGateway().prepare(...args),
    submit: (...args) => requireGateway().submit(...args),
    dispose: () => { gateway?.dispose(); gateway = null; },
  };
  const controller = storage ? createOperationController({ store: new BrowserOperationStore(storage, {
    key: `${namespace}:wallet-operations:v1`, lockKey: 'partfolk:wallet-operation-lock',
  }), gateway: forwardingGateway, now }) : undefined;
  const repository = createArkivRepository({ request: rpc, controller, now });
  const runtime = createAppRuntime({ storage, namespace, repository, now });
  runtime.session.setMode('public');
  const clearAuthority = (message: string | null) => {
    version += 1;
    forwardingGateway.dispose();
    runtime.session.setAccount(null);
    update({ connecting: false, restoring: false, error: message });
  };
  const restore = async (): Promise<boolean> => {
    if (disposed || state.connecting || !allowed || !provider || !canSaveWalletSession(storage)) return false;
    const currentProvider = provider;
    const attempt = ++version;
    forwardingGateway.dispose();
    runtime.session.setAccount(null);
    update({ restoring: true, error: null });
    try {
      const [accounts, chain] = await Promise.all([
        currentProvider.request({ method: 'eth_accounts' }), currentProvider.request({ method: 'eth_chainId' }),
      ]);
      if (disposed || attempt !== version || !allowed) return false;
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof address !== 'string' || !isAccountAddress(address)) { update({ restoring: false }); return false; }
      if (typeof chain !== 'string' || !/^0x[\da-f]+$/i.test(chain) || BigInt(chain) !== BigInt(TIRAMISU_CHAIN_ID)) {
        update({ restoring: false, error: 'Your wallet is on another network. Sign in to switch to Arkiv Tiramisu.' }); return false;
      }
      gateway = createWalletGateway({ provider: currentProvider, publicRpc: { request: rpc } });
      runtime.session.setAccount({ kind: 'wallet', address: address.toLowerCase() as typeof address & `0x${string}` }, TIRAMISU_CHAIN_ID);
      update({ restoring: false, error: null });
      return true;
    } catch {
      if (!disposed && attempt === version) update({ restoring: false, error: 'Your wallet connection could not be restored. Sign in to try again.' });
      return false;
    }
  };
  const walletChanged = () => {
    if (state.connecting || disposed) return;
    clearAuthority(null);
    channel?.publish({ type: 'changed' });
    void restore();
  };
  const walletDisconnected = () => {
    if (disposed) return;
    clearAuthority('Your wallet disconnected. Sign in when you are ready to continue.');
    channel?.publish({ type: 'changed' });
  };
  const watchProvider = (next: InjectedWalletProvider | undefined) => {
    provider?.removeListener?.('accountsChanged', walletChanged); provider?.removeListener?.('chainChanged', walletChanged); provider?.removeListener?.('disconnect', walletDisconnected);
    provider = next;
    provider?.on?.('accountsChanged', walletChanged); provider?.on?.('chainChanged', walletChanged); provider?.on?.('disconnect', walletDisconnected);
  };
  provider?.on?.('accountsChanged', walletChanged);
  provider?.on?.('chainChanged', walletChanged);
  provider?.on?.('disconnect', walletDisconnected);
  const selectedWallet = () => {
    const wallets = discovery.getSnapshot();
    const preferred = preferredWallet(storage);
    if (preferred && preferred !== 'injected') return wallets.find(wallet => wallet.id === preferred);
    return wallets.find(wallet => wallet.id === preferred) ?? wallets.find(wallet => wallet.provider === provider) ?? wallets[0];
  };
  const unsubscribe = channel?.subscribe(message => {
    if (disposed) return;
    if (message.type === 'signed-out') { allowed = false; clearAuthority(null); return; }
    if (message.type === 'changed' && state.connecting) return;
    if (message.type === 'connected') {
      allowed = true;
      const selected = selectedWallet();
      // A peer's newly selected extension may announce later. Never restore the previous one.
      watchProvider(selected?.provider); update({ selectedWalletId: selected?.id ?? null });
    }
    clearAuthority(null);
    void restore();
  });
  const unsubscribeDiscovery = discovery.subscribe(() => {
    const wallets = discovery.getSnapshot();
    update({ wallets: wallets.map(({ id, name }) => ({ id, name })), hasProvider: wallets.length > 0 });
    if (state.connecting) return;
    const selected = selectedWallet();
    update({ selectedWalletId: selected?.id ?? null });
    if (selected?.provider !== provider) { clearAuthority(null); watchProvider(selected?.provider); void restore(); }
  });
  // Start after composition has attached its subscribers, with no approval or signing request.
  const ready = Promise.resolve().then(restore);
  return {
    runtime,
    // Feature repositories share this read boundary and durable operation controller.
    // No signer is exposed; writes still pass the live wallet gateway.
    client: readClient.client, request: rpc, controller, reader: repository.reader,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ready, restore, refreshWallets: discovery.refresh,
    async connect(walletId?: string): Promise<boolean> {
      if (disposed || state.connecting) return false;
      const selected = discovery.getSnapshot().find(wallet => wallet.id === (walletId ?? state.selectedWalletId))
        ?? (walletId ? undefined : discovery.getSnapshot()[0]);
      if (!selected) { update({ error: 'A browser wallet is needed to sign in. You can keep reading public projects without connecting.' }); return false; }
      if (!canSaveWalletSession(storage)) { update({ error: 'Browser storage is unavailable. Publishing needs a saved transaction journal; your current work remains readable.' }); return false; }
      const attempt = ++version;
      allowed = false;
      forwardingGateway.dispose();
      runtime.session.setAccount(null);
      watchProvider(selected.provider);
      update({ connecting: true, restoring: false, error: null, selectedWalletId: selected.id });
      try {
        const account = await connectWallet(selected.provider, { isCurrent: () => !disposed && attempt === version });
        if (disposed || attempt !== version) return false;
        gateway?.dispose();
        if (!saveWalletPreference(storage, 'enabled')) {
          clearAuthority('Your connection could not be saved safely. Check browser storage and sign in again.'); return false;
        }
        allowed = true;
        rememberWallet(storage, selected.id);
        gateway = createWalletGateway({ provider: selected.provider, publicRpc: { request: rpc } });
        runtime.session.setAccount({ kind: 'wallet', address: account.account }, account.chainId);
        update({ connecting: false, error: null });
        channel?.publish({ type: 'connected' });
        return true;
      } catch (error) {
        if (disposed || attempt !== version) return false;
        forwardingGateway.dispose();
        runtime.session.setAccount(null);
        const rejected = typeof error === 'object' && error !== null && 'code' in error && error.code === 4001;
        update({ connecting: false, error: rejected ? 'Wallet connection was cancelled. Your draft is still here.' : 'The wallet could not connect to Arkiv Tiramisu. Check the wallet and try again.' });
        return false;
      }
    },
    disconnect: () => {
      allowed = false;
      const persisted = saveWalletPreference(storage, 'signed-out');
      clearAuthority(persisted ? null : 'You are signed out here. This browser could not save that choice for your next visit.');
      channel?.publish({ type: 'signed-out' });
    },
    // A wallet can emit accountsChanged after its already-open prompt resolves.
    // Cancellation blocks those late passive responses until another explicit sign-in.
    cancelConnection: () => { allowed = false; clearAuthority(null); },
    dispose: () => {
      disposed = true; clearAuthority(null); unsubscribe?.(); unsubscribeDiscovery();
      if (!walletDiscovery) discovery.dispose();
      if (!sessionChannel) channel?.close?.();
      provider?.removeListener?.('accountsChanged', walletChanged); provider?.removeListener?.('chainChanged', walletChanged); provider?.removeListener?.('disconnect', walletDisconnected);
      listeners.clear();
    },
  };
}
export type PublicRuntimeBinding = ReturnType<typeof createPublicRuntime>;

/** Browser integration only; no request is sent merely by discovering a provider. */
export function injectedProvider(scope: unknown): InjectedWalletProvider | undefined {
  if (!scope || typeof scope !== 'object' || !('ethereum' in scope)) return undefined;
  return walletProvider(scope.ethereum);
}
