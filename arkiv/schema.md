# Arkiv data contract

Status: Partfolk planning contract, 9 October 2026. The product is not implemented yet. Bootstrap and native transition feasibility evidence are actual network observations, clearly separated below.

Network: Tiramisu, chain ID 7738577. SDK: the official 0.8.x line, verified installed version recorded in `friction.md`.

All application data published during development is synthetic. Indexed attributes are public and use lowercase names. Numeric range fields require explicit typed attributes. Arkiv creation and expiration values are block numbers. Creator provenance does not establish real-world identity or truth. No personal data, credentials or signing keys are permitted.

Before the first product write, the reviewed application validator will freeze payload fields and exact reproducible queries. Proposed namespace: `partfolk`, protocol `partfolk/1`; all five types use readonly payload/attributes and owner-controlled lifetime.

| Planned entity | Authority / filters | Purpose / lifetime |
| --- | --- | --- |
| `project_root` | Immutable creator; entity key is project identity | Stable protocol identity; 180 days for demo |
| `project_state` | Root creator; `project_key` typed key | Editable project recipe, active proposal, lifecycle; 90 days |
| `publisher_root` | Immutable creator; entity key is publisher identity | Stable authority/kind; 180 days |
| `book_state` | Publisher-root creator; `book_key` typed key | Offers/resources, cross-project grants, separate execution assertions; 90 days or longer than every grant |
| `proposal` | Project-root creator; `project_key`, `proposal_hash`, `requirements_hash` | Exact immutable agreed package, 180 days |

Common indexed attributes: `project` str, `entity_type` str, `schema_version` i32, `created_at` u64, and `operation_id` str for reconciliation. Roots contain stable identity only; mutable labels/capacities live in state/books. Current-state uniqueness is validated by complete creator-scoped queries at one block, not guaranteed by an index. Missing heads are unavailable; multiple heads are conflicts, never latest-wins. A replacement creates its readonly successor and deletes its exact predecessor atomically. Consent is bound to canonical material terms; every material revision requires fresh approval from all required owners. Execution assertions survive grant withdrawal. Cancellation cannot erase another owner's grant. These are application rules, not onchain execution of the constraint solver or a multi-owner lock.

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

## Atomic feasibility records

These use a separate historical feasibility namespace `convene_atomic_feasibility_v1`, not the Partfolk application namespace. Attributes: project str; entity_type str=`atomic_probe_state`; probe_id str=`20261009_sdk081_6267ab77`; state str=A/B/C; created_at u64. Payload: protocol=`convene-atomic-probe/1`, probeId, synthetic=true, state, previousState=null forA or A forB/C. All states are readonly, permissionlessExtension=false, seven-day lifetime, same bootstrap creator. Only A and B were broadcast. B replaces A using native create+delete; C exists only as a rejected estimate.

Exact scope verified at block352164:

```text
project = str('convene_atomic_feasibility_v1') AND entity_type = str('atomic_probe_state') AND probe_id = str('20261009_sdk081_6267ab77') AND $creator = addr(0x6267AB770266dA229130a2a75a52A9d578Fb0A5b)
```

Result: one B entity `0x5f29b503534f990b2dbbbe81f027c121379ebf1a3488fbac964880f547ec12f0`. See [atomic evidence](evidence/atomic-transition.json) for exact receipts, deleted A, predicted unsent C, decoded error and limits. No claim of a tested mined failed transaction.
