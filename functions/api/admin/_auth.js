/* Cổng cho /api/admin/**: header `x-admin-key` phải khớp secret ADMIN_PASSWORD.
 * Tách khỏi mật khẩu site: người dùng chat biết mật khẩu site, nhưng KHÔNG sửa được cấu hình.
 * Chưa đặt ADMIN_PASSWORD → admin tắt hẳn (fail-closed). */
import { sameSecret } from '../../_middleware.js';

export const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** Trả Response lỗi nếu không được phép, null nếu OK. */
export function denyUnlessAdmin(request, env) {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) {
    return json({ error: 'Trang admin đang tắt: đặt secret ADMIN_PASSWORD (tối thiểu 8 ký tự) trên Cloudflare rồi deploy lại.' }, 503);
  }
  const got = request.headers.get('x-admin-key') || '';
  if (!sameSecret(String(got || '').trim(), String(env.ADMIN_PASSWORD).trim())) return json({ error: 'Sai mật khẩu admin.' }, 401);
  return null;
}
