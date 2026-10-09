import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData, encodeErrorResult, parseAbi, parseAbiParameters } from 'viem';
import { BootstrapError, CHAIN_ID, CREATOR, parameterFingerprint } from '../scripts/first-write.mjs';
import { assertOnlyState, assertProbeFunding, estimateBatch, exactMissingEntity,
  PROBE_CAP, stateParameters } from '../scripts/probe-atomic-transition.mjs';

const createdAt = 1791555000000n;
const aKey = `0x${'11'.repeat(32)}`;
const bKey = `0x${'22'.repeat(32)}`;
const missingAbi = parseAbi(['error EntityNotFound(bytes32 entityKey)']);
const missingData = encodeErrorResult({ abi: missingAbi, errorName: 'EntityNotFound', args: [aKey] });
const matches = code => error => error instanceof BootstrapError && error.code === code;
const fees = { nonce: 2, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n };

test('frozen states have distinct fingerprints, readonly flags and seven-day lifetime', () => {
  const parameters = ['A', 'B', 'C'].map(state => stateParameters(state, createdAt));
  assert.equal(new Set(parameters.map(item => parameterFingerprint(item))).size, 3);
  for (const item of parameters) {
    assert.deepEqual(item.flags, { readonly: true, permissionlessExtension: false });
    assert.equal(item.expires.minLifetime, 302400n);
    assert.equal(item.salt, 0n);
  }
  assert.throws(() => stateParameters('D', createdAt), matches('INVALID_PROBE_PARAMETERS'));
});

test('real SDK serializes create before exact-key delete and estimate cannot send', async () => {
  const methods = [];
  const batch = { creates: [stateParameters('B', createdAt)], deletes: [{ entityKey: aKey }] };
  const estimated = await estimateBatch(batch, fees, async args => {
    methods.push(args.method);
    if (args.method === 'eth_blockNumber') return '0x64';
    if (args.method === 'eth_chainId') return `0x${CHAIN_ID.toString(16)}`;
    if (args.method === 'eth_estimateGas') return '0x186a0';
    throw Error('Unexpected fixture RPC method');
  });
  assert.equal(estimated.status, 'estimated');
  assert.equal(estimated.gas, 100000n);
  const decoded = decodeFunctionData({ abi: parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']), data: estimated.input });
  assert.deepEqual(decoded.args[0].map(op => op.operation), [1, 5]);
  assert.equal(decodeAbiParameters(parseAbiParameters('bytes32'), decoded.args[0][1].operationData)[0], aKey);
  const [create] = decodeAbiParameters(parseAbiParameters('(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)'), decoded.args[0][0].operationData);
  assert.equal(create.creationFlags, 1);
  assert.equal(create.minLifetime, 302400n);
  assert.equal(methods.at(-1), 'eth_estimateGas');
  assert.ok(methods.every(method => ['eth_blockNumber', 'eth_chainId', 'eth_estimateGas'].includes(method)));
});

test('exact missing-key custom error is recognized through RPC cause wrapping', () => {
  assert.equal(exactMissingEntity({ cause: { data: missingData } }, aKey), missingData);
  assert.equal(exactMissingEntity({ data: { data: missingData } }, aKey), missingData);
  assert.equal(exactMissingEntity({ data: missingData }, bKey), undefined);
  assert.equal(exactMissingEntity(Error('EntityNotFound'), aKey), undefined);
  assert.equal(exactMissingEntity({ data: '0x1234' }, aKey), undefined);
});

test('stale SDK estimate counts only the exact decoded missing-A failure', async () => {
  const methods = [];
  const result = await estimateBatch({ creates: [stateParameters('C', createdAt)], deletes: [{ entityKey: aKey }] }, fees, async args => {
    methods.push(args.method);
    if (args.method === 'eth_blockNumber') return '0x64';
    if (args.method === 'eth_chainId') return `0x${CHAIN_ID.toString(16)}`;
    if (args.method === 'eth_estimateGas') throw Object.assign(new Error('execution reverted'), { code: 3, data: missingData });
    throw Error('Unexpected fixture RPC method');
  }, aKey);
  assert.deepEqual(result, { status: 'rejected_missing_entity', entityKey: aKey, revertData: missingData });
  assert.ok(!methods.some(method => method.includes('send')));
});

test('generic RPC outages and wrong missing key never become passing stale evidence', async () => {
  for (const failure of [Error('provider unavailable'), Object.assign(Error('execution reverted'), { code: 3,
    data: encodeErrorResult({ abi: missingAbi, errorName: 'EntityNotFound', args: [bKey] }) })]) {
    await assert.rejects(estimateBatch({ creates: [stateParameters('C', createdAt)], deletes: [{ entityKey: aKey }] }, fees, async ({ method }) => {
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_chainId') return `0x${CHAIN_ID.toString(16)}`;
      throw failure;
    }, aKey), matches('BATCH_ESTIMATE_FAILED'));
  }
});

test('estimate rejects gas override because it would bypass the capture guard', async () => {
  let called = false;
  await assert.rejects(estimateBatch({ creates: [stateParameters('A', createdAt)] }, { ...fees, gas: 100000n },
    async () => { called = true; }), matches('ESTIMATE_MUST_NOT_HAVE_GAS_OVERRIDE'));
  assert.equal(called, false);
});

test('probe and global aggregate budgets both apply, including previous phase spend', () => {
  const budget = { balance: 10n ** 18n, bootstrapSpent: 101712000203424n,
    probeSpent: PROBE_CAP - 200n, gas: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  assert.equal(assertProbeFunding(budget), 200n);
  assert.throws(() => assertProbeFunding({ ...budget, probeSpent: PROBE_CAP - 199n }), matches('PROBE_BUDGET_EXCEEDED'));
  assert.throws(() => assertProbeFunding({ ...budget, bootstrapSpent: 100_000_000_000_000_000n }), matches('APPROVED_BUDGET_EXCEEDED'));
  assert.throws(() => assertProbeFunding({ ...budget, balance: 199n }), matches('INSUFFICIENT_TEST_GLM'));
});

function bEntity() {
  const parameters = stateParameters('B', createdAt);
  return { key: bKey, creator: CREATOR, owner: CREATOR, payload: parameters.payload, contentType: parameters.contentType,
    creationFlags: { raw: 1, readonly: true, permissionlessExtension: false }, createdAt: 100n, expiresAt: 302500n,
    attributes: Object.fromEntries(Object.entries(parameters.attributes).map(([name, value]) => [name,
      typeof value === 'string' ? { type: 'str', value } : value])) };
}
test('readback requires exactly B; stale A, phantom C, duplicate heads and wrong provenance fail', () => {
  const parameters = stateParameters('B', createdAt);
  const entity = bEntity();
  assert.doesNotThrow(() => assertOnlyState([entity], 'B', parameters, bKey, 100n));
  for (const entities of [[], [entity, { ...entity, key: aKey }], [entity, entity, entity]]) {
    assert.throws(() => assertOnlyState(entities, 'B', parameters, bKey, 100n), matches('UNEXPECTED_PROBE_LIVE_STATES'));
  }
  assert.throws(() => assertOnlyState([{ ...entity, key: aKey }], 'B', parameters, bKey, 100n), matches('STATE_PROVENANCE_MISMATCH'));
  assert.throws(() => assertOnlyState([{ ...entity, creator: '0x4400000000000000000000000000000000000044' }], 'B', parameters, bKey, 100n), matches('STATE_PROVENANCE_MISMATCH'));
  assert.throws(() => assertOnlyState([{ ...entity, payload: new Uint8Array() }], 'B', parameters, bKey, 100n), matches('STATE_PAYLOAD_MISMATCH'));
  assert.throws(() => assertOnlyState([entity], 'B', parameters, bKey, entity.expiresAt), matches('STATE_EXPIRY_MISMATCH'));
});
