import { createArkivReadClient, createArkivRepository, type RpcRequest } from '../data/arkiv';
import { BrowserOperationStore, createOperationController } from '../data/operations';
import { connectWallet, createWalletGateway } from '../data/wallet';
import { WalletOperationError, type InjectedWalletProvider, type NativeWalletGateway } from '../data/wallet/types';
import { createAppRuntime } from './context';
import type { StoragePort } from './storage';

export interface ConnectionSnapshot { connecting: boolean; error: string | null; hasProvider: boolean }
export interface PublicRuntimeOptions {
  storage: StoragePort | null; namespace: string; provider?: InjectedWalletProvider;
  request?: RpcRequest; now?: () => number;
}
/** Each independent client constructs its own connection. Reads never need a wallet. */
export function createPublicRuntime({ storage, namespace, provider, request, now = Date.now }: PublicRuntimeOptions) {
  let gateway: NativeWalletGateway | null = null;
  let disposed = false;
  let version = 0;
  let state: ConnectionSnapshot = { connecting: false, error: null, hasProvider: !!provider };
  const listeners = new Set<() => void>();
  const update = (next: Partial<ConnectionSnapshot>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
  const rpc = createArkivReadClient(request).request;
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
    update({ connecting: false, error: message });
  };
  return {
    runtime,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async connect(): Promise<boolean> {
      if (disposed || state.connecting) return false;
      if (!provider) { update({ error: 'A browser wallet is needed to publish. You can still read public projects without connecting.' }); return false; }
      if (!storage) { update({ error: 'Browser storage is unavailable. Publishing needs a saved transaction journal; your current work remains readable.' }); return false; }
      const attempt = ++version;
      forwardingGateway.dispose();
      runtime.session.setAccount(null);
      update({ connecting: true, error: null });
      try {
        const account = await connectWallet(provider);
        if (disposed || attempt !== version) return false;
        gateway?.dispose();
        gateway = createWalletGateway({ provider, publicRpc: { request: rpc },
          onSessionChange: () => clearAuthority('Your wallet account or network changed. Reconnect before publishing.') });
        runtime.session.setAccount({ kind: 'wallet', address: account.account }, account.chainId);
        update({ connecting: false, error: null });
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
    disconnect: () => clearAuthority(null),
    dispose: () => { disposed = true; clearAuthority(null); listeners.clear(); },
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
