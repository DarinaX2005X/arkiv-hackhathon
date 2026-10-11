import { useId } from 'react';
import type { TourArt } from './tour';

/** Original geometric artwork. Decorative objects illustrate capabilities, never saved activity. */
export function TourIllustration({ scene }: { scene: TourArt }) {
  const id = useId().replace(/:/g, '');
  const cream = `url(#${id}-cream)`, green = `url(#${id}-green)`;
  return <svg viewBox="0 0 560 280" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-cream`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#FFFFFF" /><stop offset="1" stopColor="#E5EBD9" /></linearGradient>
      <linearGradient id={`${id}-green`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#54795D" /><stop offset="1" stopColor="#224E3D" /></linearGradient>
      <linearGradient id={`${id}-ground`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#F0F5E8" /><stop offset="1" stopColor="#D4E5C7" /></linearGradient>
      <filter id={`${id}-shadow`} x="-20%" y="-20%" width="145%" height="155%"><feDropShadow dx="0" dy="8" stdDeviation="5" floodColor="#244D37" floodOpacity=".14" /></filter>
    </defs>
    <rect width="560" height="280" rx="18" fill={`url(#${id}-ground)`} />
    <ellipse cx="282" cy="238" rx="185" ry="20" fill="#294E38" opacity=".09" />
    <g filter={`url(#${id}-shadow)`} strokeLinejoin="round">
      {scene === 'event' && <>
        <path d="m111 198 130-58 192 54-132 63z" fill="#B5C7A5" /><path d="m111 187 130-58 192 54-132 63z" fill={cream} /><path d="m111 187 190 59v11l-190-59z" fill="#A0B795" />
        <path d="m139 163 65-30 1-63-66 31z" fill="#D0DDC6" /><path d="m204 70 39 11v63l-38-11z" fill="#91AC87" /><path d="m128 101 77-42 52 17-77 42z" fill={cream} /><path d="m128 101 52 17v12l-52-17z" fill="#BECFB3" /><path d="m180 118 77-42v12l-77 42z" fill={green} />
        <path d="m156 123 23-10v44l-23 11z" fill="#54765A" />
        <path d="m281 192 44-20 30 9-44 20z" fill="#577254" /><path d="m309 168 12-5v29l-12 5z" fill="#A4B997" />
        <path d="m271 75 106 28v78l-106-29z" fill="#2A4F3D" /><path d="m278 69 108 29v78l-108-29z" fill={green} /><path d="m287 81 89 24v57l-89-24z" fill={cream} /><path d="m322 103 24 20-24 7z" fill="#54795D" />
        <path d="m227 180 56 17v42l-56-17z" fill="#C0D5AB" /><path d="m232 166 56 17v47l-56-17z" fill={cream} /><path d="m232 166 56 17v12l-56-17z" fill={green} />
        <path d="m244 196 7 2v7l-7-2zm15 5 7 2v7l-7-2zm15 4 7 2v7l-7-2z" fill="#66845D" />
      </>}
      {scene === 'resources' && <>
        <path d="m115 186 90-44 107 31-91 47z" fill={cream} /><path d="m115 186 106 34v29l-106-33z" fill="#A9BD98" /><path d="m221 220 91-47v29l-91 47z" fill={green} />
        <path d="m139 153 41-20 66 20-42 21z" fill={cream} /><path d="m139 153 65 21v31l-65-21z" fill="#C4D4B9" /><path d="m204 174 42-21v31l-42 21z" fill="#73916A" />
        <path d="m300 210 65-31 55 17-65 32z" fill="#9DB58B" /><path d="m326 204 17-7V97l-17 7z" fill="#E9EFDF" /><path d="m343 97 11 3v103l-11-6z" fill="#A0B98F" />
        <path d="m292 99 52-25 53 16-52 25z" fill={cream} /><path d="m292 99 53 16v14l-53-16z" fill="#C9DAC0" /><path d="m345 115 52-25v14l-52 25z" fill={green} />
        <path d="m203 82 36-18 43 13v72l-37 18-42-13z" fill={green} /><path d="m203 82 42 13v72l-42-13z" fill="#446B4C" /><path d="m210 91 26 8v26l-26-8z" fill="#B6CEA4" /><ellipse cx="226" cy="142" rx="11" ry="13" fill="#183F2E" transform="rotate(-15 226 142)" />
        <path d="m158 126 17-8v23l-17 8z" fill="#3D6245" /><path d="m158 126 10 3 17-8-10-3z" fill="#BCD0AA" />
      </>}
      {scene === 'agreement' && <>
        <path d="m107 183 91-43 83 24-90 46z" fill="#AEC29B" /><path d="m107 174 91-44 83 25-90 46z" fill={cream} /><path d="m107 174 84 27v9l-84-27z" fill="#C0D2B1" />
        <path d="m300 182 88-42 76 22-88 44z" fill="#AEC29B" /><path d="m300 173 88-42 76 22-88 44z" fill={cream} /><path d="m300 173 76 24v9l-76-24z" fill="#C0D2B1" />
        <path d="m206 122 74-35 72 22-74 36z" fill={cream} /><path d="m206 122 72 23v16l-72-23z" fill="#B5CBA5" /><path d="m278 145 74-36v16l-74 36z" fill={green} />
        <path d="m202 193 71-36 77 27" fill="none" stroke="#789866" strokeWidth="8" />
        <ellipse cx="189" cy="173" rx="25" ry="13" fill="#386148" /><ellipse cx="189" cy="167" rx="25" ry="13" fill="#A6C486" /><path d="m178 165 9 7 15-11" fill="none" stroke="#234A32" strokeWidth="4" strokeLinecap="round" />
        <ellipse cx="380" cy="170" rx="25" ry="13" fill="#386148" /><ellipse cx="380" cy="164" rx="25" ry="13" fill="#A6C486" /><path d="m369 162 9 7 15-11" fill="none" stroke="#234A32" strokeWidth="4" strokeLinecap="round" />
        <path d="m249 110 23 7 24-12m-57 18 23 7 24-12" fill="none" stroke="#739369" strokeWidth="4" strokeLinecap="round" />
        <path d="m260 208 19-9 27 8-19 10z" fill={cream} /><path d="m260 208 27 9v19l-27-9z" fill="#87A175" /><path d="m287 217 19-10v19l-19 10z" fill={green} />
      </>}
      {scene === 'return' && <>
        <path d="m155 107 57-27 39 12 24-12 121 36v112l-86 40-155-47z" fill="#9FB98B" /><path d="m155 107 57-27 39 12v20l-96 45z" fill="#CADDB9" />
        <path d="m198 98 104-35 61 24v118l-102 40-63-27z" fill="#E5ECD9" /><path d="m214 112 104-35 61 24v115l-104 40-61-27z" fill={cream} />
        <path d="m287 104 76 23m-76-8 58 18m-58-3 66 20" stroke="#A1B993" strokeWidth="5" strokeLinecap="round" />
        <path d="m147 148 54-26 50 15 17-9 137 42-95 46z" fill="#E4EFCF" /><path d="m147 148 163 49v65l-163-49z" fill={green} /><path d="m310 197 95-45v66l-95 44z" fill="#264B34" />
        <path d="m176 181 49 15v16l-49-15z" fill="#D7E6C1" />
        <path d="m108 218 34-17 37 11-34 18z" fill={cream} /><path d="m108 218 37 12v10l-37-12z" fill="#B8CCA5" /><path d="m145 230 34-18v10l-34 18z" fill="#749462" />
      </>}
    </g>
  </svg>;
}
