import { describe, expect, it } from 'vitest';
import { audienceChanges, audienceHash, type AudienceTerms } from '../../../domain/events';
import { emptyPublishingFields, publishingDateInputType, publishingFields, publishingLocalInstant, termsFromFields, validPublishingDraft, type PublishingFields } from './model';
import { catalogueFilters, eventCalendar, eventPlace, audienceValue } from '../presentation';
import { countryOptions, timeZoneOptions } from '../places';

function fields(): PublishingFields { return { ...emptyPublishingFields(true), title: 'A shared workshop', description: 'Meet and make', timeZone: 'UTC', startsLocal: '2030-10-20T18:00', endsLocal: '2030-10-20T20:00', venue: 'Central library', countryCode: 'GB', country: 'United Kingdom', city: 'London', deadlineLocal: '2030-10-19T12:00' }; }
function terms(input = fields()): AudienceTerms { const value = termsFromFields(input); if (!value.ok) throw Error(value.message); return value.terms; }

describe('structured event form and visitor facts', () => {
  it('roundtrips physical, online and hybrid public terms without changing their audience hash', () => {
    for (const input of [fields(), { ...fields(), format: 'online' as const, onlineUrl: 'https://example.com/live?room=public#schedule' }, { ...fields(), format: 'hybrid' as const, onlineInstructions: 'Open the public room listed on the community website.' }]) {
      const first = terms(input), second = terms(publishingFields(first));
      expect(audienceHash(second)).toBe(audienceHash(first));
      expect(audienceChanges(first, second)).toEqual([]);
    }
  });
  it('keeps unedited legacy terms and drafts compatible', () => {
    const { format: _format, countryCode: _code, country: _country, city: _city, deadlineLocal: _deadline, ...raw } = fields();
    const legacy = terms({ ...emptyPublishingFields(), title: raw.title, venue: raw.venue, startsLocal: raw.startsLocal, endsLocal: raw.endsLocal, timeZone: 'UTC' });
    expect(legacy.termsVersion).toBeUndefined(); expect(terms(publishingFields(legacy))).toEqual(legacy);
  });
  it('preserves hidden format fields and invalid input for recovery without publishing them', () => {
    const input = { ...fields(), format: 'online' as const, onlineUrl: '', onlineInstructions: '', capacityKind: 'limited' as const, capacityLimit: '0' };
    const before = structuredClone(input); expect(termsFromFields(input).ok).toBe(false); expect(input).toEqual(before);
    const draft = { projectRoot: `0x${'1'.repeat(64)}`, organizer: `0x${'2'.repeat(40)}`, baselineReleaseKey: null, fields: input };
    expect(validPublishingDraft(draft)).toBe(true);
    expect(validPublishingDraft({ ...draft, fields: { ...input, hiddenSecret: 'no' } })).toBe(false);
    const online = terms({ ...input, onlineInstructions: 'Use the public community directory.', capacityLimit: '10' });
    expect(online.location).toBeNull(); expect(input.venue).toBe('Central library');
  });
  it('validates place, capacity, deadline and invitation choices before review', () => {
    for (const patch of [{ city: '' }, { countryCode: '' }, { capacityKind: 'limited' as const, capacityLimit: '513' }, { capacityKind: 'limited' as const, capacityLimit: '1.5' }, { deadlineLocal: '2030-10-21T12:00' }, { admission: 'invite_only' as const, invitedAccounts: 'not-an-address' }]) expect(termsFromFields({ ...fields(), ...patch }).ok).toBe(false);
    expect(terms({ ...fields(), deadlineLocal: '2030-10-20T19:30' }).registration?.deadline).toBe(Date.parse('2030-10-20T19:30:00Z'));
    const invited = `0x${'A'.repeat(40)}`;
    const parsed = terms({ ...fields(), admission: 'invite_only', invitedAccounts: `${invited}\n${invited.toLowerCase()}`, capacityKind: 'limited', capacityLimit: '5', waitlist: true });
    expect(parsed.registration).toMatchObject({ invitedAccounts: [invited.toLowerCase()], waitlist: true, capacity: { kind: 'limited', limit: 5 } });
    expect(audienceValue(parsed, 'registration')).toContain('5 places');
  });
  it('allows public routing links or instructions while rejecting recognizable credentials', () => {
    expect(terms({ ...fields(), format: 'online', onlineUrl: 'https://www.youtube.com/watch?v=public-stream#program' }).online?.url).toContain('watch?v=');
    for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com', 'https://example.com?pwd=secret', 'https://example.com#access_token=secret']) expect(termsFromFields({ ...fields(), format: 'online', onlineUrl: url }).ok).toBe(false);
    expect(terms({ ...fields(), format: 'online', onlineInstructions: 'Find the public room on the event website.' }).online?.url).toBe('');
  });
  it('asks for a DST occurrence instead of changing an ambiguous deadline silently', () => {
    const input = { ...fields(), timeZone: 'America/New_York', startsLocal: '2030-11-04T12:00', endsLocal: '2030-11-04T14:00', deadlineLocal: '2030-11-03T01:30' };
    expect(termsFromFields(input).ok).toBe(false);
    const first = terms({ ...input, deadlineOccurrence: 'earlier' }), second = terms({ ...input, deadlineOccurrence: 'later' });
    expect(second.registration!.deadline! - first.registration!.deadline!).toBe(3600000);
  });
  it('exposes repeated and invalid input without losing published millisecond precision', () => {
    expect(publishingLocalInstant('2030-11-03T01:30:00.125', 'America/New_York')).toEqual({ ok: false, error: 'ambiguous_time' });
    const early = publishingLocalInstant('2030-11-03T01:30:00.125', 'America/New_York', 'earlier');
    const late = publishingLocalInstant('2030-11-03T01:30:00.125', 'America/New_York', 'later');
    expect(early.ok && early.utcMilliseconds % 1000).toBe(125);
    expect(early.ok && late.ok && late.utcMilliseconds - early.utcMilliseconds).toBe(3600000);
    expect(publishingDateInputType('2030-11-03T01:30:00.125')).toBe('datetime-local');
    expect(publishingDateInputType('2030-02-31T10:00')).toBe('text');
    expect(publishingDateInputType('unfinished date')).toBe('text');
  });
  it('offers country names and readable time zones while keeping codes internal', () => {
    expect(countryOptions.find(item => item.value === 'KZ')?.label).toBe('Kazakhstan');
    expect(timeZoneOptions('Asia/Qyzylorda').find(item => item.value === 'Asia/Qyzylorda')?.label).toBe('Qyzylorda, Asia');
    expect(eventPlace(terms())).toBe('Central library, London, United Kingdom');
  });
});

describe('calendar export and date filters', () => {
  it('escapes event text and folds Unicode without allowing calendar property injection', () => {
    const value = { ...terms(), title: `${'Мастерская '.repeat(20)}\nATTENDEE:fake`, description: 'Bring paint; paper, and brushes\\tools' };
    const calendar = eventCalendar(value, 'event-reference', 1900000000000);
    expect(eventCalendar(value, 'event-reference', 1900000000000, true)).toContain('STATUS:CANCELLED');
    expect(calendar).toContain('BEGIN:VCALENDAR\r\n'); expect(calendar).toContain('DTSTART:20301020T180000Z');
    expect(calendar).not.toContain('\r\nATTENDEE:');
    expect(calendar.replace(/\r\n /g, '')).toContain('\\nATTENDEE:fake');
    for (const line of calendar.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
  it('uses the whole local date across DST and rejects reversed date ranges', () => {
    const filter = catalogueFilters('', '2030-11-03', '2030-11-03', 'America/New_York');
    expect(filter.ok).toBe(true); if (filter.ok) expect(filter.filters.to! - filter.filters.from! + 1).toBe(25 * 3600000);
    expect(catalogueFilters('', '2030-11-04', '2030-11-03', 'UTC').ok).toBe(false);
  });
});
