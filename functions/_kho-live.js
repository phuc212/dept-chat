/* KHO SỐNG theo TỪNG PHÒNG BAN: mỗi phòng đọc đúng thư mục của mình (link ở /admin/).
 *
 * Mỗi câu hỏi chỉ đọc kho của phòng đang hỏi → ít lượt gọi ra ngoài, dữ liệu các phòng tách hẳn.
 * Bộ nhớ đệm 2 tầng theo từng phòng: RAM isolate → Cache API. Hết hạn (cfg.ttl) mà còn bản cũ thì
 * trả bản cũ ngay + đọc lại ở nền. Nguồn lỗi thì giữ bản cũ, ghi lastError.
 */
import { chunkText } from './_kho-lib.js';
import { readerFor, LIMITS } from './_drive.js';
import { makeSource, missingFor } from './_sources.js';

const mem = new Map();        // key → { key, at, chunks, status }
const building = new Map();   // key → Promise

/** Phòng này đọc được nguồn ngoài chưa (có link + đủ khoá). */
export const deptReady = (dept, cfg, env) => Boolean(dept.folder) && missingFor(dept.folder, cfg, env).length === 0;

// Khoá đệm đổi khi đổi link / app → đổi cấu hình là kho cũ tự bỏ.
export const deptKey = (dept, cfg) => `${dept.folder}|${cfg.tenantId}|${cfg.clientId}`;
const cacheReq = (key) => new Request(`https://kho-cache.internal/v4/${encodeURIComponent(key)}`);
const edgeCache = () => (typeof caches !== 'undefined' && caches.default) || null;

/** Đọc toàn bộ một thư mục → { chunks, status }. Mọi file (kể cả thư mục con) thuộc phòng đó. */
export async function buildFolder(link, cfg, env, fetchImpl = fetch, now = Date.now()) {
  const src = await makeSource(link, cfg, env, fetchImpl, now);
  const files = await src.list();
  const chunks = [];
  const status = { at: now, source: src.kind, account: src.account, files: 0, chunks: 0, skipped: [], errors: [], truncated: files.length >= LIMITS.files };
  const todo = [];
  for (const f of files) {
    const r = readerFor(f);
    if (!r.how) status.skipped.push({ file: [...f.path, f.name].join('/'), why: r.why });
    else todo.push(f);
  }
  for (let i = 0; i < todo.length; i += LIMITS.parallel) {
    await Promise.all(todo.slice(i, i + LIMITS.parallel).map(async (f) => {
      const where = [...f.path, f.name].join('/');
      try {
        const text = await src.text(f);
        if (!text || !text.trim()) { status.skipped.push({ file: where, why: 'không có chữ' }); return; }
        const url = src.urlOf ? src.urlOf(f) : null;
        chunks.push(...chunkText(text).map((t, n) => ({ source: where, part: n + 1, text: t, url })));
        status.files++;
      } catch (e) {
        status.errors.push({ file: where, error: String(e.message || e).slice(0, 200) });
      }
    }));
  }
  status.chunks = chunks.length;
  return { chunks, status };
}

function refresh(dept, cfg, env, fetchImpl, now) {
  const key = deptKey(dept, cfg);
  if (building.has(key)) return building.get(key);
  const p = (async () => {
    try {
      const { chunks, status } = await buildFolder(dept.folder, cfg, env, fetchImpl, now);
      const entry = { key, at: now, chunks, status };
      mem.set(key, entry);
      const c = edgeCache();
      if (c) {
        await c.put(cacheReq(key), new Response(JSON.stringify(entry), {
          headers: { 'content-type': 'application/json', 'cache-control': `max-age=${(cfg.ttl || 600) * 6}` },
        }));
      }
      return entry;
    } finally { building.delete(key); }
  })();
  building.set(key, p);
  return p;
}

/** Kho của MỘT phòng: { at, chunks, status }. */
export async function liveDept(dept, cfg, env, { waitUntil, fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const key = deptKey(dept, cfg);
  const ttl = (cfg.ttl || 600) * 1000;
  let m = mem.get(key);
  if (!m && !force) {
    const c = edgeCache();
    const hit = c && await c.match(cacheReq(key));
    if (hit) { m = await hit.json(); mem.set(key, m); }
  }
  if (m && !force && now - m.at < ttl) return m;
  if (m && !force) {
    const p = refresh(dept, cfg, env, fetchImpl, now).catch((e) => { m.status = { ...m.status, lastError: String(e.message || e) }; });
    if (waitUntil) waitUntil(p);
    return m;
  }
  try {
    return await refresh(dept, cfg, env, fetchImpl, now);
  } catch (e) {
    if (m) { m.status = { ...m.status, lastError: String(e.message || e) }; return m; }
    throw e;
  }
}

/** Kho đã có sẵn trong bộ nhớ đệm (RAM / Cache API) — KHÔNG đọc nguồn. null nếu chưa có.
 *  Dùng cho "Hỏi chung": dò phòng nào khớp mà không kéo tài liệu của mọi phòng mỗi câu hỏi. */
export async function peekDept(dept, cfg) {
  const key = deptKey(dept, cfg);
  let m = mem.get(key);
  if (m) return m;
  const c = edgeCache();
  const hit = c && await c.match(cacheReq(key)).catch(() => null);
  if (hit) { m = await hit.json(); mem.set(key, m); }
  return m || null;
}

/** Chỉ dùng trong test. */
export function _resetLiveKho() { mem.clear(); building.clear(); }
