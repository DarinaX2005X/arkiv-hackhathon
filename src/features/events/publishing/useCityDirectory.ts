import { useEffect, useState } from 'react';
import { cityDirectoryErrorMessage, hasCityDirectoryCountry, isCityDirectoryAbort, loadCityOptions, type CityOption } from '../../../data/places/directory';

interface CityDirectoryState { countryCode: string; status: 'idle' | 'loading' | 'ready' | 'error'; options: readonly CityOption[]; error: string | null }

export function useCityDirectory(countryCode: string, enabled: boolean) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<CityDirectoryState>({ countryCode: '', status: 'idle', options: [], error: null });
  useEffect(() => {
    if (!enabled || !countryCode) { setState({ countryCode, status: 'idle', options: [], error: null }); return; }
    if (!hasCityDirectoryCountry(countryCode)) { setState({ countryCode, status: 'error', options: [], error: 'Choose a country from the list.' }); return; }
    const controller = new AbortController();
    setState({ countryCode, status: 'loading', options: [], error: null });
    void loadCityOptions(countryCode, { signal: controller.signal }).then(options => {
      if (!controller.signal.aborted) setState({ countryCode, status: 'ready', options, error: null });
    }).catch(error => {
      if (!controller.signal.aborted && !isCityDirectoryAbort(error)) setState({ countryCode, status: 'error', options: [], error: cityDirectoryErrorMessage(error) });
    });
    return () => controller.abort();
  }, [countryCode, enabled, retry]);
  const current = state.countryCode === countryCode && enabled ? state : { countryCode, status: enabled && countryCode ? 'loading' as const : 'idle' as const, options: [], error: null };
  return { ...current, retry: () => setRetry(value => value + 1) };
}
