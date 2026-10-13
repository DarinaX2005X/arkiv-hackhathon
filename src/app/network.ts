import { createArkivReadClient, createArkivRepository, type RpcRequest } from '../data/arkiv';
import { BrowserOperationStore, createOperationController } from '../data/operations';
import { connectWallet, createWalletGateway } from '../data/wallet';
import { WalletOperationError, type InjectedWalletProvider, type NativeWalletGateway } from '../data/wallet/types';
import { createAppRuntime } from './context';
import type { StoragePort } from './storage';
import { TIRAMISU_CHAIN_ID } from '../domain/types';
import { isAccountAddress } from './ids';
import { browserWalletSessionChannel, canSaveWalletSession, readWalletPreference, saveWalletPreference, type WalletSessionChannel } from '../features/account/wallet-session';

export interface ConnectionSnapshot { connecting: boolean; restoring: boolean; error: string | null; hasProvider: boolean }
export interface PublicRuntimeOptions {
  storage: StoragePort | null; namespace: string; provider?: InjectedWalletProvider;
  request?: RpcRequest; now?: () => number;
  sessionChannel?: WalletSessionChannel;
}
/** Each independent client constructs its own connection. Reads never need a wallet. */
export function createPublicRuntime({ storage, namespace, provider, request, now = Date.now, sessionChannel }: PublicRuntimeOptions) {
  let gateway: NativeWalletGateway | null = null;
  let disposed = false;
  let version = 0;
  let allowed = readWalletPreference(storage) === 'enabled';
  let state: ConnectionSnapshot = { connecting: false, restoring: false, error: null, hasProvider: !!provider };
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
    const attempt = ++version;
    forwardingGateway.dispose();
    runtime.session.setAccount(null);
    update({ restoring: true, error: null });
    try {
      const [accounts, chain] = await Promise.all([
        provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' }),
      ]);
      if (disposed || attempt !== version || !allowed) return false;
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof address !== 'string' || !isAccountAddress(address)) { update({ restoring: false }); return false; }
      if (typeof chain !== 'string' || !/^0x[\da-f]+$/i.test(chain) || BigInt(chain) !== BigInt(TIRAMISU_CHAIN_ID)) {
        update({ restoring: false, error: 'Your wallet is on another network. Sign in to switch to Arkiv Tiramisu.' }); return false;
      }
      gateway = createWalletGateway({ provider, publicRpc: { request: rpc } });
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
  provider?.on?.('accountsChanged', walletChanged);
  provider?.on?.('chainChanged', walletChanged);
  provider?.on?.('disconnect', walletDisconnected);
  const unsubscribe = channel?.subscribe(message => {
    if (disposed) return;
    if (message.type === 'signed-out') { allowed = false; clearAuthority(null); return; }
    if (message.type === 'changed' && state.connecting) return;
    if (message.type === 'connected') allowed = true;
    clearAuthority(null);
    void restore();
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
    ready, restore,
    async connect(): Promise<boolean> {
      if (disposed || state.connecting) return false;
      if (!provider) { update({ error: 'A browser wallet is needed to publish. You can still read public projects without connecting.' }); return false; }
      if (!canSaveWalletSession(storage)) { update({ error: 'Browser storage is unavailable. Publishing needs a saved transaction journal; your current work remains readable.' }); return false; }
      const attempt = ++version;
      forwardingGateway.dispose();
      runtime.session.setAccount(null);
      update({ connecting: true, restoring: false, error: null });
      try {
        const account = await connectWallet(provider);
        if (disposed || attempt !== version) return false;
        gateway?.dispose();
        if (!saveWalletPreference(storage, 'enabled')) {
          clearAuthority('Your connection could not be saved safely. Check browser storage and sign in again.'); return false;
        }
        allowed = true;
        gateway = createWalletGateway({ provider, publicRpc: { request: rpc } });
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
    cancelConnection: () => clearAuthority(null),
    dispose: () => {
      disposed = true; clearAuthority(null); unsubscribe?.();
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
  const provider = scope.ethereum;
  return provider && typeof provider === 'object' && 'request' in provider && typeof provider.request === 'function'
    ? provider as InjectedWalletProvider : undefined;
}
