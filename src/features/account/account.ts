import type { AppRuntime } from '../../app/context';
import { isAccountAddress } from '../../app/ids';
import { parseRoute, routePath, safeReturnPath, type Route } from '../../app/routes';
import type { LoadResult, StorageIssue } from '../../app/storage';

export interface AccountPreferences {
  label: string;
  defaultDestination: 'workspace' | 'contributions' | 'my-events';
  setupComplete: boolean;
}
export const defaultAccountPreferences: AccountPreferences = { label: '', defaultDestination: 'workspace', setupComplete: false };
export function isAccountPreferences(value: unknown): value is AccountPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') === 'defaultDestination,label,setupComplete'
    && typeof item.label === 'string' && item.label.length <= 80 && !/[\u0000-\u001f]/.test(item.label)
    && typeof item.defaultDestination === 'string' && ['workspace', 'contributions', 'my-events'].includes(item.defaultDestination) && typeof item.setupComplete === 'boolean';
}
/** Device preferences are never a public identity record or signing authority. */
export function createAccountPreferences(runtime: AppRuntime, address: string) {
  if (!isAccountAddress(address)) throw new TypeError('A valid wallet address is required.');
  return runtime.drafts(`account-${address.toLowerCase()}`, 'account-preferences', isAccountPreferences);
}
export function readAccountPreferences(result: LoadResult<AccountPreferences>): { value: AccountPreferences; issue: StorageIssue | null } {
  return { value: result.status === 'ready' ? result.value : { ...defaultAccountPreferences },
    issue: result.status === 'recovery' || result.status === 'unavailable' ? result.issue : null };
}
export function accountReturnRoute(returnTo: string | undefined, preferences = defaultAccountPreferences): Route {
  return parseRoute(safeReturnPath(returnTo) ?? routePath({ name: preferences.defaultDestination }));
}
/** Help/account detours retain the user's original work destination. */
export function workDestination(route: Route): string | undefined {
  if (['help', 'sign-in', 'account', 'onboarding'].includes(route.name) && 'returnTo' in route && route.returnTo) return safeReturnPath(route.returnTo);
  return safeReturnPath(routePath(route));
}
