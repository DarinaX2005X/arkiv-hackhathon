import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityOption } from './directory';

interface Asset {
  version: number;
  countryCode: string;
  dataVersion: string;
  regions: string[];
  cities: [string, number[], string[]][];
}
function asset(countryCode = 'KZ', changes: Partial<Asset> = {}): Asset {
  return { version: 1, countryCode, dataVersion: 'v4.0-export.51', regions: ['Almaty Region'], cities: [['Almaty', [0], ['Алматы']]], ...changes };
}
function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('country city directory loader', () => {
  it('loads one versioned local country asset and caches an immutable validated result', async () => {
    const fetcher = vi.fn(async () => jsonResponse(asset()));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    const first = await loadCityOptions('KZ');
    expect(first).toEqual([{ value: 'Almaty', label: 'Almaty', keywords: ['Almaty Region', 'Алматы'] }]);
    expect(await loadCityOptions('KZ')).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/places/v4.0-export.51/KZ.json', expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.keywords)).toBe(true);
  });

  it('rejects unknown, path-like and noncanonical country codes before fetching', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions, hasCityDirectoryCountry } = await import('./directory');
    for (const country of ['', 'kz', ' KZ', 'ZZ', '../KZ', 'constructor', 'KZZ']) {
      expect(hasCityDirectoryCountry(country)).toBe(false);
      await expect(loadCityOptions(country)).rejects.toMatchObject({ code: 'invalid_country' });
    }
    expect(hasCityDirectoryCountry('XK')).toBe(true);
    expect(hasCityDirectoryCountry('KZ')).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong country', asset('GB')],
    ['wrong release', asset('KZ', { dataVersion: 'latest' })],
    ['case duplicate', asset('KZ', { cities: [['Almaty', [], []], ['ALMATY', [], []]] })],
    ['noncanonical Unicode', asset('KZ', { cities: [['Que\u0301bec', [], []]] })],
    ['control characters', asset('KZ', { cities: [['Alma\u0000ty', [], []]] })],
    ['unpaired surrogate', asset('KZ', { cities: [['Alma\ud800ty', [], []]] })],
    ['missing region', asset('KZ', { cities: [['Almaty', [8], []]] })],
    ['duplicate region', asset('KZ', { cities: [['Almaty', [0, 0], []]] })],
    ['blank alias', asset('KZ', { cities: [['Almaty', [], [' ']]] })],
    ['unknown fields', { ...asset(), unvalidated: 'anything' }],
  ])('rejects a corrupt country result: %s', async (_reason, value) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(value)));
    const { loadCityOptions } = await import('./directory');
    await expect(loadCityOptions('KZ')).rejects.toMatchObject({ code: 'invalid_data' });
  });

  it('rejects an HTML fallback and a malformed UTF-8 body', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('<html>Not found</html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    await expect(loadCityOptions('KZ')).rejects.toMatchObject({ code: 'invalid_data' });
    await expect(loadCityOptions('KZ')).rejects.toMatchObject({ code: 'invalid_data' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds declared and streamed bytes, and bounds the number of choices', async () => {
    const hugeStream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(asset(), { 'content-length': '3000000' }))
      .mockResolvedValueOnce(new Response(hugeStream, { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(jsonResponse(asset('KZ', { cities: Array.from({ length: 50_001 }, (_, index) => [`City ${index}`, [], []]) })));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(loadCityOptions('KZ')).rejects.toMatchObject({ code: 'too_large' });
  });

  it('makes network and validation failures retryable without caching partial choices', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(asset('GB')))
      .mockResolvedValueOnce(jsonResponse(asset()));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions, cityDirectoryErrorMessage } = await import('./directory');
    await expect(loadCityOptions('KZ')).rejects.toMatchObject({ code: 'load_failed' });
    await expect(loadCityOptions('KZ')).rejects.toMatchObject({ code: 'load_failed' });
    await expect(loadCityOptions('KZ')).rejects.toMatchObject({ code: 'invalid_data' });
    const choices = await loadCityOptions('KZ');
    expect(choices[0]?.value).toBe('Almaty');
    expect(await loadCityOptions('KZ')).toBe(choices);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(cityDirectoryErrorMessage(new Error('sensitive transport detail'))).toBe('City choices could not be loaded. Try again.');
  });

  it('caches an honest empty partition as successful coverage information', async () => {
    const fetcher = vi.fn(async () => jsonResponse(asset('AQ', { regions: [], cities: [] })));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    expect(await loadCityOptions('AQ')).toEqual([]);
    expect(await loadCityOptions('AQ')).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors a pre-aborted caller and a caller cancelled before a cached result is delivered', async () => {
    const fetcher = vi.fn(async () => jsonResponse(asset()));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions, isCityDirectoryAbort } = await import('./directory');
    const stopped = new AbortController();
    stopped.abort();
    const error = await loadCityOptions('KZ', { signal: stopped.signal }).catch(value => value);
    expect(isCityDirectoryAbort(error)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await loadCityOptions('KZ');
    const controller = new AbortController();
    const cached = loadCityOptions('KZ', { signal: controller.signal });
    controller.abort();
    await expect(cached).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('coalesces one country request while letting either caller cancel independently', async () => {
    const response = deferred<Response>();
    let networkSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => { networkSignal = options?.signal ?? undefined; return response.promise; });
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    const controller = new AbortController();
    const first = loadCityOptions('KZ', { signal: controller.signal });
    const second = loadCityOptions('KZ');
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(networkSignal?.aborted).toBe(false);
    response.resolve(jsonResponse(asset()));
    expect((await second)[0]?.value).toBe('Almaty');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels an abandoned request and does not let its late completion replace a retry', async () => {
    const old = deferred<Response>();
    let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn()
      .mockImplementationOnce((_url: string, options?: RequestInit) => { oldSignal = options?.signal ?? undefined; return old.promise; })
      .mockResolvedValueOnce(jsonResponse(asset()));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    const controller = new AbortController();
    const abandoned = loadCityOptions('KZ', { signal: controller.signal });
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    expect(oldSignal?.aborted).toBe(true);
    const replacement = await loadCityOptions('KZ');
    old.resolve(jsonResponse(asset('KZ', { cities: [['Unwanted old value', [], []]] })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await loadCityOptions('KZ')).toBe(replacement);
    expect(replacement[0]?.value).toBe('Almaty');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps separate country results separate during a country change', async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith('/KZ.json') ? old.promise : Promise.resolve(jsonResponse(asset('GB', { regions: ['Westminster'], cities: [['London', [0], []]] }))));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    const controller = new AbortController();
    const previous = loadCityOptions('KZ', { signal: controller.signal });
    controller.abort();
    await expect(previous).rejects.toMatchObject({ name: 'AbortError' });
    const current = await loadCityOptions('GB');
    old.resolve(jsonResponse(asset()));
    expect(current.map(option => option.value)).toEqual(['London']);
    expect(await loadCityOptions('GB')).toBe(current);
  });

  it('turns a stalled fetch into a recoverable load failure', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockImplementationOnce((_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }))
      .mockResolvedValueOnce(jsonResponse(asset()));
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions } = await import('./directory');
    const stalled = loadCityOptions('KZ');
    const failure = expect(stalled).rejects.toMatchObject({ code: 'load_failed' });
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect((await loadCityOptions('KZ'))[0]?.value).toBe('Almaty');
  });
});

describe('shipped offline directory integrity', () => {
  it('validates every country partition, source counts, Unicode, merged names and the full download', async () => {
    const dataRoot = fileURLToPath(new URL('../../../public/places/', import.meta.url));
    const provenance = JSON.parse(await readFile(`${dataRoot}/provenance.json`, 'utf8')) as {
      release: string; commit: string; license: string;
      counts: { sourceCityRecords: number; settlementRecords: number; excludedRecords: number; mergedSameNameRecords: number; capitalSupplements: number; choices: number; nonemptyCountries: number; emptyCountries: string[] };
      distribution: { partitionBytes: number; archive: { path: string; bytes: number; sha256: string } };
      countries: { countryCode: string; path: string; choices: number; bytes: number; sha256: string }[];
    };
    const hashes = new Map<string, string>();
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toMatch(/^\/places\/v4\.0-export\.51\/[A-Z]{2}\.json$/);
      const bytes = await readFile(`${dataRoot}/${url.slice('/places/'.length)}`);
      hashes.set(url, createHash('sha256').update(bytes).digest('hex'));
      return new Response(bytes, { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetcher);
    const { loadCityOptions, hasCityDirectoryCountry } = await import('./directory');
    const options = new Map<string, readonly CityOption[]>();
    let choices = 0;
    let partitionBytes = 0;
    for (const country of provenance.countries) {
      expect(hasCityDirectoryCountry(country.countryCode)).toBe(true);
      const loaded = await loadCityOptions(country.countryCode);
      expect(loaded).toHaveLength(country.choices);
      expect(new Set(loaded.map(option => option.value.toLowerCase())).size).toBe(loaded.length);
      expect(loaded.every(option => option.value === option.value.normalize('NFC') && option.value === option.label)).toBe(true);
      expect(hashes.get(`/places/${country.path}`)).toBe(country.sha256);
      options.set(country.countryCode, loaded);
      choices += loaded.length;
      partitionBytes += country.bytes;
    }
    expect(provenance.countries).toHaveLength(250);
    expect(await readdir(`${dataRoot}/${provenance.release}`)).toHaveLength(250);
    expect(choices).toBe(135_435);
    expect(choices).toBe(provenance.counts.choices);
    expect(partitionBytes).toBe(provenance.distribution.partitionBytes);
    expect(provenance.counts).toMatchObject({ sourceCityRecords: 152_021, settlementRecords: 148_091, excludedRecords: 3_930, mergedSameNameRecords: 12_678, capitalSupplements: 22, nonemptyCountries: 244 });
    expect(provenance.counts.emptyCountries).toEqual(['AQ', 'BV', 'HM', 'MS', 'TK', 'UM']);
    expect(options.get('KZ')?.find(option => option.value === 'Almaty')?.keywords).toContain('Алматы');
    expect(options.get('GB')?.some(option => option.value === 'London')).toBe(true);
    expect(options.get('BR')?.some(option => option.value === 'São Paulo')).toBe(true);
    expect(options.get('IS')?.some(option => option.value === 'Reykjavík')).toBe(true);
    const usLondon = options.get('US')?.filter(option => option.value === 'London');
    expect(usLondon).toHaveLength(1);
    expect(usLondon?.[0]?.keywords).toEqual(expect.arrayContaining(['Arkansas', 'California', 'Kentucky', 'Ohio']));
    expect(options.get('AI')?.map(option => option.value)).toEqual(['The Valley']);
    expect(options.get('VA')?.map(option => option.value)).toEqual(['Vatican City']);
    expect(options.get('MS')).toEqual([]);
    expect(provenance.license).toBe('ODbL-1.0');
    expect(provenance.commit).toBe('bed35e907ce78992a7da3321d21a100e3fcb84bb');
    const archive = await readFile(`${dataRoot}/${provenance.distribution.archive.path}`);
    expect(archive.length).toBe(provenance.distribution.archive.bytes);
    expect(createHash('sha256').update(archive).digest('hex')).toBe(provenance.distribution.archive.sha256);
    const complete = JSON.parse(gunzipSync(archive).toString('utf8')) as Asset[];
    expect(complete).toHaveLength(250);
    expect(complete.reduce((count, country) => count + country.cities.length, 0)).toBe(choices);
    expect(fetcher).toHaveBeenCalledTimes(250);
  });
});
