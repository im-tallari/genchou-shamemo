// モーダル・トースト等の共通UI

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

const stack = [];

/**
 * モーダルを開く。
 * buttons: [{ label, value, kind: 'primary'|'danger'|'', onClick?(close) }]
 * 戻り値: Promise<value>（背景タップ・×で閉じると null）
 */
export function modal({ title, body, buttons = [], className = '', dismissable = true, onOpen }) {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const box = h('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true' });
    const close = (v = null) => {
      backdrop.remove();
      stack.splice(stack.indexOf(close), 1);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable && stack[stack.length - 1] === close) close(null);
    };
    document.addEventListener('keydown', onKey);
    if (title) {
      box.appendChild(h('div', { class: 'modal-head' },
        h('div', { class: 'modal-title' }, title),
        dismissable ? h('button', { class: 'icon-btn modal-x', 'aria-label': '閉じる', onclick: () => close(null) }, '✕') : null));
    }
    if (body) box.appendChild(h('div', { class: 'modal-body' }, body));
    if (buttons.length) {
      box.appendChild(h('div', { class: 'modal-foot' }, buttons.map((b) => {
        const el = h('button', { class: `btn ${b.kind || ''}` }, b.label);
        el.addEventListener('click', () => (b.onClick ? b.onClick(close, el) : close(b.value)));
        return el;
      })));
    }
    backdrop.appendChild(box);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop && dismissable) backdrop.dataset.down = '1';
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && dismissable && backdrop.dataset.down) close(null);
      delete backdrop.dataset.down;
    });
    document.body.appendChild(backdrop);
    stack.push(close);
    if (onOpen) onOpen(box, close);
  });
}

export async function confirmDialog(message, { okLabel = 'OK', danger = false, title = '確認' } = {}) {
  const v = await modal({
    title,
    body: h('p', { class: 'pre' }, message),
    buttons: [
      { label: 'キャンセル', value: false },
      { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === true;
}

export async function alertDialog(message, title = 'お知らせ') {
  await modal({ title, body: h('p', { class: 'pre' }, message), buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
}

export async function promptDialog(title, { value = '', placeholder = '', okLabel = 'OK', allowEmpty = false } = {}) {
  const input = h('input', { type: 'text', class: 'input', value, placeholder, enterkeyhint: 'done' });
  const v = await modal({
    title,
    body: input,
    buttons: [
      { label: 'キャンセル', value: null },
      {
        label: okLabel, kind: 'primary',
        onClick: (close) => {
          if (!allowEmpty && !input.value.trim()) { input.focus(); return; }
          close(input.value.trim());
        },
      },
    ],
    onOpen: (box, close) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (!allowEmpty && !input.value.trim()) return;
          close(input.value.trim());
        }
      });
      setTimeout(() => { input.focus(); input.select(); }, 50);
    },
  });
  return v;
}

let toastTimer = 0;
export function toast(message, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** 処理中表示 */
export function busy(message = '処理中…') {
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, h('div', { class: 'spinner' }), h('div', {}, message)));
  document.body.appendChild(el);
  return {
    set: (m) => { el.querySelector('.busy-box div:last-child').textContent = m; },
    close: () => el.remove(),
  };
}

/** ファイル選択（ユーザー操作の中から呼ぶこと） */
export function pickFile({ accept = '', capture = null, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    if (capture) input.setAttribute('capture', capture);
    if (multiple) input.multiple = true;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => finish(multiple ? [...input.files] : input.files[0] || null));
    input.addEventListener('cancel', () => finish(multiple ? [] : null));
    document.body.appendChild(input);
    input.click();
  });
}

export function formatDate(t, withTime = true) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  return withTime ? `${s} ${p(d.getHours())}:${p(d.getMinutes())}` : s;
}
