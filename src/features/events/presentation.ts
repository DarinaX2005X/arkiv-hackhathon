import { formatDateTime, localDateTimeToUtc } from '../../app/time';
import type { EventFilters } from '../../data/events/types';
import type { RepositoryError } from '../../data/types';
import type { AudienceTerms, EventAvailability } from '../../domain/events';
import type { Tone } from '../../ui';

export const availabilityCopy: Record<EventAvailability, { label: string; tone: Tone; explanation: string }> = {
  registration_closed: { label: 'Registration deadline passed', tone: 'neutral', explanation: 'The registration deadline has passed. Existing confirmed places are kept.' },
  full: { label: 'Fully booked', tone: 'neutral', explanation: 'All places are reserved. Check back if the organizer releases a place.' },
  waitlist: { label: 'Waiting list open', tone: 'warning', explanation: 'All places are reserved. You can ask to join the waiting list; a place is confirmed only by the organizer.' },
  open: { label: 'Open for registration', tone: 'success', explanation: 'Registration is open. Review how places are confirmed before joining.' },
  paused: { label: 'Plans are being updated', tone: 'warning', explanation: 'The organizers need to restore agreement on the event preparations. New registrations are paused.' },
  closed: { label: 'Registration closed', tone: 'neutral', explanation: 'The organizer has closed registration. Existing registrations remain visible.' },
  cancelled: { label: 'Event cancelled', tone: 'danger', explanation: 'The organizer has cancelled this event.' },
  ended: { label: 'Event ended', tone: 'neutral', explanation: 'This event has ended. A registration is an intention to attend, not evidence that someone was there.' },
  unverified: { label: 'Status needs verification', tone: 'warning', explanation: 'The current event details or preparations could not be fully verified. Refresh before making a decision.' },
};

export function eventDate(terms: AudienceTerms): string {
  if (eventZoneChanges(terms)) {
    const format = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: terms.timeZone, timeZoneName: 'short' });
    return `${format.format(terms.startsAt)} to ${format.format(terms.endsAt)}`;
  }
  return `${formatDateTime(terms.startsAt, terms.timeZone)} to ${formatDateTime(terms.endsAt, terms.timeZone)}`;
}

function eventZoneChanges(terms: AudienceTerms): boolean {
  const format = new Intl.DateTimeFormat('en', { timeZone: terms.timeZone, timeZoneName: 'shortOffset' });
  const zone = (instant: number) => format.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value;
  return zone(terms.startsAt) !== zone(terms.endsAt);
}

export function eventDayLabel(terms: AudienceTerms): string {
  const format = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: terms.timeZone });
  return format.formatRange(terms.startsAt, terms.endsAt);
}

export function eventTimeLabel(terms: AudienceTerms): string {
  const format = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: terms.timeZone,
    ...(eventZoneChanges(terms) ? { timeZoneName: 'short' as const } : {}) });
  return `${format.format(terms.startsAt)} to ${format.format(terms.endsAt)}`;
}

/** A compact place is separate from the format, so online events never read "Online: Online". */
export function eventLocationLabel(terms: AudienceTerms): string {
  return terms.format === 'online' ? '' : terms.location
    ? [terms.location.city, terms.location.country].filter(Boolean).join(', ')
    : terms.venue;
}

export function eventAdmissionLabel(terms: AudienceTerms): string {
  if (terms.registration?.admission === 'invite_only') return 'Invitation required';
  if (terms.registration?.capacity.kind === 'limited') return 'Organizer confirms places';
  return 'Open to everyone';
}

export function eventError(error: RepositoryError): string {
  switch (error.code) {
    case 'rate_limited': return 'The event data service is temporarily limiting requests. Wait a little, then refresh the event data.';
    case 'network': return 'The event data service could not be reached. Check your connection, then refresh the event data.';
    case 'not_found': case 'expired': return 'This event record is unavailable. It may have expired or been removed. This does not mean the organizer cancelled the event.';
    case 'conflict': case 'stale_heads': return 'The saved details changed while you were reviewing them. Refresh and review the current event before continuing.';
    case 'incomplete': return 'Only part of the event data could be read. Refresh to check the complete record.';
    case 'rejected': return 'The wallet request was cancelled. Your selected event has been kept. Check the saved request before trying again.';
    case 'not_connected': case 'unauthorized': return 'Connect the wallet shown in this registration review before continuing.';
    case 'wrong_chain': return 'Switch your wallet to Tiramisu, then review this registration again.';
    case 'insufficient_funds': return 'This wallet needs test GLM on Arkiv Tiramisu to cover the network fee. Fund it, then retry the saved request.';
    case 'storage': return 'The request could not be saved safely in this browser. No new request will be sent until recovery is available.';
    case 'reverted': return 'The transaction did not complete. Check the saved request, refresh the event and review your decision again.';
    case 'invalid_input': return 'Some details are no longer valid. Refresh the event and review the highlighted information.';
    default: return 'The current event data could not be verified. Refresh before continuing. If you submitted a request, check its saved status before sending another.';
  }
}

/** Date filters mean calendar dates in the explicitly displayed device zone. */
export function catalogueFilters(search: string, from: string, to: string, timeZone: string):
  { ok: true; filters: EventFilters } | { ok: false; error: string } {
  const filters: EventFilters = {};
  if (search.trim()) filters.search = search.trim();
  if (from) {
    const value = localDateTimeToUtc(`${from}T00:00`, timeZone, 'earlier');
    if (!value.ok) return { ok: false, error: 'Choose a valid start date.' };
    filters.from = value.utcMilliseconds;
  }
  if (to) {
    // The end is exclusive. Temporal handles the actual length of the calendar day.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T12:00:00Z`) : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== to) return { ok: false, error: 'Choose a valid end date.' };
    date.setUTCDate(date.getUTCDate() + 1);
    const value = localDateTimeToUtc(`${date.toISOString().slice(0, 10)}T00:00`, timeZone, 'earlier');
    if (!value.ok) return { ok: false, error: 'Choose a valid end date.' };
    filters.to = value.utcMilliseconds - 1;
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) return { ok: false, error: 'The end date must be on or after the start date.' };
  return { ok: true, filters };
}

export const shortAddress = (value: string): string => `${value.slice(0, 8)}…${value.slice(-6)}`;

export const eventFormatLabel = (terms: AudienceTerms): string => terms.format === 'online' ? 'Online' : terms.format === 'hybrid' ? 'Hybrid' : terms.format === 'in_person' ? 'In person' : 'Location provided';
export const eventPlace = (terms: AudienceTerms): string => terms.format === 'online' ? 'Online' : terms.location ? [terms.location.venue, terms.location.city, terms.location.country].filter(Boolean).join(', ') : terms.venue;
export function eventRegistrationLabel(terms: AudienceTerms): string {
  const rules = terms.registration;
  if (!rules) return 'Open registration';
  return [rules.admission === 'invite_only' ? 'Invited wallets only' : 'Open to everyone', rules.capacity.kind === 'limited' ? `${rules.capacity.limit} places, organizer confirmation` : rules.admission === 'invite_only' ? 'Organizer confirmation' : 'No capacity limit'].join(', ');
}
export const audienceLabels: Record<keyof AudienceTerms, string> = { title: 'Event title', description: 'About the event', startsAt: 'Start time', endsAt: 'End time', timeZone: 'Time zone', venue: 'Place', instructions: 'Before you join', conditions: 'Participation conditions', termsVersion: 'Event details', format: 'Event format', location: 'Location', online: 'Online access', registration: 'Registration rules' };
export function audienceValue(terms: AudienceTerms, field: keyof AudienceTerms): string {
  if (field === 'startsAt' || field === 'endsAt') return `${formatDateTime(terms[field], terms.timeZone)} (${terms.timeZone})`;
  if (field === 'format') return eventFormatLabel(terms);
  if (field === 'location') return terms.location ? eventPlace(terms) : 'No physical location';
  if (field === 'online') return terms.online ? [terms.online.url, terms.online.instructions].filter(Boolean).join('\n') : 'No online access';
  if (field === 'registration') return terms.registration ? [eventRegistrationLabel(terms), terms.registration.deadline === null ? 'No registration deadline' : `Register by ${formatDateTime(terms.registration.deadline, terms.timeZone)} (${terms.timeZone})`, terms.registration.waitlist ? 'Waiting list available by choice' : 'No waiting list', ...(terms.registration.admission === 'invite_only' ? [`Invited wallets: ${terms.registration.invitedAccounts.join(', ')}`] : [])].join('\n') : 'Open registration with no capacity limit';
  if (field === 'termsVersion') return terms.termsVersion === 2 ? 'Structured event details' : 'Original event details';
  return String(terms[field] ?? '') || 'Not provided';
}

/** Calendar text is escaped and folded by UTF-8 octets, including untrusted titles. */
export function eventCalendar(terms: AudienceTerms, eventId: string, now = Date.now(), cancelled = false): string {
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  const stamp = (at: number) => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fold = (line: string) => { let current = '', size = 0; const rows: string[] = []; for (const char of line) { const bytes = new TextEncoder().encode(char).length; if (size + bytes > 75) { rows.push(current); current = ' '; size = 1; } current += char; size += bytes; } rows.push(current); return rows.join('\r\n'); };
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Partfolk//Events//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT', `UID:${escape(eventId)}@partfolk`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(terms.startsAt)}`, `DTEND:${stamp(terms.endsAt)}`, `SUMMARY:${escape(terms.title)}`, ...(cancelled ? ['STATUS:CANCELLED'] : []), `LOCATION:${escape(eventPlace(terms))}`, `DESCRIPTION:${escape([terms.description, terms.instructions, terms.conditions, terms.online?.url, terms.online?.instructions, 'Check Partfolk for current event details. A calendar entry does not confirm a place.'].filter(Boolean).join('\n\n'))}`, 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}
export function downloadEventCalendar(terms: AudienceTerms, eventId: string, cancelled = false) {
  const url = URL.createObjectURL(new Blob([eventCalendar(terms, eventId, Date.now(), cancelled)], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'partfolk-event.ics'; link.click(); URL.revokeObjectURL(url);
}
