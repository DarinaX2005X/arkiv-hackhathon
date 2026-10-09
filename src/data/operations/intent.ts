import { canonicalJson, hashCanonical } from '../../domain/canonical';
import type { EntityKey, JsonValue } from '../../domain/types';
import type { OperationIntent, OperationKind, OperationPhase, OperationStep, WriteAuthority } from '../types';

export function assertOperationId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new TypeError('Invalid operation ID.');
}

/** Canonical JSON is also the clone boundary: callers cannot change a prepared intent. */
export function createOperationIntent(
  kind: OperationKind,
  authority: WriteAuthority,
  inputWithoutOperation: unknown,
  options: { id?: string; now?: number } = {},
): OperationIntent {
  const id = options.id ?? globalThis.crypto.randomUUID();
  assertOperationId(id);
  const input = JSON.parse(canonicalJson(inputWithoutOperation)) as JsonValue;
  if (input === null || Array.isArray(input) || typeof input !== 'object' || 'operation' in input) {
    throw new TypeError('Operation input must be a command object without an operation field.');
  }
  const rejectSecrets = (value: JsonValue): void => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (/^(private_?key|mnemonic|seed_?phrase|secret_?key|signing_?key)$/i.test(key)) {
        throw new TypeError('Signing secrets cannot be stored in an operation.');
      }
      rejectSecrets(entry);
    }
  };
  rejectSecrets(input);
  const expectedHeads: EntityKey[] = [];
  for (const name of ['expectedHeads', 'expectedBookHeads', 'expectedActivationHeads']) {
    const heads = input[name];
    if (heads === undefined) continue;
    if (!Array.isArray(heads) || heads.some(key => typeof key !== 'string' || !/^(0x[\da-fA-F]{64}|local:.+)$/.test(key))) {
      throw new TypeError('Expected predecessor keys are invalid.');
    }
    expectedHeads.push(...heads as EntityKey[]);
  }
  const createdAt = options.now ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Invalid operation timestamp.');
  return {
    id, kind, authority: JSON.parse(canonicalJson(authority)) as WriteAuthority,
    createdAt, input, inputHash: hashCanonical(input), expectedHeads: [...new Set(expectedHeads)].sort(),
    phase: 'prepared', transactionHash: null, confirmedKeys: [], pendingPublisherRoots: [], steps: [],
  };
}

/** Call once per phase and retain the returned step, including its ID, when resuming. */
export function allocateOperationStep(
  operation: OperationIntent, phase: OperationPhase, input: unknown,
  expectedHeads: EntityKey[] = [], publisherRoot?: EntityKey,
): OperationStep {
  assertOperationId(operation.id);
  return {
    id: globalThis.crypto.randomUUID(), phase, status: 'prepared', transactionHash: null,
    confirmedKeys: [], expectedHeads: [...expectedHeads], inputHash: hashCanonical(input),
    ...(publisherRoot === undefined ? {} : { publisherRoot }),
  };
}
