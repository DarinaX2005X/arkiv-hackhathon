#!/usr/bin/env node
/** Rebuild the public, ODbL-licensed place data with Node's standard library only. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');
const output = join(root, 'public', 'places');
const version = 'v4.0-export.51';
const commit = 'bed35e907ce78992a7da3321d21a100e3fcb84bb';
const repository = 'https://github.com/dr5hn/countries-states-cities-database';
const raw = `https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/${commit}`;
const sources = {
  cities: { url: `${repository}/releases/download/${version}/json-cities.json.gz`, sha256: '32b23561c24c027ae8618ff46e4e889199a7f33efb8c94128bd00e510fe78893' },
  countries: { url: `${raw}/json/countries.json`, sha256: 'a12d03080595c22d4477ddc64383b7f795c156be3571bb3ebf969df9bbf75684' },
  license: { url: `${raw}/LICENSE`, sha256: '6042621cae96bbce3a10739b480a074e25b0ea23025c00d7874582ad2c47b780' },
  settlementGuide: { url: `${raw}/TYPE_FIELD.md`, sha256: '4b058c2451f328e9af31909d1effc682691cc494ae11e16420a2b21819f0714e' },
  readme: { url: `${raw}/README.md`, sha256: '6513490d8ddcc4b2918ed81414ee71478d921d81cf86e40f053ab981ce8ffffe' },
};
const maximumAssetBytes = 2 * 1024 * 1024;
const maximumCities = 50_000;
const maximumKeywords = 64;
const excludedTypes = new Set([
  'county', 'regency', 'prefecture', 'parish', 'banner', 'province', 'area', 'oblast',
  'administrative zone', 'region', 'abandoned', 'historical', 'destroyed', 'religious', 'historical_capital',
]);
const skippedCapitals = {
  MS: {
    name: 'Plymouth',
    reason: 'The source capital is a defunct settlement in the volcanic exclusion zone; it is not offered as a city choice.',
    reference: 'https://www.gov.ms/2023/05/31/montserrat-cabinet-approves-proposal-to-improve-access-to-zone-v/',
  },
};
const forbiddenText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const order = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const nameKey = value => value.normalize('NFC').toLowerCase();
const sortKey = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const byName = (left, right) => order(sortKey(left), sortKey(right)) || order(left, right);

function text(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return normalized.length > 0 && normalized.length <= 200 && !forbiddenText.test(normalized) ? normalized : null;
}

function assert(condition, message) { if (!condition) throw new Error(message); }

async function download(source) {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(60_000) });
  assert(response.ok, `Download failed (${response.status}): ${source.url}`);
  assert(Number(response.headers.get('content-length') || 0) <= 64 * 1024 * 1024, `Source is unexpectedly large: ${source.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 64 * 1024 * 1024, `Source is unexpectedly large: ${source.url}`);
  assert(sha256(bytes) === source.sha256, `Pinned source hash differs: ${source.url}`);
  return bytes;
}

function exclusion(row, country) {
  if (excludedTypes.has(row.type)) return `type:${row.type}`;
  if (['MX', 'GR', 'VN'].includes(country) && row.type === 'municipality') return 'municipal_territory';
  if (country === 'NL' && row.name.startsWith('Gemeente ')) return 'named_municipal_territory';
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  if (row.latitude == null || row.longitude == null || row.latitude === '' || row.longitude === ''
    || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return 'invalid_coordinates';
  if (!text(row.name)) return 'invalid_name';
  return null;
}

async function build() {
  const downloaded = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([key, source]) => [key, await download(source)])));
  const cityRows = JSON.parse(gunzipSync(downloaded.cities, { maxOutputLength: 384 * 1024 * 1024 }).toString('utf8'));
  const countryRows = JSON.parse(downloaded.countries.toString('utf8'));
  assert(Array.isArray(cityRows) && cityRows.length === 152_021, 'Unexpected pinned city row count');
  assert(Array.isArray(countryRows) && countryRows.length === 250, 'Unexpected pinned country row count');
  const countries = new Map();
  for (const country of countryRows) {
    assert(/^[A-Z]{2}$/.test(country.iso2) && !countries.has(country.iso2) && Number.isSafeInteger(country.id), 'Invalid source country identity');
    countries.set(country.iso2, { source: country, places: new Map(), sourceRows: 0, includedRows: 0, capitalSupplement: null });
  }
  const exclusions = {};
  const recordIds = new Set();
  let includedRows = 0;
  let normalizedNames = 0;
  let ignoredKeywords = 0;
  // IDs decide which source spelling wins a same-country case-insensitive duplicate.
  for (const row of cityRows.sort((left, right) => left.id - right.id)) {
    assert(Number.isSafeInteger(row.id) && row.id > 0 && !recordIds.has(row.id), 'Invalid or repeated source city ID');
    recordIds.add(row.id);
    const country = countries.get(row.country_code);
    assert(country && row.country_id === country.source.id, `Country partition mismatch for source city ${row.id}`);
    assert(typeof row.name === 'string', `Missing name for source city ${row.id}`);
    country.sourceRows += 1;
    const reason = exclusion(row, row.country_code);
    if (reason) { exclusions[reason] = (exclusions[reason] || 0) + 1; continue; }
    includedRows += 1;
    country.includedRows += 1;
    const name = text(row.name);
    if (name !== row.name) normalizedNames += 1;
    const key = nameKey(name);
    let place = country.places.get(key);
    if (!place) {
      place = { name, regions: new Set(), aliases: new Set() };
      country.places.set(key, place);
    }
    for (const [field, set] of [['state_name', place.regions], ['native', place.aliases]]) {
      if (row[field] == null || row[field] === '') continue;
      const keyword = text(row[field]);
      if (!keyword) { ignoredKeywords += 1; continue; }
      if (nameKey(keyword) !== key) set.add(keyword);
    }
    // A differing source spelling is searchable even though one name must be canonical.
    if (name !== place.name) place.aliases.add(name);
  }
  const supplements = [];
  const omittedCapitals = [];
  for (const [countryCode, country] of countries) {
    if (country.places.size > 0) continue;
    const capital = text(country.source.capital);
    if (!capital) continue;
    if (skippedCapitals[countryCode]?.name === capital) {
      omittedCapitals.push({ countryCode, ...skippedCapitals[countryCode] });
      continue;
    }
    country.places.set(nameKey(capital), { name: capital, regions: new Set(), aliases: new Set() });
    country.capitalSupplement = { countryId: country.source.id, name: capital, sourceField: 'countries.capital' };
    supplements.push({ countryCode, ...country.capitalSupplement });
  }
  const assets = [];
  const files = [];
  let totalChoices = 0;
  let totalBytes = 0;
  let maxKeywords = 0;
  for (const [countryCode, country] of [...countries].sort(([left], [right]) => order(left, right))) {
    const places = [...country.places.values()].sort((left, right) => byName(left.name, right.name));
    const regions = [...new Set(places.flatMap(place => [...place.regions]))].sort(byName);
    const regionIndex = new Map(regions.map((name, index) => [name, index]));
    const cities = places.map(place => {
      const indices = [...place.regions].map(region => regionIndex.get(region)).sort((left, right) => left - right);
      const aliases = [...place.aliases].filter(alias => nameKey(alias) !== nameKey(place.name)).sort(byName);
      assert(indices.length + aliases.length <= maximumKeywords, `Too many search keywords for ${countryCode}/${place.name}`);
      maxKeywords = Math.max(maxKeywords, indices.length + aliases.length);
      return [place.name, indices, aliases];
    });
    const asset = { version: 1, countryCode, dataVersion: version, regions, cities };
    const bytes = json(asset);
    assert(cities.length <= maximumCities && bytes.length <= maximumAssetBytes, `Country asset exceeds the loader bounds: ${countryCode}`);
    const path = `${version}/${countryCode}.json`;
    files.push({ path, bytes });
    totalChoices += cities.length;
    totalBytes += bytes.length;
    assets.push({ countryCode, country: country.source.name, path, choices: cities.length, sourceRows: country.sourceRows,
      settlementRows: country.includedRows, mergedRows: country.includedRows - (cities.length - (country.capitalSupplement ? 1 : 0)),
      capitalSupplement: country.capitalSupplement, bytes: bytes.length, sha256: sha256(bytes), asset });
  }
  const archiveName = `cities-${version}.json.gz`;
  const archive = gzipSync(json(assets.map(({ asset }) => asset)), { level: 9 });
  const provenance = {
    formatVersion: 1,
    dataset: 'Countries States Cities Database',
    license: 'ODbL-1.0',
    repository,
    release: version,
    releasePublishedAt: '2026-10-12T23:10:55Z',
    commit,
    sources: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, { ...source, bytes: downloaded[key].length }])),
    generator: { path: 'scripts/build-places.mjs', sha256: sha256(await readFile(scriptPath)), command: 'node scripts/build-places.mjs', checkCommand: 'node scripts/build-places.mjs --check' },
    transformations: {
      settlementRules: `${repository}/blob/${commit}/TYPE_FIELD.md`,
      excludedTypes: [...excludedTypes],
      countrySpecificRules: ['MX/GR/VN: omit municipality territories', 'NL: omit names starting Gemeente '],
      namePolicy: 'Keep Unicode; NFC normalization, whitespace normalization and trim; 1–200 UTF-16 code units; no control characters or bidi overrides.',
      duplicatePolicy: 'One NFC/case-insensitive city name per country. Lowest source city ID supplies the canonical spelling; all usable state names and native spellings remain search keywords.',
      capitalPolicy: 'Only countries with no retained settlement rows receive their nonempty capital from the same pinned countries source, excluding the documented defunct-capital exception.',
      coordinatePolicy: 'Require finite coordinates within valid latitude/longitude ranges; coordinates are omitted from product assets.',
      ordering: 'Deterministic accent-folded lower-case name order with Unicode code-point tie-break; region and native keywords sorted likewise.',
      removedFields: ['source IDs', 'coordinates', 'population', 'timezone', 'translations', 'administrative metadata'],
      normalizedNames, ignoredKeywords, excludedRowsByReason: exclusions,
      capitalSupplements: supplements.sort((left, right) => order(left.countryCode, right.countryCode)),
      omittedCapitals,
    },
    counts: {
      sourceCountries: countries.size, sourceCityRecords: cityRows.length, sourceCountriesWithCityRows: [...countries.values()].filter(country => country.sourceRows > 0).length,
      settlementRecords: includedRows, excludedRecords: cityRows.length - includedRows,
      mergedSameNameRecords: includedRows - (totalChoices - supplements.length), capitalSupplements: supplements.length,
      choices: totalChoices, nonemptyCountries: assets.filter(asset => asset.choices > 0).length,
      emptyCountries: assets.filter(asset => asset.choices === 0).map(asset => asset.countryCode),
      maximumSearchKeywords: maxKeywords,
    },
    distribution: {
      partitionBytes: totalBytes,
      largestPartition: assets.reduce((largest, asset) => asset.bytes > largest.bytes ? { countryCode: asset.countryCode, bytes: asset.bytes, choices: asset.choices } : largest, { countryCode: '', bytes: 0, choices: 0 }),
      archive: { path: archiveName, bytes: archive.length, sha256: sha256(archive) },
    },
    countries: assets.map(({ asset: _asset, ...metadata }) => metadata),
  };
  const attribution = `# Place directory data\n\nData by [Countries States Cities Database](${repository}), released under the [Open Database License (ODbL) v1.0](./LICENSE). This directory and its derived data remain under ODbL v1.0; application code and the build script retain the repository's MIT license. No third-party city library is installed.\n\nSource credits: [GeoNames](https://www.geonames.org/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL 1.0); [Wikidata](https://www.wikidata.org/) ([CC0](https://creativecommons.org/publicdomain/zero/1.0/)). Upstream per-record source ledgers are available [in the pinned repository](${repository}/tree/${commit}/.github/fixes-docs/ledgers). These credits are preserved from the source README.\n\n## Download and provenance\n\n[Download the complete derived dataset](./${archiveName}) as gzipped JSON. It is an array of the same country objects served individually under \`${version}/{countryCode}.json\`. All copies are available without authentication or payment. [Machine-readable provenance](./provenance.json) lists every partition, its SHA-256, size, count, source URL and transformation rules. The complete upstream license is included in [LICENSE](./LICENSE).\n\nSource release: [${version}](${repository}/releases/tag/${version}), published 12 October 2026. Source commit: [${commit}](${repository}/commit/${commit}). Source files are pinned by SHA-256; rebuilding stops if any hash differs. The original upstream records can be downloaded from the pinned URLs in provenance.json; this directory contains a compact derivative rather than the full original city export.\n\n## Coverage and changes\n\nThe actual pinned city export contains ${cityRows.length.toLocaleString('en-US')} records. Applying the source's [settlement rules](${repository}/blob/${commit}/TYPE_FIELD.md) retains ${includedRows.toLocaleString('en-US')} records, excluding administrative-only units and defunct places. Case-insensitive duplicate names within a country are merged because Partfolk's existing event schema stores a city name, not a city ID. Native Unicode is kept; state names and native spellings are searchable keywords. Distinct same-name settlements in one country share a choice and retain their combined region keywords.\n\nThere are ${totalChoices.toLocaleString('en-US')} unique choices across ${provenance.counts.nonemptyCountries} nonempty country/territory partitions. ${supplements.length} countries without retained city rows use a capital recorded in the same pinned country source. These supplements are explicitly listed in provenance.json. The source capital Plymouth, Montserrat, is omitted as a defunct settlement; the [Government of Montserrat describes its controlled exclusion-zone access](${skippedCapitals.MS.reference}). Empty partitions: ${provenance.counts.emptyCountries.join(', ')}. XK is the source's assigned code for Kosovo, in addition to the 249 ISO 3166-1 country/territory codes.\n\nThis community-maintained directory is not a complete list of every settlement and may contain errors. A directory option establishes a consistent spelling; it does not verify an event's venue or its location. No event or wallet data is included.\n\n## Rebuild\n\nFrom the repository root, run \`node scripts/build-places.mjs\` with Node 22 or later. The script downloads only pinned public source files, verifies their hashes, applies the documented transformations and rewrites these assets deterministically. Run \`node scripts/build-places.mjs --check\` to verify the shipped files, complete archive, license and generator hash offline. No package installation, API key or runtime external service is required.\n\nCompact country format: \`{version: 1, countryCode, dataVersion, regions: string[], cities: [name, regionIndices: number[], nativeAliases: string[]][]}\`. Name values are the canonical city strings; region indices and native aliases are search-only metadata.\n`;
  // Validate the complete result before writing any files. No prior snapshots are deleted.
  await mkdir(join(output, version), { recursive: true });
  for (const file of files) await writeFile(join(output, file.path), file.bytes);
  await writeFile(join(output, archiveName), archive);
  await writeFile(join(output, 'LICENSE'), downloaded.license);
  await writeFile(join(output, 'ATTRIBUTION.md'), attribution, 'utf8');
  await writeFile(join(output, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return check();
}

async function check() {
  const provenance = JSON.parse(await readFile(join(output, 'provenance.json'), 'utf8'));
  assert(provenance.release === version && provenance.commit === commit && provenance.license === 'ODbL-1.0', 'Unexpected data provenance');
  assert(provenance.generator.sha256 === sha256(await readFile(scriptPath)), 'Generator changed; rebuild the dataset');
  assert(sha256(await readFile(join(output, 'LICENSE'))) === sources.license.sha256, 'Source license differs');
  const expectedFiles = provenance.countries.map(country => `${country.countryCode}.json`).sort();
  assert(JSON.stringify((await readdir(join(output, version))).sort()) === JSON.stringify(expectedFiles), 'Country file inventory differs');
  let totalChoices = 0;
  let totalBytes = 0;
  const assets = [];
  for (const country of provenance.countries) {
    assert(/^[A-Z]{2}$/.test(country.countryCode) && country.path === `${version}/${country.countryCode}.json`, 'Invalid country path');
    const bytes = await readFile(join(output, country.path));
    assert(bytes.length === country.bytes && bytes.length <= maximumAssetBytes && sha256(bytes) === country.sha256, `Country asset integrity failure: ${country.countryCode}`);
    const asset = JSON.parse(bytes.toString('utf8'));
    assert(asset.version === 1 && asset.countryCode === country.countryCode && asset.dataVersion === version, `Country partition mismatch: ${country.countryCode}`);
    assert(asset.cities.length === country.choices && asset.cities.length <= maximumCities, `Country count mismatch: ${country.countryCode}`);
    assert(asset.regions.every(region => text(region) === region) && new Set(asset.regions).size === asset.regions.length, 'Invalid region dictionary');
    const seen = new Set();
    for (const [name, indices, aliases] of asset.cities) {
      assert(text(name) === name && !seen.has(nameKey(name)), `Invalid or repeated city name: ${country.countryCode}/${name}`);
      seen.add(nameKey(name));
      assert(Array.isArray(indices) && Array.isArray(aliases) && indices.length + aliases.length <= maximumKeywords, 'Invalid search keywords');
      assert(new Set(indices).size === indices.length && indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < asset.regions.length), 'Invalid region index');
      assert(new Set(aliases).size === aliases.length && aliases.every(alias => text(alias) === alias), 'Invalid native alias');
    }
    assert(json(asset).equals(bytes), 'Non-canonical country serialization');
    totalChoices += country.choices;
    totalBytes += country.bytes;
    assets.push(asset);
  }
  assert(totalChoices === provenance.counts.choices && totalBytes === provenance.distribution.partitionBytes, 'Total counts differ');
  const archive = await readFile(join(output, provenance.distribution.archive.path));
  assert(archive.length === provenance.distribution.archive.bytes && sha256(archive) === provenance.distribution.archive.sha256, 'Complete archive integrity failure');
  assert(gunzipSync(archive).equals(json(assets)), 'Complete archive does not match country partitions');
  console.log(JSON.stringify({ status: 'verified', release: version, countries: provenance.countries.length, ...provenance.counts, ...provenance.distribution }, null, 2));
}

const arguments_ = process.argv.slice(2);
assert(arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--check'), 'Usage: node scripts/build-places.mjs [--check]');
await (arguments_[0] === '--check' ? check() : build());
