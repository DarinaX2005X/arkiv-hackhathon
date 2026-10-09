import { describe, expect, it } from 'vitest';
import { makeSmallWorksFixture } from '../../domain/fixtures';
import { parseRoute, routeHref } from '../../app/routes';
import { createCoveragePreview, previewQuantity, previewTime } from './model';

describe('the introductory coverage sheet', () => {
  it('uses the canonical Sunday requirements and a complete computed allocation', () => {
    const preview = createCoveragePreview();
    expect(preview).not.toBeNull();
    const sunday = makeSmallWorksFixture({ oak: true }).recipe.variants.find(variant => variant.id === 'sunday')!;
    expect(preview!.rows.map(row => row.id)).toEqual(sunday.requirements.map(requirement => requirement.id));
    for (const row of preview!.rows) expect(row.contributions.reduce((sum, contribution) => sum + contribution.quantity, 0)).toBe(row.quantity);
    expect(preview!.rows.find(row => row.id === 'installation')?.contributions.map(item => item.owner).sort()).toEqual(['Cedar', 'Willow']);
    expect(preview!.rows.find(row => row.id === 'transport')?.contributions.map(item => item.owner)).toEqual(['Oak']);
    expect(preview!.rows.find(row => row.id === 'boards')).toMatchObject({ quantity: 6, unit: 'board' });
  });

  it('keeps the sample time zone and concrete units in the preview', () => {
    const preview = createCoveragePreview()!;
    const installation = preview.rows.find(row => row.id === 'installation')!;
    expect(previewTime(installation.interval, preview.timeZone)).toBe('10:00–12:00');
    expect(previewQuantity(installation.quantity, installation.unit)).toBe('2 people');
    expect(previewQuantity(6, 'board')).toBe('6 boards');
  });

  it('uses separate real destinations for editable practice and a custom draft', () => {
    for (const name of ['demo', 'new-project', 'workspace', 'contributions', 'requests'] as const) {
      expect(parseRoute(routeHref({ name }))).toEqual({ name });
    }
  });
});
