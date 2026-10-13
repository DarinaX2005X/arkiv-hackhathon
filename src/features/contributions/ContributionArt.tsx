import { useId } from 'react';
import type { Resource } from '../../domain/types';

/** An original material family for the three things a contributor can offer. */
export function ContributionArt({ kind }: { kind: Resource['kind'] }) {
  const id = useId().replaceAll(':', '');
  return <svg className="pf-contribution-art" viewBox="0 0 160 118" aria-hidden="true" focusable="false">
    <defs><linearGradient id={`${id}-paper`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fffef6" /><stop offset="1" stopColor="#dce6d0" /></linearGradient><linearGradient id={`${id}-green`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#548364" /><stop offset="1" stopColor="#234e3a" /></linearGradient></defs>
    <ellipse cx="81" cy="104" rx="53" ry="7" fill="#102d20" opacity=".1" />
    {kind === 'person' ? <>
      <path d="M31 35 106 23 131 38 56 51Z" fill="#cedfbd" /><path d="m31 35 25 16v50L31 86Z" fill="#adbfa0" /><path d="m56 51 75-13v50l-75 13Z" fill={`url(#${id}-paper)`} />
      <circle cx="79" cy="65" r="9" fill={`url(#${id}-green)`} /><path d="M65 86c1-15 25-20 29-5Z" fill={`url(#${id}-green)`} />
      <path d="m103 57 16-3m-16 11 16-3m-16 11 12-2" stroke="#92aa88" strokeWidth="4" strokeLinecap="round" />
      <path d="m44 31 0-9m18 6v-9m20 6v-9m19 6v-9" stroke="#46664b" strokeWidth="5" strokeLinecap="round" />
    </> : kind === 'place' ? <>
      <path d="m26 91 58 17 51-26-58-17Z" fill="#b7cba5" /><path d="m26 91 58 17v-6L26 85Z" fill="#90a581" />
      <path d="m35 85 47 14V38L35 24Z" fill="#e2ecd5" /><path d="m82 99 45-23V17L82 38Z" fill={`url(#${id}-paper)`} /><path d="m35 24 46-20 46 13-45 21Z" fill="#f7faee" />
      <path d="m94 93 20-10V50L94 60Z" fill={`url(#${id}-green)`} /><path d="m45 44 23 7v22l-23-7Z" fill="#699275" /><path d="m56 47 0 22m-11-15 23 7" stroke="#dfeacf" strokeWidth="2.5" />
    </> : <>
      <path d="m30 61 58 16 41-23-58-16Z" fill="#f4f8e9" /><path d="m30 61 58 16v29L30 88Z" fill={`url(#${id}-green)`} /><path d="m88 77 41-23v29l-41 23Z" fill="#254e39" />
      <path d="m49 51 13-6V27l27 8v19l13 4V24L62 12 49 19Z" fill="#a9c18f" /><path d="m62 12 40 12-13 7-40-12Z" fill="#d7e8bb" />
      <path d="m57 77 15 4v9l-15-4Z" fill="#e3edce" /><path d="m101 83 16-9" stroke="#7ea16a" strokeWidth="3" strokeLinecap="round" />
    </>}
  </svg>;
}
