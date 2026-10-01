/**
 * GET /api/admin/config  — danh sách phòng ban (kèm link), Tenant/Client ID, tình trạng secret
 *                          (chỉ có/không, KHÔNG trả giá trị), email bot Google để Share thư mục.
 * PUT /api/admin/config  — lưu (KV `CONFIG`). Body: { depts: [{id?, name, folder, contact, scope, color}], tenantId, clientId, ttl }
 */
import { denyUnlessAdmin, json } from './_auth.js';
import { loadConfig, validateConfig, saveConfig, kvReady, secretStatus } from '../../_config.js';
import { hydrate, MAX_DEPTS } from '../../../public/shared/dept-model.js';
import { dbReady } from '../../_stats.js';
import { deleteDocsExcept } from '../../_uploads.js';

export async function onRequestGet({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  const cfg = await loadConfig(env);
  // Trả giá trị ĐÃ LƯU (ô trống vẫn trống) — chỉ màu lấy bản đã bù, để ô chọn màu có giá trị.
  const raw = cfg.depts;
  const depts = hydrate(raw).map((d, i) => ({
    id: d.id, name: d.name, source: d.source, folder: d.folder, color: d.color,
    contact: raw ? raw[i].contact || '' : d.contact, scope: raw ? raw[i].scope || '' : d.scope,
    greeting: raw ? raw[i].greeting || '' : '', suggestions: raw ? raw[i].suggestions || [] : d.suggest,
  }));
  return json({
    depts, tenantId: cfg.tenantId, clientId: cfg.clientId, ttl: cfg.ttl, stats: cfg.stats !== false, showSources: cfg.showSources === true, dbReady: dbReady(env), maxDepts: MAX_DEPTS,
    kvReady: kvReady(env),
    workersAi: Boolean(env.AI && typeof env.AI.run === 'function'),   // binding Workers AI (không cần key)
    secrets: await secretStatus(env),   // { NAME: { set, source: 'admin'|'cloudflare'|null, hint } } — không có giá trị
  });
}

export async function onRequestPut({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body phải là JSON.' }, 400); }
  const v = validateConfig(body);
  if (v.error) return json({ error: v.error }, 400);
  try { await saveConfig(env, v.cfg); } catch (e) { return json({ error: e.message }, 409); }
  // Phòng bị xoá → xoá luôn file đã tải lên cho phòng đó (tài liệu trên Drive/SharePoint không bị động tới).
  await deleteDocsExcept(env, v.cfg.depts.map((d) => d.id)).catch((e) => console.warn('[docs] dọn lỗi:', e.message));
  return json({ ok: true, depts: v.cfg.depts });
}
