import { describe, expect, it, vi } from 'vitest';
import { createArkivRepository } from '../../src/data/arkiv';
import { KEYS, NOW, readyFixture } from '../../src/data/__tests__/arkiv-fixture';
import { deriveReadiness } from '../../src/domain/readiness';
import { createProjectReader } from '../../src/features/projects/projectReader';
import { READ_RATE_LIMIT_COOLDOWN_MS } from '../../src/data/arkiv/read-policy';

describe('public query failures through the repository and current-view controller', () => {
  it('invalidates a previously Ready snapshot immediately on RPC 429 and restores it only after a complete new read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const { rpc } = readyFixture();
    const repository = createArkivRepository({ request: rpc.request, now: Date.now });
    const reader = createProjectReader(signal => repository.loadProject(KEYS.project, { signal }), Date.now);
    try {
      reader.start(false); await reader.refresh();
      const original = reader.getSnapshot().project!;
      expect(deriveReadiness(original, NOW).status).toBe('ready');
      rpc.queryOverride = () => { throw Object.assign(new Error('Rate limited by the fixture'), { status: 429 }); };
      await reader.refresh();
      const failed = reader.getSnapshot();
      expect(failed.error).toMatchObject({ code: 'rate_limited', retryable: true, reasons: [{ code: 'rpc_error' }] });
      expect(failed.project?.root).toEqual(original.root);
      expect(failed.project?.proposal).toEqual(original.proposal);
      expect(failed.project?.snapshot).toMatchObject({ completeness: 'incomplete', freshness: 'stale', reasons: [{ code: 'rpc_error' }] });
      expect(deriveReadiness(failed.project!, NOW).status).toBe('unverified');
      rpc.queryOverride = undefined;
      const requests = rpc.calls.length;
      await reader.refresh();
      expect(rpc.calls).toHaveLength(requests);
      expect(reader.getSnapshot().error?.code).toBe('rate_limited');
      expect(reader.getSnapshot().project?.snapshot.freshness).toBe('stale');
      vi.setSystemTime(NOW + READ_RATE_LIMIT_COOLDOWN_MS + 1);
      await reader.refresh();
      expect(reader.getSnapshot().error).toBeNull();
      expect(reader.getSnapshot().project?.snapshot).toMatchObject({ completeness: 'complete', freshness: 'fresh' });
      expect(deriveReadiness(reader.getSnapshot().project!, Date.now()).status).toBe('ready');
    } finally { reader.stop(); vi.useRealTimers(); }
  });

  it('refuses an unavailable historical block without falling back to a different snapshot', async () => {
    const { rpc } = readyFixture();
    const repository = createArkivRepository({ request: rpc.request, now: () => NOW });
    const initial = await repository.loadProject(KEYS.project);
    if (!initial.ok) throw new Error(initial.error.code);
    const start = rpc.calls.length;
    rpc.queryOverride = () => { throw Object.assign(new Error('Historical block unavailable'), { code: -32006 }); };
    const result = await repository.loadProject(KEYS.project, { snapshot: initial.value.snapshot });
    expect(result).toMatchObject({ ok: false, error: { code: 'unverified', retryable: false, reasons: [{ code: 'incomplete_snapshot' }] } });
    const calls = rpc.calls.slice(start);
    expect(calls.some(call => call.method === 'eth_blockNumber')).toBe(false);
    expect(calls.filter(call => call.method === 'arkiv_query')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'arkiv_query').every(call =>
      (call.params as [string, { atBlock: string }])[1].atBlock === '0x64')).toBe(true);
  });
});
