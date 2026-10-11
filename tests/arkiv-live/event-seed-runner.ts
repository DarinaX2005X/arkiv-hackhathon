/** Explicit operator helper. Importing never reads credentials, creates signers or broadcasts. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { createOperatorRpc } from '../../src/cli/arkiv-rpc';
import { createArkivRepository } from '../../src/data/arkiv';
import type { ArkivRepository } from '../../src/data/arkiv/repository';
import { createArkivReadClient } from '../../src/data/arkiv/client';
import type { RpcRequest } from '../../src/data/arkiv/client';
import { publicKey } from '../../src/data/arkiv/envelope';
import { createEventRepository } from '../../src/data/events';
import type { EventRepositoryContract } from '../../src/data/events';
import { BrowserOperationStore, MemoryOperationStore, createOperationController, createOperationIntent } from '../../src/data/operations';
import type { OperationStore } from '../../src/data/operations';
import type { CommandBase, OperationKind, Result, WriteAuthority } from '../../src/data/types';
import { createWalletGateway, WalletOperationError } from '../../src/data/wallet';
import type { NativeWalletGateway } from '../../src/data/wallet';
import { canonicalJson, hashCanonical } from '../../src/domain/canonical';
import { attendanceStatus, deriveEventAvailability, isTestEventTerms } from '../../src/domain/events';
import type { EventAggregate } from '../../src/domain/events';
import { prepareDecision } from '../../src/domain/operations';
import { activeSource, deriveReadiness } from '../../src/domain/readiness';
import { PROTOCOL } from '../../src/domain/types';
import type { AccountAddress, ProjectAggregate, PublicEntityKey, SourcePlanRef } from '../../src/domain/types';
import { admitPublisherInput, planningInput, publishPlanInput } from '../../src/features/projects/selectors';
import { solve } from '../../src/domain/solver';
import { assertJournalContinuity, hydrateOriginalHashes, withCappedPreparation } from './runner';
import { atomicWriteJson, BudgetLedger, createFileStorage, createGuardedAccountProvider, LIVE_CHAIN_ID, LIVE_LIMIT_WEI,
  LiveSafetyError, PRIOR_SPEND_WEI, readJson, withRunLock } from './safety';
import type { BudgetDocument, ReadRpc } from './safety';
import type { BudgetRecord } from './safety';
import { ROOT_ACCOUNT, validateState } from './state';
import type { ProofState, SignerName } from './state';
import { ACTOR_IDS } from './scenario';
import { SEED_ATTENDEES, SEED_CONSENT_UNTIL, SEED_DISCLOSURE, SEED_IDS, SEED_LIFETIME_SECONDS,
  SEED_PARTICIPANT_ALIASES, SEED_RUN_ID, SEED_TRANSACTION_COUNT, seedMaterialBook, seedRecipe, seedScenarioHash, seedTerms } from './event-seed-scenario';
import type { SeedAccounts, SeedId, SeedProjectRoots } from './event-seed-scenario';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL = resolve(ROOT, '.local/product-proof');
const SEED_STATE = resolve(LOCAL, 'event-seed-state.json');
const METHODS = { createProject: 'create_project', registerPublisher: 'register_publisher', replaceBook: 'replace_book',
  replaceProject: 'replace_project', publishProjectLink: 'publish_project_link', publishPlan: 'publish_plan',
  publishEvent: 'publish_event', replaceAttendance: 'replace_attendance', replaceEvent: 'replace_event' } as const satisfies Record<string, OperationKind>;
type SeedMethod = keyof typeof METHODS;
export interface SeedAction { actor: SignerName; method: SeedMethod; command: CommandBase & Record<string, unknown>; confirmed: boolean; confirmedKeys: PublicEntityKey[] }
export interface EventSeedState {
  version: 1; runId: typeof SEED_RUN_ID; proofRunId: string; genesisHash: Hex; codeCommit: string; initializedAt: number;
  accounts: SeedAccounts; scenarioHash: string; publisherRoot: PublicEntityKey | null; projectRoots: SeedProjectRoots;
  actions: Record<string, SeedAction>; complete: boolean;
}
export interface SeedClient { core: ArkivRepository; events: EventRepositoryContract }
export interface SeedRuntime {
  now(): number; client(actor: SignerName): SeedClient; save(state: EventSeedState): void | Promise<void>;
  reconcile(): Promise<void>; confirmed(action: SeedAction): boolean;
}
class SeedError extends Error {}
const ensure: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new SeedError(message); };
const take = <T>(result: Result<T>): T => { if (!result.ok) throw new SeedError(`Repository ${result.error.code}: ${result.error.reasons.map(reason => reason.code).join(', ')}`); return result.value; };
const isKey = (value: unknown): value is PublicEntityKey => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const accountFor = (state: EventSeedState, actor: SignerName): AccountAddress => (actor === 'coordinator' ? ROOT_ACCOUNT : state.accounts[actor]).toLowerCase() as AccountAddress;
function bindingFor(id: string): { actor: SignerName; method: SeedMethod; event?: SeedId } | null {
  if (id === 'publisher') return { actor: 'ash', method: 'registerPublisher' };
  if (id === 'material') return { actor: 'ash', method: 'replaceBook' };
  for (const event of SEED_IDS) {
    const steps: Record<string, [SignerName, SeedMethod]> = { project: ['coordinator', 'createProject'], offer: ['ash', 'publishProjectLink'],
      admit: ['coordinator', 'replaceProject'], plan: ['coordinator', 'publishPlan'], accept: ['ash', 'replaceBook'], publish: ['coordinator', 'publishEvent'] };
    for (const [suffix, [actor, method]] of Object.entries(steps)) if (id === `${event}-${suffix}`) return { actor, method, event };
    for (const actor of SEED_ATTENDEES[event]) if (id === `${event}-guest-${actor}`) return { actor, method: 'replaceAttendance', event };
    if (event === 'bookbinding' && id === 'bookbinding-confirm') return { actor: 'coordinator', method: 'replaceEvent', event };
  }
  return null;
}

export function createSeedState(proof: Pick<ProofState, 'runId' | 'actors' | 'genesisHash' | 'completedPhases'>, commit: string, now: number): EventSeedState {
  ensure(proof.completedPhases.includes('p3-accept'), 'Finish and export the original proof before initializing seed writes.');
  return validateSeedState({ version: 1, runId: SEED_RUN_ID, proofRunId: proof.runId, genesisHash: proof.genesisHash, codeCommit: commit,
    initializedAt: now, accounts: structuredClone(proof.actors), scenarioHash: seedScenarioHash(proof.actors), publisherRoot: null,
    projectRoots: {}, actions: {}, complete: false });
}

export function validateSeedState(input: unknown): EventSeedState {
  const state = input as EventSeedState;
  ensure(state && state.version === 1 && state.runId === SEED_RUN_ID && typeof state.proofRunId === 'string'
    && /^[a-z0-9-]{1,48}$/i.test(state.proofRunId) && isKey(state.genesisHash) && /^[0-9a-f]{40}$/.test(state.codeCommit)
    && Number.isSafeInteger(state.initializedAt) && state.initializedAt >= 0 && state.accounts && Object.keys(state.accounts).length === ACTOR_IDS.length
    && ACTOR_IDS.every(actor => /^0x[0-9a-fA-F]{40}$/.test(state.accounts[actor]))
    && new Set(Object.values(state.accounts).map(value => value.toLowerCase())).size === ACTOR_IDS.length
    && !Object.values(state.accounts).some(value => value.toLowerCase() === ROOT_ACCOUNT.toLowerCase())
    && state.scenarioHash === seedScenarioHash(state.accounts) && (state.publisherRoot === null || isKey(state.publisherRoot))
    && state.projectRoots && Object.entries(state.projectRoots).every(([id, value]) => SEED_IDS.includes(id as SeedId) && isKey(value))
    && state.actions && !Array.isArray(state.actions) && typeof state.complete === 'boolean', 'The saved seed identity or scenario differs; preserve its original journals.');
  for (const [id, action] of Object.entries(state.actions)) {
    const binding = bindingFor(id);
    ensure(/^[a-z0-9-]{1,64}$/.test(id) && action && Object.hasOwn(METHODS, action.method)
      && ['coordinator', ...ACTOR_IDS].includes(action.actor) && typeof action.confirmed === 'boolean'
      && binding?.actor === action.actor && binding.method === action.method
      && Array.isArray(action.confirmedKeys) && action.confirmedKeys.every(isKey) && (!action.confirmed || action.confirmedKeys.length > 0)
      && action.command?.operation && action.command.lifetimeSeconds === SEED_LIFETIME_SECONDS, 'The saved seed action is invalid.');
    const { operation, ...fields } = action.command;
    ensure(operation.id === `pfe:${state.runId}:${id}` && operation.kind === METHODS[action.method]
      && operation.inputHash === hashCanonical(fields) && operation.inputHash === hashCanonical(operation.input)
      && operation.authority.mode === 'public' && operation.authority.chainId === LIVE_CHAIN_ID
      && operation.authority.actor.address.toLowerCase() === accountFor(state, action.actor).toLowerCase(), 'The frozen seed command or authority changed.');
    const material = fields as Record<string, unknown>;
    if (action.method === 'registerPublisher') ensure(material.kind === 'organization' && material.name === 'Synthetic Partfolk Workshop Crew'
      && material.description === SEED_DISCLOSURE, 'The frozen seed publisher differs.');
    if (action.method === 'replaceBook') ensure(state.publisherRoot && material.publisherRoot === state.publisherRoot
      && (material.book as { publisherRoot?: unknown })?.publisherRoot === state.publisherRoot, 'Only the dedicated seed book may change.');
    if (binding.event) {
      const target = state.projectRoots[binding.event];
      if (action.method === 'createProject') ensure(canonicalJson(material.recipe) === canonicalJson(seedRecipe(binding.event)), 'The frozen seed recipe differs.');
      else if (action.method === 'publishProjectLink') {
        const link = material.link as { projectRoot?: unknown; publisherRoot?: unknown; linkKind?: unknown; offerIds?: unknown };
        ensure(target && link.projectRoot === target && link.publisherRoot === state.publisherRoot && link.linkKind === 'offer'
          && canonicalJson(link.offerIds) === canonicalJson(seedRecipe(binding.event).variants[0]!.requirements.map(item => `${binding.event}-${item.id}`)), 'The frozen seed discovery scope differs.');
      } else if (action.method !== 'replaceBook') ensure(target && material.projectRoot === target, 'Only the dedicated seed project may change.');
      if (action.method === 'publishEvent') ensure(canonicalJson(material.terms) === canonicalJson(seedTerms(binding.event)), 'The frozen synthetic audience terms differ.');
    }
  }
  if (state.complete) ensure(Object.keys(state.actions).length === 30 && Object.values(state.actions).every(action => action.confirmed)
    && state.publisherRoot && SEED_IDS.every(id => state.projectRoots[id]), 'A complete seed must retain every confirmed action.');
  return structuredClone(state);
}

/** Requires the common app journal and reconciled budget to agree before skipping a completed action. */
export function seedActionConfirmed(action: SeedAction, store: OperationStore, budget: BudgetRecord[]): boolean {
  const records = store.list().filter(record => record.operation.id === action.command.operation.id);
  if (!action.confirmed || !records.length) return false;
  const keys = records.flatMap(record => record.step.confirmedKeys);
  if (canonicalJson(keys) !== canonicalJson(action.confirmedKeys)) return false;
  return records.every(record => {
    const native = budget.find(item => item.id === `${record.operation.id}:${record.step.id}`);
    const request = record.admission?.request;
    return record.step.status === 'confirmed' && record.operation.phase === 'complete' && record.operation.inputHash === action.command.operation.inputHash
      && !!request && !!record.receipt && native?.kind === 'native' && native.status === 'confirmed'
      && native.transactionHash === record.receipt.transactionHash && native.transactionHash === record.step.transactionHash
      && native.plan.from === request.from.toLowerCase() && native.plan.to === request.to.toLowerCase() && native.plan.data === request.data.toLowerCase()
      && native.plan.value === '0' && native.plan.chainId === LIVE_CHAIN_ID && native.plan.gas === BigInt(request.gas!).toString()
      && native.plan.maxFeePerGas === BigInt(request.maxFeePerGas!).toString() && native.plan.maxPriorityFeePerGas === BigInt(request.maxPriorityFeePerGas!).toString();
  });
}

/** Scenario orchestrator is shared by fixture and operator runtimes; only production repositories mutate data. */
export class EventSeedRun {
  constructor(readonly state: EventSeedState, readonly runtime: SeedRuntime) { validateSeedState(state); }
  private async save() { await this.runtime.save(validateSeedState(this.state)); }
  private async action(id: string, actor: SignerName, method: SeedMethod, build: () => Promise<Record<string, unknown>>) {
    let frozen = this.state.actions[id];
    if (frozen?.confirmed) {
      ensure(frozen.actor === actor && frozen.method === method && this.runtime.confirmed(frozen), 'A completed seed action lacks matching original verification journals.');
      return { operation: { confirmedKeys: frozen.confirmedKeys }, value: ['registerPublisher', 'createProject'].includes(method) ? { root: { key: publicKey(frozen.confirmedKeys[0]) } } : undefined };
    }
    await this.runtime.reconcile();
    if (!frozen) {
      const fields = await build(), authority: WriteAuthority = { mode: 'public', chainId: LIVE_CHAIN_ID, actor: { kind: 'wallet', address: accountFor(this.state, actor) } };
      frozen = { actor, method, command: { ...structuredClone(fields), operation: createOperationIntent(METHODS[method], authority, fields,
        { id: `pfe:${this.state.runId}:${id}`, now: this.runtime.now() }) } as SeedAction['command'], confirmed: false, confirmedKeys: [] };
      this.state.actions[id] = frozen; await this.save();
    }
    ensure(frozen.actor === actor && frozen.method === method, 'The original seed action binding differs.');
    const client = this.runtime.client(actor), repo = ['publishEvent', 'replaceAttendance', 'replaceEvent'].includes(method) ? client.events : client.core;
    const call = (repo as unknown as Record<SeedMethod, (input: never) => Promise<Result<unknown>>>)[method];
    const result = await call.call(repo, structuredClone(frozen.command) as never);
    await this.runtime.reconcile();
    const value = take(result) as { value?: unknown; operation: { confirmedKeys: PublicEntityKey[] } };
    frozen.confirmed = true; frozen.confirmedKeys = value.operation.confirmedKeys.map(publicKey); await this.save(); return value;
  }
  private project(id: SeedId): Promise<ProjectAggregate> {
    return this.runtime.client('coordinator').core.loadProject(publicKey(this.state.projectRoots[id])).then(take);
  }
  private event(id: SeedId): Promise<EventAggregate> {
    return this.runtime.client('coordinator').events.loadEvent(publicKey(this.state.projectRoots[id]), { includeSource: true }).then(take);
  }
  private async source(id: SeedId): Promise<SourcePlanRef> {
    const project = await this.project(id), source = activeSource(project);
    ensure(source && deriveReadiness(project, this.runtime.now()).status === 'ready', 'Fresh exact seed preparation consent is required.'); return source;
  }
  async run(): Promise<void> {
    ensure(this.runtime.now() < seedTerms('sketchbook').registration!.deadline!, 'The dated seed registration scenario is no longer timely.');
    const registered = await this.action('publisher', 'ash', 'registerPublisher', async () => ({ kind: 'organization', name: 'Synthetic Partfolk Workshop Crew', description: SEED_DISCLOSURE, lifetimeSeconds: SEED_LIFETIME_SECONDS }));
    const publisherRoot = publicKey((registered.value as { root: { key: string } }).root.key);
    ensure(!this.state.publisherRoot || this.state.publisherRoot === publisherRoot, 'A saved seed publisher differs.'); this.state.publisherRoot = publisherRoot; await this.save();
    for (const id of SEED_IDS) {
      const created = await this.action(`${id}-project`, 'coordinator', 'createProject', async () => ({ recipe: seedRecipe(id), lifetimeSeconds: SEED_LIFETIME_SECONDS }));
      const root = publicKey((created.value as ProjectAggregate).root.key);
      ensure(!this.state.projectRoots[id] || this.state.projectRoots[id] === root, 'A saved seed project differs.'); this.state.projectRoots[id] = root; await this.save();
    }
    await this.action('material', 'ash', 'replaceBook', async () => {
      const publisher = take(await this.runtime.client('ash').core.loadPublisher(publisherRoot)); ensure(publisher.book.status === 'unique', 'A unique dedicated seed book is required.');
      return { publisherRoot, expectedHeads: [publisher.book.entity.key], book: { ...seedMaterialBook(publisher.book.entity.payload, this.state.projectRoots), predecessorKeys: [publisher.book.entity.key] }, lifetimeSeconds: SEED_LIFETIME_SECONDS };
    });
    for (const id of SEED_IDS) {
      await this.action(`${id}-offer`, 'ash', 'publishProjectLink', async () => ({ lifetimeSeconds: SEED_LIFETIME_SECONDS,
        link: { protocol: PROTOCOL, schemaVersion: 1, entityType: 'project_link', operationId: `${id}-offer`, createdAt: this.runtime.now(), linkKind: 'offer', projectRoot: this.state.projectRoots[id], publisherRoot,
          offerIds: seedRecipe(id).variants[0]!.requirements.map(item => `${id}-${item.id}`) } }));
      const discovery = take(await this.runtime.client('coordinator').core.listIncomingOffers(publicKey(this.state.projectRoots[id])));
      ensure(discovery.snapshot.completeness === 'complete' && discovery.items.some(item => item.publisher?.root.key === publisherRoot && item.status === 'current'), 'Fresh authored seed offer discovery is required.');
      await this.action(`${id}-admit`, 'coordinator', 'replaceProject', async () => ({ ...admitPublisherInput(await this.project(id), publisherRoot, `${id}-admit`, this.runtime.now()), lifetimeSeconds: SEED_LIFETIME_SECONDS }));
      await this.action(`${id}-plan`, 'coordinator', 'publishPlan', async () => {
        const project = await this.project(id), input = planningInput(project); ensure(input, 'Seed planning input is unavailable.');
        const solved = solve(input), candidate = solved.candidates[0]; ensure(candidate && solved.status === 'found', 'The real solver could not produce the seed preparation plan.');
        ensure(candidate.plan.requiredApprovers.length === 1 && candidate.plan.requiredApprovers[0] === publisherRoot, 'Every actual seed approver must receive and accept the exact plan.');
        return { ...publishPlanInput(project, candidate, `${id}-plan`, this.runtime.now(), SEED_DISCLOSURE), lifetimeSeconds: SEED_LIFETIME_SECONDS };
      });
      await this.action(`${id}-accept`, 'ash', 'replaceBook', async () => {
        const project = await this.project(id), decision = prepareDecision(project, publisherRoot, { kind: 'wallet', address: this.state.accounts.ash },
          { status: 'accepted', operationId: `${id}-accept`, now: this.runtime.now(), validUntil: SEED_CONSENT_UNTIL });
        ensure(decision.ok, 'The exact synthetic owner decision is invalid.');
        return { publisherRoot, expectedHeads: decision.value.expectedHeads, book: decision.value.book, lifetimeSeconds: SEED_LIFETIME_SECONDS };
      });
      await this.action(`${id}-publish`, 'coordinator', 'publishEvent', async () => ({ projectRoot: this.state.projectRoots[id], terms: seedTerms(id), source: await this.source(id), expectedHeads: [], lifetimeSeconds: SEED_LIFETIME_SECONDS }));
      for (const actor of SEED_ATTENDEES[id]) {
        await this.action(`${id}-guest-${actor}`, actor, 'replaceAttendance', async () => {
          const event = await this.event(id); ensure(event.release, 'The synthetic audience release is unavailable.');
          return { projectRoot: event.projectRoot, releaseKey: event.release.key, audienceHash: event.release.payload.audienceHash,
            decision: 'going', expectedHeads: [], ...(id === 'bookbinding' && actor === 'courtyard' ? { joinWaitlist: true } : {}), lifetimeSeconds: SEED_LIFETIME_SECONDS };
        });
      }
      if (id === 'bookbinding') await this.action(`${id}-confirm`, 'coordinator', 'replaceEvent', async () => {
        const event = await this.event(id); ensure(event.release && event.roster && event.state.status === 'unique', 'The exact limited roster is unavailable.');
        const admissions = SEED_ATTENDEES[id].slice(0, 3).map(actor => {
          const entry = event.roster!.entries.find(item => item.attendee === this.state.accounts[actor].toLowerCase());
          ensure(entry?.attendance.status === 'unique', 'An exact attendee-authored request is required.');
          return { attendee: entry.attendee, attendanceKey: entry.attendance.entity.key, releaseKey: event.release!.key };
        });
        return { projectRoot: event.projectRoot, releaseKey: event.release.key, audienceHash: event.release.payload.audienceHash,
          source: await this.source(id), status: 'open', expectedHeads: [event.state.entity.key], admissions, lifetimeSeconds: SEED_LIFETIME_SECONDS };
      });
    }
    await this.verify(); this.state.complete = true; await this.save();
  }
  async verify() {
    const events = [];
    for (const id of SEED_IDS) {
      const event = await this.event(id), source = await this.source(id);
      ensure(event.release && isTestEventTerms(event.release.payload.terms) && canonicalJson(event.release.payload.terms) === canonicalJson(seedTerms(id)), 'Seed terms or their authored disclosure differ.');
      ensure(deriveEventAvailability(event, this.runtime.now()) === (id === 'bookbinding' ? 'waitlist' : 'open'), 'The seed registration status differs.');
      ensure(event.roster?.entries.length === SEED_ATTENDEES[id].length, 'The synthetic attendee count differs.');
      for (const actor of SEED_ATTENDEES[id]) {
        const mine = take(await this.runtime.client(actor).events.listMyEvents({ kind: 'wallet', address: this.state.accounts[actor] }));
        const item = mine.items.find(item => item.projectRoot === event.projectRoot);
        ensure(item && item.event && attendanceStatus(item.attendance, item.event, this.runtime.now(), item.registeredRelease) === (id === 'bookbinding' && actor === 'courtyard' ? 'waitlisted' : 'going'), 'A synthetic participant registration differs.');
      }
      events.push({ id, event, source });
    }
    const catalogue = take(await this.runtime.client('coordinator').events.listEvents());
    ensure(catalogue.snapshot.completeness === 'complete' && catalogue.snapshot.freshness === 'fresh'
      && events.every(({ event }) => catalogue.items.some(item => item.projectRoot === event.projectRoot)), 'The fresh catalogue does not discover every seed event.');
    return events;
  }
}

export interface SeedOptions { phase: 'prepare' | 'seed' | 'verify' | 'export'; broadcast: boolean; maxTransactions: number; reviewedCommit?: string; output?: string }
/** Gate before wallet admission, reservation or signer access. Receipt recovery does not pass this gate again. */
export function boundSeedGateway(base: NativeWalletGateway, options: {
  broadcast: boolean; maxTransactions: number; forwarded(): number; seedRecords(): number; onBoundary(): void;
}): NativeWalletGateway {
  return { ...base, submit: async (prepared, hooks) => {
    if (!options.broadcast || options.forwarded() >= options.maxTransactions) {
      options.onBoundary(); throw new WalletOperationError('The explicit seed invocation boundary prevents admission.', { kind: 'not_sent', code: 'unsupported' });
    }
    ensure(options.seedRecords() < SEED_TRANSACTION_COUNT, 'The authorized total seed send ceiling was reached.');
    return base.submit(prepared, hooks);
  } };
}
export function parseSeedOptions(args: string[]): SeedOptions {
  const options: SeedOptions = { phase: 'prepare', broadcast: false, maxTransactions: 1 }, seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!; ensure(!seen.has(flag), 'Duplicate seed option.'); seen.add(flag);
    if (flag === '--broadcast') options.broadcast = true;
    else if (flag === '--phase' && ['prepare', 'seed', 'verify', 'export'].includes(args[index + 1] ?? '')) options.phase = args[++index] as SeedOptions['phase'];
    else if (flag === '--max-transactions' && /^\d+$/.test(args[index + 1] ?? '')) options.maxTransactions = Number(args[++index]);
    else if (flag === '--reviewed-commit' && /^[0-9a-f]{40}$/i.test(args[index + 1] ?? '')) options.reviewedCommit = args[++index]!.toLowerCase();
    else if (flag === '--output' && args[index + 1] && !args[index + 1]!.startsWith('--')) options.output = args[++index];
    else throw new SeedError('Unknown or malformed seed option.');
  }
  ensure(Number.isSafeInteger(options.maxTransactions) && options.maxTransactions >= 1 && options.maxTransactions <= 32, 'An invocation admits only 1–32 transactions.');
  ensure(!options.broadcast || (options.phase === 'seed' && options.reviewedCommit), 'Broadcast requires the seed phase and an exact reviewed commit.');
  ensure(!options.output || options.phase === 'export', 'Output is available only for public export.');
  ensure(options.phase !== 'export' || options.output, 'Export requires a new public evidence path.'); return options;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseSeedOptions(args), commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (options.broadcast) {
    ensure(commit === options.reviewedCommit, 'Broadcast requires this exact reviewed commit.');
    ensure(!execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'Commit and review source changes before broadcast.');
  }
  const proof = validateState(readJson(resolve(LOCAL, 'state.json'))), document = readJson<BudgetDocument>(resolve(LOCAL, 'budget.json'));
  ensure(document && document.rootAccount.toLowerCase() === ROOT_ACCOUNT.toLowerCase() && document.limitWei === LIVE_LIMIT_WEI
    && document.priorSpendWei === PRIOR_SPEND_WEI, 'The original cumulative budget must be preserved.');
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (options.phase === 'prepare') {
    const budget = new BudgetLedger(document, () => { throw new SeedError('Prepare cannot mutate the budget.'); }).publicSummary();
    emit({ mode: 'read-only-prepare', prerequisite: 'Original 92-send proof complete and exported before seed writes', originalProofComplete: proof.completedPhases.includes('p3-accept'),
      plannedSends: SEED_TRANSACTION_COUNT, fundingTransfers: 0, budget, events: SEED_IDS.map(id => ({ id, terms: seedTerms(id), recipe: seedRecipe(id),
        participants: SEED_ATTENDEES[id].map(actor => ({ alias: SEED_PARTICIPANT_ALIASES[actor], address: proof.actors[actor] })) })) }); return;
  }
  ensure(proof.completedPhases.includes('p3-accept'), 'Finish and export the original proof before seed writes.');
  const originalEvidence = readJson<{ format: string; version: number; runId: string; genesisHash: string; projectRoot: string;
    proposals: unknown; completedPhases: string[] }>(resolve(ROOT, 'arkiv/evidence/product-proof.json'));
  ensure(originalEvidence?.format === 'partfolk-product-proof' && originalEvidence.version === 1 && originalEvidence.runId === proof.runId
    && originalEvidence.genesisHash === proof.genesisHash && originalEvidence.projectRoot === proof.projectRoot
    && canonicalJson(originalEvidence.proposals) === canonicalJson(proof.proposals)
    && originalEvidence.completedPhases.includes('p3-accept'), 'Export matching completed original proof evidence before seed writes.');
  const raw = createOperatorRpc({ autoDetectDirectory: ROOT }).request;
  const read = createArkivReadClient(raw).request as ReadRpc;
  ensure(BigInt(await read({ method: 'eth_chainId' }) as string) === BigInt(LIVE_CHAIN_ID), 'Wrong seed network.');
  const genesis = await read({ method: 'eth_getBlockByNumber', params: ['0x0', false] }) as { hash?: string };
  ensure(genesis.hash === proof.genesisHash, 'The saved proof network genesis differs.');
  await withRunLock(ROOT_ACCOUNT, async () => {
    const currentProof = validateState(readJson(resolve(LOCAL, 'state.json')));
    ensure(currentProof.runId === proof.runId && canonicalJson(currentProof.actors) === canonicalJson(proof.actors), 'The original proof identity changed while acquiring locks.');
    let state = readJson<EventSeedState>(SEED_STATE);
    if (!state) {
      ensure(options.phase === 'seed', 'Initialize through the seed phase before verification or export.'); state = createSeedState(proof, commit, Date.now()); atomicWriteJson(SEED_STATE, state);
    } else state = validateSeedState(state);
    ensure(state.proofRunId === proof.runId && state.genesisHash === proof.genesisHash && canonicalJson(state.accounts) === canonicalJson(proof.actors), 'The saved seed belongs to another proof.');
    const latestBudget = readJson<BudgetDocument>(resolve(LOCAL, 'budget.json')); ensure(latestBudget, 'The cumulative ledger is missing.');
    ensure(latestBudget.rootAccount.toLowerCase() === ROOT_ACCOUNT.toLowerCase() && latestBudget.limitWei === LIVE_LIMIT_WEI
      && latestBudget.priorSpendWei === PRIOR_SPEND_WEI, 'The approved cumulative budget changed while acquiring locks.');
    const ledger = new BudgetLedger(latestBudget, next => atomicWriteJson(resolve(LOCAL, 'budget.json'), next));
    const store = new BrowserOperationStore(createFileStorage(resolve(LOCAL, 'operations.json')), { key: 'partfolk-product-proof-v1', locks: new MemoryOperationStore() });
    let forwarded = 0, boundary = false; const clients = new Map<SignerName, SeedClient>(), gateways: NativeWalletGateway[] = [];
    const runtime: SeedRuntime = {
      now: Date.now, save: next => atomicWriteJson(SEED_STATE, next),
      confirmed: action => seedActionConfirmed(action, store, ledger.snapshot().records),
      async reconcile() { assertJournalContinuity(proof.actions, store, ledger.snapshot().records); await ledger.reconcileAll(read); hydrateOriginalHashes(store, ledger.snapshot().records); },
      client(actor) {
        const existing = clients.get(actor); if (existing) return existing;
        const address = accountFor(state!, actor);
        const provider = createGuardedAccountProvider({ address, read, ledger, broadcast: options.broadcast,
          sendRaw: async transaction => { ensure(options.broadcast && forwarded < options.maxTransactions, 'The explicit invocation ceiling was reached.'); forwarded++; return raw({ method: 'eth_sendRawTransaction', params: [transaction] }); },
          loadAccount: async () => {
            ensure(options.broadcast, 'Signer access requires explicit broadcast.');
            try {
              const path = actor === 'coordinator' ? resolve(ROOT, '.local/demo-wallet.json') : resolve(LOCAL, `wallet-${actor}.json`);
              const wallet = JSON.parse(readFileSync(path, 'utf8')) as { network: string; chainId: number; address: string; privateKey: Hex; version?: number; role?: string };
              ensure(wallet.network === 'tiramisu' && wallet.chainId === LIVE_CHAIN_ID && (actor === 'coordinator' || (wallet.version === 1 && wallet.role === actor)), 'Unexpected synthetic signer.');
              const account = privateKeyToAccount(wallet.privateKey); ensure(account.address.toLowerCase() === address.toLowerCase() && wallet.address.toLowerCase() === address.toLowerCase(), 'Unexpected synthetic signer.'); return account;
            } catch { throw new LiveSafetyError('CANNOT_LOAD_EXPECTED_LOCAL_SIGNER'); }
          },
          resolveAdmission: request => {
            const matches = store.list().filter(item => item.admission && !['confirmed', 'reverted'].includes(item.step.status) && canonicalJson(item.admission.request) === canonicalJson(request));
            ensure(matches.length === 1, 'Exactly one saved admission must authorize the seed send.'); return { operationId: matches[0]!.operation.id, stepId: matches[0]!.step.id, request };
          } });
        const base = createWalletGateway({ provider, publicRpc: { request: read } });
        const gateway = boundSeedGateway(base, { broadcast: options.broadcast, maxTransactions: options.maxTransactions, forwarded: () => forwarded,
          seedRecords: () => ledger.snapshot().records.filter(item => item.id.startsWith(`pfe:${SEED_RUN_ID}:`)).length, onBoundary: () => { boundary = true; } });
        gateways.push(gateway); const controller = withCappedPreparation(createOperationController({ store, gateway }), store, base);
        const repositoryOptions = { request: read as RpcRequest, controller, receiptTimeoutMs: 45_000 };
        const client = { core: createArkivRepository(repositoryOptions), events: createEventRepository(repositoryOptions) }; clients.set(actor, client); return client;
      },
    };
    try {
      await runtime.reconcile(); const run = new EventSeedRun(state, runtime);
      if (options.phase === 'seed') {
        try { await run.run(); } catch (error) { if (!boundary) throw error; }
        emit({ phase: 'seed', complete: state.complete, transactionsForwardedThisInvocation: forwarded, plannedSends: SEED_TRANSACTION_COUNT, budget: ledger.publicSummary() });
      } else {
        ensure(state.complete, 'Complete every seed action before final verification or export.'); const verified = await run.verify();
        if (options.phase === 'export') {
          const output = resolve(ROOT, options.output!), within = relative(resolve(ROOT, 'arkiv/evidence'), output);
          ensure(within && !within.startsWith('..') && !/^[A-Za-z]:/.test(within) && output.endsWith('.json'), 'Export must be a new JSON file inside arkiv/evidence.');
          const evidence = { format: 'partfolk-test-event-seed', version: 1, synthetic: true, chainId: LIVE_CHAIN_ID, exportedAt: new Date().toISOString(), codeCommit: commit,
            proofRunId: state.proofRunId, scenarioHash: state.scenarioHash, publisherRoot: state.publisherRoot, projectRoots: state.projectRoots,
            participants: ACTOR_IDS.map(actor => ({ alias: SEED_PARTICIPANT_ALIASES[actor], address: state!.accounts[actor] })),
            events: verified.map(({ id, event, source }) => ({ id, projectRoot: event.projectRoot, source, snapshot: event.snapshot, release: event.release,
              state: event.state, roster: event.roster, sourceDependencies: { root: event.sourceProject?.root, state: event.sourceProject?.state,
                proposal: event.sourceProject?.proposal, activation: event.sourceProject?.activation, publishers: event.sourceProject?.publishers } })),
            budget: ledger.publicSummary(), limitation: SEED_DISCLOSURE + ' Nominal 90-day block lifetimes are not UTC retention guarantees. UI review belongs to the user.' };
          mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' }); emit({ exported: relative(ROOT, output).replaceAll('\\', '/') });
        } else emit({ verified: true, projects: state.projectRoots, budget: ledger.publicSummary() });
      }
    } finally { gateways.forEach(gateway => gateway.dispose()); }
  }, { runId: SEED_RUN_ID, accounts: Object.values(proof.actors) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof LiveSafetyError ? error.code : error instanceof SeedError ? error.message : 'SEED_RECONCILIATION_REQUIRED';
    process.stderr.write(`${JSON.stringify({ stopped: true, message, retryPolicy: 'Preserve every journal and reconcile the original operation before another send.' })}\n`); process.exitCode = 1;
  });
}
