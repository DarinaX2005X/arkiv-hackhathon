import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { key } from '@arkiv-network/sdk/attr';
import { eq } from '@arkiv-network/sdk/query';
import { deriveReadiness } from '../domain/readiness';
import type { ExportPacket, ReadOptions } from '../data/types';
import { TIRAMISU_CHAIN_ID } from '../domain/types';
import { ArkivReader } from '../data/arkiv/reader';
import { publicKey, sameIdentity } from '../data/arkiv/envelope';
import { repositoryError, assertArkiv } from '../data/arkiv/errors';

const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
const CAPABILITIES = {
  bootstrap: { key: '0xfadef279e9b79b91409a85ba941aa5b03e7f7e48ee3cab28e97c0d3fa8d25050', namespace: 'arkiv_hackathon_capability_probe_v1' },
  atomic: { key: '0x5f29b503534f990b2dbbbe81f027c121379ebf1a3488fbac964880f547ec12f0', namespace: 'convene_atomic_feasibility_v1' },
} as const;
const CAPABILITY_CREATOR = '0x6267ab770266da229130a2a75a52a9d578fb0a5b';

export async function verifyProject(reader: ArkivReader, root: string, options?: ReadOptions): Promise<ExportPacket> {
  const project = await reader.loadProject(publicKey(root), options);
  return { format: 'partfolk-export', version: 1, exportedAt: reader.now(), mode: 'public', project,
    readiness: deriveReadiness(project, reader.now()), snapshot: project.snapshot };
}

/** Explicitly named feasibility records are not interpreted as Partfolk projects. */
export async function inspectCapability(reader: ArkivReader, name: string): Promise<unknown> {
  assertArkiv(name === 'bootstrap' || name === 'atomic', 'invalid_input', 'invalid_input', 'Choose bootstrap or atomic capability evidence.');
  const expected = CAPABILITIES[name]; const context = await reader.context();
  const rows = await reader.query(context, [eq('$key', key(expected.key))], undefined, true);
  assertArkiv(rows.length === 1, 'not_found', 'evidence_unavailable', 'The feasibility entity is no longer live.');
  const entity = rows[0]!;
  assertArkiv(sameIdentity(entity.creator, CAPABILITY_CREATOR) && sameIdentity(entity.owner, CAPABILITY_CREATOR)
    && entity.creationFlags?.raw === 1 && entity.contentType === 'application/json'
    && entity.attributes?.project?.type === 'str' && entity.attributes.project.value === expected.namespace
    && entity.expiresAt !== undefined && entity.expiresAt > BigInt(context.snapshot.blockNumber!),
    'unverified', 'projection_mismatch', 'The live feasibility record differs from the recorded identity.');
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entity.payload)); }
  catch { throw new Error('The feasibility payload is unavailable.'); }
  assertArkiv(payload && typeof payload === 'object' && 'synthetic' in payload && payload.synthetic === true,
    'unverified', 'invalid_schema', 'The expected synthetic feasibility marker is missing.');
  await reader.finish(context);
  return { evidenceKind: 'sdk-feasibility-only', productProof: false, name, snapshot: context.snapshot,
    key: entity.key, creator: entity.creator, owner: entity.owner, flags: entity.creationFlags,
    createdAtBlock: entity.createdAt?.toString(), expiresAtBlock: entity.expiresAt.toString(), attributes: entity.attributes, payload };
}

export async function runCli(args: string[], output: (text: string) => void = console.log): Promise<number> {
  const usage = 'Usage: node node_modules/tsx/dist/cli.mjs src/cli/verify.ts <project-root> [--json] [--block <number>] [--export <file>]\n       node node_modules/tsx/dist/cli.mjs src/cli/verify.ts --inspect-capability bootstrap|atomic [--json]\n--block verifies a dated historical snapshot, not current readiness.';
  if (!args.length || args.includes('--help')) { output(usage); return args.length ? 0 : 2; }
  const reader = new ArkivReader();
  try {
    if (args[0] === '--inspect-capability') {
      assertArkiv(args.length >= 2 && args.slice(2).every(arg => arg === '--json'), 'invalid_input', 'invalid_input', usage);
      output(json(await inspectCapability(reader, args[1]!))); return 0;
    }
    const root = args[0]!; let jsonOutput = false; let exportPath: string | undefined; let requestedBlock: bigint | undefined;
    for (let index = 1; index < args.length; index++) {
      if (args[index] === '--json') jsonOutput = true;
      else if (args[index] === '--block' && /^\d+$/.test(args[index + 1] ?? '')) requestedBlock = BigInt(args[++index]!);
      else if (args[index] === '--export' && args[index + 1]) exportPath = resolve(args[++index]!);
      else throw new Error(usage);
    }
    let options: ReadOptions | undefined;
    if (requestedBlock !== undefined) {
      const block = await reader.client.getBlock({ blockNumber: requestedBlock });
      assertArkiv(block.number === requestedBlock && block.hash, 'unverified', 'incomplete_snapshot', 'The requested historical block is unavailable.');
      options = { snapshot: { mode: 'public', source: 'arkiv', chainId: TIRAMISU_CHAIN_ID, blockNumber: requestedBlock.toString() as `${bigint}`,
        blockHash: block.hash, blockTimestamp: Number(block.timestamp * 1_000n), fetchedAt: reader.now(), completeness: 'complete', freshness: 'fresh', reasons: [] } };
    }
    const packet = await verifyProject(reader, root, options);
    if (exportPath) await writeFile(exportPath, `${json(packet)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (jsonOutput) output(json(packet));
    else {
      const title = packet.project.proposal?.payload.plan.outcome
        ?? (packet.project.state.status === 'unique' ? packet.project.state.entity.payload.recipe.title : 'Project');
      output(`${title}\nAgreement${requestedBlock !== undefined ? ' at requested block' : ''}: ${packet.readiness.status}\nLifecycle: ${packet.readiness.lifecycle}\nArkiv block: ${packet.snapshot.blockNumber}\nBlock time: ${new Date(packet.snapshot.blockTimestamp).toISOString()}\nApprovals: ${packet.readiness.acceptedApprovers.length}/${packet.readiness.requiredApprovers.length}\nHistory: ${packet.project.proposalHistoryStatus?.complete === false ? 'contains gaps' : 'complete within the verified lineage'}\nReasons: ${packet.readiness.reasons.map(reason => reason.code).join(', ') || 'none'}${exportPath ? `\nExport: ${exportPath}` : ''}\nSource: direct official Tiramisu RPC; no Studio server or browser cache.`);
    }
    return packet.readiness.status === 'unverified' ? 1 : 0;
  } catch (error) {
    output(json({ status: 'unverified', error: repositoryError(error), source: 'direct official Tiramisu RPC' })); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
