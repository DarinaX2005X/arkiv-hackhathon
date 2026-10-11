import { useMemo, useState } from 'react';
import type { RouteViewProps } from '../../app/App';
import { useApp, useAppSession } from '../../app/context';
import { routeHref, type Route } from '../../app/routes';
import { Button, Link } from '../../ui';
import { useProjectDrafts } from '../projects/hooks';
import { selectNewProjectDraft } from '../projects/draft-session';
import { helpHref } from '../help/navigation';
import { landingCopy as copy } from './catalog';
import { createCoveragePreview, type CoveragePreview, type IllustrationMoment } from './model';
import { ExhibitionArt } from './ExhibitionArt';
import { ProcessArt } from './ProcessArt';
import './landing.css';

export interface ReturningDraft { title: string; route: Route; onContinue?: () => void }
export interface LandingPageProps {
  returningDraft?: ReturningDraft | null;
  deskUrl?: string;
  onCreateProject?: () => void;
}

const moments = [
  { id: 'agreed', label: copy.sceneAgreed, title: copy.agreedTitle, body: copy.agreedBody, version: copy.agreementVersion },
  { id: 'withdrawn', label: copy.sceneWithdrawn, title: copy.withdrawnTitle, body: copy.withdrawnBody, version: copy.withdrawnVersion },
  { id: 'replacement', label: copy.sceneReplacement, title: copy.replacementTitle, body: copy.replacementBody, version: copy.replacementVersion },
] as const;
const steps = [
  { kind: 'set', title: copy.setTitle, action: copy.setAction, result: copy.setResult },
  { kind: 'offer', title: copy.offerTitle, action: copy.offerAction, result: copy.offerResult },
  { kind: 'agree', title: copy.agreeTitle, action: copy.agreeAction, result: copy.agreeResult },
] as const;

/** Explanatory states are component memory only. No repository or storage writes. */
function ExhibitionScene({ original, replacement }: { original: CoveragePreview; replacement: CoveragePreview | null }) {
  const [moment, setMoment] = useState<IllustrationMoment>('agreed');
  const current = moments.find(item => item.id === moment)!;
  const preview = moment === 'replacement' && replacement ? replacement : original;
  const rows = preview.rows.filter(row => ['venue', 'boards', 'installation', 'transport', 'hosting'].includes(row.id));
  return <section className="pf-landing-scene" aria-labelledby="landing-scene-title">
    <div className="pf-landing-scene-heading"><h2 id="landing-scene-title">{copy.sceneTitle}</h2><p>{copy.illustration}</p></div>
    <div className="pf-landing-moments" role="group" aria-label={copy.sceneControl}>
      {moments.map(item => <button type="button" key={item.id} aria-pressed={moment === item.id}
        disabled={item.id === 'replacement' && !replacement} onClick={() => setMoment(item.id)}>{item.label}</button>)}
    </div>
    <div className={`pf-landing-stage pf-landing-stage--${moment}`}>
      <div className="pf-landing-scene-art"><ExhibitionArt boardCount={preview.rows.find(row => row.id === 'boards')?.quantity ?? 0} moment={moment} /></div>
      <div className="pf-landing-decisions" aria-live="polite" aria-atomic="true">
        <h3>{current.title}</h3>
        <p className="pf-landing-version">{current.version}</p>
        <dl>{rows.map(row => <div key={row.id} className={row.id === 'transport' && moment === 'withdrawn' ? 'pf-landing-decision--withdrawn' : undefined}>
          <dt>{row.title}</dt><dd><span>{row.contributions.map(contribution => contribution.owner).join(' + ')}</span>
            <span className="pf-landing-decision-state">{moment === 'replacement' ? copy.waiting : moment === 'withdrawn' ? row.id === 'transport' ? copy.withdrawn : copy.earlierAgreement : copy.accepted}</span></dd>
        </div>)}</dl>
        <p>{current.body}</p>
      </div>
    </div>
  </section>;
}

export function LandingPage({ returningDraft, onCreateProject, deskUrl = './desk.html' }: LandingPageProps) {
  const original = useMemo(() => createCoveragePreview(), []);
  const replacement = useMemo(() => createCoveragePreview(true), []);
  const scrollToSteps = () => {
    const target = document.getElementById('landing-how-title');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  };
  const createLink = <Link className="pf-button pf-button--primary" href={routeHref({ name: 'new-project' })} onClick={onCreateProject}>{copy.createProject}</Link>;
  return <div className="pf-landing">
    <section className="pf-landing-hero" aria-labelledby="landing-title">
      <div className="pf-landing-opening">
        <h1 id="landing-title">{copy.heading}</h1>
        <div className="pf-landing-intro">
          <p className="pf-landing-description">{copy.description}</p>
          <p className="pf-landing-arkiv-intro">{copy.arkivIntro}</p>
          <div className="pf-landing-entry">{createLink}<Button variant="quiet" onClick={scrollToSteps}>{copy.seeHow}</Button></div>
          <p className="pf-landing-draft-note">{copy.draftNote}</p>
          {returningDraft && <div className="pf-landing-return"><Link href={routeHref(returningDraft.route)} onClick={returningDraft.onContinue}>{copy.continueProject}</Link><span>{returningDraft.title || copy.untitledDraft}</span></div>}
        </div>
      </div>
      {original ? <ExhibitionScene original={original} replacement={replacement} /> : <p>{copy.sampleUnavailable}</p>}
    </section>

    <section className="pf-landing-how" aria-labelledby="landing-how-title">
      <div className="pf-landing-section-heading"><h2 id="landing-how-title" tabIndex={-1}>{copy.howTitle}</h2><p>{copy.howIntro}</p></div>
      <ol className="pf-landing-steps">{steps.map(step => <li key={step.kind}>
        <ProcessArt kind={step.kind} /><div><h3>{step.title}</h3><p>{step.action}</p><p className="pf-landing-step-result">{step.result}</p></div>
      </li>)}</ol>
    </section>

    <section className="pf-landing-repair" aria-labelledby="landing-repair-title">
      <div className="pf-landing-repair-copy"><h2 id="landing-repair-title">{copy.repairTitle}</h2><p>{copy.repairIntro}</p><p>{copy.repairHistory}</p>
        <Link className="pf-button pf-button--secondary" href={routeHref({ name: 'demo' })}>{copy.tryExample}</Link><p className="pf-landing-practice-note">{copy.practiceNote}</p>
      </div>
      <div className="pf-landing-change-sheet">
        <table><caption>{copy.repairCaption}</caption><thead><tr><th scope="col">The work</th><th scope="col">{copy.repairBefore}</th><th scope="col">{copy.repairAfter}</th></tr></thead>
          <tbody>{['transport', 'installation'].map(id => <tr key={id}><th scope="row">{original?.rows.find(row => row.id === id)?.title ?? id}</th>
            <td>{original?.rows.find(row => row.id === id)?.contributions.map(item => item.owner).join(' + ') ?? 'See example'}</td>
            <td>{replacement?.rows.find(row => row.id === id)?.contributions.map(item => item.owner).join(' + ') ?? 'See example'}</td></tr>)}</tbody>
        </table>
        <p>{copy.repairFresh}</p>
      </div>
    </section>

    <section className="pf-landing-independent" aria-labelledby="landing-independent-title">
      <div className="pf-landing-independent-title"><h2 id="landing-independent-title">{copy.arkivTitle}</h2><p>{copy.arkivBody}</p></div>
      <div className="pf-landing-independent-detail"><p>{copy.arkivConsequence}</p><Link href={deskUrl}>{copy.deskAction}</Link><Link href={helpHref('technical', { name: 'home' })}>{copy.dataAction}</Link><p className="pf-landing-data-note">{copy.arkivBoundary}</p></div>
    </section>

    <section className="pf-landing-next" aria-labelledby="landing-next-title"><div><h2 id="landing-next-title">{copy.finalTitle}</h2><p>{copy.finalBody}</p></div><div className="pf-landing-next-actions">{createLink}<Link href={routeHref({ name: 'contributions' })}>{copy.ownersAction}</Link></div></section>
  </div>;
}

export function LandingRoute({ onCreateProject }: Partial<RouteViewProps> & { onCreateProject?: () => void }) {
  const runtime = useApp(); const state = useAppSession(); const { storage } = useProjectDrafts();
  const draft = storage.get(state.activeDraftId) ?? storage.list()[0];
  const returningDraft: ReturningDraft | null = draft ? { title: draft.editor.title,
    route: draft.projectRoot ? { name: 'project', projectRoot: draft.projectRoot, tab: 'needs' } : { name: 'new-project' },
    onContinue: () => runtime.session.selectDraft(draft.id) } : null;
  return <LandingPage returningDraft={returningDraft} onCreateProject={onCreateProject ?? (() => { selectNewProjectDraft(runtime); })} />;
}
