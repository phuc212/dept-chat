/**
 * PUT /api/admin/secrets — đặt / đổi / xoá MỘT khoá kết nối. Body: { name, value } (value '' = xoá).
 * CHỈ GHI: không có GET trả giá trị. Trả lại tình trạng (có/không, nguồn, gợi ý) để trang admin vẽ lại.
 */
import { denyUnlessAdmin, json } from './_auth.js';
import { validateSecret, saveSecret, secretStatus } from '../../_config.js';
import { _resetLiveKho } from '../../_kho-live.js';

export async function onRequestPut({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body phải là JSON.' }, 400); }
  const v = validateSecret(body?.name, body?.value);
  if (v.error) return json({ error: v.error }, 400);
  try {
    await saveSecret(env, body.name, v.value);
    // Ô AI chỉ một hãng: lưu key Gemini thì bỏ key Claude đã nhập ở admin, và ngược lại.
    const other = { GEMINI_API_KEY: 'ANTHROPIC_API_KEY', ANTHROPIC_API_KEY: 'GEMINI_API_KEY' }[body.name];
    if (other && v.value) await saveSecret(env, other, '');
  } catch (e) { return json({ error: e.message }, 409); }
  _resetLiveKho();                         // khoá đổi → đọc lại tài liệu bằng khoá mới
  return json({ ok: true, secrets: await secretStatus(env) });
}
