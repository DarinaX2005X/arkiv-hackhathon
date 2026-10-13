/**
 * The country-partitioned place data is served from our own public assets.
 * Dataset license and provenance: /places/ATTRIBUTION.md. Application code: MIT.
 */
export interface CityOption {
  readonly value: string;
  readonly label: string;
  readonly keywords?: readonly string[];
}

export type CityDirectoryErrorCode = 'invalid_country' | 'load_failed' | 'invalid_data' | 'too_large';

export class CityDirectoryError extends Error {
  readonly name = 'CityDirectoryError';
  constructor(readonly code: CityDirectoryErrorCode) {
    super(code === 'invalid_country' ? 'Choose a country from the list.' : 'City choices could not be loaded. Try again.');
  }
}

export function cityDirectoryErrorMessage(error: unknown): string {
  return error instanceof CityDirectoryError ? error.message : 'City choices could not be loaded. Try again.';
}

export function isCityDirectoryAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

// ISO 3166-1 alpha-2 countries/territories plus the source's explicitly assigned XK (Kosovo).
const countryCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' '));
const dataVersion = 'v4.0-export.51';
const maximumBytes = 2 * 1024 * 1024;
const maximumCities = 50_000;
const maximumRegions = 10_000;
const maximumKeywords = 64;
const requestTimeoutMs = 15_000;
const forbiddenText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;

/** A malformed, unknown or lower-case code never becomes an asset URL. */
export function hasCityDirectoryCountry(countryCode: string): boolean {
  return typeof countryCode === 'string' && countryCodes.has(countryCode);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && value === value.trim() && value === value.normalize('NFC') && !forbiddenText.test(value);
}

function invalidData(): never { throw new CityDirectoryError('invalid_data'); }
function abortError(): DOMException { return new DOMException('City loading was cancelled.', 'AbortError'); }

/** Reject a partial, mismatched or corrupted country asset before exposing any choices. */
function parseOptions(value: unknown, countryCode: string): readonly CityOption[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidData();
  const asset = value as Record<string, unknown>;
  if (Object.keys(asset).sort().join(',') !== 'cities,countryCode,dataVersion,regions,version'
    || asset.version !== 1 || asset.dataVersion !== dataVersion || asset.countryCode !== countryCode
    || !Array.isArray(asset.regions) || !Array.isArray(asset.cities)) return invalidData();
  if (asset.cities.length > maximumCities || asset.regions.length > maximumRegions) throw new CityDirectoryError('too_large');
  const regions = asset.regions;
  if (!regions.every(validText) || new Set(regions).size !== regions.length) return invalidData();
  const seen = new Set<string>();
  const options: CityOption[] = [];
  for (const row of asset.cities) {
    if (!Array.isArray(row) || row.length !== 3 || !validText(row[0]) || !Array.isArray(row[1]) || !Array.isArray(row[2])) return invalidData();
    const [name, regionIndices, aliases] = row as [string, unknown[], unknown[]];
    if (regionIndices.length + aliases.length > maximumKeywords) throw new CityDirectoryError('too_large');
    const nameKey = name.toLowerCase();
    if (seen.has(nameKey)) return invalidData();
    seen.add(nameKey);
    if (new Set(regionIndices).size !== regionIndices.length || !regionIndices.every(index =>
      typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < regions.length)
      || !aliases.every(validText) || new Set(aliases).size !== aliases.length) return invalidData();
    const keywords = [...new Set([
      ...(regionIndices as number[]).map(index => regions[index] as string), ...(aliases as string[]),
    ])].filter(keyword => keyword.toLowerCase() !== nameKey);
    options.push(Object.freeze({ value: name, label: name, ...(keywords.length ? { keywords: Object.freeze(keywords) } : {}) }));
  }
  return Object.freeze(options);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new CityDirectoryError('too_large');
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) return invalidData();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new CityDirectoryError('too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted) throw abortError();
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown; }
  catch { return invalidData(); }
}

async function fetchOptions(countryCode: string, signal: AbortSignal): Promise<readonly CityOption[]> {
  try {
    // Absolute to this origin: both / and /desk use the same versioned public data.
    const response = await fetch(`/places/${dataVersion}/${countryCode}.json`, {
      signal, credentials: 'omit', headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new CityDirectoryError('load_failed');
    const options = parseOptions(await readBoundedJson(response, signal), countryCode);
    if (signal.aborted) throw abortError();
    return options;
  } catch (error) {
    if (signal.aborted || isCityDirectoryAbort(error)) throw abortError();
    if (error instanceof CityDirectoryError) throw error;
    throw new CityDirectoryError('load_failed');
  }
}

interface PendingRequest {
  controller: AbortController;
  promise: Promise<readonly CityOption[]>;
  consumers: number;
  settled: boolean;
  timedOut: boolean;
}
const successful = new Map<string, readonly CityOption[]>();
const pending = new Map<string, PendingRequest>();

function subscribe(countryCode: string, request: PendingRequest, signal?: AbortSignal): Promise<readonly CityOption[]> {
  request.consumers += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (deliver: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      request.consumers -= 1;
      deliver();
      if (!request.settled && request.consumers === 0) {
        if (pending.get(countryCode) === request) pending.delete(countryCode);
        request.controller.abort();
      }
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.promise.then(options => finish(() => resolve(options)), error => finish(() => reject(error)));
    if (signal?.aborted) onAbort();
  });
}

/**
 * Load strict canonical city-name values. A valid country with no source coverage
 * resolves to []; failures reject and can be retried. Each caller can cancel
 * independently; the shared fetch stops when its last consumer leaves.
 */
export function loadCityOptions(countryCode: string, options: { signal?: AbortSignal } = {}): Promise<readonly CityOption[]> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  if (!hasCityDirectoryCountry(countryCode)) return Promise.reject(new CityDirectoryError('invalid_country'));
  const cached = successful.get(countryCode);
  if (cached) return Promise.resolve().then(() => {
    if (options.signal?.aborted) throw abortError();
    return cached;
  });
  let request = pending.get(countryCode);
  if (!request) {
    const controller = new AbortController();
    request = { controller, consumers: 0, settled: false, timedOut: false, promise: Promise.resolve([]) };
    const active = request;
    const timer = setTimeout(() => { active.timedOut = true; controller.abort(); }, requestTimeoutMs);
    active.promise = fetchOptions(countryCode, controller.signal).then(result => {
      if (controller.signal.aborted) throw abortError();
      successful.set(countryCode, result);
      return result;
    }).catch(error => {
      if (active.timedOut) throw new CityDirectoryError('load_failed');
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      active.settled = true;
      if (pending.get(countryCode) === active) pending.delete(countryCode);
    });
    pending.set(countryCode, active);
  }
  return subscribe(countryCode, request, options.signal);
}
