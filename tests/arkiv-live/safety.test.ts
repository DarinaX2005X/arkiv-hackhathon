import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, parseTransaction, serializeTransaction, toHex } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { NativeTransactionRequest } from '../../src/data/wallet/types';
import {
  accountLockPort, atomicWriteJson, BudgetLedger, createBudgetDocument, createFileStorage,
  createGuardedAccountProvider, LIVE_CHAIN_ID, LIVE_LIMIT_WEI, LiveSafetyError, PRIOR_SPEND_WEI,
  readJson, submitFunding, withRunLock,
} from './safety';
import type { BudgetDocument, ReadRpc, SendRaw } from './safety';

const native = '0x4400000000000000000000000000000000000044';
const blockHash = `0x${'ab'.repeat(32)}` as Hex;
const matches = (code: string) => (error: unknown) => error instanceof LiveSafetyError && error.code === code;
const copy = <T>(value: T): T => structuredClone(value);

function fixture(options: { persist?: (document: BudgetDocument) => void | Promise<void>; limitWei?: string } = {}) {
  // Ephemeral synthetic test account only. No local wallet file, network, or UI is used.
  const account = privateKeyToAccount(generatePrivateKey());
  const order: string[] = [];
  let nonce = 0n, pendingNonce: bigint | undefined, reads = 0, keyLoads = 0, sends = 0;
  let balance = 10n ** 20n;
  const mined = new Map<string, { receipt: Record<string, unknown>; transaction: Record<string, unknown>; block: Record<string, unknown> }>();
  const read: ReadRpc = async args => {
    reads++;
    if (args.method === 'eth_chainId') return toHex(LIVE_CHAIN_ID);
    if (args.method === 'eth_getTransactionCount') return toHex(args.params?.[1] === 'pending' ? pendingNonce ?? nonce : nonce);
    if (args.method === 'eth_getBalance') return toHex(balance);
    if (args.method === 'eth_getTransactionReceipt') return mined.get(String(args.params?.[0]))?.receipt ?? null;
    if (args.method === 'eth_getTransactionByHash') return mined.get(String(args.params?.[0]))?.transaction ?? null;
    if (args.method === 'eth_getBlockByNumber') return [...mined.values()].find(value => value.block.number === args.params?.[0])?.block ?? null;
    throw Error(`Unexpected synthetic RPC method ${args.method}`);
  };
  const saved: BudgetDocument[] = [];
  const ledger = new BudgetLedger(createBudgetDocument({ rootAccount: account.address, limitWei: options.limitWei }), async document => {
    const state = document.records.at(-1)?.status ?? 'empty'; order.push(`persist:${state}`);
    await options.persist?.(document); saved.push(copy(document));
  });
  const loadAccount = async () => { keyLoads++; order.push('load'); return account; };
  const sendRaw: SendRaw = async raw => { sends++; order.push('send'); return keccak256(raw); };
  const request: NativeTransactionRequest = {
    from: account.address.toLowerCase() as Hex, to: native, data: '0x1234', value: '0x0', chainId: toHex(LIVE_CHAIN_ID),
    gas: toHex(100_000n), maxFeePerGas: toHex(2_000_000_000n), maxPriorityFeePerGas: '0x1',
  };
  const submit = (id = 'operation:step', extra = {}) => ledger.submit({ id, kind: 'native', address: account.address,
    request, read, sendRaw, loadAccount, broadcast: true, ...extra });
  const mine = (status: '0x0' | '0x1' = '0x1', recordIndex = 0) => {
    const record = ledger.snapshot().records[recordIndex]!;
    const plan = record.plan, txHash = record.transactionHash!;
    const number = toHex(100n + BigInt(recordIndex));
    const receipt: Record<string, unknown> = { transactionHash: txHash, from: plan.from, to: plan.to,
      type: '0x2', blockHash, blockNumber: number, transactionIndex: '0x0', status, gasUsed: toHex(21_000n), effectiveGasPrice: toHex(1_000_000_000n) };
    const transaction: Record<string, unknown> = { hash: txHash, from: plan.from, to: plan.to, input: plan.data,
      value: toHex(BigInt(plan.value)), nonce: toHex(plan.nonce), gas: toHex(BigInt(plan.gas)), type: '0x2', chainId: toHex(plan.chainId),
      maxFeePerGas: toHex(BigInt(plan.maxFeePerGas)), maxPriorityFeePerGas: toHex(BigInt(plan.maxPriorityFeePerGas)),
      blockHash, blockNumber: number, transactionIndex: '0x0', accessList: [] };
    const block: Record<string, unknown> = { hash: blockHash, number, transactions: [txHash] };
    mined.set(txHash, { receipt, transaction, block }); nonce = BigInt(plan.nonce + 1);
    return { receipt, transaction, block, txHash };
  };
  return { account, order, ledger, request, read, sendRaw, loadAccount, submit, mine, mined, saved,
    counters: () => ({ reads, keyLoads, sends }), setNonce: (value: bigint) => { nonce = value; },
    setPending: (value: bigint) => { pendingNonce = value; }, setBalance: (value: bigint) => { balance = value; } };
}

test('constructing safety components and default provider never reads keys, RPC, signs or sends', async () => {
  const f = fixture();
  const provider = createGuardedAccountProvider({ address: f.account.address, read: f.read, sendRaw: f.sendRaw,
    loadAccount: f.loadAccount, ledger: f.ledger, resolveAdmission: request => ({ operationId: 'op', stepId: 'step', request }) });
  assert.deepEqual(await provider.request({ method: 'eth_accounts' }), [f.account.address.toLowerCase()]);
  assert.equal(await provider.request({ method: 'eth_chainId' }), toHex(LIVE_CHAIN_ID));
  await assert.rejects(provider.request({ method: 'eth_sendTransaction', params: [f.request] }), matches('BROADCAST_NOT_ENABLED'));
  await assert.rejects(f.submit('disabled', { broadcast: false }), matches('BROADCAST_NOT_ENABLED'));
  assert.deepEqual(f.counters(), { reads: 0, keyLoads: 0, sends: 0 });
  assert.deepEqual(f.ledger.snapshot().records, []);
});

test('reservation is durable before key load and exact signed bytes/hash before the sole raw forward', async () => {
  const f = fixture();
  const result = await f.submit();
  assert.deepEqual(f.order, ['persist:reserved', 'load', 'persist:admitted', 'send', 'persist:submitted']);
  assert.equal(f.saved[1]?.records[0]?.transactionHash, result);
  assert.equal(keccak256(f.saved[1]!.records[0]!.signedTransaction!), result);
  assert.equal(f.ledger.publicSummary().chargedWei, (BigInt(PRIOR_SPEND_WEI) + 100_000n * 2_000_000_000n).toString());
  const publicJson = JSON.stringify(f.ledger.publicSummary());
  assert.ok(!publicJson.includes(f.ledger.snapshot().records[0]!.signedTransaction!));
  assert.ok(!publicJson.includes('signedTransaction'));
  await assert.rejects(f.submit(), matches('ORIGINAL_TRANSACTION_RECONCILE_ONLY'));
  assert.equal(f.counters().sends, 1);
});

async function assertReloadRequired(f: ReturnType<typeof fixture>): Promise<void> {
  const before = f.counters();
  assert.throws(() => f.ledger.snapshot(), matches('LEDGER_RELOAD_REQUIRED'));
  assert.throws(() => f.ledger.publicSummary(), matches('LEDGER_RELOAD_REQUIRED'));
  await assert.rejects(f.ledger.reconcileAll(f.read), matches('LEDGER_RELOAD_REQUIRED'));
  await assert.rejects(f.submit(), matches('LEDGER_RELOAD_REQUIRED'));
  await assert.rejects(f.submit('different'), matches('LEDGER_RELOAD_REQUIRED'));
  assert.deepEqual(f.counters(), before);
}

async function recoveryFixture(persist: (document: BudgetDocument) => void = () => undefined) {
  const f = fixture(); const expectedHash = await f.submit();
  const original = f.saved[1]!.records[0]!;
  const saved: BudgetDocument[] = [];
  const ledger = new BudgetLedger(f.saved[0]!, document => { persist(document); saved.push(copy(document)); });
  let sends = 0, keyLoads = 0;
  const recover = (extra = {}) => ledger.recoverReserved({ id: original.id, expectedHash, address: f.account.address,
    request: f.request, read: f.read, broadcast: true, loadAccount: async () => { keyLoads++; return f.account; },
    sendRaw: async raw => { sends++; assert.equal(raw, original.signedTransaction); return keccak256(raw); }, ...extra });
  return { ...f, ledger, expectedHash, original, saved, recover, recoveryCounters: () => ({ sends, keyLoads }) };
}

test('exact original recovery requires broadcast opt-in before reads or key access', async () => {
  const f = await recoveryFixture(); const before = f.counters();
  await assert.rejects(f.recover({ broadcast: false }), matches('BROADCAST_NOT_ENABLED'));
  assert.deepEqual(f.counters(), before);
  assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 0 });
});

test('exact original recovery forwards one identical transaction and never creates another reservation', async () => {
  const f = await recoveryFixture(); const before = f.ledger.snapshot(); const maximum = f.ledger.publicSummary().chargedWei;
  assert.deepEqual(await f.recover(), { transactionHash: f.expectedHash, status: 'submitted', forwarded: true });
  const after = f.ledger.snapshot();
  assert.equal(after.records.length, before.records.length);
  assert.deepEqual(after.records[0]!.plan, before.records[0]!.plan);
  assert.equal(after.records[0]!.id, before.records[0]!.id);
  assert.equal(f.ledger.publicSummary().chargedWei, maximum);
  assert.equal(f.saved[0]?.records[0]?.status, 'admitted');
  assert.equal(f.saved[0]?.records[0]?.signedTransaction, f.original.signedTransaction);
  assert.deepEqual(await f.recover(), { transactionHash: f.expectedHash, status: 'unresolved', forwarded: false });
  assert.deepEqual(f.recoveryCounters(), { sends: 1, keyLoads: 1 });
});

test('recovery rejects a different hash without replacing the reservation', async () => {
  const f = await recoveryFixture(); const before = f.ledger.snapshot();
  await assert.rejects(f.recover({ expectedHash: `0x${'11'.repeat(32)}` }), matches('RECOVERY_HASH_MISMATCH'));
  assert.deepEqual(f.ledger.snapshot(), before);
  assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 1 });
  assert.equal(f.saved.length, 0);
});

test('recovery rejects admission fee or calldata changes before signing', async () => {
  for (const change of [{ gas: '0x1' }, { data: '0xabcd' }, { maxFeePerGas: '0x1' }]) {
    const f = await recoveryFixture();
    await assert.rejects(f.recover({ request: { ...f.request, ...change } }), matches('RECOVERY_ADMISSION_MISMATCH'));
    assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 0 });
  }
});

test('recovery rejects spent and pending nonce mismatches before signing', async () => {
  for (const pendingOnly of [false, true]) {
    const f = await recoveryFixture(); const before = f.ledger.snapshot();
    if (pendingOnly) f.setPending(1n); else f.setNonce(1n);
    await assert.rejects(f.recover(), matches('RECOVERY_NONCE_MISMATCH'));
    assert.deepEqual(f.ledger.snapshot(), before);
    assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 0 });
  }
});

test('recovery persistence failure cannot forward or expose reconstructed bytes', async () => {
  const f = await recoveryFixture(() => { throw Error('synthetic fsync failure'); });
  await assert.rejects(f.recover(), matches('LEDGER_PERSISTENCE_FAILED'));
  assert.throws(() => f.ledger.snapshot(), matches('LEDGER_RELOAD_REQUIRED'));
  assert.equal(f.saved.length, 0);
  assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 1 });
});

test('already mined original recovery restores signed bytes and authenticates receipt without forwarding', async () => {
  const f = await recoveryFixture(); f.mine();
  assert.deepEqual(await f.recover(), { transactionHash: f.expectedHash, status: 'confirmed', forwarded: false });
  assert.equal(f.ledger.snapshot().records[0]?.signedTransaction, f.original.signedTransaction);
  assert.equal(f.ledger.snapshot().records[0]?.receipt?.status, 'success');
  assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 1 });
  // A subsequent invocation reconciles the same durable signed record without loading a signer.
  assert.deepEqual(await f.recover(), { transactionHash: f.expectedHash, status: 'confirmed', forwarded: false });
  assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 1 });
});

test('known pending original recovery never forwards even with the original account nonce', async () => {
  const f = await recoveryFixture(); const mined = f.mine(); f.setNonce(0n);
  mined.transaction.blockHash = null; mined.transaction.blockNumber = null; mined.transaction.transactionIndex = null;
  const read: ReadRpc = args => args.method === 'eth_getTransactionReceipt' ? Promise.resolve(null) : f.read(args);
  assert.deepEqual(await f.recover({ read }), { transactionHash: f.expectedHash, status: 'pending', forwarded: false });
  assert.equal(f.ledger.snapshot().records[0]?.status, 'admitted');
  assert.deepEqual(f.recoveryCounters(), { sends: 0, keyLoads: 1 });
});

test('a transaction appearing while recovery signs is reconciled without forwarding', async () => {
  const f = await recoveryFixture();
  const result = await f.recover({ loadAccount: async () => { f.mine(); return f.account; } });
  assert.deepEqual(result, { transactionHash: f.expectedHash, status: 'confirmed', forwarded: false });
  assert.equal(f.recoveryCounters().sends, 0);
});

test('reservation persistence failure does not load keys or forward and requires a fresh ledger', async () => {
  const f = fixture({ persist: () => { throw Error('synthetic fsync failure'); } });
  await assert.rejects(f.submit(), matches('LEDGER_PERSISTENCE_FAILED'));
  assert.deepEqual(f.counters(), { reads: 4, keyLoads: 0, sends: 0 });
  await assertReloadRequired(f);
});

test('signed-byte persistence failure never forwards or exports a nondurable hash', async () => {
  const f = fixture({ persist: document => { if (document.records[0]?.status === 'admitted') throw Error('synthetic fsync failure'); } });
  await assert.rejects(f.submit(), matches('LEDGER_PERSISTENCE_FAILED'));
  assert.equal(f.counters().sends, 0);
  assert.equal(f.saved.at(-1)?.records[0]?.status, 'reserved');
  assert.equal(f.saved.at(-1)?.records[0]?.transactionHash, null);
  await assertReloadRequired(f);
});

test('failure after persistence also requires reload and preserves the durable original hash', async () => {
  let durable!: BudgetDocument;
  const f = fixture({ persist: document => {
    durable = copy(document);
    if (document.records[0]?.status === 'admitted') throw Error('synthetic post-rename failure');
  } });
  await assert.rejects(f.submit(), matches('LEDGER_PERSISTENCE_FAILED'));
  await assertReloadRequired(f);
  const reloaded = new BudgetLedger(durable, () => undefined);
  await reloaded.reconcileAll(f.read);
  assert.equal(reloaded.snapshot().records[0]?.status, 'admitted');
  assert.ok(reloaded.snapshot().records[0]?.transactionHash);
  await assert.rejects(reloaded.submit({ id: 'operation:step', kind: 'native', address: f.account.address,
    request: f.request, read: f.read, sendRaw: f.sendRaw, loadAccount: f.loadAccount, broadcast: true }), matches('ORIGINAL_TRANSACTION_RECONCILE_ONLY'));
  assert.equal(f.counters().sends, 0);
  assert.equal(f.counters().keyLoads, 1);
});

test('submitted persistence failure retains durable admission and never forwards again', async () => {
  const f = fixture({ persist: document => { if (document.records[0]?.status === 'submitted') throw Error('synthetic fsync failure'); } });
  await assert.rejects(f.submit(), matches('LEDGER_PERSISTENCE_FAILED'));
  assert.equal(f.saved.at(-1)?.records[0]?.status, 'admitted');
  assert.equal(f.counters().sends, 1);
  await assertReloadRequired(f);
  const reloaded = new BudgetLedger(f.saved.at(-1)!, () => undefined);
  await reloaded.reconcileAll(f.read);
  assert.equal(reloaded.snapshot().records[0]?.transactionHash, f.saved.at(-1)?.records[0]?.transactionHash);
  assert.equal(f.counters().sends, 1);
});

test('receipt persistence failure cannot export a lower charge before reload', async () => {
  const f = fixture({ persist: document => { if (document.records[0]?.status === 'confirmed') throw Error('synthetic fsync failure'); } });
  await f.submit(); f.mine();
  const maximum = f.ledger.publicSummary().chargedWei;
  await assert.rejects(f.ledger.reconcileAll(f.read), matches('LEDGER_PERSISTENCE_FAILED'));
  await assertReloadRequired(f);
  const reloaded = new BudgetLedger(f.saved.at(-1)!, () => undefined);
  assert.equal(reloaded.publicSummary().chargedWei, maximum);
  await reloaded.reconcileAll(f.read);
  assert.equal(reloaded.snapshot().records[0]?.status, 'confirmed');
  assert.equal(f.counters().sends, 1);
});

test('reorg persistence failure requires reload before any other transaction', async () => {
  let rejectSave = false;
  const f = fixture({ persist: () => { if (rejectSave) throw Error('synthetic fsync failure'); } });
  await f.submit(); const mined = f.mine(); await f.ledger.reconcileAll(f.read);
  f.mined.delete(mined.txHash); rejectSave = true;
  await assert.rejects(f.submit('after-reorg'), matches('LEDGER_PERSISTENCE_FAILED'));
  await assertReloadRequired(f);
  const reloaded = new BudgetLedger(f.saved.at(-1)!, () => undefined);
  await reloaded.reconcileAll(f.read);
  assert.equal(reloaded.snapshot().records[0]?.status, 'admitted');
  assert.equal(reloaded.snapshot().records[0]?.receipt, null);
  assert.equal(f.counters().sends, 1);
});

test('lost response never signs or forwards again; the original hash later authenticates', async () => {
  const f = fixture(); let forwards = 0;
  await assert.rejects(f.submit('lost', { sendRaw: async () => { forwards++; throw Error('synthetic timeout'); } }), /synthetic timeout/);
  const before = f.ledger.snapshot().records[0]!;
  assert.equal(before.status, 'admitted'); assert.ok(before.transactionHash); assert.ok(before.signedTransaction);
  await assert.rejects(f.submit('lost'), matches('ORIGINAL_TRANSACTION_RECONCILE_ONLY'));
  await assert.rejects(f.submit('new'), matches('UNRESOLVED_TRANSACTION'));
  assert.equal(forwards, 1); assert.equal(f.counters().keyLoads, 1);
  f.mine(); await f.ledger.reconcileAll(f.read);
  assert.equal(f.ledger.snapshot().records[0]?.status, 'confirmed');
  assert.equal(f.ledger.snapshot().records[0]?.transactionHash, before.transactionHash);
  assert.equal(f.ledger.publicSummary().chargedWei, (BigInt(PRIOR_SPEND_WEI) + 21_000n * 1_000_000_000n).toString());
});

test('a different returned hash leaves the original signed transaction reserved', async () => {
  const f = fixture();
  await assert.rejects(f.submit('hash', { sendRaw: async () => `0x${'11'.repeat(32)}` }), matches('RPC_RETURNED_DIFFERENT_HASH'));
  assert.equal(f.ledger.snapshot().records[0]?.status, 'admitted');
  await assert.rejects(f.submit('other'), matches('UNRESOLVED_TRANSACTION'));
});

test('provider blocks every signing/send path except exact admitted eth_sendTransaction', async () => {
  const f = fixture();
  const provider = createGuardedAccountProvider({ address: f.account.address, read: f.read, sendRaw: f.sendRaw,
    loadAccount: f.loadAccount, ledger: f.ledger, broadcast: true,
    resolveAdmission: request => ({ operationId: 'op', stepId: 'step', request }) });
  for (const method of ['eth_sendRawTransaction', 'wallet_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData_v4', 'eth_fillTransaction', 'debug_traceTransaction']) {
    await assert.rejects(provider.request({ method, params: [f.request] }), matches('WALLET_METHOD_BLOCKED'));
  }
  const txHash = await provider.request({ method: 'eth_sendTransaction', params: [f.request] });
  assert.equal(txHash, f.ledger.snapshot().records[0]?.transactionHash);
  assert.equal(f.ledger.snapshot().records[0]?.id, 'op:step'); assert.equal(f.counters().sends, 1);
});

test('provider rejects a frozen app admission that differs from the forwarded request', async () => {
  const f = fixture();
  const provider = createGuardedAccountProvider({ address: f.account.address, read: f.read, sendRaw: f.sendRaw,
    loadAccount: f.loadAccount, ledger: f.ledger, broadcast: true,
    resolveAdmission: request => ({ operationId: 'op', stepId: 'step', request: { ...request, data: '0xabcd' } }) });
  await assert.rejects(provider.request({ method: 'eth_sendTransaction', params: [f.request] }), matches('ADMISSION_REQUEST_MISMATCH'));
  assert.deepEqual(f.counters(), { reads: 0, keyLoads: 0, sends: 0 });
});

for (const [name, mutation] of Object.entries({
  'native recipient': { to: `0x${'12'.repeat(20)}` }, 'native value': { value: '0x1' },
  'wrong chain': { chainId: '0x1' }, 'excess gas': { gas: toHex(2_000_001) },
  'excess fee': { maxFeePerGas: toHex(2_000_000_001n) }, 'priority above fee': { maxPriorityFeePerGas: toHex(3_000_000_000n) },
  'missing gas': { gas: undefined }, 'extra nonce': { nonce: '0x0' }, 'legacy fee': { gasPrice: '0x1' },
})) {
  test(`rejects ${name} before reading a signing key`, async () => {
    const f = fixture();
    await assert.rejects(f.submit(name, { request: { ...f.request, ...mutation } }));
    assert.equal(f.counters().keyLoads, 0); assert.equal(f.counters().sends, 0);
  });
}

test('aggregate ceiling includes prior spend and maximum fee reservation before signing', async () => {
  const f = fixture({ limitWei: (BigInt(PRIOR_SPEND_WEI) + 100_000n * 2_000_000_000n - 1n).toString() });
  await assert.rejects(f.submit(), matches('APPROVED_BUDGET_EXCEEDED'));
  assert.equal(f.counters().keyLoads, 0); assert.equal(f.counters().sends, 0);
  assert.throws(() => createBudgetDocument({ rootAccount: f.account.address, limitWei: (BigInt(LIVE_LIMIT_WEI) + 1n).toString() }), matches('INVALID_BUDGET_LIMIT'));
  assert.throws(() => createBudgetDocument({ rootAccount: f.account.address, priorSpendWei: '0' }), matches('INVALID_BUDGET_LIMIT'));
});

test('balance and existing pending nonce fail before key load', async () => {
  const f = fixture(); f.setBalance(1n);
  await assert.rejects(f.submit(), matches('INSUFFICIENT_TEST_GLM'));
  f.setBalance(10n ** 20n); f.setPending(1n);
  await assert.rejects(f.submit(), matches('ACCOUNT_HAS_PENDING_TRANSACTION'));
  assert.equal(f.counters().keyLoads, 0); assert.equal(f.counters().sends, 0);
});

test('wrong signer account and signed wrong calldata never forward', async () => {
  const wrong = privateKeyToAccount(generatePrivateKey());
  const f = fixture();
  await assert.rejects(f.submit('address', { loadAccount: async () => wrong }), matches('SIGNER_ADDRESS_MISMATCH'));
  assert.equal(f.counters().sends, 0);
  const g = fixture();
  const altered = { ...g.account, signTransaction: async (args: Parameters<PrivateKeyAccount['signTransaction']>[0]) =>
    g.account.signTransaction({ ...args, data: '0xffff' } as Parameters<PrivateKeyAccount['signTransaction']>[0]) } as PrivateKeyAccount;
  await assert.rejects(g.submit('bytes', { loadAccount: async () => altered }), matches('SIGNED_TRANSACTION_MISMATCH'));
  assert.equal(g.counters().sends, 0);
});

test('zero priority fee is canonical and accepted', async () => {
  const f = fixture();
  await f.submit('zero', { request: { ...f.request, maxPriorityFeePerGas: '0x0' } });
  assert.equal(f.counters().sends, 1);
});

test('unsigned and high-S transactions cannot pass the signed-byte gate', async () => {
  for (const kind of ['unsigned', 'highS'] as const) {
    const f = fixture();
    const altered = { ...f.account, signTransaction: async (args: Parameters<PrivateKeyAccount['signTransaction']>[0]) => {
      if (kind === 'unsigned') return serializeTransaction(args);
      const signed = await f.account.signTransaction(args), parsed = parseTransaction(signed);
      const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      return serializeTransaction({ ...parsed, s: toHex(curveOrder - BigInt(parsed.s!), { size: 32 }), yParity: parsed.yParity === 0 ? 1 : 0 });
    } } as PrivateKeyAccount;
    await assert.rejects(f.submit(kind, { loadAccount: async () => altered }), matches('SIGNED_TRANSACTION_MISMATCH'));
    assert.equal(f.counters().sends, 0);
  }
});

for (const [name, mutate] of Object.entries({
  'receipt hash': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.receipt.transactionHash = `0x${'12'.repeat(32)}`; },
  'receipt sender': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.receipt.from = native; },
  'receipt gas': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.receipt.gasUsed = toHex(100_001); },
  'receipt fee': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.receipt.effectiveGasPrice = toHex(2_000_000_001n); },
  'transaction input': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.transaction.input = '0xabcd'; },
  'transaction nonce': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.transaction.nonce = '0x1'; },
  'transaction fee': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.transaction.maxFeePerGas = '0x1'; },
  'transaction index': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.transaction.transactionIndex = '0x1'; },
  'canonical block hash': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.block.hash = `0x${'12'.repeat(32)}`; },
  'canonical block number': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.block.number = '0x65'; },
  'canonical membership': (value: ReturnType<ReturnType<typeof fixture>['mine']>) => { value.block.transactions = []; },
})) {
  test(`invalid ${name} cannot release the maximum reservation`, async () => {
    const f = fixture(); await f.submit(); const before = f.ledger.publicSummary().chargedWei;
    mutate(f.mine()); await assert.rejects(f.ledger.reconcileAll(f.read));
    assert.equal(f.ledger.publicSummary().chargedWei, before);
    assert.equal(f.ledger.snapshot().records[0]?.receipt, null);
  });
}

test('a canonical revert is terminal for its ID but a distinct explicit attempt can spend remaining budget', async () => {
  const f = fixture(); await f.submit('reverted'); f.mine('0x0'); await f.ledger.reconcileAll(f.read);
  assert.equal(f.ledger.snapshot().records[0]?.status, 'reverted');
  await assert.rejects(f.submit('reverted'), matches('ORIGINAL_TRANSACTION_RECONCILE_ONLY'));
  await f.submit('new-explicit-attempt'); assert.equal(f.counters().sends, 2);
  assert.equal(f.ledger.snapshot().records[1]?.plan.nonce, 1);
});

test('a previously confirmed receipt disappearing restores maximum reservation and blocks any new send', async () => {
  const f = fixture(); await f.submit(); const maximum = f.ledger.publicSummary().chargedWei;
  const mined = f.mine(); await f.ledger.reconcileAll(f.read); f.mined.delete(mined.txHash);
  await assert.rejects(f.submit('after-reorg'), matches('UNRESOLVED_TRANSACTION'));
  assert.equal(f.ledger.publicSummary().chargedWei, maximum); assert.equal(f.counters().sends, 1);
});

test('stale nonce cannot be reused after a verified earlier transaction', async () => {
  const f = fixture(); await f.submit(); f.mine(); await f.ledger.reconcileAll(f.read); f.setNonce(0n);
  await assert.rejects(f.submit('second'), matches('NONCE_ALREADY_USED')); assert.equal(f.counters().sends, 1);
});

async function pooledFixture(count = 9) {
  const fixtures = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const f = fixture(); await f.submit(`pool:${index}`); const mined = f.mine();
    const number = toHex(100 + index);
    mined.receipt.blockNumber = number; mined.transaction.blockNumber = number; mined.block.number = number;
    return { f, mined };
  }));
  const document = createBudgetDocument({ rootAccount: fixtures[0]!.f.account.address });
  document.records = fixtures.map(({ f }) => f.ledger.snapshot().records[0]!);
  const saved: BudgetDocument[] = [];
  const ledger = new BudgetLedger(document, next => { saved.push(copy(next)); });
  const read: ReadRpc = async args => {
    if (args.method === 'eth_chainId') return toHex(LIVE_CHAIN_ID);
    const found = fixtures.find(({ mined }) => args.method === 'eth_getBlockByNumber'
      ? mined.block.number === args.params?.[0] : mined.txHash === args.params?.[0]);
    if (!found) throw Error('Unexpected pooled fixture lookup');
    if (args.method === 'eth_getTransactionReceipt') return found.mined.receipt;
    if (args.method === 'eth_getTransactionByHash') return found.mined.transaction;
    if (args.method === 'eth_getBlockByNumber') return found.mined.block;
    throw Error('Unexpected pooled fixture method');
  };
  return { fixtures, ledger, saved, read };
}

test('reconciliation uses four record workers and at most four RPC calls including nested pairs', async () => {
  const f = await pooledFixture(); let active = 0, peak = 0, receipts = 0;
  const perRecord = new Map<string, number>(); const activeRecords = new Set<string>(); let peakRecords = 0;
  const read: ReadRpc = async args => {
    if (args.method === 'eth_chainId') return f.read(args);
    const item = f.fixtures.find(({ mined }) => args.method === 'eth_getBlockByNumber'
      ? mined.block.number === args.params?.[0] : mined.txHash === args.params?.[0])!;
    if (args.method === 'eth_getTransactionReceipt') {
      receipts++; activeRecords.add(item.mined.txHash); peakRecords = Math.max(peakRecords, activeRecords.size);
    }
    active++; peak = Math.max(peak, active);
    try { await new Promise<void>(resolve => setImmediate(resolve)); return await f.read(args); }
    finally {
      active--;
      if (args.method !== 'eth_getTransactionReceipt') {
        const completed = (perRecord.get(item.mined.txHash) ?? 0) + 1; perRecord.set(item.mined.txHash, completed);
        if (completed === 2) activeRecords.delete(item.mined.txHash);
      }
    }
  };
  await f.ledger.reconcileAll(read);
  assert.equal(peak, 4); assert.equal(peakRecords, 4); assert.equal(active, 0); assert.equal(receipts, 9);
  assert.ok(f.ledger.snapshot().records.every(record => record.status === 'confirmed'));
  // Confirmed records still get all three reads on the next invocation.
  await f.ledger.reconcileAll(read); assert.equal(receipts, 18);
});

test('pooled read failure drains in-flight reads and cannot partly mutate, persist, sign or send', async () => {
  const f = await pooledFixture(); const before = f.ledger.snapshot();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  let blocked = false, returned = false, loads = 0, sends = 0;
  const read: ReadRpc = async args => {
    if (args.method === 'eth_getBlockByNumber' && args.params?.[0] === '0x64') { blocked = true; reached(); await gate; }
    if (args.method === 'eth_getTransactionByHash' && args.params?.[0] === f.fixtures[1]!.mined.txHash) {
      // A different record's second lookup fails while the first block read remains in flight.
      await entered; throw Error('synthetic pooled read failure');
    }
    return f.read(args);
  };
  const first = f.fixtures[0]!.f;
  const pending = f.ledger.submit({ id: 'after-pool', kind: 'native', address: first.account.address, request: first.request,
    read, loadAccount: async () => { loads++; return first.account; }, sendRaw: async raw => { sends++; return keccak256(raw); }, broadcast: true })
    .finally(() => { returned = true; });
  // Attach the assertion immediately so the deliberate rejection is always handled.
  const rejected = assert.rejects(pending, /synthetic pooled read failure/);
  await entered; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(blocked, true); assert.equal(returned, false); assert.equal(f.saved.length, 0);
  assert.throws(() => f.ledger.snapshot(), matches('LEDGER_BUSY'));
  release(); await rejected;
  assert.deepEqual(f.ledger.snapshot(), before); assert.equal(f.saved.length, 0);
  assert.equal(loads, 0); assert.equal(sends, 0);
});

test('pooled authentication failure preserves every original receipt and reservation', async () => {
  const f = await pooledFixture(5); const before = f.ledger.snapshot();
  f.fixtures[4]!.mined.block.hash = `0x${'12'.repeat(32)}`;
  await assert.rejects(f.ledger.reconcileAll(f.read), matches('NONCANONICAL_RECEIPT'));
  assert.deepEqual(f.ledger.snapshot(), before); assert.equal(f.saved.length, 0);
});

test('funding needs explicit recipient and amount and charges successful principal plus gas', async () => {
  const f = fixture(), recipient = privateKeyToAccount(generatePrivateKey()).address, amount = '5000000000000000';
  const base = { id: 'fund', from: f.account.address, to: recipient, amountWei: amount, gas: '21000',
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1', read: f.read, sendRaw: f.sendRaw, loadAccount: f.loadAccount,
    ledger: f.ledger, allowedRecipients: { [recipient]: amount } };
  await assert.rejects(submitFunding(base), matches('BROADCAST_NOT_ENABLED'));
  await assert.rejects(submitFunding({ ...base, broadcast: true, amountWei: '1' }), matches('FUNDING_NOT_ALLOWLISTED'));
  await submitFunding({ ...base, broadcast: true });
  assert.equal(f.ledger.snapshot().records[0]?.plan.data, '0x');
  assert.equal(f.ledger.publicSummary().chargedWei, (BigInt(PRIOR_SPEND_WEI) + BigInt(amount) + 21_000n * 2_000_000_000n).toString());
  f.mine(); await f.ledger.reconcileAll(f.read);
  assert.equal(f.ledger.publicSummary().chargedWei, (BigInt(PRIOR_SPEND_WEI) + BigInt(amount) + 21_000n * 1_000_000_000n).toString());
  await assert.rejects(submitFunding({ ...base, id: 'another-funding-id', broadcast: true }), matches('RECIPIENT_ALREADY_FUNDED'));
});

test('reverted funding charges verified gas without transferring principal', async () => {
  const f = fixture(), recipient = privateKeyToAccount(generatePrivateKey()).address, amount = '5000000000000000';
  await submitFunding({ id: 'fund', from: f.account.address, to: recipient, amountWei: amount, gas: '21000',
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1', read: f.read, sendRaw: f.sendRaw, loadAccount: f.loadAccount,
    ledger: f.ledger, allowedRecipients: { [recipient]: amount }, broadcast: true });
  f.mine('0x0'); await f.ledger.reconcileAll(f.read);
  assert.equal(f.ledger.publicSummary().chargedWei, (BigInt(PRIOR_SPEND_WEI) + 21_000n * 1_000_000_000n).toString());
});

test('budget load rejects malformed stored costs and clone boundaries preserve frozen data', async () => {
  const f = fixture(); await f.submit(); f.mine(); await f.ledger.reconcileAll(f.read);
  const document = f.ledger.snapshot(); document.records[0]!.receipt!.actualCostWei = '0';
  assert.throws(() => new BudgetLedger(document, () => undefined), matches('INVALID_RECEIPT_RECORD'));
  const snapshot = f.ledger.snapshot(); snapshot.records[0]!.plan.data = '0xabcd';
  assert.equal(f.ledger.snapshot().records[0]!.plan.data, '0x1234');
});

test('concurrent submissions on one ledger cannot race reservations', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
  const f = fixture({ persist: async document => { if (document.records[0]?.status === 'reserved') { reached(); await blocked; } } });
  const first = f.submit('first'); await entered;
  await assert.rejects(f.submit('second'), matches('LEDGER_BUSY'));
  assert.throws(() => f.ledger.snapshot(), matches('LEDGER_BUSY'));
  assert.throws(() => f.ledger.publicSummary(), matches('LEDGER_BUSY'));
  release(); await first; assert.equal(f.counters().sends, 1);
});

test('fsynced file adapter preserves corrupt/torn documents and never silently resets them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'partfolk-safety-test-')), path = join(directory, 'journal.json');
  try {
    assert.equal(readJson(path), null);
    atomicWriteJson(path, { value: 'before' }); assert.deepEqual(readJson(path), { value: 'before' });
    atomicWriteJson(path, { value: 'after' }); assert.deepEqual(readJson(path), { value: 'after' });
    const storage = createFileStorage(path);
    for (const corrupt of ['{', '{}', 'null\n', 'false\n', '0\n', '""\n', '[]\n', '{"version":2}\n']) {
      writeFileSync(path, corrupt);
      assert.throws(() => storage.setItem('journal', '{}'));
      assert.equal(readFileSync(path, 'utf8'), corrupt);
    }
    unlinkSync(path); storage.setItem('journal', '{"version":1}');
    assert.equal(storage.getItem('journal'), '{"version":1}');
    assert.throws(() => storage.setItem('other-key', '{}'), matches('INVALID_STORAGE_FILE'));
  } finally {
    // Delete only files in the unique test directory; no recursive path operation.
    for (const entry of readdirSync(directory)) unlinkSync(join(directory, entry));
    rmdirSync(directory);
  }
});

test('account mutex is helper-compatible and a second runner is rejected until release', async () => {
  const account = privateKeyToAccount(generatePrivateKey()).address;
  const digest = createHash('sha256').update(`${LIVE_CHAIN_ID}:${account.toLowerCase()}`).digest('hex');
  assert.equal(accountLockPort(account), 20_000 + parseInt(digest.slice(0, 8), 16) % 30_000);
  await withRunLock(account, async () => {
    await assert.rejects(withRunLock(account, async () => undefined), matches('LOCAL_SIGNER_COORDINATOR_BUSY'));
  });
  await withRunLock(account, async () => undefined);
});
