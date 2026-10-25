> 移行前の検討記録です。現行の配置・手順は [README](README.md) と [運用手順](docs/development-and-release.md) を参照してください。

# Capsule Host のホスト比較

採用決定（2026-09-18）：既存アカウントと運用経験を理由に利用者がAWSサーバーレスを選択。以下の比較は選定時の記録。現在の実装・配置手順は [AWS手順](aws/README.md)。
2026-09-18。料金はUSD、税・為替・ドメイン・外部AI料金を除く。推奨案であり、有料契約や公開の実施記録ではない。

## 推奨

Cloudflareへ直接、Workers Paid + Static Assets + D1 + Cron Triggersで配置する。基本料金はアカウント全体で月5ドルから。旅行ごとに別アプリ・DB・契約を作らず、共通ランタイムとデータを共有する。写真を追加するときはR2、非同期処理はQueues等を別途評価する。

無料枠に合わせて機能を削ることを目的にしない。参加者はアカウント不要、owner/editor/participant/viewerのcapabilityリンクを使う。Cognito不要。旅行作成は管理されたPublisherから行い、参加者向け画面と発行資格情報を分離する。このPCへの外部接続は必要ない。

## 比較

| 候補 | 通常料金の出発点 | 適する拡張 | 主な負担・制約 |
| --- | --- | --- | --- |
| Workers Paid + D1 | 月5ドル＋超過従量 | 多数の期限付き旅行、API、写真保存、非同期処理 | Worker実行環境、D1の容量と書き込み処理能力に制約 |
| AWS Lambda + HTTP API + DynamoDB + S3/CloudFront | 従量。API10万回の計算例は約0.20ドル、DB・配信等は別 | 多種のAWSサービスや重い処理との連携 | IAM・デプロイ・監視の構成要素が多い。DynamoDB用データ設計が必要 |
| Supabase Pro + 静的画面配信 | バックエンド月25ドルから。画面配信は別枠 | PostgreSQLの関連検索・集計・拡張 | コンピュート増強や転送量で増額。Authは使わなくてよい |
| 小型VPS（Lightsail例） | 1GB RAM月7ドル、2GB月12ドル＋バックアップ等 | Bun/NodeやOSを含む自由な処理 | OS更新・復旧・バックアップを自分で運用。単一サーバーの障害点 |

AWSのAPI例は、米国向け公式料金例のHTTP API 1ドル/100万回、Lambda 0.20ドル/100万回、256MiB・平均200ms・0.0000166667ドル/GB秒で計算。無料枠を差し引かず0.10 + 0.02 + 0.0833 = 0.2033ドル。東京の総額見積もりではない。小規模なら請求額はCloudflareより安くなり得るが、運用の構成要素も比較する。

## Cloudflareの費用モデル

Workers Paidには月1000万リクエストと3000万CPUミリ秒を含む。超過は100万リクエストあたり0.30ドル、100万CPUミリ秒あたり0.02ドル。静的アセットだけの配信は無料。これらはアカウントの他アプリと共有する枠。

D1は月250億行読み取り、5000万行書き込み、5GB保存まで含む。超過は100万行読み取り0.001ドル、100万行書き込み1ドル、保存1GB月0.75ドル。返却した行数ではなく走査行数、索引更新等も考慮する。

仮にAPI月100万回、平均CPU10ms、D1とログが含有枠内なら月5ドル。API月1000万回・平均CPU10msではCPU超過7000万msで1.40ドル増、月6.40ドル。これは性能実測ではなく条件付き試算。Cron等の処理も合算する。写真・AI・メールはこの試算に含めない。月5ドルは課金上限ではないため、CPU上限、作成数・容量制限、レート制限と監視を実装する。

## 拡張性の境界

D1は1DB最大10GB、1行・文字列最大2,000,000バイト。単一DBはクエリを直列実行するため、料金枠だけで処理能力は保証されない。試作のカプセル全体1行保存を、予定・Grant・Session等へ分割し、旅行IDによる分離と索引を設計する。将来のDB分割やPostgreSQL移行には実装・データ移行が必要。

WorkersはBun/通常のNodeサーバーをそのまま実行する環境ではない。互換APIの範囲で移植・検証する。ネイティブバイナリ、長時間の重い処理、複雑なSQL集計が中心になれば、AWSやPostgreSQLを再評価する。現在の宣言的Specの旅行アプリにはWorkersを推奨するが、任意コードの実行基盤まで保証しない。

無料からPaidへの変更でホストを乗り換える必要はない。ただし今回は最初からPaidを費用基準とし、無料特有のCPU制限等を前提にしない。

## 公開とプライバシー

汎用画面・配布JSに実名や実旅程を入れない。公開デモは架空データ。実データは公開前に確認し、旅行ごとの権限を検査するAPIのみから取得する。ログイン画面を足すことをデータ分離の代替にしない。

期限切れは毎リクエストで拒否し、Cronで物理削除を再試行する。D1 PaidのTime Travelは30日なので、一次データ削除とバックアップから消える時期を区別する。

現状はローカル実装とクラウド用試作まで。クラウド試作に残るログイン前提の修正、Worker実環境検証、定期削除の配線、本番公開は未完了。この提案を公開済みと扱わない。

## 公式資料

- Workers料金: https://developers.cloudflare.com/workers/platform/pricing/
- D1料金: https://developers.cloudflare.com/d1/platform/pricing/
- D1制限: https://developers.cloudflare.com/d1/platform/limits/
- Node互換性: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Lambda料金: https://aws.amazon.com/lambda/pricing/
- HTTP API料金: https://aws.amazon.com/api-gateway/pricing/
- Supabase料金: https://supabase.com/pricing
- VPS料金: https://aws.amazon.com/lightsail/pricing/
