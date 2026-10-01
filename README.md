# dept-chat — Hỏi đáp bộ phận

Bản thu gọn từ `kstns-office` (Keystone Quest): bản đồ 2D chỉ còn **3 phòng — Kế toán ·
Nhân sự · Phát triển**. Đi vào phòng và nhấn `E` cạnh trợ lý, hoặc bấm thẳng vào phòng
(hay nút trên thanh trên cùng), là mở chatbot trả lời câu hỏi của bộ phận đó.

## Chạy ở máy

```bash
cp .dev.vars.example .dev.vars   # điền SITE_PASSWORD, và ANTHROPIC_API_KEY nếu muốn bật AI
npm run dev                      # → http://localhost:8788  (user gõ gì cũng được, pass = SITE_PASSWORD)
npm test                         # test, không cần browser, không cần mạng
```

`npm run dev` không cần cài gì (chỉ cần Node ≥ 20): nó chạy đúng mã trong `functions/`.
Muốn giả lập Cloudflare sát hơn: `npm i` rồi `npm run dev:cf`.

## Bản demo trên claude.ai

`node tools/build-artifact.mjs` đóng gói toàn bộ thành `dist-artifact/index.html`, một file
publish được thành Artifact. Bản demo không gọi `/api/chat`: nó hỏi Claude bằng tài khoản
của chính người xem (lần đầu sẽ hỏi quyền), và không có thì dùng FAQ.

## Cách bot trả lời

| Có `ANTHROPIC_API_KEY`? | Chế độ | Hành vi |
|---|---|---|
| có | `llm` | Claude trả lời, stream từng chữ. System prompt gồm phạm vi bộ phận + **toàn bộ FAQ của bộ phận đó**; không có trong FAQ thì bot nói chưa có thông tin và đưa đầu mối liên hệ, không bịa. Hỏi sai phòng thì chỉ sang phòng đúng. |
| không | `faq` | Khớp từ khoá (không dấu cũng được) với FAQ. Không tốn tiền, nhưng chỉ trả lời được câu đã soạn. |
| có, nhưng API lỗi | `faq-fallback` | Tự rơi về FAQ để người dùng không bị trắng tay. |

Key chỉ nằm ở server (`functions/api/chat.js`), không bao giờ tới trình duyệt. Lịch sử chat
chỉ nằm trong RAM của tab: tải lại trang là mất, và server không lưu câu hỏi nào.

## Kho tài liệu (SharePoint / Google Drive) — bot trả lời từ tài liệu của bạn

Ngoài FAQ, bot đọc được **kho tài liệu**: Word (.docx), PDF, Excel (.xlsx), Markdown, .txt.
Bot chỉ trả lời từ FAQ + kho, không dùng internet hay kiến thức ngoài, và ghi nguồn "(Nguồn: tên-file)".

```
kho/
  ketoan/      ← tài liệu Kế toán (thư mục con sâu hơn cũng được)
  nhansu/      ← tài liệu Nhân sự
  phattrien/   ← tài liệu Phát triển
```

**Lấy từ SharePoint / Drive — không cần API, không cần xin quyền admin:**

- *SharePoint*: mở thư viện tài liệu → bấm **Sync** → OneDrive tạo thư mục trên máy
  (vd. `C:\Users\<bạn>\<Công ty>\Tai lieu chatbot`). Bên trong tạo 3 thư mục `ketoan`, `nhansu`, `phattrien`.
- *Google Drive*: cài **Google Drive for desktop** → thư mục Drive hiện ở ổ `G:`.

Cập nhật kho (mỗi lần tài liệu đổi):

```powershell
npm.cmd install                                            # một lần: cài thư viện đọc Word/PDF/Excel
npm.cmd run kho -- "C:\đường\dẫn\thư mục đã sync"          # hoặc bỏ trống để đọc ./kho
npx.cmd wrangler pages deploy public --project-name dept-chat --branch main
```

- Kho nằm trong `functions/_kho.js` — **chỉ server đọc**, trình duyệt không tải được (khác FAQ).
  File này có trong `.gitignore`: đừng commit tài liệu nội bộ lên git.
- Bot tìm 6 đoạn liên quan nhất (BM25, bỏ dấu) rồi đưa cho Claude; không có AI thì trích nguyên đoạn khớp nhất kèm tên file.
- .doc/.xls/.ppt đời cũ: mở và "Save as" .docx/.xlsx/.pdf. PDF dạng ảnh scan không có chữ thì không đọc được.
- Giới hạn: Pages Functions gói Free cho bundle ~3 MB (nén). Kho vài trăm trang văn bản vẫn vừa;
  lớn hơn thì cần chuyển kho sang R2/D1 (hỏi lại khi tới lúc).

## Nguồn tài liệu — cấu hình trên web ở `/admin/`

Không cần sửa code hay chạy lệnh: vào **`https://<site>/admin/`**. **Mỗi phòng ban = 1 chatbot = 1 link thư mục riêng.**

- **＋ Thêm phòng ban** (tối đa 8) → đặt tên, chọn màu, dán link thư mục Drive/SharePoint → **Kiểm tra** (đọc thử, chưa lưu).
- **×** trên mỗi phòng → hộp thoại cảnh báo → xoá. Tài liệu trên Drive/SharePoint không bị động tới.
- Mọi thay đổi chỉ áp dụng khi bấm **Lưu**; bản đồ tự vẽ lại (1 hàng khi ≤ 4 phòng, 2 hàng khi 5–8).
- Link trống = phòng chỉ trả lời từ FAQ mẫu. Mỗi phòng chỉ đọc thư mục của nó (kể cả thư mục con).

Đọc được: Google Docs/Slides/Sheets, .docx, .xlsx, .txt, .md, .csv. PDF: mở bằng Google Tài liệu để chuyển.
Server tự đọc lại theo chu kỳ chọn ở /admin/ (mặc định 10 phút), trả bản cũ trong lúc đọc lại.

**Cài một lần trên Cloudflare dashboard** (Workers & Pages → dept-chat):

| Ở đâu | Tên | Giá trị |
|---|---|---|
| Settings → Variables and Secrets (Secret) | `ADMIN_PASSWORD` | mật khẩu vào /admin/ (≥ 8 ký tự, khác mật khẩu site) |
| Settings → Bindings → KV namespace | `CONFIG` | một KV namespace bất kỳ (tạo ở Storage & Databases → KV) — nơi lưu cấu hình |
| Settings → Bindings → D1 database (tuỳ chọn) | `DB` | database D1 (`npx wrangler d1 create dept-chat-db`) — thống kê câu hỏi, 👍/👎. Bảng tự tạo. |

Sau khi thêm secret/binding: deploy lại một lần. Từ đó mọi thứ còn lại làm trên /admin/:

| Trên /admin/ | Việc |
|---|---|
| Phòng ban | thêm / xoá phòng, link thư mục từng phòng, nút Kiểm tra, **tải file lên trực tiếp** (.docx/.xlsx/.txt/.md/.csv — cần D1) |
| Khoá kết nối | chọn file key.json của Google (`GOOGLE_SA_KEY`), API key Claude (`ANTHROPIC_API_KEY`) |
| SharePoint | Tenant ID, Client ID, client secret (`SHAREPOINT_CLIENT_SECRET`) |
| Tab Thống kê | số câu hỏi, % trả lời được, theo ngày / phòng, câu bot chưa trả lời được, câu bị 👎, tải CSV. Tắt/bật ở Cài đặt chung. Lưu ẩn danh, tự xoá sau 180 ngày. |

Khoá nhập trên /admin/ lưu trong KV (key `app-secrets`), **chỉ ghi, không đọc lại**, và thắng secret
Cloudflare cùng tên (secret Cloudflare vẫn dùng được làm dự phòng). Đánh đổi: ai vào được tài khoản
Cloudflare thì xem được giá trị trong KV — nếu cần chặt hơn, đặt khoá bằng secret Cloudflare thay vì trên web.

- **Không có `wrangler.toml`** là cố ý: có file đó thì Cloudflare khoá phần Variables/Bindings trên dashboard.
  (Mẫu ở `wrangler.example.toml` nếu muốn quản lý bằng code.)
- Không API nào trả giá trị khoá về trình duyệt — /admin/ chỉ báo "đã có" + vài ký tự cuối / email bot.
- /admin/ nằm sau mật khẩu site **và** `ADMIN_PASSWORD`: người chat không sửa được cấu hình.
- Gói Free: mỗi request gọi ra ngoài tối đa ~50 lần → thư mục trên ~40 file nên nâng Workers Paid (5 USD/tháng).

## Sửa FAQ

**`public/shared/depts.js`** là nguồn duy nhất: tên, màu, đầu mối liên hệ, phạm vi và FAQ
của từng bộ phận. Client (câu gợi ý) và server (prompt cho AI) cùng đọc file này.

- ⚠️ **FAQ hiện là dữ liệu MẪU.** Thay bằng quy định thật rồi đặt `SAMPLE_DATA = false`
  để tắt banner vàng.
- File này được serve tĩnh, nên ai qua được mật khẩu đều đọc được. Đừng để thông tin mật.
- Thêm bộ phận thứ 4: thêm một phần tử vào `DEPTS`, bản đồ tự chia thêm phòng.

## Deploy (Cloudflare Pages) — giống keystone-quest.pages.dev

Sau khi deploy, site nằm ở **https://dept-chat.pages.dev**: ai có link và mật khẩu đều vào
được như một trang web bình thường, không cần tài khoản Claude.

**Cách 1 — tự động (khuyên dùng, giống kstns-office):** merge vào `main` là GitHub Actions
chạy test rồi deploy (`.github/workflows/deploy.yml`).

0. Chuyển `ci/deploy.yml` vào `.github/workflows/deploy.yml` (GitHub chỉ đọc workflow ở đó).
1. Tạo repo GitHub (vd. `Keystone-Solution/dept-chat`) rồi push project này lên.
2. Repo → Settings → Environments → tạo `production` → thêm secret:
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (dùng chung được với kstns-office),
   `SITE_PASSWORD`, và `ANTHROPIC_API_KEY` nếu muốn bật AI.
3. Push lên `main` (hoặc Actions → deploy → Run workflow).

**Cách 2 — tay, từ máy mình:**

```bash
npx wrangler login
npx wrangler pages project create dept-chat --production-branch main
npx wrangler pages secret put SITE_PASSWORD --project-name dept-chat
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name dept-chat   # tuỳ chọn
npx wrangler pages deploy public --project-name dept-chat --branch main
```

Thiếu `SITE_PASSWORD` thì site **chặn hết** (fail-closed). Tên `dept-chat` đã có người dùng
trên pages.dev thì đổi tên project (và `PROJECT` trong workflow, `name` trong wrangler.toml).

## Cấu trúc

```
public/                    ← static (pages_build_output_dir)
  index.html
  shared/depts.js          ← dữ liệu 3 bộ phận + FAQ  (sửa ở đây)
  shared/faq-match.js      ← khớp từ khoá (dùng cho chế độ không-AI)
  shared/prompt.js         ← system prompt / luật trả lời của bot
  src/map.js               ← bố cục phòng, sinh từ DEPTS; va chạm
  src/main.js              ← vòng lặp game: đi, E, click, vẽ canvas
  src/chat.js              ← panel chat, stream, lịch sử theo bộ phận
  src/style.css
functions/
  _middleware.js           ← basic auth một mật khẩu
  api/chat.js              ← POST /api/chat → Claude (hoặc FAQ/kho)
  _retrieve.js             ← tìm đoạn tài liệu liên quan (BM25)
  _kho.js                  ← SINH RA bởi `npm run kho` — không commit (dự phòng khi chưa bật Drive)
  _kho-live.js             ← kho sống: đọc Google Drive + bộ nhớ đệm
  _drive.js                ← Drive API bằng Web Crypto (service account)
  _office.js               ← đọc chữ .docx/.xlsx ngay trên Cloudflare
  api/kho.js               ← GET /api/kho — trạng thái kho, ?refresh=1
  api/admin/               ← /api/admin/config (GET/PUT), /api/admin/test — cần ADMIN_PASSWORD
  _config.js               ← cấu hình nguồn (KV CONFIG)
  _sources.js              ← giao diện chung cho các nguồn
  _sharepoint.js           ← SharePoint qua Microsoft Graph
public/admin/              ← trang quản trị nguồn tài liệu
tools/build-kho.mjs        ← đọc thư mục kho (Word/PDF/Excel/MD) → functions/_kho.js
tools/sync-drive.mjs       ← tải thư mục Google Drive (service account) → build-kho
tools/dev.mjs              ← dev server Node, không cần wrangler
tools/build-artifact.mjs   ← đóng gói bản demo một file
tests/                     ← node --test
.github/workflows/deploy.yml ← test + deploy tự động khi merge vào main
```

## Đã bỏ so với kstns-office

Sơ đồ chỗ ngồi thật và 71 NPC, nhiệm vụ, bi-a, D1, R2, /settings, /admin, WC (Tuya),
phòng họp (M365), chế độ Online (Durable Object), tủ đồ. Muốn lấy lại phần nào thì xem
repo cũ.

## Hướng mở rộng

- FAQ lớn dần (hàng trăm mục) thì chuyển sang tìm kiếm (RAG): lọc 5–10 mục liên quan nhất
  rồi mới đưa vào prompt, thay vì đưa cả kho.
- Cần biết *ai* hỏi (vd. hỏi số phép còn lại của chính mình) thì thêm đăng nhập M365 như
  repo cũ, rồi gọi API HR bằng quyền của người đó.
- Thêm rate limit theo IP cho `/api/chat` (Cloudflare Rate Limiting rules) khi mở cho đông người.

## Tải file lên trực tiếp (không cần Drive/SharePoint)

Trên /admin/ → Cấu hình → mỗi phòng có mục **Tài liệu tải lên**. Trình duyệt tự rút CHỮ khỏi file (ảnh bỏ qua)
rồi chỉ gửi chữ lên — lưu ở D1 (bảng `docs`, tự tạo). Giới hạn: file ≤ 30 MB, chữ ≤ 1 MB/file,
≤ 50 file và ≤ 2 MB chữ/phòng (≈ 500–600 trang A4). Tải lại cùng tên = thay bản cũ. Xoá phòng = xoá file của phòng đó.
Mỗi phòng chọn MỘT nguồn: file tải lên hoặc link thư mục.

**PDF:** đọc được PDF có chữ (xuất từ Word/Excel) — trình duyệt dùng pdf.js (`public/vendor/pdfjs/`, Apache-2.0).
PDF **scan** (ảnh) không có chữ → trang admin báo cách chuyển qua Google Tài liệu (OCR). PDF qua *link* chưa đọc được
(quá nặng cho gói Free) → mở bằng Google Tài liệu. .doc / .xls kiểu cũ: lưu thành .docx / .xlsx trước.
