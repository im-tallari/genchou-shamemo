// 「ホーム画面に追加」の案内とストレージ永続化

import { h, modal } from './dialogs.js';

const SEEN_KEY = 'install-guide-seen';
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 使えなくても動作に影響なし */ } }

/** 初回起動時に案内を出す。force=true で常に出す */
export async function showInstallGuide(force = false) {
  if (!force && (isStandalone() || lsGet(SEEN_KEY))) return;
  lsSet(SEEN_KEY, '1');
  const body = h('div', { class: 'form install-guide' },
    h('p', {}, 'このツールのデータ（図面・写真・メモ）は、この端末のブラウザ内だけに保存されます。'),
    isIOS()
      ? h('div', {},
        h('p', { class: 'warn' }, 'iPhone／iPad の Safari は、ホーム画面に追加していないサイトのデータを、7日ほど使わないと削除することがあります。必ずホーム画面に追加して、そこから起動してください。'),
        h('ol', {},
          h('li', {}, '画面下（iPad は上）の共有ボタン（□に↑）をタップ'),
          h('li', {}, '「ホーム画面に追加」をタップ'),
          h('li', {}, 'ホーム画面のアイコンから起動')))
      : h('div', {},
        h('p', {}, 'ホーム画面（デスクトップ）に追加すると、アプリとして起動でき、オフラインでも使えます。'),
        deferredPrompt ? null : h('p', { class: 'muted small' }, 'Chrome のメニュー（︙）→「ホーム画面に追加」または「アプリをインストール」から追加できます。')),
    h('p', { class: 'muted small' }, '端末の故障や機種変更に備えて、プロジェクトはときどき「書き出し（.zip）」で保存してください。'));

  const buttons = [{ label: '閉じる', value: null }];
  if (deferredPrompt && !isStandalone()) {
    buttons.push({
      label: 'ホーム画面に追加', kind: 'primary',
      onClick: async (close) => {
        const p = deferredPrompt;
        deferredPrompt = null;
        close();
        p.prompt();
        await p.userChoice.catch(() => {});
      },
    });
  }
  await modal({ title: 'はじめに', body, buttons });
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
  } catch { /* 非対応 */ }
  return false;
}

export async function storageStatusText() {
  try {
    const parts = [];
    if (navigator.storage && navigator.storage.persisted) {
      parts.push((await navigator.storage.persisted()) ? '保存領域：永続化済み' : '保存領域：未永続化');
    }
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e.usage != null) parts.push(`使用量 ${(e.usage / 1024 / 1024).toFixed(1)} MB`);
    }
    return parts.join('　');
  } catch {
    return '';
  }
}
