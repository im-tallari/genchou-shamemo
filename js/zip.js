// プロジェクトの .zip 書き出し／読み込み
// zip の中身:
//   project.json             … プロジェクト全体（files に blobRef → zip 内パスの対応）
//   drawings/<blobRef>.<ext> … 図面の元ファイル
//   photos/<blobRef>.jpg     … 写真

import * as db from './db.js';
import { uid, normalizeProject, ymd } from './model.js';

/* global JSZip */ // vendor/jszip/jszip.min.js（index.html で読み込み）

const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

function safeName(s) {
  return (s || 'project').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

export function exportFileName(project) {
  return `${safeName(project.name)}_${ymd()}.zip`;
}

export async function exportProject(projectId, onProgress) {
  const project = await db.getProject(projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  const zip = new JSZip();
  const files = {};
  const refs = [];
  for (const d of project.drawings) refs.push({ ref: d.blobRef, dir: 'drawings', fallbackExt: d.type === 'pdf' ? 'pdf' : 'png' });
  for (const o of project.objects) if (o.type === 'photo' && o.blobRef) refs.push({ ref: o.blobRef, dir: 'photos', fallbackExt: 'jpg' });
  const missing = [];
  for (const { ref, dir, fallbackExt } of refs) {
    const rec = await db.getBlobRecord(project.id, ref);
    if (!rec) { missing.push(ref); continue; }
    const ext = EXT[rec.blob.type] || fallbackExt;
    const path = `${dir}/${ref}.${ext}`;
    files[ref] = path;
    zip.file(path, rec.blob, { compression: ext === 'pdf' ? 'DEFLATE' : 'STORE' });
  }
  const json = { ...project, files, exportedAt: Date.now(), app: 'site-survey' };
  zip.file('project.json', JSON.stringify(json, null, 1), { compression: 'DEFLATE' });
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' }, (m) => onProgress && onProgress(m.percent));
  return { blob, fileName: exportFileName(project), missing };
}

/** zip を読み込み、新しいプロジェクトとして保存する（既存とは別IDになる） */
export async function importProject(file, onProgress) {
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('zip ファイルとして読み込めませんでした');
  }
  const entry = zip.file('project.json');
  if (!entry) throw new Error('project.json が含まれていません。このツールで書き出したファイルを選んでください');
  let data;
  try {
    data = JSON.parse(await entry.async('string'));
  } catch {
    throw new Error('project.json の形式が正しくありません');
  }
  if (!Array.isArray(data.drawings) || !Array.isArray(data.objects)) throw new Error('project.json の形式が正しくありません');
  const files = data.files || {};
  delete data.files;
  delete data.exportedAt;
  delete data.app;
  const project = normalizeProject(data);
  project.id = uid();
  project.updatedAt = Date.now();

  const blobs = [];
  const entries = Object.entries(files);
  let i = 0;
  for (const [ref, path] of entries) {
    const f = zip.file(path);
    i++;
    if (!f) continue;
    const ext = path.split('.').pop().toLowerCase();
    const mime = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[ext] || 'application/octet-stream';
    const ab = await f.async('arraybuffer');
    blobs.push({ id: ref, blob: new Blob([ab], { type: mime }), kind: path.startsWith('photos/') ? 'photo' : 'drawing', mime });
    if (onProgress) onProgress((i / entries.length) * 100);
  }
  await db.putProjectWithBlobs(project, blobs);
  return project;
}

/** Blob をダウンロードさせる（iOS では「ファイル」に保存される） */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFile(blob, fileName) {
  try {
    const f = new File([blob], fileName, { type: 'application/zip' });
    return !!(navigator.canShare && navigator.canShare({ files: [f] }));
  } catch {
    return false;
  }
}

export async function shareBlob(blob, fileName, title) {
  const f = new File([blob], fileName, { type: 'application/zip' });
  await navigator.share({ files: [f], title });
}
