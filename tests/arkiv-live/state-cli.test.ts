import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, hashCanonical } from '../../src/domain/canonical';
import { allocateOperationStep, MemoryOperationStore } from '../../src/data/operations';
import type { OperationStore } from '../../src/data/operations';
import type { StoredOperationStep } from '../../src/data/operations/types';
import { activeSource, deriveReadiness } from '../../src/domain/readiness';
import { TIRAMISU_CHAIN_ID } from '../../src/domain/types';
import type { AccountAddress, PublicEntityKey, SourcePlanRef } from '../../src/domain/types';
import type { ExportPacket, WriteAuthority } from '../../src/data/types';
import { ArkivReader } from '../../src/data/arkiv/reader';
import { KEYS, NOW, entityKey, threeProposalFixture } from '../../src/data/__tests__/arkiv-fixture';
import { verifyInFreshProcess } from './cli';
import { confirmedActionResult } from './confirmed-action';
import type { BudgetRecord } from './safety';
import type { RunCli } from './cli';
import { ACTOR_IDS } from './scenario';
import { ROOT_ACCOUNT, freezeAction, parseOptions, validateState } from './state';
import type { MutationMethod, ProofState, SignerName } from './state';

const COMMIT = 'a1'.repeat(20);
const OTHER_COMMIT = 'b2'.repeat(20);
const address = (number: number): AccountAddress => `0x${number.toString(16).padStart(40, '0')}`;
const authority = (): Extract<WriteAuthority, { mode: 'public' }> => ({ mode: 'public', actor: { kind: 'wallet', address: ROOT_ACCOUNT }, chainId: TIRAMISU_CHAIN_ID });

function stateFixture(): ProofState {
  return { version: 1, runId: 'unit-proof', chainId: TIRAMISU_CHAIN_ID, genesisHash: entityKey(999), initializedAt: NOW,
    initialCodeCommit: COMMIT, rootAccount: ROOT_ACCOUNT,
    actors: Object.fromEntries(ACTOR_IDS.map((actor, index) => [actor, address(index + 1)])) as ProofState['actors'],
    projectRoot: null, publisherRoots: {}, proposals: {}, actions: {}, completedPhases: [], observationIds: [] };
}

function freezeFixture(state = stateFixture()) {
  const input = { lifetimeSeconds: 3_600, expectedHeads: [entityKey(400)], projectRoot: KEYS.project, label: 'Original reviewed material.' };
  const frozen = freezeAction(state, 'project:edit', 'coordinator', 'replaceProject', 'replace_project', authority(), input, COMMIT, NOW);
  return { state, input, frozen };
}

async function packetFixture(): Promise<ExportPacket> {
  // The reader uses only an in-memory RPC fixture. No live runner or actual child process is invoked.
  const { rpc } = threeProposalFixture();
  const reader = new ArkivReader({ request: rpc.request, now: () => NOW });
  const project = await reader.loadProject(KEYS.project);
  return { format: 'partfolk-export', version: 1, exportedAt: NOW, mode: 'public', project,
    readiness: deriveReadiness(project, NOW), snapshot: project.snapshot };
}

// Capture the original complete fixture as the operator's saved publication references before altering a returned packet.
function savedLineage(packet: ExportPacket): SourcePlanRef[] {
  return packet.project.proposalHistory.map((_, index, records) => structuredClone(index + 1 < records.length
    ? records[index + 1]!.payload.plan.predecessor! : activeSource(packet.project)!));
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('live proof option parsing is read only unless explicitly gated', () => {
  it('defaults to a bounded read-only prepare invocation', () => {
    expect(parseOptions([])).toEqual({ phase: 'prepare', broadcast: false, initialize: false, maxTransactions: 1, studioStopped: false });
    expect(parseOptions(['--phase', 'verify'])).toMatchObject({ phase: 'verify', broadcast: false, initialize: false });
  });

  it('permits separate local preparation without enabling broadcast', () => {
    expect(parseOptions(['--initialize', '--studio-stopped'])).toMatchObject({ phase: 'prepare', initialize: true, studioStopped: true, broadcast: false });
  });

  it('binds an explicit mutation phase to an exact reviewed commit and a per-invocation transaction bound', () => {
    expect(parseOptions(['--phase', 'p1-accept', '--broadcast', '--reviewed-commit', COMMIT.toUpperCase(), '--max-transactions', '7']))
      .toEqual({ phase: 'p1-accept', broadcast: true, initialize: false, maxTransactions: 7, studioStopped: false, reviewedCommit: COMMIT });
  });

  it('requires an explicit destination for export and keeps it read only', () => {
    expect(parseOptions(['--phase', 'export', '--output', 'public proof.json']))
      .toMatchObject({ phase: 'export', output: 'public proof.json', broadcast: false });
  });

  it.each([
    ['--unknown'], ['--phase'], ['--phase', 'all'], ['--phase', 'verify', '--phase', 'prepare'],
    ['--broadcast', '--broadcast'], ['--initialize', '--initialize'], ['--studio-stopped', '--studio-stopped'],
    ['--reviewed-commit'], ['--reviewed-commit', 'HEAD'], ['--reviewed-commit', 'abc123'],
    ['--max-transactions'], ['--max-transactions', '0'], ['--max-transactions', '33'],
    ['--max-transactions', '-1'], ['--max-transactions', '1.5'], ['--max-transactions', '9007199254740993'],
    ['--broadcast'], ['--broadcast', '--phase', 'fund'], ['--broadcast', '--reviewed-commit', COMMIT],
    ['--broadcast', '--phase', 'verify', '--reviewed-commit', COMMIT],
    ['--initialize', '--phase', 'fund'], ['--initialize', '--broadcast'],
    ['--output', 'proof.json'], ['--phase', 'export'], ['--phase', 'export', '--output'],
    ['--phase', 'export', '--output', '--broadcast'],
  ].map(args => ({ args })))('rejects malformed, duplicated or ungated options: $args', ({ args }) => {
    expect(() => parseOptions(args)).toThrow();
  });
});

describe('frozen action and persisted state integrity', () => {
  it('freezes exact input, lifetime, authority and predecessor keys before any signer action', () => {
    const { state, input, frozen } = freezeFixture();
    expect(frozen).toMatchObject({ actor: 'coordinator', method: 'replaceProject', codeCommit: COMMIT, confirmed: false, confirmedKeys: [] });
    expect(frozen.command.operation).toMatchObject({ id: 'pfp:unit-proof:project:edit', kind: 'replace_project', authority: authority(),
      createdAt: NOW, inputHash: hashCanonical(input), expectedHeads: [entityKey(400)], phase: 'prepared', transactionHash: null, steps: [] });
    expect(frozen.command.lifetimeSeconds).toBe(3_600);
    input.label = 'Changed after freezing'; input.expectedHeads.push(entityKey(401));
    frozen.command.lifetimeSeconds = 1;
    frozen.command.operation.authority = { mode: 'public', actor: { kind: 'wallet', address: address(999) }, chainId: TIRAMISU_CHAIN_ID };
    expect(state.actions['project:edit']!.command).toMatchObject({ label: 'Original reviewed material.', lifetimeSeconds: 3_600,
      expectedHeads: [entityKey(400)], operation: { authority: authority() } });
  });

  it('resumes the same original intent and reviewed commit when caller input, clock and current commit have changed', () => {
    const { state } = freezeFixture();
    const original = structuredClone(state.actions['project:edit']);
    const resumed = freezeAction(state, 'project:edit', 'coordinator', 'replaceProject', 'replace_project', authority(),
      { lifetimeSeconds: 8_000, expectedHeads: [entityKey(402)], label: 'New values are not a new authorization.' }, OTHER_COMMIT, NOW + 60_000);
    expect(resumed).toEqual(original);
    resumed.confirmed = true; resumed.confirmedKeys.push(entityKey(403)); resumed.command.operation.steps.push({
      id: 'injected-step', phase: 'book_pending', status: 'prepared', transactionHash: null, confirmedKeys: [], expectedHeads: [], inputHash: entityKey(404),
    });
    expect(state.actions['project:edit']).toEqual(original);
  });

  it.each(['actor', 'method', 'kind', 'authority'] as const)('rejects a changed %s binding for an existing action ID', changed => {
    const { state } = freezeFixture();
    const actor: SignerName = changed === 'actor' ? 'oak' : 'coordinator';
    const method: MutationMethod = changed === 'method' ? 'replaceBook' : 'replaceProject';
    const changedAuthority = authority();
    if (changed === 'authority') changedAuthority.actor.address = address(999);
    expect(() => freezeAction(state, 'project:edit', actor, method, changed === 'kind' ? 'replace_book' : 'replace_project',
      changedAuthority, { lifetimeSeconds: 3_600 }, COMMIT, NOW)).toThrow('saved action binding changed');
  });

  it('validates and returns an independent copy of a legitimate frozen journal', () => {
    const { state } = freezeFixture();
    state.projectRoot = KEYS.project; state.publisherRoots.oak = KEYS.publisher;
    state.completedPhases = ['fund']; state.observationIds = ['after-fund'];
    const validated = validateState(state);
    expect(validated).toEqual(state);
    validated.actions['project:edit']!.confirmedKeys.push(entityKey(405));
    validated.completedPhases.push('publish-core');
    expect(state.actions['project:edit']!.confirmedKeys).toEqual([]);
    expect(state.completedPhases).toEqual(['fund']);
  });

  it.each<[string, (state: ProofState) => void]>([
    ['wrong chain', state => { (state as { chainId: number }).chainId = 1; }],
    ['malformed genesis', state => { state.genesisHash = '0x1234'; }],
    ['wrong root account', state => { state.rootAccount = address(999); }],
    ['duplicate actor', state => { state.actors.oak = state.actors.cedar; }],
    ['actor reusing root signer', state => { state.actors.oak = ROOT_ACCOUNT; }],
    ['invalid actor address', state => { state.actors.oak = '0x1234'; }],
    ['local project root', state => { (state as { projectRoot: string }).projectRoot = 'local:project'; }],
    ['local publisher root', state => { (state.publisherRoots as Record<string, string>).oak = 'local:oak'; }],
    ['unknown publisher', state => { (state.publisherRoots as Record<string, string>).unknown = entityKey(406); }],
    ['duplicate completed phase', state => { state.completedPhases = ['fund', 'fund']; }],
    ['invalid observation ID', state => { state.observationIds = ['../arbitrary-file']; }],
    ['changed action input', state => { state.actions['project:edit']!.command.lifetimeSeconds++; }],
    ['changed operation hash', state => { state.actions['project:edit']!.command.operation.inputHash = entityKey(407); }],
    ['changed operation input', state => { state.actions['project:edit']!.command.operation.input = { lifetimeSeconds: 1 }; }],
    ['changed operation identity', state => { state.actions['project:edit']!.command.operation.id = 'another-operation'; }],
    ['malformed confirmed key', state => { state.actions['project:edit']!.confirmedKeys.push('0x1234'); }],
  ])('rejects persisted state with %s without resetting the original journal', (_name, mutate) => {
    const { state } = freezeFixture(); mutate(state);
    const before = structuredClone(state);
    expect(() => validateState(state)).toThrow();
    expect(state).toEqual(before);
  });
});

function confirmedFixture(method: 'createProject' | 'registerPublisher' | 'replaceBook' = 'replaceBook') {
  const state = stateFixture();
  const kind = method === 'createProject' ? 'create_project' : method === 'registerPublisher' ? 'register_publisher' : 'replace_book';
  const action = freezeAction(state, 'confirmed-resume', 'coordinator', method, kind, authority(),
    { lifetimeSeconds: 3600, expectedHeads: method === 'replaceBook' ? [entityKey(400)] : [] }, COMMIT, NOW);
  const operation = structuredClone(action.command.operation);
  const root = method !== 'replaceBook';
  const phases = root ? ['root_pending', 'initial_state_pending'] as const : ['book_pending'] as const;
  const budget: BudgetRecord[] = [];
  const records = phases.map((phase, index): StoredOperationStep => {
    const type = phase === 'root_pending' ? method === 'createProject' ? 'project_root' : 'publisher_root' : 'book_state';
    const batch = { creates: [{ payloadJson: canonicalJson({ entityType: type }), attributes: {}, lifetimeSeconds: 3600, salt: '1' as const }],
      deletes: method === 'replaceBook' ? [entityKey(400)] : [] };
    const step = allocateOperationStep(operation, phase, {}, batch.deletes);
    const transactionHash = entityKey(800 + index), key = entityKey(900 + index), blockNumber = `${100 + index}` as `${bigint}`;
    step.inputHash = hashCanonical(batch); step.status = 'confirmed'; step.confirmedKeys = [key]; step.transactionHash = transactionHash;
    operation.steps.push(step); operation.confirmedKeys.push(key); operation.transactionHash = transactionHash;
    const request = { from: ROOT_ACCOUNT, to: '0x4400000000000000000000000000000000000044' as const,
      data: '0x1234' as const, value: '0x0' as const, chainId: '0x7614d1' as const,
      gas: '0x186a0' as const, maxFeePerGas: '0x77359400' as const, maxPriorityFeePerGas: '0x1' as const };
    // Synthetic already-authenticated ledger outcomes; this fixture performs no signing or RPC.
    budget.push({ id: `${operation.id}:${step.id}`, kind: 'native', status: 'confirmed', maximumCostWei: '200000000000000',
      signedTransaction: '0x1234', transactionHash,
      plan: { chainId: 7738577, from: ROOT_ACCOUNT.toLowerCase(), to: request.to, data: request.data, value: '0', nonce: index,
        gas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' },
      receipt: { transactionHash, blockHash: entityKey(700 + index), blockNumber, transactionIndex: '0', status: 'success',
        gasUsed: '21000', effectiveGasPrice: '1000000000', actualCostWei: '21000000000000' } });
    return { version: 1, revision: 5, operation, step, batch, prepared: { batch, account: ROOT_ACCOUNT, chainId: 7738577, request,
      transactionOptions: { gas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' },
      estimatedGas: '100000', preparedAtBlock: '99', estimatedCostWei: null, estimatedMaximumCostWei: null, estimatePolicy: 'estimate-only' },
      admission: { request, at: NOW }, submissionHash: transactionHash,
      receipt: { operationId: operation.id, transactionHash, entityKeys: [key], consumedKeys: batch.deletes, blockNumber, confirmedAt: NOW }, error: null };
  });
  operation.phase = 'complete'; action.confirmed = true; action.confirmedKeys = operation.confirmedKeys.map(key => key as PublicEntityKey);
  const store = new MemoryOperationStore(); store.putMany(records);
  store.putAttemptCAS({ version: 1, revision: 1, operation: action.command.operation, attemptId: 'confirmed-resume-attempt',
    state: 'native-started', nativeStepIds: operation.steps.map(step => step.id), startedAt: NOW, settledAt: null }, null);
  return { action, store, budget, records, operation };
}

describe('confirmed original action resume', () => {
  it('reuses only ordered confirmed keys for completed material/decision actions', () => {
    const f = confirmedFixture(); const before = structuredClone(f.action);
    const result = confirmedActionResult(f.action, f.store, f.budget);
    expect(result).toEqual({ operation: { confirmedKeys: f.action.confirmedKeys } });
    result!.operation.confirmedKeys.push(entityKey(999));
    expect(f.action).toEqual(before);
  });
  it.each(['createProject', 'registerPublisher'] as const)('reconstructs only the authenticated root key for %s', method => {
    const f = confirmedFixture(method);
    expect(confirmedActionResult(f.action, f.store, f.budget)).toEqual({ operation: { confirmedKeys: f.action.confirmedKeys },
      value: { root: { key: f.action.confirmedKeys[0] } } });
  });
  it('leaves unconfirmed preflight failures, publication and unknown methods on their normal path', () => {
    const f = confirmedFixture(); f.action.confirmed = false;
    expect(confirmedActionResult(f.action, new MemoryOperationStore(), [])).toBeUndefined();
    f.action.confirmed = true; f.action.method = 'publishPlan';
    expect(confirmedActionResult(f.action, f.store, f.budget)).toBeUndefined();
    (f.action as { method: string }).method = 'unknown';
    expect(confirmedActionResult(f.action, f.store, f.budget)).toBeUndefined();
  });
  it('stops a resumed multi-step action when an original step or attempt is missing', () => {
    const f = confirmedFixture('registerPublisher');
    const incomplete = new MemoryOperationStore(); incomplete.put(f.records[1]!);
    expect(() => confirmedActionResult(f.action, incomplete, f.budget)).toThrow('CONFIRMED_ACTION_JOURNAL_MISMATCH');
    const missingStep: OperationStore = { ...f.store,
      list: () => f.store.list().slice(1), get: (operationId, stepId) => stepId === f.records[0]!.step.id ? undefined : f.store.get(operationId, stepId),
      getAttempt: operationId => f.store.getAttempt(operationId),
    } as OperationStore;
    expect(() => confirmedActionResult(f.action, missingStep, f.budget)).toThrow('CONFIRMED_ACTION_JOURNAL_MISMATCH');
  });
  it.each<[string, (f: ReturnType<typeof confirmedFixture>) => void]>([
    ['frozen input', f => { f.action.command.lifetimeSeconds++; }],
    ['frozen authority', f => { f.action.command.operation.authority = { ...authority(), actor: { kind: 'wallet', address: address(999) } }; }],
    ['ordered keys', f => { f.action.confirmedKeys.reverse(); }],
    ['canonical status', f => { f.budget[0]!.status = 'admitted'; f.budget[0]!.receipt = null; }],
    ['receipt block', f => { f.budget[0]!.receipt!.blockNumber = '999'; }],
    ['receipt hash', f => { f.budget[0]!.receipt!.transactionHash = entityKey(999); }],
    ['frozen calldata', f => { f.budget[0]!.plan.data = '0xabcd'; }],
    ['fee cap', f => { f.budget[0]!.plan.maxFeePerGas = '1'; }],
    ['missing budget record', f => { f.budget.splice(0, 1); }],
    ['submission hash', f => { f.records[0]!.submissionHash = entityKey(999); f.store.put(f.records[0]!); }],
    ['receipt keys', f => { f.records[0]!.receipt!.entityKeys = [entityKey(999)]; f.store.put(f.records[0]!); }],
    ['consumed keys', f => { f.records[0]!.receipt!.consumedKeys = [entityKey(999)]; f.store.put(f.records[0]!); }],
  ])('refuses to skip when the %s binding is lost', (_name, mutate) => {
    const f = confirmedFixture('registerPublisher'); mutate(f);
    expect(() => confirmedActionResult(f.action, f.store, f.budget)).toThrow('CONFIRMED_ACTION_JOURNAL_MISMATCH');
  });
});

describe('independent CLI verifier with an injected executor', () => {
  it('requests the exact public root and block in a new process with an allowlisted environment', async () => {
    const expected = await packetFixture();
    const repositoryRoot = resolve('synthetic repo with spaces');
    vi.stubEnv('PATH', 'synthetic-tool-path'); vi.stubEnv('TEMP', 'synthetic-temp');
    for (const variable of ['ARKIV_RPC_URL', 'ARKIV_ACCESS_KEY_FILE', 'ARKIV_API_KEY', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'PARTFOLK_WALLET', 'CODEX_HOME']) {
      vi.stubEnv(variable, 'do-not-forward');
    }
    const execute = vi.fn<RunCli>(async () => JSON.stringify(expected));
    const received = await verifyInFreshProcess(expected, repositoryRoot, savedLineage(expected), execute);
    expect(received).toEqual(expected);
    expect(execute).toHaveBeenCalledTimes(1);
    const [executable, args, options] = execute.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(args).toEqual([resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs'), resolve(repositoryRoot, 'src/cli/verify.ts'),
      KEYS.project, '--json', '--block', '100']);
    expect(options).toMatchObject({ cwd: repositoryRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: 'synthetic-tool-path', TEMP: 'synthetic-temp' } });
    expect(Object.keys(options.env).every(name => ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].includes(name))).toBe(true);
    expect(Object.values(options.env)).not.toContain('do-not-forward');
  });

  it('passes only an explicitly selected absolute key filename to the fresh verifier', async () => {
    const expected = await packetFixture(); const execute = vi.fn<RunCli>(async () => JSON.stringify(expected));
    vi.stubEnv('ARKIV_ACCESS_KEY_FILE', 'unselected-file'); vi.stubEnv('ARKIV_API_KEY', 'synthetic-secret-not-forwarded');
    const accessKeyFile = resolve('synthetic directory with spaces', 'access-key.txt');
    await verifyInFreshProcess(expected, '.', savedLineage(expected), execute, { accessKeyFile });
    const [, args, options] = execute.mock.calls[0]!;
    expect(options.env.ARKIV_ACCESS_KEY_FILE).toBe(accessKeyFile);
    expect(options.env.ARKIV_API_KEY).toBeUndefined();
    expect(args).not.toContain(accessKeyFile);
    expect(JSON.stringify(options)).not.toContain('synthetic-secret-not-forwarded');
    expect(JSON.stringify(options)).not.toContain('unselected-file');
  });

  it('allows independent fetch/export times when the exact canonical snapshot and agreement match', async () => {
    const expected = await packetFixture(); const received = structuredClone(expected);
    received.exportedAt += 2_000; received.snapshot.fetchedAt += 2_000;
    expect(await verifyInFreshProcess(expected, '.', savedLineage(expected), async () => JSON.stringify(received))).toEqual(received);
  });

  it.each([false, true])('rejects two equally truncated histories even if their completeness marker is %s', async complete => {
    const expected = await packetFixture(); const lineage = savedLineage(expected);
    expect(lineage).toHaveLength(3);
    expected.project.proposalHistory = [expected.project.proposal!];
    expected.project.proposalHistoryStatus = { complete, reasons: complete ? [] : [{ code: 'evidence_unavailable' }] };
    const execute = vi.fn<RunCli>(async () => JSON.stringify(expected));
    await expect(verifyInFreshProcess(expected, '.', lineage, execute)).rejects.toThrow('lineage');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an independent history gap even when its proposal keys and hashes match', async () => {
    const expected = await packetFixture(); const received = structuredClone(expected);
    received.project.proposalHistoryStatus = { complete: false, reasons: [{ code: 'evidence_unavailable' }] };
    await expect(verifyInFreshProcess(expected, '.', savedLineage(expected), async () => JSON.stringify(received)))
      .rejects.toThrow('lineage is incomplete');
  });

  it.each<[string, (lineage: SourcePlanRef[]) => void, string]>([
    ['prior proposal key', lineage => { lineage[0]!.proposalKey = entityKey(601); }, 'saved revision identities'],
    ['prior proposal hash', lineage => { lineage[0]!.proposalHash = entityKey(602); }, 'saved revision identities'],
    ['prior activation', lineage => { lineage[0]!.activationKey = entityKey(603); }, 'saved revision chain'],
    ['active activation', lineage => { lineage[2]!.activationKey = entityKey(604); }, 'active proof revision'],
    ['project root', lineage => { lineage[0]!.projectRoot = entityKey(605); }, 'saved revision identities'],
  ])('authenticates the %s against saved publication references', async (_name, mutate, message) => {
    const expected = await packetFixture(); const lineage = savedLineage(expected); mutate(lineage);
    await expect(verifyInFreshProcess(expected, '.', lineage, async () => JSON.stringify(expected))).rejects.toThrow(message);
  });

  it.each<[string, (packet: ExportPacket) => void]>([
    ['format', packet => { (packet as { format: string }).format = 'other'; }],
    ['version', packet => { (packet as { version: number }).version = 2; }],
    ['local mode', packet => { packet.mode = 'local'; }],
    ['chain', packet => { packet.snapshot.chainId = null; }],
    ['source', packet => { packet.snapshot.source = 'local'; }],
    ['incomplete snapshot', packet => { packet.snapshot.completeness = 'incomplete'; }],
    ['stale snapshot', packet => { packet.snapshot.freshness = 'stale'; }],
    ['block number', packet => { packet.snapshot.blockNumber = '101'; }],
    ['block hash', packet => { packet.snapshot.blockHash = entityKey(500); }],
    ['block time', packet => { packet.snapshot.blockTimestamp++; }],
    ['public root identity', packet => { packet.project.root.key = entityKey(501); }],
    ['local root identity', packet => { packet.project.root.key = 'local:project'; }],
    ['proposal identity', packet => { packet.project.proposal!.key = entityKey(502); }],
    ['proposal hash', packet => { packet.project.proposal!.payload.proposalHash = entityKey(503); }],
    ['activation identity', packet => { if (packet.project.activation.status === 'unique') packet.project.activation.entity.key = entityKey(504); }],
    ['missing activation', packet => { packet.project.activation = { status: 'missing', reason: 'expired_or_deleted' }; }],
    ['readiness', packet => { packet.readiness.status = 'changed'; }],
    ['missing accepted owner', packet => { packet.readiness.acceptedApprovers = []; }],
    ['different accepted owner', packet => { packet.readiness.acceptedApprovers = [entityKey(505)]; }],
    ['duplicate accepted owner', packet => { packet.readiness.acceptedApprovers.push(packet.readiness.acceptedApprovers[0]!); }],
    ['truncated history', packet => { packet.project.proposalHistory.pop(); }],
    ['reordered history', packet => { packet.project.proposalHistory.reverse(); }],
    ['changed historical hash', packet => { packet.project.proposalHistory[0]!.payload.proposalHash = entityKey(506); }],
    ['local snapshot mode', packet => { packet.snapshot.mode = 'local'; }],
    ['aggregate snapshot block', packet => { packet.project.snapshot = { ...packet.project.snapshot, blockNumber: '101' }; }],
    ['readiness snapshot block', packet => { packet.readiness.snapshot = { ...packet.readiness.snapshot, blockNumber: '101' }; }],
  ])('rejects an independent packet with mismatched %s', async (_name, mutate) => {
    const expected = await packetFixture(); const different = structuredClone(expected); mutate(different);
    let failure: unknown;
    try { await verifyInFreshProcess(expected, '.', savedLineage(expected), async () => JSON.stringify(different)); }
    catch (error) { failure = error; }
    expect(failure, 'A mismatched independent packet must be rejected.').toBeInstanceOf(Error);
  });

  it('rejects malformed JSON and propagates execution failure without another process attempt', async () => {
    const expected = await packetFixture();
    await expect(verifyInFreshProcess(expected, '.', savedLineage(expected), async () => 'not a JSON packet')).rejects.toThrow('not JSON');
    const execute = vi.fn<RunCli>(async () => { throw new Error('Synthetic verifier failure'); });
    await expect(verifyInFreshProcess(expected, '.', savedLineage(expected), execute)).rejects.toThrow('Synthetic verifier failure');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
