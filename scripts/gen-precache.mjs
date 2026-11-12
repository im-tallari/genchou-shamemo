// sw.js のキャッシュ対象リストとバージョンを更新する
// 使い方: node scripts/gen-precache.mjs
// アプリのファイルを追加・変更したら、公開前に実行してください。

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const INCLUDE = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons', 'vendor'];
const EXCLUDE = /(\.map|LICENSE[^/]*|\.md|\.d\.mts)$/;

function walk(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f), out);
  else out.push(p);
}

const files = [];
for (const i of INCLUDE) walk(join(root, i), files);
const rel = files.map((f) => relative(root, f).split(sep).join('/')).filter((f) => !EXCLUDE.test(f));

const hash = createHash('sha256');
for (const f of rel) { hash.update(f); hash.update(readFileSync(join(root, f))); }
const version = hash.digest('hex').slice(0, 12);

const list = ['./', ...rel.map((f) => './' + f)];
const block = `// <precache>\nconst VERSION = '${version}';\nconst PRECACHE = ${JSON.stringify(list, null, 1)};\n// </precache>`;
const swPath = join(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const next = sw.replace(/\/\/ <precache>[\s\S]*?\/\/ <\/precache>/, block);
writeFileSync(swPath, next);
console.log(`sw.js updated: ${list.length} files, version ${version}`);
