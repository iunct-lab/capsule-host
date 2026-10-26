# 開発・リリース・運用

## 管理する単位

`capsule-host`は長く保守する共通製品。ソースとAWS IaCをこの1リポジトリで管理し、同一コミットをリリース単位にする。旅程インスタンスはGitの管理対象にしない。旅行ごとのコードコピー、DB、AWSスタックは作らない。

Switchboard側の変更は汎用Artifact/Deployment台帳、承認画面、Publisher呼び出しに限る。HostのAWS SDKや旅程コンポーネントをSwitchboardへ依存追加しない。HostはCLIだけでも利用可能にして、Switchboardとのリリースを同期必須にしない。

## 配置図

```text
Switchboard（ローカル・生成と管理）
    ↓ Publisher CLI / 利用者のAWSプロファイル
AWS dev または prod（Host単位のスタック）
    CloudFront → 非公開S3（汎用UI）
               → Lambda Web Function（OAC） → DynamoDB
    EventBridge → Lambda（Event Function。期限削除・生成の続き）

参加者 → CloudFrontの旅行リンク（PCは経由しない）
```

## 3つの作業フロー

### A. 共通機能を開発する

1. このリポジトリで作業ブランチを作る。Trip Runtime/Domain Kit/RecipeとIaCを変更する。
2. `bun run check`（型・テスト・AWS/ブラウザ用ビルド）、`sam validate --lint --template-file aws/template.yaml` を実行する。
3. 画面変更はローカルで操作確認（`bun run dev` に対して `bun run verify:ui`。変えた所の群を `bun run verify:ui <群>` で確かめ、PBI の最後に引数なしで 1 回通す。新しい場面は群に入れ、前の群の状態に頼らず群の用意で作る。群と選び方は README の「ローカル開発」。手元の Chrome をヘッドレスで動かし、依存は足さない。`verify:http` と同じく、立っている Host に対して走らせる検証で `bun run check` には入れない）。認可・保存・削除の変更はAWS dev上でも検証する。認可・ライフサイクルの実装は `src/cloud-host.ts` の1つだけで、ローカル（`bun run dev`、`src/local-d1.ts` のSQLite）もAWS（`src/aws-store.ts` のDynamoDB）も同じコードを通る。ローカルで確かめられないのは保存先とその手前（CloudFront・Lambda Web Functions の OAC・IAM・地域制限）。
4. ソースとIaCの差分をレビューする。schemaVersionの破壊変更、既存旅行の読取互換性、削除への影響を確認する。
5. 検証済みコミットをリリース対象に固定する。初期は手動配置、将来のCI化でもこの順序を保つ。

CI（`.github/workflows/ci.yml`）は、PRとmainへのpushで `bun install --frozen-lockfile` → `bun run check` → `sam validate --lint` を走らせる。AWSには接続しない（認証情報もOIDCも渡さない）ので、配置と `aws/verify.ts` は手元の手順のまま。CIからの配置を足すときは、AWS接続はOIDC、dev/prod別ロールとする。長期AWSキーをGitHub Secretsへコピーする方式を既定にしない。

### B. 共通HostをAWSへ配置する

- 環境は `capsule-host-dev` / `capsule-host-prod` の2スタック。**同じAWSアカウント・同じリージョン（ap-northeast-1）にあり、スタック名で区別する**。DynamoDB、S3、秘密鍵、Originを分ける。devには架空データのみ。
- AWSアカウント・リージョン・profileは明示し、`aws sts get-caller-identity` で対象を確認する。リージョンは東京（ap-northeast-1）。devとprodは同じアカウントにあり、`--stack-name` だけが違う。
- `bun install --frozen-lockfile` → `bun run check` → SAM lint → `sam deploy --no-execute-changeset`。
- 変更セットの置換・削除・IAM変更を確認して実行。初回のみCloudFront出力Originを設定する2段階配置。詳細はaws/README.md。
- S3には `dist/public/` だけを同期し、CloudFrontをinvalidate。SAM/Lambda更新とS3更新は原子的ではないため、APIは直前のUIと互換にする。破壊変更は新schema/APIの併存、UI切替、旧版廃止の順に行う。
- devでリンク交換Cookie、role制限、同時更新、ZIP、失効を実際のCloudFront越しに検証（`aws/verify.ts`）。期限拒否と定期物理削除は実時間で6分半〜13分かかるので毎回は回さず、期限・sweep・ライフサイクルの経路に触ったときと、prod公開の前にdevで1回（`aws/verify-expiry.ts`）。
- **旅程の暗号化を配る順番**（`docs/design/trip-e2e.md` §5。API を直前の画面と互換に保つため）: 1. Host を配る（平文の旅行は今の API のまま、暗号化した旅行の API と移す要求を足す）2. 画面を配る（新しい画面は要求に `ui=2` を付け、owner に平文の旅行を移す帯を出す。古い画面が暗号化した旅行を開くと Host は「画面を更新してください」）3. 画面を配り終えた時刻を prod の `SealedFrom` に置く（`aws/README.md` の「旅程の暗号化を始めた後に発行した旅行」）。これが「配った後」の線で、**配った後に発行された旅行**とは `created` が `SealedFrom` 以後の旅行のこと。それは平文で使えず、owner が移すまで開けない。配る前に発行された平文の旅行は、owner が新しい画面で開いて移すまで平文のまま使え、来なければ削除期限まで平文で残る。`SealedFrom` を置いてから 180 日の後に、平文の旅行を平文のまま読み書きする道を消す（§6 の 8）。dev の `SealedFrom` は普段は空のまま。置いた後の prod の配置でも `aws/verify.ts` を smoke test として回し、線のある Host として回ったことを出力の `SealedFrom: set (trips published by this run are after the line)` の行で確かめる（`SealedFrom: set, not reached yet …` なら線の前として回っている）（線のある Host で何を確かめ、何を線の無い dev に任せるかは `aws/README.md` の「AWS検証」。#893）
- 同じコミットとlockfileでprodを配置。prodで架空カプセルを発行してsmoke testし、削除する。
- コミットSHA、環境、スタック、配置時刻、検証結果を リリース記録（`docs/releases.md`。Private のリポジトリだけにある）へ1行足す。秘密や実旅程は含めない。
- 同時に `README.md` の「状態」を読み直し、事実でなくなった文を直す。配置と関係なく変わる事実（リポジトリの公開範囲、台帳との接続など）は、それを変えた PR で直す。

IaCの正本は `aws/template.yaml`。コンソールで恒久設定を手修正した場合はIaCへ反映し、driftを確認する。SAMのパッケージ用S3は配置成果物置き場で、旅行原本の置き場ではない。

### C. 旅行を作成・公開・終了する

1. SwitchboardのタスクはGit外の成果物workspaceを使う。現在の移行データは隣接 `capsule-data/legacy-data/` に保全済み。将来の正式な保存先は設定可能なArtifact root。
2. RecipeからSpec/Documentを生成し、ローカルpreview。原本・実名を配布ファイルに入れない。（画面から作るときは、作成者が登録した自分の Anthropic API キーで Host が生成する。#76、`docs/design/host-side-generation.md`。貼り付けの道も残る）
3. 内容・期限・host・公開候補hashを確認して、`aws/publish.ts`で対象Hostへ送信する。Hostの再配置は不要。
4. ownerリンクは秘密保管へ、台帳には秘密なしURL・remoteId・期限・hashを記録。初期CLIは権限600のownerファイルへ保存する暫定方式。
5. 旅行中の共同編集はAWSが正本。ローカルの初期データで上書きしない。
6. 旅行後にExportし、必要ならKnowledgeへ明示保存。期限で共有不能にしAWS側データを削除する。
7. 運用者が旅行を期限の前に終わらせるときは `aws/capsules.ts terminate`（IAM）。ownerのpurgeと同じ保存の経路で消え、以後410。Webの管理者コンソール（#12）は作らない（#37）。

Publisherは操作IDで冪等。`aws/publish.ts`は入力の隣に`.operation`（権限600）を置き、毎回同じ操作IDを送る。Hostはカプセル IDをその操作IDから導くので、タイムアウトや通信断で応答を失ったら**同じコマンドをそのまま再実行する**（`.operation`を消さない）。前回が成功していれば二重発行にならず、失われたownerリンクは出し直して`.owner.json`に保存される（owner の席が空いていれば再実行の応答が新しいリンクを持ち、埋まっていれば`/recover`で再発行する）。`.owner.json`が既にあれば送信しない。

## バックログの管理

作業は GitHub Project「Capsule Host」（`https://github.com/orgs/iunct-lab/projects/4`）で管理する。運用は Switchboard と同じ：要望（`type:request`、要望の正本）→ PBI（`type:pbi`、ユーザーストーリー・検証つき受け入れ条件・Story Points）→ Task（`type:task`、PBI の sub-issue、1 Task = 1 PR）。着手順を決めるのは Project の Priority だけ。open な Milestone は「今のゴール」1 つだけで、到達点と進捗はその説明に書く（将来のゴールを並べて先に作らない。Sprint を置かないのと同じ理由）。

```sh
bash scripts/setup/triage_issue.sh <num> <area> <kind> <P0-P3> [parent-PBI] [Status]
bash scripts/setup/set_project_field.sh <num> "Story Points" 5
bash scripts/setup/request_issue.sh "要望: <題>" <body-file>
bash scripts/setup/lint_backlog.sh        # violations: 0 かつ exit 0 で合格
```

`scripts/setup/` は Switchboard の共通キット（`ops-kit`）を呼ぶ入口だけで、capsule-host の値（Project、選択肢、必須の節、Story Points）は root の `ops.config.json` にある。キットは `OPS_KIT`、無ければ `SWITCHBOARD_REPO_ROOT/ops-kit` から呼ぶ（どちらも無ければ exit 2 で案内が出る）。

Project の URL はリポジトリ変数 `CAPSULE_PROJECT_URL`。Issue を Project へ入れるのは上のスクリプトで、GitHub Actions による自動追加は置かない（PAT の登録・更新が要る割に、スクリプトと役割が重なるため）。Web 画面から直接作った Issue は `triage_issue.sh` を実行するまで Project に入らない。手順の詳細は共通スキルにある（Switchboard が Task の起動時に `.claude/skills` / `.agents/skills` へリンクで置き、`.git/info/exclude` で除外する）。スキルが読む capsule-host 固有の値（テスト、作業の場所、live check、マージ判定など）は root の `CLAUDE.md`。

## 公開リポジトリ

- 公開先: `iunct-lab/capsule-host`（Public）。開発はこの Private のリポジトリで続ける
- 送るもの: main のツリーだけ（新しい履歴。Private のコミット・Issue・PR は送らない）。外すファイルは root の `ops.config.json` の `publicSync.exclude`（配置の記録、Private の Actions の代わりのスクリプト、ラベルの同期）
- 公開側の扱い: Issue は要望だけ（要望のテンプレ）、質問・相談は Discussions。PR は受け付けず、workflow が方針の返信つきで自動で閉じる。脆弱性は Security Advisory（`SECURITY.md`）。公開側の要望は `request-to-backlog` の「公開側の Issue から」で、この Private のリポジトリの要望 Issue にしてから扱う
- 同期の回し方: 手で `ops-kit public-sync --source <開発タグ>`（`--source` は private origin にあり main に含まれる厳密な `vX.Y.Z`。初回は main へ直接、2 回目からは `sync/<版>` の PR を道具が公開側で Rebase and merge し、同じ版のタグと Release を付ける）。定期実行は Switchboard の「公開リポジトリへの同期（capsule-host）」（毎日 4 時、capsule-host の workspace。`--source` は `git describe --tags --abbrev=0 origin/main`）で、人はマージしない。開発タグが増えていなければ「nothing to sync」。止まったら Task が停止を報告する。手で回すときも、送る前に `--dry-run` で除外と検査の結果と、予定の公開版（`version:` の行）を見る
- 公開版（`publicSync.versioning: "independent"`）: 公開側の `vX.Y.Z` は開発タグ（`release-tag.ts` が付ける `v0.x.y`）とは別の番号。前回公開した source から今回の `--source` までの開発タグの最大区分（major > minor > patch）を、公開側で 1 回だけ上げる。公開側 `main` のコミットの題と Release は版だけ。台帳は private origin の `refs/public-sync/versions/*`。`package.json` の version は書き換えない
- `v0.1.0` の経緯: 2026-10-25、既存の公開履歴を独立採番へ移す機能が無かったため、公開側 `main` を題 `v0.1.0` の根のコミット 1 つに置き換え（ツリーは同じ）、タグ・Release・台帳・同期の記録を手で作った。共通化の要望は Switchboard の iunct-lab/switchboard-dev#2595
- 中断したとき: 台帳（`git ls-remote origin 'refs/public-sync/versions/*'`）と公開側を確かめ、同じ `--source` で再開する（台帳や公開タグを消して採番をやり直さない）。詳細は共通キットの README の「独立した公開バージョン」
- 仕組みの正本: Switchboard の `docs/design/public-repo.md`（公開側の受け口、公開する日の手順）と、共通キットの README の「公開リポジトリへの同期」

## 認証の値の検査

認証に使える値（device code と承認 URL、AWS の鍵、GitHub のトークン、秘密鍵、`Bearer` の値、AWS のアカウント ID、SSO の開始 URL、招待リンクの `#k=` の値）を Issue・PR に出さないためのルールは root の `CLAUDE.md` の「Issue・PR に書かない値」と、共通スキル `issue-workflow` の「Issue・PR・コメントに書かない値」。機械の検査は Switchboard の共通の仕組みで、このリポジトリに独自の実装は置かない。

- 規則: `ops-kit/src/secrets.ts` の `findSecrets`。当たったときに出すのは種類と場所だけで、値は出さない。足りない種類はこのリポジトリではなく共通の側に足す
- 投稿の前: Switchboard の Task（Claude Code・Codex とも）とホストの対話シェルで、`PATH` の先頭にある `ops-kit/bin/gh` が `gh` の書き込みの本文を検査し、当たれば `gh-guard: 投稿を止めました` で止める
- 既に書かれたもの: デーモンの予定「認証の値の検査」（`secret-scan`）が、登録済みの全リポジトリ（このリポジトリを含む）の Issue・PR・コメント・レビューを毎日見て、当たれば受信箱に残す。手で見るなら `ops-kit scan-issues`（このリポジトリの作業ツリーで。対象は origin）

独自の検査を置かない理由: 同じ役割の検査が 2 つあると、規則の片方だけ直す・片方だけ抜けることになる。前段が止めないもの（ホストの外、利用者の手元の端末やブラウザで書くもの、`gh` を使わない投稿、`gh issue close --comment` など前段が読まないコマンド。一覧は Switchboard の文書）は毎日の検査で後から見つける。#387 で自前の検査・hook・監査・毎日のワークフローを作り、共通の側がこのリポジトリの規則・読む範囲・毎日の検査を受けるようになったので #464 で外した。ホストの対話シェルの前段は、ホストを作り直したあとの実端末での確認が共通の側に残っている。

## ロールバックと削除

コードの障害は直前の検証済みコミットを再ビルドし、SAMと静的アセットを戻す。データやschemaの破壊変更はコードrollbackだけでは戻らないため、破壊的変更を避け、必要時は移行・回復計画を別に用意する。秘密鍵の意図しない更新は既存リンクを壊す。

運用者の強制終了（`aws/capsules.ts terminate`）はownerのpurgeと同じ保存の経路で、同じく取り消せない。Webの管理者コンソールは作らないので、運用者の削除の入口はこのIAMのCLIだけ。

カプセルのpurgeとCloudFormationスタック削除は別。旅行が終わってもHostスタックは削除しない。Host廃止は全旅行の終了・Exportを確認してから行う。DynamoDB・S3にはRetainを設定し、誤ったスタック削除による一括消失を避ける。保持リソースは費用が残るため、正式廃止時は別途削除する。バックアップは使わない（PITRもオンデマンドも無し。理由と、例外的に復元した場合の扱いは `aws/README.md`「バックアップ方針」）。例外的に復元すると、復元時点より後のpurge・期限の短縮・失効が取り消されるので、公開前にやり直す。

## 公開前に残ること

ブラウザ検証、API→CloudFront経由の制限。Lambda同時実行は予約5（#24。新規アカウントは上限の引き上げが要る、`aws/README.md`）。費用監視はアカウント全体の予算アラート（`aws/README.md`「保存・費用・残る検証」、#23）。prodスタックに `BudgetLimitUsd` / `BudgetEmail` を渡して配置し、`aws budgets describe-budgets` で予算があることを確かめるまでは残っている扱い。バックアップ方針は決定済み（使わない。`aws/README.md`「バックアップ方針」、#25）。現状のローカル検証成功を本番公開可能の証明としない。

期限拒否と定期物理削除はdevで実時間検証する（`aws/verify-expiry.ts`、#6。結果は配置の記録）。DynamoDB TTLによるトゥームストーンの後始末のタイミングはAWS側の仕様（最大48時間）で、約束の対象はpayloadの削除なのでここでは追わない。
