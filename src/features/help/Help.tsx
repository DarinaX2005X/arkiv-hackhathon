import { useEffect } from 'react';
import type { RouteViewProps } from '../../app/App';
import { routeHref } from '../../app/routes';
import { Link } from '../../ui';
import { helpCopy as copy, helpTopics, type HelpTopicId } from './catalog';
import { helpHref, helpReturnLabel, helpReturnRoute, isHelpTopic } from './navigation';
import './help.css';

export interface HelpPageProps {
  topic?: string; returnTo?: string; deskUrl?: string;
  sourceLinks?: readonly { label: string; href: string }[];
}
const everyday: HelpTopicId[] = ['getting-started', 'offers', 'agreement', 'changes', 'runbook'];
const deeper: HelpTopicId[] = ['publishing', 'recovery', 'expiry', 'partner-desk', 'technical'];

export function HelpPage({ topic, returnTo, deskUrl = './desk.html', sourceLinks = [] }: HelpPageProps) {
  const selected = isHelpTopic(topic) ? helpTopics.find(item => item.id === topic)! : null;
  const returnRoute = helpReturnRoute(returnTo);
  useEffect(() => { if (selected) document.getElementById(`help-${selected.id}`)?.focus(); }, [selected]);
  const topicLinks = (ids: HelpTopicId[], summary = false) => <ul>{ids.map(id => {
    const item = helpTopics.find(entry => entry.id === id)!;
    return <li key={id}><Link href={helpHref(id, returnRoute)} aria-current={selected?.id === id ? 'location' : undefined}>{item.title}</Link>{summary && <p>{item.summary}</p>}</li>;
  })}</ul>;
  return <div className={`pf-help ${selected ? 'pf-help--answer' : ''}`}>
    <nav className="pf-help-return" aria-label="Return to your work"><Link href={routeHref(returnRoute)}>{helpReturnLabel(returnRoute)}</Link>{selected && <Link href={helpHref(undefined, returnRoute)}>{copy.allTopics}</Link>}</nav>
    {!selected ? <>
      <header className="pf-help-heading"><h1>{copy.title}</h1><p>{copy.intro}</p></header>
      {topic && <p className="pf-help-missing" role="status">{copy.unknownTopic}</p>}
      <div className="pf-help-start">
        <nav className="pf-help-choices" aria-label="Choose what you want to do">{topicLinks(everyday, true)}</nav>
        <aside className="pf-help-first-time"><h2>See a project come together</h2><p>The exhibition example starts with a scheduling clash. Try a change and find a plan that fits.</p><Link href={routeHref({ name: 'demo' })}>{copy.exampleAction}</Link><p className="pf-help-first-time-note">Fictional people and places. Everything stays on this device.</p></aside>
      </div>
      <details className="pf-help-deeper"><summary>Sharing, saved work and other clients</summary><nav aria-label="Sharing and data help">{topicLinks(deeper, true)}</nav></details>
    </> : <div className="pf-help-answer-layout">
      <article className="pf-help-answer" aria-labelledby={`help-${selected.id}`}>
        <header className="pf-help-heading"><h1 id={`help-${selected.id}`} tabIndex={-1}>{selected.title}</h1><p className="pf-help-summary">{selected.summary}</p></header>
        <div className="pf-help-prose">{selected.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
        <div className="pf-help-answer-actions">
          {selected.id === 'getting-started' && <><Link href={routeHref({ name: 'new-project' })}>{copy.createAction}</Link><Link href={routeHref({ name: 'demo' })}>{copy.exampleAction}</Link></>}
          {selected.id === 'offers' && <Link href={routeHref({ name: 'contributions' })}>{copy.contributionsAction}</Link>}
          {selected.id === 'agreement' && <Link href={routeHref({ name: 'requests' })}>{copy.requestsAction}</Link>}
          {selected.id === 'recovery' && <Link href={routeHref({ name: 'workspace' })}>Open my projects</Link>}
          {selected.id === 'partner-desk' && <div><Link href={deskUrl}>{copy.deskAction}</Link><p>{copy.deskNote}</p></div>}
        </div>
        {selected.id === 'technical' && sourceLinks.length > 0 && <section className="pf-help-sources"><h2>{copy.technicalLinks}</h2><ul>{sourceLinks.map(source => <li key={source.href}><Link href={source.href}>{source.label}</Link></li>)}</ul></section>}
        <div className="pf-help-bottom"><Link href={routeHref(returnRoute)}>{helpReturnLabel(returnRoute)}</Link></div>
      </article>
      <nav className="pf-help-topics" aria-label={copy.topics}><h2>{copy.topics}</h2>{topicLinks(everyday)}<details open={deeper.includes(selected.id)}><summary>Sharing and data</summary>{topicLinks(deeper)}</details></nav>
    </div>}
  </div>;
}

export function HelpRoute({ route }: RouteViewProps) {
  const topic = 'topic' in route && typeof route.topic === 'string' ? route.topic : undefined;
  const returnTo = 'returnTo' in route && typeof route.returnTo === 'string' ? route.returnTo : undefined;
  return <HelpPage topic={topic} returnTo={returnTo} />;
}
