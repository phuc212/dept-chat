/* Vòng lặp game: vẽ bản đồ các phòng ban, đi lại có va chạm, tới gần trợ lý hoặc bấm vào phòng
 * là mở chat của bộ phận đó. Vanilla JS + Canvas 2D, không dependency.
 * Danh sách phòng lấy từ /api/depts (thêm/xoá ở /admin/); lỗi mạng thì dùng 3 phòng mặc định.
 */
import { DEPTS, SAMPLE_DATA } from '../shared/depts.js';
import { hydrate } from '../shared/dept-model.js';
import { W, H, buildMap, collides, roomAt } from './map.js';
import { createChat, AUTO } from './chat.js';

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
async function loadDepts() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch('/api/depts', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(res.status);
    const j = await res.json();
    if (Array.isArray(j.depts) && j.depts.length) return { list: j.depts, custom: j.custom };
  } catch { /* không có API (bản demo, mất mạng) → mặc định */ }
  return { list: hydrate(null), custom: false };
}
const { list: DEPT_LIST, custom: CUSTOM_DEPTS } = await loadDepts();
const map = buildMap(DEPT_LIST);
canvas.setAttribute('aria-label', 'Bản đồ văn phòng: ' + DEPT_LIST.map((d) => d.name).join(', '));
// Bản demo (artifact) gắn DEPT_CHAT_ASK để hỏi Claude từ trình duyệt; bản thật dùng /api/chat.
const chat = createChat(document.getElementById('chat'), globalThis.DEPT_CHAT_ASK, { depts: DEPT_LIST });
// "Hỏi chung": nút nổi góc phải + nút đầu tiên trên HUD. Bản demo (artifact) không có server để dò phòng → ẩn.
const AUTO_OK = !globalThis.DEPT_CHAT_ASK;
const fab = document.getElementById('fab');
fab.hidden = !AUTO_OK;
fab.onclick = () => chat.open(AUTO);
document.addEventListener('chat:open', () => { fab.hidden = true; });
document.addEventListener('chat:close', () => { fab.hidden = !AUTO_OK; });

const player = { x: map.spawn.x, y: map.spawn.y, r: 13, dir: 1, step: 0 };
const SPEED = 230;             // px logic / giây
const TALK_DIST = 70;
const keys = new Set();
let target = null;             // điểm click-to-move ở sảnh
let near = null;               // phòng có trợ lý đang ở gần

// ── HUD: nút tắt cho từng bộ phận (dùng được cả trên điện thoại) ──────────────
const hudDepts = document.getElementById('hud-depts');
if (AUTO_OK) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hud-auto';
  b.textContent = '💬 Hỏi chung';
  b.onclick = () => chat.open(AUTO);
  hudDepts.appendChild(b);
}
for (const d of DEPT_LIST) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = d.name;
  b.style.setProperty('--dept', d.color);
  b.onclick = () => chat.open(d);
  hudDepts.appendChild(b);
}
document.getElementById('sample-banner').hidden = !SAMPLE_DATA || CUSTOM_DEPTS;

// ── Scale canvas theo khung, giữ tỉ lệ, nét theo devicePixelRatio ──────────────
let scale = 1;
function resize() {
  const box = canvas.parentElement.getBoundingClientRect();
  scale = Math.min(box.width / W, box.height / H);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  canvas.width = Math.round(W * scale * dpr);
  canvas.height = Math.round(H * scale * dpr);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ── Input ─────────────────────────────────────────────────────────────────────
const typing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chat.current) { chat.close(); return; }
  if (typing()) return;
  const k = e.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) {
    keys.add(k); target = null; e.preventDefault();
  }
  if ((k === 'e' || k === ' ') && near) { e.preventDefault(); chat.open(near.dept); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / scale;
  const y = (e.clientY - rect.top) / scale;
  const rm = roomAt(map, x, y);
  if (rm) chat.open(rm.dept);           // bấm vào phòng = mở chat bộ phận đó
  else target = { x, y };               // bấm ở sảnh = đi tới đó
});
canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const rm = roomAt(map, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
  canvas.style.cursor = rm ? 'pointer' : 'default';
  hover = rm;
});
let hover = null;

// ── Cập nhật ──────────────────────────────────────────────────────────────────
function update(dt) {
  let dx = 0, dy = 0;
  if (!typing()) {
    if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
    if (keys.has('arrowright') || keys.has('d')) dx += 1;
    if (keys.has('arrowup') || keys.has('w')) dy -= 1;
    if (keys.has('arrowdown') || keys.has('s')) dy += 1;
  }
  if (!dx && !dy && target) {
    const tx = target.x - player.x, ty = target.y - player.y;
    const dist = Math.hypot(tx, ty);
    if (dist < 4) target = null; else { dx = tx / dist; dy = ty / dist; }
  }
  if (dx || dy) {
    const len = Math.hypot(dx, dy);
    const vx = (dx / len) * SPEED * dt, vy = (dy / len) * SPEED * dt;
    // Tách trục để trượt dọc tường thay vì dính cứng.
    const ox = player.x, oy = player.y;
    if (!collides(map, player.x + vx, player.y, player.r)) player.x += vx;
    if (!collides(map, player.x, player.y + vy, player.r)) player.y += vy;
    if (target && ox === player.x && oy === player.y) target = null;   // kẹt → bỏ đích
    if (dx) player.dir = dx > 0 ? 1 : -1;
    player.step += dt * 10;
  }
  near = map.rooms.find((rm) => Math.hypot(rm.npc.x - player.x, rm.npc.y - player.y) < TALK_DIST) || null;
}

// ── Vẽ ────────────────────────────────────────────────────────────────────────
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawPerson(x, y, color, t = 0, bot = false) {
  const bob = Math.sin(t) * 1.5;
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath(); ctx.ellipse(x, y + 14, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  roundRect(x - 11, y - 4 + bob, 22, 18, 7); ctx.fill();
  ctx.fillStyle = '#f5d3b3';
  ctx.beginPath(); ctx.arc(x, y - 12 + bob, 9, 0, Math.PI * 2); ctx.fill();
  if (bot) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 21 + bob); ctx.lineTo(x, y - 28 + bob); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y - 29 + bob, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#2b2b33';
  ctx.beginPath(); ctx.arc(x - 3, y - 12 + bob, 1.4, 0, Math.PI * 2); ctx.arc(x + 3, y - 12 + bob, 1.4, 0, Math.PI * 2); ctx.fill();
}

function label(text, x, y, { size = 13, color = '#fff', bg = 'rgba(30,32,44,.85)', weight = 600 } = {}) {
  ctx.font = `${weight} ${size}px "Be Vietnam Pro", system-ui, "Segoe UI", sans-serif`;
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = bg;
  roundRect(x - w / 2, y - size, w, size + 8, 6); ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - size / 2 + 4);
}

function draw(t) {
  ctx.fillStyle = '#ece6dc';
  ctx.fillRect(0, 0, W, H);
  // sảnh
  ctx.fillStyle = '#e4ddd0';
  ctx.fillRect(map.lobby.x, map.lobby.y, map.lobby.w, map.lobby.h);
  ctx.fillStyle = '#b9ae9c';
  ctx.font = '600 14px "Be Vietnam Pro", system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('SẢNH', W / 2, map.lobby.y + 40);
  for (const e of map.entrances) ctx.fillText(e.label, e.x, e.y);

  for (const rm of map.rooms) {
    const d = rm.dept;
    ctx.fillStyle = d.floor;
    ctx.fillRect(rm.x, rm.y, rm.w, rm.h);
    if (hover === rm || near === rm) {
      ctx.strokeStyle = d.color; ctx.lineWidth = 4; ctx.setLineDash([10, 6]);
      ctx.strokeRect(rm.x + 6, rm.y + 6, rm.w - 12, rm.h - 12); ctx.setLineDash([]);
    }
    for (const k of rm.desks) {
      ctx.fillStyle = '#b98c5e'; roundRect(k.x, k.y, k.w, k.h, 5); ctx.fill();
      ctx.fillStyle = '#9c7449'; ctx.fillRect(k.x, k.y + k.h - 6, k.w, 6);
      ctx.fillStyle = '#39404f'; roundRect(k.x + k.w / 2 - 14, k.y + 6, 28, 16, 3); ctx.fill();
    }
    // biển tên phòng — co chữ cho vừa biển khi phòng hẹp / tên dài
    const sg = rm.sign;
    ctx.fillStyle = d.color;
    roundRect(sg.x, sg.y, sg.w, sg.h, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const title = d.name.toUpperCase();
    let fs = 20;
    do { ctx.font = `700 ${fs}px "Be Vietnam Pro", system-ui, sans-serif`; } while (ctx.measureText(title).width > sg.w - 16 && --fs > 10);
    ctx.fillText(title, rm.cx, sg.y + (d.ja ? 16 : 22), sg.w - 12);
    if (d.ja) {
      ctx.font = '500 12px "Be Vietnam Pro", system-ui, sans-serif';
      ctx.fillText(d.ja, rm.cx, sg.y + 35);
    }

    drawPerson(rm.npc.x, rm.npc.y, d.color, t / 400 + rm.x, true);
    label(d.bot, rm.npc.x, rm.npc.y - 38, { size: 12, bg: d.color });
  }

  ctx.fillStyle = '#3a3f4f';
  for (const w of map.walls) ctx.fillRect(w.x, w.y, w.w, w.h);

  if (target) {
    ctx.strokeStyle = 'rgba(58,63,79,.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(target.x, target.y, 8, 0, Math.PI * 2); ctx.stroke();
  }
  drawPerson(player.x, player.y, '#3d7a5a', player.step);
  label('Bạn', player.x, player.y - 30, { size: 11 });

  if (near && !chat.current) {
    label(`Nhấn E hoặc bấm vào phòng để hỏi ${near.dept.bot}`, W / 2, H - 80, { size: 15 });
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// để test/automation soi được trạng thái
window.__deptChat = { map, player, chat };
