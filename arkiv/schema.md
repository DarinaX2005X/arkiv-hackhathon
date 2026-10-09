# Arkiv data contract

Status: bootstrap, 9 October 2026. The concept and entity contract are being selected after live SDK capability checks.

Network: Tiramisu, chain ID 7738577. SDK: the official 0.8.x line, verified installed version recorded in `friction.md`.

All application data published during development is synthetic. Indexed attributes are public and use lowercase names. Numeric range fields require explicit typed attributes. Arkiv creation and expiration values are block numbers. Creator provenance does not establish real-world identity or truth. No personal data, credentials or signing keys are permitted.

The final contract will specify entity types, queryable attributes, payloads, creation flags, expiration per type, writer/owner policy and the exact reproducible queries before the first product write.

## Capability bootstrap entity

This is a synthetic SDK check, not the product's final data model. Its actual receipt and query verification are in [evidence/bootstrap.json](evidence/bootstrap.json).

| Field | Type | Value / purpose |
| --- | --- | --- |
| `project` | str | `arkiv_hackathon_capability_probe_v1` |
| `entity_type` | str | `bootstrap` |
| `seed_id` | str | `sdk_081_v1`, stable deduplication identity |
| `created_at` | u64 | Explicit UTC epoch milliseconds frozen before sending |

Content type: `application/json`. Payload: `{ "purpose": "Verify Arkiv create, read-back and typed query", "sdk": "0.8.1", "synthetic": true }`.

Creator and initial owner: `0x6267AB770266dA229130a2a75a52A9d578Fb0A5b`. Creation flags: readonly true, permissionlessExtension false. Requested lifetime: 30 days (1,296,000 blocks). Confirmed creation block: 351105; expiration block: 1647105. There is no promise of permanent retention or undeletability.

Exact query, verified at block 351105 and current block 351106 on 9 October 2026:

```text
project = str('arkiv_hackathon_capability_probe_v1') AND entity_type = str('bootstrap') AND seed_id = str('sdk_081_v1') AND $creator = addr(0x6267AB770266dA229130a2a75a52A9d578Fb0A5b)
```

`node scripts/first-write.mjs` estimates only before admission and reconciles after a send; it never broadcasts by default. `--broadcast` admits this one frozen operation with a cumulative ceiling of 0.1 test GLM. It durably records the signed transaction hash before forwarding, refuses a replacement after an ambiguous send, then checks the receipt, event, creator, payload, typed attributes, creation flags and scoped query.
