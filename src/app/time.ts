import { Temporal } from '@js-temporal/polyfill';

export type TimeError = 'invalid_datetime' | 'invalid_timezone' | 'ambiguous_time' | 'nonexistent_time';
export type TimeResult = { ok: true; utcMilliseconds: number } | { ok: false; error: TimeError };
export type TimeDisambiguation = 'reject' | 'earlier' | 'later';
export function isTimeZone(value: string): boolean {
  // Numeric offsets are not named zones. UTC and IANA aliases are supported.
  if (!value || /^[+-]/.test(value)) return false;
  try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value); return true; }
  catch { return false; }
}

/** Never interprets form values using the computer's implicit timezone. */
export function localDateTimeToUtc(local: string, timeZone: string, disambiguation: TimeDisambiguation = 'reject'): TimeResult {
  if (!isTimeZone(timeZone)) return { ok: false, error: 'invalid_timezone' };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) return { ok: false, error: 'invalid_datetime' };
  let plain: Temporal.PlainDateTime;
  try { plain = Temporal.PlainDateTime.from(local, { overflow: 'reject' }); }
  catch { return { ok: false, error: 'invalid_datetime' }; }
  const earlier = plain.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  const later = plain.toZonedDateTime(timeZone, { disambiguation: 'later' });
  if (!earlier.toPlainDateTime().equals(plain) || !later.toPlainDateTime().equals(plain)) {
    // A nonexistent clock time must be corrected; disambiguation cannot quietly shift it.
    return { ok: false, error: 'nonexistent_time' };
  }
  if (earlier.epochMilliseconds !== later.epochMilliseconds && disambiguation === 'reject') return { ok: false, error: 'ambiguous_time' };
  return { ok: true, utcMilliseconds: (disambiguation === 'later' ? later : earlier).epochMilliseconds };
}

export function utcToLocalDateTime(utcMilliseconds: number, timeZone: string): string {
  if (!Number.isSafeInteger(utcMilliseconds)) throw new TypeError('Time must be integer UTC milliseconds.');
  if (!isTimeZone(timeZone)) throw new TypeError('A named time zone is required.');
  return Temporal.Instant.fromEpochMilliseconds(utcMilliseconds).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: 'minute' });
}
export function formatDateTime(utcMilliseconds: number, timeZone: string, options: Intl.DateTimeFormatOptions = {}): string {
  if (!Number.isSafeInteger(utcMilliseconds) || !isTimeZone(timeZone)) throw new TypeError('A valid instant and named time zone are required.');
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', ...options, timeZone }).format(utcMilliseconds);
}
export const formatQuantity = (quantity: number): string => new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(quantity);
