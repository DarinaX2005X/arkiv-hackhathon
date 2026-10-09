import { defineCatalog } from '../../i18n';

export const helpCopy = defineCatalog({
  title: 'Help with your project',
  intro: 'Find the answer for the part you’re working on.',
  topics: 'More answers',
  allTopics: 'All help topics',
  unknownTopic: 'That answer is not available. Choose a topic below or return to your project.',
  deskAction: 'Open Partfolk for contribution owners',
  deskNote: 'This opens the same public work in another Partfolk client. Your drafts stay in the browser where you made them.',
  exampleAction: 'Try the exhibition',
  createAction: 'Start a project',
  contributionsAction: 'Open my contributions',
  requestsAction: 'Open my requests',
  technicalLinks: 'Source and documentation',
  returnHome: 'Back to Partfolk',
  returnDemo: 'Back to the exhibition',
  returnWorkspace: 'Back to my projects',
  returnDraft: 'Back to my draft',
  returnProject: 'Back to my project',
  returnContributions: 'Back to my contributions',
  returnRequests: 'Back to my requests',
});

export const helpTopics = [
  {
    id: 'getting-started', title: 'Put a project together',
    summary: 'Start with what you want to make happen and what you’ll need.',
    paragraphs: [
      'Choose Start a project. Give it a name, describe the outcome and add a possible date and place. List the people, space and equipment you need. You can keep more than one date option while you work things out.',
      'Your draft stays on this device until you choose to publish it. You don’t need a wallet to work on it. Open My projects whenever you want to come back.',
      'Want to see it first? Try the exhibition. It uses fictional people and places, and lets you practice each person’s part without publishing anything.',
    ],
  },
  {
    id: 'publishing', title: 'Share a public project',
    summary: 'Check the details before you make them public.',
    paragraphs: [
      'When your draft is ready to share, connect your own wallet on Tiramisu and review the publication preview. It shows which account is acting and what will be published. Anyone with a known public project can read it without a wallet.',
      'Published descriptions, offers and decisions are public. A shared link is not a privacy setting. Leave out private addresses, contact details and confidential schedules. Copies and network history may remain after a record changes or expires.',
      'A signature shows which account wrote a record. It doesn’t verify a person’s identity, inventory or attendance. Agree any practical details with your group as you normally would.',
    ],
  },
  {
    id: 'offers', title: 'Offer your time, space or equipment',
    summary: 'Say what you can bring, when it is available and any conditions.',
    paragraphs: [
      'Open My contributions to add or edit your offer. You stay in control of it. An organizer can invite your contribution, but cannot edit your offer or accept a plan for you.',
      'An offer says what could be available. It becomes a commitment only when you agree to an exact plan. Before accepting, check the full arrangement along with your own job, dates, quantity and conditions.',
      'Partfolk checks the resources and overlapping commitments declared in Partfolk. It can spot one person assigned to two jobs at once. It cannot read your private calendar or check physical inventory.',
    ],
  },
  {
    id: 'agreement', title: 'Agree on the plan',
    summary: 'A plan works on paper first. Then everyone decides whether to take part.',
    paragraphs: [
      'Plan found means the offers fit together. Once the organizer proposes that arrangement, each required owner reviews and accepts the same version. Ready means a recent check found agreement from everyone and no declared conflict.',
      'Read the complete plan before accepting, including your assignment and any equipment handover or return. Adding an offer or opening the plan does not mean you’ve agreed.',
      'When dates, assignments or other terms change, everyone in the new plan must agree again. This includes people whose own task stayed the same. Earlier decisions remain in the history.',
      'Ready describes the latest check, not a guarantee that people will arrive or equipment will be available. Owners can change their offers, so check again before you begin.',
    ],
  },
  {
    id: 'changes', title: 'Change the plan or find a replacement',
    summary: 'Keep the work already done and make the next arrangement clear.',
    paragraphs: [
      'Edit your needs and save them when plans change. Those edits are a draft until you propose a new version. The earlier agreement keeps its original terms.',
      'If you can no longer take part, withdraw your own contribution. The project will show the gap after a fresh check. Completed work and any equipment still awaiting return stay visible.',
      'The organizer can choose Find a replacement to check current offers against the remaining work. Review who changes and what still needs doing. If no complete replacement is found, the missing need stays visible.',
      'A replacement starts a new agreement round for everyone still involved. Someone removed from the plan stays in its history but does not need to approve the replacement.',
    ],
  },
  {
    id: 'runbook', title: 'Do the work and return the equipment',
    summary: 'Use the runbook to see who does what and when.',
    paragraphs: [
      'Choose My tasks to focus on your part. Reporting a task done records your own account of the work. It does not confirm someone else’s work.',
      'For equipment, the giver reports handing it over and the recipient confirms receiving it. Return works the same way. A handover is still awaiting confirmation until the other person records their side.',
      'At the end, review the work and returns. You can close honestly with unfinished items still listed. Closing does not confirm a missing return or release equipment held for the project.',
      'Download a run sheet or JSON copy from the project. Use as a starting point makes a new draft with useful requirements. You choose new dates and find current offers; old promises and progress do not carry over.',
    ],
  },
  {
    id: 'recovery', title: 'Recover saved work or check a stuck request',
    summary: 'Keep your work and check what happened before trying again.',
    paragraphs: [
      'If saving on this device fails, keep the page open and export your draft. Import the file from My projects later. A different browser or device won’t automatically have the draft.',
      'If a publication or decision is interrupted, use Check the original operation before sending again. It may already have been recorded. A confirmed incomplete request can continue from the step that was saved.',
      'A failed read may leave dated, last-known information on screen. Refresh when the connection returns. Old or incomplete data cannot confirm that a plan is ready.',
      'Opening Help does not cancel a request or clear your draft. Use the return link to go back to where you were. Keep a recovery export before replacing any unreadable saved data.',
    ],
  },
  {
    id: 'expiry', title: 'Understand an expired record',
    summary: 'The lifetime of a stored record is separate from when the contribution is available.',
    paragraphs: [
      'Public records expire. If a required record is missing or expired, Partfolk cannot verify that the plan is ready. Its owner needs to inspect it and renew or replace it.',
      'Agreement also has a deadline. Renewing the stored record does not bring expired agreement back. The owner must explicitly agree to the exact plan again.',
      'Expiry is not secure erasure. Network history and copies made by other people may remain. Only publish information you intend to make public.',
    ],
  },
  {
    id: 'partner-desk', title: 'Use another client',
    summary: 'Contribution owners can work with the same public projects through a separate Partfolk entrance.',
    paragraphs: [
      'If you manage a library room, workshop equipment or your own time, the contribution-owner view keeps your offers and requests together. Open a public invitation, connect the owning account when you want to decide, and review the complete plan.',
      'This entrance is called Partner Desk. It reads and writes the same public records directly. An organizer sees your confirmed changes after refreshing their project. You do not need to maintain a second copy of your offers.',
      'Both entrances depend on the same public network. Local examples and drafts stay in the browser where they were made; opening another client does not publish or transfer them.',
    ],
  },
  {
    id: 'technical', title: 'Read about the open data format',
    summary: 'Partfolk uses the partfolk/1 format on Arkiv so independent clients can work with the same records.',
    paragraphs: [
      'The coordinator authors the project and plan proposals. Each contributor authors their own offers and decisions. A separate active-plan record identifies the current proposal, preventing older agreement from being silently reused.',
      'Clients validate authors, references and exact terms, then check capacity and agreement against one network snapshot. Missing records, conflicting versions and incomplete reads are reported as problems. There is no atomic booking across separate owners.',
      'The project workspace, Partner Desk and independent reader use this shared format. The local exhibition applies the same planning rules to fictional data without carrying wallet authority into a real project.',
    ],
  },
] as const;

export type HelpTopicId = (typeof helpTopics)[number]['id'];
