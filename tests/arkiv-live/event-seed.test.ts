import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import { createArkivRepository } from '../../src/data/arkiv';
import { createEventRepository } from '../../src/data/events';
import { BrowserOperationStore, createOperationController, createOperationIntent, MemoryOperationStore } from '../../src/data/operations';
import { createWalletGateway } from '../../src/data/wallet';
import type { NativeTransactionRequest, NativeWalletGateway, RpcRequest as WalletRequest } from '../../src/data/wallet';
import { audienceHash, deriveEventAvailability, isTestEventTerms, validateEventPayload } from '../../src/domain/events';
import { deriveReadiness } from '../../src/domain/readiness';
import { hashCanonical } from '../../src/domain/canonical';
import { validateRecipe } from '../../src/domain/validation';
import type { AccountAddress } from '../../src/domain/types';
import { createNativeLedger } from '../integration/support/native-ledger';
import { ACTOR_IDS } from './scenario';
import { assertJournalContinuity, hydrateOriginalHashes, withCappedPreparation } from './runner';
import { BudgetLedger, createBudgetDocument, LIVE_CHAIN_ID, PRIOR_SPEND_WEI } from './safety';
import type { BudgetRecord, ReadRpc } from './safety';
import { ROOT_ACCOUNT } from './state';
import { boundSeedGateway, createSeedState, EventSeedRun, parseSeedOptions, seedActionConfirmed, validateSeedState } from './event-seed-runner';
import type { EventSeedState, SeedClient, SeedRuntime } from './event-seed-runner';
import { SEED_ATTENDEES, SEED_CONSENT_UNTIL, SEED_IDS, SEED_LIFETIME_SECONDS, SEED_RUN_ID, SEED_TRANSACTION_COUNT, seedRecipe, seedTerms } from './event-seed-scenario';

const NOW = Date.parse('2026-10-11T13:00:00Z');
const address = (number: number): AccountAddress => `0x${number.toString(16).padStart(40, '0')}`;
const accounts = Object.fromEntries(ACTOR_IDS.map((actor, index) => [actor, address(index + 10)])) as EventSeedState['accounts'];
const parent = { runId: 'fixture-original-proof', actors: accounts, genesisHash: `0x${'aa'.repeat(32)}` as const, completedPhases: ['p3-accept' as const] };
const initial = () => createSeedState(parent, 'a'.repeat(40), NOW);

/** This fixture has no private keys or real RPC. It records mock budget bindings, not signed live proof. */
function workspace(options: { broadcast?: boolean; maxTransactions?: number; loseAt?: number } = {}) {
  const ledger = createNativeLedger({ now: NOW, pageSize: 2 }), sharedStore = new MemoryOperationStore(), records: BudgetRecord[] = [];
  let state = initial(), saved = structuredClone(state), forwarded = 0, lost = false, boundary = false;
  function open() {
    const store = sharedStore;
    const clients = new Map<string, SeedClient>();
    const runtime: SeedRuntime = {
      now: ledger.now, save: value => { saved = JSON.parse(JSON.stringify(value)) as EventSeedState; },
      confirmed: action => seedActionConfirmed(action, store, records),
      async reconcile() { assertJournalContinuity({}, store, records); records.forEach(record => { record.status = 'confirmed'; }); hydrateOriginalHashes(store, records); },
      client(actor) {
        const cached = clients.get(actor); if (cached) return cached;
        const account = (actor === 'coordinator' ? ROOT_ACCOUNT : accounts[actor]).toLowerCase() as AccountAddress;
        const provider = { request: async (args: WalletRequest): Promise<unknown> => {
          if (args.method === 'eth_accounts') return [account];
          if (args.method === 'eth_chainId') return toHex(LIVE_CHAIN_ID);
          if (args.method !== 'eth_sendTransaction') throw new Error('Unsupported fixture wallet method.');
          const request = args.params![0] as NativeTransactionRequest;
          const admission = store.list().find(item => item.admission?.request.data === request.data && item.admission.request.from === request.from && item.step.status === 'unverified');
          if (!admission) throw new Error('The fixture requires the exact persisted admission.');
          if (!lost && options.loseAt === forwarded + 1) { ledger.loseNextResponse(); lost = true; }
          forwarded++;
          try { return ledger.submit(request, admission); }
          finally {
            const send = ledger.sends.at(-1)!;
            // The native fixture's known original hash stands in for the real safety journal's pre-send capture.
            records.push({ id: `${admission.operation.id}:${admission.step.id}`, kind: 'native', status: 'submitted', transactionHash: send.hash,
              signedTransaction: null, receipt: null, maximumCostWei: (BigInt(request.gas!) * BigInt(request.maxFeePerGas!)).toString(),
              plan: { chainId: LIVE_CHAIN_ID, from: request.from.toLowerCase(), to: request.to.toLowerCase(), data: request.data.toLowerCase() as `0x${string}`,
                value: '0', nonce: ledger.sends.filter(item => item.request.from === account).length - 1, gas: BigInt(request.gas!).toString(),
                maxFeePerGas: BigInt(request.maxFeePerGas!).toString(), maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas!).toString() } });
          }
        } };
        const base = createWalletGateway({ provider, publicRpc: { request: ledger.request } });
        const gateway = boundSeedGateway(base, { broadcast: options.broadcast ?? true, maxTransactions: options.maxTransactions ?? 43,
          forwarded: () => forwarded, seedRecords: () => records.length, onBoundary: () => { boundary = true; } });
        const controller = withCappedPreparation(createOperationController({ store, gateway, now: ledger.now }), store, base);
        const repoOptions = { request: ledger.request, controller, now: ledger.now, receiptTimeoutMs: 100 };
        const client = { core: createArkivRepository(repoOptions), events: createEventRepository(repoOptions) }; clients.set(actor, client); return client;
      },
    };
    return { store, runtime, run: new EventSeedRun(state, runtime) };
  }
  return { ledger, records, open, state: () => state, saved: () => saved, boundary: () => boundary,
    restart: () => { state = validateSeedState(saved); return open(); } };
}

describe('three public TEST events through the production repositories', () => {
  it('executes exactly 43 sends with ready exact sources, discoverable facets and 3 confirmed + 1 waitlisted', async () => {
    const f = workspace(), opened = f.open(); await opened.run.run();
    expect(f.ledger.sends).toHaveLength(SEED_TRANSACTION_COUNT); expect(f.saved().complete).toBe(true);
    expect(f.ledger.sends.every(send => send.request.value === '0x0')).toBe(true);
    const events = createEventRepository({ request: f.ledger.request, now: f.ledger.now });
    const list = await events.listEvents(); expect(list.ok).toBe(true); if (!list.ok) throw new Error('Missing fixture list.');
    expect(list.value.items).toHaveLength(3); expect(list.value.diagnostics).toEqual([]);
    expect(list.value.items.map(event => event.release!.payload.terms.format)).toEqual(['online', 'in_person', 'hybrid']);
    for (const event of list.value.items) {
      expect(isTestEventTerms(event.release!.payload.terms)).toBe(true);
      expect(event.release!.payload.audienceHash).toBe(audienceHash(event.release!.payload.terms));
      expect(deriveReadiness(event.sourceProject!, f.ledger.now()).status).toBe('ready');
      expect(event.sourceProject!.proposal!.payload.plan.requiredApprovers).toEqual([f.state().publisherRoot]);
      expect(event.sourceProject!.publishers[0]!.book.status === 'unique' && event.sourceProject!.publishers[0]!.book.entity.payload.grants.every(grant => grant.validUntil === SEED_CONSENT_UNTIL)).toBe(true);
      expect(event.release!.provenance.expiresAtBlock).toBeDefined();
    }
    const limited = list.value.items[1]!;
    expect(limited.state.status === 'unique' && limited.state.entity.payload.admissions).toHaveLength(3);
    expect(deriveEventAvailability(limited, f.ledger.now())).toBe('waitlist');
    const queries = [
      { format: 'online' as const }, { countryCode: 'KZ', city: 'Almaty' }, { countryCode: 'GB', city: 'London', format: 'hybrid' as const },
      { search: 'bookbinding' }, { availability: 'waitlist' as const }, { from: seedTerms('sketchbook').startsAt, to: seedTerms('sketchbook').endsAt },
      { deadlineBefore: seedTerms('sketchbook').registration!.deadline! },
    ];
    for (const query of queries) { const filtered = await events.listEvents(query); expect(filtered.ok && filtered.value.items.length).toBe(1); }
    const byPlace = await events.listEvents({ countryCode: 'KZ', format: 'online' }); expect(byPlace.ok && byPlace.value.items).toEqual([]);
    // Fresh source/roster reads at the review date, not a future now paired with an old snapshot.
    f.ledger.setTime(Date.parse('2026-10-23T12:00:00Z')); await opened.run.verify();
    const publicJSON = JSON.stringify(list.value.items); expect(publicJSON).not.toContain('privateKey'); expect(publicJSON).not.toContain('https://');
    // Reopening serialised action state + the common operation journal never recreates a confirmed record.
    const resumed = f.restart(); await resumed.run.run(); expect(f.ledger.sends).toHaveLength(43);
  }, 30_000);

  it('blocks opening without contributor consent and preserves the original command through a lost release response', async () => {
    // First release follows 2 publisher + 6 projects + 1 material + 1 offer + 1 admission + 3 plan + 1 consent = 15 sends.
    const f = workspace({ loseAt: 16 }), opened = f.open(); await expect(opened.run.run()).rejects.toThrow();
    expect(f.ledger.sends).toHaveLength(16);
    expect(f.saved().actions['sketchbook-publish']?.confirmed).toBe(false);
    const frozen = structuredClone(f.saved().actions['sketchbook-publish']!.command);
    const resumed = f.restart(); await resumed.run.run(); expect(f.ledger.sends).toHaveLength(43);
    expect(f.saved().actions['sketchbook-publish']!.command).toEqual(frozen);
    expect(f.ledger.sends.filter(send => JSON.parse(send.record.batch.creates![0]!.payloadJson).entityType === 'event_release')).toHaveLength(3);
  });

  it('stops before wallet admission in default mode and at the explicit invocation limit', async () => {
    const dry = workspace({ broadcast: false }); await expect(dry.open().run.run()).rejects.toThrow();
    expect(dry.ledger.sends).toEqual([]); expect(dry.records).toEqual([]); expect(dry.boundary()).toBe(true);
    const bounded = workspace({ maxTransactions: 1 }); await expect(bounded.open().run.run()).rejects.toThrow();
    expect(bounded.ledger.sends).toHaveLength(1); expect(bounded.records).toHaveLength(1); expect(bounded.boundary()).toBe(true);
  });

  it('requires the original shared serialized journal and refuses the total 43-send ceiling before admission', async () => {
    const f = workspace({ maxTransactions: 2 }), opened = f.open(); await expect(opened.run.run()).rejects.toThrow();
    const action = f.saved().actions.publisher!;
    expect(action.confirmed).toBe(true); expect(seedActionConfirmed(action, opened.store, f.records)).toBe(true);
    const document = { version: 1, records: Object.fromEntries(opened.store.list().map(record => [JSON.stringify([record.operation.id, record.step.id]), record])),
      attempts: Object.fromEntries(Object.values(f.saved().actions).map(item => [item.command.operation.id, opened.store.getAttempt(item.command.operation.id)])) };
    const json = JSON.stringify(document);
    const restored = new BrowserOperationStore({ getItem: () => json, setItem: () => { throw new Error('Read-only serialized journal inspection.'); } },
      { key: 'partfolk-product-proof-v1', locks: new MemoryOperationStore() });
    expect(seedActionConfirmed(action, restored, f.records)).toBe(true);
    expect(seedActionConfirmed(action, new MemoryOperationStore(), f.records)).toBe(false);
    expect(seedActionConfirmed(action, restored, [])).toBe(false);
    expect(() => assertJournalContinuity({}, new MemoryOperationStore(), f.records)).toThrow('original application journal');
    const altered = structuredClone(action); altered.confirmedKeys.reverse(); expect(seedActionConfirmed(altered, restored, f.records)).toBe(false);
    const corrupt = f.saved(); corrupt.actions.publisher!.command.lifetimeSeconds = 2; expect(() => validateSeedState(corrupt)).toThrow('saved seed action');
    let submissions = 0;
    const base: NativeWalletGateway = { prepare: async () => { throw new Error('Unused fixture preparation.'); }, submit: async () => { submissions++; return { status: 'submitted', transactionHash: `0x${'11'.repeat(32)}` }; }, dispose() {} };
    const bounded = boundSeedGateway(base, { broadcast: true, maxTransactions: 32, forwarded: () => 0, seedRecords: () => 43, onBoundary() {} });
    await expect(bounded.submit(opened.store.list()[0]!.prepared!, { onAdmission() {}, onHash() {} })).rejects.toThrow('total seed send ceiling'); expect(submissions).toBe(0);
  });

  it('refuses first publication before exact preparation approval', async () => {
    const f = workspace({ maxTransactions: 8 }); await expect(f.open().run.run()).rejects.toThrow();
    const { runtime } = f.open(), projectRoot = f.state().projectRoots.sketchbook!;
    const project = await runtime.client('coordinator').core.loadProject(projectRoot); expect(project.ok).toBe(true);
    const input = { projectRoot, terms: seedTerms('sketchbook'), source: { projectRoot, activationKey: `0x${'11'.repeat(32)}` as const,
      proposalKey: `0x${'22'.repeat(32)}` as const, proposalHash: `0x${'33'.repeat(32)}` as const }, expectedHeads: [], lifetimeSeconds: SEED_LIFETIME_SECONDS };
    const before = f.ledger.sends.length;
    const result = await runtime.client('coordinator').events.publishEvent({ ...input, operation: createOperationIntent('publish_event',
      { mode: 'public', actor: { kind: 'wallet', address: ROOT_ACCOUNT }, chainId: LIVE_CHAIN_ID }, input, { id: 'fixture:too-early', now: f.ledger.now() }) });
    expect(result.ok).toBe(false); expect(f.ledger.sends).toHaveLength(before);
  });

  it('keeps schemas and stable frozen scenario identity and refuses corrupt resumed commands', () => {
    for (const id of SEED_IDS) {
      expect(validateRecipe(seedRecipe(id)).valid).toBe(true);
      const terms = seedTerms(id); expect(terms.description.startsWith('Synthetic TEST EVENT.')).toBe(true);
      expect(terms.online?.url ?? '').toBe(''); expect(terms.registration!.deadline).toBeGreaterThan(Date.parse('2026-10-23T23:59:59Z'));
      expect(validateEventPayload({ protocol: 'partfolk-events/1', schemaVersion: 1, entityType: 'event_release', operationId: 'fixture', createdAt: NOW,
        projectRoot: `0x${'11'.repeat(32)}`, predecessorReleaseKey: null, terms, audienceHash: audienceHash(terms), source: {
          projectRoot: `0x${'11'.repeat(32)}`, activationKey: `0x${'22'.repeat(32)}`, proposalKey: `0x${'33'.repeat(32)}`, proposalHash: `0x${'44'.repeat(32)}` } }).valid).toBe(true);
    }
    expect(Object.values(SEED_ATTENDEES).flat()).toHaveLength(9);
    expect(() => createSeedState({ ...parent, completedPhases: [] }, 'a'.repeat(40), NOW)).toThrow('original proof');
    const state = initial(); state.scenarioHash = hashCanonical({ changed: true }); expect(() => validateSeedState(state)).toThrow('scenario differs');
    expect(parseSeedOptions([])).toEqual({ phase: 'prepare', broadcast: false, maxTransactions: 1 });
    expect(() => parseSeedOptions(['--broadcast'])).toThrow('exact reviewed commit');
    expect(() => parseSeedOptions(['--phase', 'seed', '--max-transactions', '33'])).toThrow('1–32');
    expect(() => parseSeedOptions(['--fund'])).toThrow('Unknown');
  });

  it('preserves cumulative spending and blocks an over-budget native admission before loading a signer', async () => {
    // Actual safety component: no account or signed bytes are created when the cap is insufficient.
    const prior = BigInt(PRIOR_SPEND_WEI), fee = 100_000n * 2_000_000_000n;
    const ledger = new BudgetLedger(createBudgetDocument({ rootAccount: ROOT_ACCOUNT, limitWei: (prior + fee - 1n).toString() }), () => {});
    let keys = 0, sends = 0;
    const read: ReadRpc = async args => args.method === 'eth_chainId' ? toHex(LIVE_CHAIN_ID)
      : args.method === 'eth_getBalance' ? toHex(10n ** 20n) : args.method === 'eth_getTransactionCount' ? '0x0' : null;
    await expect(ledger.submit({ id: `pfe:${SEED_RUN_ID}:fixture:step`, kind: 'native', address: ROOT_ACCOUNT, broadcast: true, read,
      request: { from: ROOT_ACCOUNT, to: '0x4400000000000000000000000000000000000044', data: '0x1234', value: '0x0', chainId: toHex(LIVE_CHAIN_ID), gas: toHex(100_000), maxFeePerGas: toHex(2_000_000_000n), maxPriorityFeePerGas: '0x1' },
      loadAccount: async () => { keys++; throw new Error('Fixture signer must remain unopened.'); }, sendRaw: async () => { sends++; return null; },
    })).rejects.toMatchObject({ code: 'APPROVED_BUDGET_EXCEEDED' });
    expect(keys).toBe(0); expect(sends).toBe(0); expect(ledger.snapshot().records).toEqual([]);
    expect(ledger.publicSummary().chargedWei).toBe(PRIOR_SPEND_WEI);
  });
});
