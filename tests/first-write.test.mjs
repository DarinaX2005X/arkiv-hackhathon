import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import {
  assertCanAdmit, assertFunding, BootstrapError, CHAIN_ID, CREATOR, estimateCreate,
  firstWriteParameters, makeBroadcastGuard, makeEstimateGuard, MAX_SPEND_WEI,
  NATIVE, parameterFingerprint, validateSeed,
} from '../scripts/first-write.mjs';

const matches = code => error => error instanceof BootstrapError && error.code === code;

test('estimate guard never forwards broadcasts, wallet methods or unexpected methods', async () => {
  const forwarded = [];
  const guard = makeEstimateGuard(async args => { forwarded.push(args.method); return '0x1'; });
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'wallet_sendTransaction', 'personal_sign', 'debug_traceTransaction']) {
    await assert.rejects(guard.request({ method, params: [] }), matches('ESTIMATE_RPC_METHOD_BLOCKED'));
  }
  await assert.rejects(guard.request({ method: 'eth_fillTransaction', params: [] }));
  assert.deepEqual(forwarded, []);
});

test('estimate only succeeds from a positive actual RPC gas result', async () => {
  for (const value of ['0x0', '100', null, '-1']) {
    const guard = makeEstimateGuard(async () => value);
    await assert.rejects(guard.request({ method: 'eth_estimateGas', params: [{ to: NATIVE, data: '0x12' }] }), matches('INVALID_GAS_ESTIMATE'));
    assert.equal(guard.state.gas, undefined);
  }
  const guard = makeEstimateGuard(async () => '0x186a0');
  await assert.rejects(guard.request({ method: 'eth_estimateGas', params: [{ to: NATIVE, data: '0x12' }] }), error => error === guard.state.stop);
  assert.equal(guard.state.gas, 100000n);
  assert.equal(guard.state.input, '0x12');
});

test('real SDK create serialization stops at estimate without signing', async () => {
  let signs = 0;
  const methods = [];
  const account = { address: CREATOR, type: 'local', signTransaction: async () => { signs++; throw Error('Must not sign'); } };
  const provider = async args => {
    methods.push(args.method);
    if (args.method === 'eth_blockNumber') return '0x64';
    if (args.method === 'eth_chainId') return `0x${CHAIN_ID.toString(16)}`;
    if (args.method === 'eth_estimateGas') return '0x186a0';
    throw Error(`Unexpected fixture RPC method: ${args.method}`);
  };
  const result = await estimateCreate(account, firstWriteParameters(1791551000000n),
    { nonce: 0, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }, provider);
  assert.equal(result.gas, 100000n);
  assert.ok(result.input.startsWith('0x49650044'));
  assert.equal(signs, 0);
  assert.ok(methods.includes('eth_estimateGas'));
  assert.ok(!methods.some(method => method.includes('send')));
});

test('failed provider estimation cannot become a passing dry run', async () => {
  const account = { address: CREATOR, type: 'local', signTransaction: async () => { throw Error('Must not sign'); } };
  await assert.rejects(estimateCreate(account, firstWriteParameters(1791551000000n),
    { nonce: 0, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }, async ({ method }) => {
      if (method === 'eth_blockNumber') return '0x64';
      throw Error('Provider unavailable');
    }), matches('GUARDED_ESTIMATE_FAILED'));
});

test('spend guard enforces both the aggregate authorization and available balance', () => {
  assert.equal(assertFunding({ balance: MAX_SPEND_WEI, gas: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }), 200n);
  assert.throws(() => assertFunding({ balance: 100n, gas: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }), matches('INSUFFICIENT_TEST_GLM'));
  assert.throws(() => assertFunding({ balance: MAX_SPEND_WEI, spent: MAX_SPEND_WEI - 10n, gas: 100n,
    maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }), matches('APPROVED_BUDGET_EXCEEDED'));
});

test('fingerprint detects payload mutation and readback rejects incorrect typed identity', () => {
  const parameters = firstWriteParameters(1791551000000n);
  const before = parameterFingerprint(parameters);
  const entity = { key: `0x${'11'.repeat(32)}`, creator: CREATOR, owner: CREATOR,
    createdAt: 100n, expiresAt: 100n + parameters.expires.minLifetime,
    creationFlags: { readonly: true, permissionlessExtension: false, raw: 1 },
    payload: new Uint8Array(parameters.payload), contentType: parameters.contentType,
    attributes: { project: { type: 'str', value: parameters.attributes.project },
      entity_type: { type: 'str', value: 'bootstrap' }, seed_id: { type: 'str', value: 'sdk_081_v1' },
      created_at: { type: 'u64', value: 1791551000000n } } };
  assert.equal(validateSeed(entity, parameters, CREATOR, 100n), entity);
  assert.throws(() => validateSeed({ ...entity, creator: NATIVE }, parameters), matches('SEED_PROVENANCE_MISMATCH'));
  assert.throws(() => validateSeed({ ...entity, creationFlags: { readonly: false, permissionlessExtension: false, raw: 0 } }, parameters), matches('SEED_FLAGS_MISMATCH'));
  assert.throws(() => validateSeed({ ...entity, attributes: { ...entity.attributes,
    created_at: { type: 'i32', value: 12 } } }, parameters), matches('SEED_TIMESTAMP_MISMATCH'));
  parameters.payload[0] ^= 1;
  assert.notEqual(parameterFingerprint(parameters), before);
  assert.throws(() => validateSeed(entity, parameters), matches('SEED_PAYLOAD_MISMATCH'));
});

test('pending, ambiguous, reverted and verified journal states forbid a new send', () => {
  assert.doesNotThrow(() => assertCanAdmit({ status: 'prepared' }));
  for (const status of ['send_admitted', 'submitted', 'reconcile_required', 'reverted', 'verified']) {
    assert.throws(() => assertCanAdmit({ status }), matches('SEND_ALREADY_ADMITTED_RECONCILE_ONLY'));
  }
  assert.throws(() => assertCanAdmit({ status: 'prepared', txHash: `0x${'11'.repeat(32)}` }), matches('SEND_ALREADY_ADMITTED_RECONCILE_ONLY'));
});

async function signedFixture() {
  // Isolated in-memory test identity; no local development wallet file is touched.
  const account = privateKeyToAccount(generatePrivateKey());
  const plan = { nonce: 0, input: '0x1234', gas: '21000', maxFeePerGas: '3', maxPriorityFeePerGas: '1' };
  const raw = await account.signTransaction({ chainId: CHAIN_ID, to: NATIVE, nonce: 0, data: plan.input,
    value: 0n, gas: 21000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
  return { account, plan, raw, journal: { status: 'prepared', plan, balanceBeforeWei: MAX_SPEND_WEI.toString(), spentWei: '0' } };
}

test('signed bytes and hash are durably saved before a single forward', async () => {
  const fixture = await signedFixture();
  const order = [];
  const guard = makeBroadcastGuard({ creator: fixture.account.address, journal: fixture.journal,
    read: async () => { throw Error('unexpected read'); },
    persist: async journal => {
      order.push(`persist:${journal.status}`);
      assert.equal(journal.txHash, keccak256(fixture.raw));
      assert.equal(journal.signedTransaction, fixture.raw);
    },
    provider: async () => { order.push('forward'); return keccak256(fixture.raw); } });
  await guard({ method: 'eth_sendRawTransaction', params: [fixture.raw] });
  assert.deepEqual(order, ['persist:send_admitted', 'forward', 'persist:submitted']);
  await assert.rejects(guard({ method: 'eth_sendRawTransaction', params: [fixture.raw] }), matches('SECOND_SEND_BLOCKED'));
});

test('journal persistence failure prevents provider forwarding', async () => {
  const fixture = await signedFixture();
  let forwarded = false;
  const guard = makeBroadcastGuard({ creator: fixture.account.address, journal: fixture.journal,
    read: async () => {}, persist: async () => { throw Error('simulated fsync failure'); },
    provider: async () => { forwarded = true; return keccak256(fixture.raw); } });
  await assert.rejects(guard({ method: 'eth_sendRawTransaction', params: [fixture.raw] }));
  assert.equal(forwarded, false);
});

test('lost send response preserves original hash and blocks a replacement', async () => {
  const fixture = await signedFixture();
  const saved = [];
  const guard = makeBroadcastGuard({ creator: fixture.account.address, journal: fixture.journal,
    read: async () => {}, persist: async journal => saved.push(structuredClone(journal)),
    provider: async () => { throw Error('lost HTTP response'); } });
  await assert.rejects(guard({ method: 'eth_sendRawTransaction', params: [fixture.raw] }));
  assert.equal(saved[0].status, 'send_admitted');
  assert.equal(saved[0].txHash, keccak256(fixture.raw));
  assert.throws(() => assertCanAdmit(saved[0]), matches('SEND_ALREADY_ADMITTED_RECONCILE_ONLY'));
});

test('a signed but different transaction never reaches persistence or provider', async () => {
  const fixture = await signedFixture();
  fixture.journal.plan = { ...fixture.plan, input: '0xabcd' };
  let touched = false;
  const guard = makeBroadcastGuard({ creator: fixture.account.address, journal: fixture.journal,
    read: async () => {}, persist: async () => { touched = true; }, provider: async () => { touched = true; } });
  await assert.rejects(guard({ method: 'eth_sendRawTransaction', params: [fixture.raw] }), matches('TRANSACTION_INTENT_MISMATCH'));
  assert.equal(touched, false);
});
