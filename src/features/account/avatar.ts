import { isAccountAddress } from '../../app/ids';

/** A recognizable address pattern, not a claim about the person controlling it. */
export function addressAvatar(address: string) {
  if (!isAccountAddress(address)) throw new TypeError('An avatar requires a valid wallet address.');
  let seed = 2166136261;
  for (const character of address.toLowerCase()) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const tones = ['#1D5A43', '#244C3D', '#365B46', '#143D31'] as const;
  const tone = tones[seed % tones.length]!;
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    if ((seed >>> 0) % 3 !== 0 || (x === 2 && y === 2)) {
      cells.push({ x, y }); if (x !== 2) cells.push({ x: 4 - x, y });
    }
  }
  return { tone, cells };
}
