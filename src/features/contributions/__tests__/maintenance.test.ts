import { describe, expect, it } from 'vitest';
import { createLocalRepository, createMemoryStorage } from '../../../data/local';
import type { Result, WriteAuthority } from '../../../data/types';
import { makeSmallWorksFixture, smallWorksRecords, SMALL_WORKS_NOW as now } from '../../../domain/fixtures';
import { inspectBookConflict } from '../../../domain/operations';
import type { PublisherAggregate } from '../../../domain/types';
import { prepareRenewalCommand } from '../Renewal';
import { prepareConflictCommand, resolutionReviewContent } from '../ResolveConflict';

function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
const owner = () => makeSmallWorksFixture().publishers.find(publisher => publisher.root.key === 'local:cedar')!;
function authority(publisher: PublisherAggregate): WriteAuthority { const actor = publisher.root.payload.publisher; if (actor.kind !== 'local') throw new Error('fixture'); return { mode: 'local', actor, chainId: null }; }

describe('contribution lifetime maintenance', () => {
  it('renews only the exact reviewed current root or book and preserves its payload', async () => {
    const repository = createLocalRepository({ namespace: 'practice', storage: createMemoryStorage(), now: () => now });
    value(repository.seed(smallWorksRecords()));
    const publisher = value(await repository.loadPublisher('local:cedar')); if (publisher.book.status !== 'unique') throw new Error('fixture');
    for (const target of ['root', 'book'] as const) {
      const record = target === 'root' ? publisher.root : publisher.book.entity;
      const command = prepareRenewalCommand(publisher, authority(publisher), target, record.key, 30 * 86400, now, `renew-${target}`);
      expect(command.operation.input).toEqual({ entityKey: record.key, extendBySeconds: 30 * 86400, lifetimeSeconds: 30 * 86400 });
      const first = value(await repository.renewEntity(command)); expect(first.value.key).toBe(record.key); expect(first.value.payload).toEqual(record.payload);
      const repeat = value(await repository.renewEntity(command)); expect(repeat.receipt).toEqual(first.receipt);
      expect(value(await repository.reconcile(command.operation)).status).toBe('confirmed');
    }
    const after = value(await repository.loadPublisher(publisher.root.key)); expect(after.root.payload).toEqual(publisher.root.payload);
    if (after.book.status !== 'unique') throw new Error('fixture'); expect(after.book.entity.payload).toEqual(publisher.book.entity.payload);
  });
  it('refuses another owner, stale input, a replaced book, and conflicting books', () => {
    const publisher = owner(); if (publisher.book.status !== 'unique') throw new Error('fixture');
    const record = publisher.book.entity;
    expect(() => prepareRenewalCommand(publisher, { mode: 'local', actor: { kind: 'local', id: 'local-actor:foreign' }, chainId: null }, 'root', publisher.root.key, 86400, now, 'foreign')).toThrow('Only the owner');
    expect(() => prepareRenewalCommand(publisher, authority(publisher), 'book', 'local:old-book', 86400, now, 'replaced')).toThrow('changed');
    publisher.snapshot.freshness = 'stale'; expect(() => prepareRenewalCommand(publisher, authority(publisher), 'book', record.key, 86400, now, 'stale')).toThrow('Refresh'); publisher.snapshot.freshness = 'fresh';
    publisher.book = { status: 'conflict', entities: [record, { ...structuredClone(record), key: 'local:other-book' }] };
    expect(() => prepareRenewalCommand(publisher, authority(publisher), 'book', record.key, 86400, now, 'conflict')).toThrow('changed');
    expect(prepareRenewalCommand(publisher, authority(publisher), 'root', publisher.root.key, 86400, now, 'root').entityKey).toBe(publisher.root.key);
  });
  it('rejects expired public records and does not extend a different identifier', () => {
    const publisher = owner(); publisher.root.provenance.readonly = false;
    expect(() => prepareRenewalCommand(publisher, authority(publisher), 'root', publisher.root.key, 86400, now, 'changed-owner')).toThrow('no longer available');
    publisher.root.provenance.readonly = true;
    expect(() => prepareRenewalCommand(publisher, authority(publisher), 'root', 'local:other-root', 86400, now, 'wrong-root')).toThrow('changed');
    expect(() => prepareRenewalCommand(publisher, authority(publisher), 'root', publisher.root.key, 0, now, 'zero')).toThrow('up to one year');
    const wallet = { kind: 'wallet' as const, address: `0x${'1'.repeat(40)}` as const };
    publisher.root.key = `0x${'a'.repeat(64)}`; publisher.root.payload.publisher = wallet;
    publisher.root.provenance = { ...publisher.root.provenance, mode: 'public', creator: wallet, owner: wallet, createdAtBlock: '10', expiresAtBlock: '20' };
    publisher.snapshot = { ...publisher.snapshot, mode: 'public', chainId: 7738577, blockNumber: '20' };
    expect(() => prepareRenewalCommand(publisher, { mode: 'public', actor: wallet, chainId: 7738577 }, 'root', publisher.root.key, 86400, now, 'expired')).toThrow('no longer available');
  });
});

describe('reviewed contribution conflict command', () => {
  it('freezes the complete reviewed head set in the operation and consumes every head locally', async () => {
    const publisher = owner(); if (publisher.book.status !== 'unique') throw new Error('fixture');
    const first = publisher.book.entity; const second = { ...structuredClone(first), key: 'local:cedar:book:second' as const }; second.payload.operationId = 'second';
    publisher.book = { status: 'conflict', entities: [first, second] };
    const review = inspectBookConflict(publisher);
    const prepared = prepareConflictCommand(publisher, authority(publisher), { reviewedHeads: review.heads, availabilityHeadKey: second.key, decisions: [], operationId: 'resolve', now });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.reasons));
    const command = prepared.command; expect(command.expectedHeads).toEqual(review.heads); expect(command.operation.input).toMatchObject({ expectedHeads: review.heads, book: command.book });
    const repository = createLocalRepository({ namespace: 'practice', storage: createMemoryStorage(), now: () => now }); value(repository.seed([publisher.root, first, second]));
    expect(value(await repository.loadPublisher(publisher.root.key)).book.status).toBe('conflict');
    const result = value(await repository.replaceBook(command)); expect(result.receipt.consumedKeys.sort()).toEqual(review.heads);
    expect(value(await repository.loadPublisher(publisher.root.key)).book.status).toBe('unique');
  });
  it('ignores only newly authored timestamps when rechecking a reviewed merge', () => {
    const publisher = owner(); if (publisher.book.status !== 'unique') throw new Error('fixture'); const first = publisher.book.entity.payload; const next = structuredClone(first); next.createdAt += 10;
    expect(resolutionReviewContent(first, 'resolve')).toBe(resolutionReviewContent(next, 'resolve'));
    next.description = 'Material new description'; expect(resolutionReviewContent(first, 'resolve')).not.toBe(resolutionReviewContent(next, 'resolve'));
  });
});
