# Running and operating Partfolk

Partfolk is a static browser application with a separately built Partner Desk and a read-only command-line verifier. Public clients read Arkiv directly. There is no application server, account database, shared signing service, or required agent tooling.

The public application is available at [partfolk.vercel.app](https://partfolk.vercel.app/), with [Partner Desk](https://partfolk.vercel.app/desk.html) at the same origin. A complete live Partfolk demonstration is still being assembled. The existing bootstrap and atomic-transition records demonstrate SDK capabilities; they are not a completed public project workflow.

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

Desk is available at `http://127.0.0.1:5174/desk`. Its own entry point, runtime and browser journal namespace do not require the Studio development server. Same-origin windows share the wallet choice, explicit sign-out and account display preferences. Different ports/origins keep separate storage. The user performs browser and visual verification.

Reading public projects, preparing unsent input and synthetic practice need no wallet. Ordinary projects publish through the connected owner's wallet. Older device-only projects remain recoverable; the separate practice and its fictional roles do not grant public consent.

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
| `npm run build` | Studio, bundled Desk and the 404 document in `dist/`. |
| `npm run build:desk` | Independent Desk artifact in `dist-desk/`. |
| `npm run preview` | Serve `dist/` on `http://127.0.0.1:4173/`. |
| `npm run preview:desk` | Serve `dist-desk/` on `http://127.0.0.1:4174/desk`. |
| `npm run verify -- --help` | Show the read-only verifier's arguments. |

Build before running the corresponding preview command. All four development/preview ports are strict: an occupied port causes an error instead of silently choosing another. There is no `npm start` script. The main production bundle uses the hosted read endpoint, so its local preview requires the server-only access key below; standalone Desk builds use direct RPC.

The [Studio build configuration](../vite.config.ts) and [Desk build configuration](../vite.desk.config.ts) use origin-root asset URLs. Keep HTML and generated assets together at the hosting origin root. The independent `dist-desk/` artifact works with `/desk.html`; the provided development/preview server also serves `/desk` and redirects the older path. Do not publish `.local/`, environment files, source maps or journals as static files.

The deployed product is [partfolk.vercel.app](https://partfolk.vercel.app/). For a Vercel source deployment, [vercel.json](../vercel.json) installs dependencies, builds `dist/` and includes [api/arkiv-read.ts](../api/arkiv-read.ts) as a Node function. Set `ARKIV_RPC_ACCESS_KEY` in the server environment before enabling hosted reads. It is a provider access credential, not a signing key. `/desk` serves the same-product contributor workspace; unknown document paths redirect to `/404`, which returns HTTP 404. Missing private files and assets return 404 directly. Deployments must preserve origin storage and transaction recovery journals.

## Runtime and network configuration

Direct development reads need no token. The main production browser build reads through `/api/arkiv-read`, whose only provider credential is server-side `ARKIV_RPC_ACCESS_KEY`. For loopback development and preview, the Vite server reads that process variable or the ignored `.local/arkiv-access-key.txt` file. The file contains one access token. With no local token, development uses direct public RPC; main production preview reports the missing hosted access explicitly. Builds never load the local key into browser code.

`VITE_ARKIV_READ_TRANSPORT` is a non-secret build choice (`auto`, `direct` or `hosted`). The supplied Vite configurations set it deliberately: the hosted main build uses the same-origin read API, and the independent Desk build uses direct RPC. The network itself is fixed in source:

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

The read service validates a small allowlist of methods and exact Partfolk query/native-estimate shapes. It cannot sign or submit a transaction and does not accept a caller-selected upstream. Requests, responses, queues, concurrency and request time are bounded. Its rate admission is per instance; it is not a distributed quota guarantee. The access key is sent only to the fixed official RPC and never returned to the browser.

Browser readers share pending work and short-lived immutable query pages within a verified block/hash generation. Chain IDs and block headers stay independent, including the final reorg check. Each read has a ten-second fetch/body limit, at most one transient retry, and a cooldown that respects quota headers. Cancellation reaches the transport. Oversized query responses can restart the complete scope at smaller page sizes at the same block; generic failures cannot produce a partial successful result. The service never automatically falls back to a different upstream or replays a write.

Public reads pin related records to one block and require complete pagination. The reader defaults are 160 pages, 4,000 entities, 50 publishers, 100 records per page, and one cursor restart. Exceeding a bound or losing a page produces an incomplete/unverified result. Project views poll every 45 seconds while visible and limit focus refreshes to one per 15 seconds, respecting cooldowns. Catalogue filtering uses its loaded dataset without another traversal. Failed refreshes keep last-known data marked stale, including nested source and roster snapshots. Confidence expires after 60 seconds; see [projectReader.ts](../src/features/projects/projectReader.ts). Every public mutation still performs its own fresh complete check.

### Wallet and development signer boundary

Public writes require the participant's injected EOA wallet, browser storage, and browser Web Locks support. The modal lists detected providers, requests the chosen account and switches/adds Tiramisu only when needed. A previously authorized session can restore with passive account/chain reads. Explicit sign-out and cancelled connections suppress late provider events. Sending rechecks the account, wallet chain, RPC chain, and frozen native transaction. Account/network changes clear obsolete signing authority while keeping input and journals.

The application does not accept a private key and does not expose a public or loopback signer endpoint. Never place a key in a `VITE_*` variable, browser bundle, source file, or public deployment. The operation journal stores requests and transaction evidence, not signing keys. Published payloads are public; use synthetic demonstration data and do not enter private contact, address, or calendar details.

[create-demo-wallet.mjs](../scripts/create-demo-wallet.mjs), [first-write.mjs](../scripts/first-write.mjs), and [probe-atomic-transition.mjs](../scripts/probe-atomic-transition.mjs) belong to the historical synthetic feasibility work. They are not installation prerequisites or a participant signing backend. The latter two default to estimation/reconciliation and require `--broadcast` to admit a send; they depend on the original local wallet/journals and frozen probe identity. Do not run them to initialize a new Partfolk project or delete their journals to force another attempt. Their guarded signing paths reject `DEBUG` logging.

## Read-only health and verification

With both preview servers running, this Node command checks HTTP reachability without opening a browser:

```sh
node --input-type=module -e "for (const url of process.argv.slice(1)) { const response = await fetch(url); console.log(response.status, url); if (!response.ok) process.exitCode = 1; }" http://127.0.0.1:4173/ http://127.0.0.1:4174/desk
```

An HTTP success establishes endpoint availability, not a correct user flow, wallet interaction, or agreement. The packaged public release includes `/version.json` with its source commit. Local Vite has no application health endpoint. Record build/check results separately and use fresh RPC verification for public data.

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

The [completed contributor proof](../arkiv/evidence/product-proof.json) records the synthetic P1 → withdrawal → P2 → P3 workflow on 11 October 2026. The separate [event proof](../arkiv/evidence/test-events.json) records three labelled test events, managed admissions and attendance. Together they contain 135 confirmed transactions within the 0.1 test GLM budget. They establish dated protocol behavior, not physical events or current readiness. The guarded runner is documented in [tests/arkiv-live](../tests/arkiv-live); rerunning it is not a setup step.

A release record should distinguish build/check results, public-record verification block, source revision, deployed address, server/HTTP checks and user visual/wallet verification. The read endpoint returns no-store responses. A frontend host outage can be worked around with the independent direct-RPC Desk build or CLI; every client still relies on the configured RPC/indexer and readable owner-controlled entities.
