# capsule-host — このリポジトリ固有の値

開発の流れ（要望 → PBI → Task → PR → レビュー → マージ）は共通スキル（`issue-workflow` ほか。Switchboard が Task の起動時に `.claude/skills` / `.agents/skills` へリンクで置く）に従う。スキルに書かれていない、このリポジトリだけの値はここに置く（`issue-workflow` の「使う側のリポジトリが持つもの」の各項目）。スキルとこのファイルが食い違えば、このファイルに従う。配置・運用の正本は `docs/development-and-release.md` で、ここはそこを指す。

## リポジトリと Project

- リポジトリ: このリポジトリ（非公開。以下 `<repo>` = `gh repo view --json nameWithOwner -q .nameWithOwner` が答える `owner/name`）。`gh` の書き込み（issue / pr の作成・コメント・編集・マージ・クローズ）には `-R <repo>` を付ける
- 公開リポジトリ: `iunct-lab/capsule-host`（Public。main のツリーだけを `ops-kit public-sync` で送る新しい履歴。Issue は要望だけで、Private の要望 Issue にしてから扱う。PR は受け付けない（自動で閉じる））
- Project・選択肢（Area / Kind / Priority）・必須の節・Story Points: root の `ops.config.json`。Phase は使わない（open な Milestone は「今のゴール」1 つだけ。`docs/development-and-release.md` の「バックログの管理」）。Issue を Project に入れるのは `triage_issue.sh`（Actions の自動追加は無い）
- バックログの道具: `scripts/setup/` の入口（`lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `request_issue.sh`）。中身は Switchboard の共通キット（`ops-kit`）で、`OPS_KIT`、無ければ `SWITCHBOARD_REPO_ROOT/ops-kit` から呼ぶ。`bootstrap_project.sh` は置かない（Project は既にある）
- 公開リポジトリへの同期: `ops-kit public-sync`（共通キットの `bin/ops-kit`。`--dry-run` は送らずに結果だけ出す）。公開先・外すファイル・書き換えるファイルは root の `ops.config.json` の `publicSync`。仕組みはキットの README の「公開リポジトリへの同期」、このリポジトリの手順は `docs/development-and-release.md`。`publicSync.exclude` のファイル（配置の記録 `docs/releases.md`、Actions の代わりの `scripts/local-ci.ts`）は Private だけにあり、公開のツリーには無い
- Story Points の基準（閉じた PBI）: 2 = #342 / 3 = #355 / 5 = #39 / 8 = #10
- 設計ルール: README の「所有範囲」と `docs/development-and-release.md` の「管理する単位」「A. 共通機能を開発する」（認可・ライフサイクルは `src/cloud-host.ts` の 1 実装、旅行ごとのコピー・DB・スタックを作らない）。ライセンス: Apache-2.0（root の `LICENSE` / `NOTICE`）。依存を足すなら `bun pm licenses` で Apache-2.0 と両立するもの（Apache-2.0 / MIT / ISC / BSD-2-Clause / BSD-3-Clause / 0BSD / CC0-1.0 / Unlicense / BlueOak-1.0.0）か確かめ、PR に書く
- 互換の前提: 動いている旅行（prod のカプセル）がある。schemaVersion の破壊変更をせず、既存旅行を読めることを確かめる（`docs/development-and-release.md` の A-4）。API は直前の UI と互換にする（S3 と Lambda の更新は原子的でない。同 B）
- 並列ガード: Switchboard の `bun $SWITCHBOARD_REPO_ROOT/scripts/parallel-guard.ts <claim|overlap|release> … --repo <repo>`、`SWITCHBOARD_PROJECT_URL=$(gh variable get CAPSULE_PROJECT_URL)` を付ける（スキルの `<guard>`）

## テスト

```bash
bun run typecheck
bun run check                        # 型・全テスト（bun test src scripts）・AWS / ブラウザ用ビルド。CI も同じ + sam validate --lint
bun test src/<file>.test.ts -t "<name>"
sam validate --lint --template-file aws/template.yaml     # aws/template.yaml を触ったとき
```

変更ごとのテストの型:

| 変更 | テスト |
|---|---|
| 認可・保存・ライフサイクル・API | `src/cloud-host.test.ts`（`CloudHost` を `mktemp` の `LocalD1` と `src/test-fixture.ts` の偽の認証器で動かす）。DynamoDB 側は `src/aws-store.test.ts` |
| 旅程の形・変換（schema / export / paste / revise / timing） | 同名の `src/*.test.ts` |
| 画面（`src/client.ts`） | 描画のロジックは単体テスト。操作は `bun run dev` に対して `bun run verify:ui`（headless Chrome。足りなければ `src/verify-ui.ts` に手順を足す） |
| HTTP 越しの権限・競合・出力 | `bun run dev` に対して `bun run verify:http` |
| CloudFront・Lambda Web Functions の OAC・IAM・地域制限・期限削除 | AWS dev の実構成（下の live check） |

## 作業の場所

- main の作業ツリーでは作業しない。`git worktree add --detach ../capsule-host-<topic> origin/main` → `bun install --frozen-lockfile`。PBI を丸ごとなら `../capsule-host-pbi<PBI>`
- 枝: `ch/<Task番号>-<topic>`。Task を積むときは `gh stack`（`stacked-pr-delivery`）
- 作業ファイル: `W=$(mktemp -d /tmp/capsule-host.<用途>.XXXXXX)`。`/tmp` 直下に固定の名前で置かない（別のリポジトリのセッションとぶつかる）

## 動いている実物で確かめる（live check）

- ローカル: `bun run dev`（`http://localhost:47840`、データは `~/.local/share/capsule-host/dev/` か `CAPSULE_DATA_DIR`）を立て、別端末で `bun run verify:ui`（画面）/ `bun run verify:http`（権限・競合・出力）。どちらも架空の旅行を作って消す。手順は README の「ローカル開発」
- AWS dev（`capsule-host-dev`）: 認可・保存・削除を変えたら dev に配置して `bun aws/verify.ts …`（架空カプセルを発行 → 検証 → purge）。期限・sweep・ライフサイクルに触ったら `bun aws/verify-expiry.ts …` を dev で 1 回（6 分半〜13 分）。引数・profile・配置の手順は `aws/README.md` の「配置手順」「AWS検証」。dev には架空データだけを置き、検証で作ったカプセルは purge まで確かめる
- SSO が切れていたら（`aws sts get-caller-identity --profile <profile>` が失敗する）、dev の配置と verify は PBI の最後にまとめて 1 回にし、SSO の承認は PBI につき 1 回だけ頼む（頼み方は下の「Issue・PR に書かない値」）。AWS の要らない Task を先に進め、AWS の要る Task も dev の確認を待たずに PR・マージまで進める（`**前提**:` の順は変えない）。dev の確認を後に回した Task の結果コメントに「dev の確認は PBI の最後」と書く。PBI の最後の dev の確認は、PBI を閉じるセッションが Task を全部マージした後に行い、結果を PBI の `## 結果` に書き、落ちたら直す Task を足す
- prod（`capsule-host-prod`）への配置、prod での smoke test、`docs/releases.md` への記録は利用者の OK を取ってから（`docs/development-and-release.md` の B）。prod で `aws/verify-expiry.ts` は走らせない

## Issue・PR に書かない値

Issue の本文・コメント、PR の本文・コメント・レビューコメントに、次の値を書かない。失効済みでも、リポジトリが非公開でも書かない。触れるときは「値を伏せた」と書き、値そのものは書かない。コマンドの出力を貼るときは、これらを含む行を除く。

- device code（`user_code`）
- `user_code` 付きの承認 URL
- トークン（アクセストークン・セッショントークン・GitHub トークン）
- 鍵（秘密鍵・アクセスキー・署名鍵）
- Cookie
- 招待リンク・登録リンクの秘密（`aws/creator.ts enroll` の登録リンク、カプセルの owner / 参加者のリンク）
- AWS のアカウント ID（12 桁。アカウント ID 入りのプロファイル名・ARN を含む）
- SSO の開始 URL

無人の実行で SSO の承認が要るとき（`aws sso login` が device code を求めた）:

- 値を Issue に出さずに、`issue-workflow` の `## 判断待ち` で止める。止めるのは、PBI の Task を全部マージした後（AWS の要る Task も dev の確認を待たずに進めた後。PBI の最後の dev の確認の直前）の 1 回だけで、Task ごとには止めない。`## 判断待ち` は PBI に出し、問いは PBI にまとめた 1 回分の「SSO の再承認が要る（PBI の最後の dev の配置と verify のため）」。書くのは止めた場所と、利用者が手元で `aws sso login --profile <profile>` を実行してから `## 回答` を書けば続きから進むことだけ
- `## 判断待ち` の選択肢に「Issue に URL / code を出す」案を書かない
- device code は、利用者が居合わせる対話の画面（チャット・ターミナル）にだけ出す

利用者に頼む前に、エージェントが dev で確かめられることは先に自分で済ませる（例: 本物の LLM の呼び出しを 1 回通す）。利用者に頼むのは、端末やブラウザの権限など、エージェントには確かめられないことだけにする。

利用者に実機確認や配置を頼むときは、頼む文に次の 1 文を必ず入れる:

```text
<確かめてほしいこと・手順>
結果を `## 回答` に書くときは、アカウント ID・URL（CloudFront・Web Function の URL、承認 URL）・リンク（招待・登録・owner）を書かず、pass / fail と観察したことだけを書いてください。
```

機械の検査（投稿の前に止める・既に書かれたものを毎日見る）は Switchboard の共通の仕組みで、このリポジトリに独自の検査・hook・定期のワークフローを置かない。同じ役割の検査が 2 つあると、規則の片方だけ直す・片方だけ抜けるため（`docs/development-and-release.md` の「認証の値の検査」）。

## Switchboard の Task と動いているコード

- `SWITCHBOARD_SUPERVISED=1` なら自分は Switchboard の Task（スキルの「エージェント管理アプリの Task」）
- マージ後、main の作業ツリーは自分で `git pull --ff-only` する（未コミットの変更があれば、取り込むファイルと重ならないことを確かめてから）。`bun run dev`（`bun src/main.ts`）が動いていて、その作業ディレクトリが main の作業ツリーなら（`for p in $(pgrep -f '[b]un src/main.ts'); do lsof -a -p $p -d cwd -Fn | sed -n 's/^n//p'; done`）、pull の前に利用者の OK を取る
- 動いている Host（AWS dev / prod）への反映は上の live check のとおり。dev は自分で配置してよく、prod は利用者の OK を取ってから

## 画像（要望・PBI に貼るもの）

使わない（`feedback-assets` のような置き場を持たない。貼る必要が出たら、ここに置き場を決めて書く）。

## 利用上限

```bash
sqlite3 ~/.switchboard/switchboard.db "select * from quota"     # runner | window | utilization | resets_at(epoch s) | updated_at(ms)
date -d @<resets_at> 2>/dev/null || date -r <resets_at>     # GNU / BSD
```

Codex の `five_hour` が 0.9 以上、または `codex exec` が使用上限で止まったら、レビューは Claude のサブエージェントで代替する（`cross-runner-review` の 0）。

## マージ判定とローカル CI

- マージ判定: `bun $SWITCHBOARD_REPO_ROOT/scripts/merge-gate.ts <PR> --repo <repo> [--allow-large]`（exit 0 = merge / 1 = stop / 2 = 判定不能）。スキルの `<マージ判定>`
- ローカル CI: Actions が始まらない（run が数秒で failure、ジョブのステップ 0 件: `gh api repos/<repo>/actions/runs/<id>/jobs -q '.jobs[].steps|length'`）ときは、このリポジトリの `bun scripts/local-ci.ts <PR>`（Switchboard の `scripts/local-ci.ts` は Switchboard 専用なので使わない）。`ci.yml` の `run:` の手順を `pull/<n>/merge` の使い捨ての worktree で回し、全部通れば PR に `[local-ci] pass <head sha>` を付ける。マージ判定はその印をステップ 0 件の CI の成功と数える。下の PR のマージ後の自動 rebase などで head が変わったら回し直す。ステップが走って落ちた CI の代わりにはならない
- CI の結果は `gh run list -R <repo> --commit <sha>` で見る

## 追加のレビュアー

使わない（`cross-runner-review` の主レビュアー = 別ランナーだけ）。
