import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Link } from '../../ui';
import { landingCopy as copy } from './catalog';

const videoUrl = '/media/partfolk-demo-74a88764.mp4';
const posterUrl = '/media/partfolk-demo-74a88764.jpg';

function DemoVideoDialog({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    return () => { video?.pause(); };
  }, []);

  return <Dialog open title={copy.demoTitle} closeLabel={copy.demoClose} onClose={onClose} className="pf-landing-demo-dialog">
    <video
      ref={videoRef}
      className="pf-landing-demo-video"
      src={videoUrl}
      poster={posterUrl}
      width={1920}
      height={1080}
      controls
      playsInline
      preload="none"
      aria-label={copy.demoTitle}
      onError={() => setFailed(true)}
    >{copy.demoUnsupported}</video>
    {failed && <p className="pf-landing-demo-error" role="status">{copy.demoLoadError}</p>}
    <Link className="pf-landing-demo-direct" href={videoUrl} target="_blank" rel="noopener noreferrer" aria-label={copy.demoOpenDirectLabel}>
      {copy.demoOpenDirect}<span aria-hidden="true">↗</span>
    </Link>
  </Dialog>;
}

export function DemoVideo() {
  const [open, setOpen] = useState(false);

  return <>
    <Button variant="quiet" className="pf-landing-demo-trigger" aria-haspopup="dialog" onClick={event => {
      event.currentTarget.focus({ preventScroll: true });
      setOpen(true);
    }}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 7.8 16.5 12 10 16.2Z" fill="currentColor" />
      </svg>
      {copy.watchDemo}
    </Button>
    {open && <DemoVideoDialog onClose={() => setOpen(false)} />}
  </>;
}
