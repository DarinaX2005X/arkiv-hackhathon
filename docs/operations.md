# Running and operating Partfolk

Partfolk is a static browser application with a separately built Partner Desk and a read-only command-line verifier. Public clients read Arkiv directly. There is no application server, account database, shared signing service, or required agent tooling.

This guide describes the checked-in implementation as of 9 October 2026. A production URL and a complete live Partfolk demonstration remain pending. The existing bootstrap and atomic-transition records demonstrate SDK capabilities; they are not a completed public project workflow.

## Install and run

Use Node.js **22.12.0 or newer** and npm. Run these commands from the repository directory containing [package.json](../package.json) and [package-lock.json](../package-lock.json):

On Windows PowerShell, use `npm.cmd` in place of `npm`, particularly for commands forwarding flags after `--`; the PowerShell npm wrapper can consume those flags. The commands below use the portable `npm` spelling.

```sh
npm ci
npm run dev
```

Studio is available at `http://127.0.0.1:5173/`. Start Partner Desk independently in another terminal:

```sh
npm run dev:desk
```

Desk is available at `http://127.0.0.1:5174/desk.html`. Its own entry point, runtime, browser storage namespace, and wallet connection do not require the Studio development server. Stop Studio to check that boundary; keep the Desk server running. The user performs browser and visual verification.

Reading public projects, editing local drafts, and synthetic local practice need no wallet. Local practice and local roles are simulations. They do not publish records or grant public consent.

### Checks and production artifacts

```sh
npm run check
```

This runs TypeScript checking, Vitest tests, bootstrap/atomic script tests, and both production builds. It does not broadcast transactions or perform browser testing. The equivalent direct runner is `node scripts/check-product.mjs`.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript validation. |
| `npm run test:unit` | Domain, repository, application, and client unit tests. |
| `npm run test:bootstrap` | Tests for the historical bootstrap and atomic probe scripts. |
| `npm run build` | Studio and bundled Desk entry points in `dist/`. |
| `npm run build:desk` | Independent Desk artifact in `dist-desk/`. |
| `npm run preview` | Serve `dist/` on `http://127.0.0.1:4173/`. |
| `npm run preview:desk` | Serve `dist-desk/` on `http://127.0.0.1:4174/desk.html`. |
| `npm run verify -- --help` | Show the read-only verifier's arguments. |

Build before running the corresponding preview command. All four development/preview ports are strict: an occupied port causes an error instead of silently choosing another. There is no `npm start` script. Vite preview serves a local build; production hosting should serve the generated static files over HTTPS.

The [Studio build configuration](../vite.config.ts) and [Desk build configuration](../vite.desk.config.ts) use relative asset URLs. Deploy the contents of `dist/`, or deploy `dist-desk/` separately with `/desk.html` as its entry point. Keep each HTML file and its generated assets together. Do not publish the source workspace, `.local/`, or signer journals as a static site. No provider-specific deployment command or production hosting target is configured yet.

## Runtime and network configuration

No `.env` file, API token, private-key environment variable, or `VITE_*` setting is required by the current application. The network settings are source configuration, not runtime environment overrides:

| Setting | Current value/source |
| --- | --- |
| Network | Arkiv Tiramisu testnet. |
| Chain ID | `7738577` (`0x7614d1`). |
| Public RPC | `https://rpc.tiramisu.db-chain.testnet.arkiv.network`. |
| Explorer | `https://tiramisu.explorer.arkiv.network`. |
| Native entity address | `0x4400000000000000000000000000000000000044`. |
| SDK | Locked `@arkiv-network/sdk` version `0.8.1`. |
| Reader configuration | [src/data/arkiv/client.ts](../src/data/arkiv/client.ts). |
| Wallet configuration | [src/data/wallet/gateway.ts](../src/data/wallet/gateway.ts). |

The reader allows only specific read RPC methods, uses no cached RPC responses, has a ten-second transport timeout, and disables transport retries. Tests can inject a request function; that injection is not an end-user environment setting. Changing the chain or RPC requires a reviewed source change and matching wallet, protocol, and validation settings.

Public reads pin related records to one block and require complete pagination. The reader defaults are 160 pages, 4,000 entities, 50 publishers, 100 records per page, and one cursor restart. Exceeding a bound or losing a page produces an incomplete/unverified result. It does not establish that no records exist. Studio project views and the contributor view refresh every 15 seconds and on window focus, sharing any pending request. A failed read keeps the last-known data marked stale. Snapshot confidence expires after 60 seconds even if a later request hangs; see [projectReader.ts](../src/features/projects/projectReader.ts). Local projects use opening and manual refresh. Every public mutation still performs its own fresh check.

### Wallet and development signer boundary

Public writes require the participant's injected EOA wallet, browser storage, and browser Web Locks support. Connection requests the account and switches/adds Tiramisu. Sending rechecks the account, wallet chain, RPC chain, and frozen native transaction. Account/network changes or disconnect clear live signing authority while keeping drafts. Connect again with the original owner account to recover its pending request.

The application does not accept a private key and does not expose a public or loopback signer endpoint. Never place a key in a `VITE_*` variable, browser bundle, source file, or public deployment. The operation journal stores requests and transaction evidence, not signing keys. Published payloads are public; use synthetic demonstration data and do not enter private contact, address, or calendar details.

[create-demo-wallet.mjs](../scripts/create-demo-wallet.mjs), [first-write.mjs](../scripts/first-write.mjs), and [probe-atomic-transition.mjs](../scripts/probe-atomic-transition.mjs) belong to the historical synthetic feasibility work. They are not installation prerequisites or a participant signing backend. The latter two default to estimation/reconciliation and require `--broadcast` to admit a send; they depend on the original local wallet/journals and frozen probe identity. Do not run them to initialize a new Partfolk project or delete their journals to force another attempt. Their guarded signing paths reject `DEBUG` logging.

## Read-only health and verification

With both preview servers running, this Node command checks HTTP reachability without opening a browser:

```sh
node --input-type=module -e "for (const url of process.argv.slice(1)) { const response = await fetch(url); console.log(response.status, url); if (!response.ok) process.exitCode = 1; }" http://127.0.0.1:4173/ http://127.0.0.1:4174/desk.html
```

An HTTP success establishes endpoint availability, not a correct user flow, wallet interaction, or agreement. There is no application `/health` or version API. Record the release revision and build/check results separately when deploying; use fresh RPC verification for public data.

The bounded capability probe requires no wallet or key:

```sh
node scripts/probe-arkiv.mjs
npm run verify -- --inspect-capability bootstrap --json
npm run verify -- --inspect-capability atomic --json
```

The probe uses at most 12 read requests and stops on quota exhaustion. The two verifier commands authenticate the specifically recorded synthetic capability entities. Their output explicitly says `productProof: false`; expiry or deletion can make a previously recorded capability unavailable now.

For a real Partfolk project, replace `PROJECT_ROOT` below with its exact 32-byte public entity key. A `local:` identifier cannot be verified on Tiramisu.

```sh
npm run verify -- PROJECT_ROOT
npm run verify -- PROJECT_ROOT --json
npm run verify -- PROJECT_ROOT --export project-snapshot.json
npm run verify -- PROJECT_ROOT --block 123456 --json
```

Replace `123456` with the specific historical block you intend to inspect. `--block` verifies dated evidence and does not establish current readiness. `--export` creates a UTF-8 JSON file with exclusive creation: choose another filename if the file already exists. The verifier works in a fresh Node process with Studio stopped and uses neither browser cache nor a Studio API. See [verify.ts](../src/cli/verify.ts).

Exit code `0` means the read produced a classified result; it does **not** mean agreement is Ready. Inspect `readiness.status`, lifecycle, approval counts, snapshot block/time, reasons, and history completeness. Unverified reads/errors return `1`; calling without arguments returns `2`. Missing historical proposals appear as gaps, distinct from the completeness of current state.

## Pending writes and recovery

Before any effect, Partfolk freezes the command, operation ID, input hash, authority, lifetime, and expected current entity keys. The UI saves the recoverable command; the wallet journal then saves preparation and send admission. The original transaction hash is recorded as soon as the provider returns it. Verification checks the original transaction calldata, canonical receipt, native events, and exact entity readback.

The browser journals are origin-specific:

| Client | Wallet journal key |
| --- | --- |
| Studio public workspace | `partfolk:studio:public:wallet-operations:v1` |
| Partner Desk | `partfolk:partner-desk:wallet-operations:v1` |

Both use the same-origin Web Lock name `partfolk:wallet-operation-lock`; separate origins do not share this lock or their journals. Avoid concurrent writes from the same account in separate clients/origins. Expected-head checks still reject stale transitions, but a browser lock is not a network-wide lock.

1. Keep the original browser profile, origin, saved request, and transaction hash after an interrupted response. A timeout does not establish that nothing was sent.
2. Reconnect the same owner account on Tiramisu. Use **Check this request** in project flows or **Check the original operation** in contribution flows.
3. If earlier phases are confirmed, use the offered **Continue saving** or **Continue saved request** action. This resumes the frozen request and revalidates only the remaining work.
4. Refresh the affected project/contribution and verify the result. Do not create a replacement operation merely to clear a pending indicator.

Initialization preserves `root_pending → root_confirmed → initial_state_pending → initialized`; a lost response must not create a second root. Plan publication preserves `proposal_pending → proposal_confirmed → activation_pending → activation_confirmed → fanout_pending → complete`, with each recipient's request link tracked separately. An existing proposal alone is not an active agreement, and interrupted request delivery does not justify publishing a second proposal. See [writer.ts](../src/data/arkiv/writer.ts) and [controller.ts](../src/data/operations/controller.ts).

| Result or error | Operator action |
| --- | --- |
| `not_sent`, wallet rejection, or `failed-before-send` | Correct the reported cause and review again. If earlier phases succeeded, continue their saved operation. |
| `pending` or `unverified` | Reconcile the original request. Do not resend or clear its journal. An empty operation-ID lookup does not prove an admitted send never happened. |
| Verified `reverted` | That transaction applied no entity changes; gas may have been spent. Refresh and create a corrected request only when no earlier phase needs recovery. |
| `partial_reverted` | Preserve the successful phases and use the saved request's continuation after fresh validation. |
| `stale_heads` | Refresh the exact current scope, review changes, and rebuild the intended change against those keys. Never automatically overwrite another revision. |
| `conflict` / multiple authentic heads | The owner must review all competing heads and explicitly resolve them. Do not select the newest timestamp. |
| `wrong_chain`, `not_connected`, or `unauthorized` | Select Tiramisu and the creator/owner account. Transferred or foreign-owned roots are not usable signing authority. |
| `rate_limited`, `network`, or `incomplete` | Allow the RPC to recover and retry a fresh bounded read/reconciliation. Keep current state Unverified and retain dated last-known data. |
| `storage` or unreadable journal | Preserve the existing browser data. Resolve storage availability/quota; do not erase it to permit a second send. |

When a saved **request envelope** is unreadable, the UI offers **Save the original file** and **Restore a request backup**. Restore a valid backup under its original account, then reconcile. This repairs the request envelope; it does not reconstruct a missing wallet verification journal or confer signing authority. Missing admitted-send evidence stays Unverified. There is no supported blanket “clear pending transactions” command. Terminal action state can be cleared by the application after confirmation, rejection, or a verified terminal revert; low-level transaction evidence is retained. See [ActionRecovery.tsx](../src/app/ActionRecovery.tsx) and [actions.ts](../src/app/actions.ts).

## Entity lifetime, consent, and missing-state recovery

Arkiv entity expiration is a block deadline. Nominal seconds/days are estimates derived by the SDK, not a guaranteed UTC retention date. Consent deadlines, availability intervals, and entity lifetimes are separate. Extending storage does not extend availability, renew an expired grant, or revive an expired entity. Natural expiry needs fresh reads; no deletion event is required.

Before a public demonstration, inspect the exact current root, state, proposal, activation, publisher books, and required evidence at a fresh block. Arrange owner-authorized extensions before those entities expire, with margin beyond the intended demonstration period. Recheck after extending. Project verification and exports show provenance/expiration blocks; they do not provide automatic lifetime maintenance. Preserve dated exports when history matters, while recognizing that an export cannot recreate third-party consent.

The contribution screen's **Keep my offers available** section lets an owner extend its current book or publisher root by about 30, 90, or 180 days. It rechecks the selected exact key and owner. The repository's `renewEntity` operation freezes an absolute target block for reconciliation, so retrying the same uncertain request cannot repeatedly add time. There is no general-purpose public CLI renewal command or automatic renewal scheduler in this release. Project/proposal/activation maintenance beyond the contribution UI requires an explicitly reviewed owner operation through the repository API; see [Renewal.tsx](../src/features/contributions/Renewal.tsx) and [writer.ts](../src/data/arkiv/writer.ts).

Books declare a retention policy, normally 90 days, and write validation requires a nominal lifetime covering retention and the consent horizon. This remains conditional on entities staying live and readable. Every newly activated material plan needs fresh approval from all required parties. Cancellation or closure cannot erase another owner's timed reservation or an outstanding equipment hold.

If the current book is missing but its publisher root is still live, authentic, and creator-owned, recovery requires a fresh complete zero-head read and explicit acknowledgement/redeclaration. It creates an **empty** book under the same root. Cached offers, approvals, grants, attestations, and custody are not restored. Redeclare current availability before offering. If the root is expired, deleted, or lacks valid authority, create a new publisher identity and obtain explicit project admission. Missing custody evidence does not mean equipment was returned.

## Evidence and release status

The checked-in [bootstrap evidence](../arkiv/evidence/bootstrap.json) and [atomic transition evidence](../arkiv/evidence/atomic-transition.json) record historical Tiramisu transactions. The atomic probe records creation of A, replacement by B, and rejection of a stale A-to-C gas estimate. It explicitly records `staleBroadcast: false` and `minedRollbackTested: false`. It does not prove a mined stale transaction rollback or a full Partfolk workflow.

The bounded product live-proof runner is under construction in [tests/arkiv-live](../tests/arkiv-live). Its final invocation and resulting evidence must be checked before publication; no live product proof or deployment is asserted by this guide. Do not infer completion from unit tests, a runner file, local practice, or capability evidence.

A release record should distinguish: build/check results, public-record verification block, source revision, deployed HTTPS address, server/HTTP checks, user visual/wallet verification, repository visibility, and submission status. At this documentation checkpoint, the production address, complete live product evidence, and user visual acceptance are pending. Deployment should preserve browser journals across upgrades, serve fresh HTML, and avoid caching RPC responses. A frontend host outage can be worked around with an independent Desk or CLI, but the current clients still rely on the configured RPC/indexer and on readable owner-controlled entities.
