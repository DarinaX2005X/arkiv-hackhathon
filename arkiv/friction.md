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
