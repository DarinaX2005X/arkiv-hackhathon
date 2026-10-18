import type { RouteViewProps } from '../../app/App';
import { useApp } from '../../app/context';
import { routeHref } from '../../app/routes';
import { Link } from '../../ui';
import { selectNewProjectDraft } from '../projects/draft-session';
import { helpHref } from '../help/navigation';
import { landingCopy as copy } from './catalog';
import { DemoVideo } from './DemoVideo';
import { EventScene } from './EventScene';
import { OwnershipScene } from './OwnershipScene';
import './landing.css';

export interface LandingPageProps { onCreateProject?: () => void }

/** Public explanation only. Rendering this page never creates personal work. */
export function LandingPage({ onCreateProject }: LandingPageProps) {
  const create = (className: string) => <Link className={className} href={routeHref({ name: 'new-project' })} onClick={onCreateProject}>{copy.createProject}</Link>;
  const browse = (className: string) => <Link className={className} href={routeHref({ name: 'events' })}>{copy.browseEvents}</Link>;

  return <div className="pf-landing">
    <section className="pf-landing-hero" aria-labelledby="landing-title">
      <div className="pf-landing-opening">
        <h1 id="landing-title"><span>{copy.heading}.</span>{' '}<span>{copy.headingContinuation}.</span></h1>
        <div className="pf-landing-opening-invitation"><p className="pf-landing-description">{copy.description}</p>
          <div className="pf-landing-entry">{browse('pf-button pf-button--primary')}{create('pf-button pf-button--secondary')}</div>
          <DemoVideo />
        </div>
      </div>
      <figure className="pf-landing-assembly"><EventScene /><figcaption><span>A place to meet. Something to share. People to make it happen.</span><span>Each contribution has its own owner and agreement.</span></figcaption></figure>
    </section>

    <section className="pf-landing-roles" aria-labelledby="landing-roles-title">
      <div className="pf-landing-section-heading">
        <h2 id="landing-roles-title">{copy.rolesTitle}</h2>
        <p>{copy.rolesIntro}</p>
      </div>
      <div className="pf-landing-entry-list">
        <article><h3>{copy.attendeeTitle}</h3><p>{copy.attendeeBody}</p>{browse('pf-landing-entry-link')}</article>
        <article><h3>{copy.organizerTitle}</h3><p>{copy.organizerBody}</p>{create('pf-landing-entry-link')}</article>
        <article><h3>{copy.contributorTitle}</h3><p>{copy.contributorBody}</p><Link className="pf-landing-entry-link" href={routeHref({ name: 'contributions' })}>{copy.offerAction}</Link></article>
      </div>
    </section>

    <section className="pf-landing-independent" aria-labelledby="landing-independent-title">
      <div className="pf-landing-independent-copy">
        <h2 id="landing-independent-title">{copy.arkivTitle}</h2>
        <p className="pf-landing-lead">{copy.arkivBody}</p>
        <p>{copy.arkivConsequence}</p>
        <Link className="pf-landing-text-link" href={helpHref('technical', { name: 'home' })}>
          {copy.dataAction}<span aria-hidden="true">↗</span>
        </Link>
      </div>
      <figure className="pf-landing-ownership">
        <OwnershipScene />
        <figcaption>{copy.ownerCaption}</figcaption>
      </figure>
      <div className="pf-landing-desk">
        <div>
          <h3>{copy.deskTitle}</h3>
          <p>{copy.deskBody}</p>
        </div>
        <Link className="pf-button pf-button--secondary" href="/desk">{copy.deskAction}<span aria-hidden="true">↗</span></Link>
      </div>
    </section>

    <section className="pf-landing-change pf-surface-light" aria-labelledby="landing-change-title">
      <div className="pf-landing-section-heading">
        <h2 id="landing-change-title">{copy.changeTitle}</h2>
        <div className="pf-landing-change-intro">
          <p>{copy.changeIntro}</p>
          <Link className="pf-button pf-button--secondary" href={routeHref({ name: 'demo' })}>{copy.practiceAction}</Link>
        </div>
      </div>
      <div className="pf-landing-change-example" aria-label="Illustrative example of a changed event plan">
        <div className="pf-landing-example-heading"><h3>A transport offer changes</h3><p>An illustrative example. If required agreement is withdrawn, new registrations pause.</p></div>
        <div className="pf-landing-change-comparison"><section><h4>Before withdrawal</h4><dl><div><dt>Space</dt><dd>Offered and agreed</dd></div><div><dt>Display equipment</dt><dd>Offered and agreed</dd></div><div><dt>Transport</dt><dd>Offered and agreed</dd></div></dl></section><section><h4>After withdrawal</h4><dl><div><dt>Space</dt><dd>Still in the plan</dd></div><div><dt>Display equipment</dt><dd>Still in the plan</dd></div><div className="pf-landing-missing-part"><dt>Transport</dt><dd>A replacement is needed</dd></div></dl></section></div>
        <div className="pf-landing-change-decision"><h3>Same occasion. A new agreement.</h3><p>{copy.agreementBody}</p></div>
      </div>
      <div className="pf-landing-guests">
        <div>
          <h3>{copy.guestsTitle}</h3>
          <p>{copy.guestsBody}</p>
        </div>
        <Link className="pf-landing-text-link" href={routeHref({ name: 'my-events' })}>{copy.guestsAction}<span aria-hidden="true">→</span></Link>
      </div>
    </section>

    <section className="pf-landing-next" aria-labelledby="landing-next-title">
      <div className="pf-landing-next-copy">
        <h2 id="landing-next-title">{copy.finalTitle}</h2>
        <p>{copy.finalBody}</p>
      </div>
      <div className="pf-landing-entry">
        {create('pf-button pf-button--primary')}
        {browse('pf-button pf-button--secondary')}
      </div>
    </section>
  </div>;
}

export function LandingRoute({ onCreateProject }: Partial<RouteViewProps> & { onCreateProject?: () => void }) {
  const runtime = useApp();
  return <LandingPage onCreateProject={onCreateProject ?? (() => { selectNewProjectDraft(runtime); })} />;
}
