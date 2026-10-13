import { describe, expect, it } from 'vitest';
import type { AudienceTerms } from '../../../domain/events';
import { emptyPublishingFields } from './model';
import { changePublishingCountry, publishingCitySelection } from './placeSelection';

const fields = () => ({ ...emptyPublishingFields(true), countryCode: 'GB', country: 'United Kingdom', city: 'London' });
const published = { location: { countryCode: 'GB', country: 'United Kingdom', city: 'Earlier place', venue: 'Hall' } } as AudienceTerms;

describe('publishing city selection and recovery', () => {
  it('requires a real choice and keeps an unmatched draft value intact', () => {
    const original = { ...fields(), city: 'Typed town' }, before = structuredClone(original);
    expect(publishingCitySelection(original, undefined, [{ value: 'London', label: 'London' }])).toMatchObject({ valid: false, retainedUnselected: true });
    expect(original).toEqual(before);
    expect(publishingCitySelection(fields(), undefined, [{ value: 'London', label: 'London' }]).valid).toBe(true);
  });
  it('keeps only the exact published country and city as a legacy option', () => {
    const original = { ...fields(), city: 'Earlier place' };
    const preserved = publishingCitySelection(original, published, []);
    expect(preserved).toMatchObject({ valid: true, preserved: true });
    expect(preserved.options[0]?.value).toBe('Earlier place');
    expect(publishingCitySelection({ ...original, countryCode: 'US' }, published, []).valid).toBe(false);
    expect(publishingCitySelection({ ...original, city: 'Another place' }, published, []).valid).toBe(false);
  });
  it('clears a selected city on a country change while retaining it when the same country is chosen', () => {
    const original = fields();
    expect(changePublishingCountry(original, 'KZ', 'Kazakhstan')).toMatchObject({ countryCode: 'KZ', country: 'Kazakhstan', city: '' });
    expect(original.city).toBe('London');
    expect(changePublishingCountry(original, 'GB', 'United Kingdom').city).toBe('London');
    expect(publishingCitySelection(changePublishingCountry(original, 'KZ', 'Kazakhstan'), undefined, [{ value: 'London', label: 'London' }]).valid).toBe(false);
  });
  it('does not discard retained physical fields when the event becomes online', () => {
    const online = { ...fields(), format: 'online' as const, city: 'Unfinished city' };
    expect(publishingCitySelection(online, undefined, []).valid).toBe(true);
    expect(online.city).toBe('Unfinished city');
  });
});
