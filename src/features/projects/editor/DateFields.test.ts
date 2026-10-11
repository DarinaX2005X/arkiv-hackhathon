import { describe, expect, it } from 'vitest';
import { dateInputType, timeZoneOptions } from './DateFields';

describe('date entry preserves unfinished imported values', () => {
  it('uses native date entry for empty and valid dates', () => {
    expect(dateInputType('')).toBe('datetime-local');
    expect(dateInputType('2026-10-17T09:00')).toBe('datetime-local');
  });
  it('keeps invalid calendar values in a readable text field for recovery', () => {
    expect(dateInputType('unfinished date')).toBe('text');
    expect(dateInputType('2026-02-30T09:00')).toBe('text');
    expect(dateInputType('2026-13-99T25:70')).toBe('text');
  });
  it('does not replace valid clock input when daylight saving needs separate resolution', () => {
    expect(dateInputType('2026-03-29T01:30')).toBe('datetime-local');
    expect(dateInputType('2026-10-25T01:30')).toBe('datetime-local');
  });
  it('keeps a saved zone and readable native choices without rewriting its identity', () => {
    const options = timeZoneOptions('US/Eastern');
    expect(options).toContainEqual({ value: 'US/Eastern', label: 'Eastern, US' });
    expect(options).toContainEqual({ value: 'America/New_York', label: 'New York, America' });
    expect(new Set(options.map(option => option.value)).size).toBe(options.length);
  });
});
