import { describe, expect, it } from 'vitest';
import { addressAvatar } from './avatar';

describe('wallet address avatar identity', () => {
  it('is stable across sessions and checksum letter case, and changes for another address', () => {
    const address = `0x${'ab'.repeat(20)}`;
    expect(addressAvatar(address)).toEqual(addressAvatar(`0x${'AB'.repeat(20)}`));
    expect(addressAvatar(address)).toEqual(addressAvatar(address));
    expect(addressAvatar(address)).not.toEqual(addressAvatar(`0x${'cd'.repeat(20)}`));
  });
  it('keeps a nonempty symmetric pattern within the avatar bounds', () => {
    const { cells } = addressAvatar(`0x${'0'.repeat(40)}`);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every(cell => cell.x >= 0 && cell.x <= 4 && cell.y >= 0 && cell.y <= 4)).toBe(true);
    for (const cell of cells) expect(cells).toContainEqual({ x: 4 - cell.x, y: cell.y });
  });
  it('cannot make a wallet identity from malformed or local addresses', () => {
    for (const address of ['', 'local-actor:me', '0x1234']) expect(() => addressAvatar(address)).toThrow(TypeError);
  });
});
