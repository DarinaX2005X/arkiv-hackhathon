import { canonicalJson, hashCanonical } from '../../src/domain/canonical';
import { createOperationIntent } from '../../src/data/operations';
import type { CommandBase, OperationKind, WriteAuthority } from '../../src/data/types';
import type { AccountAddress, PublicEntityKey } from '../../src/domain/types';
import { ACTOR_IDS } from './scenario';
import type { ProofActor, ProofRoots, RevisionName } from './scenario';

export const ROOT_ACCOUNT: AccountAddress = '0x6267AB770266dA229130a2a75a52A9d578Fb0A5b';
export const PHASES = ['fund', 'publish-core', 'discover-oak', 'p1-propose', 'p1-accept', 'withdraw-oak',
  'discover-juniper', 'p2-propose', 'p2-accept', 'p3-propose', 'p3-accept'] as const;
export type ProofPhase = typeof PHASES[number];
export type RunnerPhase = ProofPhase | 'prepare' | 'verify' | 'export';
export type SignerName = ProofActor | 'coordinator';
export type MutationMethod = 'createProject' | 'registerPublisher' | 'replaceProject' | 'replaceBook' | 'publishProjectLink' | 'publishPlan';
export const PHASE_TRANSACTION_COUNTS: Record<ProofPhase, number> = { fund: 9, 'publish-core': 24, 'discover-oak': 5,
  'p1-propose': 9, 'p1-accept': 7, 'withdraw-oak': 1, 'discover-juniper': 5, 'p2-propose': 9, 'p2-accept': 7, 'p3-propose': 9, 'p3-accept': 7 };
export interface RunnerOptions {
  phase: RunnerPhase; broadcast: boolean; initialize: boolean; maxTransactions: number;
  reviewedCommit?: string; output?: string; studioStopped: boolean;
}
export interface FrozenAction {
  method: MutationMethod; actor: SignerName; command: CommandBase & Record<string, unknown>;
  codeCommit: string; confirmed: boolean; confirmedKeys: PublicEntityKey[];
}
export interface ProofState {
  version: 1; runId: string; chainId: 7738577; genesisHash: `0x${string}`; initializedAt: number;
  initialCodeCommit: string; rootAccount: AccountAddress; actors: Record<ProofActor, AccountAddress>;
  projectRoot: PublicEntityKey | null; publisherRoots: ProofRoots;
  proposals: Partial<Record<RevisionName, { proposalKey: PublicEntityKey; activationKey: PublicEntityKey; proposalHash: `0x${string}` }>>;
  actions: Record<string, FrozenAction>; completedPhases: ProofPhase[]; observationIds: string[];
}

export function parseOptions(args: string[]): RunnerOptions {
  const options: RunnerOptions = { phase: 'prepare', broadcast: false, initialize: false, maxTransactions: 1, studioStopped: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error('Duplicate runner option.');
    seen.add(flag);
    if (flag === '--broadcast') options.broadcast = true;
    else if (flag === '--initialize') options.initialize = true;
    else if (flag === '--studio-stopped') options.studioStopped = true;
    else if (flag === '--phase' && [...PHASES, 'prepare', 'verify', 'export'].includes(args[index + 1] as RunnerPhase)) options.phase = args[++index] as RunnerPhase;
    else if (flag === '--max-transactions' && /^\d+$/.test(args[index + 1] ?? '')) options.maxTransactions = Number(args[++index]);
    else if (flag === '--reviewed-commit' && /^[0-9a-f]{40}$/i.test(args[index + 1] ?? '')) options.reviewedCommit = args[++index]!.toLowerCase();
    else if (flag === '--output' && args[index + 1] && !args[index + 1]!.startsWith('--')) options.output = args[++index];
    else throw new Error('Unknown or malformed runner option.');
  }
  if (!Number.isSafeInteger(options.maxTransactions) || options.maxTransactions < 1 || options.maxTransactions > 32) throw new Error('Each invocation is bounded to 1–32 transactions.');
  if (options.initialize && (options.phase !== 'prepare' || options.broadcast)) throw new Error('Local account initialization is a separate prepare-only action.');
  if (options.broadcast && (!PHASES.includes(options.phase as ProofPhase) || !options.reviewedCommit)) throw new Error('Broadcast requires one named phase and an exact reviewed Git commit.');
  if (options.output && options.phase !== 'export') throw new Error('Public output is available only through the explicit export phase.');
  if (options.phase === 'export' && !options.output) throw new Error('Export requires an explicit public evidence output path.');
  return options;
}

export function assertPhaseOrder(state: ProofState, phase: ProofPhase): void {
  const index = PHASES.indexOf(phase);
  if (index < 0 || PHASES.slice(0, index).some(prior => !state.completedPhases.includes(prior))) throw new Error('Complete and verify every earlier phase before this phase.');
}

/** The same action ID is permanently bound to the full original command, including its lifetime. */
export function freezeAction(state: ProofState, actionId: string, actor: SignerName, method: MutationMethod,
  kind: OperationKind, authority: WriteAuthority, input: Record<string, unknown>, codeCommit: string, now: number): FrozenAction {
  const existing = state.actions[actionId];
  if (existing) {
    if (existing.actor !== actor || existing.method !== method || existing.command.operation.kind !== kind
      || canonicalJson(existing.command.operation.authority) !== canonicalJson(authority)) throw new Error('The saved action binding changed.');
    return structuredClone(existing);
  }
  const operation = createOperationIntent(kind, authority, input, { id: `pfp:${state.runId}:${actionId}`, now });
  const frozen: FrozenAction = { actor, method, codeCommit, command: { ...structuredClone(input), operation } as FrozenAction['command'], confirmed: false, confirmedKeys: [] };
  state.actions[actionId] = structuredClone(frozen);
  return frozen;
}

export function validateState(value: unknown): ProofState {
  const state = value as ProofState;
  const addr = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
  const key = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
  if (!state || state.version !== 1 || state.chainId !== 7738577 || !/^[a-z0-9-]{1,48}$/i.test(state.runId)
    || !key(state.genesisHash) || !Number.isSafeInteger(state.initializedAt) || !/^[0-9a-f]{40}$/i.test(state.initialCodeCommit)
    || state.rootAccount?.toLowerCase() !== ROOT_ACCOUNT.toLowerCase() || !state.actors
    || ACTOR_IDS.some(actor => !addr(state.actors[actor])) || Object.keys(state.actors).length !== ACTOR_IDS.length
    || new Set(Object.values(state.actors).map(item => item.toLowerCase())).size !== ACTOR_IDS.length
    || Object.values(state.actors).some(item => item.toLowerCase() === ROOT_ACCOUNT.toLowerCase())
    || (state.projectRoot !== null && !key(state.projectRoot)) || !state.publisherRoots || !state.actions || !state.proposals
    || !Array.isArray(state.completedPhases) || state.completedPhases.some(phase => !PHASES.includes(phase))
    || new Set(state.completedPhases).size !== state.completedPhases.length || !Array.isArray(state.observationIds)
    || state.observationIds.some(id => !/^[a-z0-9-]{1,64}$/.test(id))) throw new Error('The proof state is invalid. Preserve it for review; do not reset it.');
  for (const [actor, root] of Object.entries(state.publisherRoots)) if (!ACTOR_IDS.includes(actor as ProofActor) || !key(root)) throw new Error('Invalid publisher root mapping.');
  for (const [id, action] of Object.entries(state.actions)) {
    const command = action.command; const { operation, ...input } = command;
    if (!/^[a-z0-9:-]{1,64}$/.test(id) || !['coordinator', ...ACTOR_IDS].includes(action.actor)
      || !['createProject', 'registerPublisher', 'replaceProject', 'replaceBook', 'publishProjectLink', 'publishPlan'].includes(action.method)
      || operation.id !== `pfp:${state.runId}:${id}` || operation.inputHash !== hashCanonical(input)
      || operation.inputHash !== hashCanonical(operation.input) || !Array.isArray(action.confirmedKeys) || action.confirmedKeys.some(item => !key(item))) throw new Error('A saved frozen action has changed. Preserve its original journal.');
  }
  return structuredClone(state);
}
