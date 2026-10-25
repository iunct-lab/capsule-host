import { expect, test } from "bun:test";
import { privateReviseText, takePrivate, privateDiff } from "./private-revise";
import type { PlainEntry } from "./private-entries";
import { testTrip } from "./test-fixture";

const { spec, document } = testTrip();
const mine: PlainEntry[] = [
  { id: "p1", kind: "item", day: "2026-09-25", startsAt: "2026-09-25T08:00:00+09:00", title: "朝の目印ランニング", body: "" },
  { id: "d1", kind: "diary", day: "2026-09-25", title: "", body: "目印の日記" },
];
const answer = (entries: unknown[]) => `直しました。\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, entries })}\n\`\`\`\n\n1 件足しました。`;

// What is copied goes to a chat outside the host: this seat's own entries, and the shared plan as a reference only.
test("the text to copy holds the recipe, the trip's dates and zone, the shared plan as a reference and this seat's entries", () => {
  const text = privateReviseText(spec, document, mine);
  expect(text).toStartWith("# Recipe: 自分だけの予定・日記");
  expect(text).toContain("- 期間: 2026-09-24〜2026-09-26\n- 時間帯: Asia/Tokyo");
  const [before, own] = text.split("## 自分の予定・日記\n");
  // The shared items by day, time and title, under their own heading, said not to be answered; none in this seat's JSON.
  const reference = before!.slice(before!.indexOf("## 共有の予定（参照）"));
  expect(reference).toContain("直しても反映されません"); expect(reference).toContain("- 2026-09-24 13:15 集合"); expect(reference).toContain("- 2026-09-25 19:00 夕食");
  expect(own).not.toContain("集合"); expect(own).not.toContain("夕食");
  expect(own).toContain(JSON.stringify({ schemaVersion: 1, entries: mine }));
  expect(text.match(/目印/g)).toHaveLength(2);
  // An item with a zone of its own is listed at its own clock.
  const abroad = { ...document, items: [{ ...document.items[0]!, timezone: "Europe/Paris" }] };
  expect(privateReviseText(spec, abroad, [])).toContain("- 2026-09-24 06:15 集合");
  // Another member's entries are never handed in, so they cannot be in it; nor are the shared trip's posts.
  document.suggestions.push({ id: "s1", author: "みどり", body: "他人の目印", createdAt: "2026-09-20T00:00:00+09:00", promoted: false });
  expect(privateReviseText(spec, document, mine)).not.toContain("他人の目印");
  expect(privateReviseText(spec, document, [])).toContain('{"schemaVersion":1,"entries":[]}');
});

test("an answer is taken out of the prose around it; a new entry gets an id, a known one keeps its own", () => {
  const taken = takePrivate(answer([{ ...mine[0], title: "朝のランニング" }, mine[1], { kind: "item", day: "2026-09-26", startsAt: "2026-09-26T07:00:00+09:00", endsAt: "2026-09-26T08:00:00+09:00", title: "散歩", body: "", place: { label: "公園", publicUrl: "https://example.com/park" } }]), spec);
  if (!taken.ok) throw new Error(taken.messages.join("\n"));
  expect(taken.entries.map(e => e.id).slice(0, 2)).toEqual(["p1", "d1"]);
  expect(taken.entries[2]).toMatchObject({ kind: "item", day: "2026-09-26", title: "散歩", place: { label: "公園", publicUrl: "https://example.com/park" } });
  expect(taken.entries[2]!.id).toMatch(/^[0-9a-f-]{36}$/);
  // Unfenced, as some chats answer.
  expect(takePrivate(`どうぞ ${JSON.stringify({ schemaVersion: 1, entries: [mine[1]] })} 以上です`, spec)).toMatchObject({ ok: true, entries: [mine[1]] });
});

test("what cannot be applied is said with where to fix it", () => {
  const messages = (text: string) => { const r = takePrivate(text, spec); expect(r.ok).toBe(false); return r.ok ? [] : r.messages; };
  expect(messages("")).toEqual(["返事が貼られていません。チャットの答えを貼ってください。"]);
  expect(messages("```json\n{ \"schemaVersion\": 1, \"entries\": [\n```")).toEqual(["答えが途中で切れています。チャットの返事を最後まで貼ってください。"]);
  expect(messages("ごめんなさい、作れませんでした")).toEqual(["自分の予定・日記が見つかりません。チャットの返事を、前後の文ごとそのまま貼ってください。"]);
  expect(messages(answer([{ ...mine[1], day: "2026-09-27" }]))).toEqual(["1 つめの自分の予定・日記の日付: 旅行期間（2026-09-24〜2026-09-26）の日付にしてください"]);
  expect(messages(answer([mine[1], { ...mine[1], id: "d2", day: "2026-09-31" }]))).toEqual(["2 つめの自分の予定・日記の日付: 旅行期間（2026-09-24〜2026-09-26）の日付にしてください"]);
  expect(messages(answer([{ ...mine[0], startsAt: "2026-09-26T08:00:00+09:00" }]))).toEqual(["1 つめの自分の予定・日記の開始時刻: 2026-09-25 の時刻にしてください（時間帯 Asia/Tokyo）"]);
  expect(messages(answer([{ ...mine[0], title: "あ".repeat(161) }]))).toEqual(["1 つめの自分の予定・日記の題: 160 文字以内で指定してください"]);
  expect(messages(answer([{ ...mine[1], body: "あ".repeat(4001) }]))).toEqual(["1 つめの自分の予定・日記の本文: 4000 文字以内で指定してください"]);
  expect(messages(answer(Array.from({ length: 101 }, () => mine[1])))).toEqual(["自分の予定・日記: 100 件以内にしてください"]);
  expect(messages(answer([{ ...mine[0], startsAt: undefined }]))).toEqual(["1 つめの自分の予定・日記の開始時刻: 予定の開始時刻を入れてください"]);
  expect(messages(answer([{ ...mine[1], startsAt: "2026-09-25T08:00:00+09:00" }]))).toEqual(["1 つめの自分の予定・日記の開始時刻: 日記には時刻を書きません"]);
  expect(messages(answer([{ ...mine[1], endsAt: "2026-09-25T08:00:00+09:00" }]))).toEqual(["1 つめの自分の予定・日記の終了時刻: 日記には時刻を書きません"]);
  expect(messages(answer([{ ...mine[0], endsAt: "2026-09-25T07:00:00+09:00" }]))).toEqual(["1 つめの自分の予定・日記の終了時刻: 終了時刻が開始時刻より前です"]);
  expect(messages(answer([{ ...mine[0], place: { label: "" } }]))).toEqual(["1 つめの自分の予定・日記の場所の名前: 1 文字以上で指定してください"]);
  expect(messages(answer([{ ...mine[0], place: { label: "駅", publicUrl: "http://example.com/" } }]))).toEqual(["1 つめの自分の予定・日記の場所の公開URL: 公開HTTPS URLのみ使用できます"]);
  // zod 4 reports a missing choice as a wrong one; it still reads as under zod 3 (#833).
  expect(messages(answer([{ ...mine[1], kind: undefined }]))).toEqual(["1 つめの自分の予定・日記の種類: 指定してください"]);
  expect(messages(answer([{ ...mine[1], kind: "memo" }]))).toEqual(["1 つめの自分の予定・日記の種類: 次のいずれかを指定してください: item | diary"]);
  expect(messages(answer([{ ...mine[0], owner: "x" }]))).toEqual(["1 つめの自分の予定・日記: 知らない項目があります: 'owner'"]);
  expect(messages(answer([mine[1], { ...mine[1], body: "別" }]))).toEqual(["同じ id（d1）の項目が 2 つあります。1 つにしてください。"]);
  expect(messages(JSON.stringify({ schemaVersion: 1, spec, document }))).toContain("旅程全体: 知らない項目があります: 'spec', 'document'");
});

test("the diff says what is added, changed and removed; an entry this browser cannot read is never removed or replaced", () => {
  const next: PlainEntry[] = [{ ...mine[0]!, title: "朝のランニング" }, { id: "new", kind: "diary", day: "2026-09-26", title: "", body: "新しい日記" }];
  const d = privateDiff(mine, next);
  expect(d.changed).toEqual([next[0]!]);
  expect(d.removed).toEqual([mine[1]!]);
  expect(d.added).toHaveLength(1); expect(d.added[0]).toMatchObject({ kind: "diary", body: "新しい日記" }); expect(d.added[0]!.id).not.toBe("new");
  // Unchanged entries are in none of the three, whatever order their keys come in.
  expect(privateDiff(mine, [{ body: "", title: "朝の目印ランニング", startsAt: "2026-09-25T08:00:00+09:00", day: "2026-09-25", kind: "item", id: "p1" }, mine[1]!])).toEqual({ added: [], changed: [], removed: [] });
  // "locked" is an entry this browser could not open: it is not in `current`, so it is not removed, and an answer naming its id
  // adds a new entry instead of writing over it.
  const again = privateDiff(mine, [...mine, { id: "locked", kind: "diary", day: "2026-09-25", title: "", body: "上書き" }]);
  expect(again.removed).toEqual([]); expect(again.changed).toEqual([]); expect(again.added[0]!.id).not.toBe("locked");
});
