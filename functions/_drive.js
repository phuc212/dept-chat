/* Đọc Google Drive NGAY TRÊN Cloudflare (Web Crypto + fetch, không thư viện ngoài).
 * Đăng nhập bằng service account: secret GOOGLE_SA_KEY = nội dung nguyên file key.json.
 * Quyền đọc do chủ thư mục cấp: Share thư mục cho `client_email` của service account (Người xem).
 */
import { decodeBody } from './_office.js';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
export const LIMITS = { files: 300, depth: 6, bytes: 5 * 1024 * 1024, parallel: 6 };

// Google Docs/Slides → chữ, Sheets → CSV (sheet đầu). File thường: đọc theo đuôi.
const EXPORT = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};
const PLAIN = /\.(txt|md|csv)$/i;

/** Lấy folderId từ link Drive hoặc chính id. */
export function folderIdFrom(s) {
  const m = /\/folders\/([\w-]{10,})/.exec(s || '') || /[?&]id=([\w-]{10,})/.exec(s || '');
  return m ? m[1] : (/^[\w-]{10,}$/.test(s || '') ? s : null);
}

/** Loại file → cách đọc: 'export' | 'plain' | 'docx' | 'xlsx' | null (+ lý do bỏ qua). */
export function readerFor(f) {
  if (EXPORT[f.mimeType]) return { how: 'export' };
  if (f.mimeType?.startsWith('application/vnd.google-apps.')) return { how: null, why: 'loại Google này chưa đọc được' };
  if (Number(f.size || 0) > LIMITS.bytes) return { how: null, why: 'lớn hơn 5 MB' };
  if (PLAIN.test(f.name)) return { how: 'plain' };
  if (/\.docx$/i.test(f.name)) return { how: 'docx' };
  if (/\.xlsx$/i.test(f.name)) return { how: 'xlsx' };
  if (/\.pdf$/i.test(f.name)) return { how: null, why: 'PDF: trên Drive bấm chuột phải → Mở bằng Google Tài liệu để chuyển thành Google Docs' };
  if (/\.(doc|xls|ppt|pptx)$/i.test(f.name)) return { how: null, why: 'định dạng Office cũ: mở bằng Google Tài liệu/Trang tính để chuyển' };
  return { how: null, why: 'định dạng không phải văn bản' };
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

function pemToDer(pem) {
  const b = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

let tokenCache = null;   // { email, token, exp } — sống theo isolate, đỡ ký lại mỗi request

/** Service account key (object) → access token chỉ-đọc Drive. */
export async function driveToken(key, fetchImpl = fetch, now = Date.now()) {
  if (tokenCache && tokenCache.email === key.client_email && tokenCache.exp - 60_000 > now) return tokenCache.token;
  const iat = Math.floor(now / 1000);
  const aud = key.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlStr(JSON.stringify({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud, iat, exp: iat + 3600,
  }))}`;
  let k;
  try {
    k = await crypto.subtle.importKey('pkcs8', pemToDer(key.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch { throw new Error('private_key trong key.json không đọc được — tải lại file JSON từ Google Cloud (Keys → Add key → JSON).'); }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(unsigned));
  const res = await fetchImpl(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google từ chối key service account (${res.status}) — key đã bị xoá hoặc dán thiếu?`);
  const { access_token, expires_in } = await res.json();
  tokenCache = { email: key.client_email, token: access_token, exp: now + (expires_in || 3600) * 1000 };
  return access_token;
}

/** Duyệt cây thư mục → danh sách file kèm `path` (tên các thư mục cha, tính từ gốc). */
export async function listTree(folderId, token, fetchImpl = fetch) {
  const files = [];
  const queue = [{ id: folderId, path: [] }];
  while (queue.length && files.length < LIMITS.files) {
    const { id, path } = queue.shift();
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
      const url = `${API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)` +
        `&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? '&pageToken=' + pageToken : ''}`;
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 404) throw new Error('Không thấy thư mục Drive — đã Share cho email service account chưa? DRIVE_FOLDER_ID đúng chưa?');
      if (res.status === 403) throw new Error(`Drive từ chối (403) — đã bật Google Drive API cho project chưa? ${(await res.text()).slice(0, 150)}`);
      if (!res.ok) throw new Error(`Drive lỗi ${res.status}`);
      const data = await res.json();
      for (const f of data.files || []) {
        if (f.mimeType === FOLDER) { if (path.length < LIMITS.depth) queue.push({ id: f.id, path: [...path, f.name] }); }
        else files.push({ ...f, path });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken && files.length < LIMITS.files);
  }
  return files;
}

/** Nội dung chữ của một file, hoặc null. */
export async function fileText(f, token, fetchImpl = fetch) {
  const { how } = readerFor(f);
  if (!how) return null;
  const url = how === 'export'
    ? `${API}/files/${f.id}/export?mimeType=${encodeURIComponent(EXPORT[f.mimeType])}`
    : `${API}/files/${f.id}?alt=media&supportsAllDrives=true`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`tải lỗi ${res.status}`);
  return decodeBody(how, res);
}
