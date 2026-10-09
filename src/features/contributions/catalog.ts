import type { RepositoryErrorCode } from '../../data/types';
import type { ReasonCode } from '../../domain/types';

/** English is the only product locale. Raw publisher-authored content is never translated. */
export const contributionReasons: Record<ReasonCode, string> = {
  invalid_input: 'Some contribution fields need correction.', invalid_schema: 'A record does not follow the contribution format.',
  invalid_identity: 'The record identity could not be verified.', foreign_author: 'Only the owner of this contribution can change it.',
  projection_mismatch: 'The record references do not match its published contents.', hash_mismatch: 'The published terms do not match their recorded fingerprint.',
  not_readonly: 'This record does not have the required immutable provenance.', owner_changed: 'Ownership changed. The original author cannot authorize this update.',
  missing_root: 'The publisher identity is unavailable. A new identity needs a new project invitation.',
  missing_state: 'Current availability is missing or expired.', missing_activation: 'There is no verified current activation to approve.',
  missing_proposal: 'The complete proposed plan is unavailable.', conflicting_heads: 'Competing current records need to be resolved by their owner.',
  incomplete_snapshot: 'Some required records could not be read. Refresh before deciding.', stale_snapshot: 'The last check is no longer current. Refresh to verify.',
  rpc_error: 'The network could not complete this check.', page_budget: 'The record list is incomplete. Refresh before deciding.',
  cursor_error: 'The record list changed while being read. Refresh to start a new complete check.', expired: 'A required record has expired.',
  not_initialized: 'The contribution identity has not finished initialization.', missing_offer: 'A selected offer is no longer available.',
  offer_changed: 'The offer changed after this plan was proposed.', scope_mismatch: 'This offer or owner is not eligible for this project.',
  unit_mismatch: 'The resource and assignment use different units.', shortage: 'There is not enough of the required contribution.',
  capacity_exceeded: 'This resource is already needed by overlapping commitments.', outside_availability: 'An assignment falls outside the owner’s declared availability.',
  condition_unsatisfied: 'A required condition for this offer is not met.', dependency_unsatisfied: 'A required earlier task or contribution is missing.',
  pin_conflict: 'A requested assignment cannot be satisfied together with the other requirements.', search_exhausted: 'The search stopped before all possibilities were checked.',
  missing_decision: 'Waiting for this owner’s decision.', declined: 'This owner declined the current plan.', withdrawn: 'This owner withdrew their contribution.',
  missing_grant: 'No matching current approval covers these assignments.', grant_expired: 'The approval has expired or does not cover the duties. A fresh valid deadline is required.',
  activation_mismatch: 'This decision belongs to another activation. Fresh approval is required.', proposal_mismatch: 'The decision does not match the complete current proposal.',
  contradictory_decision: 'The owner’s decision and approval do not agree.', custody_outstanding: 'Equipment remains in custody. Its return has not been acknowledged.',
  attestation_mismatch: 'The work or transfer statement does not match this obligation.', evidence_unavailable: 'The evidence needed to verify this claim is unavailable.',
  closed_project: 'This project is closed. A restarted project needs a fresh agreement.', unsupported: 'This action is not supported by the selected data source.',
  payload_too_large: 'This contribution is too large to publish. Reduce its descriptions or split independent resources into another identity.',
};
export const contributionErrors: Record<RepositoryErrorCode, string> = {
  invalid_input: 'Review the highlighted input before trying again.', unauthorized: 'Connect the account that owns this contribution.',
  wrong_chain: 'Reconnect your owner account on Tiramisu, then check the saved request.', not_connected: 'Connect your owner account to publish.',
  not_found: 'The requested record is unavailable. Refresh to check its current state.', conflict: 'Current records conflict. Refresh and resolve the owner state first.',
  stale_heads: 'Another update changed this contribution. Refresh and review it before trying again.', expired: 'This record expired. Review the recovery options.',
  incomplete: 'The current data is incomplete. Refresh before relying on it.', network: 'The network response was interrupted. Check the original operation.',
  rate_limited: 'The network is limiting requests. Keep the saved operation and check it again later.', rejected: 'The wallet request was rejected. Your input has been kept.',
  storage: 'The operation could not be safely saved on this device. Keep this page open and export your draft.',
  reverted: 'The transaction did not apply. Refresh and review your input before starting another request.',
  payload_too_large: 'Reduce the size of this contribution before publishing.', unverified: 'The outcome is not yet verified. Check the original operation before sending anything else.',
  unsupported: 'This action is unavailable in the current client.',
};
export const contributionsCopy = {
  contributions: 'My contributions', requests: 'Requests', create: 'Offer a contribution', review: 'Review availability changes',
  agree: 'Confirm my contribution', decline: 'Decline this plan', withdraw: 'Withdraw my contribution',
  exact: 'Agreement applies only to this exact activation.', ...contributionErrors,
};
