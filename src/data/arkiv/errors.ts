import type { DomainReason, ReasonCode } from '../../domain/types';
import type { RepositoryError, RepositoryErrorCode, Result } from '../types';
import { WalletOperationError } from '../wallet/types';

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

export function repositoryError(error: unknown): RepositoryError {
  if (error instanceof ArkivRepositoryError) return error.detail;
  let current: unknown = error;
  for (let depth = 0; current && depth < 12; depth++) {
    if (typeof current !== 'object') break;
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
      code: 'rate_limited', reasons: [{ code: 'rpc_error' }], retryable: true, diagnostic: 'The Arkiv provider rate limit was reached.' };
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
