# `/v1/*` を Lambda Web Functions に移す（Spike #677 の結果）

親 PBI: #673。元要望: #670 の 1（`/v1/*` を CloudFront から Lambda Web Functions へ OAC で直接つなぐ）。

この文書は、Lambda Web Functions（2026-10-12 に出た、HTTP サーバーをそのまま動かす Lambda）を CloudFront の origin にして OAC で縛る構成を、使い捨ての dev のスタックで試した Spike の成果物。後の Task（#678・#679・#680）はここの名前と値を使う。確かめたのは 2026-10-16、ap-northeast-1、dev と同じアカウントの使い捨てスタック（`capsule-webfn-spike`・`capsule-webfn-spike-code`、CloudFront のログ用に us-east-1 の `capsule-webfn-spike-cdnlogs`）。コードは捨て、`aws/template.yaml`・`src/` は変えていない。アカウント ID・URL は伏せた。

## 0. 結論

**移す。ただし 1 つ、利用者が決めること（§5）が残る**: API 全体の上限が API Gateway の 10 rps / burst 30 より **10 倍ゆるい（100 rps が下限）**。固定費の無い置き換えはあるが、同じ値にはできない。

- **SAM / CloudFormation で書ける**。型は `AWS::Lambda::WebFunction`・`AWS::Lambda::WebFunctionRevision`・`AWS::Lambda::WebFunctionEndpoint`・`AWS::Lambda::ResourcePolicy`・`AWS::CloudFront::OriginAccessControl`。1 回の `cloudformation deploy` で動いた。`sam validate --lint` はこの型を知らないので、該当するリソースの `Metadata` でだけ E3006・E3031 を無視する（§4）
- **OAC の署名の無い直叩きは 403**（関数に届かず、ログにも残らない）。`x-capsule-edge` の秘密ヘッダと Secrets Manager の `EdgeKey` は要らなくなる
- **`CloudFront-Viewer-Country`・`CloudFront-Viewer-Address`・`If-Match`・`Origin`・Cookie（複数）は届く**。偽のヘッダを足しても CloudFront が上書きする。`X-Forwarded-For` は先頭が偽造できるので読まない（今も読んでいない）
- **要求の最長は CloudFront 経由で 60 秒**（`OriginReadTimeout` の既定の上限）。関数そのものは 900 秒まで。35 秒の応答は返り、70 秒は 504。assist は今のまま非同期なので影響しない
- **sweep・assist の続き・発行は Web Function では受けられない**（Event Function の `Invoke` だけ）。今の `Host` は Event Function として残し、`/v1/*` だけを新しい Web Function が受ける（§3、§6）
- **アクセスログは CloudFront の標準ログ v2 → CloudWatch Logs（us-east-1）**。時刻・IP・パス・status・大きさ・User-Agent が出て、Cookie とクエリは項目に入れなければ出ない。401 / 403 / 429 の行が出た。月額は 0.1 USD 未満の見積もり（§5）
- **費用**: Web Function は要求 0.30 USD/百万 + 動いた CPU 時間 + 環境が生きている間のメモリ。固定費は無い（環境は 3〜5 分の無通信で消える）。Secrets Manager の `EdgeKey` の月 0.40 USD が消える

## 1. 試した組み合わせ

| 部品 | 値 |
|---|---|
| Web Function | `nodejs24.x`（arm64）、`TimeoutSeconds: 900`、実行ロールは `AWSLambdaBasicExecutionRole` のみ |
| エンドポイント | `HomeRegion`、`AuthType: IamAuth`、`ScalingConfig.MaxEnvironments: 2`、`ThrottleConfig.RateLimit: 100` |
| OAC | `OriginAccessControlOriginType: lambda`、`SigningBehavior: always-amz-auth`、`SigningProtocol: sigv4`（`AWS::CloudFront::OriginAccessControl`） |
| CloudFront | origin = エンドポイントの `DomainName`、`https-only`、`OriginReadTimeout: 60`、キャッシュは `CachingDisabled`（`4135ea2d-…`）、origin request policy は本体の `ApiRequest` と同じ（Host を入れない。Origin・Content-Type・If-Match・User-Agent・CloudFront-Viewer-Country・CloudFront-Viewer-Address、Cookie 全部、クエリ全部） |
| リソースポリシー | `AWS::Lambda::ResourcePolicy`。主体 `cloudfront.amazonaws.com`、`lambda:InvokeWebFunctionEndpoint`、`Resource` はエンドポイントの ARN、`aws:SourceArn` は配信の ARN |
| 試すサーバー | `CloudHost` ではなく、受けたメソッド・URL・ヘッダを JSON で返すだけの Node の HTTP サーバー（`/sleep/<秒>`・`/status/<コード>` つき）。`AWS_LAMBDA_HTTP_ENDPOINT`（`host:port`、実測は `0.0.0.0:3000`）で待ち受け |
| コードの置き場 | バージョニングを有効にした S3 バケット（別スタック `capsule-webfn-spike-code`）。バケットポリシーで `lambda.amazonaws.com` に `s3:GetObject`・`s3:GetObjectVersion` |
| 配信ログ | `AWS::Logs::DeliverySource`（`ACCESS_LOGS`）・`DeliveryDestination`（`json`）・`Delivery`（`RecordFields` を指定）を **us-east-1** に。CloudFront のログ v2 は us-east-1 でしか作れない |

AWS CLI は 2.33.15 で `aws lambda-web …`（Web Functions の操作）がまだ無い（`Found invalid choice 'lambda-web'`）。配置は CloudFormation だけで足りたので、CLI の更新は要らない。

## 2. 確かめたこと

`<cdn>` = 配信のドメイン、`<endpoint>` = Web Function のエンドポイントのドメイン（`*.lambda-web.ap-northeast-1.on.aws`）。

| 項目 | 結果 | コマンドと出力（要る行だけ） |
|---|---|---|
| SAM / CloudFormation で書けるか | 書ける。`create-stack` 1 回で CREATE_COMPLETE。更新（コードを替えたリビジョン）は 43 秒、リビジョンが替わり、古いリビジョンは消えた | `aws cloudformation deploy --template-file main.yaml --stack-name capsule-webfn-spike --capabilities CAPABILITY_IAM …` → `Successfully created/updated stack`。リビジョンは作り直し（`Update requires: Replacement`）で、コードは S3 のバージョン ID で指す |
| `sam validate --lint` | 型を知らず失敗。該当リソースの `Metadata` で無視すれば通る | `E3006 … Resource type 'AWS::Lambda::WebFunction' does not exist`、`E3031 … 'always-amz-auth' does not match '^(never\|no-override\|always)$'`。`WebFunction`・`WebFunctionRevision`・`WebFunctionEndpoint`・`ResourcePolicy` に `Metadata: { cfn-lint: { config: { ignore_checks: [E3006] } } }`、`OriginAccessControl` に `[E3031]` を足す（template 全体には付けない）と `is a valid SAM Template` |
| `CloudFront-Viewer-Country` | 届く。偽の値を足しても CloudFront が本当の値（`JP`）に上書き | `curl -H 'CloudFront-Viewer-Country: XX' https://<cdn>/v1/x` → 関数が見た `"cloudfront-viewer-country":"JP"` |
| `CloudFront-Viewer-Address` | 届く（`<ip>:<port>`、閲覧者の本当の IP） | 関数が見た `"cloudfront-viewer-address":"<閲覧者の IP>:<port>"`（端末の IP と一致。配信ログの `c-ip` も同じ） |
| Cookie（複数） | 1 本のヘッダにまとまって届く | 送った `-b 'a=1; b=2'` → `"cookie":"a=1; b=2"`。応答の `Set-Cookie` は 2 本のまま返る |
| `If-Match`・`Origin` | 届く | `"if-match":"\"abc\""`、`"origin":"https://example.com"` |
| 偽の `X-Forwarded-For` | 先頭に偽の値が残り、後ろに閲覧者の IP と CloudFront の IP が付く。**閲覧者の IP の根拠にならない** | 送った `6.6.6.6` → `"x-forwarded-for":"6.6.6.6, <閲覧者の IP>, <CloudFront の IP>"`。Lambda 自身も末尾に接続元（CloudFront）を足す。`remoteAddress` は `169.254.100.1`（内部）で、今の `sourceIp` の代わりにならない |
| OAC の署名の無い直叩き | 403（HTML の「HTTP Error 403」）。関数のログに行は無い | `curl -si https://<endpoint>/v1/x` → `HTTP/1.1 403 Forbidden` |
| 署名つきの直叩き | IAM で許された主体（ここでは管理者）の署名なら通り、**そのときは偽の `CloudFront-Viewer-Country: XX` がそのまま届く**。信頼の境界は `lambda:InvokeWebFunctionEndpoint` を持つ主体（§5） | `curl --aws-sigv4 aws:amz:ap-northeast-1:lambda … -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD'` → 200、`"cloudfront-viewer-country":"XX"` |
| 要求の最長時間（CloudFront 経由） | 35 秒は 200。70 秒は **180 秒かかって 504**（60 秒 × 3 回の再試行） | `sleep35 via CF status=200 wall=35.22s`、`sleep70 via CF status=504 wall=180.12s`。`OriginReadTimeout` は 60 秒が上限（引き上げは Service Quotas） |
| 要求の最長時間（関数の直、署名つき） | 90 秒かかる応答が返る（設定は `TimeoutSeconds: 900`、最大 900） | `sleep90 direct signed status=200 time=90.09` |
| 本文の大きさ | 8 MB・25 MB の POST が通った（API Gateway の 10 MB の壁は無い） | `bodyBytes: 8000000`、`25MB POST status=200` |
| 同時要求の上限 | 環境 2 つ × 環境ごとの上限（既定 64 まで）を超えると **429**（`lambda-web-error-type: Platform.EndpointMaxEnvThrottle`）。キューに入れず即返す | 3 秒かかる要求 300 本を同時に: `155 200` / `145 429` |
| 要求の速さの上限 | `ThrottleConfig.RateLimit` を超えた分は 429。**値は 100 の倍数（1,000 までは 100 刻み）で、下限は 100 rps**。0 は全拒否（503） | 設定は `RateLimit: 100`。端末から出せる速さ（curl の起動で 100 rps に届かない）では 429 を起こせず、速さの上限そのものは公式の仕様（`web-functions-scaling`）で確かめた。同時要求の上限は上の行で実測 |
| CloudFront から見える 429 | `OriginError` として配信ログに残る | 配信ログ 3,657 行のうち `429 OriginError` が 145 行、`401 Error` が 1 行、`403 Error` が 1 行、`504 OriginCommError` が 1 行 |
| 関数のログ | 標準出力が JSON で出る。`SystemLogLevel: DEBUG` で 1 要求ごとに `platform.requestComplete`（requestId・結果・所要時間・応答の大きさ）。**429（環境が足りない）と 403（署名なし）は関数に届かないので出ない** | `/capsule-webfn-spike/<スタック名>`（自分で作ったロググループ）に出た。`.local`（同名 + `.local`）も作る |
| 配信ログ（標準ログ v2）の項目 | `timestamp`（秒）・`c-ip`・`cs-method`・`cs-uri-stem`・`sc-status`・`sc-bytes`・`cs(User-Agent)`・`x-edge-detailed-result-type` が JSON で出た。`cs-uri-query`・`cs(Cookie)` を `RecordFields` に入れなければ出ない | `{"timestamp":"1792125192","c-ip":"<閲覧者の IP>","cs-method":"GET","cs-uri-stem":"/b","sc-status":"200","sc-bytes":"999","cs(User-Agent)":"curl/8.21.0",…}`。最初の行が見えるまでに数分〜十数分かかった（配信の遅延） |
| 保持期間 | ロググループに `RetentionInDays: 90` を付けられる（配信先の自分のロググループ） | `describe-log-groups` → `90` |
| 環境の寿命 | 無通信の環境は 3〜5 分で止まる（最後の通信 04:33 台、`spinDownStart` は 04:36 と 04:38）。初期化は約 0.3 秒 | `platform.initReport … totalDurationMs 316`。メモリは環境が生きている間だけ課金 |
| sweep（EventBridge）・assist の続き・発行（IAM の Invoke）を同じ関数で受けられるか | **受けられない**。`lambda invoke --function-name <web-function>` は `function:` の名前空間を探して `Function not found`。web-function の ARN は `Invoke` の引数の形に合わない（`ValidationException`）。公式も「イベント処理は Event Function」としている | `An error occurred (ResourceNotFoundException) when calling the Invoke operation: Function not found: arn:aws:lambda:ap-northeast-1:<acct>:function:capsule-webfn-spike-web` |

## 3. 関数の入口の形（#678 が作るもの）

実測したのは §2 の表まで。この節と §4 は、その結果から後の Task が読む**提案**で、試していない部分（`.mjs` の入口、assist の `dispatch` の権限、ビルドの形）は各 Task が最初に確かめる。

- `src/aws-web.ts`（新規）: Node の `http.createServer` を、環境変数 `AWS_LAMBDA_HTTP_ENDPOINT`（`host:port`）で待ち受ける。受けた要求を `Request`（`https://<PublicOrigin のホスト><パス>?<クエリ>`）に直して `CloudHost.fetch` に渡し、`Response` を `res` に書く。`Set-Cookie` は `res.setHeader("set-cookie", response.headers.getSetCookie())`（複数）。本文は base64 にしない（API Gateway の v2.0 イベントの変換が要らなくなる）
- 待ち受けは 10 秒以内に始める（初期化の上限）。SIGTERM から 1 秒で終わる（持つ状態は無い）
- `CloudHost` の生成（`aws-handler.ts` の `store`・`host` まわり）は 1 箇所に置き、`aws-handler.ts`（Event Function）と `aws-web.ts`（Web Function）の両方が使う。入口が 2 つになっても認可・保存・ライフサイクルは `src/cloud-host.ts` の 1 実装のまま
- 閲覧者の IP は `CloudFront-Viewer-Address` だけから取る（`viewerIp` から `sourceIp` の引数とフォールバックを外す。`remoteAddress` は内部の `169.254.100.1` で閲覧者の IP の代わりにならないので、ヘッダが無い要求の扱いは #678 が決める。案は 403: CloudFront を通った要求には必ず付くので、署名つきの直叩きでヘッダを付け忘れた要求を IP 不明のまま通さずに済む）。`X-Forwarded-For` は読まない。国は今の `cloudfront-viewer-country` のまま
- `Authorization` ヘッダ: 閲覧者の `Authorization` は origin request policy に入れていないので届かない（試した policy のとおり）。`aws-handler.ts` の `headers.delete("authorization")` は、今の形を保つなら残す
- ビルド: 入口は zip の根の `index.js`（既定）か、環境変数 `AWS_LAMBDA_NODEJS_ENTRYPOINT` で指した名前。今の `aws/build.ts` は ESM（`index.mjs`）を出すので、`AWS_LAMBDA_NODEJS_ENTRYPOINT=index.mjs` を環境変数に置く案が最小。**この Spike では CommonJS の `index.js` で試しており、`.mjs` + 環境変数は試していない。#678 / #679 の最初に確かめ、通らなければ `package.json` の `{"type":"module"}` を zip に入れる**。出力は `dist/aws-web/`（Event Function の `dist/aws/` と分ける）
- `Host`（Event Function）は残る: sweep（`aws.events`）・assist の続き（`capsule.assist`）・発行（`capsule.publisher`）を受ける。`/v1/*` の HTTP を受ける分岐（`event.version === "2.0"` 以降）と `CAPSULE_EDGE_KEY`・`x-capsule-edge` の比較は `aws-handler.ts` から消える。Web Function の assist の `dispatch` は `Host` を `InvocationType: "Event"` で呼ぶ（関数名を環境変数で渡す）。実行ロールに `lambda:InvokeFunction` を `Host` に対して許す

## 4. template の形（#679 が作るもの）

提案。§3 と同じく、試していない部分は #679 が確かめる。

- 消す: `Api`（`AWS::Serverless::HttpApi`）・`ApiLogs`・`EdgeKey`・`Host` の `Events.Http`・CloudFront の `api` origin の `OriginCustomHeaders`・出力 `ApiEndpoint`・`Host` の `CAPSULE_EDGE_KEY`
- 足す: 上の §1 の型。出力は `ApiEndpoint` の代わりに `WebEndpoint`（値は `https://` を付けた `!Sub 'https://${Endpoint.DomainName}'`。`aws/verify.ts:98` が `apiEndpoint + "/v1/account"` で呼ぶので、スキームまで出力に入れる）。`aws/verify.ts` は `WebEndpoint` を読む（両対応にしない）
- `Host` の `Timeout: 300` と `ReservedConcurrentExecutions` は、assist の続きと sweep のために残す。コメント「30 seconds is all an HTTP request gets (API Gateway)」は、HTTP の最長が CloudFront の 60 秒に替わるので直す
- **コードの置き場**（測ったこと）: `WebFunctionRevision` は S3 の**バージョン付きの zip**（`VersionId`）を指し、作った後に変えられず、コードを替えるたびに作り直しになる（更新 43 秒、§2）。この Spike は `aws s3api put-object` で上げた zip を使い、`sam package` が `CodeConfig` を上げるかは試していない。バケットをどこに置き、どう上げるかは #679 が決める
- `sam validate --lint`（CI も同じ）は新しい型を知らない。該当するリソースだけの `Metadata`（型を知らない 4 つのリソースに `[E3006]`、OAC に `[E3031]`）で通す。template 全体では無視しない（他のリソースの型の打ち間違いや不正な値を、この 2 つの検査が見逃さないように）。cfn-lint が型を知るようになったら外す。この形で `sam validate --lint` が通ることは使い捨ての template で確かめた
- 配信の `/v1/*` は `Origins` に OAC つきの Web Function の origin を足し、`CustomOriginConfig` に `OriginProtocolPolicy: https-only`・`OriginReadTimeout: 60`、`OriginAccessControlId` を付ける。`OriginRequestPolicyId` は今の `ApiRequest`（Host を入れない）のまま
- `AWS::Lambda::ResourcePolicy` は `Resource` に `Endpoint.EndpointArn`、`aws:SourceArn` に配信の ARN。配信は Web Function の origin を持ち、ポリシーは配信の ID を使うので、循環しない（配信 → エンドポイント、ポリシー → 配信 + エンドポイント）
- ログ（§5）の配信先は **us-east-1** のスタック（または `AWS::CloudFormation::Stack`）で別に作る。ap-northeast-1 のスタックの中には書けない

## 5. 上限・ログ・信頼の境界

### API 全体の上限（受け入れ条件 5）— **利用者の判断が要る**

| | 今（API Gateway） | 移した後 |
|---|---|---|
| 速さの上限 | 10 rps / burst 30（`DefaultRouteSettings`） | `ThrottleConfig.RateLimit`。**100 の倍数で下限は 100 rps**（10 rps は書けない）。超えた分は 429 |
| 同時の上限 | Lambda の予約同時実行（5） | `ScalingConfig.MaxEnvironments`（下限 2）× 環境ごとの同時要求（既定 64）。超えた分は 429 |
| 費用の上限の意味 | 10 rps 続けても月 約 26M 要求 | 100 rps 続けると月 約 259M 要求。Web Function の要求料金だけで 0.30 USD/百万 × 259M ≈ 78 USD（US East の公開価格。東京は公開されていない）に、動いた CPU 時間が足される |

固定費の無い置き換え（`RateLimit` と `MaxEnvironments`）は**ある**ので、`## 判断待ち` で止める条件（置き換えが見つからない）には当たらない。ただし受け入れ条件 5 の「API Gateway のスロットルと同じくらい」は、100 rps が下限なので**満たせない（10 倍）**。AWS WAF のレート制限は有料の固定費なので使わない（スコープ外）。細かい上限が要るなら、Host の中のレート制限（`rate:ip`・`rate:login`・`rate:capsule`）がすでに IP・ログイン・カプセル単位で効いている。**推奨**: `RateLimit: 100`・`MaxEnvironments: 2` で移し、`aws/README.md` に 10 倍ゆるくなったことと費用の見積もりを書く。予算アラート（`Budget`）は今のまま残す。この変更（受け入れ条件 5 の読み替え）は PBI の `## 判断待ち` で利用者に聞く。

### ログ（受け入れ条件 6）

- `/v1/*` の要求のログは **CloudFront の標準ログ v2 → CloudWatch Logs（us-east-1）**。項目は `timestamp`・`c-ip`・`cs-method`・`cs-uri-stem`・`sc-status`・`sc-bytes`・`cs(User-Agent)`・`x-edge-detailed-result-type`（任意で `time-taken`）。`cs-uri-query`・`cs(Cookie)`・本文は入れない。ロググループは `RetentionInDays: 90` で自分で作る
- 今の API Gateway のアクセスログとの違い: (1) `ip` は `c-ip`（閲覧者の IP）で、エッジの IP ではない。(2) `routeKey` は無い（`cs-uri-stem` で足りる）。(3) **配信を通らない要求（署名なしの直叩き）は、どこにも残らない**（今は API Gateway のログに 403 が残る）。残すなら CloudTrail の Lambda データイベントが要り、有料。直叩きは 403 で何も起きないので、残さない
- 関数のログ（`kind: "refused"` の行）は `/capsule-host/<スタック名>/web`（自分で作り、`RetentionInDays: 90`）に出し、`TelemetryConfig.LoggingConfig.LogGroup` で指す。**Lambda は同名 + `.local` のロググループを自分で作り直す**（スタックを消した後にも 1 つ残っていた。作る側は `.local` も `AWS::Logs::LogGroup` に書き、保持期間を付ける）
- 月額の見積もり: 配信ログ 1 行が約 280 B。月 10 万要求で約 28 MB、取り込み 0.50 USD/GB（us-east-1）と保存 0.03 USD/GB で 0.02 USD 未満。`SystemLogLevel: DEBUG`（要求ごとの `requestComplete`）は要らないので使わない（INFO のまま）。合計でも 0.1 USD 未満
- 侵害の確認の手順（`aws/README.md`）の置き換えの案（書き直すのは #680）: (a) 401 / 403 の IP ごとの数と (c) 429 の IP ごとの数は、配信ログ（`c-ip`・`sc-status`）に対する Logs Insights に替える（us-east-1）。(b) カプセル id ごとの 401 は関数のログの `kind = "refused"` のまま。クエリの形は #680 で書く

### 信頼の境界

今は「`x-capsule-edge` の秘密を知っているか」が、国と IP のヘッダを偽装できるかを決めている。移した後は「**`lambda:InvokeWebFunctionEndpoint` を持つ主体か**」になる。リソースポリシーは CloudFront（この配信）だけを許す。同じアカウントでは、このアクションを identity policy に持つ主体（管理者）も通る（署名つきの直叩きで偽の `CloudFront-Viewer-Country` が届いた、§2）。管理者は DynamoDB も直接読めるので、新しい穴にはならない。運用者以外の主体に `lambda:InvokeWebFunctionEndpoint` を渡さないことを `aws/README.md` に書くことを提案する（書くのは #680）。

## 6. 後の Task の読み替え

| PBI / Task の書き方 | この文書で読み替える |
|---|---|
| 「関数の入口の形（`src/aws-web.ts` の export の形）」 | §3。`http.createServer` を起動する（export は無い）。`CloudHost` の生成は `aws-handler.ts` と共有 |
| 「`Host` を残すか」 | 残す（Event Function。sweep・assist の続き・発行） |
| 「10 rps / burst 30 の代わりになる上限」 | `RateLimit: 100`・`MaxEnvironments: 2`（§5。受け入れ条件 5 は利用者の判断待ち） |
| 「アクセスログの代わりとその月額」 | CloudFront の標準ログ v2 → CloudWatch Logs（us-east-1）、0.1 USD 未満（§5） |
| 「`ApiEndpoint`」 | `WebEndpoint`（`https://` つきの `Endpoint.DomainName`） |
| 「OAC の書き方」 | §1・§4 |
| 「直叩きが拒まれるか」 | 署名なしは 403（§2）。`aws/verify.ts` は `WebEndpoint` に署名なしで送って 403 を確かめる |

## 7. 後始末

試したスタックは全部消した。確認:

```sh
aws cloudformation describe-stacks --stack-name capsule-webfn-spike --region ap-northeast-1
# → An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id capsule-webfn-spike does not exist
aws cloudformation describe-stacks --stack-name capsule-webfn-spike-code --region ap-northeast-1   # 同じく does not exist
aws cloudformation describe-stacks --stack-name capsule-webfn-spike-cdnlogs --region us-east-1     # 同じく does not exist
```

`/capsule-webfn-spike` で始まるロググループは両地域で 0 個（Lambda が作り直した `.local` を 1 つ手で消した）。OAC・Web Function の配信も 0 個。バケットは中身（バージョンを含む）を消してからスタックごと消した。
