// 出力ダイアログ：図面PDF・写真台帳・メモ一覧

import { h, modal, busy, toast, alertDialog } from './dialogs.js';
import { downloadBlob } from '../zip.js';
import { ymd } from '../model.js';
import { exportDrawingsPdf } from '../export/pdf.js';
import { exportPhotoLedger, exportMemoList } from '../export/excel.js';

const PDF_OPTS_KEY = 'pdf-output-options';

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
  // 前回の選択を覚えておく
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PDF_OPTS_KEY) || '{}'); } catch { /* 既定値 */ }

  const memoOn = layers.memo !== false;
  const memoStyles = [['tag', '番号のみ'], ['bubble', '番号＋1行目（画面と同じ）'], ['bubbleFull', '番号＋全文']];
  let memoStyle = memoStyles.some(([k]) => k === saved.memoStyle) ? saved.memoStyle : 'tag';
  const commentCb = h('input', { type: 'checkbox', checked: saved.embedComments !== false, disabled: !memoOn });
  const commentRow = h('div', { class: 'sub-options' },
    h('label', { class: 'check-row' }, commentCb, h('span', {}, 'メモを PDF のコメントとして埋め込む')),
    h('div', { class: 'muted small' }, '番号の横に付箋が付き、PDF アプリで本文を読めます（手書きは入りません）'));
  const syncComment = () => { commentRow.hidden = memoStyle !== 'tag' || !memoOn; };
  const memoRadios = memoStyles.map(([k, label]) => {
    const r = h('input', { type: 'radio', name: 'pdf-memo-style', checked: k === memoStyle, disabled: !memoOn });
    r.addEventListener('change', () => { if (r.checked) { memoStyle = k; syncComment(); } });
    return h('label', { class: 'check-row' }, r, h('span', {}, label));
  });
  syncComment();

  const memoCb = h('input', { type: 'checkbox', checked: memoOn && saved.withMemo !== false, disabled: !memoOn });
  const photos = project.objects.filter((o) => o.type === 'photo');
  const ledgerCb = h('input', { type: 'checkbox', checked: !!photos.length && !!saved.withLedger, disabled: !photos.length });
  const annotated = photos.some((p) => p.annotations && p.annotations.length);
  const rComp = h('input', { type: 'radio', name: 'pdf-ledger-img', checked: saved.composite !== false });
  const rOrig = h('input', { type: 'radio', name: 'pdf-ledger-img', checked: saved.composite === false });
  const ledgerImg = h('div', { class: 'sub-options', hidden: !annotated || !ledgerCb.checked },
    h('div', { class: 'muted small' }, '書き込みのある写真に貼る画像'),
    h('label', { class: 'check-row' }, rComp, h('span', {}, '書き込みを合成した画像')),
    h('label', { class: 'check-row' }, rOrig, h('span', {}, '元画像')));
  ledgerCb.addEventListener('change', () => { ledgerImg.hidden = !annotated || !ledgerCb.checked; });

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
      h('div', { class: 'label' }, '図面上のメモ'),
      memoRadios[0], commentRow, memoRadios[1], memoRadios[2],
      h('div', { class: 'label' }, '一緒に出力するもの'),
      h('label', { class: 'check-row' }, memoCb, h('span', {}, 'メモ一覧（Excel）')),
      h('label', { class: 'check-row' }, ledgerCb, h('span', {}, '写真台帳（Excel）')),
      ledgerImg,
      h('div', { class: 'muted small' }, 'メモ一覧・写真台帳には、選んだページにあるメモ・写真だけが入ります。'),
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
  const withLedger = ledgerCb.checked && !ledgerCb.disabled;
  const composite = rComp.checked;
  try {
    localStorage.setItem(PDF_OPTS_KEY, JSON.stringify({
      memoStyle, withMemo: memoOn ? memoCb.checked : saved.withMemo, withLedger, composite,
      embedComments: memoOn ? commentCb.checked : saved.embedComments,
    }));
  } catch { /* 保存できなくても出力は続ける */ }

  const keys = new Set(pages.map((p) => `${p.drawing.id}:${p.pageIndex}`));
  const onPages = (o) => keys.has(`${o.drawingId}:${o.page}`);
  // 進み具合の配分：PDF・メモ一覧・写真台帳
  const wPdf = 1, wMemo = withMemo ? 0.15 : 0, wLedger = withLedger ? 0.6 : 0;
  const total = wPdf + wMemo + wLedger;

  const files = await run('出力中…', async (progress) => {
    const out = [];
    const pdf = await exportDrawingsPdf(project, pages, layers, (r, l) => progress((r * wPdf) / total, l), {
      memoStyle: memoOn ? memoStyle : 'tag',
      embedComments: memoOn && memoStyle === 'tag' && commentCb.checked,
    });
    out.push({ blob: pdf, name: fileName(project, '図面', 'pdf') });
    if (withMemo) {
      const memos = project.objects.filter((o) => o.type === 'memo' && onPages(o));
      if (memos.length) {
        const xlsx = await exportMemoList(project, memos, (r) => progress((wPdf + r * wMemo) / total, 'メモ一覧'));
        out.push({ blob: xlsx, name: fileName(project, 'メモ一覧', 'xlsx') });
      }
    }
    if (withLedger) {
      const list = photos.filter(onPages);
      if (list.length) {
        const xlsx = await exportPhotoLedger(project, { composite, photos: list },
          (r, l) => progress((wPdf + wMemo + r * wLedger) / total, l));
        out.push({ blob: xlsx, name: fileName(project, '写真台帳', 'xlsx') });
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
