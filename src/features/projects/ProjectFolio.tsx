import { useId } from 'react';
/** Original paper-and-resource object. Decorative only; no invented project data. */
export function ProjectFolio() {
  const id = useId().replaceAll(':', '');
  return <svg className="project-folio" viewBox="0 0 360 240" aria-hidden="true" focusable="false">
    <defs><linearGradient id={`${id}-paper`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#FFFFFF" /><stop offset="1" stopColor="#E4EADD" /></linearGradient><linearGradient id={`${id}-folder`} x1="0" y1="0" x2="0.9" y2="1"><stop stopColor="#43876A" /><stop offset="1" stopColor="#21523F" /></linearGradient><radialGradient id={`${id}-shadow`}><stop stopColor="#17392A" stopOpacity=".18" /><stop offset="1" stopColor="#17392A" stopOpacity="0" /></radialGradient></defs>
    <ellipse cx="178" cy="200" rx="151" ry="30" fill={`url(#${id}-shadow)`} />
    <path d="M56 73Q56 64 66 64L129 53Q135 52 139 59L147 69L278 48Q289 46 289 59V165L65 205Q56 207 56 195Z" fill="#214C39" />
    <path d="M71 66L263 37L274 158L82 190Z" fill="#D5DFD0" />
    <path d="M84 45Q84 39 91 38L249 17Q257 16 259 23L279 153L105 178Z" fill={`url(#${id}-paper)`} stroke="#E0E8DA" />
    <path d="M110 67L223 51M113 83L199 71M119 120L235 103M122 137L215 123" stroke="#A1B8A7" strokeWidth="6" strokeLinecap="round" />
    <path d="M58 110Q56 102 67 101L151 91Q158 90 163 96L170 105L290 86Q300 85 299 96L285 179Q284 187 276 189L68 217Q60 218 60 209Z" fill={`url(#${id}-folder)`} />
    <path d="M65 109L152 99L169 113L291 94" fill="none" stroke="#77A38B" strokeWidth="2" />
    <path d="M66 216L276 188L285 179L285 190L71 222Q63 223 60 218Z" fill="#173C2B" />
    <g transform="translate(245 138)"><path d="M0 20L36 10L70 24L33 35Z" fill="#E3EBCF" /><path d="M0 20V58L33 74V35Z" fill="#B9CEA9" /><path d="M33 35L70 24V61L33 74Z" fill="#91AF84" /><path d="M35 11L20 16L54 30L54 47L62 44V27Z" fill="#EFF4E2" /></g>
  </svg>;
}
