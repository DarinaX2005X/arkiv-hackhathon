import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction } from 'viem';
import type { Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { canonicalJson } from '../../src/domain/canonical';
import { ARKIV_NATIVE_ADDRESS } from '../../src/data/wallet/gateway';
import type { InjectedWalletProvider, NativeTransactionRequest, RpcRequest } from '../../src/data/wallet/types';

export const LIVE_CHAIN_ID = 7738577;
export const LIVE_LIMIT_WEI = '100000000000000000';
export const PRIOR_SPEND_WEI = '326176000652352';
export const MAX_GAS = 2_000_000n;
export const MAX_FEE_PER_GAS = 2_000_000_000n;
export type ReadRpc = (request: RpcRequest) => Promise<unknown>;
export type SendRaw = (raw: Hex) => Promise<unknown>;
export type LoadAccount = () => Promise<PrivateKeyAccount>;
type Persist = (document: BudgetDocument) => void | Promise<void>;

export class LiveSafetyError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LiveSafetyError'; }
}
const fail = (code: string): never => { throw new LiveSafetyError(code); };
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const address = (value: unknown): string => typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value)
  ? value.toLowerCase() : fail('INVALID_ADDRESS');
const decimal = (value: unknown): bigint => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
  ? BigInt(value) : fail('INVALID_DECIMAL');
const quantity = (value: unknown): bigint => typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][\da-fA-F]*)$/.test(value)
  ? BigInt(value) : fail('INVALID_RPC_QUANTITY');
const bytes = (value: unknown): Hex => typeof value === 'string' && /^0x(?:[\da-fA-F]{2})*$/.test(value)
  ? value.toLowerCase() as Hex : fail('INVALID_HEX_BYTES');
const hash = (value: unknown): Hex => typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value)
  ? value.toLowerCase() as Hex : fail('INVALID_TRANSACTION_HASH');
const hex = (value: bigint): Hex => `0x${value.toString(16)}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('INVALID_RPC_OBJECT');

/** The replacement file is fsynced before rename. Unsupported directory fsync on Windows is not claimed. */
export function atomicWriteJson(path: string, value: unknown): void {
  const contents = `${JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    // Node cannot open a Windows directory for fsync. The file itself was flushed above.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Missing is distinct from corrupt: corrupt/torn data is never reset or replaced implicitly. */
export function readJson<T>(path: string): T | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!text.endsWith('\n')) fail('TORN_JSON_FILE');
  try {
    const value: unknown = JSON.parse(text);
    if (value === null) fail('INVALID_JSON_FILE');
    return value as T;
  } catch { return fail('INVALID_JSON_FILE'); }
}

/** A single-key Storage adapter for the application's existing BrowserOperationStore. */
export function createFileStorage(path: string): Pick<Storage, 'getItem' | 'setItem'> {
  const read = (key: string) => {
    const document = readJson<{ version: number; key: string; value: string }>(path);
    if (document !== null && (typeof document !== 'object' || Array.isArray(document)
      || document.version !== 1 || document.key !== key || typeof document.value !== 'string')) fail('INVALID_STORAGE_FILE');
    return document;
  };
  return {
    getItem(key) { return read(key)?.value ?? null; },
    setItem(key, value) { read(key); atomicWriteJson(path, { version: 1, key, value }); },
  };
}

const lockPort = (scope: string) => 20_000 + parseInt(createHash('sha256').update(scope).digest('hex').slice(0, 8), 16) % 30_000;
export const accountLockPort = (account: string, chainId = LIVE_CHAIN_ID) => lockPort(`${chainId}:${address(account)}`);
async function acquirePort(port: number): Promise<() => Promise<void>> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new LiveSafetyError('LOCAL_SIGNER_COORDINATOR_BUSY')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve());
  });
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

/** Root account uses the exact mutex scheme of first-write.mjs and probe-atomic-transition.mjs. */
export async function withRunLock<T>(rootAccount: string, task: () => Promise<T>, options: {
  chainId?: number; runId?: string; accounts?: string[];
} = {}): Promise<T> {
  const chainId = options.chainId ?? LIVE_CHAIN_ID;
  const ports = [...new Set([
    accountLockPort(rootAccount, chainId),
    ...(options.accounts ?? []).map(account => accountLockPort(account, chainId)),
    lockPort(`partfolk-live:${chainId}:${options.runId ?? 'smallworks-04.2'}`),
  ])].sort((a, b) => a - b);
  const releases: (() => Promise<void>)[] = [];
  try { for (const port of ports) releases.push(await acquirePort(port)); return await task(); }
  finally { for (const release of releases.reverse()) await release(); }
}

export interface FrozenPlan {
  chainId: number; from: string; to: string; data: Hex; value: string; nonce: number;
  gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
}
export interface BudgetReceipt {
  transactionHash: Hex; blockHash: Hex; blockNumber: string; transactionIndex: string;
  status: 'success' | 'reverted'; gasUsed: string; effectiveGasPrice: string; actualCostWei: string;
}
export interface BudgetRecord {
  id: string; kind: 'native' | 'funding'; plan: FrozenPlan; maximumCostWei: string;
  status: 'reserved' | 'admitted' | 'submitted' | 'confirmed' | 'reverted';
  signedTransaction: Hex | null; transactionHash: Hex | null; receipt: BudgetReceipt | null;
}
export interface BudgetDocument {
  version: 1; chainId: number; rootAccount: string; limitWei: string; priorSpendWei: string; records: BudgetRecord[];
}
export function createBudgetDocument(options: { rootAccount: string; chainId?: number; limitWei?: string; priorSpendWei?: string }): BudgetDocument {
  const document: BudgetDocument = {
    version: 1, chainId: options.chainId ?? LIVE_CHAIN_ID, rootAccount: address(options.rootAccount),
    limitWei: options.limitWei ?? LIVE_LIMIT_WEI, priorSpendWei: options.priorSpendWei ?? PRIOR_SPEND_WEI, records: [],
  };
  validateDocument(document); return document;
}
function maximumCost(plan: FrozenPlan): bigint { return decimal(plan.value) + decimal(plan.gas) * decimal(plan.maxFeePerGas); }
function validatePlan(plan: FrozenPlan): void {
  if (plan.chainId !== LIVE_CHAIN_ID || !Number.isSafeInteger(plan.nonce) || plan.nonce < 0) fail('INVALID_FROZEN_PLAN');
  address(plan.from); address(plan.to); bytes(plan.data); decimal(plan.value);
  const gas = decimal(plan.gas), fee = decimal(plan.maxFeePerGas), priority = decimal(plan.maxPriorityFeePerGas);
  if (gas <= 0n || gas > MAX_GAS || fee <= 0n || fee > MAX_FEE_PER_GAS || priority > fee) fail('FEE_CAP_EXCEEDED');
}
function validateDocument(document: BudgetDocument): void {
  if (!document || document.version !== 1 || document.chainId !== LIVE_CHAIN_ID || !Array.isArray(document.records)) fail('INVALID_BUDGET_DOCUMENT');
  address(document.rootAccount);
  if (decimal(document.limitWei) > BigInt(LIVE_LIMIT_WEI) || decimal(document.priorSpendWei) < BigInt(PRIOR_SPEND_WEI)
    || decimal(document.priorSpendWei) > decimal(document.limitWei)) fail('INVALID_BUDGET_LIMIT');
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const record of document.records) {
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id) || !['native', 'funding'].includes(record.kind)
      || !['reserved', 'admitted', 'submitted', 'confirmed', 'reverted'].includes(record.status)) fail('INVALID_BUDGET_RECORD');
    ids.add(record.id); validatePlan(record.plan);
    if (maximumCost(record.plan) !== decimal(record.maximumCostWei)) fail('INVALID_RESERVATION');
    if (record.kind === 'native' && (address(record.plan.to) !== address(ARKIV_NATIVE_ADDRESS) || decimal(record.plan.value) !== 0n || bytes(record.plan.data) === '0x')) fail('INVALID_NATIVE_PLAN');
    if (record.kind === 'funding' && (address(record.plan.from) !== address(document.rootAccount) || bytes(record.plan.data) !== '0x' || decimal(record.plan.value) <= 0n)) fail('INVALID_FUNDING_PLAN');
    if (record.status === 'reserved') {
      if (record.signedTransaction !== null || record.transactionHash !== null || record.receipt !== null) fail('INVALID_RESERVED_RECORD');
    } else {
      const txHash = hash(record.transactionHash);
      if (hash(keccak256(bytes(record.signedTransaction))) !== txHash || hashes.has(txHash)) fail('INVALID_SIGNED_RECORD');
      hashes.add(txHash);
    }
    if (record.status === 'confirmed' || record.status === 'reverted') {
      const receipt = record.receipt ?? fail('INVALID_RECEIPT_RECORD');
      if (hash(receipt.transactionHash) !== record.transactionHash
        || receipt.status !== (record.status === 'confirmed' ? 'success' : 'reverted')
        || decimal(receipt.actualCostWei) > decimal(record.maximumCostWei)) fail('INVALID_RECEIPT_RECORD');
      hash(receipt.blockHash); decimal(receipt.blockNumber); decimal(receipt.transactionIndex);
      const gas = decimal(receipt.gasUsed), fee = decimal(receipt.effectiveGasPrice);
      if (gas <= 0n || gas > decimal(record.plan.gas) || fee > decimal(record.plan.maxFeePerGas)
        || decimal(receipt.actualCostWei) !== gas * fee + (record.status === 'confirmed' ? decimal(record.plan.value) : 0n)) fail('INVALID_RECEIPT_RECORD');
    } else if (record.receipt !== null) fail('INVALID_RECEIPT_RECORD');
  }
  if (charged(document) > decimal(document.limitWei)) fail('APPROVED_BUDGET_EXCEEDED');
}
function charged(document: BudgetDocument): bigint {
  return decimal(document.priorSpendWei) + document.records.reduce((sum, record) => sum +
    (record.receipt ? decimal(record.receipt.actualCostWei) : decimal(record.maximumCostWei)), 0n);
}
function frozenRequest(requestInput: unknown, expectedAddress: string, kind: 'native' | 'funding', chainId: number): Omit<FrozenPlan, 'nonce'> {
  const request = object(requestInput);
  if (Object.keys(request).some(key => !['from', 'to', 'data', 'value', 'chainId', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas'].includes(key))) fail('UNSUPPORTED_TRANSACTION_FIELD');
  if (address(request.from) !== address(expectedAddress) || quantity(request.chainId) !== BigInt(chainId)) fail('REQUEST_AUTHORITY_MISMATCH');
  const plan = {
    chainId, from: address(request.from), to: address(request.to), data: bytes(request.data), value: quantity(request.value).toString(),
    gas: quantity(request.gas).toString(), maxFeePerGas: quantity(request.maxFeePerGas).toString(),
    maxPriorityFeePerGas: quantity(request.maxPriorityFeePerGas).toString(),
  };
  validatePlan({ ...plan, nonce: 0 });
  if (kind === 'native' && (plan.to !== address(ARKIV_NATIVE_ADDRESS) || plan.value !== '0' || plan.data === '0x')) fail('INVALID_NATIVE_PLAN');
  if (kind === 'funding' && (plan.data !== '0x' || decimal(plan.value) <= 0n)) fail('INVALID_FUNDING_PLAN');
  return plan;
}
async function authenticateRaw(raw: Hex, plan: FrozenPlan): Promise<void> {
  const parsed = parseTransaction(raw);
  const halfCurveOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  if (parsed.type !== 'eip1559' || parsed.chainId !== plan.chainId || parsed.nonce !== plan.nonce
    || address(parsed.to) !== plan.to || bytes(parsed.data ?? '0x') !== plan.data || (parsed.value ?? 0n) !== decimal(plan.value)
    || parsed.gas !== decimal(plan.gas) || parsed.maxFeePerGas !== decimal(plan.maxFeePerGas)
    || (parsed.maxPriorityFeePerGas ?? 0n) !== decimal(plan.maxPriorityFeePerGas) || (parsed.accessList?.length ?? 0) !== 0
    || !parsed.r || !parsed.s || BigInt(parsed.r) <= 0n || BigInt(parsed.s) <= 0n || BigInt(parsed.s) > halfCurveOrder
    || (parsed.yParity !== 0 && parsed.yParity !== 1) || serializeTransaction(parsed).toLowerCase() !== raw
    || address(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })) !== plan.from) fail('SIGNED_TRANSACTION_MISMATCH');
}
function authenticateRpcTransaction(value: unknown, record: BudgetRecord, receipt: Record<string, unknown>): void {
  const tx = object(value), plan = record.plan;
  if (hash(tx.hash) !== record.transactionHash || address(tx.from) !== plan.from || address(tx.to) !== plan.to
    || bytes(tx.input) !== plan.data || quantity(tx.value) !== decimal(plan.value) || quantity(tx.nonce) !== BigInt(plan.nonce)
    || quantity(tx.gas) !== decimal(plan.gas) || quantity(tx.type) !== 2n
    || quantity(tx.maxFeePerGas) !== decimal(plan.maxFeePerGas) || quantity(tx.maxPriorityFeePerGas) !== decimal(plan.maxPriorityFeePerGas)
    || (tx.chainId !== undefined && quantity(tx.chainId) !== BigInt(plan.chainId))
    || hash(tx.blockHash) !== hash(receipt.blockHash) || quantity(tx.blockNumber) !== quantity(receipt.blockNumber)
    || quantity(tx.transactionIndex) !== quantity(receipt.transactionIndex)
    || (tx.accessList !== undefined && (!Array.isArray(tx.accessList) || tx.accessList.length !== 0))) fail('RECEIPT_TRANSACTION_MISMATCH');
}
interface SubmitOptions {
  id: string; kind: 'native' | 'funding'; address: string; request: unknown; read: ReadRpc; sendRaw: SendRaw;
  loadAccount: LoadAccount; broadcast?: boolean; fundingAllowlist?: Readonly<Record<string, string>>;
}

/** Private signed bytes stay in this local ledger; publicSummary intentionally excludes them and calldata. */
export class BudgetLedger {
  private document: BudgetDocument;
  private active = false;
  constructor(document: BudgetDocument, private readonly persist: Persist) { validateDocument(document); this.document = clone(document); }
  snapshot(): BudgetDocument { return clone(this.document); }
  publicSummary() {
    return {
      version: 1, chainId: this.document.chainId, rootAccount: this.document.rootAccount, limitWei: this.document.limitWei,
      priorSpendWei: this.document.priorSpendWei, chargedWei: charged(this.document).toString(),
      remainingWei: (decimal(this.document.limitWei) - charged(this.document)).toString(),
      records: this.document.records.map(record => ({ id: record.id, kind: record.kind, from: record.plan.from, to: record.plan.to,
        valueWei: record.plan.value, nonce: record.plan.nonce, maximumCostWei: record.maximumCostWei, status: record.status,
        transactionHash: record.transactionHash, receipt: record.receipt ? clone(record.receipt) : null })),
    };
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.active) fail('LEDGER_BUSY'); this.active = true;
    try { return await action(); } finally { this.active = false; }
  }
  private async save(): Promise<void> { validateDocument(this.document); await this.persist(clone(this.document)); }
  async reconcileAll(read: ReadRpc): Promise<void> { return this.exclusive(() => this.reconcile(read)); }
  private async reconcile(read: ReadRpc): Promise<void> {
    if (quantity(await read({ method: 'eth_chainId' })) !== BigInt(this.document.chainId)) fail('WRONG_CHAIN');
    for (const record of this.document.records) {
      if (!record.transactionHash || !record.signedTransaction) continue;
      await authenticateRaw(record.signedTransaction, record.plan);
      const receiptValue = await read({ method: 'eth_getTransactionReceipt', params: [record.transactionHash] });
      if (receiptValue === null) {
        if (record.receipt) { record.receipt = null; record.status = 'admitted'; await this.save(); }
        continue;
      }
      const receipt = object(receiptValue);
      if (hash(receipt.transactionHash) !== record.transactionHash || address(receipt.from) !== record.plan.from
        || address(receipt.to) !== record.plan.to || quantity(receipt.type) !== 2n) fail('RECEIPT_IDENTITY_MISMATCH');
      const blockNumber = quantity(receipt.blockNumber), blockHash = hash(receipt.blockHash), index = quantity(receipt.transactionIndex);
      const status = quantity(receipt.status), gasUsed = quantity(receipt.gasUsed), effectiveGasPrice = quantity(receipt.effectiveGasPrice);
      if ((status !== 0n && status !== 1n) || gasUsed <= 0n || gasUsed > decimal(record.plan.gas)
        || effectiveGasPrice > decimal(record.plan.maxFeePerGas)) fail('INVALID_RECEIPT_COST');
      const [transaction, blockValue] = await Promise.all([
        read({ method: 'eth_getTransactionByHash', params: [record.transactionHash] }),
        read({ method: 'eth_getBlockByNumber', params: [hex(blockNumber), false] }),
      ]);
      authenticateRpcTransaction(transaction, record, receipt);
      const block = object(blockValue);
      if (hash(block.hash) !== blockHash || quantity(block.number) !== blockNumber || !Array.isArray(block.transactions)
        || index > BigInt(Number.MAX_SAFE_INTEGER) || hash(block.transactions[Number(index)]) !== record.transactionHash) fail('NONCANONICAL_RECEIPT');
      const actualCost = gasUsed * effectiveGasPrice + (status === 1n ? decimal(record.plan.value) : 0n);
      const verified: BudgetReceipt = { transactionHash: record.transactionHash, blockHash, blockNumber: blockNumber.toString(),
        transactionIndex: index.toString(), status: status === 1n ? 'success' : 'reverted', gasUsed: gasUsed.toString(),
        effectiveGasPrice: effectiveGasPrice.toString(), actualCostWei: actualCost.toString() };
      if (!same(record.receipt, verified)) {
        record.receipt = verified; record.status = status === 1n ? 'confirmed' : 'reverted'; await this.save();
      }
    }
  }
  async submit(options: SubmitOptions): Promise<Hex> {
    return this.exclusive(async () => {
      if (options.broadcast !== true) fail('BROADCAST_NOT_ENABLED');
      if (!options.id || this.document.records.some(record => record.id === options.id)) fail('ORIGINAL_TRANSACTION_RECONCILE_ONLY');
      await this.reconcile(options.read);
      if (this.document.records.some(record => record.status !== 'confirmed' && record.status !== 'reverted')) fail('UNRESOLVED_TRANSACTION');
      const partial = frozenRequest(clone(options.request), options.address, options.kind, this.document.chainId);
      if (options.kind === 'funding') {
        if (partial.from !== address(this.document.rootAccount) || !options.fundingAllowlist
          || options.fundingAllowlist[partial.to] !== partial.value) fail('FUNDING_NOT_ALLOWLISTED');
        if (this.document.records.some(record => record.kind === 'funding' && record.plan.to === partial.to)) fail('RECIPIENT_ALREADY_FUNDED');
      }
      const [nonceValue, latestNonceValue, balanceValue] = await Promise.all([
        options.read({ method: 'eth_getTransactionCount', params: [partial.from, 'pending'] }),
        options.read({ method: 'eth_getTransactionCount', params: [partial.from, 'latest'] }),
        options.read({ method: 'eth_getBalance', params: [partial.from, 'pending'] }),
      ]);
      const nonce = quantity(nonceValue), balance = quantity(balanceValue);
      if (nonce !== quantity(latestNonceValue)) fail('ACCOUNT_HAS_PENDING_TRANSACTION');
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) fail('UNSAFE_NONCE');
      if (this.document.records.some(record => record.plan.from === partial.from && record.plan.nonce === Number(nonce))) fail('NONCE_ALREADY_USED');
      const plan: FrozenPlan = { ...partial, nonce: Number(nonce) }, maximum = maximumCost(plan);
      if (charged(this.document) + maximum > decimal(this.document.limitWei)) fail('APPROVED_BUDGET_EXCEEDED');
      if (balance < maximum) fail('INSUFFICIENT_TEST_GLM');
      const record: BudgetRecord = { id: options.id, kind: options.kind, plan, maximumCostWei: maximum.toString(),
        status: 'reserved', signedTransaction: null, transactionHash: null, receipt: null };
      this.document.records.push(record);
      await this.save(); // Reservation is durable before loading a secret or signing.
      const account = await options.loadAccount();
      if (address(account.address) !== plan.from) fail('SIGNER_ADDRESS_MISMATCH');
      const raw = bytes(await account.signTransaction({ chainId: plan.chainId, to: plan.to as Hex, data: plan.data,
        value: decimal(plan.value), nonce: plan.nonce, gas: decimal(plan.gas), maxFeePerGas: decimal(plan.maxFeePerGas),
        maxPriorityFeePerGas: decimal(plan.maxPriorityFeePerGas), type: 'eip1559' }));
      await authenticateRaw(raw, plan);
      record.signedTransaction = raw; record.transactionHash = keccak256(raw); record.status = 'admitted';
      await this.save(); // A failure here NEVER forwards; the reservation remains terminal for this ID.
      const returned = await options.sendRaw(raw); // The only raw forward; no retry/replacement path exists.
      if (hash(returned) !== record.transactionHash) fail('RPC_RETURNED_DIFFERENT_HASH');
      record.status = 'submitted'; await this.save();
      return record.transactionHash;
    });
  }
}

export interface Admission { operationId: string; stepId: string; request: NativeTransactionRequest }
export function createGuardedAccountProvider(options: {
  address: string; read: ReadRpc; sendRaw: SendRaw; loadAccount: LoadAccount; ledger: BudgetLedger;
  resolveAdmission(request: NativeTransactionRequest): Admission | Promise<Admission>; broadcast?: boolean;
}): InjectedWalletProvider {
  const expectedAddress = address(options.address);
  return {
    async request(args) {
      if (args.method === 'eth_accounts') return [expectedAddress];
      if (args.method === 'eth_chainId') return hex(BigInt(LIVE_CHAIN_ID));
      if (args.method !== 'eth_sendTransaction') return fail('WALLET_METHOD_BLOCKED');
      if (options.broadcast !== true) return fail('BROADCAST_NOT_ENABLED');
      if (args.params?.length !== 1) return fail('INVALID_SEND_PARAMS');
      const request = clone(args.params[0]) as NativeTransactionRequest;
      frozenRequest(request, expectedAddress, 'native', LIVE_CHAIN_ID);
      const admitted = await options.resolveAdmission(clone(request));
      if (!admitted.operationId || !admitted.stepId || !same(admitted.request, request)) return fail('ADMISSION_REQUEST_MISMATCH');
      return options.ledger.submit({ id: `${admitted.operationId}:${admitted.stepId}`, kind: 'native', address: expectedAddress,
        request, read: options.read, sendRaw: options.sendRaw, loadAccount: options.loadAccount, broadcast: true });
    },
  };
}

export async function submitFunding(options: {
  id: string; from: string; to: string; amountWei: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
  allowedRecipients: Readonly<Record<string, string>>; read: ReadRpc; sendRaw: SendRaw; loadAccount: LoadAccount;
  ledger: BudgetLedger; broadcast?: boolean;
}): Promise<Hex> {
  const allowlist: Record<string, string> = {};
  for (const [recipient, amount] of Object.entries(options.allowedRecipients)) allowlist[address(recipient)] = decimal(amount).toString();
  return options.ledger.submit({ id: options.id, kind: 'funding', address: options.from, broadcast: options.broadcast,
    request: { from: address(options.from), to: address(options.to), data: '0x', value: hex(decimal(options.amountWei)),
      chainId: hex(BigInt(LIVE_CHAIN_ID)), gas: hex(decimal(options.gas)), maxFeePerGas: hex(decimal(options.maxFeePerGas)),
      maxPriorityFeePerGas: hex(decimal(options.maxPriorityFeePerGas)) },
    fundingAllowlist: allowlist, read: options.read, sendRaw: options.sendRaw, loadAccount: options.loadAccount,
  });
}
