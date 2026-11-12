// 各ツールの入力処理
// tool.mode: 'draw' … 1本指ドラッグをツールが受け取る
//            'tap'  … 1本指ドラッグはパン、タップだけツールが受け取る
// app（ツールの操作窓口）は editor.js / photo.js が用意する。
//   app.target: 書き込み先（targets.js）

import { uid, pointInPolygon, strokeHitsPath, objectPoints, translateObject, dimShape } from './model.js';
import { drawArrow, tracePath, PIN_COLOR, ROOM_COLOR, SELECT_COLOR } from './viewer.js';
import { HL_ALPHA } from './model.js';

const MIN_POINT_DIST = 1.5;   // ペン：この画面px未満の移動は間引く
const ERASER_RADIUS = 12;     // 消しゴム半径(画面px)
const ARROW_MIN_DRAG = 16;    // カメラ：これ以上ドラッグしたら方向ありとする
const CLOSE_DIST = 16;        // 部屋：始点からこの画面px以内のタップで閉じる
const DIM_MIN_DRAG = 10;      // 寸法：これ未満のドラッグはタップ扱い
const SNAP_DEG = 4;           // 寸法(線)：水平・垂直に吸着する角度

const r2 = (n) => Math.round(n * 100) / 100;

function openHit(app, ev, types) {
  const hit = ev.viewer.hitTest(ev.sx, ev.sy, types);
  if (!hit) return false;
  if (hit.type === 'photo') app.openPhoto(hit);
  else if (hit.type === 'memo') app.openMemo(hit);
  else if (hit.type === 'dim') app.openDim(hit);
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
  tap(ev) { openHit(this.app, ev, ['photo', 'memo', 'dim']); }

  // 長押し：1つ選んで削除
  async longPress(ev) {
    const v = ev.viewer;
    const hit = v.hitTest(ev.sx, ev.sy, ['photo', 'memo', 'dim', 'stroke', 'room']);
    if (!hit) return;
    v.highlightIds = new Set([hit.id]);
    v.requestRedraw();
    try {
      await this.app.deleteWithConfirm([hit]);
    } finally {
      v.highlightIds = new Set();
      v.requestRedraw();
    }
  }
}

export class CameraTool {
  constructor(app) {
    this.app = app;
    this.penOnly = false; // Apple Pencil 使用中でも指で操作できる
    this.drag = null;
  }
  get mode() { return this.app.settings.cameraMode === 'room' ? 'tap' : 'draw'; }

  tap(ev) {
    if (openHit(this.app, ev, ['photo'])) return;
    const room = roomAt(ev.viewer, ev.x, ev.y);
    if (!room) {
      const v = ev.viewer;
      this.app.toast(!v.layerVisible('room')
        ? '部屋範囲が非表示になっています（右上の表示切替）'
        : v.pageRooms().length
          ? '部屋の範囲内をタップしてください'
          : '部屋が登録されていません。先に「部屋」ツールで範囲を登録してください');
      return;
    }
    this.app.capturePhoto({ x: ev.x, y: ev.y, angle: null, room, mode: 'room' });
  }

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
    this.app.onToolStateChange();
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
    const s = this.app.settings;
    const hl = !!s.highlighter;
    this.cur = {
      points: [[ev.x, ev.y]],
      last: [ev.sx, ev.sy],
      color: s.color,
      highlight: hl,
      width: (hl ? s.hlWidth : s.penWidth) * ev.viewer.unit(),
    };
    ev.viewer.requestRedraw();
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
    const last = c.points[c.points.length - 1];
    if (last[0] !== ev.x || last[1] !== ev.y) c.points.push([ev.x, ev.y]);
    const stroke = {
      id: uid(),
      type: 'stroke',
      points: c.points.map(([x, y]) => [r2(x), r2(y)]),
      color: c.color,
      width: r2(c.width),
    };
    if (c.highlight) stroke.highlight = true;
    const { target } = this.app;
    this.app.store.mutate((p) => target.add(p, stroke));
  }

  cancel() { this.cur = null; this.app.viewer.requestRedraw(); }

  drawOverlay(ctx, v) {
    const c = this.cur;
    if (!c) return;
    ctx.save();
    if (c.highlight) ctx.globalAlpha = HL_ALPHA;
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
    const { target } = this.app;
    if (ids.size) this.app.store.mutate((p) => target.remove(p, ids));
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

export class DimTool {
  constructor(app) {
    this.app = app;
    this.penOnly = false;
    this.drag = null;
  }
  get fields() { return this.app.settings.dimFields; }
  get shape() { return dimShape(this.fields); }
  get mode() { return this.shape === 'point' ? 'tap' : 'draw'; }

  _newDim(p1, p2) {
    const values = {};
    for (const f of this.fields) values[f] = '';
    return {
      id: uid(), type: 'dim', shape: this.shape,
      p1: [r2(p1[0]), r2(p1[1])], p2: [r2(p2[0]), r2(p2[1])],
      fields: [...this.fields], values, color: this.app.settings.color,
    };
  }

  // H のみ：タップで置く
  tap(ev) {
    if (openHit(this.app, ev, ['dim'])) return;
    this.app.createDim(this._newDim([ev.x, ev.y], [ev.x, ev.y]));
  }

  down(ev) {
    this.drag = { start: ev, end: [ev.x, ev.y], hit: ev.viewer.hitTest(ev.sx, ev.sy, ['dim']) };
  }

  move(ev) {
    if (!this.drag) return;
    this.drag.end = this._snap(ev);
    this.drag.moved = this.drag.moved || Math.hypot(ev.sx - this.drag.start.sx, ev.sy - this.drag.start.sy) >= DIM_MIN_DRAG;
    ev.viewer.requestRedraw();
  }

  _snap(ev) {
    const s = this.drag.start;
    if (this.shape !== 'line') return [ev.x, ev.y];
    const dx = ev.x - s.x, dy = ev.y - s.y;
    const a = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    if (a < SNAP_DEG || a > 180 - SNAP_DEG) return [ev.x, s.y];
    if (Math.abs(a - 90) < SNAP_DEG) return [s.x, ev.y];
    return [ev.x, ev.y];
  }

  up(ev) {
    const d = this.drag;
    this.drag = null;
    ev.viewer.requestRedraw();
    if (!d) return;
    if (!d.moved) {
      if (d.hit) this.app.openDim(d.hit);
      else this.app.toast(this.shape === 'rect' ? '対角にドラッグして範囲を指定してください'
        : this.shape === 'circle' ? '中心から外へドラッグして円を指定してください'
          : '始点から終点へドラッグしてください');
      return;
    }
    this.app.createDim(this._newDim([d.start.x, d.start.y], d.end));
  }

  cancel() { this.drag = null; this.app.viewer.requestRedraw(); }

  drawOverlay(ctx, v) {
    const d = this.drag;
    if (!d || !d.moved) return;
    v.drawDim(ctx, this._newDim([d.start.x, d.start.y], d.end));
  }
}

/** 範囲選択（投げ縄）：囲んだものをまとめて移動・色変更・削除 */
export class SelectTool {
  constructor(app) {
    this.app = app;
    this.mode = 'draw';
    this.penOnly = false;
    this.objIds = new Set();
    this.roomIds = new Set();
    this.lasso = null;
    this.moving = null;
  }

  get count() { return this.objIds.size + this.roomIds.size; }

  selectedObjects(p = this.app.store.project) {
    return p.objects.filter((o) => this.objIds.has(o.id));
  }

  selectedRooms(p = this.app.store.project) {
    return p.rooms.filter((r) => this.roomIds.has(r.id));
  }

  _bounds(v) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of [...this.selectedObjects(), ...this.selectedRooms()]) {
      const b = v.screenBounds(o);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  down(ev) {
    const v = ev.viewer;
    const b = this.count ? this._bounds(v) : null;
    if (b && ev.sx >= b.x - 10 && ev.sx <= b.x + b.w + 10 && ev.sy >= b.y - 10 && ev.sy <= b.y + b.h + 10) {
      // 選択中のものをドラッグで移動（確定まではその場で書き換え、確定時に1回の変更として記録）
      this.moving = {
        start: [ev.x, ev.y], s0: [ev.sx, ev.sy], dx: 0, dy: 0,
        orig: new Map([...this.selectedObjects(), ...this.selectedRooms()].map((o) => [o.id, JSON.stringify(o)])),
      };
      return;
    }
    this.lasso = [[ev.sx, ev.sy]];
    v.requestRedraw();
  }

  move(ev) {
    const v = ev.viewer;
    if (this.moving) {
      const m = this.moving;
      m.dx = ev.x - m.start[0];
      m.dy = ev.y - m.start[1];
      m.dist = Math.hypot(ev.sx - m.s0[0], ev.sy - m.s0[1]);
      this._restore();
      for (const o of [...this.selectedObjects(), ...this.selectedRooms()]) translateObject(o, m.dx, m.dy);
      v.requestRedraw();
      return;
    }
    if (!this.lasso) return;
    const last = this.lasso[this.lasso.length - 1];
    if (Math.hypot(ev.sx - last[0], ev.sy - last[1]) >= 3) this.lasso.push([ev.sx, ev.sy]);
    v.requestRedraw();
  }

  _restore(m = this.moving) {
    const p = this.app.store.project;
    const put = (list) => list.map((o) => (m.orig.has(o.id) ? JSON.parse(m.orig.get(o.id)) : o));
    p.objects = put(p.objects);
    p.rooms = put(p.rooms);
  }

  up(ev) {
    const v = ev.viewer;
    if (this.moving) {
      const m = this.moving;
      this.moving = null;
      this._restore(m);
      if ((m.dist || 0) >= 3) {
        const ids = new Set([...this.objIds, ...this.roomIds]);
        this.app.store.mutate((p) => {
          for (const o of [...p.objects, ...p.rooms]) if (ids.has(o.id)) translateObject(o, m.dx, m.dy);
        });
      }
      v.requestRedraw();
      return;
    }
    const lasso = this.lasso;
    this.lasso = null;
    if (!lasso) return;
    let span = 0;
    for (const [x, y] of lasso) span = Math.max(span, Math.hypot(x - lasso[0][0], y - lasso[0][1]));
    if (lasso.length < 3 || span < 12) {
      // タップ：その1つだけ選ぶ（何もなければ選択解除）
      const hit = v.hitTest(ev.sx, ev.sy, ['photo', 'memo', 'dim', 'stroke', 'room']);
      this.objIds = new Set(hit && !hit.polygon ? [hit.id] : []);
      this.roomIds = new Set(hit && hit.polygon ? [hit.id] : []);
      this._changed();
      return;
    }
    const poly = lasso.map(([sx, sy]) => v.toDrawing(sx, sy));
    const inside = (o) => objectPoints(o).every(([x, y]) => pointInPolygon(x, y, poly));
    this.objIds = new Set(v.pageObjects().filter(inside).map((o) => o.id));
    this.roomIds = new Set(v.pageRooms().filter(inside).map((r) => r.id));
    this._changed();
    if (!this.count) this.app.toast('囲みの中に完全に入ったものがありません');
  }

  cancel() {
    if (this.moving) { this._restore(this.moving); this.moving = null; }
    this.lasso = null;
    this.app.viewer.requestRedraw();
  }

  clear() {
    this.objIds = new Set();
    this.roomIds = new Set();
    this._changed();
  }

  /** 元に戻す等で消えたものを選択から外す */
  sync() {
    const p = this.app.store.project;
    const ob = new Set(p.objects.map((o) => o.id));
    const rm = new Set(p.rooms.map((r) => r.id));
    const a = this.count;
    this.objIds = new Set([...this.objIds].filter((id) => ob.has(id)));
    this.roomIds = new Set([...this.roomIds].filter((id) => rm.has(id)));
    if (a !== this.count) this._changed();
    else this.app.viewer.highlightIds = new Set([...this.objIds, ...this.roomIds]);
  }

  deactivate() {
    this.cancel();
    this.objIds = new Set();
    this.roomIds = new Set();
    this.app.viewer.highlightIds = new Set();
  }

  _changed() {
    this.app.viewer.highlightIds = new Set([...this.objIds, ...this.roomIds]);
    this.app.viewer.requestRedraw();
    this.app.onToolStateChange();
  }

  drawOverlay(ctx, v) {
    if (this.lasso && this.lasso.length > 1) {
      ctx.save();
      ctx.beginPath();
      this.lasso.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(30,102,245,.06)';
      ctx.fill();
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    }
    if (this.count && !this.lasso) {
      const b = this._bounds(v);
      if (!b) return;
      ctx.save();
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
      ctx.restore();
    }
  }
}
