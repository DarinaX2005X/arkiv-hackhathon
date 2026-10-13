# Place directory data

Data by [Countries States Cities Database](https://github.com/dr5hn/countries-states-cities-database), released under the [Open Database License (ODbL) v1.0](./LICENSE). This directory and its derived data remain under ODbL v1.0; application code and the build script retain the repository's MIT license. No third-party city library is installed.

Source credits: [GeoNames](https://www.geonames.org/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL 1.0); [Wikidata](https://www.wikidata.org/) ([CC0](https://creativecommons.org/publicdomain/zero/1.0/)). Upstream per-record source ledgers are available [in the pinned repository](https://github.com/dr5hn/countries-states-cities-database/tree/bed35e907ce78992a7da3321d21a100e3fcb84bb/.github/fixes-docs/ledgers). These credits are preserved from the source README.

## Download and provenance

[Download the complete derived dataset](./cities-v4.0-export.51.json.gz) as gzipped JSON. It is an array of the same country objects served individually under `v4.0-export.51/{countryCode}.json`. All copies are available without authentication or payment. [Machine-readable provenance](./provenance.json) lists every partition, its SHA-256, size, count, source URL and transformation rules. The complete upstream license is included in [LICENSE](./LICENSE).

Source release: [v4.0-export.51](https://github.com/dr5hn/countries-states-cities-database/releases/tag/v4.0-export.51), published 12 October 2026. Source commit: [bed35e907ce78992a7da3321d21a100e3fcb84bb](https://github.com/dr5hn/countries-states-cities-database/commit/bed35e907ce78992a7da3321d21a100e3fcb84bb). Source files are pinned by SHA-256; rebuilding stops if any hash differs. The original upstream records can be downloaded from the pinned URLs in provenance.json; this directory contains a compact derivative rather than the full original city export.

## Coverage and changes

The actual pinned city export contains 152,021 records. Applying the source's [settlement rules](https://github.com/dr5hn/countries-states-cities-database/blob/bed35e907ce78992a7da3321d21a100e3fcb84bb/TYPE_FIELD.md) retains 148,091 records, excluding administrative-only units and defunct places. Case-insensitive duplicate names within a country are merged because Partfolk's existing event schema stores a city name, not a city ID. Native Unicode is kept; state names and native spellings are searchable keywords. Distinct same-name settlements in one country share a choice and retain their combined region keywords.

There are 135,435 unique choices across 244 nonempty country/territory partitions. 22 countries without retained city rows use a capital recorded in the same pinned country source. These supplements are explicitly listed in provenance.json. The source capital Plymouth, Montserrat, is omitted as a defunct settlement; the [Government of Montserrat describes its controlled exclusion-zone access](https://www.gov.ms/2023/05/31/montserrat-cabinet-approves-proposal-to-improve-access-to-zone-v/). Empty partitions: AQ, BV, HM, MS, TK, UM. XK is the source's assigned code for Kosovo, in addition to the 249 ISO 3166-1 country/territory codes.

This community-maintained directory is not a complete list of every settlement and may contain errors. A directory option establishes a consistent spelling; it does not verify an event's venue or its location. No event or wallet data is included.

## Rebuild

From the repository root, run `node scripts/build-places.mjs` with Node 22 or later. The script downloads only pinned public source files, verifies their hashes, applies the documented transformations and rewrites these assets deterministically. Run `node scripts/build-places.mjs --check` to verify the shipped files, complete archive, license and generator hash offline. No package installation, API key or runtime external service is required.

Compact country format: `{version: 1, countryCode, dataVersion, regions: string[], cities: [name, regionIndices: number[], nativeAliases: string[]][]}`. Name values are the canonical city strings; region indices and native aliases are search-only metadata.
