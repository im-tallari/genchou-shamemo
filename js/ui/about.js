// 「このアプリについて」：版・著作権・ライセンス・ソースコードの案内
// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, modal } from './dialogs.js';
import { APP_NAME, APP_VERSION, COPYRIGHT, SOURCE_URL, LICENSE_URL } from '../version.js';

const THIRD_PARTY = [
  { name: 'PDF.js', version: '4.10.38', license: 'Apache License 2.0', url: 'https://github.com/mozilla/pdf.js' },
  { name: 'JSZip', version: '3.10.1', license: 'MIT または GPLv3（MIT を選択）', url: 'https://github.com/Stuk/jszip' },
  { name: 'pdf-lib', version: '1.17.1', license: 'MIT', url: 'https://github.com/Hopding/pdf-lib' },
  { name: 'ExcelJS', version: '4.4.0', license: 'MIT', url: 'https://github.com/exceljs/exceljs' },
];

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text || href);

export async function showAbout() {
  await modal({
    title: 'このアプリについて',
    body: h('div', { class: 'form about' },
      h('div', { class: 'about-name' }, APP_NAME, h('span', { class: 'muted small' }, `　バージョン ${APP_VERSION}`)),
      h('p', {}, '平面図に写真・メモ・手書き・寸法を記録する現地調査ツールです。データはこの端末の中だけに保存され、サーバーには送られません。'),
      h('div', { class: 'label' }, '著作権・ライセンス'),
      h('p', {}, COPYRIGHT),
      h('p', {},
        'このプログラムはフリーソフトウェアです。GNU Affero General Public License（AGPL）バージョン3、またはそれ以降のバージョンの条件で、再配布・改変できます。',
        '改変したものを配布したり、Web サービスとして公開したりする場合は、そのソースコードも同じ条件で公開する必要があります。'),
      h('p', {}, 'このプログラムは無保証です。詳しくはライセンス全文をご覧ください。'),
      h('p', {}, 'ライセンス全文：', link(LICENSE_URL, 'LICENSE')),
      h('p', {}, 'ソースコード：', link(SOURCE_URL)),
      h('div', { class: 'label' }, '使用しているライブラリ'),
      h('ul', { class: 'about-libs' }, THIRD_PARTY.map((l) =>
        h('li', {}, link(l.url, l.name), ` ${l.version}　${l.license}`)))),
    buttons: [{ label: '閉じる', kind: 'primary', value: null }],
  });
}
