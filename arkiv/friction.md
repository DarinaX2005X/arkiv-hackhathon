# Building with Arkiv

Partfolk uses Arkiv as the public source of contributor agreements and event registrations. This report separates SDK/RPC friction, protocol design lessons, application defects found with local fixtures, and confirmed testnet evidence.

## Environment and reproduction

- SDK: `@arkiv-network/sdk 0.8.1`; viem: `2.57.4`, pinned in [package.json](../package.json).
- Runtime used: Node.js `22.13.0`, npm `10.9.2`, Windows / PowerShell. The project requires Node.js `>=22.12.0`.
- Network: Tiramisu, chain ID `7738577`; official public JSON-RPC. The deployed node software version was not recorded.
- Initial network observations: 9 October 2026. Agreement and event evidence: 11 October 2026. Application fixes and regression checks: 19 October 2026, Asia/Qyzylorda.
- Local regression runner: Vitest `5.0.3` in the Node environment. These tests use fake RPC/wallet providers or callback fixtures; they do not launch a browser or send public transactions.

Run commands from the repository root after `npm ci`. Direct Node invocations avoid a PowerShell npm-wrapper issue observed during development, where `npm run verify -- ...` lost forwarded option arguments.

Live probes use current provider behavior, which may differ from the dated observations. A quota failure cannot confirm an unrelated query finding. Commands for fixed application issues verify the regression cases on the current code; they do not claim that the old failure still occurs.

## SDK and RPC friction

### 1. Exported inequality predicate rejected by the node

**Versions and evidence:** SDK 0.8.1, viem 2.57.4, public Tiramisu RPC; live read on 9 October 2026.

**Expected:** an exported SDK predicate is accepted by the node, or the SDK reports the unsupported operation with the original diagnostic.

**Actual:** `ne('entity_type', 'probe')` renders `entity_type != str('probe')`. The node rejected it with code `-32002` and instructed the caller to use `NOT` over equality. The wrapper's generic resource-unavailable message was less useful than the node diagnostic.

**Reproduce:**

1. Run the bounded, read-only probe:
   ```bash
   node scripts/probe-arkiv.mjs
   ```
2. Inspect `checks.unsupportedNotEqualObservation`. The recorded behavior is `nodeAccepted: false`.
3. Inspect the corresponding `requests[].rpcError` for the node code and message. The script treats this expected rejection as a finding, not a failed network check.

**Resolution:** use supported predicates, including `not(eq(...))` where appropriate. Keep namespace/type/creator scoping: a complement also matches records missing the attribute.

**Suggested improvement:** align the builder's advertised operators with the node dialect and preserve the actionable node diagnostic at the main error boundary. [Probe source](../scripts/probe-arkiv.mjs)

### 2. Creation-block filtering differs between SDK and raw RPC

**Versions and evidence:** SDK 0.8.1 expression validator and public Tiramisu RPC; source inspection and live raw query on 9 October 2026.

**Expected:** the documented creation-block range can be expressed consistently through the SDK builder and raw RPC.

**Actual:** raw RPC accepted a bounded `$createdAt` range using `u64`. SDK 0.8.1 rejected that field with `InvalidPredicateError`, stating that it cannot be filtered on.

**Reproduce:**

1. Run this SDK-only check; no network connection is needed:
   ```bash
   node --input-type=module -e 'import { u64 } from "@arkiv-network/sdk/attr"; import { gte } from "@arkiv-network/sdk/query"; try { gte("$createdAt", u64(350152)); console.log("accepted"); } catch (error) { console.log(error.name + ": " + error.message); }'
   ```
   Expect `InvalidPredicateError`.
2. Run `node scripts/probe-arkiv.mjs` without `--creator`. Inspect `checks.recentMetadataSample`: it sends the raw bounded range, selects metadata only and limits the result to one entity. A successful empty result also demonstrates that the node accepted the query.
3. Compare with `node_modules/@arkiv-network/sdk/src/query/expression.ts`. The probe's raw query and this separate SDK check establish the two sides of the mismatch.

**Resolution:** Partfolk stores explicit typed application timestamps where builder range queries are needed. Creation block numbers and application timestamps remain distinct.

**Suggested improvement:** document and reconcile the builder/raw-RPC difference. [Probe source](../scripts/probe-arkiv.mjs) · [Typed application attributes](../src/data/arkiv/envelope.ts)

### 3. Mutation helpers combine preparation, sending and receipt processing

**Versions and evidence:** SDK 0.8.1 and viem 2.57.4; installed source, real SDK serialization with fake providers, and the successful first write.

**Expected:** inspect exact mutation calldata and fee bounds before signing, record send identity durably, then verify confirmation independently.

**Actual:** the ergonomic mutation action also prepares, signs, sends and processes the receipt. Estimate-only tooling needed a read-method allowlist, a signing guard and interception of `eth_estimateGas`. The injected-wallet path also needed to checkpoint the returned hash before receipt handling. A viem fallback from `eth_sendTransaction` to `wallet_sendTransaction` required guarding both methods against a second forwarded send after an uncertain response. No duplicated live transaction was observed.

**Reproduce:**

```bash
node --test tests/first-write.test.mjs
node node_modules/vitest/vitest.mjs run src/data/__tests__/wallet-operations.test.ts
```

The first suite exercises real SDK create serialization with a signer that must never be called during estimation. The second checks admission/hash checkpoint order, suppression of the internal SDK receipt wait, wallet-method fallback and recovery after a lost response. Both use local providers.

**Resolution:** capture the exact unsigned request, journal admission before forwarding, persist the provider hash immediately, and reconcile through official-RPC receipt verification. Explicit receipt waits disable replacement following with `checkReplacement: false`. An unresolved outcome does not authorize another send.

**Suggested improvement:** expose a public prepare/estimate API returning the exact mutation request and fee bounds separately from submission and waiting. [Wallet gateway](../src/data/wallet/gateway.ts) · [Operation controller](../src/data/operations/controller.ts) · [Reconciliation](../src/data/operations/reconciliation.ts)

### 4. Aggregate queries can hit quota while chain reads still work

**Versions and evidence:** SDK 0.8.1, viem 2.57.4 and public Tiramisu RPC; observed HTTP `429` with `ANON_COST_LIMITED` during aggregate verification.

**Expected:** complete entity data or an actionable limit error that distinguishes unavailable evidence from an empty result.

**Actual:** chain/block reads succeeded while `arkiv_query` was rate-limited. A working `eth_chainId` response therefore did not establish that an agreement could be verified.

**Reproduce:**

1. Run `node scripts/probe-arkiv.mjs` once and compare the recorded HTTP status of chain reads with query requests. The probe records quota headers and stops further network requests after a 429.
2. The live failure depends on the provider's current quota state; a successful run does not reproduce it. Do not generate traffic just to exhaust the quota.
3. Reproduce the application's handling deterministically:
   ```bash
   node node_modules/vitest/vitest.mjs run src/data/arkiv/read-policy.test.ts src/server/arkiv-read.test.ts
   ```
   Quota fixtures check cooldowns, `Retry-After`, bounded scheduling and recovery after the recorded delay.

**Resolution:** incomplete reads stay unverified. Honor cooldown information, then retry a bounded complete read. This finding does not establish a chain-wide outage or mutation failure.

**Suggested improvement:** make quota classification and retry guidance available through SDK errors without requiring callers to inspect transport internals. [Read policy](../src/data/arkiv/read-policy.ts) · [Hosted read service](../src/server/arkiv-read.ts)

## Protocol design lesson

### 5. Readonly records remain deletable by their owner

**Versions and evidence:** SDK 0.8.1 creation flags and native `executeBatch`; source inspection followed by a live consume-and-replace experiment on Tiramisu, 9 October 2026.

**Expected during design:** readonly data plus permissionless Lifetime Extension might preserve evidence even if its publisher later wanted to remove it.

**Actual:** readonly protects payload and attributes. The current owner can still delete, transfer or extend the entity; permissionless extension only broadens who can extend it. The initial source finding was subsequently confirmed by deleting readonly A while creating readonly B in one native batch. This is a protocol property, not an SDK defect.

**Reproduce and inspect the evidence:**

1. Open [atomic-transition.json](evidence/atomic-transition.json). A was created at block `352006`; B creation and A deletion succeeded together at `352065`. A stale create-C/delete-A estimate decoded `EntityNotFound(A)` with selector `0x66a89f2a`. The complete scoped read at `352164` contained only B.
2. Run the local guard and serialization checks:
   ```bash
   node --test tests/atomic-transition.test.mjs
   ```
   The tests require the exact missing-A error; a generic RPC failure or a different missing key cannot pass.
3. While the probe record remains available, inspect B independently:
   ```bash
   node node_modules/tsx/dist/cli.mjs src/cli/verify.ts --inspect-capability atomic --json
   ```
   The output explicitly reports `productProof: false`. This reads an existing feasibility record; it does not repeat the writes.

**Resolution:** Partfolk validates the availability of required evidence at every read. It also uses create-successor/delete-exact-predecessor batches for state replacement under one owner. This is not an atomic agreement across multiple owners or a guarantee of physical resource availability.

No paid stale transaction was sent, and mined failed-batch rollback was not tested. All-or-none execution is the protocol guarantee; the live experiment establishes successful replacement and rejection of the stale estimate.

**Suggested improvement:** explain remaining owner powers beside readonly examples and include a complete consume-and-replace example with its stale-predecessor error. [Probe implementation](../scripts/probe-atomic-transition.mjs)

## Partfolk integration issues

The following application fixes were introduced in [492f090](https://github.com/DarinaX2005X/arkiv-hackhathon/commit/492f090); its parent `dc61f29` contains the earlier implementation. The commands run the committed regression fixtures against the fixed code. They are not reports of Arkiv consensus failures.

### 6. Historical attendance checks amplified HTTP requests

**Versions and evidence:** Partfolk before/fixed at `492f090`, SDK 0.8.1, viem 2.57.4, Vitest 5.0.3; deterministic reader and hosted-service fixtures.

**Expected:** a supported roster of 512 attendees fits the hosted service's bounded read policy.

**Actual:** with each request in a distinct creation block, two historical-header passes made 1,024 separate HTTP requests, plus ordinary snapshot reads. The direct fixture completed, but the hosted path exhausted its HTTP burst allowance.

**Reproduce:**

```bash
node node_modules/vitest/vitest.mjs run src/data/events/reader.test.ts -t "loads 512 distinct historical requests"
```

Both the direct and hosted cases construct 512 distinct inclusion blocks. On the fixed code, each roster load uses 32 batches of 32 historical headers, retains every required header check and completes the full roster. Ordinary snapshot headers are checked separately.

**Resolution:** group exact historical-header calls into JSON-RPC batches of at most 32. This reduces HTTP requests, not the number of RPC operations. Snapshot rechecks, deadline timestamps, response identity validation and the 60-second freshness requirement remain. Separate per-IP and per-instance header-unit budgets still bound upstream work.

A separate bounded live read confirmed that the configured provider accepted a two-header JSON-RPC batch. The 512-attendee comparison is a local fixture, not a live 512-person event. [Reader fixture](../src/data/events/reader.test.ts) · [Service limits](../docs/operations.md)

### 7. Sequential and redundant reads delayed wallet interaction

**Versions and evidence:** Partfolk before/fixed at `492f090`, SDK 0.8.1, viem 2.57.4, Vitest 5.0.3; controlled request gates and registration callback fixtures.

**Expected:** independent reads can overlap, and a complete, verified, fresh displayed snapshot need not be fetched again before the writer performs its own checks.

**Actual:** a representative project read serialized ten requests into ten network stages. Registration also added an interface refresh before the writer's existing validations.

**Reproduce:**

```bash
node node_modules/vitest/vitest.mjs run src/data/__tests__/arkiv-reader.test.ts src/features/attendance/RegistrationPanel.test.ts
```

The reader's `overlaps only independent reads` fixture gates each request: chain/head, state/activation and proposal/publisher reads overlap, while dependent reads and the final canonical-header check wait. It still makes ten requests, arranged in seven stages. Registration fixtures expect `write → refresh` for a valid fresh snapshot and `refresh → write → refresh` when it needs refreshing. Changed account or terms still block the write.

**Resolution:** overlap independent reads, reserve the shared page budget for required current evidence before optional history, and reuse displayed evidence only while it remains complete, verified and fresh. Both writer validations and the read after confirmation remain.

These fixtures establish ordering and omitted redundant work. They do not establish a live latency percentage. [Reader tests](../src/data/__tests__/arkiv-reader.test.ts) · [Registration tests](../src/features/attendance/RegistrationPanel.test.ts)

### 8. Journal contention could hide a known pre-send failure

**Versions and evidence:** Partfolk before/fixed at `492f090`, Vitest 5.0.3; deterministic operation-controller fault injection. No live transaction failed in this test.

**Expected:** when preflight fails before a native operation starts, the journal records that no transaction was sent.

**Actual:** if another operation held the journal lock, recording the known pre-send failure could also fail. The retained attempt then appeared unresolved despite no send.

**Reproduce:**

```bash
node node_modules/vitest/vitest.mjs run src/data/__tests__/operation-attempts.test.ts
```

The contention fixture holds one operation inside preparation, fails another operation's preflight read, then releases the lock. Expect the original read error, `rejected-before-native` state, complete preflight no-send evidence and zero sends during that sequence. Additional cases cover contention at the preparation boundary, storage failures and recovery after reload.

**Resolution:** settlement waits for its lock and rechecks the exact attempt before recording evidence. Wallet submission admission remains fail-fast; waiting to settle the journal does not queue another send. Storage failures or contradictory evidence remain unverified, and previously confirmed steps are retained. [Operation-attempt tests](../src/data/__tests__/operation-attempts.test.ts) · [Controller](../src/data/operations/controller.ts)

## Evidence and setup notes

### Confirmed agreement and registration workflows

The [product proof](evidence/product-proof.json) contains 92 confirmed transactions and seven matching application/independent-CLI observations:

| Snapshot | Block | Agreement | Current approvals |
| --- | --- | --- | --- |
| P1 awaiting | 441275 | Awaiting approval | 0/7 |
| P1 ready | 442076 | Ready | 7/7 |
| P1 after withdrawal | 442152 | Changed | 6/7 |
| Repaired P2 awaiting | 442583 | Awaiting approval | 0/7 |
| P2 ready | 443753 | Ready | 7/7 |
| Restored P3 awaiting | 443916 | Awaiting approval | 0/7 |
| P3 ready | 444117 | Ready | 7/7 |

Reproduce the final dated state, then substitute another block from the table:

```bash
node node_modules/tsx/dist/cli.mjs src/cli/verify.ts 0xf4e900fa56b9989f196b53cee9a7ed2abb1bbc5acc9179e47e7b11e32c7887a7 --block 444117
```

Expect `ready`, 7/7 approvals and complete history within the verified P1 → P2 → P3 lineage. These are historical snapshots; current readiness can change as grants expire.

The [event evidence](evidence/test-events.json) records three published synthetic TEST EVENT releases, read at blocks `446077`, `446084` and `446092`. There are nine attendance records across seven wallets: the unlimited events had three and two going; the limited event had three admitted places and one waiter. The event run added 43 confirmed native transactions with zero transferred value and no additional funding transactions. Its cumulative budget includes the earlier proof: 135 confirmed transactions and accounted spend of `0.067061464022387640` test GLM against the `0.1` test GLM cap.

These are dated public records of synthetic agreements and registrations. They do not establish physical attendance, browser interaction or continuing anonymous RPC availability.

### Setup and first native writes

On 9 October 2026, `npm view @arkiv-network/sdk@0.8 version` returned 0.8.0 and 0.8.1. The project pinned 0.8.1 after checking official guidance and installed declarations. This was a successful setup observation.

A dedicated local test signer was funded with 10 test GLM after a manual faucet step. The first write was confirmed at `2026-10-09T13:19:10Z`, block `351105`. The estimate was 102,698 gas; actual gas was 101,712 and the fee was `0.000101712000203424` test GLM. Receipt and query read-back matched the predicted key, creator, owner, payload, typed attributes, flags and 30-day lifetime. [Bootstrap evidence](evidence/bootstrap.json) · [Guarded helper](../scripts/first-write.mjs)

The roughly 40 minutes from practical setup to read-back included research and the manual faucet step; it is not a transaction-latency measurement. The later atomic probe spent `0.000224464000448928` test GLM within its `0.003` cap. Bootstrap plus atomic probe spend was `0.000326176000652352` test GLM. Both helpers default to estimate/reconciliation; their guarded broadcast paths are separate from the read-only and local-test commands above.

### Additional local verification

Receipt and writer fixtures check per-log transaction/block provenance, removed logs, duplicate created keys, canonical headers, and partial reverts across multi-transaction operations:

```bash
node node_modules/vitest/vitest.mjs run src/data/__tests__/arkiv-verification.test.ts src/data/__tests__/arkiv-writer.test.ts
```

A failed later phase must retain successful earlier phases. A deliberate resume validates current state and allocates a new attempt only for the proven failed phase; the reverted transaction is retained rather than resent. These are constructed fault cases, not observed Tiramisu node faults or paid failed transactions. Visual and browser verification remains user-owned.
