import { describe, expect, it } from 'vitest';
import type { RepositoryError, RepositoryErrorCode } from '../../data/types';
import { eventError } from './presentation';

const error = (code: RepositoryErrorCode): RepositoryError => ({
  code, reasons: [], retryable: true, diagnostic: 'ANON_COST_LIMITED raw provider detail',
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
});
