# Domain Kit — 新しい種類のアプリを足す

Host（`src/cloud-host.ts`）は、招待・席・ロール・パスキー・期限・削除・暗号化した旅行の鍵の受け渡しを、どの種類のアプリにも同じに行う。アプリの種類（旅程など）ごとに違うもの — Spec と Document の形、メンバーの操作、出力、LLM に渡す作り方 — は **Domain Kit** が持つ。Kit は `spec.kind` をキーに `src/kits.ts` へ登録し、Host は発行のときと、保存してあるカプセルを開くたびに、その `kind` の Kit を引く。登録の無い `kind` の発行は 400「対応していない種類です」。

最初の Kit は旅程（`src/trip-kit.ts`、`kind: "trip"`）。旅程の形・出力・直し方は `src/schema.ts`・`src/export.ts`・`src/revise.ts`・`src/recipe.ts`・`src/validate.ts`・`src/paste.ts` にあり、`trip-kit.ts` はそれらを Kit の形に並べる。

## Host が読むもの

Host が Kit の外で読むのは、Spec の `kind`・`title`・`lifecycle.purgeAt` と、Document の `revision` だけ（`src/kit.ts` の `Envelope` と `Versioned`）。

- `kind`: Kit を引く
- `title`: owner の削除の確認で打つ題（暗号化したカプセルでは暗号文なので、画面が比べる）
- `lifecycle.purgeAt`: 招待の期限の上限、保存の期限、期限を過ぎたら 410
- `revision`: `If-Match` と、変更のたびに 1 つ進む版

ほかの中身は Kit ごとに決めてよい。保存の形（`spec` と `document` を 1 行の JSON に入れる）とキーは種類によらず同じで、種類ごとのテーブル・スタック・コピーは作らない。

## Kit が持つもの

`src/kit.ts` の `DomainKit` の各項目。`?` の付いたものは無くてよく、無ければ Host はその機能を出さない（404「この種類では使えません」）。

| 項目 | 役割 |
| --- | --- |
| `kind` | 登録の名前。`spec.kind` と同じ |
| `publish` | 発行のときの検査。断るときは `Refused`（`refuse(400, "…")`）に発行者に返す文を入れる |
| `validate` | 保存してあるカプセルが、変更のたびに守る形。`sealed` は暗号化した形（言葉が暗号文）で読む |
| `stateOf` | `active` / `reflection` / `frozen` / `purged`。`frozen` で読み取り専用、`purged` で 410。`forced` は owner の共有終了 |
| `accent` | 画面のアクセント色（`theme.css`） |
| `refusal` | 設定の変更を断る理由（投稿のあるページを消す、期限を過去にする） |
| `period?` | カプセルが扱う日付と時間帯。足あと・自分だけのメモ・作成者の一覧の日付に使う |
| `hasItem?` | 写真を付けられる予定があるか |
| `exports?` | 平文のカプセルの ZIP（`zip`・`name`）と、Markdown・HTML だけの出力 |
| `recipe` | チャットに渡す作り方（`text`）と、Host の生成に渡す指示（`generate`） |
| `judge` | 貼った答え・生成した答えを、発行と同じ規則で検査する（`POST /v1/check`） |
| `apply` | メンバーの 1 つの操作（`PATCH document`）を Document に当て、`validate` と同じ規則で検査し、版を 1 つ進める。誰が何をできるか（ロール・参加者の設定・ページの有無）は Kit が決める。`viewer` と `frozen` の読み取り専用は Host が先に断る |
| `revise?` | チャットで直す・1 つ前に戻す。平文の直し（`revise`・`undo`）、暗号化したカプセルを画面が直した結果の検査（`resealed`）、戻すために残す形（`step`） |
| `sealed?` | 暗号化した形。平文のカプセルを移すときに画面が持ってくる 1 つ前の形（`previous`）と、鍵を替えたときに記録が変わっていないことの検査（`rekeyed`）。無い種類は暗号化できないので、発行できない（400） |

## 足す手順

1. `src/<name>-schema.ts`: Spec と Document の形（zod）。Spec に `schemaVersion`・`kind`・`title`・`lifecycle.purgeAt`、Document に `revision` を持たせる。日時・暗号文・名前などの共通の形は `src/fields.ts` から使う
2. `src/<name>-kit.ts`: `DomainKit<Spec, Document>` を組む。旅程のモジュールや操作を使うなら、`src/schema.ts`・`src/trip-kit.ts` から import して使い、写さない
3. `src/kits.ts` の `kits` に `"<kind>": <name>Kit` を足す
4. `src/<name>-kit.test.ts`: `validate` が通す形と弾く形、`stateOf` の各状態、`apply` のロールごとの可否
5. Host を通した流れを 1 つ通す: `src/cloud-host.test.ts` の `describe("a second domain kit")` と同じく、発行 → owner の引換 → 操作 → viewer の 403 → 持たない機能の 404 → 出力 → 期限の後の 410。テスト用の Kit（`test-note`）はこのテストファイルの中にあり、Kit の最小の例として読める
6. 画面（`src/client.ts`）は `spec.kind` で出し分ける。作り方（Recipe）は `docs/recipes/<kind>.md` に置く

## 形を変えるとき

動いているカプセルがあるので、`schemaVersion` の破壊変更をしない。形を変えるときは、新しい形を古い形と併存させ（両方を `validate` が読む）、画面を切り替え、古い形を使うカプセルが無くなってから古い形を外す。Host の API は直前の画面と互換にする（Host と画面の配置は同時ではない）。
