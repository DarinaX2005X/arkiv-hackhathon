import { useId } from 'react';
import { BrandMark, Button, Link } from '../../ui';
import './errors.css';

function LostInvitationArt() {
  const id = useId();
  return <svg className="pf-error-art" viewBox="0 0 600 440" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-paper`} x1="182" y1="68" x2="441" y2="325" gradientUnits="userSpaceOnUse"><stop stopColor="#fff" /><stop offset="1" stopColor="#e0e8d8" /></linearGradient>
      <linearGradient id={`${id}-frame`} x1="75" y1="203" x2="428" y2="420" gradientUnits="userSpaceOnUse"><stop stopColor="#7f9a7d" /><stop offset="1" stopColor="#45674f" /></linearGradient>
      <linearGradient id={`${id}-back`} x1="156" y1="177" x2="449" y2="322" gradientUnits="userSpaceOnUse"><stop stopColor="#365d4b" /><stop offset="1" stopColor="#1e4034" /></linearGradient>
      <filter id={`${id}-shadow`} x="20" y="252" width="560" height="160" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="10" /></filter>
    </defs>
    <ellipse cx="304" cy="359" rx="209" ry="25" fill="#061b13" opacity=".18" filter={`url(#${id}-shadow)`} />
    <path d="m89 245 315-76 104 93-320 86Z" fill="#a9bca0" />
    <path d="m188 348 320-86v17l-319 88Z" fill="#49684f" />
    <path d="m89 245 99 103 1 19-100-100Z" fill="#68836a" />
    <path d="m113 242 265-65 106 86-269 73Z" fill={`url(#${id}-back)`} />
    <g className="pf-error-paper">
      <path d="m202 100 187-36 58 188-189 47-59-185Z" fill="#90a48c" />
      <path d="m195 90 187-36 58 188-189 47-59-185q-2-11 3-14Z" fill={`url(#${id}-paper)`} />
      <path d="m222 115 131-27 9 29-131 28Z" fill="#cbdcba" />
      <path d="m243 169 42-9 14 47-44 10Z" fill="#39654e" />
      <path d="m298 157 73-16 5 16-73 16Z" fill="#8dA585" />
      <path d="m306 184 51-12 4 13-51 12Z" fill="#b5c5a9" />
      <path d="m265 246 64-15" stroke="#819b78" strokeWidth="6" strokeLinecap="round" />
      <path d="m350 226 41-10" stroke="#b2c3a4" strokeWidth="6" strokeLinecap="round" />
      <path d="m197 92 183-35" stroke="white" strokeWidth="3" opacity=".7" />
    </g>
    <path d="m96 247 85 82 315-83 12 16-320 86Z" fill={`url(#${id}-frame)`} />
    <path d="m99 246 84 79 310-81" stroke="#aabea0" strokeWidth="3" />
    <path d="m376 326 27-7 8 22-27 8Z" fill="#bed49f" />
    <path d="m412 317 27-7 8 22-27 8Z" fill="#d8e7c3" />
    <path d="m448 308 27-7 8 22-27 8Z" fill="#f0f4e8" />
    <path d="m97 161 37-9 8 24-36 10Z" fill="#c8dba9" />
    <path d="m99 190 34-9 6 17-34 9Z" fill="#73956b" />
  </svg>;
}

interface ErrorPageProps {
  kind?: 'not-found' | 'unavailable';
  homeHref?: string;
  eventsHref?: string;
  onRetry?: () => void;
}

/** A failed route never prints the requested URL or private error details. */
export function ErrorPage({ kind = 'not-found', homeHref = '/#/', eventsHref = '/#/events', onRetry }: ErrorPageProps) {
  const missing = kind === 'not-found';
  return <section className="pf-error-page" aria-labelledby="error-heading">
    <div className="pf-error-picture"><LostInvitationArt /><span className="pf-error-number" aria-label={missing ? 'Error 404' : 'Page unavailable'}>{missing ? '404' : '…'}</span></div>
    <div className="pf-error-content">
      <h1 id="error-heading">{missing ? 'This page isn’t here' : 'We couldn’t open this page'}</h1>
      <p>{missing ? 'The link may have changed. Find an event to join, or head home to start something together.' : 'Give it another try. Your saved work is still available when the page reopens.'}</p>
      <div className="pf-error-actions">
        {missing ? <Link className="pf-button pf-button--primary" href={eventsHref}>Browse events</Link>
          : <Button onClick={onRetry ?? (() => window.location.reload())}>Reload page</Button>}
        <Link className="pf-button pf-button--secondary" href={homeHref}>Back to home</Link>
      </div>
      <nav className="pf-error-help" aria-label="More ways to continue"><Link href="/#/workspace">My projects</Link><Link href="/#/help">Help with Partfolk</Link></nav>
    </div>
  </section>;
}

export function NotFoundPage(props: Omit<ErrorPageProps, 'kind'>) { return <ErrorPage {...props} kind="not-found" />; }

export function StandaloneErrorPage({ kind = 'not-found' }: Pick<ErrorPageProps, 'kind'>) {
  return <div className="pf-error-document">
    <a className="pf-error-skip" href="#error-main">Skip to page content</a>
    <header className="pf-error-header"><Link className="pf-error-brand" href="/#/"><BrandMark /><span>Partfolk</span></Link><nav aria-label="Main navigation"><Link href="/#/events">Events</Link><Link href="/#/workspace">My projects</Link><Link href="/#/help">Help</Link></nav></header>
    <main id="error-main" tabIndex={-1}><ErrorPage kind={kind} /></main>
    <footer className="pf-error-footer"><span>Everyone brings a part</span><Link href="/#/help?topic=publishing">Your public records</Link></footer>
  </div>;
}
