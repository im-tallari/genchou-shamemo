// 出力ダイアログ：図面PDF・写真台帳・メモ一覧

import { h, modal, busy, toast, alertDialog } from './dialogs.js';
import { downloadBlob } from '../zip.js';
import { ymd } from '../model.js';
import { exportDrawingsPdf } from '../export/pdf.js';
import { exportPhotoLedger, exportMemoList } from '../export/excel.js';

function safeName(s) {
  return (s || 'project').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

function fileName(project, kind, ext) {
  return `${safeName(project.name)}_${kind}_${ymd()}.${ext}`;
}

function sizeText(b) {
  return b.size >= 1024 * 1024 ? `${(b.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b.size / 1024))} KB`;
}

/** できたファイルを保存・共有する */
export async function deliverFiles(files) {
  const asFiles = files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.canShare({ files: asFiles })); } catch { /* 非対応 */ }
  const rows = files.map((f) => h('div', { class: 'file-row' },
    h('div', { class: 'file-name' }, f.name, h('span', { class: 'muted small' }, `　${sizeText(f.blob)}`)),
    h('button', { class: 'btn small', onclick: () => downloadBlob(f.blob, f.name) }, '保存')));
  await modal({
    title: '出力しました',
    className: 'modal-narrow',
    body: h('div', { class: 'form' }, ...rows,
      files.length > 1 ? h('div', { class: 'muted small' }, 'ファイルごとに「保存」を押してください。') : null),
    buttons: [
      canShare ? {
        label: files.length > 1 ? 'まとめて共有…' : '共有…',
        onClick: async (close) => {
          try { await navigator.share({ files: asFiles, title: files[0].name }); close(); } catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした'); }
        },
      } : null,
      files.length === 1
        ? { label: 'ファイルに保存', kind: 'primary', onClick: (close) => { downloadBlob(files[0].blob, files[0].name); close(); } }
        : { label: '閉じる', kind: 'primary', value: null },
    ].filter(Boolean),
  });
}

async function run(title, task) {
  const b = busy(title);
  try {
    return await task((ratio, label) => b.set(`${title} ${Math.round(ratio * 100)}%${label ? `\n${label}` : ''}`));
  } catch (e) {
    console.error(e);
    b.close();
    await alertDialog(e.message || String(e), '出力できませんでした');
    return null;
  } finally {
    b.close();
  }
}

/** 図面PDF（＋メモ一覧） */
export async function outputPdfDialog(project, layers, current) {
  if (!project.drawings.length) { alertDialog('図面がありません'); return; }
  const checks = [];
  const groups = project.drawings.map((d) => {
    const items = d.pages.map((_, i) => {
      const cb = h('input', { type: 'checkbox', checked: true });
      checks.push({ cb, drawing: d, pageIndex: i });
      return h('label', { class: 'check-row' }, cb,
        h('span', {}, d.pages.length > 1 ? `${i + 1}ページ` : d.name),
        current && current.drawingId === d.id && current.pageIndex === i ? h('span', { class: 'muted small' }, '（表示中）') : null);
    });
    return d.pages.length > 1
      ? h('div', { class: 'check-group' }, h('div', { class: 'check-group-title' }, d.name), ...items)
      : items[0];
  });
  const memoOn = layers.memo !== false;
  const memoCb = h('input', { type: 'checkbox', checked: memoOn, disabled: !memoOn });
  const hidden = ['photo', 'memo', 'stroke', 'dim', 'room'].filter((k) => layers[k] === false);
  const names = { photo: '写真ピン', memo: 'メモ', stroke: '手書き', dim: '寸法', room: '部屋範囲' };

  const v = await modal({
    title: '図面PDFを出力',
    body: h('div', { class: 'form' },
      h('div', { class: 'label' }, '出力するページ'),
      h('div', { class: 'check-list' }, ...groups),
      h('div', { class: 'check-tools' },
        h('button', { class: 'link', type: 'button', onclick: () => checks.forEach((c) => { c.cb.checked = true; }) }, 'すべて選択'),
        h('button', { class: 'link', type: 'button', onclick: () => checks.forEach((c) => { c.cb.checked = false; }) }, 'すべて解除')),
      h('label', { class: 'check-row' }, memoCb, h('span', {}, 'メモ一覧（Excel）も出力する')),
      hidden.length
        ? h('div', { class: 'warn small' }, `表示切替で非表示：${hidden.map((k) => names[k]).join('・')}（出力されません）`)
        : null),
    buttons: [
      { label: 'キャンセル', value: null },
      {
        label: '出力', kind: 'primary',
        onClick: (close) => {
          if (!checks.some((c) => c.cb.checked)) { toast('ページを1つ以上選んでください'); return; }
          close('ok');
        },
      },
    ],
  });
  if (v !== 'ok') return;
  const pages = checks.filter((c) => c.cb.checked).map(({ drawing, pageIndex }) => ({ drawing, pageIndex }));
  const withMemo = memoCb.checked && !memoCb.disabled;

  const files = await run('図面PDFを作成中…', async (progress) => {
    const out = [];
    const pdf = await exportDrawingsPdf(project, pages, layers, (r, l) => progress(withMemo ? r * 0.85 : r, l));
    out.push({ blob: pdf, name: fileName(project, '図面', 'pdf') });
    if (withMemo) {
      const keys = new Set(pages.map((p) => `${p.drawing.id}:${p.pageIndex}`));
      const memos = project.objects.filter((o) => o.type === 'memo' && keys.has(`${o.drawingId}:${o.page}`));
      if (memos.length) {
        const xlsx = await exportMemoList(project, memos, (r) => progress(0.85 + r * 0.15, 'メモ一覧'));
        out.push({ blob: xlsx, name: fileName(project, 'メモ一覧', 'xlsx') });
      }
    }
    return out;
  });
  if (files) await deliverFiles(files);
}

/** 写真台帳 */
export async function outputLedgerDialog(project) {
  const photos = project.objects.filter((o) => o.type === 'photo');
  if (!photos.length) { alertDialog('写真がありません'); return; }
  const annotated = photos.filter((p) => p.annotations && p.annotations.length).length;
  let composite = true;
  if (annotated) {
    const rComp = h('input', { type: 'radio', name: 'ledger-img', checked: true });
    const rOrig = h('input', { type: 'radio', name: 'ledger-img' });
    const v = await modal({
      title: '写真台帳（Excel）を出力',
      className: 'modal-narrow',
      body: h('div', { class: 'form' },
        h('div', {}, `写真 ${photos.length}枚（うち書き込みあり ${annotated}枚）`),
        h('div', { class: 'label' }, '書き込みのある写真に貼る画像'),
        h('label', { class: 'check-row' }, rComp, h('span', {}, '書き込みを合成した画像')),
        h('label', { class: 'check-row' }, rOrig, h('span', {}, '元画像'))),
      buttons: [{ label: 'キャンセル', value: null }, { label: '出力', kind: 'primary', value: 'ok' }],
    });
    if (v !== 'ok') return;
    composite = rComp.checked;
  }
  const blob = await run('写真台帳を作成中…', (progress) => exportPhotoLedger(project, { composite }, progress));
  if (blob) await deliverFiles([{ blob, name: fileName(project, '写真台帳', 'xlsx') }]);
}

/** メモ一覧だけ */
export async function outputMemoListDialog(project) {
  const memos = project.objects.filter((o) => o.type === 'memo');
  if (!memos.length) { alertDialog('メモがありません'); return; }
  const blob = await run('メモ一覧を作成中…', (progress) => exportMemoList(project, memos, progress));
  if (blob) await deliverFiles([{ blob, name: fileName(project, 'メモ一覧', 'xlsx') }]);
}
