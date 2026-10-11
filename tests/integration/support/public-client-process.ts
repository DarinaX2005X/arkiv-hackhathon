/** Non-UI process entry. No browser, DOM, signer, network URL or shared client storage. */
import { createPublicRuntime } from '../../../src/app/network';
import type { StoragePort } from '../../../src/app/storage';
import { verifyProject } from '../../../src/cli/verify';
import { BrowserOperationStore } from '../../../src/data/operations';
import type { PublishPlanCommand, Result } from '../../../src/data/types';
import type { InjectedWalletProvider, NativeTransactionRequest } from '../../../src/data/wallet';
import { activeSource } from '../../../src/domain/readiness';
import { TIRAMISU_CHAIN_ID } from '../../../src/domain/types';
import { prepareDecisionCommand } from '../../../src/features/contributions/model';
import type { ChildMessage, ParentMessage, ProcessResult, ProcessStart } from './process-messages';

let now = 0, serial = 0, fetchAttempts = 0, shuttingDown = false;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
const send = (message: ChildMessage) => { if (!process.send) throw new Error('The fixture requires a parent IPC channel.'); process.send(message); };
function request(message: Omit<Extract<ChildMessage, { kind: 'rpc' }>, 'id'> | Omit<Extract<ChildMessage, { kind: 'wallet' }>, 'id'>): Promise<unknown> {
  if (shuttingDown) return new Promise(() => {});
  const id = ++serial;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ ...message, id }); });
}
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; };

// An accidentally introduced default HTTP/Studio API dependency fails before making a request.
globalThis.fetch = async () => { fetchAttempts++; throw new Error('HTTP is forbidden in this deterministic IPC fixture.'); };

// BrowserOperationStore requires exclusive journal locking. This Node adapter holds each
// lock until its asynchronous action settles; every child owns its own isolated storage.
// It supplies only the lock primitive, with no browser, DOM, rendering or UI automation.
const heldLocks = new Set<string>();
const nodeLocks = {
  async request<T>(name: string, options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: { name: string; mode: 'exclusive' } | null) => Promise<T>): Promise<T> {
    if (options.mode !== 'exclusive' || options.ifAvailable !== true) throw new Error('Unexpected lock request.');
    if (heldLocks.has(name)) return callback(null);
    heldLocks.add(name);
    try { return await callback({ name, mode: 'exclusive' }); }
    finally { heldLocks.delete(name); }
  },
};
const nodeNavigator = globalThis.navigator ?? {};
Object.defineProperty(nodeNavigator, 'locks', { value: nodeLocks, configurable: true });
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: nodeNavigator, configurable: true });

async function run(input: ProcessStart): Promise<ProcessResult> {
  now = input.now;
  const namespace = input.role === 'desk-withdraw' ? 'partfolk:partner-desk' : 'partfolk:studio';
  const values = new Map<string, string>(input.restoredStorage), storageKeys = new Set<string>(), walletMethods: string[] = [];
  let initialPacket: ProcessResult['packet'] | undefined;
  let publicationCommand: PublishPlanCommand | undefined;
  const storage: StoragePort = {
    getItem(key) { storageKeys.add(key); return values.get(key) ?? null; },
    setItem(key, value) {
      storageKeys.add(key); values.set(key, value);
      if (!input.interruptAfterProposal || shuttingDown || !key.endsWith(':wallet-operations:v1')) return;
      const record = journal.list().find(item => item.operation.phase === 'proposal_confirmed');
      if (!record) return;
      if (!initialPacket || !publicationCommand) throw new Error('The saved original command is missing at interruption.');
      shuttingDown = true;
      // Stop the real process after the serialized checkpoint is delivered. Any attempted
      // continuation waits in request(), so no activation RPC or wallet send can slip through.
      process.send!({ kind: 'result', result: { pid: process.pid, role: input.role, packet: initialPacket,
        ownPublisherRoots: [], walletMethods, storageKeys: [...storageKeys], fetchAttempts, receipt: null,
        interrupted: { storage: [...values], operation: record.operation, command: publicationCommand } } } satisfies ChildMessage,
      () => process.exit(0));
    },
    removeItem(key) { storageKeys.add(key); values.delete(key); },
  };
  const journal = new BrowserOperationStore(storage, { key: `${namespace}:wallet-operations:v1` });
  const provider: InjectedWalletProvider = { request: async args => {
    walletMethods.push(args.method);
    if (input.role !== 'desk-withdraw' && input.role !== 'studio-publish') throw new Error('A read-only process must not ask for a wallet.');
    if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return [input.account];
    if (args.method === 'eth_chainId') return `0x${TIRAMISU_CHAIN_ID.toString(16)}`;
    if (args.method === 'wallet_switchEthereumChain') return null;
    if (args.method !== 'eth_sendTransaction') throw new Error(`Unexpected fixture wallet method ${args.method}`);
    const sent = args.params?.[0] as NativeTransactionRequest;
    const record = journal.list().find(item => item.step.status === 'unverified' && item.admission?.request.data === sent.data);
    if (!record) throw new Error('The exact send admission was not saved before forwarding.');
    return request({ kind: 'wallet', request: sent, record });
  } };
  const binding = createPublicRuntime({ storage, namespace, provider, now: () => now,
    request: rpc => request({ kind: 'rpc', request: rpc }) });
  let receipt: ProcessResult['receipt'] = null;
  let publication: ProcessResult['publication'];
  let ownPublisherRoots: string[] = [];
  try {
    if (input.role === 'desk-withdraw' || input.role === 'studio-publish') {
      if (!await binding.connect()) throw new Error(binding.getSnapshot().error ?? 'Connection failed.');
    }
    if (input.role === 'desk-withdraw') {
      const repository = binding.runtime.repository!;
      ownPublisherRoots = unwrap(await repository.listOwnPublishers({ kind: 'wallet', address: input.account })).items.map(item => item.root.key);
      const project = unwrap(await repository.loadProject(input.projectRoot));
      const source = activeSource(project);
      if (!source) throw new Error('The invited agreement was not loaded.');
      const command = prepareDecisionCommand(project, input.publisherRoot,
        { mode: 'public', actor: { kind: 'wallet', address: input.account }, chainId: TIRAMISU_CHAIN_ID },
        { status: 'withdrawn', reason: 'Synthetic owner withdrawal from the independent process.', now,
          id: 'independent-desk-withdrawal', reviewedSource: source });
      receipt = unwrap(await repository.replaceBook(command)).receipt;
    }
    if (input.role === 'studio-publish') {
      const commandKey = `${namespace}:publication-command`;
      const saved = storage.getItem(commandKey);
      publicationCommand = saved ? JSON.parse(saved) as PublishPlanCommand : input.publication;
      if (!publicationCommand) throw new Error('The original publication command is missing.');
      if (!saved) storage.setItem(commandKey, JSON.stringify(publicationCommand));
      initialPacket = await verifyProject(binding.reader, input.projectRoot);
      const repository = binding.runtime.repository!;
      if (saved) {
        const reconciled = unwrap(await repository.reconcile(publicationCommand.operation));
        if (reconciled.status !== 'pending') throw new Error(`Unexpected incomplete publication status: ${reconciled.status}`);
        publicationCommand = { ...publicationCommand, operation: reconciled.operation };
      }
      const result = unwrap(await repository.publishPlan(publicationCommand));
      if (!result.proposalKey || !result.activationKey || result.operation.phase !== 'complete') throw new Error('The publication is still incomplete.');
      publication = { proposalKey: result.proposalKey, activationKey: result.activationKey, operation: result.operation };
    }
    // This is the production CLI verification boundary, using this process's independently constructed reader.
    const packet = await verifyProject(binding.reader, input.projectRoot);
    return { pid: process.pid, role: input.role, packet, ownPublisherRoots, walletMethods, storageKeys: [...storageKeys], fetchAttempts, receipt, publication };
  } finally { binding.dispose(); }
}

process.on('message', (message: ParentMessage) => {
  if (message.kind === 'rpc-result') {
    now = message.now;
    const waiter = pending.get(message.id); pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.value);
    return;
  }
  void run(message).then(result => send({ kind: 'result', result }), error => {
    process.exitCode = 1;
    send({ kind: 'failure', message: error instanceof Error ? error.stack ?? error.message : String(error) });
  }).finally(() => { process.disconnect(); });
});
