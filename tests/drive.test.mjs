import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderIdFrom, accessToken, mirrorFolder } from '../tools/sync-drive.mjs';
import { deptIdForFolder } from '../tools/build-kho.mjs';

test('folderIdFrom: nhận link Drive hoặc id', () => {
  const id = '1pwLp5McpL8K7yqGJEA6TaWBI2CbGuRUE';
  assert.equal(folderIdFrom(`https://drive.google.com/drive/folders/${id}?usp=drive_link`), id);
  assert.equal(folderIdFrom(id), id);
  assert.equal(folderIdFrom('không phải link'), null);
});

test('deptIdForFolder: tên tự nhiên → id bộ phận', () => {
  assert.equal(deptIdForFolder('Kế toán'), 'ketoan');
  assert.equal(deptIdForFolder('KẾ TOÁN'), 'ketoan');
  assert.equal(deptIdForFolder('nhan-su'), 'nhansu');
  assert.equal(deptIdForFolder('phattrien'), 'phattrien');
  assert.equal(deptIdForFolder('Sales'), null);
});

test('accessToken: ký JWT đúng, scope chỉ đọc', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'bot@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let jwt;
  const tok = await accessToken(key, async (url, init) => {
    jwt = new URLSearchParams(init.body).get('assertion');
    return new Response(JSON.stringify({ access_token: 'T' }), { status: 200 });
  });
  assert.equal(tok, 'T');
  const [h, c, s] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));
  const claim = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(claim.iss, 'bot@x.iam.gserviceaccount.com');
});

test('mirrorFolder: duyệt cây, xuất Google Docs/Sheets, bỏ file lạ, đi qua trang 2', async () => {
  const tree = {
    ROOT: [[{ id: 'F1', name: 'Kế toán', mimeType: 'application/vnd.google-apps.folder' },
            { id: 'D1', name: 'Giới thiệu công ty', mimeType: 'application/vnd.google-apps.document' }],
           [{ id: 'X1', name: 'logo.png', mimeType: 'image/png' }]],       // trang 2
    F1: [[{ id: 'S1', name: 'Hạn mức', mimeType: 'application/vnd.google-apps.spreadsheet' },
          { id: 'M1', name: 'quy-che.md', mimeType: 'text/markdown', size: '20' }]],
  };
  const body = { D1: 'Keystone thành lập năm 2015.', S1: 'Hạng mục,Hạn mức\nTiếp khách,1.500.000đ', M1: '# Quy chế' };
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.authorization, 'Bearer T');
    const u = new URL(url);
    if (u.pathname.endsWith('/files')) {
      const parent = /'([\w]+)' in parents/.exec(u.searchParams.get('q'))[1];
      const page = Number(u.searchParams.get('pageToken') || 0);
      const pages = tree[parent];
      return new Response(JSON.stringify({ files: pages[page], nextPageToken: pages[page + 1] ? String(page + 1) : undefined }));
    }
    const id = u.pathname.split('/')[4];
    return new Response(body[id]);
  };
  const out = mkdtempSync(join(tmpdir(), 'drive-'));
  const n = await mirrorFolder('ROOT', out, 'T', fakeFetch);
  assert.equal(n, 3);
  assert.equal(readFileSync(join(out, 'Giới thiệu công ty.txt'), 'utf8'), body.D1);
  assert.equal(readFileSync(join(out, 'Kế toán', 'Hạn mức.csv'), 'utf8'), body.S1);
  assert.ok(existsSync(join(out, 'Kế toán', 'quy-che.md')));
  assert.ok(!readdirSync(out).includes('logo.png'));
  assert.ok(calls.some((c) => c.includes('/export?mimeType=text%2Fcsv')));
  assert.ok(calls.some((c) => c.includes('pageToken=1')));
});
