import { addressAvatar } from './avatar';

export function AccountAvatar({ address, className = '' }: { address: string; className?: string }) {
  const pattern = addressAvatar(address);
  return <svg className={`pf-account-avatar ${className}`} viewBox="0 0 7 7" width="40" height="40" aria-hidden="true" focusable="false">
    <rect width="7" height="7" rx="1.65" fill="#D8EDB7" />
    {pattern.cells.map(cell => <rect key={`${cell.x}:${cell.y}`} x={cell.x + 1} y={cell.y + 1} width=".92" height=".92" rx=".18" fill={pattern.tone} />)}
  </svg>;
}
