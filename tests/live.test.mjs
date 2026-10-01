import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { liveDept, buildFolder, deptReady, _resetLiveKho } from '../functions/_kho-live.js';
import { _resetConfigCache } from '../functions/_config.js';
import { readerFor } from '../functions/_drive.js';
import { hydrate } from '../public/shared/dept-model.js';
import { onRequestPost } from '../functions/api/chat.js';
import { onRequestGet as khoStatus } from '../functions/api/kho.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { client_email: 'bot@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const link = (id) => `https://drive.google.com/drive/folders/${id}?usp=x`;
const CFG = { tenantId: '', clientId: '', ttl: 600 };

const DOCX = readFileSync(new URL('./fixtures/lam-viec-tu-xa.docx', import.meta.url));
const XLSX = readFileSync(new URL('./fixtures/han-muc-chi-phi.xlsx', import.meta.url));
// Mỗi phòng MỘT thư mục riêng
const TREE = {
  FOLDERKETOAN1: [
    { id: 'x1', name: 'han-muc-chi-phi.xlsx', mimeType: 'x', size: String(XLSX.length) },
    { id: 'sub', name: 'Quy chế', mimeType: 'application/vnd.google-apps.folder' },
  ],
  sub: [{ id: 'gDoc', name: 'Giới thiệu phòng', mimeType: 'application/vnd.google-apps.document' }],
  FOLDERNHANSU1: [
    { id: 'd1', name: 'lam-viec-tu-xa.docx', mimeType: 'x', size: String(DOCX.length) },
    { id: 'pdf1', name: 'so-tay.pdf', mimeType: 'application/pdf', size: '1000' },
  ],
};
const CONTENT = { gDoc: 'Phòng Kế toán thành lập năm 2015.', x1: XLSX, d1: DOCX };

let calls, jwt;
function fakeDrive({ failList = false } = {}) {
  calls = { token: 0, list: 0, file: 0 };
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com') {
      calls.token++; jwt = new URLSearchParams(init.body).get('assertion');
      return new Response(JSON.stringify({ access_token: 'TOK', expires_in: 3600 }));
    }
    assert.equal(init.headers.authorization, 'Bearer TOK');
    if (u.pathname.endsWith('/files')) {
      calls.list++;
      if (failList) return new Response('boom', { status: 500 });
      const parent = /'([\w]+)' in parents/.exec(u.searchParams.get('q'))[1];
      if (!TREE[parent]) return new Response('nf', { status: 404 });
      return new Response(JSON.stringify({ files: TREE[parent] }));
    }
    calls.file++;
    return new Response(CONTENT[u.pathname.split('/')[4]]);
  };
}

// KV giả chứa cấu hình 3 phòng: Kế toán + Nhân sự có link riêng, Phát triển chưa có link
const kv = (cfg) => ({ get: async () => cfg, put: async () => {} });
const ENV = {
  GOOGLE_SA_KEY: JSON.stringify(SA),
  CONFIG: kv({ depts: [
    { id: 'ketoan', name: 'Kế toán', folder: link('FOLDERKETOAN1') },
    { id: 'nhansu', name: 'Nhân sự', folder: link('FOLDERNHANSU1') },
    { id: 'phattrien', name: 'Phát triển', folder: '' },
  ], tenantId: '', clientId: '', ttl: 600, showSources: true }),
};
const DEPT_KT = hydrate([{ id: 'ketoan', name: 'Kế toán', folder: link('FOLDERKETOAN1') }])[0];

beforeEach(() => { _resetLiveKho(); _resetConfigCache(); });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('deptReady: cần link + key', () => {
  assert.ok(deptReady(DEPT_KT, CFG, ENV));
  assert.ok(!deptReady(DEPT_KT, CFG, {}));
  assert.ok(!deptReady({ ...DEPT_KT, folder: '' }, CFG, ENV));
});

test('readerFor: PDF bị bỏ qua kèm hướng dẫn', () => {
  assert.match(readerFor({ name: 'a.pdf', mimeType: 'application/pdf' }).why, /Google Tài liệu/);
  assert.equal(readerFor({ name: 'G', mimeType: 'application/vnd.google-apps.spreadsheet' }).how, 'export');
});

test('buildFolder: một thư mục = một phòng, đọc cả thư mục con, JWT ký đúng', async () => {
  const { chunks, status } = await buildFolder(link('FOLDERKETOAN1'), CFG, ENV, fakeDrive());
  const [h, c, s] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(status.files, 2);
  assert.deepEqual(chunks.map((x) => x.source).sort(), ['Quy chế/Giới thiệu phòng', 'han-muc-chi-phi.xlsx']);
  assert.ok(chunks.every((x) => /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\/view$/.test(x.url)));   // link mở file gốc
});

test('liveDept: đệm theo TTL, hết hạn trả bản cũ + đọc lại ở nền; lỗi giữ bản cũ', async () => {
  const f = fakeDrive();
  const t0 = 1_000_000;
  await liveDept(DEPT_KT, CFG, ENV, { fetchImpl: f, now: t0 });
  const lists = calls.list;
  await liveDept(DEPT_KT, CFG, ENV, { fetchImpl: f, now: t0 + 60_000 });
  assert.equal(calls.list, lists);
  const bg = [];
  const m = await liveDept(DEPT_KT, CFG, ENV, { fetchImpl: f, now: t0 + 11 * 60_000, waitUntil: (p) => bg.push(p) });
  assert.equal(m.at, t0);
  await Promise.all(bg);
  assert.ok(calls.list > lists);
  const err = await liveDept(DEPT_KT, CFG, ENV, { fetchImpl: fakeDrive({ failList: true }), now: t0 + 12 * 60_000, force: true });
  assert.match(err.status.lastError, /Drive lỗi 500/);
});

const withSrc = async (r) => (await r.text()) + ' ' + decodeURIComponent(r.headers.get('x-sources') || '');

test('chat: mỗi phòng chỉ thấy tài liệu của mình (dữ liệu tách hẳn)', async () => {
  globalThis.fetch = fakeDrive();
  const ask = async (dept, q) => withSrc(await onRequestPost({
    request: new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ dept, messages: [{ role: 'user', content: q }] }) }),
    env: ENV, waitUntil: () => {},
  }));
  assert.match(await ask('ketoan', 'hạn mức tiếp khách'), /han-muc-chi-phi\.xlsx/);
  assert.match(await ask('nhansu', 'làm việc từ xa mấy ngày'), /lam-viec-tu-xa\.docx/);
  // Nhân sự KHÔNG được thấy file của Kế toán
  assert.doesNotMatch(await ask('nhansu', 'hạn mức tiếp khách'), /han-muc-chi-phi/);
  // Phòng chưa có link vẫn chạy (FAQ)
  assert.match(await ask('phattrien', 'quy trình pull request'), /PR|pull request/i);
});

test('chat: phòng ban mới thêm ở admin chat được, phòng lạ bị từ chối', async () => {
  globalThis.fetch = fakeDrive();
  const env = { ...ENV, CONFIG: kv({ depts: [{ id: 'cskh', name: 'Chăm sóc khách hàng', folder: link('FOLDERNHANSU1') }], ttl: 600, showSources: true }) };
  const ask = (dept) => onRequestPost({ request: new Request('http://x', { method: 'POST', body: JSON.stringify({ dept, messages: [{ role: 'user', content: 'làm việc từ xa' }] }) }), env, waitUntil: () => {} });
  assert.match(await withSrc(await ask('cskh')), /lam-viec-tu-xa[\s\S]*2 ngày|2 ngày[\s\S]*lam-viec-tu-xa/);
  assert.equal((await ask('ketoan')).status, 400);                               // phòng đã xoá khỏi cấu hình
});

test('/api/kho: trạng thái từng phòng, không lộ nội dung', async () => {
  globalThis.fetch = fakeDrive();
  const j = await (await khoStatus({ request: new Request('http://x/api/kho'), env: ENV, waitUntil: () => {} })).json();
  const by = Object.fromEntries(j.depts.map((d) => [d.id, d]));
  assert.equal(by.ketoan.state, 'ok');
  assert.equal(by.nhansu.skipped[0].file, 'so-tay.pdf');
  assert.equal(by.phattrien.state, 'faq');
  assert.ok(!JSON.stringify(j).includes('2015'));
  const one = await (await khoStatus({ request: new Request('http://x/api/kho?dept=nhansu'), env: ENV, waitUntil: () => {} })).json();
  assert.equal(one.depts.length, 1);
});
