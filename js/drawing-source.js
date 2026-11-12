// 図面（PDF・画像）の読み込みとレンダリング

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const base = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';

const PDF_OPTS = {
  cMapUrl: base + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: base + 'standard_fonts/',
  isEvalSupported: false,
};

// 全体表示用ビットマップの長辺(px)。拡大時は表示範囲だけ高解像度で描き直す
const BASE_LONG_SIDE = 2400;
// 画像図面の最大辺(px)。これより大きい画像は縮小して保持する
const IMAGE_MAX_SIDE = 4096;

export function detectType(file) {
  const name = (file.name || '').toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (/^image\/(jpeg|png)$/.test(file.type) || /\.(jpe?g|png)$/.test(name)) return 'image';
  return null;
}

/** ファイルを開いてページ情報を返す（読み込み時に使用） */
export async function analyze(blob, type) {
  const src = await openSource(blob, type);
  const pages = src.pages.map((p) => ({ width: p.width, height: p.height }));
  src.destroy();
  return pages;
}

export async function openSource(blob, type) {
  if (type === 'pdf') return PdfSource.open(blob);
  return ImageSource.open(blob);
}

class PdfSource {
  static async open(blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data, ...PDF_OPTS }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ page, width: vp.width, height: vp.height });
    }
    const s = new PdfSource();
    s.doc = doc;
    s.pages = pages;
    s.baseCache = new Map();
    s.supportsDetail = true;
    return s;
  }

  async getBase(index) {
    if (this.baseCache.has(index)) return this.baseCache.get(index);
    const p = this.pages[index];
    const scale = BASE_LONG_SIDE / Math.max(p.width, p.height);
    const vp = p.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.page.render({ canvasContext: ctx, viewport: vp }).promise;
    const result = { image: canvas, width: p.width, height: p.height };
    this.baseCache.clear(); // メモリ節約のため1ページ分だけ保持
    this.baseCache.set(index, result);
    return result;
  }

  /**
   * 指定範囲（図面座標 rect={x,y,w,h}）を倍率 scale(px/単位) で描く。
   * 戻り値の render.cancel() で中断できる。
   */
  renderRegion(index, scale, rect) {
    const p = this.pages[index];
    const vp = p.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(rect.w * scale));
    canvas.height = Math.max(1, Math.ceil(rect.h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = p.page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: [1, 0, 0, 1, -rect.x * scale, -rect.y * scale],
    });
    return {
      promise: task.promise.then(() => canvas),
      cancel: () => task.cancel(),
    };
  }

  destroy() {
    this.baseCache.clear();
    this.doc.destroy();
  }
}

class ImageSource {
  static async open(blob) {
    const img = await loadImage(blob);
    const w = img.naturalWidth, h = img.naturalHeight;
    let image = img;
    const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
    if (k < 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      image = c;
    }
    const s = new ImageSource();
    s.pages = [{ width: w, height: h }];
    s.image = image;
    s.supportsDetail = false;
    return s;
  }

  async getBase() {
    return { image: this.image, width: this.pages[0].width, height: this.pages[0].height };
  }

  destroy() {
    this.image = null;
  }
}

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}
