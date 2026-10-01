/* Bố cục bản đồ — sinh từ danh sách phòng ban (thêm/xoá ở /admin/), không vẽ tay.
 * Toạ độ LOGIC (W×H), canvas tự scale theo màn hình.
 *
 *  ≤ 4 phòng: một hàng trên, sảnh dưới      5–8 phòng: hai hàng, sảnh ở giữa
 *   ┌────┬────┬────┐                           ┌───┬───┬───┬───┐
 *   │ A  │ B  │ C  │                           │ A │ B │ C │ D │   ← cửa quay xuống sảnh
 *   └─┐┌─┴─┐┌─┴─┐┌─┘                           ├┐┌─┴┐┌─┴┐┌─┴┐┌─┤
 *   │     SẢNH     │                         ═  SẢNH (lối vào hai bên) ═
 *   └─────┐┌───────┘                           ├┘└─┬┘└─┬┘└─┬┘└─┤
 *                                              │ E │ F │ G │ H │   ← cửa quay lên sảnh
 */
export const W = 1000;
export const H = 640;
export const T = 14;           // độ dày tường
const DOOR = 96;

/** Xếp một hàng phòng từ trên xuống (`doorAt: 'bottom'`) hoặc từ dưới lên (`'top'`). */
function row(list, y0, h, doorAt, walls, obstacles, rooms) {
  const n = list.length;
  const inner = W - 2 * T;
  const span = (inner - (n - 1) * T) / n;
  const door = Math.min(DOOR, span - 30);
  const wallY = doorAt === 'bottom' ? y0 + h : y0 - T;       // tường có cửa, giáp sảnh
  list.forEach((dept, i) => {
    const x = T + i * (span + T);
    const cx = x + span / 2;
    if (i > 0) walls.push({ x: x - T, y: doorAt === 'bottom' ? 0 : y0 - T, w: T, h: h + T + (doorAt === 'bottom' ? T : T) });
    walls.push({ x, y: wallY, w: span / 2 - door / 2, h: T });
    walls.push({ x: cx + door / 2, y: wallY, w: span / 2 - door / 2, h: T });

    // Nội thất: bàn trợ lý sát tường xa sảnh, trợ lý đứng trước bàn, 2 bàn phụ, biển tên gần cửa.
    const far = doorAt === 'bottom' ? y0 : y0 + h;            // mép tường xa cửa
    const dir = doorAt === 'bottom' ? 1 : -1;                  // hướng từ tường xa về phía cửa
    const deskW = Math.min(150, span - 40);
    const desk = { x: cx - deskW / 2, y: far + dir * 50 - (dir < 0 ? 40 : 0), w: deskW, h: 40, kind: 'desk' };
    const npc = { x: cx, y: far + dir * (h > 280 ? 132 : 112), r: 16 };
    const sideW = Math.min(70, (span - 60) / 2);
    const sideY = far + dir * (h > 280 ? 206 : 150) - (dir < 0 ? 44 : 0);
    const desks = [desk];
    if (sideW >= 40 && h > 200) {
      desks.push({ x: x + 18, y: sideY, w: sideW, h: 44, kind: 'desk' }, { x: x + span - 18 - sideW, y: sideY, w: sideW, h: 44, kind: 'desk' });
    }
    obstacles.push(...desks, { x: npc.x - npc.r, y: npc.y - npc.r, w: npc.r * 2, h: npc.r * 2, kind: 'npc' });
    const signW = Math.min(180, span - 24);
    const signY = doorAt === 'bottom' ? y0 + h - 58 : y0 + 4;
    rooms.push({ dept, x, y: y0, w: span, h, cx, npc, desks, sign: { x: cx - signW / 2, y: signY, w: signW, h: 44 } });
  });
}

export function buildMap(depts) {
  const walls = [{ x: 0, y: 0, w: W, h: T }, { x: 0, y: H - T, w: W, h: T }];
  const obstacles = [];
  const rooms = [];
  let lobby, spawn, entrances;

  if (depts.length <= 4) {
    const roomH = 352;
    row(depts, T, roomH, 'bottom', walls, obstacles, rooms);
    lobby = { x: T, y: T + roomH + T, w: W - 2 * T, h: H - roomH - 3 * T };
    // Lối vào ở giữa tường dưới
    walls.pop();
    walls.push({ x: 0, y: H - T, w: W / 2 - 60, h: T }, { x: W / 2 + 60, y: H - T, w: W / 2 - 60, h: T });
    walls.push({ x: 0, y: 0, w: T, h: H }, { x: W - T, y: 0, w: T, h: H });
    spawn = { x: W / 2, y: H - 70 };
    entrances = [{ x: W / 2, y: H - 24, label: 'LỐI VÀO' }];
  } else {
    const top = depts.slice(0, Math.ceil(depts.length / 2));
    const bottom = depts.slice(top.length);
    const lobbyH = 150;
    const roomH = (H - 4 * T - lobbyH) / 2;
    row(top, T, roomH, 'bottom', walls, obstacles, rooms);
    row(bottom, H - T - roomH, roomH, 'top', walls, obstacles, rooms);
    lobby = { x: T, y: T + roomH + T, w: W - 2 * T, h: lobbyH };
    // Lối vào ở hai tường bên, ngang sảnh
    const ly = lobby.y, lh = lobby.h;
    walls.push({ x: 0, y: 0, w: T, h: ly + 30 }, { x: 0, y: ly + lh - 30, w: T, h: H - ly - lh + 30 });
    walls.push({ x: W - T, y: 0, w: T, h: ly + 30 }, { x: W - T, y: ly + lh - 30, w: T, h: H - ly - lh + 30 });
    spawn = { x: W / 2, y: ly + lh / 2 + 20 };
    entrances = [];
  }
  return { walls, obstacles, rooms, spawn, lobby, entrances };
}

/** Hình vuông quanh tâm (x,y) bán kính r có đè lên hình chữ nhật nào không. */
export function collides(map, x, y, r) {
  for (const b of map.walls.concat(map.obstacles)) {
    if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return true;
  }
  return false;
}

/** Phòng chứa điểm (x,y), hoặc null. */
export function roomAt(map, x, y) {
  return map.rooms.find((rm) => x >= rm.x && x <= rm.x + rm.w && y >= rm.y && y <= rm.y + rm.h) || null;
}
