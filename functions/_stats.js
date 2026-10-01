/* Thống kê câu hỏi — Cloudflare D1 (binding `DB`). Không có DB thì mọi hàm im lặng bỏ qua.
 *
 * Lưu: thời điểm, phòng, câu hỏi, bot có trả lời được không, chế độ, file nguồn, đánh giá 👍/👎.
 * KHÔNG lưu: tên, email, IP, hay bất cứ gì nhận ra người hỏi. Tự xoá bản ghi cũ hơn RETAIN_DAYS.
 * Bảng tự tạo ở lần dùng đầu — không cần chạy migration.
 */
export const RETAIN_DAYS = 180;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS questions (
     id TEXT PRIMARY KEY, at INTEGER NOT NULL, dept TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0,
     question TEXT NOT NULL, answered INTEGER, mode TEXT, sources TEXT, rating INTEGER)`,
  'CREATE INDEX IF NOT EXISTS q_at ON questions(at)',
  'CREATE INDEX IF NOT EXISTS q_dept_at ON questions(dept, at)',
];

export const dbReady = (env) => Boolean(env && env.DB && typeof env.DB.prepare === 'function');

const ready = new WeakSet();   // DB đã tạo bảng (theo từng binding)
async function ensure(db) {
  if (ready.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  ready.add(db);
}

/** Ghi một câu hỏi. Trả id (để client gửi 👍/👎) hoặc null nếu không ghi. */
export async function logQuestion(env, { dept, auto = false, question, answered = null, mode = null, sources = [] }, now = Date.now(), id = crypto.randomUUID()) {
  if (!dbReady(env)) return null;
  try {
    await ensure(env.DB);
    await env.DB.prepare('INSERT INTO questions (id, at, dept, auto, question, answered, mode, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, now, dept, auto ? 1 : 0, String(question).slice(0, 500), answered === null ? null : answered ? 1 : 0, mode,
        JSON.stringify((sources || []).map((s) => s.name)).slice(0, 1000))
      .run();
    // Dọn bản ghi cũ ~1% số lần ghi — đủ để bảng không phình, không tốn thêm mỗi câu hỏi.
    if (Math.random() < 0.01) await env.DB.prepare('DELETE FROM questions WHERE at < ?').bind(now - RETAIN_DAYS * 864e5).run();
    return id;
  } catch (e) {
    console.warn('[stats] ghi lỗi:', e.message);
    return null;
  }
}

export async function setAnswered(env, id, answered) {
  if (!dbReady(env) || !id) return;
  try { await env.DB.prepare('UPDATE questions SET answered = ? WHERE id = ?').bind(answered ? 1 : 0, id).run(); }
  catch (e) { console.warn('[stats] cập nhật lỗi:', e.message); }
}

/** 👍 = 1, 👎 = -1, 0 = bỏ đánh giá. Trả true nếu có bản ghi. */
export async function rate(env, id, rating) {
  if (!dbReady(env)) return false;
  await ensure(env.DB);
  const r = await env.DB.prepare('UPDATE questions SET rating = ? WHERE id = ?').bind(rating || null, id).run();
  return (r.meta?.changes ?? r.changes ?? 0) > 0;
}

/** Câu trả lời của AI có phải "không biết" không — theo quy tắc 1 của prompt ("chưa có thông tin"). */
export function looksUnanswered(text) {
  return /chưa có thông tin|không có (thông tin|trong tài liệu)|không tìm thấy (thông tin|trong tài liệu)/i.test(String(text).slice(0, 400));
}

const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];

/** Số liệu cho trang admin trong `days` ngày gần nhất. `tz` = lệch múi giờ (phút) để chia theo ngày địa phương. */
export async function summary(env, { days = 30, tz = 420, now = Date.now() } = {}) {
  if (!dbReady(env)) return null;
  await ensure(env.DB);
  const db = env.DB;
  const since = now - days * 864e5;
  const off = tz * 60000;
  const [tot] = await all(db, `SELECT COUNT(*) n, SUM(answered = 1) ok, SUM(answered = 0) miss,
      SUM(rating = 1) up, SUM(rating = -1) down, SUM(auto = 1) auto FROM questions WHERE at >= ?`, since);
  const byDept = await all(db, `SELECT dept, COUNT(*) n, SUM(answered = 0) miss, SUM(rating = -1) down
      FROM questions WHERE at >= ? GROUP BY dept ORDER BY n DESC`, since);
  const byDay = await all(db, `SELECT CAST((at + ?) / 86400000 AS INTEGER) d, COUNT(*) n, SUM(answered = 0) miss
      FROM questions WHERE at >= ? GROUP BY d ORDER BY d`, off, since);
  const unanswered = await all(db, `SELECT lower(trim(question)) q, MIN(question) sample, dept, COUNT(*) n, MAX(at) last
      FROM questions WHERE at >= ? AND answered = 0 GROUP BY q, dept ORDER BY n DESC, last DESC LIMIT 30`, since);
  const disliked = await all(db, `SELECT question, dept, at, sources FROM questions
      WHERE at >= ? AND rating = -1 ORDER BY at DESC LIMIT 30`, since);
  const top = await all(db, `SELECT lower(trim(question)) q, MIN(question) sample, dept, COUNT(*) n
      FROM questions WHERE at >= ? GROUP BY q, dept HAVING n > 1 ORDER BY n DESC LIMIT 15`, since);
  const recent = await all(db, `SELECT question, dept, at, answered, rating, auto FROM questions
      WHERE at >= ? ORDER BY at DESC LIMIT 50`, since);
  const num = (x) => Number(x || 0);
  return {
    days, since,
    total: num(tot?.n), answered: num(tot?.ok), missed: num(tot?.miss), up: num(tot?.up), down: num(tot?.down), auto: num(tot?.auto),
    byDept: byDept.map((r) => ({ dept: r.dept, n: num(r.n), miss: num(r.miss), down: num(r.down) })),
    byDay: byDay.map((r) => ({ day: new Date(num(r.d) * 864e5).toISOString().slice(0, 10), n: num(r.n), miss: num(r.miss) })),
    unanswered: unanswered.map((r) => ({ question: r.sample, dept: r.dept, n: num(r.n), last: num(r.last) })),
    disliked: disliked.map((r) => ({ question: r.question, dept: r.dept, at: num(r.at), sources: safeJson(r.sources) })),
    top: top.map((r) => ({ question: r.sample, dept: r.dept, n: num(r.n) })),
    recent: recent.map((r) => ({ question: r.question, dept: r.dept, at: num(r.at), answered: r.answered, rating: r.rating, auto: Boolean(r.auto) })),
  };
}

/** Toàn bộ câu hỏi trong khoảng (cho nút Tải CSV). */
export async function exportRows(env, { days = 30, now = Date.now() } = {}) {
  if (!dbReady(env)) return [];
  await ensure(env.DB);
  return all(env.DB, 'SELECT at, dept, auto, question, answered, rating, mode, sources FROM questions WHERE at >= ? ORDER BY at DESC LIMIT 20000', now - days * 864e5);
}

export async function clearAll(env) {
  if (!dbReady(env)) return;
  await ensure(env.DB);
  await env.DB.prepare('DELETE FROM questions').run();
}

function safeJson(s) { try { return JSON.parse(s) || []; } catch { return []; } }
