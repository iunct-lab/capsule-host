> 移行前の検討記録です。現行の配置・手順は [README](README.md) と [運用手順](docs/development-and-release.md) を参照してください。

# Capsule Host: AWS構成案

Status: adopted, 2026-09-18。利用者がAWSを選択。AWSリソース・契約・デプロイは未作成。実装と配置手順は [aws/README.md](aws/README.md)。

## 優先順位

無料枠への適合を最優先にしない。小規模時の低い運用費、複数の旅行と権限の分離、機能追加のしやすさ、運用作業の少なさを優先する。このPCを公開しない。Sites/D1への公開作業は保留。

拡張性は、複数の旅行・利用者、写真やファイル、通知、非同期処理、外部サービス連携の追加と解釈する。SQLによる自由な集計や複雑な関連検索を主目的とする場合は、DBをPostgreSQLにする案を再評価する。

## 推奨する構成

| 役割 | AWSサービス | 初期範囲 |
| --- | --- | --- |
| HTTPS画面配信 | CloudFront + 非公開S3、OAC | 汎用アプリだけを配信。実際の旅行は含めない |
| API | Lambda Web Function（CloudFront の OAC で呼ぶ）+ Event Function | 通常のTypeScript/Node.jsコード。旅行ごとのプロセスなし |
| 旅程・権限 | DynamoDB on-demand | 旅行単位のアクセスパターン。条件付き更新・トランザクション |
| 写真の画像 | 非公開S3（`Media`。Retain・SSE既定・作成から181日で消える規則） | ブラウザが旅行の鍵で暗号化した bytes だけ。1 旅行 500 枚・表示用 1 MiB・サムネイル 150 KiB まで。Web Function が席の Cookie を見て返し、旅行の削除で Host が先に消す |
| 期限処理 | EventBridge + Lambda | 期限超過データの削除と失敗時の再試行 |
| 可観測性 | CloudWatch Logs | CloudFrontのアクセスログ（us-east-1。時刻・接続元IP・メソッド・パス・status・応答の大きさ・User-Agent）と、Hostが拒んだ要求の1行（カプセルid・action・status・理由コード）。保持は90日。本文・Cookie・招待secret・題名・クエリは記録しない（`aws/README.md` の「侵害の確認」） |
| 費用監視 | AWS Budgets、Web Functionの速さ・環境数の上限、Lambda同時実行制限 | 費用通知に加えて実行量も制御 |

利用地域の候補は東京。具体的なアカウント・リージョン・既存サービス利用量が判明してから単価と無料枠共有分を確定する。

写真（#437）は非公開S3 `Media` に置く。画像は署名付きURLでなく、Web Function（Lambda）経由で送り・返す（本文は今の2 MiBの上限のまま、1回のPOSTで1枚）ので、CloudFrontの別の経路・署名の鍵・権限判定の2か所化を持たない。サイズ・個数（1 旅行 500 枚）・容量は Host が見る。画像はブラウザが旅行の鍵で暗号化してから上げるので、S3 にあるのは暗号文だけで、運用者は読めない（`docs/design/trip-e2e.md` §3.1。`COSTS-AND-PRIVACY.md` の「写真」）。通知・大量の出力はSQS/Lambdaへ分離する。これらは初期実装に先回りで作り込まない。画像解析・生成などの有料AIは別の明示的な費用項目とする。

## 移行上の注意

現在のクラウド試作はカプセル全体をD1の1行にまとめてCAS更新している。この方式をそのままDynamoDBへ移さない。DynamoDBは1項目400 KiBなので、初期アダプターはメタデータと128KiBのバイナリ片に分割し、トランザクションで一括更新する。予定・Grant・Session単位の部分更新は今後の費用最適化として残る。

認可・ライフサイクル・Spec検査・出力のロジックと、DB/ホスト/HTTPの接続部分を分離する。共有UIとスキーマは流用できるが、ストレージ層・デプロイ接続はAWS向けに実装して検証する必要がある。「保存先だけ変えれば完成」とはしない。

利用者のアカウント・ログイン・Cognitoは導入しない。最初のコンセプトどおり、旅行作成時にowner capabilityを発行し、管理者がparticipant/viewer等のリンクを発行する。サーバーはリンクを短命Sessionに交換して、権限・旅行ID・期限を検査する。個人情報は公開配布物に含めず、権限確認後にAPIから取得する。ログインを追加することをプライバシー分離の条件にしない。

旅行作成はSwitchboard/CLI等の管理されたPublisher経路で行う。ホストの発行権限はデプロイ用資格情報として管理し、参加者や公開JavaScriptには渡さない。誰でも無制限にカプセルを発行できる公開作成サービスは今回の範囲に含めない。必要になった場合は、作成専用capabilityや招待制を先に検討し、アカウント制は別の明示的な仕様変更として扱う。

データへのすべてのアクセスで期限を検査する。DynamoDB TTLの削除は通常数日遅れるため、アクセス制御や指定日時の削除をTTL任せにしない。EventBridgeで削除を進め、TTLは後片付けの補助に使う。削除済みカプセルのバックアップ復元時もアクセスを復活させない手順が必要。

インフラはCDKまたはSAM等で再作成可能にする。公開用成果物に `data/`、秘密、原本、仮名化済みの実旅行を含めない。

## 小規模時の費用計画

初期の**予算目安は月5〜10 USD**。これは上限保証・確定見積もりではない。利用者5〜50人、API月10万回程度、ファイル1 GB未満、配信10 GB程度、短時間のAPI処理、短期ログ保持を前提とする。独自ドメイン、SMS、外部AI、大量の写真・動画、冗長化追加は別途。キャンペーンクレジットは根拠にしない。

規模感を確認するための公式料金例（米国東部の公表例等。東京リージョンの確定見積もりではない）:

- Web Function 10万回: 要求料金 0.30 USD/百万回なら約0.03 USD（動いたCPU時間とメモリは別）。
- Lambda 10万回、256 MiB、平均200 ms: 5,000 GB秒。0.0000166667 USD/GB秒の例なら約0.083 USD、リクエスト約0.02 USD。無料枠適用前。
- DynamoDB 100万WRU + 100万RRU: 0.625 + 0.125 = 約0.75 USDの料金例。アプリの操作1回が1WRUとは限らず、項目サイズ・索引・トランザクションで増える。
- 上記以外にS3、配信、ログ、必要な秘密管理やバックアップ等の費用を見込む。

予算通知は通知の遅延があり、課金の厳密な停止線ではない。Lambda同時実行数、APIのレート、作成可能な旅行数、容量を制限し（ログは90日で消える）、月5 USD・10 USD等の通知閾値を設ける。実利用メトリクスを見て見積もりを更新する。

## 参考一次資料

- https://aws.amazon.com/api-gateway/pricing/
- https://aws.amazon.com/lambda/pricing/
- https://aws.amazon.com/dynamodb/pricing/
- https://aws.amazon.com/cloudfront/pricing/
- https://aws.amazon.com/eventbridge/pricing/
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html
- https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html
