import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSharePointUrl } from '../functions/_sharepoint.js';
import { validateConfig, loadConfig, _resetConfigCache } from '../functions/_config.js';
import { buildFolder, _resetLiveKho } from '../functions/_kho-live.js';
import { hydrate, slugify } from '../public/shared/dept-model.js';
import * as cfgApi from '../functions/api/admin/config.js';
import * as testApi from '../functions/api/admin/test.js';
import * as secretsApi from '../functions/api/admin/secrets.js';
import * as aiTestApi from '../functions/api/admin/ai-test.js';
import { withSecrets } from '../functions/_config.js';

beforeEach(() => { _resetConfigCache(); _resetLiveKho(); });

// KV giả: đúng giao diện get(key,'json') / put(key, value) của Cloudflare KV
const fakeKV = () => { const m = new Map(); return { get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); } }; };
const ADMIN = 'mat-khau-admin-123';
const req = (method, path, body, key = ADMIN) => new Request('http://x' + path, {
  method, headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) }, body: body && JSON.stringify(body),
});

test('parseSharePointUrl: link AllItems.aspx?id=… (đúng dạng link thật)', () => {
  const link = 'https://kstnsvn.sharepoint.com/sites/portal/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2Fportal%2FShared%20Documents%2F01%5FKEYSTONE%20Info&viewid=e8f2';
  assert.deepEqual(parseSharePointUrl(link), { host: 'kstnsvn.sharepoint.com', sitePath: '/sites/portal', library: 'Shared Documents', folderPath: '01_KEYSTONE Info' });
  assert.deepEqual(parseSharePointUrl('https://a.sharepoint.com/sites/hr/Shared%20Documents/Quy%20che/Nghi%20phep'),
    { host: 'a.sharepoint.com', sitePath: '/sites/hr', library: 'Shared Documents', folderPath: 'Quy che/Nghi phep' });
  assert.equal(parseSharePointUrl('https://drive.google.com/drive/folders/x'), null);
});

test('validateConfig: phòng ban động — thêm, trùng tên, link sai, SharePoint cần ID', () => {
  const ok = validateConfig({ depts: [{ name: 'Kế toán', id: 'ketoan', folder: '' }, { name: 'Chăm sóc khách hàng', folder: 'https://drive.google.com/drive/folders/1pwLp5McpL8K7yqGJEA6TaWBI2CbGuRUE' }] });
  assert.deepEqual(ok.cfg.depts.map((d) => d.id), ['ketoan', 'cham-soc-khach-hang']);
  assert.deepEqual(validateConfig({ depts: [{ name: 'A' }, { name: 'A' }] }).cfg.depts.map((d) => d.id), ['a', 'a-2']);
  assert.match(validateConfig({ depts: [] }).error, /ít nhất 1/);
  assert.match(validateConfig({ depts: Array.from({ length: 9 }, (_, i) => ({ name: 'P' + i })) }).error, /Tối đa 8/);
  assert.match(validateConfig({ depts: [{ name: '' }] }).error, /chưa có tên/);
  assert.match(validateConfig({ depts: [{ name: 'X', folder: 'https://google.com' }] }).error, /không phải thư mục/);
  assert.match(validateConfig({ depts: [{ name: 'X', folder: 'https://a.sharepoint.com/sites/x/Shared%20Documents' }] }).error, /Tenant ID/);
});

test('hydrate: phòng mới tự có màu, trợ lý, phạm vi; phòng mặc định giữ FAQ mẫu', () => {
  const [kt, moi] = hydrate([{ id: 'ketoan', name: 'Kế toán' }, { id: 'cskh', name: 'CSKH' }]);
  assert.ok(kt.faq.length > 0);
  assert.equal(moi.bot, 'Trợ lý CSKH');
  assert.match(moi.color, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(moi.faq, []);
  assert.equal(slugify('Phòng Đào tạo'), 'phong-dao-tao');
  assert.equal(hydrate(null).length, 3);
});

test('admin API: tắt khi chưa có ADMIN_PASSWORD, sai mật khẩu → 401', async () => {
  assert.equal((await cfgApi.onRequestGet({ request: req('GET', '/api/admin/config'), env: {} })).status, 503);
  assert.equal((await cfgApi.onRequestGet({ request: req('GET', '/api/admin/config', null, 'sai'), env: { ADMIN_PASSWORD: ADMIN } })).status, 401);
});

test('admin API: lưu cấu hình vào KV, đọc lại được, không lộ secret', async () => {
  const env = { ADMIN_PASSWORD: ADMIN, CONFIG: fakeKV(), GOOGLE_SA_KEY: JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'BI-MAT' }) };
  const put = await cfgApi.onRequestPut({ request: req('PUT', '/api/admin/config', { depts: [{ name: 'Kế toán', id: 'ketoan', folder: 'https://drive.google.com/drive/folders/1pwLp5McpL8K7yqGJEA6TaWBI2CbGuRUE' }, { name: 'Pháp chế' }], ttl: 300 }), env });
  assert.equal(put.status, 200);
  _resetConfigCache();
  const saved = await loadConfig(env);
  assert.equal(saved.ttl, 300);
  assert.deepEqual(saved.depts.map((d) => d.id), ['ketoan', 'phap-che']);
  const get = await cfgApi.onRequestGet({ request: req('GET', '/api/admin/config'), env, waitUntil: () => {} });
  const text = await get.text();
  const j = JSON.parse(text);
  assert.equal(j.depts[1].name, 'Pháp chế');
  assert.deepEqual(j.secrets.GOOGLE_SA_KEY, { set: true, source: 'cloudflare', hint: 'bot@p.iam.gserviceaccount.com' });
  assert.equal(j.secrets.ANTHROPIC_API_KEY.set, false);
  assert.ok(!text.includes('BI-MAT'));                                           // khoá bí mật không bao giờ ra trình duyệt
});

test('admin API: chưa gắn KV → không lưu được, báo rõ', async () => {
  const r = await cfgApi.onRequestPut({ request: req('PUT', '/api/admin/config', { depts: [{ name: 'A' }] }), env: { ADMIN_PASSWORD: ADMIN } });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /KV/);
});

test('admin test: kiểm tra TỪNG link — thiếu secret / link sai báo rõ', async () => {
  const t = (body) => testApi.onRequestPost({ request: req('POST', '/api/admin/test', body), env: { ADMIN_PASSWORD: ADMIN } }).then((r) => r.json());
  assert.match((await t({ folder: 'https://drive.google.com/drive/folders/1pwLp5McpL8K7yqGJEA6TaWBI2CbGuRUE' })).error, /GOOGLE_SA_KEY/);
  assert.match((await t({ folder: 'abc' })).error, /không phải thư mục/);
  assert.match((await t({ folder: '' })).error, /Chưa có link/);
});

test('SharePoint: đăng nhập app → tìm site/thư viện/thư mục → đọc cả cây', async () => {
  const DOCX = readFileSync(new URL('./fixtures/lam-viec-tu-xa.docx', import.meta.url));
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    if (u.host === 'login.microsoftonline.com') {
      const b = new URLSearchParams(init.body);
      assert.equal(b.get('grant_type'), 'client_credentials');
      assert.equal(b.get('client_secret'), 'SP-SECRET');
      return new Response(JSON.stringify({ access_token: 'GT', expires_in: 3600 }));
    }
    assert.equal(init.headers.authorization, 'Bearer GT');
    const p = decodeURIComponent(u.pathname);
    if (p === '/v1.0/sites/kstnsvn.sharepoint.com:/sites/portal') return new Response(JSON.stringify({ id: 'SITE1', displayName: 'Portal' }));
    if (p === '/v1.0/sites/SITE1/drives') return new Response(JSON.stringify({ value: [{ id: 'DRV', name: 'Documents', webUrl: 'https://kstnsvn.sharepoint.com/sites/portal/Shared%20Documents' }] }));
    if (p === '/v1.0/drives/DRV/root:/01_KEYSTONE Info') return new Response(JSON.stringify({ id: 'ROOT' }));
    if (p === '/v1.0/drives/DRV/items/ROOT/children') return new Response(JSON.stringify({ value: [
      { id: 'F1', name: 'Nhân sự', folder: {} },
      { id: 'T1', name: 'gioi-thieu.txt', size: 40, file: { mimeType: 'text/plain' }, webUrl: 'https://kstnsvn.sharepoint.com/x/gioi-thieu.txt' },
      { id: 'P1', name: 'so-tay.pdf', size: 99, file: { mimeType: 'application/pdf' } },
    ] }));
    if (p === '/v1.0/drives/DRV/items/F1/children') return new Response(JSON.stringify({ value: [{ id: 'D1', name: 'lam-viec-tu-xa.docx', size: DOCX.length, file: { mimeType: 'x' } }] }));
    if (p === '/v1.0/drives/DRV/items/T1/content') return new Response('Keystone thành lập năm 2015.');
    if (p === '/v1.0/drives/DRV/items/D1/content') return new Response(DOCX);
    throw new Error('URL lạ: ' + p);
  };
  const cfg = { tenantId: '16801353-95d6-40e7-b136-2c5795855d31', clientId: '07c030f6-5743-41b7-ba00-0a6e85f37c17', ttl: 600 };
  const folder = 'https://kstnsvn.sharepoint.com/sites/portal/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2Fportal%2FShared%20Documents%2F01%5FKEYSTONE%20Info';
  const { chunks, status } = await buildFolder(folder, cfg, { SHAREPOINT_CLIENT_SECRET: 'SP-SECRET' }, f);
  assert.equal(status.source, 'sharepoint');
  assert.equal(status.files, 2);
  assert.ok(chunks.some((c) => c.source === 'Nhân sự/lam-viec-tu-xa.docx' && /tối đa 2 ngày/.test(c.text)));
  assert.ok(chunks.some((c) => c.source === 'gioi-thieu.txt'));
  assert.ok(chunks.some((c) => c.source === 'gioi-thieu.txt' && c.url === 'https://kstnsvn.sharepoint.com/x/gioi-thieu.txt'));
  assert.equal(status.skipped[0].file, 'so-tay.pdf');
});

test('admin khoá: nhập trên web → dùng được, thắng secret Cloudflare, không bao giờ trả giá trị', async () => {
  const env = { ADMIN_PASSWORD: ADMIN, CONFIG: fakeKV(), ANTHROPIC_API_KEY: 'sk-ant-cu-tu-cloudflare-000000000000' };
  const put = (name, value, key) => secretsApi.onRequestPut({ request: req('PUT', '/api/admin/secrets', { name, value }, key), env });
  assert.equal((await put('ANTHROPIC_API_KEY', 'sk-ant-x', 'sai')).status, 401);
  assert.match((await (await put('ANTHROPIC_API_KEY', 'abc')).json()).error, /sk-ant-/);
  assert.match((await (await put('GOOGLE_SA_KEY', '{"a":1}')).json()).error, /service account/);
  assert.match((await (await put('LA', 'x')).json()).error, /không hợp lệ/);

  const sa = JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'PK-BI-MAT' });
  const r1 = await put('GOOGLE_SA_KEY', '  ' + sa + '\n');
  const t1 = await r1.text();
  assert.equal(r1.status, 200);
  assert.ok(!t1.includes('PK-BI-MAT'));
  assert.deepEqual(JSON.parse(t1).secrets.GOOGLE_SA_KEY, { set: true, source: 'admin', hint: 'bot@p.iam.gserviceaccount.com' });
  await put('ANTHROPIC_API_KEY', 'sk-ant-moi-tu-admin-1234567890abcd');

  _resetConfigCache();
  const e = await withSecrets(env);
  assert.equal(e.ANTHROPIC_API_KEY, 'sk-ant-moi-tu-admin-1234567890abcd');   // admin thắng Cloudflare
  assert.equal(JSON.parse(e.GOOGLE_SA_KEY).private_key, 'PK-BI-MAT');
  assert.equal(e.CONFIG, env.CONFIG);                                          // binding vẫn còn

  const g = await (await cfgApi.onRequestGet({ request: req('GET', '/api/admin/config'), env })).text();
  assert.ok(!g.includes('PK-BI-MAT') && !g.includes('1234567890'));
  assert.equal(JSON.parse(g).secrets.ANTHROPIC_API_KEY.hint, '…abcd');

  await put('ANTHROPIC_API_KEY', '');                                          // xoá → quay về secret Cloudflare
  _resetConfigCache();
  assert.equal((await withSecrets(env)).ANTHROPIC_API_KEY, 'sk-ant-cu-tu-cloudflare-000000000000');
});

test('admin test: khoá Google nhập trên web được dùng khi kiểm tra link', async () => {
  const env = { ADMIN_PASSWORD: ADMIN, CONFIG: fakeKV() };
  await env.CONFIG.put('app-secrets', JSON.stringify({ GOOGLE_SA_KEY: '{"type":"service_account","client_email":"a@b","private_key":"x"}' }));
  const r = await testApi.onRequestPost({ request: req('POST', '/api/admin/test', { folder: 'https://drive.google.com/drive/folders/1pwLp5McpL8K7yqGJEA6TaWBI2CbGuRUE' }), env }).then((x) => x.json());
  assert.doesNotMatch(r.error || '', /GOOGLE_SA_KEY/);                        // không còn báo thiếu khoá (lỗi ký JWT do key giả là chuyện khác)
});

test('ô AI chỉ một hãng: lưu key Gemini thì key Claude (nhập ở admin) bị thay', async () => {
  const env = { ADMIN_PASSWORD: ADMIN, CONFIG: fakeKV() };
  const put = (name, value) => secretsApi.onRequestPut({ request: req('PUT', '/api/admin/secrets', { name, value }), env }).then((r) => r.json());
  await put('ANTHROPIC_API_KEY', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  const j = await put('GEMINI_API_KEY', 'AIzaSyD-abcdefghijklmnopqrstuvwxyz0123');
  assert.equal(j.secrets.GEMINI_API_KEY.set, true);
  assert.equal(j.secrets.ANTHROPIC_API_KEY.set, false);
  assert.match((await put('GEMINI_API_KEY', 'sk-ant-xxx')).error, /AIza/);
  assert.equal((await put('GEMINI_API_KEY', 'AQ.Ab8Rtestkeyformat_abcdefghijklmnop')).secrets.GEMINI_API_KEY.set, true);   // định dạng key mới
});

const fakeAI = (text = 'Xin chào', fail = false) => ({
  calls: [],
  async run(model, input) {
    this.calls.push({ model, input });
    if (fail) throw new Error('3036: daily free allocation exceeded');
    const enc = new TextEncoder();
    return new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: {"response":"${text}"}\n\ndata: [DONE]\n\n`)); c.close(); } });
  },
});

test('Thử AI: báo rõ từng hãng (key sai / bị chặn vị trí / hết lượt / chạy được), không lộ key', async () => {
  const realFetch = globalThis.fetch;
  const G = 'AIzaTEST' + 'x'.repeat(30);
  const run = async (env, status, body) => {
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(body, { status }); };
    const r = await (await aiTestApi.onRequestPost({ request: req('POST', '/api/admin/ai-test', {}), env: { ADMIN_PASSWORD: ADMIN, ...env } })).json();
    return { r, sent };
  };
  try {
    assert.match((await run({}, 200, '')).r.error, /Chưa có AI/);
    const ok = await run({ GEMINI_API_KEY: G }, 200, 'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}\n\n');
    assert.equal(ok.r.ok, true);
    assert.equal(ok.r.active, 'gemini');
    assert.ok(!ok.sent.url.includes('AIzaTEST'));
    assert.ok(!JSON.stringify(ok.r).includes('AIzaTEST'));
    const bad = await run({ GEMINI_API_KEY: G }, 400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}');
    assert.match(bad.r.results[0].error, /Key sai/);
    const quota = await run({ GEMINI_API_KEY: G }, 429, '{"error":{"message":"Quota exceeded"}}');
    assert.match(quota.r.results[0].error, /Hết lượt/);
    // Gemini bị chặn vị trí → Workers AI vẫn chạy
    const loc = await run({ GEMINI_API_KEY: G, AI: fakeAI('OK') }, 400, '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}');
    assert.match(loc.r.results[0].error, /vị trí/);
    assert.equal(loc.r.results[1].provider, 'workers');
    assert.equal(loc.r.results[1].ok, true);
    assert.equal(loc.r.active, 'workers');
    const cl = await run({ ANTHROPIC_API_KEY: 'sk-ant-TEST' }, 403, '{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}');
    assert.match(cl.r.results[0].error, /vị trí/);
    const deny = await aiTestApi.onRequestPost({ request: req('POST', '/api/admin/ai-test', {}, 'sai'), env: { ADMIN_PASSWORD: ADMIN } });
    assert.equal(deny.status, 401);
  } finally { globalThis.fetch = realFetch; }
});

test('chat: Gemini lỗi → tự chuyển sang Workers AI; Workers AI lỗi → trích tài liệu', async () => {
  const realFetch = globalThis.fetch;
  const { onRequestPost: chat } = await import('../functions/api/chat.js');
  const post = (env) => chat({ request: new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ dept: 'ketoan', messages: [{ role: 'user', content: 'thủ tục tạm ứng' }] }) }), env });
  try {
    globalThis.fetch = async () => new Response('{"error":{"message":"User location is not supported for the API use."}}', { status: 400 });
    const ai = fakeAI('Bạn làm phiếu tạm ứng nhé');
    const r = await post({ GEMINI_API_KEY: 'AIzaTEST' + 'x'.repeat(30), AI: ai });
    assert.equal(r.headers.get('x-chat-mode'), 'llm');
    assert.equal(await r.text(), 'Bạn làm phiếu tạm ứng nhé');
    assert.equal(ai.calls[0].input.messages[0].role, 'system');
    assert.equal(ai.calls[0].input.stream, true);
    const r2 = await post({ AI: fakeAI('x', true) });
    assert.equal(r2.headers.get('x-chat-mode'), 'faq-fallback');
    assert.ok((await r2.text()).length > 0);
  } finally { globalThis.fetch = realFetch; }
});

test('Gemini quá tải (503): thử lại rồi chuyển Flash-Lite; tất cả lỗi → lưu lỗi gần nhất cho admin xem', async () => {
  const realFetch = globalThis.fetch;
  const chatMod = await import('../functions/api/chat.js');
  const G = 'AIzaTEST' + 'x'.repeat(30);
  const store = new Map();
  const CONFIG = { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
  const post = (env) => chatMod.onRequestPost({ request: new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ dept: 'ketoan', messages: [{ role: 'user', content: 'thủ tục tạm ứng' }] }) }), env });
  try {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      if (!url.includes('flash-lite')) return new Response('{"error":{"message":"The model is overloaded"}}', { status: 503 });
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Từ bản Lite"}]}}]}\n\n', { status: 200 });
    };
    const r = await post({ GEMINI_API_KEY: G, CONFIG });
    assert.equal(r.headers.get('x-chat-mode'), 'llm');
    assert.equal(await r.text(), 'Từ bản Lite');
    assert.equal(urls.length, 3);
    // cả Gemini lẫn Lite đều lỗi → trích tài liệu + lưu lỗi
    chatMod._resetAiErr();
    globalThis.fetch = async () => new Response('{"error":{"message":"User location is not supported for the API use."}}', { status: 400 });
    const r2 = await post({ GEMINI_API_KEY: G, CONFIG });
    assert.equal(r2.headers.get('x-chat-mode'), 'faq-fallback');
    const saved = JSON.parse(store.get('ai-last-error'));
    assert.equal(saved.errors[0].provider, 'gemini');
    assert.ok(!store.get('ai-last-error').includes('AIzaTEST'));
    const t = await (await aiTestApi.onRequestPost({ request: req('POST', '/api/admin/ai-test', {}), env: { ADMIN_PASSWORD: ADMIN, GEMINI_API_KEY: G, CONFIG } })).json();
    assert.match(t.lastError.errors[0].error, /vị trí/);
  } finally { globalThis.fetch = realFetch; }
});

test('AI trả 200 nhưng rỗng → không hiện "(không có nội dung)": thử lại / Lite, hết thì trích tài liệu', async () => {
  const realFetch = globalThis.fetch;
  const chatMod = await import('../functions/api/chat.js');
  const G = 'AIzaTEST' + 'x'.repeat(30);
  const post = (env) => chatMod.onRequestPost({ request: new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ dept: 'ketoan', messages: [{ role: 'user', content: 'thủ tục tạm ứng' }] }) }), env });
  const empty = 'data: {"candidates":[{"content":{"parts":[{"text":"…","thought":true}]},"finishReason":"MAX_TOKENS"}]}\n\n';
  try {
    let n = 0;
    globalThis.fetch = async (url, init) => {
      n++;
      assert.ok(JSON.parse(init.body).generationConfig.maxOutputTokens >= 2048);
      return new Response(url.includes('flash-lite') ? 'data: {"candidates":[{"content":{"parts":[{"text":"Có chữ"}]}}]}\n\n' : empty, { status: 200 });
    };
    const r = await post({ GEMINI_API_KEY: G });
    assert.equal(r.headers.get('x-chat-mode'), 'llm');
    assert.equal(await r.text(), 'Có chữ');
    assert.equal(n, 3);
    globalThis.fetch = async () => new Response(empty, { status: 200 });
    const r2 = await post({ GEMINI_API_KEY: G });
    assert.equal(r2.headers.get('x-chat-mode'), 'faq-fallback');
    assert.ok((await r2.text()).trim().length > 10);
  } finally { globalThis.fetch = realFetch; }
});
