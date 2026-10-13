import type { StoragePort } from '../../app/storage';

export const WALLET_SESSION_KEY = 'partfolk:wallet-session:v1';
export type WalletSessionMessage = { type: 'connected' | 'signed-out' | 'changed' };
export interface WalletSessionChannel {
  publish(message: WalletSessionMessage): void;
  subscribe(listener: (message: WalletSessionMessage) => void): () => void;
  close?(): void;
}

/** A preference to reconnect is never proof of an account or signing authority. */
export function readWalletPreference(storage: StoragePort | null): 'enabled' | 'signed-out' | 'unavailable' {
  if (!storage) return 'unavailable';
  try {
    const value = storage.getItem(WALLET_SESSION_KEY);
    if (value === null) return 'enabled';
    const parsed: unknown = JSON.parse(value);
    return parsed === 'enabled' || parsed === 'signed-out' ? parsed : 'unavailable';
  } catch { return 'unavailable'; }
}

export function saveWalletPreference(storage: StoragePort | null, value: 'enabled' | 'signed-out'): boolean {
  if (!storage) return false;
  try { storage.setItem(WALLET_SESSION_KEY, JSON.stringify(value)); return storage.getItem(WALLET_SESSION_KEY) === JSON.stringify(value); }
  catch { return false; }
}

/** Check writable storage before asking the wallet to connect. Never touch a journal. */
export function canSaveWalletSession(storage: StoragePort | null): boolean {
  if (!storage) return false;
  const key = 'partfolk:wallet-session:storage-check';
  try { storage.setItem(key, '1'); const saved = storage.getItem(key) === '1'; storage.removeItem(key); return saved; }
  catch { return false; }
}

const validMessage = (value: unknown): value is WalletSessionMessage => !!value && typeof value === 'object'
  && 'type' in value && ['connected', 'signed-out', 'changed'].includes(String(value.type));

/** Same-origin messages carry invalidation only. Every receiver asks its own provider. */
export function browserWalletSessionChannel(): WalletSessionChannel | undefined {
  if (typeof window === 'undefined') return undefined;
  const listeners = new Set<(message: WalletSessionMessage) => void>();
  let publishing = false;
  let broadcast: BroadcastChannel | undefined;
  try { if (typeof BroadcastChannel !== 'undefined') broadcast = new BroadcastChannel('partfolk:wallet-session'); } catch { /* Storage events remain available. */ }
  const deliver = (message: unknown) => { if (validMessage(message)) for (const listener of listeners) listener(message); };
  const onBroadcast = (event: MessageEvent<unknown>) => deliver(event.data);
  const onLocal = (event: Event) => { if (!publishing) deliver((event as CustomEvent<unknown>).detail); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === WALLET_SESSION_KEY && event.newValue === '"signed-out"') deliver({ type: 'signed-out' });
    else if (event.key === WALLET_SESSION_KEY && event.newValue === '"enabled"') deliver({ type: 'connected' });
  };
  broadcast?.addEventListener('message', onBroadcast);
  window.addEventListener('partfolk-wallet-session', onLocal);
  window.addEventListener('storage', onStorage);
  return {
    publish(message) {
      broadcast?.postMessage(message);
      publishing = true;
      try { window.dispatchEvent(new CustomEvent('partfolk-wallet-session', { detail: message })); } finally { publishing = false; }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {
      listeners.clear(); broadcast?.removeEventListener('message', onBroadcast); broadcast?.close();
      window.removeEventListener('partfolk-wallet-session', onLocal); window.removeEventListener('storage', onStorage);
    },
  };
}
