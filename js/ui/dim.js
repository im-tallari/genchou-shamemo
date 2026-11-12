// 寸法の数値入力・編集

import { h, modal, toast } from './dialogs.js';
import { colorPicker } from './memo.js';
import { DIM_FIELDS, DIM_LABEL } from '../model.js';

// 図形ごとに使える項目
const SHAPE_FIELDS = {
  line: ['L', 'H'],
  rect: ['W', 'D', 'H'],
  circle: ['phi', 'H'],
  point: ['H'],
};
const SHAPE_NAME = { line: '長さ', rect: '縦横', circle: '直径', point: '高さ' };

/** 全角数字などを半角に */
function normalizeNum(s) {
  return String(s || '')
    .replace(/[０-９．，－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,\s]/g, '')
    .trim();
}

/**
 * 寸法の入力。isNew=true なら作成、false なら編集。
 * 戻り値なし（保存・削除は store に反映）
 */
export async function editDim(app, dim, { isNew = false } = {}) {
  const { store, target } = app;
  const allowed = SHAPE_FIELDS[dim.shape] || ['L'];
  let color = dim.color;
  const rows = allowed.map((f) => {
    const on = h('input', { type: 'checkbox', checked: dim.fields.includes(f) });
    const input = h('input', {
      type: 'text', class: 'input dim-input', inputmode: 'decimal', enterkeyhint: 'next',
      value: (dim.values && dim.values[f]) || '', placeholder: 'mm', 'aria-label': DIM_LABEL[f],
    });
    const sync = () => { input.disabled = !on.checked; };
    on.addEventListener('change', sync);
    input.addEventListener('focus', () => { on.checked = true; sync(); });
    sync();
    // 図形の種類を決める項目（線のL・円のφ）は外せない
    if ((dim.shape === 'line' && f === 'L') || (dim.shape === 'circle' && f === 'phi') || (dim.shape === 'point')) {
      on.checked = true; on.disabled = true; sync();
    }
    const row = h('label', { class: 'dim-row' }, on, h('span', { class: 'dim-label' }, DIM_LABEL[f]), input, h('span', { class: 'muted small' }, 'mm'));
    return { f, on, input, row };
  });

  const body = h('div', { class: 'form' },
    h('div', { class: 'muted small' }, `${SHAPE_NAME[dim.shape]}（単位 mm・空欄可）`),
    ...rows.map((r) => r.row),
    h('label', { class: 'label' }, '色'),
    colorPicker(color, (c) => { color = c; }));

  const buttons = [{ label: 'キャンセル', value: null }];
  if (!isNew) buttons.push({ label: '削除', kind: 'danger', value: 'delete' });
  buttons.push({
    label: '保存', kind: 'primary',
    onClick: (close) => {
      if (dim.shape === 'rect' && !rows.some((r) => (r.f === 'W' || r.f === 'D') && r.on.checked)) {
        toast('W・D のどちらかはオンにしてください');
        return;
      }
      close('save');
    },
  });

  const v = await modal({
    title: isNew ? '寸法を入力' : '寸法',
    className: 'modal-narrow',
    body,
    buttons,
    onOpen: (box, close) => {
      const inputs = rows.filter((r) => !r.input.disabled).map((r) => r.input);
      inputs.forEach((inp, i) => inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        if (inputs[i + 1]) inputs[i + 1].focus(); else close('save');
      }));
      if (isNew && inputs[0]) setTimeout(() => { if (!box.contains(document.activeElement)) inputs[0].focus(); }, 50);
    },
  });

  if (v === 'delete') {
    await app.deleteWithConfirm([dim]);
    return;
  }
  if (v !== 'save') return;
  const fields = DIM_FIELDS.filter((f) => rows.some((r) => r.f === f && r.on.checked));
  const values = {};
  for (const r of rows) if (r.on.checked) values[r.f] = normalizeNum(r.input.value);
  if (isNew) {
    store.mutate((p) => target.add(p, { ...dim, fields, values, color }));
  } else {
    store.mutate((p) => {
      const o = target.find(p, dim.id);
      if (o) Object.assign(o, { fields, values, color });
    });
  }
}
