import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { NativeTransactionRequest } from '../../src/data/wallet/types';
import {
  BudgetLedger, createBudgetDocument, LIVE_CHAIN_ID, LiveSafetyError, PRIOR_SPEND_WEI,
} from './safety';
import type { BudgetDocument, BudgetRecord, ReadRpc, RecoverAdmissionOptions } from './safety';

const ROOT = '0x1100000000000000000000000000000000000011';
const NATIVE = '0x4400000000000000000000000000000000000044';
const PREPARED = '105';
const COMMIT = 'a'.repeat(40);
const PREPARED_HASH = `0x${'ab'.repeat(32)}` as Hex;
const OTHER_HASH = `0x${'cd'.repeat(32)}` as Hex;
const clone = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown) => error instanceof LiveSafetyError && error.code === expected;

async function fixture(historyCount = 1) {
  // These ephemeral signers exist only in memory. No wallet files, live RPC or filesystem storage are used.
  const account = privateKeyToAccount(generatePrivateKey());
  const request: NativeTransactionRequest = {
    from: account.address.toLowerCase() as Hex, to: NATIVE, data: '0x1234', value: '0x0',
    chainId: toHex(LIVE_CHAIN_ID), gas: toHex(100_000n), maxFeePerGas: toHex(2_000_000_000n), maxPriorityFeePerGas: '0x1',
  };
  let latest = 0n, pending: bigint | undefined, historical = BigInt(historyCount), balance = 10n ** 20n, estimate = 80_000n;
  let reads = 0, loads = 0, sends = 0;
  const order: string[] = [], saved: BudgetDocument[] = [];
  const transactions = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const blocks = new Map<string, Record<string, unknown>>([[toHex(BigInt(PREPARED)), { number: toHex(BigInt(PREPARED)), hash: PREPARED_HASH, transactions: [] }]]);
  const read: ReadRpc = async args => {
    reads++;
    if (args.method === 'eth_chainId') return toHex(LIVE_CHAIN_ID);
    if (args.method === 'eth_getTransactionCount') return toHex(args.params?.[1] === 'pending' ? pending ?? latest : args.params?.[1] === 'latest' ? latest : historical);
    if (args.method === 'eth_getBalance') return toHex(balance);
    if (args.method === 'eth_estimateGas') return toHex(estimate);
    if (args.method === 'eth_getTransactionReceipt') return receipts.get(String(args.params?.[0])) ?? null;
    if (args.method === 'eth_getTransactionByHash') return transactions.get(String(args.params?.[0])) ?? null;
    if (args.method === 'eth_getBlockByNumber') return blocks.get(String(args.params?.[0])) ?? null;
    throw Error(`Unexpected synthetic RPC method ${args.method}`);
  };
  const persist = (document: BudgetDocument) => { order.push(`persist:${document.records.at(-1)?.status}`); saved.push(clone(document)); };
  let ledger = new BudgetLedger(createBudgetDocument({ rootAccount: ROOT }), persist);
  const transactionFor = (record: BudgetRecord) => {
    const p = record.plan;
    return { hash: record.transactionHash, from: p.from, to: p.to, input: p.data, value: toHex(BigInt(p.value)), nonce: toHex(p.nonce),
      gas: toHex(BigInt(p.gas)), type: '0x2', chainId: toHex(p.chainId), maxFeePerGas: toHex(BigInt(p.maxFeePerGas)),
      maxPriorityFeePerGas: toHex(BigInt(p.maxPriorityFeePerGas)), accessList: [], blockHash: null, blockNumber: null, transactionIndex: null };
  };
  const mine = (record: BudgetRecord, number = 100n + BigInt(record.plan.nonce)) => {
    const hash = record.transactionHash!;
    const blockHash = `0x${Number(number).toString(16).padStart(2, '0').repeat(32)}` as Hex;
    const transaction = { ...transactionFor(record), blockHash, blockNumber: toHex(number), transactionIndex: '0x0' };
    const receipt = { transactionHash: hash, from: record.plan.from, to: record.plan.to, type: '0x2', blockHash, blockNumber: toHex(number),
      transactionIndex: '0x0', status: '0x1', gasUsed: toHex(21_000n), effectiveGasPrice: toHex(1_000_000_000n) };
    transactions.set(hash, transaction); receipts.set(hash, receipt);
    blocks.set(toHex(number), { hash: blockHash, number: toHex(number), transactions: [hash] });
    latest = BigInt(record.plan.nonce + 1);
    return { hash, transaction, receipt };
  };
  for (let index = 0; index < historyCount; index++) {
    await ledger.submit({ id: `history:${index}`, kind: 'native', address: account.address, request, read, broadcast: true,
      loadAccount: async () => account, sendRaw: async raw => keccak256(raw) });
    mine(ledger.snapshot().records[index]!);
    await ledger.reconcileAll(read);
  }
  order.length = 0; saved.length = 0; reads = 0;
  const recover = (extra: Partial<RecoverAdmissionOptions> = {}) => ledger.recoverAdmission({
    id: 'frozen-operation:native-step', expectedNonce: historyCount, preparedAtBlock: PREPARED, originalCommit: COMMIT,
    address: account.address, request, read, broadcast: true,
    loadAccount: async () => { loads++; order.push('load'); return account; },
    sendRaw: async raw => { sends++; order.push('send'); return keccak256(raw); }, ...extra,
  });
  return { account, request, read, recover, order, saved, mine, transactions, receipts, blocks,
    ledger: () => ledger, counters: () => ({ reads, loads, sends }),
    reload: (document = saved.at(-1)!, persistDocument = persist) => { ledger = new BudgetLedger(clone(document), persistDocument); },
    setLatest: (value: bigint) => { latest = value; }, setPending: (value: bigint) => { pending = value; },
    setHistorical: (value: bigint) => { historical = value; }, setBalance: (value: bigint) => { balance = value; },
    setEstimate: (value: bigint) => { estimate = value; },
  };
}

describe('BudgetLedger recoverAdmission core', () => {
  it('requires explicit broadcast and a dedicated actor before RPC, persistence or signer access', async () => {
    const f = await fixture();
    await expect(f.recover({ broadcast: false })).rejects.toSatisfy(code('BROADCAST_NOT_ENABLED'));
    await expect(f.recover({ address: ROOT, request: { ...f.request, from: ROOT } })).rejects.toSatisfy(code('DEDICATED_ACTOR_REQUIRED'));
    expect(f.counters()).toEqual({ reads: 0, loads: 0, sends: 0 });
    expect(f.saved).toEqual([]);
  });

  it('persists exactly one pinned candidate before key access and forwards its signed bytes once', async () => {
    const f = await fixture(); const before = f.ledger().snapshot();
    const result = await f.recover();
    expect(result).toMatchObject({ status: 'submitted', forwarded: true });
    expect(f.order).toEqual(['persist:reserved', 'load', 'persist:admitted', 'send', 'persist:submitted']);
    const record = f.ledger().snapshot().records.at(-1)!;
    expect(record.id).toBe('frozen-operation:native-step'); expect(record.plan.nonce).toBe(1);
    expect(record.plan).toMatchObject({ from: f.request.from, to: f.request.to, data: f.request.data, gas: '100000', maxFeePerGas: '2000000000' });
    expect(record.admissionRecovery).toMatchObject({ preparedAtBlock: PREPARED, preparedBlockHash: PREPARED_HASH, originalCommit: COMMIT });
    expect(record.transactionHash).toBe(keccak256(record.signedTransaction!));
    expect(f.ledger().snapshot().records.slice(0, -1)).toEqual(before.records);
    const charged = f.ledger().publicSummary().chargedWei;
    f.reload();
    expect(await f.recover()).toEqual({ transactionHash: result.transactionHash, status: 'unresolved', forwarded: false });
    expect(f.counters()).toMatchObject({ loads: 1, sends: 1 });
    expect(f.ledger().publicSummary().chargedWei).toBe(charged);
  });

  it('rejects absent or gapped prior nonce history without a new reservation', async () => {
    for (const historyCount of [1, 2]) {
      const f = await fixture(historyCount); const document = f.ledger().snapshot(); document.records.shift(); f.reload(document);
      await expect(f.recover()).rejects.toSatisfy(code('RECOVERY_NONCE_HISTORY_MISMATCH'));
      expect(f.counters()).toMatchObject({ loads: 0, sends: 0 }); expect(f.saved).toEqual([]);
    }
  });

  it('requires prior receipts to be canonical and at or before the prepared block', async () => {
    const reorg = await fixture(); const record = reorg.ledger().snapshot().records[0]!;
    reorg.blocks.get('0x64')!.hash = OTHER_HASH;
    await expect(reorg.recover()).rejects.toSatisfy(code('NONCANONICAL_RECEIPT'));
    expect(reorg.counters()).toMatchObject({ loads: 0, sends: 0 }); expect(reorg.saved).toEqual([]);
    const later = await fixture(); later.mine(later.ledger().snapshot().records[0]!, 106n);
    await expect(later.recover()).rejects.toSatisfy(code('RECOVERY_NONCE_HISTORY_MISMATCH'));
    expect(later.counters()).toMatchObject({ loads: 0, sends: 0 });
    expect(record.plan.nonce).toBe(0);
  });

  it('rejects freshly missing or mismatched history evidence before signer access', async () => {
    const missing = await fixture(); missing.receipts.clear();
    await expect(missing.recover()).rejects.toSatisfy(code('UNRESOLVED_TRANSACTION'));
    expect(missing.counters()).toMatchObject({ loads: 0, sends: 0 });
    const mismatch = await fixture(); mismatch.transactions.values().next().value!.input = '0xabcd';
    await expect(mismatch.recover()).rejects.toSatisfy(code('RECEIPT_TRANSACTION_MISMATCH'));
    expect(mismatch.counters()).toMatchObject({ loads: 0, sends: 0 }); expect(mismatch.saved).toEqual([]);
  });

  it('rejects historical frontier mismatch and prepared-block reorg before key access', async () => {
    const historical = await fixture(); historical.setHistorical(0n);
    await expect(historical.recover()).rejects.toSatisfy(code('RECOVERY_HISTORICAL_NONCE_MISMATCH'));
    expect(historical.counters()).toMatchObject({ loads: 0, sends: 0 });
    const reorg = await fixture(); let preparedReads = 0;
    const read: ReadRpc = async args => {
      const value = await reorg.read(args);
      if (args.method === 'eth_getBlockByNumber' && args.params?.[0] === '0x69' && ++preparedReads === 2) return { ...(value as object), hash: OTHER_HASH };
      return value;
    };
    await expect(reorg.recover({ read })).rejects.toSatisfy(code('RECOVERY_PREPARED_BLOCK_MISMATCH'));
    expect(reorg.counters()).toMatchObject({ loads: 0, sends: 0 }); expect(reorg.saved).toEqual([]);
  });

  it('rejects latest or pending nonce advancement before key access', async () => {
    for (const pendingOnly of [false, true]) {
      const f = await fixture(); if (pendingOnly) f.setPending(2n); else f.setLatest(2n);
      await expect(f.recover()).rejects.toSatisfy(code('RECOVERY_NONCE_MISMATCH'));
      expect(f.counters()).toMatchObject({ loads: 0, sends: 0 }); expect(f.saved).toEqual([]);
    }
  });

  it('resumes an unsigned durable reservation only with the same ID, nonce, request and witness binding', async () => {
    const f = await fixture(); const interrupted = Error('synthetic stop after reservation');
    await expect(f.recover({ loadAccount: async () => { throw interrupted; } })).rejects.toBe(interrupted);
    const reserved = clone(f.saved.at(-1)!); const plan = clone(reserved.records.at(-1)!.plan);
    for (const change of [{ expectedNonce: 2 }, { request: { ...f.request, data: '0xabcd' as Hex } },
      { preparedAtBlock: '104' }, { originalCommit: 'b'.repeat(40) }]) {
      f.reload(reserved);
      await expect(f.recover(change)).rejects.toSatisfy(code('ADMISSION_RECOVERY_BINDING_MISMATCH'));
    }
    f.reload(reserved);
    await expect(f.recover({ id: 'different-operation:native-step' })).rejects.toSatisfy(code('UNRESOLVED_TRANSACTION'));
    expect(f.counters()).toMatchObject({ loads: 0, sends: 0 });
    f.reload(reserved); expect((await f.recover()).forwarded).toBe(true);
    expect(f.ledger().snapshot().records).toHaveLength(2);
    expect(f.ledger().snapshot().records.at(-1)!.plan).toEqual(plan);
  });

  it('requires the same canonical prepared block when restarting an unsigned reservation', async () => {
    const f = await fixture();
    await expect(f.recover({ loadAccount: async () => { throw Error('synthetic interruption'); } })).rejects.toThrow('synthetic interruption');
    f.reload(); f.blocks.get('0x69')!.hash = OTHER_HASH;
    await expect(f.recover()).rejects.toSatisfy(code('RECOVERY_PREPARED_BLOCK_MISMATCH'));
    expect(f.counters()).toMatchObject({ loads: 0, sends: 0 });
  });

  it('never forwards when the exact reconstructed hash is already pending or mined', async () => {
    for (const mined of [false, true]) {
      const f = await fixture();
      const candidate = clone(f.ledger().snapshot().records[0]!); candidate.plan.nonce = 1;
      candidate.signedTransaction = await f.account.signTransaction({ chainId: LIVE_CHAIN_ID, to: NATIVE, data: '0x1234', value: 0n,
        nonce: 1, gas: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
      candidate.transactionHash = keccak256(candidate.signedTransaction); candidate.receipt = null; candidate.status = 'admitted';
      let loads = 0;
      const result = await f.recover({ loadAccount: async () => {
        loads++;
        if (mined) f.mine(candidate, 107n);
        else f.transactions.set(candidate.transactionHash!, { hash: candidate.transactionHash, from: candidate.plan.from, to: candidate.plan.to,
          input: candidate.plan.data, value: '0x0', nonce: toHex(candidate.plan.nonce), gas: toHex(BigInt(candidate.plan.gas)), type: '0x2',
          chainId: toHex(candidate.plan.chainId), maxFeePerGas: toHex(BigInt(candidate.plan.maxFeePerGas)), maxPriorityFeePerGas: '0x1', accessList: [],
          blockHash: null, blockNumber: null, transactionIndex: null });
        return f.account;
      } });
      expect(result).toEqual({ transactionHash: candidate.transactionHash, status: mined ? 'confirmed' : 'pending', forwarded: false });
      f.reload();
      expect(await f.recover()).toEqual({ transactionHash: result.transactionHash, status: mined ? 'confirmed' : 'pending', forwarded: false });
      expect(loads).toBe(1); expect(f.counters()).toMatchObject({ sends: 0, loads: 0 });
    }
  });

  it('a signed admitted restart after a lost raw-send response only reconciles, without retry', async () => {
    const f = await fixture(); let forwards = 0;
    await expect(f.recover({ sendRaw: async () => { forwards++; throw Error('synthetic lost response'); } })).rejects.toThrow('synthetic lost response');
    expect(f.saved.at(-1)!.records.at(-1)!.status).toBe('admitted');
    const original = clone(f.saved.at(-1)!); f.reload(original);
    expect(await f.recover()).toMatchObject({ status: 'unresolved', forwarded: false });
    expect(forwards).toBe(1); expect(f.counters()).toMatchObject({ loads: 1, sends: 0 });
    expect(f.ledger().snapshot()).toEqual(original);
  });

  it('persists the reservation before key load and signed admission before raw forwarding, including failures', async () => {
    for (const status of ['reserved', 'admitted']) {
      const f = await fixture(); const original = f.ledger().snapshot();
      f.reload(original, document => { if (document.records.at(-1)?.status === status) throw Error('synthetic persistence failure'); f.saved.push(clone(document)); });
      await expect(f.recover()).rejects.toSatisfy(code('LEDGER_PERSISTENCE_FAILED'));
      expect(f.counters()).toMatchObject({ sends: 0, loads: status === 'reserved' ? 0 : 1 });
      expect(() => f.ledger().snapshot()).toThrowError(LiveSafetyError);
      if (status === 'admitted') expect(f.saved.at(-1)!.records.at(-1)!).toMatchObject({ status: 'reserved', signedTransaction: null, transactionHash: null });
      else expect(f.saved).toEqual([]);
    }
  });

  it('respects cumulative prior spend plus authenticated history and the full candidate maximum', async () => {
    const f = await fixture(); const document = f.ledger().snapshot();
    const historyCost = BigInt(document.records[0]!.receipt!.actualCostWei);
    document.limitWei = (BigInt(PRIOR_SPEND_WEI) + historyCost + 100_000n * 2_000_000_000n - 1n).toString(); f.reload(document);
    await expect(f.recover()).rejects.toSatisfy(code('APPROVED_BUDGET_EXCEEDED'));
    expect(f.counters()).toMatchObject({ loads: 0, sends: 0 }); expect(f.saved).toEqual([]);
    expect(f.ledger().snapshot()).toEqual(document);
  });

  it('refuses insufficient funds or a fresh estimate exceeding the frozen gas cap', async () => {
    const balance = await fixture(); balance.setBalance(100_000n * 2_000_000_000n - 1n);
    await expect(balance.recover()).rejects.toSatisfy(code('INSUFFICIENT_TEST_GLM'));
    expect(balance.counters()).toMatchObject({ loads: 0, sends: 0 });
    const estimate = await fixture(); estimate.setEstimate(100_001n);
    await expect(estimate.recover()).rejects.toSatisfy(code('RECOVERY_ESTIMATE_EXCEEDS_FROZEN_GAS'));
    expect(estimate.counters()).toMatchObject({ loads: 0, sends: 0 });
  });

  it('rechecks pending nonce after signing and leaves a reconcile-only admission when it advances', async () => {
    const f = await fixture();
    await expect(f.recover({ loadAccount: async () => { f.setPending(2n); return f.account; } })).rejects.toSatisfy(code('RECOVERY_NONCE_MISMATCH'));
    expect(f.saved.at(-1)!.records.at(-1)!.status).toBe('admitted'); expect(f.counters().sends).toBe(0);
    f.reload(); expect(await f.recover()).toMatchObject({ status: 'unresolved', forwarded: false });
    expect(f.counters().sends).toBe(0);
  });
});
