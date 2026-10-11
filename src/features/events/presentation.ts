import { formatDateTime, localDateTimeToUtc } from '../../app/time';
import type { EventFilters } from '../../data/events/types';
import type { RepositoryError } from '../../data/types';
import type { AudienceTerms, EventAvailability } from '../../domain/events';
import type { Tone } from '../../ui';

export const availabilityCopy: Record<EventAvailability, { label: string; tone: Tone; explanation: string }> = {
  open: { label: 'Open for registration', tone: 'success', explanation: 'You can record your intention to attend this event.' },
  paused: { label: 'Plans are being updated', tone: 'warning', explanation: 'The organizers need to restore agreement on the event preparations. New registrations are paused.' },
  closed: { label: 'Registration closed', tone: 'neutral', explanation: 'The organizer has closed registration. Existing registrations remain visible.' },
  cancelled: { label: 'Event cancelled', tone: 'danger', explanation: 'The organizer has cancelled this event.' },
  ended: { label: 'Event ended', tone: 'neutral', explanation: 'This event has ended. A registration is an intention to attend, not evidence that someone was there.' },
  unverified: { label: 'Status needs verification', tone: 'warning', explanation: 'The current event details or preparations could not be fully verified. Refresh before making a decision.' },
};

export function eventDate(terms: AudienceTerms): string {
  return `${formatDateTime(terms.startsAt, terms.timeZone)} to ${formatDateTime(terms.endsAt, terms.timeZone)}`;
}

export function eventError(error: RepositoryError): string {
  switch (error.code) {
    case 'not_found': case 'expired': return 'This event record is unavailable. It may have expired or been removed. This does not mean the organizer cancelled the event.';
    case 'conflict': case 'stale_heads': return 'The saved details changed while you were reviewing them. Refresh and review the current event before continuing.';
    case 'incomplete': return 'Only part of the event data could be read. Refresh to check the complete record.';
    case 'rejected': return 'The wallet request was cancelled. Your selected event has been kept. Check the saved request before trying again.';
    case 'not_connected': case 'unauthorized': return 'Connect the wallet shown in this registration review before continuing.';
    case 'wrong_chain': return 'Switch your wallet to Tiramisu, then review this registration again.';
    case 'storage': return 'The request could not be saved safely in this browser. No new request will be sent until recovery is available.';
    case 'reverted': return 'The transaction did not complete. Check the saved request, refresh the event and review your decision again.';
    case 'invalid_input': return 'Some details are no longer valid. Refresh the event and review the highlighted information.';
    default: return 'The current record could not be verified. Your selected event and saved request are kept. Refresh or check the original request.';
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
