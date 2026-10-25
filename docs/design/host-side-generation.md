# Host 側で旅程を生成する（作成者の Anthropic API キーで。2026-10-14 に方式を改訂）

親 PBI: #76。元要望: #73（LLM の機能は最終的に Capsule ホストに持たせる）。履歴: Spike #81（PR #233）の設計から、2026-10-14 に利用者の指示で現在の方式へ改訂した（旧案は §9）。

## 0. 結論

（HTTP ステータス・文言・列名・上限の細部は実装 Task #640〜#644 で確定する。食い違ったら実装と Task の結果コメントを正とし、この文書を直す。）

- **Host は、作成者が登録した自分の Anthropic API キーで、Anthropic の Messages API を直接呼ぶ。** 費用は鍵の持ち主の Anthropic 請求に行く。Host の運用者は LLM の費用を払わない（利用者の判断: 費用は提供側でなく、各利用者が登録する自分の API キーで持つ）
- Bedrock 経由などの他の経路は採らない（§9）。定額プランのログインは Host では使えない（§3）
- **用途は旅程の生成 1 つ。** 修正・質問の用途は、必要になったときに足す。抽象は先に作らない
- **鍵**: 作成者 1 人に 1 本。アプリ層で AES-256-GCM に封じ、SSM Parameter Store（ローカルは SQLite）に置く。どの応答にも返さない（§3）
- **上限**: 作成者ごと 1 分 2 回・同時 1 件、Host 全体で同時 2 件、希望文 6,000 バイト。日・月の上限は持たない（§4）
- **非同期**: `POST /v1/assist` は 202 とジョブ ID を返し、Host の Lambda が自分自身を Event で起動して生成する。画面は `GET /v1/assist/<id>` を見る（§5）
- **生成物の扱い**: 返事は貼り付け（#75）と同じ `extract()` → `check()` → `explain()` に通してから見せる（§6）。貼り付けの道も残す

## 1. （欠番）

他の文書が §番号で参照するので番号は詰めない。採らなかった案は §9。

## 2. 見積もり（実測なし）

1 回の生成は、入力 約 7,000 トークン（作り方 `docs/recipes/trip.md` 約 5,000 ＋ 出力スキーマ ＋ 希望文）、出力 約 5,000 トークン（3,000〜6,000）と見る。上限は出力 16,000。

| モデル | 価格（入力 / 出力、$/100 万トークン） | 1 回の概算 |
|---|---|---|
| `claude-opus-5-5` | $4 / $20 | 約 $0.13 |
| `claude-sonnet-5-5` | $2 / $10 | 約 $0.06 |
| `claude-haiku-5-5`（既定） | $0.10 / $0.50 | 約 $0.003 |

出典: Anthropic の公開価格（2026-10-06 時点）。実測はしていない。dev での実測は利用者が自分の鍵で 1 回行う（§8）。費用は作成者の負担なので、既定は最安の `claude-haiku-5-5`（2026-10-14 の利用者の判断で、最安を前提にする）。スタックのパラメータ `AssistModel` で変える。

## 3. 規約と鍵

Anthropic の Legal and compliance（https://code.claude.com/docs/en/legal-and-compliance 、2026-09-25 取得）と Commercial Terms（https://www.anthropic.com/legal/commercial-terms 、2026-10-20 取得）を読んだ結論:

- **定額プラン（Claude Pro / Max）のログインや `setup-token` を Host が預かることはできない。** 「developers may not collect, store, or intermediate Claude.ai credentials」「route requests through … Max plan credentials on behalf of their users」に当たる。Switchboard が許される根拠（改変していない `claude` を利用者自身の機械で、認証情報を保存せずに起動する）は、Lambda で動く多人数向けの Host には移せない
- **利用者自身の API キーは許される。** 「This does not restrict how customers provision and manage their own API keys … in a development environment, secrets manager, or machine image … provided the resulting usage is billed to the key owner」。作成者が自分の鍵を登録し、費用が鍵の持ち主に行く使い方はこれに当たる
- ChatGPT / Codex の定額は、規約を確かめていないので採らない

保管:

- AWS: SSM Parameter Store の SecureString `/capsule-host/<stack>/creator-key/<creatorId>`（AWS 管理キー `aws/ssm`、費用 0）。値はアプリ層で封じた暗号文
- ローカル: SQLite の `creator_keys` 表（`subject`・`sealed`・`updated`）
- 封じ方: AES-256-GCM。鍵は `CAPSULE_HMAC_KEY` から HKDF-SHA256（info `capsule-host creator-key`）で派生させ、iv 12 バイト、AAD に主体（creatorId）。出力は base64url の `iv | tag | ciphertext`
- 復号は Cookie の作成者の creatorId でだけ行う。別の作成者の値は AAD が合わず開けない
- **鍵の値はどの応答にも返さない。** 登録の有無（`/v1/account` の `assistKey`）だけを返す。ログにも書かない
- 登録時は `models.list`（費用 0）で有効かを確かめる。生成の試し呼びはしない
- 作成者を失効させると鍵も消す
- 最後に使ってから（登録・上書きか生成の遅い方）30 日で、定期の掃除（`CloudHost.sweep`。旅行の掃除の後、AWS は 5 分ごと、ローカルは 1 分ごと）が消す。使った時刻は AWS はタグ `used` と `LastModifiedDate` の遅い方、ローカルは `updated`。使った時刻を進めるのに値は書き直さない（削除と競っても消した鍵が戻らない）。鍵の掃除が失敗しても旅行の掃除は止まらない。旅行の席の鍵は旅行と一緒に消えるので対象外。画面の鍵のカードはそのことを言う。要望 #742・#744
- 鍵の登録・置き換え・削除は、作成者の Cookie ではサインインから 5 分以内だけ（過ぎれば 428。画面はサインインし直して送り直す。#748）。IAM の発行者の身元は対象外

Secrets Manager の 3 本目・顧客管理 KMS は固定費が出るので作らない。Data テーブルの行に置く案（IAM の変更なし）は、鍵と旅程を同じ表・同じ IAM に置かないために採らなかった。

## 4. 濫用と上限

**作成者だけが呼べる**（`/v1/check` と同じ判定。作成者の Cookie か IAM の発行者）。owner リンクは人に渡せる capability link なので、呼び出しの入口にしない。

| 上限 | 値 | どこで効かせるか | 超えたとき |
|---|---|---|---|
| 作成者ごと | 1 分 2 回、同時 1 件 | Host（`rate()` と実行中の行 `assist:running:<digest>`） | 429「前の生成が終わるまで待ってください」/「混み合っています。1 分ほど待ってもう一度試してください」 |
| Host 全体 | 同時 2 件 | Host（枠の行 `assist:slot:0` / `assist:slot:1` を既存の版数 CAS で取る） | 429「混み合っています。1 分ほど待ってもう一度試してください」 |
| 希望文 | 6,000 バイト（UTF-8、日本語で約 2,000 文字） | Host | 413 |
| 作成者の鍵が無い | — | Host | 412「Anthropic の API キーを登録してください」 |

- 日の上限・月額の上限・AWS Budgets の通知は持たない。LLM の費用は鍵の持ち主に行き、鍵の持ち主は Anthropic 側で上限を設定できる。Host の運用者に掛かるのは Lambda の実行時間だけ（1 回 300 秒 × 256 MB でも 0.002 USD 未満）
- 回数は受け付けた時点で数え、失敗しても戻さない
- 枠は「行が無いか `until <= now` なら書く」という条件付きの書き込みで取る。同時に来た要求でも取れるのは片方だけ。生成が終われば `until` を 0 にして空ける。消せないまま終わっても締め切りで再び取れる
- **プロンプトインジェクション**: 希望文は信用しない入力として `user` にだけ入れ、ツールは渡さない。返事は `check()` を通ったものしか画面に出さない。希望文・鍵・返事は Host のログに書かない
- 希望文はジョブ行の payload に置き、生成が終わったら消す（Lambda の Event には ID だけを乗せる）

## 5. 非同期ジョブ

経路は CloudFront → Web Function（OAC）。CloudFront が origin を待つのは 60 秒までで（`OriginReadTimeout`、`docs/design/lambda-web-functions.md`）、生成は数十秒かかるので、Web Function が Event Function（`Host`）を Event で起動して、その `Timeout` の範囲で行う。

- `POST /v1/assist { text }`: 上限（§4）を確かめ、ジョブ行 `assist:<id>`（`Data` の別キー、TTL 付き。作成者の digest・state・締め切り・希望文）を書き、実行中の行と枠を取り、`dispatch(id)`（Web Function が Event Function を起動）して 202 `{ id }`
- AWS の `dispatch` は `lambda:InvokeFunction`（`InvocationType: Event`、payload `{ source: "capsule.assist", id }`）。`EventInvokeConfig` の `MaximumRetryAttempts: 0`、`MaximumEventAgeInSeconds: 60`。`Host`（Event Function）の `Timeout` は 300 秒（HTTP は CloudFront の 60 秒で切れる。長いのは Event Function で動く生成だけ）。ローカルは同じプロセスで `void runAssist(id)`
- `runAssist(id)` はジョブ行から鍵を復号して生成し、検査の結果をジョブ行に書く。`done`（検査の結果つき。落ちた場合も `ok: false`）・`failed`（`Anthropic.APIError` の `status` だけ。例外の文は入れない）のどちらでも、最後に実行中の行と枠を空ける
- `GET /v1/assist/<id>` を読めるのは、そのジョブを作った作成者だけ（digest が一致するとき。他は 404）。画面は 3 秒おきに見る
- 締め切りは受付から 360 秒。過ぎても終わらないジョブは `failed` として返す。文は「生成に失敗しました。もう一度試すか、作り方をコピーしてチャットで作ってください」
- Host では再試行しない。SDK も `maxRetries: 0`、`timeout` 280 秒。もう一度は利用者が押す（1 回として数える）

## 6. モデルと呼び方、検査へのつなぎ方

- モデルは環境変数 `CAPSULE_ASSIST_MODEL`（スタックのパラメータ `AssistModel`、既定 `claude-haiku-5-5`）。画面からは選べない
- `@anthropic-ai/sdk`（MIT）の `messages.parse` に、旅程のスキーマ（`src/json-schema.ts`）を `output_config.format` で渡す。`system` に作り方、`user` に希望文だけを入れる
- `stop_reason`: `max_tokens` → `cut-off`、`refusal` → failed、それ以外は最初の `text` ブロックの本文を `extract()` → `check()` → `explain()` に通す（`/v1/check` と同じ。`parsed_output` は使わず、検査は Host の `check()` に任せる）
- 応答は `/v1/check` の応答と同じ形（成功は `ok`・`title`・`purgeAt`・`items`・`sha256`・`trip`、検査落ちは `ok: false`・`errors`・`messages`、取り出せなければ `ok: false`・`reason`）。画面は貼り付けの後と同じ preview とエラー表示を使う。生成での `cut-off` の文は貼り付けと分ける（「生成が途中で切れました。希望を短くしてもう一度試してください」）
- 生成の部分は `CloudHost` に注入する（時計と同じやり方）。単体テストは偽の生成器で 412・413・429・打ち切り・検査落ち・締め切り切れを書ける
- 画面の入口は、今の「作り方をコピー → チャットで作って貼る」の隣に「ここで作る」を置く。貼り付けの経路は残す（鍵の無い人の道）

### 6.1 調べもの（2026-10-15、#658 の利用者の指示）
- 呼び出しに Anthropic 側の `web_search_20250305`（`max_uses` 5）を付ける。使うかどうかは**モデルが判断する**（導線・画面の選択は増やさない）。計画を立てる依頼では見どころ・営業時間などの最新を調べ、小さな修正では調べない、とシステム文（`SEARCH_NOTE`）に書く
- 費用は鍵の持ち主に増える: 検索 1,000 回あたり $10 と、検索結果の入力トークン。1 回の呼び出しは最大 5 回の検索
- 検索中の `pause_turn` は続きを呼ぶ。答えは最後の検索より後の本文。API が検索そのもので 400 を返したとき（組織の設定で無効など）は、検索なしで 1 回やり直す
- 検査が断った答えの修正（1 回）には検索を付けない

## 7. MCP 的な受け口（後段、この PBI では作らない）

`/v1/recipe`（作り方）と `/v1/check`（検査とエラー文）は、そのまま MCP の道具にできる（`get_recipe` / `check_trip`、必要なら `publish_trip`）。外の LLM クライアントが作成者の鍵を使わずに生成してから `check_trip` で検査し、`publish_trip` で出す形になる。MCP クライアントは作成者の Cookie を持てないので、開くときの認証（作成者トークンの発行・失効）は、その PBI で決める。この PBI では実装しない。

## 8. 決まったこと・残っていること

決まったこと（利用者の指示、2026-10-14）:

- Host が LLM の費用を払う形は採らない。作成者が自分の Anthropic API キーを登録する
- 他の経路（§9）は使わない。定額ログインは規約上できない（§3）
- 上限は回数・同時・長さだけ。費用の上限は鍵の持ち主の Anthropic 側で設定する

残っていること:

- 実測: 利用者が自分の鍵を dev の作成者として登録し、架空の希望で 1 回生成する（pass / fail、所要秒数、Anthropic Console の入出力トークン数だけを記録する）

## 9. 採らなかった案（記録）

| 案 | 採らなかった理由 |
|---|---|
| Host が Bedrock（GPT-5.6 Luna、Global CRIS）を直接呼ぶ（Spike #81） | 運用者が LLM の費用を払うことになる。上限と Budgets が要る |
| Host が DAK を呼ぶ（2026-09-23） | 運用者が費用を払う点は同じで、呼び先の側の前提待ちになる。DAK につなぎ直すなら別の PBI |
| 作成者の定額プラン（Pro / Max、ChatGPT）のログインを預かる | 規約上できない（§3） |
| 他社 API（OpenAI / Gemini）の鍵 | 用途と鍵が 2 つ目になったときに別の PBI で |

## 10. 旅行の中の修正は、各メンバー自身の鍵で（#658、#657）

作成者の鍵は作成画面の生成だけに使う。旅行のほかのメンバーが作成者の鍵を使うことはしない（利用者の指示 2026-10-14）。旅行の中の「チャットで直す」を Host が行うときは、**オーナー・編集者それぞれが自分の Anthropic API キー**を登録し、自分の席の権限で使う。

- 鍵は席（`Session`）に持たせる: `Session.assistKey` に、`<カプセル ID>:<席 ID>` を主体として §3 と同じ方式で封じた値を置く。席・旅行が消えれば（失効・入れ替え・期限・purge）鍵も一緒に消える。一覧・書き出し・他の席の応答には出ない
- 登録・削除: `PUT` / `DELETE /v1/c/<id>/key`（オーナー・編集者のみ。登録時に `models.list` で確かめる。上限は §4 の形で、5 回 / 分）。`GET /v1/c/<id>` は `assistKey: boolean` だけを返す
- 修正: `POST /v1/c/<id>/revise/assist { instruction }` が §5 のジョブを作る（同じ上限・枠・締め切り）。入力は今の「チャットで直す」でコピーする文と同じ旅程と、直してほしいこと。答えは**テキストのまま**ジョブに返り、画面が既存の `revise/check` に渡す。差分の確認・反映・1 つ前に戻すは今のとおり。`GET /v1/c/<id>/revise/assist/<ジョブ ID>` を読めるのは依頼した席だけ
- 閲覧者・参加者は登録も修正もできない。貼り付けの道は残る
- 質問・相談の LLM 化は別 PBI

## 出典

- Anthropic の価格: [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)（2026-10-06 時点の値を使った）
- 規約: Anthropic の Legal and compliance（https://code.claude.com/docs/en/legal-and-compliance 、2026-09-25 取得）と Commercial Terms（https://www.anthropic.com/legal/commercial-terms 、2026-10-20 取得）
- 最初の版（Bedrock の見積もり、他社 API の価格）: PR #233。中間の版は PR #239
