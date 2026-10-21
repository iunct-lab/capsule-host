# 足あとの地図の背景（Spike #565 の結果）

親 PBI: #563。元要望: #562（足あとの地図に道路・地名・海岸線の背景を出す）。

この文書は、MapLibre GL JS と自分で置く PMTiles で足あとの地図に背景を出すときの、画面の CSP・文字の出し方・style の層・ファイルの大きさを手元で確かめた Spike の成果物。後の Task（#566・#567・#568）はここの名前と値を使う。確かめたのは 2026-10-11、Linux の headless Chromium（幅 800px、WebGL は SwiftShader）で開いた使い捨てのページだけ。**実機（iPhone / Android）では確かめていない**。

## 0. 結論

- **CSP は今の文字列のまま足すものが無い**: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`。`worker-src` も `blob:` も要らない（§2）
- **文字は手元のフォントで描く**: style に `glyphs` を書かない。MapLibre 6.13 は `glyphs` の無い style の文字を全部ブラウザのフォントで描く（日本語・英数字・ハングル）。`localIdeographFontFamily: "sans-serif"`、層の `text-font: ["sans-serif"]`。glyph の PBF もフォントのファイルも置かない（§3）
- **style は自前の層 10 個**を、`world` と `japan` の 2 つの source に同じ関数 `mapLayers(source)` で当てる。`@protomaps/basemaps` は足さない（§4）
- **大きさ**: `map.js` 1,066,086 B（gzip 290,179 B）、`maplibre-worker.mjs` 508,314 B（gzip 143,415 B）、`map.css` 83,290 B（gzip 10,486 B）。`app.js` は今 195,993 B（gzip 57,188 B）で、地図の部品を別ファイルにすれば増えない（§5）

## 1. 試した組み合わせ

| 部品 | 版 | ライセンス |
|---|---|---|
| `maplibre-gl` | 6.13.0（npm の latest） | BSD-3-Clause |
| `pmtiles` | 4.5.0（npm の latest） | BSD-3-Clause |
| `go-pmtiles`（`pmtiles extract`。地図データを作る道具で、リポジトリには入れない） | 1.31.2 | BSD-3-Clause |
| 地図データ | `https://build.protomaps.com/20261011.pmtiles`（Protomaps Basemap 4.15.2、OpenStreetMap 由来、ODbL） | ODbL（画面に「© OpenStreetMap contributors」） |

地図データは作業ディレクトリ（`mktemp -d`）に切り出した:

```bash
pmtiles extract https://build.protomaps.com/20261011.pmtiles japan.pmtiles --bbox=130.30,33.50,130.50,33.65 --maxzoom=15   # 15 MB、38 回の要求、7 秒
pmtiles extract https://build.protomaps.com/20261011.pmtiles world.pmtiles --maxzoom=6                                    # 45 MB、4 分
```

世界は z6 までで確かめた（作業ディレクトリの空きのため）。PBI の z8 までのうち z7・z8 は描いていない。層の形は同じ PMTiles なので変わらない見込みで、#568 の dev で確かめる。

ページは `map.js`（下の `showMap` と `pmtiles` を `bun build --minify --format esm --target browser` で束ねたもの）・`maplibre-worker.mjs`（`node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs` をそのまま）・`map.css`（同 `maplibre-gl.css`）と、`/map/japan.pmtiles`・`/map/world.pmtiles` を `Range: bytes=a-b` に 206 で答える Bun のサーバーで出し、全部の応答に CSP を付けた。

```ts
setWorkerUrl("/maplibre-worker.mjs");
addProtocol("pmtiles", new Protocol().tile);
new Map({ container, center, zoom, maxZoom: 15, attributionControl: false, localIdeographFontFamily: "sans-serif",
  style: { version: 8, sources: {
    world: { type: "vector", url: `pmtiles://${location.origin}/map/world.pmtiles` },
    japan: { type: "vector", url: `pmtiles://${location.origin}/map/japan.pmtiles` },
  }, layers: [{ id: "bg", type: "background", paint: { "background-color": "#c7dbe8" } }, ...mapLayers("world"), ...mapLayers("japan")] } });   // Spike で走らせた形。並べ方は §4
map.addControl(new AttributionControl({ compact: false, customAttribution: "© OpenStreetMap contributors" }));
```

source の `maxzoom` は書かなくてよい（`pmtiles://` の source は PMTiles のヘッダーから minzoom / maxzoom / bounds を読む）。

## 2. CSP

今の CSP（`src/cloud-host.ts` の `secure()`、`aws/template.yaml` の `ContentSecurityPolicy`）のまま描けた。Chrome の DevTools の `Log.entryAdded` に CSP 違反は 0 件、要求は全部同じ配信元（`/`・`/map.css`・`/map.js`・`/maplibre-worker.mjs`・`/map/world.pmtiles`・`/map/japan.pmtiles`）。

- Worker: 6.x は `setWorkerUrl` の URL から `new Worker(url, { type: "module" })` で作る（blob の Worker は作らない）。`worker-src` が無いと `script-src` に落ちるので、`script-src 'self'` で通る
- 地図データ: `pmtiles` の `Protocol` は主スレッドの `fetch` で Range を取る。`connect-src 'self'` で通る
- `map.css`: `<link rel="stylesheet">` の同じ配信元のファイルなので `style-src 'self'` で通る。css の中のコントロールのアイコンは `data:` の SVG で、`img-src data:` で通る。要素の位置は CSSOM（`element.style`）で書くので `style-src` に `'unsafe-inline'` は要らない
- 対照: `connect-src 'none'` にすると `Connecting to '…/map/world.pmtiles' violates the following Content Security Policy directive: "connect-src 'none'"` が出て背景が描かれない。違反は同じ方法で見えている

よって #566 の CSP の変更は、文字列を変えずに、`connect-src` と `img-src` が `'self'`（と `data:`）だけで外部のドメインを含まないことをテストに足し、#439 の答え A を書いたコメントを直すことになる（PBI の受け入れ条件 5「MapLibre に要る分だけを足している」は、足す分が 0）。

## 3. 文字の出し方

style に `glyphs` を書かずに、`places`・`pois`・`roads` の名前を出した。どれも手元のフォント（Chromium の `sans-serif`。この Linux では Noto Sans CJK）で描かれた:

- z15 の博多駅の周り: 「博多駅（筑紫口）」「博多駅前４丁目」「はかた駅前通り」「JR」「九州新幹線」、国道の番号「385」、英数字の「ELIF Hakata」「Budget」、ハングルの店名
- z15 の天神の周り: 「天神」「天神西」「天神南04」「天神橋口」「明治通り」「昭和通り」、国道の番号「202」「602」
- z5 のパリの周り（`world` だけ）: 「パリ」「フランス」「ロンドン」など。`places` は `name:ja` があればそれを出す

スクリーンショットで天神・博多駅が読めることを見た（画像はリポジトリにも Issue にも置かない）。

- `localIdeographFontFamily` は `"sans-serif"`（MapLibre の既定と同じ値。iPhone ではヒラギノ、Android では Noto Sans CJK になる見込みで、実機は #568 の後の利用者の確認）
- `text-font` は `["sans-serif"]`。`glyphs` が無いとき、MapLibre はこれを CSS の font-family として使う
- glyph の PBF・フォントのファイルを置く案は要らない（外部のフォントも使わない）

## 4. style の層

`mapLayers(source)` が返す 10 層。並べ方は、面と線を `world` → `japan` の順に、その上に文字（symbol）を `world` → `japan` の順に置く（`[...mapLayers("world"), ...mapLayers("japan")]` の symbol を最後へ回す）。Spike は source ごとに 10 層をそのまま並べたが、それだと日本の中で `world` の文字が `japan` の陸の面の下に隠れ、衝突判定の場所だけ取る:

| id | 種類 | source-layer | 中身 |
|---|---|---|---|
| `<source>-earth` | fill | `earth` | 陸 `#f4f1ea`（背景の `background` が海の色 `#c7dbe8`。海岸線は陸と海の境で見える） |
| `<source>-landuse` | fill | `landuse` | `kind` が公園・森など（`park` `forest` `wood` `grass` `nature_reserve` `cemetery` `golf_course`）を `#dfe9d5` |
| `<source>-water` | fill | `water` | 川・湖 `#c7dbe8` |
| `<source>-boundaries` | line | `boundaries` | `kind_detail` が 4 以下（国・都道府県）の破線 |
| `<source>-roads-minor` | line | `roads` | `minor_road` `path`、z13 から、白 |
| `<source>-roads-major` | line | `roads` | `highway` `major_road`、ズームで太く |
| `<source>-rail` | line | `roads` | `rail`、灰色の細線 |
| `<source>-places` | symbol | `places` | `["coalesce", ["get", "name:ja"], ["get", "name"]]`。`kind` で文字の大きさ |
| `<source>-pois` | symbol | `pois` | z14 から、名前 |
| `<source>-roadnames` | symbol | `roads` | z14 から、線に沿って `ref`（国道の番号）か名前 |

z8 以下の日本は `world` と `japan` の両方にあり、同じ地名が重なる。Spike の並べ方では二重の文字を見なかったが、それは `world` の文字が `japan` の陸の下に隠れていたためでもある。上の並べ方（文字を全部最後）で z8 以下の日本に二重の地名が出ないか（symbol の衝突判定で 1 つになるか）は確かめていない（#568 の dev で見る）。`buildings` は出さない（足あとを読むのに要らず、z15 の描画を重くする）。

## 5. 大きさ（2026-10-11 の測定）

| ファイル | そのまま | gzip -9 |
|---|---|---|
| `map.js`（MapLibre の主スレッド + `pmtiles` + `showMap`） | 1,066,086 B | 290,179 B |
| `maplibre-worker.mjs` | 508,314 B | 143,415 B |
| `map.css` | 83,290 B | 10,486 B |
| 参考: 今の `app.js`（`bun run build`） | 195,993 B | 57,188 B |

- 地図の部品は `app.js` に入れず、足あとの地図を開いたときに `import("/map.js")` で読む（#566・#567）。旅程のページの重さは変わらない
- **CloudFront が圧縮する**（#569）: 調べたときは `aws/template.yaml` の `DefaultCacheBehavior` に `Compress` が無く（既定は false）、地図を開くと `map.js` と Worker で約 1.6 MB をそのまま送っていた。#569 で `Compress: true` にし、`map.js` と Worker は gzip で約 430 KB（Brotli ならそれ以下）で届く。`app.js` などほかの画面のファイルも同じ（`index.html` は 1,000 B 未満なので圧縮されない）。地図データ（10,000,000 B を超える）は圧縮されず Range のまま
- 地図データ（PBI の背景の dry-run）: 日本の z15 まで約 3.6 GB、世界の z8 まで約 558 MB。画面は Range で見ている範囲のタイルだけ取る

## 6. 置き場と名前（後の Task が使う）

| もの | 手元（`bun run dev`） | AWS（S3 → CloudFront） |
|---|---|---|
| `map.js` | `src/map.ts` を `Bun.build` | `dist/public/map.js`（`aws/build.ts` の入口を 1 つ足す。名前は固定、chunk 分割しない） |
| `maplibre-worker.mjs` | `node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs` | `dist/public/maplibre-worker.mjs` に写す |
| `map.css` | `node_modules/maplibre-gl/dist/maplibre-gl.css` | `dist/public/map.css` に写す |
| 地図データ | `<CAPSULE_DATA_DIR か ~/.local/share/capsule-host/dev>/map/japan.pmtiles`・`world.pmtiles` | Assets バケットの `map/japan.pmtiles`・`map/world.pmtiles`（`/map/…`） |

- 画面のファイルには CloudFront の `Cache-Control: no-cache`（`aws/template.yaml` の応答ヘッダーの方針、#428）が付き、`/map/*.pmtiles` も同じになる。ブラウザは Range の要求をそのたびに配信元へ出す（部分の応答がブラウザのキャッシュにどう残るかは確かめていない）。#566 の設計チェックのとおり `/map/*` 用の設定は足さず、遅ければ別の PBI にする
- Worker は module として読むので、配信の `Content-Type` が JavaScript（`text/javascript`）でないと動かない。`aws s3 sync` が `.mjs` に付ける型を #568 の配置で確かめる
- 地図データが無いとき（手元に置いていない）、`pmtiles` の取得は 404 で失敗し（MapLibre の `error` が console に 1 source 1 件）、背景は `background` の色だけになる。それでも地図は `idle` まで進み、`Marker` の点は描かれた（2026-10-11、空の `map/` で確かめた）。線（GeoJSON）は #567 で確かめる
