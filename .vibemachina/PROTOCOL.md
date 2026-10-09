# Partfolk protocol v1

This is the authoritative implementation contract consolidated by MAIN on 9 October 2026. It describes the planned protocol, not shipped application evidence. Namespace `partfolk`, protocol `partfolk/1`, Tiramisu chain7738577, SDK0.8.1. The completed feasibility probe uses its historical separate namespace `convene_atomic_feasibility_v1` and does not represent product records.

## Repairs accepted after independent contract review

The following precise rules replace any earlier proposal wording:

1. Root payloads carry only protocol identity, kind and stable creator authority. Editable project title/outcome/requirements/variants belong in project_state; editable publisher name/resources/capacities belong in book_state. Human labels never establish identity.
2. Initialization is a persisted multi-step intent: root_pending → root_confirmed(exactkey) → initial_state_pending → initialized. Resume the known missing step. A verified head is required before sharing a ready invitation. Unknown sends reconcile first; no second root. Missing initialized/expired state is not initial publication and cannot restore expired approvals.
3. Project lifecycle (`planning`,`in_progress`,`closed`), current agreement health (`possible`,`awaiting_approval`,`declined`,`ready`,`changed`,`conflict`,`unverified`), recorded outcome (`completed`,`completed_with_outstanding`,`cancelled`) and evidence availability are separate fields. Closure never manufactures a ready state, completed task or returned resource.
4. Books contain separate arrays for active grants and execution attestations. Removing a grant preserves historical authored assertions. A completed task retains stable obligation ID, source proposal/hash and evidence references. Remaining-work repairs name their predecessor and include outstanding duties only; full recipe/history remains in the project lineage. If old source evidence disappears, say recorded complete with supporting source unavailable, not currently verified physical completion.
5. An unexpired grant counts against capacity even while the whole project is awaiting agreement. Only its owner's explicit release/replacement or exact deadline ends that hold. Coordinator cancellation does not erase it. Show Release my commitment, outstanding holds and deadlines. To evaluate a replacement for the same project, remove that publisher's prior project grant hypothetically before counting the candidate exactly once. The actual swap occurs only in the successful book transition. Grant deadline must cover its accepted obligations, including planned return. Entity life must cover deadline. Extension of storage never extends consent.
6. A handover statement binds transferId, project root, source proposal/hash, obligationId, resourceId, positive integer quantity, giver, receiver and action. Receiver acknowledgement binds that statement digest and acknowledged quantity (at most the sent amount). Return is the opposite named transfer and acknowledgement. Partial quantities remain partial. Corrections reference original statement, are visible, and cannot impersonate the other party. Task progress does not change agreed terms.
7. Known outstanding owned equipment is marked unavailable for a different project until owner-authored return acknowledgement or explicit corrected availability. This physical custody hold is separate from timed approval expiry; it cannot vanish because the project closes. Capacity evaluation avoids double-counting a hold against the same project allocation while refusing reuse by another project. This is participant assertion, not proof of actual custody.
8. Retain authored execution statements in current books for the demonstrated project and at least90days when the entity remains live. Bounds use measured encoded payload bytes and SDK limit131072; normal application target is<=120KiB. If a book cannot fit, preserve input, explain what needs owner archival/export and refuse silent data loss. Removing old statements is explicit and degrades evidence availability, never fabricates a permanent archive. No onchain deletion erases external copies.

## Exact canonical material boundary

Canonical JSON uses UTF-8, object keys sorted lexicographically, Unicode NFC strings with CRLF normalized to LF, no undefined/NaN/infinity/floats, explicit null only for documented nullable fields, omitted optional fields normalized by schema defaults. Ordered task dependencies are sorted as sets; arrays that are meaningful ordered runbook steps retain stable sequence IDs. Sets of approvers/offers/allocations/conditions use documented stable identifiers and reject duplicates. Hash is keccak256 of the complete canonical document; domain separator fields are inside that document, not ad-hoc concatenation. Golden fixtures with expected hashes are shipped for third-party clients.

Covered fields: protocol/validation version, chainId, projectRoot, original project outcome, selected variant and venue, time zone and exact UTC intervals, selected requirements/quantities/units, selected offer IDs and immutable offer content hashes, resource identities/capacity assumptions, allocations, all required approvers derived independently from allocations and explicit duties, typed conditions, human instructions people are asked to accept, stable task/dependency/handover obligations, predecessor when this is a remaining-work repair. Approval deadline is in each exact displayed grant, with verifier requiring coverage of that party's last accepted duty; it does not vary the global proposal hash.

Excluded: current book entity key, unselected variants/offers, UI sort/filter, receipt progress, decision status, cache timestamp and comments. Active immutable proposal is the agreed package; editing an unselected draft alternative does not mutate that package. Promotion of changed terms needs a new hash and every new required owner's fresh agreement. Hash equality alone never substitutes for full domain validation or full approver derivation.

Intervals are half-open [start,end), integer UTC milliseconds; quantity/capacity positive integers with explicit unit. Multi-window availability must cover every allocated interval without gaps. Zero-length intervals are invalid. Same publisher/root self resource has capacity one for personal time regardless of number of role offers. Publisher roots are not verified human identities and cannot provide Sybil resistance.

## Sample physical dependency

Small Works uses boards and installation kit already delivered to the library before10:00. Installation builds those displays10:00–12:00. Simultaneous transport brings ARTWORKS from a synthetic studio, with the transport service including required carrying equipment. Exhibition hosting starts12:00 after both installation and artwork transport. Cedar cannot install and transport simultaneously. Oak's transport offer enables the plan; later Juniper installs so Cedar can transport. The product models explicit end-before-start dependencies, rather than assuming a person count proves physical feasibility.

## Verified atomic prerequisite

9October2026 live SDK create A succeeded at block352006, create B/delete A succeeded at block352065. A stale create C/delete A estimate returned decoded EntityNotFound with exact A key; only B remained live at block352164. Evidence `arkiv/evidence/atomic-transition.json`. Combined probe cost0.000224464000448928testGLM; prior bootstrap0.000101712000203424. No paid stale transaction was broadcast; mined failed-batch rollback was not tested. Atomic all-or-none guarantee is documented by Arkiv. Application still validates payloads, provenance, uniqueness and snapshots itself.

## Detailed data and integration design

## Decision: immutable current books, consumed on replacement

Do not use an unversioned mutable `latest_head` patch as authority. SDK patches have no compare-and-set precondition, and a creator/current-owner pair alone does not authenticate content after ownership has transferred away and back.

Use a small **current book** entity with `readonly: true`, `permissionlessExtension: false`. To replace it, its owner submits one native batch containing a new readonly book and deletion of the exact old key. The SDK applies creates before deletes, but the whole batch is atomic. If the old key is already absent, the delete is expected to fail, reverting the newly created replacement too.

This uses the existence of a specific, immutable, owned entity as a transition precondition. It is an application construction from native create/delete/batch behavior, **not** a claim that Arkiv has a patch CAS API. The atomic guarantee is explicit in [native mutation documentation](https://docs.arkiv.network/json-rpc/mutating-entities/#batch-operations); missing-entity failures are listed in [its error catalog](https://docs.arkiv.network/json-rpc/mutating-entities/#errors). The completed bounded live experiment above verified the exact stale-transition estimate failure; its mined rollback limitation is explicit.

Benefits:

- Two honest clients editing the same book version cannot both leave successful replacements if each consumes the exact old key.
- Withdrawal does not rely on a separate short-lived revocation record. The previous approved state is consumed, so deleting or expiring the new state cannot reveal that old approval as live again.
- A current book's payload is authenticated by its immutable `$creator` and readonly flag. A foreign record transferred to that owner is still rejected by creator validation.
- Natural expiration yields no current state, never a fallback to an old consent.

Limits:

- This does not atomically lock several different owners' resources. Whole-plan readiness is derived from one common block snapshot.
- Application namespace/book-ID uniqueness is not enforced by the chain. If a creator deliberately publishes two current heads without consuming the old one, readers must show **Conflict**, not select the greatest revision.
- An owner may delete or transfer their own book. That breaks readiness; the application cannot force continued participation.
- Old consumed books disappear from live queries. Do not promise a permanent onchain readable audit log. Retain public proposal snapshots and export verification packets; historical RPC availability remains provider-dependent.

## Seven core entity types

All use `contentType: application/json`, lowercase attributes, explicit schema version and a bounded validated payload. All are readonly. Current-state entities permit only creator-owned consume-and-replace transitions. No transfer workflow is offered in the product.

Common attributes: `project: str('partfolk')`, `schema_version: i32(1)`, `entity_type: str(...)`, `created_at: u64(ms)`. Immutable entity keys identify roots; names do not establish identity. Add only fields used by actual filters. The model stays well below 30 user attributes per create.

| Type | Authority and useful attributes | Payload and lifecycle |
| --- | --- | --- |
| `project_root` | Coordinator creates it. Canonical project identity is this entity's key. | Stable protocol identity and designated coordinator authority. Editable title, outcome, variants and planning horizon live in project_state. Shared links carry the root key. No global mutable directory is authoritative. |
| `project_state` | Creator must equal root creator; `project_key: key(root)`. Exactly one live state is required. | Requirements, allowable date/venue variants, participant/book root references, lifecycle and completion summary. The unique plan_activation is the sole authority for active proposal key/hash. Payload includes consumed predecessor keys and an operation ID. Coordinator changes it by consuming the current state. |
| `publisher_root` | An individual or organization creates it. Its immutable creator is the publisher authority. | Stable publisher kind and protocol/creator identity. Editable alias, resource identities, capacities and horizon live in book_state. This is not verified real-world identity. Root key is the book ID. |
| `book_state` | Creator must equal publisher-root creator; `book_key: key(root)`. Exactly one live state is required. | Current offers, editable publisher metadata and resource windows/capacity, active approval reservations across projects, separate retained task/transfer attestations and custody holds, consumed predecessor keys and operation ID. Every meaningful change consumes the previous book. |
| `proposal` | Coordinator creates it; `project_key`, `requirements_hash: bytes32`, `proposal_hash: bytes32`. | Complete canonical arrangement: date/venue, selected offer IDs/hashes and publisher roots, exact allocations, requirements snapshot, conditions, runbook and change explanation. Kept as a readonly snapshot even when superseded. |

`operation_id: str(uuid)` is for reconciling a user's attempted write, not a protocol uniqueness constraint. A known hash/key remains the primary receipt reconciliation handle.

The additional `plan_activation` and `project_link` types are fully specified in Final discovery, decision and activation contracts below. Those rules supersede earlier project-state promotion wording.

There is no need for an independent onchain row for every checkbox. A publisher's current book holds its exact approvals and task attestations. Keeping those together lets a single owner update capacity accounting and consent atomically.

## Offers, capacities and consent

Each offer has a stable `offer_id` within a publisher root, plus a digest of its canonical content. Its content includes resource IDs, allowed windows or named date variants, quantity/capacity, project/community scope and a small set of structured conditions. Keep explanatory prose separate from conditions interpreted by the solver.

A project proposal refers to `(publisher_root_key, offer_id, offer_hash)`. It must **not** require the original `book_state` key to remain live: approving the proposal itself replaces that book. Updating unrelated reservations can preserve an unchanged offer hash and grant. Changing an offer's actual terms produces a different hash and invalidates proposals relying on the old terms.

An approval grant in a book contains:

- chain/protocol version, project-root key, proposal key and canonical proposal hash;
- exact offer IDs/hashes and resource allocations this publisher accepts;
- each interval as integer UTC start/end values with a named display timezone retained in the proposal;
- explicit consent validity time; execution attestations are retained separately from active grants;
- a fresh operation ID, plus its state-transition predecessor for reconciliation.

The hash domain includes `partfolk`, protocol version, chain ID and project-root key. It covers every material term: requirements, variant choices, allocations, commitments and the runbook. Stable ordering and exact integer encodings are part of the published protocol. No freeform string concatenation or floating-point quantities.

Any material proposal change produces a different hash and requires fresh agreement. A prior approval cannot be silently copied to a new revision. Pure display formatting outside canonical content does not require new signatures.

The grant is authored onchain by the publisher's wallet, rather than stored by a shared server signer. No additional offchain cryptographic signature is needed for this first version because the readonly book's verified creator authenticates its content.

### Cross-project capacity accounting

Store all **public Partfolk reservations** for one publisher in its current book. Accepting project B computes capacity against project A and every other active grant, then creates the complete new book and consumes the old one. Two separate project frontends starting from the same book cannot both admit incompatible edits through the transition protocol: the second stale transition must be reconciled and recomputed.

Count an approval reservation immediately, while other participants are still considering the proposal. Otherwise the same contributor could appear available to many half-approved plans. Explain the hold in the approval confirmation and give it an explicit validity deadline. Approving a replacement revision can remove that publisher's old revision grant and add the new one in the same book transition.

For personal publishers, all labor offers consume the single `self` capacity resource, with capacity one over overlapping intervals. This prevents one declared participant from filling two simultaneous roles under that publisher root. An organization may declare several separately identified resources. Several wallet addresses or several publisher roots are not proof of several different people or physical assets; do not claim Sybil resistance or verified physical inventory.

This is capacity accounting over declared public commitments, not a guarantee about a person's private calendar or activity outside Partfolk. No private calendar import or private availability inference belongs in the hackathon demonstration.

## Publish, approve, withdraw, repair

1. The coordinator creates the project root and first project state. Publisher-root keys are deliberately added to this project; an arbitrary entity with copied `project_key` attributes is not a trusted contributor.
2. Each publisher creates its root and initial book. The second and later versions consume the previous book. A library's own frontend and a maker lab's CLI can publish directly to the same chain; the coordinator does not hold their keys.
3. A visitor can compute candidate arrangements locally from one validated snapshot. This spends no GLM and creates no entity. Present infeasibility as concrete unmet requirements, not an opaque solver score.
4. The coordinator publishes the selected immutable proposal. Then it promotes that proposal through a project-state transition. A successfully created but not activated proposal remains a draft and cannot become Ready. Promotion now uses the dedicated consumed activation head specified below. A partial failure resumes promotion using the known proposal key, not another create.
5. Each contributor views the complete plan and their own exact allocation, then explicitly approves it by replacing their book with the new grant included. The wallet approves one bounded native transaction. A later full snapshot determines readiness; the button does not optimistically paint the whole project green.
6. Withdrawal removes the grant or changes the offer in a replacement book. The old approved book is deleted in the same batch. The project becomes Changed/Not ready when read at or after that inclusion block.
7. The solver proposes a repair. A different plan hash starts with no borrowed approvals. A contributor can compare old/new obligations and replace the old grant when agreeing to the new plan.
8. Assigned publishers attest task completion in their own book. The coordinator can close the project with a summary bound to the active proposal and these attestations. Describe physical completion as a participant assertion, not independently proven real-world performance.
9. Reuse copies requirements and the runbook into a **new project root**. It copies no participant approval, reservation, wallet authority or claim of continued availability.

Creating a proposal and promoting it can remain two short, resumable transactions. Do not add predicted-key coupling just to save a click. A combined transaction is an optimization only after exclusive entity-nonce custody is established for that exact writer.

## Revision and fork handling

For each authorized `(root key, creator)` current-state scope:

- **One valid live entity:** evaluate it normally.
- **None:** Unavailable/Expired; do not resurrect a predecessor, fabricate an empty consent set as a complete result, or recreate automatically.
- **More than one:** Conflict. Show the competing changes and require that same publisher/coordinator to choose a merged state. A resolution batch creates the chosen full state and deletes every observed competing live key.
- **Missing or invalid referenced root:** Unverifiable, never Ready.
- **Owner differs from creator:** current state is unavailable for this workflow. Readonly contents retain provenance, but creator-controlled future transitions cannot be assumed.

The conflict-resolution transaction also races safely under the same consume rule: if another operation already consumed one of the observed keys, the whole resolution should revert. Re-read and show the new situation. Do not run an automatic loop that keeps overwriting someone's latest decision.

An adversarial creator may deliberately publish contradictory records, invent capacity or delete their book. The product surfaces those states; the chain is not executing Partfolk's solver rules. A version integer helps readers explain sequence but is never enough to resolve forks or establish authority.

## Trust and readiness computation

`Ready` means **this exact plan has compatible current offers and valid approvals at block B**, using the published protocol. It does not mean a multi-owner onchain lock, money escrow, binding contract, venue verification or an eternal promise.

A verifier returns a structured verdict, never a bare boolean:

| Verdict | Required meaning |
| --- | --- |
| `possible` | Solver found a feasible candidate; it has not acquired full consent. |
| `awaiting_approval` | Active proposal is valid; named contributors still lack matching current grants. |
| `ready` | One active project state, authentic proposal, complete books, satisfied conditions/capacities, and all exact grants are valid at the same block. |
| `changed` | A required offer/hash/grant changed or is no longer live; report the broken obligations. |
| `conflict` | A required current-state scope has more than one live head. |
| `unverified` | RPC/quota/page-budget/schema/retention failure or stale cached data prevents a complete current assessment. |
| `completed` | Coordinator's closing statement and required publisher task attestations match the recorded plan. |

Every ready decision must validate root/key/creator identity, readonly flags, owner compatibility, MIME/schema, attribute/payload projection agreement, canonical hashes, selected resource capacity, all active overlapping grants, declared conditions, consent validity and entity liveness. Wallet possession proves a publisher account authored a statement, not that a person or institution has been externally verified.

Use the canonical block's timestamp as the shared time for consent/window checks. Keep Arkiv expiration block numbers distinct from application UTC timestamps. Display a short freshness indication; if refresh fails or the approved maximum age is exceeded, change the current badge to Unverified rather than leave an old green state presented as current.

## Query boundaries and no fake green

Read a fresh head B once, then pin every related query to B. Retrieve the project root, its complete state scope, its selected proposal and the complete state scopes of every referenced publisher. Proposal selection must come from the unique live plan_activation, not “newest proposal” or a project_state pointer.

Typical state predicates:

- `project = str('partfolk') AND entity_type = str('project_state') AND project_key = key(root)` plus `.createdBy(projectRoot.creator)`.
- `project = str('partfolk') AND entity_type = str('book_state') AND book_key = key(publisherRoot)` plus `.createdBy(publisherRoot.creator)`.
- Exact root/proposal entity keys via `$key = key(...)` at the same B.

State scopes should normally contain one current row, but readers must establish that fact by cursor completion. A two-row page already proves a conflict; no need to download an attacker's whole fork spam. For directories and proposal history, walk all bounded pages with stable query/projection/B. On a cursor error, discard the partial walk; at most a small explicit restart budget. HTTP 401/403/429 and page-budget exhaustion are failures, never an empty successful array.

The solver operates over complete validated input, or returns Unverified. It does not turn one arbitrary page of offers into a claim that no solution exists. Raw filtered count is optional diagnostic support, not a replacement for row validation. SDK `getEntityCount()` is not a scoped count.

A missing resource's entire book invalidates its commitments. A missing unrelated directory listing does not silently delete a known required publisher from the project. Root references in the project snapshot define the required trust scope.

## Solver and minimal repair

Implement a deterministic finite constraint solver, not an AI decision maker. Candidate dimensions are named date/venue variants and explicitly enumerated contribution alternatives. Conditions are typed: compatible date/venue, required capability, dependency on another selected contribution, mutual exclusion, quantity and interval capacity. Do not execute user-supplied expressions.

Evaluate all chosen obligations together. A room offer conditional on a facilitator is not usable merely because a room row exists. Validate the final assignment independently from the search algorithm; the CLI uses that same published verifier contract.

For repair, use a documented lexicographic objective: preserve previously selected compatible contributors; then preserve date/venue; then minimize changed allocations and runbook assignments; finally break ties by stable IDs. The exact priority order is a product decision to freeze before implementation. Present concrete changes and which people must reapprove.

“Minimal change” is justified only when the solver completed its documented search domain. If a time/node budget is exhausted, return a valid found repair with `optimality: not_proven`, or an unresolved search—not an invented optimal result or “impossible.” Use small realistic demonstration data and meaningful branch pruning; no generic scheduling platform is necessary.

## Expiration and deletion

All roots/proposals/current books need explicit lifetime policies. For the demonstration, keep roots and immutable proposals alive through judging plus a clear margin; plan per-operation costs before writes. Current books must outlive their longest current grant or the grant cannot be accepted. A participant controls book renewal; do not allow third-party indefinite extension of someone's public availability.

Consent validity is an application deadline, separate from the enclosing entity's expiration. Extending an entity does not revive an expired approval. The old grant would require an explicit newly authored consent according to the same exact proposal hash.

Arkiv deletion/expiration does not erase history or downloaded copies. Natural expiration emits no event, so readiness needs periodic fresh reads even if the explicit operation feed is quiet. A renewed current book keeps the same key; a consumed/replaced book gets a new key. Never extend a consumed key or treat its absence as proof of secure deletion.

## Independent clients to ship

1. **Partfolk board:** normal project planning interface, local candidate exploration, contributor approval and runbook.
2. **Library or maker console:** a small separately built entry point controlling that publisher's book directly through its connected wallet. It shows the same reservations while the Partfolk server is stopped. It must not call Partfolk's API to obtain authoritative state or send its transaction.
3. **`partfolk verify` CLI:** given a project-root key, a fresh Node process queries official Arkiv RPC, runs the published schema/consent/capacity verifier and prints block, plan summary, readiness and reasons. No frontend cache or private API access. A narrowly scoped CLI publisher is also useful for the second organization's synthetic demonstration.

Share a small protocol/domain package between these clients: schema validation, canonicalization, predicates, solver/verifier and DTOs. This is honest open-source reuse, not a second UI calling the first UI's backend. Publish a concise schema with sample entities and a command showing a third-party consumer how to join.

## Signing and ordinary-user testing

Public deployment: injected EOA wallet, explicit account, Tiramisu chain recheck before each write, user-approved transaction, no shared custody or public faucet signer. Read and draft exploration require neither login nor wallet. Handle account/chain changes, disconnect and rejected signatures explicitly; a constructed client does not automatically follow a changed wallet account.

One reusable operation controller is sufficient: freeze normalized input + operation ID + predecessor keys; persist pending intent/hash locally; estimate where the wallet/provider supports it; ask wallet to send; reconcile receipt and re-read before another operation. After timeout, show Pending/Needs verification and query by the original operation ID/creator/known hash. Do not silently call create again. The bootstrap's 450-line custody machinery does not need to be duplicated per button.

A public or loopback signing service is not selected. Dedicated synthetic personas are available only in a reviewed local CLI evidence runner, with keys outside Git/browser. The optional service proposal below is not part of approved scope: Local full-role testing may use dedicated synthetic personas with distinct funded test keys in a loopback-only service. That service needs a fixed action allowlist, input bounds, origin/CSRF checks, a process-wide signer queue and the shared remaining spend ledger. It must refuse non-loopback binding and be omitted from production artifacts. Keys never enter the client or Git. Public visitors must not be able to trigger this test funding path.

All onchain demonstration content is synthetic: no real names, emails, phone numbers, home locations, calendar events or hashes of such data. Public organization/resources are the intended product context, but the demonstration must not quietly import real schedules. Make this restriction visible at the input boundary rather than burying it in technical documentation.

## Proofs needed within the build

The existing [bootstrap evidence](../arkiv/arkiv/evidence/bootstrap.json) proves one readonly SDK write/readback on Tiramisu, transaction `0xd9a9eb50a203afc13c5a28df1707eca01c66fab19837eacb91c72e11c22b2ba3`, gas fee `0.000101712000203424` test GLM. It does not yet prove this application protocol.

Required next tests:

- Atomic A→B replacement, then a stale A→C estimate that fails and leaves no C; if needed, an explicitly budgeted reverted-send test separately authorized after review.
- Two projects contend for the same publisher resource; after one grant consumes book A, the second stale edit cannot create a valid conflicting successor. Recompute against B and explain the capacity conflict.
- Complete plan with separate publisher creators; one withdrawal changes Ready to Changed at a fresh common block in both UI data API and independent CLI.
- Exact-version replay rejection, projection/hash mismatch rejection, foreign-creator spoof rejection, duplicate-head Conflict, missing/expired book Unverified/Changed, failed pagination never Ready.
- Interrupted operation resumed by its original hash, without another create.
- Template reuse yields a new root with no inherited approvals.

Main blockers are the atomic transition experiment, signing UX verification by the user, and a genuinely independent publisher/reader path. None requires arbitrary smart contracts, a public custodial signer, private data, or a large backend platform.

## Sources

- Installed SDK: `src/actions/wallet/executeBatch.ts`, `src/utils/arkivTransactions.ts`, `src/entity/flags.ts`, `src/query/queryBuilder.ts`, `src/query/engine.ts`, `src/entity/expiry.ts`.
- [Official native mutations and atomic batches](https://docs.arkiv.network/json-rpc/mutating-entities/).
- [Official query protocol](https://docs.arkiv.network/json-rpc/querying-data/).
- [Official entity lifecycle skill](https://github.com/Arkiv-Network/skills/blob/main/skills/arkiv-entity-lifecycle/SKILL.md).
- [Official modeling skill](https://github.com/Arkiv-Network/skills/blob/main/skills/arkiv-data-modeling/SKILL.md).
- [Official app integration skill](https://github.com/Arkiv-Network/skills/blob/main/skills/arkiv-app-integration/SKILL.md).
- [Official security/trust skill](https://github.com/Arkiv-Network/skills/blob/main/skills/arkiv-security-trust/SKILL.md).


## Final discovery, decision and activation contracts

### Two additional entity types

`project_link` is a readonly discovery hint, never authority. Common attrs plus link_kind str (`offer` or `request`), project_key key, publisher_key key; request links also carry activation_key key. Payload includes the same identities, relevant offer IDs for an offer link, or exact proposal/activation references for a request link. Offer link creator must equal publisher-root creator; request link creator must equal project-root creator. Readers fetch and validate those roots instead of trusting payload author labels. Lifetime90days for demo, bounded payload. Duplicated valid hints collapse by canonical content identity; they do not create duplicate promises.

`plan_activation` is the coordinator's readonly current agreement head. Common attrs plus project_key key and proposal_key key. Payload carries protocol, projectRoot, proposalKey, proposalHash, predecessorActivationKeys and operationId. Every promotion, including returning to old terms, creates a NEW activation entity and consumes the exact prior activation in the same native batch. Exactly one authentic live activation is required. Missing is unavailable; multiple is conflict; no max-revision fallback. Active proposal authority belongs to this head, not to an editable pointer in project_state. Project_state retains recipe and lifecycle; progress/state edits do not replace activation. Lifetime90days or enough to cover accepted duties. Grant deadlines cannot outlive activation/entity availability requirements.

All grants bind the exact activation ENTITY KEY as well as proposal key/hash. Readiness requires that exact activation to be uniquely live at the common block. An old activation cannot be revived by pointing at its proposal: after consumption it no longer exists, and a new copy has a different entity key. Therefore P1-ready → P2-active → old P1 terms promoted creates a third activation and requires new owner decisions, even when its material proposal hash equals P1. Progress/book updates preserve activation and do not reset consent. This closes historical-grant replay without depending on a coordinator-maintained history list.

Publishing is now explicit: create immutable proposal; create/consume activation; confirm its exact key; fan out owner request links. Persist every phase and resume the known incomplete step. A pending fanout is a delivery problem visible to the organizer, not a reason to create another proposal or activation. A draft proposal is never active merely because it exists. Invitation links can directly open the active proposal without waiting for a separate notification service.

### Durable participant decisions

Each book has `decisions`, `grants`, `attestations` and `custodyHolds` as separate collections. Decisions contain projectRoot, activationKey, proposalKey/hash, status (`accepted`,`declined`,`withdrawn`), optional public reason, decision timestamp and operationId. There is at most one current decision per(projectRoot,activationKey) within a valid book; contradictory duplicates invalidate it. Historical decisions remain explicitly historical after activation change. Retention follows the book's declared90day policy and payload bounds.

Accept replaces the exact current book, recording accepted decision AND matching grant atomically. Decline/withdraw records the owner's exact decision and removes the corresponding grant in the same transition; it cannot change another publisher's book. An accepted decision without its valid exact grant is not agreement; a grant with contradictory decision is invalid. No decision means awaiting. A current declined decision yields declined with optional reason; withdrawal yields changed/withdrawn. A later explicit reacceptance can replace the decision under the same still-live activation, with full current validation. Expired/missing decisions never resurrect a prior accepted record. Independent CLI and Desk derive these states identically after reload.

### Unseeded invitation and independent discovery

1. Organizer publishes root+initial state, receives project invitation link only after confirmed initialization.
2. A new participant follows it, creates or selects their own publisher root/book. Fresh clients discover own roots through entity_type=publisher_root and immutable createdBy(wallet), with complete scoped pagination.
3. Participant prepares a contribution in their own book and publishes an offer project_link referencing this project and publisher. The multi-step intent persists book/root keys and link result, so interrupted sharing resumes without duplicate identities. Contribution is now submitted for organizer review, not silently trusted or accepted.
4. Studio queries incoming offer links by project_key, validates publisher authority and current book, then organizer explicitly adds a selected publisher root to project_state. Spam/invalid hints are excluded with diagnostics; failed pagination shows incomplete inbox, never says no offers. Hints do not authorize access or consent.
5. After proposal activation, coordinator publishes request links per required publisher. Fresh Desk discovers them by publisher_key and link_kind=request, validates coordinator/root/current activation and opens the complete plan. Stale links appear historical/obsolete, never count as live agreement. Multipleprojects work without copying private Studio storage.
6. The participant's own active/historical grants also retain project references; a watched-project list is a local navigation convenience, never authority. Direct public project ID entry remains available when a discovery link expires. Missing inbox data cannot silently remove an already-known required party from readiness.

Repository adds listOwnPublishers(account), listIncomingOffers(projectRoot), listRequests(publisherRoot), publishProjectLink(command) and activateProposal(expectedActivationHeads,proposal). Queries stay pinned and typed. Public links are untrusted input and go through the same runtime validators.

Required tests: an empty custom project plus previously unknown publisher using two fresh repository instances; invite→publisher→offer-link→coordinator-admission→activation→request-link→Desk-decision→freshStudio/CLI. Test interrupted link/fanout writes; duplicate/malicious links; decline and withdrawal persist after reload. Regression P1 ready→P2→P1 replay cannot become Ready from old grants. Do not claim these tests have passed before implementation.

### Closure and restart

Terminal closure/cancellation creates the new project_state, deletes its expected previous state and consumes the current plan_activation in one native atomic batch. This prevents reopening a closed project from reviving a still-live old activation. Restart/promotion always creates a fresh activation and needs fresh decisions. Owner capacity holds remain until owner release/replacement or their deadline, even after cancellation consumes the activation. Closed historical views expect no current activation; they display recorded outcomes/evidence availability rather than failing the whole history as if it were a current-ready request. Completed task history retains source activation/proposal references and its recorded verification evidence even when that activation has been consumed.

