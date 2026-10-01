import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, hasSqlite } from '../tools/fake-d1.mjs';
import { onRequestPost as chat } from '../functions/api/chat.js';
import { onRequestPost as feedback } from '../functions/api/feedback.js';
import * as statsApi from '../functions/api/admin/stats.js';
import { looksUnanswered, summary } from '../functions/_stats.js';
import { _resetConfigCache } from '../functions/_config.js';

beforeEach(() => _resetConfigCache());
const ADMIN = 'mat-khau-admin-123';
const post = (url, body) => new Request('http://x' + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ask = (dept, q) => ({ dept, messages: [{ role: 'user', content: q }] });

async function run(env, dept, q) {
  const bg = [];
  const r = await chat({ request: post('/api/chat', ask(dept, q)), env, waitUntil: (p) => bg.push(p) });
  await r.text(); await Promise.all(bg);
  return r;
}

test('thống kê: ghi câu hỏi, trả lời được / không, hỏi chung, 👍👎, không lộ gì cho người chat', { skip: !hasSqlite && 'cần Node ≥ 22.5 (node:sqlite)' }, async () => {
  const env = { DB: fakeD1(), ADMIN_PASSWORD: ADMIN };
  const a = await run(env, 'ketoan', 'làm sao để xin tạm ứng');
  const qid = a.headers.get('x-qid');
  assert.match(qid, /^[0-9a-f-]{36}$/);
  await run(env, 'ketoan', 'con mèo của sếp tên gì');           // không trả lời được
  await run(env, 'ketoan', 'con mèo của sếp tên gì');
  await run(env, 'auto', 'thời tiết hôm nay');                  // hỏi chung không rõ phòng
  await run(env, 'auto', 'nghỉ phép năm được mấy ngày');

  assert.equal((await feedback({ request: post('/api/feedback', { id: qid, rating: -1 }), env })).status, 200);
  assert.equal((await feedback({ request: post('/api/feedback', { id: 'x', rating: 1 }), env })).status, 400);
  assert.equal((await feedback({ request: post('/api/feedback', { id: crypto.randomUUID(), rating: 1 }), env })).status, 404);

  const s = await summary(env, { days: 7 });
  assert.equal(s.total, 5);
  assert.equal(s.missed, 3);
  assert.equal(s.down, 1);
  assert.equal(s.auto, 2);
  assert.deepEqual(s.unanswered.length ? s.unanswered[0] : null, { question: 'con mèo của sếp tên gì', dept: 'ketoan', n: 2, last: s.unanswered[0].last });
  assert.ok(s.byDept.find((d) => d.dept === '_auto'));
  assert.equal(s.byDay.length, 1);
  assert.equal(s.disliked[0].question, 'làm sao để xin tạm ứng');

  // admin API: cần mật khẩu; CSV có BOM + chặn công thức Excel
  const get = (u, key = ADMIN) => statsApi.onRequestGet({ request: new Request('http://x' + u, { headers: { 'x-admin-key': key } }), env });
  assert.equal((await get('/api/admin/stats', 'sai')).status, 401);
  const j = await (await get('/api/admin/stats?days=30')).json();
  assert.equal(j.total, 5);
  assert.equal(j.names._auto, 'Hỏi chung (chưa rõ phòng)');
  await run(env, 'ketoan', '=HYPERLINK("http://x")');
  const buf = new Uint8Array(await (await get('/api/admin/stats?format=csv')).arrayBuffer());
  assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf]);            // BOM → Excel đọc đúng tiếng Việt
  const csv = new TextDecoder().decode(buf);
  assert.ok(csv.startsWith('Thời gian'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
  await statsApi.onRequestDelete({ request: new Request('http://x/api/admin/stats', { method: 'DELETE', headers: { 'x-admin-key': ADMIN } }), env });
  assert.equal((await summary(env)).total, 0);
});

test('thống kê: tắt ở admin → không ghi; không có DB → chat vẫn chạy', { skip: !hasSqlite && 'cần Node ≥ 22.5 (node:sqlite)' }, async () => {
  const kv = new Map([['app-config', JSON.stringify({ depts: null, stats: false })]]);
  const env = { DB: fakeD1(), CONFIG: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async () => {} } };
  const r = await run(env, 'ketoan', 'xin tạm ứng');
  assert.equal(r.headers.get('x-qid'), null);
  assert.equal((await summary(env)).total, 0);
  const r2 = await run({}, 'ketoan', 'xin tạm ứng');
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('x-qid'), null);
});

test('looksUnanswered: nhận ra câu "chưa có thông tin" của AI', () => {
  assert.ok(looksUnanswered('Hiện mình chưa có thông tin về việc này, bạn liên hệ …'));
  assert.ok(!looksUnanswered('Bạn điền phiếu tạm ứng mẫu KT-01.'));
});
