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
import { ProcessArt } from './ProcessArt';
import './landing.css';

export interface LandingPageProps { onCreateProject?: () => void }

const changes = [
  { kind: 'withdrawn', art: 'offer', title: copy.withdrawnTitle, body: copy.withdrawnBody },
  { kind: 'replacement', art: 'set', title: copy.replacementTitle, body: copy.replacementBody },
  { kind: 'agreement', art: 'agree', title: copy.agreementTitle, body: copy.agreementBody },
] as const;

/** Public explanation only. Rendering this page never creates personal work. */
export function LandingPage({ onCreateProject }: LandingPageProps) {
  const create = (className: string) => <Link className={className} href={routeHref({ name: 'new-project' })} onClick={onCreateProject}>{copy.createProject}</Link>;
  const browse = (className: string) => <Link className={className} href={routeHref({ name: 'events' })}>{copy.browseEvents}</Link>;

  return <div className="pf-landing">
    <section className="pf-landing-hero" aria-labelledby="landing-title">
      <div className="pf-landing-opening">
        <h1 id="landing-title"><span>{copy.heading}</span>{' '}<span>{copy.headingContinuation}</span></h1>
        <p className="pf-landing-description">{copy.description}</p>
        <div className="pf-landing-entry">
          {browse('pf-button pf-button--primary')}
          {create('pf-button pf-button--secondary')}
        </div>
        <DemoVideo />
        <p className="pf-landing-arkiv-intro">{copy.arkivIntro}</p>
      </div>
      <EventScene />
    </section>

    <section className="pf-landing-roles" aria-labelledby="landing-roles-title">
      <div className="pf-landing-section-heading">
        <h2 id="landing-roles-title">{copy.rolesTitle}</h2>
        <p>{copy.rolesIntro}</p>
      </div>
      <div className="pf-landing-role-grid">
        <article className="pf-landing-role pf-landing-role--join pf-surface-light">
          <div className="pf-landing-role-art"><ProcessArt kind="join" /></div>
          <div className="pf-landing-role-copy">
            <h3>{copy.attendeeTitle}</h3>
            <p>{copy.attendeeBody}</p>
            <p className="pf-landing-role-result">{copy.attendeeResult}</p>
            {browse('pf-button pf-button--primary')}
          </div>
        </article>
        <article className="pf-landing-role pf-landing-role--set pf-surface-dark">
          <div className="pf-landing-role-art"><ProcessArt kind="set" /></div>
          <div className="pf-landing-role-copy">
            <h3>{copy.organizerTitle}</h3>
            <p>{copy.organizerBody}</p>
            {create('pf-button pf-button--secondary')}
          </div>
        </article>
        <article className="pf-landing-role pf-landing-role--offer pf-surface-light">
          <div className="pf-landing-role-art"><ProcessArt kind="offer" /></div>
          <div className="pf-landing-role-copy">
            <h3>{copy.contributorTitle}</h3>
            <p>{copy.contributorBody}</p>
            <Link className="pf-button pf-button--secondary" href={routeHref({ name: 'contributions' })}>{copy.offerAction}</Link>
          </div>
        </article>
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
        <p>{copy.changeIntro}</p>
      </div>
      <ol className="pf-landing-change-steps">
        {changes.map((step, index) => <li className={`pf-landing-change-step pf-landing-change-step--${step.kind}`} key={step.kind}>
          <div className="pf-landing-change-art">
            <ProcessArt kind={step.art} />
            {index < changes.length - 1 && <span className="pf-landing-change-arrow" aria-hidden="true">→</span>}
          </div>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </li>)}
      </ol>
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
