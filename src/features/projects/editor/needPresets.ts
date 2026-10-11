import type { ResourceKind } from '../../../domain/types';
export interface NeedPreset { value: string; label: string; kind: ResourceKind; unit: string }
/** Shared ordinary labels produce the same exact matching terms in needs and offers. */
export const needPresets: NeedPreset[] = [
  { value: 'setup', label: 'Setup help', kind: 'person', unit: 'person' },
  { value: 'hosting', label: 'Event host', kind: 'person', unit: 'person' },
  { value: 'speaking', label: 'Speaker or workshop leader', kind: 'person', unit: 'person' },
  { value: 'facilitation', label: 'Online facilitation', kind: 'person', unit: 'person' },
  { value: 'photography', label: 'Photography', kind: 'person', unit: 'person' },
  { value: 'meeting', label: 'Meeting or workshop space', kind: 'place', unit: 'space' },
  { value: 'exhibition', label: 'Exhibition space', kind: 'place', unit: 'space' },
  { value: 'audio', label: 'Audio equipment', kind: 'equipment', unit: 'item' },
  { value: 'projection', label: 'Projector', kind: 'equipment', unit: 'item' },
  { value: 'transport', label: 'Transport vehicle', kind: 'equipment', unit: 'vehicle' },
];
