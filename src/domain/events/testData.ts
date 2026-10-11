import type { AudienceTerms } from './types';

export const TEST_EVENT_MARKER = '[PARTFOLK TEST EVENT]';

/** Organizer-declared synthetic content in signed terms, not an authenticity certification. */
export function isTestEventTerms(terms: Pick<AudienceTerms, 'conditions'> | null | undefined): boolean {
  return terms?.conditions.split(/\r?\n/, 1)[0] === TEST_EVENT_MARKER;
}
