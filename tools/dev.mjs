#!/usr/bin/env node
/* Dev server không cần Cloudflare: serve public/ và chạy ĐÚNG mã functions/ (middleware +
 * /api/chat) trên Node ≥ 20. Biến môi trường đọc từ .dev.vars (cùng file wrangler dùng).
 *
 *   node tools/dev.mjs            → http://localhost:8788  (mật khẩu: SITE_PASSWORD trong .dev.vars)
 *   PORT=3000 node tools/dev.mjs
 *
 * Muốn giả lập Cloudflare sát hơn thì dùng `npx wrangler pages dev`.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import * as middleware from '../functions/_middleware.js';
import * as chat from '../functions/api/chat.js';
import * as kho from '../functions/api/kho.js';
import * as depts from '../functions/api/depts.js';
import * as adminConfig from '../functions/api/admin/config.js';
import * as adminTest from '../functions/api/admin/test.js';
import * as adminAiTest from '../functions/api/admin/ai-test.js';
import * as adminSecrets from '../functions/api/admin/secrets.js';
import * as adminStats from '../functions/api/admin/stats.js';
import * as feedback from '../functions/api/feedback.js';
import * as adminDocs from '../functions/api/admin/docs.js';
import { fakeD1 } from './fake-d1.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

function loadVars() {
  const env = {};
  const f = join(root, '.dev.vars');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
    }
  }
  for (const k of ['SITE_PASSWORD', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'ADMIN_PASSWORD', 'GOOGLE_SA_KEY', 'SHAREPOINT_CLIENT_SECRET']) if (process.env[k]) env[k] = process.env[k];
  if (!env.ADMIN_PASSWORD) { env.ADMIN_PASSWORD = 'admin-dev-123'; console.log('· ADMIN_PASSWORD chưa đặt → dùng "admin-dev-123"'); }
  // KV giả lập trong RAM (Cloudflare thật: binding CONFIG gắn ở dashboard)
  const store = new Map();
  env.CONFIG = { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
  // D1 giả (SQLite trong RAM) — thống kê câu hỏi chạy được khi dev
  if (!env.DB) env.DB = fakeD1() || undefined;
  if (!env.SITE_PASSWORD) { env.SITE_PASSWORD = 'dev'; console.log('· SITE_PASSWORD chưa đặt → dùng "dev"'); }
  return env;
}
const env = loadVars();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function staticFile(url) {
  let p = decodeURIComponent(new URL(url).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(pub, p));
  if (!file.startsWith(pub)) return new Response('Forbidden', { status: 403 });
  try {
    return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

// Bảng route giống cách Cloudflare Pages ánh xạ functions/ → URL.
const ROUTES = {
  '/api/chat': { POST: chat.onRequestPost },
  '/api/kho': { GET: kho.onRequestGet },
  '/api/depts': { GET: depts.onRequestGet },
  '/api/admin/config': { GET: adminConfig.onRequestGet, PUT: adminConfig.onRequestPut },
  '/api/admin/test': { POST: adminTest.onRequestPost },
  '/api/admin/ai-test': { POST: adminAiTest.onRequestPost },
  '/api/admin/secrets': { PUT: adminSecrets.onRequestPut },
  '/api/admin/stats': { GET: adminStats.onRequestGet, DELETE: adminStats.onRequestDelete },
  '/api/feedback': { POST: feedback.onRequestPost },
  '/api/admin/docs': { GET: adminDocs.onRequestGet, PUT: adminDocs.onRequestPut, DELETE: adminDocs.onRequestDelete },
};

async function route(request) {
  const { pathname } = new URL(request.url);
  const r = ROUTES[pathname];
  if (r) {
    const fn = r[request.method];
    if (!fn) return new Response('Method not allowed', { status: 405 });
    return fn({ request, env, waitUntil: () => {} });
  }
  if (pathname === '/admin') return Response.redirect(new URL('/admin/', request.url), 301);
  return staticFile(request.url);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host}${req.url}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, {
      method: req.method, headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined,
    });
    const resp = await middleware.onRequest({ request, env, next: () => route(request) });
    res.writeHead(resp.status, Object.fromEntries(resp.headers));
    if (resp.body) for await (const chunk of resp.body) res.write(chunk);
    res.end();
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('Lỗi dev server');
  }
});
const port = Number(process.env.PORT || 8788);
server.listen(port, () => {
  console.log(`dept-chat → http://localhost:${port}  (chế độ ${env.ANTHROPIC_API_KEY ? 'AI' : 'FAQ, chưa có ANTHROPIC_API_KEY'})`);
});
