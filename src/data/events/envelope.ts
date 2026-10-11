import type { AttributeInputs, Entity } from '@arkiv-network/sdk';
import { i32, key, bytes32, u64 } from '@arkiv-network/sdk/attr';
import { eq } from '@arkiv-network/sdk/query';
import { canonicalJson } from '../../domain/canonical';
import { MAX_EVENT_STATE_PAYLOAD_BYTES, validateEventPayload } from '../../domain/events';
import type { EventPayload, EventRecord } from '../../domain/events';
import type { AccountAddress, PublicEntityKey, Snapshot } from '../../domain/types';
import { ArkivRepositoryError, assertArkiv } from '../arkiv/errors';
import { publicAddress, publicKey, sameIdentity } from '../arkiv/envelope';
import type { NativeAttribute, NativeBatch } from '../wallet';
import type { VerificationCodec } from '../arkiv/verification';

export const EVENTS_NAMESPACE = 'partfolk-events';
export function eventPayload(value: unknown): EventPayload {
  const validation = validateEventPayload(value);
  if (!validation.valid) throw new ArkivRepositoryError('invalid_input', 'invalid_schema', 'The event record does not satisfy the event protocol.', false, validation.reasons);
  return value as EventPayload;
}
export function eventAttributes(payload: EventPayload): AttributeInputs {
  const attributes: Record<string, AttributeInputs[string]> = {
    project: EVENTS_NAMESPACE, entity_type: payload.entityType, schema_version: i32(1),
    project_key: key(publicKey(payload.projectRoot)), created_at: u64(BigInt(payload.createdAt)), operation_id: payload.operationId,
    audience_hash: bytes32(payload.audienceHash),
  };
  if (payload.entityType === 'event_release') {
    attributes.starts_at = u64(BigInt(payload.terms.startsAt)); attributes.ends_at = u64(BigInt(payload.terms.endsAt));
    attributes.proposal_key = key(publicKey(payload.source.proposalKey));
  } else {
    attributes.release_key = key(publicKey(payload.releaseKey));
    if (payload.entityType === 'event_state') {
      attributes.status = payload.status; attributes.starts_at = u64(BigInt(payload.startsAt)); attributes.ends_at = u64(BigInt(payload.endsAt));
      attributes.proposal_key = key(publicKey(payload.source.proposalKey));
    } else attributes.decision = payload.decision;
  }
  return attributes;
}

export function decodeEventEntity<T extends EventPayload>(raw: Entity, expectedType: T['entityType'], snapshot: Snapshot,
  expectedCreator?: AccountAddress, expectedKey?: PublicEntityKey): EventRecord<T> {
  const identity = publicKey(raw.key); const creator = publicAddress(raw.creator); const owner = publicAddress(raw.owner);
  if (expectedKey) assertArkiv(sameIdentity(identity, expectedKey), 'unverified', 'invalid_identity', 'The provider returned another event key.');
  if (expectedCreator) assertArkiv(sameIdentity(creator, expectedCreator), 'unverified', 'foreign_author', 'The event record has a different immutable creator.');
  assertArkiv(creator === owner, 'unverified', 'owner_changed', 'Transferred event records cannot authorize a current transition.');
  assertArkiv(raw.creationFlags?.raw === 1 && raw.creationFlags.readonly === true && raw.creationFlags.permissionlessExtension === false,
    'unverified', 'not_readonly', 'Event records must be readonly with owner-controlled extension.');
  assertArkiv(raw.contentType === 'application/json' && raw.payload instanceof Uint8Array, 'unverified', 'invalid_schema', 'The event payload is missing.');
  assertArkiv(raw.payload.byteLength <= MAX_EVENT_STATE_PAYLOAD_BYTES, 'payload_too_large', 'payload_too_large', 'The event payload exceeds its limit.');
  assertArkiv(snapshot.mode === 'public' && snapshot.blockNumber !== null && typeof raw.createdAt === 'bigint' && typeof raw.expiresAt === 'bigint'
    && raw.createdAt >= 0n && raw.createdAt <= BigInt(snapshot.blockNumber) && raw.expiresAt > BigInt(snapshot.blockNumber),
    'expired', 'expired', 'The event record is not live at the requested block.');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.payload)); }
  catch { throw new ArkivRepositoryError('unverified', 'invalid_schema', 'The event payload is not valid UTF-8 JSON.'); }
  const payload = eventPayload(parsed);
  assertArkiv(payload.createdAt <= snapshot.blockTimestamp, 'unverified', 'invalid_schema', 'The event record claims a future creation time.');
  assertArkiv(payload.entityType === expectedType, 'unverified', 'projection_mismatch', 'The event record has another type.');
  if (payload.entityType === 'attendance_state') assertArkiv(payload.attendee === creator, 'unverified', 'foreign_author', 'Only the attendee can author their decision.');
  const attributes = eventAttributes(payload);
  assertArkiv(raw.attributes && Object.keys(raw.attributes).sort().join('|') === Object.keys(attributes).sort().join('|'),
    'unverified', 'projection_mismatch', 'The event projection has an unexpected attribute set.');
  for (const [name, value] of Object.entries(attributes)) {
    const expected = typeof value === 'string' ? { type: 'str', value } : value;
    const actual = raw.attributes[name];
    assertArkiv(expected && typeof expected === 'object' && 'type' in expected && 'value' in expected && actual?.type === expected.type
      && (actual.type === 'key' || actual.type === 'bytes32' ? sameIdentity(actual.value, expected.value) : actual.value === expected.value),
      'unverified', 'projection_mismatch', `The event ${name} projection disagrees with its payload.`);
  }
  return { key: identity, payload: payload as T, provenance: { mode: 'public', creator: { kind: 'wallet', address: creator },
    owner: { kind: 'wallet', address: owner }, readonly: true, permissionlessExtension: false, contentType: 'application/json',
    createdAtBlock: raw.createdAt.toString() as `${bigint}`, expiresAtBlock: raw.expiresAt.toString() as `${bigint}`, transactionHash: null } };
}

export function nativeEventCreate(input: EventPayload, lifetimeSeconds: number): NonNullable<NativeBatch['creates']>[number] {
  const payload = eventPayload(input); const attributes: Record<string, NativeAttribute> = {};
  for (const [name, value] of Object.entries(eventAttributes(payload))) {
    if (typeof value === 'string') attributes[name] = { type: 'str', value };
    else if (value && typeof value === 'object' && 'type' in value && 'value' in value) {
      if (value.type === 'u64') attributes[name] = { type: 'u64', value: value.value.toString() as `${bigint}` };
      else if (value.type === 'i32' || value.type === 'str') attributes[name] = { type: value.type, value: value.value } as NativeAttribute;
      else if (value.type === 'key' || value.type === 'bytes32') attributes[name] = { type: value.type, value: value.value };
      else throw new ArkivRepositoryError('invalid_input', 'invalid_schema', 'Unsupported event attribute type.');
    } else throw new ArkivRepositoryError('invalid_input', 'invalid_schema', 'Malformed event attribute.');
  }
  return { payloadJson: canonicalJson(payload), attributes, lifetimeSeconds, salt: '0' };
}

export const EVENT_VERIFICATION_CODEC: VerificationCodec<EventRecord> = {
  namespace: EVENTS_NAMESPACE, validate: eventPayload,
  decode: (raw, snapshot, creator, expectedKey) => {
    const type = raw.attributes?.entity_type?.value;
    assertArkiv(type === 'event_release' || type === 'event_state' || type === 'attendance_state', 'unverified', 'invalid_schema', 'Unknown event record type.');
    return decodeEventEntity(raw, type, snapshot, creator, expectedKey);
  },
  read: async (reader, context, entityKey, payload, creator) => {
    const rows = await reader.query(context, [eq('$key', key(entityKey))], undefined, true);
    assertArkiv(rows.length <= 1, 'unverified', 'conflicting_heads', 'An exact event key returned several entities.');
    return rows.length ? decodeEventEntity(rows[0]!, payload.entityType, context.snapshot, creator, entityKey) : null;
  },
};
