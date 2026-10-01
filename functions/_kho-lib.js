/* Hàm thuần dùng chung cho kho tài liệu — chạy được cả trên Node (tools/) lẫn Cloudflare
 * (functions/). Không I/O, không phụ thuộc gì ngoài DEPTS.
 */
import { DEPTS } from '../public/shared/depts.js';
import { normalize } from '../public/shared/faq-match.js';

const MAX_FILE_MB = 20;
export { MAX_FILE_MB };

export const CHUNK_CHARS = 1200;          // ~300 từ mỗi đoạn: đủ ngữ cảnh, đủ nhỏ để chọn lọc

/** Chia văn bản thành đoạn ~CHUNK_CHARS, cắt ở ranh giới đoạn văn / câu. Hàm thuần. */
export function chunkText(text, size = CHUNK_CHARS) {
  const paras = text.replace(/\r/g, '').split(/\n\s*\n+/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > size) {                     // đoạn quá dài: cắt theo câu
      push();
      let buf = '';
      for (const s of p.split(/(?<=[.!?。])\s+/)) {
        if ((buf + ' ' + s).length > size && buf) { out.push(buf.trim()); buf = ''; }
        buf += (buf ? ' ' : '') + s;
      }
      if (buf.trim()) out.push(buf.trim());
      continue;
    }
    if ((cur + '\n\n' + p).length > size) push();
    cur += (cur ? '\n\n' : '') + p;
  }
  push();
  return out;
}

/** Thư mục con → id bộ phận. Nhận cả id ("ketoan") lẫn tên hiển thị ("Kế toán", "ke-toan",
 *  "KẾ TOÁN") — để thư mục trên Drive/SharePoint đặt tên tự nhiên được. null = không khớp. */
export function deptIdForFolder(name) {
  const n = normalize(name).replace(/[\s_-]+/g, '');
  const d = DEPTS.find((x) => n === x.id || n === normalize(x.name).replace(/\s+/g, ''));
  return d ? d.id : null;
}

