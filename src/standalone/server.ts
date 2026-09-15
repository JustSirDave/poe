// cspell:ignore nosniff
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { CoachService } from './service';
import { ReviewStore } from './reviews';

function respond(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer; size += bytes.length;
    if (size > 4096) throw new Error('Request too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startDashboard(service: CoachService): Promise<{ url: string; close: () => Promise<void> }> {
  const reviews = new ReviewStore(service.config.stateDir);
  await reviews.load();
  let origin = '';
  const server = createServer((req, res) => { void handle(req, res).catch(() => respond(res, 400, { error: 'Request failed' })); });
  server.requestTimeout = 10000;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (`http://${req.headers.host || ''}` !== origin || (req.headers.origin && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') { respond(res, 403, { error: 'Local same-origin requests only' }); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const route = new URL(req.url || '/', origin).pathname;
    if (req.method === 'GET' && route === '/api/report') {
      respond(res, 200, { report: service.report, error: service.error, history: reviews.history(), config: {
        lookbackDays: service.config.lookbackDays, refreshSeconds: service.config.refreshSeconds, includeExcerpts: service.config.includeExcerpts,
      } }); return;
    }
    if (req.method === 'POST' && req.headers['content-type'] === 'application/json' && route === '/api/refresh') {
      void service.refresh().catch(() => {}); respond(res, 202, { ok: true }); return;
    }
    if (req.method === 'POST' && req.headers['content-type'] === 'application/json' && route === '/api/review') {
      const input = z.object({ id: z.string().regex(/^[a-f0-9]{20}$/), action: z.enum(['dismissed', 'reopened']) }).strict().parse(await readBody(req));
      if (!service.report?.findings.some(f => f.id === input.id) && !reviews.history().some(e => e.id === input.id)) { respond(res, 404, { error: 'Unknown finding' }); return; }
      await reviews.record({ ...input, at: new Date().toISOString() }); respond(res, 200, { ok: true }); return;
    }
    const assets: Record<string, [string, string]> = { '/': ['dashboard.html', 'text/html'], '/dashboard.js': ['dashboard.js', 'application/javascript'], '/dashboard.css': ['dashboard.css', 'text/css'] };
    if (req.method === 'GET' && Object.hasOwn(assets, route)) {
      const [file, type] = assets[route];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(await fs.readFile(path.join(__dirname, 'standalone', file))); return;
    }
    respond(res, 404, { error: 'Not found' });
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(service.config.port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start dashboard');
  origin = `http://127.0.0.1:${address.port}`;
  void service.refresh().catch(() => {});
  const timer = setInterval(() => { void service.refresh().catch(() => {}); }, service.config.refreshSeconds * 1000);
  return { url: origin, close: async () => {
    clearInterval(timer); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await service.close();
  } };
}
