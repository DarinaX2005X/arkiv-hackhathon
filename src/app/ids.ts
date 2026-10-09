import type { AccountAddress, EntityKey, LocalActorId, LocalEntityKey, PublicEntityKey } from '../domain/types';

export const isPublicEntityKey = (value: unknown): value is PublicEntityKey => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
export const isLocalEntityKey = (value: unknown): value is LocalEntityKey => typeof value === 'string' && /^local:[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
export const isEntityKey = (value: unknown): value is EntityKey => isPublicEntityKey(value) || isLocalEntityKey(value);
export const isAccountAddress = (value: unknown): value is AccountAddress => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
export const isLocalActorId = (value: unknown): value is LocalActorId => typeof value === 'string' && /^local-actor:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export function requirePublicEntityKey(value: unknown): PublicEntityKey {
  if (!isPublicEntityKey(value)) throw new TypeError('A public entity key must contain exactly 32 hexadecimal bytes.');
  return value;
}

export function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\u0000');
}
export function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
