// 各ツールの入力処理
// tool.mode: 'draw' … 1本指ドラッグをツールが受け取る
//            'tap'  … 1本指ドラッグはパン、タップだけツールが受け取る

import { uid, pointInPolygon, strokeHitsPath, unitScale } from './model.js';
import { drawArrow, tracePath, PIN_COLOR, ROOM_COLOR } from './viewer.js';

const MIN_POINT_DIST = 1.5;   // ペン：この画面px未満の移動は間引く
const ERASER_RADIUS = 12;     // 消しゴム半径(画面px)
const ARROW_MIN_DRAG = 16;    // カメラ：これ以上ドラッグしたら方向ありとする
const CLOSE_DIST = 16;        // 部屋：始点からこの画面px以内のタップで閉じる

function openHit(app, ev, types) {
  const hit = ev.viewer.hitTest(ev.sx, ev.sy, types);
  if (!hit) return false;
  if (hit.type === 'photo') app.openPhoto(hit);
  else if (hit.type === 'memo') app.openMemo(hit);
  return true;
}

function roomAt(viewer, x, y) {
  const rooms = viewer.pageRooms();
  for (let i = rooms.length - 1; i >= 0; i--) {
    if (pointInPolygon(x, y, rooms[i].polygon)) return rooms[i];
  }
  return null;
}

export class ViewTool {
  constructor(app) { this.app = app; this.mode = 'tap'; }
  tap(ev) { openHit(this.app, ev, ['photo', 'memo']); }
}

export class CameraTool {
  constructor(app) {
    this.app = app;
    this.penOnly = false; // Apple Pencil 使用中でも指で操作できる
    this.drag = null;
  }
  get mode() { return this.app.settings.cameraMode === 'room' ? 'tap' : 'draw'; }

  // 部屋指定モード
  tap(ev) {
    if (openHit(this.app, ev, ['photo'])) return;
    const room = roomAt(ev.viewer, ev.x, ev.y);
    if (!room) {
      this.app.toast(ev.viewer.pageRooms().length
        ? '部屋の範囲内をタップしてください'
        : '部屋が登録されていません。先に「部屋」ツールで範囲を登録してください');
      return;
    }
    this.app.capturePhoto({ x: ev.x, y: ev.y, angle: null, room, mode: 'room' });
  }

  // 位置指定モード
  down(ev) {
    this.drag = { start: ev, cur: ev, hit: ev.viewer.hitTest(ev.sx, ev.sy, ['photo']) };
  }
  move(ev) {
    if (!this.drag) return;
    this.drag.cur = ev;
    ev.viewer.requestRedraw();
  }
  up(ev) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const dx = ev.sx - d.start.sx, dy = ev.sy - d.start.sy;
    const dragged = Math.hypot(dx, dy) >= ARROW_MIN_DRAG;
    ev.viewer.requestRedraw();
    if (!dragged && d.hit) { this.app.openPhoto(d.hit); return; }
    const angle = dragged ? Math.atan2(dy, dx) : null;
    const room = roomAt(ev.viewer, d.start.x, d.start.y);
    this.app.capturePhoto({ x: d.start.x, y: d.start.y, angle, room, mode: 'position' });
  }
  cancel() { this.drag = null; }
  drawOverlay(ctx) {
    const d = this.drag;
    if (!d) return;
    const dx = d.cur.sx - d.start.sx, dy = d.cur.sy - d.start.sy;
    if (Math.hypot(dx, dy) >= ARROW_MIN_DRAG) drawArrow(ctx, d.start.sx, d.start.sy, Math.atan2(dy, dx), PIN_COLOR);
    ctx.beginPath();
    ctx.arc(d.start.sx, d.start.sy, 9, 0, Math.PI * 2);
    ctx.fillStyle = PIN_COLOR;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
}

export class RoomTool {
  constructor(app) { this.app = app; this.mode = 'tap'; this.draft = []; }

  tap(ev) {
    const v = ev.viewer;
    if (!this.draft.length) {
      const room = roomAt(v, ev.x, ev.y);
      if (room) { this.app.openRoom(room); return; }
    }
    if (this.draft.length >= 3) {
      const [fx, fy] = v.toScreen(...this.draft[0]);
      if (Math.hypot(ev.sx - fx, ev.sy - fy) < CLOSE_DIST) { this.finish(); return; }
    }
    this.draft.push([ev.x, ev.y]);
    this._changed();
  }

  undoPoint() { this.draft.pop(); this._changed(); }
  clear() { this.draft = []; this._changed(); }

  finish() {
    if (this.draft.length < 3) { this.app.toast('3点以上タップしてください'); return; }
    const polygon = this.draft;
    this.draft = [];
    this._changed();
    this.app.createRoom(polygon);
  }

  _changed() {
    this.app.viewer.requestRedraw();
    this.app.onRoomDraftChange(this.draft.length);
  }

  deactivate() { this.clear(); }

  drawOverlay(ctx, v) {
    if (!this.draft.length) return;
    v.drawRoom(ctx, { polygon: this.draft }, { draft: true });
    if (this.draft.length >= 3) {
      const [fx, fy] = v.toScreen(...this.draft[0]);
      ctx.beginPath();
      ctx.arc(fx, fy, CLOSE_DIST, 0, Math.PI * 2);
      ctx.strokeStyle = ROOM_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

export class MemoTool {
  constructor(app) { this.app = app; this.mode = 'tap'; }
  tap(ev) {
    if (openHit(this.app, ev, ['memo'])) return;
    this.app.createMemo(ev.x, ev.y);
  }
}

export class PenTool {
  constructor(app) { this.app = app; this.mode = 'draw'; this.cur = null; }

  down(ev) {
    const v = ev.viewer;
    const page = v.page;
    this.cur = {
      points: [[ev.x, ev.y]],
      last: [ev.sx, ev.sy],
      color: this.app.settings.color,
      width: this.app.settings.penWidth * unitScale(page),
    };
    v.requestRedraw();
  }

  move(ev) {
    const c = this.cur;
    if (!c) return;
    if (Math.hypot(ev.sx - c.last[0], ev.sy - c.last[1]) < MIN_POINT_DIST) return;
    c.points.push([ev.x, ev.y]);
    c.last = [ev.sx, ev.sy];
    ev.viewer.requestRedraw();
  }

  up(ev) {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    const v = ev.viewer;
    const last = c.points[c.points.length - 1];
    if (last[0] !== ev.x || last[1] !== ev.y) c.points.push([ev.x, ev.y]);
    const r = (n) => Math.round(n * 100) / 100;
    const stroke = {
      id: uid(),
      type: 'stroke',
      drawingId: v.drawingId,
      page: v.pageIndex,
      points: c.points.map(([x, y]) => [r(x), r(y)]),
      color: c.color,
      width: r(c.width),
    };
    this.app.store.mutate((p) => { p.objects.push(stroke); });
  }

  cancel() { this.cur = null; this.app.viewer.requestRedraw(); }

  drawOverlay(ctx, v) {
    const c = this.cur;
    if (!c) return;
    ctx.save();
    ctx.strokeStyle = c.color;
    ctx.fillStyle = c.color;
    ctx.lineWidth = Math.max(0.75, c.width * v.view.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    tracePath(ctx, c.points, v.view.scale, v.view.ox, v.view.oy);
    ctx.restore();
  }
}

export class EraserTool {
  constructor(app) { this.app = app; this.mode = 'draw'; this.path = null; this.pos = null; }

  down(ev) {
    this.path = [[ev.x, ev.y]];
    this.pos = [ev.sx, ev.sy];
    this._test(ev.viewer);
  }

  move(ev) {
    if (!this.path) return;
    this.path.push([ev.x, ev.y]);
    this.pos = [ev.sx, ev.sy];
    this._test(ev.viewer);
    // 判定は直近の区間だけでよい
    if (this.path.length > 2) this.path = this.path.slice(-2);
  }

  _test(v) {
    const r = ERASER_RADIUS / v.view.scale;
    for (const o of v.pageObjects()) {
      if (o.type === 'stroke' && strokeHitsPath(o, this.path, r)) v.hiddenIds.add(o.id);
    }
    v.requestRedraw();
  }

  up() {
    const v = this.app.viewer;
    const ids = new Set(v.hiddenIds);
    v.hiddenIds.clear();
    this.path = null;
    this.pos = null;
    if (ids.size) this.app.store.mutate((p) => { p.objects = p.objects.filter((o) => !ids.has(o.id)); });
    v.requestRedraw();
  }

  cancel() {
    this.app.viewer.hiddenIds.clear();
    this.path = null;
    this.pos = null;
    this.app.viewer.requestRedraw();
  }

  drawOverlay(ctx) {
    if (!this.pos) return;
    ctx.beginPath();
    ctx.arc(this.pos[0], this.pos[1], ERASER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
