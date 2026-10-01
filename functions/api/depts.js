/**
 * GET /api/depts — danh sách phòng ban để trình duyệt vẽ bản đồ (tên, màu, trợ lý, FAQ gợi ý).
 * Không trả link thư mục. Nằm sau mật khẩu site.
 */
import { loadConfig } from '../_config.js';
import { hydrate, publicDepts } from '../../public/shared/dept-model.js';

export async function onRequestGet({ env }) {
  const cfg = await loadConfig(env);
  return new Response(JSON.stringify({ depts: publicDepts(hydrate(cfg.depts)), custom: Boolean(cfg.depts) }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
