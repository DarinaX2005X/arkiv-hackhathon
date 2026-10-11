/** Operator-invoked synthetic proof. Importing this module never initializes signers or broadcasts. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createArkivRepository } from '../../src/data/arkiv';
import type { ArkivRepository } from '../../src/data/arkiv/repository';
import { createArkivReadClient } from '../../src/data/arkiv/client';
import { createOperatorRpc } from '../../src/cli/arkiv-rpc';
import type { RpcRequest as ArkivRpcRequest } from '../../src/data/arkiv/client';
import { publicKey } from '../../src/data/arkiv/envelope';
import { BrowserOperationStore, MemoryOperationStore, createOperationController } from '../../src/data/operations';
import type { OperationStore } from '../../src/data/operations';
import type { OperationController } from '../../src/data/operations';
import { createWalletGateway, WalletOperationError } from '../../src/data/wallet';
import type { NativeWalletGateway, NativeTransactionRequest } from '../../src/data/wallet';
import type { ExportPacket, OperationKind, PublicationProgress, Repository, Result, WriteAuthority } from '../../src/data/types';
import { canonicalJson } from '../../src/domain/canonical';
import { prepareDecision } from '../../src/domain/operations';
import { deriveRequiredApprovers } from '../../src/domain/validation';
import { PROTOCOL } from '../../src/domain/types';
import type { AccountAddress, AgreementHealth, ProjectAggregate, Proposal, SourcePlanRef } from '../../src/domain/types';
import { ACTOR_IDS, BASE_ACTORS, CHILD_FUNDING_WEI, LIFETIME_SECONDS, REVISION_NAMES, assertProofLineage, assertProofState,
  buildProofProposal, materialBook, proofConsentDeadline, publicRecipe, publisherTemplate } from './scenario';
import type { ProofActor, RevisionName } from './scenario';
import { verifyInFreshProcess } from './cli';
import { confirmedActionResult } from './confirmed-action';
import { BudgetLedger, LIVE_CHAIN_ID, LIVE_LIMIT_WEI, MAX_FEE_PER_GAS, MAX_GAS, PRIOR_SPEND_WEI,
  LiveSafetyError, atomicWriteJson, createBudgetDocument, createFileStorage, createGuardedAccountProvider,
  readJson, submitFunding, withRunLock } from './safety';
import type { BudgetDocument, BudgetRecord, ReadRpc } from './safety';
import { PHASES, PHASE_TRANSACTION_COUNTS, ROOT_ACCOUNT, assertPhaseOrder, freezeAction, parseOptions, validateState } from './state';
import type { FrozenAction, MutationMethod, ProofPhase, ProofState, RunnerOptions, SignerName } from './state';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL = resolve(ROOT, '.local/product-proof');
const STATE = resolve(LOCAL, 'state.json'), BUDGET = resolve(LOCAL, 'budget.json');
const FEES = { maxFeePerGas: MAX_FEE_PER_GAS.toString() as `${bigint}`, maxPriorityFeePerGas: '1' as const };
const hex = (value: bigint): Hex => `0x${value.toString(16)}`;
class ProofError extends Error {}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new ProofError(message); }
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const take = <T>(result: Result<T>): T => { if (!result.ok) throw new ProofError(`Repository ${result.error.code}: ${result.error.reasons.map(reason => reason.code).join(', ')}`); return result.value; };
const signerPath = (actor: ProofActor) => resolve(LOCAL, `wallet-${actor}.json`);
type WalletFile = { version?: number; role?: ProofActor; network: string; chainId: number; address: AccountAddress; privateKey: Hex };
type PublicObservation = { id: string; observedAt: string; codeCommit: string; studioStoppedDeclaredByOperator: boolean;
  packet: ExportPacket; independentPacket: ExportPacket; summary: ReturnType<typeof assertProofState> };
const CHECKPOINT_REVISIONS = { 'p1-awaiting': 'p1', 'p1-ready': 'p1', 'p1-changed': 'p1',
  'p2-awaiting': 'p2', 'p2-ready': 'p2', 'p3-awaiting': 'p3', 'p3-ready': 'p3' } as const;

/** Expected identities come from the saved successful publications, never from either client's observed history. */
export function expectedProofLineage(state: Pick<ProofState, 'projectRoot' | 'proposals'>, revision: RevisionName): SourcePlanRef[] {
  return REVISION_NAMES.slice(0, REVISION_NAMES.indexOf(revision) + 1).map(name => {
    const saved = state.proposals[name];
    ensure(saved, `The saved ${name} proposal reference is missing.`);
    return { projectRoot: publicKey(state.projectRoot), proposalKey: publicKey(saved.proposalKey),
      proposalHash: publicKey(saved.proposalHash), activationKey: publicKey(saved.activationKey) };
  });
}

/** Missing application journals are never interpreted as an unsent operation. */
export function assertJournalContinuity(actions: ProofState['actions'], store: OperationStore, records: BudgetRecord[]): void {
  const steps = store.list();
  for (const record of records.filter(item => item.kind === 'native')) {
    ensure(steps.some(step => `${step.operation.id}:${step.step.id}` === record.id && step.admission),
      'A reserved or signed transaction is missing its original application journal. Preserve all files for recovery.');
  }
  for (const step of steps.filter(item => item.admission)) {
    ensure(records.some(record => record.kind === 'native' && record.id === `${step.operation.id}:${step.step.id}`),
      'An admitted application operation is missing its cumulative budget record. Preserve all files for recovery.');
  }
  for (const action of Object.values(actions).filter(item => item.confirmed || item.confirmedKeys.length)) {
    ensure(steps.some(step => step.operation.id === action.command.operation.id),
      'A completed action is missing its original application journal. It cannot be initialized again.');
  }
}

function checkedAccount(wallet: WalletFile, expected?: string) {
  ensure(wallet.network === 'tiramisu' && wallet.chainId === LIVE_CHAIN_ID && /^0x[0-9a-f]{64}$/i.test(wallet.privateKey), 'The expected local signer is invalid.');
  const account = privateKeyToAccount(wallet.privateKey);
  ensure(account.address.toLowerCase() === wallet.address.toLowerCase() && (!expected || account.address.toLowerCase() === expected.toLowerCase()), 'The expected local signer address differs.');
  return account;
}

/** Only called behind explicit prepare --initialize; it never reads the coordinator secret. */
function initialize(genesisHash: Hex, commit: string): ProofState {
  ensure(!existsSync(STATE) && !existsSync(BUDGET), 'Existing proof state or budget must be reconciled; initialization cannot reset them.');
  const actors = {} as ProofState['actors'];
  for (const actor of ACTOR_IDS) {
    let wallet = readJson<WalletFile>(signerPath(actor));
    if (!wallet) {
      const privateKey = generatePrivateKey();
      wallet = { version: 1, role: actor, network: 'tiramisu', chainId: LIVE_CHAIN_ID, address: privateKeyToAccount(privateKey).address, privateKey };
      atomicWriteJson(signerPath(actor), wallet);
    }
    ensure(wallet.version === 1 && wallet.role === actor, 'A saved signer has an unexpected role.');
    actors[actor] = checkedAccount(wallet).address;
  }
  const state = validateState({ version: 1, runId: randomUUID(), chainId: LIVE_CHAIN_ID, genesisHash,
    initializedAt: Date.now(), initialCodeCommit: commit, rootAccount: ROOT_ACCOUNT, actors,
    projectRoot: null, publisherRoots: {}, proposals: {}, actions: {}, completedPhases: [], observationIds: [] });
  // Budget first: an interruption never leaves an apparently initialized run with an absent spend ledger.
  atomicWriteJson(BUDGET, createBudgetDocument({ rootAccount: ROOT_ACCOUNT }));
  atomicWriteJson(STATE, state); return state;
}

function checkPriorEvidence(): void {
  const bootstrap = readJson<{ chainId: number; receipt: { status: string; gasFeeWei: string } }>(resolve(ROOT, 'arkiv/evidence/bootstrap.json'));
  const atomic = readJson<{ chainId: number; status: string; budget: { probeSpentWei: string } }>(resolve(ROOT, 'arkiv/evidence/atomic-transition.json'));
  ensure(bootstrap?.chainId === LIVE_CHAIN_ID && bootstrap.receipt.status === 'success' && atomic?.chainId === LIVE_CHAIN_ID && atomic.status === 'verified'
    && BigInt(bootstrap.receipt.gasFeeWei) + BigInt(atomic.budget.probeSpentWei) === BigInt(PRIOR_SPEND_WEI), 'The prior paid capability evidence differs from the approved cumulative budget.');
}

/** Recover only the hash already durably signed; never create a replacement after a transport error. */
export function hydrateOriginalHashes(store: OperationStore, records: BudgetRecord[]): void {
  for (const saved of store.list()) {
    const record = records.find(item => item.id === `${saved.operation.id}:${saved.step.id}`);
    if (!record?.transactionHash || !saved.admission || ['confirmed', 'reverted'].includes(saved.step.status)) continue;
    const request = saved.admission.request, plan = record.plan;
    ensure(plan.from === request.from.toLowerCase() && plan.to === request.to.toLowerCase() && plan.data === request.data.toLowerCase()
      && plan.value === '0' && plan.chainId === Number(BigInt(request.chainId)) && plan.gas === BigInt(request.gas!).toString()
      && plan.maxFeePerGas === BigInt(request.maxFeePerGas!).toString() && plan.maxPriorityFeePerGas === BigInt(request.maxPriorityFeePerGas!).toString(), 'The stored admission does not match the original signed transaction.');
    ensure(!saved.submissionHash || saved.submissionHash === record.transactionHash, 'The journal already records a different transaction hash.');
    if (saved.submissionHash === record.transactionHash && saved.step.transactionHash === record.transactionHash) continue;
    saved.submissionHash = record.transactionHash; saved.step.transactionHash = record.transactionHash;
    saved.step.status = 'submitted'; saved.revision += 1; store.put(saved);
  }
}

/** The exact fee options belong to the operation journal, including after a read-only stop. */
export function withCappedPreparation(controller: OperationController, store: OperationStore, gateway: NativeWalletGateway): OperationController {
  return { ...controller, prepareStep: async input => {
    const saved = store.get(input.operation.id, input.step.id);
    const caps = saved?.prepared?.transactionOptions;
    if (caps) return controller.prepareStep({ ...input, transactionOptions: caps });
    return controller.prepareStep(input, async () => {
      ensure(input.operation.authority.mode === 'public', 'The proof requires a public signer.');
      const estimate = await gateway.prepare(input.batch, input.operation.authority.actor.address, FEES);
      const gas = (BigInt(estimate.estimatedGas) * 120n + 99n) / 100n;
      ensure(gas <= MAX_GAS, 'The actual SDK gas estimate exceeds the approved limit.');
      return { ...FEES, gas: gas.toString() as `${bigint}` };
    });
  } };
}

class PhaseBoundary extends Error {}
class ProofRun {
  readonly ledger: BudgetLedger;
  readonly store: BrowserOperationStore;
  private repositories = new Map<SignerName, ArkivRepository>();
  private gateways: NativeWalletGateway[] = [];
  private forwarded = 0;
  private boundary = false;
  private reconciled = false;
  private estimates: { account: string; gas: string; maximumCostWei: string | null }[] = [];
  constructor(readonly state: ProofState, readonly options: RunnerOptions, readonly commit: string, readonly read: ReadRpc,
    private readonly rawRpc: ReadRpc, private readonly accessKeyFile?: string) {
    const document = readJson<BudgetDocument>(BUDGET);
    ensure(document, 'The cumulative budget ledger is missing. Preserve the run for review.');
    ensure(document.rootAccount.toLowerCase() === ROOT_ACCOUNT.toLowerCase() && document.priorSpendWei === PRIOR_SPEND_WEI
      && document.limitWei === LIVE_LIMIT_WEI, 'The approved budget identity changed.');
    this.ledger = new BudgetLedger(document, next => atomicWriteJson(BUDGET, next));
    this.store = new BrowserOperationStore(createFileStorage(resolve(LOCAL, 'operations.json')),
      { key: 'partfolk-product-proof-v1', locks: new MemoryOperationStore() });
  }
  save() { atomicWriteJson(STATE, validateState(this.state)); }
  private address(actor: SignerName): AccountAddress { return actor === 'coordinator' ? ROOT_ACCOUNT : this.state.actors[actor]; }
  private authority(actor: SignerName): WriteAuthority { return { mode: 'public', chainId: LIVE_CHAIN_ID, actor: { kind: 'wallet', address: this.address(actor) } }; }
  private loadAccount = (actor: SignerName) => async () => {
    ensure(this.options.broadcast, 'Signer access requires explicit broadcast.');
    try {
      const path = actor === 'coordinator' ? resolve(ROOT, '.local/demo-wallet.json') : signerPath(actor);
      const wallet = JSON.parse(readFileSync(path, 'utf8')) as WalletFile;
      if (actor !== 'coordinator') ensure(wallet.version === 1 && wallet.role === actor, 'Unexpected signer role.');
      return checkedAccount(wallet, this.address(actor));
    } catch { throw new LiveSafetyError('CANNOT_LOAD_EXPECTED_LOCAL_SIGNER'); }
  };
  private sendRaw = async (raw: Hex): Promise<unknown> => {
    ensure(this.options.broadcast && this.forwarded < this.options.maxTransactions, 'The explicit transaction bound was reached.');
    this.forwarded += 1;
    return this.rawRpc({ method: 'eth_sendRawTransaction', params: [raw] });
  };
  repo(actor: SignerName = 'coordinator'): ArkivRepository {
    const existing = this.repositories.get(actor); if (existing) return existing;
    const provider = createGuardedAccountProvider({ address: this.address(actor), read: this.read, sendRaw: this.sendRaw,
      loadAccount: this.loadAccount(actor), ledger: this.ledger, broadcast: this.options.broadcast,
      resolveAdmission: request => {
        const matches = this.store.list().filter(item => item.admission && !['confirmed', 'reverted'].includes(item.step.status)
          && canonicalJson(item.admission.request) === canonicalJson(request));
        ensure(matches.length === 1, 'Exactly one durable application admission must authorize this transaction.');
        return { operationId: matches[0]!.operation.id, stepId: matches[0]!.step.id, request };
      } });
    const base = createWalletGateway({ provider, publicRpc: { request: this.read } });
    const gateway: NativeWalletGateway = {
      prepare: async (batch, account, options) => {
        const prepared = await base.prepare(batch, account, options);
        this.estimates.push({ account, gas: prepared.estimatedGas, maximumCostWei: prepared.estimatedMaximumCostWei });
        return prepared;
      },
      submit: async (prepared, hooks) => {
        if (!this.options.broadcast || this.forwarded >= this.options.maxTransactions) {
          this.boundary = true;
          throw new WalletOperationError('Prepared and estimated; the explicit invocation boundary prevents admission.', { kind: 'not_sent', code: 'unsupported' });
        }
        return base.submit(prepared, hooks);
      }, dispose: () => base.dispose(),
    };
    this.gateways.push(gateway);
    const controller = createOperationController({ store: this.store, gateway });
    const cappedController = withCappedPreparation(controller, this.store, base);
    const repo = createArkivRepository({ request: this.read as ArkivRpcRequest, controller: cappedController, receiptTimeoutMs: 45_000 });
    this.repositories.set(actor, repo); return repo;
  }
  async reconcile() {
    this.reconciled = false;
    assertJournalContinuity(this.state.actions, this.store, this.ledger.snapshot().records);
    await this.ledger.reconcileAll(this.read);
    hydrateOriginalHashes(this.store, this.ledger.snapshot().records);
    this.reconciled = true;
  }
  private async action(id: string, actor: SignerName, method: MutationMethod, kind: OperationKind,
    build: () => Promise<Record<string, unknown>>): Promise<unknown> {
    assertJournalContinuity(this.state.actions, this.store, this.ledger.snapshot().records);
    let frozen = this.state.actions[id];
    if (!frozen) {
      frozen = freezeAction(this.state, id, actor, method, kind, this.authority(actor), await build(), this.commit, Date.now());
      this.save();
    }
    ensure(frozen.actor === actor && frozen.method === method && frozen.command.operation.kind === kind
      && canonicalJson(frozen.command.operation.authority) === canonicalJson(this.authority(actor)), 'The original action binding differs.');
    if (frozen.confirmed) {
      ensure(this.reconciled, 'The cumulative ledger must be reconciled before resuming a completed action.');
      const completed = confirmedActionResult(frozen, this.store, this.ledger.snapshot().records);
      if (completed) return completed;
    }
    const call = this.repo(actor)[method] as unknown as (command: FrozenAction['command']) => Promise<Result<unknown>>;
    const result = await call.call(this.repo(actor), structuredClone(frozen.command));
    await this.reconcile();
    if (!result.ok && this.boundary) throw new PhaseBoundary();
    const value = take(result) as { operation: { confirmedKeys: string[] } };
    frozen.confirmed = true; frozen.confirmedKeys = value.operation.confirmedKeys.map(publicKey); this.state.actions[id] = frozen;
    this.save(); return value;
  }
  private project = async (): Promise<ProjectAggregate> => take(await this.repo().loadProject(publicKey(this.state.projectRoot)));
  private async register(actor: ProofActor) {
    const result = await this.action(`register-${actor}`, actor, 'registerPublisher', 'register_publisher', async () => {
      const { kind, name, description } = publisherTemplate(actor, publicKey(this.state.projectRoot));
      return { kind, name, description, lifetimeSeconds: LIFETIME_SECONDS };
    }) as { value: { root: { key: string } } };
    const root = publicKey(result.value.root.key);
    ensure(!this.state.publisherRoots[actor] || this.state.publisherRoots[actor] === root, 'A prior publisher root differs.');
    this.state.publisherRoots[actor] = root; this.save();
    await this.action(`material-${actor}`, actor, 'replaceBook', 'replace_book', async () => {
      const publisher = take(await this.repo(actor).loadPublisher(root));
      ensure(publisher.book.status === 'unique', 'A unique current owner book is required.');
      return { publisherRoot: root, expectedHeads: [publisher.book.entity.key],
        book: { ...materialBook(publisher.book.entity.payload, actor, publicKey(this.state.projectRoot)), predecessorKeys: [publisher.book.entity.key] }, lifetimeSeconds: LIFETIME_SECONDS };
    });
  }
  private async admit(id: string, actors: readonly ProofActor[]) {
    await this.action(id, 'coordinator', 'replaceProject', 'replace_project', async () => {
      const project = await this.project(); ensure(project.state.status === 'unique', 'A unique project state is required.');
      return { projectRoot: project.root.key, expectedHeads: [project.state.entity.key],
        state: { ...project.state.entity.payload, predecessorKeys: [project.state.entity.key], publisherRoots: [...new Set([...project.state.entity.payload.publisherRoots, ...actors.map(actor => publicKey(this.state.publisherRoots[actor]))])] },
        lifetimeSeconds: LIFETIME_SECONDS };
    });
  }
  private async discover(actor: 'oak' | 'juniper') {
    await this.register(actor);
    await this.action(`offer-${actor}`, actor, 'publishProjectLink', 'publish_project_link', async () => ({ lifetimeSeconds: LIFETIME_SECONDS,
      link: { protocol: PROTOCOL, schemaVersion: 1, entityType: 'project_link', operationId: `offer-${actor}`, createdAt: Date.now(),
        linkKind: 'offer', projectRoot: publicKey(this.state.projectRoot), publisherRoot: publicKey(this.state.publisherRoots[actor]),
        offerIds: publisherTemplate(actor, publicKey(this.state.projectRoot)).offers.map(offer => offer.id) } }));
    const discoveryPath = resolve(LOCAL, `discovery-${actor}.json`);
    if (!existsSync(discoveryPath)) {
      const project = await this.project(); ensure(project.state.status === 'unique', 'A unique project state is required.');
      const root = publicKey(this.state.publisherRoots[actor]);
      ensure(!project.state.entity.payload.publisherRoots.includes(root), 'Discovery evidence must precede admission.');
      const incoming = take(await this.repo().listIncomingOffers(project.root.key, { snapshot: project.snapshot }));
      const link = incoming.items.find(item => item.entity.payload.publisherRoot === root && item.status === 'current' && item.publisher);
      ensure(link, 'The direct authored offer query did not discover the new publisher.');
      atomicWriteJson(discoveryPath, { actor, codeCommit: this.commit, publisherRoot: root, admittedBefore: false, snapshot: incoming.snapshot, link });
    }
    await this.admit(`admit-${actor}`, [actor]);
  }
  private async propose(revision: RevisionName) {
    const result = await this.action(`${revision}-publish`, 'coordinator', 'publishPlan', 'publish_plan', async () => {
      const project = await this.project();
      let initialPlan: Proposal['plan'] | undefined;
      if (revision === 'p3') {
        const context = await this.repo().reader.context({ snapshot: project.snapshot });
        const record = await this.repo().reader.entity(context, publicKey(this.state.proposals.p1?.proposalKey), 'proposal', ROOT_ACCOUNT);
        ensure(record?.payload.entityType === 'proposal', 'The authenticated original P1 proposal is unavailable.');
        initialPlan = record.payload.plan;
      }
      const proposal = buildProofProposal(project, revision, this.state.publisherRoots, { operationId: `${revision}-proposal`, createdAt: Date.now(), ...(initialPlan ? { initialPlan } : {}) });
      ensure(project.activation.status !== 'conflict' && project.activation.status !== 'unverified', 'The current activation cannot be verified.');
      return { projectRoot: project.root.key, proposal,
        expectedActivationHeads: project.activation.status === 'unique' ? [project.activation.entity.key] : [],
        requestPublisherRoots: deriveRequiredApprovers(proposal.plan), lifetimeSeconds: LIFETIME_SECONDS };
    }) as PublicationProgress;
    ensure(result.proposalKey && result.activationKey && result.pendingPublisherRoots.length === 0, 'Publication fanout is incomplete.');
    const project = await this.project(); ensure(project.proposal, 'The activated proposal is missing.');
    this.state.proposals[revision] = { proposalKey: publicKey(result.proposalKey), activationKey: publicKey(result.activationKey), proposalHash: project.proposal.payload.proposalHash };
    this.save(); await this.observe(`${revision}-awaiting`, 'awaiting_approval', 0);
  }
  private async decision(actor: ProofActor, id: string, status: 'accepted' | 'withdrawn') {
    await this.action(id, actor, 'replaceBook', 'replace_book', async () => {
      const project = await this.project(); ensure(project.proposal, 'The proposal is missing.');
      const publisherRoot = publicKey(this.state.publisherRoots[actor]);
      const prepared = prepareDecision(project, publisherRoot, { kind: 'wallet', address: this.address(actor) },
        { status, operationId: id, now: Date.now(), ...(status === 'accepted' ? { validUntil: proofConsentDeadline(project.proposal.payload.plan, publisherRoot) }
          : { reason: 'Synthetic transport availability withdrawn for the agreed plan.' }) });
      ensure(prepared.ok, `The exact decision is invalid: ${prepared.ok ? '' : prepared.reasons.map(reason => reason.code).join(', ')}.`);
      return { publisherRoot, expectedHeads: prepared.value.expectedHeads, book: prepared.value.book, lifetimeSeconds: LIFETIME_SECONDS };
    });
  }
  private async accept(revision: RevisionName) {
    const project = await this.project(); ensure(project.proposal, 'The active proposal is missing.');
    const required = deriveRequiredApprovers(project.proposal.payload.plan);
    ensure(required.length === 7, 'The proof expects seven exact required approvers.');
    for (const root of required) {
      const actor = ACTOR_IDS.find(item => this.state.publisherRoots[item] === root); ensure(actor, 'A required owner is not in the explicit signer map.');
      await this.decision(actor, `${revision}-accept-${actor}`, 'accepted');
    }
    await this.observe(`${revision}-ready`, 'ready', 7);
  }
  private async observe(id: keyof typeof CHECKPOINT_REVISIONS, status: AgreementHealth, accepted: number) {
    const packet = take(await this.repo().exportPacket(publicKey(this.state.projectRoot)));
    const lineage = expectedProofLineage(this.state, CHECKPOINT_REVISIONS[id]);
    const summary = assertProofState(packet.project, status, accepted, Date.now(), lineage);
    const independentPacket = await verifyInFreshProcess(packet, ROOT, lineage, undefined, { accessKeyFile: this.accessKeyFile });
    const observation: PublicObservation = { id, observedAt: new Date().toISOString(), codeCommit: this.commit,
      studioStoppedDeclaredByOperator: this.options.studioStopped, packet, independentPacket, summary };
    atomicWriteJson(resolve(LOCAL, `observation-${id}.json`), observation);
    if (!this.state.observationIds.includes(id)) this.state.observationIds.push(id); this.save();
    emit({ checkpoint: id, block: packet.snapshot.blockNumber, status: packet.readiness.status, accepted: packet.readiness.acceptedApprovers.length,
      freshProcessAgreement: true, studioStoppedDeclaredByOperator: this.options.studioStopped });
  }
  private async fund() {
    const recipients = Object.fromEntries(ACTOR_IDS.map(actor => [this.state.actors[actor], CHILD_FUNDING_WEI]));
    for (const actor of ACTOR_IDS) {
      const id = `fund:${this.state.runId}:${actor}`;
      const prior = this.ledger.snapshot().records.find(record => record.id === id);
      if (prior) { ensure(prior.status === 'confirmed', 'An earlier funding transaction requires reconciliation or review.'); continue; }
      const gas = BigInt(await this.read({ method: 'eth_estimateGas', params: [{ from: ROOT_ACCOUNT, to: this.state.actors[actor], value: hex(BigInt(CHILD_FUNDING_WEI)), data: '0x',
        maxFeePerGas: hex(MAX_FEE_PER_GAS), maxPriorityFeePerGas: '0x1' }] }) as string);
      if (!this.options.broadcast || this.forwarded >= this.options.maxTransactions) { this.estimates.push({ account: ROOT_ACCOUNT, gas: gas.toString(), maximumCostWei: (BigInt(CHILD_FUNDING_WEI) + gas * MAX_FEE_PER_GAS).toString() }); throw new PhaseBoundary(); }
      const transactionHash = await submitFunding({ id, from: ROOT_ACCOUNT, to: this.state.actors[actor], amountWei: CHILD_FUNDING_WEI,
        gas: gas.toString(), ...FEES, allowedRecipients: recipients, read: this.read, sendRaw: this.sendRaw, loadAccount: this.loadAccount('coordinator'), ledger: this.ledger, broadcast: true });
      await this.repo().reader.client.waitForTransactionReceipt({ hash: transactionHash, checkReplacement: false, timeout: 45_000 });
      await this.reconcile(); ensure(this.ledger.snapshot().records.find(record => record.id === id)?.status === 'confirmed', 'Funding was not canonically confirmed.');
    }
  }
  async phase(phase: ProofPhase) {
    assertPhaseOrder(this.state, phase);
    if (this.state.completedPhases.includes(phase)) return emit({ phase, alreadyComplete: true, nextPhase: PHASES[PHASES.indexOf(phase) + 1] ?? null });
    try {
      if (phase === 'fund') await this.fund();
      else if (phase === 'publish-core') {
        const result = await this.action('project', 'coordinator', 'createProject', 'create_project', async () => ({ recipe: publicRecipe(), lifetimeSeconds: LIFETIME_SECONDS })) as { value: ProjectAggregate };
        const root = publicKey(result.value.root.key); ensure(!this.state.projectRoot || this.state.projectRoot === root, 'The original project root differs.');
        this.state.projectRoot = root; this.save();
        for (const actor of BASE_ACTORS) await this.register(actor);
        await this.admit('admit-core', BASE_ACTORS);
      } else if (phase === 'discover-oak' || phase === 'discover-juniper') await this.discover(phase === 'discover-oak' ? 'oak' : 'juniper');
      else if (phase === 'withdraw-oak') { await this.decision('oak', 'withdraw-oak', 'withdrawn'); await this.observe('p1-changed', 'changed', 6); }
      else if (phase.endsWith('-propose')) await this.propose(phase.slice(0, 2) as RevisionName);
      else await this.accept(phase.slice(0, 2) as RevisionName);
      this.state.completedPhases.push(phase); this.save();
      emit({ phase, complete: true, transactionsForwardedThisInvocation: this.forwarded, budget: this.ledger.publicSummary() });
    } catch (error) {
      if (!(error instanceof PhaseBoundary)) throw error;
      emit({ phase, complete: false, mode: this.options.broadcast ? 'explicit-transaction-limit' : 'read-only-preflight',
        transactionsForwardedThisInvocation: this.forwarded, estimates: this.estimates, budget: this.ledger.publicSummary() });
    }
  }
  async verify() {
    const packet = take(await this.repo().exportPacket(publicKey(this.state.projectRoot)));
    const revision = [...REVISION_NAMES].reverse().find(name => this.state.proposals[name]);
    ensure(revision, 'A completed proof publication is required before verifying its saved lineage.');
    const independent = await verifyInFreshProcess(packet, ROOT, expectedProofLineage(this.state, revision), undefined, { accessKeyFile: this.accessKeyFile });
    emit({ verified: true, snapshot: independent.snapshot, readiness: independent.readiness, projectRoot: packet.project.root.key,
      studioStoppedDeclaredByOperator: this.options.studioStopped });
  }
  export(path: string) {
    const output = resolve(ROOT, path), evidenceRoot = resolve(ROOT, 'arkiv/evidence');
    const within = relative(evidenceRoot, output);
    ensure(within && !within.startsWith('..') && !/^[A-Za-z]:/.test(within) && output.endsWith('.json'), 'Public exports must be new JSON files inside arkiv/evidence.');
    ensure(this.state.completedPhases.includes('p3-accept'), 'The complete P1/P2/P3 sequence must finish before final evidence export.');
    const observations = Object.entries(CHECKPOINT_REVISIONS).map(([id, revision]) => {
      ensure(this.state.observationIds.includes(id), 'A required proof checkpoint is missing.');
      const record = readJson<PublicObservation>(resolve(LOCAL, `observation-${id}.json`)); ensure(record?.id === id, 'A dated observation is missing.');
      const lineage = expectedProofLineage(this.state, revision);
      assertProofLineage(record.packet.project, lineage); assertProofLineage(record.independentPacket.project, lineage);
      return record;
    });
    const evidence = { format: 'partfolk-product-proof', version: 1, network: 'tiramisu', chainId: LIVE_CHAIN_ID,
      exportedAt: new Date().toISOString(), codeCommit: this.commit, runId: this.state.runId, synthetic: true,
      rootAccount: ROOT_ACCOUNT, publisherAccounts: this.state.actors, genesisHash: this.state.genesisHash,
      projectRoot: this.state.projectRoot, publisherRoots: this.state.publisherRoots, proposals: this.state.proposals,
      completedPhases: this.state.completedPhases, budget: this.ledger.publicSummary(), observations,
      discovery: ['oak', 'juniper'].map(actor => readJson(resolve(LOCAL, `discovery-${actor}.json`))),
      limitation: 'Dated public Arkiv snapshots, synthetic owners and declared consent. No physical execution, real identity, permanent retention, or current readiness promise. UI review belongs to the user.' };
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    emit({ exported: relative(ROOT, output).replaceAll('\\', '/'), projectRoot: this.state.projectRoot, observations: observations.length });
  }
  dispose() { this.gateways.forEach(gateway => gateway.dispose()); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  ensure(/^[0-9a-f]{40}$/i.test(commit), 'The current source commit is unavailable.');
  if (options.broadcast) {
    ensure(commit === options.reviewedCommit, 'Broadcast requires this exact reviewed commit.');
    ensure(!execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'Commit and review source changes before broadcast.');
  }
  checkPriorEvidence();
  const operatorRpc = createOperatorRpc({ autoDetectDirectory: ROOT });
  const rawRpc: ReadRpc = operatorRpc.request;
  const { request } = createArkivReadClient(rawRpc as ArkivRpcRequest);
  const read: ReadRpc = request;
  ensure(BigInt(await read({ method: 'eth_chainId' }) as string) === BigInt(LIVE_CHAIN_ID), 'The official endpoint is on another chain.');
  const genesis = await read({ method: 'eth_getBlockByNumber', params: ['0x0', false] }) as { hash?: Hex };
  ensure(genesis?.hash && /^0x[0-9a-f]{64}$/i.test(genesis.hash), 'A canonical genesis hash is required.');
  let state = readJson<ProofState>(STATE);
  if (state) state = validateState(state);
  if (options.phase === 'prepare') {
    await withRunLock(ROOT_ACCOUNT, async () => {
      if (options.initialize) state = initialize(genesis.hash!, commit);
      if (state) ensure(state.genesisHash === genesis.hash, 'The saved run belongs to another genesis.');
      const balance = await read({ method: 'eth_getBalance', params: [ROOT_ACCOUNT, 'pending'] });
      emit({ mode: 'read-only-prepare', initialized: state !== null, chainId: LIVE_CHAIN_ID, genesisHash: genesis.hash, codeCommit: commit,
        rootAccount: ROOT_ACCOUNT, rootBalanceWei: BigInt(balance as string).toString(), budgetLimitWei: LIVE_LIMIT_WEI,
        priorSpendWei: PRIOR_SPEND_WEI, plannedTransactions: PHASE_TRANSACTION_COUNTS,
        maximumPlannedTransactions: Object.values(PHASE_TRANSACTION_COUNTS).reduce((sum, count) => sum + count, 0),
        publisherAccounts: state?.actors ?? null, nextPhase: state ? PHASES.find(phase => !state!.completedPhases.includes(phase)) ?? null : 'prepare --initialize' });
    }); return;
  }
  ensure(state, 'Explicit prepare --initialize is required before a proof phase.');
  ensure(state.genesisHash === genesis.hash, 'The saved run belongs to another genesis.');
  await withRunLock(ROOT_ACCOUNT, async () => {
    const current = validateState(readJson(STATE));
    ensure(current.runId === state!.runId && canonicalJson(current.actors) === canonicalJson(state!.actors) && current.genesisHash === genesis.hash,
      'The run identity changed while acquiring its signer locks.');
    const run = new ProofRun(current, options, commit, read, rawRpc, operatorRpc.accessKeyFile ?? undefined);
    try {
      await run.reconcile();
      if (options.phase === 'verify') await run.verify();
      else if (options.phase === 'export') run.export(options.output!);
      else await run.phase(options.phase as ProofPhase);
    } finally { run.dispose(); }
  }, { runId: state.runId, accounts: Object.values(state.actors) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never print RPC error objects, command inputs, raw transactions, paths to secrets, or stack traces.
    const message = error instanceof LiveSafetyError ? error.code : error instanceof ProofError ? error.message : 'PROOF_RECONCILIATION_REQUIRED';
    process.stderr.write(`${JSON.stringify({ stopped: true, message, retryPolicy: 'Preserve journals and reconcile the original operation before any further send.' })}\n`);
    process.exitCode = 1;
  });
}
