import type { EntityKey, ProjectAggregate, ResourceKind } from '../../domain/types';
import { deriveDraftStatus } from '../../domain/readiness';
import { formatDateTime, formatQuantity } from '../../app/time';

export type NeedsComparison = 'not_proposed' | 'matching' | 'changed' | 'unverified' | 'closed';
export interface NeedsNotice { title: string; message: string; tone: 'neutral' | 'warning' }
export interface ReadableRequirement {
  id: string; title: string; kind: ResourceKind; kindLabel: string; capability: string;
  quantity: number; unit: string; quantityLabel: string; start: number; end: number;
  startLabel: string; endLabel: string; startIso: string | undefined; endIso: string | undefined; instructions: string;
  dependencies: { id: string; title: string; label: string }[];
}
export interface ReadableVariant {
  id: string; title: string; venueId: string; timeZone: string; instructions: string;
  requirements: ReadableRequirement[];
}
export type ProjectNeedsModel = { available: false; notice: NeedsNotice } | {
  available: true; heading: string; title: string; outcome: string; timeZone: string;
  instructions: string; sourceProjectRoot?: EntityKey; variants: ReadableVariant[];
  comparison: NeedsComparison; notice: NeedsNotice; snapshotNotice: string | null;
};

const kindLabels: Record<ResourceKind, string> = { person: 'People', place: 'Place', equipment: 'Equipment' };
const comparisonNotices: Record<NeedsComparison, NeedsNotice> = {
  not_proposed: { tone: 'neutral', title: 'The project is still being planned', message: 'Use these needs to prepare an offer. Everyone will review the finished plan before agreeing to take part.' },
  matching: { tone: 'neutral', title: 'Selected option matches the active plan’s needs', message: 'The other options below remain planning alternatives. Read the active agreement for selected contributions, owner decisions, and current readiness.' },
  changed: { tone: 'warning', title: 'Saved draft needs differ from the active plan', message: 'The active plan and its existing decisions remain separate from these edited needs. A replacement plan requires fresh owner decisions.' },
  unverified: { tone: 'warning', title: 'Active plan comparison is unavailable', message: 'The current active plan could not be verified for comparison. These saved needs alone do not establish agreement.' },
  closed: { tone: 'neutral', title: 'This project has finished', message: 'This project is closed. These saved needs do not invite new commitments; consult its recorded outcome and history.' },
};

function comparisonFor(project: ProjectAggregate): NeedsComparison {
  if (project.state.status !== 'unique') return 'unverified';
  if (project.state.entity.payload.lifecycle === 'closed') return 'closed';
  if (project.snapshot.freshness !== 'fresh' || project.snapshot.completeness !== 'complete') return 'unverified';
  if (project.activation.status === 'missing' && project.activation.reason === 'not_initialized' && !project.proposal) return 'not_proposed';
  if (project.activation.status !== 'unique' || !project.proposal) return 'unverified';
  const activation = project.activation.entity.payload, proposal = project.proposal;
  if (activation.projectRoot !== project.root.key || proposal.payload.projectRoot !== project.root.key
    || activation.proposalKey !== proposal.key || activation.proposalHash !== proposal.payload.proposalHash) return 'unverified';
  return deriveDraftStatus(project).changed ? 'changed' : 'matching';
}

/** An offset on both endpoints disambiguates repeated local times during a DST fold. */
function needsTime(instant: number, timeZone: string) {
  try {
    return { label: formatDateTime(instant, timeZone, {
      dateStyle: undefined, timeStyle: undefined, year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
      ...(instant % 60_000 !== 0 ? { second: '2-digit' as const } : {}),
      ...(instant % 1_000 !== 0 ? { fractionalSecondDigits: 3 as const } : {}),
    }), iso: new Date(instant).toISOString() };
  } catch {
    return { label: `${instant} UTC milliseconds (date display unavailable)`, iso: undefined };
  }
}

/** Read the saved recipe, never allocation reservations or a historical proposal's recipe. */
export function projectNeedsModel(project: ProjectAggregate): ProjectNeedsModel {
  if (project.state.status !== 'unique') return { available: false, notice: {
    tone: 'warning', title: 'Saved project needs are unavailable',
    message: project.state.status === 'conflict' ? 'Conflicting project records must be resolved before one set of needs can be shown.'
      : 'A unique current project record is required to verify these needs. Refresh the project or check the invitation with its coordinator.',
  } };
  const recipe = project.state.entity.payload.recipe, comparison = comparisonFor(project);
  const uncertain = project.snapshot.freshness !== 'fresh' || project.snapshot.completeness !== 'complete';
  return {
    available: true, heading: uncertain ? 'Last-known saved project needs' : 'Current saved project needs',
    title: recipe.title, outcome: recipe.outcome, timeZone: recipe.timeZone,
    instructions: recipe.instructions, sourceProjectRoot: recipe.sourceProjectRoot,
    comparison, notice: comparisonNotices[comparison],
    snapshotNotice: uncertain ? 'This read is stale or incomplete. Refresh to verify the latest saved needs before relying on them.' : null,
    variants: recipe.variants.map(variant => ({
      id: variant.id, title: variant.title, venueId: variant.venueId, timeZone: variant.timeZone, instructions: variant.instructions,
      requirements: variant.requirements.map(requirement => {
        const start = needsTime(requirement.interval.start, variant.timeZone), end = needsTime(requirement.interval.end, variant.timeZone);
        return {
        id: requirement.id, title: requirement.title, kind: requirement.kind, kindLabel: kindLabels[requirement.kind],
        capability: requirement.capability, quantity: requirement.quantity, unit: requirement.unit,
        quantityLabel: `${formatQuantity(requirement.quantity)} ${requirement.unit}`,
        start: requirement.interval.start, end: requirement.interval.end,
        startLabel: start.label, endLabel: end.label, startIso: start.iso, endIso: end.iso,
        instructions: requirement.instructions,
        dependencies: requirement.dependsOn.map(id => {
          const dependency = variant.requirements.find(candidate => candidate.id === id);
          return { id, title: dependency?.title ?? id, label: dependency ? `${dependency.title} (${id})` : id };
        }),
        };
      }),
    })),
  };
}
