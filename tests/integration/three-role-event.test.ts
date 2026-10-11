import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import type { AppSession } from '../../src/app/session';
import { createArkivRepository } from '../../src/data/arkiv';
import type { RpcRequest } from '../../src/data/arkiv/client';
import { createEventRepository } from '../../src/data/events';
import { BrowserOperationStore, createOperationController, createOperationIntent, MemoryOperationStore } from '../../src/data/operations';
import type { OperationKind, Result, WriteAuthority } from '../../src/data/types';
import { createWalletGateway } from '../../src/data/wallet';
import type { NativeTransactionRequest, RpcRequest as WalletRequest } from '../../src/data/wallet';
import { canonicalJson } from '../../src/domain/canonical';
import { audienceChanges, deriveEventAvailability } from '../../src/domain/events';
import type { AudienceTerms } from '../../src/domain/events';
import { activeSource, deriveReadiness } from '../../src/domain/readiness';
import { solve } from '../../src/domain/solver';
import { TIRAMISU_CHAIN_ID } from '../../src/domain/types';
import type { AccountAddress, Actor, EntityKey, Offer, ProjectRecipe, PublicEntityKey, Resource } from '../../src/domain/types';
import { matchesMyEventFilter, myEventStatus } from '../../src/features/attendance/MyEvents';
import { prepareRegistration, prepareWithdrawal, targetForEvent, targetForWithdrawal } from '../../src/features/attendance/intent';
import { prepareDecisionCommand } from '../../src/features/contributions/model';
import { readEventForActor, readEventForWithdrawal } from '../../src/features/events/hooks';
import { preparePublishingReview, publishingFields, submitPublishingCommand, validatePublishingReview } from '../../src/features/events/publishing/model';
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

function workspace() {
  const ledger = createNativeLedger({ now: NOW });
  const journals = new Map<AccountAddress, Map<string, string>>();
  const locks = new MemoryOperationStore();
  let serial = 0;
  const nextId = (label: string) => `${label}-${++serial}`;
  /** Each reopening has new repositories/controller; only its own serialized journal survives. */
  function client(account: AccountAddress, request: RpcRequest = ledger.request) {
    let storage = journals.get(account);
    if (!storage) { storage = new Map(); journals.set(account, storage); }
    const ownStorage = storage, state = { account };
    const store = new BrowserOperationStore({ getItem: key => ownStorage.get(key) ?? null,
      setItem: (key, value) => { ownStorage.set(key, value); } }, { key: `journal:${account}`, lockKey: `journal:${account}`, locks });
    const provider = { request: async (args: WalletRequest): Promise<unknown> => {
      if (args.method === 'eth_accounts') return [state.account];
      if (args.method === 'eth_chainId') return toHex(TIRAMISU_CHAIN_ID);
      if (args.method !== 'eth_sendTransaction') throw new Error(`Unexpected synthetic wallet method ${args.method}`);
      const transaction = args.params![0] as NativeTransactionRequest;
      const record = store.list().find(item => item.step.status === 'unverified'
        && canonicalJson(item.admission?.request) === canonicalJson(transaction));
      if (!record) throw new Error('A native send must have its exact persisted admission.');
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

async function exhibition() {
  const f = workspace();
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
    const unavailable = await f.freshEvents(outage).loadEvent(f.projectRoot);
    expect(blockedSourceCalls).toBeGreaterThan(0);
    expect(unavailable.ok ? deriveEventAvailability(unavailable.value, f.ledger.now()) : 'unverified').toBe('unverified');
    blockedSourceCalls = 0;
    const ownRead = unwrap(await readEventForWithdrawal(f.freshEvents(outage), f.projectRoot, actor(attendee)));
    const withdrawal = prepared(prepareWithdrawal(ownRead, targetForWithdrawal(ownRead, session(attendee), f.ledger.now())!, session(attendee), f.ledger.now()));
    const withdrew = unwrap(await f.client(attendee, outage).events.replaceAttendance(withdrawal));
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
