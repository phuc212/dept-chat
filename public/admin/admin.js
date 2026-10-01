import { docxText, xlsxText } from '/shared/office.js';
/* Trang quản trị: danh sách phòng ban — mỗi phòng 1 link thư mục + nút Kiểm tra; thêm / xoá (có cảnh báo).
 * Mọi thao tác gọi /api/admin/** với header x-admin-key. Mật khẩu admin chỉ giữ trong sessionStorage.
 * Server không bao giờ trả giá trị secret — chỉ có/không. Mọi chữ từ server gắn bằng textContent. */
const $ = (s, r = document) => r.querySelector(s);
const PALETTE = ['#e8a33d', '#d9607a', '#4a8fd9', '#3f9f7a', '#8a6ad8', '#d4763b', '#2f9bb3', '#b9577f'];
let key = '';
try { key = sessionStorage.getItem('adminKey') || localStorage.getItem('adminKey') || ''; } catch { /* storage bị chặn */ }

let MAX = 8;
let saved = null;        // bản đã lưu (để biết có thay đổi)
let depts = [];          // [{ uid, id?, name, folder, contact, scope, color, greeting, suggestText }]
let statusById = {};     // trạng thái kho các phòng ĐÃ LƯU
let uidSeq = 0;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const pill = (ok, yes = 'Đã có', no = 'Chưa có') => el('span', ok ? yes : no, 'pill ' + (ok ? 'ok' : 'bad'));
const kind = (link) => /drive\.google\.com/i.test(link) ? 'gdrive' : /\.sharepoint\.com/i.test(link) ? 'sharepoint' : link.trim() ? 'bad' : null;

function payload() {
  return {
    depts: depts.map(({ id, name, source, folder, contact, scope, color, greeting, suggestText }) => ({
      id, name: name.trim(), source, folder: source === 'link' ? folder.trim() : '', contact, scope, color, greeting: (greeting || '').trim(),
      suggestions: lines(suggestText),
    })),
    tenantId: $('#tenantId').value.trim(), clientId: $('#clientId').value.trim(), ttl: Number($('#ttl').value), stats: $('#stats-on').checked, showSources: $('#src-on').checked,
  };
}
const dirty = () => JSON.stringify(payload()) !== saved;
function lines(t) { return [...new Set(String(t || '').split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, 5); }
const fromSaved = (d) => ({ uid: ++uidSeq, ...d, source: d.source || (d.folder ? 'link' : 'upload'), folder: d.folder || '', greeting: d.greeting || '', suggestText: (d.suggestions || []).join('\n') });

/* ---------- vẽ ---------- */
function stateBadge(d) {
  const b = { text: '', cls: '' };
  const s = d.id && statusById[d.id];
  const savedDept = saved && JSON.parse(saved).depts.find((x) => x.id === d.id);
  if (!d.id) return { text: 'Mới · chưa lưu', cls: 'info' };
  if (savedDept && savedDept.source !== d.source) return { text: 'Đổi nguồn · chưa lưu', cls: 'info' };
  if (savedDept && d.source === 'link' && savedDept.folder !== d.folder.trim()) return { text: 'Link đổi · chưa lưu', cls: 'info' };
  if (!s) return b;
  const upN = s.uploads?.files || 0;
  if (s.state === 'uploads') return { text: `✓ ${upN} file tải lên`, cls: 'ok' };
  if (s.state === 'ok') return { text: `✓ ${s.filesRead + upN} file`, cls: 'ok' };
  if (s.state === 'faq') return { text: 'Chưa có tài liệu', cls: 'warn', tip: 'Bot đang trả lời bằng FAQ mẫu (dữ liệu giả). Tải file lên hoặc gắn link thư mục để bot trả lời bằng tài liệu thật.' };
  if (s.state === 'missing') return { text: 'Thiếu cấu hình', cls: 'bad' };
  if (s.state === 'empty') return { text: 'Không đọc được file', cls: 'bad' };
  return { text: 'Lỗi', cls: 'bad' };
}

function renderResult(box, r, title) {
  box.replaceChildren();
  if (!r) return;
  if (title) box.append(el('p', title, 'muted small'));
  if (r.error) { box.append(el('div', r.error, 'notice bad')); return; }
  if (r.missing?.length) { box.append(el('div', 'Còn thiếu: ' + r.missing.join('; '), 'notice warn')); return; }
  if (r.state === 'faq' || r.state === 'uploads') return;
  if (r.lastError) box.append(el('div', 'Lần đọc gần nhất lỗi (đang dùng bản trước): ' + r.lastError, 'notice bad'));
  const src = r.source === 'gdrive' ? 'Google Drive' : 'SharePoint';
  const when = r.updatedAt ? ` · cập nhật ${new Date(r.updatedAt).toLocaleString('vi-VN')}` : '';
  const ok = r.filesRead > 0;
  box.append(el('div', `${ok ? '✓ ' : ''}${src}: đọc được ${r.filesRead} file (${r.chunks} đoạn), bỏ qua ${(r.skipped || []).length}${(r.errors || []).length ? `, lỗi ${r.errors.length}` : ''}${when}`, 'notice ' + (ok ? 'ok' : 'warn')));
  if (r.note) box.append(el('p', r.note, 'muted small'));
  if (r.truncated) box.append(el('p', 'Thư mục hơn 300 file — chỉ đọc 300 file đầu.', 'muted small'));
  const rows = [...(r.skipped || []).map((x) => [x.file, x.why]), ...(r.errors || []).map((x) => [x.file, 'Lỗi: ' + x.error])];
  if (rows.length) {
    const det = el('details'); det.append(el('summary', `Xem ${rows.length} file chưa đọc`));
    const wrap = el('div', null, 'tablewrap'); const t = el('table');
    for (const [a, b] of rows) { const tr = el('tr'); tr.append(el('td', a), el('td', b)); t.append(tr); }
    wrap.append(t); det.append(wrap); box.append(det);
  }
}

function renderDept(d, i) {
  const li = $('#tpl-dept').content.firstElementChild.cloneNode(true);
  li.dataset.uid = d.uid;
  li.style.setProperty('--c', d.color);
  const f = (c) => $(c, li);
  f('.d-color').value = d.color;
  f('.d-name').value = d.name;
  f('.d-folder').value = d.folder;
  f('.d-contact').value = d.contact || '';
  f('.d-scope').value = d.scope || '';
  f('.d-greeting').value = d.greeting || '';
  f('.d-suggest').value = d.suggestText || '';
  f('.d-del').disabled = depts.length <= 1;
  f('.d-del').title = depts.length <= 1 ? 'Cần ít nhất 1 phòng ban' : 'Xoá phòng ban';
  const st = stateBadge(d);
  f('.d-state').textContent = st.text; f('.d-state').className = 'd-state pill ' + st.cls; f('.d-state').hidden = !st.text;
  f('.d-state').title = st.tip || '';
  if (d.id && statusById[d.id] && !st.cls.includes('info')) renderResult(f('.d-result'), statusById[d.id]);
  if (d._test) renderResult(f('.d-result'), d._test, 'Kết quả kiểm tra (chưa lưu):');
  f('.d-name').placeholder = `Tên phòng ban ${i + 1}`;
  // Nguồn: hiện đúng một khối
  for (const b of li.querySelectorAll('.seg')) b.setAttribute('aria-pressed', String(b.dataset.src === d.source));
  f('.d-link').hidden = d.source !== 'link';
  f('.d-docs').hidden = d.source !== 'upload';
  const nDocs = d.id && docsById[d.id]?.docs?.length;
  f('.d-link-note').textContent = d.source === 'link' && nDocs ? `${nDocs} file đã tải lên trước đó đang tạm không dùng (vẫn giữ — chuyển lại "Tải file lên" là dùng tiếp).` : '';
  renderDocs(li, d);
  return li;
}

function render() {
  const list = $('#depts');
  list.replaceChildren(...depts.map(renderDept));
  $('#count').textContent = `${depts.length}/${MAX}`;
  $('#btn-add').disabled = depts.length >= MAX;
  $('#btn-add').title = depts.length >= MAX ? `Tối đa ${MAX} phòng ban` : '';
  syncChrome();
}

// Phần phụ thuộc link: thẻ SharePoint chỉ hiện khi có phòng dùng SharePoint; thanh Lưu khi có thay đổi.
function syncChrome() {
  const kinds = depts.map((d) => (d.source === 'link' ? kind(d.folder) : null));
  // Nhóm "Đọc thư mục qua link": tự mở tab SharePoint nếu chỉ có phòng dùng link SharePoint
  if (!folderTabTouched) setFolderTab(kinds.includes('sharepoint') && !kinds.includes('gdrive') ? 'sp' : 'gdrive');
  $('#savebar').hidden = !dirty();
  $('#save-msg').className = ''; $('#save-msg').textContent = 'Có thay đổi chưa lưu';
}

/* ---------- tải ---------- */
async function loadStatus() {
  const all = await Promise.all(depts.filter((d) => d.id).map((d) =>
    fetch('/api/kho?dept=' + encodeURIComponent(d.id)).then((r) => r.json()).then((j) => j.depts?.[0]).catch(() => null)));
  statusById = {};
  for (const s of all) if (s) statusById[s.id] = s;
  await Promise.all(depts.filter((d) => d.id).map(async (d) => {
    const r = await api('GET', '/api/admin/docs?dept=' + encodeURIComponent(d.id));
    docsById[d.id] = { ...(docsById[d.id] || {}), ...(r.ok ? r.data : { error: r.data.error }) };
  }));
  render();
}

/* ---------- tài liệu tải lên (D1) ---------- */
const docsById = {};         // id phòng → { dbReady, docs, used, limits, msg, cls, busy }
const MAX_FILE_MB = 30;
const kb = (n) => (!n ? '0 KB' : n >= 1e6 ? (n / 1e6).toFixed(2) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

function renderDocs(li, d) {
  const box = $('.d-docs', li), ul = $('.d-doclist', li), used = $('.d-docs-used', li), msg = $('.d-docs-msg', li);
  const pick = $('.filebtn', li), input = $('.d-file', li);
  const st = d.id ? docsById[d.id] : null;
  ul.replaceChildren();
  const disable = (why) => { pick.classList.add('disabled'); input.disabled = true; msg.textContent = why; msg.className = 'd-docs-msg small muted'; };
  pick.classList.remove('disabled'); input.disabled = false;
  if (!d.id) { used.textContent = ''; disable('Bấm Lưu để tạo phòng trước, rồi mới tải file lên.'); return; }
  if (!st) { used.textContent = ''; msg.textContent = ''; return; }
  if (st.dbReady === false) { used.textContent = ''; disable('Cần gắn database D1 (binding DB) để tải file lên — xem tab Thống kê.'); return; }
  if (st.error) { used.textContent = ''; msg.textContent = st.error; msg.className = 'd-docs-msg small err'; return; }
  const lim = st.limits || { deptBytes: 2e6, files: 50 };
  used.textContent = `${st.docs.length} file · ${kb(st.used)} / ${kb(lim.deptBytes)} chữ`;
  used.classList.toggle('warn-text', st.used > lim.deptBytes * 0.85);
  for (const doc of st.docs) {
    const row = el('li');
    row.append(el('span', '📄 ' + doc.name, 'doc-name'), el('span', `${kb(doc.bytes)} · ${new Date(doc.at).toLocaleDateString('vi-VN')}`, 'muted small'));
    const x = el('button', '×', 'icon small-icon');
    x.type = 'button'; x.title = 'Xoá file'; x.setAttribute('aria-label', 'Xoá file ' + doc.name);
    x.onclick = () => askDeleteDoc(d, doc.name);
    row.append(x);
    ul.append(row);
  }
  if (!st.docs.length) ul.append(el('li', 'Chưa có file nào.', 'muted small empty'));
  msg.textContent = st.msg || '';
  msg.className = 'd-docs-msg small ' + (st.cls || '');
  if (st.busy) disable(st.msg || 'Đang tải lên…');
}

// Rút CHỮ ngay trên trình duyệt (ảnh bỏ qua) — chỉ gửi chữ lên server.
let note = '';            // ghi chú của lần rút chữ gần nhất (vd PDF có trang scan)
async function extractText(file, onProgress = () => {}) {
  note = '';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'docx') return docxText(await file.arrayBuffer());
  if (ext === 'xlsx') return xlsxText(await file.arrayBuffer());
  if (['txt', 'md', 'csv'].includes(ext)) return file.text();
  if (ext === 'pdf') {
    const { pdfText } = await import('/admin/pdf-text.js');
    const r = await pdfText(await file.arrayBuffer(), onProgress);
    const notes = [];
    if (r.emptyPages) notes.push(`${r.emptyPages}/${r.pages} trang không có chữ (ảnh / scan) đã bỏ qua`);
    if (r.garbled) notes.push('một số chữ có dấu có thể bị sai (font trong PDF lỗi) — nếu bot trích sai, mở PDF bằng Word/Google Tài liệu rồi tải bản .docx');
    note = notes.join('; ');
    return r.text;
  }
  if (ext === 'doc' || ext === 'xls') throw new Error(`File .${ext} kiểu cũ — mở bằng Word/Excel rồi "Lưu thành" .${ext}x.`);
  throw new Error('Chỉ nhận .docx, .xlsx, .pdf, .txt, .md, .csv.');
}

async function uploadFiles(d, files) {
  const st = docsById[d.id] || (docsById[d.id] = {});
  const results = [];
  for (const [i, file] of [...files].entries()) {
    st.busy = true; st.cls = ''; st.msg = `Đang đọc ${file.name} (${i + 1}/${files.length})…`; render();
    try {
      if (file.size > MAX_FILE_MB * 1e6) throw new Error(`nặng ${(file.size / 1e6).toFixed(0)} MB — tối đa ${MAX_FILE_MB} MB.`);
      const text = await extractText(file, (p, n) => { st.msg = `Đang đọc ${file.name}: trang ${p}/${n}…`; render(); });
      const fileNote = note;
      const r = await api('PUT', '/api/admin/docs', { dept: d.id, name: file.name, text });
      if (!r.ok) throw new Error(r.data.error || `lỗi ${r.status}`);
      Object.assign(st, { docs: r.data.docs, used: r.data.used, limits: r.data.limits });
      results.push({ ok: true, name: file.name, replaced: r.data.replaced, note: fileNote });
    } catch (e) {
      results.push({ ok: false, name: file.name, error: String(e.message || e) });
    }
  }
  const bad = results.filter((x) => !x.ok), good = results.filter((x) => x.ok);
  st.busy = false;
  st.cls = !bad.length ? 'ok' : good.length ? '' : 'err';
  st.msg = [
    good.length ? `✓ Đã tải lên ${good.length} file${good.some((x) => x.replaced) ? ' (file trùng tên đã được thay bản mới)' : ''} — bot dùng được sau khoảng 15 giây.` : '',
    ...good.filter((x) => x.note).map((x) => `⚠ ${x.name}: ${x.note}`),
    ...bad.map((x) => `✗ ${x.name}: ${x.error}`),
  ].filter(Boolean).join('\n');
  render();
  refreshStatus(d.id);
}

async function refreshStatus(id) {
  const s = await fetch('/api/kho?dept=' + encodeURIComponent(id)).then((r) => r.json()).then((j) => j.depts?.[0]).catch(() => null);
  if (s) { statusById[id] = s; render(); }
}

function askDeleteDoc(d, name) {
  const dlg = $('#dlg-doc');
  $('#doc-name').textContent = name;
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const r = await api('DELETE', `/api/admin/docs?dept=${encodeURIComponent(d.id)}&name=${encodeURIComponent(name)}`);
    const st = docsById[d.id];
    if (r.ok) Object.assign(st, { docs: r.data.docs, used: r.data.used, msg: `Đã xoá ${name}.`, cls: 'ok' });
    else Object.assign(st, { msg: r.data.error || 'Xoá không được.', cls: 'err' });
    render();
    refreshStatus(d.id);
  };
  dlg.showModal();
}

async function load() {
  const r = await api('GET', '/api/admin/config');
  $('#login-btn').disabled = false; $('#login-btn').textContent = 'Đăng nhập';
  if (!r.ok) {
    document.body.dataset.view = 'login'; $('#app').hidden = true;
    if (r.status === 401) forget();                                    // mật khẩu cũ đã nhớ không còn đúng
    const e = $('#login-err'); e.hidden = false;
    e.textContent = r.status === 401 ? 'Mật khẩu không đúng.' : r.data.error || `Không kết nối được (lỗi ${r.status}).`;
    $('#admin-key').select();
    return;
  }
  document.body.dataset.view = 'app'; $('#app').hidden = false;
  const c = r.data;
  MAX = c.maxDepts || 8;
  depts = c.depts.map(fromSaved);
  $('#tenantId').value = c.tenantId || ''; $('#clientId').value = c.clientId || '';
  $('#ttl').value = String([300, 600, 1800, 3600].includes(c.ttl) ? c.ttl : 600);
  $('#stats-on').checked = c.stats !== false;
  $('#src-on').checked = c.showSources === true;
  statsOn = c.stats !== false; dbOk = Boolean(c.dbReady);
  saved = JSON.stringify(payload());
  $('#warn-kv').hidden = c.kvReady;
  $('#btn-save').disabled = !c.kvReady;
  kvOk = c.kvReady;
  renderKeys(c.secrets);
  renderWorkersAi(Boolean(c.workersAi));
  render();
  loadStatus();
  if (activeTab === 'stats') loadStats();
}

/* ---------- sự kiện ---------- */
function forget() {
  try { sessionStorage.removeItem('adminKey'); localStorage.removeItem('adminKey'); } catch { /* bỏ qua */ }
}
$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $('#admin-key').value.trim();
  const err = $('#login-err');
  if (!key) { err.hidden = false; err.textContent = 'Nhập mật khẩu.'; $('#admin-key').focus(); return; }
  err.hidden = true;
  forget();
  try { ($('#remember').checked ? localStorage : sessionStorage).setItem('adminKey', key); } catch { /* bỏ qua */ }
  $('#login-btn').disabled = true; $('#login-btn').textContent = 'Đang vào…';
  load();
});
$('#pw-eye').addEventListener('click', () => {
  const i = $('#admin-key'); const show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  $('#pw-eye').setAttribute('aria-pressed', String(show));
  $('#pw-eye').setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  i.focus();
});
$('#admin-key').addEventListener('input', () => { $('#login-err').hidden = true; });
$('#logout').addEventListener('click', () => {
  forget(); key = '';
  $('#admin-key').value = ''; $('#app').hidden = true; document.body.dataset.view = 'login';
  $('#admin-key').focus();
});

const deptOf = (node) => depts.find((d) => String(d.uid) === node.closest('.dept')?.dataset.uid);
const FIELD = { 'd-name': 'name', 'd-folder': 'folder', 'd-contact': 'contact', 'd-scope': 'scope', 'd-color': 'color', 'd-greeting': 'greeting', 'd-suggest': 'suggestText' };

$('#depts').addEventListener('input', (e) => {
  const d = deptOf(e.target);
  const k = FIELD[[...e.target.classList].find((c) => FIELD[c])];
  if (!d || !k) return;
  d[k] = e.target.value;
  if (k === 'color') e.target.closest('.dept').style.setProperty('--c', d.color);
  if (k === 'folder') {
    d._test = null;
    const li = e.target.closest('.dept');
    const st = stateBadge(d); const p = $('.d-state', li);
    p.textContent = st.text; p.className = 'd-state pill ' + st.cls; p.hidden = !st.text;
    const bad = kind(d.folder) === 'bad';
    renderResult($('.d-result', li), bad ? { error: 'Link này không phải thư mục Google Drive hoặc SharePoint. Mở thư mục trên trình duyệt → copy thanh địa chỉ.' } : null);
  }
  syncChrome();
});

$('#depts').addEventListener('change', (e) => {
  if (!e.target.matches('.d-file')) return;
  const d = deptOf(e.target);
  const files = [...e.target.files];
  e.target.value = '';
  if (d && d.id && files.length) uploadFiles(d, files);
});

$('#depts').addEventListener('click', async (e) => {
  const d = deptOf(e.target);
  if (!d) return;
  if (e.target.closest('.d-test')) {
    const b = e.target.closest('.d-test');
    const box = $('.d-result', b.closest('.dept'));
    if (!d.folder.trim()) { renderResult(box, { error: 'Dán link thư mục trước khi kiểm tra.' }); return; }
    b.disabled = true; b.textContent = 'Đang đọc thử…';
    const r = await api('POST', '/api/admin/test', { folder: d.folder, tenantId: $('#tenantId').value, clientId: $('#clientId').value });
    b.disabled = false; b.textContent = 'Kiểm tra';
    d._test = r.status === 401 || r.status === 503 ? { error: r.data.error } : { ...r.data, error: r.data.ok === false && !r.data.filesRead ? r.data.error : undefined };
    renderResult(box, d._test, 'Kết quả kiểm tra (chưa lưu):');
  }
  if (e.target.closest('.seg')) {
    const src = e.target.closest('.seg').dataset.src;
    if (src !== d.source) { d.source = src; d._test = null; render(); }
  }
  if (e.target.closest('.d-del')) askDelete(d);
});

function askDelete(d) {
  if (depts.length <= 1) return;
  const dlg = $('#dlg-del');
  $('#del-name').textContent = d.name.trim() || 'chưa đặt tên';
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    depts = depts.filter((x) => x !== d);
    render();
  };
  dlg.showModal();
}

$('#btn-add').addEventListener('click', () => {
  if (depts.length >= MAX) return;
  const used = new Set(depts.map((d) => d.color));
  depts.push({ uid: ++uidSeq, name: '', source: 'upload', folder: '', contact: '', scope: '', greeting: '', suggestText: '', color: PALETTE.find((c) => !used.has(c)) || PALETTE[depts.length % PALETTE.length] });
  render();
  const last = $('#depts').lastElementChild;
  last.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('.d-name', last).focus();
});

['#tenantId', '#clientId', '#ttl', '#stats-on', '#src-on'].forEach((s) => $(s).addEventListener('input', syncChrome));
$('#stats-on').addEventListener('change', syncChrome);
$('#src-on').addEventListener('change', syncChrome);

$('#btn-reset').addEventListener('click', () => {
  const s = JSON.parse(saved);
  depts = s.depts.map(fromSaved);
  $('#tenantId').value = s.tenantId; $('#clientId').value = s.clientId; $('#ttl').value = String(s.ttl); $('#stats-on').checked = s.stats; $('#src-on').checked = Boolean(s.showSources);
  render();
});

$('#btn-save').addEventListener('click', async () => {
  const msg = $('#save-msg');
  const empty = depts.findIndex((d) => !d.name.trim());
  if (empty >= 0) {
    msg.className = 'err'; msg.textContent = `Phòng ban thứ ${empty + 1} chưa có tên.`;
    $('.d-name', $('#depts').children[empty]).focus();
    return;
  }
  const b = $('#btn-save'); b.disabled = true;
  const r = await api('PUT', '/api/admin/config', payload());
  b.disabled = false;
  if (!r.ok) { msg.className = 'err'; msg.textContent = r.data.error || 'Lưu không được.'; return; }
  msg.className = ''; msg.textContent = '✓ Đã lưu — bản đồ cập nhật trong khoảng 30 giây.';
  setTimeout(load, 1200);
});

/* ---------- khoá kết nối: chỉ ghi, không đọc lại ---------- */
let kvOk = false;
const KEY_LABEL = { GOOGLE_SA_KEY: 'Google Drive', ANTHROPIC_API_KEY: 'AI (Claude)', GEMINI_API_KEY: 'AI (Gemini)', SHAREPOINT_CLIENT_SECRET: 'SharePoint' };
const KEY_EFFECT = {
  GOOGLE_SA_KEY: 'Bot sẽ không đọc được tài liệu trên Google Drive nữa — các phòng dùng link Drive quay về chỉ trả lời từ FAQ.',
  ANTHROPIC_API_KEY: 'Bot quay về chế độ trích nguyên đoạn tài liệu khớp nhất (không dùng AI).',
  GEMINI_API_KEY: 'Bot quay về chế độ trích nguyên đoạn tài liệu khớp nhất (không dùng AI).',
  SHAREPOINT_CLIENT_SECRET: 'Bot sẽ không đọc được tài liệu trên SharePoint nữa.',
};

function renderWorkersAi(on) {
  const el = $('#wai-state');
  el.textContent = on ? 'Đã gắn ✓' : 'Chưa gắn';
  el.className = 'pill ' + (on ? 'ok' : 'bad');
  $('#wai-help').open = !on && $('#wai-help').open;
}
function renderKeys(sec) {
  document.querySelectorAll('.key').forEach((box) => {
    let k = box.dataset.key;
    if (k === 'AI') {                                   // một ô cho AI: hiện hãng đang dùng (Claude ưu tiên nếu có cả hai)
      k = sec.ANTHROPIC_API_KEY?.set ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
      box.dataset.active = sec[k]?.set ? k : '';
    }
    const st = sec[k] || {};
    const pillEl = $('.k-state', box);
    pillEl.textContent = !st.set ? 'Chưa có' : st.source === 'admin' ? 'Đã có' : 'Đã có · đặt trên Cloudflare';
    pillEl.className = 'k-state pill ' + (st.set ? 'ok' : 'bad');
    if (st.set && box.dataset.key === 'AI') pillEl.textContent = (k === 'ANTHROPIC_API_KEY' ? 'Claude' : 'Gemini') + ' · ' + pillEl.textContent.replace(/^Đã có/, 'đã bật');
    if (st.set && st.hint && k !== 'GOOGLE_SA_KEY') pillEl.textContent += ' · ' + st.hint;
    const share = $('.k-share', box);
    if (share) { share.hidden = !(st.set && st.hint && st.hint.includes('@')); if (!share.hidden) $('.k-hint', share).textContent = st.hint; }
    editing(box, !st.set);
    $('.k-del', box).hidden = st.source !== 'admin';                 // khoá đặt trên Cloudflare thì xoá ở Cloudflare
    $('.k-cancel', box).hidden = !st.set;
    box.dataset.set = st.set ? '1' : '';
    $('.k-save', box).disabled = !kvOk;
    if (!kvOk) msg(box, 'Cần gắn KV CONFIG trước mới lưu khoá được.', 'err');
  });
  folderSummary(sec);
}
let folderTabTouched = false;
function setFolderTab(t) {
  document.querySelectorAll('#grp-folder .seg').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ftab === t)));
  document.querySelectorAll('#grp-folder .ftab').forEach((p) => { p.hidden = p.dataset.ftab !== t; });
}
document.querySelectorAll('#grp-folder .seg').forEach((b) => b.addEventListener('click', () => { folderTabTouched = true; setFolderTab(b.dataset.ftab); }));
function folderSummary(sec) {
  const g = sec.GOOGLE_SA_KEY?.set, sp = sec.SHAREPOINT_CLIENT_SECRET?.set;
  const el = $('#folder-state');
  el.textContent = g && sp ? 'Drive ✓ · SharePoint ✓' : g ? 'Drive ✓' : sp ? 'SharePoint ✓' : 'Chưa kết nối';
  el.className = 'pill ' + (g || sp ? 'ok' : 'bad');
  document.querySelectorAll('#grp-folder .dot').forEach((d) => d.classList.toggle('on', Boolean(sec[d.dataset.for]?.set)));
}

function editing(box, on) {
  $('.k-edit', box).hidden = !on;
  $('.k-actions', box).hidden = on;
  if (!on) $('.k-input', box).value = '';
}
function msg(box, text, cls = '') { const m = $('.k-msg', box); m.textContent = text; m.className = 'k-msg small ' + cls; }

// Ô AI: nhận hãng theo đầu key
const aiNameOf = (v) => (/^sk-ant-/.test(v) ? 'ANTHROPIC_API_KEY' : /^(AIza|AQ\.)/.test(v) ? 'GEMINI_API_KEY' : null);

async function saveKey(box, value) {
  let k = box.dataset.key;
  if (k === 'AI') {
    k = value ? aiNameOf(value) : box.dataset.active;
    if (!k) { msg(box, value ? 'Không nhận ra key: key Gemini bắt đầu bằng AIza… hoặc AQ.…, key Claude bắt đầu bằng sk-ant-…' : 'Chưa có khoá AI nào.', 'err'); return; }
  }
  const b = $('.k-save', box); b.disabled = true;
  const r = await api('PUT', '/api/admin/secrets', { name: k, value });
  b.disabled = false;
  if (!r.ok) { msg(box, r.data.error || 'Lưu không được.', 'err'); return; }
  renderKeys(r.data.secrets);
  msg(box, value ? '✓ Đã lưu — có hiệu lực trong khoảng 30 giây.' : '✓ Đã xoá khoá.', 'ok');
  loadStatus();
}

$('#app').addEventListener('click', (e) => {
  const box = e.target.closest('.key');
  if (!box) return;
  if (e.target.closest('.k-save')) {
    const v = $('.k-input', box).value.trim();
    if (!v) { msg(box, 'Chưa nhập khoá.', 'err'); $('.k-input', box).focus(); return; }
    saveKey(box, v);
  }
  if (e.target.closest('.k-aitest')) {
    const b = e.target.closest('.k-aitest'); b.disabled = true;
    msg(box, 'Đang thử…');
    api('POST', '/api/admin/ai-test', {}).then((r) => {
      const d = r.data || {};
      if (!d.results || !d.results.length) { msg(box, `✗ ${d.error || 'Không thử được.'}`, 'err'); return; }
      const lines = d.results.map((x) => (x.ok ? `✓ ${x.name} (${x.model}) chạy được` : `✗ ${x.name}: ${x.error}`));
      const act = d.results.find((x) => x.ok);
      lines.push(act ? `→ Bot đang trả lời bằng ${act.name}.` : '→ Chưa AI nào chạy được — bot tự trích tài liệu.');
      if (d.lastError) {
        const t = new Date(d.lastError.at).toLocaleString('vi-VN');
        lines.push('', `Lần chat gần nhất AI lỗi: ${t}${d.lastError.colo ? ' · máy chủ ' + d.lastError.colo : ''}`);
        for (const x of d.lastError.errors) lines.push(`  · ${x.name}: ${x.error}`);
      }
      if (d.colo) lines.push(`(Máy chủ Cloudflare đang chạy: ${d.colo}${d.colo === 'HKG' ? ' = Hồng Kông' : d.colo === 'SIN' ? ' = Singapore' : d.colo === 'HAN' ? ' = Hà Nội' : d.colo === 'SGN' ? ' = TP.HCM' : ''})`);
      msg(box, lines.join('\n'), act ? 'ok' : 'err');
    }).finally(() => { b.disabled = false; });
  }
  if (e.target.closest('.k-change')) { editing(box, true); msg(box, ''); $('.k-input', box).focus(); }
  if (e.target.closest('.k-cancel')) { editing(box, false); msg(box, ''); }
  if (e.target.closest('.k-copy')) {
    const code = $('.k-hint', box);
    navigator.clipboard.writeText(code.textContent).then(() => { e.target.textContent = 'Đã copy'; })
      .catch(() => { const r = document.createRange(); r.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(r); });
  }
  if (e.target.closest('.k-del')) {
    const dlg = $('#dlg-key');
    const kk = box.dataset.key === 'AI' ? box.dataset.active : box.dataset.key;
    $('#key-name').textContent = KEY_LABEL[kk] || 'AI';
    $('#key-body').textContent = KEY_EFFECT[kk] || '';
    dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'ok') saveKey(box, ''); };
    dlg.showModal();
  }
});

// Chọn file key.json: đọc ngay trên trình duyệt, không gửi đi đâu cho tới khi bấm Lưu.
$('#app').addEventListener('change', async (e) => {
  if (!e.target.matches('.k-file')) return;
  const box = e.target.closest('.key'); const f = e.target.files[0];
  if (!f) return;
  if (f.size > 20000) { msg(box, 'File quá lớn — key.json chỉ vài KB.', 'err'); return; }
  $('.k-input', box).value = await f.text();
  e.target.value = '';
  msg(box, `Đã nạp ${f.name} — bấm “Lưu khoá”.`);
});

/* ---------- Thống kê ---------- */
let statsOn = true, dbOk = false, activeTab = 'stats';
let deptNames = {};
const fmtDate = (ms) => new Date(ms).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function setTab(t) {
  activeTab = t;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $('#tab-stats').hidden = t !== 'stats';
  $('#tab-config').hidden = t !== 'config';
  try { localStorage.setItem('adminTab', t); } catch { /* bỏ qua */ }
  if (t === 'stats') loadStats();
}
document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
try { const t = localStorage.getItem('adminTab'); if (t === 'config' || t === 'stats') activeTab = t; } catch { /* bỏ qua */ }
document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === activeTab)));
$('#tab-stats').hidden = activeTab !== 'stats';
$('#tab-config').hidden = activeTab !== 'config';

function table(el, head, rows) {
  const t = $(el);
  t.replaceChildren();
  const hr = document.createElement('tr');
  for (const h of head) hr.append(Object.assign(document.createElement('th'), { textContent: h }));
  t.append(hr);
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const c of r) {
      const td = document.createElement('td');
      if (c instanceof Node) td.append(c); else td.textContent = c;
      tr.append(td);
    }
    t.append(tr);
  }
}
const deptChip = (id) => {
  const d = depts.find((x) => x.id === id);
  const s = document.createElement('span');
  s.className = 'dchip';
  s.style.setProperty('--c', d?.color || '#8a8f9c');
  s.textContent = deptNames[id] || d?.name || id;
  return s;
};

async function loadStats() {
  if (!key) return;
  const days = Number($('#st-days').value);
  const r = await api('GET', '/api/admin/stats?days=' + days);
  const cards = ['#stats-card', '#st-miss-card', '#st-down-card', '#st-top-card'];
  if (!r.ok || !r.data.dbReady) {
    $('#warn-db').hidden = !(r.ok && !r.data.dbReady);
    cards.forEach((c) => { $(c).hidden = true; });
    if (!r.ok) { $('#warn-db').hidden = false; $('#warn-db').textContent = r.data.error || 'Không tải được thống kê.'; }
    return;
  }
  const s = r.data;
  deptNames = s.names || {};
  $('#warn-db').hidden = true;
  cards.forEach((c) => { $(c).hidden = false; });
  $('#st-off').hidden = statsOn;

  // Ô số liệu
  const tiles = $('#st-tiles');
  tiles.replaceChildren();
  const tile = (v, label, sub, cls = '') => {
    const d = el('div', null, 'tile ' + cls);
    d.append(el('b', v), el('span', label));
    if (sub) d.append(el('small', sub));
    tiles.append(d);
  };
  tile(String(s.total), 'câu hỏi', `${s.days} ngày qua${s.auto ? ` · ${s.auto} hỏi chung` : ''}`);
  const known = s.answered + s.missed;
  tile(pct(s.answered, known) + '%', 'trả lời được', `${s.answered}/${known} câu`, 'good');
  tile(String(s.missed), 'chưa trả lời được', s.missed ? 'xem danh sách bên dưới' : '', s.missed ? 'warn' : '');
  tile(`${s.up} · ${s.down}`, '👍 hữu ích · 👎 chưa tốt', s.up + s.down ? `${pct(s.up, s.up + s.down)}% hài lòng` : 'chưa có đánh giá');

  // Theo ngày: đủ mọi ngày trong khoảng (ngày không có câu hỏi = 0)
  const byDay = new Map(s.byDay.map((x) => [x.day, x]));
  const daysArr = [];
  const today = new Date(Date.now() + 420 * 60000);
  for (let i = s.days - 1; i >= 0; i--) daysArr.push(new Date(today - i * 864e5).toISOString().slice(0, 10));
  const max = Math.max(1, ...daysArr.map((d) => byDay.get(d)?.n || 0));
  const cols = $('#st-days-chart');
  cols.replaceChildren();
  cols.style.setProperty('--n', daysArr.length);
  for (const d of daysArr) {
    const x = byDay.get(d) || { n: 0, miss: 0 };
    const col = el('div', null, 'col');
    const bar = el('i');
    bar.style.height = (x.n / max) * 100 + '%';
    const miss = el('i', null, 'miss');
    miss.style.height = (x.miss / max) * 100 + '%';
    col.append(bar, miss);
    const [, m, dd] = d.split('-');
    col.dataset.tip = `${dd}/${m}: ${x.n} câu${x.miss ? ` · ${x.miss} chưa trả lời được` : ''}`;
    col.setAttribute('aria-label', col.dataset.tip);
    col.tabIndex = 0;
    cols.append(col);
  }
  const axis = el('div', null, 'cols-axis');
  const first = daysArr[0].split('-'), last = daysArr[daysArr.length - 1].split('-');
  axis.append(el('span', `${first[2]}/${first[1]}`), el('span', `đỉnh ${max} câu/ngày`), el('span', `${last[2]}/${last[1]}`));
  cols.after(axis);
  cols.parentElement.querySelectorAll('.cols-axis').forEach((n, i, all) => { if (i < all.length - 1) n.remove(); });

  // Theo phòng
  const hb = $('#st-dept-chart');
  hb.replaceChildren();
  const dmax = Math.max(1, ...s.byDept.map((x) => x.n));
  if (!s.byDept.length) hb.append(el('p', 'Chưa có câu hỏi nào.', 'muted'));
  for (const x of s.byDept) {
    const row = el('div', null, 'hbar');
    const name = deptChip(x.dept);
    const track = el('div', null, 'track');
    const fill = el('i');
    fill.style.width = (x.n / dmax) * 100 + '%';
    fill.style.setProperty('--c', depts.find((d) => d.id === x.dept)?.color || '#8a8f9c');
    track.append(fill);
    const v = el('span', `${x.n}${x.miss ? ` · ${x.miss} chưa TL` : ''}${x.down ? ` · ${x.down}👎` : ''}`, 'val');
    row.append(name, track, v);
    hb.append(row);
  }

  table('#st-miss', ['Câu hỏi', 'Phòng', 'Số lần', 'Lần cuối'], s.unanswered.map((x) => [x.question, deptChip(x.dept), String(x.n), fmtDate(x.last)]));
  $('#st-miss-card').hidden = !s.unanswered.length;
  table('#st-down', ['Câu hỏi', 'Phòng', 'Tài liệu đã dùng', 'Lúc'], s.disliked.map((x) => [x.question, deptChip(x.dept), (x.sources || []).map((n) => n.split('/').pop()).join(', ') || '—', fmtDate(x.at)]));
  $('#st-down-card').hidden = !s.disliked.length;
  table('#st-top', ['Câu hỏi', 'Phòng', 'Số lần'], s.top.map((x) => [x.question, deptChip(x.dept), String(x.n)]));
  if (!s.top.length) table('#st-top', ['Câu hỏi', 'Phòng', 'Số lần'], [['Chưa có câu nào được hỏi từ 2 lần trở lên.', '', '']]);
  table('#st-recent', ['Lúc', 'Câu hỏi', 'Phòng', 'Trả lời', 'Đánh giá'], s.recent.map((x) => [fmtDate(x.at), x.question, deptChip(x.dept),
    x.answered === 1 ? '✓' : x.answered === 0 ? '✗ chưa' : '…', x.rating === 1 ? '👍' : x.rating === -1 ? '👎' : '']));
  if (!s.total) { $('#st-top-card').hidden = true; }
}
$('#st-days').addEventListener('change', loadStats);
$('#st-refresh').addEventListener('click', loadStats);
$('#st-csv').addEventListener('click', async () => {
  const res = await fetch('/api/admin/stats?format=csv&days=' + $('#st-days').value, { headers: { 'x-admin-key': key } });
  if (!res.ok) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = `dept-chat-cau-hoi-${$('#st-days').value}ngay.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('#st-clear').addEventListener('click', () => {
  const dlg = $('#dlg-clear');
  dlg.returnValue = '';
  dlg.onclose = async () => { if (dlg.returnValue === 'ok') { await api('DELETE', '/api/admin/stats'); loadStats(); } };
  dlg.showModal();
});

window.addEventListener('beforeunload', (e) => { if (saved && dirty()) e.preventDefault(); });

if (key) { document.body.dataset.view = 'loading'; load(); } else $('#admin-key').focus();
