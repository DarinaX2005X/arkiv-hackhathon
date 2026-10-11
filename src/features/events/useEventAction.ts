import { useMemo, useRef, useSyncExternalStore } from 'react';
import { keccak256, toBytes } from 'viem';
import { createRepositoryActionController, validRepositoryActionRecord } from '../../app/actions';
import type { AppSession } from '../../app/session';
import { createDraftStore, type StoragePort } from '../../app/storage';
import type { EventRepositoryContract } from '../../data/events/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';

export function browserEventStorage(): StoragePort | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function useEventAction(repository: EventRepositoryContract | null, session: AppSession, channel: string, storage: StoragePort | null) {
  const sessionRef = useRef(session); sessionRef.current = session;
  const account = session.actor?.kind === 'wallet' ? session.actor.address.toLowerCase() : 'signed-out';
  const controller = useMemo(() => createRepositoryActionController({ repository,
    store: createDraftStore({ storage, key: `partfolk:events:action:${keccak256(toBytes(`${channel}:${account}`))}`,
      kind: 'repository-action', validate: validRepositoryActionRecord }),
    getActor: () => sessionRef.current.mode === 'public' && sessionRef.current.chainId === TIRAMISU_CHAIN_ID ? sessionRef.current.actor : null,
  }), [repository, storage, channel, account]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { controller, state };
}
