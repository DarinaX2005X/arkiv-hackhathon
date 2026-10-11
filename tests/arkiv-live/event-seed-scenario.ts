import { hashCanonical } from '../../src/domain/canonical';
import { TEST_EVENT_MARKER } from '../../src/domain/events';
import type { AudienceTerms } from '../../src/domain/events';
import type { AccountAddress, BookState, Offer, ProjectRecipe, PublicEntityKey, Resource } from '../../src/domain/types';
import { ACTOR_IDS, LIFETIME_SECONDS } from './scenario';
import type { ProofActor } from './scenario';

export const SEED_IDS = ['sketchbook', 'bookbinding', 'audio-walk'] as const;
export type SeedId = typeof SEED_IDS[number];
export const SEED_RUN_ID = 'public-events-20261011-v1';
export const SEED_CONSENT_UNTIL = Date.parse('2026-10-29T23:59:00Z');
export const SEED_TRANSACTION_COUNT = 43;
export const SEED_LIFETIME_SECONDS = LIFETIME_SECONDS;
export const SEED_DISCLOSURE = 'Synthetic TEST EVENT. The program, venue and participants are fictional; no real gathering, booking or attendance is represented.';
export const SEED_ATTENDEES: Record<SeedId, readonly ProofActor[]> = {
  sketchbook: ['willow', 'elm', 'juniper'], bookbinding: ['cedar', 'oak', 'library', 'courtyard'], 'audio-walk': ['willow', 'cedar'],
};
export const SEED_PARTICIPANT_ALIASES = Object.fromEntries(ACTOR_IDS.map(actor => [actor, `TEST participant ${actor}`])) as Record<ProofActor, string>;
export type SeedAccounts = Record<ProofActor, AccountAddress>;
export type SeedProjectRoots = Partial<Record<SeedId, PublicEntityKey>>;
const utc = (text: string) => Date.parse(text);
const conditions = `${TEST_EVENT_MARKER}\n${SEED_DISCLOSURE}\nThese testnet registrations record synthetic wallet intentions only. They do not prove physical attendance. Do not travel to the fictional venue or expect a live online meeting.`;
const online = { url: '', instructions: 'This is a fictional online room for a testnet demonstration. No live meeting is scheduled and no meeting URL or credentials are published.' };
const open = { capacity: { kind: 'unlimited' as const }, waitlist: false, admission: 'open' as const, invitedAccounts: [] };

export function seedTerms(id: SeedId): AudienceTerms {
  if (id === 'sketchbook') return {
    title: 'Sketchbook exchange', description: `${SEED_DISCLOSURE}\nA relaxed online sketchbook circle for beginners and regular drawing groups. The fictional program starts with a ten-minute object sketch, continues with paired observation exercises, and ends with an optional show-and-tell. Bring any pencil and a few blank pages.`,
    startsAt: utc('2026-10-24T09:00:00Z'), endsAt: utc('2026-10-24T10:30:00Z'), timeZone: 'UTC', venue: 'Fictional online sketchbook room',
    instructions: 'Program: 09:00 welcome and warm-up; 09:15 everyday-object sketch; 09:45 paired prompts; 10:10 optional sharing; 10:30 finish. Times are UTC. Cameras and sharing are optional.', conditions,
    termsVersion: 2, format: 'online', location: null, online: { ...online }, registration: { ...open, invitedAccounts: [], deadline: utc('2026-10-24T08:30:00Z') },
  };
  if (id === 'bookbinding') return {
    title: 'Bookbinding at a shared table', description: `${SEED_DISCLOSURE}\nA small introductory bookbinding workshop for people who enjoy paper, drawing and handmade notebooks. The fictional shared table has three working places, so the organizer confirms requests separately. A fourth synthetic participant demonstrates the optional waiting list.`,
    startsAt: utc('2026-10-25T09:00:00Z'), endsAt: utc('2026-10-25T12:00:00Z'), timeZone: 'Asia/Almaty', venue: 'Paper Lantern Studio — fictional venue',
    instructions: 'Program: 14:00 paper and tools introduction; 14:20 fold signatures; 15:00 supervised stitching; 15:40 break; 16:00 covers and finishing; 17:00 finish. Times are Asia/Almaty. Materials are fictional demonstration supplies. No street address is provided.', conditions,
    termsVersion: 2, format: 'in_person', location: { countryCode: 'KZ', country: 'Kazakhstan', city: 'Almaty', venue: 'Paper Lantern Studio — fictional venue' }, online: null,
    registration: { deadline: utc('2026-10-25T08:00:00Z'), capacity: { kind: 'limited', limit: 3 }, waitlist: true, admission: 'open', invitedAccounts: [] },
  };
  return {
    title: 'Community audio walk workshop', description: `${SEED_DISCLOSURE}\nA hybrid workshop for community storytellers exploring how everyday sounds can shape a short audio walk. The fictional room group and online group compare listening notes, build a two-stop outline, and exchange practical feedback. No real recordings, route, venue access or meeting are promised.`,
    startsAt: utc('2026-10-26T17:00:00Z'), endsAt: utc('2026-10-26T19:00:00Z'), timeZone: 'Europe/London', venue: 'Cedar Listening Room — fictional venue',
    instructions: 'Program: 17:00 introductions; 17:15 listening exercise; 17:40 outline a two-stop story; 18:20 paired feedback; 18:45 next steps; 19:00 finish. Times are Europe/London. Online participation is equally welcome in this synthetic scenario. No physical address or real meeting link exists.', conditions,
    termsVersion: 2, format: 'hybrid', location: { countryCode: 'GB', country: 'United Kingdom', city: 'London', venue: 'Cedar Listening Room — fictional venue' }, online: { ...online },
    registration: { ...open, invitedAccounts: [], deadline: utc('2026-10-26T16:00:00Z') },
  };
}

export function seedRecipe(id: SeedId): ProjectRecipe {
  const terms = seedTerms(id), interval = { start: terms.startsAt - 30 * 60_000, end: terms.endsAt };
  return { title: `${terms.title} — synthetic preparations`, outcome: `Prepare the fictional ${terms.title.toLowerCase()} program.`, timeZone: terms.timeZone,
    instructions: `${SEED_DISCLOSURE} These preparation duties deliberately cover setup and the published audience program.`,
    variants: [{ id: `${id}-program`, title: `${terms.title} preparations`, venueId: `${id}-fictional-place`, timeZone: terms.timeZone,
      instructions: 'All resources and promises belong to a dedicated synthetic publisher; none are real-world availability claims.', requirements: [
        { id: 'facilitate', title: 'Prepare and facilitate the program', kind: 'person', capability: `${id}-facilitate`, unit: 'person', quantity: 1, interval, instructions: 'Set up thirty minutes before opening, welcome the group and facilitate the published program.', dependsOn: [] },
        ...(terms.format !== 'online' ? [{ id: 'room', title: 'Provide the fictional workshop room', kind: 'place' as const, capability: `${id}-room`, unit: 'room', quantity: 1, interval, instructions: 'Synthetic place availability only; no actual booking.', dependsOn: [] }] : []),
        { id: 'materials', title: id === 'bookbinding' ? 'Provide three demonstration paper kits' : 'Prepare demonstration workshop materials', kind: 'equipment', capability: `${id}-materials`, unit: 'kit', quantity: id === 'bookbinding' ? 3 : 1, interval, instructions: 'Fictional supplies remain with their synthetic owner; no transfer or custody claim.', dependsOn: [] },
      ] }],
  };
}

export function seedMaterialBook(current: BookState, roots: SeedProjectRoots): BookState {
  const resources: Resource[] = [], offers: Offer[] = [];
  for (const id of SEED_IDS) {
    const projectRoot = roots[id]; if (!projectRoot) throw new Error('Every seed project must exist before material publication.');
    for (const requirement of seedRecipe(id).variants[0]!.requirements) {
      const resource: Resource = { id: `${id}-${requirement.id}`, name: `Synthetic ${requirement.title.toLowerCase()}`, kind: requirement.kind,
        unit: requirement.unit, capacity: requirement.quantity, capabilities: [requirement.capability], availability: [{ ...requirement.interval }] };
      resources.push(resource);
      offers.push({ id: resource.id, title: `TEST offer: ${requirement.title}`, resourceId: resource.id, kind: resource.kind, unit: resource.unit,
        quantity: resource.capacity, capabilities: [...resource.capabilities], availability: structuredClone(resource.availability), projectScope: [projectRoot],
        conditions: [{ kind: 'allowed_venues', venueIds: [`${id}-fictional-place`] }], instructions: SEED_DISCLOSURE });
    }
  }
  return { ...structuredClone(current), name: 'Synthetic Partfolk Workshop Crew', description: SEED_DISCLOSURE, resources, offers };
}

export function seedScenarioHash(accounts: SeedAccounts): string {
  return hashCanonical({ id: SEED_RUN_ID, terms: SEED_IDS.map(seedTerms), recipes: SEED_IDS.map(seedRecipe), attendees: SEED_ATTENDEES,
    aliases: SEED_PARTICIPANT_ALIASES, accounts, publisherActor: 'ash', lifetimeSeconds: SEED_LIFETIME_SECONDS, consentUntil: SEED_CONSENT_UNTIL, sends: SEED_TRANSACTION_COUNT });
}
