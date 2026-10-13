import { useEffect, useId, useRef, type CSSProperties } from 'react';
import './event-scene.css';

/** Original illustration. One oblique camera, upper-left light and solid cream
 * objects connect a physical gathering, an online session and owned resources.
 * There are no product controls, sample records or fabricated live activity. */
export function EventScene() {
  const scene = useRef<HTMLDivElement>(null);
  const id = `event-${useId().replaceAll(':', '')}`;
  useEffect(() => {
    const node = scene.current;
    if (!node || typeof IntersectionObserver === 'undefined' || typeof window.matchMedia !== 'function') return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let inView = false;
    const sync = () => { node.dataset.playing = String(inView && !document.hidden && !reducedMotion.matches); };
    const observer = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); sync(); }, { threshold: .1 });
    observer.observe(node);
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reducedMotion.removeEventListener('change', sync);
      node.dataset.playing = 'false';
    };
  }, []);

  const materials = {
    '--event-paper': `url(#${id}-paper)`, '--event-edge': `url(#${id}-edge)`,
    '--event-green': `url(#${id}-green)`, '--event-screen': `url(#${id}-screen)`,
    '--event-shadow': `url(#${id}-shadow)`, '--event-light': `url(#${id}-light)`,
  } as CSSProperties;

  return <div ref={scene} className="pf-event-scene" data-playing="false" style={materials}>
    <svg className="pf-event-art" viewBox="0 0 720 610" width="720" height="610" role="img" aria-labelledby={`${id}-title ${id}-description`} focusable="false">
      <title id={`${id}-title`}>An event brought together from everyone’s contributions</title>
      <desc id={`${id}-description`}>A dimensional gathering space connects to an online session and an equipment case. A separate signed agreement sits beside each contribution. People can come together while each contributor retains control of their part.</desc>
      <defs>
        <linearGradient id={`${id}-paper`} x1="0" y1="0" x2=".85" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="var(--art-highlight)" /><stop offset=".52" stopColor="var(--art-cream)" /><stop offset="1" stopColor="var(--art-sand)" /></linearGradient>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2=".8" gradientUnits="objectBoundingBox"><stop stopColor="var(--art-sand)" /><stop offset="1" stopColor="var(--art-shadow)" /></linearGradient>
        <linearGradient id={`${id}-green`} x1="0" y1="0" x2=".9" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="var(--surface-dark-light)" /><stop offset="1" stopColor="var(--surface-dark)" /></linearGradient>
        <linearGradient id={`${id}-screen`} x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="var(--surface-dark-light)" /><stop offset=".68" stopColor="var(--surface-dark)" /><stop offset="1" stopColor="var(--text-on-light)" /></linearGradient>
        <radialGradient id={`${id}-light`}><stop stopColor="var(--action-on-dark)" stopOpacity=".12" /><stop offset="1" stopColor="var(--action-on-dark)" stopOpacity="0" /></radialGradient>
        <filter id={`${id}-shadow`} x="-25%" y="-45%" width="150%" height="190%"><feGaussianBlur stdDeviation="6" /></filter>
      </defs>

      {/* The far and middle planes are part of a single architectural stage. */}
      <path className="pf-event-far-plane" d="m35 280 292-162 368 202v75L400 562 35 360Z" />
      <ellipse className="pf-event-light" cx="403" cy="294" rx="292" ry="246" />
      <path className="pf-event-ground-shadow" d="m49 422 282-160 369 197-294 139Z" />
      <path className="pf-event-base-side" d="m32 362 298-164 366 204v21L398 590 32 384Z" />
      <path className="pf-event-base" d="m32 362 298-164 366 204-298 167Z" />
      <path className="pf-event-base-edge" d="m33 362 365 207 296-167" />

      {/* The room has an open arch, floor, edge thickness and a receiving wall. */}
      <g className="pf-event-room">
        <path className="pf-event-contact" d="m67 329 194-106 204 113-197 111Z" />
        <path className="pf-event-room-edge" fillRule="evenodd" d="M74 302V134q0-11 9-16L232 35q10-5 10 6v168ZM112 293V139q0-41 37-61a47 47 0 0 1 70 42v115Z" />
        <path className="pf-event-paper" fillRule="evenodd" d="M85 308V139q0-9 8-13l145-81q8-4 8 6v168l-27 16V120a47 47 0 0 0-70-42q-37 20-37 61v154Z" />
        <path className="pf-event-rim" d="m74 127 11 6L246 44l-11-6Z" />
        <path className="pf-event-arch-reveal" d="M112 293V139q0-41 37-61a47 47 0 0 1 70 42v8a43 43 0 0 0-64-38q-32 18-32 53v144Z" />
        <path className="pf-event-room-edge" d="m244 207 205 114v19L252 449 59 341v-15Z" />
        <path className="pf-event-paper" d="m59 326 185-102 205 114-197 109Z" />
        <path className="pf-event-floor-light" d="m125 289 92-51 174 98-91 52Z" />
        <path className="pf-event-floor-line" d="m220 273 103 58m-157-27 104 58" />
        <g transform="matrix(1 .55 0 1 264 148)">
          <path className="pf-event-room-edge" d="M0 0 10-6h101v96l-10 6H0Z" />
          <rect className="pf-event-paper" width="101" height="96" rx="6" />
          <path className="pf-event-green" d="M11 11h79v62H11Z" />
          <path className="pf-event-mint" d="M28 59V40a22 22 0 0 1 44 0v19Z" />
          <path className="pf-event-green" d="M42 59V39a8 8 0 0 1 16 0v20Z" />
          <path className="pf-event-caption" d="M12 83h41m8 0h27" />
          <path className="pf-event-leg" d="M12 96v24m75-24v24" />
        </g>
        <Bench x={142} y={330} />
        <Bench x={213} y={370} />
        <Person x={177} y={333} coat="mint" />
        <Person x={296} y={340} coat="cream" />
        <Person x={252} y={398} coat="forest" />
      </g>

      {/* A freestanding monitor is a physical object, not a simulated app. */}
      <g className="pf-event-online">
        <path className="pf-event-contact" d="m410 332 93-50 153 81-93 52Z" />
        <path className="pf-event-screen-foot-side" d="m451 321 74-40 97 54v10l-74 41-97-55Z" />
        <path className="pf-event-paper" d="m451 321 74-40 97 54-74 41Z" />
        <path className="pf-event-screen-stand" d="m516 242 23 13v73l-23-12Z" />
        <path className="pf-event-rim" d="m539 255 11-6v73l-11 6Z" />
        <g transform="matrix(1 .55 0 1 425 62)">
          <path className="pf-event-room-edge" d="M0 0 12-7h201q9 0 9 9v166q0 9-9 9l-12 7H0Z" />
          <rect className="pf-event-paper" width="210" height="184" rx="12" />
          <rect className="pf-event-screen-face" x="11" y="11" width="188" height="154" rx="5" />
          <path className="pf-event-screen-highlight" d="M14 54V19q0-4 5-4h88Z" />
          <circle className="pf-event-cream" cx="111" cy="66" r="18" />
          <path className="pf-event-mint" d="M75 129v-17a36 36 0 0 1 72 0v17Z" />
          <path className="pf-event-green" d="m92 130 8-37 12 7 11-7 10 37Z" />
          <path className="pf-event-cream" d="m147 115 20-19 5 7-23 27Z" />
          <path className="pf-event-screen-detail" d="M20 146h169" />
          <circle className="pf-event-screen-camera" cx="104" cy="175" r="2.5" />
        </g>
      </g>

      {/* Physical links remain on the receiving plane; no floating UI badges. */}
      <path className="pf-event-connection" d="m367 402 68 38 50-28m-50 28-82 46" />
      <g className="pf-event-resource">
        <path className="pf-event-contact" d="m472 432 70-38 105 58-70 40Z" />
        <g transform="translate(478 381)">
          <path className="pf-event-case-side" d="m0 18 53-30 94 52v47l-54 30L0 65Z" />
          <path className="pf-event-green" d="m0 18 93 52v47L0 65Z" />
          <path className="pf-event-case-top" d="m0 18 53-30 94 52-54 30Z" />
          <path className="pf-event-case-seam" d="m0 30 93 52 54-30" />
          <path className="pf-event-case-handle" d="m52 4 12-7q4-2 8 0l22 12q4 2 4 7v6" />
          <path className="pf-event-cream" d="m17 37 9 5v15l-9-5Zm52 29 9 5v15l-9-5Z" />
          <path className="pf-event-case-edge" d="m3 18 50-28 91 50" />
        </g>
        <g className="pf-event-secondary-object" transform="matrix(1 .55 0 1 595 334)">
          <path className="pf-event-room-edge" d="m0 0 8-5h30v54l-8 5H0Z" />
          <rect className="pf-event-paper" width="30" height="54" rx="4" />
          <circle className="pf-event-green" cx="15" cy="18" r="7" /><circle className="pf-event-green" cx="15" cy="39" r="10" />
        </g>
      </g>

      {/* Each owned contribution carries a separate agreement on the shared
          receiving plane. No central sheet stands in for all three authors. */}
      <g className="pf-event-agreements">
        <Agreement x={194} y={435} />
        <Agreement x={447} y={333} />
        <Agreement x={364} y={464} />
      </g>
      <g className="pf-event-secondary-object pf-event-plant" transform="translate(79 381)">
        <ellipse className="pf-event-contact" cx="0" cy="20" rx="29" ry="10" />
        <path className="pf-event-room-edge" d="M-20-10h40L15 20q-15 9-30 0Z" />
        <ellipse className="pf-event-paper" cy="-10" rx="20" ry="11" />
        <ellipse className="pf-event-green" cy="-11" rx="14" ry="6" />
        <path className="pf-event-stem" d="M0-11v-82m0 42-20-22m20 39 18-31" />
        <path className="pf-event-leaf" d="M0-60Q-26-68-29-96-3-92 0-60Zm0-18q-7-34 13-43 9 26-13 43Zm1 38q4-33 29-39-2 31-29 39Z" />
      </g>
    </svg>
  </div>;
}

function Bench({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}>
    <path className="pf-event-contact" d="m-12 12 34-18 78 42-34 19Z" />
    <path className="pf-event-leg" d="M0 0v22m70 18v22m-44-77V7m63 20v21" />
    <path className="pf-event-room-edge" d="m-7-6 30-17 83 46v9L76 49-7 3Z" />
    <path className="pf-event-paper" d="m-7-6 30-17 83 46-30 17Z" />
  </g>;
}

function Person({ x, y, coat }: { x: number; y: number; coat: 'mint' | 'cream' | 'forest' }) {
  return <g transform={`translate(${x} ${y})`} className={`pf-event-person pf-event-person--${coat}`}>
    <ellipse className="pf-event-contact" cx="7" cy="6" rx="20" ry="7" />
    <path className="pf-event-trousers" d="m-9-31 24 1 6 30-9 3-9-23L-2 5h-10Z" />
    <path className="pf-event-shoe" d="m-12 0 9 1 6 7q-8 6-17-1Zm23-3 8-1 10 7q-5 7-16 2Z" />
    <path className="pf-event-coat-edge" d="M-13-59q14-12 27 2l8 29-15 10-22-12Z" />
    <path className="pf-event-coat" d="M-13-59q10-9 18-4l9 35-25 1-5-13Z" />
    <path className="pf-event-skin" d="m-4-71 12 2-1 11-11-4Z" />
    <ellipse className="pf-event-skin" cx="1" cy="-81" rx="12" ry="15" />
    <path className="pf-event-hair" d="M-11-80q-6-21 11-23 19 1 15 19l-10-8-6 14-7-5-1 11Z" />
    <path className="pf-event-coat" d="m7-59 13 12 14-8 4 9-20 13-14-14Z" />
    <path className="pf-event-skin" d="m33-55 7-8 6 1-2 12-8 4Z" />
  </g>;
}

function Agreement({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}>
    <path className="pf-event-contact" d="m-3 6 51-29 90 50-51 28Z" />
    <path className="pf-event-room-edge" d="m0 0 48-27 85 47v5l-48 27L0 5Z" />
    <path className="pf-event-paper" d="m0 0 48-27 85 47-48 27Z" />
    <path className="pf-event-agreement-lines" d="m26-3 29 16m-16-23 36 20" />
    <path className="pf-event-agreement-signature" d="m36 8 7-6 4 8 7-4 8 4" />
    <path className="pf-event-green" d="m85 14 13-7 13 7v5l-13 7-13-7Z" />
    <path className="pf-event-mint" d="m85 14 13-7 13 7-13 7Z" />
    <path className="pf-event-agreement-mark" d="m92 13 5 3 8-4" />
  </g>;
}
