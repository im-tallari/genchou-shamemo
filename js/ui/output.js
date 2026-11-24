// 出力ダイアログ：図面PDF・写真台帳・メモ一覧

import { h, modal, busy, toast, alertDialog } from './dialogs.js';
import { downloadBlob } from '../zip.js';
import { ymd } from '../model.js';
import { exportDrawingsPdf } from '../export/pdf.js';
import { exportSurveyWorkbook } from '../export/excel.js';

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

/** 図面PDF（＋写真台帳・メモ一覧の Excel） */
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
  const photoOn = layers.photo !== false;
  const memoStyles = [['tag', '番号のみ'], ['bubble', '番号＋1行目（画面と同じ）'], ['bubbleFull', '番号＋全文']];
  let memoStyle = memoStyles.some(([k]) => k === saved.memoStyle) ? saved.memoStyle : 'tag';
  const memoRadios = memoStyles.map(([k, label]) => {
    const r = h('input', { type: 'radio', name: 'pdf-memo-style', checked: k === memoStyle, disabled: !memoOn });
    r.addEventListener('change', () => { if (r.checked) memoStyle = k; });
    return h('label', { class: 'check-row' }, r, h('span', {}, label));
  });

  // コメント（付箋）：図面のメモは「番号のみ」のとき、写真のメモは常に
  const commentCb = h('input', { type: 'checkbox', checked: saved.embedComments !== false, disabled: !memoOn && !photoOn });
  const commentRow = h('div', {},
    h('label', { class: 'check-row' }, commentCb, h('span', {}, 'メモを PDF のコメント（付箋）として埋め込む')),
    h('div', { class: 'muted small sub-note' }, '図面のメモは「番号のみ」のときに番号の横へ、写真のメモは写真ピンの横へ付箋を付けます。PDF アプリで付箋を開くと本文を読めます（手書きは入りません）。'));

  // Excel（写真台帳・メモ一覧を1つのファイルに）
  const photos = project.objects.filter((o) => o.type === 'photo');
  const memosAll = project.objects.filter((o) => o.type === 'memo');
  const hasExcelData = (photoOn && photos.length) || (memoOn && memosAll.length);
  const excelCb = h('input', { type: 'checkbox', checked: !!hasExcelData && saved.withExcel !== false, disabled: !hasExcelData });
  const annotated = photos.some((p) => p.annotations && p.annotations.length);
  const rComp = h('input', { type: 'radio', name: 'pdf-ledger-img', checked: saved.composite !== false });
  const rOrig = h('input', { type: 'radio', name: 'pdf-ledger-img', checked: saved.composite === false });
  const ledgerImg = h('div', { class: 'sub-options', hidden: !annotated || !excelCb.checked },
    h('div', { class: 'muted small' }, '写真台帳：書き込みのある写真に貼る画像'),
    h('label', { class: 'check-row' }, rComp, h('span', {}, '書き込みを合成した画像')),
    h('label', { class: 'check-row' }, rOrig, h('span', {}, '元画像')));
  excelCb.addEventListener('change', () => { ledgerImg.hidden = !annotated || !excelCb.checked; });

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
      ...memoRadios,
      h('div', { class: 'label' }, 'コメント'),
      commentRow,
      h('div', { class: 'label' }, '一緒に出力するもの'),
      h('label', { class: 'check-row' }, excelCb, h('span', {}, 'Excel（写真台帳・メモ一覧）')),
      ledgerImg,
      h('div', { class: 'muted small' }, '写真台帳とメモ一覧は1つのファイルにシートを分けて入ります。選んだページにある写真・メモだけが入ります。'),
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
  const withExcel = excelCb.checked && !excelCb.disabled;
  const composite = rComp.checked;
  try {
    localStorage.setItem(PDF_OPTS_KEY, JSON.stringify({
      memoStyle, composite,
      withExcel: excelCb.disabled ? saved.withExcel : excelCb.checked,
      embedComments: commentCb.disabled ? saved.embedComments : commentCb.checked,
    }));
  } catch { /* 保存できなくても出力は続ける */ }

  const keys = new Set(pages.map((p) => `${p.drawing.id}:${p.pageIndex}`));
  const onPages = (o) => keys.has(`${o.drawingId}:${o.page}`);
  const xPhotos = photoOn ? photos.filter(onPages) : [];
  const xMemos = memoOn ? memosAll.filter(onPages) : [];
  // 進み具合の配分：PDF と Excel
  const wPdf = 1, wXls = withExcel ? 0.1 + xPhotos.length * 0.08 : 0;
  const total = wPdf + wXls;

  const files = await run('出力中…', async (progress) => {
    const out = [];
    const pdf = await exportDrawingsPdf(project, pages, layers, (r, l) => progress((r * wPdf) / total, l), {
      memoStyle: memoOn ? memoStyle : 'tag',
      embedComments: memoOn && memoStyle === 'tag' && commentCb.checked,
      embedPhotoComments: photoOn && commentCb.checked,
    });
    out.push({ blob: pdf, name: fileName(project, '図面', 'pdf') });
    if (withExcel) {
      const xlsx = await exportSurveyWorkbook(project, { photos: xPhotos, memos: xMemos, composite },
        (r, l) => progress((wPdf + r * wXls) / total, l));
      if (xlsx) out.push({ blob: xlsx, name: fileName(project, '写真台帳・メモ一覧', 'xlsx') });
    }
    return out;
  });
  if (files) await deliverFiles(files);
}

/** 写真台帳・メモ一覧（Excel） */
export async function outputExcelDialog(project, layers = {}) {
  const photos = project.objects.filter((o) => o.type === 'photo');
  const memos = project.objects.filter((o) => o.type === 'memo');
  if (!photos.length && !memos.length) { alertDialog('写真もメモもありません'); return; }
  const annotated = photos.filter((p) => p.annotations && p.annotations.length).length;
  const rComp = h('input', { type: 'radio', name: 'ledger-img', checked: true });
  const rOrig = h('input', { type: 'radio', name: 'ledger-img' });
  const v = await modal({
    title: '写真台帳・メモ一覧（Excel）',
    className: 'modal-narrow',
    body: h('div', { class: 'form' },
      h('div', {}, `写真 ${photos.length}枚・メモ ${memos.length}件`),
      h('div', { class: 'muted small' }, '1つのファイルに「写真台帳」「メモ一覧」のシートを分けて出力します。'),
      annotated ? h('div', { class: 'label' }, `書き込みのある写真（${annotated}枚）に貼る画像`) : null,
      annotated ? h('label', { class: 'check-row' }, rComp, h('span', {}, '書き込みを合成した画像')) : null,
      annotated ? h('label', { class: 'check-row' }, rOrig, h('span', {}, '元画像')) : null),
    buttons: [{ label: 'キャンセル', value: null }, { label: '出力', kind: 'primary', value: 'ok' }],
  });
  if (v !== 'ok') return;
  const blob = await run('Excel を作成中…', (progress) =>
    exportSurveyWorkbook(project, { photos, memos, composite: rComp.checked }, progress));
  if (blob) await deliverFiles([{ blob, name: fileName(project, '写真台帳・メモ一覧', 'xlsx') }]);
}
