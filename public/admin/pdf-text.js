/* Rút CHỮ khỏi PDF ngay trên trình duyệt bằng pdf.js (thư viện của Mozilla, nằm ở /vendor/pdfjs/).
 * Chỉ nạp khi người dùng chọn file PDF — trang admin không nặng thêm.
 * PDF scan (toàn ảnh) không có chữ → ném lỗi kèm hướng dẫn chuyển qua Google Tài liệu (OCR).
 */
const VERSION = '6.3.289';
let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import('/vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return lib;
}

export const SCAN_HINT = 'File này là bản scan (ảnh chụp) — không có chữ để đọc. Cách xử lý: tải lên Google Drive → chuột phải → Mở bằng → Google Tài liệu (Google tự nhận dạng chữ) → kiểm tra lại dấu, số liệu → Tệp → Tải xuống → .docx → tải file .docx đó lên đây.';

/** Một trang → chữ. KHÔNG tin thứ tự mẩu chữ trong file: PDF tiếng Việt hay tách chữ có dấu (ố, ệ, ượ…)
 *  sang font dự phòng và vẽ SAU cả dòng, chèn vào GIỮA một cụm chữ khác. Nên dựng lại theo VỊ TRÍ:
 *  gom thành dòng theo y → rải từng ký tự theo x (ước lượng trong cụm) → xếp theo x → nối lại.
 *  Khoảng trống dọc lớn giữa 2 dòng = sang đoạn mới. */
export function pageText(items) {
  const bits = [];
  for (const it of items) {
    if (!('str' in it) || !it.transform || !it.str) continue;
    const [a, b, , d, x, y] = it.transform;
    const size = Math.hypot(a, b) || Math.abs(d) || it.height || 10;
    const str = it.str.replace(/[\u0000-\u001f\u007f]/g, '');       // mã điều khiển = glyph ánh xạ lỗi → bỏ
    if (!str) continue;
    // cụm toàn dấu cách mà rộng bất thường = chỗ trống giữ chỗ cho font khác → bỏ
    if (!str.trim() && (it.width || 0) > size * 0.6) continue;
    bits.push({ s: str, x, y, w: it.width || 0, size });
  }
  if (!bits.length) return '';
  bits.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines = [];
  for (const t of bits) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - t.y) < Math.min(line.size, t.size) * 0.5) { line.bits.push(t); line.size = Math.max(line.size, t.size); }
    else lines.push({ y: t.y, size: t.size, bits: [t] });
  }
  let out = '', prev = null;
  for (const ln of lines) {
    // rải ký tự: mỗi ký tự một toạ độ x (chia đều độ rộng cụm) → xếp lại theo x
    const chars = [];
    ln.bits.sort((p, q) => p.x - q.x);
    let lastEnd = null;
    for (const t of ln.bits) {
      const cs = [...t.s];
      const cw = t.w / Math.max(1, cs.length);
      // cụm cách cụm trước một khoảng rõ → chèn dấu cách
      if (lastEnd !== null && t.x - lastEnd > t.size * 0.18) chars.push({ c: ' ', x: t.x - 0.01 });
      cs.forEach((c, i) => chars.push({ c, x: t.x + cw * (i + 0.5) }));
      lastEnd = Math.max(lastEnd ?? -Infinity, t.x + t.w);
    }
    chars.sort((p, q) => p.x - q.x);
    const txt = chars.map((c) => c.c).join('').replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    if (prev) out += prev.y - ln.y > Math.max(prev.size, ln.size) * 1.9 ? '\n\n' : '\n';
    out += txt;
    prev = ln;
  }
  return out.normalize('NFC');
}

/** → { text, pages, emptyPages, garbled } ; bản scan hoàn toàn → throw Error(SCAN_HINT). */
export async function pdfText(buf, onProgress = () => {}) {
  const { getDocument } = await pdfjs();
  let doc, task;
  try {
    task = getDocument({
      data: new Uint8Array(buf), isEvalSupported: false,
      cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/cmaps/`, cMapPacked: true,
    });
    doc = await task.promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('PDF có mật khẩu — mở khoá rồi tải lại.');
    throw new Error('Không mở được PDF (file hỏng?).');
  }
  const parts = [];
  let emptyPages = 0, total = 0, broken = 0;
  try {
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress(p, doc.numPages);
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items;
    for (const it of items) if (it.str) { total += it.str.length; broken += (it.str.match(/[\u0000-\u001f]/g) || []).length; }
    const t = pageText(items);
    if (t.replace(/\s/g, '').length < 15) emptyPages++;          // trang không có chữ (ảnh / trang trắng)
    else parts.push(t);
    page.cleanup();
  }
  } finally { task.destroy().catch?.(() => {}); }
  const pages = doc.numPages;
  const text = parts.join('\n\n');
  // Hầu như không có chữ → coi là bản scan
  if (text.replace(/\s/g, '').length < 100 || emptyPages / pages > 0.8) {
    throw new Error(SCAN_HINT);
  }
  // Font trong PDF ánh xạ lỗi (hay gặp khi máy xuất PDF thiếu font tiếng Việt) → dấu có thể sai
  const garbled = total && broken / total > 0.003;
  return { text, pages, emptyPages, garbled };
}
