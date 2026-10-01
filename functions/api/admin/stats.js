/**
 * GET    /api/admin/stats?days=30            — số liệu tổng hợp cho trang admin.
 * GET    /api/admin/stats?days=30&format=csv — tải toàn bộ câu hỏi dạng CSV (mở bằng Excel).
 * DELETE /api/admin/stats                    — xoá hết dữ liệu thống kê.
 */
import { denyUnlessAdmin, json } from './_auth.js';
import { summary, exportRows, clearAll, dbReady } from '../../_stats.js';
import { loadConfig } from '../../_config.js';
import { hydrate } from '../../../public/shared/dept-model.js';

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;            // chặn công thức khi mở bằng Excel (CSV injection)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function onRequestGet({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  if (!dbReady(env)) return json({ dbReady: false });
  const u = new URL(request.url);
  const days = Math.min(365, Math.max(1, Number(u.searchParams.get('days')) || 30));
  const names = Object.fromEntries(hydrate((await loadConfig(env)).depts).map((d) => [d.id, d.name]));
  names._auto = 'Hỏi chung (chưa rõ phòng)';
  if (u.searchParams.get('format') === 'csv') {
    const rows = await exportRows(env, { days });
    const head = ['Thời gian', 'Phòng', 'Hỏi chung', 'Câu hỏi', 'Trả lời được', 'Đánh giá', 'Chế độ', 'Nguồn'];
    const body = rows.map((r) => [
      new Date(r.at).toISOString(), names[r.dept] || r.dept, r.auto ? 'có' : '', r.question,
      r.answered === 1 ? 'có' : r.answered === 0 ? 'không' : '', r.rating === 1 ? '👍' : r.rating === -1 ? '👎' : '', r.mode,
      (() => { try { return JSON.parse(r.sources || '[]').join('; '); } catch { return ''; } })(),
    ].map(csvCell).join(','));
    return new Response('﻿' + [head.join(','), ...body].join('\r\n'), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="dept-chat-cau-hoi-${days}ngay.csv"`, 'cache-control': 'no-store' },
    });
  }
  return json({ dbReady: true, names, ...(await summary(env, { days })) });
}

export async function onRequestDelete({ request, env }) {
  const deny = denyUnlessAdmin(request, env);
  if (deny) return deny;
  if (!dbReady(env)) return json({ error: 'Chưa gắn D1.' }, 409);
  await clearAll(env);
  return json({ ok: true });
}
