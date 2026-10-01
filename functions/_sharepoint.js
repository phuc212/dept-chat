/* Đọc thư mục SharePoint qua Microsoft Graph, NGAY TRÊN Cloudflare.
 *
 * Đăng nhập bằng app (client credentials) — IT của công ty phải:
 *   1. Đăng ký app trong Microsoft Entra, tạo client secret.
 *   2. Cấp quyền Application `Sites.Selected` (admin consent) và cấp quyền `read` cho app trên
 *      ĐÚNG site chứa tài liệu (app không đọc được site nào khác).
 * Cấu hình: Tenant ID + Client ID ở trang /admin/; Client secret là secret Cloudflare
 * `SHAREPOINT_CLIENT_SECRET` (không lưu trong cấu hình).
 */
import { decodeBody } from './_office.js';
import { readerFor } from './_drive.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SP_LIMITS = { files: 300, depth: 6 };

/** Link thư mục SharePoint (dán từ trình duyệt) → { host, sitePath, library, folderPath }.
 *  Nhận cả link dạng .../Forms/AllItems.aspx?id=%2Fsites%2F… lẫn .../sites/x/Shared%20Documents/thu-muc. */
export function parseSharePointUrl(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { return null; }
  if (!/\.sharepoint\.com$/i.test(u.host)) return null;
  const raw = u.searchParams.get('id') || u.searchParams.get('RootFolder') || decodeURIComponent(u.pathname);
  const m = /^\/(sites|teams)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(raw.replace(/\/+$/, ''));
  if (!m) return null;
  const rest = (m[4] || '').replace(/\/?Forms\/[^/]+\.aspx$/i, '');
  return { host: u.host, sitePath: `/${m[1]}/${m[2]}`, library: m[3], folderPath: rest };
}

let tokenCache = null;

/** Lấy access token Graph bằng client credentials. */
export async function graphToken({ tenantId, clientId, clientSecret }, fetchImpl = fetch, now = Date.now()) {
  const k = `${tenantId}|${clientId}`;
  if (tokenCache && tokenCache.k === k && tokenCache.exp - 60_000 > now) return tokenCache.token;
  const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Microsoft từ chối đăng nhập app (${res.status}) — kiểm tra Tenant ID, Client ID, SHAREPOINT_CLIENT_SECRET. ${t.slice(0, 160)}`);
  }
  const j = await res.json();
  tokenCache = { k, token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

async function graph(path, token, fetchImpl) {
  const res = await fetchImpl(path.startsWith('http') ? path : GRAPH + path, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 403 || res.status === 401) throw new Error(`SharePoint từ chối (${res.status}) — IT đã cấp quyền Sites.Selected (read) cho app trên site này chưa?`);
  if (res.status === 404) throw new Error('Không thấy site/thư mục SharePoint — kiểm tra lại link.');
  if (!res.ok) throw new Error(`Graph lỗi ${res.status}`);
  return res.json();
}

/** Tìm drive (thư viện tài liệu) + item gốc của thư mục. */
export async function resolveFolder(loc, token, fetchImpl = fetch) {
  const site = await graph(`/sites/${loc.host}:${encodeURI(loc.sitePath)}`, token, fetchImpl);
  const { value: drives = [] } = await graph(`/sites/${site.id}/drives?$select=id,name,webUrl`, token, fetchImpl);
  const lib = loc.library.toLowerCase();
  const drive = drives.find((d) => decodeURIComponent(d.webUrl || '').toLowerCase().endsWith('/' + lib))
    || drives.find((d) => d.name?.toLowerCase() === lib)
    || (lib === 'shared documents' && drives.find((d) => /^(documents|shared documents|ドキュメント|tài liệu)$/i.test(d.name)));
  if (!drive) throw new Error(`Không thấy thư viện "${loc.library}" trong site ${loc.sitePath}.`);
  const root = loc.folderPath
    ? await graph(`/drives/${drive.id}/root:/${loc.folderPath.split('/').map(encodeURIComponent).join('/')}`, token, fetchImpl)
    : await graph(`/drives/${drive.id}/root`, token, fetchImpl);
  return { driveId: drive.id, itemId: root.id, siteName: site.displayName || loc.sitePath };
}

/** Duyệt cây thư mục → file kèm `path` (tên thư mục cha tính từ gốc). */
export async function listSharePoint(root, token, fetchImpl = fetch) {
  const files = [];
  const queue = [{ id: root.itemId, path: [] }];
  while (queue.length && files.length < SP_LIMITS.files) {
    const { id, path } = queue.shift();
    let url = `/drives/${root.driveId}/items/${id}/children?$select=id,name,size,file,folder,webUrl&$top=200`;
    while (url && files.length < SP_LIMITS.files) {
      const page = await graph(url, token, fetchImpl);
      for (const it of page.value || []) {
        if (it.folder) { if (path.length < SP_LIMITS.depth) queue.push({ id: it.id, path: [...path, it.name] }); }
        else if (it.file) files.push({ id: it.id, name: it.name, size: it.size, mimeType: it.file.mimeType, path, url: it.webUrl || null });
      }
      url = page['@odata.nextLink'] || null;
    }
  }
  return files;
}

export async function sharePointText(root, f, token, fetchImpl = fetch) {
  const { how } = readerFor(f);
  if (!how) return null;
  const res = await fetchImpl(`${GRAPH}/drives/${root.driveId}/items/${f.id}/content`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`tải lỗi ${res.status}`);
  return decodeBody(how, res);
}
