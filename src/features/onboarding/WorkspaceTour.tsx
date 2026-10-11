import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp, useAppSession } from '../../app/context';
import { parseRoute } from '../../app/routes';
import { Button, Dialog } from '../../ui';
import { createAccountPreferences, readAccountPreferences } from '../account/account';
import { canShowTour, tourContext, tourSteps, workspaceTour } from './tour';
import { TourIllustration } from './TourIllustration';
import './tour.css';

export function WorkspaceTour() {
  const runtime = useApp(), session = useAppSession();
  const controller = useMemo(() => workspaceTour(runtime, session.actor), [runtime, session.actor]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const route = parseRoute(session.destination);
  const eligible = canShowTour(route, session.mode, session.actor);
  const preferences = session.actor?.kind === 'wallet'
    ? readAccountPreferences(createAccountPreferences(runtime, session.actor.address).load()).value : null;
  useEffect(() => {
    // Help only replays on request. First-use guidance follows actual sign-in and setup.
    if (eligible && route.name !== 'help' && preferences?.setupComplete) controller.ensureStarted();
  }, [controller, eligible, preferences?.setupComplete, route.name]);
  if (!eligible || state.progress.status !== 'active') return null;
  const steps = tourSteps(tourContext(route, preferences?.defaultDestination));
  const step = steps[state.progress.step] ?? steps[0]!;
  const last = state.progress.step === steps.length - 1;
  return <Dialog key={session.actor?.kind === 'wallet' ? session.actor.address.toLowerCase() : 'guest'}
    open title="Welcome to Partfolk" closeLabel="Close" className="pf-welcome-tour pf-surface-light"
    onClose={controller.close}
    footer={<>
      <Button variant="quiet" className="pf-welcome-tour-skip" onClick={controller.skip}>Skip tour</Button>
      <div className="pf-welcome-tour-navigation">
        <Button variant="secondary" disabled={state.progress.step === 0} onClick={controller.back}>Previous</Button>
        <Button onClick={controller.next}>{last ? 'Finish tour' : 'Continue'}</Button>
      </div>
    </>}>
    <div className="pf-welcome-tour-art" key={step.art}><TourIllustration scene={step.art} /></div>
    <div className="pf-welcome-tour-copy" aria-live="polite" aria-atomic="true">
      <h3>{step.title}</h3><p>{step.body}</p>
      <p className="pf-welcome-tour-progress">Step {state.progress.step + 1} of {steps.length}</p>
    </div>
    <div className="pf-welcome-tour-dots" aria-hidden="true">{steps.map((_, index) => <span key={index} data-current={index === state.progress.step} />)}</div>
    {state.storageIssue && <p className="pf-field-message pf-welcome-tour-storage" role="status">Tour progress could not be saved on this device. It may appear again next time.</p>}
  </Dialog>;
}
