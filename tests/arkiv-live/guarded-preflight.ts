import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../src/domain/canonical';
import type { OperationStore, StoredOperationStep } from '../../src/data/operations';
import { WalletOperationError } from '../../src/data/wallet';
import type { NativeWalletGateway } from '../../src/data/wallet';
import { GuardedPreflightNotSent, LIVE_CHAIN_ID, LiveSafetyError, nativeRequestHash } from './safety';
import type { Admission, BudgetRecord, GuardedPreflightHooks } from './safety';

interface PreflightWitness {
  id: string; operationId: string; stepId: string; requestHash: string; originalAdmissionAt: number;
  codeCommit: string; startedAt: number; state: 'entered' | 'not_sent';
  completedAt: number | null; reasonCode: string | null; proof: { keyLoads: 0; rawForwards: 0; noBudgetRecord: true } | null;
}
export interface PreflightWitnessDocument { version: 1; chainId: number; runId: string; records: PreflightWitness[] }
export function createPreflightWitnessDocument(runId: string): PreflightWitnessDocument {
  return { version: 1, chainId: LIVE_CHAIN_ID, runId, records: [] };
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const clone = <T>(value: T): T => structuredClone(value);
function ensure(condition: unknown, code = 'INVALID_PREFLIGHT_WITNESS'): asserts condition { if (!condition) throw new LiveSafetyError(code); }
function validate(document: PreflightWitnessDocument): void {
  ensure(document?.version === 1 && document.chainId === LIVE_CHAIN_ID && /^[a-z0-9-]{1,48}$/i.test(document.runId) && Array.isArray(document.records));
  const ids = new Set<string>();
  for (const item of document.records) {
    ensure(/^[a-z0-9-]{1,48}$/i.test(item.id) && !ids.has(item.id)); ids.add(item.id);
    ensure(/^[a-z0-9._:-]{1,127}$/i.test(item.operationId) && /^[a-z0-9._:-]{1,127}$/i.test(item.stepId)
      && /^0x[\da-f]{64}$/.test(item.requestHash) && /^[\da-f]{40}$/.test(item.codeCommit)
      && Number.isSafeInteger(item.originalAdmissionAt) && item.originalAdmissionAt >= 0
      && Number.isSafeInteger(item.startedAt) && item.startedAt >= item.originalAdmissionAt);
    if (item.state === 'entered') ensure(item.completedAt === null && item.reasonCode === null && item.proof === null);
    else ensure(item.state === 'not_sent' && Number.isSafeInteger(item.completedAt) && item.completedAt! >= item.startedAt
      && typeof item.reasonCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(item.reasonCode)
      && same(item.proof, { keyLoads: 0, rawForwards: 0, noBudgetRecord: true }));
  }
}

/** Separate positive evidence; an absent witness never establishes no send. */
export class GuardedPreflightWitnesses {
  private document: PreflightWitnessDocument;
  private poisoned = false;
  constructor(document: PreflightWitnessDocument, private readonly persist: (document: PreflightWitnessDocument) => void) {
    validate(document); this.document = clone(document);
  }
  private usable() { ensure(!this.poisoned, 'PREFLIGHT_WITNESS_RELOAD_REQUIRED'); }
  snapshot(): PreflightWitnessDocument { this.usable(); return clone(this.document); }
  private save() {
    try { validate(this.document); this.persist(clone(this.document)); }
    catch { this.poisoned = true; throw new LiveSafetyError('PREFLIGHT_WITNESS_PERSISTENCE_FAILED'); }
  }
  hooks(store: OperationStore, codeCommit: string, now = Date.now): GuardedPreflightHooks {
    return {
      begin: admission => {
        this.usable();
        const saved = store.get(admission.operationId, admission.stepId);
        ensure(saved?.admission && same(saved.admission.request, admission.request), 'PREFLIGHT_WITNESS_ADMISSION_MISMATCH');
        const prior = [...this.document.records].reverse().find(item => item.operationId === admission.operationId && item.stepId === admission.stepId);
        ensure(!prior || prior.state === 'not_sent' && prior.requestHash === nativeRequestHash(admission.request), 'PREFLIGHT_WITNESS_UNRESOLVED');
        const id = randomUUID();
        this.document.records.push({ id, operationId: admission.operationId, stepId: admission.stepId, requestHash: nativeRequestHash(admission.request),
          originalAdmissionAt: saved.admission.at, codeCommit, startedAt: Math.max(now(), saved.admission.at), state: 'entered',
          completedAt: null, reasonCode: null, proof: null });
        this.save(); return id;
      },
      notSent: (id, admission, reasonCode) => {
        this.usable(); const item = this.document.records.find(entry => entry.id === id);
        ensure(item?.state === 'entered' && item.operationId === admission.operationId && item.stepId === admission.stepId
          && item.requestHash === nativeRequestHash(admission.request), 'PREFLIGHT_WITNESS_ADMISSION_MISMATCH');
        item.state = 'not_sent'; item.completedAt = Math.max(now(), item.startedAt); item.reasonCode = reasonCode;
        item.proof = { keyLoads: 0, rawForwards: 0, noBudgetRecord: true }; this.save();
      },
    };
  }
  matches(saved: StoredOperationStep, attemptId?: string): boolean {
    this.usable();
    const latest = [...this.document.records].reverse().find(item => item.operationId === saved.operation.id && item.stepId === saved.step.id);
    return !!latest && latest.state === 'not_sent' && (!attemptId || latest.id === attemptId)
      && !!saved.admission && !!saved.prepared && latest.originalAdmissionAt === saved.admission.at
      && latest.requestHash === nativeRequestHash(saved.admission.request) && same(saved.prepared.request, saved.admission.request)
      && saved.submissionHash === null && saved.step.transactionHash === null && saved.receipt === null && saved.step.confirmedKeys.length === 0;
  }
}

/** Recognize only our runtime error and its durable witness, never a generic wallet/network error. */
export function withGuardedPreflightEvidence(base: NativeWalletGateway, store: OperationStore, witnesses: GuardedPreflightWitnesses): NativeWalletGateway {
  return { ...base, async submit(prepared, hooks) {
    try { return await base.submit(prepared, hooks); }
    catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 6 && cause instanceof Error; depth++, cause = cause.cause) {
        if (!(cause instanceof GuardedPreflightNotSent)) continue;
        const attemptId = cause.attemptId;
        const matches = store.list().filter(saved => saved.admission && same(saved.admission.request, prepared.request) && witnesses.matches(saved, attemptId));
        ensure(matches.length === 1, 'PREFLIGHT_WITNESS_ADMISSION_MISMATCH');
        throw new WalletOperationError('The guarded provider stopped before budget reservation, key access or transaction forwarding.', { kind: 'not_sent', code: 'network' });
      }
      throw error;
    }
  } };
}

/** Recover the controller status after a crash between the durable witness and its error checkpoint. */
export function applyGuardedPreflightEvidence(store: OperationStore, records: BudgetRecord[], witnesses: GuardedPreflightWitnesses): void {
  for (const saved of store.list()) {
    if (!witnesses.matches(saved) || records.some(record => record.id === `${saved.operation.id}:${saved.step.id}`)) continue;
    ensure(['unverified', 'failed-before-send'].includes(saved.step.status), 'PREFLIGHT_WITNESS_JOURNAL_MISMATCH');
    if (saved.step.status === 'failed-before-send' && saved.error?.kind === 'not_sent') continue;
    saved.step.status = 'failed-before-send';
    saved.error = { kind: 'not_sent', code: 'network', message: 'The guarded provider stopped before budget reservation, key access or transaction forwarding.' };
    saved.operation.steps = saved.operation.steps.map(step => step.id === saved.step.id ? clone(saved.step) : step);
    saved.revision++; store.put(saved);
  }
}
