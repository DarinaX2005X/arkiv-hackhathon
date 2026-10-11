import { canonicalJson, hashCanonical } from '../canonical';
import { TIRAMISU_CHAIN_ID } from '../types';
import type { ContentHash } from '../types';
import { EVENTS_PROTOCOL, EVENTS_SCHEMA_VERSION } from './types';
import type { AudienceTerms } from './types';

export const AUDIENCE_FIELDS = ['title', 'description', 'startsAt', 'endsAt', 'timeZone', 'venue', 'instructions', 'conditions'] as const;

/** Content comparison excludes source plans and receipts; consent also binds the exact release key. */
export function audienceHash(terms: AudienceTerms): ContentHash {
  return hashCanonical({ domain: 'partfolk/event-audience', protocol: EVENTS_PROTOCOL,
    schemaVersion: EVENTS_SCHEMA_VERSION, chainId: TIRAMISU_CHAIN_ID,
    terms: Object.fromEntries(AUDIENCE_FIELDS.map(field => [field, terms[field]])) });
}

/** Uses the same normalization as the consent hash, so display differences cannot disagree with it. */
export function audienceChanges(previous: AudienceTerms, current: AudienceTerms): (keyof AudienceTerms)[] {
  return AUDIENCE_FIELDS.filter(field => canonicalJson(previous[field]) !== canonicalJson(current[field]));
}
