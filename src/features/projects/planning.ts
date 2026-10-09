import type { PlanCandidate, SolverBudget, SolverInput, SolverPin, SolverResult } from '../../domain/types';
import { solve } from '../../domain/solver';
import { planningFingerprint } from './selectors';

export interface PlanningState {
  revision: number; running: boolean; stale: boolean; result: SolverResult | null;
  resultFingerprint: string | null; selected: number; failure: string | null;
}
/** Revision checks prevent an older async result replacing newer edits. */
export function createPlanningController(evaluate: (input: SolverInput, pins: SolverPin[], budget: SolverBudget) => SolverResult | Promise<SolverResult> = solve) {
  let input: SolverInput | null = null, pins: SolverPin[] = [], salt = '';
  let state: PlanningState = { revision: 0, running: false, stale: false, result: null, resultFingerprint: null, selected: 0, failure: null };
  const subscribers = new Set<() => void>();
  const set = (patch: Partial<PlanningState>) => { state = { ...state, ...patch }; for (const listener of subscribers) listener(); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    update(next: SolverInput | null, nextPins: SolverPin[], fingerprintSalt = '') {
      const changed = input === null || next === null || salt !== fingerprintSalt || planningFingerprint(input, pins) !== planningFingerprint(next, nextPins);
      input = next === null ? null : structuredClone(next); pins = structuredClone(nextPins); salt = fingerprintSalt;
      if (changed) set({ revision: state.revision + 1, stale: state.result !== null, running: false, failure: null });
    },
    async run(budget: SolverBudget = { maxNodes: 100000, maxCandidates: 12, maxMilliseconds: 500 }) {
      if (!input) return;
      const captured = structuredClone(input), capturedPins = structuredClone(pins), revision = state.revision;
      const fingerprint = `${planningFingerprint(captured, capturedPins)}${salt ? `:${salt}` : ''}`;
      set({ running: true, failure: null });
      try {
        const result = await evaluate(captured, capturedPins, budget);
        if (state.revision !== revision) return;
        set({ result, resultFingerprint: fingerprint, selected: 0, stale: false, running: false });
      } catch {
        if (state.revision === revision) set({ running: false, stale: state.result !== null, failure: 'The plan search could not finish. Your inputs have been retained.' });
      }
    },
    select(index: number) { if (state.result && Number.isInteger(index) && index >= 0 && index < state.result.candidates.length) set({ selected: index }); },
    candidate(): PlanCandidate | null {
      if (state.stale || state.running || !input || `${planningFingerprint(input, pins)}${salt ? `:${salt}` : ''}` !== state.resultFingerprint) return null;
      return state.result?.candidates[state.selected] ?? null;
    },
  };
}
