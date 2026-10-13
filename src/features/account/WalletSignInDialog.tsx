import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { PublicRuntimeBinding } from '../../app/network';
import { Button, Dialog, Link, Notice } from '../../ui';
import { AccountAvatar } from './AccountAvatar';
import { createAccountPreferences, readAccountPreferences } from './account';
import { walletDialogActivity } from './dialog-activity';

export interface WalletSignInDialogProps {
  binding: PublicRuntimeBinding; open: boolean; onClose: () => void; onConnected?: () => void;
}

export function WalletSignInDialog({ binding, open, onClose, onConnected }: WalletSignInDialogProps) {
  const connection = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  const session = useSyncExternalStore(binding.runtime.session.subscribe, binding.runtime.session.getSnapshot, binding.runtime.session.getSnapshot);
  const openRef = useRef(open); openRef.current = open;
  const wasOpen = useRef(false), initiator = useRef<HTMLElement | null>(null), ownsConnection = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') initiator.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  useLayoutEffect(() => {
    if (!open) return;
    openRef.current = true;
    const leave = walletDialogActivity.enter();
    binding.refreshWallets();
    return () => {
      openRef.current = false;
      if (ownsConnection.current && binding.getSnapshot().connecting) binding.cancelConnection();
      leave();
      setTimeout(() => {
        // Native Dialog restores an existing trigger. Successful sign-in can remove it.
        const active = document.activeElement;
        if (active instanceof Element && active.closest('dialog[open]')) return;
        if (!initiator.current?.isConnected || active === document.body) document.getElementById('account-commands')?.focus({ preventScroll: true });
      }, 0);
    };
  }, [binding, open]);
  const close = () => {
    openRef.current = false;
    if (ownsConnection.current && binding.getSnapshot().connecting) binding.cancelConnection();
    onClose();
  };
  const connected = () => {
    if (!openRef.current) return;
    const actor = binding.runtime.session.getSnapshot().actor;
    if (actor?.kind !== 'wallet') return;
    const store = createAccountPreferences(binding.runtime, actor.address);
    const preferences = readAccountPreferences(store.load()).value;
    if (!preferences.setupComplete) store.save({ ...preferences, setupComplete: true });
    openRef.current = false;
    onConnected?.(); onClose();
  };
  const connect = async (walletId: string) => {
    ownsConnection.current = true;
    try { if (await binding.connect(walletId)) connected(); }
    finally { ownsConnection.current = false; }
  };
  return <Dialog open={open} title="Sign in with your wallet" closeLabel="Close" onClose={close} className="pf-wallet-dialog pf-surface-light"
    description="Use one wallet to organize, contribute and take part."
    footer={<><Button variant="quiet" onClick={close}>{session.actor?.kind === 'wallet' ? 'Return to this page' : 'Continue without signing in'}</Button><Link href="/#/help?topic=publishing" onClick={close}>About public records</Link></>}>
    <div className="pf-wallet-intro"><WalletIcon /><p>Your wallet connects you to your events and contributions on Arkiv. You stay on this page after signing in.</p></div>
    {session.actor?.kind === 'wallet' ? <div className="pf-wallet-connected">
      <AccountAvatar address={session.actor.address} /><div><strong>Wallet connected</strong><p className="pf-account-address">{session.actor.address}</p></div>
      <Button onClick={connected}>Continue</Button>
    </div> : connection.wallets.length ? <div className="pf-wallet-options" aria-label="Available wallets" aria-busy={connection.connecting}>
      {connection.wallets.map(wallet => <Button key={wallet.id} className="pf-wallet-choice" variant="secondary"
        pending={connection.connecting && connection.selectedWalletId === wallet.id} pendingLabel={`Waiting for ${wallet.name}`}
        disabled={connection.connecting} onClick={() => { void connect(wallet.id); }}>
        <WalletIcon /><span className="pf-wallet-choice-name"><strong>{wallet.name}</strong><span>Available in this browser</span></span><span className="pf-wallet-choice-action">Connect</span>
      </Button>)}
    </div> : <div className="pf-wallet-empty"><h3>No wallet found</h3><p>Open Partfolk in a browser with an Ethereum-compatible wallet, or unlock your installed wallet and check again.</p><Button variant="secondary" onClick={binding.refreshWallets}>Check for wallets</Button></div>}
    {connection.error && <Notice tone="warning" role="alert" title="Sign-in needs your attention">{connection.error}</Notice>}
    {connection.connecting && <p className="pf-wallet-progress" role="status">Check your wallet to continue. You can close this dialog to cancel this connection.</p>}
    <p className="pf-wallet-permission">Connecting shares your wallet address and may ask to use Arkiv Tiramisu. It does not register you for an event, publish anything or approve a plan.</p>
  </Dialog>;
}

export function WalletIcon() {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false"><path d="M4 7.5V6a2 2 0 0 1 2-2h13v4H6a2 2 0 0 1 0-4M4 7.5V18a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V8H6a2 2 0 0 1-2-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 12h-4a2 2 0 0 0 0 4h4M16 14h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}
