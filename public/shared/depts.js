/* Dữ liệu 3 bộ phận — NGUỒN SỰ THẬT DUY NHẤT, dùng chung cho:
 *   · client (public/src/*): màu, tên phòng, câu hỏi gợi ý
 *   · server (functions/api/chat.js): system prompt + kho FAQ đưa cho LLM
 *
 * ⚠️ Nội dung FAQ dưới đây là DỮ LIỆU MẪU. Thay bằng quy định thật của công ty trước khi
 * cho nhân viên dùng, rồi đổi SAMPLE_DATA = false (banner "dữ liệu mẫu" trên UI sẽ tắt).
 * File này được serve tĩnh — ai qua được mật khẩu site đều đọc được. Đừng đặt thông tin
 * mật (lương từng người, số tài khoản…) vào đây.
 *
 * Thêm/sửa một câu: thêm một phần tử {q, a, k?} vào `faq`. `k` là từ khoá phụ (không dấu
 * cũng được) giúp chế độ không-AI khớp câu hỏi tốt hơn.
 */

export const COMPANY = 'Công ty';
export const SAMPLE_DATA = true;

export const DEPTS = [
  {
    id: 'ketoan',
    name: 'Kế toán',
    ja: '経理部',
    color: '#e8a33d',
    floor: '#fbe7c6',
    bot: 'Trợ lý Kế toán',
    contact: 'ketoan@congty.example · máy lẻ 101',
    scope: 'tạm ứng, hoàn ứng, thanh toán chi phí, hoá đơn, công tác phí, lương và phiếu lương, thuế TNCN',
    faq: [
      { q: 'Làm sao để xin tạm ứng?',
        a: 'Điền phiếu đề nghị tạm ứng (mẫu KT-01), xin quản lý trực tiếp duyệt, rồi gửi Kế toán trước 15h. Tiền chuyển khoản trong 2 ngày làm việc. Hoàn ứng trong vòng 7 ngày sau khi xong việc.',
        k: 'tam ung xin ung' },
      { q: 'Hoàn ứng / thanh toán chi phí cần giấy tờ gì?',
        a: 'Cần hoá đơn VAT (hoặc hoá đơn bán lẻ nếu dưới 200.000đ), phiếu đề nghị thanh toán (KT-02) có chữ ký quản lý. Nộp chậm nhất ngày 25 hằng tháng để vào kỳ thanh toán tháng đó.',
        k: 'hoan ung thanh toan chi phi chung tu hoa don taxi' },
      { q: 'Thông tin xuất hoá đơn VAT của công ty?',
        a: 'Lấy tên công ty, mã số thuế và địa chỉ đúng như trên giấy đăng ký kinh doanh — Kế toán gửi file thông tin xuất hoá đơn khi bạn hỏi. Email nhận hoá đơn điện tử: hoadon@congty.example.',
        k: 'hoa don vat xuat mst ma so thue' },
      { q: 'Ngày nào trả lương?',
        a: 'Lương trả vào ngày 5 hằng tháng qua chuyển khoản; trùng ngày nghỉ thì trả vào ngày làm việc liền trước.',
        k: 'luong tra luong ngay nhan luong' },
      { q: 'Xem phiếu lương ở đâu?',
        a: 'Phiếu lương gửi qua email cá nhân công ty vào ngày trả lương, file PDF có mật khẩu. Có sai lệch thì báo Kế toán trong 5 ngày.',
        k: 'phieu luong bang luong payslip' },
      { q: 'Công tác phí được tính thế nào?',
        a: 'Phụ cấp công tác trong nước 200.000đ/ngày, khách sạn tối đa 800.000đ/đêm, đi lại thanh toán theo vé thực tế. Cần tờ trình công tác được duyệt trước khi đi.',
        k: 'cong tac phi di cong tac khach san' },
      { q: 'Quyết toán thuế TNCN thế nào?',
        a: 'Nếu chỉ có thu nhập từ công ty, bạn có thể uỷ quyền cho công ty quyết toán: ký giấy uỷ quyền (mẫu 08/UQ-QTT-TNCN) gửi Kế toán trước 15/2 hằng năm.',
        k: 'thue tncn quyet toan thue thu nhap ca nhan' },
    ],
  },
  {
    id: 'nhansu',
    name: 'Nhân sự',
    ja: '人事部',
    color: '#d9607a',
    floor: '#f9d9e0',
    bot: 'Trợ lý Nhân sự',
    contact: 'hr@congty.example · máy lẻ 102',
    scope: 'nghỉ phép, giờ làm việc, chấm công, bảo hiểm, hợp đồng lao động, thử việc, onboarding, phúc lợi, quy định nội bộ',
    faq: [
      { q: 'Mỗi năm được nghỉ phép bao nhiêu ngày?',
        a: '12 ngày phép năm cho điều kiện làm việc bình thường, cứ đủ 5 năm làm việc được cộng thêm 1 ngày. Phép chưa dùng được chuyển sang tối đa hết quý 1 năm sau.',
        k: 'nghi phep phep nam ngay phep' },
      { q: 'Xin nghỉ phép như thế nào?',
        a: 'Tạo đơn trên hệ thống chấm công, báo trước ít nhất 3 ngày làm việc (nghỉ từ 3 ngày trở lên: báo trước 1 tuần). Quản lý trực tiếp duyệt; nghỉ đột xuất thì nhắn quản lý trước 9h và bổ sung đơn sau.',
        k: 'xin nghi don nghi nghi om dot xuat' },
      { q: 'Giờ làm việc và chấm công?',
        a: 'Thứ 2–thứ 6, 8:00–17:15, nghỉ trưa 12:00–13:00. Chấm công bằng máy ở lễ tân khi vào và khi về; quên chấm thì gửi đơn giải trình trong 2 ngày.',
        k: 'gio lam cham cong di muon ve som' },
      { q: 'Thời gian thử việc bao lâu?',
        a: 'Tối đa 60 ngày với vị trí chuyên môn, 30 ngày với các vị trí khác; lương thử việc 85% lương chính thức. Cuối kỳ có buổi đánh giá với quản lý.',
        k: 'thu viec hop dong' },
      { q: 'Bảo hiểm xã hội đóng khi nào?',
        a: 'Công ty đăng ký BHXH, BHYT, BHTN từ tháng bạn ký hợp đồng lao động chính thức. Sổ BHXH điện tử tra trên ứng dụng VssID.',
        k: 'bhxh bhyt bao hiem so bao hiem vssid' },
      { q: 'Ngày đầu đi làm cần chuẩn bị gì?',
        a: 'Mang CCCD bản gốc, sổ hộ khẩu/xác nhận cư trú, bằng cấp (bản sao), số tài khoản ngân hàng. Nhân sự sẽ hướng dẫn nhận laptop, thẻ ra vào và tài khoản email.',
        k: 'onboarding nhan viec ngay dau ho so nhan vien moi' },
    ],
  },
  {
    id: 'phattrien',
    name: 'Phát triển',
    ja: '開発部',
    color: '#4a8fd9',
    floor: '#d6e6f8',
    bot: 'Trợ lý Phát triển',
    contact: 'dev-lead@congty.example · kênh Teams #dev',
    scope: 'quy trình phát triển phần mềm, git và pull request, code review, môi trường dev, cấp quyền repo/công cụ, deploy, báo bug, quy ước code',
    faq: [
      { q: 'Quy trình git và pull request?',
        a: 'Không commit thẳng lên main. Tạo nhánh feat/… fix/… từ main, commit nhỏ, push rồi mở PR. PR cần ít nhất 1 người duyệt và CI xanh mới được merge (squash merge).',
        k: 'git branch nhanh pr pull request merge commit' },
      { q: 'Code review cần lưu ý gì?',
        a: 'Thân PR ghi rõ vì sao · kết quả · lưu ý; có thay đổi giao diện thì kèm ảnh trước/sau. Reviewer phản hồi trong 1 ngày làm việc. PR nên dưới 400 dòng thay đổi.',
        k: 'review code review reviewer' },
      { q: 'Xin quyền truy cập repo và công cụ?',
        a: 'Gửi yêu cầu cho Dev lead qua Teams kèm tên repo/công cụ và lý do. Quyền production chỉ cấp sau khi quản lý duyệt.',
        k: 'quyen truy cap repo account tai khoan github azure devops' },
      { q: 'Dựng môi trường dev ở máy mới?',
        a: 'Clone repo, đọc README và CLAUDE.md của repo đó, cài đúng phiên bản Node/Python ghi trong README, copy .env.example thành .env. Không bao giờ commit file .env.',
        k: 'moi truong dev setup cai dat may moi env' },
      { q: 'Deploy lên production thế nào?',
        a: 'Merge PR vào main là CI tự deploy. Deploy tay chỉ khi CI hỏng và phải báo trước trên kênh #dev. Không deploy chiều thứ 6.',
        k: 'deploy release production trien khai' },
      { q: 'Báo bug ở đâu?',
        a: 'Tạo work item loại Bug trên Azure DevOps: bước tái hiện, kết quả mong đợi/thực tế, ảnh chụp, môi trường. Bug nghiêm trọng trên production thì báo thêm trên #dev.',
        k: 'bug loi bao loi issue work item' },
    ],
  },
];

export const deptById = (id) => DEPTS.find((d) => d.id === id) || null;
