import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { FieldMessage } from './primitives';
import { filterSearchSelectOptions, indexSearchSelectOptions, SEARCH_SELECT_PAGE_SIZE, searchSelectPage, type SearchSelectOption } from './search-select-options';
export type { SearchSelectOption } from './search-select-options';

export interface SearchSelectProps {
  label: ReactNode;
  options: readonly SearchSelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  help?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  clearable?: boolean;
  clearLabel?: string;
  noResultsText?: string;
  className?: string;
}

/** Query text is never a selected value, including an exact typed label. */
export function SearchSelect({
  label, options, value, onValueChange, id: suppliedId, name,
  placeholder = 'Search or choose', help, error, disabled = false, required = false,
  clearable = true, clearLabel = 'Clear selection', noResultsText = 'No matching options', className,
}: SearchSelectProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const root = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const optionNodes = useRef(new Map<string, HTMLButtonElement>());
  const restoringFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [activeValue, setActiveValue] = useState('');
  const [pageNumber, setPageNumber] = useState(0);
  const [placement, setPlacement] = useState({ above: false, height: 288 });
  const index = useMemo(() => indexSearchSelectOptions(options), [options]);
  const choices = useMemo(() => new Map(index.map(entry => [entry.option.value, entry.option])), [index]);
  const selected = choices.get(value);
  const filtered = useMemo(() => filterSearchSelectOptions(index, query ?? ''), [index, query]);
  const page = searchSelectPage(filtered, pageNumber);
  const enabled = filtered.filter(option => !option.disabled);
  const active = page.options.find(option => option.value === activeValue && !option.disabled) ?? page.options.find(option => !option.disabled);
  const expanded = open && !disabled;
  const activeIndex = active ? page.options.indexOf(active) + page.offset : -1;
  const description = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;

  function close() {
    setOpen(false);
    setQuery(null);
  }

  function focusInput() {
    restoringFocus.current = true;
    input.current?.focus({ preventScroll: true });
    restoringFocus.current = false;
  }

  function show() {
    if (disabled) return;
    setQuery(null);
    setActiveValue(selected && !selected.disabled ? selected.value : '');
    const selectedIndex = selected ? index.findIndex(entry => entry.option.value === selected.value) : 0;
    setPageNumber(Math.floor(Math.max(0, selectedIndex) / SEARCH_SELECT_PAGE_SIZE));
    setOpen(true);
  }

  function choose(option: SearchSelectOption) {
    // Recheck current props: options can change while the list is open.
    const current = choices.get(option.value);
    if (!current || current.disabled) return;
    onValueChange(option.value);
    close();
    focusInput();
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Enter' && expanded) {
      event.preventDefault();
      if (active) choose(active);
      return;
    }
    const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    const edge = expanded && query === null && !event.ctrlKey && !event.metaKey && (event.key === 'Home' || event.key === 'End');
    if (!arrow && !edge) return;
    event.preventDefault();
    if (!expanded) { show(); return; }
    if (!enabled.length) return;
    const current = active ? enabled.indexOf(active) : -1;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : event.key === 'ArrowUp' ? (current - 1 + enabled.length) % enabled.length
      : (current + 1) % enabled.length;
    const next = enabled[index];
    if (next) {
      setActiveValue(next.value);
      setPageNumber(Math.floor(filtered.indexOf(next) / SEARCH_SELECT_PAGE_SIZE));
    }
  }

  function changePage(next: number) {
    const nextPage = searchSelectPage(filtered, next);
    setPageNumber(nextPage.page);
    setActiveValue(nextPage.options.find(option => !option.disabled)?.value ?? '');
    focusInput();
  }

  useEffect(() => {
    input.current?.setCustomValidity(required && !disabled && (!selected || selected.disabled)
      ? 'Choose an option from the list.' : '');
  }, [required, disabled, selected]);

  useEffect(() => { if (disabled) close(); }, [disabled]);

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const position = () => {
      const bounds = control.current?.getBoundingClientRect();
      if (!bounds) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const footerHeight = page.pageCount > 1 ? 100 : 0;
      const below = bottom - bounds.bottom - 16 - footerHeight;
      const above = bounds.top - top - 16 - footerHeight;
      const useAbove = below < 240 && above > below;
      setPlacement({ above: useAbove, height: Math.max(96, Math.min(288, useAbove ? above : below)) });
    };
    position();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
    };
  }, [expanded, page.pageCount]);

  useEffect(() => {
    if (!expanded || !active) return;
    optionNodes.current.get(active.value)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [expanded, active]);

  return <div ref={root} className={['pf-field', 'pf-search-select', className].filter(Boolean).join(' ')}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <label id={`${id}-label`} htmlFor={id} className="pf-field-label">{label}</label>
    <div ref={control} className="pf-search-select-control" data-invalid={Boolean(error)} data-disabled={disabled} data-clearable={Boolean(clearable && value && !disabled)}>
      <input ref={input} id={id} className="pf-input pf-search-select-input" type="text"
        role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={description} aria-invalid={error ? true : undefined} aria-required={required || undefined}
        autoComplete="off" spellCheck={false} disabled={disabled} required={required && !selected}
        placeholder={placeholder} value={expanded && query !== null ? query : selected?.label ?? ''}
        onFocus={() => { if (!restoringFocus.current) { show(); input.current?.select(); } }}
        onClick={() => { if (!expanded) show(); }}
        onChange={event => { setQuery(event.currentTarget.value); setActiveValue(''); setPageNumber(0); setOpen(true); }}
        onKeyDown={handleKey} />
      {name && <input type="hidden" name={name} disabled={disabled} value={selected && !selected.disabled ? selected.value : ''} />}
      <div className="pf-search-select-tools">
        {clearable && value && !disabled && <button type="button" className="pf-search-select-tool"
          aria-label={clearLabel} title={clearLabel} onClick={() => { onValueChange(''); close(); focusInput(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
        </button>}
        <button type="button" className="pf-search-select-tool" tabIndex={-1} disabled={disabled}
          aria-label={expanded ? 'Close options' : 'Show options'} aria-expanded={expanded}
          onClick={() => { if (expanded) close(); else show(); focusInput(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} /></svg>
        </button>
      </div>
      {expanded && <div className="pf-search-select-popover" data-above={placement.above}
        style={{ '--search-list-height': `${placement.height}px` } as CSSProperties}>
        <ul id={`${id}-list`} className="pf-search-select-list" role="listbox" aria-labelledby={`${id}-label`}>
          {page.options.map((option, index) => <li role="presentation" key={option.value}>
            <button type="button" role="option" id={`${id}-option-${page.offset + index}`} tabIndex={-1} disabled={option.disabled}
              aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
              className="pf-search-select-option" data-active={option.value === active?.value}
              ref={node => { if (node) optionNodes.current.set(option.value, node); else optionNodes.current.delete(option.value); }}
              onMouseDown={event => event.preventDefault()}
              onClick={() => { if (!option.disabled) choose(option); }}>
              <span><span className="pf-search-select-option-label">{option.label}</span>
                {option.description && <span className="pf-search-select-option-description">{option.description}</span>}</span>
              {option.value === value && <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
            </button>
          </li>)}
        </ul>
        {!filtered.length && <p className="pf-search-select-empty" role="status">{noResultsText}</p>}
        {page.pageCount > 1 && <div className="pf-search-select-pagination">
          <p>{page.offset + 1} to {page.offset + page.options.length} of {page.total.toLocaleString('en')}</p>
          <div><button type="button" disabled={page.page === 0} onClick={() => changePage(page.page - 1)} aria-label="Previous options">Previous</button>
            <button type="button" disabled={page.page + 1 === page.pageCount} onClick={() => changePage(page.page + 1)} aria-label="Next options">Next</button></div>
        </div>}
      </div>}
    </div>
    {help && <FieldMessage id={`${id}-help`}>{help}</FieldMessage>}
    {error && <FieldMessage id={`${id}-error`} tone="danger" role="alert">{error}</FieldMessage>}
    {expanded && <span className="pf-visually-hidden" role="status">{filtered.length.toLocaleString('en')} {filtered.length === 1 ? 'option' : 'options'} available{page.pageCount > 1 ? `, showing ${page.offset + 1} to ${page.offset + page.options.length}. Search to narrow the list.` : ''}</span>}
  </div>;
}
