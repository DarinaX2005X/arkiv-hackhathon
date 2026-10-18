import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalRepository } from '../../data/local';
import { activeSource, sameSource } from '../../domain/readiness';
import type { ProjectAggregate } from '../../domain/types';
import { Button } from '../../ui';
import { loadGuidedPractice, runGuidedPracticeAction } from './guided';
import type { GuidedPracticeState, GuidedStage } from './guided';
import './practice.css';

export interface GuidedPracticeProps {
  repository: LocalRepository;
  onRefresh: () => Promise<void> | void;
  now: () => number;
  onOpenProject?: () => void;
  refreshKey?: number;
}
const copy: Record<GuidedStage, { title: string; body: string; button?: string; step: number }> = {
  blocked: { title: 'Cedar cannot install and transport at the same time',
    body: 'Sunday needs two installers and someone to bring the artworks. Cedar can do either job, but cannot do both at once. Saturday also lacks two display boards.',
    button: 'Add Oak and find a plan', step: 1 },
  awaiting_agreement: { title: 'A workable plan is waiting for agreement',
    body: 'Oak brings the artworks while Cedar and Willow install. The group can now review the complete plan, including equipment delivery and return.',
    button: 'Play the group’s agreement', step: 2 },
  ready: { title: 'Everyone has agreed to this plan',
    body: 'Each contributor has agreed to their part in the same complete plan. Next, see what happens when Oak becomes unavailable.',
    button: 'Let Oak withdraw', step: 3 },
  changed: { title: 'Oak withdrew. The plan needs an update',
    body: 'The old agreement no longer makes the plan ready. Juniper can join Willow to install, freeing Cedar to bring the artworks.',
    button: 'Add Juniper and update the plan', step: 4 },
  repair_awaiting_agreement: { title: 'The new plan needs fresh agreement',
    body: 'Juniper and Willow install; Cedar brings the artworks. The previous decisions belong to the previous plan. Everyone must agree to this changed plan.',
    button: 'Play fresh agreement', step: 5 },
  repaired: { title: 'The changed plan has everyone’s agreement',
    body: 'The saved history keeps both plans and their separate decisions. You can explore the people, the run sheet, or make another change in the full project.', step: 5 },
  manual: { title: 'Continue with your saved sample',
    body: 'Your sample has moved beyond this guided path. Its saved plan and decisions are available in the full project.', step: 0 },
};

/** Show the saved assignment and its owner's current decision together. */
export function practiceAssignmentRows(project: ProjectAggregate) {
  const plan = project.proposal?.payload.plan, source = activeSource(project);
  if (!plan) return [];
  return ['transport', 'installation', 'hosting'].flatMap(id => {
    const requirement = plan.variant.requirements.find(item => item.id === id);
    if (!requirement) return [];
    const owners = [...new Set(plan.allocations.filter(item => item.requirementId === id).map(item => item.publisherRoot))].map(key => {
      const publisher = project.publishers.find(item => item.root.key === key);
      const book = publisher?.book.status === 'unique' ? publisher.book.entity.payload : null;
      const decision = source ? book?.decisions.find(item => sameSource(item, source)) : null;
      const status = !book ? 'unverified' as const : decision?.status === 'withdrawn' || decision?.status === 'declined' ? decision.status : null;
      return { key, name: book?.name ?? 'Contributor unavailable', status };
    });
    return owners.length ? [{ id, title: requirement.title, owners }] : [];
  });
}

/** A shortcut through real local owner operations, explicitly presented as fictional sample decisions. */
export function GuidedPractice({ repository, onRefresh, now, onOpenProject, refreshKey }: GuidedPracticeProps) {
  const [state, setState] = useState<GuidedPracticeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), nowRef = useRef(now);
  nowRef.current = now;
  const read = useCallback(async () => {
    try { setState(await loadGuidedPractice(repository, () => nowRef.current())); setError(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The saved sample could not be read. Try again.'); }
  }, [repository]);
  useEffect(() => {
    let active = true;
    void loadGuidedPractice(repository, () => nowRef.current()).then(value => {
      if (active) { setState(value); setError(null); }
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'The saved sample could not be read.'); });
    return () => { active = false; };
  }, [repository, refreshKey]);
  useEffect(() => {
    const refresh = () => { if (!pending.current) void read(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('storage', refresh); };
  }, [read]);
  const act = async () => {
    if (!state?.action || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      setState(await runGuidedPracticeAction(repository, state.action, () => nowRef.current()));
      await onRefresh();
    } catch (failure) {
      try { setState(await loadGuidedPractice(repository, () => nowRef.current())); } catch { /* Keep the last readable view. */ }
      setError(failure instanceof Error ? failure.message : 'This step could not finish. Read the saved progress before trying again.');
    } finally { pending.current = false; setBusy(false); }
  };
  const words = state ? copy[state.stage] : null;
  const resumedBeforePlan = state?.stage === 'blocked' && !state.initialImpossible;
  const agreement = state?.stage === 'awaiting_agreement' || state?.stage === 'repair_awaiting_agreement';
  const assignments = state ? practiceAssignmentRows(state.project) : [];
  return <section className="guided-practice" aria-labelledby="guided-practice-title" aria-busy={busy || undefined}>
    <div className="guided-practice-intro"><h2 id="guided-practice-title">Try the exhibition</h2>
      <p>Sample decisions on this device. You play the fictional contributors.</p>
    </div>
    <div className="guided-practice-step" aria-live="polite">
      {words ? <>
        <h3>{resumedBeforePlan ? 'Continue finding a plan for the sample' : words.title}</h3>
        <p>{resumedBeforePlan ? 'Your added offers are saved. Continue to find and publish the complete plan.' : words.body}</p>
        {assignments.length > 0 && <ul className="guided-practice-result">{assignments.map(row => <li key={row.id}>
          <span className="guided-practice-result-label">{row.title}</span><span className="guided-practice-result-value">{row.owners.map((owner, index) => <span key={owner.key}>
            {index > 0 ? ' and ' : ''}{owner.name}{owner.status && <strong className="guided-practice-result-status">{owner.status === 'withdrawn' ? 'Withdrew; replacement needed' : owner.status === 'declined' ? 'Declined; replacement needed' : 'Availability needs checking'}</strong>}
          </span>)}</span>
        </li>)}</ul>}
        {agreement && <p className="guided-practice-owners">This plays a separate sample decision for {new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(state!.names)}.</p>}
        {state!.action && words.button && <div className="guided-practice-action"><Button onClick={() => { void act(); }} pending={busy} pendingLabel="Saving this step…">{words.button}</Button><span>Step {words.step} of 5</span></div>}
      </> : <p>Reading your saved practice…</p>}
      {error && <p role="alert" className="guided-practice-error">{error}</p>}
    </div>
    <div className="guided-practice-tools"><Button variant="quiet" size="compact" disabled={busy} onClick={() => { void read(); }}>Read saved progress</Button>
      {onOpenProject && <Button variant="quiet" size="compact" disabled={busy} onClick={onOpenProject}>Explore the full project</Button>}
    </div>
  </section>;
}
