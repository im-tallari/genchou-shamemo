# 現地調査（仮称）

スマホ・タブレットで平面図を開き、写真・メモ・手書きを図面上に記録する現地調査用 Web ツール（PWA）。
サーバーは使わず、データはすべて端末内（IndexedDB）に保存します。

## 実装範囲

### 第1段階

- プロジェクト管理（作成・名前変更・削除）
- 図面の表示（PDF・JPG・PNG、複数図面・複数ページ、ピンチ拡大／2本指パン／ホイール拡大）
- カメラ
  - 位置指定：タップで撮影位置、ドラッグで方向矢印
  - 部屋指定：登録済みの部屋をタップして撮影
  - 写真番号：プロジェクト通し番号／日付ごと（プロジェクト設定で選択）
  - 写真ビューアー：部屋名の変更・撮り直し・削除
- 部屋：角をタップして多角形で登録、名前変更・削除
- メモ：キーボード入力と手書き。図面上は1行目を省略表示し、タップで全文表示
- ペン（4段階の太さ、プリセット6色＋任意色）、消しゴム（ペンの線のみ）
- 元に戻す／やり直す（20回）
- .zip の書き出し／読み込み
- PWA（オフライン動作、ホーム画面への追加の案内、`navigator.storage.persist()`）

### 第2段階
- 蛍光ペン：ペンの「蛍光」オンで半透明（不透明度35%）。太さは専用の4段階。普通の線より下に描画
- 寸法：L・W・D・H・φ をそれぞれオン／オフ
  - L → 線（始点→終点、水平・垂直に吸着）／W・D → 矩形（対角ドラッグ）／φ → 円（中心→外）／H のみ → 点（タップ）
  - L・W/D・φ は排他、H はどれとも併用可。数値は mm、空欄可
  - 文字は図面に固定した大きさ（A3上で約2.5mm）で、拡大・縮小に連動
- 範囲選択：投げ縄で囲む（完全に入ったもの）／タップで1つ選択。枠内ドラッグで移動、色変更、削除
- 長押し（表示ツール）：1つ選んで削除
- 表示切替：写真ピン・メモ・手書き・寸法・部屋範囲（端末ごとに保存）。非表示のものはタップ・選択・消しゴムの対象外
- 写真への書き込み：写真ビューアーで拡大・移動、「書き込み」でペン（蛍光含む）・メモ・消しゴム。元画像は残し、書き込みは別データ。書き込みのある写真はピンに印

### 第3段階
- メモ番号：作成時にプロジェクト通し番号（M001, M002, …）を付ける。削除しても詰めない。画面の吹き出しにも表示
- 図面PDF（「⋯」→「図面PDFを出力」）
  - 出力するページを選択。表示切替で非表示のものは出力しない
  - PDF図面はページをベクターのまま埋め込み、書き込みは透明画像（最大300dpi相当）にして重ねる
  - 画像図面は A3 に縦横比を保って収める
  - ピン・番号札・部屋名は A3 でピンの高さ約4mm（他の用紙は比例）
  - メモは図面上に番号だけを表示し、本文は「メモ一覧（Excel）」に出力（同時出力を選べる）
- 写真台帳（Excel、暫定様式）：番号・部屋名・書き込み（有／無）・写真・撮影日時・図面名
  - 写真は1セルに1枚（長辺1200pxに縮小）、A4縦・見出し行を各ページに印刷
  - 書き込みのある写真は「合成画像」か「元画像」を出力時に選択
- メモ一覧（Excel）：番号・図面名・ページ・部屋名（メモの位置の部屋）・本文・手書き（画像）

## フォルダ構成

```
index.html              画面の入れ物
manifest.webmanifest    PWA 設定
sw.js                   Service Worker（オフライン用キャッシュ）
css/app.css             スタイル
js/
  main.js               起動・画面切替・Service Worker 登録
  db.js                 IndexedDB（projects / blobs）
  model.js              データモデル・写真番号・幾何計算
  project-store.js      編集中プロジェクトの状態・自動保存・元に戻す
  drawing-source.js     図面の読み込みと描画（PDF.js / 画像）
  viewer.js             図面キャンバス（表示・ズーム・オブジェクト描画・入力）
  tools.js              各ツール（表示・選択・カメラ・部屋・メモ・ペン・寸法・消しゴム）
  targets.js            書き込み先（図面 / 写真）の切替
  image.js              写真の縮小（長辺 2560px / JPEG 0.85）
  zip.js                .zip 書き出し／読み込み
  export/               出力（pdf.js：図面PDF / excel.js：写真台帳・メモ一覧 / render.js：出力用画像 / lazy.js：ライブラリ遅延読み込み）
  ui/                   画面とダイアログ（home / editor / photo / memo / dim / delete / output / tool-options / install / dialogs / icons）
icons/                  アプリアイコン
vendor/                 外部ライブラリ（PDF.js 4.10.38 legacy build、JSZip 3.10.1、pdf-lib 1.17.1、ExcelJS 4.4.0）
scripts/gen-precache.mjs  sw.js のキャッシュ対象リストを更新するスクリプト
```

ビルドは不要です。静的ファイルをそのまま配信します。

## ローカルで動かす

```bash
python3 -m http.server 8000
```

ブラウザで http://localhost:8000/ を開きます。カメラ撮影と Service Worker は https または localhost でのみ動作します。

## ファイルを変更したとき

アプリのファイルを追加・変更したら、公開前に次を実行して `sw.js` を更新してください（キャッシュの更新に必要です）。

```bash
node scripts/gen-precache.mjs
```

## GitHub Pages で公開

リポジトリの Settings → Pages で、Source を「Deploy from a branch」、Branch を `main` / `(root)` にします。

## データ形式

- プロジェクトの JSON（`project.json`）は仕様書 7章のモデルに準拠。追加フィールド：
  - `counters`：写真番号の採番カウンタ（削除しても番号は再利用しない）
  - `drawings[].pages`：各ページの大きさ（図面座標。PDF はポイント、画像はピクセル）
  - `Memo.handwriting`：`{ width, height, strokes: [{ points, width }] }`（手書きパッドの座標）
  - `Photo.width / height`：保存した写真の画素数
  - `Memo.number`：メモ番号（図面上のメモのみ。写真上のメモには付けない）
  - `counters.memo`：メモ番号の採番カウンタ
  - `Photo.annotations`：写真への書き込み（Stroke / Memo、座標は写真の画素）
  - `Stroke.highlight`：蛍光ペンなら true
  - `Dimension`：仕様書の `kind` の代わりに次の形で保持
    `{ shape: 'line'|'rect'|'circle'|'point', p1, p2, fields: ['L'|'W'|'D'|'H'|'phi', ...], values: { L?, W?, D?, H?, phi? }, color }`
    （rect は p1・p2 が対角、circle は p1 が中心で p2 が円周上の点）
- 座標はすべて図面座標系（ページの左上が原点、ズームに依存しない）
- zip：`project.json`、`drawings/<id>.<拡張子>`、`photos/<id>.jpg`

## 使用ライブラリ

- [PDF.js](https://github.com/mozilla/pdf.js)（Apache License 2.0）
- [JSZip](https://github.com/Stuk/jszip)（MIT / GPLv3）
- [pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）
- [ExcelJS](https://github.com/exceljs/exceljs)（MIT）
