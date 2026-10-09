import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Local development only. This command never broadcasts or prints a signing key.
const directory = resolve(import.meta.dirname, '../.local');
const path = resolve(directory, 'demo-wallet.json');
await mkdir(directory, { recursive: true });
let wallet;
try {
  wallet = JSON.parse(await readFile(path, 'utf8'));
  if (privateKeyToAccount(wallet.privateKey).address !== wallet.address) {
    throw new Error('Local wallet failed its consistency check. No replacement was made.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Cannot safely read the local demo wallet. No replacement was made.');
  const privateKey = generatePrivateKey();
  wallet = { network: 'tiramisu', chainId: 7738577, address: privateKeyToAccount(privateKey).address, privateKey };
  await writeFile(path, JSON.stringify(wallet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ chainId: wallet.chainId, address: wallet.address, localKeyFile: '.local/demo-wallet.json', fundsSpent: '0', faucet: 'https://hub.arkiv.network/faucet' }, null, 2));
