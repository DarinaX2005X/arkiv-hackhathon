import { describe, expect, it } from 'vitest';
import { attendanceRequestCopy } from './status';

describe('attendance request presentation', () => {
  it.each([
    ['pending', 'Request sent'],
    ['waitlisted', 'waiting list'],
    ['full', 'No place is confirmed'],
    ['invitation_required', 'needs an invitation'],
    ['registration_closed', 'missed the deadline'],
  ] as const)('keeps %s as an unconfirmed request', (status, title) => {
    const copy = attendanceRequestCopy(status);
    expect(copy?.title).toContain(title);
    expect(copy?.message).toContain('do not have a confirmed place');
  });

  it.each(['going', 'withdrawn', 'needs_review', 'not_registered', 'unverified', 'cancelled', 'ended'] as const)(
    'does not relabel %s as a request', status => expect(attendanceRequestCopy(status)).toBeNull(),
  );
});
