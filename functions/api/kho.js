/**
 * GET /api/kho            — trạng thái kho của TỪNG phòng ban: nguồn, lúc đọc, số file, file bỏ qua.
 * GET /api/kho?refresh=1  — ép đọc lại mọi phòng ngay.
 * GET /api/kho?dept=<id>  — chỉ một phòng (trang admin gọi từng phòng một, song song).
 * Nằm sau mật khẩu site. Chỉ trả SỐ LIỆU và TÊN FILE, không trả nội dung tài liệu.
 */
import KHO from '../_kho.js';
import { deptReady, liveDept } from '../_kho-live.js';
import { loadConfig, withSecrets } from '../_config.js';
import { missingFor, kindOf } from '../_sources.js';
import { hydrate } from '../../public/shared/dept-model.js';
import { listDocs } from '../_uploads.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** Tóm tắt trạng thái MỘT phòng — dùng chung cho /api/kho và trang admin. */
export async function deptSummary(dept, cfg, env, { waitUntil, force = false } = {}) {
  const docs = await listDocs(env, dept.id).catch(() => []);
  const base = { id: dept.id, name: dept.name, source: kindOf(dept.folder), mode: dept.source,
    uploads: { files: docs.length, bytes: docs.reduce((s, d) => s + d.bytes, 0) } };
  if (dept.source === 'upload' || !dept.folder) {
    return dept.source === 'upload' && docs.length ? { ...base, state: 'uploads' }
      : { ...base, state: 'faq', note: 'Chưa có link / file tải lên — chỉ trả lời từ FAQ.', bundledChunks: (KHO[dept.id] || []).length };
  }
  if (!deptReady(dept, cfg, env)) return { ...base, state: 'missing', missing: missingFor(dept.folder, cfg, env) };
  try {
    const m = await liveDept(dept, cfg, env, { waitUntil, force });
    const s = m.status;
    return { ...base, state: s.files ? 'ok' : 'empty', account: s.account, updatedAt: new Date(m.at).toISOString(),
      filesRead: s.files, chunks: s.chunks, skipped: s.skipped, errors: s.errors, truncated: s.truncated || undefined, lastError: s.lastError };
  } catch (e) {
    return { ...base, state: 'error', error: String(e.message || e) };
  }
}

export async function onRequestGet({ request, env: rawEnv, waitUntil }) {
  const env = await withSecrets(rawEnv);
  const force = new URL(request.url).searchParams.get('refresh') === '1';
  const cfg = await loadConfig(env);
  const only = new URL(request.url).searchParams.get('dept');
  const depts = hydrate(cfg.depts).filter((d) => !only || d.id === only);
  if (only && !depts.length) return json({ error: 'Không có phòng ban này.' }, 404);
  const out = [];
  for (const d of depts) out.push(await deptSummary(d, cfg, env, { waitUntil, force }));   // lần lượt: đỡ dồn lượt gọi ra ngoài
  return json({ depts: out });
}
