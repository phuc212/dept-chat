/**
 * POST /api/admin/test — thử kết nối MỘT link thư mục (chưa lưu): đọc thật, trả số file đọc được /
 * bỏ qua / lỗi. Body: { folder, tenantId?, clientId? }. Không trả nội dung tài liệu.
 */
import { denyUnlessAdmin, json } from './_auth.js';
import { kindOf, missingFor } from '../../_sources.js';
import { buildFolder } from '../../_kho-live.js';
import { withSecrets } from '../../_config.js';

export async function onRequestPost({ request, env: rawEnv }) {
  const deny = denyUnlessAdmin(request, rawEnv);
  if (deny) return deny;
  const env = await withSecrets(rawEnv);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body phải là JSON.' }, 400); }
  const folder = String(body.folder || '').trim();
  const cfg = { tenantId: String(body.tenantId || '').trim(), clientId: String(body.clientId || '').trim() };
  if (!folder) return json({ ok: false, error: 'Chưa có link thư mục.' }, 400);
  if (!kindOf(folder)) return json({ ok: false, error: 'Link không phải thư mục Google Drive hoặc SharePoint (mở thư mục trên trình duyệt → copy thanh địa chỉ).' }, 400);
  const miss = missingFor(folder, cfg, env);
  if (miss.length) return json({ ok: false, error: 'Còn thiếu: ' + miss.join('; ') }, 400);
  try {
    const { status } = await buildFolder(folder, cfg, env);
    return json({
      ok: status.files > 0, source: status.source, account: status.account, filesRead: status.files, chunks: status.chunks,
      skipped: status.skipped, errors: status.errors, truncated: status.truncated || undefined,
      note: status.files ? undefined : 'Kết nối được nhưng không đọc được file nào — xem danh sách bị bỏ qua.',
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }
}
