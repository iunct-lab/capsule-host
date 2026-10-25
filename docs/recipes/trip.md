# Recipe: 旅程（kind: trip）

旅行の希望を書いた文章から、Capsule Host に発行できる旅のしおりのデータ（Spec と初期 Document）を 1 ファイル作るための手順。
このファイルを渡されたエージェントは、ここに書いてあることだけで作業できる。発行はしない（検査まで。preview と発行は人が行う）。

## 入力

利用者が自然言語で書いた旅行の希望。行き先、日程、人数や顔ぶれ、やりたいこと、決まっている予定、まだ決めていないこと。
足りない項目は聞き返さず、下の「決め方」の既定で埋め、何を仮に決めたかを最後に報告する。日程だけは推測しない（書かれていなければ聞く）。

## 出力

JSON を 1 ファイル。形は次のとおりで、ほかのトップレベル項目は足さない。

```
{ "schemaVersion": 1, "spec": { … }, "document": { … } }
```

- 置き場所は**このリポジトリの外**（利用者が指定した場所。無ければ `/tmp` 以下）。リポジトリには架空のデータしか置かない
- **チャットで作っている場合**（しおりの画面で「作り方をコピー」して貼った場合）は、ファイルに書かずに**返事としてそのまま返す**。利用者はその返事を画面に貼り戻す。前後に説明の文が付いていても、コードフェンスで囲んでいても構わない。ただし**旅程は 1 つだけ**返すこと（2 案を並べると貼り付け側で断られる）。途中で切らず、最後まで返すこと
- `spec` はしおりの形（題、日程、どのページを出すか、見た目、期限）。`document` は中身（予定、候補、準備リスト、メモ、費用の目安）
- 最後に利用者へ報告する: 仮に決めたこと、入れなかった情報。**ファイルに書いた場合**はその場所と `bun run validate` の結果（`title` / `purgeAt` / `items` / `sha256`）も。**チャットで返した場合**は、利用者が画面に貼ると同じ検査が走るので、検査結果の報告は要らない

## 直すとき

しおりの「チャットで直す」でコピーした文には、この文書の後ろに **「今の旅程」** が付いている。そのときは新しく作らず、今の旅程を直す。文を短くするため、最後の「例」は省いてある。今の旅程を土台にする（形はそれに倣う）。

文の最初に **「直してほしいこと」** があれば、それが利用者の頼み。無ければ、利用者がチャットで続けて書く頼みに従う（頼みが来るまで旅程を返さず、何を直すか聞く）。

「今の旅程」に「この旅程は編集者が直します」と書いてあれば、`spec` は一字も変えずにそのまま返す（編集者の反映では設定は変わらない）。題・日程・期限を変えてほしいと頼まれたら、変えずに「設定はオーナーが直します」と報告する。

- 今の旅程を土台に、**利用者が頼んだところだけ**直す。頼まれていない予定・文言・設定は変えない
- 場所に座標の無い予定へ、`place.lat` / `place.lng` を足してよい（頼まれたとき、または場所が分かるとき。場所の名前は変えない）
- 予定（`items[]`）の `id` は保つ。そのまま残す予定と直す予定は同じ `id`、足す予定は新しい `id`、やめる予定は配列から消す。`id` を振り直すと、全部の予定が「削除して追加」に見える
- 候補（`suggestions[]`）・相談（`comments[]`）も `id` を保つ。残す・直す投稿は同じ `id`、足す投稿は新しい `id`、やめる投稿は配列から消す
- 候補・相談の `author`・`createdAt` は書かない。既存投稿は元の値、新しい投稿は反映した人と時刻をしおりが付ける。候補の `promoted` は返す値を使う
- まだ決まっていない予定を候補に戻すときは、`items` から消して同じ内容を `suggestions` に `promoted: false` で足す
- 思い出（`reflections`）はしおりが保持し、答えに含めても使われない
- 返すのは `{ "schemaVersion": 1, "spec": { … }, "document": { … } }` の旅程**全体を 1 つ**（直したところだけを返さない）。`document` は今の旅程と同じ `items`・`checklist`・`notes`・`budget`・`suggestions`・`comments` の 6 つ
- `revision` の値は触らない。準備リストの `done` もそのまま（チェックの状態はしおりの側の値が残る）
- 今あるページ（`spec.modules`）は消さない。削除期限（`purgeAt`）を過去にしない。どちらも反映のときに断られる
- 利用者はその返事をしおりに貼り、今の旅程との差分を見てから反映する。報告には何を直したかを短く書く

## 構造

項目の名前・型・必須かどうか・長さと件数の上限の正本は JSON Schema。ここに写しは置かない。

- **手元でコマンドを実行できる場合**は、作る前に必ず読む: `bun run schema`
- **チャットで作っている場合**（コマンドを実行できない場合）は、この文書の最後にある「例」を土台にする（「チャットで直す」でコピーした文には例が無い。そのときは「今の旅程」を土台にする）。例はすべての項目を含んだ完全な旅程で、検査に通ることをテストで保証している。項目の意味は以下と「決め方」に書いてある

スキーマに無い項目は 1 つも足せない（すべて strict）。スキーマからは読み取れない意味を以下に書く。

`spec.modules` はしおりのページ。`kind` ごとに表示する `document` の場所が決まっている。**`spec.navigation` に `id` を入れたモジュールだけがタブとして表示される**（並び順もここ）。希望に合うものだけ選ぶ。

| `kind` | 表示するもの | 使うとき |
|---|---|---|
| `day-timeline` | `document.items` を日付ごとに、**配列に書いた順のまま**（画面は並べ替えない）。発行後に「編集」で時刻を変えた予定は Host が時刻の合う位置へ移し、ドラッグで動かした予定は前後に合う時刻に変える | 日ごとの予定がある旅行。ほぼ常に入れる |
| `places` | `document.items` のうち `place` を持つものの一覧（`groupBy` は `area` / `category`、省略可） | 行き先が複数ある |
| `suggestion-board` | `document.suggestions`（候補）と `document.comments`（相談） | まだ決まっていないことを皆で出し合う |
| `checklist` | `document.checklist`。`mode` は `shared` のみ | 準備や持ち物がある |
| `budget` | `document.budget`（概算。精算の記録ではない）。`currency` は `JPY` のみ | 費用の目安を共有したい |
| `notes` | `document.notes`（1 つの文章） | 集合の約束、注意事項 |
| `reflection` | `document.reflections`（旅行後の思い出） | 旅行後に振り返りたい。初期値は空配列 |
| `trip-map` | 足あとのページ。メンバーはこのページの「ここにいる」で足あとを残し、地図の下の一覧で見て消す。足あとを点で出し、`showTrack` なら同じメンバーの点を時刻の順に線で結ぶ。線は点を結んだもので、実際に通った道ではない。`showPhotos` は使わない（書かない） | 旅行中に足あとを残す |
| `story` | 日ごとに予定と、足あとから求めた実際の時刻（予定 12:00 / 記録 13:02）、予定になかったところ。旅行後に開くと最初に出る | ほぼ常に入れる |

- `spec.theme.preset`: `paper`（生成りの紙、既定）/ `postcard`（暖色の背景）/ `minimal`（白い背景）/ `night`（暗い配色。差し色も固定になる）。`accent` は差し色で、`#` + 16 進 6 桁
- `spec.exports`: `markdown` / `json` / `ics` / `html`。迷ったら 4 つとも
- `spec.collaboration`: 参加者（オーナー・編集者以外）に候補の投稿・相談・準備リストのチェックを許すか。迷ったら 3 つとも `true`
- `spec.presentation`（省略可）: 表紙の短い文言（`kicker`、`postcardLabel`、`postcardCaption`）、日ごとの見出し `dayHeadings`、顔ぶれ `travelers`。`travelers[].name` はニックネーム
- `document.items[]`: `kind` は `transport` / `stay` / `activity` / `meal` / `note`、`status` は決まっていれば `confirmed`、案なら `proposed`。`revision` は 1
- `document.items[].place.publicUrl`: 公開されている `https:` の URL だけ（店や施設の公式ページ、地図）。ログインが要る URL、予約の管理 URL は入れない
- `document.items[].place.lat` / `place.lng`: 場所の緯度・経度（十進の度、WGS84。例 `35.6586` / `139.7454`）。**両方そろえて**書く。場所が 1 か所に決まり、位置に自信があるときだけ付け、分からなければ付けない（推測で付けない）。足あとの地図に予定の印として出る
- `document.revision` は 1。使わない配列は `[]`、`notes` は空でも `""` を入れる（省略不可）

## 決め方

- `spec.timezone`: 行き先の IANA 名（国内なら `Asia/Tokyo`）。旅行中に時間帯が変わる予定だけ `items[].timezone` で上書きする
- `spec.trip.startsOn` / `endsOn`: `YYYY-MM-DD`。期間は 180 日以内
- `items[].day` は `startsOn` 〜 `endsOn` の範囲内。`startsAt` は**必ず書く**。**オフセットつき**（`2026-11-21T10:30:00+09:00`）で、その時刻を `timezone` の現地日付に直したものが `day` と一致すること。時刻が決まっていない予定は、前後の予定から妥当な時刻（前の予定が終わるころ）を置き、`"timeTentative": true` を付ける（画面では「10:30 ごろ」と出て、決まった時刻ではないと分かる）。`startsAt` の無い予定は検査で弾かれる
- `endsAt` は `startsAt` 以降
- `items` は日付順、同じ日の中は `startsAt` の早い順に並べる（画面は配列の順に表示する）
- `spec.lifecycle.purgeAt`（全データを消す時刻）: **`endsOn` の 30 日後**の `T00:00:00` + オフセット。`endsOn` より後で、かつ**作成日から 180 日以内**でなければならない。旅行が先すぎて 180 日に収まらないなら、作らずに利用者へそう伝える
- `spec.lifecycle.reflectionDays`: 既定 7（旅行後に思い出を追記できる日数。0〜30）
- `spec.locale`: 希望の文章が日本語なら `ja`、英語なら `en`
- ID（`modules[].id`、`items[].id`、`checklist[].id` …）は英数字と `_` `-` だけ。同じ配列の中で重複させない。`navigation` は `modules[].id` だけを、重複なく
- 上限（スキーマにもある）: 文字列は短いもの 160 字・文章 4,000 字、`modules` 12、`items` 300、`checklist` 200、`budget` 100、`destinations` 30、`travelers` 50、全体で 2 MiB
- 希望に書かれていないことを事実のように作らない（架空の店名、決まったかのような時刻や金額）。仮に置いた時刻には `timeTentative: true` を付ける。決まっていないことは `suggestions` か `status: "proposed"` にする
- `suggestions[]` / `comments[]` を初期値として入れるなら `author` はニックネーム、`createdAt` は作成時刻。`promoted: false` は `suggestions[]` だけに付ける（`itemId` は Host が付ける。生成では書かない）（`comments[]` にその項目は無く、付けると検査で弾かれる）

## 入れてはいけない情報

しおりは URL を知っている人が開ける。次のものは、**希望の文章に書かれていても出力のどこにも入れない**（`notes`、`description`、`title`、`publicUrl` を含む）。伏せ字や一部だけにして残すこともしない。

- パスポート、運転免許証などの本人確認書類の番号や画像、クレジットカード情報
- 航空券や入場券の QR / バーコード
- 予約番号・確認番号など予約の変更や取消に使える番号、予約の管理に使える秘密の URL
- 自宅の住所、鍵の受け渡し方法、部屋やロッカーの暗証番号、健康情報
- API キー、パスワード、会員 ID とパスワードの組
- 本名のフルネーム、電話番号、メールアドレス（顔ぶれはニックネームで書く）

予定そのものは入れてよい（「10:30 発の便に乗る」「宿にチェックイン」）。番号や鍵の情報だけを落とす。
**入れなかったものがあれば、種類を挙げて利用者に伝える**（「予約番号とパスポート番号は入れていません。手元で管理してください」）。番号そのものは報告にも書かない。
この検査は機械ではしていない。`bun run validate` が通っても、ここに挙げた情報が入っていないことの証明にはならない。

## 検査と直し方

チャットで作っている場合は、この節の代わりに**利用者が画面に貼り戻し**、しおりの画面が同じ検査をして結果を見せる。直すべき点は日本語で表示されるので、それを伝えてもらって直す。

手元にファイルとして持っている場合は次のコマンドで検査する。

```bash
bun run validate <file>
```

発行はされない。結果は標準出力の JSON と exit code。

- `{"ok": true, "title", "purgeAt", "items", "sha256"}`・exit 0: 完了。`sha256` は発行するときに人が承認するハッシュなので、報告に含める
- `{"ok": false, "errors": [{"path", "message"}]}`・exit 1: `path`（例 `spec.theme.accent`、`document.items.0.startsAt`。`document.items.N.startsAt` に「開始時刻を書いてください」と出たら、その予定に時刻が無い）の項目を直して、もう一度実行する。`path` が `spec` や空のものは、項目どうしの関係の誤り（日付の順序、期間外の `day`、`day` と `startsAt` の現地日付のずれ、ID の重複、`navigation` にモジュールに無い `id`、`purgeAt` が 180 日より先）。`message` を読む
- **3 回直しても通らなければ止めて**、最後の `errors` をそのまま利用者に報告する。検査を通すために予定を消したり日付を変えたりしない

通ったあと、人が `bun run dev` の最初の画面の「ファイルから取り込む」で preview し、内容を確認してから発行する（README「開発・配置・旅行発行は別操作」）。エージェントは発行しない。

## 例

架空の旅行。形の参考で、文言や構成をなぞる必要はない。

```json
{
  "schemaVersion": 1,
  "spec": {
    "schemaVersion": 1,
    "kind": "trip",
    "title": "灯台岬 秋のひとやすみ",
    "summary": "海ぞいの町で、歩いて食べて、なにもしない二泊三日。",
    "locale": "ja",
    "timezone": "Asia/Tokyo",
    "trip": { "startsOn": "2026-11-21", "endsOn": "2026-11-23", "destinations": ["みなと町", "灯台岬"] },
    "modules": [
      { "id": "days", "kind": "day-timeline", "label": "旅程" },
      { "id": "places", "kind": "places", "label": "行くところ" },
      { "id": "ideas", "kind": "suggestion-board", "label": "候補・相談" },
      { "id": "check", "kind": "checklist", "label": "準備", "mode": "shared" },
      { "id": "budget", "kind": "budget", "label": "費用の目安", "currency": "JPY" },
      { "id": "notes", "kind": "notes", "label": "旅のメモ" },
      { "id": "memories", "kind": "reflection", "label": "思い出" }
    ],
    "navigation": ["days", "places", "ideas", "check", "budget", "notes", "memories"],
    "theme": { "preset": "paper", "accent": "#2f6f8f" },
    "collaboration": { "participantSuggestions": true, "participantComments": true, "participantChecklist": true },
    "lifecycle": { "reflectionDays": 7, "purgeAt": "2026-12-23T00:00:00+09:00" },
    "exports": ["markdown", "json", "ics", "html"],
    "presentation": {
      "kicker": "AUTUMN BY THE SEA",
      "postcardLabel": "灯台岬より",
      "postcardCaption": "風の強い日は、早めに宿へ。",
      "dayHeadings": [
        { "day": "2026-11-21", "title": "着いたら、まず海へ" },
        { "day": "2026-11-22", "title": "岬まで歩く日" },
        { "day": "2026-11-23", "title": "おみやげと帰り道" }
      ],
      "travelers": [{ "name": "あお", "note": "幹事" }, { "name": "みどり" }, { "name": "きいろ", "note": "二日目から合流" }]
    }
  },
  "document": {
    "revision": 1,
    "items": [
      { "id": "meet", "kind": "transport", "status": "confirmed", "title": "みなと町駅に集合", "day": "2026-11-21", "startsAt": "2026-11-21T13:00:00+09:00", "place": { "label": "みなと町駅 改札前", "lat": 35.1, "lng": 139.6 }, "revision": 1 },
      { "id": "stay", "kind": "stay", "status": "confirmed", "title": "宿にチェックイン", "day": "2026-11-21", "startsAt": "2026-11-21T16:00:00+09:00", "place": { "label": "岬の宿", "lat": 35.05, "lng": 139.62 }, "description": "夕食は宿で 18:30 から。", "revision": 1 },
      { "id": "walk", "kind": "activity", "status": "confirmed", "title": "灯台まで海ぞいを歩く", "day": "2026-11-22", "startsAt": "2026-11-22T09:30:00+09:00", "endsAt": "2026-11-22T12:00:00+09:00", "place": { "label": "灯台岬", "lat": 35.03, "lng": 139.65 }, "tags": ["歩きやすい靴"], "revision": 1 },
      { "id": "lunch", "kind": "meal", "status": "proposed", "title": "お昼は港の食堂で（店は未定）", "day": "2026-11-22", "startsAt": "2026-11-22T12:00:00+09:00", "timeTentative": true, "revision": 1 },
      { "id": "home", "kind": "transport", "status": "proposed", "title": "夕方の列車で帰る", "day": "2026-11-23", "startsAt": "2026-11-23T17:00:00+09:00", "timeTentative": true, "revision": 1 }
    ],
    "suggestions": [
      { "id": "s1", "author": "みどり", "body": "二日目の夜、港で星を見たい。", "createdAt": "2026-10-20T21:00:00+09:00", "promoted": false }
    ],
    "checklist": [
      { "id": "c1", "title": "帰りの列車の時刻を決める", "done": false },
      { "id": "c2", "title": "歩きやすい靴と上着", "done": false }
    ],
    "comments": [
      { "id": "m1", "author": "あお", "body": "お昼の店、行ったことがある人がいたら教えて。", "createdAt": "2026-10-20T21:05:00+09:00" }
    ],
    "reflections": [],
    "notes": "表示名はニックネームで。予約番号や本人確認書類、秘密のURLはここに書かないでください。",
    "budget": [
      { "id": "b1", "title": "宿（二泊・一人あたり）", "amount": 24000, "description": "夕朝食つきの目安。" }
    ]
  }
}
```
