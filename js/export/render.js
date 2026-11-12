// 出力用の画像を作る（画面に出さないキャンバスで描画）

import { Viewer, drawHandwriting } from '../viewer.js';
import { loadImage } from '../drawing-source.js';
import * as db from '../db.js';

// iOS の Safari は 1枚のキャンバスが約1670万画素まで
export const MAX_CANVAS_PIXELS = 12e6;

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の作成に失敗しました'))), type, quality);
  });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function releaseCanvas(c) {
  c.width = 0;
  c.height = 0;
}

/**
 * 図面1ページ分の書き込み（写真ピン・メモ番号・手書き・寸法・部屋）を透明画像に描く。
 * 何も描かれていない余白は切り落とす。
 * pxPerUnit: 図面座標1単位あたりの画素数 / ui: ピン等の倍率
 * 戻り値: { blob, x, y, w, h }（画素。図面左上が原点）または null
 */
export async function renderOverlay(project, drawing, pageIndex, { pxPerUnit, ui, layers }) {
  const page = drawing.pages[pageIndex];
  const v = new Viewer(null, { memoStyle: 'tag' });
  v.page = page;
  v.drawingId = drawing.id;
  v.pageIndex = pageIndex;
  v.view = { scale: pxPerUnit, ox: 0, oy: 0 };
  v.ui = ui;
  v.layers = layers;
  v.objectSource = () => project.objects.filter((o) => o.drawingId === drawing.id && o.page === pageIndex);
  v.roomSource = () => project.rooms.filter((r) => r.drawingId === drawing.id && r.page === pageIndex);
  if (!v.pageObjects().length && !v.pageRooms().length) return null;

  const W = Math.ceil(page.width * pxPerUnit), H = Math.ceil(page.height * pxPerUnit);
  const c = v.canvas;
  c.width = W;
  c.height = H;
  v._drawObjects(v.ctx);

  // 描かれた範囲を縮小画像で調べて切り出す
  const step = 8;
  const sw = Math.ceil(W / step), sh = Math.ceil(H / step);
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(c, 0, 0, sw, sh);
  const data = sctx.getImageData(0, 0, sw, sh).data;
  let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (data[(y * sw + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  releaseCanvas(small);
  if (x1 < 0) { releaseCanvas(c); return null; }
  const rx = Math.max(0, (x0 - 1) * step), ry = Math.max(0, (y0 - 1) * step);
  const rw = Math.min(W, (x1 + 2) * step) - rx, rh = Math.min(H, (y1 + 2) * step) - ry;
  const crop = document.createElement('canvas');
  crop.width = rw;
  crop.height = rh;
  crop.getContext('2d').drawImage(c, rx, ry, rw, rh, 0, 0, rw, rh);
  releaseCanvas(c);
  const blob = await canvasToBlob(crop, 'image/png');
  releaseCanvas(crop);
  return { blob, x: rx, y: ry, w: rw, h: rh };
}

/**
 * 写真を JPEG にする。annotate=true なら書き込みを合成する。
 * longSide: 出力の長辺(px)
 */
export async function renderPhoto(project, photo, { longSide = 1200, annotate = false, quality = 0.85 } = {}) {
  const blob = await db.getBlob(project.id, photo.blobRef);
  if (!blob) return null;
  const img = await loadImage(blob);
  const W = img.naturalWidth, H = img.naturalHeight;
  const k = Math.min(1, longSide / Math.max(W, H));
  const v = new Viewer(null, { memoStyle: 'full', unitBase: 400 });
  v.page = { width: W, height: H };
  v.view = { scale: k, ox: 0, oy: 0 };
  const c = v.canvas;
  c.width = Math.round(W * k);
  c.height = Math.round(H * k);
  const ctx = v.ctx;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (annotate) {
    v.objectSource = () => photo.annotations || [];
    v._drawObjects(ctx);
  }
  const out = await canvasToBlob(c, 'image/jpeg', quality);
  const size = { width: c.width, height: c.height };
  releaseCanvas(c);
  return { blob: out, ...size };
}

/** メモの手書きを白背景の PNG にする */
export async function renderHandwriting(hw, color, w = 240, h = 160) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  drawHandwriting(ctx, hw, color, 4, 4, w - 8, h - 8, { crop: true });
  const blob = await canvasToBlob(c, 'image/png');
  releaseCanvas(c);
  return blob;
}
