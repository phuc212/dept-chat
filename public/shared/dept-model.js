/* Phòng ban ĐỘNG: danh sách thêm/xoá ở /admin/ (lưu KV), còn depts.js là MẶC ĐỊNH + FAQ mẫu.
 * Dùng chung cho trình duyệt (vẽ bản đồ) và server (chat, prompt, kho).
 *
 * Mỗi phòng lưu tối thiểu { id, name, folder?, contact?, scope?, color? }. Hàm hydrate() bù phần
 * còn thiếu: màu, màu sàn, tên trợ lý, phạm vi mặc định, và FAQ mẫu nếu id trùng phòng mặc định.
 */
import { DEPTS } from './depts.js';
import { normalize } from './faq-match.js';

export const MAX_DEPTS = 8;

// Bảng màu cho phòng mới: đủ tương phản với chữ trắng trên biển tên.
export const PALETTE = ['#e8a33d', '#d9607a', '#4a8fd9', '#3f9f7a', '#8a6ad8', '#d4763b', '#2f9bb3', '#b9577f'];

/** Màu sàn nhạt từ màu chính (trộn 78% trắng). */
export function floorOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#eeeeee';
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.78);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('');
}

/** "Chăm sóc khách hàng" → "cham-soc-khach-hang" (id ổn định, chỉ a-z0-9-). */
export function slugify(name) {
  return normalize(name).replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'phong';
}

/** Danh sách lưu trữ → danh sách đầy đủ để vẽ & chat. `null` → dùng mặc định. */
export function hydrate(list) {
  const src = Array.isArray(list) && list.length ? list : DEPTS.map(({ id, name, contact, scope }) => ({ id, name, contact, scope, folder: '' }));
  return src.slice(0, MAX_DEPTS).map((d, i) => {
    const def = DEPTS.find((x) => x.id === d.id);
    const color = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : (def?.color || PALETTE[i % PALETTE.length]);
    return {
      id: d.id,
      name: d.name,
      ja: d.ja ?? def?.ja ?? '',
      color,
      floor: def && def.color === color ? def.floor : floorOf(color),
      bot: `Trợ lý ${d.name}`,
      contact: d.contact || def?.contact || `bộ phận ${d.name}`,
      scope: d.scope || def?.scope || `công việc và quy định của bộ phận ${d.name}`,
      folder: d.folder || '',
      source: d.source === 'link' || d.source === 'upload' ? d.source : (d.folder ? 'link' : 'upload'),
      faq: def?.faq || [],
      // Lời chào + câu gợi ý: admin nhập thì dùng, không thì lấy từ FAQ mẫu (nếu có).
      greeting: d.greeting || '',
      suggest: Array.isArray(d.suggestions) && d.suggestions.length ? d.suggestions.slice(0, 5) : (def?.faq || []).slice(0, 4).map((e) => e.q),
    };
  });
}

/** Bản công khai cho trình duyệt: bỏ link thư mục (không bí mật, nhưng người chat không cần). */
export const publicDepts = (depts) => depts.map(({ folder, ...rest }) => rest);
