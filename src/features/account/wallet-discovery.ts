import type { InjectedWalletProvider } from '../../data/wallet';
import type { StoragePort } from '../../app/storage';

export interface AvailableWallet { id: string; name: string; provider: InjectedWalletProvider }
export interface WalletDiscovery {
  getSnapshot(): readonly AvailableWallet[];
  subscribe(listener: () => void): () => void;
  refresh(): void;
  dispose(): void;
}
export const WALLET_PROVIDER_KEY = 'partfolk:wallet-provider:v1';
export function walletProvider(value: unknown): InjectedWalletProvider | undefined {
  return value && typeof value === 'object' && 'request' in value && typeof value.request === 'function'
    ? value as InjectedWalletProvider : undefined;
}
export function preferredWallet(storage: StoragePort | null): string | null {
  try { const value = storage?.getItem(WALLET_PROVIDER_KEY); return value && value.length <= 200 ? value : null; } catch { return null; }
}
export function rememberWallet(storage: StoragePort | null, id: string): void {
  try { storage?.setItem(WALLET_PROVIDER_KEY, id); } catch { /* Account authority never comes from this preference. */ }
}
type DiscoveryScope = Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'> & { ethereum?: unknown };
function eventScope(value: unknown): value is DiscoveryScope {
  return !!value && typeof value === 'object' && 'addEventListener' in value && typeof value.addEventListener === 'function'
    && 'removeEventListener' in value && typeof value.removeEventListener === 'function' && 'dispatchEvent' in value && typeof value.dispatchEvent === 'function';
}

/** EIP-6963 announces installed providers. Discovery never asks for accounts or trusts remote artwork. */
export function createWalletDiscovery(scope?: unknown, fallback?: InjectedWalletProvider): WalletDiscovery {
  const events = eventScope(scope) ? scope : undefined;
  const injected = fallback ?? (scope && typeof scope === 'object' && 'ethereum' in scope ? walletProvider(scope.ethereum) : undefined);
  let wallets: readonly AvailableWallet[] = injected ? [{ id: 'injected', name: 'Browser wallet', provider: injected }] : [];
  const listeners = new Set<() => void>();
  const announce: EventListener = event => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object' || !('provider' in detail) || !('info' in detail)) return;
    const provider = walletProvider(detail.provider); const info = detail.info;
    if (!provider || !info || typeof info !== 'object' || !('name' in info) || !('rdns' in info)
      || typeof info.name !== 'string' || typeof info.rdns !== 'string'
      || !/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/i.test(info.rdns) || info.rdns.length > 180) return;
    const name = info.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
    if (!name) return;
    const id = `eip6963:${info.rdns.toLowerCase()}`;
    if (wallets.some(wallet => wallet.id === id && wallet.provider === provider && wallet.name === name)) return;
    // A branded announcement replaces only that same provider's generic fallback.
    wallets = [...wallets.filter(wallet => wallet.provider !== provider && wallet.id !== id), { id, name, provider }];
    listeners.forEach(listener => listener());
  };
  const refresh = () => {
    const lateProvider = events ? walletProvider(events.ethereum) : undefined;
    if (lateProvider && !wallets.some(wallet => wallet.provider === lateProvider)) {
      wallets = [...wallets.filter(wallet => wallet.id !== 'injected'), { id: 'injected', name: 'Browser wallet', provider: lateProvider }];
      listeners.forEach(listener => listener());
    }
    events?.dispatchEvent(new Event('eip6963:requestProvider'));
  };
  events?.addEventListener('eip6963:announceProvider', announce);
  refresh();
  return {
    getSnapshot: () => wallets,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    dispose() { events?.removeEventListener('eip6963:announceProvider', announce); listeners.clear(); },
  };
}
