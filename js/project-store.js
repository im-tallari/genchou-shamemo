// 編集中プロジェクトの状態・自動保存・元に戻す／やり直す

import * as db from './db.js';

const HISTORY_LIMIT = 20;
const SAVE_DELAY = 400;

export class ProjectStore extends EventTarget {
  constructor(project) {
    super();
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this._saveTimer = null;
    this._saving = Promise.resolve();
    this._dirty = false;
  }

  // 元に戻すの対象：部屋とオブジェクト
  _snapshot() {
    return JSON.stringify({ rooms: this.project.rooms, objects: this.project.objects });
  }

  _restore(snap) {
    const s = JSON.parse(snap);
    this.project.rooms = s.rooms;
    this.project.objects = s.objects;
  }

  /**
   * 変更を加える。fn 内で this.project を書き換える。
   * undoable=false の場合は履歴に積まない（設定変更など）
   */
  mutate(fn, { undoable = true } = {}) {
    const before = undoable ? this._snapshot() : null;
    const result = fn(this.project);
    if (undoable) {
      if (before === this._snapshot()) return result; // 変化なし
      this.undoStack.push(before);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this._changed();
    return result;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this._changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this._changed();
  }

  clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this.dispatchEvent(new Event('change'));
  }

  _changed() {
    this.project.updatedAt = Date.now();
    this._dirty = true;
    this.dispatchEvent(new Event('change'));
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  /** 保留中の保存を即実行 */
  flush() {
    clearTimeout(this._saveTimer);
    if (!this._dirty) return this._saving;
    this._dirty = false;
    // 保存中に次の変更が入っても順番に保存する
    const data = structuredCloneSafe(this.project);
    this._saving = this._saving
      .then(() => db.putProject(data))
      .then(() => this.dispatchEvent(new Event('saved')))
      .catch((e) => {
        console.error(e);
        this._dirty = true;
        this.dispatchEvent(new CustomEvent('saveerror', { detail: e }));
      });
    return this._saving;
  }

  /** 参照されていない Blob を削除（履歴を捨てたあとに呼ぶ） */
  async collectGarbage() {
    const used = new Set();
    for (const d of this.project.drawings) used.add(d.blobRef);
    for (const o of this.project.objects) if (o.blobRef) used.add(o.blobRef);
    // 履歴中にしか残っていない写真も消さない
    for (const s of [...this.undoStack, ...this.redoStack]) {
      for (const m of s.matchAll(/"blobRef":"([^"]+)"/g)) used.add(m[1]);
    }
    const ids = await db.listBlobIds(this.project.id);
    await db.deleteBlobs(this.project.id, ids.filter((id) => !used.has(id)));
  }
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}
