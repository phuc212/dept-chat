/* Khớp câu hỏi với FAQ bằng từ khoá — dùng khi KHÔNG có LLM (chưa đặt ANTHROPIC_API_KEY,
 * hoặc gọi API lỗi). Hàm thuần, không phụ thuộc DOM hay Worker, để test được bằng node.
 */

/** Bỏ dấu tiếng Việt, hạ chữ thường, bỏ ký tự lạ. "Hoàn ứng?" → "hoan ung" */
export function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Từ quá phổ biến, khớp chúng không nói lên gì. ("cong ty" có ở khắp nơi → từng khớp nhầm
// "thưởng Tết của công ty" sang mục hoá đơn VAT.)
const STOP = new Set(('la gi the nao nhu sao lam cho toi minh em anh chi ban co khong duoc bao nhieu ' +
  'o dau khi nao cua va voi thi can muon hoi ve nay do cong ty moi mot cac nhung duoc roi se da dang ' +
  'phai tai vi neu hay giup xin chao').split(' '));

// Cụm hỏi chung chung phải bỏ TRƯỚC khi tách từ: "bao giờ" từng làm "giờ" khớp nhầm sang
// "Giờ làm việc" khi người dùng hỏi "Lương tháng này bao giờ có?".
const STOP_PHRASES = /\b(bao gio|luc nao|khi nao|the nao|nhu the nao|o dau|la gi|duoc khong|co khong)\b/g;

export function tokens(s) {
  return normalize(s).replace(STOP_PHRASES, ' ')
    .split(' ').filter((t) => t.length > 1 && !STOP.has(t));
}

// Trọng số IDF tính trên TOÀN BỘ FAQ của mọi bộ phận: từ hiếm ("hoan", "vat", "phep") nặng,
// từ gặp ở nhiều mục ("ngay", "tien") nhẹ. Cache theo mảng depts.
const idfCache = new WeakMap();
function idf(allDepts) {
  let m = idfCache.get(allDepts);
  if (m) return m;
  const docs = allDepts.flatMap((d) => d.faq.map((e) => new Set(tokens(e.q + ' ' + (e.k || '')))));
  const df = new Map();
  for (const doc of docs) for (const t of doc) df.set(t, (df.get(t) || 0) + 1);
  m = new Map([...df].map(([t, n]) => [t, Math.log(1 + docs.length / n)]));
  idfCache.set(allDepts, m);
  return m;
}

/** Điểm khớp: tổng IDF các token của câu hỏi có trong mục FAQ, cộng thưởng cho cụm 2 từ khớp liền.
 *  Token nằm trong `k` (từ khoá người soạn cố ý đặt) tính đủ trọng số; token chỉ có trong câu `q`
 *  tính một nửa — "thời" trong "Thời gian thử việc" không được một mình kéo "thời tiết" sang đó. */
function score(queryToks, entry, w) {
  const kToks = new Set(tokens(entry.k || ''));
  const hayToks = tokens(entry.q + ' ' + (entry.k || ''));
  const set = new Set(hayToks);
  const hay = ' ' + hayToks.join(' ') + ' ';
  let s = 0;
  for (const t of new Set(queryToks)) {
    if (set.has(t)) s += (w.get(t) || 0) * (kToks.has(t) ? 1 : 0.5);
  }
  for (let i = 0; i + 1 < queryToks.length; i++) {
    if (hay.includes(' ' + queryToks[i] + ' ' + queryToks[i + 1] + ' ')) s += 1;
  }
  return s;
}

// Ngưỡng: một từ khoá hiếm (xuất hiện ở 1–2 mục) là đủ; một từ phổ biến đứng một mình thì không.
export const MIN_SCORE = 2.2;

/** Trả {entry, score} tốt nhất trong một bộ phận, hoặc null nếu không đủ điểm.
 *  `allDepts` để tính trọng số từ; bỏ trống thì chỉ dùng FAQ của bộ phận này. */
export function bestMatch(dept, question, allDepts = [dept], minScore = MIN_SCORE) {
  const qt = tokens(question);
  if (!qt.length) return null;
  const w = idf(allDepts);
  let best = null;
  for (const e of dept.faq) {
    const s = score(qt, e, w);
    if (!best || s > best.score) best = { entry: e, score: s };
  }
  return best && best.score >= minScore ? best : null;
}

/** Câu trả lời hoàn chỉnh cho chế độ không-AI, có gợi ý sang bộ phận khác nếu hợp hơn. */
export function faqAnswer(dept, allDepts, question) {
  const here = bestMatch(dept, question, allDepts);
  let elsewhere = null;
  for (const d of allDepts) {
    if (d.id === dept.id) continue;
    const m = bestMatch(d, question, allDepts);
    if (m && (!elsewhere || m.score > elsewhere.m.score)) elsewhere = { d, m };
  }
  // Người dùng đã chọn phòng này: chỉ chuyển sang phòng khác khi bên kia khớp RÕ hơn hẳn.
  // (Bỏ dấu làm "Nam" trùng "năm" → "lương anh Nam" từng bị đẩy sang mục phép năm.)
  if (elsewhere && (!here || elsewhere.m.score > here.score * 1.5)) {
    return `Câu này có vẻ thuộc bộ phận ${elsewhere.d.name}. Bạn mở phòng ${elsewhere.d.name} để hỏi nhé.\n\n` +
      `Tham khảo nhanh: ${elsewhere.m.entry.a}`;
  }
  if (here) return here.entry.a;
  return `Mình chưa có thông tin cho câu này. Bạn liên hệ trực tiếp bộ phận ${dept.name}: ${dept.contact}.`;
}
