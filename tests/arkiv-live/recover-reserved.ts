/** Explicit operator recovery of one original journalled hash. Importing performs no I/O. */
import { execFileSync } from 'node:child_process';
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
import { assertJournalContinuity } from './runner';
import { BudgetLedger, LIVE_CHAIN_ID, LIVE_LIMIT_WEI, PRIOR_SPEND_WEI, LiveSafetyError,
  atomicWriteJson, createFileStorage, readJson, withRunLock } from './safety';
import type { BudgetDocument, BudgetRecord, ReadRpc } from './safety';
import { ROOT_ACCOUNT, validateState } from './state';
import type { ProofState } from './state';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL = resolve(ROOT, '.local/product-proof');
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new LiveSafetyError(code); }
export interface RecoveryOptions { expectedHash: Hex; reviewedCommit: string; broadcast: true; maxTransactions: 1 }

export function parseRecoveryOptions(args: string[]): RecoveryOptions {
  let recover = false, broadcast = false, expectedHash: Hex | undefined, reviewedCommit: string | undefined, maxTransactions: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    ensure(!seen.has(flag), 'INVALID_RECOVERY_OPTIONS'); seen.add(flag);
    if (flag === '--recover-reserved') recover = true;
    else if (flag === '--broadcast') broadcast = true;
    else if (flag === '--expected-hash' && /^0x[\da-f]{64}$/i.test(args[index + 1] ?? '')) expectedHash = args[++index]!.toLowerCase() as Hex;
    else if (flag === '--reviewed-commit' && /^[\da-f]{40}$/i.test(args[index + 1] ?? '')) reviewedCommit = args[++index]!.toLowerCase();
    else if (flag === '--max-transactions' && args[index + 1] === '1') { index++; maxTransactions = 1; }
    else throw new LiveSafetyError('INVALID_RECOVERY_OPTIONS');
  }
  if (!recover || !broadcast || !expectedHash || !reviewedCommit || maxTransactions !== 1) throw new LiveSafetyError('EXPLICIT_ORIGINAL_RECOVERY_REQUIRED');
  return { expectedHash, reviewedCommit, broadcast: true, maxTransactions: 1 };
}

/** Bind the CLI hash to the existing action, native step, admission and reservation. */
export function recoveryBinding(state: ProofState, store: OperationStore, records: BudgetRecord[], expectedHash: Hex) {
  assertJournalContinuity(state.actions, store, records);
  const matches = store.list().filter(saved => saved.submissionHash === expectedHash || saved.step.transactionHash === expectedHash);
  ensure(matches.length === 1, 'RECOVERY_ORIGINAL_JOURNAL_REQUIRED');
  const saved = matches[0]!;
  ensure(saved.submissionHash === expectedHash && saved.step.transactionHash === expectedHash
    && saved.admission && saved.prepared && !saved.receipt && ['submitted', 'unverified'].includes(saved.step.status), 'RECOVERY_JOURNAL_HASH_MISMATCH');
  const actions = Object.values(state.actions).filter(action => action.command.operation.id === saved.operation.id);
  ensure(actions.length === 1, 'RECOVERY_ORIGINAL_ACTION_REQUIRED');
  const action = actions[0]!;
  ensure(!action.confirmed && action.confirmedKeys.length === 0 && operationBinding(action.command.operation) === operationBinding(saved.operation), 'RECOVERY_ACTION_MISMATCH');
  const actorAddress = action.actor === 'coordinator' ? state.rootAccount : state.actors[action.actor];
  ensure(saved.operation.authority.mode === 'public' && saved.operation.authority.chainId === LIVE_CHAIN_ID
    && saved.operation.authority.actor.address.toLowerCase() === actorAddress.toLowerCase()
    && saved.step.inputHash === hashCanonical(saved.batch), 'RECOVERY_AUTHORITY_MISMATCH');
  const attempt = store.getAttempt(saved.operation.id);
  ensure(attempt?.state === 'native-started' && attempt.nativeStepIds.includes(saved.step.id)
    && operationBinding(attempt.operation) === operationBinding(saved.operation), 'RECOVERY_ORIGINAL_ATTEMPT_REQUIRED');
  const record = records.find(item => item.id === `${saved.operation.id}:${saved.step.id}`);
  ensure(record?.kind === 'native' && record.plan.from === actorAddress.toLowerCase()
    && (!record.transactionHash || record.transactionHash === expectedHash), 'RECOVERY_RESERVATION_MISMATCH');
  ensure(canonicalJson(saved.prepared!.request) === canonicalJson(saved.admission!.request), 'RECOVERY_ADMISSION_MISMATCH');
  return { actor: action.actor, address: actorAddress, record: record!, request: saved.admission!.request };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseRecoveryOptions(args);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  ensure(commit === options.reviewedCommit, 'RECOVERY_REVIEWED_COMMIT_REQUIRED');
  ensure(!execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'RECOVERY_CLEAN_SOURCE_REQUIRED');
  const statePath = resolve(LOCAL, 'state.json'), budgetPath = resolve(LOCAL, 'budget.json');
  const initial = validateState(readJson(statePath));
  await withRunLock(ROOT_ACCOUNT, async () => {
    const state = validateState(readJson(statePath));
    ensure(state.runId === initial.runId && canonicalJson(state.actors) === canonicalJson(initial.actors)
      && state.genesisHash === initial.genesisHash, 'RECOVERY_RUN_CHANGED');
    const document = readJson<BudgetDocument>(budgetPath);
    ensure(document && document.rootAccount.toLowerCase() === ROOT_ACCOUNT.toLowerCase()
      && document.limitWei === LIVE_LIMIT_WEI && document.priorSpendWei === PRIOR_SPEND_WEI, 'RECOVERY_BUDGET_IDENTITY_MISMATCH');
    const ledger = new BudgetLedger(document!, next => atomicWriteJson(budgetPath, next));
    const store = new BrowserOperationStore(createFileStorage(resolve(LOCAL, 'operations.json')),
      { key: 'partfolk-product-proof-v1', locks: new MemoryOperationStore() });
    const binding = recoveryBinding(state, store, ledger.snapshot().records, options.expectedHash);
    const operator = createOperatorRpc({ autoDetectDirectory: ROOT });
    const read: ReadRpc = createArkivReadClient(operator.request).request;
    const genesis = await read({ method: 'eth_getBlockByNumber', params: ['0x0', false] }) as { hash?: string };
    ensure(genesis?.hash === state.genesisHash, 'RECOVERY_GENESIS_MISMATCH');
    let forwarded = 0;
    const result = await ledger.recoverReserved({ id: binding.record.id, expectedHash: options.expectedHash,
      address: binding.address, request: binding.request, read, broadcast: true,
      loadAccount: async () => {
        try {
          const path = binding.actor === 'coordinator' ? resolve(ROOT, '.local/demo-wallet.json') : resolve(LOCAL, `wallet-${binding.actor}.json`);
          const wallet = JSON.parse(readFileSync(path, 'utf8')) as { privateKey: Hex; address: string; chainId: number; network: string; version?: number; role?: string };
          ensure(wallet.network === 'tiramisu' && wallet.chainId === LIVE_CHAIN_ID
            && (binding.actor === 'coordinator' || wallet.version === 1 && wallet.role === binding.actor), 'RECOVERY_SIGNER_MISMATCH');
          const account = privateKeyToAccount(wallet.privateKey);
          ensure(account.address.toLowerCase() === binding.address.toLowerCase()
            && wallet.address.toLowerCase() === binding.address.toLowerCase(), 'RECOVERY_SIGNER_MISMATCH');
          return account;
        } catch { throw new LiveSafetyError('CANNOT_LOAD_EXPECTED_LOCAL_SIGNER'); }
      },
      sendRaw: async raw => {
        ensure(forwarded < options.maxTransactions, 'RECOVERY_TRANSACTION_BOUND_REACHED'); forwarded++;
        return operator.request({ method: 'eth_sendRawTransaction', params: [raw] });
      },
    });
    process.stdout.write(`${JSON.stringify({ recovery: result, transactionsForwardedThisInvocation: forwarded,
      chargedWei: ledger.publicSummary().chargedWei,
      next: 'Resume the original phase through its normal reconciliation before any later writes.' })}\n`);
  }, { runId: initial.runId, accounts: Object.values(initial.actors) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof LiveSafetyError ? error.code : 'ORIGINAL_RECOVERY_RECONCILIATION_REQUIRED';
    process.stderr.write(`${JSON.stringify({ stopped: true, code, retryPolicy: 'Preserve all files; reconcile only the original hash.' })}\n`);
    process.exitCode = 1;
  });
}
