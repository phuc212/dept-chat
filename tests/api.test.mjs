import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost, validate, systemPrompt, LIMITS } from '../functions/api/chat.js';
import { onRequest as mw, sameSecret } from '../functions/_middleware.js';
import { deptById } from '../public/shared/depts.js';

const post = (body) => new Request('http://x/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const ask = (dept, q) => ({ dept, messages: [{ role: 'user', content: q }] });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('validate: chặn bộ phận lạ, body sai, câu quá dài', () => {
  assert.equal(validate(ask('marketing', 'hi')).status, 400);
  assert.equal(validate({ dept: 'ketoan', messages: [] }).status, 400);
  assert.equal(validate(ask('ketoan', 'x'.repeat(LIMITS.perMessage + 1))).status, 413);
  assert.equal(validate({ dept: 'ketoan', messages: [{ role: 'system', content: 'x' }] }).status, 400);
});

test('validate: cắt lịch sử dài, bắt đầu bằng user', () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  msgs.push({ role: 'user', content: 'cuối' });
  const v = validate({ dept: 'nhansu', messages: msgs });
  assert.ok(v.messages.length <= LIMITS.messages);
  assert.equal(v.messages[0].role, 'user');
  assert.equal(v.messages.at(-1).content, 'cuối');
});

test('không có API key → trả lời FAQ', async () => {
  const res = await onRequestPost({ request: post(ask('ketoan', 'ngày nào trả lương')), env: {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-chat-mode'), 'faq');
  assert.match(await res.text(), /ngày 5/);
});

test('body không phải JSON → 400', async () => {
  const res = await onRequestPost({ request: post('{oops'), env: {} });
  assert.equal(res.status, 400);
});

test('có key → gọi Anthropic đúng cách, stream text ra', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    const sse = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Xin "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chào"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { sse.forEach((s) => c.enqueue(enc.encode(s))); c.close(); } }), { status: 200 });
  };
  const res = await onRequestPost({ request: post(ask('phattrien', 'deploy sao?')), env: { ANTHROPIC_API_KEY: 'k' } });
  assert.equal(res.headers.get('x-chat-mode'), 'llm');
  assert.equal(await res.text(), 'Xin chào');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], 'k');
  assert.equal(sent.body.stream, true);
  assert.match(sent.body.system, /Trợ lý Phát triển/);
  assert.match(sent.body.system, /Deploy lên production/);   // kho FAQ nằm trong prompt
});

test('có key Gemini (không có key Claude) → gọi Gemini, stream text ra, key ở header', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    const enc = new TextEncoder();
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Xin "}],"role":"model"}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"suy nghĩ","thought":true},{"text":"chào"}],"role":"model"}}]}',
    ];
    return new Response(new ReadableStream({ start(c) { sse.forEach((x) => c.enqueue(enc.encode(x))); c.close(); } }), { status: 200 });
  };
  const res = await onRequestPost({ request: post({ dept: 'phattrien', messages: [
    { role: 'user', content: 'deploy sao?' }, { role: 'assistant', content: 'Bạn hỏi môi trường nào?' }, { role: 'user', content: 'production' }] }), env: { GEMINI_API_KEY: 'AIzaTEST' } });
  assert.equal(res.headers.get('x-chat-mode'), 'llm');
  assert.equal(await res.text(), 'Xin chào');                                   // bỏ phần "thought"
  assert.match(sent.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-flash-latest:streamGenerateContent\?alt=sse$/);
  assert.ok(!sent.url.includes('AIzaTEST'));                                   // key KHÔNG nằm trong URL
  assert.equal(sent.init.headers['x-goog-api-key'], 'AIzaTEST');
  assert.match(sent.body.systemInstruction.parts[0].text, /Trợ lý Phát triển/);
  assert.deepEqual(sent.body.contents.map((c) => c.role), ['user', 'model', 'user']);
});

test('LLM lỗi → rơi về FAQ, không trả lỗi cho người dùng', async () => {
  globalThis.fetch = async () => new Response('overloaded', { status: 529 });
  const res = await onRequestPost({ request: post(ask('nhansu', 'giờ làm việc')), env: { ANTHROPIC_API_KEY: 'k' } });
  assert.equal(res.headers.get('x-chat-mode'), 'faq-fallback');
  assert.match(await res.text(), /8:00/);
});

test('system prompt nhắc phạm vi và các bộ phận khác', () => {
  const p = systemPrompt(deptById('ketoan'));
  assert.match(p, /Nhân sự:/);
  assert.match(p, /Phát triển:/);
  assert.doesNotMatch(p, /- Kế toán:/);
});

// ── middleware ────────────────────────────────────────────────────────────
const basic = (pw) => ({ authorization: 'Basic ' + btoa(`any:${pw}`) });
const req = (h = {}) => new Request('http://x/', { headers: h });
const next = () => new Response('ok');

test('middleware: fail-closed khi thiếu SITE_PASSWORD', async () => {
  assert.equal((await mw({ request: req(basic('a')), env: {}, next })).status, 500);
});
test('middleware: sai/thiếu mật khẩu → 401, đúng → qua', async () => {
  const env = { SITE_PASSWORD: 'bí-mật' };
  assert.equal((await mw({ request: req(), env, next })).status, 401);
  assert.equal((await mw({ request: req(basic('sai')), env, next })).status, 401);
  // mật khẩu Unicode: btoa không nhận ký tự ngoài Latin-1 → mã hoá UTF-8 trước
  const b64 = Buffer.from('u:bí-mật', 'utf8').toString('base64');
  assert.equal(await (await mw({ request: req({ authorization: `Basic ${b64}` }), env, next })).text(), 'ok');
});
test('middleware: SITE_PASSWORD=off → mở công khai, không hỏi mật khẩu', async () => {
  for (const v of ['off', ' OFF ']) assert.equal(await (await mw({ request: req(), env: { SITE_PASSWORD: v }, next })).text(), 'ok');
  assert.equal((await mw({ request: req(), env: { SITE_PASSWORD: 'offx' }, next })).status, 401);
});
test('sameSecret', () => {
  assert.ok(sameSecret('abc', 'abc'));
  assert.ok(!sameSecret('abc', 'abd'));
  assert.ok(!sameSecret('abc', 'abcd'));
});

/* ── Giai đoạn 1: hỏi chung, link nguồn, lời chào + câu gợi ý ── */
import { routeDept, sourcesOf } from '../functions/api/chat.js';
import { hydrate } from '../public/shared/dept-model.js';
import { validateConfig } from '../functions/_config.js';

test('hỏi chung: tự chọn đúng phòng, báo qua header X-Dept', async () => {
  const depts = hydrate(null);
  assert.equal((await routeDept('thủ tục tạm ứng công tác phí', depts))?.id, 'ketoan');
  assert.equal((await routeDept('nghỉ phép năm được bao nhiêu ngày', depts))?.id, 'nhansu');
  assert.equal(await routeDept('thời tiết hôm nay', depts), null);
  const r = await onRequestPost({ request: post(ask('auto', 'xin nghỉ phép thế nào')), env: {} });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-dept'), 'nhansu');
  const none = await onRequestPost({ request: post(ask('auto', 'thời tiết hôm nay')), env: {} });
  assert.equal(none.headers.get('x-chat-mode'), 'route-none');
  assert.match(await none.text(), /Kế toán/);
  // câu lạc đề sau một câu kế toán: KHÔNG bị kéo về phòng Kế toán
  const follow = await onRequestPost({ request: post({ dept: 'auto', messages: [
    { role: 'user', content: 'thủ tục tạm ứng' }, { role: 'assistant', content: '…' }, { role: 'user', content: 'thời tiết hôm nay' }] }), env: {} });
  assert.equal(follow.headers.get('x-chat-mode'), 'route-none');
});

test('nguồn: chỉ tên file (không link), bỏ FAQ, bỏ trùng', () => {
  const s = sourcesOf([
    { source: 'FAQ', faq: {} },
    { source: 'Nhân sự/nghi-phep.docx', url: 'https://drive.google.com/file/d/A/view' },
    { source: 'Nhân sự/nghi-phep.docx', url: 'https://drive.google.com/file/d/A/view' },
    { source: 'x.txt', url: 'javascript:alert(1)' },
  ]);
  assert.deepEqual(s, [{ name: 'Nhân sự/nghi-phep.docx' }, { name: 'x.txt' }]);
});

test('lời chào + câu gợi ý: admin nhập thì dùng, không thì lấy FAQ mẫu', () => {
  const v = validateConfig({ depts: [{ id: 'ketoan', name: 'Kế toán', greeting: ' Chào! ', suggestions: 'A?\n\nB?\nA?\nC\nD\nE\nF' }, { name: 'CSKH' }] });
  assert.equal(v.cfg.depts[0].greeting, 'Chào!');
  assert.deepEqual(v.cfg.depts[0].suggestions, ['A?', 'B?', 'C', 'D', 'E']);
  const [kt, cs] = hydrate(v.cfg.depts);
  assert.deepEqual(kt.suggest, ['A?', 'B?', 'C', 'D', 'E']);
  assert.deepEqual(cs.suggest, []);
  assert.ok(hydrate(null)[0].suggest.length > 0);                // phòng mặc định: câu hỏi FAQ mẫu
});
