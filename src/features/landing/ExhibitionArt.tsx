import { useId, type CSSProperties } from 'react';

/** Original explanatory artwork, not a screenshot or live activity.
 * Board count comes from the example requirement. Objects share one oblique
 * camera and light from the upper left. Palette comes from shared tokens. */
export function ExhibitionArt({ boardCount }: { boardCount: number }) {
  const shadow = `exhibition-shadow-${useId().replaceAll(':', '')}`;
  const boards = [[167, 306], [249, 264], [331, 222], [290, 376], [372, 334], [454, 292]] as const;
  const materials = { '--pf-art-ivory': `url(#${shadow}-ivory)`, '--pf-art-wall': `url(#${shadow}-wall)`,
    '--pf-art-clay': `url(#${shadow}-clay)`, '--pf-art-forest': `url(#${shadow}-forest)`,
    '--pf-art-sand': `url(#${shadow}-sand)`, '--pf-art-contact-filter': `url(#${shadow}-contact)` } as CSSProperties;
  return <svg className="pf-exhibition-art" style={materials} viewBox="0 0 720 565" role="img" aria-labelledby={`${shadow}-title ${shadow}-description`}>
    <title id={`${shadow}-title`}>Everyone brings a part of the exhibition</title>
    <desc id={`${shadow}-description`}>An illustrated library room with display boards, people hanging artwork, and a helper bringing framed work on a trolley. The working example uses the same people, space and equipment needs.</desc>
    <defs>
      <filter id={shadow} x="-25%" y="-30%" width="150%" height="170%"><feGaussianBlur stdDeviation="16" /></filter>
      <filter id={`${shadow}-contact`} x="-30%" y="-80%" width="170%" height="260%"><feGaussianBlur stdDeviation="3" /></filter>
      <filter id={`${shadow}-board-shadow`} x="-30%" y="-20%" width="180%" height="160%"><feDropShadow dx="5" dy="8" stdDeviation="5" floodColor="var(--brand-ink)" floodOpacity=".12" /></filter>
      <linearGradient id={`${shadow}-ivory`} x1="5%" y1="0%" x2="85%" y2="100%"><stop stopColor="var(--surface-work)" /><stop offset=".55" stopColor="var(--surface-work)" /><stop offset="1" stopColor="var(--surface-inset)" /></linearGradient>
      <linearGradient id={`${shadow}-wall`} x1="0%" y1="0%" x2="90%" y2="100%"><stop stopColor="var(--surface-work)" /><stop offset="1" stopColor="var(--surface-inset)" /></linearGradient>
      <linearGradient id={`${shadow}-clay`} x1="0%" y1="0%" x2="100%" y2="65%"><stop stopColor="var(--art-cream)" /><stop offset=".3" stopColor="var(--art-clay)" /><stop offset="1" stopColor="var(--art-clay)" /></linearGradient>
      <linearGradient id={`${shadow}-forest`} x1="0%" y1="0%" x2="100%" y2="90%"><stop stopColor="var(--action)" /><stop offset=".7" stopColor="var(--surface-strong)" /><stop offset="1" stopColor="var(--brand-ink)" /></linearGradient>
      <linearGradient id={`${shadow}-sand`} x1="0%" y1="0%" x2="100%" y2="80%"><stop stopColor="var(--art-cream)" /><stop offset=".45" stopColor="color-mix(in srgb, var(--art-cream) 60%, var(--art-clay))" /><stop offset="1" stopColor="var(--art-clay)" /></linearGradient>
    </defs>
    <path className="pf-art-shadow" d="m85 357 260-145 317 180-258 157Z" filter={`url(#${shadow})`} />
    <g className="pf-art-room">
      <path className="pf-art-room-base" d="M87 325 348 182q7-4 14 0l292 165q7 4 7 12v8q0 7-7 11L394 521q-8 4-16 0L87 357q-7-4-7-11v-8q0-9 7-13Z" />
      <path className="pf-art-floor" d="m87 325 261-143q7-4 14 0l292 165q13 7 0 14L394 505q-8 4-16 0L87 341q-14-8 0-16Z" />
      <path className="pf-art-floor-seam" d="m158 373 274-151m-184 202 274-151m-184 202 274-151" />
      <path className="pf-art-wall-left" d="M80 330V177q0-10 9-15L347 20q8-4 8 7v152Z" />
      <path className="pf-art-wall-right" d="M355 27q0-11 9-6l288 162q9 5 9 15v153L355 179Z" />
      <path className="pf-art-wall-rim" d="m80 167 8 5L355 26l298 167 8-5L355 16Z" />
      <path className="pf-art-wall-rim" d="M80 167v163l8 5V172Z" />
      <g transform="matrix(1 -.55 0 1 121 232)"><path className="pf-art-window-edge" d="M0 0v-51a31 31 0 0 1 62 0V0Z" /><path className="pf-art-window" d="M6-6v-45a25 25 0 0 1 50 0v45Z" /><path className="pf-art-window-bar" d="M31-78v74M6-40h50" /></g>
      <g transform="matrix(1 -.55 0 1 224 174)"><path className="pf-art-window-edge" d="M0 0v-51a31 31 0 0 1 62 0V0Z" /><path className="pf-art-window" d="M6-6v-45a25 25 0 0 1 50 0v45Z" /><path className="pf-art-window-bar" d="M31-78v74M6-40h50" /></g>
      <path className="pf-art-sunlight" d="m128 303 116-65 148 83-116 65Z" />
      <g transform="matrix(1 .56 0 1 518 173)"><path className="pf-art-door" d="M0 88V-21h68V88Z" /><path className="pf-art-door-inset" d="M6 88V-15h52V88Z" /><path className="pf-art-door-light" d="M58-15 68-21V88H58Z" /><path className="pf-art-door-handle" d="M48 34v16" /></g>
      <g transform="matrix(1 .56 0 1 410 101)"><rect className="pf-art-wall-frame" width="48" height="60" rx="1" /><rect className="pf-art-cream" x="5" y="5" width="38" height="50" /><path className="pf-art-clay" d="M10 45V31a14 14 0 0 1 28 0v14Z" /><path className="pf-art-ink" d="M11 15h16v6H11Z" /></g>
    </g>
    {boards.slice(0, Math.max(0, Math.min(6, boardCount))).map(([x, y], index) => <g key={index} transform={`translate(${x} ${y})`}>
      <ellipse className="pf-art-contact" cx="42" cy="14" rx="48" ry="13" />
      <g transform="matrix(1 .54 0 1 0 0)" filter={`url(#${shadow}-board-shadow)`}>
        <path className="pf-art-board-foot" d="m4 4-12 8 4 3 26-6V4Zm49 0-12 8 4 3 28-6V4Z" /><path className="pf-art-board-leg" d="M8-8h5v17H8Zm49 0h5v17h-5Z" />
        <rect className="pf-art-board-side" x="4" y="-121" width="72" height="116" rx="6" /><rect className="pf-art-board" x="0" y="-117" width="70" height="116" rx="6" /><path className="pf-art-board-highlight" d="M3-108q0-6 6-6h54" />
        <rect className="pf-art-pin" x="31" y="-105" width="7" height="2" rx="1" /><rect className={index % 3 === 1 ? 'pf-art-picture-sand' : 'pf-art-picture'} x="11" y="-97" width="46" height="65" rx="2" />
        {index % 3 === 0 ? <><circle className="pf-art-clay" cx="34" cy="-70" r="14" /><path className="pf-art-ink" d="M17-42v-15h35v15Zm6-48h6v9h-6Z" /></>
          : index % 3 === 1 ? <><path className="pf-art-ink" d="M18-39V-69a16 16 0 0 1 32 0v30Z" /><path className="pf-art-cream" d="M29-38v-24a7 7 0 0 1 14 0v24Z" /><circle className="pf-art-clay" cx="24" cy="-83" r="7" /></>
            : <><path className="pf-art-clay" d="m16-81 21-10 15 19-9 24-25-5Z" /><path className="pf-art-ink" d="m19-43 5-19 22 8-5 14Z" /><circle className="pf-art-cream" cx="31" cy="-74" r="7" /></>}
        <path className="pf-art-caption" d="M11-23h20v2H11Zm0 5h13v2H11Z" />
      </g>
    </g>)}
    <g transform="translate(218 398)"><ellipse className="pf-art-contact" cx="18" cy="15" rx="29" ry="10" /><path className="pf-art-ink" d="m0-5 27-14 27 15-27 15Z" /><path className="pf-art-tool-front" d="M0-5v17l27 15V11Z" /><path className="pf-art-tool-side" d="M27 11v16l27-14V-4Z" /><path className="pf-art-tool-handle" d="m16-11 10-6 16 9v8" /><path className="pf-art-cream" d="m24 8 6-3v7l-6 3Z" /></g>
    <Person x={152} y={358} pose="hang" coat="clay" /><Person x={394} y={430} pose="work" coat="forest" /><Person x={570} y={392} pose="welcome" coat="clay" /><Person x={520} y={433} pose="stand" coat="forest" />
    <g className="pf-art-transport">
      <path className="pf-art-path" d="M74 513c43 6 60 16 91 7s43-16 60-21" />
      <g transform="translate(128 449)">
        <ellipse className="pf-art-contact" cx="18" cy="36" rx="47" ry="12" /><path className="pf-art-trolley" d="m-6-55 5-4 26 79 29-10 3 7-39 13Z" /><path className="pf-art-trolley-edge" d="m-7-57-17-9-6 4 16 9Z" />
        <g transform="matrix(.93 .37 -.24 .88 -13 -46)"><path className="pf-art-frame-side" d="M0 0 7-5h45v69l-7 5H0Z" /><path className="pf-art-frame" d="M0 0h45v69H0Z" /><path className="pf-art-cream" d="M6 6h33v57H6Z" /><path className="pf-art-clay" d="M11 47V29a12 12 0 0 1 24 0v18Z" /><path className="pf-art-ink" d="M12 50h22v7H12Z" /></g>
        <ellipse className="pf-art-wheel" cx="18" cy="31" rx="8" ry="10" /><ellipse className="pf-art-wheel-hub" cx="17" cy="30" rx="3" ry="4" /><ellipse className="pf-art-wheel" cx="51" cy="17" rx="6" ry="8" />
      </g>
      <Person x={76} y={479} pose="carry" coat="forest" />
    </g>
  </svg>;
}

function Person({ x, y, pose, coat }: { x: number; y: number; pose: 'stand' | 'hang' | 'work' | 'welcome' | 'carry'; coat: 'clay' | 'forest' }) {
  const working = pose === 'work';
  return <g transform={`translate(${x} ${y})`} className={`pf-art-person pf-art-person--${coat}`}>
    <ellipse className="pf-art-contact" cx="9" cy="7" rx={working ? 24 : 18} ry="7" />
    {working ? <><path className="pf-art-trousers" d="m-1-28 16 4 17 21-9 5-19-17-10 7-10-5Z" /><path className="pf-art-shoe" d="m20 0 6-4 12 4c5 6-5 10-14 7Z" /></>
      : <><path className="pf-art-trousers" d="m-8-33 23-1-3 21L8 4H0l-1-23-6 20h-9l5-25Z" /><path className="pf-art-shoe" d="m0 0 9-1 8 6c4 6-7 7-15 3Zm-15-3 8 1 4 6c1 5-11 4-14 0Z" /></>}
    <path className="pf-art-coat-side" d={working ? 'm-4-65 21 8 9 30-24 12-14-15Z' : 'm-8-63 21 2 10 29-9 8-29-9Z'} /><path className="pf-art-coat" d={working ? 'm-4-65 12 4 3 25-14 11-12-10Z' : 'm-8-63 12 3 8 27-26-1 1-18Z'} />
    <path className="pf-art-neck" d="m-3-69 11 2-1 9-11-3Z" /><path className="pf-art-face" d="M-9-77c0-9 6-14 14-12 8 1 12 8 10 16l-3 8-9 1-10-5Z" /><path className="pf-art-hair" d="M-10-77c-3-10 4-19 14-18 10 0 16 7 13 14l-9-4-5 8-6-2-3 8-5-2Z" />
    {pose === 'hang' ? <><path className="pf-art-sleeve" d="m8-58 15-17 8 5-17 25Z" /><path className="pf-art-hand" d="m23-76 4-13c4-5 7-1 6 3l-1 10-1 6Z" /></>
      : pose === 'carry' ? <><path className="pf-art-sleeve" d="m10-58 19 8 8-5 4 9-13 8-20-5Z" /><path className="pf-art-hand" d="m35-57 10-4 6 4-5 6-9 5Z" /></>
        : pose === 'welcome' ? <><path className="pf-art-sleeve" d="m8-57 16 11 15-8 4 8-22 12-17-13Z" /><path className="pf-art-hand" d="m38-55 10-7 5 3-5 11-7 3Z" /></>
          : working ? <><path className="pf-art-sleeve" d="m9-58 17 16-9 10-6-9-11-4Z" /><path className="pf-art-hand" d="m24-44 11 3 1 8-10 2-8-4Z" /></>
            : <><path className="pf-art-sleeve" d="m9-59 12 10 1 21-8 3-4-18Z" /><path className="pf-art-hand" d="m15-27 6-1 2 10-5 3-5-5Z" /></>}
  </g>;
}
