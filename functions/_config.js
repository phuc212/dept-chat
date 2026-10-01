/* Cấu hình hệ thống — sửa ở /admin/, lưu trong Cloudflare KV (binding `CONFIG`).
 *
 *   { depts: [{ id, name, folder, contact, scope, color, greeting, suggestions[] }], tenantId, clientId, ttl }
 *
 * · Mỗi phòng ban MỘT link thư mục riêng (Google Drive hoặc SharePoint — tự nhận theo link).
 *   Để trống link = phòng đó chỉ trả lời từ FAQ.
 * · Tenant ID / Client ID dùng chung cho mọi link SharePoint (một app Entra của công ty).
 * · BÍ MẬT (key Google, client secret SharePoint) KHÔNG ở đây — nằm trong secret Cloudflare.
 * Chưa gắn KV: dùng 3 phòng mặc định trong depts.js, trang admin chỉ xem được.
 */
import { MAX_DEPTS, slugify } from '../public/shared/dept-model.js';
import { kindOf } from './_sources.js';

const KEY = 'app-config';
const DEFAULTS = { depts: null, tenantId: '', clientId: '', ttl: 600, stats: true, showSources: false };

let cache = null;   // { at, cfg }

export const kvReady = (env) => Boolean(env.CONFIG && typeof env.CONFIG.get === 'function');

/** Cấu hình hiện tại (KV → mặc định). Đệm 30 giây. `depts: null` = dùng phòng mặc định. */
export async function loadConfig(env, now = Date.now()) {
  if (cache && now - cache.at < 30_000) return cache.cfg;
  let cfg = null;
  if (kvReady(env)) {
    try { cfg = await env.CONFIG.get(KEY, 'json'); } catch { cfg = null; }
  }
  cfg = { ...DEFAULTS, ...(cfg || {}) };
  if (!Array.isArray(cfg.depts)) cfg.depts = null;          // cấu hình đời cũ (source/folder) → mặc định
  cache = { at: now, cfg };
  return cfg;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kiểm tra + chuẩn hoá cấu hình gửi lên. Trả { cfg } hoặc { error }. */
export function validateConfig(input) {
  if (!input || typeof input !== 'object') return { error: 'Dữ liệu không hợp lệ.' };
  const list = input.depts;
  if (!Array.isArray(list) || list.length === 0) return { error: 'Cần ít nhất 1 phòng ban.' };
  if (list.length > MAX_DEPTS) return { error: `Tối đa ${MAX_DEPTS} phòng ban.` };
  const used = new Set();
  const depts = [];
  for (const [i, d] of list.entries()) {
    const name = String(d?.name || '').trim().slice(0, 40);
    if (!name) return { error: `Phòng ban thứ ${i + 1} chưa có tên.` };
    let id = /^[a-z0-9-]{1,40}$/.test(d.id || '') ? d.id : slugify(name);
    for (let n = 2; used.has(id); n++) id = `${slugify(name)}-${n}`;
    used.add(id);
    // Nguồn tài liệu của phòng: 'upload' (file tải lên) HOẶC 'link' (thư mục Drive/SharePoint) — một trong hai.
    const source = d.source === 'upload' || d.source === 'link' ? d.source : (String(d.folder || '').trim() ? 'link' : 'upload');
    const folder = source === 'link' ? String(d.folder || '').trim().slice(0, 1000) : '';
    if (folder && !kindOf(folder)) return { error: `Link của "${name}" không phải thư mục Google Drive hoặc SharePoint.` };
    const color = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : undefined;
    depts.push({
      id, name, source, folder, color,
      contact: String(d.contact || '').trim().slice(0, 120),
      scope: String(d.scope || '').trim().slice(0, 300),
      greeting: String(d.greeting || '').trim().slice(0, 300),
      // Câu gợi ý: tối đa 5 câu, mỗi câu ≤ 120 ký tự, bỏ trùng / dòng trống.
      suggestions: [...new Set((Array.isArray(d.suggestions) ? d.suggestions : String(d.suggestions || '').split('\n'))
        .map((q) => String(q).trim().slice(0, 120)).filter(Boolean))].slice(0, 5),
    });
  }
  const tenantId = String(input.tenantId || '').trim().slice(0, 100);
  const clientId = String(input.clientId || '').trim().slice(0, 100);
  if (depts.some((d) => kindOf(d.folder) === 'sharepoint')) {
    if (!GUID.test(tenantId) && !/^[\w.-]+\.[a-z]{2,}$/i.test(tenantId)) return { error: 'Có phòng dùng SharePoint: cần Tenant ID (GUID hoặc congty.onmicrosoft.com).' };
    if (!GUID.test(clientId)) return { error: 'Có phòng dùng SharePoint: cần Client ID (dạng GUID).' };
  }
  const ttl = Number(input.ttl);
  return { cfg: { depts, tenantId, clientId, ttl: Number.isFinite(ttl) ? Math.min(86400, Math.max(60, Math.round(ttl))) : 600, stats: input.stats !== false, showSources: input.showSources === true } };
}

export async function saveConfig(env, cfg) {
  if (!kvReady(env)) throw new Error('Chưa gắn KV `CONFIG` cho project — xem hướng dẫn trên trang admin.');
  await env.CONFIG.put(KEY, JSON.stringify(cfg));
  cache = { at: Date.now(), cfg };
}

/** Chỉ dùng trong test. */
export function _resetConfigCache() { cache = null; secretCache = null; }

/* ---------- KHOÁ KẾT NỐI nhập từ trang admin ----------
 * Lưu ở KV key riêng `app-secrets`. Chỉ GHI được qua /api/admin/secrets — không API nào trả giá trị
 * về trình duyệt. Khoá nhập ở admin THẮNG secret Cloudflare cùng tên (để đổi khoá trên web là có
 * hiệu lực ngay); secret Cloudflare dùng làm dự phòng.
 * Đánh đổi: ai có quyền vào tài khoản Cloudflare thì xem được giá trị trong KV. */
const SECRETS_KEY = 'app-secrets';
export const SECRET_NAMES = ['GOOGLE_SA_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'SHAREPOINT_CLIENT_SECRET'];
let secretCache = null;   // { at, s }

export async function loadSecrets(env, now = Date.now()) {
  if (secretCache && now - secretCache.at < 30_000) return secretCache.s;
  let s = null;
  if (kvReady(env)) { try { s = await env.CONFIG.get(SECRETS_KEY, 'json'); } catch { s = null; } }
  s = s && typeof s === 'object' ? s : {};
  secretCache = { at: now, s };
  return s;
}

/** env + khoá từ admin (admin thắng). Dùng thay `env` ở mọi chỗ cần khoá. */
export async function withSecrets(env) {
  const s = await loadSecrets(env);
  const out = Object.create(env);          // giữ nguyên binding (CONFIG…), chỉ đè khoá
  for (const n of SECRET_NAMES) if (s[n]) out[n] = s[n];
  return out;
}

/** Kiểm tra một khoá trước khi lưu. Trả { value } (đã chuẩn hoá) hoặc { error }. '' = xoá. */
export function validateSecret(name, raw) {
  if (!SECRET_NAMES.includes(name)) return { error: 'Tên khoá không hợp lệ.' };
  const v = String(raw ?? '').trim();
  if (!v) return { value: '' };
  if (v.length > 20000) return { error: 'Khoá quá dài.' };
  if (name === 'GOOGLE_SA_KEY') {
    let j;
    try { j = JSON.parse(v); } catch { return { error: 'Không phải JSON — dán NGUYÊN nội dung file key.json (hoặc chọn file).' }; }
    if (j.type !== 'service_account' || !j.client_email || !j.private_key) return { error: 'File JSON này không phải key của service account (thiếu client_email / private_key).' };
    return { value: JSON.stringify(j) };
  }
  if (name === 'ANTHROPIC_API_KEY' && !/^sk-ant-[\w-]{20,}$/.test(v)) return { error: 'API key Anthropic có dạng sk-ant-… (lấy ở console.anthropic.com → API Keys).' };
  // Key Gemini: dạng cũ AIza…, dạng mới AQ.… (Google đổi định dạng key từ 2026)
  if (name === 'GEMINI_API_KEY' && !/^(AIza[\w-]{30,}|AQ\.[\w.-]{20,})$/.test(v)) return { error: 'API key Gemini có dạng AIza… hoặc AQ.… (lấy ở aistudio.google.com/apikey).' };
  if (/\s/.test(v)) return { error: 'Khoá không được chứa dấu cách.' };
  return { value: v };
}

export async function saveSecret(env, name, value) {
  if (!kvReady(env)) throw new Error('Chưa gắn KV `CONFIG` cho project — xem hướng dẫn trên trang admin.');
  secretCache = null;
  const s = { ...(await loadSecrets(env)) };
  if (value) s[name] = value; else delete s[name];
  await env.CONFIG.put(SECRETS_KEY, JSON.stringify(s));
  secretCache = { at: Date.now(), s };
}

/** Tình trạng từng khoá cho trang admin — KHÔNG có giá trị, chỉ nguồn + gợi ý nhận dạng. */
export async function secretStatus(env) {
  const s = await loadSecrets(env);
  const out = {};
  for (const n of SECRET_NAMES) {
    const v = s[n] || env[n];
    const source = s[n] ? 'admin' : env[n] ? 'cloudflare' : null;
    let hint = null;
    if (v && n === 'GOOGLE_SA_KEY') { try { hint = JSON.parse(v).client_email || null; } catch { hint = 'JSON lỗi'; } }
    else if (v) hint = '…' + String(v).slice(-4);
    out[n] = { set: Boolean(v), source, hint };
  }
  return out;
}

export function _resetSecretCache() { secretCache = null; }
