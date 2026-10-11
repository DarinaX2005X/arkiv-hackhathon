import { useState } from 'react';
import { useApp } from '../../app/context';
import type { EntityKey, ProjectAggregate } from '../../domain/types';
import { Button, Notice } from '../../ui';
import { downloadText } from '../projects/drafts';
import { buildExecutionExports, packetFromProject } from './export';

export function ExecutionExports({ project, selectedProposalKey, id }: { project: ProjectAggregate; selectedProposalKey?: EntityKey; id?: string }) {
  const runtime = useApp();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  async function download(kind: 'json' | 'html', localSnapshot: boolean) {
    setBusy(true); setMessage(''); setFailed(false);
    try {
      let packet = packetFromProject(project, runtime.now());
      if (!localSnapshot) {
        if (!runtime.repository) throw new Error('The repository is unavailable. Export the last-known snapshot instead.');
        const result = await runtime.repository.exportPacket(project.root.key);
        if (!result.ok) throw new Error('A current export could not be read. Your last-known snapshot remains available below.');
        packet = result.value;
      }
      const file = buildExecutionExports(packet, selectedProposalKey)[kind];
      downloadText(file.filename, file.text, file.mime);
      setMessage('The download was requested. Check your browser’s downloads for the file.');
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : 'The download could not be prepared. No file was confirmed.'); }
    finally { setBusy(false); }
  }
  return <section id={id} tabIndex={-1} className="pf-sheet pf-stack execution-exports" aria-label="Export project records">
    <h3>Take a copy with you</h3><p>Export this exact version, its status, assignments and exceptions. The print sheet is a standalone HTML file; open it yourself to print.</p>
    <div className="pf-actions"><Button variant="secondary" disabled={busy} onClick={() => void download('json', false)}>Download JSON package</Button><Button variant="secondary" disabled={busy} onClick={() => void download('html', false)}>Download printable run sheet</Button><Button variant="quiet" disabled={busy} onClick={() => void download('json', true)}>Export last-known snapshot</Button></div>
    {message && <Notice role="status" tone={failed ? 'warning' : 'neutral'}>{message}</Notice>}
  </section>;
}
