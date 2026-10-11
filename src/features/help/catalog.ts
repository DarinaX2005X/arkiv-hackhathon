import { defineCatalog } from '../../i18n';

export const helpCopy = defineCatalog({
  title: 'Help with Partfolk',
  intro: 'Choose your part, understand a change or get back to work you started.',
  topics: 'More answers',
  allTopics: 'All help topics',
  unknownTopic: 'That answer is not available. Choose a topic below or return to your project.',
  deskAction: 'Open Partfolk for contribution owners',
  deskNote: 'This opens the same public work in another Partfolk client. Your drafts stay in the browser where you made them.',
  exampleAction: 'Try the guided example',
  createAction: 'Start your project',
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
  returnEvents: 'Back to events',
  returnEvent: 'Back to this event',
  returnMyEvents: 'Back to my events',
  signInAction: 'Sign in with a wallet',
  accountAction: 'Account and settings',
  eventsAction: 'Browse events',
  tourTitle: 'Find your way around your workspace',
  tourBody: 'A short guide explains the actions available in your own work. You can skip it, close it or come back to it here.',
  tourAction: 'Open workspace tour',
  tourNote: 'The guide does not create projects, publish records or agree for you.',
  practiceTitle: 'Try the decisions before your own project',
  practiceBody: 'Use fictional people to make a complete plan, withdraw a contribution and find a replacement.',
  practiceNote: 'Separate local practice. It can be reset without changing your own work.',
});

export const helpTopics = [
  {
    id: 'getting-started', title: 'Organize an event',
    summary: 'Start with what you want to make happen and what you’ll need.',
    paragraphs: [
      'Choose Start your project. Give it a name, describe the outcome and add possible dates. List the people, space and equipment you need. You can keep more than one option while you work things out.',
      'Your draft stays on this device until you choose to publish it. You can prepare it without a wallet. My projects keeps your own work together; Continue opens an existing draft, while Start your project creates a fresh one and keeps earlier drafts.',
      'Publish your project when you want to invite help. Each contributor offers their own resources and reviews their part. Finding a workable arrangement does not mean everyone has agreed to it.',
      'Once the current plan has everyone’s agreement, the organizer can publish an event page and open registration. Guests see the event’s time, place and participation details, without having to manage your preparation plan.',
    ],
  },
  {
    id: 'account', title: 'Sign in and return to your work',
    summary: 'Your wallet owns public records. Your device keeps drafts and preferences.',
    paragraphs: [
      'Choose Sign in and connect your own wallet on Arkiv Tiramisu. Connecting requests your wallet address and network. It does not create a project, publish a profile or approve a plan. If you cancel, your entered draft stays where you left it.',
      'On your first sign-in, choose where to begin and optionally add a label for this wallet on this device. You can skip setup. The label and preferences are stored in this browser; they are not a public profile or proof of your real identity.',
      'Return with the same wallet to read your public projects, contributions and decisions from Arkiv, including on another device. Local drafts do not move with the wallet. Export them before changing browsers or devices, then import the file in My projects.',
      'Account and settings lets you change device preferences, sign out or use another wallet. Signing out keeps local drafts and pending operations. A different wallet cannot edit the previous owner’s draft or sign their decisions; reconnect the owning wallet to continue.',
      'A lost connection or changed wallet does not erase a submitted request. Reconnect the account that started it and check the original operation before trying again. Public records remain public when you sign out.',
    ],
  },
  {
    id: 'attending', title: 'Find and join an event',
    summary: 'Choose an event for its time, place and purpose. You do not need to organize it or offer equipment.',
    paragraphs: [
      'Browse events without signing in. Search by title or date, then open an event to read its description, time zone, place, what to bring and participation conditions. The catalog contains events published through Partfolk.',
      'Choose Join event when registration is open. Sign in with your wallet if needed; Partfolk keeps the event you selected. Review Your public registration and explicitly confirm it. A wallet connection by itself does not register you.',
      'Your registration links your wallet to the public event. It does not ask for your name, phone number or email. Join only if you intend this wallet’s participation to be public.',
      'You’re registered appears after a fresh read confirms your registration. If a request is interrupted, use Check original request before trying again. Free open registration does not sell a ticket, reserve a limited seat or verify that someone physically attended.',
      'Open My events to return to your registrations with the same wallet, including on another device. Review changes to the date, place or participation terms before confirming again. You can cancel your own participation from the event page; the organizer cannot cancel on your behalf.',
      'If a required contribution is withdrawn, new registrations pause while the organizers update their plan. An unavailable or expired record is different from an event being cancelled; check the current event status before travelling.',
    ],
  },
  {
    id: 'practice', title: 'Learn without adding a sample to your work',
    summary: 'The landing illustration, guided practice and your own projects stay separate.',
    paragraphs: [
      'The landing illustration shows a fictional exhibition in three moments: agreement, a withdrawal and a replacement proposal. Changing the scene saves nothing and does not use your wallet.',
      'Try the guided example opens a separate local practice. It uses the same planning and agreement rules with clearly fictional people. The practice role selector lets you explore their decisions; it does not grant authority over a real contributor.',
      'Start the example again resets the sample offers, decisions and progress. Your own projects stay as they are. Simply viewing the example, signing in or completing a tour does not put the exhibition in My projects.',
      'Start my own project opens a fresh personal draft. Fictional participants, acceptances and progress are not copied into it. In your real project, each owner publishes and agrees with their own wallet.',
    ],
  },
  {
    id: 'publishing', title: 'Share a public project',
    summary: 'Check the details before you make them public.',
    paragraphs: [
      'When your draft is ready to share, sign in with your own wallet on Arkiv Tiramisu and review the publication preview. It shows which account is acting and what will be published. Anyone with a public project link can read it without a wallet.',
      'Published descriptions, offers, decisions and event registrations are public. A shared link or sign-in screen is not a privacy setting. Leave out private addresses, contact details and confidential schedules. Copies and network history may remain after a record changes or expires.',
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
      'A failed read may leave dated, last-known information on screen. Refresh when the connection returns. Old or incomplete data cannot confirm that a plan is ready or an event registration is current. A recent screen refresh alone does not make an old network record fresh.',
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
      'This entrance is called Partner Desk. It reads and writes the same public records directly through Arkiv. An organizer sees your confirmed changes after refreshing their project. You do not need to maintain a second copy of your offers, and the organizer cannot change your decision for you.',
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
