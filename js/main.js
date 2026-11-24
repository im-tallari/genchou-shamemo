// 起動・画面切替・Service Worker 登録

import { HomeScreen } from './ui/home.js';
import { EditorScreen } from './ui/editor.js';
import { showInstallGuide } from './ui/install.js';
import { alertDialog, h } from './ui/dialogs.js';
import { registerSW, applyUpdate } from './update.js';

const app = {
  home: null,
  editor: null,
  async showHome() {
    history.replaceState(null, '', location.pathname + location.search);
    await app.home.show();
  },
  async openProject(id) {
    app.home.hide();
    try {
      await app.editor.open(id);
      history.replaceState(null, '', `#p=${id}`);
    } catch (e) {
      console.error(e);
      await alertDialog(e.message || String(e), 'プロジェクトを開けませんでした');
      app.showHome();
    }
  },
};

async function start() {
  if (!('indexedDB' in window)) {
    document.body.textContent = 'このブラウザでは使えません（IndexedDB 非対応）。';
    return;
  }
  app.home = new HomeScreen(document.getElementById('home'), app);
  app.editor = new EditorScreen(document.getElementById('editor'), app);
  // デバッグ・自動テスト用
  window.__app_project = () => app.editor.store && app.editor.store.project;
  window.__app_viewer = () => app.editor.viewer;

  const m = /#p=([\w-]+)/.exec(location.hash);
  if (m) await app.openProject(m[1]);
  else await app.home.show();

  showInstallGuide();
  registerSW({
    onUpdateReady: showUpdateBanner,
    beforeReload: async () => { if (app.editor && app.editor.store) await app.editor.store.flush(); },
  });
}

function showUpdateBanner() {
  if (document.querySelector('.update-banner')) return;
  const bar = h('div', { class: 'update-banner' },
    h('span', {}, '新しいバージョンがあります'),
    h('button', {
      class: 'btn small primary',
      onclick: () => applyUpdate(),
    }, '更新'),
    h('button', { class: 'btn small', onclick: () => bar.remove() }, 'あとで'));
  document.body.appendChild(bar);
}

start();
