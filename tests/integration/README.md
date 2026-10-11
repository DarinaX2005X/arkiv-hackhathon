# Repository acceptance tests

These Node tests exercise the production repository, solver, agreement and feature-command contracts. They do not launch a browser, render the interface, contact Arkiv, sign transactions or claim live-network evidence.

Run from the repository root:

```sh
node node_modules/typescript/bin/tsc --noEmit -p tests/integration/tsconfig.json
node node_modules/vitest/vitest.mjs run --config tests/integration/vitest.config.ts
```

`custom-project.test.ts` starts with empty serialized storage. Independent `LocalRepository` instances create a new listening session, register previously unknown contributors, share offers, explicitly admit them, publish the complete proposal and its requests, and record each owner's separate decision. Its data differs from Small Works: three listening stations, one person in two adjacent roles, a different date and `Europe/Paris` time zone. It verifies complete assignments, canonical hash, exact missing-owner reasons, saved consent and export read-back. A one-millisecond schedule overlap must remain impossible with the chosen assignment pinned.

`repair-delta.test.ts` uses the real persisted guided actions to verify the exact Small Works repair explanation. Only Oak's transport and Cedar's installation are replaced by Cedar's transport and Juniper's installation. The other allocations remain equal, while every required owner has a missing decision on the new activation.

## Calculation and agreement acceptance map

Existing focused tests remain the evidence for behavior already covered; this directory does not duplicate their assertions to increase test counts.

| Contract | Exact test evidence |
| --- | --- |
| A newly saved project is not yet proposed; a previously published plan stays unavailable after its proposal and activation expire, even with an empty live history | `custom-project.test.ts`: `keeps a newly saved draft distinct from a plan whose activation went missing`, `does not relabel expired proposals as never initialized when no live history remains` |
| Saturday is short of two boards; Sunday identifies Cedar's conflicting personal capacity and either useful additional role | `src/domain/__tests__/canonical-fixture.test.ts`: `explains Saturday two-board shortage and Sunday simultaneous Cedar capacity` |
| Oak makes the complete Sunday plan feasible; ending one minute early does not cover transport | Same file: `Oak transport makes Sunday feasible without pretending boards are transported simultaneously` and `one-minute-short transport cannot cover the requirement`; `src/features/projects/projects.test.ts`: `uses the actual generic Small Works conflict and full Oak assignments` |
| Adjacent personal shifts work; overlap and impossible pins do not silently change the requested assignment | `custom-project.test.ts`: both complete-flow and saved-overlap cases; `src/domain/__tests__/solver-oracle.test.ts`: `allows adjacent reuse and rejects overlap and availability gaps`, `honors quantity pins and never drops an incompatible pin` |
| Unknown contributor offer discovery requires explicit organizer admission; request links identify the exact activation | `custom-project.test.ts`: complete-flow case; `src/domain/__tests__/local.test.ts`: `discovers a previously unknown publisher and exact requests across independent clients` |
| No inferred consent; each exact owner is required, and a foreign actor cannot decide | `custom-project.test.ts`: complete-flow case; `src/domain/__tests__/consent-execution.test.ts`: `has no inferred agreement; only the owner can accept and decision+grant count together` |
| Decline and withdrawal remain distinct after reload | `src/domain/__tests__/local.test.ts`: `records decline and withdrawal durably without another publisher gaining authority` |
| P1 agreement, Oak withdrawal, Juniper repair and fresh agreement survive independent repository reloads | `src/features/practice/__tests__/guided.test.ts`: `moves a genuinely impossible project through owner agreement, withdrawal, repair and fresh agreement`, `derives every stage after reload and makes repeated completed actions durable no-ops` |
| Repair reports the exact changed assignments, retains the others, changes the canonical hash, and requires all seven owners again | `repair-delta.test.ts`; `src/features/execution/execution.test.ts`: `finds Cedar transport, Juniper installation, Willow unchanged and resets all agreement` |
| P1 → P2 → restored P1 terms and close → reopen cannot revive old grants | `src/domain/__tests__/local.test.ts`: `requires exact current proposal lineage and consumes activation on terminal close`; `tests/arkiv-live/scenario.test.ts`: `proves P1 agreement, Oak withdrawal, P2 repair, and P3 restore with three distinct exact agreements` |
| Changing selected offer terms invalidates agreement; unrelated offers and draft edits retain the immutable active agreement | `src/domain/__tests__/consent-execution.test.ts`: `preserves readiness for unrelated offers and changes it for selected terms`, `keeps active consent bound to immutable terms while exposing selected draft changes`; `src/domain/__tests__/local.test.ts`: `keeps active consent through a draft recipe edit and an unrelated offer edit` |
| Progress is separate from the agreed plan, and its correction remains owner controlled | `src/features/execution/execution.test.ts`: `records only the actor’s task and keeps self-report separate from acknowledgement`; `src/domain/__tests__/canonical-fixture.test.ts`: `selected offer hash ignores unrelated book progress and includes owner identity` |
| Public invitation parsing, independently authenticated discovery and foreign-wallet refusal | `src/desk/desk.test.ts`: `accepts generated public project links and all shared contribution destinations`; `src/data/__tests__/arkiv-reader.test.ts`: `discovers an unseeded participant, requires coordinator admission and fresh consent across independent reader instances`; `src/data/__tests__/arkiv-writer.test.ts`: foreign authority checks. The RPC fixtures are deterministic transport inputs, not real network writes. |

## Boundaries

The local custom-project test passes real serialized records between new repository instances; it does not establish independence of a running Partner Desk process or public wallet signatures. Public reader/writer and operation-failure tests cover those adapter contracts separately. Live transactions and independently queried public evidence have their own explicitly authorized runner under `tests/arkiv-live/`.

The user verifies visible explanations, discovery of the next action, role and revision review, keyboard/focus behavior, responsive layout, and visual/export appearance. A passing test here does not close those user-owned checks.
