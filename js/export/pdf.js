// ピン入り図面 PDF の出力
// 図面 PDF のページはベクターのまま埋め込み、書き込みは透明画像にして重ねる

import * as db from '../db.js';
import { APP_NAME } from '../version.js';
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
 * memoStyle: 図面上のメモの表示（'tag' 番号のみ / 'bubble' 番号＋1行目 / 'bubbleFull' 番号＋全文）
 * embedComments: メモを PDF のコメント（付箋）として埋め込む
 */
export async function exportDrawingsPdf(project, pages, layers, onProgress = () => {}, { memoStyle = 'tag', embedComments = false } = {}) {
  const PDFLib = await loadPdfLib();
  const { PDFDocument, degrees } = PDFLib;
  const out = await PDFDocument.create();
  out.setTitle(project.name);
  out.setCreator(APP_NAME);
  out.setProducer(`${APP_NAME}（pdf-lib）`);

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
    const ov = await renderOverlay(project, drawing, pageIndex, { pxPerUnit, ui, layers, memoStyle });
    if (ov) {
      const png = await out.embedPng(new Uint8Array(await ov.blob.arrayBuffer()));
      const w = ov.w / pxPerPt, h = ov.h / pxPerPt;
      const x = ox + ov.x / pxPerPt;
      const yTop = oy + ov.y / pxPerPt;
      page.drawImage(png, { x, y: PH - yTop - h, width: w, height: h });
    }
    if (embedComments && layers.memo !== false) {
      const memos = project.objects.filter((o) => o.type === 'memo' && o.drawingId === drawing.id && o.page === pageIndex);
      for (const m of memos) addMemoComment(PDFLib, out, page, m, { PH, ox, oy, kpt, uiPt: ui / pxPerPt });
    }
    n++;
    // UI を固まらせない
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress(1, '保存しています');
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

const AUTHOR = '現調写メモ';
const COMMENT_SIZE = 16; // 付箋アイコンの大きさ(pt)

let measureCtx = null;
function tagWidth(text) {
  // viewer.js の番号札（13px・左右の余白6px）と同じ計算
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = '13px system-ui, sans-serif';
  return Math.max(16, measureCtx.measureText(text).width) + 12;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 0.85, 0.2];
}

function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** メモを付箋コメント（/Text 注釈）として、番号札のすぐ右に置く */
function addMemoComment(PDFLib, doc, page, m, { PH, ox, oy, kpt, uiPt }) {
  const { PDFHexString, PDFString, PDFName } = PDFLib;
  const hasHw = !!(m.handwriting && m.handwriting.strokes && m.handwriting.strokes.length);
  const lines = [m.number || 'メモ'];
  if (m.text) lines.push(m.text);
  if (hasHw) lines.push('（手書きあり：メモ一覧を参照）');
  // 番号札の位置（viewer.js の吹き出しと同じ配置。単位は ui の画素 → pt）
  const ax = ox + m.x * kpt, ayTop = oy + m.y * kpt;
  const tagH = 16 + 12;
  const left = ax + (4 + tagWidth(m.number || '') + 3) * uiPt;
  const top = ayTop - (tagH + 10) * uiPt;
  const x0 = Math.min(left, page.getWidth() - COMMENT_SIZE);
  const y1 = Math.min(PH, Math.max(COMMENT_SIZE, PH - top));
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [x0, y1 - COMMENT_SIZE, x0 + COMMENT_SIZE, y1],
    Contents: PDFHexString.fromText(lines.join('\n')),
    T: PDFHexString.fromText(AUTHOR),
    Subj: PDFHexString.fromText(m.number || 'メモ'),
    NM: PDFString.of(`genchou-${m.id}`),
    Name: PDFName.of('Comment'),
    C: hexToRgb(m.color),
    F: 24, // 拡大・回転しても大きさを変えない（印刷はしない）
    Open: false,
    M: PDFString.of(pdfDate()),
    CreationDate: PDFString.of(pdfDate()),
  });
  page.node.addAnnot(doc.context.register(annot));
}
