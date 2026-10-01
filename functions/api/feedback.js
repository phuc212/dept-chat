/**
 * POST /api/feedback — 👍/👎 cho một câu trả lời. Body: { id: '<x-qid>', rating: 1 | -1 | 0 }.
 * id là UUID ngẫu nhiên server cấp cùng câu trả lời → không đoán được id của câu khác.
 */
import { rate, dbReady } from '../_stats.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost({ request, env }) {
  if (!dbReady(env)) return json({ error: 'Chưa bật thống kê.' }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Body phải là JSON.' }, 400); }
  if (!UUID.test(String(b?.id || ''))) return json({ error: 'id không hợp lệ.' }, 400);
  const r = Number(b.rating);
  if (![1, -1, 0].includes(r)) return json({ error: 'rating phải là 1, -1 hoặc 0.' }, 400);
  const ok = await rate(env, b.id, r);
  return ok ? json({ ok: true }) : json({ error: 'Không thấy câu trả lời này.' }, 404);
}
