import type { Actor, EntityKey } from '../../domain/types';
import type { OperationIntent, ReadOptions } from '../types';
import type { ArkivRepositoryOptions } from '../arkiv';
import { invalidateArkivReadCache } from '../arkiv/client';
import { asResult } from '../arkiv/errors';
import { EventReader } from './reader';
import { EventReadCache, eventReadKey } from './read-cache';
import { EventWriter } from './writer';
import type { EventFilters, EventReadOptions, EventRepositoryContract, PublishEventCommand, ReplaceAttendanceCommand, ReplaceEventCommand } from './types';

export type EventRepositoryOptions = ArkivRepositoryOptions;
export class EventRepository implements EventRepositoryContract {
  readonly mode = 'public' as const;
  readonly reader: EventReader;
  readonly writer: EventWriter;
  private readonly reads = new EventReadCache();
  constructor(options: EventRepositoryOptions = {}) {
    this.reader = new EventReader(options); this.writer = new EventWriter(this.reader, options.controller, options.receiptTimeoutMs);
  }
  listEvents(filters: EventFilters = {}, options: ReadOptions = {}) {
    return asResult(() => {
      const input = { ...filters }, snapshot = options.snapshot && structuredClone(options.snapshot);
      return this.reads.run(eventReadKey(['catalog', input, snapshot]),
        signal => this.reader.listEvents(input, { snapshot, signal }), options.signal);
    });
  }
  loadEvent(root: EntityKey, options: EventReadOptions = {}) {
    return asResult(() => {
      const snapshot = options.snapshot && structuredClone(options.snapshot), includeSource = options.includeSource;
      return this.reads.run(eventReadKey(['event', root, snapshot, includeSource]),
        signal => this.reader.loadEvent(root, { snapshot, includeSource, signal }), options.signal);
    });
  }
  listMyEvents(actor: Actor, options: EventReadOptions = {}) {
    return asResult(() => {
      const account = { ...actor }, snapshot = options.snapshot && structuredClone(options.snapshot), includeSource = options.includeSource;
      return this.reads.run(eventReadKey(['mine', account, snapshot, includeSource]),
        signal => this.reader.listMyEvents(account, { snapshot, includeSource, signal }), options.signal);
    });
  }
  private changed<T>(operation: () => Promise<T>) {
    return asResult(async () => {
      try { return await operation(); }
      finally { this.reads.invalidate(); invalidateArkivReadCache(this.reader.core.request); }
    });
  }
  // Writer preflights use the reader directly, never the display coalescer.
  publishEvent(command: PublishEventCommand) { return this.changed(() => this.writer.publishEvent(command)); }
  replaceEvent(command: ReplaceEventCommand) { return this.changed(() => this.writer.replaceEvent(command)); }
  replaceAttendance(command: ReplaceAttendanceCommand) { return this.changed(() => this.writer.replaceAttendance(command)); }
  reconcile(operation: OperationIntent) { return this.changed(() => this.writer.reconcile(operation)); }
}
export const createEventRepository = (options: EventRepositoryOptions = {}) => new EventRepository(options);
