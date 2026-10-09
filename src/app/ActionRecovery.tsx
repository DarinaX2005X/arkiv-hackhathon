import { useRef, useState } from 'react';
import { Button, Notice } from '../ui';
import type { useRepositoryAction } from './actions';

/** Repair only the saved request envelope. The original transaction is still reconciled. */
export function ActionRecovery({ action }: { action: Pick<ReturnType<typeof useRepositoryAction>, 'recoveryText' | 'restoreRecovery'> }) {
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (action.recoveryText === null) return null;
  const download = () => {
    const url = URL.createObjectURL(new Blob([action.recoveryText!], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'partfolk-original-request.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <div className="pf-stack pf-stack--compact"><p>This saved request could not be read. Keep the original file, then restore a readable backup. Its transaction will be checked before anything is sent.</p>
    <div className="pf-actions"><Button variant="secondary" onClick={download}>Save the original file</Button><Button variant="secondary" onClick={() => file.current?.click()}>Restore a request backup</Button></div>
    <input ref={file} className="pf-visually-hidden" type="file" accept="application/json,.json" aria-label="Saved request backup" onChange={async event => {
      const input = event.currentTarget, selected = input.files?.[0];
      if (!selected) return;
      if (selected.size > 1024 * 1024) { setMessage('Choose a request backup smaller than 1 MB.'); input.value = ''; return; }
      try { const result = action.restoreRecovery(await selected.text()); setMessage(result.ok ? 'Backup restored. Check the original request to continue.' : result.error.diagnostic ?? 'The backup could not be restored. The original file is still available.'); }
      catch { setMessage('The backup could not be read. The original file is still available.'); }
      finally { input.value = ''; }
    }} />
    {message && <Notice role="status">{message}</Notice>}
  </div>;
}
