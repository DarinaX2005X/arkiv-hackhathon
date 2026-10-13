import { describe, expect, it, vi } from 'vitest';
import { toHex } from 'viem';
import type { AppSession } from '../../src/app/session';
import { createArkivRepository } from '../../src/data/arkiv';
import type { RpcRequest } from '../../src/data/arkiv/client';
import { READ_NETWORK_COOLDOWN_MS } from '../../src/data/arkiv/read-policy';
import { createEventRepository } from '../../src/data/events';
import { BrowserOperationStore, createOperationController, createOperationIntent, MemoryOperationStore } from '../../src/data/operations';
import type { OperationKind, Result, WriteAuthority } from '../../src/data/types';
import { createWalletGateway } from '../../src/data/wallet';
import type { NativeTransactionRequest, RpcRequest as WalletRequest } from '../../src/data/wallet';
import { canonicalJson } from '../../src/domain/canonical';
import { audienceChanges, canAdmitAttendance, deriveEventAvailability, eventRosterVerified, registrationEligibility } from '../../src/domain/events';
import type { AudienceTerms, EventAggregate } from '../../src/domain/events';
import { activeSource, deriveReadiness } from '../../src/domain/readiness';
import { solve } from '../../src/domain/solver';
import { TIRAMISU_CHAIN_ID } from '../../src/domain/types';
import type { AccountAddress, Actor, EntityKey, Offer, ProjectRecipe, PublicEntityKey, Resource } from '../../src/domain/types';
import { matchesMyEventFilter, myEventStatus } from '../../src/features/attendance/MyEvents';
import { prepareRegistration, prepareWithdrawal, targetForEvent, targetForWithdrawal } from '../../src/features/attendance/intent';
import { prepareDecisionCommand } from '../../src/features/contributions/model';
import { readEventForActor, readEventForWithdrawal } from '../../src/features/events/hooks';
import { preparePublishingReview, publishingFields, submitPublishingCommand, validatePublishingReview } from '../../src/features/events/publishing/model';
import { prepareAdmissionReview, validateAdmissionReview } from '../../src/features/events/publishing/admission';
import type { PublishingKind } from '../../src/features/events/publishing/model';
import { repairInput, solveRepair } from '../../src/features/execution/repair';
import { admitPublisherInput, planningInput, publishPlanInput } from '../../src/features/projects/selectors';
import { createNativeLedger } from './support/native-ledger';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const start = Date.parse('2026-11-10T08:00:00Z'), opening = start + 3_600_000, end = opening + 3 * 3_600_000;
const lifetimeSeconds = 180 * 86_400;
const address = (number: number) => `0x${number.toString(16).padStart(40, '0')}` as AccountAddress;
const organizer = address(1), host = address(2), driver = address(3), replacement = address(4), attendee = address(5), stranger = address(6);
const actor = (account: AccountAddress): Extract<Actor, { kind: 'wallet' }> => ({ kind: 'wallet', address: account });
const authority = (account: AccountAddress): WriteAuthority => ({ mode: 'public', actor: actor(account), chainId: TIRAMISU_CHAIN_ID });
const session = (account: AccountAddress): AppSession => ({ mode: 'public', actor: actor(account), chainId: TIRAMISU_CHAIN_ID,
  destination: '/events', activeDraftId: null, storageIssue: null });
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const prepared = <T>(value: { ok: true; command: T } | { ok: false; message: string }): T => {
  if (!value.ok) throw new Error(value.message);
  return value.command;
};
const recipe: ProjectRecipe = {
  title: 'Neighbourhood print exhibition', outcome: 'Open a small exhibition of local prints.', timeZone: 'Europe/Paris',
  instructions: 'Synthetic acceptance scenario: use the community room already arranged by the group.',
  variants: [{ id: 'morning', title: 'Tuesday exhibition', venueId: 'community-room', timeZone: 'Europe/Paris', instructions: '', requirements: [
    { id: 'transport', title: 'Bring the mounted prints', kind: 'person', capability: 'drive-prints', unit: 'person', quantity: 1,
      interval: { start, end: opening }, instructions: 'Bring the prepared prints before opening.', dependsOn: [] },
    { id: 'hosting', title: 'Welcome visitors', kind: 'person', capability: 'host-exhibition', unit: 'person', quantity: 1,
      interval: { start: opening, end }, instructions: 'Introduce the work and welcome visitors.', dependsOn: ['transport'] },
  ] }],
};
const audience: AudienceTerms = { title: 'Neighbourhood print exhibition', description: 'Meet the makers and see their prints.',
  startsAt: opening, endsAt: end, timeZone: 'Europe/Paris', venue: 'Community room', instructions: 'Enter through the courtyard.',
  conditions: 'Free open event. Registration records an intention to attend and does not guarantee a reserved place.' };

function workspace(options: { pageSize?: number } = {}) {
  const ledger = createNativeLedger({ now: NOW, ...options });
  const journals = new Map<string, Map<string, string>>();
  const locks = new MemoryOperationStore();
  let serial = 0;
  const nextId = (label: string) => `${label}-${++serial}`;
  /** Each reopening has new repositories/controller; only its own serialized journal survives. */
  function client(account: AccountAddress, request: RpcRequest = ledger.request,
    device: { id?: string; beforeSend?: () => void | Promise<void> } = {}) {
    const journalId = `${device.id ?? 'primary'}:${account}`;
    let storage = journals.get(journalId);
    if (!storage) { storage = new Map(); journals.set(journalId, storage); }
    const ownStorage = storage, state = { account };
    const store = new BrowserOperationStore({ getItem: key => ownStorage.get(key) ?? null,
      setItem: (key, value) => { ownStorage.set(key, value); } }, { key: `journal:${journalId}`, lockKey: `journal:${journalId}`, locks });
    const provider = { request: async (args: WalletRequest): Promise<unknown> => {
      if (args.method === 'eth_accounts') return [state.account];
      if (args.method === 'eth_chainId') return toHex(TIRAMISU_CHAIN_ID);
      if (args.method !== 'eth_sendTransaction') throw new Error(`Unexpected synthetic wallet method ${args.method}`);
      const transaction = args.params![0] as NativeTransactionRequest;
      const record = store.list().find(item => item.step.status === 'unverified'
        && canonicalJson(item.admission?.request) === canonicalJson(transaction));
      if (!record) throw new Error('A native send must have its exact persisted admission.');
      await device.beforeSend?.();
      return ledger.submit(transaction, record);
    } };
    const gateway = createWalletGateway({ provider, publicRpc: { request } });
    const controller = createOperationController({ store, gateway, now: ledger.now });
    const options = { request, controller, now: ledger.now, receiptTimeoutMs: 10 };
    return { core: createArkivRepository(options), events: createEventRepository(options), state, store,
      command<T extends object>(kind: OperationKind, input: T, id = nextId(kind)) {
        return { ...input, operation: createOperationIntent(kind, authority(account), input, { id, now: ledger.now() }) };
      } };
  }
  const freshEvents = (request: RpcRequest = ledger.request) => createEventRepository({ request, now: ledger.now });
  const freshCore = () => createArkivRepository({ request: ledger.request, now: ledger.now });
  return { ledger, client, nextId, freshEvents, freshCore };
}

async function exhibition(options: { pageSize?: number } = {}) {
  const f = workspace(options);
  expect(f.ledger.readRows()).toEqual([]);
  expect(unwrap(await f.freshEvents().listEvents()).items).toEqual([]);
  expect(unwrap(await f.freshEvents().listMyEvents(actor(attendee))).items).toEqual([]);
  const owner = f.client(organizer);
  const created = unwrap(await owner.core.createProject(owner.command('create_project', { recipe, lifetimeSeconds }))).value;
  const projectRoot = created.root.key as PublicEntityKey;
  const project = () => f.freshCore().loadProject(projectRoot).then(unwrap);
  const event = () => f.freshEvents().loadEvent(projectRoot, { includeSource: true }).then(unwrap);
  const publish = async (kind: PublishingKind, terms?: AudienceTerms) => {
    const current = await event();
    const draft = terms ? { projectRoot, organizer, baselineReleaseKey: (current.release?.key as PublicEntityKey | undefined) ?? null,
      fields: publishingFields(terms) } : null;
    const result = preparePublishingReview(current, session(organizer), kind, draft, f.ledger.now());
    if (!result.ok) throw new Error(result.message);
    const review = result.review;
    expect(validatePublishingReview(review, await event(), session(organizer), f.ledger.now())).toBeNull();
    unwrap(await submitPublishingCommand(f.client(organizer).events, review.command));
    return event();
  };
  const unpublished = await event();
  expect(preparePublishingReview(unpublished, session(organizer), 'publish', { projectRoot, organizer, baselineReleaseKey: null,
    fields: publishingFields(audience) }, f.ledger.now())).toMatchObject({ ok: false });
  const contributors = new Map<AccountAddress, EntityKey>();
  for (const [account, name, capability] of [[host, 'Mika', 'host-exhibition'], [driver, 'Rowan', 'drive-prints'],
    [replacement, 'Ari', 'drive-prints']] as const) {
    const person = f.client(account);
    const publisher = unwrap(await person.core.registerPublisher(person.command('register_publisher',
      { name, kind: 'individual', description: 'Synthetic contributor', lifetimeSeconds }))).value;
    if (publisher.book.status !== 'unique') throw new Error('New publisher requires an empty current book.');
    const previous = publisher.book.entity;
    expect(previous.payload.decisions).toEqual([]);
    expect(previous.payload.grants).toEqual([]);
    const resource: Resource = { id: 'self', name: `${name}'s time`, kind: 'person', unit: 'person', capacity: 1,
      capabilities: [capability], availability: [{ start, end }] };
    const offer: Offer = { id: capability, title: capability, resourceId: resource.id, kind: 'person', unit: 'person', quantity: 1,
      capabilities: [capability], availability: [{ start, end }], projectScope: [projectRoot], conditions: [], instructions: '' };
    const id = f.nextId('share');
    unwrap(await person.core.shareOffer(person.command('share_offer', { projectRoot, publisherRoot: publisher.root.key,
      expectedBookHeads: [previous.key], book: { ...previous.payload, operationId: id, createdAt: f.ledger.now(),
        predecessorKeys: [previous.key], resources: [resource], offers: [offer] }, offerIds: [offer.id], lifetimeSeconds }, id)));
    contributors.set(account, publisher.root.key);
  }
  expect((await project()).publishers).toEqual([]);
  expect(unwrap(await f.freshCore().listIncomingOffers(projectRoot)).items).toHaveLength(3);
  for (const root of contributors.values()) {
    const id = f.nextId('admit'), input = admitPublisherInput(await project(), root, id, f.ledger.now());
    unwrap(await owner.core.replaceProject(owner.command('replace_project', input, id)));
  }
  let current = await project();
  const result = solve(planningInput(current)!, [{ requirementId: 'transport', publisherRoot: contributors.get(driver)!, offerId: 'drive-prints', quantity: 1 }]);
  expect(result.status).toBe('found');
  const selected = result.candidates[0]!;
  const id = f.nextId('plan'), input = publishPlanInput(current, selected, id, f.ledger.now(), 'Host and driver selected for the exhibition.');
  unwrap(await owner.core.publishPlan(owner.command('publish_plan', input, id)));
  current = await project();
  expect(deriveReadiness(current, f.ledger.now())).toMatchObject({ status: 'awaiting_approval', acceptedApprovers: [] });
  const decide = async (account: AccountAddress, status: 'accepted' | 'withdrawn') => {
    const currentProject = await project(), root = contributors.get(account)!;
    const decision = prepareDecisionCommand(currentProject, root, authority(account), { status, now: f.ledger.now(),
      id: f.nextId(status), validUntil: end, reviewedSource: activeSource(currentProject)! });
    unwrap(await f.client(account).core.replaceBook(decision));
  };
  await decide(host, 'accepted');
  expect(deriveReadiness(await project(), f.ledger.now()).status).toBe('awaiting_approval');
  await decide(driver, 'accepted');
  expect(deriveReadiness(await project(), f.ledger.now()).status).toBe('ready');
  return { ...f, projectRoot, project, event, publish, decide, contributors };
}

describe('organizer, contributor and attendee through independent production repositories', () => {
  it.each(['cancelled', 'ended'] as const)('keeps consent exact through preparation repair, schedule review and %s My events', async terminal => {
    const f = await exhibition();
    const initialSource = activeSource(await f.project())!;
    const published = await f.publish('publish', audience);
    expect(deriveEventAvailability(published, f.ledger.now())).toBe('open');
    const firstRelease = published.release!, firstEventHead = published.state.status === 'unique' ? published.state.entity.key : null;
    expect(unwrap(await f.freshEvents().listEvents({ search: 'print', from: opening, to: end })).items.map(item => item.projectRoot)).toEqual([f.projectRoot]);
    expect(unwrap(await f.freshCore().listOwnPublishers(actor(attendee))).items).toEqual([]);
    const selected = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(attendee)));
    const target = targetForEvent(selected, session(attendee), f.ledger.now())!;
    expect(prepareRegistration(selected, target, session(stranger), f.ledger.now())).toMatchObject({ ok: false });
    const join = prepared(prepareRegistration(selected, target, session(attendee), f.ledger.now()));
    const visitor = f.client(attendee);
    visitor.state.account = stranger;
    const countBeforeWrongAccount = f.ledger.sends.length;
    expect(await visitor.events.replaceAttendance(join)).toMatchObject({ ok: false, error: { code: 'not_connected' } });
    expect(f.ledger.sends).toHaveLength(countBeforeWrongAccount);
    visitor.state.account = attendee;
    let registrationKey: EntityKey;
    if (terminal === 'cancelled') {
      f.ledger.loseNextResponse();
      expect(await visitor.events.replaceAttendance(join)).toMatchObject({ ok: false, error: { code: 'unverified' } });
      const sendsAfterLoss = f.ledger.sends.length;
      const reopened = f.client(attendee);
      expect(reopened.store).not.toBe(visitor.store);
      expect(unwrap(await reopened.events.reconcile(join.operation)).status).toBe('confirmed');
      registrationKey = unwrap(await reopened.events.replaceAttendance(join)).value.key;
      expect(f.ledger.sends).toHaveLength(sendsAfterLoss);
    } else registrationKey = unwrap(await visitor.events.replaceAttendance(join)).value.key;
    const myEvent = async () => {
      const result = unwrap(await f.freshEvents().listMyEvents(actor(attendee)));
      expect(result.snapshot).toMatchObject({ completeness: 'complete', freshness: 'fresh', reasons: [] });
      expect(result.items).toHaveLength(1);
      return result.items[0]!;
    };
    expect(myEventStatus(await myEvent(), f.ledger.now())).toBe('going');
    expect(unwrap(await f.freshEvents().listMyEvents(actor(organizer))).items).toEqual([]);
    await f.decide(driver, 'withdrawn');
    expect(deriveReadiness(await f.project(), f.ledger.now()).status).toBe('changed');
    const paused = await f.event();
    expect(deriveEventAvailability(paused, f.ledger.now())).toBe('paused');
    expect(paused.release).toEqual(firstRelease);
    expect(paused.state.status === 'unique' && paused.state.entity.key).toBe(firstEventHead);
    const pending = await myEvent();
    expect(pending.attendance.status === 'unique' && pending.attendance.entity.key).toBe(registrationKey);
    expect(myEventStatus(pending, f.ledger.now())).toBe('going');
    const newcomer = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(stranger)));
    expect(prepareRegistration(newcomer, targetForEvent(newcomer, session(stranger), f.ledger.now())!, session(stranger), f.ledger.now())).toMatchObject({ ok: false });

    const withdrawnProject = await f.project(), repair = repairInput(withdrawnProject)!;
    const repaired = solveRepair(withdrawnProject, repair, [], { maxNodes: 10_000, maxCandidates: 4 });
    expect(repaired.status).toBe('found');
    const candidate = repaired.candidates[0]!;
    expect(candidate.plan.predecessor).toEqual(initialSource);
    expect(candidate.plan.requiredApprovers).toEqual([f.contributors.get(host)!, f.contributors.get(replacement)!].sort());
    expect(candidate.plan.allocations.find(item => item.requirementId === 'hosting')).toEqual(
      withdrawnProject.proposal!.payload.plan.allocations.find(item => item.requirementId === 'hosting'));
    const repairId = f.nextId('repair'), repairFields = publishPlanInput(withdrawnProject, candidate, repairId, f.ledger.now(), 'Ari replaces Rowan for transport.');
    const coordinator = f.client(organizer);
    unwrap(await coordinator.core.publishPlan(coordinator.command('publish_plan', repairFields, repairId)));
    expect(deriveReadiness(await f.project(), f.ledger.now())).toMatchObject({ status: 'awaiting_approval', acceptedApprovers: [] });
    await f.decide(host, 'accepted');
    expect(deriveReadiness(await f.project(), f.ledger.now()).status).toBe('awaiting_approval');
    await f.decide(replacement, 'accepted');
    expect(deriveReadiness(await f.project(), f.ledger.now()).status).toBe('ready');
    expect(deriveEventAvailability(await f.event(), f.ledger.now())).toBe('paused');
    const resumed = await f.publish('repair');
    expect(deriveEventAvailability(resumed, f.ledger.now())).toBe('open');
    expect(resumed.release).toEqual(firstRelease);
    expect(resumed.state.status === 'unique' && resumed.state.entity.payload.source).toEqual(activeSource(await f.project()));
    expect((await myEvent()).attendance).toEqual(pending.attendance);
    expect(myEventStatus(await myEvent(), f.ledger.now())).toBe('going');

    const priorTerms = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(stranger)));
    const staleReview = prepared(prepareRegistration(priorTerms, targetForEvent(priorTerms, session(stranger), f.ledger.now())!, session(stranger), f.ledger.now()));
    expect(staleReview.expectedHeads).toEqual([]);
    const changedTerms = { ...audience, startsAt: opening + 15 * 60_000, endsAt: end - 15 * 60_000 };
    const rescheduled = await f.publish('publish', changedTerms);
    expect(rescheduled.release!.key).not.toBe(firstRelease.key);
    expect(rescheduled.release!.payload.predecessorReleaseKey).toBe(firstRelease.key);
    const needsReview = await myEvent();
    expect(needsReview.registeredRelease).toEqual(firstRelease);
    expect(myEventStatus(needsReview, f.ledger.now())).toBe('needs_review');
    expect(matchesMyEventFilter(myEventStatus(needsReview, f.ledger.now()), 'needs_review')).toBe(true);
    expect(audienceChanges(needsReview.registeredRelease!.payload.terms, rescheduled.release!.payload.terms)).toEqual(['startsAt', 'endsAt']);
    const currentRead = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(attendee)));
    expect(prepareRegistration(currentRead, target, session(attendee), f.ledger.now())).toMatchObject({ ok: false });
    const beforeStale = f.ledger.sends.length;
    expect(await f.client(stranger).events.replaceAttendance(staleReview)).toMatchObject({ ok: false,
      error: { code: 'stale_heads', reasons: [{ code: 'proposal_mismatch' }] } });
    expect(f.ledger.sends).toHaveLength(beforeStale);
    const reconfirm = prepared(prepareRegistration(currentRead, targetForEvent(currentRead, session(attendee), f.ledger.now())!, session(attendee), f.ledger.now()));
    const confirmed = unwrap(await f.client(attendee).events.replaceAttendance(reconfirm));
    expect(confirmed.receipt.consumedKeys).toEqual([registrationKey]);
    registrationKey = confirmed.value.key;
    expect(confirmed.value.payload).toMatchObject({ releaseKey: rescheduled.release!.key, predecessorKeys: confirmed.receipt.consumedKeys, decision: 'going' });
    expect(myEventStatus(await myEvent(), f.ledger.now())).toBe('going');

    // Contributor reads can fail independently of the attendee's right to withdraw.
    let blockedSourceCalls = 0;
    const outage: RpcRequest = async args => {
      if (args.method === 'arkiv_query' && /book_state|publisher_root|plan_activation|proposal/.test(String((args.params as unknown[])[0]))) {
        blockedSourceCalls++; throw Object.assign(new Error('Synthetic contributor RPC outage.'), { status: 503 });
      }
      return f.ledger.request(args);
    };
    let transportTime = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => transportTime);
    const withdrew = await (async () => {
      try {
        const unavailable = await f.freshEvents(outage).loadEvent(f.projectRoot);
        expect(blockedSourceCalls).toBe(2); // One initial read and one bounded transient retry.
        expect(unavailable.ok ? deriveEventAvailability(unavailable.value, f.ledger.now()) : 'unverified').toBe('unverified');
        const requests = f.ledger.calls.length;
        expect(await readEventForWithdrawal(f.freshEvents(outage), f.projectRoot, actor(attendee)))
          .toMatchObject({ ok: false, error: { code: 'network', retryable: true } });
        expect(f.ledger.calls).toHaveLength(requests);
        expect(blockedSourceCalls).toBe(2); // Source-free reads cannot bypass a provider-wide cooldown.
        transportTime += READ_NETWORK_COOLDOWN_MS + 1;
        blockedSourceCalls = 0;
        const ownRead = unwrap(await readEventForWithdrawal(f.freshEvents(outage), f.projectRoot, actor(attendee)));
        const withdrawal = prepared(prepareWithdrawal(ownRead, targetForWithdrawal(ownRead, session(attendee), f.ledger.now())!, session(attendee), f.ledger.now()));
        return unwrap(await f.client(attendee, outage).events.replaceAttendance(withdrawal));
      } finally { clock.mockRestore(); }
    })();
    expect(withdrew.receipt.consumedKeys).toEqual([registrationKey]);
    expect(blockedSourceCalls).toBe(0);
    expect(myEventStatus(await myEvent(), f.ledger.now())).toBe('withdrawn');
    const returnRead = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(attendee)));
    const rejoin = prepared(prepareRegistration(returnRead, targetForEvent(returnRead, session(attendee), f.ledger.now())!, session(attendee), f.ledger.now()));
    const returned = unwrap(await f.client(attendee).events.replaceAttendance(rejoin));
    expect(returned.receipt.consumedKeys).toEqual([withdrew.value.key]);
    const finalDecision = (await myEvent()).attendance;

    if (terminal === 'ended') f.ledger.setTime(changedTerms.endsAt + 2_000);
    const finished = await f.publish(terminal === 'cancelled' ? 'cancel' : 'end');
    expect(deriveEventAvailability(finished, f.ledger.now())).toBe(terminal);
    const final = await myEvent();
    expect(myEventStatus(final, f.ledger.now())).toBe(terminal);
    expect(matchesMyEventFilter(myEventStatus(final, f.ledger.now()), 'past')).toBe(true);
    expect(final.attendance).toEqual(finalDecision);
    expect(final.attendance.status === 'unique' && final.attendance.entity.payload.decision).toBe('going');
    expect(final.registeredRelease?.key).toBe(rescheduled.release!.key);
    expect(unwrap(await f.freshCore().listOwnPublishers(actor(attendee))).items).toEqual([]);
    for (const publisher of (await f.project()).publishers) {
      if (publisher.book.status !== 'unique') throw new Error('Every contributor book should remain available.');
      expect(publisher.book.entity.payload.attestations).toEqual([]);
    }
    expect(f.ledger.sends.flatMap(send => send.record.batch.creates ?? []).map(create => JSON.parse(create.payloadJson))
      .filter(payload => payload.entityType === 'attendance_state').every(payload => payload.attendee === attendee)).toBe(true);
    expect(f.ledger.readRows().filter(row => row.attributes.some(attribute => attribute.name === 'entity_type' && attribute.value === 'attendance_state'))).toHaveLength(1);
    expect(f.ledger.readRows().filter(row => row.attributes.some(attribute => attribute.name === 'entity_type' && attribute.value === 'event_release'))).toHaveLength(2);
  }, 60_000);
});

type Exhibition = Awaited<ReturnType<typeof exhibition>>;
const finiteAudience = (rules: Partial<NonNullable<AudienceTerms['registration']>> = {}): AudienceTerms => ({
  ...audience, termsVersion: 2, format: 'hybrid',
  location: { countryCode: 'FR', country: 'France', city: 'Paris', venue: audience.venue },
  online: { url: 'https://example.org/exhibition', instructions: 'Use the public exhibition page.' },
  conditions: 'The organizer confirms places. Joining the waiting list is optional.',
  registration: { deadline: opening - 86_400_000, capacity: { kind: 'limited', limit: 1 },
    waitlist: true, admission: 'open', invitedAccounts: [], ...rules },
});
async function requestReview(f: Exhibition, account: AccountAddress, joinWaitlist = false) {
  const read = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(account)));
  return prepared(prepareRegistration(read, targetForEvent(read, session(account), f.ledger.now())!, session(account), f.ledger.now(), joinWaitlist));
}
async function ownEvent(f: Exhibition, account: AccountAddress, request: RpcRequest = f.ledger.request) {
  const result = unwrap(await f.freshEvents(request).listMyEvents(actor(account)));
  expect(result.snapshot).toMatchObject({ completeness: 'complete', freshness: 'fresh', reasons: [] });
  expect(result.items).toHaveLength(1);
  return result.items[0]!;
}
async function ownerReview(f: Exhibition, account: AccountAddress, kind: 'admit' | 'release', event?: EventAggregate) {
  const current = event ?? await f.event();
  const result = prepareAdmissionReview(current, session(organizer), account, kind, f.ledger.now());
  if (!result.ok) throw new Error(result.message);
  expect(validateAdmissionReview(result.review, current, session(organizer), f.ledger.now())).toBeNull();
  return result.review.command;
}
async function withdraw(f: Exhibition, account: AccountAddress) {
  const read = unwrap(await readEventForWithdrawal(f.freshEvents(), f.projectRoot, actor(account)));
  return unwrap(await f.client(account).events.replaceAttendance(prepared(prepareWithdrawal(read,
    targetForWithdrawal(read, session(account), f.ledger.now())!, session(account), f.ledger.now()))));
}

describe('structured events across independent production clients', () => {
  it('keeps an obsolete reservation occupied across repeated withdrawal and rejoining until an explicit owner decision', async () => {
    const f = await exhibition({ pageSize: 1 });
    const published = await f.publish('publish', finiteAudience({ capacity: { kind: 'limited', limit: 2 }, waitlist: false }));
    const first = unwrap(await f.client(attendee).events.replaceAttendance(await requestReview(f, attendee))).value;
    const other = unwrap(await f.client(stranger).events.replaceAttendance(await requestReview(f, stranger))).value;
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'admit')));
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, stranger, 'admit')));
    const original = await f.event();
    if (original.state.status !== 'unique') throw new Error('Expected one organizer head.');
    const originalReservations = original.state.entity.payload.admissions;
    expect(originalReservations).toHaveLength(2);
    const newcomer = address(7);
    let currentRequest = first;
    for (let cycle = 0; cycle < 2; cycle++) {
      const withdrawn = await withdraw(f, attendee);
      expect(withdrawn.receipt.consumedKeys).toEqual([currentRequest.key]);
      expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('withdrawn');
      expect(myEventStatus(await ownEvent(f, stranger), f.ledger.now())).toBe('going');
      const beforeRejoin = await f.event();
      expect(eventRosterVerified(beforeRejoin, f.ledger.now())).toBe(true);
      expect(registrationEligibility(beforeRejoin, actor(newcomer), f.ledger.now())).toMatchObject({ status: 'full', remaining: 0 });
      expect(registrationEligibility(beforeRejoin, actor(attendee), f.ledger.now()).status).toBe('request');
      const rejoined = unwrap(await f.client(attendee).events.replaceAttendance(await requestReview(f, attendee)));
      expect(rejoined.receipt.consumedKeys).toEqual([withdrawn.value.key]);
      expect(rejoined.value.payload.predecessorKeys).toEqual([withdrawn.value.key]);
      expect(rejoined.value.payload.predecessorKeys).not.toContain(first.key);
      currentRequest = rejoined.value;
      const current = await f.event();
      expect(eventRosterVerified(current, f.ledger.now())).toBe(true);
      expect(deriveEventAvailability(current, f.ledger.now())).toBe('full');
      expect(current.state.status === 'unique' && current.state.entity.payload.admissions).toEqual(originalReservations);
      expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('pending');
      expect(myEventStatus(await ownEvent(f, stranger), f.ledger.now())).toBe('going');
      expect(registrationEligibility(current, actor(newcomer), f.ledger.now())).toMatchObject({ status: 'full', remaining: 0 });
      const before = f.ledger.sends.length, outsider = f.client(newcomer);
      expect(await outsider.events.replaceAttendance(outsider.command('replace_attendance', { projectRoot: f.projectRoot,
        releaseKey: published.release!.key, audienceHash: published.release!.payload.audienceHash,
        decision: 'going' as const, expectedHeads: [], lifetimeSeconds }))).toMatchObject({ ok: false });
      expect(f.ledger.sends).toHaveLength(before);
    }
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'release')));
    const released = await f.event();
    expect(registrationEligibility(released, actor(newcomer), f.ledger.now())).toMatchObject({ status: 'request', remaining: 1 });
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('pending');
    expect(myEventStatus(await ownEvent(f, stranger), f.ledger.now())).toBe('going');
    const accepted = unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'admit')));
    expect(accepted.value.payload.admissions).toEqual(expect.arrayContaining([
      { attendee, attendanceKey: currentRequest.key, releaseKey: published.release!.key },
      { attendee: stranger, attendanceKey: other.key, releaseKey: published.release!.key },
    ]));
    expect(accepted.value.payload.admissions).toHaveLength(2);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('going');
    expect(myEventStatus(await ownEvent(f, stranger), f.ledger.now())).toBe('going');
    expect(registrationEligibility(await f.event(), actor(newcomer), f.ledger.now())).toMatchObject({ status: 'full', remaining: 0 });
  }, 60_000);

  it('keeps requests pending, atomically arbitrates the last place, and requires explicit release before promotion', async () => {
    const f = await exhibition({ pageSize: 1 });
    const published = await f.publish('publish', finiteAudience());
    expect(registrationEligibility(published, actor(attendee), f.ledger.now())).toMatchObject({ status: 'request', remaining: 1, requiresApproval: true });
    expect(unwrap(await f.freshEvents().listEvents({ format: 'hybrid', countryCode: 'FR', city: 'paris', availability: 'open', deadlineBefore: opening })).items).toHaveLength(1);
    expect(unwrap(await f.freshEvents().listEvents({ format: 'online' })).items).toEqual([]);

    const firstRequest = unwrap(await f.client(attendee).events.replaceAttendance(await requestReview(f, attendee, true))).value;
    const secondRequest = unwrap(await f.client(stranger).events.replaceAttendance(await requestReview(f, stranger, true))).value;
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('pending');
    expect(myEventStatus(await ownEvent(f, stranger), f.ledger.now())).toBe('pending');
    const reviewed = await f.event();
    expect(reviewed.roster?.entries.map(entry => entry.attendee)).toEqual([attendee, stranger]);
    expect(eventRosterVerified(reviewed, f.ledger.now())).toBe(true);
    expect(reviewed.roster?.entries.every(entry => canAdmitAttendance(reviewed, entry, f.ledger.now()))).toBe(true);
    const firstDecision = await ownerReview(f, attendee, 'admit', reviewed);
    const secondDecision = await ownerReview(f, stranger, 'admit', reviewed);
    expect(firstDecision.expectedHeads).toEqual(secondDecision.expectedHeads);

    // Independent devices have independent journals/locks. Both complete production preflight
    // before either native batch executes; only the exact consume can protect the final place.
    let reached = 0, release!: () => void;
    const together = new Promise<void>(resolve => { release = resolve; });
    const beforeSend = async () => { reached++; if (reached === 2) release(); await together; };
    const before = f.ledger.sends.length;
    const results = await Promise.all([
      f.client(organizer, f.ledger.request, { id: 'owner-device-a', beforeSend }).events.replaceEvent(firstDecision),
      f.client(organizer, f.ledger.request, { id: 'owner-device-b', beforeSend }).events.replaceEvent(secondDecision),
    ]);
    expect(reached).toBe(2);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'unverified' }) })]);
    expect(f.ledger.sends).toHaveLength(before + 1);
    const winner = results[0]!.ok ? attendee : stranger, waiting = winner === attendee ? stranger : attendee;
    const admittedRequest = winner === attendee ? firstRequest : secondRequest;
    const current = await f.event();
    expect(current.state.status).toBe('unique');
    if (current.state.status !== 'unique') throw new Error('The native race must leave exactly one event head.');
    expect(current.state.entity.payload.admissions).toEqual([{ attendee: winner, attendanceKey: admittedRequest.key, releaseKey: published.release!.key }]);
    const nativeAdmission = f.ledger.sends.at(-1)!;
    expect(nativeAdmission.deletedKeys).toEqual(firstDecision.expectedHeads);
    expect(nativeAdmission.record.batch.creates).toHaveLength(1);
    expect(myEventStatus(await ownEvent(f, winner), f.ledger.now())).toBe('going');
    expect(myEventStatus(await ownEvent(f, waiting), f.ledger.now())).toBe('waitlisted');
    expect(registrationEligibility(current, actor(waiting), f.ledger.now())).toMatchObject({ status: 'waitlist', remaining: 0 });
    const newcomer = address(7);
    const fullRead = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(newcomer)));
    expect(prepareRegistration(fullRead, targetForEvent(fullRead, session(newcomer), f.ledger.now())!, session(newcomer), f.ledger.now())).toMatchObject({ ok: false });
    unwrap(await f.client(newcomer).events.replaceAttendance(await requestReview(f, newcomer, true)));
    expect(myEventStatus(await ownEvent(f, newcomer), f.ledger.now())).toBe('waitlisted');

    const staleDecision = winner === attendee ? secondDecision : firstDecision;
    const { operation: ignored, ...staleFields } = staleDecision;
    const freshOwner = f.client(organizer, f.ledger.request, { id: 'fresh-owner' });
    expect(await freshOwner.events.replaceEvent(freshOwner.command('replace_event', staleFields))).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(f.ledger.sends).toHaveLength(before + 2);

    const withdrawn = await withdraw(f, winner);
    expect(withdrawn.receipt.consumedKeys).toEqual([admittedRequest.key]);
    expect(myEventStatus(await ownEvent(f, winner), f.ledger.now())).toBe('withdrawn');
    expect(myEventStatus(await ownEvent(f, waiting), f.ledger.now())).toBe('waitlisted');
    expect(registrationEligibility(await f.event(), actor(waiting), f.ledger.now()).remaining).toBe(0);
    expect(prepareAdmissionReview(await f.event(), session(organizer), waiting, 'admit', f.ledger.now())).toMatchObject({ ok: false });
    const releasePlace = await ownerReview(f, winner, 'release');
    unwrap(await freshOwner.events.replaceEvent(releasePlace));
    expect(myEventStatus(await ownEvent(f, waiting), f.ledger.now())).toBe('pending');
    const promotion = await ownerReview(f, waiting, 'admit');
    f.ledger.loseNextResponse();
    const lostOwner = f.client(organizer, f.ledger.request, { id: 'promotion-device' });
    expect(await lostOwner.events.replaceEvent(promotion)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    const afterLost = f.ledger.sends.length;
    const reopened = f.client(organizer, f.ledger.request, { id: 'promotion-device' });
    expect(unwrap(await reopened.events.reconcile(promotion.operation)).status).toBe('confirmed');
    const confirmed = unwrap(await reopened.events.replaceEvent(promotion));
    expect(confirmed.receipt.consumedKeys).toEqual(promotion.expectedHeads);
    expect(f.ledger.sends).toHaveLength(afterLost);
    expect(myEventStatus(await ownEvent(f, waiting), f.ledger.now())).toBe('going');
    expect(myEventStatus(await ownEvent(f, winner), f.ledger.now())).toBe('withdrawn');
    const rejoined = unwrap(await f.client(winner).events.replaceAttendance(await requestReview(f, winner, true)));
    expect(rejoined.receipt.consumedKeys).toEqual([withdrawn.value.key]);
    expect(myEventStatus(await ownEvent(f, winner), f.ledger.now())).toBe('waitlisted');
    expect(myEventStatus(await ownEvent(f, waiting), f.ledger.now())).toBe('going');
    const afterRejoin = f.ledger.sends.length;
    // An unconfirmed losing native attempt cannot be treated as permission to send again.
    const losingClient = f.client(organizer, f.ledger.request, { id: winner === attendee ? 'owner-device-b' : 'owner-device-a' });
    expect(unwrap(await losingClient.events.reconcile(staleDecision.operation)).status).not.toBe('confirmed');
    expect(await losingClient.events.replaceEvent(staleDecision)).toMatchObject({ ok: false });
    expect(f.ledger.sends).toHaveLength(afterRejoin);
  }, 60_000);

  it('binds reconfirmation and admission to the new release even when earlier audience terms return', async () => {
    const f = await exhibition();
    const terms = finiteAudience();
    const first = await f.publish('publish', terms);
    unwrap(await f.client(attendee).events.replaceAttendance(await requestReview(f, attendee)));
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'admit')));
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('going');
    const oldRead = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(attendee)));
    const oldTarget = targetForEvent(oldRead, session(attendee), f.ledger.now())!;
    await f.publish('publish', { ...terms, startsAt: opening + 60_000 });
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('needs_review');
    const repeated = await f.publish('publish', terms);
    expect(repeated.release!.payload.audienceHash).toBe(first.release!.payload.audienceHash);
    expect(repeated.release!.key).not.toBe(first.release!.key);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('needs_review');
    const fresh = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(attendee)));
    expect(prepareRegistration(fresh, oldTarget, session(attendee), f.ledger.now())).toMatchObject({ ok: false });
    const reconfirm = await requestReview(f, attendee);
    const result = unwrap(await f.client(attendee).events.replaceAttendance(reconfirm));
    expect(result.value.payload.releaseKey).toBe(repeated.release!.key);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('pending');
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'admit')));
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('going');
    const noWaitlist = await f.publish('publish', { ...terms, registration: { ...terms.registration!, waitlist: false } });
    expect(registrationEligibility(noWaitlist, actor(stranger), f.ledger.now())).toMatchObject({ status: 'full', remaining: 0 });
    const before = f.ledger.sends.length;
    const outsider = f.client(stranger);
    expect(await outsider.events.replaceAttendance(outsider.command('replace_attendance', { projectRoot: f.projectRoot,
      releaseKey: noWaitlist.release!.key, audienceHash: noWaitlist.release!.payload.audienceHash, decision: 'going' as const,
      expectedHeads: [], lifetimeSeconds, joinWaitlist: false }))).toMatchObject({ ok: false });
    expect(f.ledger.sends).toHaveLength(before);
  }, 60_000);

  it('uses canonical inclusion time, rejecting stale reviews and never granting late backdated requests a place', async () => {
    const f = await exhibition();
    const deadline = f.ledger.now() + 120_000;
    await f.publish('publish', finiteAudience({ deadline }));
    const stale = await requestReview(f, stranger);
    const reviewed = await requestReview(f, attendee);
    const { operation: ignored, ...fields } = reviewed;
    const backdated = { ...fields, operation: createOperationIntent('replace_attendance', authority(attendee), fields,
      { id: f.nextId('backdated-request'), now: NOW - 86_400_000 }) };
    const lateWallet = f.client(attendee, f.ledger.request, { beforeSend: () => f.ledger.setTime(deadline) });
    const recorded = unwrap(await lateWallet.events.replaceAttendance(backdated));
    expect(recorded.value.payload.createdAt).toBe(NOW - 86_400_000);
    const current = await f.event();
    expect(current.roster!.entries[0]!.inclusionTimestamp).toBeGreaterThanOrEqual(deadline);
    expect(canAdmitAttendance(current, current.roster!.entries[0]!, f.ledger.now())).toBe(false);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('registration_closed');
    expect(prepareAdmissionReview(current, session(organizer), attendee, 'admit', f.ledger.now())).toMatchObject({ ok: false });
    const owner = f.client(organizer);
    const head = current.state.status === 'unique' ? current.state.entity : null;
    if (!head) throw new Error('Expected the current event head.');
    const before = f.ledger.sends.length;
    expect(await owner.events.replaceEvent(owner.command('replace_event', { projectRoot: f.projectRoot,
      releaseKey: current.release!.key, audienceHash: current.release!.payload.audienceHash, source: head.payload.source,
      status: 'open' as const, expectedHeads: [head.key], lifetimeSeconds,
      admissions: [{ attendee, attendanceKey: recorded.value.key, releaseKey: current.release!.key }] }))).toMatchObject({ ok: false });
    expect(await f.client(stranger).events.replaceAttendance(stale)).toMatchObject({ ok: false, error: { code: 'stale_heads' } });
    expect(f.ledger.sends).toHaveLength(before);
  }, 60_000);

  it('allows only still-reserved release-listed wallets to reconfirm changed terms after the deadline', async () => {
    const f = await exhibition();
    const deadline = f.ledger.now() + 120_000;
    const terms = finiteAudience({ deadline });
    const initial = await f.publish('publish', terms);
    expect(initial.release!.payload.reconfirmationAccounts).toEqual([]);
    const firstRequest = unwrap(await f.client(attendee).events.replaceAttendance(await requestReview(f, attendee))).value;
    unwrap(await f.client(stranger).events.replaceAttendance(await requestReview(f, stranger, true)));
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'admit')));
    f.ledger.setTime(deadline + 2_000);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('going');
    const changed = await f.publish('publish', { ...terms, startsAt: terms.startsAt + 60_000 });
    expect(changed.release!.key).not.toBe(initial.release!.key);
    expect(changed.release!.payload.predecessorReleaseKey).toBe(initial.release!.key);
    expect(changed.release!.payload.reconfirmationAccounts).toEqual([attendee]);
    expect(deriveEventAvailability(changed, f.ledger.now())).toBe('registration_closed');
    expect(registrationEligibility(changed, actor(attendee), f.ledger.now())).toMatchObject({ status: 'request', remaining: 0 });
    expect(registrationEligibility(changed, actor(stranger), f.ledger.now()).status).toBe('registration_closed');
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('needs_review');
    const newcomer = address(7), before = f.ledger.sends.length;
    for (const account of [stranger, newcomer]) {
      const reader = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(account)));
      expect(prepareRegistration(reader, targetForEvent(reader, session(account), f.ledger.now())!, session(account), f.ledger.now(), true)).toMatchObject({ ok: false });
      const writer = f.client(account);
      expect(await writer.events.replaceAttendance(writer.command('replace_attendance', { projectRoot: f.projectRoot,
        releaseKey: changed.release!.key, audienceHash: changed.release!.payload.audienceHash,
        decision: 'going' as const, joinWaitlist: true, expectedHeads: reader.attendance?.status === 'unique' ? [reader.attendance.entity.key] : [],
        lifetimeSeconds }))).toMatchObject({ ok: false });
    }
    expect(f.ledger.sends).toHaveLength(before);
    const reconfirmed = unwrap(await f.client(attendee).events.replaceAttendance(await requestReview(f, attendee)));
    expect(reconfirmed.receipt.consumedKeys).toEqual([firstRequest.key]);
    expect(reconfirmed.value.payload.releaseKey).toBe(changed.release!.key);
    const pending = await f.event();
    expect(eventRosterVerified(pending, f.ledger.now())).toBe(true);
    expect(pending.roster!.entries.find(entry => entry.attendee === attendee)!.inclusionTimestamp).toBeGreaterThan(deadline);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('pending');
    if (pending.state.status !== 'unique') throw new Error('Expected one event head.');
    expect(pending.state.entity.payload.admissions).toEqual([{ attendee, attendanceKey: firstRequest.key, releaseKey: initial.release!.key }]);
    const accepted = unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'admit')));
    expect(accepted.value.payload.admissions).toEqual([{ attendee, attendanceKey: reconfirmed.value.key, releaseKey: changed.release!.key }]);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('going');
    expect(eventRosterVerified(await f.event(), f.ledger.now())).toBe(true);

    // Immutable eligibility metadata alone cannot restore a place the organizer explicitly released.
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'release')));
    const released = await f.event();
    expect(released.release!.payload.reconfirmationAccounts).toEqual([attendee]);
    expect(registrationEligibility(released, actor(attendee), f.ledger.now())).toMatchObject({ status: 'registration_closed', remaining: 1 });
    const returning = unwrap(await readEventForActor(f.freshEvents(), f.projectRoot, actor(attendee)));
    expect(prepareRegistration(returning, targetForEvent(returning, session(attendee), f.ledger.now())!, session(attendee), f.ledger.now())).toMatchObject({ ok: false });
  }, 60_000);

  it('checks invitation eligibility for each wallet and retains pending state until the organizer admits it', async () => {
    const f = await exhibition();
    const published = await f.publish('publish', finiteAudience({ admission: 'invite_only', invitedAccounts: [attendee], capacity: { kind: 'unlimited' }, waitlist: false }));
    expect(registrationEligibility(published, actor(stranger), f.ledger.now()).status).toBe('invitation_required');
    expect(registrationEligibility(published, actor(attendee), f.ledger.now()).status).toBe('request');
    const before = f.ledger.sends.length, outsider = f.client(stranger);
    expect(await outsider.events.replaceAttendance(outsider.command('replace_attendance', { projectRoot: f.projectRoot,
      releaseKey: published.release!.key, audienceHash: published.release!.payload.audienceHash,
      decision: 'going' as const, expectedHeads: [], lifetimeSeconds }))).toMatchObject({ ok: false });
    expect(f.ledger.sends).toHaveLength(before);
    const request = await requestReview(f, attendee);
    f.ledger.loseNextResponse();
    expect(await f.client(attendee).events.replaceAttendance(request)).toMatchObject({ ok: false, error: { code: 'unverified' } });
    const sent = f.ledger.sends.length, reopened = f.client(attendee);
    expect(unwrap(await reopened.events.reconcile(request.operation)).status).toBe('confirmed');
    unwrap(await reopened.events.replaceAttendance(request));
    expect(f.ledger.sends).toHaveLength(sent);
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('pending');
    unwrap(await f.client(organizer).events.replaceEvent(await ownerReview(f, attendee, 'admit')));
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('going');
    const changed = await f.publish('publish', finiteAudience({ admission: 'invite_only', invitedAccounts: [stranger], capacity: { kind: 'unlimited' }, waitlist: false }));
    expect(myEventStatus(await ownEvent(f, attendee), f.ledger.now())).toBe('needs_review');
    expect(registrationEligibility(changed, actor(attendee), f.ledger.now()).status).toBe('invitation_required');
  }, 60_000);

  it('fails closed on incomplete roster pages and expired reserved evidence without silently freeing a place', async () => {
    const f = await exhibition({ pageSize: 1 });
    // Longer organizer storage makes the attendee's real block expiration independently observable.
    const owner = f.client(organizer), initial = await f.event();
    const published = unwrap(await owner.events.publishEvent(owner.command('publish_event', { projectRoot: f.projectRoot,
      terms: finiteAudience(), source: activeSource(initial.sourceProject!)!, expectedHeads: [], lifetimeSeconds }))).value;
    const request = await requestReview(f, attendee);
    const reserved = unwrap(await f.client(attendee).events.replaceAttendance(request)).value;
    unwrap(await f.client(stranger).events.replaceAttendance(await requestReview(f, stranger, true)));
    const review = await ownerReview(f, attendee, 'admit');
    const { operation: ignored, ...fields } = review;
    let interrupted = 0;
    const partial: RpcRequest = async args => {
      const params = args.params as [string, { cursor?: string }];
      if (args.method === 'arkiv_query' && params[0].includes('attendance_state') && params[1].cursor) {
        interrupted++; throw Object.assign(new Error('Synthetic unavailable next roster page.'), { status: 503 });
      }
      return f.ledger.request(args);
    };
    const unavailable = await f.freshEvents(partial).loadEvent(f.projectRoot);
    expect(interrupted).toBeGreaterThan(0);
    expect(unavailable.ok ? deriveEventAvailability(unavailable.value, f.ledger.now()) : 'unverified').toBe('unverified');
    const strangerCommand = await requestReview(f, stranger, true).catch(() => null);
    expect(strangerCommand).toBeNull(); // Already recorded requests must not be duplicated.
    const before = f.ledger.sends.length;
    expect(await f.client(organizer, partial).events.replaceEvent(review)).toMatchObject({ ok: false });
    expect(f.ledger.sends).toHaveLength(before);
    unwrap(await owner.events.replaceEvent(owner.command('replace_event', { ...fields, lifetimeSeconds })));

    const row = f.ledger.readRows().find(item => item.key === reserved.key)!;
    // Preserve contributor/project evidence through its owners' production renewal path,
    // isolating audience evidence expiration from unrelated preparation expirations.
    for (const evidence of f.ledger.readRows().filter(item => BigInt(item.expiresAt) <= BigInt(row.expiresAt)
      && item.attributes.some(attribute => attribute.name === 'project' && attribute.value === 'partfolk'))) {
      const author = f.client(evidence.creator);
      unwrap(await author.core.renewEntity(author.command('renew_entity', { entityKey: evidence.key,
        extendBySeconds: lifetimeSeconds, lifetimeSeconds })));
    }
    const afterRenewal = f.ledger.sends.length;
    f.ledger.advanceBlocks(Number(BigInt(row.expiresAt)) - f.ledger.blockNumber());
    const expired = await f.event();
    expect(deriveReadiness(expired.sourceProject!, f.ledger.now()).status).toBe('ready');
    expect(expired.release?.key).toBe(published.release!.key);
    expect(expired.state.status).toBe('unique');
    expect(eventRosterVerified(expired, f.ledger.now())).toBe(false);
    expect(deriveEventAvailability(expired, f.ledger.now())).toBe('unverified');
    expect(registrationEligibility(expired, actor(stranger), f.ledger.now())).toMatchObject({ status: 'unverified', remaining: null });
    expect(expired.state.status === 'unique' && expired.state.entity.payload.admissions).toHaveLength(1);
    expect(prepareAdmissionReview(expired, session(organizer), stranger, 'admit', f.ledger.now())).toMatchObject({ ok: false });
    expect(f.ledger.sends).toHaveLength(afterRenewal);
  }, 60_000);
});
