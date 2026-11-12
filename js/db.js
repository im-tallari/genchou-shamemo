// IndexedDB ラッパー
// stores:
//   projects : keyPath "id"  … プロジェクト本体（JSON）
//   blobs    : keyPath ["projectId","id"] … 図面・写真の元ファイル

const DB_NAME = 'site-survey';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        const s = db.createObjectStore('blobs', { keyPath: ['projectId', 'id'] });
        s.createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export async function listProjects() {
  const db = await open();
  const all = await reqP(db.transaction('projects').objectStore('projects').getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getProject(id) {
  const db = await open();
  return reqP(db.transaction('projects').objectStore('projects').get(id));
}

export async function putProject(project) {
  const db = await open();
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(project);
  return txDone(tx);
}

export async function deleteProject(id) {
  const db = await open();
  const tx = db.transaction(['projects', 'blobs'], 'readwrite');
  tx.objectStore('projects').delete(id);
  const idx = tx.objectStore('blobs').index('projectId');
  const keys = await reqP(idx.getAllKeys(IDBKeyRange.only(id)));
  for (const k of keys) tx.objectStore('blobs').delete(k);
  return txDone(tx);
}

export async function putBlob(projectId, id, blob, meta = {}) {
  const db = await open();
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').put({ projectId, id, blob, ...meta });
  return txDone(tx);
}

export async function getBlob(projectId, id) {
  const db = await open();
  const rec = await reqP(db.transaction('blobs').objectStore('blobs').get([projectId, id]));
  return rec ? rec.blob : null;
}

export async function getBlobRecord(projectId, id) {
  const db = await open();
  return reqP(db.transaction('blobs').objectStore('blobs').get([projectId, id]));
}

export async function listBlobIds(projectId) {
  const db = await open();
  const keys = await reqP(
    db.transaction('blobs').objectStore('blobs').index('projectId').getAllKeys(IDBKeyRange.only(projectId))
  );
  return keys.map((k) => k[1]);
}

export async function deleteBlobs(projectId, ids) {
  if (!ids.length) return;
  const db = await open();
  const tx = db.transaction('blobs', 'readwrite');
  for (const id of ids) tx.objectStore('blobs').delete([projectId, id]);
  return txDone(tx);
}

/** プロジェクトと、それが参照する Blob をまとめて保存（zip 読み込み用） */
export async function putProjectWithBlobs(project, blobs) {
  const db = await open();
  const tx = db.transaction(['projects', 'blobs'], 'readwrite');
  tx.objectStore('projects').put(project);
  for (const b of blobs) tx.objectStore('blobs').put({ projectId: project.id, ...b });
  return txDone(tx);
}
