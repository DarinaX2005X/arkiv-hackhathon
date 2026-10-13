import type { EventFormat } from '../../domain/events';

const covers = {
  in_person: { file: 'gathering.svg', description: 'An illustrated gathering space with a round table and chairs' },
  online: { file: 'online.svg', description: 'An illustrated laptop and microphone for an online gathering' },
  hybrid: { file: 'hybrid.svg', description: 'An illustrated shared space connected to an online screen' },
} as const;

/** Original format illustrations are presentation only and never alter published event terms. */
export function EventCover({ format, className = '', decorative = true }: {
  format?: EventFormat;
  className?: string;
  decorative?: boolean;
}) {
  const cover = covers[format ?? 'in_person'];
  return <div className={`pf-event-cover pf-event-cover--${format ?? 'in_person'} ${className}`}>
    <img src={`/event-art/${cover.file}`} width="600" height="480" alt={decorative ? '' : cover.description} loading="lazy" decoding="async" />
  </div>;
}

export function EventFactIcon({ name }: { name: 'calendar' | 'clock' | 'place' | 'online' | 'in_person' | 'hybrid' | 'check' | 'people' }) {
  return <svg className="pf-event-fact-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'calendar' && <><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 10h16m-12 4h2m4 0h2m-8 3h2" /></>}
    {name === 'clock' && <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>}
    {name === 'place' && <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>}
    {name === 'online' && <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 21h8m-4-5v5" /></>}
    {name === 'in_person' && <><circle cx="12" cy="7" r="3" /><path d="M6 21v-4a6 6 0 0 1 12 0v4M9 21v-5m6 5v-5" /></>}
    {name === 'hybrid' && <><rect x="2" y="3" width="13" height="10" rx="2" /><path d="M6 17h5m-2-4v4" /><circle cx="18" cy="14" r="2.5" /><path d="M14 22v-2a4 4 0 0 1 8 0v2" /></>}
    {name === 'check' && <><path d="m8 12 3 3 5-6" /><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z" /></>}
    {name === 'people' && <><circle cx="9" cy="7" r="3" /><path d="M3 21v-4a6 6 0 0 1 12 0v4m2-17a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5v2" /></>}
  </svg>;
}
