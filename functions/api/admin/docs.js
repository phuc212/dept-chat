/**
 * Tài liệu tải lên cho từng phòng (lưu D1). Cần mật khẩu admin.
 *   GET    /api/admin/docs?dept=<id>              — danh sách file + dung lượng đã dùng
 *   PUT    /api/admin/docs  { dept, name, text }   — lưu / thay một file (CHỮ đã rút ở trình duyệt)
 *   DELETE /api/admin/docs?dept=<id>&name=<tên>    — xoá một file
 */
import { denyUnlessAdmin, json } from './_auth.js';
import { listDocs, saveDoc, deleteDoc, UPLOAD_LIMITS } from '../../_uploads.js';
import { dbReady } from '../../_stats.js';
import { loadConfig } from '../../_config.js';
import { hydrate } from '../../../public/shared/dept-model.js';

async function deptOk(env, id) {
  const cfg = await loadConfig(env);
  return hydrate(cfg.depts).some((d) => d.id === id);
}
const summary = (docs) => ({ docs, used: docs.reduce((s, d) => s + d.bytes, 0), limits: UPLOAD_LIMITS });

export async function onRequestGet({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  if (!dbReady(env)) return json({ dbReady: false, docs: [], used: 0, limits: UPLOAD_LIMITS });
  const dept = new URL(request.url).searchParams.get('dept') || '';
  if (!(await deptOk(env, dept))) return json({ error: 'Không có phòng ban này (lưu phòng trước rồi mới tải file).' }, 404);
  return json({ dbReady: true, ...summary(await listDocs(env, dept)) });
}

export async function onRequestPut({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Body phải là JSON.' }, 400); }
  if (!(await deptOk(env, b?.dept))) return json({ error: 'Không có phòng ban này (lưu phòng trước rồi mới tải file).' }, 404);
  const r = await saveDoc(env, b.dept, b.name, b.text);
  if (r.error) return json({ error: r.error }, dbReady(env) ? 400 : 409);
  return json({ ok: true, doc: r.doc, replaced: r.replaced, ...summary(await listDocs(env, b.dept)) });
}

export async function onRequestDelete({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  const u = new URL(request.url);
  const dept = u.searchParams.get('dept') || '';
  const ok = await deleteDoc(env, dept, u.searchParams.get('name') || '');
  if (!ok) return json({ error: 'Không thấy file này.' }, 404);
  return json({ ok: true, ...summary(await listDocs(env, dept)) });
}
