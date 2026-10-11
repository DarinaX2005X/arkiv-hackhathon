import { makeSmallWorksFixture } from '../../domain/fixtures';
import { solve } from '../../domain/solver';
import type { Interval } from '../../domain/types';

export interface CoveragePreviewRow {
  id: string; title: string; quantity: number; unit: string; interval: Interval;
  contributions: { owner: string; quantity: number }[];
}
export interface CoveragePreview {
  title: string; variantTitle: string; timeZone: string;
  rows: CoveragePreviewRow[];
}
export type IllustrationMoment = 'agreed' | 'withdrawn' | 'replacement';

/** A fixed, explicitly local illustration derived from the same data and solver as practice. */
export function createCoveragePreview(replacement = false): CoveragePreview | null {
  const input = makeSmallWorksFixture(replacement ? { juniper: true } : { oak: true });
  const result = solve(input);
  const candidate = result.candidates.find(item => item.plan.variant.id === 'sunday');
  if (!candidate) return null;
  const names = new Map(input.publishers.flatMap(publisher => publisher.book.status === 'unique'
    ? [[publisher.root.key, publisher.book.entity.payload.name] as const] : []));
  return {
    title: input.recipe.title, variantTitle: candidate.plan.variant.title, timeZone: input.recipe.timeZone,
    rows: candidate.plan.variant.requirements.map(requirement => ({
      id: requirement.id, title: requirement.title, quantity: requirement.quantity, unit: requirement.unit,
      interval: requirement.interval,
      contributions: candidate.plan.allocations.filter(allocation => allocation.requirementId === requirement.id)
        .map(allocation => ({ owner: names.get(allocation.publisherRoot) ?? 'Example contributor', quantity: allocation.quantity })),
    })),
  };
}

export function previewTime(interval: Interval, timeZone: string): string {
  const format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${format.format(interval.start)}–${format.format(interval.end)}`;
}

export function previewQuantity(quantity: number, unit: string): string {
  return `${quantity} ${quantity === 1 ? unit : unit === 'person' ? 'people' : `${unit}s`}`;
}
