// 編集画面：図面表示・ツールバー・メニュー

import * as db from '../db.js';
import { uid, normalizeProject, PEN_WIDTHS, HL_WIDTHS, DIM_FIELDS, DIM_LABEL, toggleDimField } from '../model.js';
import { ProjectStore } from '../project-store.js';
import { Viewer, LAYERS } from '../viewer.js';
import { openSource, analyze, detectType } from '../drawing-source.js';
import { ViewTool, SelectTool, CameraTool, RoomTool, MemoTool, PenTool, DimTool, EraserTool } from '../tools.js';
import { drawingTarget } from '../targets.js';
import { h, modal, toast, busy, pickFile, confirmDialog, promptDialog, alertDialog } from './dialogs.js';
import { icon } from './icons.js';
import { capturePhoto, openPhotoViewer } from './photo.js';
import { editMemo, openMemo, colorPicker } from './memo.js';
import { editDim } from './dim.js';
import { deleteWithConfirm } from './delete.js';
import { segmented, toggleButton, penOptions } from './tool-options.js';
import { exportWithDialog } from './home.js';
import { outputPdfDialog, outputLedgerDialog, outputMemoListDialog } from './output.js';
import { requestPersist } from './install.js';
import { showAbout } from './about.js';

const SETTINGS_KEY = 'editor-settings';
const TOOLS = [
  { id: 'view', label: '表示', icon: 'hand' },
  { id: 'select', label: '選択', icon: 'lasso' },
  { id: 'camera', label: 'カメラ', icon: 'camera' },
  { id: 'room', label: '部屋', icon: 'room' },
  { id: 'memo', label: 'メモ', icon: 'memo' },
  { id: 'pen', label: 'ペン', icon: 'pen' },
  { id: 'dim', label: '寸法', icon: 'ruler' },
  { id: 'eraser', label: '消しゴム', icon: 'eraser' },
];

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* 既定値を使う */ }
  const d = {
    tool: 'view', color: '#e53935', cameraMode: 'position',
    penWidth: PEN_WIDTHS[1].value, highlighter: false, hlWidth: HL_WIDTHS[1].value,
    dimFields: ['L'],
    layers: { photo: true, memo: true, stroke: true, dim: true, room: true },
  };
  const r = { ...d, ...s };
  r.layers = { ...d.layers, ...(s.layers || {}) };
  if (!Array.isArray(r.dimFields) || !r.dimFields.length) r.dimFields = ['L'];
  return r;
}

export class EditorScreen {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.settings = loadSettings();
    this.store = null;
    this.viewer = null;
    this.source = null;
    this.drawingId = null;
    this.pageIndex = 0;
    this.viewMemory = new Map();
    this.tools = {};
    this._build();

    const flush = () => this.store && this.store.flush();
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);
    document.addEventListener('keydown', (e) => this._onKey(e));
  }

  // ---- 画面構築 ----

  _build() {
    this.el = {};
    const e = this.el;
    e.title = h('button', { class: 'title-btn', onclick: () => this.projectSettings() });
    e.drawingBtn = h('button', { class: 'drawing-btn', onclick: () => this.drawingMenu() });
    e.prev = h('button', { class: 'icon-btn', 'aria-label': '前のページ', onclick: () => this.gotoPage(this.pageIndex - 1) }, icon('prev'));
    e.pageLabel = h('span', { class: 'page-label' });
    e.next = h('button', { class: 'icon-btn', 'aria-label': '次のページ', onclick: () => this.gotoPage(this.pageIndex + 1) }, icon('next'));
    e.pager = h('div', { class: 'pager' }, e.prev, e.pageLabel, e.next);
    e.undo = h('button', { class: 'icon-btn', 'aria-label': '元に戻す', onclick: () => this.store.undo() }, icon('undo'));
    e.redo = h('button', { class: 'icon-btn', 'aria-label': 'やり直す', onclick: () => this.store.redo() }, icon('redo'));
    e.layers = h('button', { class: 'icon-btn layers-btn', 'aria-label': '表示切替', onclick: () => this.layersDialog() }, icon('eye'));
    e.saveState = h('span', { class: 'save-state muted small' });

    e.stage = h('div', { class: 'stage' });
    e.empty = h('div', { class: 'stage-empty', hidden: true },
      h('p', {}, '図面がありません'),
      h('button', { class: 'btn primary', onclick: () => this.addDrawing() }, '図面を追加（PDF・JPG・PNG）'));
    e.subbar = h('div', { class: 'subbar' });
    e.toolbar = h('nav', { class: 'toolbar' }, TOOLS.map((t) =>
      h('button', { class: 'tool-btn', 'data-tool': t.id, onclick: () => this.setTool(t.id) }, icon(t.icon), h('span', {}, t.label))));

    this.root.replaceChildren(
      h('header', { class: 'topbar editor-top' },
        h('button', { class: 'icon-btn', 'aria-label': 'プロジェクト一覧へ', onclick: () => this.close() }, icon('back')),
        h('div', { class: 'title-wrap' }, e.title, e.drawingBtn),
        h('div', { class: 'spacer' }),
        e.pager,
        e.saveState,
        e.undo, e.redo, e.layers,
        h('button', { class: 'icon-btn', 'aria-label': '全体表示', onclick: () => this.viewer.fit() }, icon('fit')),
        h('button', { class: 'icon-btn', 'aria-label': 'メニュー', onclick: () => this.menu() }, icon('more'))),
      e.stage, e.empty, e.subbar, e.toolbar);

    this.viewer = new Viewer(e.stage);
    this.viewer.layers = this.settings.layers;
    this.viewer.objectSource = () => (this.store
      ? this.store.project.objects.filter((o) => o.drawingId === this.drawingId && o.page === this.pageIndex) : []);
    this.viewer.roomSource = () => (this.store
      ? this.store.project.rooms.filter((r) => r.drawingId === this.drawingId && r.page === this.pageIndex) : []);
    this.viewer.onViewChange = (v) => {
      if (this.drawingId) this.viewMemory.set(`${this.drawingId}:${this.pageIndex}`, { ...v });
    };
    this.target = drawingTarget(this.viewer);

    const ctx = this._toolContext();
    this.tools = {
      view: new ViewTool(ctx),
      select: new SelectTool(ctx),
      camera: new CameraTool(ctx),
      room: new RoomTool(ctx),
      memo: new MemoTool(ctx),
      pen: new PenTool(ctx),
      dim: new DimTool(ctx),
      eraser: new EraserTool(ctx),
    };
    this._updateLayersIcon();
  }

  /** ツール・ダイアログに渡す操作窓口 */
  _toolContext() {
    const self = this;
    const ctx = {
      get store() { return self.store; },
      get viewer() { return self.viewer; },
      get settings() { return self.settings; },
      get target() { return self.target; },
      saveSetting: (k, v) => this._set(k, v),
      toast,
      openPhoto: (p) => openPhotoViewer(ctx, p),
      openMemo: (m) => openMemo(ctx, m),
      createMemo: (x, y) => editMemo(ctx, null, { x, y }),
      openDim: (d) => editDim(ctx, d),
      createDim: (d) => editDim(ctx, d, { isNew: true }),
      capturePhoto: (t) => { requestPersist(); capturePhoto(ctx, t); },
      openRoom: (r) => this.roomMenu(r),
      createRoom: (poly) => this.createRoom(poly),
      deleteWithConfirm: (items) => deleteWithConfirm(this.store, this.target, items),
      onToolStateChange: () => this._renderSubbar(),
    };
    return ctx;
  }

  _set(k, v) {
    this.settings[k] = v;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* 無視 */ }
  }

  // ---- プロジェクト ----

  async open(projectId) {
    const project = await db.getProject(projectId);
    if (!project) throw new Error('プロジェクトが見つかりません');
    normalizeProject(project);
    this.store = new ProjectStore(project);
    this.store.addEventListener('change', () => this._onStoreChange());
    this.store.addEventListener('saved', () => { this.el.saveState.textContent = ''; });
    this.store.addEventListener('saveerror', (ev) => {
      this.el.saveState.textContent = '未保存';
      toast('保存に失敗しました: ' + (ev.detail && ev.detail.message));
    });
    this.store.collectGarbage().catch((e) => console.warn(e));
    this.viewMemory.clear();
    this.root.hidden = false;
    this.setTool(this.settings.tool);
    this._updateHeader();
    const first = project.drawings[0];
    if (first) await this.showDrawing(first.id, 0);
    else this._showEmpty();
  }

  async close() {
    if (this.store) await this.store.flush();
    for (const t of Object.values(this.tools)) if (t.deactivate) t.deactivate();
    if (this.source) this.source.destroy();
    this.source = null;
    this.drawingId = null;
    this.viewer.clearPage();
    this.store = null;
    this.root.hidden = true;
    this.app.showHome();
  }

  _onStoreChange() {
    this.tools.select.sync();
    this.viewer.requestRedraw();
    this._updateHeader();
    this.el.saveState.textContent = '保存中…';
  }

  _updateHeader() {
    const p = this.store && this.store.project;
    if (!p) return;
    this.el.title.textContent = p.name;
    const d = p.drawings.find((x) => x.id === this.drawingId);
    this.el.drawingBtn.textContent = d ? `${d.name} ▾` : (p.drawings.length ? '図面を選択 ▾' : '');
    this.el.drawingBtn.hidden = !p.drawings.length;
    const n = d ? d.pages.length : 0;
    this.el.pager.hidden = n <= 1;
    this.el.pageLabel.textContent = `${this.pageIndex + 1}/${n}`;
    this.el.prev.disabled = this.pageIndex <= 0;
    this.el.next.disabled = this.pageIndex >= n - 1;
    this.el.undo.disabled = !this.store.canUndo();
    this.el.redo.disabled = !this.store.canRedo();
  }

  _showEmpty() {
    this.el.empty.hidden = false;
    this.viewer.clearPage();
    this._updateHeader();
  }

  // ---- 図面 ----

  async showDrawing(drawingId, pageIndex = 0) {
    const d = this.store.project.drawings.find((x) => x.id === drawingId);
    if (!d) return;
    this.el.empty.hidden = true;
    this.tools.room.clear();
    this.tools.select.clear();
    if (this.drawingId !== drawingId || !this.source) {
      const b = busy('図面を開いています…');
      try {
        const blob = await db.getBlob(this.store.project.id, d.blobRef);
        if (!blob) throw new Error('図面ファイルが見つかりません');
        if (this.source) this.source.destroy();
        this.source = await openSource(blob, d.type);
        this.drawingId = drawingId;
      } catch (e) {
        console.error(e);
        alertDialog(`図面を開けませんでした。\n${e.message || e}`);
        return;
      } finally {
        b.close();
      }
    }
    this.pageIndex = Math.max(0, Math.min(pageIndex, this.source.pages.length - 1));
    await this.viewer.setPage(this.source, drawingId, this.pageIndex,
      this.viewMemory.get(`${drawingId}:${this.pageIndex}`));
    this._updateHeader();
  }

  gotoPage(i) {
    if (!this.source || i < 0 || i >= this.source.pages.length) return;
    this.showDrawing(this.drawingId, i);
  }

  async addDrawing() {
    const file = await pickFile({ accept: 'application/pdf,.pdf,image/jpeg,image/png' });
    if (!file) return;
    const type = detectType(file);
    if (!type) { alertDialog('PDF・JPG・PNG のファイルを選んでください'); return; }
    const b = busy('図面を読み込んでいます…');
    let drawing;
    try {
      const pages = await analyze(file, type);
      const blobRef = uid();
      await db.putBlob(this.store.project.id, blobRef, file, { kind: 'drawing', mime: file.type, fileName: file.name });
      drawing = {
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        type,
        blobRef,
        pages: pages.map((p) => ({ width: Math.round(p.width * 100) / 100, height: Math.round(p.height * 100) / 100 })),
      };
      this.store.mutate((p) => { p.drawings.push(drawing); }, { undoable: false });
      requestPersist();
    } catch (e) {
      console.error(e);
      alertDialog(`図面を読み込めませんでした。\n${e.message || e}`);
      return;
    } finally {
      b.close();
    }
    await this.showDrawing(drawing.id, 0);
  }

  async drawingMenu() {
    const p = this.store.project;
    const v = await modal({
      title: '図面',
      className: 'modal-narrow',
      body: h('div', { class: 'menu-list' },
        p.drawings.map((d) => h('div', { class: 'drawing-row' },
          h('button', { class: 'menu-item' + (d.id === this.drawingId ? ' on' : ''), 'data-open': d.id },
            d.name, h('span', { class: 'muted small' }, `　${d.type === 'pdf' ? 'PDF' : '画像'}・${d.pages.length}ページ`)),
          h('button', { class: 'icon-btn', 'aria-label': '図面のメニュー', 'data-menu': d.id }, '⋯'))),
        h('button', { class: 'menu-item accent', 'data-add': '1' }, '＋ 図面を追加')),
      onOpen: (box, close) => {
        box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => close({ open: b.dataset.open })));
        box.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', () => close({ menu: b.dataset.menu })));
        box.querySelector('[data-add]').addEventListener('click', () => close({ add: true }));
      },
    });
    if (!v) return;
    if (v.open) this.showDrawing(v.open, v.open === this.drawingId ? this.pageIndex : 0);
    else if (v.add) this.addDrawing();
    else if (v.menu) this.drawingItemMenu(v.menu);
  }

  async drawingItemMenu(id) {
    const d = this.store.project.drawings.find((x) => x.id === id);
    if (!d) return;
    const v = await modal({
      title: d.name,
      className: 'modal-narrow',
      body: h('div', { class: 'menu-list' },
        h('button', { class: 'menu-item', 'data-k': 'rename' }, '名前を変更'),
        h('button', { class: 'menu-item danger', 'data-k': 'delete' }, '図面を削除')),
      onOpen: (box, close) => box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => close(b.dataset.k))),
    });
    if (v === 'rename') {
      const name = await promptDialog('図面の名前', { value: d.name });
      if (!name) return;
      this.store.mutate((p) => { p.drawings.find((x) => x.id === id).name = name; }, { undoable: false });
    } else if (v === 'delete') {
      const p = this.store.project;
      const n = p.objects.filter((o) => o.drawingId === id).length + p.rooms.filter((r) => r.drawingId === id).length;
      const ok = await confirmDialog(
        `図面「${d.name}」を削除しますか？\nこの図面上の写真・メモ・手書き・寸法・部屋（${n}件）もすべて削除されます。\nこの操作は元に戻せません。`,
        { okLabel: '削除', danger: true });
      if (!ok) return;
      this.store.mutate((pp) => {
        pp.drawings = pp.drawings.filter((x) => x.id !== id);
        pp.objects = pp.objects.filter((o) => o.drawingId !== id);
        pp.rooms = pp.rooms.filter((r) => r.drawingId !== id);
      }, { undoable: false });
      this.store.clearHistory();
      await this.store.flush();
      this.store.collectGarbage().catch((e) => console.warn(e));
      if (this.drawingId === id) {
        if (this.source) this.source.destroy();
        this.source = null;
        this.drawingId = null;
        const next = this.store.project.drawings[0];
        if (next) this.showDrawing(next.id, 0);
        else this._showEmpty();
      }
      toast('図面を削除しました');
    }
  }

  // ---- 部屋 ----

  async createRoom(polygon) {
    const name = await promptDialog('部屋名', { placeholder: '例：事務室1', allowEmpty: true, okLabel: '登録' });
    if (name === null) { toast('部屋の登録を取り消しました'); return; }
    this.store.mutate((p) => {
      p.rooms.push({ id: uid(), drawingId: this.drawingId, page: this.pageIndex, name, polygon: polygon.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) });
    });
    toast(`部屋「${name || '名称なし'}」を登録しました`);
  }

  async roomMenu(room) {
    const count = this.store.project.objects.filter((o) => o.roomId === room.id).length;
    const v = await modal({
      title: room.name || '（名称なし）',
      className: 'modal-narrow',
      body: h('div', { class: 'form' },
        h('div', { class: 'muted small' }, `この部屋の写真：${count}枚`),
        h('div', { class: 'menu-list' },
          h('button', { class: 'menu-item', 'data-k': 'rename' }, '名前を変更'),
          h('button', { class: 'menu-item danger', 'data-k': 'delete' }, '部屋を削除'))),
      onOpen: (box, close) => box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => close(b.dataset.k))),
    });
    if (v === 'rename') {
      const name = await promptDialog('部屋名', { value: room.name, allowEmpty: true });
      if (name === null) return;
      const rename = count > 0 && await confirmDialog(
        `この部屋の写真（${count}枚）の部屋名も「${name || '空欄'}」に変更しますか？`,
        { okLabel: '変更する', title: '写真の部屋名' });
      this.store.mutate((p) => {
        p.rooms.find((r) => r.id === room.id).name = name;
        if (rename) for (const o of p.objects) if (o.roomId === room.id) o.roomName = name;
      });
    } else if (v === 'delete') {
      deleteWithConfirm(this.store, this.target, [room]);
    }
  }

  // ---- ツール ----

  setTool(id) {
    if (!this.tools[id]) id = 'view';
    const prev = this.tools[this.settings.tool];
    if (prev && prev !== this.tools[id] && prev.deactivate) prev.deactivate();
    this._set('tool', id);
    this.viewer.tool = this.tools[id];
    this.viewer.resetGesture();
    for (const b of this.el.toolbar.querySelectorAll('.tool-btn')) b.classList.toggle('on', b.dataset.tool === id);
    this._renderSubbar();
  }

  _renderSubbar() {
    const id = this.settings.tool;
    const sb = this.el.subbar;
    const set = (k, v) => this._set(k, v);
    let content = [];
    if (id === 'view') {
      content = [h('span', { class: 'hint' }, 'タップで開く／長押しで削除／ドラッグで移動／2本指で拡大・縮小')];
    } else if (id === 'select') {
      const sel = this.tools.select;
      content = sel.count
        ? [
          h('span', { class: 'hint strong' }, `${sel.count}件選択`),
          colorPicker(this.settings.color, (c) => { set('color', c); this.applyColorToSelection(c); }),
          h('button', { class: 'btn small danger', onclick: () => this.deleteSelection() }, '削除'),
          h('button', { class: 'btn small', onclick: () => sel.clear() }, '解除'),
          h('span', { class: 'hint' }, '枠内をドラッグで移動'),
        ]
        : [h('span', { class: 'hint' }, '指でなぞって囲むと選択（完全に囲まれたもの）／タップで1つ選択')];
    } else if (id === 'camera') {
      const seg = segmented([['position', '位置指定'], ['room', '部屋指定']], this.settings.cameraMode, (v) => {
        set('cameraMode', v);
        this.viewer.resetGesture();
        this._renderSubbar();
      });
      content = [seg, h('span', { class: 'hint' }, this.settings.cameraMode === 'room'
        ? '部屋をタップして撮影'
        : '撮影位置をタップ（ドラッグで方向を指定）')];
    } else if (id === 'room') {
      const n = this.tools.room.draft.length;
      content = n
        ? [
          h('span', { class: 'hint' }, `${n}点　始点をタップで閉じる`),
          h('button', { class: 'btn small', onclick: () => this.tools.room.undoPoint() }, '1点戻す'),
          h('button', { class: 'btn small', onclick: () => this.tools.room.clear() }, '取消'),
          h('button', { class: 'btn small primary', disabled: n < 3, onclick: () => this.tools.room.finish() }, '確定'),
        ]
        : [h('span', { class: 'hint' }, '部屋の角を順にタップして範囲を登録／登録済みの部屋をタップで名前変更・削除')];
    } else if (id === 'memo') {
      content = [colorPicker(this.settings.color, (c) => set('color', c)), h('span', { class: 'hint' }, 'メモを置く位置をタップ')];
    } else if (id === 'pen') {
      content = penOptions(this.settings, set);
    } else if (id === 'dim') {
      const fields = this.settings.dimFields;
      const wrap = h('div', { class: 'dim-toggles' });
      for (const f of DIM_FIELDS) {
        wrap.appendChild(toggleButton(DIM_LABEL[f], fields.includes(f), () => {
          set('dimFields', toggleDimField(this.settings.dimFields, f));
          this.viewer.resetGesture();
          this._renderSubbar();
        }));
      }
      const shape = this.tools.dim.shape;
      const hint = { line: '始点から終点へドラッグ', rect: '対角にドラッグ（矩形）', circle: '中心から外へドラッグ（円）', point: '位置をタップ' }[shape];
      content = [wrap, colorPicker(this.settings.color, (c) => set('color', c)), h('span', { class: 'hint' }, hint)];
    } else if (id === 'eraser') {
      content = [h('span', { class: 'hint' }, '手書きの線をなぞって消す（写真・メモ・寸法は消えません）')];
    }
    sb.replaceChildren(...content);
  }

  applyColorToSelection(color) {
    const sel = this.tools.select;
    const ids = new Set(sel.objIds);
    const n = this.store.project.objects.filter((o) => ids.has(o.id) && ['memo', 'stroke', 'dim'].includes(o.type)).length;
    if (!n) { toast('色を変えられるもの（メモ・手書き・寸法）が選択されていません'); return; }
    this.store.mutate((p) => {
      for (const o of p.objects) if (ids.has(o.id) && ['memo', 'stroke', 'dim'].includes(o.type)) o.color = color;
    });
  }

  async deleteSelection() {
    const sel = this.tools.select;
    const items = [...sel.selectedObjects(), ...sel.selectedRooms()];
    if (await deleteWithConfirm(this.store, this.target, items)) sel.clear();
  }

  // ---- 表示切替 ----

  async layersDialog() {
    const layers = this.settings.layers;
    const rows = LAYERS.map((l) => {
      const cb = h('input', { type: 'checkbox', checked: layers[l.id] !== false });
      cb.addEventListener('change', () => {
        layers[l.id] = cb.checked;
        this._set('layers', layers);
        this.viewer.layers = layers;
        this.tools.select.clear();
        this.viewer.requestRedraw();
        this._updateLayersIcon();
      });
      return h('label', { class: 'switch-row' }, h('span', {}, l.label), cb);
    });
    await modal({
      title: '表示切替',
      className: 'modal-narrow',
      body: h('div', { class: 'form' }, ...rows,
        h('div', { class: 'muted small' }, '非表示のものはタップ・選択・消しゴムの対象になりません。')),
      buttons: [
        {
          label: 'すべて表示',
          onClick: () => {
            for (const l of LAYERS) layers[l.id] = true;
            for (const r of rows) r.querySelector('input').checked = true;
            this._set('layers', layers);
            this.viewer.layers = layers;
            this.viewer.requestRedraw();
            this._updateLayersIcon();
          },
        },
        { label: '閉じる', kind: 'primary', value: null },
      ],
    });
  }

  _updateLayersIcon() {
    const hidden = LAYERS.some((l) => this.settings.layers[l.id] === false);
    this.el.layers.classList.toggle('badge', hidden);
    this.el.layers.setAttribute('aria-label', hidden ? '表示切替（非表示あり）' : '表示切替');
  }

  // ---- メニュー ----

  async menu() {
    const items = [
      ['addDrawing', '図面を追加'],
      ['drawings', '図面の切替・名前変更・削除'],
      ['layers', '表示切替'],
      ['settings', 'プロジェクト設定'],
      ['outPdf', '図面PDFを出力'],
      ['outLedger', '写真台帳（Excel）を出力'],
      ['outMemo', 'メモ一覧（Excel）を出力'],
      ['export', '書き出し（.zip）'],
      ['about', 'このアプリについて'],
    ];
    const v = await modal({
      title: 'メニュー',
      className: 'modal-narrow',
      body: h('div', { class: 'menu-list' }, items.map(([k, l]) => h('button', { class: 'menu-item', 'data-k': k }, l))),
      onOpen: (box, close) => box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => close(b.dataset.k))),
    });
    if (v === 'addDrawing') this.addDrawing();
    else if (v === 'drawings') this.drawingMenu();
    else if (v === 'layers') this.layersDialog();
    else if (v === 'settings') this.projectSettings();
    else if (v === 'export') {
      await this.store.flush();
      exportWithDialog(this.store.project.id);
    } else if (v === 'outPdf') {
      outputPdfDialog(this.store.project, this.settings.layers, { drawingId: this.drawingId, pageIndex: this.pageIndex });
    } else if (v === 'outLedger') {
      outputLedgerDialog(this.store.project);
    } else if (v === 'about') {
      showAbout();
    } else if (v === 'outMemo') {
      outputMemoListDialog(this.store.project);
    }
  }

  async projectSettings() {
    const p = this.store.project;
    const name = h('input', { type: 'text', class: 'input', value: p.name });
    const numbering = h('select', { class: 'input' },
      h('option', { value: 'sequential', selected: p.settings.photoNumbering === 'sequential' }, 'プロジェクト通し番号（001, 002, …）'),
      h('option', { value: 'daily', selected: p.settings.photoNumbering === 'daily' }, '日付ごと（20261112-001, …）'));
    const v = await modal({
      title: 'プロジェクト設定',
      body: h('div', { class: 'form' },
        h('label', { class: 'label' }, 'プロジェクト名'), name,
        h('label', { class: 'label' }, '写真番号'), numbering,
        h('div', { class: 'muted small' }, '番号の付け方を変えると、これから撮る写真に適用されます。撮影済みの番号は変わりません。')),
      buttons: [{ label: 'キャンセル', value: null }, { label: '保存', kind: 'primary', value: 'ok' }],
    });
    if (v !== 'ok') return;
    this.store.mutate((pp) => {
      if (name.value.trim()) pp.name = name.value.trim();
      pp.settings.photoNumbering = numbering.value;
    }, { undoable: false });
  }

  _onKey(e) {
    if (this.root.hidden || !this.store) return;
    if (document.querySelector('.modal-backdrop')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.store.redo(); else this.store.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.store.redo();
    } else if (e.key === 'Escape') {
      if (this.settings.tool === 'room') this.tools.room.clear();
      if (this.settings.tool === 'select') this.tools.select.clear();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.settings.tool === 'select' && this.tools.select.count) {
      e.preventDefault();
      this.deleteSelection();
    }
  }
}
