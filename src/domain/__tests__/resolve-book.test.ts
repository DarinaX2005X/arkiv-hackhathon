import { describe, expect, it } from 'vitest';
import { hashCanonical, hashOffer } from '../canonical';
import { localRecord, makePublisher, SMALL_WORKS_NOW as now } from '../fixtures';
import { inspectBookConflict, prepareResolveBook } from '../operations';
import type { ResolveBookInput } from '../operations';
import type { BookState, EntityRecord, Grant, SourcePlanRef } from '../types';

const source = (id: string): SourcePlanRef => ({ projectRoot: `local:project-${id}`, activationKey: `local:activation-${id}`, proposalKey: `local:proposal-${id}`, proposalHash: hashCanonical(id) });
function fixture(capacity = 2) {
  const interval = { start: now + 60_000, end: now + 120_000 };
  const publisher = makePublisher('fork-owner', { kind: 'organization', resources: [{ id: 'kit', kind: 'equipment', name: 'Kit', unit: 'kit', capacity, capabilities: ['installation'], availability: [interval] }], offers: [{ id: 'kit', title: 'Installation kit', resourceId: 'kit', kind: 'equipment', unit: 'kit', quantity: capacity, capabilities: ['installation'], availability: [interval], projectScope: [], conditions: [], instructions: '' }] });
  if (publisher.book.status !== 'unique') throw new Error('fixture');
  const base = publisher.book.entity.payload;
  const heads = ['a', 'b', 'c'].map(id => localRecord(`local:fork-${id}`, { ...structuredClone(base), operationId: `fork-${id}`, name: `Copy ${id}` }, publisher.root.payload.publisher));
  publisher.book = { status: 'conflict', entities: heads };
  const input: ResolveBookInput = { reviewedHeads: heads.map(head => head.key), availabilityHeadKey: heads[0]!.key, decisions: [], now, operationId: 'resolve-forks' };
  const promise = (head: EntityRecord<BookState>, id: string) => {
    const binding = source(id); const offer = head.payload.offers[0]!;
    const grant: Grant = { ...binding, id: `grant-${id}`, protocol: 'partfolk/1', chainId: null, acceptedAt: now, validUntil: now + 180_000, operationId: `accept-${id}`,
      offers: [{ publisherRoot: publisher.root.key, offerId: offer.id, offerHash: hashOffer(publisher.root.key, offer) }],
      allocations: [{ id: `allocation-${id}`, requirementId: 'installation', publisherRoot: publisher.root.key, offerId: offer.id, offerHash: hashOffer(publisher.root.key, offer), resourceId: 'kit', quantity: 1, unit: 'kit', interval }] };
    head.payload.decisions.push({ ...binding, status: 'accepted', decidedAt: now, operationId: `accept-${id}` }); head.payload.grants.push(grant);
    return grant;
  };
  const resolve = () => prepareResolveBook(publisher, publisher.root.payload.publisher, input);
  return { publisher, heads, input, promise, resolve };
}
function merged(result: ReturnType<typeof prepareResolveBook>) { if (!result.ok) throw new Error(JSON.stringify(result.reasons)); return result.value; }

describe('complete owner book conflict resolution', () => {
  it('consumes all three reviewed heads and retains union promises, statements, and custody', () => {
    const { publisher, heads, input, promise, resolve } = fixture(); const grantA = promise(heads[0]!, 'a'); const grantB = promise(heads[1]!, 'b');
    heads[2]!.payload.grants.push(structuredClone(grantA)); heads[2]!.payload.decisions.push(structuredClone(heads[0]!.payload.decisions[0]!));
    heads[1]!.payload.attestations.push({ ...source('b'), id: 'work-b', kind: 'task_report', obligationId: 'task-b', author: publisher.root.key, recordedAt: now, operationId: 'report-b', status: 'done', note: 'Owner report' });
    heads[2]!.payload.custodyHolds.push({ id: 'hold-a', projectRoot: source('a').projectRoot, resourceId: 'kit', quantity: 1, unit: 'kit', source: source('a'), transferId: 'handover-a', createdAt: now, status: 'outstanding' });
    const result = merged(resolve());
    expect(result.expectedHeads).toEqual([...input.reviewedHeads].sort()); expect(result.book.predecessorKeys).toEqual(result.expectedHeads);
    expect(result.book.name).toBe('Copy a'); expect(result.book.grants).toEqual([grantA, grantB]); expect(result.book.decisions).toHaveLength(2);
    expect(result.book.attestations).toEqual(heads[1]!.payload.attestations); expect(result.book.custodyHolds).toEqual(heads[2]!.payload.custodyHolds);
    expect(heads[0]!.payload.operationId).toBe('fork-a');
  });
  it('rejects an incomplete, duplicated, or changed reviewed head set', () => {
    const { input, resolve } = fixture(); input.reviewedHeads.pop(); expect(resolve()).toMatchObject({ ok: false, reasons: [{ code: 'conflicting_heads' }] });
    input.reviewedHeads.push(input.reviewedHeads[0]!); expect(resolve().ok).toBe(false);
  });
  it('never chooses the newest contradictory decision automatically', () => {
    const { publisher, heads, input, promise, resolve } = fixture(); promise(heads[0]!, 'a');
    heads[1]!.payload.decisions.push({ ...source('a'), status: 'declined', decidedAt: now + 1, operationId: 'later-decline' });
    expect(resolve()).toMatchObject({ ok: false, reasons: [{ code: 'contradictory_decision' }] });
    input.decisions = [{ key: inspectBookConflict(publisher).decisions[0]!.key, kind: 'recorded', headKey: heads[1]!.key }];
    const result = merged(resolve()); expect(result.book.grants).toHaveLength(0); expect(result.book.decisions[0]!.status).toBe('declined');
  });
  it('refuses conflicting live capacity until the owner explicitly withdraws a promise', () => {
    const { publisher, heads, input, promise, resolve } = fixture(1); promise(heads[0]!, 'a'); promise(heads[1]!, 'b');
    expect(resolve()).toMatchObject({ ok: false, reasons: expect.arrayContaining([{ code: 'capacity_exceeded', publisherRoot: publisher.root.key, resourceId: 'kit', params: { capacity: 1, required: 2 } }]) });
    const group = inspectBookConflict(publisher).decisions.find(item => item.source.projectRoot === 'local:project-b')!;
    input.decisions = [{ key: group.key, kind: 'withdraw', reason: 'Only one kit is available.' }];
    const result = merged(resolve()); expect(result.book.grants.map(grant => grant.id)).toEqual(['grant-a']);
    expect(result.book.decisions.find(decision => decision.projectRoot === 'local:project-b')).toMatchObject({ status: 'withdrawn', reason: 'Only one kit is available.', operationId: input.operationId, decidedAt: now });
    input.decisions = [{ key: group.key, kind: 'withdraw', reason: ' ' }]; expect(resolve().ok).toBe(false);
  });
  it('rejects same-ID contradictory work or custody facts instead of inventing a return', () => {
    const { publisher, heads, resolve } = fixture();
    const statement: BookState['attestations'][number] = { ...source('a'), id: 'work', kind: 'task_report', obligationId: 'task', author: publisher.root.key, recordedAt: now, operationId: 'report', status: 'done', note: '' };
    heads[0]!.payload.attestations = [statement]; heads[1]!.payload.attestations = [{ ...statement, status: 'not_done' }];
    expect(resolve()).toMatchObject({ ok: false, reasons: [{ code: 'attestation_mismatch' }] });
    heads[1]!.payload.attestations = [structuredClone(statement)];
    const hold: BookState['custodyHolds'][number] = { id: 'hold', projectRoot: source('a').projectRoot, resourceId: 'kit', quantity: 1, unit: 'kit', source: source('a'), transferId: 'transfer', createdAt: now, status: 'outstanding' };
    heads[0]!.payload.custodyHolds = [hold]; heads[1]!.payload.custodyHolds = [{ ...hold, status: 'released', release: { at: now, operationId: 'release', reason: 'Different authored claim' } }];
    expect(resolve()).toMatchObject({ ok: false, reasons: [{ code: 'custody_outstanding' }] });
  });
  it('retains supporting resources without restoring their removed availability', () => {
    const { heads, promise, resolve } = fixture(); promise(heads[1]!, 'b'); heads[0]!.payload.resources = []; heads[0]!.payload.offers = [];
    const result = merged(resolve()); expect(result.book.offers).toEqual([]); expect(result.book.grants).toHaveLength(1);
    expect(result.book.resources).toMatchObject([{ id: 'kit', availability: [] }]);
  });
  it('retains historical decisions but does not renew expired approvals', () => {
    const { publisher, heads, promise, resolve } = fixture(); const grant = promise(heads[0]!, 'a');
    publisher.snapshot.blockTimestamp = grant.validUntil; publisher.snapshot.fetchedAt = grant.validUntil;
    expect(prepareResolveBook(publisher, publisher.root.payload.publisher, { ...fixture().input, now: grant.validUntil })).toMatchObject({ ok: true, value: { book: { grants: [], decisions: [{ status: 'accepted' }] } } });
    expect(resolve().ok).toBe(false);
  });
  it('rejects a foreign actor, foreign head, stale snapshot, or incomplete snapshot', () => {
    const { publisher, heads, input, resolve } = fixture();
    expect(prepareResolveBook(publisher, { kind: 'local', id: 'local-actor:foreign' }, input)).toMatchObject({ ok: false, reasons: [{ code: 'foreign_author' }] });
    publisher.snapshot.freshness = 'stale'; expect(resolve().ok).toBe(false); publisher.snapshot.freshness = 'fresh';
    publisher.snapshot.completeness = 'incomplete'; expect(resolve().ok).toBe(false); publisher.snapshot.completeness = 'complete';
    heads[1]!.provenance.creator = { kind: 'local', id: 'local-actor:foreign' }; expect(resolve().ok).toBe(false);
  });
});
