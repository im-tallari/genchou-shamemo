// 図面キャンバス：表示・パン／ズーム・オブジェクト描画・入力の振り分け

import { polygonCentroid } from './model.js';

const TAP_SLOP = 8;          // これ以上動いたらタップではなくドラッグ
const DETAIL_DELAY = 160;    // ズーム後に高解像度で描き直すまでの待ち(ms)
const MAX_DETAIL_PIXELS = 12e6;

export const ROOM_COLOR = '#00897b';
export const PIN_COLOR = '#d32f2f';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewer-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = 0;
    this.cssH = 0;

    this.view = { scale: 1, ox: 0, oy: 0 };
    this.page = null;          // { width, height }
    this.source = null;        // drawing-source
    this.pageIndex = 0;
    this.base = null;
    this.detail = null;
    this.detailTask = null;
    this.detailTimer = null;

    this.project = null;
    this.drawingId = null;
    this.hiddenIds = new Set();
    this.tool = null;          // 現在のツール（tools.js）
    this.penDetected = false;

    this.pointers = new Map();
    this.gesture = null;
    this._raf = 0;
    this.onViewChange = null;  // 表示位置が変わったら呼ばれる

    this._bindInput();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
  }

  // ---- 表示データ ----

  setProject(project) {
    this.project = project;
    this.requestRedraw();
  }

  async setPage(source, drawingId, pageIndex, savedView) {
    this._cancelDetail();
    this.source = source;
    this.drawingId = drawingId;
    this.pageIndex = pageIndex;
    this.base = null;
    this.detail = null;
    this.page = source ? source.pages[pageIndex] : null;
    if (!source) { this.requestRedraw(); return; }
    if (savedView) this.view = { ...savedView };
    else this.fit();
    this.requestRedraw();
    const b = await source.getBase(pageIndex);
    if (this.source !== source || this.pageIndex !== pageIndex) return;
    this.base = b;
    this.requestRedraw();
    this._scheduleDetail();
  }

  clearPage() {
    this.setPage(null, null, 0);
  }

  // ---- 座標変換 ----

  toDrawing(sx, sy) {
    return [(sx - this.view.ox) / this.view.scale, (sy - this.view.oy) / this.view.scale];
  }

  toScreen(x, y) {
    return [x * this.view.scale + this.view.ox, y * this.view.scale + this.view.oy];
  }

  fitScale() {
    if (!this.page || !this.cssW) return 1;
    return Math.min(this.cssW / this.page.width, this.cssH / this.page.height) * 0.95;
  }

  fit() {
    if (!this.page) return;
    const s = this.fitScale();
    this.view = {
      scale: s,
      ox: (this.cssW - this.page.width * s) / 2,
      oy: (this.cssH - this.page.height * s) / 2,
    };
    this._viewChanged();
  }

  zoomAt(sx, sy, factor) {
    const fs = this.fitScale();
    const ns = Math.min(fs * 60, Math.max(fs * 0.5, this.view.scale * factor));
    const [x, y] = this.toDrawing(sx, sy);
    this.view.scale = ns;
    this.view.ox = sx - x * ns;
    this.view.oy = sy - y * ns;
    this._viewChanged();
  }

  _viewChanged() {
    this.requestRedraw();
    this._scheduleDetail();
    if (this.onViewChange) this.onViewChange(this.view);
  }

  _resize() {
    const r = this.container.getBoundingClientRect();
    const oldW = this.cssW, oldH = this.cssH;
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
    if (this.page) {
      if (!oldW) this.fit();
      else {
        // 中心を保つ
        this.view.ox += (this.cssW - oldW) / 2;
        this.view.oy += (this.cssH - oldH) / 2;
        this._viewChanged();
      }
    }
    this.requestRedraw();
  }

  // ---- 高解像度の部分描画 ----

  _cancelDetail() {
    clearTimeout(this.detailTimer);
    if (this.detailTask) { this.detailTask.cancel(); this.detailTask = null; }
  }

  _scheduleDetail() {
    this._cancelDetail();
    if (!this.source || !this.source.supportsDetail) return;
    this.detailTimer = setTimeout(() => this._renderDetail(), DETAIL_DELAY);
  }

  _renderDetail() {
    if (!this.base || !this.page) return;
    let s = this.view.scale * this.dpr;
    const baseScale = this.base.image.width / this.page.width;
    if (s <= baseScale * 1.15) { this.detail = null; this.requestRedraw(); return; }
    const [x0, y0] = this.toDrawing(0, 0);
    const [x1, y1] = this.toDrawing(this.cssW, this.cssH);
    const rx = Math.max(0, x0), ry = Math.max(0, y0);
    const rw = Math.min(this.page.width, x1) - rx;
    const rh = Math.min(this.page.height, y1) - ry;
    if (rw <= 0 || rh <= 0) return;
    if (rw * rh * s * s > MAX_DETAIL_PIXELS) s = Math.sqrt(MAX_DETAIL_PIXELS / (rw * rh));
    const d = this.detail;
    if (d && Math.abs(d.scale - s) < 1e-6 && d.rect.x <= rx && d.rect.y <= ry &&
        d.rect.x + d.rect.w >= rx + rw && d.rect.y + d.rect.h >= ry + rh) return;
    const rect = { x: rx, y: ry, w: rw, h: rh };
    const task = this.source.renderRegion(this.pageIndex, s, rect);
    this.detailTask = task;
    const source = this.source, pageIndex = this.pageIndex;
    task.promise.then((canvas) => {
      if (this.detailTask !== task || this.source !== source || this.pageIndex !== pageIndex) return;
      this.detailTask = null;
      this.detail = { canvas, rect, scale: s };
      this.requestRedraw();
    }).catch((e) => {
      if (e && e.name !== 'RenderingCancelledException') console.warn(e);
    });
  }

  // ---- 描画 ----

  requestRedraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
    });
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e8eaed';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!this.page) return;
    const { scale, ox, oy } = this.view;

    // 図面
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#fff';
    ctx.fillRect(ox, oy, this.page.width * scale, this.page.height * scale);
    ctx.restore();
    if (this.base) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.base.image, ox, oy, this.page.width * scale, this.page.height * scale);
    }
    if (this.detail) {
      const r = this.detail.rect;
      ctx.drawImage(this.detail.canvas, ox + r.x * scale, oy + r.y * scale, r.w * scale, r.h * scale);
    }

    if (this.project) this._drawObjects(ctx);
    if (this.tool && this.tool.drawOverlay) this.tool.drawOverlay(ctx, this);
  }

  pageObjects() {
    if (!this.project) return [];
    return this.project.objects.filter(
      (o) => o.drawingId === this.drawingId && o.page === this.pageIndex && !this.hiddenIds.has(o.id)
    );
  }

  pageRooms() {
    if (!this.project) return [];
    return this.project.rooms.filter((r) => r.drawingId === this.drawingId && r.page === this.pageIndex);
  }

  _drawObjects(ctx) {
    const objs = this.pageObjects();
    for (const r of this.pageRooms()) this.drawRoom(ctx, r);
    for (const o of objs) if (o.type === 'stroke') this.drawStroke(ctx, o);
    for (const o of objs) if (o.type === 'memo') this.drawMemo(ctx, o);
    for (const o of objs) if (o.type === 'photo') this.drawPhotoPin(ctx, o);
  }

  drawRoom(ctx, room, { draft = false } = {}) {
    const pts = room.polygon.map(([x, y]) => this.toScreen(x, y));
    if (!pts.length) return;
    ctx.save();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (!draft) ctx.closePath();
    if (!draft) {
      ctx.fillStyle = 'rgba(0,137,123,0.08)';
      ctx.fill();
    }
    ctx.strokeStyle = ROOM_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (draft) {
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.stroke();
      }
    } else if (room.name) {
      const [cx, cy] = this.toScreen(...polygonCentroid(room.polygon));
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.strokeText(room.name, cx, cy);
      ctx.fillStyle = ROOM_COLOR;
      ctx.fillText(room.name, cx, cy);
    }
    ctx.restore();
  }

  drawStroke(ctx, s) {
    const pts = s.points;
    if (!pts.length) return;
    const { scale, ox, oy } = this.view;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(0.75, s.width * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    tracePath(ctx, pts, scale, ox, oy);
    ctx.restore();
  }

  _pinLabel(o) {
    const n = String(o.number || '');
    const m = /^(\d{4})(\d{4})-(\d+)$/.exec(n);
    return m ? `${m[2]}-${m[3]}` : n;
  }

  _pinBox(ctx, o) {
    const [sx, sy] = this.toScreen(o.x, o.y);
    ctx.font = 'bold 12px system-ui, sans-serif';
    const w = Math.max(24, ctx.measureText(this._pinLabel(o)).width + 12);
    const h = 22;
    return { sx, sy, x: sx - w / 2, y: sy - h / 2, w, h };
  }

  drawPhotoPin(ctx, o) {
    ctx.save();
    const b = this._pinBox(ctx, o);
    if (o.angle != null) drawArrow(ctx, b.sx, b.sy, o.angle, PIN_COLOR);
    ctx.shadowColor = 'rgba(0,0,0,.3)';
    ctx.shadowBlur = 3;
    roundRect(ctx, b.x, b.y, b.w, b.h, 11);
    ctx.fillStyle = o.roomId && o.angle == null ? ROOM_COLOR : PIN_COLOR;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._pinLabel(o), b.sx, b.sy + 0.5);
    ctx.restore();
  }

  _memoBox(ctx, m) {
    const [sx, sy] = this.toScreen(m.x, m.y);
    const pad = 6;
    const maxW = 180;
    ctx.font = '13px system-ui, sans-serif';
    const text = m.text ? truncate(ctx, firstLine(m.text), maxW - pad * 2) : '';
    const hasHw = m.handwriting && m.handwriting.strokes && m.handwriting.strokes.length;
    const thumbW = 96, thumbH = 64;
    let w = 0, h = pad * 2;
    if (text) { w = Math.max(w, ctx.measureText(text).width); h += 16; }
    if (hasHw) { w = Math.max(w, thumbW); h += thumbH + (text ? 4 : 0); }
    if (!text && !hasHw) { w = 16; h += 16; }
    w += pad * 2;
    return { sx, sy, x: sx + 4, y: sy - h - 10, w, h, pad, text, hasHw, thumbW, thumbH };
  }

  drawMemo(ctx, m) {
    ctx.save();
    const b = this._memoBox(ctx, m);
    // 吹き出し
    ctx.beginPath();
    ctx.moveTo(b.sx, b.sy);
    ctx.lineTo(b.x + 6, b.y + b.h);
    ctx.lineTo(b.x + 16, b.y + b.h);
    ctx.closePath();
    ctx.fillStyle = m.color;
    ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,.25)';
    ctx.shadowBlur = 4;
    roundRect(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2;
    ctx.strokeStyle = m.color;
    ctx.stroke();
    let y = b.y + b.pad;
    ctx.fillStyle = m.color;
    ctx.textBaseline = 'top';
    if (b.text) {
      ctx.fillText(b.text, b.x + b.pad, y + 1);
      y += 16 + (b.hasHw ? 4 : 0);
    } else if (!b.hasHw) {
      ctx.fillText('…', b.x + b.pad, y + 1);
    }
    if (b.hasHw) {
      drawHandwriting(ctx, m.handwriting, m.color, b.x + b.pad, y, b.thumbW, b.thumbH, { crop: true });
    }
    ctx.restore();
  }

  /** 画面座標で、タップ対象（写真ピン・メモ）を探す。手前に描くものを優先 */
  hitTest(sx, sy, types = ['photo', 'memo']) {
    const ctx = this.ctx;
    const objs = this.pageObjects();
    if (types.includes('photo')) {
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        if (o.type !== 'photo') continue;
        const b = this._pinBox(ctx, o);
        if (sx >= b.x - 6 && sx <= b.x + b.w + 6 && sy >= b.y - 6 && sy <= b.y + b.h + 6) return o;
      }
    }
    if (types.includes('memo')) {
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        if (o.type !== 'memo') continue;
        const b = this._memoBox(ctx, o);
        if ((sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h + 10) ||
            Math.hypot(sx - b.sx, sy - b.sy) < 10) return o;
      }
    }
    return null;
  }

  // ---- 入力 ----

  _bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerup', (e) => this._onUp(e));
    c.addEventListener('pointercancel', (e) => this._onUp(e, true));
    c.addEventListener('lostpointercapture', (e) => { if (this.pointers.has(e.pointerId)) this._onUp(e, true); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.page) return;
      const r = c.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari のページ拡大を抑止
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
      c.addEventListener(t, (e) => e.preventDefault());
    }
  }

  _evt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [x, y] = this.toDrawing(sx, sy);
    return { sx, sy, x, y, pointerType: e.pointerType, viewer: this };
  }

  _onDown(e) {
    if (!this.page) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    if (e.pointerType === 'pen') this.penDetected = true;
    const ev = this._evt(e);
    this.pointers.set(e.pointerId, { sx: ev.sx, sy: ev.sy, type: e.pointerType });

    if (this.pointers.size === 2) {
      // 2本指：ツール操作を取り消してピンチへ
      this._cancelGesture();
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: 'pinch',
        d0: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1,
        m0: [(a.sx + b.sx) / 2, (a.sy + b.sy) / 2],
        view0: { ...this.view },
      };
      return;
    }
    if (this.pointers.size > 2 || this.gesture) return;

    if (e.pointerType === 'mouse' && e.button !== 0) {
      this.gesture = { kind: 'pan', id: e.pointerId, s0: [ev.sx, ev.sy], view0: { ...this.view }, moved: true };
      return;
    }

    const tool = this.tool;
    const drawLike = tool && tool.mode === 'draw' &&
      !(this.penDetected && e.pointerType === 'touch' && tool.penOnly !== false);
    if (drawLike) {
      this.gesture = { kind: 'tool', id: e.pointerId };
      tool.down(ev);
    } else {
      // タップ or 1本指パン
      this.gesture = { kind: 'tap', id: e.pointerId, s0: [ev.sx, ev.sy], view0: { ...this.view }, moved: false, ev0: ev };
      if (tool && tool.press) tool.press(ev);
    }
  }

  _onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const ev = this._evt(e);
    p.sx = ev.sx; p.sy = ev.sy;
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.sx - b.sx, a.sy - b.sy);
      const m = [(a.sx + b.sx) / 2, (a.sy + b.sy) / 2];
      const fs = this.fitScale();
      const ns = Math.min(fs * 60, Math.max(fs * 0.5, g.view0.scale * (d / g.d0)));
      const x = (g.m0[0] - g.view0.ox) / g.view0.scale;
      const y = (g.m0[1] - g.view0.oy) / g.view0.scale;
      this.view = { scale: ns, ox: m[0] - x * ns, oy: m[1] - y * ns };
      this._viewChanged();
    } else if (g.id !== e.pointerId) {
      return;
    } else if (g.kind === 'tool') {
      // 合体イベント（Apple Pencil 等の高頻度入力）を取りこぼさない
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (list.length > 1) for (const ce of list) this.tool.move(this._evt(ce));
      else this.tool.move(ev);
    } else if (g.kind === 'pan' || g.kind === 'tap') {
      const dx = ev.sx - g.s0[0], dy = ev.sy - g.s0[1];
      if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
      if (g.moved) {
        this.view = { scale: g.view0.scale, ox: g.view0.ox + dx, oy: g.view0.oy + dy };
        this._viewChanged();
      }
    }
  }

  _onUp(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    if (g.id !== e.pointerId) return;
    this.gesture = null;
    if (g.kind === 'tool') {
      if (cancelled) this.tool.cancel();
      else this.tool.up(this._evt(e));
    } else if (g.kind === 'tap' && !g.moved && !cancelled && this.tool && this.tool.tap) {
      this.tool.tap(g.ev0);
    }
  }

  _cancelGesture() {
    const g = this.gesture;
    if (g && g.kind === 'tool' && this.tool) this.tool.cancel();
    this.gesture = null;
  }

  /** ツール切替時などに呼ぶ */
  resetGesture() {
    this._cancelGesture();
    this.requestRedraw();
  }
}

// ---- 描画ヘルパー ----

export function tracePath(ctx, pts, scale, ox, oy) {
  const X = (p) => p[0] * scale + ox;
  const Y = (p) => p[1] * scale + oy;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(X(pts[0]), Y(pts[0]), ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(X(pts[0]), Y(pts[0]));
  if (pts.length === 2) {
    ctx.lineTo(X(pts[1]), Y(pts[1]));
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (X(pts[i]) + X(pts[i + 1])) / 2;
      const my = (Y(pts[i]) + Y(pts[i + 1])) / 2;
      ctx.quadraticCurveTo(X(pts[i]), Y(pts[i]), mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(X(last), Y(last));
  }
  ctx.stroke();
}

/** 手書きデータ（パッド座標）を枠内に縮小して描く */
export function drawHandwriting(ctx, hw, color, x, y, w, h, { crop = false } = {}) {
  // crop=true: 書いた部分だけを拡大して表示（図面上のサムネイル用）
  let bx = 0, by = 0, bw = hw.width, bh = hw.height;
  if (crop) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of hw.strokes) for (const [px, py] of s.points) {
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    if (x0 <= x1) {
      const pad = 8;
      const minSide = Math.max(hw.width, hw.height) / 4; // 小さな点を過剰に拡大しない
      bw = Math.max(x1 - x0 + pad * 2, minSide);
      bh = Math.max(y1 - y0 + pad * 2, minSide * (h / w));
      bx = (x0 + x1) / 2 - bw / 2;
      by = (y0 + y1) / 2 - bh / 2;
    }
  }
  const k = Math.min(w / bw, h / bh);
  const ox = x + (w - bw * k) / 2 - bx * k;
  const oy = y + (h - bh * k) / 2 - by * k;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of hw.strokes) {
    ctx.lineWidth = Math.max(0.6, s.width * k);
    tracePath(ctx, s.points, k, ox, oy);
  }
  ctx.restore();
}

export function drawArrow(ctx, sx, sy, angle, color, len = 44) {
  const ex = sx + Math.cos(angle) * len;
  const ey = sy + Math.sin(angle) * len;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex - Math.cos(angle) * 8, ey - Math.sin(angle) * 8);
  ctx.stroke();
  const a = 0.5, hl = 13;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - Math.cos(angle - a) * hl, ey - Math.sin(angle - a) * hl);
  ctx.lineTo(ex - Math.cos(angle + a) * hl, ey - Math.sin(angle + a) * hl);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function firstLine(t) {
  const lines = t.split(/\r?\n/);
  return lines.length > 1 ? lines[0] + '…' : lines[0];
}

function truncate(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  const chars = [...text.replace(/…$/, '')];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + '…';
}
