import { useEffect } from 'react';
import type { RouteViewProps } from '../../app/App';
import { useApp, useAppSession } from '../../app/context';
import { routeHref, routePath } from '../../app/routes';
import { Button, Link } from '../../ui';
import { selectNewProjectDraft } from '../projects/draft-session';
import { TourIllustration } from '../onboarding/TourIllustration';
import { helpCopy as copy, helpTopics, type HelpTopicId } from './catalog';
import { helpContributionRoute, helpHref, helpReturnLabel, helpReturnRoute, isHelpTopic } from './navigation';
import './help.css';

export interface HelpPageProps {
  topic?: string; returnTo?: string;
  sourceLinks?: readonly { label: string; href: string }[];
  onCreateProject?: () => void;
  onReplayTour?: () => void;
}
const starting: HelpTopicId[] = ['getting-started', 'attending', 'offers', 'account', 'practice'];
const together: HelpTopicId[] = ['agreement', 'changes', 'runbook'];
const deeper: HelpTopicId[] = ['publishing', 'recovery', 'expiry', 'partner-desk', 'technical'];

export function HelpPage({ topic, returnTo, sourceLinks = [], onCreateProject, onReplayTour }: HelpPageProps) {
  const selected = isHelpTopic(topic) ? helpTopics.find(item => item.id === topic)! : null;
  const returnRoute = helpReturnRoute(returnTo);
  useEffect(() => { if (selected) document.getElementById(`help-${selected.id}`)?.focus(); }, [selected]);
  const topicLinks = (ids: HelpTopicId[], summary = false) => <ul>{ids.map(id => {
    const item = helpTopics.find(entry => entry.id === id)!;
    return <li key={id}><Link href={helpHref(id, returnRoute)} aria-current={selected?.id === id ? 'location' : undefined}>{item.title}</Link>{summary && <p>{item.summary}</p>}</li>;
  })}</ul>;
  const createLink = <Link href={routeHref({ name: 'new-project' })} onClick={onCreateProject}>{copy.createAction}</Link>;
  const accountLink = <Link href={routeHref({ name: 'account', returnTo: routePath(returnRoute) })}>{copy.accountAction}</Link>;
  const tour = <section className="pf-help-tour"><div className="pf-help-tour-art"><TourIllustration scene="return" /></div><h2>{copy.tourTitle}</h2><p>{copy.tourBody}</p>{onReplayTour ? <Button onClick={onReplayTour}>{copy.tourAction}</Button> : <Link href={routeHref({ name: 'sign-in', returnTo: routePath(returnRoute) })}>Sign in for the welcome tour</Link>}<p className="pf-help-first-time-note">{copy.tourNote}</p></section>;
  return <div className={`pf-help pf-surface-dark ${selected ? 'pf-help--answer' : ''}`}>
    <nav className="pf-help-return" aria-label="Return to your work"><Link href={routeHref(returnRoute)}>{helpReturnLabel(returnRoute)}</Link>{selected && <Link href={helpHref(undefined, returnRoute)}>{copy.allTopics}</Link>}</nav>
    {!selected ? <>
      <header className="pf-help-heading"><h1>{copy.title}</h1><p>{copy.intro}</p></header>
      {topic && <p className="pf-help-missing" role="status">{copy.unknownTopic}</p>}
      <div className="pf-help-start">
        <div className="pf-help-index-groups">
          <nav className="pf-help-choices" aria-label="Start and return">{topicLinks(starting, true)}</nav>
          <section className="pf-help-index-section"><h2>Work together</h2><nav className="pf-help-choices" aria-label="Work together">{topicLinks(together, true)}</nav></section>
          <section className="pf-help-index-section"><h2>Sharing and saved work</h2><nav className="pf-help-choices" aria-label="Sharing and saved work">{topicLinks(deeper, true)}</nav></section>
        </div>
        <aside className="pf-help-first-time pf-surface-light">{tour}<section className="pf-help-practice"><h2>{copy.practiceTitle}</h2><p>{copy.practiceBody}</p><Link href={routeHref({ name: 'demo' })}>{copy.exampleAction}</Link><p className="pf-help-first-time-note">{copy.practiceNote}</p></section></aside>
      </div>
    </> : <div className="pf-help-answer-layout">
      <article className="pf-help-answer pf-surface-light" aria-labelledby={`help-${selected.id}`}>
        <header className="pf-help-heading"><h1 id={`help-${selected.id}`} tabIndex={-1}>{selected.title}</h1><p className="pf-help-summary">{selected.summary}</p></header>
        <div className="pf-help-prose">{selected.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
        <div className="pf-help-answer-actions">
          {selected.id === 'getting-started' && <>{createLink}<Link href={routeHref({ name: 'workspace' })}>Open my projects</Link></>}
          {selected.id === 'account' && <><Link href={routeHref({ name: 'sign-in', returnTo: routePath(returnRoute) })}>{copy.signInAction}</Link>{accountLink}</>}
          {selected.id === 'attending' && <><Link href={routeHref({ name: 'events' })}>{copy.eventsAction}</Link><Link href={routeHref({ name: 'my-events' })}>Open my events</Link></>}
          {selected.id === 'practice' && <><Link href={routeHref({ name: 'demo' })}>{copy.exampleAction}</Link>{createLink}</>}
          {selected.id === 'offers' && <Link href={routeHref(helpContributionRoute(returnRoute))}>{copy.contributionsAction}</Link>}
          {selected.id === 'agreement' && <Link href={routeHref({ name: 'requests' })}>{copy.requestsAction}</Link>}
          {selected.id === 'recovery' && <><Link href={routeHref({ name: 'workspace' })}>Open my projects</Link>{accountLink}</>}
          {selected.id === 'partner-desk' && <><Link href={routeHref(helpContributionRoute(returnRoute))}>{copy.contributionsAction}</Link><Link href={routeHref({ name: 'requests' })}>{copy.requestsAction}</Link></>}
        </div>
        {selected.id === 'technical' && sourceLinks.length > 0 && <section className="pf-help-sources"><h2>{copy.technicalLinks}</h2><ul>{sourceLinks.map(source => <li key={source.href}><Link href={source.href}>{source.label}</Link></li>)}</ul></section>}
        <div className="pf-help-bottom"><Link href={routeHref(returnRoute)}>{helpReturnLabel(returnRoute)}</Link></div>
      </article>
      <aside className="pf-help-answer-support"><nav className="pf-help-topics" aria-label={copy.topics}><h2>{copy.topics}</h2>{topicLinks(starting)}{topicLinks(together)}<details open={deeper.includes(selected.id)}><summary>Sharing and data</summary>{topicLinks(deeper)}</details></nav>{onReplayTour && <Button variant="quiet" onClick={onReplayTour}>{copy.tourAction}</Button>}</aside>
    </div>}
  </div>;
}

export function HelpRoute({ route, onCreateProject, onReplayTour }: RouteViewProps & Pick<HelpPageProps, 'onCreateProject' | 'onReplayTour'>) {
  const runtime = useApp();
  const session = useAppSession();
  const topic = 'topic' in route && typeof route.topic === 'string' ? route.topic : undefined;
  const returnTo = 'returnTo' in route && typeof route.returnTo === 'string' ? route.returnTo : undefined;
  return <HelpPage topic={topic} returnTo={returnTo} onCreateProject={onCreateProject ?? (() => { selectNewProjectDraft(runtime); })} onReplayTour={session.mode === 'public' && session.actor?.kind === 'wallet' ? onReplayTour : undefined} />;
}
