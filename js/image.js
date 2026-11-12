// 写真の縮小（長辺 2560px・JPEG 品質 0.85）

import { loadImage } from './drawing-source.js';

export const PHOTO_MAX_SIDE = 2560;
export const PHOTO_QUALITY = 0.85;

export async function resizePhoto(file) {
  // <img> で読み込むと EXIF の向きが反映された状態で描画される
  const img = await loadImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
  // 元が十分小さい JPEG ならそのまま使う
  if (k === 1 && file.type === 'image/jpeg') return { blob: file, width: w, height: h };
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), 'image/jpeg', PHOTO_QUALITY));
  c.width = c.height = 0; // iOS のメモリ解放
  return { blob, width: Math.round(w * k), height: Math.round(h * k) };
}
