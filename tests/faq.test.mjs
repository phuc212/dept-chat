import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPTS, deptById } from '../public/shared/depts.js';
import { normalize, bestMatch, faqAnswer } from '../public/shared/faq-match.js';

const kt = deptById('ketoan'), ns = deptById('nhansu'), pt = deptById('phattrien');

test('normalize bỏ dấu và chữ đ', () => {
  assert.equal(normalize('Hoàn ỨNG đi!'), 'hoan ung di');
});

test('mỗi bộ phận có id duy nhất và FAQ không rỗng', () => {
  assert.equal(new Set(DEPTS.map((d) => d.id)).size, DEPTS.length);
  for (const d of DEPTS) {
    assert.ok(d.faq.length >= 3, d.id);
    for (const e of d.faq) assert.ok(e.q && e.a, `${d.id}: ${e.q}`);
  }
});

test('khớp đúng câu dù gõ không dấu', () => {
  assert.match(bestMatch(kt, 'xin tam ung the nao').entry.q, /tạm ứng/);
  assert.match(bestMatch(ns, 'được nghỉ phép mấy ngày').entry.q, /nghỉ phép/);
  assert.match(bestMatch(pt, 'quy trình tạo pull request').entry.q, /pull request/);
});

test('câu lạc đề → không khớp, trả lời hướng dẫn liên hệ', () => {
  assert.equal(bestMatch(kt, 'thời tiết hôm nay'), null);
  assert.match(faqAnswer(kt, DEPTS, 'thời tiết hôm nay'), /ketoan@/);
});

test('hỏi sai phòng → gợi ý sang phòng đúng', () => {
  assert.match(faqAnswer(pt, DEPTS, 'xin nghỉ phép năm'), /Nhân sự/);
});

// Các ca từng khớp nhầm — giữ lại để không tái phát.
test('không khớp nhầm vì từ chung chung', () => {
  // "công ty" có ở khắp nơi → không được kéo sang mục hoá đơn VAT
  assert.equal(bestMatch(kt, 'Công ty có thưởng Tết không?', DEPTS), null);
  // "bao giờ" không được khớp sang "Giờ làm việc" của Nhân sự
  assert.match(faqAnswer(kt, DEPTS, 'Lương tháng này bao giờ có?'), /ngày 5/);
});
test('hoàn ứng có hoá đơn → đúng mục hoàn ứng, không phải tạm ứng', () => {
  assert.match(bestMatch(kt, 'Hoàn ứng tiền taxi có cần hoá đơn không', DEPTS).entry.q, /Hoàn ứng/);
});
test('ưu tiên phòng đang đứng khi khớp mơ hồ', () => {
  assert.match(faqAnswer(kt, DEPTS, 'Lương của anh Nam bao nhiêu?'), /ngày 5|chưa có thông tin/);
});
