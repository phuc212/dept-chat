/**
 * POST /api/admin/ai-test — thử khoá AI đang lưu bằng một câu hỏi rất ngắn, trả về chạy được hay lỗi gì
 * (để admin biết vì sao bot đang "trích tài liệu" thay vì trả lời bằng AI). Không trả khoá về trình duyệt.
 */
import { denyUnlessAdmin, json } from './_auth.js';
import { withSecrets } from '../../_config.js';
import { providers, startLLM, modelOf, PROVIDER_NAME, loadAiError } from '../chat.js';

/** Lỗi của Google / Anthropic → câu dễ hiểu. */
export function explainAiError(provider, status, raw) {
  let m = '';
  try { const j = JSON.parse(raw); m = j.error?.message || j.error?.status || ''; } catch { m = String(raw || ''); }
  m = m.slice(0, 200);
  if (status === 429) return 'Hết lượt dùng (quota) của key — gói miễn phí giới hạn số câu mỗi phút/ngày. Thử lại sau ít phút.' + (m ? ` (${m})` : '');
  if (status === 401 || /API_KEY_INVALID|API key not valid|invalid x-api-key/i.test(m)) return 'Key sai hoặc đã bị xoá — tạo key mới rồi dán lại.';
  if (provider === 'claude' && status === 403 && /request not allowed/i.test(m)) return 'Anthropic chặn theo vị trí máy chủ Cloudflare đang chạy (403 "Request not allowed") — key vẫn đúng.';
  if (provider === 'claude' && /credit balance/i.test(m)) return 'Tài khoản Claude hết credit — vào platform.claude.com → Billing nạp thêm.';
  if (status === 403) return 'Key không có quyền (API chưa bật cho project, hoặc key bị giới hạn). ' + m;
  if (status === 404) return 'Model không tồn tại / không dùng được với key này. ' + m;
  if (provider === 'claude' && /credit|billing/i.test(m)) return 'Tài khoản Claude hết credit — nạp thêm ở console.anthropic.com. ';
  return `Lỗi ${status || 'mạng'}: ${m || 'không rõ'}`;
}

/** Chuỗi lỗi thô "503 {...}" (đã lưu khi chat) → câu dễ hiểu. */
function explainRaw(p, m) {
  m = String(m || '');
  const status = Number(m.match(/^(\d{3}) /)?.[1]) || 0;
  if (/location is not supported/i.test(m)) return 'bị chặn theo vị trí máy chủ Cloudflare';
  if (/AI trả về rỗng/.test(m)) return 'AI trả lời rỗng (không có chữ)';
  if (status === 503 || status === 500) return 'máy chủ AI quá tải / tạm lỗi (' + status + ')';
  return explainAiError(p, status, m.replace(/^\d{3} /, ''));
}

export async function onRequestPost({ request, env: rawEnv }) {
  const deny = denyUnlessAdmin(request, rawEnv);
  if (deny) return deny;
  const env = await withSecrets(rawEnv);
  const chain = providers(env);
  if (!chain.length) return json({ ok: false, results: [], error: 'Chưa có AI nào — bot đang trích tài liệu (không dùng AI).' });
  const results = [];
  for (const p of chain) {
    const r = { provider: p, name: PROVIDER_NAME[p], model: modelOf(p, env) };
    try {
      const stream = await startLLM(p, env, 'Bạn là trợ lý kiểm tra.', [{ role: 'user', content: 'Chỉ trả lời đúng một chữ: OK' }], { maxTokens: 50 });
      await new Response(stream).text();
      r.ok = true;
    } catch (e) {
      const m = String(e.message || e);
      r.ok = false;
      r.error = /location is not supported/i.test(m)
        ? 'Google chặn theo vị trí máy chủ Cloudflare đang chạy ("User location is not supported").'
        : explainRaw(p, m);
    }
    results.push(r);
  }
  const active = results.find((r) => r.ok);
  // Máy chủ Cloudflare đang chạy (mã sân bay: HKG = Hồng Kông, SIN = Singapore…) — để biết vì sao bị chặn vị trí.
  const colo = request.cf?.colo || null;
  const le = await loadAiError(env);
  const lastError = le && {
    at: le.at, colo: le.colo,
    errors: (le.errors || []).map((x) => ({ name: PROVIDER_NAME[x.provider] || x.provider, error: explainRaw(x.provider, x.error) })),
  };
  return json({ ok: Boolean(active), active: active?.provider || null, results, colo, lastError });
}
