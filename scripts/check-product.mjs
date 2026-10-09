import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const checks = [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['node_modules/vitest/vitest.mjs', 'run'],
  ['--test', 'tests/first-write.test.mjs', 'tests/atomic-transition.test.mjs'],
  ['node_modules/vite/bin/vite.js', 'build'],
  ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.desk.config.ts'],
];
for (const args of checks) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
