// ツールのサブバー部品（図面と写真の書き込みで共用）

import { h } from './dialogs.js';
import { colorPicker } from './memo.js';
import { PEN_WIDTHS, HL_WIDTHS } from '../model.js';

export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  for (const [v, label] of options) {
    const b = h('button', { class: 'seg-btn' + (v === value ? ' on' : ''), type: 'button' }, label);
    b.addEventListener('click', () => {
      for (const x of wrap.children) x.classList.remove('on');
      b.classList.add('on');
      onChange(v);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

export function toggleButton(label, on, onChange, { title } = {}) {
  const b = h('button', { class: 'toggle-btn' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(!!on), title }, label);
  b.addEventListener('click', () => {
    on = !on;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    onChange(on);
  });
  return b;
}

/** ペンの設定：色・蛍光オン／オフ・太さ */
export function penOptions(settings, save) {
  const widthWrap = h('div', { class: 'seg-wrap' });
  const renderWidths = () => {
    const hl = !!settings.highlighter;
    const list = hl ? HL_WIDTHS : PEN_WIDTHS;
    const key = hl ? 'hlWidth' : 'penWidth';
    widthWrap.replaceChildren(segmented(list.map((w) => [w.value, w.label]), settings[key], (v) => save(key, v)));
  };
  renderWidths();
  return [
    colorPicker(settings.color, (c) => save('color', c)),
    toggleButton('蛍光', settings.highlighter, (on) => { save('highlighter', on); renderWidths(); }, { title: '半透明の蛍光ペン' }),
    widthWrap,
  ];
}
