import type { Entity } from '@arkiv-network/sdk';
import { i32, key, bytes32, u64 } from '@arkiv-network/sdk/attr';
import type { AttributeInputs } from '@arkiv-network/sdk';
import { canonicalJson, hashPlan, hashRequirements } from '../../domain/canonical';
import { validateEntityPayload } from '../../domain/validation';
import type { AccountAddress, EntityPayload, EntityRecord, EntityType, PublicEntityKey, Snapshot } from '../../domain/types';
import { TIRAMISU_CHAIN_ID } from '../../domain/types';
import { ArkivRepositoryError, assertArkiv } from './errors';

export const ENTITY_SELECTION = { key: true, creator: true, owner: true, createdAt: true,
  expiresAt: true, creationFlags: true, contentType: true, payload: true, attributes: true } as const;
export const MAX_PAYLOAD_BYTES = 120 * 1024;
export const NAMESPACE = 'partfolk';
export const PUBLIC_KEY = /^0x[0-9a-fA-F]{64}$/;
export const PUBLIC_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const sameIdentity = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function publicKey(value: unknown): PublicEntityKey {
  assertArkiv(typeof value === 'string' && PUBLIC_KEY.test(value), 'invalid_input', 'invalid_identity', 'A public Arkiv entity key must contain 32 bytes. Local IDs cannot be sent to Arkiv.');
  return value.toLowerCase() as PublicEntityKey;
}
export function publicAddress(value: unknown): AccountAddress {
  assertArkiv(typeof value === 'string' && PUBLIC_ADDRESS.test(value), 'invalid_input', 'invalid_identity', 'A public wallet address must contain 20 bytes.');
  return value.toLowerCase() as AccountAddress;
}

const SINGLE_KEY_FIELDS = new Set(['projectRoot', 'publisherRoot', 'proposalKey', 'activationKey', 'sourceProjectRoot', 'giver', 'receiver', 'author']);
const KEY_ARRAY_FIELDS = new Set(['predecessorKeys', 'predecessorActivationKeys', 'publisherRoots', 'projectScope', 'requiredApprovers']);
/** The domain permits local IDs. The public boundary validates identity fields again, without rejecting ordinary prose. */
export function assertPublicPayload(payload: EntityPayload): void {
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const record = value as Record<string, unknown>;
    for (const [name, item] of Object.entries(record)) {
      if (SINGLE_KEY_FIELDS.has(name) && item !== undefined) publicKey(item);
      else if (KEY_ARRAY_FIELDS.has(name)) {
        assertArkiv(Array.isArray(item), 'invalid_input', 'invalid_schema', 'An entity reference collection is malformed.');
        item.forEach(publicKey);
      } else if (name === 'chainId') assertArkiv(item === TIRAMISU_CHAIN_ID, 'wrong_chain', 'invalid_identity', 'The payload belongs to another chain or local mode.');
      else walk(item);
    }
  };
  walk(payload);
  if (payload.entityType === 'project_root') {
    assertArkiv(payload.coordinator.kind === 'wallet', 'invalid_input', 'invalid_identity', 'A public project requires a wallet creator.');
    publicAddress(payload.coordinator.address);
  }
  if (payload.entityType === 'publisher_root') {
    assertArkiv(payload.publisher.kind === 'wallet', 'invalid_input', 'invalid_identity', 'A public publisher requires a wallet creator.');
    publicAddress(payload.publisher.address);
  }
}

export function payloadAttributes(payload: EntityPayload): AttributeInputs {
  const attributes: Record<string, AttributeInputs[string]> = { project: NAMESPACE, entity_type: payload.entityType, schema_version: i32(1),
    created_at: u64(BigInt(payload.createdAt)), operation_id: payload.operationId };
  if ('projectRoot' in payload) attributes.project_key = key(publicKey(payload.projectRoot));
  if (payload.entityType === 'book_state') attributes.book_key = key(publicKey(payload.publisherRoot));
  if (payload.entityType === 'proposal') {
    attributes.requirements_hash = bytes32(payload.requirementsHash);
    attributes.proposal_hash = bytes32(payload.proposalHash);
  }
  if (payload.entityType === 'plan_activation') attributes.proposal_key = key(publicKey(payload.proposalKey));
  if (payload.entityType === 'project_link') {
    attributes.link_kind = payload.linkKind;
    attributes.publisher_key = key(publicKey(payload.publisherRoot));
    if (payload.linkKind === 'request') attributes.activation_key = key(publicKey(payload.activationKey));
  }
  return attributes;
}

export function validatePayloadForNetwork(value: unknown): EntityPayload {
  const validation = validateEntityPayload(value);
  if (!validation.valid) throw new ArkivRepositoryError('invalid_input', 'invalid_schema', 'The entity payload does not satisfy the Partfolk protocol.', false, validation.reasons);
  const payload = value as EntityPayload;
  assertPublicPayload(payload);
  if (payload.entityType === 'proposal') {
    assertArkiv(sameIdentity(payload.projectRoot, payload.plan.projectRoot), 'unverified', 'projection_mismatch', 'The proposal project and plan project disagree.');
    assertArkiv(sameIdentity(hashPlan(payload.plan), payload.proposalHash), 'unverified', 'hash_mismatch', 'The proposal hash does not match its complete material document.');
    assertArkiv(sameIdentity(hashRequirements(payload.projectRoot, payload.plan.variant.requirements), payload.requirementsHash), 'unverified', 'hash_mismatch', 'The requirements hash does not match the selected requirements.');
  }
  const encoded = new TextEncoder().encode(canonicalJson(payload));
  assertArkiv(encoded.byteLength <= MAX_PAYLOAD_BYTES, 'payload_too_large', 'payload_too_large', 'The entity exceeds the application payload limit. Preserve and export its history before choosing what to archive.');
  return payload;
}

export function decodeEntity<T extends EntityPayload>(raw: Entity, expectedType: T['entityType'], snapshot: Snapshot,
  expectedCreator?: AccountAddress, expectedKey?: PublicEntityKey): EntityRecord<T> {
  const keyValue = publicKey(raw.key);
  if (expectedKey) assertArkiv(sameIdentity(keyValue, expectedKey), 'unverified', 'invalid_identity', 'The response returned a different entity key.');
  const creator = publicAddress(raw.creator); const owner = publicAddress(raw.owner);
  if (expectedCreator) assertArkiv(sameIdentity(creator, expectedCreator), 'unverified', 'foreign_author', 'The immutable creator does not match the expected root authority.');
  assertArkiv(sameIdentity(creator, owner), 'unverified', 'owner_changed', 'This entity has changed owner and is unavailable for creator-controlled transitions.');
  assertArkiv(raw.creationFlags?.raw === 1 && raw.creationFlags.readonly === true && raw.creationFlags.permissionlessExtension === false,
    'unverified', 'not_readonly', 'Partfolk requires readonly entities with owner-controlled extension.');
  assertArkiv(raw.contentType === 'application/json' && raw.payload instanceof Uint8Array,
    'unverified', 'invalid_schema', 'The entity payload or content type is missing.');
  assertArkiv(raw.payload.byteLength <= MAX_PAYLOAD_BYTES, 'payload_too_large', 'payload_too_large', 'The entity payload exceeds the application limit.');
  assertArkiv(typeof raw.createdAt === 'bigint' && typeof raw.expiresAt === 'bigint' && snapshot.blockNumber !== null
    && raw.createdAt >= 0n && raw.createdAt <= BigInt(snapshot.blockNumber) && raw.expiresAt > BigInt(snapshot.blockNumber),
    'expired', 'expired', 'The entity is not live at the requested block.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.payload)); }
  catch { throw new ArkivRepositoryError('unverified', 'invalid_schema', 'The entity does not contain valid UTF-8 JSON.'); }
  const payload = validatePayloadForNetwork(value);
  assertArkiv(payload.entityType === expectedType, 'unverified', 'projection_mismatch', 'The payload entity type does not match the query.');
  if (payload.entityType === 'project_root') assertArkiv(payload.coordinator.kind === 'wallet' && sameIdentity(payload.coordinator.address, creator),
    'unverified', 'foreign_author', 'The project coordinator is not its immutable creator.');
  if (payload.entityType === 'publisher_root') assertArkiv(payload.publisher.kind === 'wallet' && sameIdentity(payload.publisher.address, creator),
    'unverified', 'foreign_author', 'The publisher authority is not its immutable creator.');
  const attributes = payloadAttributes(payload);
  assertArkiv(raw.attributes && Object.keys(raw.attributes).sort().join('|') === Object.keys(attributes).sort().join('|'),
    'unverified', 'projection_mismatch', 'The indexed attribute set does not match the payload schema.');
  for (const [name, expected] of Object.entries(attributes)) {
    const actual = raw.attributes[name];
    const typed = typeof expected === 'string' ? { type: 'str', value: expected } : expected;
    assertArkiv(typed && typeof typed === 'object' && 'type' in typed && 'value' in typed && actual?.type === typed.type
      && (['key', 'bytes32', 'addr'].includes(actual.type) ? sameIdentity(actual.value, typed.value) : actual.value === typed.value),
      'unverified', 'projection_mismatch', `The indexed ${name} value does not match its payload.`);
  }
  return { key: keyValue, payload: payload as T, provenance: { mode: 'public', creator: { kind: 'wallet', address: creator },
    owner: { kind: 'wallet', address: owner }, readonly: true, permissionlessExtension: false, contentType: 'application/json',
    createdAtBlock: raw.createdAt.toString() as `${bigint}`, expiresAtBlock: raw.expiresAt.toString() as `${bigint}`, transactionHash: null } };
}

export function creatorOf(record: EntityRecord): AccountAddress {
  assertArkiv(record.provenance.mode === 'public' && record.provenance.creator.kind === 'wallet', 'unauthorized', 'invalid_identity', 'The entity has no public creator authority.');
  return publicAddress(record.provenance.creator.address);
}

export function entityType(value: unknown): EntityType {
  assertArkiv(typeof value === 'string' && ['project_root', 'publisher_root', 'project_state', 'book_state', 'proposal', 'plan_activation', 'project_link'].includes(value),
    'unverified', 'invalid_schema', 'Unknown Partfolk entity type.');
  return value as EntityType;
}
