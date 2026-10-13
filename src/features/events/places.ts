import type { EventAggregate } from '../../domain/events';
import { isTimeZone } from '../../app/time';

/** ISO 3166-1 alpha-2 regions, displayed as localized country names. */
const regionCodes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const names = new Intl.DisplayNames(['en'], { type: 'region' });
// GeoNames includes Kosovo under XK; keep the documented directory extension selectable.
export const countryOptions = [...regionCodes, 'XK'].map(value => ({ value, label: names.of(value) ?? value })).sort((a, b) => a.label.localeCompare(b.label));
export const countryName = (code: string): string => countryOptions.find(option => option.value === code)?.label ?? code;

/** Facets describe the actual catalog, not an invented or partial world-city directory. */
export function catalogPlaceOptions(events: readonly EventAggregate[], countryCode = '') {
  const countries = new Map<string, string>();
  const cities = new Map<string, string>();
  for (const event of events) {
    const location = event.release?.payload.terms.location;
    if (!location?.countryCode || !location.city.trim()) continue;
    countries.set(location.countryCode, countryName(location.countryCode));
    if (location.countryCode === countryCode) {
      const city = location.city.trim();
      const normalized = city.toLocaleLowerCase('en');
      if (!cities.has(normalized)) cities.set(normalized, city);
    }
  }
  return {
    countries: [...countries].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'en')),
    cities: [...cities.values()].map(value => ({ value, label: value })).sort((a, b) => a.label.localeCompare(b.label, 'en')),
  };
}
export function timeZoneOptions(current = 'UTC') {
  const zones = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC', 'Europe/London', 'America/New_York', 'Asia/Almaty', 'Asia/Qyzylorda'];
  return [...new Set(['UTC', ...(isTimeZone(current) ? [current] : []), ...zones])].map(value => ({ value, label: value === 'UTC' ? 'UTC (Coordinated Universal Time)' : value.split('/').reverse().join(', ').replaceAll('_', ' ') }));
}
