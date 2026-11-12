// ピン入り図面 PDF の出力
// 図面 PDF のページはベクターのまま埋め込み、書き込みは透明画像にして重ねる

import * as db from '../db.js';
import { loadPdfLib } from './lazy.js';
import { renderOverlay, MAX_CANVAS_PIXELS } from './render.js';

const A3 = [1190.55, 841.89];          // 横（pt）
const TARGET_DPI = 300;
const PIN_MM_ON_A3 = 4;                // A3 でのピンの高さ
const PIN_PX = 22;                     // 画面でのピンの高さ(px)
const IMAGE_MARGIN = 20;               // 画像図面の余白(pt)

/**
 * pages: [{ drawing, pageIndex }]
 * layers: 表示切替の設定
 */
export async function exportDrawingsPdf(project, pages, layers, onProgress = () => {}) {
  const { PDFDocument, degrees } = await loadPdfLib();
  const out = await PDFDocument.create();
  out.setTitle(project.name);
  out.setCreator('現地調査');
  out.setProducer('現地調査（pdf-lib）');

  const srcDocs = new Map();
  const getSrc = async (drawing) => {
    if (srcDocs.has(drawing.id)) return srcDocs.get(drawing.id);
    const blob = await db.getBlob(project.id, drawing.blobRef);
    if (!blob) throw new Error(`図面「${drawing.name}」のファイルが見つかりません`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const src = drawing.type === 'pdf'
      ? { pdf: await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }) }
      : { bytes, mime: blob.type };
    srcDocs.set(drawing.id, src);
    return src;
  };

  let n = 0;
  for (const { drawing, pageIndex } of pages) {
    onProgress(n / pages.length, `${drawing.name} ${pageIndex + 1}ページ`);
    const src = await getSrc(drawing);
    const pg = drawing.pages[pageIndex];
    let page, PW, PH, ox, oy, kpt;

    if (drawing.type === 'pdf') {
      const sp = src.pdf.getPage(pageIndex);
      const crop = sp.getCropBox();
      const emb = await out.embedPage(sp, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height });
      const rot = (((sp.getRotation().angle || 0) % 360) + 360) % 360;
      const W0 = emb.width, H0 = emb.height;
      [PW, PH] = rot % 180 ? [H0, W0] : [W0, H0];
      page = out.addPage([PW, PH]);
      // 元ページの /Rotate を反映して、画面と同じ向きに置く
      if (rot === 90) page.drawPage(emb, { x: 0, y: W0, rotate: degrees(-90) });
      else if (rot === 180) page.drawPage(emb, { x: W0, y: H0, rotate: degrees(180) });
      else if (rot === 270) page.drawPage(emb, { x: H0, y: 0, rotate: degrees(90) });
      else page.drawPage(emb, { x: 0, y: 0 });
      // 図面座標（pdf.js の表示座標・pt）と出力ページの対応
      kpt = PW / pg.width;
      ox = 0;
      oy = 0;
    } else {
      // 画像図面：A3 に縦横比を保って収める
      [PW, PH] = pg.width >= pg.height ? A3 : [A3[1], A3[0]];
      page = out.addPage([PW, PH]);
      kpt = Math.min((PW - IMAGE_MARGIN * 2) / pg.width, (PH - IMAGE_MARGIN * 2) / pg.height);
      ox = (PW - pg.width * kpt) / 2;
      oy = (PH - pg.height * kpt) / 2;
      const img = src.mime === 'image/png' || /\.png$/i.test(drawing.fileName || '')
        ? await out.embedPng(src.bytes) : await out.embedJpg(src.bytes);
      page.drawImage(img, { x: ox, y: PH - oy - pg.height * kpt, width: pg.width * kpt, height: pg.height * kpt });
    }

    // 書き込みを重ねる
    const areaPt = pg.width * kpt * pg.height * kpt;
    const pxPerPt = Math.min(TARGET_DPI / 72, Math.sqrt(MAX_CANVAS_PIXELS / areaPt));
    const pxPerUnit = pxPerPt * kpt;
    const pinPt = (PIN_MM_ON_A3 / 25.4) * 72 * (Math.max(PW, PH) / A3[0]);
    const ui = (pinPt * pxPerPt) / PIN_PX;
    const ov = await renderOverlay(project, drawing, pageIndex, { pxPerUnit, ui, layers });
    if (ov) {
      const png = await out.embedPng(new Uint8Array(await ov.blob.arrayBuffer()));
      const w = ov.w / pxPerPt, h = ov.h / pxPerPt;
      const x = ox + ov.x / pxPerPt;
      const yTop = oy + ov.y / pxPerPt;
      page.drawImage(png, { x, y: PH - yTop - h, width: w, height: h });
    }
    n++;
    // UI を固まらせない
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress(1, '保存しています');
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
