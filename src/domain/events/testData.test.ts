import { describe, expect, it } from 'vitest';
import { isTestEventTerms, TEST_EVENT_MARKER } from './index';

describe('organizer-declared test event marker', () => {
  it.each([
    TEST_EVENT_MARKER,
    `${TEST_EVENT_MARKER}\nThis is a fictional event for testing.`,
    `${TEST_EVENT_MARKER}\r\nThis is a fictional event for testing.`,
  ])('recognizes an exact first-line marker: %j', conditions => {
    expect(isTestEventTerms({ conditions })).toBe(true);
  });

  it.each([
    '',
    'An ordinary public event.',
    `This mentions ${TEST_EVENT_MARKER} in a sentence.`,
    `Participation conditions\n${TEST_EVENT_MARKER}`,
    `\n${TEST_EVENT_MARKER}`,
    ` ${TEST_EVENT_MARKER}`,
    `${TEST_EVENT_MARKER} `,
    `${TEST_EVENT_MARKER} This is a fictional event.`,
    '[PARTFOLK TEST EVENTS]',
    '[partfolk test event]',
    `${TEST_EVENT_MARKER}\r`,
  ])('does not treat incidental or altered text as a marker: %j', conditions => {
    expect(isTestEventTerms({ conditions })).toBe(false);
  });

  it('does not mark missing current terms as a test event', () => {
    expect(isTestEventTerms(null)).toBe(false);
    expect(isTestEventTerms(undefined)).toBe(false);
  });
});
