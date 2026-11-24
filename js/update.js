// アプリの更新（Service Worker）の登録・確認・反映
// SPDX-License-Identifier: AGPL-3.0-or-later

const CHECK_INTERVAL = 60 * 1000; // アプリに戻ってきたときの確認は1分に1回まで

let reg = null;
let lastCheck = 0;
let beforeReload = async () => {};
let onUpdateReady = () => {};
let updateReady = false;
let readyWaiters = [];

export function isSupported() {
  if (!('serviceWorker' in navigator)) return false;
  return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

/**
 * Service Worker を登録する
 * options.onUpdateReady: 新しい版を取り込み終えたときに呼ばれる（「新しいバージョンがあります」の表示用）
 * options.beforeReload: 再読み込みの前に呼ばれる（保存の確定用）
 */
export function registerSW(options = {}) {
  if (options.onUpdateReady) onUpdateReady = options.onUpdateReady;
  if (options.beforeReload) beforeReload = options.beforeReload;
  if (!isSupported()) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then((r) => {
    reg = r;
    lastCheck = Date.now();
    r.addEventListener('updatefound', () => {
      const w = r.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'activated') {
          if (hadController) markReady();
          else resolveWaiters(false); // 初回のインストール（更新ではない）
        }
        if (w.state === 'redundant') resolveWaiters(false);
      });
    });
  }).catch((e) => console.warn('SW 登録に失敗', e));

  // アプリに戻ってきたとき・ネットにつながったときにも更新を確認する
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkQuietly();
  });
  window.addEventListener('online', () => checkQuietly());
}

function markReady() {
  updateReady = true;
  resolveWaiters(true);
  onUpdateReady();
}

function resolveWaiters(v) {
  const ws = readyWaiters;
  readyWaiters = [];
  for (const f of ws) f(v);
}

function checkQuietly() {
  if (!reg || !navigator.onLine || Date.now() - lastCheck < CHECK_INTERVAL) return;
  lastCheck = Date.now();
  reg.update().catch(() => {});
}

/**
 * 今すぐ更新を確認する
 * 戻り値: 'found'（新しい版を取り込んだ）| 'latest'（最新）| 'offline' | 'unsupported' | 'error'
 */
export async function checkForUpdate() {
  if (!isSupported() || !reg) return 'unsupported';
  if (updateReady) return 'found';
  if (!navigator.onLine) return 'offline';
  lastCheck = Date.now();
  try {
    const waitReady = new Promise((resolve) => readyWaiters.push(resolve));
    await reg.update();
    if (!reg.installing && !reg.waiting) {
      resolveWaiters(false);
      return updateReady ? 'found' : 'latest';
    }
    // 取り込み終わるまで待つ（最大60秒）
    const ok = await Promise.race([waitReady, new Promise((r) => setTimeout(() => r(false), 60000))]);
    return ok ? 'found' : 'error';
  } catch (e) {
    console.warn(e);
    return navigator.onLine ? 'error' : 'offline';
  }
}

/** 保存を確定してから再読み込みし、新しい版に切り替える */
export async function applyUpdate() {
  try { await beforeReload(); } catch (e) { console.warn(e); }
  location.reload();
}
