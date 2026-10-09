import { expect, it } from 'vitest';
import { createCopyRegistry, defineCatalog } from './index';
import { shellCopy } from './shell';

it('registers typed English feature copy without mutating another client', () => {
  const base = createCopyRegistry({ shell: shellCopy });
  const feature = base.withCatalog('agreement', defineCatalog({ waiting: '{count} people still need to agree.' }));
  expect(feature.text('agreement', 'waiting', { count: 2 })).toBe('2 people still need to agree.');
  expect(base.catalogs).not.toHaveProperty('agreement');
  expect(() => feature.text('agreement', 'waiting')).toThrow('Missing copy parameter');
  expect(() => feature.withCatalog('agreement', { other: 'Duplicate' })).toThrow('already registered');
  expect(base.locale).toBe('en');
});
