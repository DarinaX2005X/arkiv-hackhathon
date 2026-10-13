import { isEntityKey, isPublicEntityKey } from '../../app/ids';
import { safeReturnPath } from '../../app/routes';
import type { EntityKey } from '../../domain/types';

/** Parse a shared project reference without visiting the pasted URL or treating it as authority. */
export function contributionProjectTarget(input: string, mode: 'local' | 'public'): EntityKey | null {
  if (input.length > 2048 || /[\u0000-\u001f]/.test(input)) return null;
  let value = input.trim();
  const eligible = (key: string): key is EntityKey => mode === 'public' ? isPublicEntityKey(key) : isEntityKey(key) && key.startsWith('local:');
  if (eligible(value)) return value;
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password) return null; value = url.hash || `${url.pathname}${url.search}`; }
    catch { return null; }
  }
  value = value.replace(/^#/, '');
  const [path, query, extra] = value.split('?');
  if (extra !== undefined || !path || /[\\#]/.test(path)) return null;
  const params = new URLSearchParams(query);
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return null;
  if (path === '/contributions') {
    if ([...params.keys()].some(key => !['projectRoot', 'returnTo'].includes(key)) || params.has('returnTo') && !safeReturnPath(params.get('returnTo'))) return null;
    const key = params.get('projectRoot'); return key && eligible(key) ? key : null;
  }
  if ([...params.keys()].some(key => !['activation', 'proposal', 'revision', 'hash'].includes(key)) || params.has('proposal') && params.has('revision')) return null;
  if (['activation', 'proposal', 'revision'].some(key => params.has(key) && !eligible(params.get(key)!)) || params.has('hash') && !isPublicEntityKey(params.get('hash'))) return null;
  let decoded: string; try { decoded = decodeURIComponent(path); } catch { return null; }
  const match = /^\/projects\/([^/]+)(?:\/(needs|plans|agreement|runbook|history))?$/.exec(decoded);
  return match && eligible(match[1]!) ? match[1]! : null;
}
