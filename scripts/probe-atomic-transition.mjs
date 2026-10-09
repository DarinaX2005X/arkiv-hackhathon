/** Bounded SDK feasibility experiment. Default never signs or broadcasts.
 * --broadcast admits at most ONE of two frozen success phases per invocation.
 * Stale A -> C is always an estimate, never a paid failed transaction.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, ENTITY_EVENTS_ABI, ExpirationTime,
  jsonToPayload, predictEntityKey } from '@arkiv-network/sdk';
import { u64 } from '@arkiv-network/sdk/attr';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { eq } from '@arkiv-network/sdk/query';
import { bytesToHex, custom, decodeErrorResult, decodeEventLog, formatEther, http,
  MethodNotFoundRpcError, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { estimateFeesPerGas } from 'viem/actions';
import { assertCanAdmit, assertFunding, BootstrapError, CHAIN_ID, CREATOR, makeBroadcastGuard,
  makeEstimateGuard, NATIVE, parameterFingerprint } from './first-write.mjs';

export const PROBE_ID = '20261009_sdk081_6267ab77';
export const PROJECT = 'convene_atomic_feasibility_v1';
export const PROBE_CAP = 3_000_000_000_000_000n; // 0.003 test GLM, both phases combined.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const JOURNAL = resolve(ROOT, '.local/atomic-transition-journal.json');
const EVIDENCE = resolve(ROOT, 'arkiv/evidence/atomic-transition.json');
const RPC = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network';
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const MISSING_ABI = parseAbi(['error EntityNotFound(bytes32 entityKey)']);
const READS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionCount',
  'eth_getBalance', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_call', 'arkiv_query']);
const SELECTION = { key: true, creator: true, owner: true, createdAt: true, expiresAt: true,
  creationFlags: true, payload: true, contentType: true, attributes: true };
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const requireTrue = (condition, code) => { if (!condition) throw new BootstrapError(code); };
const publicAccount = { address: CREATOR, type: 'local', signTransaction: async () => { throw new BootstrapError('ESTIMATE_SIGNING_BLOCKED'); } };

export function stateParameters(state, createdAt) {
  requireTrue(['A', 'B', 'C'].includes(state) && typeof createdAt === 'bigint' && createdAt > 0n, 'INVALID_PROBE_PARAMETERS');
  return { payload: jsonToPayload({ protocol: 'convene-atomic-probe/1', probeId: PROBE_ID, synthetic: true,
    state, previousState: state === 'A' ? null : 'A' }), contentType: 'application/json', salt: 0n,
  attributes: { project: PROJECT, entity_type: 'atomic_probe_state', probe_id: PROBE_ID, state, created_at: u64(createdAt) },
  flags: { readonly: true, permissionlessExtension: false }, expires: ExpirationTime.fromDays(7) };
}
const fingerprint = createdAt => sha(json(['A', 'B', 'C'].map(state => parameterFingerprint(stateParameters(state, createdAt)))));
const operations = (state, createdAt, aKey) => ({ creates: [stateParameters(state, createdAt)],
  ...(state === 'A' ? {} : { deletes: [{ entityKey: aKey }] }) });

/** A provider outage, generic revert, or another missing entity is never passing evidence. */
export function exactMissingEntity(error, entityKey) {
  for (let depth = 0, cause = error; cause && depth < 24; depth++, cause = cause.cause) {
    for (const data of [cause.data, cause.data?.data, cause.error?.data]) {
      if (typeof data !== 'string') continue;
      try {
        const decoded = decodeErrorResult({ abi: MISSING_ABI, data });
        if (decoded.errorName === 'EntityNotFound' && same(decoded.args?.[0], entityKey)) return data;
      } catch { /* Only a decoded exact custom error counts. */ }
    }
  }
  return undefined;
}

export async function estimateBatch(batch, txParams, provider, missingKey) {
  requireTrue(txParams.gas === undefined, 'ESTIMATE_MUST_NOT_HAVE_GAS_OVERRIDE');
  let missingData;
  const guard = makeEstimateGuard(async args => {
    try { return await provider(args); }
    catch (error) {
      if (args.method === 'eth_estimateGas' && missingKey) missingData = exactMissingEntity(error, missingKey);
      throw error;
    }
  });
  const wallet = createWalletClient({ account: publicAccount, chain: tiramisu, cacheTime: 0,
    transport: custom({ request: guard.request }, { retryCount: 0 }) });
  try { await wallet.executeBatch(batch, txParams); }
  catch (error) {
    if (missingData) return { status: 'rejected_missing_entity', entityKey: missingKey, revertData: missingData };
    for (let depth = 0, cause = error; cause && depth < 32; depth++, cause = cause.cause) {
      if (cause === guard.state.stop && guard.state.gas !== undefined) return { status: 'estimated', gas: guard.state.gas, input: guard.state.input };
    }
    throw new BootstrapError('BATCH_ESTIMATE_FAILED');
  }
  throw new BootstrapError('BATCH_ESTIMATE_GUARD_NOT_REACHED');
}

export function assertProbeFunding({ probeSpent, bootstrapSpent, ...funding }) {
  requireTrue(typeof probeSpent === 'bigint' && probeSpent >= 0n && typeof bootstrapSpent === 'bigint'
    && bootstrapSpent >= 0n, 'INVALID_PROBE_SPEND');
  const cap = assertFunding({ ...funding, spent: probeSpent + bootstrapSpent });
  requireTrue(probeSpent + cap <= PROBE_CAP, 'PROBE_BUDGET_EXCEEDED');
  return cap;
}

export function assertOnlyState(entities, state, parameters, expectedKey, snapshot) {
  requireTrue(entities.length === (state ? 1 : 0), 'UNEXPECTED_PROBE_LIVE_STATES');
  if (!state) return;
  const entity = entities[0];
  requireTrue(same(entity.key, expectedKey) && same(entity.creator, CREATOR) && same(entity.owner, CREATOR), 'STATE_PROVENANCE_MISMATCH');
  requireTrue(entity.creationFlags?.raw === 1 && entity.creationFlags.readonly === true
    && entity.creationFlags.permissionlessExtension === false, 'STATE_FLAGS_MISMATCH');
  requireTrue(entity.contentType === parameters.contentType && entity.payload instanceof Uint8Array
    && bytesToHex(entity.payload) === bytesToHex(parameters.payload), 'STATE_PAYLOAD_MISMATCH');
  requireTrue(Object.keys(entity.attributes ?? {}).sort().join(',') === 'created_at,entity_type,probe_id,project,state', 'STATE_ATTRIBUTE_SET_MISMATCH');
  for (const name of ['project', 'entity_type', 'probe_id', 'state']) {
    requireTrue(entity.attributes[name]?.type === 'str' && entity.attributes[name].value === parameters.attributes[name], 'STATE_ATTRIBUTE_MISMATCH');
  }
  requireTrue(entity.attributes.created_at?.type === 'u64'
    && entity.attributes.created_at.value === parameters.attributes.created_at.value, 'STATE_TIMESTAMP_MISMATCH');
  requireTrue(typeof entity.createdAt === 'bigint' && entity.expiresAt > snapshot
    && entity.expiresAt - entity.createdAt === parameters.expires.minLifetime, 'STATE_EXPIRY_MISMATCH');
}

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(`${path}.tmp`, 'w', 0o600);
  try { await file.writeFile(json(value), 'utf8'); await file.sync(); } finally { await file.close(); }
  await rename(`${path}.tmp`, path);
}
async function load(path, optional = false) {
  try { const text = await readFile(path, 'utf8'); requireTrue(text.endsWith('\n'), 'TORN_LOCAL_JSON'); return JSON.parse(text); }
  catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw new BootstrapError('LOCAL_JSON_UNAVAILABLE_OR_INVALID'); }
}
async function readStates(reader, snapshot) {
  const page = await reader.select(SELECTION).where(eq('project', PROJECT), eq('entity_type', 'atomic_probe_state'), eq('probe_id', PROBE_ID))
    .createdBy(CREATOR).atBlock(snapshot).limit(4).fetch();
  requireTrue(page.blockNumber === snapshot && !page.hasNextPage(), 'INCOMPLETE_PROBE_SNAPSHOT');
  return page.entities;
}
async function verifyCurrent(reader, journal, completed) {
  const snapshot = await reader.getBlockNumber({ cacheTime: 0 });
  const state = [undefined, 'A', 'B'][completed];
  assertOnlyState(await readStates(reader, snapshot), state, state && stateParameters(state, BigInt(journal.createdAtMs)), journal.keys[state], snapshot);
  return snapshot;
}

async function verifyReceipt(reader, journal, index) {
  const phase = journal.phases[index];
  requireTrue(HEX32.test(phase.txHash), 'MISSING_PHASE_HASH');
  const receipt = await reader.getTransactionReceipt({ hash: phase.txHash });
  const transaction = await reader.getTransaction({ hash: phase.txHash });
  const block = await reader.getBlock({ blockNumber: receipt.blockNumber });
  const plan = phase.plan;
  requireTrue(same(receipt.transactionHash, phase.txHash) && same(receipt.from, CREATOR) && same(receipt.to, NATIVE)
    && receipt.blockHash === block.hash && receipt.blockHash === transaction.blockHash
    && receipt.blockNumber === transaction.blockNumber, 'NONCANONICAL_PHASE_RECEIPT');
  requireTrue(transaction.chainId === CHAIN_ID && same(transaction.from, CREATOR) && same(transaction.to, NATIVE)
    && transaction.nonce === plan.nonce && transaction.input === plan.input && transaction.value === 0n
    && transaction.type === 'eip1559' && transaction.gas === BigInt(plan.gas)
    && transaction.maxFeePerGas === BigInt(plan.maxFeePerGas)
    && transaction.maxPriorityFeePerGas === BigInt(plan.maxPriorityFeePerGas), 'PHASE_TRANSACTION_MISMATCH');
  requireTrue(receipt.gasUsed > 0n && receipt.gasUsed <= BigInt(plan.gas)
    && receipt.effectiveGasPrice > 0n && receipt.effectiveGasPrice <= BigInt(plan.maxFeePerGas), 'PHASE_RECEIPT_GAS_INVALID');
  phase.actualFeeWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
  phase.receiptBlock = receipt.blockNumber.toString(); phase.blockHash = receipt.blockHash;
  if (receipt.status !== 'success') { phase.status = 'reverted'; await save(JOURNAL, journal); throw new BootstrapError('PHASE_REVERTED_NO_RETRY'); }
  const events = receipt.logs.filter(log => same(log.address, NATIVE)).map(log => decodeEventLog({ abi: ENTITY_EVENTS_ABI, topics: log.topics, data: log.data }));
  const state = index === 0 ? 'A' : 'B';
  requireTrue(events.length === index + 1 && events[0].eventName === 'EntityCreated'
    && same(events[0].args.entityKey, journal.keys[state]) && same(events[0].args.owner, CREATOR)
    && events[0].args.creationFlags === 1
    && events[0].args.expiresAt - receipt.blockNumber === stateParameters(state, BigInt(journal.createdAtMs)).expires.minLifetime, 'PHASE_CREATE_EVENT_MISMATCH');
  if (index === 1) requireTrue(events[1].eventName === 'EntityDeleted' && same(events[1].args.entityKey, journal.keys.A)
    && same(events[1].args.owner, CREATOR), 'PHASE_DELETE_EVENT_MISMATCH');
  phase.status = 'verified';
  await save(JOURNAL, journal);
  return receipt;
}

async function exclusive(task) {
  // Same account-level mutex as first-write.mjs; separate scripts cannot sign concurrently.
  const port = 20000 + parseInt(sha(`${CHAIN_ID}:${CREATOR.toLowerCase()}`).slice(0, 8), 16) % 30000;
  const server = createServer(socket => socket.destroy());
  await new Promise((accept, reject) => { server.once('error', () => reject(new BootstrapError('LOCAL_SIGNER_COORDINATOR_BUSY')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, accept); });
  try { return await task(); } finally { await new Promise(accept => server.close(accept)); }
}

export async function runAtomicProbe({ broadcast = false } = {}) {
  requireTrue(typeof broadcast === 'boolean' && !process.env.DEBUG, 'INVALID_FLAGS_OR_DEBUG_LOGGING');
  requireTrue(createRequire(import.meta.url)('@arkiv-network/sdk/package.json').version === '0.8.1', 'SDK_CHANGED_REVIEW_REQUIRED');
  return exclusive(async () => {
    const provider = http(RPC, { retryCount: 0, timeout: 10_000, fetchOptions: { cache: 'no-store', redirect: 'error' } })({ chain: tiramisu }).request;
    const read = args => {
      if (args.method === 'eth_fillTransaction') throw new MethodNotFoundRpcError(new Error('Fill disabled'));
      requireTrue(READS.has(args.method), 'READ_ONLY_METHOD_BLOCKED'); return provider(args);
    };
    const reader = createPublicClient({ chain: tiramisu, cacheTime: 0, transport: custom({ request: read }, { retryCount: 0 }) });
    requireTrue(await reader.getChainId() === CHAIN_ID, 'WRONG_CHAIN');
    const genesis = await reader.getBlock({ blockNumber: 0n });
    const bootstrap = await load(resolve(ROOT, 'arkiv/evidence/bootstrap.json'));
    requireTrue(bootstrap.chainId === CHAIN_ID && same(bootstrap.creator, CREATOR) && bootstrap.receipt.status === 'success'
      && bootstrap.transactionHash === '0xd9a9eb50a203afc13c5a28df1707eca01c66fab19837eacb91c72e11c22b2ba3', 'BOOTSTRAP_BASELINE_MISMATCH');
    let journal = await load(JOURNAL, true);
    if (!journal) {
      requireTrue(await reader.getTransactionCount({ address: CREATOR, blockTag: 'latest' }) === 1
        && await reader.getTransactionCount({ address: CREATOR, blockTag: 'pending' }) === 1
        && await reader.getEntityNonce(CREATOR) === 1n, 'UNJOURNALED_ACCOUNT_ACTIVITY');
      const createdAt = BigInt(Date.now());
      journal = { schema: 1, chainId: CHAIN_ID, creator: CREATOR, probeId: PROBE_ID, genesisHash: genesis.hash,
        createdAtMs: createdAt.toString(), fingerprint: fingerprint(createdAt), maxProbeSpendWei: PROBE_CAP.toString(),
        bootstrapSpentWei: bootstrap.receipt.gasFeeWei, initialBalanceWei: (await reader.getBalance({ address: CREATOR })).toString(),
        keys: Object.fromEntries(['A', 'B', 'C'].map((state, index) => [state, predictEntityKey({ owner: CREATOR, nonce: BigInt(index + 1), salt: 0n, chainId: CHAIN_ID })])),
        phases: [] };
      await verifyCurrent(reader, journal, 0); await save(JOURNAL, journal);
    }
    requireTrue(journal.schema === 1 && journal.chainId === CHAIN_ID && same(journal.creator, CREATOR) && journal.probeId === PROBE_ID
      && journal.genesisHash === genesis.hash && journal.maxProbeSpendWei === PROBE_CAP.toString()
      && journal.bootstrapSpentWei === bootstrap.receipt.gasFeeWei && journal.fingerprint === fingerprint(BigInt(journal.createdAtMs))
      && Array.isArray(journal.phases) && journal.phases.length <= 2, 'FROZEN_PROBE_JOURNAL_MISMATCH');
    for (const [index, state] of ['A', 'B', 'C'].entries()) requireTrue(journal.keys[state] === predictEntityKey({ owner: CREATOR,
      nonce: BigInt(index + 1), salt: 0n, chainId: CHAIN_ID }), 'FROZEN_PROBE_KEYS_MISMATCH');
    for (let index = 0; index < journal.phases.length; index++) {
      if (journal.phases[index].txHash) await verifyReceipt(reader, journal, index);
      else assertCanAdmit(journal.phases[index]);
    }
    const completed = journal.phases.filter(phase => phase.status === 'verified').length;
    const snapshot = await verifyCurrent(reader, journal, completed);
    const nonce = completed + 1;
    const verifyNonce = async () => requireTrue(await reader.getTransactionCount({ address: CREATOR, blockTag: 'latest' }) === nonce
      && await reader.getTransactionCount({ address: CREATOR, blockTag: 'pending' }) === nonce
      && await reader.getEntityNonce(CREATOR) === BigInt(nonce), 'ACCOUNT_ACTIVITY_REQUIRES_RECONCILIATION');
    await verifyNonce();
    const fees = await estimateFeesPerGas(reader, { type: 'eip1559' });
    const createdAt = BigInt(journal.createdAtMs);
    const state = ['A', 'B', 'C'][completed];
    const batch = operations(state, createdAt, journal.keys.A);
    const estimated = await estimateBatch(batch, { nonce, ...fees }, read, completed === 2 ? journal.keys.A : undefined);
    const receiptSpend = journal.phases.reduce((total, phase) => total + BigInt(phase.actualFeeWei ?? '0'), 0n);
    const balance = await reader.getBalance({ address: CREATOR });
    const balanceDelta = BigInt(journal.initialBalanceWei) - balance;
    const probeSpent = receiptSpend > balanceDelta ? receiptSpend : balanceDelta;
    requireTrue(probeSpent <= PROBE_CAP && probeSpent + BigInt(journal.bootstrapSpentWei) <= 100_000_000_000_000_000n, 'OBSERVED_SPEND_EXCEEDED');
    if (completed === 2) {
      requireTrue(estimated.status === 'rejected_missing_entity', 'STALE_BATCH_UNEXPECTEDLY_ESTIMATED');
      await verifyNonce(); const after = await verifyCurrent(reader, journal, 2);
      const evidence = { schemaVersion: 1, status: 'verified', chainId: CHAIN_ID, sdkVersion: '0.8.1', probeId: PROBE_ID,
        creator: CREATOR, observedAt: new Date().toISOString(), parameterSha256: journal.fingerprint, keys: journal.keys,
        phases: journal.phases.map((phase, index) => ({ state: ['A', 'B'][index], transactionHash: phase.txHash,
          receiptBlock: phase.receiptBlock, blockHash: phase.blockHash, actualFeeWei: phase.actualFeeWei })),
        proof: { AAbsent: true, BExactAndLive: true, CAbsent: true, snapshotBefore: snapshot.toString(), snapshotAfter: after.toString(),
          staleEstimate: estimated, staleBroadcast: false, minedRollbackTested: false },
        budget: { maximumProbeTestGlm: '0.003', probeSpentWei: probeSpent.toString(), probeSpentTestGlm: formatEther(probeSpent),
          bootstrapSpentWei: journal.bootstrapSpentWei, approvedGlobalTestGlm: '0.1' },
        limitation: 'Stale batch rejection is verified through eth_estimateGas. Reverted mined-batch atomicity relies on official protocol documentation.' };
      journal.proof = evidence.proof; await save(JOURNAL, journal); await save(EVIDENCE, evidence); return evidence;
    }
    const gas = (estimated.gas * 12n + 9n) / 10n;
    const cap = assertProbeFunding({ balance, probeSpent, bootstrapSpent: BigInt(journal.bootstrapSpentWei), gas, ...fees });
    const phase = journal.phases[completed] ?? { status: 'prepared' };
    assertCanAdmit(phase);
    Object.assign(phase, { balanceBeforeWei: balance.toString(), spentWei: (probeSpent + BigInt(journal.bootstrapSpentWei)).toString(),
      plan: { nonce, input: estimated.input, gas: gas.toString(), estimatedGas: estimated.gas.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() } });
    journal.phases[completed] = phase; await save(JOURNAL, journal);
    const result = { status: 'estimated', broadcast: false, phase: state, chainId: CHAIN_ID, creator: CREATOR,
      probeId: PROBE_ID, parameterSha256: journal.fingerprint, expectedEntityKey: journal.keys[state],
      operationCount: completed + 1, estimatedGas: estimated.gas.toString(), gasLimit: gas.toString(),
      maximumCostTestGlm: formatEther(cap), probeSpentTestGlm: formatEther(probeSpent), probeCapTestGlm: '0.003' };
    if (!broadcast) return result;
    await verifyNonce(); await verifyCurrent(reader, journal, completed);
    assertProbeFunding({ balance: await reader.getBalance({ address: CREATOR }), probeSpent,
      bootstrapSpent: BigInt(journal.bootstrapSpentWei), gas, ...fees });
    const stored = await load(resolve(ROOT, '.local/demo-wallet.json'));
    requireTrue(stored.chainId === CHAIN_ID && stored.network === 'tiramisu' && same(stored.address, CREATOR) && HEX32.test(stored.privateKey), 'LOCAL_WALLET_MISMATCH');
    const account = privateKeyToAccount(stored.privateKey); requireTrue(same(account.address, CREATOR), 'LOCAL_WALLET_MISMATCH');
    const guarded = makeBroadcastGuard({ provider, read, journal: phase, persist: () => save(JOURNAL, journal) });
    const wallet = createWalletClient({ account, chain: tiramisu, cacheTime: 0, transport: custom({ request: guarded }, { retryCount: 0 }) });
    try { await wallet.executeBatch(batch, { nonce, gas, ...fees }); }
    catch { requireTrue(Boolean(phase.txHash), 'STOPPED_BEFORE_SEND_ADMISSION'); }
    await verifyReceipt(reader, journal, completed);
    const verifiedBlock = await verifyCurrent(reader, journal, completed + 1);
    return { ...result, status: 'phase_verified', broadcast: true, transactionHash: phase.txHash,
      currentBlock: verifiedBlock.toString(), actualFeeWei: phase.actualFeeWei,
      next: completed === 0 ? 'Run default to estimate the B transition; --broadcast separately admits B.' : 'Run default for the read-only stale-batch proof.' };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireTrue(args.length === 0 || (args.length === 1 && args[0] === '--broadcast'), 'USAGE_OPTIONAL_BROADCAST');
    console.log(json(await runAtomicProbe({ broadcast: args[0] === '--broadcast' })));
  } catch (error) {
    // SDK errors may contain signed bytes. Output only our allowlisted error codes.
    console.error(json({ status: 'stopped', code: error instanceof BootstrapError ? error.code : 'ATOMIC_PROBE_RECONCILE_REQUIRED',
      next: 'Inspect the local journal and reconcile original hashes. Never delete it or create replacements to retry.' }));
    process.exitCode = 1;
  }
}
