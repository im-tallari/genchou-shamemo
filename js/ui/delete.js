// 削除の確認と実行（長押し・範囲選択・各ダイアログ共通）

import { confirmDialog, toast } from './dialogs.js';

const NAME = { photo: '写真', memo: 'メモ', stroke: '手書きの線', dim: '寸法' };

function describe(o) {
  if (o.polygon) return `部屋「${o.name || '名称なし'}」の範囲`;
  if (o.type === 'photo') return `写真 ${o.number}`;
  return NAME[o.type] || 'オブジェクト';
}

/** items: オブジェクト・部屋の配列。削除したら true */
export async function deleteWithConfirm(store, target, items) {
  if (!items.length) return false;
  let msg;
  if (items.length === 1) {
    msg = `${describe(items[0])}を削除しますか？`;
  } else {
    const counts = {};
    for (const o of items) {
      const k = o.polygon ? '部屋範囲' : NAME[o.type] || 'その他';
      counts[k] = (counts[k] || 0) + 1;
    }
    msg = `選択した ${items.length} 件を削除しますか？\n（${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join('、')}）`;
  }
  if (items.some((o) => o.polygon)) msg += '\n部屋の写真は削除されず、部屋名もそのまま残ります。';
  msg += '\n（「元に戻す」で取り消せます）';
  if (!(await confirmDialog(msg, { okLabel: '削除', danger: true }))) return false;

  const objIds = new Set(items.filter((o) => !o.polygon).map((o) => o.id));
  const roomIds = new Set(items.filter((o) => o.polygon).map((o) => o.id));
  store.mutate((p) => {
    if (objIds.size) target.remove(p, objIds);
    if (roomIds.size) {
      p.rooms = p.rooms.filter((r) => !roomIds.has(r.id));
      for (const o of p.objects) if (roomIds.has(o.roomId)) o.roomId = null;
    }
  });
  toast(items.length === 1 ? '削除しました' : `${items.length} 件を削除しました`);
  return true;
}
