#!/usr/bin/env node
/* Đồng bộ KHO từ một thư mục Google Drive → functions/_kho.js.
 *
 *   node tools/sync-drive.mjs <folderId | link thư mục>      (hoặc env DRIVE_FOLDER_ID)
 *
 * Đăng nhập bằng SERVICE ACCOUNT (tài khoản dịch vụ Google Cloud), không cần ai đăng nhập tay:
 *   GOOGLE_SA_KEY_FILE=đường/dẫn/key.json   hoặc   GOOGLE_SA_KEY='{"type":"service_account",…}'
 * Thư mục Drive phải được CHIA SẺ (Người xem) cho email của service account
 * (trường `client_email` trong key.json). Không cần — và KHÔNG nên — mở "ai có link".
 *
 * Cấu trúc như kho local: thư mục con "Kế toán", "Nhân sự", "Phát triển" (hoặc id) → phòng tương
 * ứng; file ở gốc / thư mục khác → kho chung. Google Docs/Slides xuất ra chữ, Sheets ra CSV,
 * .docx/.pdf/.xlsx tải về rồi đọc như tools/build-kho.mjs.
 * Không thêm dependency: tự ký JWT bằng node:crypto rồi gọi Drive REST v3.
 */
import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKho } from './build-kho.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = join(root, '.kho-drive');          // bản sao tạm, có trong .gitignore
const API = 'https://www.googleapis.com/drive/v3';
const MAX_BYTES = 20 * 1024 * 1024;

// Google Workspace → định dạng xuất; file thường → tải nguyên bản nếu đuôi đọc được.
const EXPORT = {
  'application/vnd.google-apps.document': ['text/plain', '.txt'],
  'application/vnd.google-apps.presentation': ['text/plain', '.txt'],
  'application/vnd.google-apps.spreadsheet': ['text/csv', '.csv'],   // CSV chỉ lấy sheet đầu
};
const DOWNLOADABLE = /\.(docx|pdf|xlsx|md|txt|csv)$/i;
const FOLDER = 'application/vnd.google-apps.folder';

/** Lấy folderId từ link Drive hoặc chính id. Hàm thuần. */
export function folderIdFrom(s) {
  const m = /\/folders\/([\w-]{10,})/.exec(s || '') || /[?&]id=([\w-]{10,})/.exec(s || '');
  return m ? m[1] : (/^[\w-]{10,}$/.test(s || '') ? s : null);
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Đổi key service account lấy access token (OAuth JWT bearer, scope chỉ-đọc Drive). */
export async function accessToken(key, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: key.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = b64url(createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key));
  const res = await fetchImpl(key.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Không lấy được token Google (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

/** Tên file an toàn cho mọi hệ điều hành. */
const safe = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || '_';

/** Duyệt cây thư mục Drive, ghi bản sao vào `outDir`. Trả số file đã lấy. */
export async function mirrorFolder(folderId, outDir, token, fetchImpl = fetch, depth = 0) {
  if (depth > 6) return 0;
  const auth = { authorization: `Bearer ${token}` };
  let pageToken = '', count = 0;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const url = `${API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size)` +
      `&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetchImpl(url, { headers: auth });
    if (res.status === 404) throw new Error('Không thấy thư mục — đã chia sẻ cho email service account chưa?');
    if (!res.ok) throw new Error(`Drive lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    for (const f of data.files || []) {
      if (f.mimeType === FOLDER) {
        const sub = join(outDir, safe(f.name));
        mkdirSync(sub, { recursive: true });
        count += await mirrorFolder(f.id, sub, token, fetchImpl, depth + 1);
        continue;
      }
      let url, name = safe(f.name);
      if (EXPORT[f.mimeType]) {
        const [mime, ext] = EXPORT[f.mimeType];
        url = `${API}/files/${f.id}/export?mimeType=${encodeURIComponent(mime)}`;
        if (!name.toLowerCase().endsWith(ext)) name += ext;
      } else if (DOWNLOADABLE.test(f.name)) {
        if (Number(f.size || 0) > MAX_BYTES) { console.warn(`· Bỏ qua (>20MB): ${f.name}`); continue; }
        url = `${API}/files/${f.id}?alt=media&supportsAllDrives=true`;
      } else {
        console.warn(`· Bỏ qua (định dạng chưa đọc được): ${f.name}`);
        continue;
      }
      const r = await fetchImpl(url, { headers: auth });
      if (!r.ok) { console.warn(`· Không tải được ${f.name} (${r.status})`); continue; }
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, name), Buffer.from(await r.arrayBuffer()));
      count++;
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return count;
}

function loadKey() {
  const raw = process.env.GOOGLE_SA_KEY || (process.env.GOOGLE_SA_KEY_FILE && readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8'));
  if (!raw) throw new Error('Thiếu key service account: đặt GOOGLE_SA_KEY_FILE=đường/dẫn/key.json (hoặc GOOGLE_SA_KEY).');
  const key = JSON.parse(raw);
  if (!key.client_email || !key.private_key) throw new Error('Key không hợp lệ (thiếu client_email / private_key).');
  return key;
}

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.DRIVE_FOLDER_ID;
  const folderId = folderIdFrom(arg);
  if (!folderId) throw new Error('Cần folderId hoặc link thư mục Drive (tham số hoặc env DRIVE_FOLDER_ID).');
  const key = loadKey();
  console.log(`Drive: thư mục ${folderId} · đọc bằng ${key.client_email}`);
  const token = await accessToken(key);
  rmSync(MIRROR, { recursive: true, force: true });
  mkdirSync(MIRROR, { recursive: true });
  const n = await mirrorFolder(folderId, MIRROR, token);
  console.log(`✓ Tải ${n} file từ Drive`);
  if (!n) console.warn('· Không có file nào — kiểm tra thư mục đã chia sẻ cho ' + key.client_email + ' chưa.');
  await buildKho(MIRROR, `Google Drive ${folderId}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
}
