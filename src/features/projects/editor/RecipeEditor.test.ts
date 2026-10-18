import { describe, expect, it, vi } from 'vitest';

// Invoke the editor's callbacks directly without a DOM, renderer or browser.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useId: () => 'editor-test',
  useState<T>(initial: T | (() => T)) { return [typeof initial === 'function' ? (initial as () => T)() : initial, () => {}]; },
  useRef<T>(initial: T) { return { current: initial }; },
  useMemo(create: () => unknown) { return create(); },
  useEffect() {},
}));

import { RecipeEditor } from './RecipeEditor';
import { TimeZoneField } from './DateFields';
import { createEventEditorDraft, eventDetailsReady, type EditorDraft } from './model';
import { isSavedProjectDraft, makeDraft } from '../drafts';

type Element = { type: unknown; props: { children?: unknown; value?: string; error?: string; onChange?: (value: string) => void } };
function fields(element: unknown, type: unknown): Element[] {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(item => fields(item, type));
  const item = element as Element;
  return [...(item.type === type ? [item] : []), ...fields(item.props?.children, type)];
}

function savedDraft(firstZone: string) {
  const draft = createEventEditorDraft('UTC', 'main-date');
  draft.title = 'Workshop'; draft.outcome = 'Make something together';
  const first = draft.variants[0]!;
  first.timeZone = firstZone;
  first.schedule!.startLocal = '2027-01-01T09:00'; first.schedule!.endLocal = '2027-01-01T10:00';
  draft.variants.push({ ...structuredClone(first), id: 'other-zone', timeZone: 'America/New_York' });
  expect(isSavedProjectDraft({ ...makeDraft('public:visitor', undefined, 1000), editor: draft })).toBe(true);
  return draft;
}

function edit(draft: EditorDraft, onDraftChange: (draft: EditorDraft) => void) {
  return RecipeEditor({ value: { title: '', outcome: '', timeZone: 'UTC', variants: [], instructions: '' },
    draft, section: 'event', validationRequested: true, onDraftChange, onChange() {} });
}

describe('first-step option time zone recovery', () => {
  it('repairs the zone actually used by the first dates while retaining the rest of the saved draft', () => {
    const draft = savedDraft('Invalid/Saved_Zone');
    expect(eventDetailsReady(draft)).toBe(false);
    let changed: EditorDraft | undefined;
    const zones = fields(edit(draft, next => { changed = next; }), TimeZoneField);
    const firstZone = zones.find(field => field.props.value === 'Invalid/Saved_Zone');
    expect(firstZone).toBeDefined();
    expect(firstZone!.props.error).toBeTruthy();
    firstZone!.props.onChange!('Europe/Paris');
    const expected = structuredClone(draft); expected.variants[0]!.timeZone = 'Europe/Paris';
    expect(changed).toEqual(expected);
    expect(eventDetailsReady(changed!)).toBe(true);
  });

  it('keeps intentionally different valid zones when changing the global default', () => {
    const draft = savedDraft('Asia/Tokyo');
    draft.variants.push({ ...structuredClone(draft.variants[0]!), id: 'shared-default', timeZone: 'UTC' });
    let changed: EditorDraft | undefined;
    const zones = fields(edit(draft, next => { changed = next; }), TimeZoneField);
    expect(zones.some(field => field.props.value === 'Asia/Tokyo')).toBe(true);
    zones.find(field => field.props.value === 'UTC')!.props.onChange!('Europe/Paris');
    const expected = structuredClone(draft); expected.timeZone = 'Europe/Paris'; expected.variants[2]!.timeZone = 'Europe/Paris';
    expect(changed).toEqual(expected);
    expect(eventDetailsReady(changed!)).toBe(true);
  });
});
