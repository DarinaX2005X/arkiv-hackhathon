import { defineCatalog } from '../../i18n';

export const helpCopy = defineCatalog({
  title: 'Help with Partfolk',
  intro: 'Organize, contribute or join. Find the next step for your event.',
  topics: 'More answers',
  allTopics: 'All help topics',
  unknownTopic: 'That answer is not available. Choose a topic below or return to your project.',
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
  tourTitle: 'A quick welcome to Partfolk',
  tourBody: 'Four short steps to find your work, bring your part and make your own decisions.',
  tourAction: 'Replay welcome tour',
  tourNote: 'You can close or skip at any time. Your current work stays where you left it.',
  practiceTitle: 'Try the decisions before your own project',
  practiceBody: 'Use fictional people to make a complete plan, withdraw a contribution and find a replacement.',
  practiceNote: 'Separate local practice. It can be reset without changing your own work.',
});

export const helpTopics = [
  {
    id: 'getting-started', title: 'Organize an event',
    summary: 'Bring people and resources together, then invite guests.',
    paragraphs: [
      'Start your project with an outcome, possible dates and the people, place or equipment you need. Your draft stays on this device until you publish it. My projects keeps your drafts and published projects together.',
      'Publish the project to invite help. Contributors offer their own resources and decide whether to agree to the plan. A workable plan becomes ready only after its required owners agree.',
      'When the current plan is ready, publish the event for guests. Choose online, in person or hybrid, then set its time zone, location, participation rules and registration options.',
    ],
  },
  {
    id: 'account', title: 'Sign in and return to your work',
    summary: 'One account for organizing, contributing and attending.',
    paragraphs: [
      'Connect your wallet when you want to publish or make a decision. Signing in alone does not publish anything or register you for an event. Your wallet identifies the account that owns a record; it does not verify a person’s identity.',
      'First-time setup lets you choose where to begin and add an optional label for this wallet on this device. You can skip setup. Account and settings lets you change these preferences or sign out.',
      'Return with the same wallet to find public projects, offers and decisions on Arkiv, including from another device. Unpublished drafts stay in this browser. Export drafts before changing devices and import them in My projects.',
      'Signing out, cancelling a connection or switching accounts keeps drafts and pending requests. Reconnect the wallet that started the work to continue its decisions. Public records stay public after sign-out.',
    ],
  },
  {
    id: 'attending', title: 'Find and join an event',
    summary: 'Check the format, time and participation rules, then decide.',
    paragraphs: [
      'Browse Events without signing in. Open an event to review whether it is online, in person or hybrid, its time zone and location, and what you need to take part.',
      'Read the registration deadline, availability and admission rules. Open events with unlimited places let you join directly. For limited or invitation-only events, request a place and wait for organizer confirmation. Check your current status in My events; a request or waiting-list entry is not a confirmed place.',
      'When joining, review the terms and confirm with your own wallet. Your wallet’s registration is public on Arkiv. A wallet connection alone does not register you, and a signature does not prove physical attendance.',
      'My events brings you back to your registrations. Review changed conditions before confirming again, or cancel your own participation. If a request is interrupted, check the original request before trying again.',
    ],
  },
  {
    id: 'practice', title: 'Learn before starting your own work',
    summary: 'Replay the welcome tour or try the separate guided example.',
    paragraphs: [
      'The welcome tour explains useful next steps after sign-in. You can replay it here, go back a step, skip it or close it. It keeps your current page and invitation in place.',
      'Try the guided example explores planning, agreement and replacing a withdrawn contribution with fictional people. It is separate local practice that you can reset.',
      'Viewing an illustration, signing in or completing the tour never adds a sample project to My projects. Start your project opens your own draft without copying fictional people or promises.',
    ],
  },
  {
    id: 'publishing', title: 'Choose what you make public',
    summary: 'Review the details before publishing a project, offer or event.',
    paragraphs: [
      'The publication preview shows the account acting and the details it will share. Published descriptions, offers, agreements and event registrations are public on Arkiv. A sign-in screen or invitation-only event does not make those records private.',
      'Only include a meeting link if it is safe to share publicly. Keep passwords, private invitation tokens, contact details and confidential access links outside the public event description.',
      'A wallet signature identifies the authoring account. It does not verify someone’s identity, inventory or attendance. Copies and network history may remain even when a record changes or expires.',
    ],
  },
  {
    id: 'offers', title: 'Offer your time, space or equipment',
    summary: 'Choose what to share and the conditions that work for you.',
    paragraphs: [
      'Open My contributions to describe your resource, availability and conditions. Publish it when you are ready, then share it with a project. An invitation keeps the relevant project with your offer.',
      'You own the offer. An organizer can include it in a proposal but cannot accept for you. Review the full plan, your assignment and any return arrangements before agreeing.',
      'Partfolk checks declared resources and overlapping commitments. It cannot read your private calendar or check physical inventory. Keep your availability current.',
    ],
  },
  {
    id: 'agreement', title: 'Agree on the exact plan',
    summary: 'Each owner reviews and confirms their own decision.',
    paragraphs: [
      'A found plan means the declared offers fit together. Each required owner then reviews the same version and agrees with their own wallet. Publishing an offer or opening a plan is not agreement.',
      'When dates, assignments or other terms change, everyone in the new plan reviews it again, even if their own task stayed the same. Arkiv keeps those separately authored decisions linked to their terms.',
      'Ready means the latest check found the necessary agreement and no declared conflict. Check again before you begin, since an owner can withdraw or change their offer.',
    ],
  },
  {
    id: 'changes', title: 'Change the plan or find a replacement',
    summary: 'Make the new arrangement clear while keeping earlier work.',
    paragraphs: [
      'Edit project needs when plans change. These edits remain a draft until you propose a new version. Earlier agreement stays attached to its original terms.',
      'If you can no longer contribute, withdraw your own part. After a fresh check the project shows what is missing. Completed work and equipment awaiting return remain visible.',
      'The organizer can find a replacement using current offers. Everyone included in the replacement plan reviews it again. If a complete replacement is unavailable, the missing need stays visible.',
    ],
  },
  {
    id: 'runbook', title: 'Do the work and return equipment',
    summary: 'Use Run sheet to see who does what and when.',
    paragraphs: [
      'Choose My tasks to focus on your part. Marking a task done records your own report, without confirming another person’s work.',
      'For a handover or return, one person reports sending the equipment and the other confirms receiving it. Until both sides respond, it stays awaiting confirmation.',
      'At the end, review unfinished work and returns before closing. Download a run sheet or use the project as a starting point for another event. New dates and owners need new agreement.',
    ],
  },
  {
    id: 'recovery', title: 'Recover work or check a stuck request',
    summary: 'Keep your draft and check what happened before trying again.',
    paragraphs: [
      'If saving on this device fails, keep the page open and export your draft. You can import it into My projects later. A new browser will not automatically have that draft.',
      'If publication or a decision is interrupted, check the original operation before sending again. It may already be recorded. Reconnect the wallet that started it to continue.',
      'After a failed read, refresh when the connection returns. Last-known information cannot confirm current agreement or registration. Opening Help keeps your draft and request; use the return link to continue.',
    ],
  },
  {
    id: 'expiry', title: 'Understand an expired record',
    summary: 'A missing record needs attention from its owner.',
    paragraphs: [
      'Arkiv records have a lifetime. When a required record is missing or expired, Partfolk cannot confirm that the plan is ready. Its owner needs to renew or replace it.',
      'Agreement has its own deadline. Renewing a stored record does not restore expired agreement; the owner must review and agree again.',
      'Expiry is not secure erasure. Other people may retain copies, so only publish details you intend to share publicly.',
    ],
  },
  {
    // Retain existing help URLs while replacing the old separate-client promotion.
    id: 'partner-desk', title: 'Your resources and decisions on Arkiv',
    summary: 'Own your offers and agreements within one Partfolk account.',
    paragraphs: [
      'Use My contributions for resources you offer and Requests for plans awaiting your decision. Use My projects when organizing and My events when attending. You can do all of these with the same account.',
      'Arkiv holds your published offers and decisions under the wallet that authored them. An organizer can read your confirmed response but cannot change it for you.',
      'Return with the owning wallet to continue. Drafts and device preferences stay in the browser where you made them.',
    ],
  },
  {
    id: 'technical', title: 'How shared records work',
    summary: 'Independent authors, shared terms and a fresh check.',
    paragraphs: [
      'Partfolk uses the partfolk/1 format on Arkiv. Organizers publish projects and proposals; contributors publish their own offers and decisions. Each agreement refers to the exact proposed terms.',
      'Other clients can read the same public records and check their authors and references. Missing records, conflicting versions or incomplete reads prevent a confirmed result.',
      'Shared records make decisions inspectable. They do not guarantee real-world attendance, physical inventory or availability outside the commitments recorded here.',
    ],
  },
] as const;

export type HelpTopicId = (typeof helpTopics)[number]['id'];
