/** Coordinates the sign-in dialog with first-use guidance, without changing tour progress. */
export function createDialogActivity() {
  const active = new Set<symbol>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    getSnapshot: () => active.size > 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    enter() {
      const token = Symbol('wallet-dialog'); active.add(token); notify();
      return () => { if (active.delete(token)) notify(); };
    },
  };
}
export const walletDialogActivity = createDialogActivity();
