/** Empty values are reserved for clearing the selection. */
export interface SearchSelectOption {
  value: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  disabled?: boolean;
}

export interface SearchSelectEntry {
  option: SearchSelectOption;
  text: string;
}

export const SEARCH_SELECT_PAGE_SIZE = 80;

function searchable(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** City aliases can be large. Normalize them once when the directory changes. */
export function indexSearchSelectOptions(options: readonly SearchSelectOption[]): readonly SearchSelectEntry[] {
  const values = new Set<string>();
  return options.filter(option => {
    if (!option.value || values.has(option.value)) return false;
    values.add(option.value);
    return true;
  }).map(option => ({
    option,
    text: searchable([option.label, option.description ?? '', ...(option.keywords ?? [])].join(' ')),
  }));
}

export function filterSearchSelectOptions(index: readonly SearchSelectEntry[], query: string): readonly SearchSelectOption[] {
  const terms = searchable(query).split(/\s+/u).filter(Boolean);
  return index.filter(entry => terms.every(term => entry.text.includes(term))).map(entry => entry.option);
}

/** Every result remains reachable while only one bounded page is rendered. */
export function searchSelectPage(options: readonly SearchSelectOption[], requestedPage: number) {
  const pageCount = Math.ceil(options.length / SEARCH_SELECT_PAGE_SIZE);
  const page = Math.max(0, Math.min(Math.max(0, pageCount - 1), Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0));
  const offset = page * SEARCH_SELECT_PAGE_SIZE;
  return { options: options.slice(offset, offset + SEARCH_SELECT_PAGE_SIZE), offset, page, pageCount, total: options.length };
}
