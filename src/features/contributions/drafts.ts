import type { AppRuntime } from '../../app/context';
import { validRepositoryActionRecord } from '../../app/actions';
import { keccak256, toBytes } from 'viem';
import { isAccountAddress } from '../../app/ids';
import { parseRoute, safeReturnPath } from '../../app/routes';
import type { LoadResult, StorageIssue } from '../../app/storage';
import { hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID, type AccountAddress, type Actor } from '../../domain/types';
import { actorScope, isContributionDraft, type ContributionDraft } from './model';

const emptyDraft = (): ContributionDraft => ({ name: '', description: '', resources: [], offers: [] });
export interface VisitorContributionDraft {
  draft: ContributionDraft;
  /** Null is a legacy guest draft whose invitation was never stored. */
  destination: string | null;
  owner: AccountAddress | null;
  phase: 'available' | 'reserved' | 'adopted';
}
export interface ContributionDraftState { draft: ContributionDraft; saved: boolean; recovery: boolean; exists: boolean }
export interface VisitorDraftState { value: VisitorContributionDraft | null; issue: StorageIssue | null }
const meaningful = (draft: ContributionDraft) => Boolean(draft.name || draft.description || draft.resources.length || draft.offers.length
  || draft.publisherKind || Object.keys(draft.editorWindows ?? {}).length || Object.keys(draft.editorNumbers ?? {}).length);
function isVisitorDraft(value: unknown): value is VisitorContributionDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') === 'destination,draft,owner,phase' && isContributionDraft(item.draft)
    && (item.destination === null || typeof item.destination === 'string' && safeReturnPath(item.destination) === item.destination && parseRoute(item.destination).name === 'contributions')
    && (item.phase === 'available' && item.owner === null || ['reserved', 'adopted'].includes(String(item.phase)) && isAccountAddress(item.owner));
}
export const visitorDraftFingerprint = (value: VisitorContributionDraft): string => hashCanonical({ draft: value.draft, destination: value.destination });
const durableVersion = <T,>(loaded: LoadResult<T>): string => loaded.status === 'ready' ? `ready:${hashCanonical(loaded.value)}` : loaded.status;

function createContributionDrafts(runtime: AppRuntime) {
  const visitorStore = runtime.drafts('contribution-visitor-handoff', 'contribution-visitor-handoff', isVisitorDraft);
  const loadedVisitor = visitorStore.load();
  let visitorVersion = durableVersion(loadedVisitor);
  let legacyVisitor = false;
  let visitor: VisitorDraftState = { value: loadedVisitor.status === 'ready' ? loadedVisitor.value : null,
    issue: loadedVisitor.status === 'recovery' || loadedVisitor.status === 'unavailable' ? loadedVisitor.issue : null };
  const listeners = new Set<() => void>();
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  const opened = new Map<string, boolean>();
  const emitVisitor = () => { for (const listener of listeners) listener(); };
  function saveVisitor(value: VisitorContributionDraft): boolean {
    const saved = visitorStore.save(value);
    if (saved.persisted) { visitorVersion = `ready:${hashCanonical(value)}`; legacyVisitor = false; }
    visitor = { value: structuredClone(value), issue: saved.issue }; emitVisitor(); return saved.persisted;
  }
  function createSession(actor: Actor | null, id: string, initial: ContributionDraft) {
    const scope = actorScope(actor);
    const store = runtime.drafts(`contribution:${scope}:${id.slice(-50).replace(/[^a-zA-Z0-9._:-]/g, '_')}`, 'contribution', isContributionDraft);
    const loaded = store.load();
    let version = durableVersion(loaded);
    // An adopted guest snapshot remains available as recovery evidence, but never becomes another wallet's new input.
    const consumedGuest = actor === null && id === 'new' && visitor.value?.phase === 'adopted';
    let state: ContributionDraftState = { draft: loaded.status === 'ready' && !consumedGuest ? loaded.value : structuredClone(initial),
      saved: loaded.status === 'ready' && !consumedGuest, recovery: loaded.status === 'recovery', exists: loaded.status === 'ready' && !consumedGuest || loaded.status === 'recovery' };
    const observers = new Set<() => void>();
    const originalRecovery = store.exportRecovery();
    const update = (value: ContributionDraft, replaceRecovery = false) => {
      const current = runtime.session.getSnapshot();
      if (scope !== actorScope(current.actor)) return false;
      if (actor === null && id === 'new' && visitor.value?.phase === 'reserved') return false;
      if (actor === null && id === 'new') {
        const durable = visitorStore.load();
        if (durable.status === 'unavailable' || durableVersion(durable) !== visitorVersion) {
          // A stale guest tab cannot turn an already-owned snapshot back into an unowned draft.
          state = { ...state, draft: structuredClone(value), saved: false, exists: true };
          for (const observer of observers) observer();
          if (durable.status === 'unavailable' && current.mode === 'public' && parseRoute(current.destination).name === 'contributions'
            && (!visitor.value || visitor.value.phase === 'available')
            && (!visitor.issue || ['unavailable', 'write_failed'].includes(visitor.issue.code))) {
            // Keep the handoff visible/exportable through sign-in even when nothing can be read.
            // Its durable version is unchanged, so adoption still requires a fresh ownership check and reservation.
            visitor = { value: { draft: structuredClone(value), destination: current.destination, owner: null, phase: 'available' }, issue: durable.issue };
            emitVisitor();
          }
          return false;
        }
      }
      const saved = store.save(value, { replaceRecovery });
      if (saved.persisted) version = `ready:${hashCanonical(value)}`;
      state = { draft: structuredClone(value), saved: saved.persisted, recovery: saved.persisted ? false : state.recovery, exists: true };
      for (const observer of observers) observer();
      if (actor === null && id === 'new' && current.mode === 'public' && parseRoute(current.destination).name === 'contributions') {
        saveVisitor({ draft: structuredClone(value), destination: current.destination, owner: null, phase: 'available' });
      }
      return saved.persisted;
    };
    return { getSnapshot: () => state, subscribe: (listener: () => void) => { observers.add(listener); return () => observers.delete(listener); },
      update, matchesDurable: () => { const fresh = store.load(); return fresh.status !== 'unavailable' && durableVersion(fresh) === version; },
      resetGuest: () => { state = { draft: emptyDraft(), saved: false, recovery: false, exists: false }; for (const observer of observers) observer(); },
      exportDraft: () => store.export(state.draft), exportRecovery: () => originalRecovery ?? store.exportRecovery() };
  }
  const session = (actor: Actor | null, id: string, initial = emptyDraft()) => {
    const key = `${actorScope(actor)}:${id}`;
    let result = sessions.get(key);
    if (!result) { result = createSession(actor, id, initial); sessions.set(key, result); }
    return result;
  };
  // Preserve drafts written before this handoff record existed. Their destination requires an explicit choice.
  if (loadedVisitor.status === 'missing') {
    const legacy = session(null, 'new').getSnapshot();
    if (legacy.exists && meaningful(legacy.draft)) { visitor = { value: { draft: structuredClone(legacy.draft), destination: null, owner: null, phase: 'available' }, issue: null }; legacyVisitor = true; }
  }
  return {
    session,
    getVisitorSnapshot: () => visitor,
    subscribeVisitor: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    exportVisitor: () => visitor.value ? visitorStore.export(visitor.value) : visitorStore.exportRecovery(),
    exportVisitorRecovery: () => visitorStore.exportRecovery(),
    editorOpen(actor: Actor | null): boolean {
      const explicit = opened.get(actorScope(actor)); if (explicit !== undefined) return explicit;
      const value = visitor.value;
      return Boolean(value && meaningful(value.draft) && value.phase !== 'adopted'
        && (!value.owner || actor?.kind === 'wallet' && value.owner.toLowerCase() === actor.address.toLowerCase()));
    },
    setEditorOpen(actor: Actor | null, open: boolean) { opened.set(actorScope(actor), open); },
    adoptVisitor({ fingerprint, replaceExisting, replaceRecovery, pending }: {
      fingerprint: string; replaceExisting: boolean; replaceRecovery: boolean; pending: boolean;
    }): { ok: true } | { ok: false; message: string } {
      const current = runtime.session.getSnapshot(), value = visitor.value;
      if (current.mode !== 'public' || current.actor?.kind !== 'wallet' || current.chainId !== TIRAMISU_CHAIN_ID)
        return { ok: false, message: 'Connect your wallet on Tiramisu to continue this draft.' };
      if (pending) return { ok: false, message: 'Check the saved profile request before choosing another draft. It may already have been sent.' };
      const actionKey = keccak256(toBytes(`register-contribution:wallet:${current.actor.address.toLowerCase()}`)).slice(2);
      const action = runtime.drafts(`action:${actionKey}`, 'repository-action', validRepositoryActionRecord).load();
      if (action.status === 'recovery' || action.status === 'unavailable' || action.status === 'ready' && action.value.status === 'needs-verification')
        return { ok: false, message: 'The saved profile request needs verification or recovery before another draft can be selected.' };
      if (!value || value.phase === 'adopted' || visitorDraftFingerprint(value) !== fingerprint)
        return { ok: false, message: 'The guest draft changed. Review the current saved draft before continuing.' };
      if (value.owner && value.owner.toLowerCase() !== current.actor.address.toLowerCase())
        return { ok: false, message: 'This draft is already assigned to another wallet. Reconnect that wallet to finish.' };
      if (value.destination && value.destination !== current.destination)
        return { ok: false, message: 'Return to the original invitation before continuing this draft.' };
      if (visitor.issue && ['invalid_json', 'invalid_payload', 'unsupported_version', 'too_large', 'recovery_required'].includes(visitor.issue.code))
        return { ok: false, message: 'The saved draft handoff needs recovery. Keep its original backup; no wallet draft has been replaced.' };
      const target = session(current.actor, 'new'), targetState = target.getSnapshot();
      const durableVisitor = visitorStore.load();
      if (durableVisitor.status === 'unavailable' || durableVersion(durableVisitor) !== visitorVersion
        || legacyVisitor && !session(null, 'new').matchesDurable())
        return { ok: false, message: 'The guest draft changed in another window or could not be checked. Reload before choosing a draft; both copies are kept.' };
      if (!target.matchesDurable()) return { ok: false, message: 'This wallet’s saved draft changed in another window or could not be checked. Reload before replacing it.' };
      if (targetState.recovery && !replaceRecovery) return { ok: false, message: 'The wallet draft needs recovery. Save its original data before explicitly replacing it.' };
      if (targetState.exists && !targetState.recovery && !replaceExisting) return { ok: false, message: 'This wallet already has a draft. Choose which draft to continue.' };
      const reserved: VisitorContributionDraft = { ...value, owner: current.actor.address.toLowerCase() as AccountAddress, phase: 'reserved' };
      // Reserve ownership before the destination write. If either save fails, the full guest snapshot remains exportable.
      if (!saveVisitor(reserved)) return { ok: false, message: 'The draft handoff could not be saved. Your guest draft is kept here; export it or retry when storage is available.' };
      if (!target.matchesDurable()) return { ok: false, message: 'This wallet’s draft changed while the handoff was saved. Both drafts are kept; reload before continuing.' };
      if (!target.update(value.draft, replaceRecovery)) return { ok: false, message: 'The wallet draft could not be saved. Your guest copy is kept for this wallet; export it or retry.' };
      saveVisitor({ ...reserved, phase: 'adopted' });
      session(null, 'new').resetGuest();
      opened.set(actorScope(current.actor), true);
      return { ok: true };
    },
  };
}
const registries = new WeakMap<AppRuntime, ReturnType<typeof createContributionDrafts>>();
/** Runtime scope survives sign-in/onboarding and component remounts; owned drafts never change account keys. */
export function contributionDrafts(runtime: AppRuntime) {
  let registry = registries.get(runtime);
  if (!registry) { registry = createContributionDrafts(runtime); registries.set(runtime, registry); }
  return registry;
}
