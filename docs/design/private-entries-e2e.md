# 運用者にも読めない個人メモ — 鍵の置き場所と失ったときの扱い（Spike #347）

親 PBI: #342。元要望: #340（管理者にも見えないものをどう管理するのかが分かりにくい）。この文書の決定を実装するのは #343、個人メモそのもの（保存形と API）は #341。

この文書は方式を決める Spike の成果物で、実装はしていない。試したコードはコミットせず、§2.3 に載せた。ブラウザ対応は 2026-09-29 に一次資料で確かめた。**実機のスマホでは試していない**（§5 の「実機で確かめた端末」は利用者が書く）。

## 0. 結論

**推薦: 案 B（パスキーの PRF から導いた鍵で、席ごとの鍵を包む）。** 2026-09-29 に利用者が案 B に決めた（§5）。 ブラウザが席ごとにランダムな鍵（以下「メモの鍵」）を 1 本作り、パスキーの PRF の出力から導いた鍵で包んで Host に置く。開いた端末では、包みを解いたメモの鍵を取り出せない `CryptoKey` として IndexedDB に置き、毎回はパスキーを求めない。

理由:

1. 席に戻る手段がもともとパスキーだけなので（Cookie を失った端末はパスキーでしか同じ席に戻れない。`src/client.ts:81-89`）、鍵をパスキーに結びつけても、席を失わずに鍵だけを失う場面がほとんど増えない。端末を替えても、同期されたパスキーで戻れば読める
2. 案 A（ブラウザだけの鍵）は、ブラウザのデータを消すと必ず失い、Safari はサイトを 7 日使わないだけでも IndexedDB を消す（§2.2）。案 C（合言葉）は、運用者が暗号文と salt を持つので弱い合言葉を手元で総当たりでき、「運用者にも読めない」が合言葉の強さ次第になる
3. 包みの解けない端末（PRF の無いブラウザ、QR 経由で値が違う Safari など）では「この端末では読めません」になるだけで、データは壊れない。案 A のキャッシュを併せ持つので、パスキーを求めるのは端末ごとに初回とキャッシュが消えたときだけ

## 1. 今だれが個人メモを読めるか

#341 の個人メモはカプセルの payload の中に置く（`Capsule.private`、#344 の手順 1）。暗号化（#343）の前は、次の経路で本人以外にも読める。行番号は 2026-09-29 の main（`94567b5`）。

| 経路 | だれが | 何が読めるか | コードの場所 |
|---|---|---|---|
| DynamoDB を読む | 運用者（AWS アカウントの IAM で DynamoDB を読める人） | payload の全部（個人メモを含む）。保存時の暗号化は AWS の鍵で、IAM で読めれば平文で返る | テーブル `aws/template.yaml:33`、保存時の暗号化 `aws/template.yaml:54`。payload は 128 KiB ごとの `chunk:<n>` 項目に平文の JSON のバイト列で入り（`src/aws-store.ts:27`）、`get` が連結して文字列に戻す（`src/aws-store.ts:16-21`）。Lambda のロールに `Scan` は無い（`aws/template.yaml:89`）が、運用者自身の IAM には制限が無い |
| `/recover` | 旅行を発行した人（IAM の publisher） | 新しい owner の席。owner の席からも他人の個人メモは返らない（#344 の手順 3 は本人の席の分だけ返す）。古い owner の招待は失効し（`src/cloud-host.ts:496`）、失効した招待の席は保存のたびに消え（`src/cloud-host.ts:652`）、その席の個人メモも消える（#344 の手順 4）。**画面の経路としては閉じている**。ただし発行した人が運用者でもあれば、上の DynamoDB の経路が残る | `src/cloud-host.ts:491-497`、`aws/recover.ts` |
| 盗まれた Cookie | Cookie の値を手に入れた人（端末を盗んだ、など） | その席の本人と同じもの。個人メモも本人の分が返る。Cookie は `HttpOnly; Secure; SameSite=Strict` で旅行ごとの `Path`（`src/cloud-host.ts:112`）、Host は値の HMAC だけを持つ（`src/cloud-host.ts:116`）ので、DynamoDB から Cookie は作れない | `src/cloud-host.ts:113-120` |
| CloudWatch のログ | 運用者 | 個人メモの本文は出ない。`fetch` の `catch` は例外を応答に変えるだけで記録しない（`src/cloud-host.ts:358-360`）。`src/cloud-host.ts` と `src/aws-handler.ts` に `console` は無い。Lambda が投げるのは中身を含まない固定の文言だけ（`src/aws-handler.ts:16`、`:20`）。アクセスログは CloudFront のもの（`aws/edge-logs.yaml`）で、項目に本文・クエリ・Cookie を入れない。ログは 7 日で消える（`aws/template.yaml:101-102`） | 同左 |

暗号化（#343）の後に変わるのは 1 行目と 3 行目で、どちらも暗号文しか得られない（3 行目は、盗んだ端末の IndexedDB にメモの鍵が残っていれば読める。端末そのものを盗まれた場合は防がない）。

**防げないもの**: 画面の JavaScript は運用者が配る（S3 の `dist/public/`）。運用者が復号した本文を送り返すコードを配れば読める。この方式が閉じるのは「保存されたデータを後から読む」経路で、「配るコードを書き換える」能動的な攻撃は防がない。配る版はコミットと `docs/releases.md` の記録に残る。

**書き換えは一部しか見つけられない**: 運用者は DynamoDB に書き込める。平文の `day` / `startsAt` / `endsAt` / `kind` の書き換えと、暗号文を別の項目・別の欄に入れ替えることは、追加認証データ（§3）に含めるので復号に失敗して見つかる（その項目は「この端末では読めません」になる）。見つけられないのは、同じ項目の古い暗号文に戻すこと（巻き戻し）、項目を消すこと、包んだメモの鍵を消すこと（全部が読めなくなる）。どれも読むことにはならず、壊すことにしかならない。

## 2. 鍵の置き場所

どの案も、暗号化は `crypto.subtle` の AES-GCM（256 ビット）だけで足り、新しい依存は要らない。鍵の預かり・運用者による回復は案に入れない（運用者が復号できるなら「読めない」ではない）。

- **案 A**: ブラウザが `crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, …)` で作った取り出せない鍵を IndexedDB に置く
- **案 B**: 席ごとのメモの鍵をブラウザで作り、パスキーの PRF 拡張の出力（固定の入力 `capsule private entries v1` に対する 32 バイト）から HKDF で導いた鍵で包んで（AES-GCM）、包んだものを席に置く。開いた端末では、メモの鍵を取り出せない `CryptoKey` として IndexedDB にも置く（案 A と同じ置き方をキャッシュとして使う）
- **案 C**: 利用者が決めた合言葉から PBKDF2（SHA-256、60 万回）で鍵を導く。salt は席に置く

### 2.1 比べる

| 観点 | A: ブラウザ生成の鍵 | B: パスキーの PRF で包む | C: 合言葉 |
|---|---|---|---|
| 登録の手間 | 無い。初めて書いたときに作る | この席のパスキーを 1 回登録する（Face ID・指紋 1 回）。今のパスキーは PRF を求めずに作っているので（`src/client.ts:53`）、PRF の出ないパスキーは置き換えが要る（§2.3 の 3 行目） | 合言葉を決めて覚える。短いと運用者に総当たりされる（salt と暗号文は Host にある） |
| 端末を替えたとき | 新しい端末では読めない。項目は残り、消せる | 同期されるパスキー（iCloud キーチェーン・Google パスワードマネージャー）で戻れば、戻るときの 1 回の確認で読める。端末に閉じたパスキーなら読めない | 合言葉を入れれば読める |
| ブラウザのデータを消したとき | 読めなくなる。Safari はサイトを 7 日使わなければ消さなくても消す（§2.2） | キャッシュが消えるだけ。「パスキーで戻る」の 1 回で読める | 合言葉を入れ直せば読める |
| 端末を失ったとき | 失う（その端末にしか無い） | 同期されたパスキーが別の端末にあれば読める。無ければ失う。どちらでも、席に戻れなければ owner の失効で個人メモごと消える（#341 の決定 (b)） | 合言葉を覚えていれば読める。ただし席に戻る手段はパスキーだけなので、パスキーが無ければ席ごと失い、個人メモも消える |
| PC から QR でスマホのパスキーを使うとき | PC の席には鍵が無く読めない | Chrome は QR 経由（hybrid）でも PRF を返す。Safari は QR 経由で PRF が空か、端末上と違う値を返したという報告がある（§2.2）。値が違えば包みが解けず「この端末では読めません」になるだけで、データは壊れない | 合言葉を入れれば読める |
| ブラウザ対応 | `crypto.subtle` と IndexedDB があれば全部（LINE のアプリ内ブラウザも） | Chrome / Edge 116 以降、Safari 18 以降（iCloud キーチェーンのパスキー。`get` で返るかは MDN と WebKit で食い違い、要実機確認。§2.2）、Firefox 139 以降（デスクトップ）。Android の Firefox は `get` で未対応。WebAuthn の無いアプリ内ブラウザでは使えない（`src/client.ts:36`） | `crypto.subtle` の PBKDF2 があれば全部 |

### 2.2 ブラウザ対応の一次資料（確認日 2026-09-29）

- MDN「Web Authentication extensions」の `prf`: `create()` と `get()` の両方で使え、`create()` の結果は `prf.enabled`（と対応していれば `results`）、`get()` は `prf.results.first`、対応が無ければ `prf: {}`。<https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions>（ページの最終更新 2026-09-17）
- MDN の互換性データ（`@mdn/browser-compat-data` 8.1.3、2026-09-24 生成）: `create` の `prf` は Chrome 116 / Chrome Android 116 / Edge 116 / Firefox 139 / Firefox Android 149 / Safari 18 / Safari iOS 18。`get` の `prf` は Chrome・Edge・Firefox が同じ版、**Safari と Safari iOS は未対応（false）**、Firefox Android も未対応。<https://unpkg.com/@mdn/browser-compat-data/data.json>
- WebKit「WebKit Features in Safari 18.0」（2024-09-16）:「WebKit for Safari 18.0 adds support for the WebAuthn `prf` extension. It allows for retrieving a symmetric key from a passkey to use for the encryption of user data.」<https://webkit.org/blog/15865/webkit-features-in-safari-18-0/>。上の MDN の「`get` は未対応」と食い違う。MDN が参照する WebKit のバグ（「Implement PRF extension + hmac-secret」、2025-11-21 に修正、2026-01-08 更新）はセキュリティキー（hmac-secret）の実装で、iCloud キーチェーンのパスキーは Safari 18 から返すと読める。<https://bugs.webkit.org/show_bug.cgi?id=259934>。**どちらが実機に合うかは実機で確かめる**（§5）
- Apple Developer Forums「PRF Extension Not Supported in Safari's Cross-Device WebAuthn Flow」: Apple の担当者が 2025-02 に「Safari 18.2 で QR 経由（hybrid）でも PRF が返るようになったが、端末上とは違う値を返す。近く直す」と回答。2025-03（Safari 18.4 beta）と 2025-04（Safari 18.3.1）に、まだ空・値が違うという報告。<https://developer.apple.com/forums/thread/774112>
- Chrome「Intent to Ship: WebAuthn PRF extension」（blink-dev）:「Support on Windows depends on having a recent version of Windows. Not every security key supports the underlying hmac_secret functionality. Some passkey providers on Android 14 may not support it.」<https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI>。Chrome Platform Status の状態は「Enabled by default」<https://chromestatus.com/feature/5138422207348736>。Google パスワードマネージャーのパスキーが PRF を返すことは、Google の一次資料（<https://developers.google.com/identity/passkeys/supported-environments>、2025-05-19 更新）には書かれていない
- WebKit「Full Third-Party Cookie Blocking and More」（2020-03-24）: Safari は「deleting all of a website's script-writable storage after seven days of Safari use without user interaction on the site」。対象に IndexedDB を含む。ホーム画面に追加した Web アプリは別に数える。<https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/>。Host の Cookie はサーバーが付ける `HttpOnly` なので、この 7 日の対象は案 A の鍵（と案 B のキャッシュ）
- MDN「SubtleCrypto: generateKey()」: `extractable` が false の鍵は `exportKey()` / `wrapKey()` で取り出せない。<https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/generateKey>

### 2.3 手元の Chrome で試した（2026-09-29）

`bun run verify:ui` と同じく `CHROME_PATH` の Chrome（`Chrome/153.0.8010.12`、Linux、headless）を DevTools プロトコルで動かし、`http://localhost:<空きポート>/` の空のページで試した。OS のダイアログの代わりに CDP の virtual authenticator（`WebAuthn.addVirtualAuthenticator`、`protocol: "ctap2"`、`ctap2Version: "ctap2_1"`、`transport: "internal"`、`hasResidentKey` / `hasUserVerification` / `isUserVerified` を true）が答える。実機の認証器・パスキーの同期・QR 経由は試せない。

ページで評価したコード（要点。スクリプトはコミットしていない）:

```js
const salt = new TextEncoder().encode("capsule private entries v1");
const created = await navigator.credentials.create({ publicKey: {
  challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { id: "localhost", name: "prf test" },
  user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "test", displayName: "test" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
  extensions: { prf: {} } } });                                  // 3 行目だけ extensions を付けない
const atCreate = created.getClientExtensionResults().prf;
const get = () => navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)),
  rpId: "localhost", userVerification: "required", extensions: { prf: { eval: { first: salt } } } } });
const a = await get(), b = await get();                          // 2 回とも同じ 32 バイトが出るか
// a の出力の SHA-256 を AES-GCM の鍵にして "目印 secret" を暗号化し、b の出力から作った鍵で復号する
```

出力（PRF の値は先頭 8 バイトだけ）:

```
browser: Chrome/153.0.8010.12 | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
virtual authenticator hasPrf=true, create without extensions.prf=false:  {"atCreate":{"enabled":true},"getPrf":{"results":{"firstBytes":32,"firstPrefix":"f88214159d6a930f…"}},"sameOutputTwice":true,"decryptedWithSecondGet":"目印 secret"}
virtual authenticator hasPrf=false, create without extensions.prf=false:  {"atCreate":{"enabled":false},"getPrf":{},"sameOutputTwice":false,"decryptedWithSecondGet":null}
virtual authenticator hasPrf=true, create without extensions.prf=true:  {"atCreate":null,"getPrf":{},"sameOutputTwice":false,"decryptedWithSecondGet":null}
```

読み取れること:

1. PRF に対応した認証器なら、`create` は `prf.enabled: true` を返し、`get` は 2 回とも同じ 32 バイトを返す。1 回目の値で暗号化したものを 2 回目の値で復号できた
2. 対応していない認証器では `create` が `enabled: false`、`get` が `prf: {}`。エラーにはならないので、画面は `results` の有無で分ける
3. **`create` で `extensions.prf` を求めずに作ったパスキーは、同じ認証器でも `get` で PRF を返さなかった**（CTAP2 の hmac-secret は作るときに有効にする）。今のパスキーの登録（`src/client.ts:53`）は PRF を求めていないので、#343 では登録に `extensions: { prf: {} }` を足し、PRF の出ない既存のパスキーは置き換え（`src/client.ts:39-64`）を案内する。iCloud キーチェーンや Google パスワードマネージャーのパスキーが作るときの指定と関係なく PRF を返すかは、実機で確かめる
4. Chrome の virtual authenticator では `create` の時点で `results` は返らなかった。登録の直後にメモの鍵を包むには、もう 1 回 `get` が要る（Face ID が 2 回になる）場合がある

### 2.4 案 B の流れ（#343 が実装する形）

- **初めて書くとき**: パスキーが無ければ登録を求める（今の `registerPasskey`）。`get` の `prf.eval.first` に固定の入力を渡し、出力から HKDF-SHA-256 で「包む鍵」を導く。メモの鍵（AES-GCM 256）を `extractable: true` で作り、`wrapKey` で包んで席に置く（Host に置くのは包んだものとパスキーの ID だけ）。端末に置く分は、包んだものを `unwrapKey(…, extractable: false)` で開き直した取り出せない `CryptoKey` を IndexedDB に置き、取り出せる方はメモリから捨てる（`wrapKey` は取り出せる鍵しか包めないため）。HKDF は salt なし（PRF の出力が既に一様な 32 バイト）、info は `capsule private entries v1/<カプセルの id>`。包むのは AES-GCM で、IV は包むたびに新しい 12 バイト、追加認証データはカプセルの id。形は §3 の暗号文と同じ `v1.` 形式
- **同じ端末で開くとき**: IndexedDB のメモの鍵で読む。パスキーは求めない
- **別の端末・データを消したあと**: 「パスキーで戻る」（`src/client.ts:81-89`）の `get` に PRF を足し、同じ 1 回の確認で包みを解く。Cookie が残っていて IndexedDB だけが無ければ、個人メモを開いたときに「パスキーで読む」で 1 回確認する
- **パスキーの置き換え**: 置き換えはもともと今のパスキーでの確認を先に取る（`src/client.ts:44-49`）。その `get` に PRF を足して包みを解き、新しいパスキーの PRF で包み直して、置き換えと同じ要求で送る。新しいパスキーの PRF は、`create` が `results` を返さなければ（手元の Chrome では返さなかった。§2.3 の 4）、送る前に新しいパスキーでもう 1 回 `get` が要る。置き換えの確認は今の 2 回から 3 回に増える。分かれ目は PRF が返ったかではなく、**Host が席に包んだメモの鍵を持っているか**で決める。持っていなければ（まだ個人メモを書いていない）、包み直すものは無く、新しいパスキーで初めてメモの鍵を作る。持っているのに包みが解けない（QR 経由で PRF が空か値が違う、このブラウザが PRF を返さない）なら、置き換えを止め、パスキーのある端末で直接置き換えるよう案内する（§4.5）。そのまま置き換えると古いパスキーが消え、書いたメモが全部読めなくなるため。今のパスキーを失ったら置き換えられず、owner に失効と再招待を頼む（席が変わり、個人メモは消える）
- **PRF が出ないとき**: 個人メモは書けない（§4.5 の文言）。案 A に落とすことはしない（落とすと「ブラウザのデータを消すと消える」鍵が混じり、画面の説明が 2 通りになる）

## 3. 何を暗号化するか

#341 の保存形（#344 の手順 1。`PrivateEntry` はまだ `src/cloud-host.ts` に無い）と突き合わせる。

| `PrivateEntry` の項目 | 扱い | 理由 |
|---|---|---|
| `title` | 暗号文 | 題に内容が出る |
| `body` | 暗号文 | 本文 |
| `place`（`label` / `publicUrl`。#341 の画面の `address` も含めるならここ） | 暗号文（オブジェクトを JSON にしてまとめて 1 つ） | 行き先は体調・家族のメモと同じくらい私的 |
| `id` | 平文 | 置き換え・削除の対象を Host が探す |
| `kind`（`item` / `diary`） | 平文 | 日記は 1 日 1 つ、予定は時刻順、という並べ方を画面と Host で揃える |
| `day` | 平文 | Host が旅行期間内かを検査し（#344 の手順 2）、日のタブに置く |
| `startsAt` / `endsAt` | 平文 | 日のタブで他の予定と時刻順に並べる（共有の予定の並べ方は `placeByTime`、`src/cloud-host.ts:64`） |
| `createdAt` / `updatedAt` | 平文 | Host の時計で書く（#344 の手順 2） |

**暗号文の形**: `v1.` に続けて、IV（12 バイト、項目ごと・保存ごとに新しく作る）と AES-GCM の暗号文（タグ 16 バイトを含む）をつないだものの base64url（`=` なし）。追加認証データ（AAD）に `<項目の id>/<項目名>/<kind>/<day>/<startsAt>/<endsAt>`（無い時刻は空）を入れ、運用者が暗号文を別の項目や別の欄に入れ替えたり、平文の日付・時刻・種類を書き換えたりすると復号に失敗するようにする（それでも防げない書き換えは §1 の末尾）。日付や時刻を変えるときは、画面が 3 つの欄を暗号化し直して `put` する（`put` はもともと項目を丸ごと置き換える）。`createdAt` / `updatedAt` は Host が書くので含めない。席ごとにメモの鍵が違うので、席をまたぐ入れ替えも復号できない。

**Host の検査で失うものと、代わりに見るもの**:

| いまの検査（#344 の手順 2） | 暗号化の後 |
|---|---|
| `title` が 1〜160 字 | Host は字数を数えられない。`^v1\.[A-Za-z0-9_-]+$` で、長さ 700 字以下（160 字が UTF-8 で最大 480 バイト＋28 バイト → base64url で 678 字＋`v1.`）。1〜160 字の検査は画面が暗号化の前にする |
| `body` が 4000 字以下 | 同じ形で 16,100 字以下（12,000＋28 バイト → 16,038 字＋`v1.`） |
| `place.publicUrl` が https だけ | Host は見られない。画面が暗号化の前と、復号して表示する前の 2 回検査する（`https:` 以外はリンクにしない）。見るのは書いた本人だけなので、他人に危険なリンクを見せる経路にはならない |
| `place` の形（`label` 必須、`publicUrl` は任意） | `place` 全体を同じ形で 17,400 字以下。JSON にした最悪のバイト数で決める: `label` 160 単位と `publicUrl` 2,000 単位（`src/schema.ts:11` は UTF-16 の単位で数え、漢字の URL も通す）が、制御文字の `\u00XX` で 1 単位 6 バイトになりうるとして 12,960 バイト＋キー名 40＋28 → 17,371 字＋`v1.`。画面は暗号化の前に平文の検査（字数と https）をする |
| `day` が旅行期間内、100 件まで | 変わらない（平文のまま） |

**容量**: 暗号文は平文の約 4/3 倍（base64url）＋項目ごとに 28 バイト＋`v1.`。カプセル全体の上限（`src/cloud-host.ts:654` の 1,900,000 バイト）は共有のままなので、1 席 100 件・本文 4000 字をいっぱいに使うと本文だけで 1 席約 1.6 MB、題と `place` も上限いっぱいなら 1 席約 3.4 MB（1 件で 700＋16,100＋17,400 字）で、1 席だけでも 413 になりうる。これは #341 の上限の決め方の問題で、暗号化で約 1.33 倍に早まる（#343 の Task で上限の文言を確かめる）。

**運用者に残るメタデータ**（暗号化の後も DynamoDB で読める）:

- 席ごとの件数、項目ごとの `id` / `kind` / `day` / `startsAt` / `endsAt` / `createdAt` / `updatedAt`
- 暗号文の長さ（題・本文・場所のおおよその字数が分かる。詰め物はしない）と、`place` があるかどうか
- 包んだメモの鍵と、それを包んだパスキーの ID（パスキーの公開鍵は今も `Session.passkey` にある）
- どの席のものか（`Session.id`。席の招待の名前 `label`、端末の種類 `device`、最終利用時刻 `lastUsed` は今も `Session` にある。`src/cloud-host.ts:17`）

## 4. 鍵を失ったとき

「鍵を失った」は、この端末の IndexedDB にメモの鍵が無く、パスキーの PRF でも包みが解けないこと（パスキーが無い、PRF が出ない、QR 経由で値が違う）。

### 4.1 表示

- 思い出モジュールが無い、または navigation に無い既存の旅行にも、標準の思い出タブを画面側で補う。保存済みの Spec・暗号データは変更しない（#494 の回答 A）。日記の編集でもこのタブを使う。共有の思い出が元の Spec で無効なら共有節は表示せず、Host の既存のモジュール制約を保つ。
- 読めない項目も、平文の `day` / `startsAt` / `kind` で、予定は旅程の同じ位置、日記は思い出の選択日の一覧に並べる。題の代わりに「この端末では読めません」、本文は出さない。「自分だけ」の印はそのまま
- 項目を開くと「パスキーで読む」と「削除」だけを出す（編集はできない。暗号文を書き換えられないため）
- 旅程の上に「自分だけの予定のうち n 件は、この端末では読めません。」、思い出の日記節に「自分の日記のうち n 件は、この端末では読めません。」と種類ごとの読めない件数を表示する。

### 4.2 削除だけはできる

削除は `PATCH private` の `remove`（#344）で、Host は暗号文を読まずに消せる。鍵が無くても、書いた本人の席なら消せる。

### 4.3 書き出し

`private.md`（#346）はブラウザで復号して作る（#343 の条件 4。Host は暗号文しか返せない）。読めない項目は本文に入れず、先頭に「この端末で読めなかった n 件は含まれていません。」と書く。1 件も読めなければ書き出しのボタンを出さず、理由を出す。

### 4.4 パスキーを失ったとき（新しい鍵は作らない）

案 B では、メモの鍵は席に 1 本で、包みを解けるのはその席のパスキーだけ。パスキーを失うと、Cookie が残っていても席に新しいパスキーは足せない（置き換えには今のパスキーでの確認が要る。`src/cloud-host.ts:545-550`、`src/client.ts:44-49`）ので、新しい包む鍵が作れない。だから**新しい鍵で書き始める流れは作らない**。起こりうるのは次の 2 つだけ:

- **Cookie でその席を使い続ける**: 共有の旅程はそのまま使える。自分だけのメモは読めず、書けず、消すことだけできる（§4.2）
- **owner に失効と再招待を頼む**: 新しい席になり、古い席の個人メモは席ごと消える（#341 の決定 (b)、#344 の手順 4）。新しい席では新しいパスキーで新しいメモの鍵を作る

包みが解けない理由が「QR 経由で PRF の値が違う」「このブラウザが PRF を返さない」だけのとき（パスキー自体はある）は、削除も新しい鍵も勧めず、パスキーのある端末で直接開くよう案内する（§4.5）。画面からは理由を区別できない（どれも「包みが解けない」）ので、削除を勧める文言は出さない。

### 4.5 文言案

| 場面 | 文言 |
|---|---|
| 入力欄の注記 | 「同行者・オーナー・サービスの運用者には読めません。この席のパスキーで鍵をかけます。パスキーを失うと、あなたにも読めなくなります。」 |
| パスキーが無いときに書こうとした | 「自分だけのメモは、運用者にも読めないようにパスキーで鍵をかけます。この端末でパスキーを登録して続けますか？」 |
| PRF の出ないブラウザ・パスキー | 「このブラウザ（またはこのパスキー）では、自分だけのメモに鍵をかけられません。別のブラウザで開くか、パスキーを登録し直してください。」 |
| 読めない項目の題 | 「この端末では読めません」 |
| 読めない項目を開いた | 「このメモは、この席のパスキーで開くと読めます。」ボタン「パスキーで読む」「削除」 |
| 置き換えで今のパスキーの包みが解けなかった | 「今のパスキーで自分だけのメモの鍵を開けませんでした。このまま置き換えるとメモが読めなくなるため、置き換えを止めました。パスキーのある端末で直接開くか、別のブラウザで開いて置き換えてください。」 |
| パスキーでも解けなかった | 「このパスキーでは読めませんでした。この旅行に登録したパスキーを選んでください。別の端末から QR で使った場合は、パスキーのある端末で直接開いてください。」 |
| パスキーを失った（読めず、書けない） | 「この席のパスキーが無いため、自分だけのメモは読むことも書くこともできません。削除はできます。新しい端末で続けるには、オーナーに失効と再招待を頼んでください（今のメモは消えます）。」 |
| 書き出しの先頭 | 「この端末で読めなかった n 件は含まれていません。」 |

## 5. 利用者の決定

**決定: 案 B**（下の表）。以下の段落は決定を求めたときの問い。

推薦（§0）と違う案を選ぶ場合、#343 の Task の切り方が変わる（案 A は画面だけ、案 B はパスキーの登録と置き換え、案 C は合言葉の入力画面）。「失ったときの扱い」は、推薦のとおり「読めない・書けない・消せる。新しい鍵は作らず、続けるなら再招待で席ごと作り直す」（§4.4）と「PRF が出ないブラウザでは書けない」（§2.4）でよいか。

| 項目 | 利用者の決定 |
|---|---|
| 日付 | 2026-09-29（#342 の `## 回答`） |
| 鍵の置き場所 | 案 B（パスキーの PRF で席ごとのメモの鍵を包む。§0、§2.4）。#342 の回答で B に決まった。 |
| 失ったときの扱い | 推薦のとおり（§4.4 と §2.4）。#342 の回答で、パスキーを登録していない端末では個人メモを使えないことにした。§2.4・§4 の扱いと同じと読んだ: この席のパスキーで包みを解けるまで、その端末では個人メモは読めず書けない。案 A に落とさない（§2.4 の「PRF が出ないとき」）。席にパスキーがまだ無いときに初めて書く端末でパスキーを登録して続ける流れ（§2.4、§4.5）と、別の端末から QR でパスキーを使って読む流れ（§2.1 の表の「PC から QR でスマホのパスキーを使うとき」の行）は変えない |
| 実機で確かめた端末 | 未確認（回答に無い）。iPhone（Safari 18 以降）で PRF が返るか（§2.2）は利用者が確かめる |
