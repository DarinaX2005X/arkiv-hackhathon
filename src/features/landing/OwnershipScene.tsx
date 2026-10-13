import { useId, type CSSProperties } from 'react';
import './ownership-scene.css';

/** Explanatory objects, not sample records. Each offer has a separate sheet,
 * signature and seal; a shared receiving plane never combines their authors. */
export function OwnershipScene() {
  const id = `owners-${useId().replaceAll(':', '')}`;
  const materials = {
    '--owner-paper': `url(#${id}-paper)`,
    '--owner-edge': `url(#${id}-edge)`,
    '--owner-green': `url(#${id}-green)`,
    '--owner-contact': `url(#${id}-contact)`,
  } as CSSProperties;

  return <svg className="pf-ownership-art" viewBox="0 0 620 405" width="620" height="405"
    style={materials} role="img" aria-labelledby={`${id}-title ${id}-description`} focusable="false">
    <title id={`${id}-title`}>Separate offers, independently agreed</title>
    <desc id={`${id}-description`}>Three substantial paper objects show a space, equipment and time. Each carries its own signature and seal. They share a foundation but remain separate, just as an event’s contributors keep ownership of their decisions.</desc>
    <defs>
      <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="1" y2=".85">
        <stop stopColor="var(--art-highlight)" /><stop offset=".6" stopColor="var(--art-cream)" /><stop offset="1" stopColor="var(--art-sand)" />
      </linearGradient>
      <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="var(--art-sand)" /><stop offset="1" stopColor="var(--art-shadow)" />
      </linearGradient>
      <linearGradient id={`${id}-green`} x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="var(--surface-dark-light)" /><stop offset="1" stopColor="var(--surface-dark)" />
      </linearGradient>
      <filter id={`${id}-contact`} x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="4" /></filter>
    </defs>

    <path className="pf-owner-shadow" d="m31 260 275-150 288 160-273 121Z" />
    <path className="pf-owner-foundation-side" d="m32 244 272-151 284 158v16L316 419 32 261Z" transform="translate(0 -28)" />
    <path className="pf-owner-foundation" d="m32 244 272-151 284 158-272 151Z" transform="translate(0 -28)" />
    <path className="pf-owner-foundation-rim" d="m33 216 283 157 270-150" />

    <path className="pf-owner-trace" d="m118 255 152 84 45-25m-2-72 81 45-79 44m190-65-93 52-39-22" />
    <OfferSheet x={62} y={62} kind="space" />
    <OfferSheet x={245} y={18} kind="equipment" />
    <OfferSheet x={400} y={18} kind="time" />

    {/* Three independent seals meet the same plan without becoming one seal. */}
    <g transform="matrix(1 -.55 1 .55 268 340)">
      <path className="pf-owner-paper-side" d="M0 0h54v40H0Z" transform="translate(0 4)" />
      <path className="pf-owner-paper" d="M0 0h54v40H0Z" />
      <path className="pf-owner-document-line" d="M9 9h36M9 16h26" />
      <path className="pf-owner-seal" d="M9 24h8v8H9Zm14 0h8v8h-8Zm14 0h8v8h-8Z" />
    </g>
  </svg>;
}

function OfferSheet({ x, y, kind }: { x: number; y: number; kind: 'space' | 'equipment' | 'time' }) {
  return <g transform={`matrix(1 .53 0 1 ${x} ${y})`}>
    <path className="pf-owner-shadow" d="m-5 163 26-12 124 3 6 18H-5Z" />
    <path className="pf-owner-paper-side" d="M0 0 10-6h111q8 0 8 8v159l-10 7H0Z" />
    <path className="pf-owner-paper" d="M7 0h106q7 0 7 7v151q0 8-8 8H7q-7 0-7-7V7q0-7 7-7Z" />
    <path className="pf-owner-paper-rim" d="M1 157V7q0-6 6-6h103" />
    <path className="pf-owner-fold" d="m103 0 17 18h-15q-5 0-4-5Z" />
    <g transform="translate(23 25)">
      {kind === 'space' ? <>
        <path className="pf-owner-paper-side" d="M0 62V10L36-7l35 20v55L35 88Z" />
        <path className="pf-owner-green" d="M0 10 36-7v52L0 62Z" />
        <path className="pf-owner-sage" d="m36-7 35 20v55L36 48Z" />
        <path className="pf-owner-paper" d="M42 50V20q0-12 10-6 11 6 11 18v30Z" />
        <path className="pf-owner-green" d="M49 54V25q0-5 4-3t4 8v29Z" />
        <path className="pf-owner-sage" d="m10 13 16-8v24l-16 8Z" />
      </> : kind === 'equipment' ? <>
        <path className="pf-owner-paper-side" d="m-1 24 20-11 61 24v38L58 88-1 61Z" />
        <path className="pf-owner-green" d="m-1 24 61 26v38L-1 61Z" />
        <path className="pf-owner-sage" d="m-1 24 20-11 61 24-20 13Z" />
        <path className="pf-owner-handle" d="m25 24 5-12q2-5 6-3l18 7q4 2 4 6v11" />
        <path className="pf-owner-paper" d="m9 37 7 3v12l-7-3Zm32 14 7 3v12l-7-3Z" />
        <path className="pf-owner-case-seam" d="m0 34 59 25 19-10" />
      </> : <>
        <ellipse className="pf-owner-paper-side" cx="43" cy="40" rx="32" ry="38" />
        <ellipse className="pf-owner-green" cx="35" cy="44" rx="32" ry="38" />
        <ellipse className="pf-owner-paper" cx="35" cy="44" rx="25" ry="30" />
        <path className="pf-owner-clock" d="M35 22v24l15 14" />
        <path className="pf-owner-clock-ticks" d="M35 16v5M35 67v5M13 44h4m37 0h4" />
      </>}
    </g>
    <path className="pf-owner-document-line" d="M17 117h56M17 124h42" />
    <path className="pf-owner-signature" d={kind === 'space' ? 'M17 146q16-22 10-8t9 4q8-7 6 3l15-6' : kind === 'equipment' ? 'M17 145q11-21 15-7t11-3q2-4 2 8l13-3' : 'M17 144q8-15 9-1t7-9q3-8 4 10l19-6'} />
    <path className="pf-owner-seal-side" d="m80 131 13-7 13 7v17l-13 7-13-7Z" />
    <path className="pf-owner-seal" d="m80 128 13-7 13 7v17l-13 7-13-7Z" />
    <path className="pf-owner-check" d="m86 136 5 6 9-9" />
  </g>;
}
