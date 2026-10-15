import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiParameters } from 'viem';
import { canonicalJson, hashCanonical } from '../../domain/canonical';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { OperationReceipt, OperationStep, WriteAuthority } from '../types';
import {
  allocateOperationStep, BrowserOperationStore, createOperationController, createOperationIntent,
  DEFAULT_OPERATION_STORAGE_KEY, MemoryOperationStore,
} from '../operations';
import type { StoredOperationStep } from '../operations';
import { ARKIV_NATIVE_ADDRESS, createWalletGateway, WalletOperationError } from '../wallet';
import type { InjectedWalletProvider, NativeBatch, RpcRequest, RpcRequester } from '../wallet';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const OLD = `0x${'a'.repeat(64)}` as const;
const NEW = `0x${'b'.repeat(64)}` as const;
const HASH = `0x${'c'.repeat(64)}` as const;
const authority: WriteAuthority = { mode: 'public', actor: { kind: 'wallet', address: ACCOUNT }, chainId: TIRAMISU_CHAIN_ID };
const EXECUTE = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']);
const batch = (): NativeBatch => ({
  creates: [{
    payloadJson: canonicalJson({ operationId: 'op-one', message: 'Synthetic library offer' }),
    attributes: {
      project: { type: 'str', value: 'partfolk' }, schema_version: { type: 'i32', value: 1 },
      created_at: { type: 'u64', value: '1791532800000' },
      book_key: { type: 'key', value: OLD }, proposal_hash: { type: 'bytes32', value: NEW },
    },
    lifetimeSeconds: 3600, salt: '23',
  }], deletes: [OLD],
});

class FakeWallet implements InjectedWalletProvider {
  requests: RpcRequest[] = [];
  account = ACCOUNT as string;
  chain = '0x7614d1';
  send: (request: RpcRequest) => Promise<unknown> = async () => HASH;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  async request(request: RpcRequest): Promise<unknown> {
    this.requests.push(request);
    if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [this.account];
    if (request.method === 'eth_chainId') return this.chain;
    if (request.method === 'eth_sendTransaction' || request.method === 'wallet_sendTransaction') return this.send(request);
    throw new Error(`Unexpected wallet method ${request.method}`);
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener); this.listeners.set(event, listeners);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string) { for (const listener of this.listeners.get(event) ?? []) listener(); }
  listenerCount(event: string) { return this.listeners.get(event)?.size ?? 0; }
  sent() { return this.requests.filter(request => request.method.endsWith('_sendTransaction')); }
}

class FakeRpc implements RpcRequester {
  requests: RpcRequest[] = [];
  failPrice = false;
  balance = 1_000_000n;
  async request(request: RpcRequest): Promise<unknown> {
    this.requests.push(request);
    switch (request.method) {
      case 'eth_chainId': return '0x7614d1';
      case 'eth_blockNumber': return '0x100';
      case 'eth_estimateGas': return '0x186a0';
      case 'eth_gasPrice': if (this.failPrice) throw new Error('Quote unavailable.'); return '0x2';
      case 'eth_getBalance': return `0x${this.balance.toString(16)}`;
      default: throw new Error(`Unexpected public RPC method ${request.method}`);
    }
  }
}

function fixture(store = new MemoryOperationStore()) {
  const wallet = new FakeWallet(); const rpc = new FakeRpc();
  const gateway = createWalletGateway({ provider: wallet, publicRpc: rpc });
  const controller = createOperationController({ store, gateway, now: () => 1791532800010 });
  const operation = createOperationIntent('replace_book', authority, { expectedHeads: [OLD], lifetimeSeconds: 3600, synthetic: true }, { id: 'op-one', now: 1791532800000 });
  const step: OperationStep = { ...allocateOperationStep(operation, 'book_pending', { batch: batch() }, [OLD]), id: 'step-one' };
  return { store, wallet, rpc, gateway, controller, operation, step };
}

const receipt = (): OperationReceipt => ({
  operationId: 'op-one', transactionHash: HASH, entityKeys: [NEW], consumedKeys: [OLD],
  blockNumber: '257', confirmedAt: 1791532800020,
});

describe('frozen operation intents', () => {
  it('accepts numeric time, clones complete input, infers predecessor keys and hashes the command', () => {
    const input = { expectedHeads: [OLD], expectedActivationHeads: [NEW], lifetimeSeconds: 3600, names: ['Library'] };
    const intent = createOperationIntent('close_project', authority, input, { id: 'uuid-before-decision', now: 1000 });
    input.names[0] = 'Changed';
    expect(intent.createdAt).toBe(1000);
    expect(intent.input).toEqual({ ...input, names: ['Library'] });
    expect(intent.expectedHeads).toEqual([OLD, NEW]);
    expect(intent.inputHash).toBe(hashCanonical(intent.input));
  });
  it('rejects nested signing secrets, embedded operations and invalid JSON numbers', () => {
    expect(() => createOperationIntent('create_project', authority, { settings: { privateKey: 'never-store' } })).toThrow('Signing secrets');
    expect(() => createOperationIntent('create_project', authority, { operation: {} })).toThrow('without an operation');
    expect(() => createOperationIntent('create_project', authority, { amount: Infinity })).toThrow('safe integers');
  });
});

describe('SDK native wallet gateway', () => {
  it('prepares real SDK calldata and an unsigned estimate without touching the wallet', async () => {
    const f = fixture(); const prepared = await f.gateway.prepare(batch(), ACCOUNT);
    expect(f.wallet.requests).toHaveLength(0);
    expect(prepared.request.to).toBe(ARKIV_NATIVE_ADDRESS);
    expect(prepared.estimatedGas).toBe('100000');
    expect(prepared.estimatedCostWei).toBe('200000');
    expect(prepared.estimatedMaximumCostWei).toBeNull();
    const decoded = decodeFunctionData({ abi: EXECUTE, data: prepared.request.data });
    const operations = decoded.args![0];
    expect(operations).toHaveLength(2);
    expect(operations.map(operation => operation.operation)).toEqual([1, 5]);
    const create = decodeAbiParameters(parseAbiParameters('(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name,uint8 typeId,bytes value)[] attributes)'), operations[0]!.operationData)[0];
    expect(create.salt).toBe(23n);
    expect(create.minLifetime).toBe(1800n);
    expect(create.creationFlags).toBe(1);
    expect(f.rpc.requests.some(request => request.method.endsWith('_sendTransaction'))).toBe(false);
  });
  it('freezes explicit fees/gas, labels capped quotes and represents missing quotes as null', async () => {
    const f = fixture();
    const capped = await f.gateway.prepare(batch(), ACCOUNT, { gas: '120000', gasPrice: '3' });
    expect(capped.request.gas).toBe('0x1d4c0'); expect(capped.request.gasPrice).toBe('0x3');
    expect(capped.estimatedMaximumCostWei).toBe('360000'); expect(capped.estimatePolicy).toBe('explicit-cap');
    f.rpc.failPrice = true;
    const unknown = await f.gateway.prepare(batch(), ACCOUNT);
    expect(unknown.estimatedCostWei).toBeNull(); expect(unknown.estimatedMaximumCostWei).toBeNull();
    expect(unknown.estimatePolicy).toBe('gas-only');
  });
  it('stops before a wallet send when the prepared-block balance cannot cover the estimate', async () => {
    const f = fixture(); f.rpc.balance = 199_999n;
    await expect(f.gateway.prepare(batch(), ACCOUNT)).rejects.toMatchObject({ kind: 'not_sent', code: 'insufficient_funds' });
    expect(f.rpc.requests.at(-1)).toMatchObject({ method: 'eth_getBalance', params: [ACCOUNT, '0x100'] });
    expect(f.wallet.sent()).toHaveLength(0);
  });
  it('checkpoints admission and returned hash in order, never entering the SDK receipt wait', async () => {
    const f = fixture(); const prepared = await f.gateway.prepare(batch(), ACCOUNT);
    const order: string[] = [];
    f.wallet.send = async () => { order.push('provider'); return HASH; };
    const result = await f.gateway.submit(prepared, {
      onAdmission: () => { order.push('admission'); }, onHash: hash => { expect(hash).toBe(HASH); order.push('hash'); },
    });
    expect(result).toEqual({ status: 'submitted', transactionHash: HASH });
    expect(order).toEqual(['admission', 'provider', 'hash']);
    expect(f.wallet.sent()).toHaveLength(1);
    expect(f.wallet.requests.some(request => request.method === 'eth_getTransactionReceipt')).toBe(false);
  });
  it('blocks viem wallet namespace fallback after the first forwarded request', async () => {
    const f = fixture(); const prepared = await f.gateway.prepare(batch(), ACCOUNT);
    f.wallet.send = async () => { throw { code: -32602, message: 'Invalid input from wallet.' }; };
    await expect(f.gateway.submit(prepared, { onAdmission() {}, onHash() {} })).rejects.toMatchObject({ kind: 'unverified', providerCode: -32602 });
    expect(f.wallet.sent().map(request => request.method)).toEqual(['eth_sendTransaction']);
  });
  it('checks exact prepared calldata again before forwarding', async () => {
    const f = fixture(); const prepared = await f.gateway.prepare(batch(), ACCOUNT);
    prepared.request.data = '0x1234';
    await expect(f.gateway.submit(prepared, { onAdmission() {}, onHash() {} })).rejects.toMatchObject({ kind: 'not_sent' });
    expect(f.wallet.sent()).toHaveLength(0);
  });
  it('re-estimates explicit-gas transactions before a funded send', async () => {
    const f = fixture(); const prepared = await f.gateway.prepare(batch(), ACCOUNT, { gas: '120000', gasPrice: '3' });
    const original = f.rpc.request.bind(f.rpc);
    f.rpc.request = async request => {
      if (request.method === 'eth_estimateGas') throw new Error('The expected predecessor was consumed.');
      return original(request);
    };
    await expect(f.gateway.submit(prepared, { onAdmission() {}, onHash() {} })).rejects.toMatchObject({ kind: 'not_sent' });
    expect(f.wallet.sent()).toHaveLength(0);
  });
  it('refuses stale account/chain sessions and removes only its own listeners', async () => {
    const f = fixture(); const prepared = await f.gateway.prepare(batch(), ACCOUNT);
    f.wallet.account = OTHER;
    await expect(f.gateway.submit(prepared, { onAdmission() {}, onHash() {} })).rejects.toMatchObject({ code: 'not_connected' });
    f.wallet.account = ACCOUNT; f.wallet.chain = '0x1';
    await expect(f.gateway.submit(prepared, { onAdmission() {}, onHash() {} })).rejects.toMatchObject({ code: 'wrong_chain' });
    f.wallet.chain = '0x7614d1'; f.wallet.on('chainChanged', () => {}); f.wallet.emit('chainChanged');
    await expect(f.gateway.submit(prepared, { onAdmission() {}, onHash() {} })).rejects.toMatchObject({ code: 'not_connected' });
    f.gateway.dispose();
    expect(f.wallet.listenerCount('chainChanged')).toBe(1); expect(f.wallet.listenerCount('accountsChanged')).toBe(0);
    expect(f.wallet.sent()).toHaveLength(0);
  });
  it('keeps a returned hash if the wallet session changes while its request is open', async () => {
    const f = fixture(); const prepared = await f.gateway.prepare(batch(), ACCOUNT);
    f.wallet.send = async () => { f.wallet.emit('accountsChanged'); return HASH; };
    await expect(f.gateway.submit(prepared, { onAdmission() {}, onHash() {} })).resolves.toMatchObject({ transactionHash: HASH });
  });
});

describe('persistent operation controller', () => {
  it('clones frozen commands and returns the existing submission without a second send', async () => {
    const f = fixture(); const input = batch();
    const pending = f.controller.prepareStep({ operation: f.operation, step: f.step, batch: input });
    input.creates![0]!.salt = '99'; input.deletes![0] = NEW;
    const prepared = await pending;
    expect(prepared.batch.creates![0]!.salt).toBe('23'); expect(prepared.batch.deletes).toEqual([OLD]);
    await f.controller.submitStep(f.operation.id, f.step.id);
    const restored = createOperationController({ store: f.store, gateway: f.gateway });
    expect((await restored.submitStep(f.operation.id, f.step.id)).step.status).toBe('submitted');
    expect(f.wallet.sent()).toHaveLength(1);
    await restored.markConfirmed(f.operation.id, f.step.id, receipt());
    expect(restored.getStep(f.operation.id, f.step.id)?.step.status).toBe('confirmed');
  });
  it('does not resend unknown outcomes, including after a fresh controller instance', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    f.wallet.send = async () => { throw new Error('Response lost after forwarding.'); };
    await expect(f.controller.submitStep(f.operation.id, f.step.id)).rejects.toMatchObject({ kind: 'unverified' });
    const restored = createOperationController({ store: f.store, gateway: f.gateway });
    await expect(restored.submitStep(f.operation.id, f.step.id)).rejects.toMatchObject({ kind: 'unverified' });
    expect(restored.getStep(f.operation.id, f.step.id)?.admission).not.toBeNull();
    expect(f.wallet.sent()).toHaveLength(1);
  });
  it('records an explicit 4001 rejection as not sent and supports deliberate re-preparation', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    f.wallet.send = async () => { throw { code: 4001, message: 'User rejected request.' }; };
    await expect(f.controller.submitStep(f.operation.id, f.step.id)).rejects.toMatchObject({ kind: 'rejected', providerCode: 4001 });
    expect(f.controller.getStep(f.operation.id, f.step.id)?.step.status).toBe('failed-before-send');
    const retried = await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    expect(retried.step.status).toBe('prepared'); expect(retried.admission).toBeNull();
    f.wallet.send = async () => HASH;
    expect((await f.controller.submitStep(f.operation.id, f.step.id)).step.status).toBe('submitted');
  });
  it('refuses changed input under a retained operation/step ID', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    const changed = batch(); changed.creates![0]!.salt = '24';
    await expect(f.controller.prepareStep({ operation: f.operation, step: f.step, batch: changed })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.wallet.sent()).toHaveLength(0);
  });
  it('rejects concurrent admission rather than queueing another wallet prompt', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    let release!: (hash: string) => void;
    f.wallet.send = () => new Promise(resolve => { release = resolve; });
    const first = f.controller.submitStep(f.operation.id, f.step.id);
    await expect(f.controller.submitStep(f.operation.id, f.step.id)).rejects.toMatchObject({ code: 'conflict' });
    // Wait only for the local fake provider promise to be reached.
    for (let index = 0; index < 20 && !release; index++) await new Promise(resolve => setTimeout(resolve, 0));
    release(HASH); await first;
    expect(f.wallet.sent()).toHaveLength(1);
  });
  it('blocks another step for the account while its earlier transaction is unresolved', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    await f.controller.submitStep(f.operation.id, f.step.id);
    const another = { ...f.step, id: 'step-two' };
    await f.controller.prepareStep({ operation: f.operation, step: another, batch: batch() });
    await expect(f.controller.submitStep(f.operation.id, another.id)).rejects.toMatchObject({ kind: 'unverified' });
    expect(f.wallet.sent()).toHaveLength(1);
  });
  it('never forwards if admission persistence fails', async () => {
    class FailingAdmissionStore extends MemoryOperationStore {
      override put(record: StoredOperationStep) {
        if (record.step.status === 'unverified') throw new WalletOperationError('Storage is full.', { kind: 'not_sent', code: 'storage' });
        super.put(record);
      }
    }
    const f = fixture(new FailingAdmissionStore());
    await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    await expect(f.controller.submitStep(f.operation.id, f.step.id)).rejects.toMatchObject({ code: 'storage', kind: 'not_sent' });
    expect(f.wallet.sent()).toHaveLength(0);
  });
  it('retains pre-send admission and exposes the observed hash if hash persistence fails', async () => {
    class FailingHashStore extends MemoryOperationStore {
      override put(record: StoredOperationStep) {
        if (record.submissionHash) throw new WalletOperationError('Storage is full.', { kind: 'not_sent', code: 'storage' });
        super.put(record);
      }
    }
    const f = fixture(new FailingHashStore());
    await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    await expect(f.controller.submitStep(f.operation.id, f.step.id)).rejects.toMatchObject({ kind: 'unverified', code: 'storage', transactionHash: HASH });
    const saved = f.store.get(f.operation.id, f.step.id)!;
    expect(saved.admission).not.toBeNull(); expect(saved.step.status).toBe('unverified');
    expect(saved.submissionHash).toBeNull(); expect(f.wallet.sent()).toHaveLength(1);
  });
  it('updates multi-phase progress without downgrading confirmed steps', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    await f.controller.submitStep(f.operation.id, f.step.id); await f.controller.markConfirmed(f.operation.id, f.step.id, receipt());
    const nextStep = { ...f.step, id: 'step-two', phase: 'link_pending' as const };
    const progress = { ...f.operation, phase: 'book_confirmed' as const, confirmedKeys: [NEW] };
    await f.controller.prepareStep({ operation: progress, step: nextStep, batch: batch() });
    await f.controller.updateOperation({ ...progress, phase: 'link_pending', pendingPublisherRoots: [OLD] });
    for (const saved of f.store.list()) {
      expect(saved.operation.phase).toBe('link_pending');
      expect(saved.operation.steps.find(step => step.id === 'step-one')?.status).toBe('confirmed');
    }
    const restored = createOperationController({ store: f.store, gateway: f.gateway });
    const recovered = restored.getOperation(f.operation.id)!;
    expect(recovered.phase).toBe('link_pending'); expect(recovered.steps).toHaveLength(2);
    expect(recovered.steps.find(step => step.id === 'step-one')?.status).toBe('confirmed');
    expect(recovered.confirmedKeys).toContain(NEW);
  });
  it('records a verified mined revert as terminal and releases the account for a corrected operation', async () => {
    const f = fixture(); await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    await f.controller.submitStep(f.operation.id, f.step.id);
    const revertedReceipt = { ...receipt(), entityKeys: [], consumedKeys: [] };
    const failed = await f.controller.markReverted(f.operation.id, f.step.id, revertedReceipt);
    expect(failed.step.status).toBe('reverted'); expect(failed.error?.kind).toBe('reverted');
    expect(f.controller.listPending()).toHaveLength(0);
    expect((await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() })).step.status).toBe('reverted');
    await expect(f.controller.submitStep(f.operation.id, f.step.id)).rejects.toMatchObject({ kind: 'reverted', code: 'reverted' });
    await expect(f.controller.markConfirmed(f.operation.id, f.step.id, receipt())).rejects.toMatchObject({ code: 'conflict' });
    const corrected = createOperationIntent('replace_book', authority, { expectedHeads: [OLD], lifetimeSeconds: 3600 }, { id: 'op-corrected' });
    const next = { ...f.step, id: 'step-corrected' };
    await f.controller.prepareStep({ operation: corrected, step: next, batch: batch() });
    expect((await f.controller.submitStep(corrected.id, next.id)).step.status).toBe('submitted');
    expect(f.wallet.sent()).toHaveLength(2);
  });
  it('recovers an interrupted unsigned preparation without allocating another step ID', async () => {
    const f = fixture(); const saved = await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    saved.prepared = null; f.store.put(saved);
    const restored = createOperationController({ store: f.store, gateway: f.gateway });
    const recovered = await restored.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    expect(recovered.prepared).not.toBeNull(); expect(recovered.step.id).toBe('step-one');
    expect(f.wallet.sent()).toHaveLength(0);
  });
});

describe('browser journal storage without browser automation', () => {
  function storage(raw: string | null = null) {
    let value = raw;
    return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
  }
  it('round-trips JSON sidecars through injected storage and keeps unknown versions intact', async () => {
    const f = fixture(); const prepared = await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    const target = storage(); const journal = new BrowserOperationStore(target);
    journal.put(prepared);
    expect(new BrowserOperationStore(target).get('op-one', 'step-one')).toEqual(prepared);
    const bad = '{"version":99,"records":{}}'; const incompatible = storage(bad);
    const invalid = new BrowserOperationStore(incompatible);
    expect(() => invalid.list()).toThrow('preserved');
    expect(() => invalid.put(prepared)).toThrow('preserved');
    expect(incompatible.getItem()).toBe(bad);
  });
  it('does not clear the previous journal when storage rejects a write', async () => {
    const f = fixture(); const prepared = await f.controller.prepareStep({ operation: f.operation, step: f.step, batch: batch() });
    const prior = '{"version":1,"records":{}}';
    const target = { getItem: () => prior, setItem: () => { throw new Error('Quota exceeded.'); } };
    expect(() => new BrowserOperationStore(target).put(prepared)).toThrow('preserved');
    expect(target.getItem()).toBe(prior);
    expect(DEFAULT_OPERATION_STORAGE_KEY).toContain('partfolk');
  });
  it('coordinates separate Studio and Desk journals through one shared lock name', async () => {
    const coordinator = new MemoryOperationStore(); const names: string[] = [];
    const locks = {
      runExclusive<T>(name: string, action: () => Promise<T>): Promise<T> {
        names.push(name); return coordinator.runExclusive(name, action);
      },
    };
    const studio = new BrowserOperationStore(storage(), { key: 'studio:wallet-operations:v1', lockKey: 'partfolk:wallet-operation-lock', locks });
    const desk = new BrowserOperationStore(storage(), { key: 'desk:wallet-operations:v1', lockKey: 'partfolk:wallet-operation-lock', locks });
    let release!: () => void;
    const first = studio.runExclusive('7738577:studio-account', () => new Promise<void>(resolve => { release = resolve; }));
    await expect(desk.runExclusive('7738577:desk-account', async () => 'must-not-run')).rejects.toMatchObject({ code: 'conflict' });
    release(); await first;
    await expect(desk.runExclusive('7738577:desk-account', async () => 'available')).resolves.toBe('available');
    expect(names).toEqual(Array(3).fill('partfolk:wallet-operation-lock'));
    const defaults = new BrowserOperationStore(storage(), { key: 'custom-journal', locks });
    await defaults.runExclusive('account', async () => {});
    expect(names.at(-1)).toBe('custom-journal:journal');
  });
});
