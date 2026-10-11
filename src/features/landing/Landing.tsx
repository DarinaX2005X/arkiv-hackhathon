import type { RouteViewProps } from '../../app/App';
import { useApp } from '../../app/context';
import { routeHref } from '../../app/routes';
import { Link } from '../../ui';
import { selectNewProjectDraft } from '../projects/draft-session';
import { helpHref } from '../help/navigation';
import { landingCopy as copy } from './catalog';
import { EventScene } from './EventScene';
import { ProcessArt } from './ProcessArt';
import './landing.css';

export interface LandingPageProps { onCreateProject?: () => void }

const roles = [
  { kind: 'set', title: copy.organizerTitle, body: copy.organizerBody, result: copy.organizerResult, action: copy.createProject, route: 'new-project' },
  { kind: 'offer', title: copy.contributorTitle, body: copy.contributorBody, result: copy.contributorResult, action: copy.offerAction, route: 'contributions' },
  { kind: 'join', title: copy.attendeeTitle, body: copy.attendeeBody, result: copy.attendeeResult, action: copy.browseEvents, route: 'events' },
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
        <div className="pf-landing-entry">{browse('pf-button pf-button--primary')}{create('pf-button pf-button--secondary')}</div>
        <p className="pf-landing-arkiv-intro">{copy.arkivIntro}</p>
      </div>
      <EventScene />
    </section>

    <section className="pf-landing-roles" aria-labelledby="landing-roles-title">
      <div className="pf-landing-section-heading"><h2 id="landing-roles-title">{copy.rolesTitle}</h2><p>{copy.rolesIntro}</p></div>
      <div className="pf-landing-role-grid">{roles.map(role => <article className={`pf-landing-role pf-landing-role--${role.kind} pf-surface-light`} key={role.kind}>
        <div className="pf-landing-role-art"><ProcessArt kind={role.kind} /></div>
        <div className="pf-landing-role-copy"><h3>{role.title}</h3><p>{role.body}</p><p className="pf-landing-role-result">{role.result}</p>
          <Link className="pf-button pf-button--secondary" href={routeHref({ name: role.route })} onClick={role.route === 'new-project' ? onCreateProject : undefined}>{role.action}</Link>
        </div>
      </article>)}</div>
    </section>

    <section className="pf-landing-independent" aria-labelledby="landing-independent-title">
      <div className="pf-landing-independent-copy"><h2 id="landing-independent-title">{copy.arkivTitle}</h2><p className="pf-landing-lead">{copy.arkivBody}</p><p>{copy.arkivConsequence}</p>
        <Link className="pf-landing-text-link" href={helpHref('technical', { name: 'home' })}>{copy.dataAction}<span aria-hidden="true">↗</span></Link>
      </div>
      <div className="pf-landing-agreement pf-surface-light">
        <div className="pf-landing-agreement-art"><ProcessArt kind="agree" /></div>
        <h3>{copy.agreementTitle}</h3>
        <ol className="pf-landing-agreement-steps">
          <li><strong>{copy.proposeTitle}</strong><span>{copy.proposeBody}</span></li>
          <li><strong>{copy.decideTitle}</strong><span>{copy.decideBody}</span></li>
          <li><strong>{copy.recordTitle}</strong><span>{copy.recordBody}</span></li>
        </ol>
      </div>
    </section>

    <section className="pf-landing-change" aria-labelledby="landing-change-title">
      <h2 id="landing-change-title">{copy.changeTitle}</h2>
      <div className="pf-landing-change-copy"><p>{copy.changeBody}</p><p>{copy.changeResult}</p></div>
    </section>

    <section className="pf-landing-next pf-surface-light" aria-labelledby="landing-next-title">
      <div className="pf-landing-next-copy"><h2 id="landing-next-title">{copy.finalTitle}</h2><p>{copy.finalBody}</p>
        <div className="pf-landing-entry">{create('pf-button pf-button--primary')}{browse('pf-button pf-button--secondary')}</div>
      </div>
      <div className="pf-landing-next-object" aria-hidden="true"><ProcessArt kind="set" /></div>
    </section>
  </div>;
}

export function LandingRoute({ onCreateProject }: Partial<RouteViewProps> & { onCreateProject?: () => void }) {
  const runtime = useApp();
  return <LandingPage onCreateProject={onCreateProject ?? (() => { selectNewProjectDraft(runtime); })} />;
}
