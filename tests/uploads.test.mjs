import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeD1, hasSqlite } from '../tools/fake-d1.mjs';
import * as docsApi from '../functions/api/admin/docs.js';
import * as cfgApi from '../functions/api/admin/config.js';
import { onRequestPost as chat } from '../functions/api/chat.js';
import { _resetUploads, UPLOAD_LIMITS, cleanName } from '../functions/_uploads.js';
import { _resetConfigCache } from '../functions/_config.js';
import { docxText } from '../public/shared/office.js';

const skip = !hasSqlite && 'cần Node ≥ 22.5 (node:sqlite)';
beforeEach(() => { _resetUploads(); _resetConfigCache(); });
const ADMIN = 'mat-khau-admin-123';
const kv = () => { const m = new Map(); return { get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); } }; };
const req = (method, url, body, key = ADMIN) => new Request('http://x' + url, { method, headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: body && JSON.stringify(body) });
const ask = async (env, dept, q) => { const r = await chat({ request: new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ dept, messages: [{ role: 'user', content: q }] }) }), env }); return (await r.text()) + ' ' + decodeURIComponent(r.headers.get('x-sources') || ''); };

test('tải file lên: rút chữ ở trình duyệt → lưu D1 → bot trả lời từ file đó', { skip }, async () => {
  const env = { DB: fakeD1(), CONFIG: kv(), ADMIN_PASSWORD: ADMIN };
  // Rút chữ đúng như trình duyệt làm (cùng module public/shared/office.js)
  const text = await docxText(readFileSync(new URL('./fixtures/lam-viec-tu-xa.docx', import.meta.url)));
  const put = await docsApi.onRequestPut({ request: req('PUT', '/api/admin/docs', { dept: 'nhansu', name: 'C:\\fakepath\\lam-viec-tu-xa.docx', text }), env });
  assert.equal(put.status, 200);
  const j = await put.json();
  assert.equal(j.doc.name, 'lam-viec-tu-xa.docx');
  assert.equal(j.docs.length, 1);
  assert.ok(j.used > 0);

  const a0 = await ask(env, 'nhansu', 'làm việc từ xa tối đa mấy ngày');
  assert.match(a0, /tối đa 2 ngày/);
  assert.doesNotMatch(a0, /lam-viec-tu-xa/);                              // mặc định: KHÔNG hiện tên file
  await env.CONFIG.put('app-config', JSON.stringify({ showSources: true }));
  _resetConfigCache();
  const a = await ask(env, 'nhansu', 'làm việc từ xa tối đa mấy ngày');
  assert.match(a, /tối đa 2 ngày/);
  assert.match(a, /lam-viec-tu-xa\.docx/);                               // admin bật → có tên file
  // phòng khác KHÔNG thấy file của Nhân sự
  assert.doesNotMatch(await ask(env, 'ketoan', 'làm việc từ xa tối đa mấy ngày'), /tối đa 2 ngày/);

  // tải lại cùng tên = thay bản cũ
  const again = await (await docsApi.onRequestPut({ request: req('PUT', '/api/admin/docs', { dept: 'nhansu', name: 'lam-viec-tu-xa.docx', text: 'Làm việc từ xa: tối đa 3 ngày mỗi tuần.' }), env })).json();
  assert.equal(again.replaced, true);
  assert.equal(again.docs.length, 1);
  _resetUploads();
  assert.match(await ask(env, 'nhansu', 'làm việc từ xa tối đa mấy ngày'), /3 ngày/);

  // xoá
  const del = await docsApi.onRequestDelete({ request: req('DELETE', '/api/admin/docs?dept=nhansu&name=lam-viec-tu-xa.docx'), env });
  assert.equal((await del.json()).docs.length, 0);
});

test('tải file lên: chặn sai mật khẩu, phòng lạ, file rỗng, vượt dung lượng; xoá phòng → xoá file', { skip }, async () => {
  const env = { DB: fakeD1(), CONFIG: kv(), ADMIN_PASSWORD: ADMIN };
  const put = (b, key) => docsApi.onRequestPut({ request: req('PUT', '/api/admin/docs', b, key), env });
  assert.equal((await put({ dept: 'nhansu', name: 'a.txt', text: 'x' }, 'sai')).status, 401);
  assert.equal((await put({ dept: 'khong-co', name: 'a.txt', text: 'x' })).status, 404);
  assert.match((await (await put({ dept: 'nhansu', name: 'scan.docx', text: '  ' })).json()).error, /không có chữ/);
  const big = 'ạ'.repeat(UPLOAD_LIMITS.fileBytes / 3 + 10);                 // 'ạ' = 3 byte UTF-8
  assert.match((await (await put({ dept: 'nhansu', name: 'big.txt', text: big })).json()).error, /tối đa 1 MB/);
  const half = 'ạ '.repeat(190_000);                                          // ~0.76 MB
  assert.equal((await put({ dept: 'nhansu', name: '1.txt', text: half })).status, 200);
  assert.equal((await put({ dept: 'nhansu', name: '2.txt', text: half })).status, 200);
  assert.match((await (await put({ dept: 'nhansu', name: '3.txt', text: half })).json()).error, /Vượt dung lượng/);

  // xoá phòng Nhân sự ở cấu hình → file của phòng đó bị xoá theo
  await put({ dept: 'ketoan', name: 'kt.txt', text: 'Quy định kế toán' });
  const save = await cfgApi.onRequestPut({ request: req('PUT', '/api/admin/config', { depts: [{ id: 'ketoan', name: 'Kế toán' }, { id: 'phattrien', name: 'Phát triển' }] }), env });
  assert.equal(save.status, 200);
  _resetConfigCache();
  const list = async (d) => (await (await docsApi.onRequestGet({ request: req('GET', '/api/admin/docs?dept=' + d), env })).json());
  assert.equal((await list('ketoan')).docs.length, 1);
  assert.equal((await list('nhansu')).error, 'Không có phòng ban này (lưu phòng trước rồi mới tải file).');
  const rows = await env.DB.prepare('SELECT COUNT(*) n FROM docs WHERE dept = ?').bind('nhansu').first();
  assert.equal(rows.n, 0);
});

test('cleanName: bỏ đường dẫn, giữ dấu tiếng Việt', () => {
  assert.equal(cleanName('C:\\Users\\a\\Quy chế lương.docx'), 'Quy chế lương.docx');
  assert.equal(cleanName('../../x<script>.txt'), 'xscript.txt');
});

test('mỗi phòng MỘT nguồn: chọn "link" thì file tải lên không được dùng (vẫn giữ), chọn lại "upload" là dùng tiếp', { skip }, async () => {
  const store = kv();
  const env = { DB: fakeD1(), CONFIG: store, ADMIN_PASSWORD: ADMIN };
  await docsApi.onRequestPut({ request: req('PUT', '/api/admin/docs', { dept: 'nhansu', name: 'wfh.txt', text: 'Làm việc từ xa: tối đa 4 ngày mỗi tháng.' }), env });
  assert.match(await ask(env, 'nhansu', 'làm việc từ xa tối đa mấy ngày'), /4 ngày/);
  const save = (source, folder = '') => cfgApi.onRequestPut({ request: req('PUT', '/api/admin/config', { depts: [{ id: 'ketoan', name: 'Kế toán' }, { id: 'nhansu', name: 'Nhân sự', source, folder }] }), env });
  assert.equal((await save('link', 'https://drive.google.com/drive/folders/1pwLp5McpL8K7yqGJEA6TaWBI2CbGuRUE')).status, 200);
  _resetConfigCache(); _resetUploads();
  assert.doesNotMatch(await ask(env, 'nhansu', 'làm việc từ xa tối đa mấy ngày'), /4 ngày/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM docs').first()).n, 1);          // file vẫn còn
  // chọn "upload" → link bị bỏ khi lưu, file dùng lại được
  assert.equal((await save('upload', 'https://drive.google.com/drive/folders/XYZ')).status, 200);
  _resetConfigCache(); _resetUploads();
  const cfg = JSON.parse(JSON.stringify(await (await import('../functions/_config.js')).loadConfig(env)));
  assert.equal(cfg.depts[1].folder, '');
  assert.match(await ask(env, 'nhansu', 'làm việc từ xa tối đa mấy ngày'), /4 ngày/);
});

test('phòng đã có tài liệu thật → FAQ MẪU không còn che tài liệu thật', { skip }, async () => {
  const env = { DB: fakeD1(), CONFIG: kv(), ADMIN_PASSWORD: ADMIN };
  const faq = await ask(env, 'nhansu', 'nghỉ phép năm được mấy ngày');         // chưa có tài liệu → FAQ mẫu (12 ngày)
  assert.match(faq, /12 ngày/);
  await docsApi.onRequestPut({ request: req('PUT', '/api/admin/docs', { dept: 'nhansu', name: 'noi-quy.pdf', text: 'Điều 6. Nghỉ phép năm: 14 ngày mỗi năm.' }), env });
  const real = await ask(env, 'nhansu', 'nghỉ phép năm được mấy ngày');
  assert.match(real, /14 ngày/);
  assert.doesNotMatch(real, /12 ngày/);
});

test('PDF: dựng lại chữ tiếng Việt theo vị trí (chữ có dấu bị vẽ sau, chèn vào giữa cụm khác)', async () => {
  const { pageText } = await import('../public/admin/pdf-text.js');
  const T = (str, x, y, w, size = 11) => ({ str, transform: [size, 0, 0, size, x, y], width: w });
  const items = [
    T('Nhân viên đ', 90, 666, 55.2), T(' ', 145.3, 666, 13.7), T('c làm vi', 159, 666, 34.8), T('c', 200.3, 666, 4.8),
    T('ượ', 145.3, 666, 13.7), T(' ', 159, 666, 34.8), T('ệ', 193.8, 666, 6.5),                     // font dự phòng, vẽ sau
    T('Điều 6. Nghỉ phép', 90, 620, 90),                                                                  // cách xa → đoạn mới
  ];
  assert.equal(pageText(items), 'Nhân viên được làm việc\n\nĐiều 6. Nghỉ phép');
});

test('không có AI: trích đúng dòng (tiêu đề mục ở đoạn trước, hàng bảng, cụm 2 tiếng)', async () => {
  const { bestSnippet } = await import('../functions/api/chat.js');
  const chunks = [
    { source: 'a.docx', part: 1, text: 'Điều 2. Mức phụ cấp trong nước\nKhoản chi | Nhân viên\nPhụ cấp lưu trú | 300.000 đồng/ngày\nNếu đối tác lo ăn ở thì không có phụ cấp.\nĐiều 3. Công tác nước ngoài' },
    { source: 'a.docx', part: 2, text: 'Phụ cấp lưu trú: 50 USD/ngày.\nBảo hiểm do công ty mua.' },
    { source: 'b.docx', part: 1, text: '2.3. Hạn mức tạm ứng\nMục đích | Hạn mức tối đa mỗi lần\nCông tác trong nước | 10.000.000 đồng\nCông tác nước ngoài | 30.000.000 đồng' },
  ];
  const a = bestSnippet(chunks, 'đi công tác nước ngoài phụ cấp bao nhiêu');
  assert.equal(a.source, 'a.docx');
  assert.match(a.text, /^Phụ cấp lưu trú: 50 USD[\s\S]*\(Mục: Điều 3/);
  const b = bestSnippet(chunks, 'tạm ứng tối đa khi đi công tác trong nước');
  assert.match(b.text, /^Công tác trong nước — hạn mức tối đa mỗi lần: 10\.000\.000 đồng\./);
  assert.match(b.text, /\(Mục: 2\.3\. Hạn mức tạm ứng\)$/);
  assert.doesNotMatch(b.text, /\|/);
});
