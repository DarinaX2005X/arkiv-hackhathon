# Arkiv data contract

Status: implemented Partfolk adapter contract, 9 October 2026. The TypeScript payload validator, direct SDK reader, journalled injected-wallet writer, and independent CLI implement this contract. Bootstrap and native transition feasibility evidence are actual network observations, clearly separated below. These earlier probes alone are not evidence of a complete public Partfolk workflow.

Network: Tiramisu, chain ID 7738577. SDK: the official 0.8.x line, verified installed version recorded in `friction.md`.

All application data published during development is synthetic. Indexed attributes are public and use lowercase names. Numeric range fields require explicit typed attributes. Arkiv creation and expiration values are block numbers. Creator provenance does not establish real-world identity or truth. No personal data, credentials or signing keys are permitted.

Application namespace: `partfolk`, protocol `partfolk/1`, schema version 1. All seven types use readonly payload/attributes and owner-controlled lifetime. The public boundary rejects local IDs, foreign chains, missing flags, transferred ownership, hash mismatches, and any indexed projection inconsistent with the payload. Exact schemas are in `src/domain/types.ts` and `src/domain/validation.ts`; typed projections are in `src/data/arkiv/envelope.ts`.

| Entity | Authority / filters | Purpose / lifetime |
| --- | --- | --- |
| `project_root` | Immutable creator; entity key is project identity | Stable protocol identity; 180 days for demo |
| `project_state` | Root creator; `project_key` typed key | Editable recipe, admitted publisher roots, lifecycle, completed work, completion; explicit lifetime |
| `publisher_root` | Immutable creator; entity key is publisher identity | Stable authority/kind; 180 days |
| `book_state` | Publisher-root creator; `book_key` typed key | Resources, offers, separate decisions/grants, append-only recent attestations, independent custody holds; nominal lifetime at least the larger of the grant horizon plus 60 seconds and the declared retention period (minimum 90 days) |
| `proposal` | Project-root creator; `project_key`, `proposal_hash`, `requirements_hash` | Exact immutable agreed package, 180 days |
| `plan_activation` | Project-root creator; `project_key`, `proposal_key` | One exact active proposal and hash, predecessor activation keys; every material promotion consumes all reviewed heads |
| `project_link` | Publisher creator for offer links; project creator for request links; `project_key`, `publisher_key`, `link_kind`, request-only `activation_key` | Untrusted discovery hint; never admission, agreement, or resource authority |

Common indexed attributes on every entity, including roots: `project` str, `entity_type` str, `schema_version` i32, `created_at` u64, and `operation_id` str for reconciliation. Entity-reference attributes use `key`; content hashes use `bytes32`. Content type is `application/json`. Roots contain stable identity only; mutable labels/capacities live in state/books. Current-state uniqueness is validated by creator-scoped queries at one block, not guaranteed by an index. Project-state and activation readers stop after detecting two heads. Book readers enumerate every head within the same bounded complete-query policy so owners can review the entire conflict. Mutations enumerate every head before comparing the full reviewed predecessor set. Missing heads are unavailable; multiple heads are conflicts, never latest-wins. A replacement creates its readonly successor and deletes exact predecessors in one native batch. Consent binds the exact project, activation, proposal key, and canonical hash. Every material revision requires fresh approval from all required owners. Execution assertions survive grant withdrawal. Cancellation consumes current project/activation heads but cannot erase another owner's grant or physical custody claim. These are application rules, not onchain execution of the constraint solver or a multi-owner lock.

`PlanDocument.predecessor` carries the previous exact source reference. A fresh reader walks proposal keys in order, checking creator, project, canonical hashes, cycles, and a 32-proposal bound. Missing old evidence is an explicit history gap; it does not invalidate an otherwise complete current agreement. Restoring old terms creates a new proposal whose predecessor is the current agreement. Reopening retains the closed source as the lineage anchor; copying a recipe to a new project starts with null predecessor.

For a missing publisher book under a still-live owned root, recovery must explicitly acknowledge missing state and start with empty resources, offers, decisions, grants, attestations, and custody holds. Availability is declared again afterward. Cached approvals are never replayed. External evidence of unresolved custody remains evidence of that physical obligation. Competing initializations/recoveries can produce conflicts because absence has no native compare-and-swap token.

## Reproducible application reads

Pin one canonical block `B` before reading. All pages, exact key references, heads, and publisher books use `atBlock(B)`. Recheck the block hash after the read. Application time is the canonical block timestamp; `expiresAt` is separately checked as a block height. A nominal lifetime conversion does not guarantee a future UTC date.

Representative complete current-book scope (replace the public root and immutable creator):

```ts
client.select({ key: true, creator: true, owner: true, createdAt: true,
  expiresAt: true, creationFlags: true, contentType: true, payload: true, attributes: true })
  .where([eq('project', 'partfolk'), eq('entity_type', 'book_state'),
    eq('book_key', key(publisherRoot))])
  .createdBy(publisherCreator).atBlock(B).limit(100).fetch();
```

Continue `next()` while the cursor reports more rows. Do not add a `schema_version` filter to authored-head discovery: malformed authored heads must remain visible to the validator. Use `project_key` and the project root creator for `project_state` and `plan_activation`. Exact `$key` queries deliberately omit namespace/creator filters so contradictory metadata cannot be hidden. Offer discovery uses `project_key` + `link_kind='offer'`; request discovery uses `publisher_key` + `link_kind='request'`. The reader authenticates the author against the referenced root before returning a trusted link DTO.

Default read limits: 160 pages, 4,000 entities, 50 publisher books, 100 rows per page, one cursor restart at the same block. Failures and exceeded bounds yield incomplete/unverified results, never a partial authoritative list. Views can refresh every 15 seconds; confidence expires after 60 seconds.

The CLI starts its own official-RPC reader and computes readiness independently of the application process:

```text
node node_modules/tsx/dist/cli.mjs src/cli/verify.ts <project-root> --json
node node_modules/tsx/dist/cli.mjs src/cli/verify.ts <project-root> --export evidence.json
node node_modules/tsx/dist/cli.mjs src/cli/verify.ts --inspect-capability atomic --json
```

The export is a dated snapshot, never an imported authorization. Exports refuse to overwrite an existing file. The explicit capability option labels older probe records `productProof:false`.

## Write admission and reconciliation

`createOperationIntent` freezes command input, authority, expected heads, and a content hash before a wallet request. Each native step receives a stable operation ID; proposal/activation/request fan-out and root/initial-state creation retain each phase separately. An owner book replacement uses one create plus deletes for every reviewed current book head. Terminal closure additionally consumes every current activation in the same transaction.

The injected EOA port estimates actual SDK serialization and persists an admission checkpoint before forwarding a single wallet send. It captures the returned hash immediately. Account/chain changes invalidate preparation. Browser journals use same-origin locks and explicit storage failures. Clients may choose separate journal storage keys and a shared lock key for active submission serialization; unresolved records remain local to each journal. They contain public operation data, never signing secrets.

Success requires the official RPC transaction and canonical receipt to match the frozen sender, native target, calldata, value, chain, and any explicit fee parameters. Native event identities, metadata, flags, unique created keys, and ordering must match. Payloads/projections are read back at the receipt block; consumed keys must be absent there. A lost response is recovered only by the same creator-scoped operation ID with exact payloads and one matching creation transaction. Zero matches remain uncertain. A mined revert is terminal for that transaction, not a not-sent retry. If an earlier phase already succeeded, reconciliation reports `partial_reverted` and retains the frozen overall intent and confirmed keys. An explicit resume may create a new attempt ID for the proven reverted phase after canonical revert verification and fresh preflight; it never republishes the confirmed root, proposal, or activation. Failed attempts remain in the journal. A first-phase or single-transaction revert stays terminal for the overall intent.

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
