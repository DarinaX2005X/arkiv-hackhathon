import type { Actor, DomainReason, EntityKey, SourcePlanRef } from '../../domain/types';
import type { AttendanceState, AudienceTerms, EventAggregate, EventRecord, EventRelease, EventScope, EventState } from '../../domain/events';
import type { CommandBase, ListResult, MutationResult, OperationIntent, ReadOptions, ReconciliationResult, Result } from '../types';

export interface EventFilters { search?: string; from?: number; to?: number }
export interface EventReadOptions extends ReadOptions {
  /** Undefined loads source when availability needs it; true always loads it; false verifies only the event envelope. */
  includeSource?: boolean;
}
export interface MyEvent {
  projectRoot: EntityKey; attendance: EventScope<AttendanceState>; event: EventAggregate | null;
  registeredRelease: EventRecord<EventRelease> | null; diagnostics: DomainReason[];
}
export interface PublishEventCommand extends CommandBase {
  projectRoot: EntityKey; terms: AudienceTerms; source: SourcePlanRef; expectedHeads: EntityKey[];
}
export interface ReplaceEventCommand extends CommandBase {
  projectRoot: EntityKey; releaseKey: EntityKey; audienceHash: EventRelease['audienceHash'];
  source: SourcePlanRef; status: EventState['status']; expectedHeads: EntityKey[];
}
export interface ReplaceAttendanceCommand extends CommandBase {
  projectRoot: EntityKey; releaseKey: EntityKey; audienceHash: EventRelease['audienceHash'];
  decision: AttendanceState['decision']; expectedHeads: EntityKey[];
}
export interface EventRepositoryContract {
  readonly mode: 'public';
  listEvents(filters?: EventFilters, options?: ReadOptions): Promise<Result<ListResult<EventAggregate>>>;
  loadEvent(projectRoot: EntityKey, options?: EventReadOptions): Promise<Result<EventAggregate>>;
  listMyEvents(actor: Actor, options?: EventReadOptions): Promise<Result<ListResult<MyEvent>>>;
  publishEvent(command: PublishEventCommand): Promise<Result<MutationResult<EventAggregate>>>;
  replaceEvent(command: ReplaceEventCommand): Promise<Result<MutationResult<EventRecord<EventState>>>>;
  replaceAttendance(command: ReplaceAttendanceCommand): Promise<Result<MutationResult<EventRecord<AttendanceState>>>>;
  reconcile(operation: OperationIntent): Promise<Result<ReconciliationResult>>;
}
