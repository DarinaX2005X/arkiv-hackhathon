import { PROTOCOL } from './types';
import type {
  Actor, BookState, EntityKey, EntityPayload, EntityRecord, Interval, Offer, ProjectAggregate,
  ProjectRecipe, ProjectRoot, ProjectState, PublisherAggregate, PublisherRoot, Requirement,
  Resource, Snapshot, SolverInput,
} from './types';

/** Explicitly synthetic, offline-only practice. Dates are fixed for reproducible evidence. */
export const SMALL_WORKS_NOW = Date.parse('2026-10-09T09:00:00.000Z');
export const SMALL_WORKS_PROJECT_ROOT: EntityKey = 'local:small-works';
export const SMALL_WORKS_COORDINATOR: Actor = { kind: 'local', id: 'local-actor:coordinator' };
export const smallWorksActors: Record<string, Actor> = Object.fromEntries(
  ['library', 'courtyard', 'makerspace', 'cedar', 'willow', 'ash', 'elm', 'oak', 'juniper'].map(id => [id, { kind: 'local', id: `local-actor:${id}` } as Actor]),
);

export function createLocalSnapshot(now = SMALL_WORKS_NOW): Snapshot {
  return { mode: 'local', chainId: null, blockNumber: null, blockHash: null, blockTimestamp: now, fetchedAt: now,
    completeness: 'complete', freshness: 'fresh', source: 'local', reasons: [] };
}

export function localRecord<T extends EntityPayload>(key: EntityKey, payload: T, actor: Actor): EntityRecord<T> {
  return { key, payload, provenance: { mode: 'local', creator: actor, owner: actor, readonly: true, permissionlessExtension: false,
    contentType: 'application/json', createdAtBlock: null, expiresAtBlock: null, transactionHash: null } };
}

export function makePublisher(id: string, options: { resources: Resource[]; offers: Offer[]; kind?: PublisherRoot['kind']; name?: string }, now = SMALL_WORKS_NOW): PublisherAggregate {
  const rootKey: EntityKey = `local:${id}`;
  const actor: Actor = { kind: 'local', id: `local-actor:${id}` };
  const root: PublisherRoot = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'publisher_root', operationId: `fixture-root:${id}`,
    createdAt: now, publisher: actor, kind: options.kind ?? 'individual' };
  const book: BookState = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'book_state', operationId: `fixture-book:${id}`,
    createdAt: now, publisherRoot: rootKey, predecessorKeys: [], name: options.name ?? id, description: 'Synthetic local practice contributor.',
    resources: options.resources, offers: options.offers, decisions: [], grants: [], attestations: [], custodyHolds: [], retentionDays: 90 };
  return { root: localRecord(rootKey, root, actor), book: { status: 'unique', entity: localRecord(`local:${id}:book:initial`, book, actor) }, snapshot: createLocalSnapshot(now) };
}

const window = (day: 17 | 18, start: number, end: number): Interval => ({
  // London is UTC+1 on these dates; labels show the intended 10:00 / 12:00 / 16:00.
  start: Date.parse(`2026-10-${day}T${String(start - 1).padStart(2, '0')}:00:00.000Z`),
  end: Date.parse(`2026-10-${day}T${String(end - 1).padStart(2, '0')}:00:00.000Z`),
});
const saturday = window(17, 10, 16), sunday = window(18, 10, 16);
const setup = window(18, 10, 12), hosting = window(18, 12, 16);

function requirement(id: string, title: string, kind: Resource['kind'], capability: string, unit: string, quantity: number, interval: Interval, instructions = '', dependsOn: string[] = []): Requirement {
  return { id, title, kind, capability, unit, quantity, interval, instructions, dependsOn };
}

function requirements(day: 17 | 18): Requirement[] {
  return [
    requirement('venue', 'Exhibition space', 'place', 'exhibition-space', 'space', 1, window(day, 10, 16)),
    requirement('boards', 'Display boards', 'equipment', 'display-board', 'board', 6, window(day, 10, 16), 'Boards are already at the venue before setup.'),
    requirement('kit', 'Installation kit', 'equipment', 'installation-kit', 'kit', 1, window(day, 10, 12), 'The installation kit is already at the venue.'),
    requirement('installation', 'Install the displays', 'person', 'installation', 'person', 2, window(day, 10, 12), 'Build the displays using the boards and installation kit at the venue.'),
    requirement('transport', 'Bring the artworks', 'person', 'artwork-transport', 'person', 1, window(day, 10, 12), 'Bring the artworks from the synthetic studio. Transport includes carrying equipment.'),
    requirement('hosting', 'Host the exhibition', 'person', 'hosting', 'person', 2, window(day, 12, 16), 'Welcome visitors after display installation and artwork transport finish.', ['installation', 'transport']),
  ];
}

export function smallWorksRecipe(): ProjectRecipe {
  return { title: 'Small Works', outcome: 'Hold a community exhibition of small handmade artworks.', timeZone: 'Europe/London',
    variants: [
      { id: 'saturday', title: 'Saturday at the Courtyard', venueId: 'courtyard', timeZone: 'Europe/London', requirements: requirements(17), instructions: 'Synthetic public courtyard.' },
      { id: 'sunday', title: 'Sunday at the Library', venueId: 'library-hall', timeZone: 'Europe/London', requirements: requirements(18), instructions: 'Synthetic library hall.' },
    ], instructions: 'Every publisher reviews the complete exact plan before accepting. This is a synthetic local practice project.' };
}

function personal(id: string, name: string, capabilities: string[], availability: Interval[], now: number): PublisherAggregate {
  const resource: Resource = { id: 'self', name, kind: 'person', unit: 'person', capacity: 1, availability, capabilities };
  const offers: Offer[] = capabilities.map(capability => ({ id: capability, title: capability === 'artwork-transport' ? 'Bring the artworks' : capability === 'installation' ? 'Install the displays' : 'Host the exhibition',
    resourceId: 'self', kind: 'person', unit: 'person', quantity: 1, capabilities: [capability], availability,
    projectScope: [], conditions: [], instructions: capability === 'artwork-transport' ? 'Transport artworks; carrying equipment included.' : 'One person, one simultaneous assignment.' }));
  return makePublisher(id, { resources: [resource], offers, name }, now);
}

export function makeSmallWorksFixture(options: { oak?: boolean; juniper?: boolean; now?: number } = {}): SolverInput {
  const now = options.now ?? SMALL_WORKS_NOW;
  const place = (id: string, name: string, interval: Interval, venueId: string): PublisherAggregate => {
    const resource: Resource = { id: 'venue', name, kind: 'place', unit: 'space', capacity: 1, availability: [interval], capabilities: ['exhibition-space'] };
    const offer: Offer = { id: 'venue', title: name, resourceId: 'venue', kind: 'place', unit: 'space', quantity: 1, capabilities: ['exhibition-space'],
      availability: [interval], projectScope: [], conditions: [{ kind: 'allowed_venues', venueIds: [venueId] }], instructions: 'Synthetic venue; setup and exhibition access included.' };
    return makePublisher(id, { kind: 'organization', name, resources: [resource], offers: [offer] }, now);
  };
  const makerspace = makePublisher('makerspace', { kind: 'organization', name: 'Makerspace', resources: [
    { id: 'boards', name: 'Display boards', kind: 'equipment', unit: 'board', capacity: 6, availability: [saturday, sunday], capabilities: ['display-board'] },
    { id: 'kit', name: 'Installation kit', kind: 'equipment', unit: 'kit', capacity: 1, availability: [saturday, sunday], capabilities: ['installation-kit'] },
  ], offers: [
    { id: 'boards-saturday', title: 'Four boards on Saturday', resourceId: 'boards', kind: 'equipment', unit: 'board', quantity: 4,
      capabilities: ['display-board'], availability: [saturday], projectScope: [], conditions: [{ kind: 'allowed_variants', variantIds: ['saturday'] }], instructions: 'Already at the Courtyard before 10:00.' },
    { id: 'boards-sunday', title: 'Six boards on Sunday', resourceId: 'boards', kind: 'equipment', unit: 'board', quantity: 6,
      capabilities: ['display-board'], availability: [sunday], projectScope: [], conditions: [{ kind: 'allowed_variants', variantIds: ['sunday'] }], instructions: 'Already at the Library before 10:00.' },
    { id: 'kit', title: 'Installation kit', resourceId: 'kit', kind: 'equipment', unit: 'kit', quantity: 1,
      capabilities: ['installation-kit'], availability: [saturday, sunday], projectScope: [], conditions: [], instructions: 'Already at the venue.' },
  ] }, now);
  // Saturday has the same declared people, so its concrete blocker is the two missing boards.
  const workWindows = [window(17, 10, 12), setup];
  const hostWindows = [window(17, 12, 16), hosting];
  const publishers = [
    place('library', 'Library', sunday, 'library-hall'), place('courtyard', 'Courtyard', saturday, 'courtyard'), makerspace,
    personal('cedar', 'Cedar', ['installation', 'artwork-transport'], workWindows, now),
    personal('willow', 'Willow', ['installation'], workWindows, now),
    personal('ash', 'Ash', ['hosting'], hostWindows, now), personal('elm', 'Elm', ['hosting'], hostWindows, now),
  ];
  if (options.oak) publishers.push(personal('oak', 'Oak', ['artwork-transport'], [setup], now));
  if (options.juniper) publishers.push(personal('juniper', 'Juniper', ['installation'], [setup], now));
  return structuredClone({ projectRoot: SMALL_WORKS_PROJECT_ROOT, recipe: smallWorksRecipe(), publishers, snapshot: createLocalSnapshot(now),
    predecessor: null, predecessorSource: null, completedWork: [] });
}

export function makeSmallWorksProject(options: { oak?: boolean; juniper?: boolean; now?: number } = {}): ProjectAggregate {
  const input = makeSmallWorksFixture(options);
  const root: ProjectRoot = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'project_root', coordinator: SMALL_WORKS_COORDINATOR,
    operationId: 'fixture-small-works-root', createdAt: input.snapshot.blockTimestamp };
  const state: ProjectState = { protocol: PROTOCOL, schemaVersion: 1, entityType: 'project_state', projectRoot: input.projectRoot,
    predecessorKeys: [], operationId: 'fixture-small-works-state', createdAt: input.snapshot.blockTimestamp, recipe: input.recipe,
    publisherRoots: input.publishers.map(publisher => publisher.root.key), lifecycle: 'planning', completedWork: [], completion: null };
  return { root: localRecord(input.projectRoot, root, SMALL_WORKS_COORDINATOR), state: { status: 'unique', entity: localRecord('local:small-works:state:initial', state, SMALL_WORKS_COORDINATOR) },
    activation: { status: 'missing', reason: 'not_initialized' }, proposal: null, proposalHistory: [], publishers: input.publishers, snapshot: input.snapshot };
}

export function smallWorksRecords(options: { oak?: boolean; juniper?: boolean; now?: number } = {}): EntityRecord[] {
  const project = makeSmallWorksProject(options);
  return [project.root, ...(project.state.status === 'unique' ? [project.state.entity] : []), ...project.publishers.flatMap(publisher =>
    [publisher.root, ...(publisher.book.status === 'unique' ? [publisher.book.entity] : [])])];
}
