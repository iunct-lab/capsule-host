# Capsule Host

期限付きで同行者と共有する旅程アプリ（旅のカプセル）の Host です。旅行ごとに、最初から削除期限のある「カプセル」を作り、同行者はアカウントを作らず、人数分の席を持つ招待リンクで参加します。旅行の後は読み取り専用になり、手元に書き出してから期限で消えます。

旅行ごとにアプリやデータベースを作らず、1 つの共通の Host（`src/cloud-host.ts`）が旅行ごとの宣言（`TripAppSpec`）を解釈して画面を出します。旅程・足あと・名前・写真は、メンバーのブラウザだけが持つ旅行の鍵で暗号化して置きます。仕様は [旅程仕様](docs/ephemeral-trip-capsule.md) にあります（以下の §番号はこの仕様の節）。

## How this repository works

This repository is a read-only copy of a private development repository: its `main` is that repository's `main` tree, sent here by a sync as one commit at a time, without the private history. Nothing is developed here.

- **Issue and pull request numbers** (`#N`) in files and commit messages refer to the private tracker and cannot be opened here.
- **Pull requests are not accepted.** A pull request opened here is answered with this policy and closed automatically.
- **Requests and bug reports** go to an Issue of the kind *Request* (the only Issue form here). A request is read and taken into the private backlog; the Issue is answered there and closed with the outcome.
- **Vulnerabilities** are reported privately through a GitHub Security Advisory: https://github.com/iunct-lab/capsule-host/security/advisories/new (see `SECURITY.md`). Not in a public Issue or Discussion.
- **Questions and discussion** go to Discussions: https://github.com/iunct-lab/capsule-host/discussions

## 主な機能

- **旅程を作る**: 作成者（運用者が出す 1 回限りの登録リンクでパスキーを作った人）が、画面に希望を書いて自分の Anthropic API キーで生成するか、「作り方をコピー」して使い慣れたチャットに貼り、返事を貼り戻して作ります。作成者は作れますが、どの旅行も読めません（§1.5・§2.6）
- **チャットで直す**: オーナー・編集者が今の旅程をチャットに渡して直してもらい、差分を見てから反映できます。1 つ前に戻せます。自分の API キーを席に登録すれば、画面の中で直せます（§1.5）
- **旅程の画面**: 日ごとのタブで、予定を「詳細」と「リスト」で切り替えて見られ、同じ日の中で並べ替えると開始時刻を Host が前後に合わせます。準備リスト・費用メモ・メモ・候補・相談もあります（§1.3）
- **招待と席**: 招待リンクは人数分の席の引換券で、開いたブラウザが 1 席を取ります。役割はオーナー・編集者・参加者・閲覧者。オーナーが確認コードで承認する招待も選べます（§2.1〜§2.3）
- **パスキー**: 任意で席に登録すると、Cookie を失っても同じ席に戻れます。オーナーの重要操作（招待・終了・削除・設定の変更）の前にはパスキーで本人確認します（§2.1・§2.2）
- **鍵の受け渡し**: 新しいメンバーは、鍵を持つメンバーと 6 桁の確認コードを伝え合って旅行の鍵を受け取ります（§5.1）
- **自分だけの予定と日記**: どの役割も自分だけの予定と日記を書けます。同行者にも運用者にも読めません（§1.3・§1.4）
- **足あとと足あとの地図**: 旅行中に「ここにいる」で時刻と場所を残し、地図の上でメンバー全員が見返せます（§1.3）
- **写真**（既定で無効）: 運用者が有効にしたときだけ、メンバーが写真を上げ、日ごとに見られます。上げた写真は撮影時刻で日のタブの予定の下に並び、載せる予定を選び直したり一言を付けたりできます（§1.3「写真」）
- **旅の記録**: 予定と足あとを並べて「予定 12:00 / 記録 13:02」と見返せます（§1.3）
- **旅を保存**: 旅程のページ（HTML 1 ファイル）・Markdown のコピー・ZIP（オーナー・編集者）で手元に残せます（§3.2）

## 使い方

1. **作成者になる**: 運用者が `bun aws/creator.ts enroll` で出す登録リンクをスマホで開き、パスキーを作ります（`aws/README.md` の「作成者（スマホのブラウザから旅行を作る人）」）
2. **旅行を作る**: トップで作成者としてサインインし、希望を書いて生成するか、作り方をコピーしてチャットの返事を貼ります。おかしな点は、どの項目がなぜ不正かが日本語で出ます。内容と削除予定を確かめて保存します
3. **オーナーを決める**: 保存したら「この端末をオーナーにする」か「オーナーリンクを受け取る」（別の端末・別の人に渡す）を選びます。選ばずに閉じた旅行は、作成者のトップからあとで決められます
4. **招待する**: オーナーは「共有・管理」で役割・人数・受付期限を決めて招待リンクを出し、グループに送ります。参加した人は、鍵を持つメンバーと確認コードを合わせると旅程を読めるようになります
5. **旅行の後に保存する**: 画面上部の「旅を保存」で旅程のページ・Markdown・ZIP を残します。削除の 7 日前から、オーナー・編集者の画面が書き出しを促します
6. **終了・削除**: オーナーは「共有を終了」（読み取り専用にし、ほかのメンバーの席を失効）か「完全に削除」を選べます。何もしなくても削除期限（既定は旅行の終了日 + 30 日、作成から最大 180 日）で消えます

CLI（運用者の IAM）から発行するとき:

1. 生成: エージェントに [旅程の Recipe](docs/recipes/trip.md) と旅行の希望を渡し、リポジトリの外に JSON を 1 ファイル作らせます
2. 検査: `bun run validate <file>`（発行しません。不正な項目のパスと理由を JSON で返し、通れば承認用の SHA-256 を出します）
3. preview: `bun run dev` の最初の画面の「ファイルから取り込む」でファイルを選びます（チャットで作った場合は、その上の貼り付け欄に返事をそのまま貼ります）。ファイルはブラウザ内で検査して下書きとして表示するだけで、送信しません。貼った文は Host の確認（`POST /v1/check`）へ送りますが、保存はしません
4. 発行: `bun aws/publish.ts <file> <function> <profile> <region>` が表示するハッシュが 2 と同じことを確かめ、末尾に付けて再実行します（`aws/README.md` の「旅程発行」）

## 制約

- 旅行を開けるのは、有効な Cookie を持つ人です。Cookie は端末に縛られず、パスキーを登録しても有効な Cookie を持つ人の閲覧は防げません。受付期間中に招待リンクが漏れると、先着の誰でも空席を取れます（§2.4・§2.4.1）
- 閲覧の漏れも許せない情報（パスポート、カード情報、予約の確認番号、自宅住所、健康情報、パスワードなど）はカプセルに置かないでください（§1.4）
- 運用者（Host を動かす人）には、日付・時刻・件数・役割・だれの記録か・ログが見えます。旅程の中身は暗号化した後は読めませんが、画面の JavaScript を配るのは運用者です（§5.2・§5.3）
- 写真は既定で無効です。運用者が `CAPSULE_PHOTOS=1`（AWS はスタックのパラメータ `Photos=1`）にしたときだけ使えます
- パスキーの使えないブラウザ（アプリ内ブラウザなど）では、Safari・Chrome で開き直してください
- このアプリがしないこと（アカウント、決済、任意コード、無期限公開など）は [仕様の「4. 対象外」](docs/ephemeral-trip-capsule.md#4-対象外このアプリがしないこと)、データの暗号化の範囲・運用者に見えるもの・ログ・API キー・削除とバックアップは [仕様の「5. データの扱い」](docs/ephemeral-trip-capsule.md#5-データの扱い) にあります

## 所有範囲

| 場所 | 管理するもの |
| --- | --- |
| `src/` | 共通 Host（認可・招待・期限・削除。`src/cloud-host.ts`）と Domain Kit（旅程 `src/trip-kit.ts`。足し方は [docs/domain-kit.md](docs/domain-kit.md)）・UI・テスト |
| `aws/` | AWS IaC（SAM）、Lambdaビルド、AWS用Publisher、配置手順 |
| `docs/` | 旅程ドメイン仕様、開発・リリース・運用手順 |
| `bun.lock` | このプロジェクト専用の依存関係 |

旅行を増やすためにソースを変更したり、AWSスタックを増やしたりしません。共通コードを一度配置し、旅行ごとのSpec/Documentとリンクを発行します。新しい画面部品やRecipeはここで開発・再利用します。

## ローカル開発

bun 1.4.3 以上が要ります（型検査に `bun --check` を使います。古い bun では `bun run typecheck` が止まります）。

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

画面の並べ替え、「詳細 / リスト」の切り替え、終了時刻の編集と空き・重なりの表示、編集者の「チャットで直す」（反映と 1 つ前に戻す）は、`bun run dev` を立てたまま `bun run verify:ui` で確かめられます（手元の Chrome か Chromium をヘッドレスで動かします。追加の依存はありません。見つからなければ `CHROME_PATH` に実行ファイルを指定）。架空の旅行を作って終わったら消し、リンクも Cookie も表示しません。場面は 5 つの群に分かれ、`bun run verify:ui <群>` で 1 つの群だけを流せます（引数なしは下の順に全部で、通しで約 5 分。知らない名前なら使える群を出して何もせずに止まります）。群はそれぞれ自分の架空の旅行を作って、要る招待・パスキー・鍵の受け渡し・暗号化を自分で用意し、終わったら（落ちても）消し、通れば最後に `[<群>] <秒> s` を出します。秒数は手元の目安です。写真の場面は `CAPSULE_PHOTOS=1 bun run dev` に向けて走らせます。

| 群 | 中身 | 目安 |
|---|---|---|
| `plan` | owner の旅程（並べ替え・時刻・終了・「＋」・詳細 / リスト）、テーマのコントラスト、旅を保存、招待とオーナーの履歴、準備・費用メモ、候補・相談 | 約 20 秒 |
| `members` | 参加者の画面、足あと・旅の記録・旅の足あと（地図）、閲覧者の足あと、開いたときに足あとを残す、編集者（チャットで直す・共有・管理・位置の要素） | 約 2 分 |
| `seat` | 参加者のパスキーとログアウト、鍵の受け渡し、自分の予定と日記、閲覧者のチャットで直す | 約 20 秒 |
| `passkey` | owner のパスキー（PRF の無いパスキー、5 分の後の登録し直し、パスキーで戻る）と画面からの削除 | 約 5 秒 |
| `sealed` | 暗号化した旅行（描画・旅を保存・足あと・招待とメンバー・チャットで直す・ここで直す・削除）、平文の旅行を移す、鍵を替える、owner の交換 | 約 2 分半 |

新しい場面はどれかの群に入れ、前の群が作った状態に頼らず、要る状態はその群の用意（`openTrip()` と `joinAs()`、`src/verify-ui.ts`）とその群の中の場面で作ります。

待つ相手（パスキーの確認の 5 分・1 分ごとの数え直し・足あとの 1 分）は Host の時計なので、verify:ui はループバックの `bun run dev` だけにある `POST /dev/clock` で時計を進めて待たずに進みます（進めた時計は `bun run dev` を立て直すまで進んだまま）。最後に同時に開いたページの最大を出します。`bun run check` と CI には入っていません。

`http://localhost:47840` を開きます（`127.0.0.1` ではなく `localhost`。ブラウザはIPアドレスをパスキーのRP IDとして受け付けないため、既定のOriginをこちらにしています。`127.0.0.1` で使うなら `CAPSULE_ORIGIN=http://127.0.0.1:47840 bun run dev`）。別端末の `bun run verify:http` は権限・競合・出力をHTTP越しに検査し、作成した架空カプセルを削除します。実旅行はテストに使いません。

開発データの既定保存先は `~/.local/share/capsule-host/dev/`。`CAPSULE_DATA_DIR` で変更可能です。ソースリポジトリ内へ保存しません（HMAC鍵も同じ場所にあり、ディレクトリごと消すとローカルで発行済みのリンクは無効になります）。ローカルもAWSも、認可・ライフサイクル・操作の適用は同じ `src/cloud-host.ts` を通ります。違うのは保存先（ローカルは `src/local-d1.ts` のSQLite、AWSは `src/aws-store.ts` のDynamoDB）、その手前（CloudFront・Lambda Web Functions の OAC・IAM・参加登録の地域制限）、そして `src/main.ts` だけにあるローカル用の入口（静的ファイル、`/health`、preview、ループバックのときだけ画面から発行できること）です。違う部分はローカルでは確かめられないので、認可・保存・削除の変更は架空データだけの AWS のスタックでも確かめます（`aws/README.md` の「AWS検証」）。発行の上限（1分に5件、同時に保持できる旅行は10件）はローカルにも同じくかかります。作成者の鍵で旅程を生成する部分は `src/assist.ts` と `src/cloud-host.ts` の `/v1/assist` です。作成者が登録する Anthropic API キーは、`src/key-store.ts` で封じてから保存します（ローカルはSQLite、AWSは `src/aws-key-store.ts` のParameter Store）。

足あとの地図の背景（道路・地名・海岸線）は、開発データの置き場の `map/` に置いた地図データ（世界・地域の `.pmtiles` と、その一覧 `regions.json`。既定なら `~/.local/share/capsule-host/dev/map/`）から `bun run dev` が出します。地図データはリポジトリに入れません。作り方は `aws/README.md` の「足あとの地図の背景（地図データ）」と同じ `bun aws/mapdata.ts` で、バケットの代わりに開発データの置き場を渡します（`bun aws/mapdata.ts build --dir ~/.local/share/capsule-host/dev`。`pmtiles` を PATH に置き、約 4.2 GB の空きが要ります）。無くても足あとの点と線は出ます（背景が無地になるだけ）。地図の部品（`map.js`・`maplibre-worker.mjs`・`map.css`）は足あとの地図を開いたときにだけ読み込まれます。

## 自分の AWS に配置する

自分の AWS アカウントにスタックを作り、画面と地図データを置き、`aws/verify.ts` で確かめ、旅行を発行・終了する手順は [AWS配置手順](aws/README.md) にあります。旅行を増やすためにスタックを増やす必要はありません（1 つのスタックに旅行を何件でも発行できます）。

## License

Apache License 2.0（`LICENSE`、`NOTICE`）。配る画面の部品（`dist/public/map.js`）に含まれる第三者のライセンスは、ビルド（`aws/build.ts`）が成果物の先頭に入れる。

足あとの地図の地図データは OpenStreetMap から作られた ODbL（Open Database License）の派生物で、地図に「© OpenStreetMap contributors」を出し、[OpenStreetMap の著作権とライセンスのページ](https://www.openstreetmap.org/copyright) へリンクしています。
