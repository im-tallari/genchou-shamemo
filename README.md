# 現地調査（仮称）

スマホ・タブレットで平面図を開き、写真・メモ・手書きを図面上に記録する現地調査用 Web ツール（PWA）。
サーバーは使わず、データはすべて端末内（IndexedDB）に保存します。

## 現在の実装範囲（第1段階）

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
  tools.js              各ツール（表示・カメラ・部屋・メモ・ペン・消しゴム）
  image.js              写真の縮小（長辺 2560px / JPEG 0.85）
  zip.js                .zip 書き出し／読み込み
  ui/                   画面とダイアログ（home / editor / photo / memo / install / dialogs / icons）
icons/                  アプリアイコン
vendor/                 外部ライブラリ（PDF.js 4.10.38 legacy build、JSZip 3.10.1）
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
- 座標はすべて図面座標系（ページの左上が原点、ズームに依存しない）
- zip：`project.json`、`drawings/<id>.<拡張子>`、`photos/<id>.jpg`

## 使用ライブラリ

- [PDF.js](https://github.com/mozilla/pdf.js)（Apache License 2.0）
- [JSZip](https://github.com/Stuk/jszip)（MIT / GPLv3）
