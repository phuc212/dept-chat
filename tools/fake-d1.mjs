/* D1 giả cho dev/test: cùng giao diện prepare().bind().run()/all()/first() với Cloudflare D1,
 * chạy trên SQLite có sẵn trong Node 22 (node:sqlite). Dữ liệu chỉ nằm trong RAM. */
// node:sqlite có từ Node 22.5 — Node cũ hơn thì fakeD1() trả null (dev chạy không có thống kê, test tự bỏ qua).
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node cũ */ }

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.args) }; }
  async first(col) { const r = this.db.prepare(this.sql).get(...this.args); return col ? r?.[col] : r ?? null; }
}

export const hasSqlite = Boolean(DatabaseSync);
export function fakeD1(file = ':memory:') {
  if (!DatabaseSync) return null;
  const db = new DatabaseSync(file);
  return { prepare: (sql) => new Stmt(db, sql) };
}
