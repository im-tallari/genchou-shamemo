// 撮影ダイアログと写真ビューアー（拡大・写真への書き込み）

import { h, modal, pickFile, busy, confirmDialog, toast, formatDate } from './dialogs.js';
import { resizePhoto } from '../image.js';
import { uid, nextPhotoNumber } from '../model.js';
import * as db from '../db.js';
import { Viewer } from '../viewer.js';
import { openSource } from '../drawing-source.js';
import { ViewTool, PenTool, MemoTool, EraserTool } from '../tools.js';
import { photoTarget } from '../targets.js';
import { editMemo, openMemo, colorPicker } from './memo.js';
import { penOptions } from './tool-options.js';
import { deleteWithConfirm } from './delete.js';
import { icon } from './icons.js';

function roomNameInput(project, value) {
  const listId = 'room-names-' + Math.random().toString(36).slice(2);
  const names = [...new Set(project.rooms.map((r) => r.name).filter(Boolean))];
  const input = h('input', { type: 'text', class: 'input', value: value || '', placeholder: '（空欄可）', list: listId });
  const list = h('datalist', { id: listId }, names.map((n) => h('option', { value: n })));
  return { input, el: h('div', {}, input, list) };
}

async function storePhoto(store, file) {
  const b = busy('写真を保存しています…');
  try {
    const { blob, width, height } = await resizePhoto(file);
    const id = uid();
    await db.putBlob(store.project.id, id, blob, { kind: 'photo', mime: 'image/jpeg' });
    return { blobRef: id, width, height };
  } finally {
    b.close();
  }
}

/**
 * 撮影：部屋名を確認してからカメラを起動する
 * target: { x, y, angle, room, mode }
 */
export function capturePhoto(app, target) {
  const { store, viewer } = app;
  const drawingId = viewer.drawingId, page = viewer.pageIndex;
  const rn = roomNameInput(store.project, target.room ? target.room.name : '');
  const take = async (close, capture) => {
    // input.click() はタップ操作の中で同期的に呼ぶ必要がある
    const filePromise = pickFile({ accept: 'image/*', capture });
    const roomName = rn.input.value.trim();
    close(true);
    const file = await filePromise;
    if (!file) return;
    let stored;
    try {
      stored = await storePhoto(store, file);
    } catch (e) {
      console.error(e);
      toast('写真を保存できませんでした: ' + e.message);
      return;
    }
    const now = new Date();
    const photo = store.mutate((p) => {
      const obj = {
        id: uid(), type: 'photo', drawingId, page,
        x: target.x, y: target.y, angle: target.angle,
        roomId: target.room ? target.room.id : null,
        roomName,
        number: nextPhotoNumber(p, now),
        takenAt: now.getTime(),
        blobRef: stored.blobRef, width: stored.width, height: stored.height,
        annotations: [],
      };
      p.objects.push(obj);
      return obj;
    });
    toast(`写真 ${photo.number} を登録しました`);
  };

  const modeLabel = target.mode === 'room'
    ? `部屋指定：${target.room.name || '（名称なし）'}`
    : (target.angle == null ? '位置指定（方向なし）' : '位置指定（方向あり）');

  modal({
    title: '写真を撮影',
    className: 'modal-narrow',
    body: h('div', { class: 'form' },
      h('div', { class: 'muted small' }, modeLabel),
      h('label', { class: 'label' }, '部屋名'),
      rn.el),
    buttons: [
      { label: 'ファイルから選ぶ', onClick: (close) => take(close, null) },
      { label: '📷 カメラで撮影', kind: 'primary', onClick: (close) => take(close, 'environment') },
    ],
  });
}

const PV_TOOLS = [
  { id: 'view', label: '移動', icon: 'hand' },
  { id: 'pen', label: 'ペン', icon: 'pen' },
  { id: 'memo', label: 'メモ', icon: 'memo' },
  { id: 'eraser', label: '消しゴム', icon: 'eraser' },
];

/** 写真ビューアー（app: 編集画面の { store, settings, saveSetting }） */
export async function openPhotoViewer(app, photo) {
  const { store, settings } = app;
  const photoId = photo.id;
  const target = photoTarget(photoId);
  const current = () => store.project.objects.find((o) => o.id === photoId);

  // ---- 表示部 ----
  const stage = h('div', { class: 'photo-stage' });
  const pv = new Viewer(stage, { memoStyle: 'full', unitBase: 400 }); // 写真は画面いっぱいに表示するので太めに
  pv.objectSource = () => target.list(store.project);
  let source = null;
  const loadImage = async (ref) => {
    const blob = await db.getBlob(store.project.id, ref);
    if (!blob) { toast('画像が見つかりません'); return; }
    const s = await openSource(blob, 'image');
    if (source) source.destroy();
    source = s;
    await pv.setPage(source, null, 0);
  };

  // ---- 書き込みツール ----
  let annotating = false;
  let toolId = 'view';
  const ctx = {
    store, settings, target, toast,
    get viewer() { return pv; },
    openPhoto() {},
    openDim() {},
    openMemo: (m) => openMemo(ctx, m),
    createMemo: (x, y) => editMemo(ctx, null, { x, y }),
    deleteWithConfirm: (items) => deleteWithConfirm(store, target, items),
    onToolStateChange: () => {},
  };
  const tools = { view: new ViewTool(ctx), pen: new PenTool(ctx), memo: new MemoTool(ctx), eraser: new EraserTool(ctx) };
  // 書き込みモード以外では、タップでメモを開く・長押しの削除だけ
  pv.tool = tools.view;

  const subbar = h('div', { class: 'subbar pv-subbar' });
  const undoBtn = h('button', { class: 'icon-btn', 'aria-label': '元に戻す', onclick: () => store.undo() }, icon('undo'));
  const redoBtn = h('button', { class: 'icon-btn', 'aria-label': 'やり直す', onclick: () => store.redo() }, icon('redo'));
  const toolbar = h('div', { class: 'pv-toolbar' },
    PV_TOOLS.map((t) => h('button', { class: 'tool-btn', 'data-tool': t.id, onclick: () => setTool(t.id) }, icon(t.icon), h('span', {}, t.label))),
    undoBtn, redoBtn);
  const annotateBar = h('div', { class: 'pv-annotate', hidden: true }, subbar, toolbar);

  const save = (k, v) => app.saveSetting(k, v);
  function renderSubbar() {
    let content = [];
    if (toolId === 'view') content = [h('span', { class: 'hint' }, 'ドラッグで移動・2本指で拡大／メモをタップで開く／長押しで削除')];
    else if (toolId === 'pen') content = penOptions(settings, save);
    else if (toolId === 'memo') content = [colorPicker(settings.color, (c) => save('color', c)), h('span', { class: 'hint' }, 'メモを置く位置をタップ')];
    else if (toolId === 'eraser') content = [h('span', { class: 'hint' }, '手書きの線をなぞって消す')];
    subbar.replaceChildren(...content);
  }
  function setTool(id) {
    toolId = id;
    pv.tool = tools[id];
    pv.resetGesture();
    for (const b of toolbar.querySelectorAll('.tool-btn')) b.classList.toggle('on', b.dataset.tool === id);
    renderSubbar();
  }
  function updateUndo() {
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
  }

  // ---- 情報欄 ----
  const rn = roomNameInput(store.project, photo.roomName);
  const saveRoomName = () => {
    const v = rn.input.value.trim();
    const o = current();
    if (o && (o.roomName || '') !== v) {
      store.mutate((p) => { p.objects.find((x) => x.id === photoId).roomName = v; });
      toast('部屋名を変更しました');
    }
  };
  rn.input.addEventListener('change', saveRoomName);
  const taken = h('span', {}, formatDate(photo.takenAt));
  const annCount = h('span', { class: 'muted small' });
  const info = h('div', { class: 'photo-info form' },
    h('div', { class: 'photo-meta' }, h('span', { class: 'photo-no' }, `No. ${photo.number}`), taken, annCount),
    h('div', { class: 'photo-room' }, h('label', { class: 'label' }, '部屋名'), rn.el));

  const updateInfo = () => {
    const o = current();
    const n = o && o.annotations ? o.annotations.length : 0;
    annCount.textContent = n ? `書き込み ${n}件` : '';
  };

  let closeModal = null;
  const onChange = () => {
    if (!current()) { if (closeModal) closeModal('gone'); return; }
    pv.requestRedraw();
    updateUndo();
    updateInfo();
  };
  store.addEventListener('change', onChange);

  const body = h('div', { class: 'photo-view' }, stage, annotateBar, info);
  setTool('view');
  updateUndo();
  updateInfo();

  await modal({
    title: `写真 ${photo.number}`,
    className: 'modal-full',
    body,
    buttons: [
      {
        label: '削除', kind: 'danger',
        onClick: async (close) => {
          if (!(await confirmDialog(`写真 ${photo.number} を削除しますか？\n（「元に戻す」で取り消せます）`, { okLabel: '削除', danger: true }))) return;
          store.mutate((p) => { p.objects = p.objects.filter((o) => o.id !== photoId); });
          close('deleted');
        },
      },
      {
        label: '撮り直し',
        onClick: async () => {
          const o = current();
          if (o && o.annotations && o.annotations.length &&
              !(await confirmDialog('撮り直すと、この写真への書き込みは削除されます。よろしいですか？', { okLabel: '撮り直す', danger: true }))) return;
          const file = await pickFile({ accept: 'image/*', capture: 'environment' });
          if (!file) return;
          try {
            const stored = await storePhoto(store, file);
            const t = Date.now();
            store.mutate((p) => {
              const x = p.objects.find((y) => y.id === photoId);
              Object.assign(x, { blobRef: stored.blobRef, width: stored.width, height: stored.height, takenAt: t, annotations: [] });
            });
            taken.textContent = formatDate(t);
            await loadImage(stored.blobRef);
            toast('撮り直しました');
          } catch (e) {
            toast('写真を保存できませんでした: ' + e.message);
          }
        },
      },
      {
        label: '書き込み',
        onClick: (close, btn) => {
          annotating = !annotating;
          annotateBar.hidden = !annotating;
          info.classList.toggle('compact', annotating);
          btn.textContent = annotating ? '書き込み終了' : '書き込み';
          btn.classList.toggle('primary', annotating);
          setTool(annotating ? 'pen' : 'view');
        },
      },
      { label: '閉じる', kind: 'primary', onClick: (close) => { saveRoomName(); close(); } },
    ],
    onOpen: (box, close) => {
      closeModal = close;
      loadImage(photo.blobRef);
    },
  });
  saveRoomName();
  store.removeEventListener('change', onChange);
  pv.destroy();
  if (source) source.destroy();
}
