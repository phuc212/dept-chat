#!/usr/bin/env node
/* Nạp KHO TÀI LIỆU cho chatbot: đọc thư mục tài liệu → chuyển thành chữ → chia đoạn →
 * ghi functions/_kho.js (chỉ server đọc, trình duyệt KHÔNG tải được file này).
 *
 *   node tools/build-kho.mjs                     # đọc ./kho
 *   node tools/build-kho.mjs "D:\OneDrive - Cty\Tai lieu chatbot"
 *   KHO_DIR="..." node tools/build-kho.mjs
 *   node tools/build-kho.mjs --if-missing        # chỉ tạo file rỗng nếu chưa có (cho test/dev)
 *
 * Cấu trúc thư mục: mỗi bộ phận một thư mục con, tên = id hoặc tên bộ phận trong depts.js:
 *   <kho>/Kế toán/…  <kho>/nhansu/…  <kho>/Phát triển/…   (thư mục con sâu hơn cũng được)
 *   File ở gốc / thư mục không khớp bộ phận nào → kho chung, bộ phận nào cũng tìm được.
 *
 * Lấy từ SharePoint / Google Drive KHÔNG cần API: bấm "Sync" (OneDrive) trên thư viện
 * SharePoint, hoặc cài Google Drive for desktop — thư mục hiện ra trên máy như thư mục thường,
 * trỏ script này vào đó. Sửa tài liệu trên SharePoint/Drive → chạy lại script → deploy.
 *
 * Định dạng: .md .txt (có sẵn) · .docx (cần `mammoth`) · .pdf (cần `unpdf`) · .xlsx (cần
 * `exceljs`). Thiếu thư viện nào thì bỏ qua loại file đó và báo — không hỏng cả lượt.
 * Cài một lần: npm i -D mammoth unpdf exceljs
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPTS } from '../public/shared/depts.js';
import { chunkText, deptIdForFolder, CHUNK_CHARS, MAX_FILE_MB } from '../functions/_kho-lib.js';

export { chunkText, deptIdForFolder, CHUNK_CHARS };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'functions/_kho.js');
async function tryImport(name) {
  try { return await import(name); } catch { return null; }
}

const warned = new Set();
function warnOnce(key, msg) { if (!warned.has(key)) { warned.add(key); console.warn('· ' + msg); } }

/** Đọc một file thành chữ; null = bỏ qua. */
async function toText(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.md' || ext === '.txt' || ext === '.csv') return readFileSync(file, 'utf8');
  if (ext === '.docx') {
    const m = await tryImport('mammoth');
    if (!m) return warnOnce('docx', 'Bỏ qua .docx — chưa cài: npm i -D mammoth'), null;
    const { value } = await (m.default || m).extractRawText({ path: file });
    return value;
  }
  if (ext === '.pdf') {
    const u = await tryImport('unpdf');
    if (!u) return warnOnce('pdf', 'Bỏ qua .pdf — chưa cài: npm i -D unpdf'), null;
    const { text } = await u.extractText(new Uint8Array(readFileSync(file)), { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join('\n\n');
  }
  if (ext === '.xlsx') {
    const E = await tryImport('exceljs');
    if (!E) return warnOnce('xlsx', 'Bỏ qua .xlsx — chưa cài: npm i -D exceljs'), null;
    const wb = new (E.default || E).Workbook();
    await wb.xlsx.readFile(file);
    const parts = [];
    wb.eachSheet((ws) => {
      const rows = [];
      ws.eachRow((row) => {
        const cells = row.values.slice(1).map((v) => (v && typeof v === 'object' ? (v.text ?? v.result ?? '') : v ?? ''));
        if (cells.some((c) => String(c).trim())) rows.push(cells.join(' | '));
      });
      if (rows.length) parts.push(`Sheet ${ws.name}:\n` + rows.join('\n'));
    });
    return parts.join('\n\n');
  }
  if (['.doc', '.xls', '.ppt', '.pptx'].includes(ext)) {
    warnOnce(ext, `Bỏ qua ${ext} — lưu lại thành .docx/.xlsx/.pdf rồi chạy lại.`);
  }
  return null;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name.startsWith('~$')) continue;   // file ẩn, file tạm của Office
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function writeOut(kho, note) {
  const body = `/* SINH TỰ ĐỘNG bởi tools/build-kho.mjs — ĐỪNG sửa tay, ĐỪNG commit (có trong .gitignore).
 * ${note}
 * Chỉ functions/ import file này → nằm trong bundle server, trình duyệt không tải được. */
export default ${JSON.stringify(kho)};
`;
  writeFileSync(OUT, body);
}

/** Đọc cả thư mục kho → { <deptId>: [đoạn], _chung: [đoạn] } và ghi functions/_kho.js.
 *  File nằm thẳng ở gốc, hoặc trong thư mục con không khớp bộ phận nào, vào `_chung`
 *  (mọi bộ phận đều tìm được) — vì thư mục của người dùng không phải lúc nào cũng chia sẵn. */
export async function buildKho(dir, label = dir) {
  if (!existsSync(dir)) throw new Error(`Không thấy thư mục kho: ${dir}`);
  const kho = {};
  const add = async (key, base, f) => {
    if (statSync(f).size > MAX_FILE_MB * 1024 * 1024) { console.warn(`· Bỏ qua (>${MAX_FILE_MB}MB): ${f}`); return 0; }
    let text;
    try { text = await toText(f); } catch (e) { console.warn(`· Lỗi đọc ${f}: ${e.message}`); return 0; }
    if (!text || !text.trim()) return 0;
    const source = relative(base, f).split(sep).join('/');
    (kho[key] ||= []).push(...chunkText(text).map((t, i) => ({ source, part: i + 1, text: t })));
    return 1;
  };
  let files = 0;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const id = deptIdForFolder(name);
      if (!id) console.warn(`· Thư mục "${name}" không khớp bộ phận nào → đưa vào kho chung`);
      for (const f of walk(p)) files += await add(id || '_chung', id ? p : dir, f);
    } else {
      files += await add('_chung', dir, p);
    }
  }
  let chunks = 0;
  for (const d of [...DEPTS, { id: '_chung', name: 'Kho chung (mọi bộ phận)' }]) {
    const list = kho[d.id] || [];
    chunks += list.length;
    if (list.length || d.id !== '_chung') {
      console.log(`${list.length ? '✓' : '·'} ${d.name}: ${new Set(list.map((c) => c.source)).size} file, ${list.length} đoạn`);
    }
  }
  writeOut(kho, `Từ: ${label} · ${files} file · ${chunks} đoạn · ${new Date().toISOString()}`);
  const kb = Buffer.byteLength(readFileSync(OUT)) / 1024;
  console.log(`→ functions/_kho.js (${kb.toFixed(0)} KB)`);
  if (kb > 8000) console.warn('· Kho lớn (>8 MB) — Pages Functions giới hạn kích thước bundle, nên lọc bớt tài liệu.');
  return kho;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--if-missing')) {
    if (!existsSync(OUT)) writeOut({}, 'Kho rỗng.');
    return;
  }
  const dir = args.find((a) => !a.startsWith('--')) || process.env.KHO_DIR || join(root, 'kho');
  try { await buildKho(dir); } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
