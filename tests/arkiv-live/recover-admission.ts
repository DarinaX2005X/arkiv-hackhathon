/** Explicit recovery of a legacy guarded admission gap. Importing performs no I/O. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createOperatorRpc } from '../../src/cli/arkiv-rpc';
import { createArkivReadClient } from '../../src/data/arkiv/client';
import { BrowserOperationStore, MemoryOperationStore } from '../../src/data/operations';
import type { OperationStore } from '../../src/data/operations';
import { operationBinding } from '../../src/data/operations/reconciliation';
import { canonicalJson, hashCanonical } from '../../src/domain/canonical';
import { BudgetLedger, LIVE_CHAIN_ID, LIVE_LIMIT_WEI, PRIOR_SPEND_WEI, LiveSafetyError,
  atomicWriteJson, createFileStorage, nativeRequestHash, readJson, withRunLock } from './safety';
import type { BudgetDocument, BudgetRecord, ReadRpc } from './safety';
import { ROOT_ACCOUNT, validateState } from './state';
import type { ProofState } from './state';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL = resolve(ROOT, '.local/product-proof');
export const LEGACY_GUARD_COMMIT = '1f7fd49e95453bf33bbf1f379d48efbd55d37547';
// Reviewed provenance: reservation fsync before loadAccount, persistence poisoning,
// durable signed bytes before forwarding, exclusive actors, and no reservation deletion.
export const LEGACY_GUARD_DIGESTS: Readonly<Record<string, string>> = {
  'tests/arkiv-live/safety.ts': '94f0f47b8530ef6a08e2a7da4fc247c68f36af43232c2d0bab9d36c758a1e264',
  'tests/arkiv-live/runner.ts': 'eb1283aaed650c0a69f3722d7edb06fb8363692c1927bcee3985bc1b82483f34',
};
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new LiveSafetyError(code); }
export interface AdmissionRecoveryOptions {
  actionId: string; stepId: string; expectedNonce: number; originalCommit: string; reviewedCommit: string; broadcast: true; maxTransactions: 1;
}
export function parseAdmissionRecoveryOptions(args: string[]): AdmissionRecoveryOptions {
  let recover = false, broadcast = false, actionId: string | undefined, stepId: string | undefined, expectedNonce: number | undefined;
  let originalCommit: string | undefined, reviewedCommit: string | undefined, maxTransactions: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!; ensure(!seen.has(flag), 'INVALID_ADMISSION_RECOVERY_OPTIONS'); seen.add(flag);
    if (flag === '--recover-admission') recover = true;
    else if (flag === '--broadcast') broadcast = true;
    else if (flag === '--action' && /^[a-z0-9:-]{1,64}$/.test(args[index + 1] ?? '')) actionId = args[++index];
    else if (flag === '--step-id' && /^[a-z0-9._:-]{1,127}$/i.test(args[index + 1] ?? '')) stepId = args[++index];
    else if (flag === '--expected-nonce' && /^[1-9]\d*$/.test(args[index + 1] ?? '')) expectedNonce = Number(args[++index]);
    else if (flag === '--original-commit' && /^[\da-f]{40}$/i.test(args[index + 1] ?? '')) originalCommit = args[++index]!.toLowerCase();
    else if (flag === '--reviewed-commit' && /^[\da-f]{40}$/i.test(args[index + 1] ?? '')) reviewedCommit = args[++index]!.toLowerCase();
    else if (flag === '--max-transactions' && args[index + 1] === '1') { index++; maxTransactions = 1; }
    else throw new LiveSafetyError('INVALID_ADMISSION_RECOVERY_OPTIONS');
  }
  ensure(recover && broadcast && actionId && stepId && Number.isSafeInteger(expectedNonce) && expectedNonce! >= 1
    && originalCommit && reviewedCommit && maxTransactions === 1, 'EXPLICIT_ADMISSION_RECOVERY_REQUIRED');
  return { actionId, stepId, expectedNonce: expectedNonce!, originalCommit, reviewedCommit, broadcast: true, maxTransactions: 1 };
}
export function assertOriginalGuardProvenance(originalCommit: string, actionCommit: string, digests: Readonly<Record<string, string>>): void {
  ensure(originalCommit === LEGACY_GUARD_COMMIT && actionCommit === originalCommit
    && Object.entries(LEGACY_GUARD_DIGESTS).every(([path, digest]) => digests[path] === digest), 'LEGACY_GUARD_PROVENANCE_REQUIRED');
}

export function admissionRecoveryBinding(state: ProofState, store: OperationStore, budget: BudgetRecord[], options: AdmissionRecoveryOptions) {
  const action = state.actions[options.actionId];
  ensure(action && !action.confirmed && action.confirmedKeys.length === 0 && action.actor !== 'coordinator'
    && action.codeCommit === options.originalCommit && options.originalCommit === LEGACY_GUARD_COMMIT, 'ADMISSION_RECOVERY_ACTION_MISMATCH');
  const operation = action.command.operation, saved = store.get(operation.id, options.stepId);
  const attempt = store.getAttempt(operation.id), candidateId = `${operation.id}:${options.stepId}`;
  const candidate = budget.find(record => record.id === candidateId);
  ensure(saved?.admission && saved.prepared && operationBinding(operation) === operationBinding(saved.operation)
    && attempt?.state === 'native-started' && attempt.nativeStepIds.includes(saved.step.id)
    && operationBinding(attempt.operation) === operationBinding(operation), 'ADMISSION_RECOVERY_JOURNAL_MISMATCH');
  ensure(saved.operation.authority.mode === 'public' && saved.operation.authority.chainId === LIVE_CHAIN_ID
    && saved.operation.authority.actor.address.toLowerCase() === state.actors[action.actor].toLowerCase()
    && saved.prepared.account.toLowerCase() === state.actors[action.actor].toLowerCase()
    && saved.prepared.chainId === LIVE_CHAIN_ID && saved.step.inputHash === hashCanonical(saved.batch)
    && canonicalJson(saved.prepared.batch) === canonicalJson(saved.batch)
    && canonicalJson(saved.prepared.request) === canonicalJson(saved.admission.request)
    && /^(0|[1-9]\d*)$/.test(saved.prepared.preparedAtBlock), 'ADMISSION_RECOVERY_BINDING_MISMATCH');
  if (candidate) {
    ensure(candidate.admissionRecovery?.requestHash === nativeRequestHash(saved.admission.request)
      && candidate.admissionRecovery.originalCommit === options.originalCommit
      && candidate.admissionRecovery.preparedAtBlock === saved.prepared.preparedAtBlock
      && candidate.plan.nonce === options.expectedNonce, 'ADMISSION_RECOVERY_CANDIDATE_MISMATCH');
    ensure((!saved.submissionHash || saved.submissionHash === candidate.transactionHash)
      && (!saved.step.transactionHash || saved.step.transactionHash === candidate.transactionHash)
      && (!saved.receipt || saved.receipt.transactionHash === candidate.transactionHash), 'ADMISSION_RECOVERY_HASH_MISMATCH');
  } else ensure(saved.submissionHash === null && saved.step.transactionHash === null && saved.receipt === null
    && saved.step.confirmedKeys.length === 0 && saved.step.status === 'unverified', 'ADMISSION_RECOVERY_HASHLESS_REQUIRED');
  const steps = store.list();
  for (const record of budget.filter(item => item.kind === 'native')) {
    ensure(steps.some(step => `${step.operation.id}:${step.step.id}` === record.id && step.admission), 'ADMISSION_RECOVERY_CONTINUITY_MISMATCH');
  }
  for (const step of steps.filter(item => item.admission)) {
    const id = `${step.operation.id}:${step.step.id}`;
    ensure(id === candidateId || budget.some(record => record.kind === 'native' && record.id === id), 'ADMISSION_RECOVERY_CONTINUITY_MISMATCH');
  }
  for (const completed of Object.values(state.actions).filter(item => item.confirmed || item.confirmedKeys.length)) {
    ensure(steps.some(step => step.operation.id === completed.command.operation.id), 'ADMISSION_RECOVERY_CONTINUITY_MISMATCH');
  }
  return { actor: action.actor, address: state.actors[action.actor], id: candidateId,
    preparedAtBlock: saved.prepared.preparedAtBlock, request: saved.admission.request, actionCommit: action.codeCommit };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseAdmissionRecoveryOptions(args);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  ensure(commit === options.reviewedCommit, 'RECOVERY_REVIEWED_COMMIT_REQUIRED');
  ensure(!execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'RECOVERY_CLEAN_SOURCE_REQUIRED');
  ensure(options.originalCommit === LEGACY_GUARD_COMMIT, 'LEGACY_GUARD_PROVENANCE_REQUIRED');
  const sourceDigests = Object.fromEntries(Object.keys(LEGACY_GUARD_DIGESTS).map(path => [path, createHash('sha256').update(
    execFileSync('git', ['show', `${options.originalCommit}:${path}`], { cwd: ROOT, encoding: 'utf8' }).replaceAll('\r\n', '\n')).digest('hex')]));
  const statePath = resolve(LOCAL, 'state.json'), budgetPath = resolve(LOCAL, 'budget.json');
  const initial = validateState(readJson(statePath));
  await withRunLock(ROOT_ACCOUNT, async () => {
    const state = validateState(readJson(statePath));
    ensure(state.runId === initial.runId && canonicalJson(state.actors) === canonicalJson(initial.actors)
      && state.genesisHash === initial.genesisHash, 'RECOVERY_RUN_CHANGED');
    const document = readJson<BudgetDocument>(budgetPath);
    ensure(document && document.rootAccount.toLowerCase() === ROOT_ACCOUNT.toLowerCase()
      && document.limitWei === LIVE_LIMIT_WEI && document.priorSpendWei === PRIOR_SPEND_WEI, 'RECOVERY_BUDGET_IDENTITY_MISMATCH');
    const ledger = new BudgetLedger(document, next => atomicWriteJson(budgetPath, next));
    const store = new BrowserOperationStore(createFileStorage(resolve(LOCAL, 'operations.json')),
      { key: 'partfolk-product-proof-v1', locks: new MemoryOperationStore() });
    const binding = admissionRecoveryBinding(state, store, ledger.snapshot().records, options);
    assertOriginalGuardProvenance(options.originalCommit, binding.actionCommit, sourceDigests);
    const operator = createOperatorRpc({ autoDetectDirectory: ROOT });
    const read: ReadRpc = createArkivReadClient(operator.request).request;
    const genesis = await read({ method: 'eth_getBlockByNumber', params: ['0x0', false] }) as { hash?: string };
    ensure(genesis?.hash === state.genesisHash, 'RECOVERY_GENESIS_MISMATCH');
    let forwarded = 0;
    const recovery = await ledger.recoverAdmission({ ...binding, expectedNonce: options.expectedNonce, originalCommit: options.originalCommit,
      broadcast: true, read,
      loadAccount: async () => {
        try {
          const wallet = JSON.parse(readFileSync(resolve(LOCAL, `wallet-${binding.actor}.json`), 'utf8')) as {
            privateKey: Hex; address: string; chainId: number; network: string; version?: number; role?: string;
          };
          ensure(wallet.network === 'tiramisu' && wallet.chainId === LIVE_CHAIN_ID && wallet.version === 1 && wallet.role === binding.actor, 'RECOVERY_SIGNER_MISMATCH');
          const account = privateKeyToAccount(wallet.privateKey);
          ensure(account.address.toLowerCase() === binding.address.toLowerCase() && wallet.address.toLowerCase() === binding.address.toLowerCase(), 'RECOVERY_SIGNER_MISMATCH');
          return account;
        } catch { throw new LiveSafetyError('CANNOT_LOAD_EXPECTED_LOCAL_SIGNER'); }
      },
      sendRaw: async raw => {
        ensure(forwarded < options.maxTransactions, 'RECOVERY_TRANSACTION_BOUND_REACHED'); forwarded++;
        return operator.request({ method: 'eth_sendRawTransaction', params: [raw] });
      },
    });
    process.stdout.write(`${JSON.stringify({ recovery, transactionsForwardedThisInvocation: forwarded,
      chargedWei: ledger.publicSummary().chargedWei, next: 'Resume the original phase through normal journal hydration and verification.' })}\n`);
  }, { runId: initial.runId, accounts: Object.values(initial.actors) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ stopped: true, code: error instanceof LiveSafetyError ? error.code : 'ADMISSION_RECOVERY_RECONCILIATION_REQUIRED',
      retryPolicy: 'Preserve the original admission and any candidate reservation; never select another nonce.' })}\n`);
    process.exitCode = 1;
  });
}
