#!/usr/bin/env node
/* Đóng gói bản DEMO một file để publish thành Artifact trên claude.ai (có URL mở được ngay,
 * không cần Cloudflare, không cần API key).
 *
 *   node tools/build-artifact.mjs      → dist-artifact/index.html
 *
 * Khác bản thật đúng một chỗ: thay vì POST /api/chat, bot hỏi Claude bằng capability `sample`
 * của Artifact (chạy trên tài khoản Claude của NGƯỜI XEM, lần đầu hỏi sẽ xin phép). Không có
 * capability đó thì rơi về FAQ từ khoá — y như bản thật khi thiếu ANTHROPIC_API_KEY.
 * Nguồn dữ liệu, prompt, bản đồ, UI chat: dùng NGUYÊN các file trong public/, không chép tay.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Thứ tự theo phụ thuộc. Bỏ dòng import, bỏ chữ `export ` — mọi thứ về chung một scope module.
const MODULES = [
  'public/shared/depts.js',
  'public/shared/faq-match.js',
  'public/shared/dept-model.js',
  'public/shared/prompt.js',
  'public/src/map.js',
  'public/src/chat.js',
];
const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

const ASK = `
// ── Demo: hỏi Claude qua capability \`sample\`, không có thì dùng FAQ ─────────────
const samplePromise = window.claude?.use ? window.claude.use('sample') : Promise.resolve(null);
let aiOff = false;
const PERMANENT = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);
globalThis.DEPT_CHAT_ASK = async (dept, history, onText) => {
  const q = history[history.length - 1].content;
  const sample = aiOff ? null : await samplePromise;
  if (!sample) return { text: faqAnswer(dept, DEPTS, q), mode: 'faq' };
  const rules = systemPrompt(dept) + '\\n\\n(Trên đây là vai trò và luật của bạn. Hội thoại với nhân viên bắt đầu từ lượt sau.)';
  const turns = [{ role: 'user', content: rules }, ...history.slice(-12)];
  try {
    const { text } = await sample(turns, { cache: false, modelTier: 'quick', onText: ({ text }) => onText(text) });
    return { text, mode: 'llm' };
  } catch (e) {
    if (PERMANENT.has(e?.code)) aiOff = true;
    if (e?.code === 'rate_limited') throw new Error('Hỏi hơi nhanh — đợi một chút rồi gửi lại nhé.');
    return { text: faqAnswer(dept, DEPTS, q), mode: 'faq-fallback' };
  }
};
`;

const main = strip(read('public/src/main.js'));
const js = MODULES.map((p) => `// ── ${p} ──\n${strip(read(p))}`).join('\n') + ASK + `\n// ── public/src/main.js ──\n${main}`;

const html = read('public/index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script type="module" src="[^"]+"><\/script>/, '')
  .replace('Hỏi đáp bộ phận</strong>', 'Văn phòng Hỏi đáp</strong>')
  .replace('câu trả lời chưa phải quy định thật của công ty.',
    'câu trả lời chưa phải quy định thật của công ty. Bản demo: AI chạy bằng tài khoản Claude của bạn (lần đầu sẽ hỏi quyền).');
const css = read('public/src/style.css')
  .replace('.chat {\n  position: fixed; top: 12px; right: 12px; bottom: 12px;',
    '.chat {\n  position: fixed; top: calc(12px + env(safe-area-inset-top, 0px)); right: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px));');

const out = `<title>Văn phòng Hỏi đáp</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap">
<style>
${css}
</style>
${body.trim()}
<script type="module">
${js}
</script>
`;
mkdirSync(join(root, 'dist-artifact'), { recursive: true });
writeFileSync(join(root, 'dist-artifact/index.html'), out);
console.log(`dist-artifact/index.html  ${(out.length / 1024).toFixed(1)} KB`);
