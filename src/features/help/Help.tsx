import { useEffect } from 'react';
import type { RouteViewProps } from '../../app/App';
import { routeHref } from '../../app/routes';
import { Link, Notice } from '../../ui';
import { helpCopy as copy, helpTopics } from './catalog';
import { helpHref, helpReturnLabel, helpReturnRoute, isHelpTopic } from './navigation';
import './help.css';

export interface HelpPageProps {
  topic?: string; returnTo?: string; deskUrl?: string;
  /** MAIN supplies links only when the corresponding documentation is available. */
  sourceLinks?: readonly { label: string; href: string }[];
}

export function HelpPage({ topic, returnTo, deskUrl = './desk.html', sourceLinks = [] }: HelpPageProps) {
  const selected = isHelpTopic(topic) ? topic : null;
  const returnRoute = helpReturnRoute(returnTo);
  useEffect(() => {
    if (selected) document.getElementById(`help-${selected}`)?.focus();
  }, [selected]);
  return <div className="pf-help pf-stack">
    <header className="pf-help-heading pf-stack pf-stack--compact">
      <Link href={routeHref(returnRoute)}>{helpReturnLabel(returnRoute)}</Link>
      <h1>{copy.title}</h1>
      <p>{copy.intro}</p>
    </header>
    {topic && !selected && <Notice tone="warning">{copy.unknownTopic}</Notice>}
    <div className="pf-help-layout">
      <nav className="pf-help-topics" aria-label={copy.topics}>
        <p className="pf-field-label">{copy.topics}</p>
        <ul>{helpTopics.map(item => <li key={item.id}><Link href={helpHref(item.id, returnRoute)} aria-current={item.id === selected ? 'location' : undefined}>{item.title}</Link></li>)}</ul>
      </nav>
      <div className="pf-help-content pf-sheet">
        {helpTopics.filter(item => !selected || item.id === selected).map(item => <section key={item.id} className="pf-help-topic" aria-labelledby={`help-${item.id}`}>
          <h2 id={`help-${item.id}`} tabIndex={-1}>{item.title}</h2>
          <p className="pf-help-summary">{item.summary}</p>
          {item.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
          {item.id === 'getting-started' && <div className="pf-actions"><Link href={routeHref({ name: 'demo' })}>{copy.exampleAction}</Link><Link href={routeHref({ name: 'workspace' })}>Open Projects</Link></div>}
          {item.id === 'offers' && <Link href={routeHref({ name: 'contributions' })}>{copy.contributionsAction}</Link>}
          {item.id === 'agreement' && <Link href={routeHref({ name: 'requests' })}>{copy.requestsAction}</Link>}
          {item.id === 'partner-desk' && <div className="pf-stack pf-stack--compact"><Link href={deskUrl}>{copy.deskAction}<span aria-hidden="true"> ↗</span></Link><p className="pf-field-message">{copy.deskNote}</p></div>}
          {item.id === 'technical' && sourceLinks.length > 0 && <div className="pf-stack pf-stack--compact"><h3>{copy.technicalLinks}</h3><ul>{sourceLinks.map(source => <li key={source.href}><Link href={source.href}>{source.label}</Link></li>)}</ul></div>}
        </section>)}
        <div className="pf-help-bottom pf-actions"><Link href={routeHref(returnRoute)}>{helpReturnLabel(returnRoute)}</Link>{selected && <Link href={helpHref(undefined, returnRoute)}>{copy.allTopics}</Link>}</div>
      </div>
    </div>
  </div>;
}

export function HelpRoute({ route }: RouteViewProps) {
  const topic = 'topic' in route && typeof route.topic === 'string' ? route.topic : undefined;
  const returnTo = 'returnTo' in route && typeof route.returnTo === 'string' ? route.returnTo : undefined;
  return <HelpPage topic={topic} returnTo={returnTo} />;
}
