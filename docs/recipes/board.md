# Recipe: 共有ボード（kind: board）

出欠確認・持ち物リスト・幹事のメモのような、旅行期間も行き先も持たない「みんなで使うページ」を、Capsule Host に発行できるデータ（Spec と初期 Document）にして 1 ファイル作るための手順。
このファイルを渡されたエージェントは、ここに書いてあることだけで作業できる。発行はしない（検査まで。preview と発行は人が行う）。
日付ごとの予定・行き先・旅の顔ぶれがある用途は、共有ボードではなく旅程（`docs/recipes/trip.md`）で作る。

## 入力

利用者が自然言語で書いた用途。何のためのページか、誰と使うか、確かめたいこと・持ち寄りたいこと・決めたいこと、いつまで使うか。
足りない項目は聞き返さず、下の「決め方」の既定で埋め、何を仮に決めたかを最後に報告する。

## 出力

JSON を 1 ファイル。形は次のとおりで、ほかのトップレベル項目は足さない。

```
{ "schemaVersion": 1, "spec": { … }, "document": { … } }
```

- 置き場所は**このリポジトリの外**（利用者が指定した場所。無ければ `/tmp` 以下）。リポジトリには架空のデータしか置かない
- **チャットで作っている場合**（画面で「作り方をコピー」して貼った場合）は、ファイルに書かずに**返事としてそのまま返す**。利用者はその返事を画面に貼り戻す。前後に説明の文が付いていても、コードフェンスで囲んでいても構わない。ただし**ボードは 1 つだけ**返すこと（2 案を並べると貼り付け側で断られる）。途中で切らず、最後まで返すこと
- `spec` はページの形（題、どのページを出すか、見た目、期限）。`document` は中身（候補、チェックリスト、メモ、費用の目安）
- 最後に利用者へ報告する: 仮に決めたこと、入れなかった情報。**ファイルに書いた場合**はその場所と `bun run validate` の結果（`title` / `purgeAt` / `sha256`）も。**チャットで返した場合**は、利用者が画面に貼ると同じ検査が走るので、検査結果の報告は要らない

## 構造

すべての項目が strict で、ここに無い項目は 1 つも足せない。旅程と違い、`spec.trip`・`spec.presentation`・`spec.lifecycle.reflectionDays`・`document.items` は**無い**（書くと検査で弾かれる）。

`spec` の項目:

| 項目 | 値 |
|---|---|
| `schemaVersion` | `1` |
| `kind` | `"board"` |
| `title` | ページの題（160 字まで） |
| `summary` | 短い紹介文（省略可、4,000 字まで） |
| `locale` | `ja` / `en` |
| `timezone` | IANA 名（国内なら `Asia/Tokyo`） |
| `modules` | ページ（下の表）。1〜12 個 |
| `navigation` | タブとして出す `modules[].id` の並び。1〜12 個 |
| `theme` | `{ "preset", "accent" }` |
| `collaboration` | `{ "participantSuggestions", "participantComments", "participantChecklist" }` |
| `lifecycle` | `{ "purgeAt" }`（全データを消す時刻） |
| `exports` | `markdown` / `json` / `html` の中から 1〜3 個 |

`spec.modules` はページ。`kind` ごとに表示する `document` の場所が決まっている。**`spec.navigation` に `id` を入れたモジュールだけがタブとして表示される**（並び順もここ）。用途に合うものだけ選ぶ。

| `kind` | 表示するもの | 使うとき |
|---|---|---|
| `suggestion-board` | `document.suggestions`（案・希望）と `document.comments`（相談） | 日程の候補や行き先の案を出し合う、質問を集める |
| `checklist` | `document.checklist`。`mode` は `shared` のみ。メンバーがチェックを付けられる | 出欠、持ち物、やることの確認 |
| `budget` | `document.budget`（概算。精算の記録ではない）。`currency` は `JPY` のみ | 会費や費用の目安を共有したい |
| `notes` | `document.notes`（1 つの文章） | 集合の約束、注意事項、幹事のメモ |
| `reflection` | `document.reflections`（ふりかえり）。共有中はいつでも書ける。初期値は空配列 | 終わったあとに感想を集めたい |

- `spec.theme.preset`: `paper`（生成りの紙、既定）/ `postcard`（暖色の背景）/ `minimal`（白い背景）/ `night`（暗い配色）。`accent` は差し色で、`#` + 16 進 6 桁
- `spec.collaboration`: 参加者（オーナー・編集者以外）に案の投稿・相談・チェックを許すか。出欠や持ち物は本人が付けるので、迷ったら 3 つとも `true`

`document` の項目（6 つとも省略不可。使わない配列は `[]`、`notes` は空でも `""`）:

- `revision`: `1`
- `suggestions[]`: `{ "id", "author", "body", "createdAt" }`。旅程と違い `promoted` は無い
- `comments[]`: `{ "id", "author", "body", "createdAt" }`
- `checklist[]`: `{ "id", "title", "done" }`。`done` は初めは `false`
- `reflections[]`: 初期値は `[]`
- `notes`: 文章 1 つ
- `budget[]`: `{ "id", "title", "amount", "description" }`。`amount` は円の整数

## 決め方

- `spec.lifecycle.purgeAt`: 使い終わる日の 30 日後の `T00:00:00` + オフセット（例 `2027-01-31T00:00:00+09:00`）。**作成日から 180 日以内**でなければならない。分からなければ作成日の 60 日後
- 状態は、共有中（だれでも書ける）→ オーナーが「共有を終了」すると読み取り専用 → `purgeAt` で全部消える。旅程のような「旅行後」の期間は無い
- `spec.locale`: 希望の文章が日本語なら `ja`、英語なら `en`
- ID（`modules[].id`、`checklist[].id` …）は英数字と `_` `-` だけ。同じ配列の中で重複させない。`navigation` は `modules[].id` だけを、重複なく
- 上限: 文字列は短いもの 160 字・文章 4,000 字、`modules` 12、`suggestions` 300、`comments` 500、`checklist` 200、`budget` 100、全体で 2 MiB
- 出欠の確認は `checklist` に参加者のニックネームを 1 人 1 行で入れ、本人がチェックを付ける形にする。日程の候補は `suggestions` に 1 案 1 件
- 希望に書かれていないことを事実のように作らない（架空の店名、決まったかのような日時や金額）。決まっていないことは `suggestions` にする
- `suggestions[]` / `comments[]` を初期値として入れるなら `author` はニックネーム、`createdAt` は作成時刻

## 入れてはいけない情報

ページは招待した人が開ける。次のものは、**希望の文章に書かれていても出力のどこにも入れない**（`notes`、`title`、`body` を含む）。伏せ字や一部だけにして残すこともしない。

- パスポート、運転免許証などの本人確認書類の番号や画像、クレジットカード情報
- チケットや入場券の QR / バーコード
- 予約番号・確認番号など予約の変更や取消に使える番号、予約の管理に使える秘密の URL
- 自宅の住所、鍵の受け渡し方法、部屋やロッカーの暗証番号、健康情報
- API キー、パスワード、会員 ID とパスワードの組
- 本名のフルネーム、電話番号、メールアドレス（参加者はニックネームで書く）

**入れなかったものがあれば、種類を挙げて利用者に伝える**。番号そのものは報告にも書かない。
この検査は機械ではしていない。`bun run validate` が通っても、ここに挙げた情報が入っていないことの証明にはならない。

## 検査と直し方

チャットで作っている場合は、この節の代わりに**利用者が画面に貼り戻し**、画面が同じ検査をして結果を見せる。直すべき点は日本語で表示されるので、それを伝えてもらって直す。

手元にファイルとして持っている場合は次のコマンドで検査する。

```bash
bun run validate <file>
```

発行はされない。結果は標準出力の JSON と exit code。

- `{"ok": true, "title", "purgeAt", "sha256"}`・exit 0: 完了。`sha256` は発行するときに人が承認するハッシュなので、報告に含める
- `{"ok": false, "errors": [{"path", "message"}]}`・exit 1: `path`（例 `spec.theme.accent`）の項目を直して、もう一度実行する。`path` が `spec` や空のものは、項目どうしの関係の誤り（ID の重複、`navigation` にモジュールに無い `id`、`purgeAt` が 180 日より先）。`message` を読む
- **3 回直しても通らなければ止めて**、最後の `errors` をそのまま利用者に報告する

## 例

架空の出欠確認。形の参考で、文言や構成をなぞる必要はない。

```json
{
  "schemaVersion": 1,
  "spec": {
    "schemaVersion": 1,
    "kind": "board",
    "title": "冬の持ち寄り会 出欠",
    "summary": "来られるかどうかと、持ってくるものを書いてください。",
    "locale": "ja",
    "timezone": "Asia/Tokyo",
    "modules": [
      { "id": "who", "kind": "checklist", "label": "出欠", "mode": "shared" },
      { "id": "ideas", "kind": "suggestion-board", "label": "日程の候補" },
      { "id": "memo", "kind": "notes", "label": "幹事のメモ" },
      { "id": "fee", "kind": "budget", "label": "会費", "currency": "JPY" }
    ],
    "navigation": ["who", "ideas", "memo", "fee"],
    "theme": { "preset": "paper", "accent": "#7a4f2f" },
    "collaboration": { "participantSuggestions": true, "participantComments": true, "participantChecklist": true },
    "lifecycle": { "purgeAt": "2027-02-01T00:00:00+09:00" },
    "exports": ["markdown", "json", "html"]
  },
  "document": {
    "revision": 1,
    "suggestions": [
      { "id": "d1", "author": "あお", "body": "12月の第2土曜の夜", "createdAt": "2026-11-05T21:00:00+09:00" },
      { "id": "d2", "author": "あお", "body": "12月の第3日曜の昼", "createdAt": "2026-11-05T21:00:00+09:00" }
    ],
    "comments": [],
    "checklist": [
      { "id": "ao", "title": "あお", "done": false },
      { "id": "midori", "title": "みどり", "done": false },
      { "id": "kiiro", "title": "きいろ", "done": false }
    ],
    "reflections": [],
    "notes": "場所はみんなが来やすいところを相談して決めます。表示名はニックネームで。",
    "budget": [
      { "id": "f1", "title": "会費（一人あたり）", "amount": 2000, "description": "飲みものと取り分けの皿の分。" }
    ]
  }
}
```
