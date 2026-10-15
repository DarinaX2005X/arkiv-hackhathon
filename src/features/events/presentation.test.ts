import { describe, expect, it } from 'vitest';
import type { RepositoryError, RepositoryErrorCode } from '../../data/types';
import type { AudienceTerms } from '../../domain/events';
import { eventAdmissionLabel, eventDate, eventDayLabel, eventError, eventLocationLabel, eventTimeLabel } from './presentation';

const error = (code: RepositoryErrorCode): RepositoryError => ({
  code, reasons: [], retryable: true, diagnostic: 'ANON_COST_LIMITED raw provider detail',
});

describe('compact event facts', () => {
  const terms: AudienceTerms = { title: 'An online workshop', description: '', startsAt: Date.parse('2026-10-24T23:30:00Z'), endsAt: Date.parse('2026-10-25T00:30:00Z'),
    timeZone: 'Pacific/Auckland', venue: 'Online', instructions: '', conditions: '', format: 'online', location: null,
    registration: { deadline: null, capacity: { kind: 'unlimited' }, admission: 'open', waitlist: false, invitedAccounts: [] } };
  it('uses the published event zone for both the day and time', () => {
    expect(eventDayLabel(terms)).toContain('Oct 25, 2026');
    expect(eventTimeLabel(terms)).toBe('12:30 PM to 1:30 PM');
  });
  it('keeps format and location distinct and explains organizer confirmation', () => {
    expect(eventLocationLabel(terms)).toBe('');
    expect(eventLocationLabel({ ...terms, format: 'in_person', location: { countryCode: 'KZ', country: 'Kazakhstan', city: 'Almaty', venue: 'Library hall' } })).toBe('Almaty, Kazakhstan');
    expect(eventAdmissionLabel(terms)).toBe('Open to everyone');
    expect(eventAdmissionLabel({ ...terms, registration: { ...terms.registration!, capacity: { kind: 'limited', limit: 20 } } })).toBe('Organizer confirms places');
    expect(eventAdmissionLabel({ ...terms, registration: { ...terms.registration!, admission: 'invite_only' } })).toBe('Invitation required');
  });
  it('distinguishes repeated local times when an event crosses a daylight-saving change', () => {
    const folded = { ...terms, startsAt: Date.parse('2026-11-01T05:30:00Z'), endsAt: Date.parse('2026-11-01T06:30:00Z'), timeZone: 'America/New_York' };
    expect(eventTimeLabel(folded)).toBe('1:30 AM EDT to 1:30 AM EST');
    expect(eventDate(folded)).toContain('EDT');
    expect(eventDate(folded)).toContain('EST');
  });
});

describe('event read failure messages', () => {
  it('explains throttling without claiming an anonymous visitor has a saved request', () => {
    const message = eventError(error('rate_limited'));
    expect(message).toContain('temporarily limiting requests');
    expect(message).toContain('Wait a little, then refresh');
    expect(message).not.toMatch(/saved request|selected event|wallet|ANON_COST_LIMITED/);
  });

  it('distinguishes a connection failure from rate limiting', () => {
    const message = eventError(error('network'));
    expect(message).toContain('could not be reached');
    expect(message).toContain('Check your connection');
    expect(message).not.toMatch(/limiting requests|saved request|selected event|ANON_COST_LIMITED/);
  });

  it('keeps fallback recovery advice conditional on a submitted request', () => {
    const message = eventError(error('unverified'));
    expect(message).toContain('event data could not be verified');
    expect(message).toContain('If you submitted a request, check its saved status before sending another.');
    expect(message).not.toMatch(/Your selected event|saved request are kept|ANON_COST_LIMITED/);
  });

  it('retains explicit saved-request recovery for a reverted transaction', () => {
    expect(eventError(error('reverted'))).toContain('Check the saved request');
  });

  it('explains how to fund an unfunded Tiramisu wallet', () => {
    const message = eventError(error('insufficient_funds'));
    expect(message).toContain('test GLM');
    expect(message).toContain('retry the saved request');
    expect(message).not.toContain('ANON_COST_LIMITED');
  });
});
