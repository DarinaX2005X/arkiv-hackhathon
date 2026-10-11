import { formatDateTime } from '../../app/time';
import { audienceChanges, type AudienceTerms } from '../../domain/events';
import { Notice, PlanDiff } from '../../ui';

const labels: Record<keyof AudienceTerms, string> = { title: 'Event title', description: 'About the event', startsAt: 'Start time', endsAt: 'End time',
  timeZone: 'Time zone', venue: 'Place', instructions: 'Before you come', conditions: 'Participation conditions' };

export function AudienceChanges({ previous, current }: { previous: AudienceTerms | null; current: AudienceTerms }) {
  if (!previous) return <Notice tone="warning">The details you originally registered for could not be read. Review the full current event before making a new decision.</Notice>;
  const changed = audienceChanges(previous, current);
  if (!changed.length) return <Notice tone="warning">The organizer published a new version with the same visitor details. Review this version and confirm your registration again.</Notice>;
  const value = (terms: AudienceTerms, field: keyof AudienceTerms): string => field === 'startsAt' || field === 'endsAt'
    ? `${formatDateTime(terms[field], terms.timeZone)} (${terms.timeZone})` : String(terms[field]) || 'Not provided';
  return <PlanDiff title="What changed since you registered" labels={{ requirement: 'Detail', before: 'Your previous version', after: 'Current version' }}
    rows={changed.map(field => ({ id: field, label: labels[field], before: <span className="pf-event-prose">{value(previous, field)}</span>, after: <span className="pf-event-prose">{value(current, field)}</span> }))} />;
}
