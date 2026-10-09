# Synthetic public proof runner

This operator-invoked helper exercises the production Arkiv repository, SDK serializer, wallet gateway, operation journal, domain solver and independent CLI. It does not use a browser or the Studio server. The fixtures and automated tests are **not live product evidence**. No public product transaction, signer initialization, or deployment was performed while writing this helper. Execution is deferred until the user resumes work.

Run from the repository root. These checks use isolated fixtures and never access demonstration keys or the live network:

```powershell
node node_modules/typescript/bin/tsc --noEmit --project tests/arkiv-live/tsconfig.json
node --import tsx --test tests/arkiv-live/safety.test.ts
node node_modules/vitest/vitest.mjs run --config tests/arkiv-live/vitest.config.ts
```

## Operator commands for the resumed session

The default command reads the official Tiramisu chain identity, genesis and coordinator balance, and prints the proposed transaction counts. It creates no signers and sends no transactions:

```powershell
node --import tsx tests/arkiv-live/runner.ts --phase prepare
```

Only after resuming the authorized proof, initialize nine dedicated synthetic publisher signers locally. This command creates sensitive ignored files under `.local/product-proof`; it does not broadcast or load the coordinator secret. It refuses to reset existing state or a spend ledger:

```powershell
node --import tsx tests/arkiv-live/runner.ts --phase prepare --initialize
```

Run one phase at a time. Omitting `--broadcast` performs the next feasible real SDK preflight/estimate and stops before wallet admission. This can persist its original frozen command and prepared operation locally. It cannot simulate unknown entity keys from later transactions. Before each broadcast invocation, commit and review **all** source changes; the runner requires an entirely clean worktree and an exact 40-character `HEAD` supplied through `--reviewed-commit`.

```powershell
node --import tsx tests/arkiv-live/runner.ts --phase fund
node --import tsx tests/arkiv-live/runner.ts --phase fund --broadcast --max-transactions 1 --reviewed-commit <reviewed-HEAD>
```

Replace the placeholder with the actual reviewed commit. Repeat the same phase command to resume; do not delete state, edit a frozen action or invent a new ID after uncertainty. The default per-invocation limit is one transaction; the hard maximum is 32. Reaching the limit is a normal checkpoint and never starts the next phase automatically.

| Phase, in order | Planned transaction maximum | Verified result |
| --- | ---: | --- |
| `fund` | 9 | Nine dedicated accounts receive 0.005 test GLM each |
| `publish-core` | 24 | Project, seven independent publisher roots/books, scoped offers and explicit admission |
| `discover-oak` | 5 | Oak is discovered through an authored offer link before coordinator admission |
| `p1-propose` | 9 | P1 proposal, activation and seven request links; zero current approvals |
| `p1-accept` | 7 | Seven exact P1 approvals; Ready |
| `withdraw-oak` | 1 | Oak withdraws current consent; Changed with six approvals |
| `discover-juniper` | 5 | Juniper is independently discovered and admitted |
| `p2-propose` | 9 | P2 repairs assignments and names P1 as its predecessor; zero current approvals |
| `p2-accept` | 7 | Seven fresh P2 approvals; Ready |
| `p3-propose` | 9 | New P3 restores P1 material terms and names P2 as predecessor; zero current approvals |
| `p3-accept` | 7 | Seven fresh P3 approvals; Ready with P1 → P2 → P3 lineage |

The planned total is 92 sends. Every transfer principal, every paid receipt fee, and each unresolved maximum reservation counts against the global 0.1 test GLM ceiling, including the earlier **0.000326176000652352** test GLM capability probes. Counting child funding and child fees is deliberately conservative. Current SDK estimates receive a 20% gas allowance, capped at 2,000,000 gas and 2 gwei max fee. Failed mined transactions still cost gas. Exceeding a cap stops the run.

The public snapshots use synthetic October 17–18, 2026 London activities. The runner must not be used as a current readiness demonstration after those activities or consent deadlines; a new reviewed scenario is then needed. Entity lifetime is nominal 90-day storage admission, not a guarantee of UTC retention or physical availability.

## Interruptions and independent verification

The same root-account mutex is shared with the earlier capability helpers. An invocation also locks its run and all publisher accounts. The ledger persists its reservation before loading a key and the signed transaction plus original hash before the only raw send. RPC retries and automatic replacements are disabled. An uncertain original hash blocks further sends; resuming reconciles that hash against the canonical receipt and the exact frozen call. The application separately authenticates native events, typed entity projections, creator/owner, read-only flags and read-back. A partial multi-step operation can resume a later **canonically reverted** phase on a later explicit invocation while retaining its confirmed root/proposal/activation. An unknown outcome cannot be retried as a fresh operation.

Every Awaiting/Ready/Changed checkpoint starts a fresh Node CLI with a minimal environment and pins it to the same canonical block as the repository export. It compares the active proposal, hash, activation, accepted owners and reachable lineage. Failed verification prevents phase completion. Local journals retain signed bytes and commands; public export includes only public addresses, references, receipts, cost summaries, authored discovery records and dated verification packets.

To verify after the operator has actually stopped Studio, use the following flag as an explicit operator declaration. The runner does not inspect or stop application processes and does not claim to prove that declaration automatically:

```powershell
node --import tsx tests/arkiv-live/runner.ts --phase verify --studio-stopped
```

After every phase has completed, export a new evidence file; existing files cannot be overwritten:

```powershell
node --import tsx tests/arkiv-live/runner.ts --phase export --output arkiv/evidence/product-proof.json
```

For a standalone public project read, the independent CLI accepts:

```powershell
node node_modules/tsx/dist/cli.mjs src/cli/verify.ts <public-project-root> --json
node node_modules/tsx/dist/cli.mjs src/cli/verify.ts <public-project-root> --json --block <recorded-block>
```

`--block` proves a dated historical snapshot; it never asserts present readiness. User visual/browser review remains unperformed by these tools.
