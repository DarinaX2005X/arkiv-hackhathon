import { defineCatalog } from '../../i18n';
import type { AgreementHealth, DomainReason } from '../../domain/types';
import type { RepositoryError } from '../../data/types';

export const projectsCopy = defineCatalog({
  title: 'Projects', create: 'Start a project', open: 'Open project', saveDraft: 'Save draft on this device',
  noProjects: 'Your next project starts here.', noProjectsBody: 'Describe the outcome, possible dates and what you need. Your project begins without invented contributors or agreement.',
  local: 'Local work · nothing published', practice: 'Local practice · synthetic people and places · nothing published',
  changed: 'Draft changes are not agreed', changedBody: 'These needs differ from the active plan. Existing decisions apply only to that plan. A new version needs fresh agreement from everyone.',
  agreedLink: 'View the active plan and its decisions',
  search: 'Find workable plans', searching: 'Checking the complete set of offers…',
  found: 'A workable plan was found. People still need to agree.',
  impossible: 'No complete plan fits these inputs.', exhausted: 'The search stopped before checking every possibility.',
  unverified: 'The available data is incomplete. A current plan cannot be verified.',
  staleResult: 'These results describe earlier inputs. Run the search again before proposing a plan.',
  offerInbox: 'Offers submitted to this project', admission: 'Add this contributor to the project',
  admissionNote: 'An offer link is an introduction. Adding its owner makes their current offers available for planning; it does not accept a contribution or record agreement.',
  preview: 'Review this exact plan', propose: 'Ask everyone to agree to this plan',
  publicPreview: 'These details will be public', publicNote: 'The title, outcome, dates, requirements and instructions are public. Use public project descriptions, without private contact information or calendars.',
  history: 'Plan history', historyGap: 'Some earlier plan evidence is unavailable. This is the history that could be verified, not a complete permanent archive.',
  restore: 'Prepare these terms as a new version', restoreNote: 'Restoring terms creates a new proposal linked to the current plan and a fresh activation. Earlier decisions will not carry over.',
  saved: 'Saved on this device', memoryOnly: 'Kept in memory only. Export this draft before closing the page.',
  exportDraft: 'Export draft', importDraft: 'Import draft', refresh: 'Refresh current data',
  planFound: 'Plan found', awaiting: 'Awaiting agreement', declined: 'Declined', ready: 'Agreed by everyone',
  needsPlan: 'Needs a new plan', conflict: 'Conflicting current records', cannotVerify: 'Cannot verify current status',
});

export const agreementLabels: Record<AgreementHealth, string> = {
  possible: projectsCopy.planFound, awaiting_approval: projectsCopy.awaiting, declined: projectsCopy.declined,
  ready: projectsCopy.ready, changed: projectsCopy.needsPlan, conflict: projectsCopy.conflict, unverified: projectsCopy.cannotVerify,
};
const reasons: Record<DomainReason['code'], string> = {
  invalid_input: 'Some inputs need correction.', invalid_schema: 'A record does not match the supported format.',
  invalid_identity: 'A record has an invalid identity.', foreign_author: 'The record was not authored by the required owner.',
  projection_mismatch: 'A record’s searchable fields and content do not match.', hash_mismatch: 'The exact terms could not be verified.',
  not_readonly: 'A referenced record does not preserve the required immutable terms.', owner_changed: 'Ownership changed and current authority cannot be verified.',
  missing_root: 'A referenced project or contributor identity is unavailable.', missing_state: 'The current project or contribution record is unavailable.',
  missing_activation: 'No current plan has been activated.', missing_proposal: 'The exact proposed plan is unavailable.',
  conflicting_heads: 'More than one current record exists. Its owner needs to resolve the conflict.',
  incomplete_snapshot: 'Some required data is missing from this read.', stale_snapshot: 'This view needs a fresh check.',
  rpc_error: 'The network could not confirm the current data.', page_budget: 'The data could not be read completely within the limit.',
  cursor_error: 'The paginated read was interrupted.', expired: 'A required record or decision has expired.',
  not_initialized: 'Initial publication has not completed.', missing_offer: 'A selected offer is no longer available.',
  offer_changed: 'A selected owner changed their offer.', scope_mismatch: 'This offer is not available to this project.',
  unit_mismatch: 'The offered and required units do not match.', shortage: 'More of this contribution is needed.',
  capacity_exceeded: 'The same resource is needed more than its capacity allows.',
  outside_availability: 'The offer does not cover the full required time.', condition_unsatisfied: 'A required offer condition is not satisfied.',
  dependency_unsatisfied: 'A dependent task cannot follow its required work.', pin_conflict: 'A pinned assignment prevents a complete plan.',
  search_exhausted: 'The search is incomplete; impossibility or optimality has not been proved.',
  missing_decision: 'A required owner has not decided on this exact version.', declined: 'A required owner declined this version.',
  withdrawn: 'A required owner withdrew their contribution.', missing_grant: 'A matching current commitment is missing.',
  grant_expired: 'A contribution’s consent deadline has passed.', activation_mismatch: 'The decision belongs to a different activation.',
  proposal_mismatch: 'The decision does not match this exact proposal.', contradictory_decision: 'Conflicting decisions need the owner’s attention.',
  custody_outstanding: 'Equipment is still held by another project.', attestation_mismatch: 'A completion or transfer statement does not match its obligation.',
  evidence_unavailable: 'Supporting evidence is unavailable.', closed_project: 'This project is closed; its outcome is historical.',
  unsupported: 'This operation is not supported.', payload_too_large: 'The record exceeds the supported size. Export it before making changes.',
};
export function reasonText(reason: DomainReason): string {
  const quantity = reason.params?.missing ?? reason.params?.shortfall;
  const extra = reason.code === 'shortage' && typeof quantity === 'number' ? ` Missing ${quantity}${typeof reason.params?.unit === 'string' ? ` ${reason.params.unit}` : ''}.` : '';
  return `${reasons[reason.code]}${extra}`;
}
export function repositoryErrorText(error: RepositoryError): string {
  const messages: Record<RepositoryError['code'], string> = {
    invalid_input: 'Review the marked inputs before continuing.', unauthorized: 'Only this project’s coordinator can make that change.',
    wrong_chain: 'Connect to Tiramisu before publishing.', not_connected: 'Connect your wallet to publish. Your draft is retained.',
    not_found: 'This project could not be found.', conflict: 'Competing current records need their owner’s review.',
    stale_heads: 'The saved record changed. Refresh and review before sending again.', expired: 'A required current record has expired.',
    incomplete: 'The read was incomplete. Last-known data is shown without current verification.',
    network: 'The network did not confirm the result. Check the original operation before trying again.',
    rate_limited: 'The network is busy. Keep your draft and try a fresh read shortly.',
    rejected: 'The wallet request was cancelled. Your input is retained.', storage: 'Your work could not be saved on this device. Export it before closing.',
    reverted: 'The transaction did not apply. Refresh the current records and review the change before creating another operation.',
    payload_too_large: 'This project exceeds the supported record size.', unverified: 'The result is not confirmed. Reconcile the original operation before another send.',
    unsupported: 'This operation is not available in the current mode.',
  };
  return messages[error.code];
}
