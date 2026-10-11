import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { ExportPacket } from '../../src/data/types';
import { TIRAMISU_CHAIN_ID } from '../../src/domain/types';
import type { SourcePlanRef } from '../../src/domain/types';
import { canonicalJson } from '../../src/domain/canonical';
import { activeSource } from '../../src/domain/readiness';
import { assertProofLineage } from './scenario';
import { ACCESS_KEY_FILE_ENV } from '../../src/cli/arkiv-rpc';

export type RunCli = (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<string>;
const runCli: RunCli = (executable, args, options) => new Promise((accept, reject) => {
  execFile(executable, args, options, (error, stdout) => error ? reject(new Error('The independent verifier did not return a verified packet.')) : accept(stdout));
});

export async function verifyInFreshProcess(expected: ExportPacket, repositoryRoot: string, expectedLineage: readonly SourcePlanRef[],
  execute: RunCli = runCli, options: { accessKeyFile?: string } = {}): Promise<ExportPacket> {
  assertProofLineage(expected.project, expectedLineage);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name];
  if (options.accessKeyFile !== undefined) env[ACCESS_KEY_FILE_ENV] = resolve(options.accessKeyFile);
  const output = await execute(process.execPath, [resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs'),
    resolve(repositoryRoot, 'src/cli/verify.ts'), expected.project.root.key, '--json', '--block', expected.snapshot.blockNumber!],
  { cwd: repositoryRoot, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  let packet: ExportPacket;
  try { packet = JSON.parse(output) as ExportPacket; } catch { throw new Error('The independent verifier output is not JSON.'); }
  if (packet.format !== 'partfolk-export' || packet.version !== 1 || packet.mode !== 'public' || packet.snapshot?.mode !== 'public' || packet.snapshot?.chainId !== TIRAMISU_CHAIN_ID
    || packet.snapshot.source !== 'arkiv' || packet.snapshot.completeness !== 'complete' || packet.snapshot.freshness !== 'fresh'
    || packet.snapshot.blockNumber !== expected.snapshot.blockNumber || packet.snapshot.blockHash !== expected.snapshot.blockHash
    || packet.snapshot.blockTimestamp !== expected.snapshot.blockTimestamp || packet.project?.root?.key !== expected.project.root.key
    || canonicalJson(packet.project.snapshot) !== canonicalJson(packet.snapshot)
    || canonicalJson(packet.readiness.snapshot) !== canonicalJson(packet.snapshot)
    || packet.project.proposal?.key !== expected.project.proposal?.key || packet.project.proposal?.payload.proposalHash !== expected.project.proposal?.payload.proposalHash
    || canonicalJson(activeSource(packet.project)) !== canonicalJson(activeSource(expected.project))
    || packet.readiness?.status !== expected.readiness.status
    || canonicalJson([...packet.readiness.acceptedApprovers].sort()) !== canonicalJson([...expected.readiness.acceptedApprovers].sort())
    || canonicalJson(packet.project.proposalHistory.map(item => [item.key, item.payload.proposalHash]))
      !== canonicalJson(expected.project.proposalHistory.map(item => [item.key, item.payload.proposalHash]))) {
    throw new Error('The independent verifier does not match the exact requested public snapshot.');
  }
  assertProofLineage(packet.project, expectedLineage);
  return packet;
}
