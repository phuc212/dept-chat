/* Nguồn tài liệu dùng chung một giao diện — bot không cần biết tài liệu nằm ở đâu:
 *   { kind, account, list() → [{id,name,mimeType,size,path}], text(file) → string|null, urlOf(file) → link mở file }
 * Loại nguồn TỰ NHẬN theo link: drive.google.com → Google Drive, *.sharepoint.com → SharePoint.
 * Thêm nguồn mới = thêm một nhánh ở kindOf + makeSource, không đụng tới bot.
 */
import { folderIdFrom, driveToken, listTree, fileText } from './_drive.js';
import { parseSharePointUrl, graphToken, resolveFolder, listSharePoint, sharePointText } from './_sharepoint.js';

/** 'gdrive' | 'sharepoint' | null */
export function kindOf(link) {
  if (!link) return null;
  if (/drive\.google\.com/i.test(link) && folderIdFrom(link)) return 'gdrive';
  if (parseSharePointUrl(link)) return 'sharepoint';
  return null;
}

/** Thiếu gì để đọc được link này — danh sách lý do (rỗng = đủ). */
export function missingFor(link, cfg, env) {
  const kind = kindOf(link);
  if (!link) return ['chưa có link thư mục'];
  if (!kind) return ['link không phải thư mục Google Drive / SharePoint'];
  const miss = [];
  if (kind === 'gdrive' && !env.GOOGLE_SA_KEY) miss.push('khoá Google Drive — nhập file key.json ở mục “Khoá kết nối” (GOOGLE_SA_KEY)');
  if (kind === 'sharepoint') {
    if (!env.SHAREPOINT_CLIENT_SECRET) miss.push('client secret SharePoint — nhập ở mục SharePoint (SHAREPOINT_CLIENT_SECRET)');
    if (!cfg.tenantId) miss.push('Tenant ID (mục SharePoint)');
    if (!cfg.clientId) miss.push('Client ID (mục SharePoint)');
  }
  return miss;
}

/** Email service account Google (trang admin hiện ra để Share thư mục cho nó). */
export function googleAccount(env) {
  try { return JSON.parse(env.GOOGLE_SA_KEY).client_email || null; } catch { return null; }
}

export async function makeSource(link, cfg, env, fetchImpl = fetch, now = Date.now()) {
  const kind = kindOf(link);
  if (kind === 'gdrive') {
    let key;
    try { key = JSON.parse(env.GOOGLE_SA_KEY); } catch { throw new Error('Khoá Google Drive không phải JSON — nhập lại file key.json ở mục “Khoá kết nối”.'); }
    const folderId = folderIdFrom(link);
    const token = await driveToken(key, fetchImpl, now);
    return { kind, account: key.client_email, list: () => listTree(folderId, token, fetchImpl), text: (f) => fileText(f, token, fetchImpl),
      urlOf: (f) => `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view` };
  }
  if (kind === 'sharepoint') {
    const token = await graphToken({ tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: env.SHAREPOINT_CLIENT_SECRET }, fetchImpl, now);
    const root = await resolveFolder(parseSharePointUrl(link), token, fetchImpl);
    return { kind, account: `app ${cfg.clientId}`, list: () => listSharePoint(root, token, fetchImpl), text: (f) => sharePointText(root, f, token, fetchImpl),
      urlOf: (f) => f.url || null };
  }
  throw new Error('Link không phải thư mục Google Drive / SharePoint.');
}
