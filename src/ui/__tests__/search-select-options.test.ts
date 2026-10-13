import { describe, expect, it } from 'vitest';
import { filterSearchSelectOptions, indexSearchSelectOptions, SEARCH_SELECT_PAGE_SIZE, searchSelectPage } from '../search-select-options';

describe('searchable location choices', () => {
  it('finds native names, accents and region aliases without changing canonical values', () => {
    const index = indexSearchSelectOptions([
      { value: 'place-1', label: 'München', keywords: ['Munich', 'Bavaria', 'Deutschland'] },
      { value: 'place-2', label: 'São Paulo', keywords: ['Brasil'] },
      { value: 'place-3', label: 'Алматы', keywords: ['Almaty', 'Kazakhstan'] },
    ]);
    expect(filterSearchSelectOptions(index, '  MUNICH bavaria  ').map(option => option.value)).toEqual(['place-1']);
    expect(filterSearchSelectOptions(index, 'sao BRASIL').map(option => option.value)).toEqual(['place-2']);
    expect(filterSearchSelectOptions(index, 'Алматы').map(option => option.value)).toEqual(['place-3']);
    expect(filterSearchSelectOptions(index, 'a misspelled city')).toEqual([]);
  });

  it('searches the complete country directory while every displayed page remains bounded', () => {
    const options = Array.from({ length: 24_137 }, (_, index) => ({ value: `city-${index}`, label: `City ${index}`, keywords: index === 24_100 ? ['The distant match'] : [] }));
    const index = indexSearchSelectOptions(options);
    const matches = filterSearchSelectOptions(index, '');
    expect(searchSelectPage(matches, 0).options).toHaveLength(SEARCH_SELECT_PAGE_SIZE);
    const last = searchSelectPage(matches, 1_000);
    expect(last.options.length).toBeLessThanOrEqual(SEARCH_SELECT_PAGE_SIZE);
    expect(last.options.at(-1)?.value).toBe('city-24136');
    const allPageValues = Array.from({ length: last.pageCount }, (_, page) => searchSelectPage(matches, page).options.map(option => option.value)).flat();
    expect(allPageValues).toEqual(options.map(option => option.value));
    expect(filterSearchSelectOptions(index, 'distant match').map(option => option.value)).toEqual(['city-24100']);
  });

  it('reserves the empty value, removes duplicate keys, and recovers a page after filtering', () => {
    const index = indexSearchSelectOptions([
      { value: '', label: 'All cities' },
      { value: 'a', label: 'First town' },
      { value: 'a', label: 'Conflicting alias' },
      { value: 'b', label: 'Second town', disabled: true },
    ]);
    const filtered = filterSearchSelectOptions(index, 'Second');
    expect(searchSelectPage(filtered, 4)).toMatchObject({ page: 0, pageCount: 1, total: 1, options: [{ value: 'b', disabled: true }] });
    expect(searchSelectPage([], -1)).toMatchObject({ page: 0, pageCount: 0, offset: 0, options: [] });
    expect(filterSearchSelectOptions(index, '').map(option => option.value)).toEqual(['a', 'b']);
  });
});
