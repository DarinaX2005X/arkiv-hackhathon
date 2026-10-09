# Partfolk protocol v1

Authoritative contract consolidated 9 October 2026. Namespace `partfolk`, protocol `partfolk/1`, schema1, Tiramisu chain7738577, SDK0.8.1. Requirements below are not claims of shipped evidence. Product tests, mocked failures and live network proofs are recorded separately.

## Seven entities and provenance

All entities: application/json, readonly true, permissionlessExtension false, bounded schema-validated JSON. Common attributes: project str(partfolk), schema_version i32(1), entity_type str(type), created_at u64(ms), operation_id str(id). Every payload including roots carries protocol/schemaVersion/createdAt/operationId. Indexed projections must match payloads. Operation IDs support reconciliation, not chain-enforced uniqueness.

| Type | Authority and query fields | Purpose |
| --- | --- | --- |
| project_root | Immutable creator is coordinator; exact entity key is identity. | Stable protocol and coordinator identity. |
| project_state | Root creator; project_key; exactly one current head. | Editable recipe, admitted publisher roots, lifecycle, completedWork and completion. No active-proposal pointer. |
| publisher_root | Immutable creator is publisher; exact entity key is identity. | Stable actor and individual/organization kind. |
| book_state | Publisher-root creator; book_key; exactly one current head. | Name, resources, offers, separate decisions, grants, attestations and custody holds. |
| proposal | Project-root creator; project_key, requirements_hash, proposal_hash. | Immutable complete canonical material plan and predecessor. |
| plan_activation | Project-root creator; project_key, proposal_key. | Sole current authority for exact proposal key/hash; predecessor activation keys. |
| project_link | Offer: publisher-root creator. Request: project-root creator. link_kind, project_key, publisher_key; requests also activation_key. | Validated discovery hints, never consent/admission authority. |

Root keys use typed key attributes, hashes bytes32, link kind str. Names never establish identity. Validate creator/current owner/flags/schema/chain/scope/projections before trusting records. Transferred foreign records fail authenticity; owner different from creator makes this workflow unavailable. Wallet authorship is not verified human identity or Sybil resistance.

## Immutable current states

Consume-and-replace uses one native atomic create-new/delete-exact-old batch. A successful competing transition consumes the expected key, so another stale transition fails. This is an existence precondition built from native mutations, not a patch CAS API or multi-owner lock. The chain does not prevent malicious owners from creating forks.

Complete scope: one authentic head is usable, zero unavailable, several Conflict. Never choose highest revision/newest timestamp/cached former head. Explicit owner fork resolution consumes every reviewed head; a race requires rereading, not automatic overwrite. Initialization persists root_pending → root_confirmed(exact key) → initial_state_pending → initialized. Reconcile unknown sends and resume the missing phase; never create a second root because response was lost. A shareable invitation requires confirmed root and state.

## Drafts, activation, history and consent

project_state.recipe is an editable draft. The immutable proposal selected by unique plan_activation is the agreed/proposed package. deriveDraftStatus compares them. If different, Needs editing displays “Draft changes — not agreed” and “View agreed plan”. An old Agreed badge never labels new draft requirements. Readiness validates active immutable terms, not a newer recipe.

EVERY material promotion creates a NEW proposal and NEW activation, consuming the exact former activation. Persist proposal_pending → proposal_confirmed → activation_pending → activation_confirmed → fanout_pending → complete, including each request link step. Resume incomplete delivery without republishing/activating. Nonmaterial progress preserves activation; a proposal merely existing is not active.

PlanDocument.predecessor is the immediately preceding active SourcePlanRef (projectRoot, activationKey, proposalKey, proposalHash), null only for initial publication. Restoring old terms creates P3 parented to P2, never reactivates old P1 or skips linear history. A created proposal may be reused during reconciliation only while its parent remains current or its original activation is already confirmed. Restart uses completion.source as predecessor. Prior completion may stay historical in open state, but readiness.outcome is null until closed. Recipe reuse creates a NEW root with null predecessor.

Fresh readers walk immutable predecessor proposals at one block B, validate creator/project/hash, reject cycles, bound traversal and return chronological proposalHistory plus separate proposalHistoryStatus. P1→P2→P3 and diffs must work without Studio cache or storage. Missing/expired history is an explicit gap; it does not poison complete current readiness unless unavailable evidence is needed for current remaining work. There is no permanent readable archive promise.

Decisions/grants bind EXACT activation entity key AND proposal key/hash/project. A valid book has at most one decision per(projectRoot,activationKey). Acceptance atomically records accepted decision plus exact grant while consuming previous book. Decline/withdraw records a durable decision and removes its corresponding grant. Accepted without valid matching grant is not agreement; contradictory duplicates invalidate. Every newly activated plan requires fresh approval from EVERY required party, including unchanged contributors. Historical decisions do not approve new activations. Explicit reacceptance of the same still-live activation requires full fresh validation.

## Canonical material and solver

Canonical JSON: UTF-8, lexicographic object keys, NFC strings, normalized newlines; no undefined/nonfinite values or floats in integer fields. Reject unknown fields and duplicate/NFC-colliding IDs. Documented defaults normalize optionals. Set-like arrays use stable IDs; meaningful runbook sequence stays explicit. Keccak256 hashes the entire domain-separated document. Golden fixtures support independent clients.

Material: protocol/validation/chain, project/outcome, selected variant/venue/timezone, exact requirements/units/quantities/intervals, selected offer IDs/hashes, resource assumptions, allocations, conditions/instructions, independently derived approvers, explicit tasks/dependencies/transfers and predecessor. Excluded: book keys, progress/receipts/decisions/cache timestamps, unselected alternatives. Hash equality never replaces independent constraint validation.

Intervals are half-open [start,end), UTC integer milliseconds. Quantity/capacity positive integers with units. Availability covers each allocation without gaps. Personal offers share publisher self resource capacity one. Equipment allocation reservation covers handover through planned return, including time after required use. Required-use interval is contained within reservation; availability/capacity/hash/grants cover whole reservation.

Deterministic finite solver supports arbitrary valid recipes/date/venue variants/offers and typed requires/excludes/capability/allowed-variant/allowed-venue conditions, dependencies and capacity. No executable user conditions. Independently validate every candidate. Repair rank is lexicographic: removed publishers, variant changes, changed allocations, changed assignments, stable-ID tie break. Exhausted budget yields exhausted or candidate optimality not_proven; never false impossible/minimal. Explicitly name transfer participants/duties before publishing; never infer receiver from project identity.

Small Works: boards and installation kit already delivered before10:00; installation10–12; simultaneous transport brings ARTWORKS with carrying equipment; hosting12–16 depends on both. Cedar cannot install and transport simultaneously. Oak transport makes whole plan possible; Juniper installation later lets Cedar transport. Fixture days17/18October2026 Europe/London. Head count alone does not prove physical feasibility.

## Readiness, capacity and expiration

Agreement health: possible, awaiting_approval, declined, ready, changed, conflict, unverified. Lifecycle planning/in_progress/closed, outcome completed/completed_with_outstanding/cancelled and evidence availability remain separate. Ready means exact compatible plan with all valid owner grants at block B; not escrow, multi-owner lock, institution verification or physical completion.

Use B timestamp, complete scopes, exact hashes/conditions/dependencies/capacities and all overlapping grants/custody restrictions. Unexpired grants reserve capacity before everyone agrees. Candidate same-project replacement removes its owner's previous project grant hypothetically and counts candidate once; actual swap is atomic. Only owner release/replacement or consent deadline ends timed hold; coordinator cancellation cannot erase it. Deadline covers last accepted duty including return.

Arkiv expiresAtBlock is not a guaranteed UTC date. At B every required entity must be live. Write admission requests storage duration covering consent duration plus safety margin using nominal chain time; future UTC coverage remains an estimate. Storage extension never extends/revives consent. Natural expiration has no event; periodic fresh reads are necessary. Failed/stale refresh shows Unverified and dated last-known data.

Missing-book recovery keeps SAME publisher root only while root is live, authentic and creator-owned. After a fresh complete zero-head read, owner submits expectedHeads=[] and recovery={acknowledgedMissingState:true,redeclaredAvailability:true} to create an EMPTY book. No cached resources/offers/grants/decisions/attestations/custody are restored. Redeclare current availability before offering. Known project facts about outstanding equipment remain unresolved; absence never means returned. Expired/deleted/invalid-authority root requires a NEW publisher identity and explicit project readmission. Concurrent first recovery may fork and must show Conflict.

## Execution, custody, closure and reuse

Attestations are separate authored assertions. Task report binds exact source/obligation and own party. Coordinator completedWork references are not proof; empty/unavailable attestations cannot fabricate completion. Missing supporting historical evidence is labeled explicitly. Remaining-work repair retains completed facts and includes outstanding duties only, with fresh agreement for all new material terms.

Transfer report binds transferId/source/obligation/resource/positive quantity/unit/giver/receiver/action. Receiver ack binds statement hash and quantity<=sent. Return is opposite named transfer plus acknowledgement. Partial quantities stay partial; corrections reference original and cannot impersonate other side. Return credits match actual transfer/chronology: old return cannot release later handover. Reconciling project B cannot reopen resolved holds in A.

Physical custody hold is separate from timed approval. Known outstanding owner equipment cannot be reused by another project until owner-authored return acknowledgement or explicit corrected availability. Avoid same-project double counting. Time/closure/missing cache never implies physical return. These are participant assertions, not proof of actual possession.

Closure/cancel atomically creates project_state, consumes prior state AND current activation. Closed history expects no live activation and displays outcome/evidence/outstanding work. Honest completed_with_outstanding/cancelled does not invent reports. Restart requires new proposal/activation and fresh decisions. Reuse clears dates/parties/allocations/consent/execution into new draft. Export/import never imports third-party authority.

Retain demonstrated project statements for declared90day policy while entities remain live. Measure encoded bytes: SDK131072byte limit, app target<=120KiB. Refuse silent data loss; explicit export/archive states evidence degradation. Deletion/expiry cannot erase external copies. Export dated UTF-8 JSON and standalone printable HTML with exact source/timezone/status/exceptions.

## Complete queries and discovery

Read head B once; pin all related queries to B. State scopes use typed namespace/type/root and immutable creator; roots/proposals exact keys. Cursor completion establishes uniqueness; multiple authentic heads prove conflict early. Cursor/quota/schema/page-budget/RPC failure is not empty success or proof of impossibility. Optional discovery failure cannot remove known required parties. Current snapshot and historical-chain completeness are separate.

Fresh own-publisher query uses creator. Invitation→create/select publisher→edit own book→offer link. Studio validates hint/publisher/book; coordinator explicitly admits publisher root to project_state. Activated plans fan out request links. Fresh Desk queries publisher_key/link_kind=request, authenticates coordinator/current source, opens full plan. Stale links are historical, valid duplicates collapse by canonical identity, invalid hints carry diagnostics. Direct project ID works without app account database or watched-project cache.

## Clients and durable operations

Studio, separately built Partner Desk(desk.html/dist-desk) and fresh-process CLI share published protocol/domain code and talk directly to Arkiv. Desk has own runtime/storage/wallet, normal offers/requests, no Studio entry/server/API dependency. Independent proof stops Studio, uses fresh Desk/CLI context and compares actual records at common block.

Public writes use participant injected EOA wallet, explicit account and Tiramisu recheck. Reading/drafts/local practice need no wallet. Local roles are labeled simulations, never network consent. No public/loopback shared signer. Synthetic evidence keys stay outside Git/browser; only MAIN broadcasts reviewed commands.

Freeze full command, operationId, authority, lifetime and expected keys; persist before effects. Capture original send hash immediately, prevent SDK fallback duplicate sends. Verify original transaction calldata, actual receipt status/events and exact readback; replacement receipts or echoed deleted keys alone are insufficient. Unknown outcome reconciles original hash/ID/creator first. Mined revert is terminal reverted, distinct from not_sent; partial prior successful phases remain recorded. Storage failure never resets uncertainty. Account/chain changes clear live authority without losing drafts.

All demonstration data synthetic; no real private contact/address/calendar data or hashes. Public storage/expiry explanation at input boundary. UI/errors/help/aria/export/public docs English-only.

## Evidence and competition scope

Verified primitive: createA block352006, replaceAwithB352065, staleA→C estimate exact EntityNotFound(A), onlyB live352164; arkiv/evidence/atomic-transition.json. No paid stale send/mined rollback test. Official native documentation establishes all-or-none guarantee. Bootstrap+probe actual total0.000326176000652352testGLM within0.1 ceiling. Journals never reset/rerun blindly.

Required product checks: fresh unknown publisher invite/admission/request/decision; uncached P1→P2→P3 history/diffs; same-root expiry recovery/new-root fallback; draft cannot inherit Agreed; second-project capacity/stale writer; withdrawal/repair/full reapproval; activation replay; expiry/deadlines; partial transfers/returns/honest closure; interrupted multistep reconciliation; malformed/foreign/forked/incomplete data never Ready; reuse no inherited authority. Label local/mocked versus live evidence.

Open Source primary and Censorship Resistance secondary use SAME product and independent-client evidence. CR claim is removal of Studio-host/API dependence for public participation/verification, matching official rubric. No claim of RPC/indexer censorship resistance, protection from owner withdrawal/deletion/expiry or bypass of coordinator admission. No extra features solely for second track.

Sources: official native mutations https://docs.arkiv.network/json-rpc/mutating-entities/ ; querying https://docs.arkiv.network/json-rpc/querying-data/ ; installed SDK0.8.1 ; external upstream/scoring-rubric.md. Public schema/friction must match final implementation and evidence.
