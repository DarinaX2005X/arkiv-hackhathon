import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Node/Vite config only. Neither the token nor this module is imported by browser code. */
export function localReadAccessKey(root: string): string | undefined {
  let token = process.env.ARKIV_RPC_ACCESS_KEY;
  if (token === undefined) {
    try { token = readFileSync(resolve(root, '.local/arkiv-access-key.txt'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('The local Arkiv read credential could not be loaded.');
    }
  }
  if (!/^[ \t]*[\x21-\x7e]{1,1024}[ \t]*(?:\r?\n)?$/.test(token)) {
    throw new Error('The local Arkiv read credential is invalid.');
  }
  return token.trim();
}
