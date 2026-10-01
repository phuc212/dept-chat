/* Panel chat: mỗi bộ phận một lịch sử hội thoại riêng (chỉ trong RAM — tải lại trang là mất,
 * cố ý: không lưu câu hỏi của nhân viên ở đâu cả).
 * Nội dung bot render bằng textContent → không có đường XSS dù model trả về HTML.
 *
 * "Hỏi chung" (AUTO): hỏi không cần chọn phòng — server tự chọn phòng khớp nhất, câu trả lời
 * có nhãn "Phòng X" + nút chuyển sang chat riêng của phòng đó.
 */
const $ = (sel, root = document) => root.querySelector(sel);

export const AUTO = Object.freeze({
  id: 'auto', name: 'Hỏi chung', bot: 'Trợ lý chung', ja: '', color: '#3d6fb4',
  greeting: 'Xin chào! Bạn cứ hỏi — mình sẽ tìm đúng phòng ban để trả lời.', suggest: [],
});

/** Gửi 👍 (1) / 👎 (-1) / bỏ (0) cho câu trả lời có id `qid`. */
export async function sendFeedback(qid, rating) {
  const res = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: qid, rating }) });
  if (!res.ok) throw new Error('feedback ' + res.status);
}

/** Cách gửi mặc định: POST /api/chat, đọc stream text. Trả {text, mode, deptId, sources}.
 * `onText(t)` nhận TOÀN BỘ câu trả lời tới lúc đó. Lỗi thì ném Error có message cho người dùng. */
export async function askServer(dept, history, onText) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dept: dept.id, messages: history }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Lỗi ${res.status}`);
  }
  const mode = res.headers.get('x-chat-mode');
  const deptId = res.headers.get('x-dept');
  const qid = res.headers.get('x-qid');
  let sources = [];
  try { sources = JSON.parse(decodeURIComponent(res.headers.get('x-sources') || '')) || []; } catch { sources = []; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    onText(acc);
  }
  return { text: acc, mode, deptId, qid, sources: Array.isArray(sources) ? sources : [] };
}

/** @param opts.depts danh sách phòng (để "Hỏi chung" biết tên phòng + gợi ý chuyển phòng) */
export function createChat(root, ask = askServer, { depts = [], feedback = sendFeedback } = {}) {
  const panel = root;
  const head = $('.chat-head', panel);
  const title = $('.chat-title', panel);
  const sub = $('.chat-sub', panel);
  const list = $('.chat-list', panel);
  const form = $('.chat-form', panel);
  const input = $('textarea', form);
  const sendBtn = $('button[type=submit]', form);
  const privacy = document.createElement('div');
  privacy.className = 'privacy-note';
  privacy.textContent = 'Câu hỏi được lưu ẩn danh (không kèm tên) để cải thiện trợ lý.';
  privacy.hidden = true;
  form.after(privacy);
  const histories = new Map();   // id → [{role, content, meta?}]
  let dept = null;
  let busy = false;
  const byId = (id) => depts.find((d) => d.id === id);

  function bubble(role, text, extra = '') {
    const el = document.createElement('div');
    el.className = `msg ${role} ${extra}`.trim();
    el.textContent = text;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  }

  // Phần phụ dưới câu trả lời: nhãn phòng (hỏi chung), link file nguồn, ghi chú chế độ.
  function decorate(el, meta = {}) {
    const routed = meta.deptId && byId(meta.deptId);
    if (routed && dept?.id === 'auto') {
      const tag = document.createElement('div');
      tag.className = 'route-tag';
      tag.style.setProperty('--dept', routed.color);
      const name = document.createElement('span');
      name.textContent = `Phòng ${routed.name}`;
      const go = document.createElement('button');
      go.type = 'button';
      go.textContent = 'Hỏi tiếp phòng này →';
      go.onclick = () => api.open(routed);
      tag.append(name, go);
      el.prepend(tag);
    }
    const srcs = (meta.sources || []).filter((s) => s && s.name);
    if (srcs.length) {
      const box = document.createElement('div');
      box.className = 'sources';
      for (const s of srcs) {
        // chỉ hiện TÊN tài liệu (không link mở/tải file gốc)
        const a = document.createElement('span');
        a.className = 'source';
        a.textContent = '📄 ' + s.name.split('/').pop().replace(/\.(docx|xlsx|pdf|txt|md|csv)$/i, '');
        a.title = 'Nguồn: ' + s.name;
        box.appendChild(a);
      }
      el.appendChild(box);
    }
    if (meta.qid) {
      // 👍/👎 — lưu ẩn danh, giúp admin biết câu nào bot trả lời chưa tốt.
      const fb = document.createElement('div');
      fb.className = 'feedback';
      const mk = (val, icon, label) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = icon; b.title = label; b.setAttribute('aria-label', label);
        b.setAttribute('aria-pressed', String(meta.rating === val));
        b.onclick = async () => {
          const next = meta.rating === val ? 0 : val;
          const prev = meta.rating;
          meta.rating = next || null;
          for (const x of fb.querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
          if (next) b.setAttribute('aria-pressed', 'true');
          thanks.textContent = next === -1 ? 'Cảm ơn — admin sẽ xem lại câu này.' : next === 1 ? 'Cảm ơn!' : '';
          try { await feedback(meta.qid, next); } catch { meta.rating = prev; thanks.textContent = 'Chưa gửi được đánh giá.'; }
        };
        return b;
      };
      const thanks = document.createElement('span');
      thanks.className = 'fb-thanks';
      fb.append(mk(1, '👍', 'Câu trả lời hữu ích'), mk(-1, '👎', 'Câu trả lời chưa đúng / chưa đủ'), thanks);
      el.appendChild(fb);
      privacy.hidden = false;
    }
    if (meta.mode && meta.mode !== 'llm' && meta.mode !== 'route-none') {
      const note = document.createElement('div');
      note.className = 'mode-note';
      note.textContent = meta.mode === 'faq' ? 'Trích từ tài liệu / FAQ (AI chưa bật)' : 'AI tạm lỗi — trích từ tài liệu / FAQ';
      el.appendChild(note);
    }
  }

  function suggestionsFor(d) {
    if (d.id !== 'auto') return (d.suggest && d.suggest.length ? d.suggest : (d.faq || []).map((e) => e.q)).slice(0, 5);
    // Hỏi chung: lấy câu gợi ý đầu tiên của vài phòng
    return depts.map((x) => (x.suggest || [])[0]).filter(Boolean).slice(0, 4);
  }

  function render() {
    list.replaceChildren();
    const h = histories.get(dept.id) || [];
    const hello = dept.greeting || `Xin chào! Mình là ${dept.bot}. Bạn cần hỏi gì về ${dept.scope}?`;
    bubble('bot', hello, 'intro');
    for (const m of h) {
      const el = bubble(m.role === 'user' ? 'user' : 'bot', m.content);
      if (m.meta) decorate(el, m.meta);
    }
    if (!h.length) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const q of suggestionsFor(dept)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = q;
        b.onclick = () => send(q);
        chips.appendChild(b);
      }
      if (chips.children.length) list.appendChild(chips);
    }
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy || !dept) return;
    const d = dept;
    const h = histories.get(d.id) || [];
    histories.set(d.id, h);
    $('.chips', list)?.remove();
    h.push({ role: 'user', content: text });
    bubble('user', text);
    input.value = '';
    setBusy(true);
    const out = bubble('bot', '', 'typing');
    try {
      const wire = h.map(({ role, content }) => ({ role, content }));
      const r = await ask(d, wire, (t) => {
        if (dept === d) { out.textContent = t; list.scrollTop = list.scrollHeight; }
      });
      const acc = (r.text || '').trim() || '(không có nội dung)';
      const meta = { mode: r.mode, deptId: r.deptId, sources: r.sources, qid: r.qid || null, rating: null };
      out.textContent = acc;
      out.classList.remove('typing');
      h.push({ role: 'assistant', content: acc, meta });
      if (dept === d) decorate(out, meta);
    } catch (e) {
      h.pop();                                   // bỏ câu hỏi lỗi khỏi lịch sử để hỏi lại được
      out.remove();
      bubble('bot', `⚠ ${e.message || 'Không gửi được, thử lại nhé.'}`, 'error');
    } finally {
      setBusy(false);
      if (dept === d) input.focus();
    }
  }

  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    input.disabled = b;
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  $('.chat-close', panel).onclick = () => api.close();
  $('.chat-reset', panel).onclick = () => { if (dept && !busy) { histories.delete(dept.id); render(); } };

  const api = {
    open(d) {
      if (busy) return;
      dept = d;
      panel.style.setProperty('--dept', d.color);
      title.textContent = d.bot;
      sub.textContent = d.id === 'auto' ? 'Tự tìm đúng phòng ban để trả lời' : `Bộ phận ${d.name}${d.ja ? ' · ' + d.ja : ''}`;
      head.dataset.dept = d.id;
      panel.hidden = false;
      render();
      input.focus();
      document.dispatchEvent(new CustomEvent('chat:open', { detail: d.id }));
    },
    close() {
      panel.hidden = true;
      dept = null;
      input.blur();
      document.dispatchEvent(new CustomEvent('chat:close'));
    },
    get current() { return dept; },
  };
  return api;
}
