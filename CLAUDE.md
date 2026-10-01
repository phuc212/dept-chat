# dept-chat — ghi chú cho Claude (và người mới)

Bản đồ văn phòng 2D; mỗi phòng ban = 1 chatbot chỉ trả lời từ tài liệu của phòng đó.
Chạy trên **Cloudflare Pages** (+ Pages Functions): https://dept-chat.pages.dev — admin ở `/admin/`.
Người dùng chính: admin không chuyên kỹ thuật → mọi cấu hình phải làm được **từ trang /admin/**,
giải thích ngắn gọn, bằng tiếng Việt. Chữ trên giao diện: tiếng Việt.

## Công nghệ
- JavaScript thuần (ES modules), **không framework, không bước build**. HTML/CSS tự viết; bản đồ vẽ bằng Canvas.
- Server: Cloudflare Pages Functions (`functions/`). Bindings: KV `CONFIG`, D1 `DB`, (tuỳ chọn) Workers AI `AI`.
- Test: `node --test` (Node ≥ 20). D1 giả: `tools/fake-d1.mjs` (node:sqlite).

## Thư mục
- `public/` — trang tĩnh. `src/` bản đồ + chat · `admin/` trang quản trị (+ `pdf-text.js` rút chữ PDF bằng pdf.js ở `vendor/pdfjs/`)
  · `shared/` code dùng chung trình duyệt + server (`office.js` đọc docx/xlsx, `prompt.js` system prompt, `depts.js`, `dept-model.js`, `faq-match.js`).
- `functions/_*.js` — thư viện server (không thành route): `_config` (cấu hình + khoá trong KV), `_uploads` (file tải lên → D1),
  `_kho-live` / `_drive` / `_sharepoint` (đọc thư mục Drive/SharePoint), `_retrieve` (BM25), `_stats` (thống kê D1), `_middleware` (mật khẩu vào trang).
- `functions/api/chat.js` — trả lời: tìm đoạn khớp (BM25) → gọi AI (thứ tự **Claude → Gemini → Workers AI**, hãng lỗi thì sang hãng sau)
  → hết cả thì trích câu khớp nhất (`offlineReply`/`bestSnippet`).
- `functions/api/admin/*` — API admin (header `x-admin-key` = ADMIN_PASSWORD).
- `kho/` — tài liệu MẪU (giả) build sẵn vào `functions/_kho.js` bằng `node tools/build-kho.mjs` (file build bị .gitignore).
- `tai-lieu-mau/` — tài liệu kế toán MẪU để thử tải lên ở admin.
- `tools/dev.mjs` — chạy thử local: `npm run dev` → http://localhost:8788.

## Lệnh
```
npm ci          # lần đầu
npm test        # phải pass hết trước khi push
npm run dev     # chạy thử local (mật khẩu trang: SITE_PASSWORD trong .dev.vars, mặc định "dev")
```
Deploy: **push lên `main`** → GitHub Actions (`.github/workflows/deploy.yml`) chạy test rồi deploy. Không cần chạy wrangler tay.
(Deploy tay khi cần: `npx wrangler pages deploy public --project-name dept-chat --branch main`.)

## Khoá & bí mật — QUY TẮC
- **Không bao giờ commit khoá** (key.json, API key, mật khẩu). `.dev.vars` đã bị ignore.
- Khoá AI / Drive / SharePoint: admin dán ở `/admin/` → lưu KV `app-secrets`, **chỉ ghi, không bao giờ trả về trình duyệt**.
- Secret trên Cloudflare: `SITE_PASSWORD` (giá trị `off` = mở công khai), `ADMIN_PASSWORD` (≥ 8 ký tự).
- Không yêu cầu người dùng gửi khoá vào chat; nếu khoá bị lộ → khuyên xoá và tạo khoá mới.
- Mọi chữ từ server / tài liệu gắn vào DOM bằng `textContent` (không innerHTML).

## Những điều đã biết (đừng "sửa" lại)
- Gemini/Claude **chặn máy chủ Cloudflare ở Hồng Kông** ("User location is not supported" / 403 "Request not allowed");
  ở Singapore thì chạy. Vì thế có chuỗi dự phòng + Workers AI. Nút "Thử AI" ở admin hiện máy chủ (colo) và lỗi gần nhất (KV `ai-last-error`).
- Gemini có lúc trả 200 nhưng rỗng (hết token vì "suy nghĩ") → `nonEmpty()` coi là lỗi, thử lại / Flash-Lite.
- Mỗi phòng chọn **một** nguồn: tải file lên (D1) **hoặc** link thư mục. PDF scan (ảnh) không đọc được → báo người dùng.
- Tên file nguồn dưới câu trả lời: mặc định ẩn (`showSources` trong cấu hình), không bao giờ là link tải.
- Bản đồ tối đa 8 phòng (2 hàng × 4) — giới hạn bố cục, không phải dữ liệu.
- Thống kê câu hỏi: ẩn danh, giữ 180 ngày, tắt được ở admin.

## Cách làm việc
- Sửa gì cũng thêm/cập nhật test trong `tests/`, chạy `npm test`.
- Giữ code đơn giản, không thêm thư viện nếu không thật cần.
- Đổi giao diện: kiểm tra cả chế độ sáng/tối và màn hình điện thoại.
