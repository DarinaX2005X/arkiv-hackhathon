# 01 Надёжная основа общего плана
Status: todo

## 01.1 Общие контракты, интерфейс и сохраняемая работа
Status: todo
Requirements: R01, R12, R13
Depends on: none
Owner: SUBAGENT to assign
Paths: src/domain/types.ts, src/data/types.ts, src/app/, src/ui/, src/i18n/, src/styles/, public/, index.html, package.json, package-lock.json, tsconfig.json, vite.config.ts, vitest.config.ts

Outcome: every subsequent surface uses one vocabulary, visual language and retained draft/session state. MAIN temporarily loans exactly these shared foundation paths to one worker before any dependent writers start. Worker reads PROJECT/DESIGN/PROTOCOL, installs only reviewed compatible pinned dependencies, and hands back the shared contract for MAIN review. No later worker redefines DTOs in a feature.

Inputs/results: English/Russian locale, local/public mode, account and chain context, route, draft versions and network freshness. Create the discriminated domain DTOs and Repository Result contract described in PLAN. Public account is an address, never a private key; local roles use a distinct type and cannot be cast to network authors. Persist only validated JSON with a format version. Unknown versions produce recovery/export guidance, not destructive reset. Quota/storage failures remain visible and preserve in-memory work.

App shell exposes Projects, My contributions, Requests, Help and a clear language switch. Feature modules register via MAIN-owned routes after handoff. Connect boundary keeps intended destination and draft. Shared async/action model distinguishes validating, awaiting-wallet, submitted, reconciling, confirmed, rejected, failed-before-send and unverified. Do not expose a success message based solely on a transaction hash. No fake home dashboard counts or fabricated projects.

Accessibility: actual labels, keyboard order, focus-visible and dialog return focus; 44px targets, wrapping Russian controls, narrow-screen single-column content and reduced motion. Self-host verified IBM Plex Sans400/500/600 plus license; tokens and source SVG from canonical DESIGN. User alone confirms appearance/browser behavior. Do not add a browser testing package.

### 01.1.1 Freeze runnable foundation and shared declarations
Status: todo

Create manifest/scripts/config and DTO/API declarations from PROTOCOL. Implement pure input bounds and tagged IDs; render a truthful app shell with real navigation and no advertised unimplemented actions. Add shared locale/catalog registration and mode/account context contracts. Run typecheck, bootstrap tests and production build; contract completeness is reviewed by MAIN before dependent assignments. Commit covers pinned dependency/config/contracts, not arbitrary unfinished feature files.

### 01.1.2 Shared controls, identity and state preservation
Status: todo

Implement tokens, fonts/license, mark, primitives and validated draft store with import/export recovery. Check locale key parity, numeric/time formatting at DST boundaries, local/public ID separation, storage-failure retention and static keyboard/label contracts. Demonstrate data-based navigation state survives locale/account changes; browser focus and responsiveness remain user checks. MAIN updates ordinary check/checkpoint command only with real runnable checks.

## 01.2 Вычислить выполнимый план и честное состояние согласия
Status: todo
Requirements: R03, R04, R05, R06, R07, R09, R10
Depends on: 01.1
Owner: SUBAGENT to assign
Paths: src/domain/solver.ts, src/domain/validation.ts, src/domain/canonical.ts, src/domain/readiness.ts, src/domain/execution.ts, src/domain/operations.ts, src/domain/fixtures.ts, src/domain/index.ts, src/domain/__tests__/, src/data/local.ts

Outcome: real generic mechanism works for sample and arbitrary user-entered cases, with trustworthy state and local practice using the same rules. Shared types.ts is read-only; additions requested through MAIN. No React/SDK dependency, no hardcoded Oak/Juniper event branching.

Inputs: explicit project variants; typed requirements with quantity/unit, interval and allowed capability; publisher resource capacities, offers, availability, exclusions/dependencies and active grants; optional preserved assignments; search budget; current canonical timestamp. Offer prose is a human-reviewed note, never executed as a condition. All numeric fields are bounded safe integers and intervals must be positive. Resource identity is publisher root plus resource ID, not display name. Same person's labor shares self capacity one; ending at12:00 and starting at12:00 is compatible.

Result: complete candidate assignments or typed shortages/conflicts, stable rank tuple and optimality/search-completeness flags. Enumerate finite variants and allocate requirement units with pruning, ensure final candidates independently pass validatePlan. Search exhaustion can return a valid found plan with optimum unproven, never false impossibility. Pins are constraints; incompatibility produces a reason rather than silently dropping pins. Repair preserves owners, then variant/date, then allocation changes with stable deterministic tie-break. All materially changed plans have a new canonical hash and need all fresh decisions.

Readiness verifies complete current trusted snapshot, referenced offer hashes, actual allocations and capacity including other projects' grants, exact activation-bound decisions/grants/deadlines, stable domain version and lifecycle. A selected offer change breaks readiness; unrelated book progress/additional offer need not. Decline, awaiting, changed, conflict and unverified remain distinct, persisted in separate exact-activation book decisions. Acceptance atomically records matching decision+grant; decline/withdraw removes its grant. Include reload/CLI tests. Lifecycle and current agreement are orthogonal; historical completed work is never invalidated by later expiry. No optimistic green or archive fallback.

Execution includes immutable task IDs and assertions separate from approval grants. Withdrawal removes current grant, preserves previous task statements. Handover matches exact plan/task/resource/quantity, giver and receiver authors; sender report and receiver receipt are distinct. Completion allows explicit outstanding items, never fabricates return. Cancellation stops activity and asks owners to release grants; it does not mutate other books. Reuse copies recipe only with cleared dates, selected parties, grants and progress.

### 01.2.1 Generic solve, explain and compare
Status: todo

Implement strict validation and canonical encoding with domain separators. Build solver plus independent assignment evaluator. Create Small Works fixture: boards are already at venue; transport moves artworks while display boards are installed. Sunday starts with Cedar overlap, Oak makes it feasible; Saturday misses two boards. Test arbitrary fixtures against independent exhaustive oracle for small search domains, partial quantities, excluded combinations, overlapping and adjacent intervals, availability end boundary, pins and search exhaustion. Tests must not merely invoke the solver as their oracle. Check repeatable ordering and canonical hash stability across property insertion order/locales. Commit solver/validation/fixtures with real proof.

### 01.2.2 Consent, recovery, execution and local repository
Status: todo

Implement domain transitions, cross-project holds, plan diff, remaining-work repair, attestation matching and recipe reuse. Implement Local Repository with realistic distinct synthetic actors, persistence, input validation and same operation errors. Custom projects start with no imaginary contributors; practice reset affects only practice. Cover all16 PROJECT acceptance cases at domain layer, including foreign decisions, revision replay, capacity changes, offer-free edit, missing/fork data, withdrawal retains completed work, receiver mismatch and cancelled hold release. Tests include book edit while another project is accepted. Integration handoff provides typed action/result examples for UI and adapter workers.

## 01.3 Читать и изменять собственные данные через Arkiv
Status: todo
Requirements: R02, R08, R12, R14, R15
Depends on: 01.1, 01.2
Owner: SUBAGENT to assign
Paths: src/data/arkiv/, src/data/operations/, src/data/wallet/, src/data/__tests__/, src/cli/, arkiv/schema.md, arkiv/friction.md

Outcome: public projects and participant books use actual Arkiv, with independent verifier available before user-facing proof. SDK0.8.1 is pinned. Implementation proceeds only after atomic probe passes exact expected failure and MAIN freezes updated schema. No arbitrary EVM contract, custody backend or public test signer.

Inputs/results: root key and expected authority; verified common block/timestamp; typed payload projections; expected prior heads; frozen operation ID and normalized data; connected wallet address/chain. Match root/key/immutable creator/current owner/readonly flags/contentType/schema/hash/projection/liveness. One live head required per current state/activation scope; zero unavailable (except closed history expects no activation), multiple conflict. Query scopes always include namespace/type/root and known creator. Complete page walk at fixed block; cursor/RPC/rate/budget errors discard confidence. Foreign data with copied attributes cannot impersonate a trusted publisher.

Native transitions create new readonly state and delete all explicitly reviewed expected old heads atomically. Initial root then initial state is resumable and missing-init stays unverified; it never silently becomes an empty authoritative book. Current heads keep audit assertions distinct from grants. Proposal creation and activation are resumable operations with receipt keys; every promotion consumes previous activation and grants bind its unique new entity key. Terminal closure atomically consumes activation with project_state replacement. P1→P2→P1 replay must require fresh decisions. Project links enable incoming offers and per-publisher requests without becoming authority. Owner alone resolves their fork; stale expected predecessor fails and prompts re-read, not auto overwrite. No automatic fallback to a consumed/expired predecessor.

Operation controller freezes intent before wallet prompt, records available hash immediately, disables duplicate submits and reconciles uncertain receipt/query outcomes by original creator/operation/hash. Cancellation before send is distinct from timeout after send. Wallet account/chain/disconnect changes clear signing authority but retain draft. Estimate gas/expiry and show bounded fee when provider supports; inability to estimate is not presented as zero cost. Public deployment never contains keys.

Every current read records block/time/freshness. Default refresh interval15s and maximum current-confidence age60s; failures immediately show unverified with dated last-known content. Canonical block timestamp drives deadlines, Arkiv block expiry remains separate. Read limits are explicit defensive bounds and surfaced as incomplete, not empty. Expiry warnings lead to owner renewal action with estimate; retention of proposal/root is not promised forever.

### 01.3.1 Strict reader and standalone CLI
Status: todo

Implement runtime schemas for all seven entity types, projections, pinned queries, pagination, trusted aggregate and typed failures. Implement listOwnPublishers/listIncomingOffers/listRequests and project_link validation. Exercise unseeded invitation→new publisher→offer link→organizer admission→active plan request→fresh Desk discovery; no shared local storage. Add CLI verify/export against only official RPC with root arg, machine-readable JSON and human-readable summary; it prints block, verdict, reasons and provenance. Tests with deterministic RPC fixtures cover wrong creator/owner/flags/hash, missing roots/state, multi-head, page truncation, fresh-read failure and natural expiry. MAIN compares one actual bootstrap/probe query to recorded evidence; it is labeled feasibility, not product proof. Update schema with exact types, useful indices, sample payload and reproducible query.

### 01.3.2 Wallet writes, safe reconciliation and lifecycle
Status: todo

Implement create/init, proposal/activation, project_link offer-sharing/request-fanout, terminal closure/activation consumption, consume-and-replace, fork resolution and owner renewal. Persist each incomplete phase and reconcile prior keys before advancing. Validate domain state before signing and recheck identity/chain at admission. Persist pending state before dispatch; reconcile same operation on reload and forbid blind duplicate create. Cover lost response, rejection, stale head, successful create with failed promotion, root-only interrupted init, capacity conflict and current-state expiry in unit/provider tests. No live send in automated test suite. MAIN alone reviews/executes bounded synthetic evidence later. Record SDK friction as observed vs source-derived, not invented user experience. Handoff includes complete direct-network call map and methods used by both Studio and Desk.

