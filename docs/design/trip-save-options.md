# アプリ無しで開ける旅の残し方（Spike #359 の結果）

親 PBI: #356。元要望: #354（より良い保存方法の検討）。

この文書は、スマホだけで旅行を使う利用者が、旅の記録を「このアプリが無くても開ける形」で手元に残す方法を比べて決めた Spike の成果物。「採用」「不採用」の節には番号を付けていない（Task #359 の検証が `^## 採用` / `^## 不採用` の見出しを探すため）。実装はしていない。対応状況は 2026-10-01 時点の一次資料による。**実機（iPhone / Android / LINE）では確かめていない**。手元で確かめたのは Linux の headless Chromium（幅 375px）で開いた、書き出しの HTML の表示と PDF への印刷だけ（§3）。

## 0. 結論

- **採用**: 旅程のページ（今の ZIP の `index.html` と同じ中身）を、ZIP を介さずに 1 ファイルで残す。共有シートにファイルを渡せるブラウザでは共有シートへ（iPhone の「ファイルに保存」、LINE、メールなど）、渡せないブラウザではファイルとしてダウンロードする。実装は別の PBI（§4）
- 今の 2 つ（Markdown のコピー、ZIP）は残す。Markdown は軽いテキスト、ZIP は全部の控え（`trip.json` を含む）という役目が、HTML 1 ファイルとは重ならない
- PDF は保存の手段を足さない。HTML 1 ファイルを開いて OS の印刷・共有から PDF にすればよい（「不採用」）
- テキストの共有（Web Share の `text`）と `calendar.ics` 単体は採らない（「不採用」）

## 1. 今の経路

- 「旅を保存」の画面（`src/client.ts` の `saveModal`）から「Markdown をコピー」（全員）と「ZIP を保存」（owner / editor）を選ぶ。`docs/ephemeral-trip-capsule.md` の §3.2 のとおり
- ZIP は `GET /v1/c/:id/export`。中身は `src/export.ts` の `exportFiles` で、その旅行の Spec の `exports` にあるものだけが入る: `README.md`（Markdown）、`trip.json`（データの控え）、`calendar.ics`（決定した予定のうち時刻のあるもの）、`index.html`（旅程のページ）と `manifest.json`
- Markdown のコピーは `GET /v1/c/:id/export.md`（`{ text }`）を `navigator.clipboard.write` に渡す。中身は ZIP の `README.md` と同じ
- `index.html` は JavaScript を持たず（`<script>` 0 個）、CSP の `<meta>` で外部の読み込みを止めている。1 ファイルで完結し、オフラインで開ける。場所の公開 URL（`place.publicUrl`）はリンクとして残る

### 1.1 重さ（実測）

`bun -e` で `testTrip()`（予定 3 件）と、それを 32 件（4 日 × 8 件ほど、説明文と全体のメモ付き）に増やした旅程を `exportFiles` に通した（単位はバイト）。カプセルの ID は Host が作るのと同じ 32 桁の 16 進にした（ID は `calendar.ics` の UID と `manifest.json` に入るので、短い ID では小さく出る）。

| 旅程 | README.md | trip.json | calendar.ics | index.html | ZIP（全部） |
|---|---|---|---|---|---|
| `testTrip()`（3 件） | 690 | 3,047 | 439 | 1,534 | 6,710 |
| 32 件 | 10,831 | 19,150 | 8,782 | 12,285 | 52,048 |
| 32 件の HTML を Chromium で印刷した PDF（A4） | — | — | — | — | 186,537（10 ページ） |

どれも通信量としては軽い。重さで差が出るのは PDF（HTML の約 15 倍）だけ。

## 2. 比べた表

対応の列は、MDN が表示する互換性データ（[@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) 8.1.4、2026-10-01 取得）の版。LINE のアプリ内ブラウザは、LINE が中身のエンジンを公開していないので、iOS は WKWebView（BCD の `webview_ios`）、Android は Android WebView（`webview_android`）として読んだ値で、**どれも実機未確認**。LINE は URL に `openExternalBrowser=1` を付けると外部のブラウザで開ける（[LINE Developers: Opening a URL in an external browser](https://developers.line.biz/en/docs/line-login/using-line-url-scheme/#opening-url-in-external-browser)）。

| 候補 | スマホだけで保存できるか | アプリ無しで開けるか | 重さ（32 件） | 失うもの | iOS Safari | Android Chrome | LINE のアプリ内ブラウザ |
|---|---|---|---|---|---|---|---|
| 今の ZIP | 保存はできる（ダウンロード）。開くにはファイルのアプリで展開が要る | 展開すれば開ける（`index.html` はブラウザ、`README.md` はメモ）。展開の手順がスマホでは分かりにくい（#354） | 52 KB | なし（全部入る。`trip.json` で控えになる） | `<a download>` は 13 から（[MDN: a の download](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#download)）。「ファイル」アプリでの展開は実機未確認 | `<a download>` は 18 から（同）。ファイルマネージャでの展開は実機未確認 | 実機未確認（出典: 同じ MDN。Android WebView のダウンロードはアプリ側の処理しだい） |
| Markdown のコピー（#355） | できる（クリップボード → メモ・LINE に貼る） | 開ける（テキスト） | 11 KB | 見た目（日ごとの区切りの見た目、カード）、カレンダーへの取り込み、`trip.json` の控え。場所のリンクは `[名前](URL)` の文字として残る | `Clipboard.write` / `ClipboardItem` は 13.4 から（[MDN: Clipboard.write](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write)）。今の実装が動くことは #355 で確認済み | `Clipboard.write` は 76、`ClipboardItem` は 84 から（同） | iOS は 13.4 から、Android WebView は `Clipboard.write` が 76・`ClipboardItem` が 84 から（同。今の実装は `ClipboardItem` を使う）。実機未確認。書けないときは本文を全部選んだ欄を出す（今の実装） |
| Web Share（ファイル共有） | できる（共有シートから「ファイルに保存」・LINE・メール） | 渡すファイルしだい。共有できるのは HTML・テキスト・PDF・画像など（[MDN: Shareable file types](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share#shareable_file_types)）。**ZIP・`.md`・`.ics` は一覧に無い** | 渡すファイルと同じ | ZIP を渡せないので、渡すのは 1 ファイル（HTML なら下の行と同じ） | `navigator.share` は 12.2、ファイル付きは 14 から（[MDN: Navigator.share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)、[MDN: Navigator.canShare](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/canShare)）。タップの直後に呼ぶ必要がある（transient activation、同） | ファイル付きは 76 から（同、[web.dev: Web Share API](https://web.dev/articles/web-share)） | iOS（WKWebView）は 14 から、**Android WebView は無し**（同）。実機未確認 |
| Web Share（テキスト共有） | できる（共有シートからメモ・LINE へ） | 開ける（テキスト） | 11 KB（Markdown と同じ） | Markdown のコピーと同じ | 12.2 から（[MDN: Navigator.share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)） | 61 から（同） | iOS は 12.2 から、**Android WebView は無し**（同）。実機未確認 |
| HTML 1 ファイル（ZIP を介さない `index.html`） | できる（ダウンロード、または上のファイル共有） | 開ける（ブラウザ。JavaScript 無しで 375px に収まることを手元の Chromium で確認、§3）。「ファイル」アプリやファイルマネージャから開けるかは実機未確認 | 12 KB | `trip.json` の控え、カレンダーへの取り込み | `<a download>` は 13 から（[MDN: a の download](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#download)）。ファイル共有は 14 から（[MDN: Navigator.canShare](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/canShare)）。保存先から開けるかは実機未確認 | `<a download>` は 18 から（同）、ファイル共有は 76 から（同）。実機未確認 | iOS はどちらも使える版（同）。Android WebView は共有が無く、ダウンロードはアプリ側の処理しだい。実機未確認 |
| 印刷からの PDF | できる（OS の印刷から PDF に保存） | 開ける（PDF。どの端末でも開ける） | 187 KB（10 ページ） | リンクを押せるかは PDF を開くアプリしだい。カレンダーへの取り込み、`trip.json` の控え。旅程が変わったら作り直し | `window.print` は 1 から（[MDN: Window.print](https://developer.mozilla.org/en-US/docs/Web/API/Window/print)）。印刷の画面から PDF を「ファイル」に保存できるかは実機未確認 | 18 から（同）。「PDF として保存」は実機未確認 | iOS は 1、Android WebView は 4.4 から（同）。アプリ内ブラウザで印刷の画面が出るかは実機未確認 |
| `calendar.ics` 単体 | できる（ダウンロード） | カレンダーに取り込める。ただし入るのは**決定した、時刻のある予定だけ** | 9 KB | 候補・時刻の無い予定・準備・費用メモ・メモ・思い出のすべて | `<a download>` は 13 から（[MDN: a の download](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#download)）。ダウンロードした `.ics` をカレンダーに取り込めるかは実機未確認 | 18 から（同）。取り込みは実機未確認 | 実機未確認（出典: 同じ MDN。`.ics` は共有できるファイルの一覧に無い（[MDN: Shareable file types](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share#shareable_file_types)）） |

## 採用

**HTML 1 ファイル（旅程のページ）を、共有シートに渡せればファイル共有で、渡せなければダウンロードで残す。**

- 「アプリ無しで開ける」を一番よく満たす: 見た目（日ごとの区切り、決定・候補の別、時刻）と場所のリンクが残り、ブラウザだけで開ける。JavaScript を持たず外部を読み込まないので、Host が消えても（旅行は期限で消える）開ける
- ZIP の弱点（スマホでの展開）が無い。共有シートに渡せば、iPhone では「ファイルに保存」、LINE やメールに送って残す、が 1 回のタップで済む
- 軽い（32 件で 12 KB）。中身は今の `index.html` と同じなので、新しい書式を作らない
- ファイル共有は MDN の共有できる型に HTML が入る（ZIP・`.md`・`.ics` は入らない）。共有できないブラウザ（Android WebView など）ではダウンロードに落ちる
- 残る未確認: 保存した HTML を「ファイル」アプリ（iPhone）やファイルマネージャ（Android）から開けるか、LINE のアプリ内ブラウザで共有・ダウンロードが動くか。実装の PBI の受け入れ条件で、**利用者の確認を得て実機で確かめる**

## 不採用

- **今の ZIP を変える**: 変えない。HTML 1 ファイルで「開ける控え」はまかなえ、ZIP は `trip.json` を含む全部の控えとして owner / editor に残す（#355 の決定）
- **Web Share のテキスト共有**: 足さない。中身が Markdown のコピーと同じで、得られるのは「貼る」の 1 手順が減ることだけ。Android WebView（LINE の Android など）に無いので、結局コピーの経路が要る
- **印刷からの PDF（専用のボタン）**: 足さない。PDF は HTML の 15 倍重く、旅程が変わるたびに作り直しになり、リンクを押せるかは開くアプリしだい。欲しい人は採用案の HTML を開いて、OS の印刷・共有から PDF にできる（`docs/ephemeral-trip-capsule.md` §3.2 の「必要なら `index.html` を利用者側で印刷する」のまま）
- **`calendar.ics` 単体**: 足さない。入るのは決定した時刻つきの予定だけで、旅の記録の控えにならない。カレンダーへの取り込みは ZIP の `calendar.ics` のまま
- **外部の保存サービス（Google Drive・iCloud への直接アップロード）**: 候補にしない（PBI #356 のスコープ外。アカウント不要という Host の前提から外れる）

## 3. 試したこと（手元）

- 書き出しの重さ: `bun -e` で `testTrip()` と 32 件の旅程を `exportFiles` / `zip` に通した（§1.1 の表）
- HTML 1 ファイルの表示: 32 件の `index.html` を 1 ファイルとして書き出し、Linux の headless Chromium（DevTools Protocol、幅 375px・モバイル表示）で `file://` から開いた。題が出る、`<article>` が 32 個、横幅が 375px に収まる（`scrollWidth` 375）、`<script>` は 0 個
- 印刷からの PDF: 同じページを `Page.printToPDF`（A4）にかけ、186,537 バイト・10 ページの PDF になった。`@media print` の `article{break-inside:avoid}` が効いて、予定のカードがページで切れない
- Web Share: デスクトップの Linux の Chromium には `navigator.share` が無い（`typeof navigator.share` が `undefined`）。スマホでの動きは確かめられないので、表は一次資料による
- 試すのに使ったスクリプトはリポジトリに入れていない（Spike の決まり）

## 4. 後続

- 採用案の実装は PBI #471（`## 元要望` は #354）。#471 は、中身が Markdown と同じ `document` の範囲なので全員が保存できる、Spec の `exports` では止めない、と置いた（変えるなら #471 の Task 分解の前に）。共有シートに渡すときはタップの前にファイルを用意しておく必要があること（transient activation）は、#471 の実装で扱う
