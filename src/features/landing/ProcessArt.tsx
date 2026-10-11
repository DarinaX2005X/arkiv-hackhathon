import { useId, type CSSProperties } from 'react';
import './process-art.css';

/** Original explanatory objects. The scenes share the event stage's
 * oblique camera, opaque materials and light from the upper left. Captions
 * live in HTML; this artwork contains no live state or interactive controls. */
export function ProcessArt({ kind }: { kind: 'set' | 'offer' | 'agree' | 'join' }) {
  const id = `process-${useId().replaceAll(':', '')}`;
  const materials = {
    '--process-paper': `url(#${id}-paper)`,
    '--process-clay': `url(#${id}-clay)`,
    '--process-forest': `url(#${id}-forest)`,
    '--process-contact': `url(#${id}-contact)`,
  } as CSSProperties;

  return <svg className={`pf-process-art pf-process-art--${kind}`} style={materials}
    viewBox="0 0 240 170" width="240" height="170" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-paper`} x1="0%" y1="0%" x2="85%" y2="100%">
        <stop stopColor="var(--surface-work)" />
        <stop offset=".55" stopColor="var(--surface-work)" />
        <stop offset="1" stopColor="var(--surface-inset)" />
      </linearGradient>
      <linearGradient id={`${id}-clay`} x1="0%" y1="0%" x2="100%" y2="85%">
        <stop stopColor="var(--art-cream)" />
        <stop offset=".32" stopColor="var(--art-sand)" />
        <stop offset="1" stopColor="var(--art-shadow)" />
      </linearGradient>
      <linearGradient id={`${id}-forest`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop stopColor="var(--action)" />
        <stop offset="1" stopColor="var(--brand-ink)" />
      </linearGradient>
      <filter id={`${id}-contact`} x="-20%" y="-60%" width="140%" height="220%">
        <feGaussianBlur stdDeviation="2.5" />
      </filter>
    </defs>
    {kind === 'set' ? <SetArt /> : kind === 'offer' ? <OfferArt /> : kind === 'join' ? <JoinArt /> : <AgreeArt />}
  </svg>;
}

function JoinArt() {
  return <>
    <path className="pf-process-shadow" d="m30 106 98-54 94 52-99 55Z" />
    {/* A folded event programme and a solid location marker share the stage. */}
    <path className="pf-process-paper-side" d="m29 91 95-53 91 51v7l-95 53-91-51Z" />
    <path className="pf-process-paper" d="m29 91 95-53 91 51-95 53Z" />
    <path className="pf-process-inset" d="m49 90 69-38 35 20-68 38Z" />
    <path className="pf-process-plan-line" d="m65 87 17 10 20-11 15 8 20-11m-45-17 15 8" />
    <path className="pf-process-paper-line" d="m115 118 45-25m-35 31 45-25m-25 30 35-20" />
    <g transform="matrix(1 .54 0 1 98 30)">
      <path className="pf-process-case-side" d="M0 18C0-8 43-11 43 15c0 18-23 41-23 41L12 51S0 33 0 18Z" />
      <path className="pf-process-forest" d="M-7 23c0-27 42-27 42-1 0 18-21 40-21 40S-7 42-7 23Z" />
      <circle className="pf-process-cream" cx="14" cy="21" r="9" />
      <path className="pf-process-case-highlight" d="M-3 16Q1 3 14 3" />
    </g>
    <g transform="matrix(1 .54 0 1 166 40)">
      <path className="pf-process-paper-side" d="m0 0 6-4h37v52l-6 4H0Z" />
      <rect className="pf-process-paper" width="37" height="56" rx="3" />
      <path className="pf-process-forest" d="M0 3q0-3 3-3h31q3 0 3 3v13H0Z" />
      <path className="pf-process-paper-line" d="M8 26h21M8 34h21M8 42h13" />
      <path className="pf-process-handle" d="M10-5v10M27-5v10" />
    </g>
  </>;
}

function SetArt() {
  return <>
    <path className="pf-process-shadow" d="m27 103 99-54 92 50-102 58Z" />
    <path className="pf-process-paper-side" d="m25 88 101-56 89 50v6l-101 57-89-51Z" />
    <path className="pf-process-paper" d="m25 88 101-56 89 50-101 57Z" />
    <path className="pf-process-edge" d="m27 87 99-54 86 48" />

    {/* A small room model rests on its exhibition floor plan. */}
    <path className="pf-process-inset" d="m43 89 57-32 41 23-57 33Z" />
    <path className="pf-process-wall" d="M43 89V68l57-32v21Z" />
    <path className="pf-process-paper" d="M100 36v21l41 23V59Z" />
    <path className="pf-process-rim" d="m43 68 4 2 53-30 37 21 4-2-41-23Z" />
    <path className="pf-process-wall-side" d="M43 68v21l4 2V70Z" />
    <path className="pf-process-window" d="m57 69 12-7v13l-12 7Zm22-12 12-7v13l-12 7Z" />
    <path className="pf-process-plan-line" d="m54 92 25-14 39 21m-35 8 36-20" />
    <path className="pf-process-clay-side" d="m78 82 11-6 18 10v5l-11 6-18-10Z" />
    <path className="pf-process-clay" d="m78 82 11-6 18 10-11 6Z" />

    {/* A folded timetable and the resource strips sit beside the room. */}
    <path className="pf-process-small-shadow" d="m144 70 22-13 25 15-22 13Z" />
    <path className="pf-process-forest" d="m146 69 13-28 21 12 10 21-22 12Z" />
    <path className="pf-process-paper" d="m159 41 21 12-6 25-22-12Z" />
    <path className="pf-process-clay" d="m159 41 21 12-2 6-21-12Z" />
    <path className="pf-process-schedule-line" d="m157 55 17 9m-19-3 17 9m-9-12-3 12" />
    <path className="pf-process-strip-side" d="m135 102 34-19 10 6v4l-34 19-10-6Z" />
    <path className="pf-process-strip" d="m135 102 34-19 10 6-34 19Z" />
    <path className="pf-process-strip-side" d="m149 111 34-19 10 6v4l-34 19-10-6Z" />
    <path className="pf-process-strip" d="m149 111 34-19 10 6-34 19Z" />
    <path className="pf-process-ink" d="m136 102 7-4 10 6-7 4Zm14 9 7-4 10 6-7 4Z" />
  </>;
}

function OfferArt() {
  return <>
    <path className="pf-process-shadow" d="m38 128 100-57 76 43-98 48Z" />
    <Frame x={128} y={27} />
    <Frame x={110} y={39} />
    <Frame x={92} y={51} />
    <path className="pf-process-small-shadow" d="m35 127 42-23 78 42-42 23Z" />

    {/* The case has a raised lid, carrying handle, latches and a side face. */}
    <path className="pf-process-case-side" d="m33 103 37-21 78 44v19l-37 21-78-44Z" />
    <path className="pf-process-forest" d="m33 106 78 44v16l-78-44Z" />
    <path className="pf-process-forest" d="m33 103 37-21 78 44-37 21Z" />
    <path className="pf-process-case-lid" d="m33 99 37-21 78 44v6l-37 21-78-44Z" />
    <path className="pf-process-forest" d="m33 99 37-21 78 44-37 21Z" />
    <path className="pf-process-case-highlight" d="m36 99 34-19 74 42" />
    <path className="pf-process-handle" d="m71 104 8-5q3-2 6 0l16 9q3 2 3 5v4" />
    <path className="pf-process-latch" d="m49 113 8 5v10l-8-5Zm44 25 8 5v10l-8-5Z" />
    <path className="pf-process-latch-inset" d="m52 118 3 2v4l-3-2Zm44 25 3 2v4l-3-2Z" />
  </>;
}

function Frame({ x, y }: { x: number; y: number }) {
  return <g transform={`matrix(1 .54 0 1 ${x} ${y})`}>
    <path className="pf-process-clay-side" d="M0 0 7-7h53v78l-7 7H0Z" />
    <path className="pf-process-clay" d="M0 0h53v78H0Z" />
    <path className="pf-process-frame-edge" d="M2 76V2h49" />
    <path className="pf-process-paper" d="M7 7h39v64H7Z" />
    <path className="pf-process-strip" d="M12 12h29v54H12Z" />
    <path className="pf-process-forest" d="M15 59V39a12 12 0 0 1 24 0v20Z" />
    <path className="pf-process-cream" d="M23 59V42a4 4 0 0 1 8 0v17Z" />
    <path className="pf-process-clay" d="M15 17h12v6H15Z" />
  </g>;
}

function AgreeArt() {
  return <>
    <path className="pf-process-shadow" d="m31 103 99-55 87 49-97 55Z" />
    {/* The offsets reveal separate sheets; every seal belongs to one sheet. */}
    <PlanSheet offset={16} seal={0} />
    <PlanSheet offset={8} seal={1} />
    <PlanSheet offset={0} seal={2} />
    <g transform="matrix(.9 -.5 .9 .5 62 90)">
      <path className="pf-process-plan-line" d="M0 0V-27h43v51H16V8H0m18-35V0h25" />
      <path className="pf-process-clay" d="M5-19h7v11H5Zm21 0h10v7H26Zm0 22h10v13H26Z" />
      <path className="pf-process-paper-line" d="M54-27h36M54-18h29M54-9h36M54 7h36M54 16h25" />
    </g>
  </>;
}

function PlanSheet({ offset, seal }: { offset: number; seal: number }) {
  const sealX = 122 + seal * 26;
  const sealY = 123 - seal * 14.5;
  return <g transform={`translate(0 ${offset})`}>
    <path className="pf-process-paper-side" d="m31 77 98-55 86 48v5l-98 55-86-48Z" />
    <path className="pf-process-paper" d="m31 77 98-55 86 48-98 55Z" />
    <path className="pf-process-edge" d="m33 76 96-53 83 47" />
    <g transform={`translate(${sealX} ${sealY})`}>
      <path className="pf-process-seal-side" d="m0-11 15-8 7 4v17l-7 4-7-4-8 4Z" />
      <path className="pf-process-seal" d="m0-11 15-8 7 4-15 8Z" />
      <path className="pf-process-seal" d="M7-7 22-15V0L15-3 7 1Z" />
      <path className="pf-process-seal-impression" d="m11-9 7-4v7l-7 4Z" />
    </g>
  </g>;
}
