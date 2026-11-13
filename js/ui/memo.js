// メモの作成・表示・編集（キーボード入力＋手書き）

import { h, modal, confirmDialog, toast } from './dialogs.js';
import { uid, PRESET_COLORS } from '../model.js';
import { tracePath, drawHandwriting } from '../viewer.js';

const PAD_W = 600, PAD_H = 400, PAD_LINE = 4;

export function colorPicker(value, onChange) {
  const wrap = h('div', { class: 'colors' });
  const custom = h('input', { type: 'color', class: 'color-custom', value, 'aria-label': '任意の色' });
  const set = (c) => {
    value = c;
    for (const b of wrap.querySelectorAll('.swatch')) b.classList.toggle('on', b.dataset.c === c);
    custom.classList.toggle('on', !PRESET_COLORS.includes(c));
    custom.value = c;
    onChange(c);
  };
  for (const c of PRESET_COLORS) {
    wrap.appendChild(h('button', {
      class: 'swatch' + (c === value ? ' on' : ''), 'data-c': c, style: { background: c },
      'aria-label': c, type: 'button', onclick: () => set(c),
    }));
  }
  custom.addEventListener('input', () => set(custom.value));
  if (!PRESET_COLORS.includes(value)) custom.classList.add('on');
  wrap.appendChild(custom);
  return wrap;
}

/** 手書きパッド */
function handwritingPad(initial, getColor) {
  const strokes = initial ? JSON.parse(JSON.stringify(initial.strokes)) : [];
  const canvas = h('canvas', { class: 'hw-pad' });
  const ctx = canvas.getContext('2d');
  let cur = null;
  let scale = 1;

  // キャンバスの大きさは表示時・大きさが変わったときだけ設定する（毎回作り直すと iPad で遅くなる）
  let cssW = 0, dpr = 1;
  const layout = () => {
    const w = canvas.clientWidth;
    const d = window.devicePixelRatio || 1;
    if (!w || (w === cssW && d === dpr)) return false;
    cssW = w;
    dpr = d;
    scale = w / PAD_W;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(PAD_H * scale * dpr);
    return true;
  };
  const style = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = ctx.fillStyle = getColor();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };
  const redraw = () => {
    layout();
    if (!cssW) return;
    style();
    ctx.clearRect(0, 0, cssW, PAD_H * scale);
    for (const s of cur ? [...strokes, cur] : strokes) {
      ctx.lineWidth = s.width * scale;
      tracePath(ctx, s.points, scale, 0, 0);
    }
  };
  new ResizeObserver(() => { if (layout()) redraw(); }).observe(canvas);

  // 書いている間は、増えた部分だけを描き足す
  const drawSegment = (from) => {
    style();
    ctx.lineWidth = cur.width * scale;
    tracePath(ctx, cur.points.slice(Math.max(0, from - 2)), scale, 0, 0);
  };

  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / scale) * 10) / 10, Math.round(((e.clientY - r.top) / scale) * 10) / 10];
  };
  // iOS の文字選択・拡大鏡などの標準動作を止める（線が途切れたり、タイトルが選択されたりする原因）
  for (const t of ['touchstart', 'touchmove', 'touchend']) {
    canvas.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  }
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
    layout();
    cur = { points: [pt(e)], width: PAD_LINE };
    drawSegment(0);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const from = cur.points.length;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of list.length ? list : [e]) cur.points.push(pt(ce));
    drawSegment(from);
  });
  const end = () => {
    if (!cur) return;
    strokes.push(cur);
    cur = null;
    redraw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const el = h('div', { class: 'hw-wrap' },
    canvas,
    h('div', { class: 'hw-tools' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { strokes.pop(); redraw(); } }, '1画戻す'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { strokes.length = 0; redraw(); } }, '全消去')));

  return {
    el,
    redraw,
    value: () => (strokes.length ? { width: PAD_W, height: PAD_H, strokes } : null),
  };
}

/** メモ編集。memo=null で新規 */
export async function editMemo(app, memo, pos) {
  const { store, target } = app;
  let color = memo ? memo.color : app.settings.color;
  const text = h('textarea', { class: 'input memo-text', rows: 3, placeholder: 'メモを入力' }, memo ? memo.text || '' : '');
  const pad = handwritingPad(memo && memo.handwriting, () => color);
  const tabText = h('button', { class: 'tab on', type: 'button' }, 'キーボード');
  const tabHw = h('button', { class: 'tab', type: 'button' }, '手書き');
  const paneText = h('div', { class: 'pane' }, text);
  const paneHw = h('div', { class: 'pane', hidden: true }, pad.el);
  const showTab = (hw) => {
    tabText.classList.toggle('on', !hw);
    tabHw.classList.toggle('on', hw);
    paneText.hidden = hw;
    paneHw.hidden = !hw;
    if (hw) requestAnimationFrame(pad.redraw);
  };
  tabText.onclick = () => showTab(false);
  tabHw.onclick = () => showTab(true);
  const startHw = memo && !memo.text && memo.handwriting;

  const body = h('div', { class: 'form' },
    h('div', { class: 'tabs' }, tabText, tabHw),
    paneText, paneHw,
    h('label', { class: 'label' }, '色'),
    colorPicker(color, (c) => { color = c; pad.redraw(); }),
    h('div', { class: 'muted small' }, 'キーボード入力と手書きは両方使えます'));

  const result = await modal({
    title: memo ? `メモを編集${memo.number ? ' ' + memo.number : ''}` : 'メモを追加',
    body,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '保存', kind: 'primary', onClick: (close) => close('save') },
    ],
    onOpen: () => {
      showTab(!!startHw);
      if (!startHw) setTimeout(() => text.focus(), 50);
    },
  });
  if (result !== 'save') return;
  const t = text.value.replace(/\s+$/, '');
  const hw = pad.value();
  if (!t && !hw) {
    if (memo) toast('内容が空のため保存しませんでした（削除はメモを開いて「削除」）');
    return;
  }
  if (memo) {
    store.mutate((p) => {
      const o = target.find(p, memo.id);
      if (!o) return;
      o.text = t;
      o.handwriting = hw;
      o.color = color;
    });
  } else {
    store.mutate((p) => {
      target.add(p, { id: uid(), type: 'memo', x: pos.x, y: pos.y, color, text: t, handwriting: hw });
    });
  }
}

/** メモを開く（全文表示） */
export async function openMemo(app, memo) {
  const { store, target } = app;
  const parts = [];
  if (memo.text) parts.push(h('div', { class: 'memo-full', style: { color: memo.color } }, memo.text));
  let canvas = null;
  if (memo.handwriting) {
    canvas = h('canvas', { class: 'memo-hw' });
    parts.push(canvas);
  }
  const v = await modal({
    title: memo.number ? `メモ ${memo.number}` : 'メモ',
    body: h('div', { class: 'form' }, parts),
    buttons: [
      { label: '削除', kind: 'danger', value: 'delete' },
      { label: '編集', value: 'edit' },
      { label: '閉じる', kind: 'primary', value: null },
    ],
    onOpen: () => {
      if (!canvas) return;
      requestAnimationFrame(() => {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || 300;
        const hh = w * (memo.handwriting.height / memo.handwriting.width);
        canvas.width = w * dpr;
        canvas.height = hh * dpr;
        canvas.style.height = hh + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawHandwriting(ctx, memo.handwriting, memo.color, 0, 0, w, hh);
      });
    },
  });
  if (v === 'edit') return editMemo(app, memo);
  if (v === 'delete') {
    if (!(await confirmDialog('このメモを削除しますか？\n（「元に戻す」で取り消せます）', { okLabel: '削除', danger: true }))) return;
    store.mutate((p) => target.remove(p, [memo.id]));
  }
}
