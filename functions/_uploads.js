/* Tài liệu TẢI LÊN trực tiếp ở trang admin — lưu trong D1 (binding `DB`), không cần Drive/SharePoint.
 *
 * Trình duyệt tự rút chữ khỏi .docx/.xlsx (ảnh bỏ qua) rồi chỉ gửi CHỮ lên → file nặng vẫn tải
 * được, server không tốn CPU giải nén. Mỗi file một hàng: chữ đã chia đoạn (JSON).
 * Tải lại cùng tên = thay bản cũ.
 */
import { chunkText } from './_kho-lib.js';
import { dbReady } from './_stats.js';

export const UPLOAD_LIMITS = { files: 50, deptBytes: 2_000_000, fileBytes: 1_000_000, nameLen: 150 };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
     dept TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL,
     chunks TEXT NOT NULL, PRIMARY KEY (dept, name))`,
];
const ready = new WeakSet();
async function ensure(db) {
  if (ready.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  ready.add(db);
}

const bytesOf = (s) => new TextEncoder().encode(s).length;

/** Chuẩn hoá tên file: bỏ đường dẫn, ký tự điều khiển; giữ dấu tiếng Việt. */
export function cleanName(name) {
  return String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, UPLOAD_LIMITS.nameLen);
}

export async function listDocs(env, dept) {
  if (!dbReady(env)) return [];
  await ensure(env.DB);
  const r = await env.DB.prepare('SELECT name, at, bytes, json_array_length(chunks) n FROM docs WHERE dept = ? ORDER BY name').bind(dept).all();
  return (r.results || []).map((x) => ({ name: x.name, at: Number(x.at), bytes: Number(x.bytes), chunks: Number(x.n) }));
}

/** Lưu (hoặc thay) một file. Trả { doc, used } hoặc { error }. */
export async function saveDoc(env, dept, rawName, text, now = Date.now()) {
  if (!dbReady(env)) return { error: 'Chưa gắn database D1 (binding DB) — xem hướng dẫn ở tab Thống kê.' };
  const name = cleanName(rawName);
  if (!name) return { error: 'Thiếu tên file.' };
  const body = String(text || '').replace(/\r/g, '').trim();
  if (!body) return { error: `"${name}" không có chữ nào đọc được (file toàn ảnh / bản scan?).` };
  const bytes = bytesOf(body);
  if (bytes > UPLOAD_LIMITS.fileBytes) return { error: `"${name}" có ${(bytes / 1e6).toFixed(1)} MB chữ — tối đa ${UPLOAD_LIMITS.fileBytes / 1e6} MB mỗi file. Tách thành nhiều file nhỏ hơn.` };
  const existing = await listDocs(env, dept);
  const others = existing.filter((d) => d.name !== name);
  if (others.length >= UPLOAD_LIMITS.files) return { error: `Phòng này đã có ${others.length} file — tối đa ${UPLOAD_LIMITS.files}.` };
  const used = others.reduce((s, d) => s + d.bytes, 0);
  if (used + bytes > UPLOAD_LIMITS.deptBytes) {
    return { error: `Vượt dung lượng chữ của phòng: đã dùng ${(used / 1e3).toFixed(0)} KB + file này ${(bytes / 1e3).toFixed(0)} KB > ${UPLOAD_LIMITS.deptBytes / 1e6} MB (≈ 500–600 trang). Xoá bớt file cũ.` };
  }
  const chunks = chunkText(body);
  await env.DB.prepare('INSERT OR REPLACE INTO docs (dept, name, at, bytes, chunks) VALUES (?, ?, ?, ?, ?)')
    .bind(dept, name, now, bytes, JSON.stringify(chunks)).run();
  bump(dept);
  return { doc: { name, at: now, bytes, chunks: chunks.length }, used: used + bytes, replaced: others.length !== existing.length };
}

export async function deleteDoc(env, dept, name) {
  if (!dbReady(env)) return false;
  await ensure(env.DB);
  const r = await env.DB.prepare('DELETE FROM docs WHERE dept = ? AND name = ?').bind(dept, cleanName(name)).run();
  bump(dept);
  return (r.meta?.changes ?? 0) > 0;
}

/** Xoá file của các phòng không còn trong danh sách (khi admin xoá phòng). */
export async function deleteDocsExcept(env, keepIds) {
  if (!dbReady(env)) return;
  await ensure(env.DB);
  const ids = [...keepIds];
  const q = ids.length ? `DELETE FROM docs WHERE dept NOT IN (${ids.map(() => '?').join(',')})` : 'DELETE FROM docs';
  await env.DB.prepare(q).bind(...ids).run();
  cache.clear();
}

/* Đoạn tài liệu của một phòng cho bot tìm. Đệm trong RAM theo "dấu phiên bản" (số file + lần sửa
 * mới nhất): chưa đổi thì trả NGUYÊN mảng cũ → chỉ mục tìm kiếm không phải dựng lại mỗi câu hỏi. */
const cache = new Map();   // dept → { sig, chunks, at }
function bump(dept) { cache.delete(dept); }

export async function uploadedChunks(env, dept, now = Date.now()) {
  if (!dbReady(env)) return EMPTY;
  const hit = cache.get(dept);
  if (hit && now - hit.at < 15_000) return hit.chunks;            // 15 giây: khỏi hỏi D1 mỗi câu
  try {
    await ensure(env.DB);
    const sig = await env.DB.prepare('SELECT COUNT(*) n, MAX(at) m FROM docs WHERE dept = ?').bind(dept).first();
    const key = `${sig?.n || 0}:${sig?.m || 0}`;
    if (hit && hit.sig === key) { hit.at = now; return hit.chunks; }
    let chunks = EMPTY;
    if (Number(sig?.n)) {
      const r = await env.DB.prepare('SELECT name, chunks FROM docs WHERE dept = ? ORDER BY name').bind(dept).all();
      chunks = [];
      for (const row of r.results || []) {
        JSON.parse(row.chunks).forEach((t, i) => chunks.push({ source: row.name, part: i + 1, text: t, url: null, uploaded: true }));
      }
    }
    cache.set(dept, { sig: key, chunks, at: now });
    return chunks;
  } catch (e) {
    console.warn('[uploads] đọc lỗi:', e.message);
    return hit ? hit.chunks : EMPTY;
  }
}
const EMPTY = Object.freeze([]);

export function _resetUploads() { cache.clear(); }
