import { ENTITY_EVENTS_ABI, ExpirationTime } from '@arkiv-network/sdk';
import type { Entity } from '@arkiv-network/sdk';
import { eq, } from '@arkiv-network/sdk/query';
import { key } from '@arkiv-network/sdk/attr';
import { decodeEventLog } from 'viem';
import { canonicalJson } from '../../domain/canonical';
import type { AccountAddress, EntityKey, EntityPayload, EntityProvenance, EntityRecord, PublicEntityKey, Snapshot, TransactionHash } from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { OperationReceipt } from '../types';
import type { StoredOperationStep } from '../operations';
import type { NativeAttribute, NativeBatch } from '../wallet';
import { ARKIV_ADDRESS } from './client';
import { assertArkiv, ArkivRepositoryError } from './errors';
import { decodeEntity, entityType, NAMESPACE, payloadAttributes, publicAddress, publicKey, sameIdentity, validatePayloadForNetwork } from './envelope';
import type { ArkivReader, ReadContext } from './reader';

/** An extension changes its payload codec; transaction and provenance verification stay identical. */
export interface VerificationRecord { key: EntityKey; payload: { entityType: string }; provenance: EntityProvenance }
export interface VerificationCodec<R extends VerificationRecord> {
  namespace: string;
  validate(value: unknown): R['payload'];
  decode(raw: Entity, snapshot: Snapshot, creator: AccountAddress, expectedKey?: PublicEntityKey): R;
  read(reader: ArkivReader, context: ReadContext, entityKey: PublicEntityKey, payload: R['payload'], creator: AccountAddress): Promise<R | null>;
}
const CORE_CODEC: VerificationCodec<EntityRecord> = {
  namespace: NAMESPACE, validate: validatePayloadForNetwork,
  decode: (raw, snapshot, creator, expectedKey) => decodeEntity(raw, entityType(raw.attributes?.entity_type?.value), snapshot, creator, expectedKey),
  read: (reader, context, entityKey, payload, creator) => reader.entity(context, entityKey, payload.entityType, creator),
};

export function nativeCreate(payloadInput: EntityPayload, lifetimeSeconds: number): NonNullable<NativeBatch['creates']>[number] {
  const payload = validatePayloadForNetwork(payloadInput);
  const attributes: Record<string, NativeAttribute> = {};
  for (const [name, input] of Object.entries(payloadAttributes(payload))) {
    if (typeof input === 'string') { attributes[name] = { type: 'str', value: input }; continue; }
    assertArkiv(input && typeof input === 'object' && 'type' in input && 'value' in input, 'invalid_input', 'invalid_schema', 'Unsupported indexed value.');
    if (input.type === 'u64') attributes[name] = { type: 'u64', value: input.value.toString() as `${bigint}` };
    else if (input.type === 'i32') attributes[name] = { type: 'i32', value: input.value };
    else if (input.type === 'key' || input.type === 'bytes32') attributes[name] = { type: input.type, value: input.value };
    else if (input.type === 'str') attributes[name] = { type: 'str', value: input.value };
    else throw new ArkivRepositoryError('invalid_input', 'invalid_schema', 'The payload uses an unsupported indexed type.');
  }
  return { payloadJson: canonicalJson(payload), attributes, lifetimeSeconds, salt: '0' };
}

async function recoverHash<R extends VerificationRecord>(reader: ArkivReader, record: StoredOperationStep, codec: VerificationCodec<R>): Promise<TransactionHash | null> {
  if (record.submissionHash) return record.submissionHash;
  if (record.step.transactionHash) return record.step.transactionHash;
  if (!record.admission || !record.prepared || !record.batch.creates?.length) return null;
  const context = await reader.context();
  const rows = await reader.query(context, [eq('project', codec.namespace), eq('operation_id', record.step.id)], record.prepared.account);
  if (!rows.length) return null; // Absence cannot establish that an admitted send never happened.
  assertArkiv(rows.length === record.batch.creates.length, 'unverified', 'conflicting_heads', 'The operation ID has ambiguous creation results.');
  const expectedPayloads = record.batch.creates.map(create => create.payloadJson).sort();
  const actualPayloads: string[] = [];
  for (const row of rows) {
    actualPayloads.push(canonicalJson(codec.decode(row, context.snapshot, record.prepared.account).payload));
  }
  assertArkiv(canonicalJson(actualPayloads.sort()) === canonicalJson(expectedPayloads), 'unverified', 'projection_mismatch', 'The operation ID was found with different content.');
  const firstBlock = rows[0]!.createdAt!;
  assertArkiv(rows.every(row => row.createdAt === firstBlock), 'unverified', 'conflicting_heads', 'The operation ID appears in multiple creation blocks.');
  const event = ENTITY_EVENTS_ABI.find(item => item.name === 'EntityCreated')!;
  const logs = await reader.client.getLogs({ address: ARKIV_ADDRESS, event, args: { owner: record.prepared.account },
    fromBlock: firstBlock, toBlock: firstBlock });
  const keys = new Set(rows.map(row => publicKey(row.key)));
  const hashes = new Set(logs.filter(log => typeof log.args.entityKey === 'string' && keys.has(publicKey(log.args.entityKey)))
    .map(log => log.transactionHash).filter((hash): hash is TransactionHash => hash !== null));
  assertArkiv(hashes.size === 1, 'unverified', 'evidence_unavailable', 'The operation creation could not be linked to one transaction.');
  await reader.finish(context);
  return [...hashes][0]!;
}

export interface VerifiedStep<R extends VerificationRecord = EntityRecord> { receipt: OperationReceipt; records: R[]; reverted: boolean }

/** SDK success is deliberately ignored. Only a canonical official-RPC receipt with the frozen call can confirm. */
export async function verifyOperationStep(reader: ArkivReader, record: StoredOperationStep, options: { waitMs?: number } = {}): Promise<VerifiedStep | null> {
  return verifyNativeOperationStep(reader, record, CORE_CODEC, options);
}

export async function verifyNativeOperationStep<R extends VerificationRecord>(reader: ArkivReader, record: StoredOperationStep,
  codec: VerificationCodec<R>, options: { waitMs?: number } = {}): Promise<VerifiedStep<R> | null> {
  assertArkiv(record.prepared && record.admission, 'unverified', 'evidence_unavailable', 'No admitted transaction is recorded for this step.');
  const hash = await recoverHash(reader, record, codec);
  if (!hash) return null;
  const receipt = options.waitMs
    ? await reader.client.waitForTransactionReceipt({ hash, checkReplacement: false, timeout: options.waitMs, pollingInterval: 1_000 })
    : await reader.client.getTransactionReceipt({ hash });
  const transaction = await reader.client.getTransaction({ hash });
  const block = await reader.client.getBlock({ blockNumber: receipt.blockNumber });
  const request = record.admission.request;
  assertArkiv(sameIdentity(receipt.transactionHash, hash) && sameIdentity(transaction.hash, hash)
    && sameIdentity(receipt.from, request.from) && sameIdentity(receipt.to, ARKIV_ADDRESS)
    && sameIdentity(transaction.from, request.from) && sameIdentity(transaction.to, ARKIV_ADDRESS)
    && transaction.chainId === TIRAMISU_CHAIN_ID && transaction.value === 0n
    && transaction.input.toLowerCase() === request.data.toLowerCase(), 'unverified', 'foreign_author', 'The mined transaction does not match the frozen wallet intent.');
  assertArkiv(receipt.blockHash === transaction.blockHash && receipt.blockNumber === transaction.blockNumber
    && receipt.transactionIndex === transaction.transactionIndex && block.hash === receipt.blockHash && block.number === receipt.blockNumber,
    'unverified', 'incomplete_snapshot', 'The receipt is not in the canonical block.');
  if (request.gas) assertArkiv(transaction.gas === BigInt(request.gas), 'unverified', 'invalid_input', 'The transaction gas limit differs from the reviewed request.');
  if (request.maxFeePerGas) assertArkiv(transaction.maxFeePerGas === BigInt(request.maxFeePerGas), 'unverified', 'invalid_input', 'The transaction fee cap differs from the reviewed request.');
  if (request.maxPriorityFeePerGas) assertArkiv(transaction.maxPriorityFeePerGas === BigInt(request.maxPriorityFeePerGas), 'unverified', 'invalid_input', 'The transaction priority fee differs from the reviewed request.');
  if (request.gasPrice) assertArkiv(transaction.gasPrice === BigInt(request.gasPrice), 'unverified', 'invalid_input', 'The transaction gas price differs from the reviewed request.');
  const timestamp = Number(block.timestamp * 1_000n);
  assertArkiv(Number.isSafeInteger(timestamp), 'unverified', 'incomplete_snapshot', 'The receipt timestamp is invalid.');
  const operationReceipt: OperationReceipt = { operationId: record.operation.id, transactionHash: hash, entityKeys: [],
    consumedKeys: [], blockNumber: receipt.blockNumber.toString() as `${bigint}`, confirmedAt: timestamp };
  if (receipt.status === 'reverted') return { receipt: operationReceipt, records: [], reverted: true };
  assertArkiv(receipt.status === 'success', 'unverified', 'evidence_unavailable', 'The transaction has no successful status.');
  const nativeLogs = receipt.logs.filter(log => sameIdentity(log.address, ARKIV_ADDRESS));
  let previousLogIndex = -1;
  for (const log of nativeLogs) {
    assertArkiv(log.removed === false && sameIdentity(log.transactionHash, hash)
      && log.blockHash === receipt.blockHash && log.blockNumber === receipt.blockNumber
      && log.transactionIndex === receipt.transactionIndex
      && typeof log.logIndex === 'number' && Number.isSafeInteger(log.logIndex) && log.logIndex > previousLogIndex,
      'unverified', 'incomplete_snapshot', 'A native event does not belong to this canonical transaction receipt.');
    previousLogIndex = log.logIndex;
  }
  const events = nativeLogs.map(log => decodeEventLog({ abi: ENTITY_EVENTS_ABI, topics: log.topics, data: log.data }));
  const creates = record.batch.creates ?? []; const deletes = record.batch.deletes ?? []; const extensions = record.batch.extensions ?? [];
  assertArkiv(events.length === creates.length + deletes.length + extensions.length, 'unverified', 'projection_mismatch', 'The native event count does not match the frozen batch.');
  const snapshot: Snapshot = { mode: 'public', source: 'arkiv', chainId: TIRAMISU_CHAIN_ID, blockNumber: operationReceipt.blockNumber,
    blockHash: receipt.blockHash, blockTimestamp: timestamp, fetchedAt: reader.now(), freshness: 'fresh', completeness: 'complete', reasons: [] };
  const context = await reader.context({ snapshot });
  const records: R[] = []; const createdKeys = new Set<PublicEntityKey>(); let eventIndex = 0;
  for (const create of creates) {
    const event = events[eventIndex++]!;
    assertArkiv(event.eventName === 'EntityCreated' && sameIdentity(event.args.owner, request.from) && event.args.creationFlags === 1,
      'unverified', 'projection_mismatch', 'A creation event has the wrong authority or flags.');
    const createdKey = publicKey(event.args.entityKey);
    assertArkiv(!createdKeys.has(createdKey), 'unverified', 'projection_mismatch', 'The creation events repeat one entity key.');
    createdKeys.add(createdKey);
    assertArkiv(event.args.expiresAt - receipt.blockNumber === ExpirationTime.fromSeconds(create.lifetimeSeconds).minLifetime,
      'unverified', 'projection_mismatch', 'The entity lifetime does not match the frozen request.');
    const frozen = codec.validate(JSON.parse(create.payloadJson));
    const entity = await codec.read(reader, context, createdKey, frozen, publicAddress(request.from));
    assertArkiv(entity && canonicalJson(entity.payload) === create.payloadJson
      && entity.provenance.createdAtBlock === operationReceipt.blockNumber
      && entity.provenance.expiresAtBlock === event.args.expiresAt.toString(), 'unverified', 'projection_mismatch', 'The created entity does not match its frozen payload and receipt.');
    entity.provenance.transactionHash = hash; records.push(entity); operationReceipt.entityKeys.push(entity.key);
  }
  for (const deletedKey of deletes) {
    const event = events[eventIndex++]!;
    assertArkiv(event.eventName === 'EntityDeleted' && sameIdentity(event.args.entityKey, deletedKey) && sameIdentity(event.args.owner, request.from),
      'unverified', 'projection_mismatch', 'The consumed entity does not match the expected predecessor.');
    const rows = await reader.query(context, [eq('$key', key(deletedKey))], undefined, true);
    assertArkiv(rows.length === 0, 'unverified', 'projection_mismatch', 'A consumed predecessor is still present at the receipt block.');
    operationReceipt.consumedKeys.push(deletedKey);
  }
  for (const extension of extensions) {
    const event = events[eventIndex++]!;
    assertArkiv(event.eventName === 'ExpiryExtended' && sameIdentity(event.args.entityKey, extension.entityKey)
      && sameIdentity(event.args.owner, request.from) && event.args.expiresAt === BigInt(extension.expiresAtBlock),
      'unverified', 'projection_mismatch', 'The renewal event does not match the reviewed expiry.');
    const rows = await reader.query(context, [eq('$key', key(extension.entityKey))], undefined, true);
    assertArkiv(rows.length === 1, 'unverified', 'evidence_unavailable', 'The renewed entity cannot be read back.');
    const entity = codec.decode(rows[0]!, snapshot, publicAddress(request.from), extension.entityKey);
    assertArkiv(entity.provenance.expiresAtBlock === extension.expiresAtBlock, 'unverified', 'projection_mismatch', 'The renewed expiry was not observed.');
    entity.provenance.transactionHash = hash; records.push(entity); operationReceipt.entityKeys.push(entity.key);
  }
  await reader.finish(context);
  return { receipt: operationReceipt, records, reverted: false };
}

export function createdRecord<T extends EntityPayload>(verified: VerifiedStep, type: T['entityType']): EntityRecord<T> {
  const records = verified.records.filter(record => record.payload.entityType === type);
  assertArkiv(records.length === 1, 'unverified', 'evidence_unavailable', 'The expected created entity could not be verified.');
  return records[0] as EntityRecord<T>;
}
