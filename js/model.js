// データモデルと幾何ユーティリティ

export const FORMAT_VERSION = 1;

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createProject(name, photoNumbering = 'sequential') {
  const now = Date.now();
  return {
    id: uid(),
    formatVersion: FORMAT_VERSION,
    name: name || '無題のプロジェクト',
    createdAt: now,
    updatedAt: now,
    settings: { photoNumbering },
    // 写真番号の採番カウンタ。元に戻すの対象外（番号は再利用しない）
    counters: { sequential: 0, daily: {} },
    drawings: [],
    rooms: [],
    objects: [],
  };
}

/** 古い形式・欠けたフィールドを補う */
export function normalizeProject(p) {
  p.settings = { photoNumbering: 'sequential', ...(p.settings || {}) };
  p.counters = p.counters || { sequential: 0, daily: {} };
  p.counters.daily = p.counters.daily || {};
  p.drawings = p.drawings || [];
  p.rooms = p.rooms || [];
  p.objects = p.objects || [];
  p.formatVersion = FORMAT_VERSION;
  return p;
}

export function ymd(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** 次の写真番号を採番する（カウンタを進める） */
export function nextPhotoNumber(project, date = new Date()) {
  if (project.settings.photoNumbering === 'daily') {
    const key = ymd(date);
    const n = (project.counters.daily[key] || 0) + 1;
    project.counters.daily[key] = n;
    return `${key}-${String(n).padStart(3, '0')}`;
  }
  const n = (project.counters.sequential || 0) + 1;
  project.counters.sequential = n;
  return String(n).padStart(3, '0');
}

/** 画像・PDFのページの「単位スケール」: A3長辺(1190.55pt)を基準にした比 */
export function unitScale(page) {
  return Math.max(page.width, page.height) / 1190.55;
}

// ---- 幾何 ----

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x0, y0] = poly[j];
    const [x1, y1] = poly[i];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

/** 線分 AB と CD の最短距離 */
export function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distToSegment(ax, ay, cx, cy, dx, dy),
    distToSegment(bx, by, cx, cy, dx, dy),
    distToSegment(cx, cy, ax, ay, bx, by),
    distToSegment(dx, dy, ax, ay, bx, by)
  );
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** ストロークがパス(eraser)に radius 以内で触れているか（図面座標） */
export function strokeHitsPath(stroke, path, radius) {
  const pts = stroke.points;
  const r = radius + (stroke.width || 0) / 2;
  if (pts.length === 1) {
    const [x, y] = pts[0];
    for (let j = 0; j < path.length; j++) {
      const a = path[Math.max(0, j - 1)], b = path[j];
      if (distToSegment(x, y, a[0], a[1], b[0], b[1]) <= r) return true;
    }
    return false;
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    for (let j = 0; j < path.length; j++) {
      const c = path[Math.max(0, j - 1)], d = path[j];
      if (segSegDist(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]) <= r) return true;
    }
  }
  return false;
}

export const PRESET_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#212121'];
// ペンの太さ（A3 図面上の pt 換算）
export const PEN_WIDTHS = [
  { label: '細', value: 0.8 },
  { label: '中', value: 1.8 },
  { label: '太', value: 3.5 },
  { label: '極太', value: 7 },
];
// 蛍光ペンの太さと不透明度
export const HL_WIDTHS = [
  { label: '細', value: 4 },
  { label: '中', value: 8 },
  { label: '太', value: 14 },
  { label: '極太', value: 22 },
];
export const HL_ALPHA = 0.35;

// ---- 寸法 ----
// Dimension { id, type:'dim', drawingId, page, shape, p1, p2, fields, values, color }
//   shape : 'line'（L）| 'rect'（W・D）| 'circle'（φ）| 'point'（H のみ）
//   fields: 使う項目 ['L'|'W'|'D'|'H'|'phi', ...]
//   values: { L?, W?, D?, H?, phi? }（mm、未入力は空文字）
//   rect は p1,p2 が対角、circle は p1 が中心で p2 が円周上の点
export const DIM_FIELDS = ['L', 'W', 'D', 'H', 'phi'];
export const DIM_LABEL = { L: 'L', W: 'W', D: 'D', H: 'H', phi: 'φ' };
// 寸法文字の高さ（A3図面上の pt。約2.5mm）
export const DIM_TEXT_PT = 7.1;

export function dimShape(fields) {
  if (fields.includes('L')) return 'line';
  if (fields.includes('W') || fields.includes('D')) return 'rect';
  if (fields.includes('phi')) return 'circle';
  return 'point';
}

/** 項目のオン／オフを切り替える。L・W/D・φ は排他、H はどれとも併用可 */
export function toggleDimField(fields, f) {
  const set = new Set(fields);
  if (set.has(f)) {
    set.delete(f);
  } else {
    set.add(f);
    const group = { L: 'line', W: 'rect', D: 'rect', phi: 'circle' }[f];
    if (group) {
      for (const g of ['L', 'W', 'D', 'phi']) {
        if (g !== f && ({ L: 'line', W: 'rect', D: 'rect', phi: 'circle' }[g]) !== group) set.delete(g);
      }
    }
  }
  if (!set.size) return fields; // 全部オフにはしない
  return DIM_FIELDS.filter((x) => set.has(x));
}

/** 寸法の点（範囲選択・移動用） */
export function dimPoints(d) {
  const [x1, y1] = d.p1, [x2, y2] = d.p2 || d.p1;
  if (d.shape === 'rect') return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  if (d.shape === 'circle') {
    const r = Math.hypot(x2 - x1, y2 - y1);
    return [[x1 - r, y1], [x1 + r, y1], [x1, y1 - r], [x1, y1 + r]];
  }
  if (d.shape === 'point') return [[x1, y1]];
  return [[x1, y1], [x2, y2]];
}

/** オブジェクトの代表点（範囲選択の判定用） */
export function objectPoints(o) {
  if (o.type === 'stroke') return o.points;
  if (o.type === 'dim') return dimPoints(o);
  if (o.polygon) return o.polygon;
  return [[o.x, o.y]];
}

/** オブジェクトを平行移動（その場で書き換え） */
export function translateObject(o, dx, dy) {
  const mv = (p) => [Math.round((p[0] + dx) * 100) / 100, Math.round((p[1] + dy) * 100) / 100];
  if (o.type === 'stroke') o.points = o.points.map(mv);
  else if (o.type === 'dim') { o.p1 = mv(o.p1); if (o.p2) o.p2 = mv(o.p2); }
  else if (o.polygon) o.polygon = o.polygon.map(mv);
  else { [o.x, o.y] = mv([o.x, o.y]); }
}

/** 寸法の表示文字列 */
export function dimText(d, f) {
  const v = d.values && d.values[f];
  return `${f === 'L' ? '' : DIM_LABEL[f]}${v === '' || v == null ? '?' : v}`;
}
