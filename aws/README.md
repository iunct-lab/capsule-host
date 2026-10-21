# AWS deployment

採用先: AWS。参加者のアカウントは不要。旅行の発行はIAMで許可されたLambda Invokeと、パスキーでサインインした作成者（スマホのブラウザ）だけ。それ以外の公開HTTP経路のpublishは拒否する。作成者の登録・失効はIAMだけ（下の「作成者」）。

## 現状

SAM定義、Lambda入口、DynamoDBアダプター、発行CLI、AWS検証スクリプトを用意した。Origin・バケット・関数名はスタック出力（`aws cloudformation describe-stacks`）を正とし、ここには書かない。期限の削除（sweep）は `rate(5 minutes)` の周期のどこに当たるかと、期限索引が結果整合であることの両方で遅れるので、`aws/verify-expiry.ts` は期限から7分まで待つ。配置と検証の経過は配置の記録（Private のリポジトリだけにある）に残す。

## 配置手順

dev と prod は**同じ AWS アカウントの別スタック**（`capsule-host-dev` / `capsule-host-prod`、どちらも ap-northeast-1）。`--profile` は同じで、区別はスタック名だけなので、`--stack-name` を間違えないこと。DynamoDB・S3・秘密鍵・Origin はスタックごとに分かれる。**`aws/verify.ts` による検証と、試しの発行は dev で行う**（devには架空データしか置かない）。prod で架空カプセルを使うのは配置直後の smoke test だけで、発行したら削除する（`docs/development-and-release.md` の「B. 共通HostをAWSへ配置する」）。

AWS CLI v2 と SAM CLI、対象プロファイルのログインが必要。この独立リポジトリのルートで操作する。

`/v1/*` は Lambda Web Function（`aws/template.yaml` の `Web*`）が受け、CloudFront が OAC で署名して呼ぶ（設計と実測: `docs/design/lambda-web-functions.md`）。Web Function のリビジョンは作った後に変えられず、**S3 のバージョン付きの zip** を指す。そのバケットはスタックごとの小さい別スタック（`aws/code.yaml`）で**最初に 1 回だけ**作る。コードを替えるたびに新しい zip を上げ、その `VersionId` を `sam deploy` に渡す（渡さないと配置できない。リビジョンが作り直される）:

```sh
STACK=capsule-host-dev
aws cloudformation deploy --template-file aws/code.yaml --stack-name $STACK-code --region ap-northeast-1 --profile YOUR_PROFILE   # 初回だけ
bun run build
BUCKET=$(aws cloudformation describe-stacks --stack-name $STACK-code --region ap-northeast-1 --profile YOUR_PROFILE --query 'Stacks[0].Outputs[0].OutputValue' --output text)
Z=$(mktemp -d /tmp/capsule-host.webzip.XXXXXX); (cd dist/aws-web && zip -q $Z/web.zip index.mjs)      # 入口は zip の根の index.mjs
VERSION=$(aws s3api put-object --bucket $BUCKET --key web.zip --body $Z/web.zip --region ap-northeast-1 --profile YOUR_PROFILE --query VersionId --output text); rm -rf $Z
sam validate --lint --template-file aws/template.yaml
sam deploy --template-file aws/template.yaml --stack-name $STACK --resolve-s3 --capabilities CAPABILITY_IAM --region ap-northeast-1 --profile YOUR_PROFILE --parameter-overrides WebCodeBucket=$BUCKET WebCodeVersion=$VERSION --no-execute-changeset
```

変更セットで、テーブル（`Data`）・`Assets` バケットが置き換え・削除になっていないことを見る。**以前の経路（`/v1/*` を別のゲートウェイ越しに受けていた版）の既存スタック（prod）を初めてこの template に更新するときは、その前に利用者に聞く**: 更新で古いアクセスログ群（`/capsule-host/<スタック名>/api`、直近 90 日ぶんの侵害確認の証跡）がスタックと一緒に消える（dev は架空データだけなので消えた）。残すなら、配置の前に `aws logs create-export-task` で S3 に書き出すか、そのロググループに `DeletionPolicy: Retain` を付けた中間の template を 1 回通す。配信ログ（新しい `cdn`）は配置の後から溜まり、前のぶんは入らない。dev で既存のスタックを更新したときは約 6 分で終わった（#679）。Web Function は空の環境変数を受けない（変更セットの作成が止まる）ので、空が正しい `ClaimCountries`・`DisabledActions` は、空のときは変数を付けない作りになっている。

CloudFront のアクセスログ（下の「侵害の確認（ログ）」）は、**us-east-1** に別のスタック（`aws/edge-logs.yaml`）として配置する（CloudFront のログの配信先がそこにしか作れない）。スタックができて配信（`DistributionId` 出力）が決まったあとに 1 回:

```sh
aws cloudformation deploy --template-file aws/edge-logs.yaml --stack-name $STACK-edge-logs --region us-east-1 --profile YOUR_PROFILE \
  --parameter-overrides DistributionArn=arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID StackName=$STACK
```

`aws/code.yaml`・`aws/edge-logs.yaml` は CI の `sam validate` の対象に入っていない。変えたときは手で `sam validate --lint --template-file …` を通す。

Lambda同時実行上限が10の新規アカウントは予約同時実行を確保できず、Hostの作成に失敗する。上限引き上げまでは `--parameter-overrides ReservedConcurrency=-1` で予約を無効化する。この場合のHostの抑止は無くなる（`/v1/*` の上限は Web Function の `RateLimit` と `MaxEnvironments`。下の「レート制限とスロットル」）ため、Service Quotasで引き上げて既定の5へ戻す。`sam deploy` は渡さなかったパラメータを前回の値のまま使うので、-1から戻すときは `ReservedConcurrency=5` を明示して渡す。作成失敗でロールバックした場合、Retain指定のS3/DynamoDBは空のまま残るので、中身が空であることを確認して手動で削除する。

まずCloudFormation変更セットを確認して実行する。初回はPublicOriginが無効なプレースホルダーなので、実旅程は発行しない。出力Originを得たら、同じdeployに `--parameter-overrides PublicOrigin=https://DISTRIBUTION.cloudfront.net` を付けて更新する。循環依存を避けるための2段階設定。

参加者のCookieとパスキーはこのOrigin（パスキーのRP IDは `PublicOrigin` のホスト名）に紐づく。Distributionを作り直す、独自ドメインへ切り替えるなどでドメインが変わると、進行中の旅行の登録（Cookie・パスキー）は全員分が無効になり、ownerは `aws/recover.ts`、参加者は再招待が必要になる。旅行の途中でドメインを変えない。

AssetsBucket出力で指定された非公開S3へ `dist/public/` の6ファイル（画面の `index.html`・`app.js`・`app.css` と、足あとの地図の部品 `map.js`・`maplibre-worker.mjs`・`map.css`）だけを配置する。`aws s3 sync dist/public/ s3://BUCKET/ --profile YOUR_PROFILE --region ap-northeast-1` を使う。data/・原本・実旅程・ownerリンク・リポジトリ全体をアップロードしない。更新時はCloudFrontのキャッシュを無効化する。画面の3ファイルにはCloudFrontの応答ヘッダーポリシー（`SecurityHeaders`）が `Cache-Control: no-cache` を付けるので、端末のブラウザは開くたびにETagで確かめ直し（変わっていなければ304）、配置の後に前の版の `app.js` を使い続けない。エッジのキャッシュは今どおり無効化で新しくなるので、無効化は省かない。CloudFrontは画面のファイルを `Accept-Encoding` に合わせて Brotli か gzip に圧縮して返す（`DefaultCacheBehavior` の `Compress`、#569。圧縮するのは 1,000 B〜10,000,000 B のファイルだけなので、`index.html`（約 700 B）と地図データ `map/*.pmtiles` は圧縮されず、地図データは Range のまま）。圧縮を有効にする前にエッジに入った版も、配置後の無効化で入れ替わる。`sync` に `--delete` を付けない（同じバケットの `map/` の地図データを消してしまう）。

### dev 用のロール（`aws/dev-agent.yaml`）

エージェントが SSO の承認を待たずに dev を配置・検証するためのロール `capsule-host-agent-dev`（スタック `capsule-host-agent-dev`）。引き受けられるのは Switchboard のホストのインスタンスロール 1 つだけで、セッションは 1 時間。prod は今のまま管理者の SSO と利用者の OK で触る。

| 許す | 許さない |
|---|---|
| `capsule-host-dev` の変更セットの作成・実行（実行ロール `capsule-host-agent-dev-cfn` を渡すときだけ）、SAM の変換 | `capsule-host-prod` とほかのスタック、`capsule-host-agent-dev` 自身、取り込み（import）の変更セット |
| このスタックの成果物バケット・`capsule-host-dev-code-*`・`capsule-host-dev-assets-*` への put、dev の配信の無効化 | prod のバケット・配信 |
| `capsule-host-dev-*` の関数の invoke・get、テーブルの scan、dev のログ群の読み取り（`aws/verify.ts`・`aws/verify-expiry.ts`・`aws/invoke.ts` が呼ぶもの） | prod の関数・テーブル・ログ群 |
| IAM は実行ロールを CloudFormation に渡すことだけ | IAM のロール・ユーザー・アクセスキー・ポリシーの作成と変更 |

- ロールを直接作らせない: IAM はロールの信頼ポリシーの中身を条件にできないので、作れると別アカウントを信頼する強いロールを作れる（Switchboard の `aws/dak-dev.yaml` と同じ判断）。dev のスタックのロール（`HostRole`・`WebRole`）は、CloudFormation が実行ロール `capsule-host-agent-dev-cfn` で、`capsule-host-dev-*` の名前と境界 `capsule-host-agent-dev-boundary`（dev の資源だけ）が付くときだけ作り・変える。境界は外せない
- 実行ロールは名前に `capsule-host-dev-` が入る資源（関数・テーブル・バケット・ログ群・規則・CloudFront の関数）を名前で、名前の無い秘密鍵をスタックのタグで、配信を `DevDistributionId` で、CloudFront の OAC と応答ヘッダー・オリジン要求のポリシー（ID しか持たない）を `DevEdgeConfigs` の ID で絞る。prod のものを dev のスタックに取り込む import はロールに許さない。dev の template がこれらを作り直して ID が変わったら、このスタックを新しい ID で配置し直す（古い ID は消せないまま残るので、管理者が消す）
- SAM の共有の成果物バケット（`--resolve-s3`）は使わない。prod の配置も同じバケットの同じキーを使うので、書けると prod の配置が差し替えられた中身を使う。dev 用の成果物バケット（出力 `ArtifactsBucket`、7 日で消える）を `--s3-bucket` に渡す
- ロール名は `capsule-host-agent-dev*` で、`capsule-host-dev-*` の許可に自分自身が入らない
- 実行ロールは `role/capsule-host-dev-*` を Lambda に渡せる（PassRole は境界を条件にできない）。その名前のロールがみな境界付きであることを、配置のあとに確かめる（下の `get-role` の出力の境界が全部 `capsule-host-agent-dev-boundary`。`list-roles` は境界を返さないので使わない）
- `ExecuteChangeSet` は実行ロールを条件にできないので、ロールは dev のスタックにある変更セットなら誰が作ったものでも実行できる。管理者も dev の変更セットは `--role-arn <CfnRoleArn>` で作り、ほかのロールの変更セットを実行しないまま残さない

配置は管理者の SSO で 1 回だけ（許可を変えるときも管理者の SSO だけ。ロール自身はこのスタックを変えられない）。ホストがインスタンスロールを作り直したら（名前が変わる）配置し直す。ホストのインスタンスロールの側にも、このロールへの `sts:AssumeRole` の許可が要る（Switchboard の側で足す）:

```sh
aws cloudformation deploy --template-file aws/dev-agent.yaml --stack-name capsule-host-agent-dev --region ap-northeast-1 --profile YOUR_PROFILE \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides HostRoleArn=<ホストの InstanceRole の ARN> DevDistributionId=<dev の DistributionId> \
  DevEdgeConfigs=origin-access-control/<Access>,origin-access-control/<WebAccess>,response-headers-policy/<SecurityHeaders>,origin-request-policy/<ApiRequest>
aws cloudformation describe-stack-resources --stack-name capsule-host-dev --region ap-northeast-1 --profile YOUR_PROFILE --query 'StackResources[?starts_with(ResourceType,`AWS::CloudFront`)].[LogicalResourceId,PhysicalResourceId]'   # <Access> などの ID
aws cloudformation describe-stacks --stack-name capsule-host-agent-dev --region ap-northeast-1 --profile YOUR_PROFILE --query 'Stacks[0].Outputs'   # RoleArn・CfnRoleArn・BoundaryArn・ArtifactsBucket
```

dev のスタックは、その出力を渡して配置する（境界は `HostRole` と `WebRole` に付く。prod には渡さないので変わらない）:

```sh
sam deploy --template-file aws/template.yaml --stack-name capsule-host-dev --role-arn <CfnRoleArn> --s3-bucket <ArtifactsBucket> --capabilities CAPABILITY_IAM --region ap-northeast-1 --profile YOUR_PROFILE \
  --parameter-overrides WebCodeBucket=$BUCKET WebCodeVersion=$VERSION PermissionsBoundary=<BoundaryArn> --no-execute-changeset
for r in $(aws iam list-roles --profile YOUR_PROFILE --query "Roles[?starts_with(RoleName,'capsule-host-dev-')].RoleName" --output text); do
  aws iam get-role --role-name $r --profile YOUR_PROFILE --query '[Role.RoleName,Role.PermissionsBoundary.PermissionsBoundaryArn]' --output text; done   # 全部に境界
```

### 足あとの地図の背景（地図データ）

足あとの地図の背景は、Protomaps が OpenStreetMap から毎日作る地図データ（PMTiles、`https://build.protomaps.com/YYYYMMDD.pmtiles`）から切り出した 2 つのファイルを、Assets バケットの `map/` に置いて配る（設計: `docs/design/footprint-basemap.md`、#563）。画面の配置（`dist/public/` の同期）とは別で、地図の鮮度が問われないので更新は年 1 回程度でよい。無いと背景が無地になるだけで、点と線は出る。

| ファイル | 範囲 | 大きさ（2026-10-11） |
|---|---|---|
| `map/japan.pmtiles` | 日本、z15 まで | 約 3.6 GB |
| `map/world.pmtiles` | 世界、z8 まで | 約 0.56 GB |

作り方は `go-pmtiles`（BSD-3-Clause）の `pmtiles extract`。`<日付>` は直近の build。作業ディレクトリは約 4.2 GB の空きのある場所に作り（`/tmp` が小さければ `TMPDIR` を替える）、置いたら消す（リポジトリに入れない）:

```sh
W=$(mktemp -d "${TMPDIR:-/tmp}/capsule-host.mapdata.XXXXXX")
pmtiles extract https://build.protomaps.com/<日付>.pmtiles "$W/japan.pmtiles" --bbox=122.93,20.42,153.99,45.56 --maxzoom=15 --download-threads=8
pmtiles extract https://build.protomaps.com/<日付>.pmtiles "$W/world.pmtiles" --maxzoom=8 --download-threads=8
pmtiles show "$W/japan.pmtiles"     # ヘッダーの範囲とズームを確かめる
aws s3 cp "$W/japan.pmtiles" s3://BUCKET/map/japan.pmtiles --profile YOUR_PROFILE --region ap-northeast-1
aws s3 cp "$W/world.pmtiles" s3://BUCKET/map/world.pmtiles --profile YOUR_PROFILE --region ap-northeast-1
rm -rf "$W"
```

置いたら `bun aws/verify.ts …`（下の「AWS検証」）が、2 つのファイルを Range で 206 で取れることを確かめる。地図データは ODbL の派生物で、地図に「© OpenStreetMap contributors」を出している（`src/map.ts`）。保存の費用は `COSTS-AND-PRIVACY.md`。地域を足す・作り直しを 1 つの手順にするのは #564。

## AWS検証

配置・更新のたびに、架空カプセルを発行→検証→purgeする。リンクやCookieは表示しない。

```sh
bun aws/verify.ts https://DISTRIBUTION.cloudfront.net FUNCTION_NAME YOUR_PROFILE ap-northeast-1
```

作成者まわりは、パスキーを作れないので実際の登録はしない。未サインインで `/v1/recipe`・`/v1/check`・`/v1/publish` が401、作成者のchallengeがCloudFront越しに出ること、使えない登録リンクを添えたchallengeが401（パスキーを作る前に止まる）、でたらめな登録・サインインが401、公開HTTPからの `enroll`・`list`・`revoke` が401、IAMからの `list` が200であることを見る（成功行の `creator endpoints`）。パスキーでの登録から保存までの流れは実機で確かめる。

スタック出力 `WebEndpoint`（Web Function の直のURL）を読み、CloudFrontを迂回した署名なしの直接アクセスが403になることを毎回確認する（成功の行は `function URL direct 403 (always)`）（出力が無いスタックでは止まる。`cloudformation:DescribeStacks` が要る）。あわせて、`/v1/*` の応答に `Access-Control-Allow-Origin` が無いこと、`OPTIONS` が2xxでないこと、別カプセルへ付け替えたCookieが401になること、viewer / editor が owner 専用の操作で403になることも確かめる。席の引換は `ClaimCountries`（既定JP）の国からだけ通るので、検証もその国から実行する。国外から運用する場合は `--parameter-overrides ClaimCountries=JP,US` のように指定し、空文字で制限を外す。

期限到達そのものは別スクリプトで確かめる。6分後が期限の架空カプセルを発行し、招待の期限切れ（401）、期限後のアクセス（410）、sweepによるpayloadチャンクの消滅を時刻つきで記録する。**devでだけ実行する。prodでは実行しない**（架空カプセルを発行し、チャンク件数をテーブル全体で数えるため。prodには実カプセルが入っている）。テーブル名は `aws cloudformation describe-stack-resources` の出力を正とする（スタック出力には無い）。

```sh
bun aws/verify-expiry.ts https://DISTRIBUTION.cloudfront.net FUNCTION_NAME YOUR_PROFILE ap-northeast-1 DYNAMODB_TABLE
```

所要は**6分半〜13分**（期限まで6分＋sweep待ちが最大7分）。長いので配置のたびには回さない。回すのは、期限・sweep・ライフサイクルの経路に触ったときと、**prod公開の前に1回（devで）**。

**実行中に他のカプセルが発行されたり期限を迎えたりしないこと。** 判定は「発行前のチャンク件数に戻るか」なので、静かに存在しているカプセルは害にならないが、同時に増減すると誤って合格・不合格になる。

## 侵害の確認（ログ）

A2B 型の評価（#607）で NICT が勧める「期間中のアクセス・API・認証のログを確認する」のための手順。ログ群は 2 つで、どちらも保持は 90 日。

| ログ群 | 中身 | 項目 |
|---|---|---|
| `/capsule-host/<スタック名>/cdn`（**us-east-1**） | CloudFront のアクセスログ（標準ログ v2）。`/v1/*` に届いた全要求（OAC の署名を付ける前の、閲覧者から見た要求） | `timestamp`（秒）・`c-ip`・`cs-method`・`cs-uri-stem`・`sc-status`・`sc-bytes`・`cs(User-Agent)`・`x-edge-detailed-result-type`・`time-taken` |
| `/capsule-host/<スタック名>/web`（と `.local`） の `"kind":"refused"` の行 | Host が 4xx / 5xx で返した要求 1 件につき 1 行（Web Function の標準出力） | `capsule`（カプセル id。`/v1/c/<id>` の要求だけ）・`action`・`method`・`status`・`reason`・`ip` |

**記録しないもの**: Cookie・招待 secret・本文・題名・クエリ文字列・例外の文。`reason` は `rate:ip` / `rate:login` / `rate:capsule` …（レート制限の範囲）か、Host が返す固定の文言。配信ログは項目を選んでいて、`cs-uri-query`・`cs(Cookie)`・`cs(Referer)` は入れていない（`aws/edge-logs.yaml` の `RecordFields`）。`aws/verify.ts` がこれらが 2 つのログ群に無いことを毎回確かめる。2 つは時刻と `path`（カプセル id）で突き合わせる。**残らないもの**: Web Function の直の URL への署名なしの呼び出し（403）は、Lambda が関数に渡す前に断るのでどのログ群にも残らない（CloudTrail のデータイベントは有料なので有効にしていない）。同時要求の上限（`MaxEnvironments`）で断られた 429 も関数のログには残らない（CloudFront のログには `429` で残る）。ログは作ってから最初の行が見えるまで数分かかる（配信の遅延。`aws/verify.ts` は 10 分まで待つ）。`aws/verify.ts` のログの確認は、`logs:FilterLogEvents` を 2 つのログ群（`cdn` は us-east-1）に使うので、prod の smoke test でも同じプロファイルで読めることを配置の前に確かめる。

配信ログの `c-ip` は**閲覧者の IP**（CloudFront が閲覧者の接続から付ける。エッジの IP ではない）。Host の拒否の行の `ip` も、同じ値（`CloudFront-Viewer-Address`）から取る。`aws/verify.ts` がその都度 `access log address:` に出し、エッジの範囲に入っていれば失敗する。

見る期間は `aws logs start-query --start-time <epoch 秒> --end-time <epoch 秒>`（Logs Insights は期間内だけを走査する）。`cdn` は `--region us-east-1`、`web` は `--region ap-northeast-1`。例（`<スタック名>` はスタック名。Web Function の標準出力は JSON の文字列として入るので、拒否の行は `like` と `parse` で読む。dev で動くことを確かめた）:

```sh
Q() { id=$(aws logs start-query --log-group-name "$1" --start-time "$S" --end-time "$E" --query-string "$2" --profile YOUR_PROFILE --region "$3" --query queryId --output text); until [ "$(aws logs get-query-results --query-id "$id" --profile YOUR_PROFILE --region "$3" --query status --output text)" = Complete ]; do sleep 2; done; aws logs get-query-results --query-id "$id" --profile YOUR_PROFILE --region "$3"; }
S=$(date -d '7 days ago' +%s); E=$(date +%s)
# (a) 未認証の大量取得: 401 / 403 を IP ごとに多い順
Q /capsule-host/<スタック名>/cdn 'filter `sc-status` = 401 or `sc-status` = 403 | stats count(*) as requests by `c-ip` | sort requests desc | limit 20' us-east-1
# (b) 同じカプセル id への連続した 401: カプセルと 5 分の窓ごと
Q /capsule-host/<スタック名>/web 'filter @message like /refused/ and @message like /status\\":401/ | parse @message /capsule\\":\\"(?<capsule>[a-f0-9]{32})/ | filter ispresent(capsule) | stats count(*) as refusals by capsule, bin(5m) | sort refusals desc | limit 20' ap-northeast-1
# (c) 同じ IP からの 429 と、その種類（rate:ip / rate:login / rate:capsule …。足あとの「1分に1回」は固定の文言）
Q /capsule-host/<スタック名>/cdn 'filter `sc-status` = 429 | stats count(*) as requests by `c-ip` | sort requests desc | limit 20' us-east-1
Q /capsule-host/<スタック名>/web 'filter @message like /refused/ and @message like /status\\":429/ | parse @message /reason\\":\\"(?<reason>[^\\"]*)/ | stats count(*) as refusals by reason | sort refusals desc' ap-northeast-1
```

(b) で多いカプセル id があれば、その id の `cs-uri-stem` を配信ログで引き、`c-ip` と `cs(User-Agent)` と時刻を見る。見つかった場合の対処（招待リンクの失効・回収）は `aws/recover.ts` と下の運用者の節。Logs Insights は走査した量に課金される（東京で 1 GB あたり約 0.0076 USD。1 か月ぶんでも数 MB なので、手で数回打つ範囲では 0.01 USD に届かない）。アラームと自動の検知は作っていない（見る手順だけ）。月額は 0.1 USD 未満の見積もり（`COSTS-AND-PRIVACY.md` の「ログ」）。

## 旅程発行

入力はGit除外のdata/imports等に置く。実名や予約情報を確認したJSONのみを対象にする。まず検証・ハッシュ確認、その後に同じ引数へ承認ハッシュを追加する。

```sh
bun aws/publish.ts ../capsule-data/legacy-data/imports/trip-anonymized.json FUNCTION_NAME YOUR_PROFILE ap-northeast-1
```

発行コマンドは配置済みのHostと同じ`src`で使う（Hostの入力の検査は厳密で、手元だけ新しいと送信が400で止まる）。Hostは配置したときの`src`のツリーハッシュ（`git rev-parse HEAD:src`）を埋めてあり、IAMの発行者だけが`/v1/version`で読める（HTTPには出さない）。コミットは埋めない（docsだけのコミットでLambdaの中身が変わり、devとprodのCodeSha256が合わなくなるため）。`aws/publish.ts`はハッシュを表示する前にこれを読み、手元の`src`と違えば（未コミットの変更があるときも）何も送らずに止まる。直し方は2つ: Hostを手元のコミットで配置し直す（「配置手順」）か、手元をそのHostを配置したコミット（配置の記録（Private のリポジトリだけにある `docs/releases.md`）の同じ環境の最新の行。`src`のツリーハッシュが同じならどのコミットでもよい）に合わせる（`git fetch`のあと`git switch --detach <コミット>`）。`src`が同じなら、その上のdocsだけのコミットやrebaseでは止まらない。`src/`の変更は、テストや画面だけのものでも「違う」になる。`/v1/version`を持たない古いHostに対しては「Hostが古い」と止まるので、配置し直す。ずれを無視して送るオプションは無い。

ownerリンクは入力隣の権限600のファイル（`<入力>.owner.json`）に保存する。最初に開いた1台だけをownerとして登録するので、3日以内に普段使う端末のブラウザで開く。共有にはowner画面で席数を決めて発行する招待リンクを使う。

発行は操作IDで冪等になっている。初回の実行が入力隣に`<入力>.operation`（権限600）を作り、以後の実行は同じ操作IDを送る。Hostはカプセル IDをその操作IDから導くので、**タイムアウトや通信断で失敗したら、同じコマンドをそのまま再実行する**（`.operation`を消さない）。前回が成功していた場合は二重発行にならず、失われたownerリンクだけが出し直されて`.owner.json`に保存される。ownerの席がまだ空いていて受付期限の前なら再実行の応答そのものが新しいリンクを持ち（前のリンクは無効、受付期限は延びない）、席が埋まっていれば`/recover`で再発行する（前のリンクで登録した端末は無効になる）。`.owner.json`が既にあるときは何も送信しない。別の旅程として発行し直したいときだけ、`.owner.json`と`.operation`を消す。

ownerの登録ブラウザを失った場合（Cookie削除・機種変更）は、owner招待を差し替える。古いowner端末は直ちに使えなくなる。

```sh
bun aws/recover.ts CAPSULE_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1
```
`lambda:InvokeFunction` を対象関数に許可する発行者IAM権限は、参加者には渡さない。

### 作成者（スマホのブラウザから旅行を作る人）

作成者はパスキーでサインインしたブラウザから新しい旅行を保存できる。作成者の権利ではどの旅行も読めないので、保存したときにownerを選ぶ: 「この端末をオーナーにする」（その場で引き換え、ownerリンクを運ぶ手順は無い）か「オーナーリンクを受け取る」（別の端末・別の人に渡す。最初に開いた1台がowner、受付3日）。ownerの席の引換は他の招待と同じく `ClaimCountries` の国からだけ通るので、国外で「この端末」を選ぶとownerになれない。画面は理由と「もう一度試す」「オーナーリンクを受け取る」を出す。保存の応答が来なかった（通信が切れた、Hostがエラーを返した）ときは、同じ画面で「この内容でカプセルを作成」をもう一度押す。同じ操作IDを送るので二重には作られず、ownerの席がまだ空いていて受付期限の前なら新しいownerリンクが返る（前のリンクは無効、受付期限は延びない）。ownerを選ばずに閉じた（ページを更新した）旅行は、作成者のトップの「オーナーを決めていない旅行」に題名・日程・削除予定が出て、そこからownerリンクを受け取り直すか削除できる（ownerが一度決まった旅行は出ない）。ownerが決まった後に端末を失ったときは `aws/recover.ts` でownerリンクを出し直す。登録・一覧・失効はIAMの発行者だけが行う。

```sh
bun aws/creator.ts enroll LABEL FUNCTION_NAME YOUR_PROFILE ap-northeast-1                 # 登録リンクを ./creator-LABEL.enroll.json（権限600）に保存
bun aws/creator.ts list FUNCTION_NAME YOUR_PROFILE ap-northeast-1                         # 作成者とパスキーの一覧（秘密は含まない）
bun aws/creator.ts revoke --creator CREATOR_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1   # 作成者ごと失効
bun aws/creator.ts revoke --passkey PASSKEY_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1   # パスキー1本だけ失効
```

登録リンクは**1日・1回**。画面には表示しないので、ファイルから作成者にするスマホへ渡し、**既定のブラウザ（Safari・Chrome）**で開く（LINEなどのアプリ内ブラウザではパスキーを作れない）。パスキーを作ると作成者になり、そのままサインインした状態になる。パスキーを作れなかったときはリンクは消費されない。2台目以降の端末は、サインインしたトップ画面の「別の端末を追加」が同じ1回限りのリンクをクリップボードに作る。作成者を失効しても、その人が作った旅行とownerの席は残る。

### 運用者（一覧と強制終了）

Hostの運用者の身元はIAMのまま（Webの管理者画面は作らない。#37で決定）。生きているカプセルの一覧と、1件の強制終了はこのCLIだけが行い、公開HTTPからは呼べない（401）。

```sh
bun aws/capsules.ts list FUNCTION_NAME YOUR_PROFILE ap-northeast-1                 # 生きているカプセルの一覧（JSON）
bun aws/capsules.ts terminate CAPSULE_ID FUNCTION_NAME YOUR_PROFILE ap-northeast-1   # 1件を即時に終了。IDをもう一度入力して確かめる
```

一覧の各項目は `id`・`kind`・`state`・`created`・`updated`・`purgeAt`・`grants`（有効な招待の数）・`members`（登録している端末の数）だけで、題名・行き先・旅程・コメント・メンバー名・秘密は含まない。`id` が `null` のカプセルは、IDを本文に持つ前（#38より前）に発行されて、その後だれも書き込んでいないもの。IDは発行の控え（`aws/publish.ts` の `<入力>.owner.json`）か、旅行のリンク（`/c/<ID>`）から探す。作成者がブラウザで保存した旅行には控えのファイルが無いので、リンクを持つ人（owner・作成者）に聞く（誰かが書き込めば一覧にIDが出る）。強制終了はownerのpurgeと同じ保存の経路で、取り消せない。以後そのカプセルへのアクセスは410になる。

### 不審なアクセスがあったとき（止める・戻す）

原因を調べる間、被害だけを止める。止めるのも戻すのもテンプレートのパラメータの更新だけにする（Lambda の環境変数を `update-function-configuration` で直接書くと、解決済みの秘密を含む全変数の書き直しになり、テンプレートとずれる）。コードは再配置しない（`--use-previous-template`）。

| 手段 | 止まるもの | 残るもの |
|---|---|---|
| 特定の操作: `DisabledActions`（カンマ区切り） | 名指しした操作だけが 503 と案内を返す。`sessions` = 新しい招待の引換、`grants` = 招待の発行・一覧・回転、`publish` = 作成者と IAM の発行、`creators` = 作成者のサインイン・登録、`passkey` = 端末の復帰と本人確認、`assist` = 作成者の鍵での生成の受付、`account` = 作成者の API キーの登録・削除 | 名指ししない操作すべて。旅行の閲覧（`GET /v1/c/<ID>`）は名前を持たないので止められず、残る。静的配信も残る |
| 全停止: `WebRateLimit=0` | `/v1/*` 全部（閲覧・編集・引換）。Web Function が 503（`lambda-web-error-type: Platform.EndpointDisabled`）を返す | 画面と地図の静的配信（CloudFront → S3）。DynamoDB の保存。期限後の sweep と生成の続き（Event Function。止めるなら `ReservedConcurrency=0`） |
| 特定の旅行: `bun aws/capsules.ts terminate`（上の節） | その旅行だけ。即時削除で、戻せない | ほかの旅行とすべての操作 |

```sh
# 止める: 渡さなかったパラメータは既定値に戻るので、ほかは UsePreviousValue で全部渡す
aws cloudformation update-stack --stack-name capsule-host-dev --use-previous-template \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --profile YOUR_PROFILE --region ap-northeast-1 \
  --parameters ParameterKey=DisabledActions,ParameterValue=sessions \
    ParameterKey=PublicOrigin,UsePreviousValue=true ParameterKey=ReservedConcurrency,UsePreviousValue=true ParameterKey=WebRateLimit,UsePreviousValue=true \
    ParameterKey=WebCodeBucket,UsePreviousValue=true ParameterKey=WebCodeVersion,UsePreviousValue=true \
    ParameterKey=ClaimCountries,UsePreviousValue=true ParameterKey=BudgetLimitUsd,UsePreviousValue=true \
    ParameterKey=BudgetEmail,UsePreviousValue=true ParameterKey=AssistModel,UsePreviousValue=true ParameterKey=PermissionsBoundary,UsePreviousValue=true
aws cloudformation wait stack-update-complete --stack-name capsule-host-dev --profile YOUR_PROFILE --region ap-northeast-1
```

表に無い名前も、パスの最初の区切り（`/v1/c/<ID>/` の下はその次の区切り。例: `spec`・`members`・`terminate`）でそのまま指定できる。名前の綴りは Host では検査しない（綴りを誤ると何も止まらない）ので、止めたあと下の確かめ方で 503 が返ることを必ず見る。

`PermissionsBoundary` は、それを持つ template（#775 から）を配置した後のスタックにだけ付ける（前のスタックに付けると「前の値が無い」で止まる）。dev では渡さないと境界を外そうとして失敗する。

全停止は、止める例の `ParameterKey=WebRateLimit,UsePreviousValue=true` を `ParameterKey=WebRateLimit,ParameterValue=0` に替え、`DisabledActions` は `UsePreviousValue=true` にする（dev で試した。配置の記録は Private のリポジトリだけにある）。Event Function（sweep・生成の続き）も止めるときは `ReservedConcurrency=0` も替える。

戻すのは止めるコマンドの `DisabledActions` を `ParameterValue=''` にする（全停止は `WebRateLimit` を止める前の値（既定は 100）に戻す。止める前に `describe-stacks` で控える。`ReservedConcurrency` も止めたなら既定は 5、同時実行の上限が 10 のアカウントは `-1`）。パラメータを足したときは、この一覧にも足す（`aws cloudformation describe-stacks --stack-name capsule-host-dev --profile YOUR_PROFILE --region ap-northeast-1 --query 'Stacks[0].Parameters[].ParameterKey'` で今の一覧が見える）。

止めた後の確かめ方: 特定の操作は、Origin 付きの `POST /v1/c/00000000000000000000000000000000/sessions` が 503 なら止まっている（綴りの誤りだと 404 になる）。`GET /v1/account` が 200 なら、ほかは通っている。全停止は Web Function の受け口が 503 を返すので、Host の案内の 503 にはならない: `GET /v1/account` が 503（`lambda-web-error-type` のヘッダ付き）になることで確かめ、戻したら 200 に戻ることを見る。dev でこの手順を試した記録は配置の記録（Private のリポジトリだけにある）。prod では試さない。

## 作成者の API キーでの生成

画面から旅程を作るとき、Host は作成者が登録した自分の Anthropic API キーで Anthropic の Messages API を呼ぶ（方式は `docs/design/host-side-generation.md`）。AWS 側にあるのは次のものだけ。

- パラメータ `AssistModel`（既定 `claude-haiku-5-5`）。使うモデルで、画面からは選べない。変えるときは `--parameters ParameterKey=AssistModel,ParameterValue=<モデル ID>` と、ほかのパラメータの `UsePreviousValue=true`
- Parameter Store: `/capsule-host/<スタック名>/creator-key/<作成者の ID>` の SecureString（AWS 管理キー `aws/ssm`）。値はアプリ層で封じた暗号文で、平文の鍵ではない（`sk-ant-` で始まらない）。IAM は `ssm:PutParameter` / `GetParameter` / `DeleteParameter` / `AddTagsToResource` / `ListTagsForResource`（Web Function のロールはタグは付けるだけ）をこのパスの下だけに、`ssm:GetParametersByPath` をこのパスそのものに（`Host` のロールだけ）許す
- 期限: 5 分ごとの掃除（`aws/template.yaml` の `Host` の `Cleanup`）が、旅行の掃除の後に、最後に使ってから 30 日たった鍵を消す（#744）。使った時刻は登録・上書き（`LastModifiedDate`）と生成（タグ `used`）の遅い方。消えた作成者には画面がもう一度鍵の登録を求める。鍵の掃除が失敗したときは `aws logs tail` に `sweep:keys` の行が出る（旅行の掃除は済んでいる）。標準パラメータのままでタグも無料なので、費用は 0 のまま（Advanced tier のパラメータポリシーは使わない）
- 起動: 生成は Web Function が Event Function（`Host`。環境変数 `CAPSULE_EVENT_FUNCTION`）を `InvocationType: Event` で起動して行う。IAM は `lambda:InvokeFunction` を Web Function のロールに `Host` の ARN だけ許す。非同期呼び出しの再試行は 0 回、イベントの寿命は 60 秒（`EventInvokeConfig`）
- `Host`（Event Function）の `Timeout` は 300 秒。HTTP の要求は CloudFront が origin を待つ 60 秒（`OriginReadTimeout`）で切り、Web Function の `TimeoutSeconds` も 60 秒なので、長いのは Event Function で動く生成だけ
- 費用: Parameter Store の標準パラメータは 0 USD、`aws/ssm` の管理キーは 0 USD。生成 1 回の Lambda の実行時間は 0.002 USD 未満。LLM の費用は作成者の Anthropic の請求に行き、この Host には掛からない（Host に日・月の上限は無い。回数・同時・長さの上限だけ）
- 鍵の登録・置き換え・削除は、作成者の Cookie ではサインインから 5 分以内だけ（過ぎれば 428。画面はサインインし直して送り直す。#748）。IAM の発行者の身元は対象外
- 止めるとき: `DisabledActions` に `assist`（生成の受付）か `account`（鍵の登録・削除）を入れる。実行中の生成は締め切り（360 秒）で終わる
- ログ: 鍵・希望文・生成物は書かない。確かめるときは `aws logs tail /aws/lambda/<関数名> --since 10m` に `sk-ant-` と希望文が無いこと（`bun aws/verify.ts` も `sk-ant-` を見る）

## 保存・費用・残る検証

DynamoDBは従量、カプセル1.9MBまで。試作との互換性を保つためJSONを128KiB以下のバイナリ項目へ分割し、メタデータと最大16片を単一トランザクションで読み書きする。400KiBの項目制限を超えず、更新・失効・削除が部分反映されない。項目ごとの更新より書き込み費用が増えるため、大規模化時には予定・Grant・Session別の更新へ移行する。料金比較のAPI単価だけを総額と見なさない。

期限アクセス拒否はリクエスト時、物理削除は5分周期。TTLはレート制限と削除済みメタデータの後処理だけ。期限索引は結果整合なので削除反映の遅れがあり得る。DynamoDBのバックアップ（PITR・オンデマンド）は使わない（下の「バックアップ方針」）。Secrets Manager 1件（HMAC鍵）、ログ、S3、CloudFront等も課金対象。`/v1/*` は Web Function で 100 req/s・環境 2、Event Function は同時実行 5 を設定しているが、月額上限保証ではない（下の「レート制限とスロットル」）。

### レート制限とスロットル

Host が数える上限（`src/cloud-host.ts` の `rate()`。1 分あたり、DynamoDB に数える）:

| 鍵 | 上限 | 数える要求 |
|---|---|---|
| `ip:<IP>` | 300 | すべての要求 |
| `login:<IP>` | 15 | ログイン系（参加の `sessions`、`passkey/challenge`・`session`・`verify`、作成者の登録・サインイン） |
| `capsule:<id>` | 600 | **認証を通った要求だけ** |
| `grant:<id>` | 120 | 認証を通った要求だけ |

`capsule:` を認証の前に数えると、カプセル ID を知るだけの相手（URL を見た人、失効済みメンバー）が Cookie 無しで 600 回送れば、その旅行のメンバー全員が 429 になる。Cookie 無しの要求は `ip:` と `login:` だけで絞る（#609）。

`ip` は CloudFront が閲覧者の接続から付けて上書きする `CloudFront-Viewer-Address` だけから取る（`src/aws-handler.ts` の `viewerIp()`、入口は `src/aws-web.ts`）。`X-Forwarded-For` は読まない（先頭は閲覧者が偽造でき、末尾は CloudFront の IP）。ヘッダが無い要求（署名つきの直叩きがヘッダを付け忘れた）は 403 で、IP 不明のまま Host に渡さない。配信ログの `c-ip` も拒否の行の `ip` も閲覧者の IP。

`/v1/*` 全体の上限は Web Function のエンドポイントの 2 つの設定で、**費用の上限**（#673。以前は 10 rps / burst 30 のスロットルだった）:

| 設定 | 値 | 超えたとき |
|---|---|---|
| `ThrottleConfig.RateLimit`（パラメータ `WebRateLimit`） | 100 rps | 超えた分は Lambda が 429 で返し、関数に届かない。値は 100 の倍数で、**100 rps が下限**（10 rps には下げられない）。0 は全停止（503） |
| `ScalingConfig.MaxEnvironments` | 2 | 環境が 2 つとも一杯（環境ごとに最大 64 の同時要求）なら、待たせずに 429（`lambda-web-error-type: Platform.EndpointMaxEnvThrottle`）。dev で 3 秒かかる要求を 300 本同時に送ると 155 が 200、145 が 429 だった（#677） |

以前の 10 倍ゆるい（#673 の利用者の判断）。続けて 100 rps 受けた最悪の月は約 259M 要求で、Web Function の要求料金（0.30 USD/百万、US East の公開価格。東京は公開されていない）だけで約 78 USD に、動いた CPU 時間とメモリが足される。以前の 10 rps は月約 26M 要求だった。実際の旅行の通信はこれよりずっと少ない。誰でもこれを使い切れるので、可用性の保証ではない。WAF は固定費がかかるので置かない。細かい上限は Host の `rate()`（上の表。IP・ログイン・カプセル単位）が受け持つ。予算アラート（`Budget`）は今のまま。Web Function の環境は無通信の 3〜5 分で止まり、固定費は無い。

**直接呼べる主体**: Web Function のエンドポイントは `IamAuth` で、リソースポリシーは CloudFront（この配信）だけを許す。同じアカウントでは `lambda:InvokeWebFunctionEndpoint` を持つ主体（管理者）も、署名つきで直接呼べ、そのとき偽の `CloudFront-Viewer-Country` / `CloudFront-Viewer-Address` がそのまま届く（#677 で確かめた）。以前の秘密ヘッダの代わりに、**運用者以外の主体にこのアクションを渡さない**。署名なしの直叩きは 403 で、`aws/verify.ts` が毎回確かめる。

実際の費用（請求メトリクスで見た月の値）の記録は、配置の記録（Private のリポジトリだけにある）に残す。

予算アラート: アカウント全体の月額予算（AWS Budgets）を**prodスタックだけ**に持たせる。prodに一度 `--parameter-overrides … BudgetLimitUsd=20 BudgetEmail=<通知先>` を渡せば、以後の `sam deploy` は渡さなかったパラメータを前回の値のまま使うので、予算は残る（消えるのは `BudgetLimitUsd=0` を明示したときだけで、そのとき変更セットに `Budget` の Remove が出る）。devには一度も渡さない（渡すと同じ予算が2本になり、以後のdevの配置でも残り続ける）。実際の費用が80%を超えたときと、月末の予測が100%を超えたときにメールが届く。通知だけで、超えても何も止まらない。通知先のメールはリポジトリに書かない（値を確かめるときは `aws cloudformation describe-stacks --stack-name capsule-host-prod` のパラメータ `BudgetLimitUsd` / `BudgetEmail`）。金額は整数のUSD。`BudgetEmail` なしで金額だけを渡しても予算は作られない（変更セットに `Budget` の Add が出ないことで分かる）。

AWS上で公開前に確認: SAM lint、作成と重複更新、席の引換と端末束縛、受付期限、viewer/participant制限、メンバー単位の失効、期限拒否とスケジュール物理削除（`aws/verify-expiry.ts` をdevで1回）、ZIP出力、パスキーの登録と復帰（RP IDがOriginのホスト名であること、cookie無しの復帰要求が席を消費しないこと）、秘密が配布物・ログにないこと（`aws/verify.ts` が API のアクセスログと Host の拒否の行を読み、Cookie の値・招待 secret・`#k=`・題名が無いことを確かめる）。静的画面のブラウザー確認も必要。

## バックアップ方針

**決定（2026-09-26、#25）: DynamoDBのPITR（ポイントインタイム復元）もオンデマンドバックアップも使わない。** テンプレートにPITRを有効にするフラグも置かない。

理由:
1. このHostの約束は「期限で消える」こと。バックアップは、期限やpurgeで消したはずの旅程の写しを残す（PITRは最大35日、オンデマンドバックアップは消すまで無期限）
2. 旅行の後に残したいものは、ownerがExport（ZIP）で手元に持ち出す。Hostは保管庫ではない
3. 誤ったスタック削除による一括消失は、`Data` / `Assets` の `DeletionPolicy: Retain` で防いでいる
4. PITRは保存量に応じた継続課金で、使わない月にも費用がかかる

失うもの: テーブルの破損や誤操作（手でのItem削除など）が起きると、進行中の旅行は戻らない。ownerには旅行中もExportを取っておくよう勧める（owner画面の「旅を保存」）。

復元した場合の扱い: このテンプレートには復元の手順も口も無い。DynamoDBの復元は必ず別名の新しいテーブルになり、`Data` はテーブル名を持たずLambdaへ `!Ref` で渡しているので、向け直すにはテンプレートの変更が要る。それでも手でバックアップを取って復元したときは、**復元時点より後の操作がすべて取り消される**ことに注意する。戻るのは、手でのpurge（`purged_at` の墓標）、早めた期限（`purge_at`）、招待リンクとメンバーの失効、ownerリンクの交換、共有の終了、パスキーと作成者の失効。つまり、漏れたリンクを失効させていても復元後は再び使え、早めた期限の後でも読める。期限は保存行の `purge_at` でリクエストのたびに確かめ（過ぎていれば410、`src/cloud-host.ts`）、5分おきのsweepが消すので、復元した行の期限を過ぎたものは読めずに消える。復元したら、公開する前に、復元時点より後に行った上の操作を利用者が確かめてすべてやり直す。
