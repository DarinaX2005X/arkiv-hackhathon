import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { partfolkHosting } from './local-hosting';

describe('local product HTTP routes without a browser', () => {
  let directory: string, origin: string, http: Server, vite: ViteDevServer;
  const upstream = vi.fn<typeof fetch>(async (_input, options) => {
    const body = JSON.parse(options!.body as string) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x7614d1' }));
  });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'partfolk-http-'));
    await Promise.all(['index', 'desk', '404'].map(name => writeFile(join(directory, `${name}.html`), `<!doctype html><html><body><h1>${name} fixture</h1></body></html>`)));
    await mkdir(join(directory, 'public', 'places'), { recursive: true });
    await writeFile(join(directory, 'public', 'places', 'sample.json'), '{"place":"fixture"}');
    vite = await createServer({ configFile: false, root: directory, appType: 'mpa', logLevel: 'silent',
      plugins: [partfolkHosting({ accessKey: () => 'unit-only-access-token', fetch: upstream })],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    http = createHttpServer(vite.middlewares);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No fixture server address.');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (http) { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }
    await vite?.close();
    if (directory) {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('partfolk-http-')) throw new Error('Unexpected cleanup root.');
      await rm(directory, { recursive: true, force: true });
    }
  });
  const read = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { redirect: 'manual', ...init });

  it.each(['/', '/events', '/projects/new', '/workspace', `/events/0x${'ab'.repeat(32)}`, `/projects/0x${'cd'.repeat(32)}/guests`])('serves Studio for the explicit route %s', async path => {
    const response = await read(path);
    expect(response.status).toBe(200); expect(await response.text()).toContain('index fixture');
  });
  it('serves the independent Desk at its clean path', async () => {
    const response = await read('/desk');
    expect(response.status).toBe(200); expect(await response.text()).toContain('desk fixture');
  });
  it.each([['/desk.html?from=invite', '/desk?from=invite'], ['/desk/', '/desk'], ['/index.html?from=home', '/?from=home']])('redirects the legacy URL %s without losing its query', async (path, destination) => {
    const response = await read(path!); expect(response.status).toBe(308); expect(response.headers.get('location')).toBe(destination);
  });
  it('moves unknown document paths to the dedicated error route without copying private queries', async () => {
    const response = await read('/unknown/invitation?private=do-not-reflect');
    expect(response.status).toBe(307); expect(response.headers.get('location')).toBe('/404');
  });
  it.each(['/404', '/404.html'])('returns a real error status with the authored document at %s', async path => {
    const response = await read(path); expect(response.status).toBe(404); expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('404 fixture');
  });
  it('supports HEAD without returning error-document bytes', async () => {
    const response = await read('/404', { method: 'HEAD' }); expect(response.status).toBe(404); expect(await response.text()).toBe('');
  });
  it.each(['/.local/arkiv-access-key.txt', '/%2elocal/arkiv-access-key.txt', '/@fs/C:/fixture/.local/key.txt', '/.vibemachina/STATE.md', '/.git/config', '/api/arkiv-read.mjs', '/assets/missing.js', '/api/missing'])('does not expose or redirect the missing/private path %s', async path => {
    const response = await read(path); expect(response.status).toBe(404); expect(response.headers.has('location')).toBe(false);
    expect(await response.text()).not.toContain('unit-only-access-token');
  });
  it('keeps ordinary public JSON available before the error fallback', async () => {
    const response = await read('/places/sample.json'); expect(response.status).toBe(200); expect(await response.json()).toEqual({ place: 'fixture' });
  });
  it('uses the bounded server-only read handler with a fixture upstream', async () => {
    const response = await read('/api/arkiv-read', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: '0x7614d1' });
    expect(upstream).toHaveBeenCalledOnce();
    expect(new Headers(upstream.mock.calls[0]![1]!.headers).get('X-API-KEY')).toBe('unit-only-access-token');
  });
  it('refuses foreign-origin reads before contacting the fixture upstream', async () => {
    const calls = upstream.mock.calls.length;
    const response = await read('/api/arkiv-read', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.invalid' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'eth_chainId', params: [] }) });
    expect(response.status).toBe(403); expect(upstream.mock.calls.length).toBe(calls);
  });
});
