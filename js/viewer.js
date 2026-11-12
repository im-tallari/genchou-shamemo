// 図面キャンバス：表示・パン／ズーム・オブジェクト描画・入力の振り分け
// 写真ビューアー（写真への書き込み）でも同じクラスを使う

import {
  polygonCentroid, pointInPolygon, distToSegment, unitScale, objectPoints,
  dimText, DIM_TEXT_PT, HL_ALPHA,
} from './model.js';

const TAP_SLOP = 8;          // これ以上動いたらタップではなくドラッグ
const LONG_PRESS_MS = 500;
const DETAIL_DELAY = 160;    // ズーム後に高解像度で描き直すまでの待ち(ms)
const MAX_DETAIL_PIXELS = 12e6;
const HIT = 10;              // タップ判定の余裕(画面px)

export const ROOM_COLOR = '#00897b';
export const PIN_COLOR = '#d32f2f';
export const SELECT_COLOR = '#1e66f5';

export const LAYERS = [
  { id: 'photo', label: '写真ピン' },
  { id: 'memo', label: 'メモ' },
  { id: 'stroke', label: '手書き' },
  { id: 'dim', label: '寸法' },
  { id: 'room', label: '部屋範囲' },
];

export class Viewer {
  /**
   * options.memoStyle: 'bubble'（図面：番号＋1行に省略）| 'tag'（PDF出力：番号のみ）
   *                    | 'full'（写真：全文を写真に固定した大きさで）
   * container=null で画面に出さない描画専用（出力用）になる
   */
  constructor(container, { memoStyle = 'bubble', unitBase = 1190.55 } = {}) {
    this.container = container;
    this.memoStyle = memoStyle;
    this.unitBase = unitBase;
    this.ui = 1; // 画面上で一定の大きさのもの（ピン・吹き出し・部屋名）の倍率。出力時に使う
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewer-canvas';
    if (container) container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = 0;
    this.cssH = 0;

    this.view = { scale: 1, ox: 0, oy: 0 };
    this.page = null;          // { width, height }
    this.source = null;        // drawing-source
    this.pageIndex = 0;
    this.drawingId = null;
    this.base = null;
    this.detail = null;
    this.detailTask = null;
    this.detailTimer = null;

    // 表示するオブジェクト・部屋を返す関数（呼び出し側が設定）
    this.objectSource = () => [];
    this.roomSource = () => [];
    this.layers = { photo: true, memo: true, stroke: true, dim: true, room: true };
    this.hiddenIds = new Set();     // 消しゴムでなぞり中など、一時的に隠す
    this.highlightIds = new Set();  // 強調表示（選択中・長押し中）
    this.tool = null;
    this.penDetected = false;

    this.pointers = new Map();
    this.gesture = null;
    this._raf = 0;
    this.onViewChange = null;

    if (!container) return;
    this._bindInput();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this._cancelDetail();
    cancelAnimationFrame(this._raf);
    this.canvas.remove();
  }

  // ---- 表示データ ----

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

  /** 線の太さ・文字の大きさの基準（図面は A3 長辺 = 1190.55 を 1 とする） */
  unit() {
    return this.page ? (unitScale(this.page) * 1190.55) / this.unitBase : 1;
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

  _clampScale(s) {
    const fs = this.fitScale();
    return Math.min(fs * 60, Math.max(fs * 0.5, s));
  }

  zoomAt(sx, sy, factor) {
    const ns = this._clampScale(this.view.scale * factor);
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
    if (r.width < 1 || r.height < 1) return;
    const oldW = this.cssW, oldH = this.cssH;
    this.cssW = r.width;
    this.cssH = r.height;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
    if (this.page) {
      if (!oldW) this.fit();
      else {
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
    ctx.fillStyle = this.memoStyle === 'full' ? '#111' : '#e8eaed';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!this.page) return;
    const { scale, ox, oy } = this.view;

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

    this._drawObjects(ctx);
    if (this.highlightIds.size) this._drawHighlight(ctx);
    if (this.tool && this.tool.drawOverlay) this.tool.drawOverlay(ctx, this);
  }

  layerVisible(type) {
    return this.layers[type] !== false;
  }

  /** 表示中のオブジェクト（非表示レイヤー・一時非表示を除く） */
  pageObjects() {
    return this.objectSource().filter((o) => this.layerVisible(o.type) && !this.hiddenIds.has(o.id));
  }

  pageRooms() {
    if (!this.layerVisible('room')) return [];
    return this.roomSource().filter((r) => !this.hiddenIds.has(r.id));
  }

  _drawObjects(ctx) {
    const objs = this.pageObjects();
    for (const r of this.pageRooms()) this.drawRoom(ctx, r);
    // 蛍光ペンは普通の線より下に描く
    for (const o of objs) if (o.type === 'stroke' && o.highlight) this.drawStroke(ctx, o);
    for (const o of objs) if (o.type === 'stroke' && !o.highlight) this.drawStroke(ctx, o);
    for (const o of objs) if (o.type === 'dim') this.drawDim(ctx, o);
    for (const o of objs) if (o.type === 'memo') this.drawMemo(ctx, o);
    for (const o of objs) if (o.type === 'photo') this.drawPhotoPin(ctx, o);
  }

  _drawHighlight(ctx) {
    const items = [
      ...this.objectSource().filter((o) => this.highlightIds.has(o.id)),
      ...this.roomSource().filter((r) => this.highlightIds.has(r.id)),
    ];
    ctx.save();
    ctx.strokeStyle = SELECT_COLOR;
    ctx.fillStyle = 'rgba(30,102,245,.08)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    for (const o of items) {
      const b = this.screenBounds(o);
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.restore();
  }

  /** オブジェクトの画面上の外接矩形（余白込み） */
  screenBounds(o) {
    if (o.type === 'photo') { const b = this._pinBox(this.ctx, o); return pad(b, 5); }
    if (o.type === 'memo') { const b = this._memoBox(this.ctx, o); return pad(b, 5); }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of objectPoints(o)) {
      const [sx, sy] = this.toScreen(p[0], p[1]);
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    const m = o.type === 'stroke' ? (o.width * this.view.scale) / 2 + 5 : 8;
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + m * 2, h: y1 - y0 + m * 2 };
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
    const ui = this.ui;
    ctx.strokeStyle = ROOM_COLOR;
    ctx.lineWidth = 2 * ui;
    ctx.setLineDash([6 * ui, 4 * ui]);
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
      ctx.font = `bold ${13 * ui}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4 * ui;
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
    if (s.highlight) ctx.globalAlpha = HL_ALPHA;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(0.75, s.width * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    tracePath(ctx, pts, scale, ox, oy);
    ctx.restore();
  }

  // ---- 寸法 ----

  /** 寸法の画面上の形と文字の配置 */
  _dimLayout(ctx, d) {
    const u = this.unit();
    const font = DIM_TEXT_PT * u * this.view.scale; // 図面に連動
    const lw = Math.max(this.ui, 0.6 * u * this.view.scale);
    const gap = font * 0.35;
    const f = (k) => (d.fields || []).includes(k);
    const hText = f('H') ? dimText(d, 'H') : '';
    const join = (...a) => a.filter(Boolean).join('×');
    const L = { font, lw, labels: [] };
    const [ax, ay] = this.toScreen(...d.p1);
    const [bx, by] = this.toScreen(...(d.p2 || d.p1));
    if (d.shape === 'line') {
      let a = Math.atan2(by - ay, bx - ax);
      let ta = a;
      if (ta > Math.PI / 2) ta -= Math.PI; else if (ta <= -Math.PI / 2) ta += Math.PI;
      const nx = Math.sin(ta), ny = -Math.cos(ta); // 文字の上側方向
      L.geom = { kind: 'line', ax, ay, bx, by, a };
      L.labels.push({ text: join(dimText(d, 'L'), hText), x: (ax + bx) / 2 + nx * gap, y: (ay + by) / 2 + ny * gap, angle: ta, align: 'center', base: 'bottom' });
    } else if (d.shape === 'rect') {
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      L.geom = { kind: 'rect', x0, y0, x1, y1 };
      if (f('W')) L.labels.push({ text: dimText(d, 'W'), x: (x0 + x1) / 2, y: y0 - gap, angle: 0, align: 'center', base: 'bottom' });
      if (f('D')) L.labels.push({ text: dimText(d, 'D'), x: x1 + gap, y: (y0 + y1) / 2, angle: 0, align: 'left', base: 'middle' });
      if (hText) L.labels.push({ text: hText, x: (x0 + x1) / 2, y: (y0 + y1) / 2, angle: 0, align: 'center', base: 'middle' });
    } else if (d.shape === 'circle') {
      const r = Math.hypot(bx - ax, by - ay);
      L.geom = { kind: 'circle', cx: ax, cy: ay, r };
      const k = Math.SQRT1_2;
      L.labels.push({ text: join(dimText(d, 'phi'), hText), x: ax + r * k + gap * 0.5, y: ay - r * k - gap * 0.5, angle: 0, align: 'left', base: 'bottom' });
    } else {
      L.geom = { kind: 'point', cx: ax, cy: ay };
      L.labels.push({ text: hText || 'H?', x: ax + Math.max(8, gap * 2), y: ay, angle: 0, align: 'left', base: 'middle' });
    }
    return L;
  }

  drawDim(ctx, d) {
    const L = this._dimLayout(ctx, d);
    const g = L.geom;
    ctx.save();
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = L.lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (g.kind === 'line') {
      ctx.moveTo(g.ax, g.ay);
      ctx.lineTo(g.bx, g.by);
      // 両端の斜線
      const t = Math.max(5, L.font * 0.7);
      for (const [x, y] of [[g.ax, g.ay], [g.bx, g.by]]) {
        const a = g.a + Math.PI / 4;
        ctx.moveTo(x - Math.cos(a) * t / 2, y - Math.sin(a) * t / 2);
        ctx.lineTo(x + Math.cos(a) * t / 2, y + Math.sin(a) * t / 2);
      }
    } else if (g.kind === 'rect') {
      ctx.rect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0);
    } else if (g.kind === 'circle') {
      ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2);
      const c = Math.max(3, L.font * 0.3);
      ctx.moveTo(g.cx - c, g.cy); ctx.lineTo(g.cx + c, g.cy);
      ctx.moveTo(g.cx, g.cy - c); ctx.lineTo(g.cx, g.cy + c);
    } else {
      const r = 5 * this.ui;
      ctx.arc(g.cx, g.cy, r, 0, Math.PI * 2);
      ctx.moveTo(g.cx - r, g.cy); ctx.lineTo(g.cx + r, g.cy);
      ctx.moveTo(g.cx, g.cy - r); ctx.lineTo(g.cx, g.cy + r);
    }
    ctx.stroke();
    if (L.font >= 2) {
      ctx.font = `600 ${L.font}px system-ui, sans-serif`;
      ctx.lineJoin = 'round';
      for (const lb of L.labels) {
        ctx.save();
        ctx.translate(lb.x, lb.y);
        ctx.rotate(lb.angle);
        ctx.textAlign = lb.align;
        ctx.textBaseline = lb.base === 'bottom' ? 'alphabetic' : 'middle';
        ctx.lineWidth = Math.max(2, L.font * 0.25);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.strokeText(lb.text, 0, 0);
        ctx.fillText(lb.text, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  _dimHit(ctx, d, sx, sy) {
    const L = this._dimLayout(ctx, d);
    const g = L.geom;
    let dist;
    if (g.kind === 'line') dist = distToSegment(sx, sy, g.ax, g.ay, g.bx, g.by);
    else if (g.kind === 'rect') {
      dist = Math.min(
        distToSegment(sx, sy, g.x0, g.y0, g.x1, g.y0), distToSegment(sx, sy, g.x1, g.y0, g.x1, g.y1),
        distToSegment(sx, sy, g.x1, g.y1, g.x0, g.y1), distToSegment(sx, sy, g.x0, g.y1, g.x0, g.y0));
    } else if (g.kind === 'circle') dist = Math.abs(Math.hypot(sx - g.cx, sy - g.cy) - g.r);
    else dist = Math.hypot(sx - g.cx, sy - g.cy) - 4;
    if (dist <= HIT) return true;
    // 文字の上
    ctx.font = `600 ${L.font}px system-ui, sans-serif`;
    for (const lb of L.labels) {
      const w = ctx.measureText(lb.text).width;
      const c = Math.cos(-lb.angle), s = Math.sin(-lb.angle);
      const dx = sx - lb.x, dy = sy - lb.y;
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      const x0 = lb.align === 'center' ? -w / 2 : 0;
      const y0 = lb.base === 'bottom' ? -L.font : -L.font / 2;
      if (lx >= x0 - 4 && lx <= x0 + w + 4 && ly >= y0 - 4 && ly <= y0 + L.font + 4) return true;
    }
    return false;
  }

  // ---- 写真ピン ----

  _pinLabel(o) {
    const n = String(o.number || '');
    const m = /^(\d{4})(\d{4})-(\d+)$/.exec(n);
    return m ? `${m[2]}-${m[3]}` : n;
  }

  _pinBox(ctx, o) {
    const [sx, sy] = this.toScreen(o.x, o.y);
    return this._pinBoxAt(ctx, o, sx, sy);
  }

  _pinBoxAt(ctx, o, sx, sy) {
    ctx.font = 'bold 12px system-ui, sans-serif';
    const w = Math.max(24, ctx.measureText(this._pinLabel(o)).width + 12);
    const h = 22;
    return { sx, sy, x: sx - w / 2, y: sy - h / 2, w, h };
  }

  drawPhotoPin(ctx, o) {
    ctx.save();
    // ピンの位置を原点にして倍率 ui で描く
    const [px, py] = this.toScreen(o.x, o.y);
    ctx.translate(px, py);
    ctx.scale(this.ui, this.ui);
    const b = this._pinBoxAt(ctx, o, 0, 0);
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
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._pinLabel(o), b.sx, b.sy + 0.5);
    // 書き込みありの印
    if (o.annotations && o.annotations.length) {
      ctx.beginPath();
      ctx.arc(b.x + b.w - 1, b.y + 1, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffb300';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- メモ ----

  _memoBox(ctx, m) {
    if (this.memoStyle === 'full') return this._memoBoxFull(ctx, m);
    const [sx, sy] = this.toScreen(m.x, m.y);
    return this._memoBoxBubble(ctx, m, sx, sy);
  }

  _memoBoxBubble(ctx, m, sx, sy) {
    const pad = 6;
    const maxW = 180;
    const tag = this.memoStyle === 'tag';
    ctx.font = '13px system-ui, sans-serif';
    const head = m.number ? m.number : '';
    const body = tag ? '' : (m.text ? firstLine(m.text) : '');
    const text = head || body ? truncate(ctx, [head, body].filter(Boolean).join(' '), maxW - pad * 2) : '';
    const hasHw = !tag && !!(m.handwriting && m.handwriting.strokes && m.handwriting.strokes.length);
    const thumbW = 96, thumbH = 64;
    let w = 0, h = pad * 2;
    if (text) { w = Math.max(w, ctx.measureText(text).width); h += 16; }
    if (hasHw) { w = Math.max(w, thumbW); h += thumbH + (text ? 4 : 0); }
    if (!text && !hasHw) { w = 16; h += 16; }
    w += pad * 2;
    return { sx, sy, x: sx + 4, y: sy - h - 10, w, h, pad, lines: text ? [text] : [], lineH: 16, font: 13, hasHw, thumbW, thumbH, tail: true };
  }

  /** 写真用：全文表示。大きさは写真に対する比率（拡大すると一緒に大きくなる） */
  _memoBoxFull(ctx, m) {
    const [sx, sy] = this.toScreen(m.x, m.y);
    const long = Math.max(this.page.width, this.page.height);
    const k = this.view.scale;
    const font = (long / 42) * k;
    const pad = font * 0.4;
    const maxW = (long * 0.42) * k;
    ctx.font = `${font}px system-ui, sans-serif`;
    const lines = m.text ? wrapText(ctx, m.text, maxW) : [];
    const hasHw = !!(m.handwriting && m.handwriting.strokes && m.handwriting.strokes.length);
    const thumbW = long * 0.22 * k, thumbH = thumbW * 2 / 3;
    const lineH = font * 1.3;
    let w = 0, h = pad * 2;
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    h += lines.length * lineH;
    if (hasHw) { w = Math.max(w, thumbW); h += thumbH + (lines.length ? pad : 0); }
    if (!lines.length && !hasHw) { w = font; h += lineH; }
    w += pad * 2;
    return { sx, sy, x: sx, y: sy, w, h, pad, lines, lineH, font, hasHw, thumbW, thumbH, tail: false };
  }

  drawMemo(ctx, m) {
    ctx.save();
    let b;
    if (this.memoStyle === 'full') {
      b = this._memoBoxFull(ctx, m);
    } else {
      // 吹き出しは位置を原点にして倍率 ui で描く
      const [px, py] = this.toScreen(m.x, m.y);
      ctx.translate(px, py);
      ctx.scale(this.ui, this.ui);
      b = this._memoBoxBubble(ctx, m, 0, 0);
    }
    if (b.tail) {
      ctx.beginPath();
      ctx.moveTo(b.sx, b.sy);
      ctx.lineTo(b.x + 6, b.y + b.h);
      ctx.lineTo(b.x + 16, b.y + b.h);
      ctx.closePath();
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.shadowColor = 'rgba(0,0,0,.25)';
      ctx.shadowBlur = 4;
    }
    const r = Math.min(6, b.font * 0.4);
    roundRect(ctx, b.x, b.y, b.w, b.h, r);
    ctx.fillStyle = b.tail ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.85)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = b.tail ? 2 : Math.max(1, b.font * 0.12);
    ctx.strokeStyle = m.color;
    ctx.stroke();
    let y = b.y + b.pad;
    ctx.fillStyle = m.color;
    ctx.textBaseline = 'top';
    ctx.font = `${b.font}px system-ui, sans-serif`;
    if (b.lines.length) {
      for (const l of b.lines) { ctx.fillText(l, b.x + b.pad, y + b.font * 0.08); y += b.lineH; }
      if (b.hasHw) y += b.tail ? 4 : b.pad;
    } else if (!b.hasHw) {
      ctx.fillText('…', b.x + b.pad, y + 1);
    }
    if (b.hasHw) drawHandwriting(ctx, m.handwriting, m.color, b.x + b.pad, y, b.thumbW, b.thumbH, { crop: true });
    ctx.restore();
  }

  // ---- 当たり判定 ----

  /** 画面座標で、タップ対象を探す。手前に描くものを優先 */
  hitTest(sx, sy, types = ['photo', 'memo', 'dim']) {
    const ctx = this.ctx;
    const objs = this.pageObjects();
    const rev = (t) => objs.filter((o) => o.type === t).reverse();
    if (types.includes('photo')) {
      for (const o of rev('photo')) {
        const b = this._pinBox(ctx, o);
        if (sx >= b.x - 6 && sx <= b.x + b.w + 6 && sy >= b.y - 6 && sy <= b.y + b.h + 6) return o;
      }
    }
    if (types.includes('memo')) {
      for (const o of rev('memo')) {
        const b = this._memoBox(ctx, o);
        if ((sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h + (b.tail ? 10 : 0)) ||
            Math.hypot(sx - b.sx, sy - b.sy) < 10) return o;
      }
    }
    if (types.includes('dim')) {
      for (const o of rev('dim')) if (this._dimHit(ctx, o, sx, sy)) return o;
    }
    if (types.includes('stroke')) {
      const { scale, ox, oy } = this.view;
      for (const o of rev('stroke')) {
        const r = HIT + (o.width * scale) / 2;
        const p = o.points;
        for (let i = 0; i < p.length; i++) {
          const a = p[Math.max(0, i - 1)], b = p[i];
          if (distToSegment(sx, sy, a[0] * scale + ox, a[1] * scale + oy, b[0] * scale + ox, b[1] * scale + oy) <= r) return o;
        }
      }
    }
    if (types.includes('room')) {
      const [x, y] = this.toDrawing(sx, sy);
      const rooms = this.pageRooms();
      for (let i = rooms.length - 1; i >= 0; i--) if (pointInPolygon(x, y, rooms[i].polygon)) return rooms[i];
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
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 合成イベント等 */ }
    if (e.pointerType === 'pen') this.penDetected = true;
    const ev = this._evt(e);
    this.pointers.set(e.pointerId, { sx: ev.sx, sy: ev.sy, type: e.pointerType });

    if (this.pointers.size === 2) {
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
      const g = { kind: 'tap', id: e.pointerId, s0: [ev.sx, ev.sy], view0: { ...this.view }, moved: false, ev0: ev, long: false };
      this.gesture = g;
      if (tool && tool.longPress) {
        g.timer = setTimeout(() => {
          if (this.gesture !== g || g.moved) return;
          g.long = true;
          if (navigator.vibrate) navigator.vibrate(15);
          tool.longPress(ev);
        }, LONG_PRESS_MS);
      }
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
      const ns = this._clampScale(g.view0.scale * (d / g.d0));
      const x = (g.m0[0] - g.view0.ox) / g.view0.scale;
      const y = (g.m0[1] - g.view0.oy) / g.view0.scale;
      this.view = { scale: ns, ox: m[0] - x * ns, oy: m[1] - y * ns };
      this._viewChanged();
    } else if (g.id !== e.pointerId) {
      return;
    } else if (g.kind === 'tool') {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (list.length > 1) for (const ce of list) this.tool.move(this._evt(ce));
      else this.tool.move(ev);
    } else if (g.kind === 'pan' || g.kind === 'tap') {
      if (g.long) return;
      const dx = ev.sx - g.s0[0], dy = ev.sy - g.s0[1];
      if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) { g.moved = true; clearTimeout(g.timer); }
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
    clearTimeout(g.timer);
    if (g.kind === 'tool') {
      if (cancelled) this.tool.cancel();
      else this.tool.up(this._evt(e));
    } else if (g.kind === 'tap' && !g.moved && !g.long && !cancelled && this.tool && this.tool.tap) {
      this.tool.tap(g.ev0);
    }
  }

  _cancelGesture() {
    const g = this.gesture;
    if (g) clearTimeout(g.timer);
    if (g && g.kind === 'tool' && this.tool) this.tool.cancel();
    this.gesture = null;
  }

  resetGesture() {
    this._cancelGesture();
    this.requestRedraw();
  }
}

// ---- 描画ヘルパー ----

function pad(b, m) {
  return { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
}

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
  // crop=true: 書いた部分だけを拡大して表示（サムネイル用）
  let bx = 0, by = 0, bw = hw.width, bh = hw.height;
  if (crop) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of hw.strokes) for (const [px, py] of s.points) {
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    if (x0 <= x1) {
      const p = 8;
      const minSide = Math.max(hw.width, hw.height) / 4; // 小さな点を過剰に拡大しない
      bw = Math.max(x1 - x0 + p * 2, minSide);
      bh = Math.max(y1 - y0 + p * 2, minSide * (h / w));
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
  r = Math.max(0, Math.min(r, w / 2, h / 2));
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

/** 改行と幅で折り返す（日本語は1文字単位） */
export function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const ch of para) {
      if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}
