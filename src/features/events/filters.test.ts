import { describe, expect, it } from 'vitest';
import { createArkivRepository } from '../../data/arkiv';
import { COORDINATOR, KEYS, NOW, entityKey, readyFixture } from '../../data/__tests__/arkiv-fixture';
import { markEventReadStale } from '../../data/events/read-cache';
import { audienceHash, deriveEventAvailability, EVENTS_PROTOCOL, type AudienceTerms, type EventAggregate, type EventRecord, type EventRelease } from '../../domain/events';
import type { EntityProvenance } from '../../domain/types';
import { catalogFiltersFromInput, emptyCatalogFilters, filterCatalog, validCatalogLocation } from './filters';
import { catalogPlaceOptions, countryOptions, timeZoneOptions } from './places';

async function fixture(overrides: Partial<AudienceTerms> = {}): Promise<EventAggregate> {
  const { rpc, source } = readyFixture();
  const project = await createArkivRepository({ request: rpc.request, now: () => NOW }).loadProject(KEYS.project);
  if (!project.ok) throw new Error('Invalid project fixture');
  const actor = { kind: 'wallet' as const, address: COORDINATOR };
  const provenance: EntityProvenance = { mode: 'public', creator: actor, owner: actor, readonly: true,
    contentType: 'application/json', permissionlessExtension: false, createdAtBlock: '95', expiresAtBlock: '10000', transactionHash: entityKey(100) };
  const base = { protocol: EVENTS_PROTOCOL, schemaVersion: 1 as const, operationId: 'catalog-fixture', createdAt: NOW - 1000 };
  const terms: AudienceTerms = { title: 'Bookbinding workshop', description: 'Make a book together.', startsAt: NOW + 3_600_000, endsAt: NOW + 7_200_000,
    timeZone: 'UTC', venue: 'Library hall', instructions: 'Use the front entrance.', conditions: 'Free open event.', termsVersion: 2,
    format: 'in_person', location: { countryCode: 'GB', country: 'United Kingdom', city: 'Oxford', venue: 'Library hall' }, online: null,
    registration: { deadline: NOW + 1_800_000, capacity: { kind: 'unlimited' }, admission: 'open', invitedAccounts: [], waitlist: false }, ...overrides };
  const release: EventRecord<EventRelease> = { key: entityKey(101), provenance, payload: { ...base, entityType: 'event_release',
    projectRoot: KEYS.project, terms, audienceHash: audienceHash(terms), predecessorReleaseKey: null, source } };
  return { projectRoot: KEYS.project, root: project.value.root, sourceProject: project.value, release, snapshot: project.value.snapshot, diagnostics: [],
    roster: { snapshot: project.value.snapshot, diagnostics: [], entries: [] },
    state: { status: 'unique', entity: { key: entityKey(102), provenance, payload: { ...base, entityType: 'event_state', projectRoot: KEYS.project,
      releaseKey: release.key, audienceHash: release.payload.audienceHash, source, status: 'open', predecessorKeys: [], admissions: [], startsAt: terms.startsAt, endsAt: terms.endsAt } } } };
}

describe('immediate catalog filters', () => {
  it('combines title, format, country and city without changing read evidence', async () => {
    const event = await fixture();
    const online = await fixture({ title: 'Online bookbinding', format: 'online', location: null, online: { url: 'https://example.org/room', instructions: '' } });
    const events = [event, online];
    const before = structuredClone(event);
    const parsed = catalogFiltersFromInput({ ...emptyCatalogFilters, search: '  BOOKbinding ', format: 'in_person', countryCode: 'GB', city: 'Oxford' }, events, 'UTC');
    const visible = filterCatalog(events, parsed.filters, NOW);
    expect(visible).toEqual([event]); expect(visible[0]).toBe(event);
    expect(visible[0]?.snapshot).toBe(event.snapshot); expect(event).toEqual(before);
    expect(filterCatalog(events, { search: 'missing title' }, NOW)).toEqual([]);
  });

  it('derives country and city choices from the catalog and clears invalid dependent choices', async () => {
    const oxford = await fixture();
    const duplicate = await fixture({ location: { ...oxford.release!.payload.terms.location!, city: 'oxford' } });
    const almaty = await fixture({ location: { countryCode: 'KZ', country: 'Kazakhstan', city: 'Almaty', venue: 'Library hall' } });
    const events = [oxford, duplicate, almaty];
    expect(catalogPlaceOptions(events, 'GB').cities).toEqual([{ value: 'Oxford', label: 'Oxford' }]);
    expect(catalogPlaceOptions(events).countries.map(option => option.value)).toEqual(['KZ', 'GB']);
    expect(validCatalogLocation(events, 'KZ', 'Oxford')).toEqual({ countryCode: 'KZ', city: '' });
    expect(validCatalogLocation(events, 'ZZ', 'Invented city')).toEqual({ countryCode: '', city: '' });
    expect(validCatalogLocation([oxford], 'KZ', 'Almaty')).toEqual({ countryCode: '', city: '' });
    expect(catalogPlaceOptions(events).cities).toEqual([]);
    expect(countryOptions.find(option => option.value === 'XK')?.label).toBe('Kosovo');
  });

  it('includes overlapping events throughout the selected calendar day across DST', async () => {
    const event = await fixture({ startsAt: Date.parse('2026-03-08T04:30:00Z'), endsAt: Date.parse('2026-03-08T05:30:00Z') });
    const parsed = catalogFiltersFromInput({ ...emptyCatalogFilters, from: '2026-03-08', to: '2026-03-08' }, [event], 'America/New_York');
    expect(parsed.filters.from).toBe(Date.parse('2026-03-08T05:00:00Z'));
    expect(parsed.filters.to).toBe(Date.parse('2026-03-09T04:00:00Z') - 1);
    expect(filterCatalog([event], parsed.filters, NOW)).toEqual([event]);
    expect(filterCatalog([event], { from: event.release!.payload.terms.endsAt + 1 }, NOW)).toEqual([]);
    expect(filterCatalog([event], { to: event.release!.payload.terms.startsAt - 1 }, NOW)).toEqual([]);
  });

  it('keeps independent filters responsive while an invalid date range is corrected', async () => {
    const event = await fixture();
    const parsed = catalogFiltersFromInput({ ...emptyCatalogFilters, search: 'book', from: '2026-10-11', to: '2026-10-09', countryCode: 'GB', city: 'Oxford', deadline: 'invalid' }, [event], 'UTC');
    expect(parsed.dateError).toContain('end date'); expect(parsed.dateErrorField).toBe('to'); expect(parsed.deadlineError).toContain('valid registration deadline');
    expect(parsed.filters).toEqual({ search: 'book', countryCode: 'GB', city: 'Oxford' });
    expect(filterCatalog([event], parsed.filters, NOW)).toEqual([event]);
    expect(catalogFiltersFromInput({ ...emptyCatalogFilters, from: 'invalid' }, [event], 'UTC').dateErrorField).toBe('from');
  });

  it('treats deadline dates inclusively and excludes events without a deadline', async () => {
    const event = await fixture();
    const noDeadline = await fixture({ registration: { ...event.release!.payload.terms.registration!, deadline: null } });
    const parsed = catalogFiltersFromInput({ ...emptyCatalogFilters, deadline: '2026-10-09' }, [event, noDeadline], 'UTC');
    expect(filterCatalog([event, noDeadline], parsed.filters, NOW)).toEqual([event]);
    expect(filterCatalog([event], { deadlineBefore: NOW }, NOW)).toEqual([]);
  });

  it('does not present cached, failed or aged records as registration-open results', async () => {
    const event = await fixture();
    expect(deriveEventAvailability(event, NOW)).toBe('open');
    expect(filterCatalog([event], { availability: 'open' }, NOW)).toEqual([event]);
    expect(filterCatalog([event], { availability: 'open' }, NOW, true)).toEqual([]);
    expect(filterCatalog([event], { availability: 'unverified' }, NOW, true)).toEqual([event]);
    const failed = markEventReadStale(event);
    expect(filterCatalog([failed], { availability: 'open' }, NOW)).toEqual([]);
    expect(filterCatalog([event], { availability: 'open' }, NOW + 60_001)).toEqual([]);
    expect(failed.snapshot.fetchedAt).toBe(event.snapshot.fetchedAt);
    expect(failed.release).toEqual(event.release);
  });

  it('does not turn an arbitrary imported time zone into a selectable choice', () => {
    expect(timeZoneOptions('Invented/Zone').some(option => option.value === 'Invented/Zone')).toBe(false);
    expect(timeZoneOptions('+05:00').some(option => option.value === '+05:00')).toBe(false);
    expect(timeZoneOptions('Asia/Calcutta').some(option => option.value === 'Asia/Calcutta')).toBe(true);
    expect(timeZoneOptions('').some(option => option.value === 'UTC')).toBe(true);
  });
});
