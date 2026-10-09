import { defineCatalog } from '../../i18n';

export const helpCopy = defineCatalog({
  title: 'Help with your project',
  intro: 'Start with a need, invite an offer, then agree on a plan that works for everyone.',
  topics: 'Help topics',
  allTopics: 'All help topics',
  unknownTopic: 'That help topic is not available. Choose one below, or return to your work.',
  deskAction: 'Open Partner Desk',
  deskNote: 'Partner Desk opens at its own address. Only public project or plan IDs belong in shared links; local drafts stay on this device.',
  exampleAction: 'Try the local example',
  createAction: 'Create a project',
  contributionsAction: 'My contributions',
  requestsAction: 'Requests',
  technicalLinks: 'Source and documentation',
  returnHome: 'Back to the introduction',
  returnDemo: 'Back to local practice',
  returnWorkspace: 'Back to Projects',
  returnDraft: 'Back to my draft',
  returnProject: 'Back to my project',
  returnContributions: 'Back to My contributions',
  returnRequests: 'Back to Requests',
});

export const helpTopics = [
  {
    id: 'getting-started', title: 'Local practice and your own draft',
    summary: 'You can start without connecting a wallet.',
    paragraphs: [
      'Try the example opens Small Works, a fictional community exhibition. You can change its inputs, try different arrangements and act as the clearly labeled sample contributors. These are local practice decisions, not other people’s real offers or public agreement.',
      'Create a project starts your own editable draft. Describe the outcome, date and place options, then add the people, spaces and equipment each option needs. Editing a draft does not publish a project or reserve anything.',
      'Drafts are saved in this browser when storage is available. A storage warning means you should keep the page open and export your draft. Use Projects to return to saved work or import a draft export; another browser or device does not automatically have it.',
    ],
  },
  {
    id: 'publishing', title: 'Publishing a public project',
    summary: 'Review the details and the account before you publish.',
    paragraphs: [
      'You can read a known public project without a wallet. Connect your own wallet on Tiramisu when you want to publish a project, offer or decision. The publication preview shows which account is acting and which details will become public.',
      'Published descriptions, offers and decisions are public. A link is a way to find a project, not a privacy setting. Do not include private addresses, contact details or confidential schedules. Copies and network history can remain available after a record is changed, deleted or expires.',
      'A signature shows which account authored a record. It does not verify the person or organization behind the account, the physical equipment, or that someone will turn up. Arrange practical details with your participants outside Partfolk when needed.',
    ],
  },
  {
    id: 'offers', title: 'Offers, capacity and ownership',
    summary: 'An offer says what could be available. Agreement commits it to one exact plan.',
    paragraphs: [
      'An owner describes their time, place or equipment, its quantity, availability and conditions in My contributions. The same owner controls later changes. Another organizer cannot accept for them or edit their offer simply by using the same display name.',
      'The project works with explicitly added contributors. It checks the available capacity of their declared resources and overlapping Partfolk commitments. For example, one person cannot install and transport at the same time. It does not read private calendars or verify inventory outside Partfolk.',
      'Adding an offer to a project is not an agreement. Find a workable plan checks the whole arrangement: timing, quantities, conditions and shared resources. A candidate still needs to be proposed and accepted by its owners.',
    ],
  },
  {
    id: 'agreement', title: 'Plan versions and everyone’s agreement',
    summary: 'Plan found, proposed and ready describe different things.',
    paragraphs: [
      'Plan found means the supplied offers fit together. A proposed plan is the exact version the organizer asks people to review. Ready means a complete, fresh check found compatible current offers and valid agreement from every required owner for that version.',
      'Before accepting, read the whole plan as well as your own assignments, quantities, dates and conditions. Your decision belongs to the displayed exact version. Opening the page, contributing an offer or seeing a green result is not consent.',
      'Changing dates, requirements, assignments or other material terms creates a new version. Every current participant must agree again, including anyone whose own assignment stayed the same. Previous decisions remain in the history and do not silently transfer.',
      'Ready is a result of a dated check. Separate owners can change their offers, and new conflicts may appear. The network does not make an atomic booking across everyone, and readiness is not a legal or physical guarantee.',
    ],
  },
  {
    id: 'changes', title: 'Draft edits, withdrawal and replacement',
    summary: 'Keep the earlier facts and make the changed work explicit.',
    paragraphs: [
      'Editing your project draft does not rewrite an already proposed or agreed plan. Save the changed requirements, calculate again and propose a new version. Review the differences before asking contributors to agree.',
      'Owners can change availability or withdraw their own contribution. A fresh project check then shows which part no longer fits. Withdrawal does not erase completed work, earlier decisions, or an outstanding equipment return.',
      'Find a replacement works with the remaining needs and current offers. It tries to preserve compatible participants and arrangements while showing the actual changes. If it cannot find a complete replacement, the missing requirement stays visible. An unfinished search is not proof that no replacement exists.',
      'The repaired proposal starts a fresh agreement round for all current participants. A person removed from the plan stays in its history but does not have to approve the new arrangement.',
    ],
  },
  {
    id: 'runbook', title: 'Doing the work and returning equipment',
    summary: 'A report from one person is different from confirmation by the other.',
    paragraphs: [
      'The runbook follows the assignments, times and dependencies in the selected plan. My tasks narrows the view to your part. Marking your task done records your report; it does not confirm somebody else’s work.',
      'For a handover, the giver records what they handed over and the recipient acknowledges receiving it. Return uses the same two-sided process. A report awaiting acknowledgement remains visible; one person or the organizer cannot supply the other side’s confirmation.',
      'The closing review shows completed, unfinished and cancelled work, along with confirmed and outstanding returns. A project can close with outstanding items honestly recorded. Closing the project does not turn an unconfirmed return into a confirmed one or erase a resource owner’s hold.',
      'Use as a starting point creates a new draft from the useful requirements. Set new dates and check current offers. The new project does not inherit old assignments, agreement, progress or reservations. Exports carry the selected plan version and its status; an old export is not a fresh check.',
    ],
  },
  {
    id: 'recovery', title: 'Missing data or an interrupted request',
    summary: 'Check what happened before sending the same request again.',
    paragraphs: [
      'If a network read fails, last-known information may remain with its date and an unverified status. It cannot establish current readiness. Refresh when the connection returns. Missing, expired or conflicting records need resolution; the app must not substitute an older record and call it current.',
      'If a publication or decision has an unknown outcome, keep its saved request details and use Check status. A response can be interrupted after a transaction was sent. Even a later rejected wallet prompt can follow an earlier successful step. Starting again immediately could duplicate part of the request.',
      'A verified incomplete request can continue from its recorded step. If local saved data cannot be read, keep its recovery export before replacing or clearing it. Your draft export is useful for local recovery, but it is not proof that a public action succeeded.',
      'Help does not cancel a pending action or clear your draft. Use the return link to go back to your previous place. If you opened Help directly, Projects is the way back to your saved work.',
    ],
  },
  {
    id: 'expiry', title: 'Record lifetime and expired agreement',
    summary: 'Public storage has a lifetime. It is not a promise of permanence.',
    paragraphs: [
      'Public records have an expiry, shown separately from the times when a contribution is available. A required current record that is missing or expired prevents a verified ready result. Its owner must inspect the record and decide whether to renew or replace it.',
      'Agreement also has its own validity deadline. Extending a stored record does not revive an expired agreement. A new decision must explicitly cover the exact plan again.',
      'Expiration ends availability in current storage; it is not secure erasure. Network history, archives and copies made by other readers can survive. Keep only information you intend to make public in a public project or offer.',
    ],
  },
  {
    id: 'partner-desk', title: 'Using the independent Partner Desk',
    summary: 'Manage your offers and project requests through a separate app.',
    paragraphs: [
      'Partner Desk gives a library, workshop or individual owner their own place to manage offers and review project requests. Open a public project invitation or validated public ID, connect the owning account for a decision, and review the exact plan.',
      'Desk reads and writes the same public Arkiv records directly. It does not ask the Studio backend for permission or copy an organizer’s account database. Studio sees a confirmed owner change after it reads the network again.',
      'The clients still depend on the Arkiv network. An unavailable network or unverified write is not a successful update. Local practice stays local; switching between browser apps does not create public cross-client evidence.',
    ],
  },
  {
    id: 'technical', title: 'How the public records fit together',
    summary: 'Partfolk uses the open partfolk/1 data format on Arkiv.',
    paragraphs: [
      'A project references its coordinator, selected contributors and immutable plan proposals. Each contributor authors their own offers and decisions. A separate active-plan record identifies which proposal is current, so an older accepted version cannot silently become the current one again.',
      'Clients validate the author, references, content and exact plan version, then check capacity and agreement against one network snapshot. Missing records, conflicting current versions or incomplete reads produce an explicit problem rather than an assumed success.',
      'This shared format lets Studio, Partner Desk and an independent reader inspect the same published work. Local practice applies the same planning rules to fictional data. It does not carry wallet authority or public agreement into a real project.',
    ],
  },
] as const;

export type HelpTopicId = (typeof helpTopics)[number]['id'];
