# Building with Arkiv

This report records observed behavior and reproducible tests. Unverified claims are not evidence of successful transactions.

## Environment and start

- Date: 9 October 2026, Asia/Qyzylorda.
- OS: Windows, PowerShell.
- Node: 22.13.0. npm: 10.9.2. pnpm available: 10.32.1.
- Network target: Tiramisu, chain ID 7738577.
- Official guidance downloaded from Arkiv-Network/global-tour-stop-pre-devcon before concept selection.
- Official `arkiv` and `arkiv-first-write` skills installed from Arkiv-Network/skills into the user's Codex skills directory and read directly.
- No existing signer was configured at task start. A dedicated test signer was created locally and the first synthetic write was confirmed at 2026-10-09T13:19:10Z.

## Initial version resolution

Surface: npm registry and official Arkiv skills.

Expected: the supported 0.8.x SDK is available and matches current examples.

Observed: `npm view @arkiv-network/sdk@0.8 version` reports 0.8.0 and 0.8.1. The official skills declare the checked range `>=0.8.1 <0.9` and use 0.8.1. The bootstrap pins 0.8.1 for reproducibility; installed declarations and real RPC behavior are checked next.

Reproduce: run the version command above, then compare `node_modules/@arkiv-network/sdk/package.json` and installed declarations with the official first-write skill.

Outcome: version selection verified. This is a successful setup observation, not a reported SDK defect.

## Read-only network probe

Surface: TypeScript SDK 0.8.1, viem 2.57.4, public Tiramisu JSON-RPC.

Reproduce: `node scripts/probe-arkiv.mjs`. The probe limits its method set to reads, caps requests, never reads a key and never fetches unrelated payloads. Observed runs at 2026-10-09T12:46:16Z and 12:47:22Z exited successfully. The latter used snapshot block 350152. Future runs use a fresh block and may observe different public metadata.

Expected: chain 7738577, a consistent typed scoped query, complete cursor semantics and meaningful provider errors.

Observed: chain ID matched; block duration was 2 seconds in this response; project-scoped SDK query and raw filtered count both returned zero for the probe namespace. Two one-item cursor pages remained pinned to one block. Public metadata samples belong to unrelated authors and are **not project write evidence**. The probe reports that the bounded sample remains incomplete.

### Exported inequality predicate rejected by the node

Expected: an exported SDK predicate can be used or fails with an actionable original message.

Actual: `ne('entity_type', 'probe')` renders `entity_type != str('probe')`, but the node rejects it with code `-32002`: inequality is not supported; use `NOT` over equality. The viem/SDK wrapper's generic resource-unavailable text is less informative. The script retains the expected rejection as a finding, not a failed network check.

Impact: application reads will use documented supported predicates and preserve useful sanitized node error context. A complement also matches records missing that attribute, so namespace/type/creator scopes remain necessary.

Suggested improvement: align the builder's advertised operators with the current node dialect and surface the node diagnostic at the primary error boundary.

### Metadata filter differs between SDK and raw RPC

Expected: a documented creation-block range is usable consistently through the builder and raw API.

Actual: current raw RPC accepts a bounded `$createdAt` u64 range; SDK 0.8.1's expression validator rejects this metadata name. This is verified by the probe and installed source. Store explicit typed application time when the builder needs it; do not confuse timestamps with block numbers.

### Readonly is not undeletable

Surface: installed `src/entity/flags.ts` and official native mutation documentation. This is a source/documentation finding, **not a live deletion test**.

Expected risk during design: a reader might interpret readonly plus permissionless Lifetime Extension as preservation against the publisher.

Actual contract: readonly fixes payload/attributes, while the current owner may still delete, transfer or extend the entity. Permissionless extension only adds permission to extend. There is no documented deletion-lock flag. We rejected a preservation-only product claim rather than promising a guarantee the protocol cannot provide.

Suggested improvement: make the remaining owner powers prominent beside the flag examples.

## Local signer preparation

`node scripts/create-demo-wallet.mjs` creates a dedicated local Tiramisu test wallet without sending transactions and only prints its public address. `.local/` is Git-ignored. Public demo address: `0x6267AB770266dA229130a2a75a52A9d578Fb0A5b`.

Faucet authentication and CAPTCHA required a manual user action. The user confirmed delivery, and a read at 2026-10-09T13:05:52Z verified 10 test GLM. No real funds were requested or used.

## First write, confirmation and read-back

Surface: SDK 0.8.1 `createEntity`, a dedicated local testnet signer, Tiramisu chain 7738577. Reproduction helper: `scripts/first-write.mjs`; guard tests: `node --test tests/first-write.test.mjs` (11 passed). The helper defaults to estimate/reconciliation and requires `--broadcast` for its single frozen synthetic operation.

Expected: estimate the exact SDK serialization without signing or sending; cap aggregate spend at 0.1 test GLM; persist send identity before network side effects; verify successful creation using the receipt plus creator-scoped, typed queries.

Observed: the guarded estimate returned 102698 gas. Admission used gas limit 123238. Transaction `0xd9a9eb50a203afc13c5a28df1707eca01c66fab19837eacb91c72e11c22b2ba3` succeeded at block 351105. Entity `0xfadef279e9b79b91409a85ba941aa5b03e7f7e48ee3cab28e97c0d3fa8d25050` matched the predicted key, immutable creator, initial owner, exact payload, typed attributes, creation flags and 30-day lifetime. Both the key query and creator-scoped seed query matched at the receipt block; the latter also matched at block 351106.

Actual gas used: 101712. Actual total fee and observed account balance delta: 0.000101712000203424 test GLM. Public evidence is stored in [evidence/bootstrap.json](evidence/bootstrap.json); keys and signed bytes remain in Git-ignored local custody. This bootstrap entity demonstrates SDK behavior, not final product functionality.

Elapsed from the task's practical setup start at approximately 12:39 UTC to confirmed read-back at 13:19 UTC: approximately 40 minutes, including parallel research and a manual faucet step. Do not interpret this as SDK installation or transaction latency alone.

Observed friction: the SDK's ergonomic mutation method also performs preparation, signing and sending, so an estimate-only helper needs a read-method allowlist, a signing guard, and interception of `eth_estimateGas`. The first-write skill provides this pattern. A first-class public prepare/estimate API returning the exact mutation calldata and fee cap would make safe first-use tooling simpler. No write failure is claimed: the bounded first send succeeded.

## Native consume-and-replace experiment

Surface: SDK0.8.1 executeBatch and official Tiramisu RPC. Observed9October2026; helper `scripts/probe-atomic-transition.mjs`, guards `tests/atomic-transition.test.mjs`. The helper admits only one frozen phase per explicit --broadcast invocation; default never signs or sends. Both phases combined have a0.003testGLM cap inside the overall0.1testGLM ceiling.

Expected: create readonly A; atomically create B and delete exact A; a stale create C/delete A estimate must decode the exact EntityNotFound(A) custom error. A generic RPC failure cannot count as passing evidence.

Observed: A creation succeeded at block352006, tx `0x0170cf0c6534e5b1bdaf470a8acc119f45949629283cd751e332f668f84069fd`. B creation/A deletion succeeded at block352065, tx `0x80e46f7b11e8e413f75a696484524b976f95bb4da695816ed56cd6737268925a`. A stale estimate returned selector0x66a89f2a with the exact deleted A key. The complete creator-scoped query at block352164 contained only the exact B payload and flags; no A or C. Actual probe fee0.000224464000448928testGLM; aggregate including bootstrap0.000326176000652352testGLM. Guard suite19/19 passed.

Evidence: [atomic-transition.json](evidence/atomic-transition.json). No paid stale transaction was sent. A mined failed-batch rollback was NOT tested; all-or-none execution is the official protocol guarantee. This supports a same-owner current-book transition precondition, not a native patch CAS, resource truth or atomic agreement across multiple owners. Readonly A was in fact deleted in this experiment, extending the earlier source-only finding with a live observation.

Suggested documentation improvement: show a complete immutable current-state replacement example, explain the exact stale predecessor error and separate this pattern from multi-owner locking. The API exposed the necessary primitives successfully; no SDK mutation failure is claimed.

## Public adapter and independent verifier

The Partfolk reader/writer uses SDK 0.8.1 with viem 2.57.4. The injected-wallet port, operation journal, scoped reader, and receipt verifier have been exercised with real SDK serialization against deterministic fake JSON-RPC responses. These are unit/contract checks, not additional live writes. UI and browser behavior remain user-owned verification.

Observed in installed source and reproduced with a fake provider: a viem send path may try `wallet_sendTransaction` after `eth_sendTransaction`. The port guards both methods and permits at most one forwarded request after recording admission. A generic lost response must not trigger a fallback resend. A fake-provider test verifies this guard and immediate hash checkpointing. This is defensive integration behavior, not a claim of a duplicated real transaction.

Observed in SDK mutation behavior: the ergonomic mutation action couples sending to receipt processing. The wallet boundary captures the provider hash and stops that internal wait so independent official-RPC verification owns the result. Its explicit receipt wait disables replacement following (`checkReplacement:false`); a different transaction must not silently become success for a frozen application intent.

Fault tests exposed and repaired verifier omissions around per-log transaction/block provenance, removed logs, duplicate created keys, and inconsistent block-number headers. The final verifier compares each event to its receipt and independently fetches the canonical header. These failures were deliberately constructed fixtures, not observed faults of the Tiramisu node.

A later blind review added mined-revert fixtures for a two-transaction project initialization and proposal/request fan-out. A failed later transaction must not erase successful earlier phases. The adapter now reports partial reverts separately, retains prior confirmed keys, and allows an explicit resume to allocate a new attempt only for the proven failed phase after fresh validation. The old reverted transaction is retained and never resent. These are deterministic fault-injection tests, not paid failed transactions on Tiramisu.

Read behavior is conservative: one block for every page/reference; one bounded cursor restart without mixing accumulated pages; scoped conflict detection; exact creator/owner/readonly validation; no latest-revision selection; history gaps separate from current agreement confidence. Reader tests cover natural expiry, incomplete pages, scope poisoning, activation replay, missing historical proposals, and terminal closure.

Read-only CLI observation on 9 October 2026: direct invocation `node node_modules/tsx/dist/cli.mjs src/cli/verify.ts --inspect-capability atomic --json` successfully read the historical B probe at block 353367 and explicitly returned `productProof:false`. On this Windows shell, the installed npm PowerShell wrapper dropped double-dash option arguments for an attempted `npm run verify -- --inspect-capability ...` invocation. The direct Node invocation avoids that wrapper. This CLI capability inspection is not a Partfolk project validation.

## Anonymous query quota and private access-key reads

Observed on **11 October 2026** against the official Tiramisu RPC. Five sequential read-only diagnostic calls distinguished basic RPC reachability from query availability: `eth_chainId` and block reads returned HTTP `200`, while an exact-key `arkiv_query` returned HTTP `429` with `ANON_COST_LIMITED`.

The response dated **13:51:59 UTC** reported a cost limit of **10,000**, **0 remaining**, a reset interval of **2,818 seconds**, and `Retry-After: 2818`. That indicated **14:38:57 UTC** as the retry time; it was not a guarantee that the next request would succeed. This was an observed anonymous query-budget limit, not evidence of a chain-wide outage or mutation failure.

The interrupted product proof retained all **25 confirmed transactions** and their journals. Its next `material-willow` operation remained **unsent**. The failed query was not interpreted as an empty scope, and no replacement records were inferred or authored from it.

A user-supplied access key was then tested through a private **Node-only** transport using the `X-API-KEY` header. Two read-only checks—chain identity and the existing project root—succeeded. The key was kept in a local file and never included in the browser bundle. The browser reader remains anonymous. Arkiv documents access keys, their network-specific quotas and the supported HTTP header in its [access-key guide](https://docs.arkiv.network/start-here/access-keys/); Partfolk's [operations guide](../docs/operations.md#runtime-and-network-configuration) describes the optional local setup.

Developer experience observation: preserving the quota error code, remaining budget and retry guidance makes this condition actionable without treating missing data as success. Read-cost estimates or clearer budget diagnostics alongside scoped-query examples would help developers plan multi-record verification workloads. The successful authenticated reads establish that this recovery path worked for these checks; they do not establish unlimited capacity or a completed product proof.
