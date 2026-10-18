import type { DomainReason, ReasonCode } from '../../domain/types';
import type { RepositoryError, RepositoryErrorCode, Result } from '../types';
import { WalletOperationError } from '../wallet/types.js';

export class ArkivRepositoryError extends Error {
  readonly detail: RepositoryError;
  constructor(code: RepositoryErrorCode, reason: ReasonCode, diagnostic: string, retryable = false, reasons?: DomainReason[]) {
    super(diagnostic); this.name = 'ArkivRepositoryError';
    this.detail = { code, reasons: reasons ?? [{ code: reason }], retryable, diagnostic };
  }
}

export function assertArkiv(condition: unknown, code: RepositoryErrorCode, reason: ReasonCode, diagnostic: string): asserts condition {
  if (!condition) throw new ArkivRepositoryError(code, reason, diagnostic);
}

/** Only an explicit response bound permits the page walker to reduce its page size. */
export function readResponseTooLarge(error: unknown): boolean {
  let current: unknown = error; const seen = new Set<unknown>();
  for (let depth = 0; current && typeof current === 'object' && depth < 12 && !seen.has(current); depth++) {
    seen.add(current);
    const item = current as { name?: unknown; status?: unknown; statusCode?: unknown; headers?: unknown; cause?: unknown };
    if (item.name === 'ResponseBodyTooLargeError') return true;
    if ((item.status === 413 || item.statusCode === 413) && item.headers && typeof item.headers === 'object') {
      const headers = item.headers as { get?: (name: string) => unknown };
      const reason = typeof headers.get === 'function' ? headers.get('x-arkiv-read-error')
        : Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-arkiv-read-error')?.[1];
      if (reason === 'response_too_large') return true;
    }
    current = item.cause;
  }
  return false;
}

export function repositoryError(error: unknown): RepositoryError {
  if (error instanceof ArkivRepositoryError) return error.detail;
  let current: unknown = error;
  for (let depth = 0; current && depth < 12; depth++) {
    if (typeof current !== 'object') break;
    if (current instanceof ArkivRepositoryError) return current.detail;
    if (current instanceof WalletOperationError) {
      const messages: Record<RepositoryErrorCode, string> = {
        invalid_input: 'The prepared transaction input is invalid.',
        unauthorized: 'This wallet cannot perform the requested change.',
        wrong_chain: 'Switch the connected wallet to Arkiv Tiramisu.',
        not_connected: 'Reconnect the wallet before preparing another transaction.',
        not_found: 'The saved operation could not be found.',
        conflict: 'Another wallet operation is already in progress.',
        stale_heads: 'The expected state changed. Refresh it before preparing a new operation.',
        expired: 'The operation refers to expired state.',
        incomplete: 'The operation could not be completely verified.',
        network: 'The wallet or RPC could not complete this request.',
        rate_limited: 'The provider rate limit was reached.',
        insufficient_funds: 'This wallet needs test GLM on Arkiv Tiramisu to cover the estimated network fee.',
        rejected: 'The wallet request was rejected. No transaction was submitted.',
        reverted: 'The transaction reverted. No entity changes were applied; gas may have been spent.',
        storage: 'The operation journal could not be saved. Retain the original operation for verification.',
        payload_too_large: 'The operation exceeds the supported payload size.',
        unverified: 'The transaction outcome is uncertain. Reconcile the original operation before another submission.',
        unsupported: 'This wallet or browser does not support the required operation.',
      };
      const code = Object.hasOwn(messages, current.code) ? current.code : 'unverified';
      const reason: ReasonCode = code === 'wrong_chain' || code === 'not_connected' ? 'invalid_identity'
        : code === 'unauthorized' ? 'foreign_author' : code === 'expired' ? 'expired'
          : code === 'unsupported' ? 'unsupported' : code === 'payload_too_large' ? 'payload_too_large'
            : code === 'network' || code === 'rate_limited' ? 'rpc_error'
              : code === 'invalid_input' || code === 'conflict' ? 'invalid_input' : 'evidence_unavailable';
      return { code, reasons: [{ code: reason }], retryable: current.kind === 'not_sent' && (code === 'network' || code === 'rate_limited'),
        diagnostic: messages[code] };
    }
    const item = current as { kind?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    if (item.kind === 'cursor' || item.code === -32005) return {
      code: 'incomplete', reasons: [{ code: 'cursor_error' }], retryable: true, diagnostic: 'The query cursor could not be completed.' };
    if (item.kind === 'block' || item.code === -32006) return {
      code: 'unverified', reasons: [{ code: 'incomplete_snapshot' }], retryable: false, diagnostic: 'The requested block is unavailable from this provider.' };
    if (item.status === 429 || item.statusCode === 429) return {
      code: 'rate_limited', reasons: [{ code: 'rpc_error' }], retryable: true, diagnostic: 'The network needs a moment. Wait briefly, then refresh.' };
    if (item.status === 401 || item.statusCode === 401 || item.status === 403 || item.statusCode === 403) return {
      code: 'network', reasons: [{ code: 'rpc_error' }], retryable: false, diagnostic: 'The public reading service is unavailable. Try again later.' };
    if ((typeof item.status === 'number' && item.status >= 400 && item.status < 500)
      || (typeof item.statusCode === 'number' && item.statusCode >= 400 && item.statusCode < 500)
      || ['parse', 'type', 'literal', 'limits'].includes(String(item.kind))
      || (typeof item.code === 'number' && [-32600, -32601, -32602, -32001, -32002, -32003, -32004].includes(item.code))) return {
      code: 'unverified', reasons: [{ code: 'rpc_error' }], retryable: false, diagnostic: 'This information could not be checked safely. Please try again later.' };
    current = item.cause;
  }
  // Never expose SDK errors: they may embed complete payloads or wallet request material.
  return { code: 'network', reasons: [{ code: 'rpc_error' }], retryable: true, diagnostic: 'Arkiv could not verify this operation. Retain the original operation and retry its reconciliation.' };
}

export async function asResult<T>(task: () => Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await task() }; }
  catch (error) { return { ok: false, error: repositoryError(error) }; }
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const error = new ArkivRepositoryError(result.error.code, result.error.reasons[0]?.code ?? 'rpc_error',
    result.error.diagnostic ?? 'The repository operation could not be verified.', result.error.retryable, result.error.reasons);
  throw error;
}
