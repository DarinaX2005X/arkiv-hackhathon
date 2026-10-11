import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { parseRoute } from '../../app/routes';
import { Button } from '../../ui';
import { createAccountPreferences, readAccountPreferences } from '../account/account';
import { resolveTourTarget, tourSteps, workspaceTour } from './tour';

export function WorkspaceTour() {
  const runtime = useApp(), session = useAppSession();
  const controller = useMemo(() => workspaceTour(runtime, session.actor), [runtime, session.actor]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const route = parseRoute(session.destination);
  const eligible = ['workspace', 'new-project', 'contributions', 'requests', 'project', 'events', 'event', 'my-events'].includes(route.name);
  useEffect(() => {
    if (!eligible || session.mode !== 'public' || session.actor?.kind !== 'wallet') return;
    const preferences = readAccountPreferences(createAccountPreferences(runtime, session.actor.address).load()).value;
    if (preferences.setupComplete) controller.ensureStarted();
  }, [controller, eligible, runtime, session.actor, session.mode]);
  if (!eligible || state.progress.status !== 'active') return null;
  const steps = tourSteps(route), step = steps[state.progress.step] ?? steps[0]!;
  const showTarget = () => {
    const candidates = [step.targetId, 'work-surface'].filter(id => document.getElementById(id));
    const target = resolveTourTarget(step, candidates);
    if (target) document.getElementById(target)?.focus();
  };
  return <aside className="pf-tour" aria-labelledby="workspace-tour-title">
    <div className="pf-tour-content" aria-live="polite"><h2 id="workspace-tour-title">{step.title}</h2><p>{step.body}</p></div>
    <div className="pf-tour-controls"><p className="pf-secondary">Workspace guide: {state.progress.step + 1} of {steps.length}</p><div className="pf-actions"><Button variant="quiet" onClick={showTarget}>{step.targetLabel}</Button><Button variant="quiet" disabled={state.progress.step === 0} onClick={controller.back}>Back</Button><Button variant="secondary" onClick={controller.next}>{state.progress.step === steps.length - 1 ? 'Finish guide' : 'Next'}</Button><Button variant="quiet" onClick={controller.skip}>Skip guide</Button><Button variant="quiet" aria-label="Close workspace guide" onClick={controller.close}>Close</Button></div></div>
    {state.storageIssue && <p className="pf-field-message">Guide progress could not be saved on this device. Your work is unaffected; the guide may appear again next time.</p>}
  </aside>;
}
