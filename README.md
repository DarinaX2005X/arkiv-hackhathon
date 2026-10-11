<p align="center">
  <img src="docs/assets/partfolk-logo.svg" alt="Partfolk — three separate parts form one P" width="104" height="104">
</p>

<h1 align="center">Partfolk</h1>

<p align="center"><strong>Find an event. Make one happen.</strong></p>

<p align="center">
  Bring people, spaces and equipment together.<br>
  Keep every contribution and agreement in its owner's hands.
</p>

<p align="center">
  <img src="docs/assets/stack-arkiv.svg" alt="Arkiv SDK 0.8.1" height="34">
  <img src="docs/assets/stack-react.svg" alt="React 19.3.0" height="34">
  <img src="docs/assets/stack-typescript.svg" alt="TypeScript 5.9.2" height="34">
  <img src="docs/assets/stack-vite.svg" alt="Vite 8.3.4" height="34">
  <img src="docs/assets/stack-viem.svg" alt="viem 2.57.4" height="34">
  <img src="docs/assets/stack-node.svg" alt="Node.js 22.12 or newer" height="34">
</p>

<p align="center">
  <a href="#try-partfolk">Try Partfolk</a>&nbsp;&nbsp; / &nbsp;&nbsp;
  <a href="#see-the-mechanism-in-four-steps">Explore the example</a>&nbsp;&nbsp; / &nbsp;&nbsp;
  <a href="#why-arkiv">Why Arkiv</a>&nbsp;&nbsp; / &nbsp;&nbsp;
  <a href="docs/protocol.md">Protocol</a>
</p>

Partfolk is one ecosystem for **organizers, contributors and visitors**. Organizers turn available skills, spaces and equipment into an event. Contributors decide which exact arrangement they accept. Visitors find published events and manage their registration.

**Arkiv holds the shared record.** Offers and agreements belong to their authors, so an organizer cannot turn an old “yes” into permission for a changed plan. Independent clients can read and verify those same decisions.

The application runs locally today. Public Arkiv integration is implemented; a hosted release and a complete live product demonstration are still pending.

## One event, three ways to take part

<img src="docs/assets/event-ecosystem.svg" alt="Organizers coordinate an event, contributors bring time, space and equipment, and visitors choose to join. All roles belong to the same ecosystem." width="960">

| Your part | What you can do |
| --- | --- |
| **Organize** | Describe needs, admit contributions, compare arrangements, collect agreement, publish the visitor page and run the event |
| **Contribute** | Offer time, a space or equipment; set availability; accept, decline or withdraw commitments; record work and equipment transfers |
| **Attend** | Browse by date, format and location; check registration rules; request or reserve a place; follow changes in **My events** |

One wallet can do all three. A welcome tour introduces the workspace after sign-in and can be replayed from Help. Connecting the wallet alone does not publish a profile, create a project or approve a plan.

## Try Partfolk

Use **Node.js 22.12.0 or newer** and npm. From the repository directory:

```sh
npm ci
npm run dev
```

Open [Partfolk at localhost:5173](http://127.0.0.1:5173/). No environment file, API key, database or container is needed. On Windows PowerShell, use `npm.cmd` instead of `npm`, especially when forwarding arguments after `--`.

| Start here | Local route |
| --- | --- |
| Explore Small Works without a wallet | [Guided example](http://127.0.0.1:5173/#/demo) |
| Find published events | [Browse events](http://127.0.0.1:5173/#/events) |
| Create or resume your own work | [My projects](http://127.0.0.1:5173/#/workspace) |

These links work while the development server is running. Port 5173 is strict; an occupied port produces an error. Stop with Ctrl+C and restart with the same command.

The example initializes when opened. Public browsing needs no wallet; an empty catalogue is not filled with fictional events. Publishing and registration require an injected Ethereum-compatible EOA wallet on **Arkiv Tiramisu**, testnet gas, browser storage and Web Locks support.

## See the mechanism in four steps

**Small Works** is a shared exhibition. Saturday lacks enough display boards. Sunday has the resources, but Cedar cannot install the exhibition and transport its artworks at the same time.

<img src="docs/assets/exact-agreement.svg" alt="Small Works first assigns transport to Oak and installation to Cedar and Willow. When Oak withdraws, Cedar takes transport and Juniper joins Willow. Every required contributor must approve the revised version." width="960">

1. **Find a workable arrangement.** Choose **Add Oak and find a plan**. Oak transports the artworks; Cedar and Willow install. The proposal includes equipment delivery and return.
2. **Agree to this version.** Choose **Play the group's agreement**. Each fictional contributor records a separate local decision. The plan becomes ready when every required agreement matches.
3. **See what changes.** Choose **Let Oak withdraw**. The old plan loses readiness, while its decisions remain attached to their original version.
4. **Repair and agree again.** Choose **Add Juniper and update the plan**, then **Play fresh agreement**. Juniper installs with Willow, freeing Cedar for transport. Every required owner approves the new version.

Choose **Explore the full project** to inspect people, history and the run sheet. The full practice lets you switch fictional roles, record work, acknowledge handovers and export a JSON record or readable HTML run sheet. A scheduled equipment return is never treated as an actual return.

Practice uses real local domain operations with fictional identities and a controlled clock. Its agreement buttons simulate the separate owners. Progress survives reload; **Start the example again** resets only the example.

**Make it yours:** choose **Create an event**, enter an outcome, time zone, date/place options and requirements. Drafts live in **My projects**, with reopen, export, import and delete actions. Publishing is explicit. Reusing a recipe creates new work without copying anyone's approvals.

## Events people can actually join

Events can be **online**, **in person** or **hybrid**. Physical events name a country, city and venue; online participation uses a public HTTPS link or public joining instructions. Each event displays its own named time zone.

Organizers can set a deadline, limited or unlimited places, an optional waiting list and open or wallet-invitation-only admission. Registration can be closed and reopened after validation; events can be cancelled or ended.

<img src="docs/assets/registration-paths.svg" alt="Unlimited open events register a valid signed decision directly. Limited or invitation-only events keep requests pending until the organizer admits the exact request and reserves a place. Waiting-list participation is optional." width="960">

**A request is not always a reservation.** For limited and invitation-only events, the organizer admits the exact signed request. Seat updates consume the reviewed previous event state in one native Arkiv batch, so competing updates cannot both consume that predecessor. Reservations cannot exceed capacity. Missing evidence or withdrawal does not silently free a place or promote a waiter; the organizer explicitly releases or replaces it.

**Deadlines use chain inclusion time.** An ordinary signup must be included before its deadline, which may be set up to the event end. A timely request can be admitted later. The queue is displayed by creation block and entity key, while the organizer decides admissions.

**Changed terms need a new decision.** A new date, venue or other public terms creates an immutable release for visitors to review. Existing reservations stay held until released or rebound to the new exact request. An internal contributor-plan repair can preserve unchanged visitor terms.

For a managed reservation, after-deadline reconfirmation requires the wallet to remain held and appear in the new release's authorized list. Previously registered visitors without held reservations need an explicitly later deadline. These exceptions do not silently reopen ordinary registration. The [event contract](arkiv/schema.md#event-participation-extension) specifies the full rules.

Registration has no ticket payments. Invitations establish eligibility, not privacy or a verified human identity. New joins pause if the underlying contributor agreement is no longer ready; scheduled end also stops joining.

## Why Arkiv

The event is shared; authority stays with each author.

<img src="docs/assets/arkiv-exchange.svg" alt="Separate owner wallets authorize writes to Arkiv. Partfolk, the independent Partner Desk and the read-only project verifier each read the shared public records directly." width="960">

| Record owner | What they control |
| --- | --- |
| **Organizer** | Project needs, admitted contributors, exact proposals, active plan, public releases and managed reservations |
| **Contributor** | Their resources, offers, decisions, capacity grants and execution statements |
| **Visitor** | Their attendance request, reconfirmation and withdrawal |

A contributor's consent binds the **project, activation, proposal key and canonical hash**. Every material plan revision needs fresh approval from every required owner, including someone whose own task stayed unchanged. Visitor consent similarly binds the exact audience release.

A reader checks authorship, ownership, schemas, hashes and all required records at one canonical block. It derives readiness from that evidence. Expired records, incomplete reads and competing versions remain visible as unavailable or unverified state.

The deterministic solver checks capacity, availability, overlapping commitments and typed conditions. Each candidate passes a separate evaluator. Repair favors retaining contributors and minimizing changes; a search limit is reported rather than presented as proof of impossibility.

Native create-and-delete batches replace exact current records. The solver and policies run in the clients: Partfolk is not escrow or a smart contract locking all owners' resources.

Read the [data schema](arkiv/schema.md), [full protocol](docs/protocol.md) and [Arkiv implementation findings](arkiv/friction.md) for the technical contract.

### Your drafts, their public record

| Stays in this browser | Published on Arkiv |
| --- | --- |
| Drafts, device label and tour progress | Projects, offers and immutable proposals |
| Local projects and isolated practice | Independently authored decisions and grants |
| Pending-action and transaction journals | Event releases, admissions and attendance states |

The same wallet can discover its public records from another client. Drafts and pending journals do not automatically move between browsers or origins. Deleting a draft does not delete a published project; disconnecting preserves saved work.

Public records are readable by others. Keep private contact details and meeting credentials out of them. Expiration cannot retract copies already read, and extending storage does not renew consent.

**Interrupted transaction?** Keep the same browser data, reconnect the same wallet and use the offered request-check or continuation action. Partfolk reconciles the original operation and verifies its receipt and records. A timeout does not mean nothing was sent; clearing a journal can destroy recovery evidence. See [operation recovery](docs/operations.md#pending-writes-and-recovery).

## Read the same agreement independently

**Partner Desk** is a technical client within Partfolk for contributors and agreement inspection. Its separate build, runtime and wallet connection read Arkiv directly, without the organizer's Studio process.

```sh
npm run dev:desk
```

Open [Partner Desk at localhost:5174/desk.html](http://127.0.0.1:5174/desk.html) and use a public project/publisher key or supported invitation link. It is optional for ordinary users.

The read-only CLI verifies the contributor project and agreement:

```sh
npm run verify -- --help
npm run verify -- PROJECT_ROOT --json
npm run verify -- PROJECT_ROOT --export project-snapshot.json
npm run verify -- PROJECT_ROOT --block 123456 --json
```

Replace `PROJECT_ROOT` with a real 32-byte public entity key and `123456` with the historical block to inspect. A `local:` identifier is not public. Exports refuse to overwrite files; historical output describes that block, not current readiness.

Exit `0` means a classified result, not necessarily a ready agreement. Inspect `readiness.status`, reasons, approvals and snapshot time. Unverified results return `1`; missing arguments return `2`. Event registration uses the extension reader rather than a separate CLI mode.

## Build and verify

```sh
npm run check
```

This runs TypeScript checks, unit and integration suites, offline probe/helper tests and both production builds.

| Command | Use |
| --- | --- |
| `npm run typecheck` | Application TypeScript |
| `npm run test:unit` | Domain, data and application behavior |
| `npm run test:integration` | Multi-role flows, process isolation and recovery |
| `npm run test:bootstrap` | Historical probe-script tests |
| `npm run build` | Main bundle in `dist/`, including Studio and Desk |
| `npm run build:desk` | Independent Desk bundle in `dist-desk/` |
| `npm run preview` | Built main app at `http://127.0.0.1:4173/` |
| `npm run preview:desk` | Built Desk at `http://127.0.0.1:4174/desk.html` |

Build before previewing. Deploy the generated static files over HTTPS, keeping HTML and assets together. Both builds use relative assets and hash routing. No application server, database migration or signing secret is required.

There are no application environment variables. The source-configured network is **Tiramisu, chain ID 7738577**, using `https://rpc.tiramisu.db-chain.testnet.arkiv.network`. Configuration lives in [the read client](src/data/arkiv/client.ts) and [wallet gateway](src/data/wallet/gateway.ts). Historical signer/probe scripts are not installation prerequisites. See [operations](docs/operations.md) for deployment details and troubleshooting.

The implementation is organized around `src/domain/` for constraints and consent, `src/data/` for repositories and transaction recovery, and `src/features/` for product flows. `src/domain/events/` and `src/data/events/` implement visitor participation; `src/desk/` and `src/cli/` provide independent clients.

### What the evidence establishes

The verified source baseline passed TypeScript, unit/integration checks and both builds. Clean installation and static serving were also checked with Node.js 22.13.0 and npm 10.9.2.

- [Integration scenarios](tests/integration/README.md) cover three-role participation, independent client processes, changed plans, interrupted operations and execution exports against a strict native-ledger fixture.
- [Bootstrap](arkiv/evidence/bootstrap.json) and [atomic transition](arkiv/evidence/atomic-transition.json) artifacts record historical Tiramisu capabilities. The atomic probe replaced A with B and rejected a stale A-to-C estimate; it did not mine a stale rollback.
- [Live product proof tooling](tests/arkiv-live/README.md) is separate. Its tests and the earlier capabilities are not a completed public product demonstration.

## Current boundaries

- **Release status:** hosting and a complete live product demonstration remain pending. Final visual, mobile and real-wallet acceptance is still outstanding.
- **Readiness is dated:** owners can withdraw, delete records or let them expire. Agreement is neither future availability nor proof of physical completion.
- **Audience details are organizer-authored:** public schedule and location are entered separately from contributor duties. The current validator does not establish their semantic correspondence.
- **Admission is bounded:** limited capacity and invitation lists support up to 512 entries. Waiters are not automatically promoted. Read and payload limits are defined in the [schema](arkiv/schema.md).
- **Public records are not permanent:** RPC/indexer availability and entity lifetime matter. Missing pages or conflicting records stay unverified; historical gaps remain explicit.
- **Recovery depends on retained evidence:** separate origins do not share journals or submission locks. Avoid concurrent writes from the same wallet in different clients.

## License

Partfolk is [MIT licensed](LICENSE). IBM Plex Sans retains its [SIL Open Font License](public/fonts/IBM-Plex-Sans/license.txt); dependencies retain their respective licenses.

The README diagrams are original explanatory illustrations, not interface screenshots. VibeMachina supplied development guidance; it is not a runtime dependency.
