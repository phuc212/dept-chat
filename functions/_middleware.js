/**
 * Basic auth một mật khẩu cho TOÀN BỘ site (trang + /api/chat).
 *
 * Vì sao cần: /api/chat tiêu tiền API key — để hở là ai cũng gọi được. Tài khoản gõ gì
 * cũng được, chỉ kiểm phần mật khẩu (giống kstns-office).
 *
 * Fail-closed: thiếu biến SITE_PASSWORD thì chặn hết (500), không bao giờ "mở tạm".
 * Muốn mở công khai thì phải nói RÕ: SITE_PASSWORD = off (trang admin vẫn cần ADMIN_PASSWORD riêng).
 */

/** So chuỗi thời gian hằng — không lộ độ dài phần khớp qua thời gian phản hồi. */
export function sameSecret(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

/** Lấy mật khẩu từ header Authorization: Basic base64(user:pass). null nếu không có/sai dạng. */
export function sentPassword(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const raw = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const i = raw.indexOf(':');
    return i < 0 ? null : raw.slice(i + 1);
  } catch { return null; }
}

export async function onRequest({ request, env, next }) {
  if (!env.SITE_PASSWORD) {
    // Tách hai ca để nhìn là biết sửa gì: biến không tồn tại, hay tồn tại nhưng giá trị rỗng.
    const why = env.SITE_PASSWORD === undefined
      ? 'Chưa cấu hình SITE_PASSWORD (biến không tồn tại trên bản deploy này — thêm secret rồi deploy lại).'
      : 'SITE_PASSWORD đang RỖNG — sửa giá trị secret rồi deploy lại.';
    return new Response(why, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (String(env.SITE_PASSWORD).trim().toLowerCase() === 'off') return next();   // cố ý tắt mật khẩu vào trang
  const pass = sentPassword(request);
  // trim: dán mật khẩu từ dashboard/notes hay dính dấu cách thừa ở đầu/cuối.
  if (pass === null || !sameSecret(pass.trim(), String(env.SITE_PASSWORD).trim())) {
    return new Response('Cần mật khẩu.', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="dept-chat", charset="UTF-8"', 'cache-control': 'no-store' },
    });
  }
  return next();
}
