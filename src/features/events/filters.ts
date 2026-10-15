import type { EventFilters } from '../../data/events/types';
import { deriveEventAvailability, type EventAggregate } from '../../domain/events';
import { catalogueFilters } from './presentation';
import { catalogPlaceOptions } from './places';

export interface CatalogFilterInput {
  search: string;
  from: string;
  to: string;
  format: string;
  countryCode: string;
  city: string;
  availability: string;
  deadline: string;
}

export const emptyCatalogFilters: CatalogFilterInput = {
  search: '', from: '', to: '', format: '', countryCode: '', city: '', availability: '', deadline: '',
};

/** A changed country or fresh catalog cannot retain a city that is absent from its choices. */
export function validCatalogLocation(events: readonly EventAggregate[], countryCode: string, city: string) {
  const countries = catalogPlaceOptions(events).countries;
  const country = countries.some(option => option.value === countryCode) ? countryCode : '';
  return { countryCode: country, city: country && catalogPlaceOptions(events, country).cities.some(option => option.value === city) ? city : '' };
}

/** Invalid dates stay visible for correction without blocking independent title/location filters. */
export function catalogFiltersFromInput(input: CatalogFilterInput, events: readonly EventAggregate[], timeZone: string): {
  filters: EventFilters;
  dateError?: string;
  dateErrorField?: 'from' | 'to';
  deadlineError?: string;
} {
  const dates = catalogueFilters(input.search, input.from, input.to, timeZone);
  const deadline = catalogueFilters('', '', input.deadline, timeZone);
  const location = validCatalogLocation(events, input.countryCode, input.city);
  const filters: EventFilters = dates.ok ? { ...dates.filters } : input.search.trim() ? { search: input.search.trim() } : {};
  if (input.format === 'online' || input.format === 'in_person' || input.format === 'hybrid') filters.format = input.format;
  if (location.countryCode) filters.countryCode = location.countryCode;
  if (location.city) filters.city = location.city;
  const availability = ['open', 'waitlist', 'full', 'registration_closed', 'closed', 'paused', 'cancelled', 'ended', 'unverified'] as const;
  const selected = availability.find(value => value === input.availability);
  if (selected) filters.availability = selected;
  if (deadline.ok && deadline.filters.to !== undefined) filters.deadlineBefore = deadline.filters.to;
  return {
    filters,
    ...(!dates.ok ? { dateError: `${dates.error} Date filters will apply when the range is valid.` } : {}),
    ...(!dates.ok ? { dateErrorField: dates.field } : {}),
    ...(!deadline.ok ? { deadlineError: 'Choose a valid registration deadline date.' } : {}),
  };
}

/** Filter the complete read locally; never change the snapshot or its verification evidence. */
export function filterCatalog(events: readonly EventAggregate[], filters: EventFilters, now: number, unverified = false): EventAggregate[] {
  const search = filters.search?.trim().toLocaleLowerCase('en');
  return events.filter(event => {
    const terms = event.release?.payload.terms;
    const startsAt = terms?.startsAt ?? (event.state.status === 'unique' ? event.state.entity.payload.startsAt : undefined);
    const endsAt = terms?.endsAt ?? (event.state.status === 'unique' ? event.state.entity.payload.endsAt : undefined);
    if (search && !terms?.title.toLocaleLowerCase('en').includes(search)) return false;
    if (filters.from !== undefined && (endsAt === undefined || endsAt < filters.from)) return false;
    if (filters.to !== undefined && (startsAt === undefined || startsAt > filters.to)) return false;
    if (filters.format && terms?.format !== filters.format) return false;
    if (filters.countryCode && terms?.location?.countryCode !== filters.countryCode) return false;
    if (filters.city && terms?.location?.city.toLocaleLowerCase('en') !== filters.city.toLocaleLowerCase('en')) return false;
    if (filters.availability && (unverified ? 'unverified' : deriveEventAvailability(event, now)) !== filters.availability) return false;
    if (filters.deadlineBefore !== undefined && (terms?.registration?.deadline == null || terms.registration.deadline > filters.deadlineBefore)) return false;
    return true;
  });
}
