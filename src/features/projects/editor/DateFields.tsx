import { useMemo } from 'react';
import { localDateTimeToUtc } from '../../../app/time';
import { Field, Select } from '../../../ui';

export function timeZoneOptions(current: string) {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = supported ? supported('timeZone') : ['Africa/Cairo', 'America/Chicago', 'America/Los_Angeles', 'America/New_York', 'Asia/Almaty', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/Berlin', 'Europe/London', 'Pacific/Auckland'];
  return [...new Set(['UTC', current, ...zones])].filter(Boolean).map(value => ({ value, label: value === 'UTC' ? 'UTC (Universal time)' : value.split('/').reverse().map(part => part.replaceAll('_', ' ')).join(', ') }));
}
export function TimeZoneField({ label = 'Time zone', value, onChange, hint, error }: { label?: string; value: string; onChange: (value: string) => void; hint?: string; error?: string }) {
  const options = useMemo(() => timeZoneOptions(value), [value]);
  return <Select label={label} value={value} options={options} onChange={event => onChange(event.target.value)} hint={hint} error={error} />;
}
/** A malformed imported value stays editable instead of being hidden by native input sanitization. */
export function dateInputType(value: string): 'text' | 'datetime-local' {
  return value && !localDateTimeToUtc(value, 'UTC').ok ? 'text' : 'datetime-local';
}
export function LocalDateField({ label, value, onChange, error, hint }: { label: string; value: string; onChange: (value: string) => void; error?: string; hint?: string }) {
  const type = dateInputType(value);
  return <Field label={label} type={type} value={value} onChange={event => onChange(event.target.value)} error={error}
    hint={type === 'text' ? `Saved date needs correction: ${value}. Enter a date and time such as 2026-10-17T09:00.` : hint} />;
}
