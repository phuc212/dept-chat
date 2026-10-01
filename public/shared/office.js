/* Đọc chữ trong .docx / .xlsx — chạy được cả trên Cloudflare Workers lẫn TRÌNH DUYỆT (trang admin), không thư viện ngoài.
 * .docx/.xlsx là file zip chứa XML: tự đọc mục lục zip, giải nén bằng DecompressionStream
 * ('deflate-raw', có sẵn trong Workers và Node ≥ 18), rồi bóc chữ khỏi XML bằng regex.
 * Cố ý đơn giản để tốn ít CPU (gói Free ~10 ms/request): chỉ lấy chữ, bỏ định dạng/ảnh.
 */

const dec = new TextDecoder();

/** Đọc mục lục zip → Map(tên file → {method, size, offset}). */
function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('không phải file zip hợp lệ');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count && p + 46 <= u8.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    out.set(dec.decode(u8.subarray(p + 46, p + 46 + nameLen)), { method, size, offset });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return { out, dv };
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Lấy nội dung một file trong zip dưới dạng chuỗi UTF-8, hoặc null nếu không có. */
async function readEntry(u8, entries, dv, name) {
  const e = entries.get(name);
  if (!e) return null;
  const nameLen = dv.getUint16(e.offset + 26, true), extraLen = dv.getUint16(e.offset + 28, true);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = u8.subarray(start, start + e.size);
  if (e.method === 0) return dec.decode(raw);
  if (e.method === 8) return dec.decode(await inflateRaw(raw));
  throw new Error(`kiểu nén ${e.method} chưa hỗ trợ`);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, c) =>
  c[0] === '#' ? String.fromCodePoint(c[1].toLowerCase() === 'x' ? parseInt(c.slice(2), 16) : +c.slice(1)) : (ENT[c] ?? m));

/** .docx → chữ: mỗi đoạn văn (w:p) một dòng, ô bảng cách nhau bằng " | ". */
export async function docxText(buf) {
  const u8 = new Uint8Array(buf);
  const { out, dv } = zipEntries(u8);
  const xml = await readEntry(u8, out, dv, 'word/document.xml');
  if (!xml) throw new Error('thiếu word/document.xml');
  return unxml(xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    // Trong ô bảng: đoạn văn nối bằng dấu cách, ô cách nhau " | ", hết hàng xuống dòng.
    .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (tc) => tc.replace(/<\/w:p>/g, ' ') + ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tbl>/g, '\n')
    .replace(/<\/w:p>/g, '\n\n')
    .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, '\u0000$1\u0000')
    .replace(/<[^>]+>/g, '')
    .replace(/\u0000/g, ''))
    .replace(/[ \t]*\|[ \t]*\n/g, '\n')
    .replace(/[ \t]+\|/g, ' |')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** .xlsx → chữ: mỗi sheet "Sheet <tên>:", mỗi hàng một dòng "ô | ô | ô". */
export async function xlsxText(buf) {
  const u8 = new Uint8Array(buf);
  const { out, dv } = zipEntries(u8);
  const shared = [];
  const ss = await readEntry(u8, out, dv, 'xl/sharedStrings.xml');
  if (ss) {
    for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(unxml((si.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const wb = (await readEntry(u8, out, dv, 'xl/workbook.xml')) || '';
  const names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unxml(m[1]));
  const sheets = [...out.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  const parts = [];
  for (const [i, path] of sheets.entries()) {
    const xml = await readEntry(u8, out, dv, path);
    const rows = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) || []) {
        const t = (/\bt="(\w+)"/.exec(c) || [])[1];
        const v = (/<v>([^<]*)<\/v>/.exec(c) || [])[1];
        const is = (/<is>[\s\S]*?<t[^>]*>([^<]*)<\/t>/.exec(c) || [])[1];
        cells.push(t === 's' ? shared[+v] ?? '' : unxml(is ?? v ?? ''));
      }
      if (cells.some((x) => String(x).trim())) rows.push(cells.join(' | '));
    }
    if (rows.length) parts.push(`Sheet ${names[i] || i + 1}:\n` + rows.join('\n'));
  }
  return parts.join('\n\n');
}

/** Nội dung HTTP đã tải → chữ, theo cách đọc `how` ('export' | 'plain' | 'docx' | 'xlsx'). */
export async function decodeBody(how, res) {
  if (how === 'export' || how === 'plain') return (await res.text()).replace(/^\uFEFF/, '');
  const buf = await res.arrayBuffer();
  if (how === 'docx') return docxText(buf);
  if (how === 'xlsx') return xlsxText(buf);
  return null;
}
