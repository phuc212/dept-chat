import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../tools/build-kho.mjs';
import { retrieve } from '../functions/_retrieve.js';
import { offlineAnswer, offlineReply } from '../functions/api/chat.js';
import { systemPrompt } from '../public/shared/prompt.js';
import { deptById } from '../public/shared/depts.js';

// Kho giả — không phụ thuộc functions/_kho.js thật trên máy.
const KHO = {
  ketoan: [
    { source: 'quy-che/cong-tac-nuoc-ngoai.md', part: 1, text: 'Đi công tác nước ngoài được phụ cấp 80 USD/ngày cho Nhật Bản. Khách sạn tối đa 120 USD/đêm.' },
    { source: 'han-muc-chi-phi.xlsx', part: 1, text: 'Sheet Hạn mức:\nTiếp khách | 1.500.000đ/lần\nVăn phòng phẩm | 500.000đ/tháng' },
  ],
  nhansu: [{ source: 'lam-viec-tu-xa.docx', part: 1, text: 'Nhân viên được làm việc từ xa tối đa 2 ngày mỗi tuần.' }],
};
const kt = deptById('ketoan'), ns = deptById('nhansu');

test('chunkText: chia theo đoạn, không đoạn nào vượt kích thước', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Đoạn ${i}. ` + 'nội dung '.repeat(20)).join('\n\n');
  const chunks = chunkText(text, 500);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.length <= 500, c.length);
  assert.match(chunks[0], /^Đoạn 0/);
});

test('retrieve: tìm đúng đoạn, bỏ dấu vẫn tìm được', () => {
  assert.equal(retrieve(KHO.ketoan, 'phu cap cong tac Nhat')[0].source, 'quy-che/cong-tac-nuoc-ngoai.md');
  assert.equal(retrieve(KHO.ketoan, 'hạn mức tiếp khách')[0].source, 'han-muc-chi-phi.xlsx');
  assert.deepEqual(retrieve(KHO.ketoan, 'thời tiết hôm nay'), []);
  assert.deepEqual(retrieve(undefined, 'gì cũng được'), []);
});

test('không AI: tài liệu kho khớp rõ thắng FAQ khớp lờ mờ, kèm tên file', () => {
  // "tiếp khách" từng bị FAQ công tác phí ("khách sạn") cướp mất
  const a = offlineReply(kt, 'hạn mức tiếp khách', KHO);
  assert.match(a.text, /1\.500\.000/);
  assert.deepEqual(a.sources.map((s) => s.name), ['han-muc-chi-phi.xlsx']);
  assert.doesNotMatch(a.text, /\|/);                                 // hàng bảng → câu
  assert.equal(offlineReply(ns, 'làm việc từ xa mấy ngày', KHO).sources[0].name, 'lam-viec-tu-xa.docx');
});

test('không AI: FAQ vẫn thắng khi nó là câu khớp nhất', () => {
  assert.match(offlineAnswer(kt, 'ngày nào trả lương', KHO), /ngày 5/);
});

test('không AI: không có gì khớp → đầu mối liên hệ, không bịa', () => {
  assert.match(offlineAnswer(kt, 'Công ty có thưởng Tết không?', KHO), /chưa có thông tin/);
});

test('prompt cho AI: có đoạn kho + tên nguồn, và luật chỉ dùng tài liệu', () => {
  const p = systemPrompt(kt, retrieve(KHO.ketoan, 'phụ cấp công tác Nhật'));
  assert.match(p, /Nguồn: quy-che\/cong-tac-nuoc-ngoai\.md/);
  assert.match(p, /80 USD/);
  assert.match(p, /KHÔNG dùng kiến thức bên ngoài/);
  assert.match(systemPrompt(kt, []), /không tìm thấy đoạn tài liệu nào/);
});
