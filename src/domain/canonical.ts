import { keccak256, toBytes } from 'viem';
import { PROTOCOL, TIRAMISU_CHAIN_ID } from './types';
import type {
  Condition, ContentHash, EntityKey, Offer, PlanDocument, Requirement,
  RunbookObligation, SelectedOfferRef,
} from './types';

/** Protocol ordering is binary and never depends on a machine's language. */
export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const text = (value: string): string => value.replace(/\r\n/g, '\n').normalize('NFC');

/** Strict JSON: invalid numbers, undefined, class instances and normalized key collisions fail. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(text(item));
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new TypeError('Canonical numbers must be safe integers.');
      return String(Object.is(item, -0) ? 0 : item);
    }
    if (typeof item !== 'object') throw new TypeError('Canonical values must be JSON values.');
    if (ancestors.has(item)) throw new TypeError('Canonical values cannot contain cycles.');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from(item, encode).join(',')}]`;
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new TypeError('Canonical objects must be plain JSON objects.');
      }
      const entries = Object.entries(item).map(([key, entry]) => [text(key), entry] as const);
      entries.sort(([a], [b]) => compareText(a, b));
      if (entries.some(([key], i) => i > 0 && entries[i - 1]?.[0] === key)) {
        throw new TypeError('Canonical object keys collide after normalization.');
      }
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`).join(',')}}`;
    } finally { ancestors.delete(item); }
  };
  return encode(value);
}

export const hashCanonical = (value: unknown): ContentHash => keccak256(toBytes(canonicalJson(value)));

function set<T>(values: readonly T[], key: (value: T) => string): T[] {
  const sorted = [...values].sort((a, b) => compareText(key(a), key(b)));
  if (sorted.some((value, i) => i > 0 && key(sorted[i - 1]!) === key(value))) {
    throw new TypeError('Canonical sets cannot contain duplicate identities.');
  }
  return sorted;
}

const strings = (values: readonly string[]): string[] => set(values.map(text), value => value);
export const offerIdentity = (ref: { publisherRoot: EntityKey; offerId: string }): string => canonicalJson([ref.publisherRoot, ref.offerId]);
export const resourceIdentity = (ref: { publisherRoot: EntityKey; resourceId: string }): string => canonicalJson([ref.publisherRoot, ref.resourceId]);

export function normalizeCondition(condition: Condition): Condition {
  if (condition.kind === 'allowed_variants') return { ...condition, variantIds: strings(condition.variantIds) };
  if (condition.kind === 'allowed_venues') return { ...condition, venueIds: strings(condition.venueIds) };
  return condition;
}

export const canonicalConditions = (conditions: readonly Condition[]): Condition[] =>
  set(conditions.map(normalizeCondition), canonicalJson);

export const normalizeRequirement = (requirement: Requirement): Requirement => ({
  ...requirement, dependsOn: strings(requirement.dependsOn),
});

function normalizeObligation(obligation: RunbookObligation): RunbookObligation {
  return { ...obligation, allocationIds: strings(obligation.allocationIds), dependsOn: strings(obligation.dependsOn) };
}

export function normalizeOffer(offer: Offer): Offer {
  return {
    ...offer,
    capabilities: strings(offer.capabilities),
    availability: set(offer.availability, canonicalJson),
    projectScope: strings(offer.projectScope) as EntityKey[],
    conditions: canonicalConditions(offer.conditions),
  };
}

export function canonicalOffer(publisherRoot: EntityKey, offer: Offer): string {
  return canonicalJson({
    domain: 'partfolk/offer', protocol: PROTOCOL, validationVersion: 1,
    chainId: publisherRoot.startsWith('local:') ? null : TIRAMISU_CHAIN_ID,
    publisherRoot, offer: normalizeOffer(offer),
  });
}

export const hashOffer = (publisherRoot: EntityKey, offer: Offer): ContentHash => keccak256(toBytes(canonicalOffer(publisherRoot, offer)));

/** The immutable plan, never a book/entity/activation receipt, is the material hash boundary. */
export function normalizedPlan(plan: PlanDocument): PlanDocument {
  return {
    protocol: plan.protocol, validationVersion: plan.validationVersion, chainId: plan.chainId,
    projectRoot: plan.projectRoot, outcome: plan.outcome,
    variant: { ...plan.variant, requirements: set(plan.variant.requirements.map(normalizeRequirement), value => value.id) },
    offers: set<SelectedOfferRef>(plan.offers, offerIdentity),
    resourceAssumptions: set(plan.resourceAssumptions, resourceIdentity),
    allocations: set(plan.allocations, value => value.id),
    requiredApprovers: strings(plan.requiredApprovers) as EntityKey[],
    conditions: canonicalConditions(plan.conditions), instructions: plan.instructions,
    // Runbook order is meaningful. Stable IDs and sorted dependency sets preserve it.
    runbook: plan.runbook.map(normalizeObligation), predecessor: plan.predecessor,
  };
}

export const canonicalPlan = (plan: PlanDocument): string => canonicalJson(normalizedPlan(plan));
export const hashPlan = (plan: PlanDocument): ContentHash => keccak256(toBytes(canonicalPlan(plan)));

export function hashRequirements(projectRoot: EntityKey, requirements: Requirement[]): ContentHash {
  return hashCanonical({
    domain: 'partfolk/requirements', protocol: PROTOCOL, validationVersion: 1,
    chainId: projectRoot.startsWith('local:') ? null : TIRAMISU_CHAIN_ID,
    projectRoot, requirements: set(requirements.map(normalizeRequirement), value => value.id),
  });
}
