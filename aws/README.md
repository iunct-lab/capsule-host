# AWS deployment

採用先: AWS。参加者のアカウントは不要。旅行の発行はIAMで許可されたLambda Invokeと、パスキーでサインインした作成者（スマホのブラウザ）だけ。それ以外の公開HTTP経路のpublishは拒否する。作成者の登録・一覧はIAMだけ。失効はIAMと、作成権限を分けた作成者（下の「作成者」）。

Origin・バケット・関数名はスタック出力（`aws cloudformation describe-stacks`）を正とし、ここには書かない。

## 配置手順

環境はスタック名ごとに分かれる。DynamoDB・S3・秘密鍵・Origin はスタックごとに作られ、ほかのスタックと共有しない。同じアカウントに複数のスタックを置くなら、区別はスタック名だけなので `--stack-name` を間違えないこと。**`aws/verify.ts` による検証と試しの発行は、架空データだけを置く検証用のスタックで行う**のがよい（実旅行のあるスタックで使うのは配置直後の smoke test だけにし、発行したら削除する）。

AWS CLI v2 と SAM CLI、対象プロファイルのログインが必要。このリポジトリのルートで操作する。

`/v1/*` は Lambda Web Function（`aws/template.yaml` の `Web*`）が受け、CloudFront が OAC で署名して呼ぶ。Web Function のリビジョンは作った後に変えられず、**S3 のバージョン付きの zip** を指す。そのバケットはスタックごとの小さい別スタック（`aws/code.yaml`）で**最初に 1 回だけ**作る。コードを替えるたびに新しい zip を上げ、その `VersionId` を `sam deploy` に渡す（渡さないと配置できない。リビジョンが作り直される）:

```sh
STACK=<自分のスタック名>
aws cloudformation deploy --template-file aws/code.yaml --stack-name $STACK-code --region ap-northeast-1 --profile YOUR_PROFILE   # 初回だけ
bun run build
BUCKET=$(aws cloudformation describe-stacks --stack-name $STACK-code --region ap-northeast-1 --profile YOUR_PROFILE --query 'Stacks[0].Outputs[0].OutputValue' --output text)
Z=$(mktemp -d /tmp/capsule-host.webzip.XXXXXX); (cd dist/aws-web && zip -q $Z/web.zip index.mjs)      # 入口は zip の根の index.mjs
VERSION=$(aws s3api put-object --bucket $BUCKET --key web.zip --body $Z/web.zip --region ap-northeast-1 --profile YOUR_PROFILE --query VersionId --output text); rm -rf $Z
sam validate --lint --template-file aws/template.yaml
sam deploy --template-file aws/template.yaml --stack-name $STACK --resolve-s3 --capabilities CAPABILITY_IAM --region ap-northeast-1 --profile YOUR_PROFILE --parameter-overrides WebCodeBucket=$BUCKET WebCodeVersion=$VERSION --no-execute-changeset
```

変更セットで、テーブル（`Data`）・`Assets` バケット・`Media` バケットが置き換え・削除になっていないことを見る。`Media`（写真の置き場。下の「写真の置き場」）を足す配置では、変更セットは `Media` の追加、`Host` と `WebRole` の IAM の追加、2 つの関数の環境変数 `CAPSULE_MEDIA_BUCKET` の追加だけのはず。Web Function は空の環境変数を受けない（変更セットの作成が止まる）ので、空が正しい `ClaimCountries`・`DisabledActions` は、空のときは変数を付けない作りになっている。

Lambda同時実行上限が10の新規アカウントは予約同時実行を確保できず、Hostの作成に失敗する。上限引き上げまでは `--parameter-overrides ReservedConcurrency=-1` で予約を無効化する。この場合のHostの抑止は無くなる（`/v1/*` の上限は Web Function の `RateLimit` と `MaxEnvironments`。下の「レート制限とスロットル」）ため、Service Quotasで引き上げて既定の5へ戻す。`sam deploy` は渡さなかったパラメータを前回の値のまま使うので、-1から戻すときは `ReservedConcurrency=5` を明示して渡す。作成失敗でロールバックした場合、Retain指定のS3/DynamoDBは空のまま残るので、中身が空であることを確認して手動で削除する。

まずCloudFormation変更セットを確認して実行する。初回はPublicOriginが無効なプレースホルダーなので、実旅程は発行しない。出力Originを得たら、同じdeployに `--parameter-overrides PublicOrigin=https://DISTRIBUTION.cloudfront.net` を付けて更新する。循環依存を避けるための2段階設定。

参加者のCookieとパスキーはこのOrigin（パスキーのRP IDは `PublicOrigin` のホスト名）に紐づく。Distributionを作り直す、独自ドメインへ切り替えるなどでドメインが変わると、進行中の旅行の登録（Cookie・パスキー）は全員分が無効になり、ownerは `aws/recover.ts`、参加者は再招待が必要になる。旅行の途中でドメインを変えない。

AssetsBucket出力で指定された非公開S3へ `dist/public/` の6ファイル（画面の `index.html`・`app.js`・`app.css` と、足あとの地図の部品 `map.js`・`maplibre-worker.mjs`・`map.css`）だけを配置する。`aws s3 sync dist/public/ s3://BUCKET/ --profile YOUR_PROFILE --region ap-northeast-1` を使う。data/・原本・実旅程・ownerリンク・リポジトリ全体をアップロードしない。更新時はCloudFrontのキャッシュを無効化する。画面の3ファイルにはCloudFrontの応答ヘッダーポリシー（`SecurityHeaders`）が `Cache-Control: no-cache` を付けるので、端末のブラウザは開くたびにETagで確かめ直し（変わっていなければ304）、配置の後に前の版の `app.js` を使い続けない。エッジのキャッシュは無効化で新しくなるので、無効化は省かない。CloudFrontは画面のファイルを `Accept-Encoding` に合わせて Brotli か gzip に圧縮して返す（`DefaultCacheBehavior` の `Compress`。圧縮するのは 1,000 B〜10,000,000 B のファイルだけなので、`index.html`（約 700 B）と地図データ `map/*.pmtiles` は圧縮されず、地図データは Range のまま）。`sync` に `--delete` を付けない（同じバケットの `map/` の地図データを消してしまう）。

### パラメータ

`sam deploy --parameter-overrides` で渡す（渡さなかったものは前回の値のまま）。

| パラメータ | 既定 | 意味 |
|---|---|---|
| `WebCodeBucket` / `WebCodeVersion` | — | Web Function の zip の置き場とその版（上の手順） |
| `PublicOrigin` | 無効なプレースホルダー | 配信の Origin。初回の配置の後に出力 `Origin` を渡す（上の 2 段階） |
| `ReservedConcurrency` | 5 | Event Function（`Host`）の予約同時実行。`-1` で予約しない、`0` で止まる |
| `WebRateLimit` | 100 | `/v1/*` が受ける 1 秒あたりの要求。100 の倍数で 100 が下限。`0` で `/v1/*` 全部が 503（全停止） |
| `ClaimCountries` | `JP` | 招待の席を引き換えられる国（カンマ区切り）。空なら制限しない。引換の後のアクセスには国の制限をかけない |
| `DisabledActions` | 空 | 止める操作の名前（`sessions`・`grants`・`publish`・`creators`・`passkey`・`assist`・`account` など、カンマ区切り）。名指しした操作は 503 と案内を返す。綴りは検査しないので、止めたら 503 が返ることを確かめる |
| `Photos` | `'0'` | `'1'` でメンバーが写真を上げられる（下の「写真の置き場」） |
| `AssistModel` | `claude-haiku-5-5` | 作成者の API キーで生成するときのモデル（下の「作成者の API キーでの生成」） |
| `BudgetLimitUsd` / `BudgetEmail` | `0` / 空 | アカウント全体の月額予算の通知（下の「保存・費用・残る検証」） |
| `PermissionsBoundary` | 空 | スタックのロール（`HostRole`・`WebRole`）に付ける権限境界。使わなければ空のまま |

パラメータだけを変える（コードは配置し直さない）ときは `aws cloudformation update-stack --use-previous-template` に、変えるものを `ParameterValue=…`、ほかの全部を `UsePreviousValue=true` で渡す（渡さなかったパラメータは既定値に戻る）。今のパラメータの一覧は `aws cloudformation describe-stacks --stack-name $STACK --query 'Stacks[0].Parameters[].ParameterKey'` で見える。Lambda の環境変数を `update-function-configuration` で直接書かない（解決済みの秘密を含む全変数の書き直しになり、テンプレートとずれる）。

### 写真の置き場（`Media`）

**写真は既定で無効**で、スタックのパラメータ `Photos`（`'0'` が既定、`'1'` で有効）が Host と Web の `CAPSULE_PHOTOS` になる。有効にするのは、機微な情報が増えうること・費用がかさむことを検討して決めてから（`sam deploy` に `--parameter-overrides Photos=1`）。無効のあいだ `Media` は空で費用は出ず、`aws/verify.ts` は写真の場面を走らせず、Host が断ることだけを確かめる（有効のスタックでは全部走る）。

メンバーが上げた写真の画像は、旅行の鍵で暗号化した bytes（表示用とサムネイルの 2 つ）のまま、スタックの非公開 S3 バケット `Media` に置く（`src/aws-media.ts`。何を暗号化するかは仕様書の「5.2 暗号化するもの・平文に残すもの」）。バケットは公開を全部ブロックし、CloudFront の経路も署名付き URL も持たない。画像は `/v1/c/<id>/media/<写真の id>/(thumb|display)` を Web Function が Cookie の席で判定して返す（応答は `private, max-age=3600`）。キーは `<カプセルの行のキー>/<アップロードごとの名前>.(thumb|display)` で、旅行の削除（オーナーの完全削除・運用者の terminate・期限の sweep）は、行を空にする前にその prefix を消す。消せなければ行を残して次の sweep でやり直す。バケットの 181 日の有効期限は、その歯止め（旅行は作成から 180 日までなので、消し漏れがあっても 181 日で消える）で、削除の正は Host の `removeAll`。中身が暗号文なので、S3 の暗号化（SSE）は運用者に対する守りではなく既定のまま。`DeletionPolicy: Retain` なので、スタックを消してもバケットは残る（中身が空であることを確かめて手で消す）。`aws/verify.ts` は、検証用のスタックで、写真を上げ → 上げた暗号文がそのまま返る → 鍵を替えても開ける → purge の後にその prefix のオブジェクトが 0 件、を確かめる（バケット名と prefix は出力しない）。

### 足あとの地図の背景（地図データ）

足あとの地図の背景は、Protomaps が OpenStreetMap から毎日作る地図データ（PMTiles、`https://build.protomaps.com/YYYYMMDD.pmtiles`）から切り出したファイルと、その一覧 `map/regions.json` を、Assets バケットの `map/` に置いて配る。画面は `map/regions.json` に載ったファイルだけを読む。画面の配置（`dist/public/` の同期）とは別で、地図の鮮度が問われないので更新は年 1 回程度でよい。無いと背景が無地になるだけで、点と線は出る。

| ファイル | 範囲 | 大きさ（日本と世界のとき） |
|---|---|---|
| `map/world.pmtiles` | 世界、z8 まで | 約 0.56 GB |
| `map/<地域>.pmtiles` | 地域ごと、z15 まで（初めは日本 `japan`） | 日本で約 3.6 GB |
| `map/regions.json` | 上のファイルの一覧（build の日付・範囲・大きさ・SHA-256） | 小さい |

作るのは `bun aws/mapdata.ts`。中で `go-pmtiles`（BSD-3-Clause）の `pmtiles extract` を使うので、`pmtiles` を PATH に置く。作業は一時ディレクトリで行い（約 4.2 GB の空きが要る。`/tmp` が小さければ `TMPDIR` を替える）、切り出したファイルを確かめてから置き、最後に `map/regions.json` を置く（リポジトリには入れない）:

```sh
bun aws/mapdata.ts build --bucket BUCKET --profile YOUR_PROFILE                       # 世界（z8）と一覧の地域（無ければ日本、z15）。--build YYYYMMDD で build を選べる（既定は直近）
bun aws/mapdata.ts add <名前> <西の経度,南の緯度,東の経度,北の緯度> --bucket BUCKET --profile YOUR_PROFILE   # 地域を 1 つ足す（一覧の build から）
```

出力は `map/<名前>.pmtiles <bytes> <sha256>` の行と最後の `map/regions.json` だけで、バケット名やアカウントは出さない。ローカル開発（`bun run dev`）の地図データは `--bucket` と `--profile` の代わりに `--dir <開発データの置き場>` を渡す。

置いたら `bun aws/verify.ts …`（下の「AWS検証」）が、`map/regions.json` と一覧のファイルを Range で 206 で取れることを確かめる。地図データは ODbL の派生物で、地図に「© OpenStreetMap contributors」を出している（`src/map.ts`）。

### 配信ログ（`aws/edge-logs.yaml`）

CloudFront のアクセスログ（下の「保存・費用・残る検証」と、仕様書 `docs/ephemeral-trip-capsule.md` の「5.7 ログに残るもの」）は、**us-east-1** に別のスタック（`aws/edge-logs.yaml`）として配置する（CloudFront のログの配信先がそこにしか作れない）。変更セットを実行し、`PublicOrigin` を渡し、画面と地図データを置いた後（配信の `DistributionId` 出力が決まった後）に 1 回:

```sh
aws cloudformation deploy --template-file aws/edge-logs.yaml --stack-name $STACK-edge-logs --region us-east-1 --profile YOUR_PROFILE \
  --parameter-overrides DistributionArn=arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID StackName=$STACK
```

`aws/code.yaml`・`aws/edge-logs.yaml` は CI の `sam validate` の対象に入っていない。変えたときは手で `sam validate --lint --template-file …` を通す。

## AWS検証

配置・更新のたびに、架空カプセルを発行→検証→purgeする。リンクやCookieは表示しない。

```sh
bun aws/verify.ts https://DISTRIBUTION.cloudfront.net FUNCTION_NAME YOUR_PROFILE ap-northeast-1
```

旅行は、owner が席を取った直後に暗号化してから回す（#696。Host は暗号化していない旅行を、owner が暗号化するまで開かない。下の「暗号化していない旅行」）。暗号化の前には、`ui=2` の無い要求の 409「画面を更新してください」、招待・編集・足あとの 409「オーナーがこの旅行を暗号化するまで開けません」、owner と運用者の一覧の `mustSeal` を確かめ、暗号化の後は、メンバーが確認コードで鍵を受け取ってから読み書きする。出力の `AWS verification passed, on trips sealed by their owners right after claiming the seat` の行で、全部の場面が回ったことが分かる。

暗号化した旅行の場面では、旅行の鍵を替えることも見る: 鍵を持つ参加者を失効させた後に owner の `GET` が `rekey: "auto"` を返し、owner のブラウザと同じ部品（`src/trip-keys.ts`）で `POST rekey` を送ると、残った参加者が新しい世代を開けて owner の署名と認め、失効した参加者の世代 1 の鍵では開けない。続けて `/recover` の後、新しい owner が参加者から鍵を受け取ると `rekey: "ask"` になり、`keep` で消える（成功行の `trip key replaced`。ローカルの Host は `/recover` に発行者の権限を渡さないので、ここで確かめる）。テーブルの中身を読む確かめ（保存された payload の暗号文が全部世代 2 で `departed`・`previous` が無いこと、個人のメモと旅程の題が平文で残っていないこと、写真の prefix の件数）は、実旅行を読まないように、`aws/verify.ts` が名前で見分ける検証用のスタックでだけ行い、ほかのスタックでは `scan: …飛ばした` と出す。

作成者まわりは、パスキーを作れないので実際の登録はしない。未サインインで `/v1/recipe`・`/v1/check`・`/v1/publish` が401、作成者のchallengeがCloudFront越しに出ること、使えない登録リンクを添えたchallengeが401（パスキーを作る前に止まる）、でたらめな登録・サインインが401、公開HTTPからの `enroll`・`list`・`revoke` が401、作成者のCookie無しの委任リンクの要求・旅行の下での委任リンクの引換・分けた作成者の失効が401、旅行のparticipant・viewerの席での委任リンクの引換が403（ownerの席はリンクの確かめに進んで401）、IAMからの `list` が200であることを見る（成功行の `creator endpoints`）。パスキーでの登録から保存までの流れは実機で確かめる。

スタック出力 `WebEndpoint`（Web Function の直のURL）を読み、CloudFrontを迂回した署名なしの直接アクセスが403になることを毎回確認する（成功の行は `function URL direct 403 (always)`）（出力が無いスタックでは止まる。`cloudformation:DescribeStacks` が要る）。あわせて、`/v1/*` の応答に `Access-Control-Allow-Origin` が無いこと、`OPTIONS` が2xxでないこと、別カプセルへ付け替えたCookieが401になること、viewer / editor が owner 専用の操作で403になることも確かめる。ログ（配信ログと Host の拒否の行。`logs:FilterLogEvents` を 2 つのログ群に使い、`cdn` は us-east-1）を読み、Cookie の値・招待 secret・`#k=`・題名が無いことと、接続元の IP が閲覧者の IP であることも見る（ログは作ってから見えるまで数分かかるので 10 分まで待つ）。席の引換は `ClaimCountries`（既定JP）の国からだけ通るので、検証もその国から実行する。国外から運用する場合は `--parameter-overrides ClaimCountries=JP,US` のように指定し、空文字で制限を外す。

期限到達そのものは別スクリプトで確かめる。6分後が期限の架空カプセルを発行し、招待の期限切れ（401）、期限後のアクセス（410）、sweepによるpayloadチャンクの消滅を時刻つきで記録する。**架空データだけの検証用のスタックでだけ実行する。実旅行のあるスタックでは実行しない**（架空カプセルを発行し、チャンク件数をテーブル全体で数えるため）。テーブル名は `aws cloudformation describe-stack-resources` の出力を正とする（スタック出力には無い）。

```sh
bun aws/verify-expiry.ts https://DISTRIBUTION.cloudfront.net FUNCTION_NAME YOUR_PROFILE ap-northeast-1 DYNAMODB_TABLE
```

所要は**6分半〜13分**（期限まで6分＋sweep待ちが最大7分。期限の削除（sweep）は `rate(5 minutes)` の周期のどこに当たるかと、期限索引が結果整合であることの両方で遅れるので、期限から7分まで待つ）。長いので配置のたびには回さない。回すのは、期限・sweep・ライフサイクルの経路に触ったときと、実旅行のあるスタックへ初めて配置する前に1回（検証用のスタックで）。

**実行中に他のカプセルが発行されたり期限を迎えたりしないこと。** 判定は「発行前のチャンク件数に戻るか」なので、静かに存在しているカプセルは害にならないが、同時に増減すると誤って合格・不合格になる。

## 旅程発行

入力はリポジトリの外（Git に入れない場所）に置く。実名や予約情報を確認したJSONのみを対象にする。まず検証・ハッシュ確認、その後に同じ引数へ承認ハッシュを追加する。

```sh
bun aws/publish.ts <入力の JSON> FUNCTION_NAME YOUR_PROFILE ap-northeast-1
```

発行コマンドは配置済みのHostと同じ`src`で使う（Hostの入力の検査は厳密で、手元だけ新しいと送信が400で止まる）。Hostは配置したときの`src`のツリーハッシュ（`git rev-parse HEAD:src`）を埋めてあり、IAMの発行者だけが`/v1/version`で読める（HTTPには出さない）。コミットは埋めない（docsだけのコミットでLambdaの中身が変わり、同じ`src`を置いたスタックどうしのCodeSha256が合わなくなるため）。`aws/publish.ts`はハッシュを表示する前にこれを読み、手元の`src`と違えば（未コミットの変更があるときも）何も送らずに止まる。直し方は2つ: Hostを手元のコミットで配置し直す（「配置手順」）か、手元をそのHostを配置したコミット（`src`のツリーハッシュが同じならどのコミットでもよい）に合わせる（`git fetch`のあと`git switch --detach <コミット>`）。配置したコミットは自分で控えておく。`src`が同じなら、その上のdocsだけのコミットやrebaseでは止まらない。`src/`の変更は、テストや画面だけのものでも「違う」になる。`/v1/version`を持たない古いHostに対しては「Hostが古い」と止まるので、配置し直す。ずれを無視して送るオプションは無い。

ownerリンクは入力隣の権限600のファイル（`<入力>.owner.json`）に保存する。最初に開いた1台だけをownerとして登録するので、3日以内に普段使う端末のブラウザで開く。共有にはowner画面で席数を決めて発行する招待リンクを使う。

発行は操作IDで冪等になっている。初回の実行が入力隣に`<入力>.operation`（権限600）を作り、以後の実行は同じ操作IDを送る。Hostはカプセル IDをその操作IDから導くので、**タイムアウトや通信断で失敗したら、同じコマンドをそのまま再実行する**（`.operation`を消さない）。前回が成功していた場合は二重発行にならず、失われたownerリンクだけが出し直されて`.owner.json`に保存される。ownerの席がまだ空いていて受付期限の前なら再実行の応答そのものが新しいリンクを持ち（前のリンクは無効、受付期限は延びない）、席が埋まっていれば`/recover`で再発行する（前のリンクで登録した端末は無効になる）。`.owner.json`が既にあるときは何も送信しない。別の旅程として発行し直したいときだけ、`.owner.json`と`.operation`を消す。

ownerの登録ブラウザを失った場合（Cookie削除・機種変更）は、owner招待を差し替える。古いowner端末は直ちに使えなくなる。

```sh
bun aws/recover.ts CAPSULE_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1
```

保存先（既定は`./capsule-<id>.owner.json`、5つ目の引数で変えられる）が既にあるか書けないときは、Hostに何も送らずに止まる（旧オーナーの席はそのまま）。前の回復のファイルが残っていれば、使い終わったものか確かめてから消すか、別の保存先を渡す。

`lambda:InvokeFunction` を対象関数に許可する発行者IAM権限は、参加者には渡さない。

### 作成者（スマホのブラウザから旅行を作る人）

作成者はパスキーでサインインしたブラウザから新しい旅行を保存できる。作成者の権利ではどの旅行も読めないので、保存したときにownerを選ぶ: 「この端末をオーナーにする」（その場で引き換え、ownerリンクを運ぶ手順は無い）か「オーナーリンクを受け取る」（別の端末・別の人に渡す。最初に開いた1台がowner、受付3日）。ownerの席の引換は他の招待と同じく `ClaimCountries` の国からだけ通るので、国外で「この端末」を選ぶとownerになれない。画面は理由と「もう一度試す」「オーナーリンクを受け取る」を出す。保存の応答が来なかった（通信が切れた、Hostがエラーを返した）ときは、同じ画面で「この内容でカプセルを作成」をもう一度押す。同じ操作IDを送るので二重には作られず、ownerの席がまだ空いていて受付期限の前なら新しいownerリンクが返る（前のリンクは無効、受付期限は延びない）。ownerを選ばずに閉じた（ページを更新した）旅行は、作成者のトップの「オーナーを決めていない旅行」に題名・日程・削除予定が出て、そこからownerリンクを受け取り直すか削除できる（ownerが一度決まった旅行は出ない）。ownerが決まった後に端末を失ったときは `aws/recover.ts` でownerリンクを出し直す。登録・一覧はIAMの発行者だけが行う。失効はIAMの発行者と、作成権限を分けた作成者（分けた相手だけ）。

```sh
bun aws/creator.ts enroll LABEL FUNCTION_NAME YOUR_PROFILE ap-northeast-1                 # 登録リンクを ./creator-LABEL.enroll.json（権限600）に保存
bun aws/creator.ts list FUNCTION_NAME YOUR_PROFILE ap-northeast-1                         # 作成者とパスキーの一覧（秘密は含まない）
bun aws/creator.ts revoke --creator CREATOR_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1   # 作成者ごと失効
bun aws/creator.ts revoke --passkey PASSKEY_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1   # パスキー1本だけ失効
```

登録リンクは**1日・1回**。画面には表示しないので、ファイルから作成者にするスマホへ渡し、**既定のブラウザ（Safari・Chrome）**で開く（LINEなどのアプリ内ブラウザではパスキーを作れない）。パスキーを作ると作成者になり、そのままサインインした状態になる。パスキーを作れなかったときはリンクは消費されない。2台目以降の端末は、サインインしたトップ画面の「別の端末を追加」が同じ1回限りのリンクをクリップボードに作る。作成者を失効しても、その人が作った旅行とownerの席は残る。

作成者は、旅行のownerに作成権限を分けられる（トップの「作成権限を分ける」に旅行のURLを入れる。作成者のパスキーで確認し、委任リンクはクリップボードへ。委任リンクは1日・1回・作成者ごとに3件まで（IAMの登録リンクの20件とは別）で、その旅行のowner席のある端末で開き、パスキーを作ると作成者になる。owner席の無い端末・editorやviewerの席の端末では受け取れない）。分けられた作成者は、さらに分けられない。分けられた作成者も、作成者の権利ではどの旅行も読めない。失効は、分けた作成者（トップの「分けた作成者」の「失効」）かIAM（`bun aws/creator.ts revoke --creator …`。`list` の `delegatedBy` が分けた作成者のID）。分けた作成者をIAMで失効しても、分けられた作成者は残る（別の人の権利なので、要れば個別に失効する）。分けた作成者を失効する・委任リンクを出したパスキーを失効すると、まだ使われていない委任リンクも消える。

### 運用者（一覧と強制終了）

Hostの運用者の身元はIAMのまま（Webの管理者画面は無い）。生きているカプセルの一覧と、1件の強制終了はこのCLIだけが行い、公開HTTPからは呼べない（401）。

```sh
bun aws/capsules.ts list FUNCTION_NAME YOUR_PROFILE ap-northeast-1                 # 生きているカプセルの一覧（JSON）
bun aws/capsules.ts terminate CAPSULE_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1   # 1件を即時に終了。IDをもう一度入力して確かめる
```

一覧の各項目は `id`・`kind`・`state`・`created`・`updated`・`purgeAt`・`grants`（有効な招待の数）・`members`（登録している端末の数）・`sealed`（旅程を暗号化したか）・`mustSeal`（暗号化していないので、owner が暗号化するまで使えない旅行か。`sealed` の反対で、直前の `aws/capsules.ts` が読むので残している）だけで、題名・行き先・旅程・コメント・メンバー名・秘密は含まない。`id` が `null` のカプセルは、IDを本文に持つ前の古い版の Host で発行されて、その後だれも書き込んでいないもの。IDは発行の控え（`aws/publish.ts` の `<入力>.owner.json`）か、旅行のリンク（`/c/<ID>`）から探す。作成者がブラウザで保存した旅行には控えのファイルが無いので、リンクを持つ人（owner・作成者）に聞く（誰かが書き込めば一覧にIDが出る）。強制終了はownerのpurgeと同じ保存の経路で、取り消せない。以後そのカプセルへのアクセスは410になる。

### 暗号化していない旅行

Host は平文の旅行を使わない（`src/cloud-host.ts` の `mustSeal`）。発行したての旅行は平文で置かれ、owner が席を取ってパスキーで確かめ、ブラウザで暗号化する（`POST seal`）までは、owner が席を取る・パスキー・鍵を置く・暗号化する・削除するほかは 409「オーナーがこの旅行を暗号化するまで開けません」を返す。暗号化の形を持たない種類は発行しない（400）。前にあった「暗号化を始めた線」のパラメータは無くなった（#696）。それを置いていたスタックは、次の配置でそのパラメータを渡さなければ（前の値を引き継がせなければ）消える。

## 作成者の API キーでの生成

画面から旅程を作るとき、Host は作成者が登録した自分の Anthropic API キーで Anthropic の Messages API を呼ぶ（鍵の扱いは仕様書の「5.8 地図データ・写真・API キー」）。AWS 側にあるのは次のものだけ。

- パラメータ `AssistModel`（既定 `claude-haiku-5-5`）。使うモデルで、画面からは選べない。変えるときは `--parameters ParameterKey=AssistModel,ParameterValue=<モデル ID>` と、ほかのパラメータの `UsePreviousValue=true`
- Parameter Store: `/capsule-host/<スタック名>/creator-key/<作成者の ID>` の SecureString（AWS 管理キー `aws/ssm`）。値はアプリ層で封じた暗号文で、平文の鍵ではない（`sk-ant-` で始まらない）。IAM は `ssm:PutParameter` / `GetParameter` / `DeleteParameter` / `AddTagsToResource` / `ListTagsForResource`（Web Function のロールはタグは付けるだけ）をこのパスの下だけに、`ssm:GetParametersByPath` をこのパスそのものに（`Host` のロールだけ）許す
- 期限: 5 分ごとの掃除（`aws/template.yaml` の `Host` の `Cleanup`）が、旅行の掃除の後に、最後に使ってから 30 日たった鍵を消す。使った時刻は登録・上書き（`LastModifiedDate`）と生成（タグ `used`）の遅い方。消えた作成者には画面がもう一度鍵の登録を求める。鍵の掃除が失敗したときは `aws logs tail` に `sweep:keys` の行が出る（旅行の掃除は済んでいる）。標準パラメータのままでタグも無料なので、費用は 0 のまま（Advanced tier のパラメータポリシーは使わない）
- 起動: 生成は Web Function が Event Function（`Host`。環境変数 `CAPSULE_EVENT_FUNCTION`）を `InvocationType: Event` で起動して行う。IAM は `lambda:InvokeFunction` を Web Function のロールに `Host` の ARN だけ許す。非同期呼び出しの再試行は 0 回、イベントの寿命は 60 秒（`EventInvokeConfig`）
- `Host`（Event Function）の `Timeout` は 300 秒。HTTP の要求は CloudFront が origin を待つ 60 秒（`OriginReadTimeout`）で切り、Web Function の `TimeoutSeconds` も 60 秒なので、長いのは Event Function で動く生成だけ
- 費用: Parameter Store の標準パラメータは 0 USD、`aws/ssm` の管理キーは 0 USD。生成 1 回の Lambda の実行時間は 0.002 USD 未満。LLM の費用は作成者の Anthropic の請求に行き、この Host には掛からない（Host に日・月の上限は無い。回数・同時・長さの上限だけ）
- 鍵の登録・置き換え・削除は、作成者の Cookie ではサインインから 5 分以内だけ（過ぎれば 428。画面はサインインし直して送り直す）。IAM の発行者の身元は対象外
- 止めるとき: `DisabledActions` に `assist`（生成の受付）か `account`（鍵の登録・削除）を入れる。実行中の生成は締め切り（360 秒）で終わる
- ログ: 鍵・希望文・生成物は書かない。確かめるときは `aws logs tail /aws/lambda/<関数名> --since 10m` に `sk-ant-` と希望文が無いこと（`bun aws/verify.ts` も `sk-ant-` を見る）

## 保存・費用・残る検証

DynamoDBは従量、カプセル1.9MBまで。JSONを128KiB以下のバイナリ項目へ分割し、メタデータと最大16片を単一トランザクションで読み書きする。400KiBの項目制限を超えず、更新・失効・削除が部分反映されない。項目ごとの更新より書き込み費用が増えるため、大規模化時には予定・Grant・Session別の更新へ移行する。料金比較のAPI単価だけを総額と見なさない。

期限アクセス拒否はリクエスト時、物理削除は5分周期。TTLはレート制限と削除済みメタデータの後処理だけ。期限索引は結果整合なので削除反映の遅れがあり得る。DynamoDBのバックアップ（PITR・オンデマンド）は使わない（下の「バックアップ方針」）。Secrets Manager 1件（HMAC鍵）、ログ、S3、CloudFront等も課金対象。`/v1/*` は Web Function で 100 req/s・環境 2、Event Function は同時実行 5 を設定しているが、月額上限保証ではない（下の「レート制限とスロットル」）。

ログはどれも保持 90 日（配信ログ `/capsule-host/<スタック名>/cdn` は us-east-1、Host の拒否の行 `/capsule-host/<スタック名>/web` と `web.local`、`/aws/lambda/<関数名>`）。何が残り、何を残さないかは仕様書の「5.7 ログに残るもの」。保存と取り込みは月 0.1 USD 未満の見積もり（単価からの計算）で、Logs Insights の検索は走査した量に課金される。

### レート制限とスロットル

Host が数える上限（`src/cloud-host.ts` の `rate()`。1 分あたり、DynamoDB に数える）:

| 鍵 | 上限 | 数える要求 |
|---|---|---|
| `ip:<IP>` | 300 | すべての要求 |
| `login:<IP>` | 15 | ログイン系（参加の `sessions`、`passkey/challenge`・`session`・`verify`、作成者の登録・サインイン） |
| `capsule:<id>` | 600 | **認証を通った要求だけ** |
| `grant:<id>` | 120 | 認証を通った要求だけ |

`capsule:` を認証の前に数えると、カプセル ID を知るだけの相手（URL を見た人、失効済みメンバー）が Cookie 無しで 600 回送れば、その旅行のメンバー全員が 429 になる。Cookie 無しの要求は `ip:` と `login:` だけで絞る。

`ip` は CloudFront が閲覧者の接続から付けて上書きする `CloudFront-Viewer-Address` だけから取る（`src/aws-handler.ts` の `viewerIp()`、入口は `src/aws-web.ts`）。`X-Forwarded-For` は読まない（先頭は閲覧者が偽造でき、末尾は CloudFront の IP）。ヘッダが無い要求（署名つきの直叩きがヘッダを付け忘れた）は 403 で、IP 不明のまま Host に渡さない。配信ログの `c-ip` も拒否の行の `ip` も閲覧者の IP。

`/v1/*` 全体の上限は Web Function のエンドポイントの 2 つの設定で、**費用の上限**:

| 設定 | 値 | 超えたとき |
|---|---|---|
| `ThrottleConfig.RateLimit`（パラメータ `WebRateLimit`） | 100 rps | 超えた分は Lambda が 429 で返し、関数に届かない。値は 100 の倍数で、**100 rps が下限**。0 は全停止（503） |
| `ScalingConfig.MaxEnvironments` | 2 | 環境が 2 つとも一杯（環境ごとに最大 64 の同時要求）なら、待たせずに 429（`lambda-web-error-type: Platform.EndpointMaxEnvThrottle`） |

続けて 100 rps 受けた最悪の月は約 259M 要求で、Web Function の要求料金（0.30 USD/百万、US East の公開価格。東京は公開されていない）だけで約 78 USD に、動いた CPU 時間とメモリが足される。実際の旅行の通信はこれよりずっと少ない。誰でもこれを使い切れるので、可用性の保証ではない。WAF は固定費がかかるので置かない。細かい上限は Host の `rate()`（上の表。IP・ログイン・カプセル単位）が受け持つ。Web Function の環境は無通信の 3〜5 分で止まり、固定費は無い。

**直接呼べる主体**: Web Function のエンドポイントは `IamAuth` で、リソースポリシーは CloudFront（この配信）だけを許す。同じアカウントでは `lambda:InvokeWebFunctionEndpoint` を持つ主体（管理者）も、署名つきで直接呼べ、そのとき偽の `CloudFront-Viewer-Country` / `CloudFront-Viewer-Address` がそのまま届く。**運用者以外の主体にこのアクションを渡さない**。署名なしの直叩きは 403 で、`aws/verify.ts` が毎回確かめる。

予算アラート: パラメータ `BudgetLimitUsd`（整数の USD）と `BudgetEmail` を渡すと、アカウント全体の月額予算（AWS Budgets）を作る。実際の費用が80%を超えたときと、月末の予測が100%を超えたときにメールが届く。通知だけで、超えても何も止まらない。予算はアカウント全体のものなので、**同じアカウントの 1 つのスタックにだけ**渡す（2 つに渡すと同じ予算が 2 本になる）。一度渡せば、以後の `sam deploy` は渡さなかったパラメータを前回の値のまま使うので、予算は残る（消えるのは `BudgetLimitUsd=0` を明示したときだけで、そのとき変更セットに `Budget` の Remove が出る）。通知先のメールはリポジトリに書かない。`BudgetEmail` なしで金額だけを渡しても予算は作られない（変更セットに `Budget` の Add が出ないことで分かる）。

AWS上で公開前に確認: SAM lint、作成と重複更新、席の引換と端末束縛、受付期限、viewer/participant制限、メンバー単位の失効、期限拒否とスケジュール物理削除（`aws/verify-expiry.ts` を検証用のスタックで1回）、ZIP出力、パスキーの登録と復帰（RP IDがOriginのホスト名であること、cookie無しの復帰要求が席を消費しないこと）、秘密が配布物・ログにないこと（`aws/verify.ts` が API のアクセスログと Host の拒否の行を読み、Cookie の値・招待 secret・`#k=`・題名が無いことを確かめる）。静的画面のブラウザー確認も必要。

## バックアップ方針

**DynamoDBのPITR（ポイントインタイム復元）もオンデマンドバックアップも使わない。** テンプレートにPITRを有効にするフラグも置かない。

理由:
1. このHostの約束は「期限で消える」こと。バックアップは、期限やpurgeで消したはずの旅程の写しを残す（PITRは最大35日、オンデマンドバックアップは消すまで無期限）
2. 旅行の後に残したいものは、ownerがExport（ZIP）で手元に持ち出す。Hostは保管庫ではない
3. 誤ったスタック削除による一括消失は、`Data` / `Assets` の `DeletionPolicy: Retain` で防いでいる
4. PITRは保存量に応じた継続課金で、使わない月にも費用がかかる

失うもの: テーブルの破損や誤操作（手でのItem削除など）が起きると、進行中の旅行は戻らない。ownerには旅行中もExportを取っておくよう勧める（owner画面の「旅を保存」）。

復元した場合の扱い: このテンプレートには復元の手順も口も無い。DynamoDBの復元は必ず別名の新しいテーブルになり、`Data` はテーブル名を持たずLambdaへ `!Ref` で渡しているので、向け直すにはテンプレートの変更が要る。それでも手でバックアップを取って復元したときは、**復元時点より後の操作がすべて取り消される**ことに注意する。戻るのは、手でのpurge（`purged_at` の墓標）、早めた期限（`purge_at`）、招待リンクとメンバーの失効、ownerリンクの交換、共有の終了、パスキーと作成者の失効。つまり、漏れたリンクを失効させていても復元後は再び使え、早めた期限の後でも読める。期限は保存行の `purge_at` でリクエストのたびに確かめ（過ぎていれば410、`src/cloud-host.ts`）、5分おきのsweepが消すので、復元した行の期限を過ぎたものは読めずに消える。復元したら、公開する前に、復元時点より後に行った上の操作を利用者が確かめてすべてやり直す。
