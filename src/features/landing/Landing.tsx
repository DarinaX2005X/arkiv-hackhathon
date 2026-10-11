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
  const owner = (id: string) => preview.rows.find(row => row.id === id)?.contributions.map(item => item.owner).join(' + ');
  const stateLabel = (id: string) => moment === 'replacement' ? copy.waiting
    : moment === 'withdrawn' ? id === 'transport' ? copy.withdrawn : copy.earlierAgreement : copy.accepted;
  return <figure className={`pf-landing-scene pf-landing-scene--${moment}`} aria-label={copy.sceneTitle}>
    <div className="pf-landing-scene-visual">
      <ExhibitionArt boardCount={preview.rows.find(row => row.id === 'boards')?.quantity ?? 0} moment={moment} />
      <div className="pf-scene-ownership" role="group" aria-label="Contributions in the illustration">
        <div className="pf-scene-owner pf-scene-owner--venue"><strong>The room</strong><span>{owner('venue')}</span><span className="pf-scene-owner-state">{stateLabel('venue')}</span></div>
        <div className="pf-scene-owner pf-scene-owner--boards"><strong>Six display boards</strong><span>{owner('boards')}</span><span className="pf-scene-owner-state">{stateLabel('boards')}</span></div>
        <div className="pf-scene-owner pf-scene-owner--transport"><strong>The artworks’ ride</strong><span>{owner('transport')}</span><span className="pf-scene-owner-state">{stateLabel('transport')}</span></div>
      </div>
    </div>
    <div className="pf-landing-scene-result" aria-live="polite" aria-atomic="true">
      <span className="pf-scene-result-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d={moment === 'agreed' ? 'm6 12 4 4 8-9' : moment === 'withdrawn' ? 'M12 5v9m0 4v1' : 'M5 12h14m-5-5 5 5-5 5'} /></svg></span>
      <div><h2>{current.title}</h2><p>{current.body}</p></div>
    </div>
    <div className="pf-landing-moments" role="group" aria-label={copy.sceneControl}>
      {moments.map(item => <button type="button" key={item.id} aria-pressed={moment === item.id}
        disabled={item.id === 'replacement' && !replacement} onClick={() => setMoment(item.id)}>{item.label}</button>)}
    </div>
    <figcaption>{copy.sceneTitle}. {copy.illustration}</figcaption>
  </figure>;
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
        <p className="pf-landing-description">{copy.description}</p>
        <div className="pf-landing-entry">{createLink}<Button variant="quiet" onClick={scrollToSteps}>{copy.seeHow}</Button></div>
        <p className="pf-landing-arkiv-intro">{copy.arkivIntro}</p>
        <Link className="pf-landing-attendee-entry" href={routeHref({ name: 'events' })}>{copy.browseEvents}<span aria-hidden="true">↗</span></Link>
      </div>
      {original ? <ExhibitionScene original={original} replacement={replacement} /> : <p>{copy.sampleUnavailable}</p>}
    </section>

    {returningDraft && <aside className="pf-landing-return" aria-label="Your saved draft"><span>Pick up where you left off <strong>{returningDraft.title || copy.untitledDraft}</strong></span><Link href={routeHref(returningDraft.route)} onClick={returningDraft.onContinue}>{copy.continueProject}</Link></aside>}

    <section className="pf-landing-how" aria-labelledby="landing-how-title">
      <div className="pf-landing-section-heading"><h2 id="landing-how-title" tabIndex={-1}>{copy.howTitle}</h2><p>{copy.howIntro}</p></div>
      <ol className="pf-landing-steps" role="list">{steps.map((step, index) => <li key={step.kind}>
        <div className="pf-landing-step-art"><ProcessArt kind={step.kind} /></div><div className="pf-landing-step-copy"><h3><span className="pf-landing-step-number" aria-hidden="true">{index + 1}</span>{step.title}</h3><p>{step.action}</p><p className="pf-landing-step-result">{step.result}</p></div>
      </li>)}</ol>
    </section>

    <section className="pf-landing-repair" aria-labelledby="landing-repair-title">
      <div className="pf-landing-repair-copy"><h2 id="landing-repair-title">{copy.repairTitle}</h2><p>{copy.repairIntro}</p><p>{copy.repairHistory}</p>
        <Link className="pf-button pf-button--secondary" href={routeHref({ name: 'demo' })}>{copy.tryExample}</Link><p className="pf-landing-practice-note">{copy.practiceNote}</p>
      </div>
      <div className="pf-landing-change-sheet">
        <div className="pf-landing-change-title"><h3>A new way to make it work</h3><span>Illustrated example</span></div>
        <table><caption>{copy.repairCaption}</caption><thead><tr><th scope="col">The work</th><th scope="col">{copy.repairBefore}</th><th scope="col">{copy.repairAfter}</th></tr></thead>
          <tbody>{['transport', 'installation'].map(id => <tr key={id}><th scope="row">{original?.rows.find(row => row.id === id)?.title ?? id}</th>
            <td>{original?.rows.find(row => row.id === id)?.contributions.map(item => item.owner).join(' + ') ?? 'See example'}</td>
            <td>{replacement?.rows.find(row => row.id === id)?.contributions.map(item => item.owner).join(' + ') ?? 'See example'}</td></tr>)}</tbody>
        </table>
        <div className="pf-landing-change-agreement"><strong>Everyone reviews again</strong><p>{copy.repairFresh}</p></div>
      </div>
    </section>

    <section className="pf-landing-independent" aria-labelledby="landing-independent-title">
      <div className="pf-landing-independent-title"><h2 id="landing-independent-title">{copy.arkivTitle}</h2><p>{copy.arkivBody}</p></div>
      <div className="pf-landing-independent-detail">
        <div className="pf-landing-record-diagram" role="group" aria-label="Independent Partfolk clients read the same owner-authored records on Arkiv">
          <div className="pf-record-client"><strong>Your event workspace</strong><span>The organizer proposes</span></div>
          <div className="pf-record-source"><strong>Arkiv</strong><span>Owner-authored offers and decisions</span></div>
          <div className="pf-record-client"><strong>A contributor’s own client</strong><span>The owner decides</span></div>
        </div>
        <p>{copy.arkivConsequence}</p>
        <div className="pf-landing-independent-links"><Link href={deskUrl}>{copy.deskAction}</Link><Link href={helpHref('technical', { name: 'home' })}>{copy.dataAction}</Link></div>
        <p className="pf-landing-data-note">{copy.arkivBoundary}</p>
      </div>
    </section>

    <section className="pf-landing-next" aria-labelledby="landing-next-title">
      <div className="pf-landing-next-organizer"><h2 id="landing-next-title">{copy.finalTitle}</h2><p>{copy.finalBody}</p>{createLink}<p className="pf-landing-draft-note">{copy.draftNote}</p></div>
      <div className="pf-landing-next-other">
        <div><h3>{copy.contributorTitle}</h3><p>{copy.contributorBody}</p><Link href={routeHref({ name: 'contributions' })}>{copy.ownersAction}</Link></div>
        <div><h3>{copy.attendeeTitle}</h3><p>{copy.attendeeBody}</p><Link href={routeHref({ name: 'events' })}>{copy.browseEvents}</Link></div>
      </div>
    </section>
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
