import { useState, type ReactNode } from 'react';
import type { RouteViewProps } from '../../app/App';
import { routeHref } from '../../app/routes';
import { Button, Dialog, Link, Notice } from '../../ui';
import { ProjectPage, type ProjectSlots } from './ProjectPage';
import { SMALL_WORKS_PROJECT_ROOT } from '../../domain/fixtures';

/** MAIN supplies the isolated practice runtime and synthetic role controller. */
export function DemoRoute({ controls, onReset, ...slots }: RouteViewProps & ProjectSlots & { controls?: ReactNode; onReset?: () => Promise<void> }) {
  const [resetOpen, setResetOpen] = useState(false), [resetting, setResetting] = useState(false), [generation, setGeneration] = useState(0), [error, setError] = useState<string | null>(null);
  return <div className="pf-stack"><header><h1>Try a community exhibition</h1><p>Small Works has two possible dates. Find what is missing, offer the missing help as its owner, and ask everyone to agree to one complete plan.</p></header>
    <Notice title="The pieces are real inputs to the planner">The display boards and installation kit are already at the venue. The driver brings artworks while two people install the displays. A person cannot do both jobs at the same time.</Notice>
    {controls}
    <div className="pf-actions"><Link href={routeHref({ name: 'contributions' })}>Offer a contribution as the selected practice role</Link><Link href={routeHref({ name: 'new-project' })}>Start my own project</Link>{onReset && <Button variant="quiet" onClick={() => setResetOpen(true)}>Reset the practice</Button>}</div>
    {error && <Notice tone="warning">{error}</Notice>}
    <ProjectPage key={generation} projectRoot={SMALL_WORKS_PROJECT_ROOT} tab="plans" practice {...slots} />
    <Dialog open={resetOpen} title="Reset this practice?" closeLabel="Keep this practice" onClose={() => setResetOpen(false)} footer={<Button disabled={resetting} onClick={async () => {
      if (!onReset) return; setResetting(true);
      try { await onReset(); setGeneration(value => value + 1); setResetOpen(false); setError(null); }
      catch { setError('The practice could not be reset. Your other projects have not been changed by this page.'); }
      finally { setResetting(false); }
    }}>Reset practice offers and decisions</Button>}><p>This resets the synthetic practice, including its local offers, decisions and progress. Your own projects use a separate workspace.</p></Dialog>
  </div>;
}
