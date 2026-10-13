import { describe, expect, it } from 'vitest';
import type { InjectedWalletProvider } from '../../data/wallet';
import { createWalletDiscovery } from './wallet-discovery';

function provider() {
  const calls: unknown[] = [];
  return { calls, request: async (input: unknown) => { calls.push(input); return []; } } satisfies InjectedWalletProvider & { calls: unknown[] };
}
class WalletScope extends EventTarget { ethereum?: unknown }
function announce(scope: WalletScope, detail: unknown) {
  const event = new Event('eip6963:announceProvider');
  Object.defineProperty(event, 'detail', { value: detail });
  scope.dispatchEvent(event);
}

describe('installed wallet discovery without browser control', () => {
  it('lists actual announcements and replaces only the same provider’s generic fallback without asking for accounts', () => {
    const scope = new WalletScope(); const first = provider(), second = provider(); scope.ethereum = first;
    const discovery = createWalletDiscovery(scope);
    expect(discovery.getSnapshot().map(wallet => wallet.name)).toEqual(['Browser wallet']);
    announce(scope, { provider: first, info: { name: 'First wallet', rdns: 'org.first.wallet', icon: 'https://untrusted.invalid/icon.svg' } });
    announce(scope, { provider: second, info: { name: 'Second wallet', rdns: 'org.second.wallet' } });
    announce(scope, { provider: first, info: { name: 'First wallet', rdns: 'org.first.wallet' } });
    expect(discovery.getSnapshot()).toEqual([
      { id: 'eip6963:org.first.wallet', name: 'First wallet', provider: first },
      { id: 'eip6963:org.second.wallet', name: 'Second wallet', provider: second },
    ]);
    expect(first.calls).toEqual([]); expect(second.calls).toEqual([]);
    discovery.dispose();
  });

  it('rejects invalid announcements and unsubscribes when disposed', () => {
    const scope = new WalletScope(), wallet = provider();
    const discovery = createWalletDiscovery(scope);
    for (const detail of [null, {}, { provider: {}, info: { name: 'Fake', rdns: 'com.fake' } },
      { provider: wallet, info: { name: 'Invalid', rdns: 'javascript:bad' } },
      { provider: wallet, info: { name: '\u0000', rdns: 'com.empty' } }]) announce(scope, detail);
    expect(discovery.getSnapshot()).toEqual([]);
    discovery.dispose();
    announce(scope, { provider: wallet, info: { name: 'Installed later', rdns: 'org.later.wallet' } });
    expect(discovery.getSnapshot()).toEqual([]); expect(wallet.calls).toEqual([]);
  });

  it('Check for wallets picks up late legacy injection and requests fresh EIP announcements without provider RPC', () => {
    const scope = new WalletScope(), wallet = provider(); let requests = 0, changes = 0;
    scope.addEventListener('eip6963:requestProvider', () => { requests++; });
    const discovery = createWalletDiscovery(scope);
    const unsubscribe = discovery.subscribe(() => { changes++; });
    scope.ethereum = wallet;
    discovery.refresh(); discovery.refresh();
    expect(discovery.getSnapshot()).toEqual([{ id: 'injected', name: 'Browser wallet', provider: wallet }]);
    expect(requests).toBe(3); expect(changes).toBe(1); expect(wallet.calls).toEqual([]);
    unsubscribe(); discovery.dispose();
  });
});
