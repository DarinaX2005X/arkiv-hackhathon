/**
 * Read-only Arkiv SDK/RPC capability probe. No account, key, signer or write method.
 * Run: node scripts/probe-arkiv.mjs [--creator 0xPUBLIC_ADDRESS]
 * Emits JSON to stdout; diagnostics are evidence, never a substitute for write tests.
 */
import { createRequire } from 'node:module';
import {
  createPublicClient,
  decodeCreationFlags,
  encodeCreationFlags,
  ExpirationTime,
  resolveExpiry,
} from '@arkiv-network/sdk';
import { u64 } from '@arkiv-network/sdk/attr';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { eq, ne } from '@arkiv-network/sdk/query';
import { custom, isAddress, numberToHex } from 'viem';

const require = createRequire(import.meta.url);
const sdkVersion = require('@arkiv-network/sdk/package.json').version;
const RPC = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network';
const allowedMethods = new Set([
  'eth_chainId', 'eth_blockNumber', 'arkiv_getBlockTiming',
  'arkiv_query', 'arkiv_getEntityCount',
]);
const requests = [];
const MAX_REQUESTS = 12;
let rateLimited = false;

async function request({ method, params = [] }) {
  if (!allowedMethods.has(method)) throw new Error(`Read-only probe forbids ${method}`);
  if (rateLimited) throw new Error('RPC quota exhausted; no retries');
  if (requests.length >= MAX_REQUESTS) throw new Error('Probe request budget exhausted');
  const evidence = { method, id: requests.length + 1 };
  requests.push(evidence);
  const started = performance.now();
  try {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: evidence.id, method, params }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    evidence.httpStatus = response.status;
    evidence.quotaHeaders = Object.fromEntries(
      ['ratelimit', 'retry-after', 'arkiv-cost', 'arkiv-quota-used-percent']
        .map(name => [name, response.headers.get(name)])
        .filter(([, value]) => value !== null),
    );
    if (response.status === 429) rateLimited = true;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.id !== evidence.id || body.jsonrpc !== '2.0') throw new Error('Malformed RPC envelope');
    if (body.error) {
      evidence.rpcError = body.error;
      throw Object.assign(new Error(body.error.message), {
        code: body.error.code, data: body.error.data,
      });
    }
    if (!Object.hasOwn(body, 'result')) throw new Error('Missing RPC result');
    return body.result;
  } finally {
    evidence.elapsedMs = Math.round(performance.now() - started);
  }
}

const client = createPublicClient({
  chain: tiramisu,
  cacheTime: 0,
  transport: custom({ request }, { retryCount: 0 }),
});

const selection = {
  key: true, creator: true, owner: true, createdAt: true,
  expiresAt: true, creationFlags: true,
};
const report = {
  observedAt: new Date().toISOString(),
  sdkVersion,
  rpc: RPC,
  readOnly: true,
  requestBudget: MAX_REQUESTS,
  checks: {},
  requests,
  limitations: [
    'No writes were broadcast: permission enforcement is source/documentation evidence only.',
    'No UI/browser testing was performed.',
    'Short historical reads do not establish archival retention.',
    'Readonly does not prevent owner deletion or ownership transfer.',
  ],
};

function errorShape(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.shortMessage ?? error?.message ?? String(error),
    ...(error?.kind !== undefined ? { kind: error.kind } : {}),
    ...(error?.code !== undefined ? { code: error.code } : {}),
  };
}

async function check(name, operation) {
  try {
    const value = await operation();
    report.checks[name] = { status: 'passed', value };
    return value;
  } catch (error) {
    report.checks[name] = { status: 'failed', error: errorShape(error) };
    return undefined;
  }
}

try {
  const args = process.argv.slice(2);
  let creator;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--creator' || !isAddress(args[1])) {
      throw new Error('Usage: node scripts/probe-arkiv.mjs [--creator 0xPUBLIC_ADDRESS]');
    }
    creator = args[1];
  }
  const chainId = await client.getChainId();
  if (chainId !== 7738577 || chainId !== tiramisu.id) throw new Error('Wrong network');
  report.chainId = chainId;
  const block = await client.getBlockNumber({ cacheTime: 0 });
  report.snapshotBlock = block;
  await check('blockTiming', () => client.getBlockTiming());
  await check('flagsEncoding', async () => {
    const encoded = encodeCreationFlags({ readonly: true, permissionlessExtension: true });
    if (encoded !== 3) throw new Error('Unexpected creation flags encoding');
    return { raw: encoded, decoded: decodeCreationFlags(encoded), evidence: 'installed SDK only' };
  });
  await check('expirationMath', async () => ({
    fromOneHour: resolveExpiry(ExpirationTime.fromHours(1), { currentBlock: block }),
    addOneHourToExisting: resolveExpiry(ExpirationTime.atBlock(block + 3600n + 1800n), { currentBlock: block }),
    nominalSecondsPerBlock: 2,
    evidence: 'installed SDK only; no lifetime extension broadcast',
  }));
  await check('typedTimestamp', async () => ({
    value: u64(Date.now()),
    evidence: 'installed SDK constructor; millisecond timestamps must not be bare i32 numbers',
  }));
  await check('pageLimitValidation', async () => {
    const before = requests.length;
    try {
      await client.select({ key: true }).where(eq('project', 'arkiv_hackathon_capability_probe_v1'))
        .atBlock(block).limit(201).fetch();
      throw new Error('SDK unexpectedly accepted page size 201');
    } catch (error) {
      if (requests.length !== before || !error?.message?.includes('exceeds the node maximum of 200')) throw error;
      return { maxPageSize: 200, rejectedPageSize: 201, networkRequests: 0, message: error.message };
    }
  });
  const scoped = client.select(selection)
    .where(eq('project', 'arkiv_hackathon_capability_probe_v1'))
    .atBlock(block).limit(1);
  await check('scopedSdkQuery', async () => {
    const page = await scoped.fetch();
    if (page.blockNumber !== block) throw new Error('Snapshot mismatch');
    return { query: scoped.toString(), blockNumber: page.blockNumber, rows: page.entities.length, hasNextPage: page.hasNextPage() };
  });
  await check('filteredCount', async () => {
    if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe JSON block number');
    const count = await request({ method: 'arkiv_getEntityCount', params: [{ query: scoped.toString(), block: Number(block) }] });
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid filtered count');
    return { count, atBlock: block };
  });
  if (!creator) {
    const sample = await check('recentMetadataSample', async () => {
      const fromBlock = block > 43200n ? block - 43200n : 0n;
      const query = `$createdAt >= u64(${fromBlock}) AND $createdAt <= u64(${block})`;
      const result = await request({ method: 'arkiv_query', params: [query, {
        select: selection, limit: '0x1', atBlock: numberToHex(block),
      }] });
      if (!Array.isArray(result?.data) || result.data.length > 1) throw new Error('Invalid sample response');
      if (BigInt(result.blockNumber) !== block) throw new Error('Snapshot mismatch');
      return { query, blockNumber: result.blockNumber, entity: result.data[0] ?? null };
    });
    creator = sample?.entity?.creator;
  }
  if (creator) {
    await check('pinnedPagination', async () => {
      let page = await client.select(selection).createdBy(creator).atBlock(block).limit(1).fetch();
      const pages = [];
      for (let index = 0; index < 2; index++) {
        if (page.blockNumber !== block) throw new Error('Pagination snapshot changed');
        pages.push({ blockNumber: page.blockNumber, entities: page.entities, hasNextPage: page.hasNextPage() });
        if (!page.hasNextPage() || index === 1) break;
        page = await page.next();
      }
      const keys = pages.flatMap(item => item.entities.map(entity => entity.key));
      if (new Set(keys).size !== keys.length) throw new Error('Duplicate key across pages');
      return { creator, pages, secondPageObserved: pages.length === 2, complete: !pages.at(-1).hasNextPage };
    });
  } else {
    report.checks.pinnedPagination = { status: 'unobserved', reason: 'No recent entity; rerun with a known public creator address.' };
  }
  await check('unsupportedNotEqualObservation', async () => {
    try {
      await client.select({ key: true })
        .where(eq('project', 'arkiv_hackathon_capability_probe_v1'), ne('entity_type', 'probe'))
        .atBlock(block).limit(1).fetch();
      return { nodeAccepted: true };
    } catch (error) {
      if (error?.kind !== 'type') throw error;
      return { nodeAccepted: false, error: errorShape(error) };
    }
  });
} catch (error) {
  report.fatalError = errorShape(error);
  process.exitCode = 1;
}

if (Object.values(report.checks).some(item => item.status === 'failed')) process.exitCode = 1;
console.log(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
