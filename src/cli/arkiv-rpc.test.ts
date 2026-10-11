import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFICIAL_RPC } from '../data/arkiv/client';
import { repositoryError } from '../data/arkiv/errors';
import { KEYS, NOW, threeProposalFixture } from '../data/__tests__/arkiv-fixture';
import { ACCESS_KEY_FILE_ENV, createOperatorRpc } from './arkiv-rpc';
import { runCli } from './verify';

const SYNTHETIC_KEY = 'synthetic-test-access-token';
const directories: string[] = [];
function directory() { const path = mkdtempSync(resolve(tmpdir(), 'partfolk-rpc-test-')); directories.push(path); return path; }
function keyFile(contents = SYNTHETIC_KEY) {
  const path = resolve(directory(), 'access-key.txt'); writeFileSync(path, contents); return path;
}
const success = (id = 1) => Response.json({ jsonrpc: '2.0', id, result: '0x7614d1' });

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const path of directories.splice(0)) {
    if (!path.startsWith(resolve(tmpdir(), 'partfolk-rpc-test-'))) throw new Error('Unexpected test directory');
    rmSync(path, { recursive: true, force: true });
  }
});

describe('Node operator access-key boundary', () => {
  it('sends the key only in a header to the fixed endpoint, with no redirects, cache or credentials', async () => {
    const path = keyFile(`  ${SYNTHETIC_KEY}\r\n`);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success()); vi.stubGlobal('fetch', fetch);
    const transport = createOperatorRpc({ accessKeyFile: path });
    expect(await transport.request({ method: 'eth_chainId' })).toBe('0x7614d1');
    expect(transport.accessKeyFile).toBe(path);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe(OFFICIAL_RPC);
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { 'content-type': 'application/json', 'X-API-KEY': SYNTHETIC_KEY } });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options!.body as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    expect(String(url) + options!.body + JSON.stringify(transport)).not.toContain(SYNTHETIC_KEY);
  });

  it('stays anonymous without explicit configuration and when the optional local file is absent', async () => {
    vi.stubEnv(ACCESS_KEY_FILE_ENV, keyFile());
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success()); vi.stubGlobal('fetch', fetch);
    for (const transport of [createOperatorRpc(), createOperatorRpc({ autoDetectDirectory: directory() })]) {
      expect(transport.accessKeyFile).toBeNull(); await transport.request({ method: 'eth_chainId' });
    }
    expect(fetch.mock.calls.every(([, options]) => !Object.hasOwn(options!.headers!, 'X-API-KEY'))).toBe(true);
  });

  it('discovers the repository-local file only when the operator opts in', async () => {
    const root = directory(); mkdirSync(resolve(root, '.local'));
    const path = resolve(root, '.local/arkiv-access-key.txt'); writeFileSync(path, SYNTHETIC_KEY);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success()); vi.stubGlobal('fetch', fetch);
    const transport = createOperatorRpc({ autoDetectDirectory: root });
    expect(transport.accessKeyFile).toBe(path); await transport.request({ method: 'eth_chainId' });
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ 'X-API-KEY': SYNTHETIC_KEY });
  });

  it.each(['', ' \r\n', `${SYNTHETIC_KEY}\nInjected: value`, `${SYNTHETIC_KEY}\rvalue`, `${SYNTHETIC_KEY}\0`, 'two tokens', 'x'.repeat(1025)])
    ('rejects an invalid key file before any HTTP request (case %#)', contents => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
      const path = keyFile(contents);
      let failure: unknown;
      try { createOperatorRpc({ accessKeyFile: path }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toBe('OperatorRpcError: ARKIV_ACCESS_KEY_FILE_INVALID');
      expect(JSON.stringify(failure)).not.toContain(SYNTHETIC_KEY);
      expect(fetch).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(contents);
    });

  it('rejects an explicitly missing/empty path and an existing empty autodetected file', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => createOperatorRpc({ accessKeyFile: resolve(directory(), 'missing') })).toThrow('ARKIV_ACCESS_KEY_FILE_INVALID');
    expect(() => createOperatorRpc({ accessKeyFile: '' })).toThrow('ARKIV_ACCESS_KEY_FILE_INVALID');
    const root = directory(); mkdirSync(resolve(root, '.local')); writeFileSync(resolve(root, '.local/arkiv-access-key.txt'), '');
    expect(() => createOperatorRpc({ autoDetectDirectory: root })).toThrow('ARKIV_ACCESS_KEY_FILE_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([429, 401, 307])('does not retry or retain HTTP %i response content', async status => {
    const response = new Response(SYNTHETIC_KEY, { status, headers: { location: 'https://invalid.example/' } });
    const parse = vi.spyOn(response, 'json');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response); vi.stubGlobal('fetch', fetch);
    const transport = createOperatorRpc({ accessKeyFile: keyFile() });
    const error = await transport.request({ method: 'arkiv_query', params: [] }).catch(error => error);
    expect(error).toMatchObject({ message: 'ARKIV_OPERATOR_RPC_FAILED', status });
    expect(String(error) + JSON.stringify(error) + JSON.stringify(repositoryError(error))).not.toContain(SYNTHETIC_KEY);
    expect(fetch).toHaveBeenCalledTimes(1); expect(parse).not.toHaveBeenCalled();
    if (status === 429) expect(repositoryError(error).code).toBe('rate_limited');
  });

  it('discards thrown transport details and JSON-RPC message/data while retaining numeric classification', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error(`header ${SYNTHETIC_KEY}`))
      .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 2, error: { code: -32006, message: SYNTHETIC_KEY, data: SYNTHETIC_KEY } }));
    vi.stubGlobal('fetch', fetch); const transport = createOperatorRpc({ accessKeyFile: keyFile() });
    for (let index = 0; index < 2; index++) {
      const error = await transport.request({ method: 'arkiv_query' }).catch(error => error);
      expect(String(error) + JSON.stringify(error)).not.toContain(SYNTHETIC_KEY);
      expect(error).not.toHaveProperty('cause');
      if (index === 1) expect(repositoryError(error).reasons[0]?.code).toBe('incomplete_snapshot');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ jsonrpc: '2.0', id: 999, result: 'bad' }, { jsonrpc: '2.0', id: 1 }, null])
    ('rejects malformed or mismatched RPC envelopes (case %#)', async body => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body)); vi.stubGlobal('fetch', fetch);
      await expect(createOperatorRpc().request({ method: 'eth_chainId' })).rejects.toThrow('ARKIV_OPERATOR_RPC_FAILED');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

  it('uses the explicit filename environment contract for the independent verifier without exposing it in the packet', async () => {
    const { rpc } = threeProposalFixture(); vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubEnv(ACCESS_KEY_FILE_ENV, keyFile());
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: await rpc.request(request) });
    });
    vi.stubGlobal('fetch', fetch); const output: string[] = [];
    expect(await runCli([KEYS.project, '--json', '--block', '100'], text => output.push(text))).toBe(0);
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.every(([url, options]) => url === OFFICIAL_RPC
      && (options!.headers as Record<string, string>)['X-API-KEY'] === SYNTHETIC_KEY)).toBe(true);
    expect(output.join('\n')).not.toContain(SYNTHETIC_KEY);
    expect(output.join('\n')).not.toContain(process.env[ACCESS_KEY_FILE_ENV]);
    expect(JSON.parse(output[0]!).snapshot.blockNumber).toBe('100');
  });

  it('reports invalid verifier configuration without leaking file contents or making a request', async () => {
    vi.stubEnv(ACCESS_KEY_FILE_ENV, keyFile(`${SYNTHETIC_KEY}\nInjected: value`));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const output: string[] = [];
    expect(await runCli([KEYS.project, '--json'], text => output.push(text))).toBe(1);
    expect(output.join('\n')).not.toContain(SYNTHETIC_KEY); expect(fetch).not.toHaveBeenCalled();
  });
});
