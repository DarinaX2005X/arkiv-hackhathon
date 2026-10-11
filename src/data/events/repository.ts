import type { Actor, EntityKey } from '../../domain/types';
import type { OperationIntent, ReadOptions } from '../types';
import type { ArkivRepositoryOptions } from '../arkiv';
import { asResult } from '../arkiv/errors';
import { EventReader } from './reader';
import { EventWriter } from './writer';
import type { EventFilters, EventReadOptions, EventRepositoryContract, PublishEventCommand, ReplaceAttendanceCommand, ReplaceEventCommand } from './types';

export type EventRepositoryOptions = ArkivRepositoryOptions;
export class EventRepository implements EventRepositoryContract {
  readonly mode = 'public' as const;
  readonly reader: EventReader;
  readonly writer: EventWriter;
  constructor(options: EventRepositoryOptions = {}) {
    this.reader = new EventReader(options); this.writer = new EventWriter(this.reader, options.controller, options.receiptTimeoutMs);
  }
  listEvents(filters?: EventFilters, options?: ReadOptions) { return asResult(() => this.reader.listEvents(filters, options)); }
  loadEvent(root: EntityKey, options?: EventReadOptions) { return asResult(() => this.reader.loadEvent(root, options)); }
  listMyEvents(actor: Actor, options?: ReadOptions) { return asResult(() => this.reader.listMyEvents(actor, options)); }
  publishEvent(command: PublishEventCommand) { return asResult(() => this.writer.publishEvent(command)); }
  replaceEvent(command: ReplaceEventCommand) { return asResult(() => this.writer.replaceEvent(command)); }
  replaceAttendance(command: ReplaceAttendanceCommand) { return asResult(() => this.writer.replaceAttendance(command)); }
  reconcile(operation: OperationIntent) { return asResult(() => this.writer.reconcile(operation)); }
}
export const createEventRepository = (options: EventRepositoryOptions = {}) => new EventRepository(options);
