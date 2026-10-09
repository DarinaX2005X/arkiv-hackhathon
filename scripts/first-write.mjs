/**
 * One synthetic Arkiv bootstrap record, with durable send admission.
 * Default: read/reconcile and estimate only. Only --broadcast can admit a send.
 * Private key and signed transaction bytes are never printed or exported as evidence.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createPublicClient, createWalletClient, ENTITY_EVENTS_ABI, ExpirationTime,
  jsonToPayload, predictEntityKey,
} from '@arkiv-network/sdk';
import { key, u64 } from '@arkiv-network/sdk/attr';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { eq } from '@arkiv-network/sdk/query';
import {
  bytesToHex, custom, decodeEventLog, formatEther, http, keccak256,
  MethodNotFoundRpcError, parseTransaction, recoverTransactionAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { estimateFeesPerGas } from 'viem/actions';

export const CHAIN_ID = 7738577;
export const NATIVE = '0x4400000000000000000000000000000000000044';
export const CREATOR = '0x6267AB770266dA229130a2a75a52A9d578Fb0A5b';
export const MAX_SPEND_WEI = 100_000_000_000_000_000n; // 0.1 test GLM, total for this job.
export const PROJECT = 'arkiv_hackathon_capability_probe_v1';
export const PAYLOAD = Object.freeze({
  purpose: 'Verify Arkiv create, read-back and typed query', sdk: '0.8.1', synthetic: true,
});
const RPC = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const JOURNAL_PATH = resolve(ROOT, '.local/first-write-journal.json');
const EVIDENCE_PATH = resolve(ROOT, 'arkiv/evidence/bootstrap.json');
const READS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionCount',
  'eth_getBalance', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_call', 'arkiv_query',
]);
const ESTIMATE_READS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionCount',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas',
]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const hash = text => createHash('sha256').update(text).digest('hex');

export class BootstrapError extends Error {
  constructor(code) { super(code); this.name = 'BootstrapError'; this.code = code; }
}
function assert(ok, code) { if (!ok) throw new BootstrapError(code); }
function hasCause(error, expected) {
  for (let depth = 0, cause = error; cause && depth < 32; depth++, cause = cause.cause) {
    if (cause === expected) return true;
  }
  return false;
}

export function firstWriteParameters(createdAt) {
  assert(typeof createdAt === 'bigint' && createdAt > 0n, 'INVALID_CREATED_AT');
  return Object.freeze({
    payload: jsonToPayload(PAYLOAD), contentType: 'application/json', salt: 0n,
    attributes: Object.freeze({
      project: PROJECT, entity_type: 'bootstrap', seed_id: 'sdk_081_v1',
      created_at: Object.freeze(u64(createdAt)),
    }),
    flags: Object.freeze({ readonly: true, permissionlessExtension: false }),
    expires: Object.freeze(ExpirationTime.fromDays(30)),
  });
}

export function parameterFingerprint(parameters, creator = CREATOR) {
  return hash(json({
    chainId: CHAIN_ID, creator: creator.toLowerCase(),
    payloadHex: bytesToHex(parameters.payload), contentType: parameters.contentType,
    attributes: parameters.attributes, flags: parameters.flags,
    expires: { minLifetime: parameters.expires.minLifetime, expiresAt: parameters.expires.expiresAt },
    salt: parameters.salt,
  }));
}

export function assertFunding({ balance, spent = 0n, gas, maxFeePerGas, maxPriorityFeePerGas }) {
  assert([balance, spent, gas, maxFeePerGas, maxPriorityFeePerGas].every(value => typeof value === 'bigint'), 'INVALID_FUNDING_INPUT');
  assert(balance >= 0n && spent >= 0n && gas > 0n && maxFeePerGas > 0n
    && maxPriorityFeePerGas >= 0n && maxPriorityFeePerGas <= maxFeePerGas, 'INVALID_FEE_CAP');
  const cap = gas * maxFeePerGas;
  assert(spent + cap <= MAX_SPEND_WEI, 'APPROVED_BUDGET_EXCEEDED');
  assert(balance >= cap, 'INSUFFICIENT_TEST_GLM');
  return cap;
}

/** The provider sees no broadcast, fill, wallet, or unexpected method through this guard. */
export function makeEstimateGuard(provider) {
  const stop = new Error('Estimate captured');
  const state = { gas: undefined, input: undefined, stop, forwarded: [] };
  const request = async args => {
    if (args.method === 'eth_fillTransaction') {
      throw new MethodNotFoundRpcError(new Error('Fill is disabled for this estimate'));
    }
    assert(ESTIMATE_READS.has(args.method), 'ESTIMATE_RPC_METHOD_BLOCKED');
    state.forwarded.push(args.method);
    const result = await provider(args);
    if (args.method === 'eth_estimateGas') {
      assert(typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result), 'INVALID_GAS_ESTIMATE');
      const gas = BigInt(result);
      assert(gas > 0n, 'INVALID_GAS_ESTIMATE');
      assert(typeof args.params?.[0]?.data === 'string' && sameAddress(args.params[0].to, NATIVE), 'UNEXPECTED_ESTIMATE_TARGET');
      state.gas = gas;
      state.input = args.params[0].data;
      throw stop;
    }
    return result;
  };
  return { request, state };
}

export async function estimateCreate(account, parameters, txParams, provider) {
  assert(txParams.gas === undefined, 'ESTIMATE_MUST_NOT_HAVE_GAS_OVERRIDE');
  const guard = makeEstimateGuard(provider);
  const unsigned = { ...account, signTransaction: async () => { throw new BootstrapError('ESTIMATE_SIGNING_BLOCKED'); } };
  const wallet = createWalletClient({ account: unsigned, chain: tiramisu, cacheTime: 0,
    transport: custom({ request: guard.request }, { retryCount: 0 }) });
  try { await wallet.createEntity(parameters, txParams); }
  catch (error) {
    if (hasCause(error, guard.state.stop) && guard.state.gas !== undefined) {
      return { gas: guard.state.gas, input: guard.state.input, methods: [...guard.state.forwarded] };
    }
    throw new BootstrapError('GUARDED_ESTIMATE_FAILED');
  }
  throw new BootstrapError('ESTIMATE_GUARD_NOT_REACHED');
}

async function captureSdkInput(account, parameters, txParams, read) {
  let input;
  const stop = new Error('Unsigned input captured');
  const unsigned = { ...account, signTransaction: async transaction => { input = transaction.data; throw stop; } };
  const wallet = createWalletClient({ account: unsigned, chain: tiramisu, cacheTime: 0,
    transport: custom({ request: read }, { retryCount: 0 }) });
  try { await wallet.createEntity(parameters, txParams); }
  catch (error) {
    if (hasCause(error, stop) && typeof input === 'string') return input;
    throw new BootstrapError('UNSIGNED_INPUT_CAPTURE_FAILED');
  }
  throw new BootstrapError('UNSIGNED_INPUT_CAPTURE_NOT_REACHED');
}

export function validateSeed(entity, parameters, creator = CREATOR, snapshot) {
  assert(entity && HEX32.test(entity.key), 'SEED_NOT_FOUND');
  assert(sameAddress(entity.creator, creator) && sameAddress(entity.owner, creator), 'SEED_PROVENANCE_MISMATCH');
  assert(entity.creationFlags?.readonly === true && entity.creationFlags.permissionlessExtension === false
    && entity.creationFlags.raw === 1, 'SEED_FLAGS_MISMATCH');
  assert(entity.contentType === parameters.contentType && entity.payload instanceof Uint8Array
    && bytesToHex(entity.payload) === bytesToHex(parameters.payload), 'SEED_PAYLOAD_MISMATCH');
  assert(Object.keys(entity.attributes ?? {}).sort().join(',') === 'created_at,entity_type,project,seed_id', 'SEED_ATTRIBUTE_SET_MISMATCH');
  for (const name of ['project', 'entity_type', 'seed_id']) {
    assert(entity.attributes[name]?.type === 'str' && entity.attributes[name].value === parameters.attributes[name], 'SEED_ATTRIBUTE_MISMATCH');
  }
  assert(entity.attributes.created_at?.type === 'u64'
    && entity.attributes.created_at.value === parameters.attributes.created_at.value, 'SEED_TIMESTAMP_MISMATCH');
  assert(typeof entity.createdAt === 'bigint' && typeof entity.expiresAt === 'bigint'
    && entity.expiresAt - entity.createdAt === parameters.expires.minLifetime, 'SEED_LIFETIME_MISMATCH');
  if (snapshot !== undefined) assert(entity.expiresAt > snapshot, 'SEED_EXPIRED');
  return entity;
}

const SELECTION = {
  key: true, creator: true, owner: true, createdAt: true, expiresAt: true,
  creationFlags: true, payload: true, contentType: true, attributes: true,
};
function seedQuery(reader, snapshot) {
  return reader.select(SELECTION).where(eq('project', PROJECT), eq('entity_type', 'bootstrap'), eq('seed_id', 'sdk_081_v1'))
    .createdBy(CREATOR).atBlock(snapshot).limit(2);
}
async function readSeed(reader, snapshot) {
  const page = await seedQuery(reader, snapshot).fetch();
  assert(page.blockNumber === snapshot, 'SEED_QUERY_SNAPSHOT_MISMATCH');
  assert(page.entities.length <= 1 && !page.hasNextPage(), 'DUPLICATE_BOOTSTRAP_SEED');
  return page.entities[0];
}

/** An fsync failure prevents admission. A torn/corrupt file is never silently replaced. */
async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(json(value), 'utf8'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}
async function loadJournal() {
  let text;
  try { text = await readFile(JOURNAL_PATH, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new BootstrapError('JOURNAL_READ_FAILED'); }
  try {
    assert(text.endsWith('\n'), 'JOURNAL_TORN');
    const journal = JSON.parse(text);
    assert(journal.schema === 1 && journal.chainId === CHAIN_ID && sameAddress(journal.creator, CREATOR), 'JOURNAL_IDENTITY_MISMATCH');
    assert(journal.maxSpendWei === MAX_SPEND_WEI.toString(), 'JOURNAL_BUDGET_MISMATCH');
    const parameters = firstWriteParameters(BigInt(journal.createdAtMs));
    assert(journal.parameterFingerprint === parameterFingerprint(parameters), 'JOURNAL_PARAMETERS_CHANGED');
    return journal;
  } catch { throw new BootstrapError('JOURNAL_INVALID_RECONCILE_MANUALLY'); }
}

export function assertCanAdmit(journal) {
  assert(journal.status === 'prepared' && !journal.txHash && !journal.signedTransaction, 'SEND_ALREADY_ADMITTED_RECONCILE_ONLY');
}

function assertTransaction(transaction, plan, creator = CREATOR) {
  assert(transaction.chainId === CHAIN_ID && sameAddress(transaction.to, NATIVE), 'TRANSACTION_NETWORK_TARGET_MISMATCH');
  assert(transaction.nonce === plan.nonce && (transaction.input ?? transaction.data) === plan.input, 'TRANSACTION_INTENT_MISMATCH');
  assert((transaction.value ?? 0n) === 0n && transaction.type === 'eip1559', 'TRANSACTION_VALUE_TYPE_MISMATCH');
  assert(transaction.gas === BigInt(plan.gas) && transaction.maxFeePerGas === BigInt(plan.maxFeePerGas)
    && transaction.maxPriorityFeePerGas === BigInt(plan.maxPriorityFeePerGas), 'TRANSACTION_FEE_MISMATCH');
  if (transaction.from !== undefined) assert(sameAddress(transaction.from, creator), 'TRANSACTION_SIGNER_MISMATCH');
}

/** Exactly one raw send, authenticated against the estimated calldata and persisted before forwarding. */
export function makeBroadcastGuard({ provider, read, journal, persist, creator = CREATOR }) {
  let admitted = false;
  return async args => {
    if (args.method === 'eth_fillTransaction') {
      throw new MethodNotFoundRpcError(new Error('Fill is disabled for this frozen transaction'));
    }
    if (args.method !== 'eth_sendRawTransaction') return read(args);
    assert(!admitted, 'SECOND_SEND_BLOCKED');
    assertCanAdmit(journal);
    admitted = true;
    const serialized = args.params?.[0];
    assert(typeof serialized === 'string' && /^0x[0-9a-f]+$/i.test(serialized), 'INVALID_SIGNED_TRANSACTION');
    const parsed = parseTransaction(serialized);
    assertTransaction(parsed, journal.plan, creator);
    const signer = await recoverTransactionAddress({ serializedTransaction: serialized });
    assert(sameAddress(signer, creator), 'TRANSACTION_SIGNER_MISMATCH');
    assertFunding({ balance: BigInt(journal.balanceBeforeWei), spent: BigInt(journal.spentWei),
      gas: parsed.gas, maxFeePerGas: parsed.maxFeePerGas, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas });
    const txHash = keccak256(serialized);
    Object.assign(journal, { status: 'send_admitted', txHash, signedTransaction: serialized, admittedAt: new Date().toISOString() });
    await persist(journal); // Fsync before provider side effect. Failure means no forward.
    const returnedHash = await provider(args);
    assert(typeof returnedHash === 'string' && returnedHash.toLowerCase() === txHash.toLowerCase(), 'PROVIDER_HASH_MISMATCH_RECONCILE');
    journal.status = 'submitted';
    await persist(journal);
    return returnedHash;
  };
}

async function verifyConfirmed(reader, journal, parameters) {
  assert(HEX32.test(journal.txHash), 'MISSING_TRANSACTION_HASH_RECONCILE');
  let receipt;
  try { receipt = await reader.getTransactionReceipt({ hash: journal.txHash }); }
  catch { throw new BootstrapError('RECEIPT_UNAVAILABLE_RECONCILE_ONLY'); }
  assert(receipt.transactionHash.toLowerCase() === journal.txHash.toLowerCase(), 'RECEIPT_HASH_MISMATCH');
  const transaction = await reader.getTransaction({ hash: journal.txHash });
  assertTransaction(transaction, journal.plan);
  assert(sameAddress(receipt.from, CREATOR) && sameAddress(receipt.to, NATIVE), 'RECEIPT_PARTIES_MISMATCH');
  assert(receipt.blockHash === transaction.blockHash && receipt.blockNumber === transaction.blockNumber, 'RECEIPT_TRANSACTION_BLOCK_MISMATCH');
  const block = await reader.getBlock({ blockNumber: receipt.blockNumber });
  assert(block.hash === receipt.blockHash, 'RECEIPT_NOT_CANONICAL');
  assert(typeof receipt.gasUsed === 'bigint' && receipt.gasUsed > 0n
    && receipt.gasUsed <= BigInt(journal.plan.gas) && typeof receipt.effectiveGasPrice === 'bigint'
    && receipt.effectiveGasPrice > 0n && receipt.effectiveGasPrice <= BigInt(journal.plan.maxFeePerGas), 'INVALID_RECEIPT_GAS');
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  journal.spentWei = fee.toString();
  journal.receiptBlock = receipt.blockNumber.toString();
  if (receipt.status !== 'success') {
    journal.status = 'reverted';
    await saveJson(JOURNAL_PATH, journal);
    throw new BootstrapError('RECEIPT_REVERTED_NO_AUTOMATIC_RETRY');
  }
  assert(fee <= MAX_SPEND_WEI, 'OBSERVED_FEE_EXCEEDS_APPROVED_BUDGET');
  const logs = receipt.logs.filter(log => sameAddress(log.address, NATIVE));
  assert(logs.length === 1, 'UNEXPECTED_NATIVE_EVENT_COUNT');
  const event = decodeEventLog({ abi: ENTITY_EVENTS_ABI, topics: logs[0].topics, data: logs[0].data });
  assert(event.eventName === 'EntityCreated' && sameAddress(event.args.owner, CREATOR)
    && event.args.creationFlags === 1, 'CREATE_EVENT_MISMATCH');
  assert(event.args.entityKey === journal.expectedEntityKey, 'PREDICTED_ENTITY_KEY_MISMATCH');
  assert(event.args.expiresAt - receipt.blockNumber === parameters.expires.minLifetime, 'CREATE_EVENT_EXPIRATION_MISMATCH');
  const page = await reader.select(SELECTION).where(eq('$key', key(event.args.entityKey)))
    .createdBy(CREATOR).atBlock(receipt.blockNumber).limit(1).fetch();
  assert(page.blockNumber === receipt.blockNumber && page.entities.length === 1 && !page.hasNextPage(), 'PINNED_KEY_READ_FAILED');
  const entity = validateSeed(page.entities[0], parameters, CREATOR, receipt.blockNumber);
  assert(entity.createdAt === receipt.blockNumber && entity.expiresAt === event.args.expiresAt, 'READBACK_EVENT_MISMATCH');
  const scoped = await readSeed(reader, receipt.blockNumber);
  assert(scoped?.key === entity.key, 'TYPED_SEED_QUERY_MISMATCH');
  validateSeed(scoped, parameters, CREATOR, receipt.blockNumber);
  const currentBlock = await reader.getBlockNumber({ cacheTime: 0 });
  const current = await readSeed(reader, currentBlock);
  assert(current?.key === entity.key, 'CURRENT_SEED_MISSING_DO_NOT_RECREATE');
  validateSeed(current, parameters, CREATOR, currentBlock);
  const balanceAfter = await reader.getBalance({ address: CREATOR });
  const delta = journal.balanceBeforeWei === null ? null : BigInt(journal.balanceBeforeWei) - balanceAfter;
  assert(delta === null || delta <= MAX_SPEND_WEI, 'ACCOUNT_BALANCE_DELTA_EXCEEDS_BUDGET');
  const evidence = {
    schemaVersion: 1, network: 'tiramisu', chainId: CHAIN_ID, sdkVersion: '0.8.1',
    observedAt: new Date().toISOString(), creator: CREATOR, owner: entity.owner,
    entityKey: entity.key, transactionHash: journal.txHash,
    receipt: { status: receipt.status, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
      gasFeeWei: fee.toString(), gasFeeTestGlm: formatEther(fee) },
    expiration: { createdAtBlock: entity.createdAt.toString(), expiresAtBlock: entity.expiresAt.toString(),
      minimumLifetimeBlocks: parameters.expires.minLifetime.toString(), requestedDays: 30 },
    budget: { maximumWei: MAX_SPEND_WEI.toString(), maximumTestGlm: '0.1', spentWei: fee.toString(),
      accountBalanceDeltaWei: delta?.toString() ?? null },
    proof: { parameterSha256: journal.parameterFingerprint, payloadSha256: hash(Buffer.from(parameters.payload)),
      payload: PAYLOAD, contentType: entity.contentType, attributes: entity.attributes, flags: entity.creationFlags,
      pinnedReadBlock: receipt.blockNumber.toString(), currentReadBlock: currentBlock.toString(),
      creatorScopedSeedQuery: seedQuery(reader, receipt.blockNumber).toString(),
      keyQueryMatched: true, typedSeedQueryMatched: true, payloadAndAttributesMatched: true },
    references: { entity: `https://tiramisu.explorer.arkiv.network/entity/${entity.key}`,
      transaction: `https://tiramisu.explorer.arkiv.network/tx/${journal.txHash}` },
  };
  journal.status = 'verified';
  journal.entityKey = entity.key;
  journal.verifiedAt = evidence.observedAt;
  await saveJson(JOURNAL_PATH, journal);
  await saveJson(EVIDENCE_PATH, evidence);
  return { status: 'verified', reused: true, ...evidence };
}

async function adoptExisting(reader, read, account, entity, genesisHash, existingJournal) {
  const parameters = firstWriteParameters(entity.attributes?.created_at?.value);
  validateSeed(entity, parameters);
  if (existingJournal) assert(existingJournal.parameterFingerprint === parameterFingerprint(parameters), 'EXISTING_SEED_DIFFERS_FROM_JOURNAL');
  const creationEvent = ENTITY_EVENTS_ABI.find(item => item.name === 'EntityCreated');
  const logs = await reader.getLogs({ address: NATIVE, event: creationEvent,
    args: { entityKey: entity.key, owner: CREATOR }, fromBlock: entity.createdAt, toBlock: entity.createdAt });
  assert(logs.length === 1 && HEX32.test(logs[0].transactionHash), 'EXISTING_SEED_ORIGIN_UNRESOLVED');
  const transaction = await reader.getTransaction({ hash: logs[0].transactionHash });
  assert(transaction.type === 'eip1559' && sameAddress(transaction.from, CREATOR), 'EXISTING_SEED_TRANSACTION_MISMATCH');
  const txParams = { nonce: transaction.nonce, gas: transaction.gas,
    maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas };
  const input = await captureSdkInput(account, parameters, txParams, read);
  assert(input === transaction.input, 'EXISTING_SEED_INPUT_MISMATCH');
  const journal = { schema: 1, chainId: CHAIN_ID, creator: CREATOR, genesisHash,
    maxSpendWei: MAX_SPEND_WEI.toString(), createdAtMs: parameters.attributes.created_at.value.toString(),
    parameterFingerprint: parameterFingerprint(parameters), expectedEntityKey: entity.key,
    status: 'reconciled_existing', txHash: logs[0].transactionHash,
    spentWei: '0', balanceBeforeWei: null, entityNonceBefore: null,
    plan: { ...txParams, input }, adoptedAt: new Date().toISOString() };
  await saveJson(JOURNAL_PATH, journal);
  return verifyConfirmed(reader, journal, parameters);
}

async function withExclusiveWriter(task) {
  const port = 20000 + parseInt(hash(`${CHAIN_ID}:${CREATOR.toLowerCase()}`).slice(0, 8), 16) % 30000;
  const server = createServer(socket => socket.destroy());
  await new Promise((accept, reject) => {
    server.once('error', () => reject(new BootstrapError('LOCAL_SIGNER_COORDINATOR_BUSY')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, accept);
  });
  try { return await task(); }
  finally { await new Promise(accept => server.close(accept)); }
}

async function loadAccount() {
  try {
    const stored = JSON.parse(await readFile(resolve(ROOT, '.local/demo-wallet.json'), 'utf8'));
    assert(stored.chainId === CHAIN_ID && stored.network === 'tiramisu'
      && sameAddress(stored.address, CREATOR) && HEX32.test(stored.privateKey), 'LOCAL_WALLET_INVALID');
    const account = privateKeyToAccount(stored.privateKey);
    assert(sameAddress(account.address, CREATOR), 'LOCAL_WALLET_INVALID');
    return account;
  } catch { throw new BootstrapError('CANNOT_LOAD_EXPECTED_LOCAL_WALLET'); }
}

export async function runBootstrap({ broadcast = false } = {}) {
  assert(broadcast === true || broadcast === false, 'INVALID_BROADCAST_FLAG');
  assert(!process.env.DEBUG, 'DISABLE_DEBUG_LOGGING_FOR_SIGNER_CUSTODY');
  const require = createRequire(import.meta.url);
  assert(require('@arkiv-network/sdk/package.json').version === '0.8.1', 'SDK_VERSION_CHANGED_REVIEW_REQUIRED');
  return withExclusiveWriter(async () => {
    const account = await loadAccount();
    const provider = http(RPC, { retryCount: 0, timeout: 10_000,
      fetchOptions: { cache: 'no-store', redirect: 'error' } })({ chain: tiramisu }).request;
    const read = async args => {
      if (args.method === 'eth_fillTransaction') throw new MethodNotFoundRpcError(new Error('Fill is disabled'));
      assert(READS.has(args.method), 'READ_ONLY_RPC_METHOD_BLOCKED');
      return provider(args);
    };
    const reader = createPublicClient({ chain: tiramisu, cacheTime: 0,
      transport: custom({ request: read }, { retryCount: 0 }) });
    assert(await reader.getChainId() === CHAIN_ID, 'WRONG_CHAIN');
    const genesis = await reader.getBlock({ blockNumber: 0n });
    assert(HEX32.test(genesis.hash), 'MISSING_GENESIS_IDENTITY');
    let journal = await loadJournal();
    if (journal) assert(journal.genesisHash === genesis.hash, 'CHAIN_GENESIS_CHANGED_RECONCILE_ONLY');
    const snapshot = await reader.getBlockNumber({ cacheTime: 0 });
    const seed = await readSeed(reader, snapshot);
    if (journal?.txHash) return verifyConfirmed(reader, journal, firstWriteParameters(BigInt(journal.createdAtMs)));
    if (journal) assertCanAdmit(journal);
    if (seed) return adoptExisting(reader, read, account, seed, genesis.hash, journal);
    const latestNonce = await reader.getTransactionCount({ address: CREATOR, blockTag: 'latest' });
    const pendingNonce = await reader.getTransactionCount({ address: CREATOR, blockTag: 'pending' });
    assert(latestNonce === pendingNonce, 'PENDING_TRANSACTION_REQUIRES_RECONCILIATION');
    const entityNonce = await reader.getEntityNonce(CREATOR);
    const balance = await reader.getBalance({ address: CREATOR });
    if (!journal) {
      // The dedicated bootstrap wallet has one authorized seed and no prior outgoing transactions.
      assert(latestNonce === 0 && entityNonce === 0n, 'UNJOURNALED_SIGNER_HISTORY_REQUIRES_RECONCILIATION');
      const parameters = firstWriteParameters(BigInt(Date.now()));
      journal = { schema: 1, status: 'prepared', chainId: CHAIN_ID, creator: CREATOR,
        genesisHash: genesis.hash, createdAtMs: parameters.attributes.created_at.value.toString(),
        parameterFingerprint: parameterFingerprint(parameters), maxSpendWei: MAX_SPEND_WEI.toString(),
        startBlock: snapshot.toString(), transactionNonceBefore: latestNonce, entityNonceBefore: entityNonce.toString(),
        initialBalanceWei: balance.toString(), balanceBeforeWei: balance.toString(), spentWei: '0',
        expectedEntityKey: predictEntityKey({ owner: CREATOR, nonce: entityNonce, salt: 0n, chainId: CHAIN_ID }) };
      await saveJson(JOURNAL_PATH, journal);
    }
    assert(journal.transactionNonceBefore === latestNonce && BigInt(journal.entityNonceBefore) === entityNonce, 'NONCE_CHANGED_RECONCILE_ONLY');
    const parameters = firstWriteParameters(BigInt(journal.createdAtMs));
    assert(parameterFingerprint(parameters) === journal.parameterFingerprint, 'FROZEN_PARAMETERS_CHANGED');
    const fees = await estimateFeesPerGas(reader, { type: 'eip1559' });
    const estimated = await estimateCreate(account, parameters, { nonce: latestNonce, ...fees }, read);
    const gas = (estimated.gas * 12n + 9n) / 10n;
    const observedSpent = BigInt(journal.initialBalanceWei) > balance ? BigInt(journal.initialBalanceWei) - balance : 0n;
    const spent = observedSpent > BigInt(journal.spentWei) ? observedSpent : BigInt(journal.spentWei);
    const cap = assertFunding({ balance, spent, gas, ...fees });
    journal.balanceBeforeWei = balance.toString();
    journal.spentWei = spent.toString();
    journal.plan = { nonce: latestNonce, input: estimated.input, gas: gas.toString(),
      estimatedGas: estimated.gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), maximumCostWei: cap.toString(),
      estimatedAt: new Date().toISOString() };
    await saveJson(JOURNAL_PATH, journal);
    const prepared = { status: 'estimated', network: 'tiramisu', chainId: CHAIN_ID, creator: CREATOR,
      broadcast: false, parameterSha256: journal.parameterFingerprint, expectedEntityKey: journal.expectedEntityKey,
      transactionNonce: latestNonce, entityNonce: entityNonce.toString(), estimatedGas: estimated.gas.toString(),
      gasLimit: gas.toString(), maximumCostWei: cap.toString(), maximumCostTestGlm: formatEther(cap),
      approvedTotalTestGlm: '0.1', spentWei: spent.toString(), balanceTestGlm: formatEther(balance),
      localJournal: '.local/first-write-journal.json' };
    if (!broadcast) return prepared;
    assertCanAdmit(journal);
    assert(parameterFingerprint(parameters) === journal.parameterFingerprint, 'FROZEN_PARAMETERS_CHANGED');
    const freshHead = await reader.getBlockNumber({ cacheTime: 0 });
    assert(!(await readSeed(reader, freshHead)), 'SEED_APPEARED_RECONCILE_ONLY');
    assert(await reader.getTransactionCount({ address: CREATOR, blockTag: 'pending' }) === latestNonce
      && await reader.getTransactionCount({ address: CREATOR, blockTag: 'latest' }) === latestNonce
      && await reader.getEntityNonce(CREATOR) === entityNonce, 'NONCE_CHANGED_BEFORE_SEND');
    assertFunding({ balance: await reader.getBalance({ address: CREATOR }), spent, gas, ...fees });
    const guardedSend = makeBroadcastGuard({ provider, read, journal, persist: value => saveJson(JOURNAL_PATH, value) });
    const wallet = createWalletClient({ account, chain: tiramisu, cacheTime: 0,
      transport: custom({ request: guardedSend }, { retryCount: 0 }) });
    try {
      const created = await wallet.createEntity(parameters, { nonce: latestNonce, gas, ...fees });
      assert(created.txHash === journal.txHash && created.entityKey === journal.expectedEntityKey, 'SDK_RESULT_MISMATCH_RECONCILE_ONLY');
    } catch {
      if (journal.txHash) {
        journal.status = 'reconcile_required';
        await saveJson(JOURNAL_PATH, journal);
        // Reconcile only the captured original hash; never call createEntity again.
        return verifyConfirmed(reader, journal, parameters);
      }
      throw new BootstrapError('CREATE_STOPPED_BEFORE_DURABLE_SEND_ADMISSION');
    }
    const verified = await verifyConfirmed(reader, journal, parameters);
    return { ...verified, reused: false };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 1 && args[0] === '--broadcast'), 'USAGE_NODE_FIRST_WRITE_OPTIONAL_BROADCAST');
    console.log(json(await runBootstrap({ broadcast: args[0] === '--broadcast' })));
  } catch (error) {
    // Never serialize an SDK/RPC error, account, wallet file or signed transaction.
    const code = error instanceof BootstrapError ? error.code : 'BOOTSTRAP_STOPPED_REVIEW_LOCAL_JOURNAL';
    console.error(json({ status: 'stopped', code, next: 'Reconcile the local journal before any new send. Default execution never broadcasts.' }));
    process.exitCode = 1;
  }
}
