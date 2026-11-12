// 撮影ダイアログと写真ビューアー

import { h, modal, pickFile, busy, confirmDialog, toast, formatDate } from './dialogs.js';
import { resizePhoto } from '../image.js';
import { uid, nextPhotoNumber } from '../model.js';
import * as db from '../db.js';

function roomNameInput(project, value) {
  const listId = 'room-names-' + Math.random().toString(36).slice(2);
  const names = [...new Set(project.rooms.map((r) => r.name).filter(Boolean))];
  const input = h('input', { type: 'text', class: 'input', value: value || '', placeholder: '（空欄可）', list: listId });
  const list = h('datalist', { id: listId }, names.map((n) => h('option', { value: n })));
  return { input, el: h('div', {}, input, list) };
}

async function storePhoto(app, file) {
  const b = busy('写真を保存しています…');
  try {
    const { blob, width, height } = await resizePhoto(file);
    const id = uid();
    await db.putBlob(app.store.project.id, id, blob, { kind: 'photo', mime: 'image/jpeg' });
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
      stored = await storePhoto(app, file);
    } catch (e) {
      console.error(e);
      toast('写真を保存できませんでした: ' + e.message);
      return;
    }
    const now = new Date();
    const photo = store.mutate((p) => {
      const obj = {
        id: uid(),
        type: 'photo',
        drawingId,
        page,
        x: target.x,
        y: target.y,
        angle: target.angle,
        roomId: target.room ? target.room.id : null,
        roomName,
        number: nextPhotoNumber(p, now),
        takenAt: now.getTime(),
        blobRef: stored.blobRef,
        width: stored.width,
        height: stored.height,
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

/** 写真ビューアー */
export async function openPhotoViewer(app, photo) {
  const { store } = app;
  let url = null;
  const img = h('img', { class: 'photo-img', alt: '' });
  const setImage = async (ref) => {
    const blob = await db.getBlob(store.project.id, ref);
    if (url) URL.revokeObjectURL(url);
    url = blob ? URL.createObjectURL(blob) : null;
    img.src = url || '';
    img.alt = blob ? `写真 ${photo.number}` : '画像が見つかりません';
  };
  await setImage(photo.blobRef);

  const current = () => store.project.objects.find((o) => o.id === photo.id);
  const rn = roomNameInput(store.project, photo.roomName);
  const saveRoomName = () => {
    const v = rn.input.value.trim();
    const o = current();
    if (o && (o.roomName || '') !== v) {
      store.mutate((p) => { p.objects.find((x) => x.id === photo.id).roomName = v; });
      toast('部屋名を変更しました');
    }
  };
  rn.input.addEventListener('change', saveRoomName);

  const taken = h('span', {}, formatDate(photo.takenAt));
  const body = h('div', { class: 'photo-view' },
    h('div', { class: 'photo-stage' }, img),
    h('div', { class: 'photo-info form' },
      h('div', { class: 'photo-meta' },
        h('span', { class: 'photo-no' }, `No. ${photo.number}`),
        taken),
      h('label', { class: 'label' }, '部屋名'),
      rn.el));

  await modal({
    title: `写真 ${photo.number}`,
    className: 'modal-full',
    body,
    buttons: [
      {
        label: '削除', kind: 'danger',
        onClick: async (close) => {
          if (!(await confirmDialog(`写真 ${photo.number} を削除しますか？\n（「元に戻す」で取り消せます）`, { okLabel: '削除', danger: true }))) return;
          store.mutate((p) => { p.objects = p.objects.filter((o) => o.id !== photo.id); });
          close('deleted');
        },
      },
      {
        label: '撮り直し',
        onClick: async () => {
          const file = await pickFile({ accept: 'image/*', capture: 'environment' });
          if (!file) return;
          try {
            const stored = await storePhoto(app, file);
            const t = Date.now();
            store.mutate((p) => {
              const o = p.objects.find((x) => x.id === photo.id);
              Object.assign(o, { blobRef: stored.blobRef, width: stored.width, height: stored.height, takenAt: t });
            });
            photo.blobRef = stored.blobRef;
            taken.textContent = formatDate(t);
            await setImage(stored.blobRef);
            toast('撮り直しました');
          } catch (e) {
            toast('写真を保存できませんでした: ' + e.message);
          }
        },
      },
      { label: '閉じる', kind: 'primary', onClick: (close) => { saveRoomName(); close(); } },
    ],
  });
  saveRoomName();
  if (url) URL.revokeObjectURL(url);
}
