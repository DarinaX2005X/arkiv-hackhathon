import { useMemo } from 'react';
import type { RouteViewProps } from '../../app/App';
import { useApp, useAppSession } from '../../app/context';
import { routeHref, type Route } from '../../app/routes';
import { Link } from '../../ui';
import { useProjectDrafts } from '../projects/hooks';
import { helpHref } from '../help/navigation';
import { landingCopy as copy } from './catalog';
import { createCoveragePreview, previewQuantity, previewTime } from './model';
import { ExhibitionArt } from './ExhibitionArt';
import './landing.css';

export interface ReturningDraft { title: string; route: Route; onContinue?: () => void }
export interface LandingPageProps {
  returningDraft?: ReturningDraft | null;
  /** Retained for application compatibility; the alternate client is explained in Help. */
  deskUrl?: string;
  onCreateProject?: () => void;
}

export function LandingPage({ returningDraft, onCreateProject }: LandingPageProps) {
  const preview = useMemo(createCoveragePreview, []);
  const jobs = ['installation', 'transport', 'hosting'].flatMap(id => {
    const row = preview?.rows.find(item => item.id === id);
    return row ? [row] : [];
  });
  return <div className="pf-landing">
    <section className="pf-landing-hero" aria-labelledby="landing-title">
      <div className="pf-landing-intro">
        <h1 id="landing-title">{copy.heading}</h1>
        <p className="pf-landing-description">{copy.description}</p>
        <div className="pf-landing-entry">
          <a className="pf-button pf-button--primary" href={routeHref({ name: 'demo' })}>{copy.tryExample}</a>
          <Link href={routeHref({ name: 'new-project' })} onClick={onCreateProject}>{copy.createProject}</Link>
        </div>
        {returningDraft && <div className="pf-landing-return">
          <Link href={routeHref(returningDraft.route)} onClick={returningDraft.onContinue}>{copy.continueProject}</Link>
          <span>{returningDraft.title || copy.untitledDraft}</span>
        </div>}
      </div>
      <figure className="pf-landing-scene">
        <ExhibitionArt boardCount={preview?.rows.find(row => row.id === 'boards')?.quantity ?? 0} />
        <figcaption><span>{copy.sampleLabel}</span><p>{copy.sampleCaption}</p></figcaption>
      </figure>
      <div className="pf-landing-coverage-wrap">
        <details className="pf-landing-coverage-detail">
          <summary>{copy.coverageAction}</summary>
          {preview ? <><p>{copy.coverageIntro}</p><table className="pf-landing-coverage">
            <caption className="pf-visually-hidden">Small Works possible exhibition plan</caption>
            <thead><tr><th scope="col">{copy.requirementColumn}</th><th scope="col">{copy.contributionColumn}</th></tr></thead>
            <tbody>{preview.rows.map(row => <tr key={row.id}>
              <th scope="row">{row.title}<span className="pf-landing-row-detail">{previewQuantity(row.quantity, row.unit)} from {previewTime(row.interval, preview.timeZone)} ({preview.timeZone})</span></th>
              <td>{row.contributions.map((contribution, index) => <span className="pf-landing-owner" key={`${contribution.owner}-${index}`}>{contribution.owner}{row.contributions.length === 1 && row.quantity > 1 ? ` brings ${previewQuantity(contribution.quantity, row.unit)}` : ''}</span>)}</td>
            </tr>)}</tbody>
          </table></> : <p>{copy.sampleUnavailable}</p>}
        </details>
      </div>
    </section>
    <section className="pf-landing-proof" aria-labelledby="landing-story-title">
      <div className="pf-landing-proof-story"><h2 id="landing-story-title">{copy.storyTitle}</h2><p>{copy.storyIntro}</p><p>{copy.storyResolution}</p><Link href={routeHref({ name: 'demo' })}>{copy.storyAction}</Link></div>
      <div className="pf-landing-plan">
        <h3>{copy.resultTitle}</h3><p className="pf-landing-plan-context">From the Small Works example. Everyone still needs to agree.</p>
        <dl>{jobs.map(row => <div key={row.id}><dt>{row.title}<span>{previewTime(row.interval, preview!.timeZone)}</span></dt><dd>{row.contributions.map(contribution => contribution.owner).join(' and ')}</dd></div>)}</dl>
        {preview && <p className="pf-landing-plan-place">Library provides the room. Makerspace provides {previewQuantity(preview.rows.find(row => row.id === 'boards')?.quantity ?? 0, 'board')} and the installation kit.</p>}
      </div>
    </section>
    <section className="pf-landing-together" aria-labelledby="landing-agreement-title">
      <h2 id="landing-agreement-title">{copy.agreementTitle}</h2><div><p>{copy.agreementBody}</p><p>{copy.changeBody}</p><Link href={helpHref('agreement', { name: 'home' })}>{copy.helpAction}</Link></div>
    </section>
    <section className="pf-landing-next" aria-labelledby="landing-next-title">
      <div><h2 id="landing-next-title">{copy.finalTitle}</h2><p>{copy.finalBody}</p><Link href={routeHref({ name: 'new-project' })} onClick={onCreateProject}>{copy.createProject}</Link></div>
      <div className="pf-landing-contribute"><h3>{copy.ownersTitle}</h3><Link href={routeHref({ name: 'contributions' })}>{copy.ownersAction}</Link></div>
    </section>
  </div>;
}

export function LandingRoute(_props: RouteViewProps) {
  const { session } = useApp(); const state = useAppSession(); const { storage } = useProjectDrafts();
  const draft = storage.get(state.activeDraftId) ?? storage.list()[0];
  const returningDraft: ReturningDraft | null = draft ? { title: draft.editor.title,
    route: draft.projectRoot ? { name: 'project', projectRoot: draft.projectRoot, tab: 'needs' } : { name: 'new-project' },
    onContinue: () => session.selectDraft(draft.id) } : null;
  return <LandingPage returningDraft={returningDraft} onCreateProject={() => session.selectDraft(null)} />;
}
