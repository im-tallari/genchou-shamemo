// ホーム画面：プロジェクト一覧

import * as db from '../db.js';
import { createProject } from '../model.js';
import { h, modal, confirmDialog, promptDialog, toast, busy, pickFile, formatDate, alertDialog } from './dialogs.js';
import { exportProject, importProject, downloadBlob, canShareFile, shareBlob } from '../zip.js';
import { showInstallGuide, storageStatusText, requestPersist } from './install.js';
import { showAbout } from './about.js';
import { APP_NAME } from '../version.js';

export class HomeScreen {
  constructor(root, app) {
    this.root = root;
    this.app = app;
  }

  async show() {
    this.root.hidden = false;
    await this.render();
  }

  hide() {
    this.root.hidden = true;
  }

  async render() {
    const projects = await db.listProjects();
    this.root.replaceChildren(
      h('header', { class: 'topbar' },
        h('div', { class: 'app-title' }, APP_NAME),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => this.importZip() }, '読み込み'),
        h('button', { class: 'btn primary', onclick: () => this.newProject() }, '＋ 新規')),
      h('main', { class: 'home-main' },
        projects.length
          ? h('ul', { class: 'project-list' }, projects.map((p) => this.item(p)))
          : h('div', { class: 'empty intro' },
            h('h1', { class: 'intro-title' }, '図面に、写真とメモを。'),
            h('p', {}, '現調写メモは、スマホやタブレットで平面図を開き、写真・メモ・手書き・寸法を図面の上に記録する現地調査ツールです。'),
            h('ul', { class: 'intro-list' },
              h('li', {}, '撮影した位置と向きを、番号付きのピンで記録'),
              h('li', {}, 'メモ・手書き・蛍光ペン・寸法（L／W×D／φ／H）を書き込み'),
              h('li', {}, '図面PDF（ピン入り）・写真台帳とメモ一覧（Excel）を出力'),
              h('li', {}, '無料・登録不要。データは端末の中だけに保存され、オフラインでも使えます')),
            h('button', { class: 'btn primary', onclick: () => this.newProject() }, '＋ 新しいプロジェクトを作る'),
            h('p', { class: 'muted small' }, '書き出した .zip がある場合は、右上の「読み込み」から開けます。')),
        h('footer', { class: 'home-foot' },
          h('div', { class: 'foot-links' },
            h('button', { class: 'link', onclick: () => showInstallGuide(true) }, 'ホーム画面に追加する方法'),
            h('button', { class: 'link', onclick: () => showAbout() }, 'このアプリについて')),
          h('span', { class: 'muted small storage-status' }, ''))),
    );
    storageStatusText().then((t) => {
      const el = this.root.querySelector('.storage-status');
      if (el) el.textContent = t;
    });
  }

  item(p) {
    const photos = p.objects.filter((o) => o.type === 'photo').length;
    return h('li', { class: 'project-item' },
      h('button', { class: 'project-open', onclick: () => this.app.openProject(p.id) },
        h('div', { class: 'project-name' }, p.name),
        h('div', { class: 'muted small' },
          `更新 ${formatDate(p.updatedAt)}　図面 ${p.drawings.length}　写真 ${photos}`)),
      h('button', { class: 'icon-btn', 'aria-label': 'メニュー', onclick: () => this.menu(p) }, '⋯'));
  }

  async menu(p) {
    const v = await modal({
      title: p.name,
      className: 'modal-narrow',
      body: h('div', { class: 'menu-list' },
        ...[['open', '開く'], ['rename', '名前を変更'], ['export', '書き出し（.zip）'], ['delete', '削除']].map(([k, label]) =>
          h('button', { class: 'menu-item' + (k === 'delete' ? ' danger' : ''), 'data-k': k }, label))),
      onOpen: (box, close) => {
        box.querySelectorAll('.menu-item').forEach((b) => b.addEventListener('click', () => close(b.dataset.k)));
      },
    });
    if (v === 'open') this.app.openProject(p.id);
    else if (v === 'rename') {
      const name = await promptDialog('プロジェクト名', { value: p.name });
      if (!name) return;
      const fresh = await db.getProject(p.id);
      fresh.name = name;
      fresh.updatedAt = Date.now();
      await db.putProject(fresh);
      this.render();
    } else if (v === 'export') {
      await exportWithDialog(p.id);
    } else if (v === 'delete') {
      if (!(await confirmDialog(`「${p.name}」を削除しますか？\n図面・写真もすべて削除され、元に戻せません。\n必要なら先に書き出してください。`, { okLabel: '削除', danger: true }))) return;
      await db.deleteProject(p.id);
      toast('削除しました');
      this.render();
    }
  }

  async newProject() {
    const name = h('input', { type: 'text', class: 'input', placeholder: '例：○○ビル 現地調査' });
    const numbering = h('select', { class: 'input' },
      h('option', { value: 'sequential' }, 'プロジェクト通し番号（001, 002, …）'),
      h('option', { value: 'daily' }, '日付ごと（20261112-001, …）'));
    const v = await modal({
      title: '新規プロジェクト',
      body: h('div', { class: 'form' },
        h('label', { class: 'label' }, 'プロジェクト名'), name,
        h('label', { class: 'label' }, '写真番号'), numbering),
      buttons: [
        { label: 'キャンセル', value: null },
        { label: '作成', kind: 'primary', onClick: (close) => { if (!name.value.trim()) { name.focus(); return; } close('ok'); } },
      ],
      onOpen: () => setTimeout(() => name.focus(), 50),
    });
    if (v !== 'ok') return;
    const p = createProject(name.value.trim(), numbering.value);
    await db.putProject(p);
    requestPersist();
    this.app.openProject(p.id);
  }

  async importZip() {
    const file = await pickFile({ accept: '.zip,application/zip,application/x-zip-compressed' });
    if (!file) return;
    const b = busy('読み込んでいます…');
    try {
      const p = await importProject(file, (pct) => b.set(`読み込んでいます… ${Math.round(pct)}%`));
      b.close();
      requestPersist();
      toast(`「${p.name}」を読み込みました`);
      this.render();
    } catch (e) {
      b.close();
      console.error(e);
      alertDialog(e.message || String(e), '読み込めませんでした');
    }
  }
}

/** 書き出して、保存または共有を選ばせる */
export async function exportWithDialog(projectId) {
  const b = busy('書き出しています…');
  let result;
  try {
    result = await exportProject(projectId, (pct) => b.set(`書き出しています… ${Math.round(pct)}%`));
  } catch (e) {
    b.close();
    alertDialog(e.message || String(e), '書き出せませんでした');
    return;
  }
  b.close();
  const { blob, fileName, missing } = result;
  const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
  const share = canShareFile(blob, fileName);
  await modal({
    title: '書き出し',
    className: 'modal-narrow',
    body: h('div', { class: 'form' },
      h('div', {}, fileName),
      h('div', { class: 'muted small' }, `${sizeMB} MB`),
      missing.length ? h('div', { class: 'warn small' }, `見つからないファイルが ${missing.length} 件ありました（書き出しから除外）`) : null),
    buttons: [
      share ? {
        label: '共有…',
        onClick: async (close) => {
          try { await shareBlob(blob, fileName, fileName); close(); } catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした'); }
        },
      } : null,
      { label: 'ファイルに保存', kind: 'primary', onClick: (close) => { downloadBlob(blob, fileName); close(); } },
    ].filter(Boolean),
  });
}
