import { hashCanonical, hashOffer } from '../../domain/canonical';
import { sameActor, sameSource, activeSource, validateCurrentEntity } from '../../domain/readiness';
import { prepareDecision, prepareReleaseCommitment } from '../../domain/operations';
import { validateBookState } from '../../domain/validation';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from '../../domain/types';
import type { Actor, BookState, Condition, EntityKey, Offer, ProjectAggregate, PublisherAggregate, Resource, SourcePlanRef } from '../../domain/types';
import type { ReplaceBookCommand, WriteAuthority } from '../../data/types';
import { createOperationIntent } from '../../data/operations';
import { localDateTimeToUtc, utcToLocalDateTime } from '../../app/time';
import { isEntityKey, isPublicEntityKey } from '../../app/ids';
import { contributionReasons } from './catalog';

export const DEFAULT_LIFETIME = 90 * 24 * 60 * 60;
export interface AvailabilityWindowDraft { id: string; start: string; end: string; timeZone: string }
export interface ContributionDraft { name: string; description: string; resources: Resource[]; offers: Offer[]; publisherKind?: 'individual' | 'organization'; editorWindows?: Record<string, AvailabilityWindowDraft[]>; editorNumbers?: Record<string, string> }
export interface ContributionTemplate extends ContributionDraft { kind: 'individual' | 'organization' }
export function actorScope(actor: Actor | null): string { return actor ? hashCanonical(actor).slice(2, 34) : 'visitor'; }
export function isContributionTarget(value: string, mode: 'public' | 'local'): value is EntityKey {
  return mode === 'public' ? isPublicEntityKey(value) : isEntityKey(value) && value.startsWith('local:');
}
export function writeAuthority(actor: Actor | null, mode: 'public' | 'local', chainId: number | null): WriteAuthority | null {
  if (mode === 'local' && actor?.kind === 'local') return { mode, actor, chainId: null };
  if (mode === 'public' && actor?.kind === 'wallet' && chainId === TIRAMISU_CHAIN_ID) return { mode, actor, chainId: TIRAMISU_CHAIN_ID };
  return null;
}
export function ownsPublisher(publisher: PublisherAggregate, actor: Actor | null): boolean {
  return !!actor && sameActor(actor, publisher.root.payload.publisher) && sameActor(actor, publisher.root.provenance.creator)
    && sameActor(actor, publisher.root.provenance.owner);
}
export function contributionDraft(book: BookState): ContributionDraft {
  return structuredClone({ name: book.name, description: book.description, resources: book.resources, offers: book.offers });
}
export function isContributionDraft(value: unknown): value is ContributionDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ContributionDraft;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
  const intervals = (v: unknown) => Array.isArray(v) && v.every(x => x && typeof x === 'object' && Number.isSafeInteger(x.start) && Number.isSafeInteger(x.end) && x.start >= 0 && x.end > x.start && x.end <= 8_640_000_000_000_000);
  const kinds = ['person', 'place', 'equipment'];
  const conditions = (v: unknown) => Array.isArray(v) && v.every(c => c && typeof c === 'object' && (
    c.kind === 'requires_capability' ? typeof c.capability === 'string' : c.kind === 'allowed_variants' ? strings(c.variantIds)
      : c.kind === 'allowed_venues' ? strings(c.venueIds) : (c.kind === 'requires_offer' || c.kind === 'excludes_offer') && typeof c.offer?.publisherRoot === 'string' && typeof c.offer?.offerId === 'string'));
  return typeof draft.name === 'string' && typeof draft.description === 'string' && Array.isArray(draft.resources) && Array.isArray(draft.offers)
    && draft.resources.every(r => typeof r?.id === 'string' && typeof r?.name === 'string' && kinds.includes(r.kind) && typeof r.unit === 'string'
      && Number.isSafeInteger(r.capacity) && intervals(r.availability) && strings(r.capabilities))
    && draft.offers.every(o => typeof o?.id === 'string' && typeof o?.title === 'string' && typeof o.resourceId === 'string' && kinds.includes(o.kind)
      && typeof o.unit === 'string' && Number.isSafeInteger(o.quantity) && intervals(o.availability) && strings(o.capabilities) && strings(o.projectScope)
      && typeof o.instructions === 'string' && conditions(o.conditions))
    && (draft.editorWindows === undefined || (!!draft.editorWindows && typeof draft.editorWindows === 'object' && !Array.isArray(draft.editorWindows)
      && Object.values(draft.editorWindows).every(w => Array.isArray(w) && w.every(v => v && typeof v.id === 'string' && typeof v.start === 'string' && typeof v.end === 'string' && typeof v.timeZone === 'string'))))
    && (draft.editorNumbers === undefined || (!!draft.editorNumbers && typeof draft.editorNumbers === 'object' && !Array.isArray(draft.editorNumbers) && Object.values(draft.editorNumbers).every(v => typeof v === 'string')))
    && (draft.publisherKind === undefined || draft.publisherKind === 'individual' || draft.publisherKind === 'organization');
}
export function editableWindows(intervals: Resource['availability']): AvailabilityWindowDraft[] {
  return intervals.map((interval, index) => ({ id: `window-${index}`, start: utcToLocalDateTime(interval.start, 'UTC'), end: utcToLocalDateTime(interval.end, 'UTC'), timeZone: 'UTC' }));
}
export function availabilityWindowError(window: AvailabilityWindowDraft): string {
  const start = localDateTimeToUtc(window.start, window.timeZone), end = localDateTimeToUtc(window.end, window.timeZone);
  return !start.ok ? `Start: ${start.error.replaceAll('_', ' ')}.` : !end.ok ? `End: ${end.error.replaceAll('_', ' ')}.`
    : start.utcMilliseconds >= end.utcMilliseconds ? 'The end must be after the start.' : '';
}
export function quantityError(raw: string): string { return !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 1_000_000 ? 'Enter a whole quantity from 1 to 1,000,000.' : ''; }
export function materializeContributionDraft(draft: ContributionDraft): ContributionDraft {
  const windows = (key: string, fallback: Resource['availability']) => draft.editorWindows?.[key]?.map(raw => {
    const error = availabilityWindowError(raw); if (error) throw new Error(`${key}: ${error}`);
    const start = localDateTimeToUtc(raw.start, raw.timeZone), end = localDateTimeToUtc(raw.end, raw.timeZone);
    if (!start.ok || !end.ok) throw new Error('Invalid availability window.');
    return { start: start.utcMilliseconds, end: end.utcMilliseconds };
  }) ?? structuredClone(fallback);
  const quantity = (key: string, fallback: number) => {
    const raw = draft.editorNumbers?.[key]; if (raw === undefined) return fallback;
    const error = quantityError(raw); if (error) throw new Error(`${key}: ${error}`);
    return Number(raw);
  };
  return { name: draft.name, description: draft.description,
    resources: draft.resources.map(r => ({ ...structuredClone(r), capacity: quantity(`resource:${r.id}:capacity`, r.capacity), availability: windows(`resource:${r.id}`, r.availability) })),
    offers: draft.offers.map(o => ({ ...structuredClone(o), quantity: quantity(`offer:${o.id}:quantity`, o.quantity), availability: windows(`offer:${o.id}`, o.availability) })) };
}
export function removeDraftOffer(draft: ContributionDraft, offerId: string): ContributionDraft {
  const next = structuredClone(draft); next.offers = next.offers.filter(o => o.id !== offerId);
  if (next.editorWindows) delete next.editorWindows[`offer:${offerId}`];
  if (next.editorNumbers) delete next.editorNumbers[`offer:${offerId}:quantity`];
  return next;
}
export function removeDraftResource(draft: ContributionDraft, resourceId: string): ContributionDraft {
  let next = structuredClone(draft);
  for (const offer of draft.offers.filter(o => o.resourceId === resourceId)) next = removeDraftOffer(next, offer.id);
  next.resources = next.resources.filter(r => r.id !== resourceId);
  if (next.editorWindows) delete next.editorWindows[`resource:${resourceId}`];
  if (next.editorNumbers) delete next.editorNumbers[`resource:${resourceId}:capacity`];
  return next;
}
export function addDraftOffer(draft: ContributionDraft, resourceId: string, offerId: string): ContributionDraft {
  const resource = draft.resources.find(r => r.id === resourceId); if (!resource) throw new Error('Select a current resource.');
  const next = structuredClone(draft);
  next.offers.push({ id: offerId, title: '', resourceId: resource.id, kind: resource.kind, unit: resource.unit, quantity: 1,
    capabilities: [...resource.capabilities], availability: structuredClone(resource.availability), projectScope: [], conditions: [], instructions: '' });
  if (draft.editorWindows?.[`resource:${resourceId}`]) next.editorWindows = { ...next.editorWindows,
    [`offer:${offerId}`]: draft.editorWindows[`resource:${resourceId}`]!.map((window, index) => ({ ...window, id: `${offerId}:window:${index}` })) };
  return next;
}
export function bookLifetime(book: BookState, now: number): number {
  return Math.max(DEFAULT_LIFETIME, book.retentionDays * 86400, ...book.grants.map(g => Math.ceil((g.validUntil - now) / 1000) + 60));
}
export function prepareAvailability(publisher: PublisherAggregate, draft: ContributionDraft, authority: WriteAuthority, now: number, id: string): ReplaceBookCommand {
  if (!ownsPublisher(publisher, authority.actor)) throw new Error('Only the current owner can change this contribution.');
  if (publisher.book.status !== 'unique') throw new Error('Refresh the contribution. A single current availability book is required.');
  const checks = [...validateCurrentEntity(publisher.root, publisher.snapshot, authority.actor).reasons,
    ...validateCurrentEntity(publisher.book.entity, publisher.snapshot, authority.actor).reasons];
  if (checks.length || publisher.snapshot.completeness !== 'complete' || publisher.snapshot.freshness !== 'fresh') throw new Error('Refresh complete, current availability before publishing.');
  const book: BookState = { ...structuredClone(publisher.book.entity.payload), ...materializeContributionDraft(draft), createdAt: now, operationId: id, predecessorKeys: [publisher.book.entity.key] };
  if (publisher.root.payload.kind === 'individual' && book.resources.some(r => r.kind === 'person' && (r.id !== 'self' || r.capacity !== 1))) throw new Error('All personal time must share one person resource named self, with capacity one.');
  const validation = validateBookState(book);
  if (!validation.valid) throw new Error(`Check the contribution: ${validation.reasons.map(r => `${r.code.replaceAll('_', ' ')}${r.path ? ` (${r.path})` : ''}`).join('; ')}.`);
  const input = { publisherRoot: publisher.root.key, expectedHeads: [publisher.book.entity.key], book, lifetimeSeconds: bookLifetime(book, now) };
  return { ...input, operation: createOperationIntent('replace_book', authority, input, { id, now }) };
}
/** Recovery never copies historical promises, availability, or claims of physical return. */
export function prepareEmptyRecovery(publisher: PublisherAggregate, authority: WriteAuthority, name: string, now: number, id: string): ReplaceBookCommand {
  if (!ownsPublisher(publisher, authority.actor) || !validateCurrentEntity(publisher.root, publisher.snapshot, authority.actor).valid) throw new Error('The original publisher identity must still be live and owned by this account.');
  if (publisher.book.status !== 'missing' || publisher.snapshot.completeness !== 'complete' || publisher.snapshot.freshness !== 'fresh') throw new Error('Refresh first. Recovery requires a confirmed missing book with no competing current state.');
  if (!name.trim()) throw new Error('Enter a public contribution name.');
  const book: BookState = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'book_state', operationId: id, createdAt: now,
    publisherRoot: publisher.root.key, predecessorKeys: [], name: name.trim(), description: '', resources: [], offers: [], decisions: [], grants: [], attestations: [], custodyHolds: [], retentionDays: 90 };
  const input = { publisherRoot: publisher.root.key, expectedHeads: [], book, recovery: { acknowledgedMissingState: true as const, redeclaredAvailability: true as const }, lifetimeSeconds: DEFAULT_LIFETIME };
  return { ...input, operation: createOperationIntent('replace_book', authority, input, { id, now }) };
}
export function prepareDecisionCommand(project: ProjectAggregate, publisherRoot: EntityKey, authority: WriteAuthority,
  input: { status: 'accepted' | 'declined' | 'withdrawn'; reason?: string; validUntil?: number; now: number; id: string; reviewedSource: SourcePlanRef }): ReplaceBookCommand {
  const source = activeSource(project);
  if (!source || !sameSource(source, input.reviewedSource)) throw new Error('The active plan changed. Review the new complete plan before deciding.');
  const result = prepareDecision(project, publisherRoot, authority.actor, { ...input, operationId: input.id });
  if (!result.ok) throw new Error(result.reasons.map(r => contributionReasons[r.code]).join(' '));
  const command = { publisherRoot, ...result.value, lifetimeSeconds: bookLifetime(result.value.book, input.now) };
  return { ...command, operation: createOperationIntent('replace_book', authority, command, { id: input.id, now: input.now }) };
}
export function prepareReleaseCommand(publisher: PublisherAggregate, authority: WriteAuthority, source: SourcePlanRef, now: number, id: string): ReplaceBookCommand {
  const exactSource = { projectRoot: source.projectRoot, activationKey: source.activationKey, proposalKey: source.proposalKey, proposalHash: source.proposalHash };
  const result = prepareReleaseCommitment(publisher, authority.actor, exactSource, id, now);
  if (!result.ok) throw new Error(result.reasons.map(r => contributionReasons[r.code]).join(' '));
  const command = { publisherRoot: publisher.root.key, ...result.value, lifetimeSeconds: bookLifetime(result.value.book, now) };
  return { ...command, operation: createOperationIntent('replace_book', authority, command, { id, now }) };
}
export function affectedProjects(book: BookState, draft: ContributionDraft): EntityKey[] {
  try { draft = materializeContributionDraft(draft); } catch { return []; }
  return [...new Set(book.grants.filter(grant => grant.offers.some(ref => {
    const offer = draft.offers.find(o => o.id === ref.offerId);
    if (!offer) return true;
    try { return hashOffer(book.publisherRoot, offer) !== ref.offerHash || hashCanonical(book.resources.find(r => r.id === offer.resourceId) ?? null) !== hashCanonical(draft.resources.find(r => r.id === offer.resourceId) ?? null); }
    catch { return true; }
  })).map(g => g.projectRoot))];
}
export function conditionText(condition: Condition): string {
  if (condition.kind === 'requires_capability') return `Requires capability: ${condition.capability}`;
  if (condition.kind === 'allowed_variants') return `Only these plan options: ${condition.variantIds.join(', ')}`;
  if (condition.kind === 'allowed_venues') return `Only these venues: ${condition.venueIds.join(', ')}`;
  return `${condition.kind === 'requires_offer' ? 'Requires' : 'Cannot be combined with'} offer ${condition.offer.offerId} from ${condition.offer.publisherRoot}`;
}
export function publisherName(publisher: PublisherAggregate | undefined, fallback: EntityKey): string {
  return publisher?.book.status === 'unique' ? publisher.book.entity.payload.name : `${fallback} (current name unavailable)`;
}
