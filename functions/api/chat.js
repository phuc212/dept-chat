/**
 * POST /api/chat — chatbot theo bộ phận.
 *
 * Body: { dept: '<id phòng>' | 'auto', messages: [{role:'user'|'assistant', content}] }
 *   dept 'auto' = "Hỏi chung": server tự chọn phòng khớp nhất (header X-Dept báo phòng đã chọn).
 * Trả về: text/plain được STREAM dần (client đọc bằng response.body.getReader()).
 * Header `X-Chat-Mode`: `llm` | `faq` (không có key) | `faq-fallback` (gọi LLM lỗi) | `route-none` (hỏi chung, không đoán được phòng).
 * Header `X-Sources`: JSON (encodeURIComponent) [{name, url}] — file tài liệu đã dùng, để hiện link mở file.
 *
 * VÌ SAO GỌI LLM Ở SERVER: API key của Anthropic không được lộ ra trình duyệt. Key nằm
 * trong secret ANTHROPIC_API_KEY của Cloudflare Pages (local: file .dev.vars).
 *
 * CẤU HÌNH:
 *   ANTHROPIC_API_KEY   (secret) Claude. Không có thì thử GEMINI_API_KEY (Google Gemini). Không có cả hai → trích tài liệu, không lỗi.
 *   ANTHROPIC_MODEL     (tuỳ chọn) mặc định DEFAULT_MODEL bên dưới.
 */
import { DEPTS } from '../../public/shared/depts.js';
import { hydrate } from '../../public/shared/dept-model.js';
import { systemPrompt } from '../../public/shared/prompt.js';
import { faqAnswer } from '../../public/shared/faq-match.js';
import { retrieve } from '../_retrieve.js';
import KHO from '../_kho.js';
import { deptReady, liveDept, peekDept } from '../_kho-live.js';
import { normalize, tokens } from '../../public/shared/faq-match.js';
import { loadConfig, withSecrets } from '../_config.js';
import { uploadedChunks } from '../_uploads.js';
import { logQuestion, setAnswered, looksUnanswered, dbReady } from '../_stats.js';

export { systemPrompt };

export const DEFAULT_MODEL = 'claude-sonnet-4-5';
// Bí danh "luôn trỏ tới bản Flash mới nhất" của Google — khỏi sửa code khi Google ra model mới. Đổi bằng biến GEMINI_MODEL.
export const GEMINI_MODEL = 'gemini-flash-latest';
// Workers AI: model chạy ngay trên Cloudflare (gắn binding "AI", không cần key, có hạn mức miễn phí mỗi ngày).
// Không bị chặn theo vị trí như Gemini. Đổi bằng biến WORKERS_AI_MODEL.
export const GEMINI_LITE = 'gemini-flash-lite-latest';
export const WORKERS_AI_MODEL = '@cf/google/gemma-3-12b-it';

/** Lần gọi AI thất bại gần nhất (KV "ai-last-error", giữ 7 ngày) — để admin xem vì sao bot phải trích tài liệu.
 *  Ghi tối đa 1 lần / phút (KV miễn phí giới hạn số lần ghi mỗi ngày). */
let lastAiErrWrite = 0;
export async function saveAiError(env, rec, now = Date.now()) {
  if (!env.CONFIG || typeof env.CONFIG.put !== 'function' || now - lastAiErrWrite < 60_000) return;
  lastAiErrWrite = now;
  try { await env.CONFIG.put('ai-last-error', JSON.stringify(rec), { expirationTtl: 7 * 86400 }); } catch { /* bỏ qua */ }
}
export async function loadAiError(env) {
  if (!env.CONFIG || typeof env.CONFIG.get !== 'function') return null;
  try { return await env.CONFIG.get('ai-last-error', 'json'); } catch { return null; }
}
export const _resetAiErr = () => { lastAiErrWrite = 0; };

/** Các hãng AI dùng được, theo thứ tự ưu tiên. */
export function providers(env) {
  const out = [];
  if (env.ANTHROPIC_API_KEY) out.push('claude');
  if (env.GEMINI_API_KEY) out.push('gemini');
  if (env.AI && typeof env.AI.run === 'function') out.push('workers');
  return out;
}
export const PROVIDER_NAME = { claude: 'Claude', gemini: 'Gemini', workers: 'Workers AI (Cloudflare)' };
export const modelOf = (p, env) => (p === 'claude' ? env.ANTHROPIC_MODEL || DEFAULT_MODEL
  : p === 'gemini' ? env.GEMINI_MODEL || GEMINI_MODEL : env.WORKERS_AI_MODEL || WORKERS_AI_MODEL);

/** Bắt đầu gọi một hãng → stream TEXT thuần. Lỗi (HTTP ≠ 2xx, mạng) thì ném Error có status + nội dung. */
export async function startLLM(p, env, system, messages, { maxTokens = LIMITS.maxTokens } = {}) {
  const model = modelOf(p, env);
  if (p === 'workers') {
    const body = await env.AI.run(model, {
      messages: [{ role: 'system', content: system }, ...messages], stream: true, max_tokens: maxTokens, temperature: 0.2,
    });
    if (!body || typeof body.pipeThrough !== 'function') throw new Error('Workers AI không trả stream');
    const text = await nonEmpty(workersSseToText(body));
    if (!text) throw new Error('200 (AI trả về rỗng)');
    return text;
  }
  const call = (m) => (p === 'claude'
    ? fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m, max_tokens: maxTokens, stream: true, system, messages }),
    })
    : fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(geminiBody(system, messages, Math.max(maxTokens, 2048))),
    }));
  // (Gemini: chừa thêm token vì model "nghĩ" trước khi viết — thiếu thì trả về rỗng.)
  // Quá tải tạm thời (503/500/429) hay gặp ở Gemini: thử lại 1 lần, rồi thử bản Flash-Lite (ít tải hơn).
  const tries = p === 'gemini' ? [model, model, GEMINI_LITE] : [model, model];
  let last;
  for (let i = 0; i < tries.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 600));
    const res = await call(tries[i]);
    if (res.ok && res.body) {
      // Có lúc AI trả 200 nhưng KHÔNG có chữ nào (Gemini "nghĩ" hết lượt token, bị lọc an toàn…) → coi như lỗi, thử tiếp.
      const text = await nonEmpty(p === 'claude' ? sseToText(res.body) : geminiSseToText(res.body));
      if (text) return text;
      last = new Error('200 (AI trả về rỗng)');
      last.status = 200;
      continue;
    }
    last = new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 500));
    last.status = res.status;
    if (!(res.status >= 500 || res.status === 429)) break;          // key sai / bị chặn → thử lại vô ích
  }
  throw last;
}

/** Đọc tới khi có chữ đầu tiên. Có chữ → trả stream (gồm phần đã đọc + phần còn lại); hết stream mà rỗng → null. */
export async function nonEmpty(stream) {
  const reader = stream.getReader();
  const head = [];
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return null;
    head.push(value);
    if (dec.decode(value, { stream: true }).trim()) break;
  }
  return new ReadableStream({
    start(ctl) { for (const c of head) ctl.enqueue(c); },
    async pull(ctl) {
      const { done, value } = await reader.read();
      if (done) ctl.close(); else ctl.enqueue(value);
    },
    cancel(r) { return reader.cancel(r); },
  });
}

/** Stream SSE của Workers AI → text. Hỗ trợ cả dạng {"response":"…"} lẫn dạng OpenAI {choices:[{delta:{content}}]}. */
export function workersSseToText(body) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  const handle = (line, ctl) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const ev = JSON.parse(data);
      const t = ev.response ?? ev.choices?.[0]?.delta?.content ?? '';
      if (t) ctl.enqueue(enc.encode(t));
    } catch { /* bỏ qua */ }
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handle(line.trim(), ctl);
    },
    flush(ctl) { if (buf.trim()) handle(buf.trim(), ctl); },
  }));
}

/** Body cho Gemini: cùng system prompt + lịch sử hội thoại (assistant → 'model'). Nhiệt độ thấp: bám tài liệu. */
export function geminiBody(system, messages, maxTokens = LIMITS.maxTokens) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
  };
}

/** Stream SSE của Gemini (alt=sse) → stream text thuần. */
export function geminiSseToText(body) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  const handle = (line, ctl) => {
    if (!line.startsWith('data:')) return;
    try {
      const ev = JSON.parse(line.slice(5).trim());
      const parts = ev.candidates?.[0]?.content?.parts || [];
      const t = parts.map((p) => (p.thought ? '' : p.text || '')).join('');
      if (t) ctl.enqueue(enc.encode(t));
      if (ev.error) ctl.enqueue(enc.encode('\n\n[Lỗi từ máy chủ AI — thử lại sau.]'));
    } catch { /* dòng không phải JSON */ }
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handle(line.trim(), ctl);
    },
    flush(ctl) { if (buf.trim()) handle(buf.trim(), ctl); },
  }));
}
export const LIMITS = { messages: 20, perMessage: 2000, total: 12000, maxTokens: 800 };

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

const textHeaders = (mode, { dept, sources, qid, hideSources } = {}) => ({
  ...(qid ? { 'x-qid': qid } : {}),
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'x-chat-mode': mode,
  ...(dept ? { 'x-dept': dept.id } : {}),
  ...(!hideSources && sources && sources.length ? { 'x-sources': encodeURIComponent(JSON.stringify(sources)) } : {}),
});

/** Danh sách file nguồn (bỏ FAQ, bỏ trùng), tối đa `n` — để hiện link "📄 tên file" dưới câu trả lời. */
export function sourcesOf(chunks, n = 3) {
  const out = [];
  for (const c of chunks) {
    if (c.faq || !c.source || c.source === 'FAQ' || out.some((x) => x.name === c.source)) continue;
    out.push({ name: c.source });           // chỉ tên file — không đưa link mở/tải file gốc cho người hỏi
    if (out.length >= n) break;
  }
  return out;
}

/** Kiểm body. Trả {dept, messages} hoặc {error, status}. Tách riêng để test. */
export function validate(body, depts = DEPTS) {
  if (!body || typeof body !== 'object') return { status: 400, error: 'Body phải là JSON.' };
  const dept = typeof body.dept === 'string' ? depts.find((d) => d.id === body.dept) : null;
  if (!dept) return { status: 400, error: 'Bộ phận không hợp lệ.' };
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return { status: 400, error: 'Thiếu messages.' };
  // Giữ phần cuối hội thoại; LLM cần message đầu là user nên cắt tới user gần nhất.
  let recent = msgs.slice(-LIMITS.messages);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  let total = 0;
  for (const m of recent) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return { status: 400, error: 'Message sai định dạng.' };
    }
    if (m.content.length > LIMITS.perMessage) return { status: 413, error: `Câu hỏi dài quá (tối đa ${LIMITS.perMessage} ký tự).` };
    total += m.content.length;
  }
  if (total > LIMITS.total) return { status: 413, error: 'Hội thoại dài quá, hãy bắt đầu lại.' };
  if (!recent.length || recent[recent.length - 1].role !== 'user') {
    return { status: 400, error: 'Message cuối phải là của người dùng.' };
  }
  if (!recent[recent.length - 1].content.trim()) return { status: 400, error: 'Câu hỏi trống.' };
  return { dept, messages: recent.map((m) => ({ role: m.role, content: m.content })) };
}

/** Câu dùng để tìm tài liệu: câu hỏi mới nhất + câu hỏi trước đó (để câu nối tiếp như
 *  "còn công tác nước ngoài thì sao?" vẫn tìm đúng chủ đề). */
export function searchQuery(messages) {
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
  return users.slice(-2).join('\n');
}

const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' …' : s);

/** Kho tra cứu của một bộ phận khi KHÔNG có AI: FAQ và các đoạn tài liệu kho xếp hạng CHUNG
 *  (cùng thang điểm BM25), để một FAQ chỉ khớp lờ mờ không che mất đoạn tài liệu khớp rõ.
 *  FAQ tính bằng câu hỏi + từ khoá (không tính câu trả lời — câu trả lời dài dễ khớp nhầm). */
/** Đoạn tài liệu một bộ phận được tìm: kho riêng của nó + kho chung. */
// Giữ NGUYÊN mảng cho mỗi (kho, bộ phận): chỉ mục tìm kiếm trong _retrieve.js được cache theo
// mảng — tạo mảng mới mỗi câu hỏi là dựng lại chỉ mục mỗi lần (đã đo: ~20 ms CPU/câu, 250 đoạn).
const khoForCache = new WeakMap();
export function khoFor(dept, kho = KHO) {
  let byDept = khoForCache.get(kho);
  if (!byDept) khoForCache.set(kho, (byDept = new Map()));
  let list = byDept.get(dept.id);
  if (!list) byDept.set(dept.id, (list = [...(kho[dept.id] || []), ...(kho._chung || [])]));
  return list;
}

const corpusCache = new WeakMap();
function corpusFor(dept, kho) {
  let byDept = corpusCache.get(kho);
  if (!byDept) corpusCache.set(kho, (byDept = new Map()));
  let c = byDept.get(dept.id);
  if (!c) {
    c = [
      ...dept.faq.map((e) => ({ source: 'FAQ', part: 0, text: `${e.q}\n${e.k || ''}`, faq: e })),
      ...khoFor(dept, kho),
    ];
    byDept.set(dept.id, c);
  }
  return c;
}

/** Trả lời khi KHÔNG có AI: mục khớp nhất trong (FAQ + kho) của phòng này; không có gì thì
 *  faqAnswer (gợi ý sang phòng khác, hoặc đưa đầu mối liên hệ). */
export function offlineAnswer(dept, question, kho = KHO, depts = DEPTS) {
  return offlineReply(dept, question, kho, depts).text;
}

/** Như offlineAnswer nhưng trả kèm file nguồn: { text, sources }. */
export function offlineReply(dept, question, kho = KHO, depts = DEPTS) {
  const corpus = corpusFor(dept, kho);
  const tops = retrieve(corpus, question, 4, 2);
  const [top] = tops;
  if (top?.faq) return { text: top.faq.a, sources: [], found: true };
  if (top) {
    // Chấm từng dòng trên TOÀN BỘ đoạn của (tối đa) 2 file khớp nhất, theo đúng thứ tự trong file
    // → tiêu đề mục ở đoạn trước vẫn đi theo dòng ở đoạn sau.
    const srcs = [...new Set(tops.filter((c) => !c.faq).map((c) => c.source))].slice(0, 2);
    const pool = corpus.filter((c) => !c.faq && srcs.includes(c.source))
      .sort((x, y) => srcs.indexOf(x.source) - srcs.indexOf(y.source) || (x.part || 0) - (y.part || 0));
    const snip = bestSnippet(pool, question) || { source: top.source, url: top.url, text: clip(top.text, 700) };
    const more = tops.find((c) => !c.faq && c.source !== snip.source);
    return {
      text: snip.text,                       // tên file hiện ở nhãn nguồn bên dưới, không chèn vào câu trả lời
      sources: sourcesOf([{ source: snip.source, url: snip.url }, ...(more ? [more] : [])]),
      found: true,
    };
  }
  return { text: faqAnswer(dept, depts, question), sources: [], found: false };
}

const HEADING = /^(điều|chương|mục|phần)\s+\d+|^\d+(\.\d+)*\.\s|^[IVX]+\.\s/i;
/** Không có AI: thay vì trích cả đoạn ~1.200 ký tự từ đầu (hay rơi vào tiêu đề), chấm điểm TỪNG DÒNG
 *  (kèm tiêu đề mục chứa nó) → lấy dòng khớp nhất + tiêu đề mục (+ dòng tiêu đề bảng nếu là hàng của bảng)
 *  + dòng kế tiếp nếu cũng khớp. `chunks` phải theo thứ tự trong file. */
export function bestSnippet(chunks, question) {
  const files = new Map();                           // source → { url, ls: [{t, head}] }
  for (const c of chunks) {
    let f = files.get(c.source);
    if (!f) files.set(c.source, (f = { url: c.url, ls: [], seen: new Set(), head: '' }));
    for (const raw of c.text.split(/\n+/)) {
      const t = raw.trim();
      if (!t || f.seen.has(t)) continue;             // bỏ dòng trùng (đoạn gối đầu nhau)
      f.seen.add(t);
      const isHead = HEADING.test(t);
      if (isHead) f.head = t;
      // hàng của bảng: nhớ dòng tiêu đề bảng (hàng đầu tiên) để chấm điểm kèm ("Hạn mức tối đa" nằm ở tiêu đề cột)
      const prev = f.ls[f.ls.length - 1];
      const th = t.includes(' | ') ? (prev && prev.t.includes(' | ') ? prev.th || prev.t : '') : '';
      f.ls.push({ t, head: isHead ? '' : f.head, isHead, th });
    }
  }
  const lines = [];
  for (const [source, f] of files) {
    f.ls.forEach((l, i) => { const o = { source: '', part: i, text: l.isHead ? l.t : `${l.head} ${l.th || ''} ${l.t}`, _src: source, _f: f, _i: i }; o._orig = o; lines.push(o); });
  }
  if (!lines.length) return null;
  // BM25 thưởng dòng lặp 1 từ nhiều lần ("phụ cấp … phụ cấp"); ưu tiên dòng khớp NHIỀU TỪ KHÁC NHAU của câu hỏi hơn.
  const qt = [...new Set(tokens(question))];
  // …tính theo độ hiếm của từ (khớp "ngoài" quý hơn khớp "đi")
  // + cụm 2 tiếng liền nhau ("công tác", "tạm ứng", "trong nước") — từ tiếng Việt thường là 2 tiếng,
  //   nên "đối tác" không được tính là khớp "công tác".
  const bi = (ts) => ts.slice(1).map((t, i) => ts[i] + ' ' + t);
  //   Cụm tính trên chữ GỐC (không bỏ từ dừng) để giữ được "tối đa", "công tác", "làm việc".
  const raw = (x) => normalize(x).split(' ').filter(Boolean);
  const terms = [...new Set([...qt, ...bi(raw(question))])];
  const sets = lines.map((l) => new Set([...tokens(l.text), ...bi(raw(l.text))]));
  const w = new Map(terms.map((t) => [t, Math.log(1 + lines.length / (1 + sets.filter((x) => x.has(t)).length))]));
  const cover = (l) => { const lt = sets[lines.indexOf(l._orig)]; return terms.reduce((s, t) => s + (lt.has(t) ? w.get(t) : 0), 0); };
  const ranked = retrieve(lines, question, 10, 0.3).map((l) => ({ ...l, cov: cover(l) }))
    .sort((a, b) => b.cov - a.cov + (b.score - a.score) * 0.1);
  const [best, second] = ranked;
  if (!best) return null;
  const { _f: f, _i: i } = best;
  const ls = f.ls;
  const isRow = (j) => ls[j] && !ls[j].isHead && ls[j].t.includes(' | ');
  const isHdr = (j) => isRow(j) && !isRow(j - 1);                  // hàng đầu của bảng = tiêu đề cột
  // hàng bảng → câu: "Công tác trong nước — hạn mức tối đa mỗi lần: 10.000.000 đồng; người duyệt: quản lý trực tiếp."
  const say = (j) => {
    if (!isRow(j)) return ls[j].t;
    if (isHdr(j)) return ls[j].t.split(' | ').join(' — ');       // không rõ tiêu đề cột
    const cells = ls[j].t.split(' | ');
    const hdr = (ls[j].th || '').split(' | ');
    const lc = (x) => (/^[A-ZĐ]{2}/.test(x) ? x : x.charAt(0).toLowerCase() + x.slice(1));
    const parts = cells.slice(1).map((c, k) => (hdr[k + 1] ? `${lc(hdr[k + 1])}: ${c}` : c));
    return `${cells[0]} — ${parts.join('; ')}.`;
  };
  const body = [];
  let head = '';
  if (ls[i].isHead) {
    head = ls[i].t;
    for (let j = i + 1; j < ls.length && body.length < 3 && !ls[j].isHead; j++) if (!isHdr(j)) body.push(say(j));
  } else {
    head = ls[i].head;
    body.push(say(i));
    const next = i + 1 < ls.length && !ls[i + 1].isHead ? i + 1 : -1;
    if (next > 0 && ((second && second._f === f && second._i === next) || ls[i].t.endsWith(':'))) body.push(say(next));
  }
  // dòng khớp chỉ là tên tài liệu / tiêu đề ngắn ("Chính sách làm việc từ xa") → đưa thêm nội dung ngay dưới
  if (!ls[i].isHead && body.length === 1 && ls[i].t.length < 80 && !/\d|:/.test(ls[i].t)) {
    for (let j = i + 1; j < ls.length && body.length < 3 && !ls[j].isHead; j++) if (!isHdr(j)) body.push(say(j));
  }
  if (!body.length) body.push(head);
  const main = clip([...new Set(body)].join('\n'), 700);
  return { source: best._src, url: f.url, head, body: main, text: head && head !== main ? `${main}\n\n(Mục: ${head})` : main };
}

/** "Hỏi chung": phòng có tài liệu / FAQ khớp câu hỏi nhất, hoặc null nếu không phòng nào đủ khớp.
 *  Chỉ dùng kho ĐÃ có trong bộ nhớ đệm (không đọc Drive của mọi phòng mỗi câu hỏi).
 *  Câu hỏi nhắc thẳng tên phòng ("phòng kế toán …") được cộng điểm. */
export async function routeDept(question, depts, cfg = {}, env = {}) {
  const q = normalize(question);
  let best = null;
  for (const d of depts) {
    let kho = KHO;
    const up = d.source === 'link' ? EMPTY : await uploadedChunks(env, d.id);
    let live = null;
    if (d.source !== 'upload' && deptReady(d, cfg, env)) live = (await peekDept(d, cfg).catch(() => null))?.chunks || null;
    if (live || up.length) kho = wrap(d.id, merged(live || EMPTY, up));
    const [top] = retrieve(corpusFor(kho !== KHO ? noSampleFaq(d) : d, kho), question, 1, 1.5);
    let score = top ? top.score : 0;
    if (q.includes(normalize(d.name))) score += 3;
    if (score >= 2 && (!best || score > best.score)) best = { dept: d, score };
  }
  return best ? best.dept : null;
}

const noFaqCache = new WeakMap();
function noSampleFaq(d) {
  if (!d.faq || !d.faq.length) return d;
  let x = noFaqCache.get(d);
  if (!x) noFaqCache.set(d, (x = { ...d, faq: [], id: d.id }));
  return x;
}

export function noRouteText(depts) {
  return 'Mình chưa rõ câu này thuộc phòng ban nào. Bạn thử hỏi cụ thể hơn (ví dụ nêu tên thủ tục, giấy tờ), ' +
    `hoặc chọn phòng để hỏi trực tiếp: ${depts.map((d) => d.name).join(', ')}.`;
}

/** Stream SSE của Anthropic → stream text thuần chỉ gồm các đoạn text_delta. */
export function sseToText(body) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            ctl.enqueue(enc.encode(ev.delta.text));
          } else if (ev.type === 'error') {
            ctl.enqueue(enc.encode('\n\n[Lỗi từ máy chủ AI — thử lại sau.]'));
          }
        } catch { /* dòng SSE không phải JSON — bỏ qua */ }
      }
    },
  }));
}

// Bọc mảng đoạn của một phòng thành "kho" { [id]: chunks } — giữ NGUYÊN object cho cùng mảng để
// chỉ mục tìm kiếm (cache theo mảng/object) không bị dựng lại mỗi câu hỏi.
const wrapCache = new WeakMap();
function wrap(deptId, chunks) {
  let byId = wrapCache.get(chunks);
  if (!byId) wrapCache.set(chunks, (byId = new Map()));
  if (!byId.has(deptId)) byId.set(deptId, { [deptId]: chunks });
  return byId.get(deptId);
}

/** Kho cho phòng đang hỏi: thư mục riêng của phòng (nếu đã cấu hình) — không có/lỗi thì kho đóng gói sẵn. */
export async function currentKho(dept, cfg, env, waitUntil) {
  // Mỗi phòng MỘT nguồn: 'upload' → chỉ file tải lên (D1); 'link' → chỉ thư mục Drive/SharePoint.
  const up = dept.source === 'link' ? EMPTY : await uploadedChunks(env, dept.id);
  let live = null;
  if (dept.source !== 'upload' && deptReady(dept, cfg, env)) {
    try { live = (await liveDept(dept, cfg, env, { waitUntil })).chunks; }
    catch (e) { console.warn(`[kho] ${dept.id}: không đọc được nguồn:`, e.message); }
  }
  if (!live && !up.length) return KHO;                     // chưa có gì → kho mẫu đóng gói
  return wrap(dept.id, merged(live || EMPTY, up));
}

// Gộp đoạn Drive/SharePoint + đoạn tải lên — giữ NGUYÊN mảng cho cùng cặp đầu vào (chỉ mục BM25 cache theo mảng).
const EMPTY = Object.freeze([]);
const mergeCache = new WeakMap();
function merged(a, b) {
  if (!b.length) return a;
  if (!a.length) return b;
  let byB = mergeCache.get(a);
  if (!byB) mergeCache.set(a, (byB = new WeakMap()));
  let m = byB.get(b);
  if (!m) byB.set(b, (m = [...a, ...b]));
  return m;
}

export async function onRequestPost({ request, env: rawEnv, waitUntil }) {
  const env = await withSecrets(rawEnv);   // khoá nhập ở /admin/ thắng secret Cloudflare
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Body phải là JSON.' }); }
  const cfg = await loadConfig(env);
  const depts = hydrate(cfg.depts);
  const auto = body && body.dept === 'auto';
  const v = validate(auto ? { ...body, dept: depts[0]?.id } : body, depts);
  if (v.error) return json(v.status, { error: v.error });
  const { messages } = v;
  let { dept } = v;
  const question = messages[messages.length - 1].content;
  // Thống kê (D1): ghi ở nền, không làm chậm câu trả lời. Tắt được ở /admin/.
  const logOn = dbReady(env) && cfg.stats !== false;
  const qid = logOn ? crypto.randomUUID() : null;
  const bg = (p) => (waitUntil ? waitUntil(p) : p.catch(() => {}));
  const log = (rec) => (logOn ? logQuestion(env, { question, auto, ...rec }, Date.now(), qid) : Promise.resolve(null));
  if (auto) {
    // Dò theo CÂU MỚI NHẤT thôi: gộp câu trước dễ kéo câu lạc đề về phòng cũ. Câu nối tiếp
    // ("còn … thì sao?") nên hỏi trong chat riêng của phòng — nút "Hỏi tiếp phòng này".
    dept = await routeDept(question, depts, cfg, env);
    if (!dept) {
      bg(log({ dept: '_auto', answered: false, mode: 'route-none' }));
      return new Response(noRouteText(depts), { headers: textHeaders('route-none', { qid }) });
    }
  }
  const kho = await currentKho(dept, cfg, env, waitUntil);
  // Phòng đã có tài liệu THẬT (file tải lên / thư mục) → bỏ FAQ MẪU (dữ liệu giả) để không che tài liệu thật.
  if (kho !== KHO) dept = noSampleFaq(dept);
  const passages = retrieve(khoFor(dept, kho), searchQuery(messages));
  const meta = { dept: auto ? dept : null, qid, hideSources: !cfg.showSources };   // tên file nguồn: admin bật/tắt

  const chain = providers(env);
  if (!chain.length) {
    const r = offlineReply(dept, question, kho, depts);
    bg(log({ dept: dept.id, answered: r.found, mode: 'faq', sources: r.sources }));
    return new Response(r.text, { headers: textHeaders('faq', { ...meta, sources: r.sources }) });
  }

  const system = systemPrompt(dept, passages, depts);
  // Thử lần lượt: Claude → Gemini → Workers AI (Cloudflare). Hãng nào lỗi (key sai, hết lượt,
  // "User location is not supported"…) thì chuyển hãng sau; hết cả thì trích tài liệu.
  let stream = null;
  const errors = [];
  for (const p of chain) {
    try { stream = await startLLM(p, env, system, messages); break; }
    catch (e) {
      const m = String(e.message || e).slice(0, 300);
      console.warn(`[chat] ${p} lỗi:`, m);
      errors.push({ provider: p, error: m });
    }
  }
  if (!stream) {
    bg(saveAiError(env, { at: Date.now(), colo: request.cf?.colo || null, errors }));
    const r = offlineReply(dept, question, kho, depts);
    bg(log({ dept: dept.id, answered: r.found, mode: 'faq-fallback', sources: r.sources }));
    return new Response(r.text, { headers: textHeaders('faq-fallback', { ...meta, sources: r.sources }) });
  }
  // Chỉ hiện file của đoạn khớp rõ (≥ 60% điểm đoạn khớp nhất) — khỏi liệt kê cả file chỉ khớp lờ mờ.
  const sources = sourcesOf(passages.filter((c) => !passages[0] || (c.score || 0) >= 0.6 * (passages[0].score || 0)), 2);
  if (logOn) {
    // Ghi ngay (answered chưa biết) → đọc xong câu trả lời thì đánh dấu có trả lời được không.
    const logged = log({ dept: dept.id, answered: null, mode: 'llm', sources });
    let full = '';
    const dec = new TextDecoder();
    let finish;
    const done = new Promise((r) => { finish = r; });
    stream = stream.pipeThrough(new TransformStream({
      transform(chunk, ctl) { full += dec.decode(chunk, { stream: true }); ctl.enqueue(chunk); },
      flush() { finish(); },
    }));
    bg(logged.then(() => done).then(() => setAnswered(env, qid, !looksUnanswered(full))));
  }
  return new Response(stream, { headers: textHeaders('llm', { ...meta, sources }) });
}
