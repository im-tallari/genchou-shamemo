// 出力用ライブラリを必要になったときに読み込む（オフライン用キャッシュには入っている）

const loaded = new Map();

function loadScript(path) {
  if (loaded.has(path)) return loaded.get(path);
  const url = new URL(`../../${path}`, import.meta.url).href;
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => { loaded.delete(path); reject(new Error(`${path} を読み込めませんでした`)); };
    document.head.appendChild(s);
  });
  loaded.set(path, p);
  return p;
}

export async function loadPdfLib() {
  await loadScript('vendor/pdf-lib/pdf-lib.min.js');
  return window.PDFLib;
}

export async function loadExcelJS() {
  await loadScript('vendor/exceljs/exceljs.min.js');
  return window.ExcelJS;
}
