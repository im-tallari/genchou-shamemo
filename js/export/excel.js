// Excel 出力：写真台帳・メモ一覧（暫定様式）

import { loadExcelJS } from './lazy.js';
import { renderPhoto, renderHandwriting, blobToDataURL } from './render.js';
import { pointInPolygon } from '../model.js';
import { formatDate } from '../ui/dialogs.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FONT = { name: 'Yu Gothic', size: 10 };
const EMU_PER_PX = 9525;
const thin = { style: 'thin', color: { argb: 'FF999999' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

// Excel の列幅（文字数）→ 画素の目安
const colPx = (w) => Math.floor(w * 7 + 5);
// 行の高さ（pt）→ 画素
const rowPx = (pt) => Math.floor((pt * 96) / 72);

function styleHeader(row) {
  row.height = 22;
  row.eachCell((c) => {
    c.font = { ...FONT, bold: true };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAED' } };
    c.border = BORDER;
  });
}

function styleBody(row, wrapCols = []) {
  row.eachCell({ includeEmpty: true }, (c, col) => {
    c.font = FONT;
    c.alignment = { vertical: 'middle', horizontal: wrapCols.includes(col) ? 'left' : 'center', wrapText: true };
    c.border = BORDER;
  });
}

function setupPrint(ws) {
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    printTitlesRow: '1:1',
  };
  ws.headerFooter.oddFooter = '&C&P / &N';
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** 画像をセルの中央に、縦横比を保って収める */
function placeImage(wb, ws, dataUrl, size, col0, row0, cellW, cellH, pad = 6) {
  const id = wb.addImage({ base64: dataUrl, extension: dataUrl.startsWith('data:image/png') ? 'png' : 'jpeg' });
  const k = Math.min((cellW - pad * 2) / size.width, (cellH - pad * 2) / size.height);
  const w = Math.round(size.width * k), h = Math.round(size.height * k);
  ws.addImage(id, {
    tl: {
      nativeCol: col0, nativeColOff: Math.round(((cellW - w) / 2) * EMU_PER_PX),
      nativeRow: row0, nativeRowOff: Math.round(((cellH - h) / 2) * EMU_PER_PX),
    },
    ext: { width: w, height: h },
    editAs: 'oneCell',
  });
}

async function toBlob(wb) {
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_MIME });
}

function newWorkbook(ExcelJS, project) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '現地調査';
  wb.created = new Date();
  wb.title = project.name;
  return wb;
}

export function sortByNumber(list) {
  return [...list].sort((a, b) => String(a.number).localeCompare(String(b.number), 'ja', { numeric: true }));
}

/**
 * 写真台帳
 * composite=true なら、書き込みのある写真は書き込みを合成した画像を貼る
 */
export async function exportPhotoLedger(project, { composite = true } = {}, onProgress = () => {}) {
  const ExcelJS = await loadExcelJS();
  const wb = newWorkbook(ExcelJS, project);
  const ws = wb.addWorksheet('写真台帳');
  const cols = [
    { header: '番号', width: 13 },
    { header: '部屋名', width: 16 },
    { header: '書き込み', width: 8 },
    { header: '写真', width: 44 },
    { header: '撮影日時', width: 16 },
    { header: '図面名', width: 18 },
  ];
  ws.columns = cols.map((c) => ({ header: c.header, width: c.width }));
  styleHeader(ws.getRow(1));
  setupPrint(ws);

  const ROW_PT = 175;
  const drawingName = new Map(project.drawings.map((d) => [d.id, d.name]));
  const photos = sortByNumber(project.objects.filter((o) => o.type === 'photo'));
  let i = 0;
  for (const p of photos) {
    onProgress(i / photos.length, `写真 ${p.number}`);
    const hasAnn = !!(p.annotations && p.annotations.length);
    const row = ws.addRow([
      p.number,
      p.roomName || '',
      hasAnn ? '有' : '無',
      '',
      formatDate(p.takenAt),
      drawingName.get(p.drawingId) || '',
    ]);
    row.height = ROW_PT;
    styleBody(row, [2, 6]);
    const img = await renderPhoto(project, p, { longSide: 1200, annotate: composite && hasAnn });
    if (img) {
      const dataUrl = await blobToDataURL(img.blob);
      placeImage(wb, ws, dataUrl, img, 3, row.number - 1, colPx(cols[3].width), rowPx(ROW_PT));
    } else {
      row.getCell(4).value = '（画像なし）';
    }
    i++;
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress(1, '保存しています');
  return toBlob(wb);
}

/** メモの位置にある部屋の名前 */
function roomNameAt(project, m) {
  const rooms = project.rooms.filter((r) => r.drawingId === m.drawingId && r.page === m.page);
  for (let i = rooms.length - 1; i >= 0; i--) {
    if (pointInPolygon(m.x, m.y, rooms[i].polygon)) return rooms[i].name || '';
  }
  return '';
}

/**
 * メモ一覧
 * memos: 出力するメモ（省略時はすべて）
 */
export async function exportMemoList(project, memos = null, onProgress = () => {}) {
  const ExcelJS = await loadExcelJS();
  const wb = newWorkbook(ExcelJS, project);
  const ws = wb.addWorksheet('メモ一覧');
  const cols = [
    { header: '番号', width: 8 },
    { header: '図面名', width: 16 },
    { header: 'ページ', width: 6 },
    { header: '部屋名', width: 14 },
    { header: '本文', width: 40 },
    { header: '手書き', width: 24 },
  ];
  ws.columns = cols.map((c) => ({ header: c.header, width: c.width }));
  styleHeader(ws.getRow(1));
  setupPrint(ws);

  const drawingName = new Map(project.drawings.map((d) => [d.id, d.name]));
  const list = sortByNumber(memos || project.objects.filter((o) => o.type === 'memo'));
  let i = 0;
  for (const m of list) {
    onProgress(i / list.length, `メモ ${m.number}`);
    const hasHw = !!(m.handwriting && m.handwriting.strokes && m.handwriting.strokes.length);
    const row = ws.addRow([
      m.number || '',
      drawingName.get(m.drawingId) || '',
      (m.page || 0) + 1,
      roomNameAt(project, m),
      m.text || '',
      '',
    ]);
    const lines = (m.text || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / 22)), 0);
    const HW_PT = 90;
    row.height = Math.max(hasHw ? HW_PT : 20, lines * 14 + 8);
    styleBody(row, [2, 4, 5]);
    row.getCell(5).alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    if (hasHw) {
      const blob = await renderHandwriting(m.handwriting, m.color, 240, 160);
      placeImage(wb, ws, await blobToDataURL(blob), { width: 240, height: 160 }, 5, row.number - 1,
        colPx(cols[5].width), rowPx(row.height), 4);
    }
    i++;
  }
  onProgress(1, '保存しています');
  return toBlob(wb);
}
