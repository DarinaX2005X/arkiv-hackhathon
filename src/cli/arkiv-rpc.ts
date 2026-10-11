/** Node-only operator transport. Never import this module from a browser entry point. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OFFICIAL_RPC } from '../data/arkiv/client';
import type { RpcRequest } from '../data/arkiv/client';

export const ACCESS_KEY_FILE_ENV = 'ARKIV_ACCESS_KEY_FILE';

/** No original exception, response body, headers or request is retained on this error. */
export class OperatorRpcError extends Error {
  constructor(message: 'ARKIV_ACCESS_KEY_FILE_INVALID' | 'ARKIV_OPERATOR_RPC_FAILED',
    readonly status?: number, readonly code?: number) {
    super(message); this.name = 'OperatorRpcError';
  }
}

export interface OperatorRpcOptions {
  accessKeyFile?: string;
  /** Only operator runners opt into repository-local discovery; the verifier never does. */
  autoDetectDirectory?: string;
}

export function createOperatorRpc(options: OperatorRpcOptions = {}): { request: RpcRequest; accessKeyFile: string | null } {
  let accessKeyFile: string | null = null;
  let accessKey: string | undefined;
  const explicit = options.accessKeyFile !== undefined;
  if (explicit || options.autoDetectDirectory !== undefined) {
    try {
      if (explicit && !options.accessKeyFile!.trim()) throw new Error();
      const candidate = explicit ? resolve(options.accessKeyFile!) : resolve(options.autoDetectDirectory!, '.local/arkiv-access-key.txt');
      let contents: string;
      try { contents = readFileSync(candidate, 'utf8'); }
      catch (error) {
        if (!explicit && (error as NodeJS.ErrnoException).code === 'ENOENT') contents = '';
        else throw error;
        // A missing optional file is anonymous; an existing empty file is invalid.
        return anonymous();
      }
      // One printable ASCII token, with optional surrounding horizontal space and one final newline.
      if (!/^[ \t]*[\x21-\x7e]{1,1024}[ \t]*(?:\r?\n)?$/.test(contents)) throw new Error();
      accessKey = contents.trim(); accessKeyFile = candidate;
    } catch { throw new OperatorRpcError('ARKIV_ACCESS_KEY_FILE_INVALID'); }
  }
  return transport(accessKey, accessKeyFile);
}

function anonymous() { return transport(undefined, null); }

function transport(accessKey: string | undefined, accessKeyFile: string | null): { request: RpcRequest; accessKeyFile: string | null } {
  let sequence = 0;
  const request: RpcRequest = async ({ method, params = [] }) => {
    const id = ++sequence;
    try {
      const response = await fetch(OFFICIAL_RPC, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(accessKey ? { 'X-API-KEY': accessKey } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new OperatorRpcError('ARKIV_OPERATOR_RPC_FAILED', response.status);
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OperatorRpcError('ARKIV_OPERATOR_RPC_FAILED');
      const envelope = body as { jsonrpc?: unknown; id?: unknown; error?: { code?: unknown }; result?: unknown };
      if (envelope.jsonrpc !== '2.0' || envelope.id !== id) throw new OperatorRpcError('ARKIV_OPERATOR_RPC_FAILED');
      if (envelope.error) throw new OperatorRpcError('ARKIV_OPERATOR_RPC_FAILED', undefined,
        typeof envelope.error.code === 'number' && Number.isSafeInteger(envelope.error.code) ? envelope.error.code : undefined);
      if (!Object.hasOwn(envelope, 'result')) throw new OperatorRpcError('ARKIV_OPERATOR_RPC_FAILED');
      return envelope.result;
    } catch (error) {
      if (error instanceof OperatorRpcError) throw error;
      throw new OperatorRpcError('ARKIV_OPERATOR_RPC_FAILED');
    }
  };
  return { request, accessKeyFile };
}
