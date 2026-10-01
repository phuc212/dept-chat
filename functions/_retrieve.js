/* Tìm các đoạn tài liệu liên quan nhất tới câu hỏi trong kho của MỘT bộ phận.
 * Hàm thuần (không I/O) để test được. Cách chấm: BM25 đơn giản trên token đã bỏ dấu —
 * đủ tốt cho vài trăm đoạn, không cần vector DB hay dịch vụ ngoài.
 */
import { tokens } from '../public/shared/faq-match.js';

const cache = new WeakMap();

function index(chunks) {
  let ix = cache.get(chunks);
  if (ix) return ix;
  const docs = chunks.map((c) => {
    const toks = tokens(c.source.replace(/\.[a-z]+$/i, '').replace(/[-_/]/g, ' ') + ' ' + c.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { tf, len: toks.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
  ix = { docs, df, avg, n: docs.length };
  cache.set(chunks, ix);
  return ix;
}

/** Trả tối đa `k` đoạn {source, part, text, score}, điểm giảm dần, bỏ đoạn điểm quá thấp. */
export function retrieve(chunks, question, k = 6, minScore = 1.5) {
  if (!chunks || !chunks.length) return [];
  const q = [...new Set(tokens(question))];
  if (!q.length) return [];
  const { docs, df, avg, n } = index(chunks);
  const K1 = 1.2, B = 0.75;
  const scored = docs.map((d, i) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      // Kho rất nhỏ (phòng mới chỉ 1–2 file): IDF của BM25 gần 0 dù từ khớp đúng → đặt sàn.
      const idf = Math.max(Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5)), n < 10 ? 1 : 0);
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avg));
    }
    return { i, s };
  }).filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, k);
  return scored.map(({ i, s }) => ({ ...chunks[i], score: s }));
}
