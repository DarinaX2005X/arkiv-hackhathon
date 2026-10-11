# Explicit synthetic event seed

This operator helper prepares three fictional public events and nine synthetic wallet registrations through the production core and event repositories. It uses no browser, real attendee identity, physical venue booking, live meeting link or funding transfer. Importing it is inert. Its default command only reads existing public proof state and prints scenario material and sanitized cumulative costs; it never loads a signing wallet.

The events are Sketchbook exchange (October 24, online, UTC), Bookbinding at a shared table (October 25, Almaty, Asia/Almaty), and Community audio walk workshop (October 26, hybrid, London, Europe/London). Descriptions begin with an English synthetic disclosure. The exact first line `[PARTFOLK TEST EVENT]` in existing `conditions` lets compatible Partfolk clients show **TEST EVENT**. This is an authored declaration about example data, not a security certification. It is part of the ordinary audience hash, with no new schema fields or attributes. Earlier audience hashes remain valid.

One new dedicated publisher root on the already funded synthetic Ash wallet owns the fictional preparation resources. Three new project roots each pass the real solver, request fan-out and exact owner acceptance before event publication. Original proof books and state are not replaced. The synthetic attendee aliases in the public manifest refer only to test wallets; attendance payloads retain the existing wallet-only schema.

There are exactly **43 authorized seed sends**, all with zero transfer value: publisher root/book (2), material book (1), three project root/state pairs (6), offer links (3), coordinator admissions (3), proposal/activation/request fan-out (9), contributor decisions (3), event release/state pairs (6), attendee decisions (9), and one limited roster confirmation (1). The bookbinding event confirms three exact requests and keeps one explicit waiting-list request. A request alone is not a confirmed place.

Every entity uses a nominal 90-day lifetime, and contributor grants remain valid through October 29. Dates, duties and public terms deliberately agree in this scenario; the general protocol does not infer that correspondence from a ready flag. Storage deadlines are observed block numbers, not guaranteed UTC retention. The helper refuses to seed the dated scenario once its first registration deadline has passed.

## Offline checks

These commands use only controlled fixtures and never read wallet or operator access-key files:

```powershell
node node_modules/typescript/bin/tsc --noEmit --project tests/arkiv-live/tsconfig.json
node node_modules/vitest/vitest.mjs run --config tests/arkiv-live/vitest.config.ts tests/arkiv-live/event-seed.test.ts
```

The fixtures cover all 43 native sends, exact preparation readiness, authenticated catalog filters, clean reader/My events return, managed admission, fresh October 23 reads, a lost release response and original-command resume, schema/hash binding, shared serialized journal continuity, default/invocation/total ceilings and cumulative-budget refusal before signer loading. The full fixture uses the production memory journal; a separate round-trip checks the serialized browser journal shared by the operator helper. These are controlled-provider checks, not public network evidence or visual acceptance.

## Operator workflow

Run from the repository root. Preparation is read-only and can run before the original proof has finished:

```powershell
node --import tsx tests/arkiv-live/event-seed-runner.ts
```

Seed writes require the original P1/P2/P3 proof to finish, its `arkiv/evidence/product-proof.json` export, scoped code review, an entirely clean worktree, and the exact reviewed commit. MAIN is the only operator authorized to broadcast. The original `0.1 testGLM` cumulative ceiling remains unchanged. Paid probe fees, prior funding principals, all transaction fees and unresolved maximum reservations still count. Forty-three sends is not a promise of their cost. The existing safety layer estimates each exact call with its gas margin, reserves the capped cost before accessing a signer, and refuses unaffordable or over-budget admission. There is no funding command or automatic fee replacement.

```powershell
node --import tsx tests/arkiv-live/event-seed-runner.ts --phase seed
node --import tsx tests/arkiv-live/event-seed-runner.ts --phase seed --broadcast --max-transactions 1 --reviewed-commit <reviewed-HEAD>
```

The first seed-phase invocation freezes ignored `.local/product-proof/event-seed-state.json`. Repeat the same command to resume; never delete or reset it after interruption. An invocation defaults to one forwarded transaction and permits at most 32. The whole seed permits at most 43, including any paid failed attempt. A failure can therefore require operator review rather than an extra send.

Budget and application evidence use the **original** `.local/product-proof/budget.json` and `operations.json`, with store key `partfolk-product-proof-v1`. The state file alone cannot establish an unsent or completed action. Confirmed actions are skipped only when their exact commands, ordered keys, app receipts, native admissions and reconciled cumulative budget agree. Missing or changed evidence stops progress. Unknown original hashes are hydrated and verified; no fresh operation ID, duplicate release or automatic raw rebroadcast is used.

The CLI-only operator RPC uses the fixed official endpoint. If `.local/arkiv-access-key.txt` exists, the transport sends its value only in `X-API-KEY`, with redirects and retries disabled. It is never printed, placed in browser code or exported. Local signer files are opened only after explicit broadcast admission and budget reservation. Account/run mutexes prevent concurrent original-proof and seed writers on this host.

After all sends finish, independent read-only repositories must verify the current source, terms, roster and registrations before public evidence export:

```powershell
node --import tsx tests/arkiv-live/event-seed-runner.ts --phase verify
node --import tsx tests/arkiv-live/event-seed-runner.ts --phase export --output arkiv/evidence/test-events.json
```

Export creates a new file and refuses overwrite. It includes synthetic aliases/public addresses, project/release/source references, canonical snapshots, public source dependencies and observed expiration blocks, roster evidence and the sanitized cumulative cost ledger. It excludes private keys, signed bytes, calldata and operator credentials. No live seed broadcast or UI verification is claimed by this source and its fixture results.
