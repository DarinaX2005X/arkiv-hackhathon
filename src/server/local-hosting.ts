import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { parseRoute } from '../app/routes';
import { createArkivReadHandler } from './arkiv-read';
import type { ArkivReadHandlerOptions } from './arkiv-read';

interface LocalHostingOptions {
  deskOnly?: boolean;
  accessKey?: () => string | undefined;
  fetch?: ArkivReadHandlerOptions['fetch'];
}
type Next = (error?: unknown) => void;

/** Loopback development uses the same bounded read handler as the hosted app. */
async function handleRead(request: IncomingMessage, response: ServerResponse,
  handler: (request: Request) => Promise<Response>) {
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  request.once('aborted', abort); response.once('close', abort);
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    // The handler must use the actual loopback peer, never a client-supplied proxy header.
    headers.set('x-vercel-forwarded-for', request.socket.remoteAddress ?? 'unknown');
    const method = request.method ?? 'GET';
    const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
      init.duplex = 'half';
    }
    const result = await handler(new Request(new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`), init));
    if (response.destroyed) return;
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
  } catch {
    if (!response.destroyed && !response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32099,"message":"The local read service could not complete this request."}}');
    }
  } finally {
    request.removeListener('aborted', abort); response.removeListener('close', abort);
  }
}

/** HTTP aliases and real errors are verified without rendering or controlling a browser. */
export function partfolkHosting(options: LocalHostingOptions = {}): Plugin {
  const handler = createArkivReadHandler({ accessKey: options.accessKey ?? (() => undefined), fetch: options.fetch });
  function install(server: ViteDevServer | PreviewServer, preview: boolean) {
    const root = preview ? resolve(server.config.root, server.config.build.outDir) : server.config.root;
    const notFound = async (request: IncomingMessage, response: ServerResponse, next: Next) => {
      try {
        let html = await readFile(resolve(root, '404.html'), 'utf8');
        if (!preview) html = await (server as ViteDevServer).transformIndexHtml('/404.html', html);
        response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : html);
      } catch (error) { next(error); }
    };
    const plain404 = (response: ServerResponse) => {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('Not found');
    };
    const redirect = (response: ServerResponse, location: string, status = 308) => {
      response.writeHead(status, { Location: location, 'Cache-Control': 'no-store' }); response.end();
    };
    server.middlewares.use((request, response, next) => {
      let url: URL, pathname: string;
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); pathname = decodeURIComponent(url.pathname); }
      catch { plain404(response); return; }
      if ((!pathname.startsWith('/node_modules/.vite/') && /(?:^|\/)\.(?!well-known(?:\/|$))/.test(pathname))
        || /(?:^|\/)(?:vercel\.json|vibemachina\.checkpoint\.json)(?:\/|$)/.test(pathname)
        || /^\/api\/.*\.(?:ts|js|mjs)(?:\/|$)/.test(pathname)) { plain404(response); return; }
      if (pathname === '/api/arkiv-read') { void handleRead(request, response, handler); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { next(); return; }
      if (pathname === '/desk.html' || pathname === '/desk/') { redirect(response, `/desk${url.search}`); return; }
      if (pathname === '/index.html') { redirect(response, `/${url.search}`); return; }
      if (pathname === '/404' || pathname === '/404.html') { void notFound(request, response, next); return; }
      if (pathname === '/desk' || (options.deskOnly && pathname === '/')) { request.url = `/desk.html${url.search}`; next(); return; }
      if (!options.deskOnly && parseRoute(`${pathname}${url.search}`).name !== 'not-found') {
        request.url = `/index.html${url.search}`;
      }
      next();
    });
    // With appType:'mpa', only real assets and the explicit aliases above can reach HTML.
    return () => server.middlewares.use((request, response, next) => {
      const pathname = (request.url ?? '/').split('?')[0] ?? '/';
      if (pathname === '/index.html' || pathname === '/desk.html') { next(); return; }
      if ((request.method === 'GET' || request.method === 'HEAD')
        && !pathname.startsWith('/api/') && !extname(pathname)) { redirect(response, '/404', 307); return; }
      plain404(response);
    });
  }
  return {
    name: 'partfolk-http-hosting',
    configureServer: server => install(server, false),
    configurePreviewServer: server => install(server, true),
  };
}
