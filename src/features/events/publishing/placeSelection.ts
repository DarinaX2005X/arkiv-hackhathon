import type { CityOption } from '../../../data/places/directory';
import type { AudienceTerms } from '../../../domain/events';
import type { PublishingFields } from './model';

export function changePublishingCountry(fields: PublishingFields, countryCode: string, country: string): PublishingFields {
  return { ...fields, countryCode, country, city: fields.countryCode === countryCode ? fields.city : '' };
}

/** A saved public place remains editable. An unpublished arbitrary value is retained for recovery,
 * but cannot masquerade as a new selection from the maintained directory. */
export function publishingCitySelection(fields: PublishingFields, published: AudienceTerms | undefined, cities: readonly CityOption[]) {
  const city = fields.city ?? '';
  const selected = cities.find(option => option.value === city);
  const location = published?.location;
  const preserved = Boolean(!selected && city && location && fields.countryCode === location.countryCode && city === location.city);
  const options: readonly (CityOption & { description?: string })[] = preserved
    ? [{ value: city, label: city, description: 'Saved on the published event. Kept exactly as it was published.' }, ...cities]
    : cities;
  return {
    options,
    preserved,
    valid: fields.format === undefined || fields.format === 'online' || Boolean(selected || preserved),
    retainedUnselected: Boolean(city && !selected && !preserved),
  };
}
