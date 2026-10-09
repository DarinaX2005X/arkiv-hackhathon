import { describe, expect, it } from 'vitest';
import { formatDateTime, formatQuantity, localDateTimeToUtc, utcToLocalDateTime } from '../time';

describe('explicit project time zones', () => {
  it('rejects nonexistent and ambiguous New York clock times by default', () => {
    expect(localDateTimeToUtc('2026-03-08T02:30', 'America/New_York')).toEqual({ ok: false, error: 'nonexistent_time' });
    expect(localDateTimeToUtc('2026-11-01T01:30', 'America/New_York')).toEqual({ ok: false, error: 'ambiguous_time' });
    const early = localDateTimeToUtc('2026-11-01T01:30', 'America/New_York', 'earlier');
    const late = localDateTimeToUtc('2026-11-01T01:30', 'America/New_York', 'later');
    expect(early).toEqual({ ok: true, utcMilliseconds: Date.UTC(2026, 10, 1, 5, 30) });
    expect(late).toEqual({ ok: true, utcMilliseconds: Date.UTC(2026, 10, 1, 6, 30) });
  });

  it('converts a named project zone independently from machine-local time', () => {
    const value = localDateTimeToUtc('2026-10-09T15:45', 'Asia/Qyzylorda');
    expect(value).toEqual({ ok: true, utcMilliseconds: Date.UTC(2026, 9, 9, 10, 45) });
    if (value.ok) expect(utcToLocalDateTime(value.utcMilliseconds, 'Asia/Qyzylorda')).toBe('2026-10-09T15:45');
    expect(formatDateTime(Date.UTC(2026, 9, 9, 10, 45), 'Asia/Qyzylorda')).toContain('2026');
    expect(formatQuantity(12000)).toBe('12,000');
  });

  it('rejects invalid dates, implicit zones and offset-bearing form values', () => {
    expect(localDateTimeToUtc('2026-02-30T10:00', 'UTC')).toEqual({ ok: false, error: 'invalid_datetime' });
    expect(localDateTimeToUtc('2026-10-09T10:00Z', 'UTC')).toEqual({ ok: false, error: 'invalid_datetime' });
    expect(localDateTimeToUtc('2026-10-09T10:00', 'invalid/zone')).toEqual({ ok: false, error: 'invalid_timezone' });
    expect(localDateTimeToUtc('2026-10-09T10:00', '+05:00')).toEqual({ ok: false, error: 'invalid_timezone' });
  });
});
