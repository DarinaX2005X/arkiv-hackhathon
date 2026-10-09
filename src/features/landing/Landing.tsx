import { useMemo } from 'react';
import type { RouteViewProps } from '../../app/App';
import { useApp, useAppSession } from '../../app/context';
import { routeHref, type Route } from '../../app/routes';
import { Link, StatusLabel } from '../../ui';
import { useProjectDrafts } from '../projects/hooks';
import { helpHref } from '../help/navigation';
import { landingCopy as copy } from './catalog';
import { createCoveragePreview, previewQuantity, previewTime } from './model';
import './landing.css';

export interface ReturningDraft { title: string; route: Route; onContinue?: () => void }
export interface LandingPageProps {
  returningDraft?: ReturningDraft | null;
  deskUrl?: string;
  onCreateProject?: () => void;
}

function EntryActions({ onCreateProject }: Pick<LandingPageProps, 'onCreateProject'>) {
  return <div className="pf-actions">
    <a className="pf-button pf-button--primary" href={routeHref({ name: 'demo' })}>{copy.tryExample}<span aria-hidden="true">→</span></a>
    <a className="pf-button pf-button--secondary" href={routeHref({ name: 'new-project' })} onClick={onCreateProject}>{copy.createProject}</a>
  </div>;
}

export function LandingPage({ returningDraft, deskUrl = './desk.html', onCreateProject }: LandingPageProps) {
  const preview = useMemo(createCoveragePreview, []);
  const steps = [
    [copy.gapTitle, copy.gapBody], [copy.fitTitle, copy.fitBody], [copy.agreementTitle, copy.agreementBody],
    [copy.changeTitle, copy.changeBody], [copy.finishTitle, copy.finishBody],
  ];
  const sampleDate = preview?.rows[0] ? new Intl.DateTimeFormat('en-GB', { timeZone: preview.timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(preview.rows[0].interval.start) : '';
  return <div className="pf-landing">
    <section className="pf-landing-hero" aria-labelledby="landing-title">
      <div className="pf-landing-intro">
        <h1 id="landing-title">{copy.heading}</h1>
        <p className="pf-landing-description">{copy.description}</p>
        <EntryActions onCreateProject={onCreateProject} />
        <p className="pf-field-message">{copy.entryNote}</p>
        {returningDraft && <div className="pf-landing-return">
          <Link href={routeHref(returningDraft.route)} onClick={returningDraft.onContinue}>{copy.continueProject}<span aria-hidden="true"> →</span></Link>
          <span>{returningDraft.title || copy.untitledDraft}</span>
        </div>}
      </div>
      <figure className="pf-landing-sheet pf-sheet">
        <figcaption className="pf-stack pf-stack--compact">
          <p className="pf-field-message">{copy.sampleLabel}</p>
          <h2>{preview?.title ?? 'Small Works'}</h2>
          <p>{copy.sampleCaption}</p>
          {preview && <p className="pf-field-message">{sampleDate}<br />{preview.variantTitle} · {preview.timeZone}</p>}
          {preview && <StatusLabel tone="neutral">{copy.sampleStatus}</StatusLabel>}
        </figcaption>
        {preview ? <table className="pf-landing-coverage">
          <caption className="pf-visually-hidden">Small Works sample coverage sheet</caption>
          <thead><tr><th scope="col">{copy.requirementColumn}</th><th scope="col">{copy.contributionColumn}</th></tr></thead>
          <tbody>{preview.rows.map(row => <tr key={row.id}>
            <th scope="row"><span>{row.title}</span><span className="pf-landing-row-detail">{previewQuantity(row.quantity, row.unit)} · {previewTime(row.interval, preview.timeZone)}</span></th>
            <td>{row.contributions.map((contribution, index) => <span className="pf-landing-owner" key={`${contribution.owner}-${index}`}>
              {contribution.owner}{row.contributions.length === 1 && row.quantity > 1 && <span className="pf-landing-owner-quantity">{previewQuantity(contribution.quantity, row.unit)}</span>}
            </span>)}</td>
          </tr>)}</tbody>
        </table> : <p>{copy.sampleUnavailable}</p>}
        <p className="pf-field-message pf-landing-sheet-note">{copy.sampleNote}</p>
      </figure>
    </section>

    <section className="pf-landing-story" aria-labelledby="landing-story-title">
      <div className="pf-stack">
        <h2 id="landing-story-title">{copy.storyTitle}</h2>
        <p>{copy.storyIntro}</p>
        <Link href={routeHref({ name: 'demo' })}>{copy.storyAction}<span aria-hidden="true"> →</span></Link>
      </div>
      <ol className="pf-landing-sequence">{steps.map(([title, body], index) => <li key={title}>
        <span className="pf-landing-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
        <div><h3>{title}</h3><p>{body}</p></div>
      </li>)}</ol>
    </section>

    <section className="pf-landing-ownership" aria-labelledby="landing-ownership-title">
      <h2 id="landing-ownership-title">{copy.ownershipTitle}</h2>
      <div className="pf-stack">
        <p>{copy.ownershipBody}</p>
        <p className="pf-secondary">{copy.ownershipNote}</p>
        <div className="pf-actions"><Link href={deskUrl}>{copy.deskAction}<span aria-hidden="true"> ↗</span></Link><Link href={helpHref('agreement', { name: 'home' })}>{copy.helpAction}</Link></div>
      </div>
    </section>

    <section className="pf-landing-close" aria-labelledby="landing-close-title">
      <div><h2 id="landing-close-title">{copy.finalTitle}</h2><p>{copy.finalBody}</p></div>
      <EntryActions onCreateProject={onCreateProject} />
    </section>
  </div>;
}

export function LandingRoute(_props: RouteViewProps) {
  const { session } = useApp();
  const state = useAppSession();
  const { storage } = useProjectDrafts();
  const draft = storage.get(state.activeDraftId) ?? storage.list()[0];
  const returningDraft: ReturningDraft | null = draft ? {
    title: draft.editor.title,
    route: draft.projectRoot ? { name: 'project', projectRoot: draft.projectRoot, tab: 'needs' } : { name: 'new-project' },
    onContinue: () => session.selectDraft(draft.id),
  } : null;
  return <LandingPage returningDraft={returningDraft} onCreateProject={() => session.selectDraft(null)} />;
}
