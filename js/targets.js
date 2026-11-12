import { nextMemoNumber } from './model.js';

// 書き込み先：図面（project.objects）か写真（photo.annotations）か
// ツールやメモ編集はこのインターフェース経由でオブジェクトを追加・変更・削除する

/** 図面の現在ページ */
export function drawingTarget(viewer) {
  return {
    kind: 'drawing',
    list: (p) => p.objects,
    add(p, o) {
      o.drawingId = viewer.drawingId;
      o.page = viewer.pageIndex;
      if (o.type === 'memo' && !o.number) o.number = nextMemoNumber(p);
      p.objects.push(o);
    },
    find: (p, id) => p.objects.find((o) => o.id === id),
    remove(p, ids) {
      const s = ids instanceof Set ? ids : new Set(ids);
      p.objects = p.objects.filter((o) => !s.has(o.id));
    },
  };
}

/** 写真への書き込み */
export function photoTarget(photoId) {
  const photo = (p) => p.objects.find((o) => o.id === photoId);
  return {
    kind: 'photo',
    photoId,
    list: (p) => (photo(p) ? photo(p).annotations || [] : []),
    add(p, o) {
      const ph = photo(p);
      if (!ph) return;
      ph.annotations = ph.annotations || [];
      ph.annotations.push(o);
    },
    find: (p, id) => {
      const ph = photo(p);
      return ph && (ph.annotations || []).find((o) => o.id === id);
    },
    remove(p, ids) {
      const ph = photo(p);
      if (!ph) return;
      const s = ids instanceof Set ? ids : new Set(ids);
      ph.annotations = (ph.annotations || []).filter((o) => !s.has(o.id));
    },
  };
}
