import { expect, test } from "bun:test";
import { revisable, reviseText, merge, settle, diff, reviseTrip, undoTrip, PASTE_LIMIT } from "./revise";
import { CloudHost } from "./cloud-host";
import { LocalD1 } from "./local-d1";
import { validate } from "./schema";
import { recipe } from "./recipe";
import { testTrip } from "./test-fixture";

// The copy goes outside the host: candidates and talk carry their words, never their authors.
test("the trip handed to a chat carries candidates and talk by their words only, without who wrote them", () => {
  const { spec, document } = testTrip();
  document.suggestions.push({ id: "s1", author: "みどり", body: "夜は星を見たい", createdAt: "2026-09-20T00:00:00+09:00", promoted: false });
  document.comments.push({ id: "m1", author: "あお", body: "店はどこ？", createdAt: "2026-09-20T00:00:00+09:00" });
  document.reflections.push({ id: "r1", author: "きいろ", body: "楽しかった", createdAt: "2026-09-27T00:00:00+09:00", included: true });
  document.revision = 2;
  const copied = revisable(spec, document);
  expect(copied).toEqual({ schemaVersion: 1, spec, document: { items: document.items, checklist: document.checklist, notes: document.notes, budget: document.budget, suggestions: [{ id: "s1", body: "夜は星を見たい", promoted: false }], comments: [{ id: "m1", body: "店はどこ？" }] } });
  const text = JSON.stringify(copied);
  for (const word of ["みどり", "あお", "createdAt", "きいろ", "楽しかった", "revision\":2"]) expect(text).not.toContain(word);
});

test("the text to copy is the recipe without its example, followed by the trip as it stands on one line", () => {
  const { spec, document } = testTrip(), text = reviseText(spec, document);
  expect(text.startsWith(recipe.withoutExample)).toBe(true);
  expect(recipe.text.startsWith(recipe.withoutExample)).toBe(true); expect(recipe.text).toContain("\n## 例"); expect(text).not.toContain("\n## 例");
  expect(text).toContain("例は省いています。この旅程を土台にしてください。");
  expect(text.split("## 今の旅程")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!).not.toContain("\n");
  const trip = JSON.parse(text.split("## 今の旅程")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!);
  expect(trip).toEqual(revisable(spec, document));
  expect(trip.document.items.map((i: { id: string }) => i.id)).toEqual(["arrival", "dinner", "walk"]);
});

// A real trip is long: the copy must stay well under what chats take in one message (one cut at about 20,000 characters, #306).
// The recipe and the new trip's pages grow with each module (the story page, #543, took it past 15,000).
test("a trip of 18 items and 10 things to prepare is copied in under 16,000 characters", () => {
  const { spec, document } = testTrip(), days = ["2026-09-24", "2026-09-25", "2026-09-26"];
  document.items = Array.from({ length: 18 }, (_, k) => ({ id: `item-${k}`, kind: "activity" as const, status: "confirmed" as const, title: `架空の予定 その${k + 1}（行き先と集合の目安）`, day: days[k % 3]!, startsAt: `${days[k % 3]}T${String(9 + Math.floor(k / 3)).padStart(2, "0")}:00:00+09:00`, place: { label: `架空の場所 ${k + 1}`, publicUrl: `https://example.com/place/${k + 1}` }, description: "集合までは各自自由。移動は電車で約1時間を目安にし、当日の交通状況で前後する。予約の有無は未確認。".repeat(2), revision: 3 }));
  document.checklist = Array.from({ length: 10 }, (_, k) => ({ id: `c${k + 1}`, title: `架空の準備 その${k + 1}：予約と受取場所を確認する`, done: k < 4 }));
  document.notes = "旅行日程は2泊3日。参加者は架空の4人。営業時間、交通時刻、移動時間は外部で再検証していません。".repeat(3);
  const text = reviseText(spec, document);
  expect(text.length).toBeLessThan(16000);
});

// The trip a chat answered, as the host sees it once checked: its own parts from the answer, the rest from the trip as it stands.
function revised(edit: (trip: ReturnType<typeof revisable>) => void, current = testTrip()) {
  current.document.suggestions.push({ id: "s1", author: "みどり", body: "夜は星を見たい", createdAt: "2026-09-20T00:00:00+09:00", promoted: false });
  current.document.checklist[0]!.done = true; current.document.revision = 5;
  const answer = structuredClone(revisable(current.spec, current.document));
  edit(answer);
  const merged = merge(current, JSON.parse(JSON.stringify(answer)), { author: "オーナー", at: "2026-09-16T00:00:00Z" }) as { spec: unknown; document: unknown };
  const checked = validate(merged.spec, merged.document, +new Date("2026-09-16T00:00:00Z"));
  const next = { spec: checked.spec, document: settle(current.document, checked.document) };
  return { current, next, diff: diff(current, next) };
}

test("memories and the version come from the trip as it stands, whatever the answer carries", () => {
  const current = testTrip();
  current.document.reflections.push({ id: "memory", author: "きいろ", body: "楽しかった", createdAt: "2026-09-27T00:00:00Z", included: true });
  current.document.suggestions.push({ id: "s1", author: "みどり", body: "夜は星を見たい", createdAt: "2026-09-20T00:00:00+09:00", promoted: false });
  current.document.revision = 5;
  const answer = { schemaVersion: 1, spec: current.spec, document: { ...revisable(current.spec, current.document).document, suggestions: [], comments: [{ id: "x" }], reflections: [], revision: 1 } };
  const merged = merge(current, answer, { author: "オーナー", at: "2026-09-16T00:00:00Z" }) as { document: Record<string, unknown> };
  expect(merged.document.revision).toBe(5);
  expect(merged.document.reflections).toEqual(current.document.reflections);
  // Anything that is not a trip is handed to check() as it came, to be refused there.
  expect(merge(current, [1], { author: "x", at: "now" })).toEqual([1]);
  expect(merge(current, { spec: {} }, { author: "x", at: "now" })).toEqual({ spec: {} });
});

test("an unchanged answer changes nothing and keeps every version and check", () => {
  const { current, next, diff: d } = revised(() => {});
  expect(next.document).toEqual(current.document);
  expect(d).toEqual({ modules: [], items: [], suggestions: [], comments: [], other: [], large: false });
});

test("items are told apart by id: added, changed field by field, removed; versions follow", () => {
  const { next, diff: d } = revised(t => {
    const items = t.document.items;
    items[1] = { ...items[1]!, startsAt: "2026-09-25T18:30:00+09:00", place: { label: "港の食堂" } };
    items.splice(2, 1);
    items.push({ id: "museum", kind: "activity", status: "proposed", title: "美術館", day: "2026-09-26", revision: 1 });
    // Key order and a stale version in the answer are not changes.
    items[0] = Object.fromEntries(Object.entries(items[0]!).reverse()) as typeof items[0];
    items[0]!.revision = 9;
  });
  expect(d.items).toEqual([
    { change: "changed", id: "dinner", title: "夕食", fields: [{ field: "開始時刻", before: "2026-09-25T19:00:00+09:00", after: "2026-09-25T18:30:00+09:00" }, { field: "場所", before: "（なし）", after: "港の食堂" }] },
    { change: "added", id: "museum", title: "美術館" },
    { change: "removed", id: "walk", title: "公園の散歩" },
  ]);
  expect(next.document.items.map(i => [i.id, i.revision])).toEqual([["arrival", 1], ["dinner", 2], ["museum", 1]]);
  // 2 of 3 items removed or changed: at least half.
  expect(d.large).toBe(true);
});

test("the checks participants made stay; a new line starts unchecked", () => {
  const { next, diff: d } = revised(t => {
    t.document.checklist[0]!.done = false; t.document.checklist[1]!.done = true;
    t.document.checklist.push({ id: "c4", title: "雨具", done: true });
  });
  expect(next.document.checklist.map(c => [c.id, c.done])).toEqual([["c1", true], ["c2", false], ["c3", false], ["c4", false]]);
  expect(d.other).toEqual(["準備リスト"]);
});

test("title, dates, deadline and pages are shown as before and after; the rest is named", () => {
  const { diff: d } = revised(t => {
    t.spec.title = "テスト旅行 改"; t.spec.trip.endsOn = "2026-09-27"; t.spec.lifecycle.purgeAt = "2026-10-27T00:00:00+09:00";
    t.spec.modules.push({ id: "extra", kind: "notes", label: "持ち物メモ" }); t.spec.navigation.push("extra");
    t.spec.theme.accent = "#123456"; t.document.notes = "集合は改札前"; t.document.budget.push({ id: "b1", title: "宿", amount: 10000, description: "" });
  });
  expect(d).toMatchObject({ title: ["テスト旅行", "テスト旅行 改"], dates: ["2026-09-24〜2026-09-26", "2026-09-24〜2026-09-27"], purgeAt: ["2026-10-26T00:00:00+09:00", "2026-10-27T00:00:00+09:00"], modules: ["持ち物メモ"], items: [] });
  expect(d.other).toEqual(["見た目", "ページの並び", "旅のメモ", "費用メモ"]);
  expect(d.large).toBe(true);
});

test("a large change is a new title or dates, or at least half of the items removed or changed", () => {
  const retitled = revised(t => { t.spec.title = "別の旅"; }).diff;
  expect(retitled.large).toBe(true);
  const one = revised(t => { t.document.items[0]!.title = "駅で集合"; }).diff;
  expect([one.items.length, one.large]).toEqual([1, false]);
  const added = revised(t => { t.document.items.push({ id: "extra", kind: "note", status: "proposed", title: "予備", day: "2026-09-25", revision: 1 }); }).diff;
  expect(added.large).toBe(false);
  const reordered = revised(t => { t.document.items.reverse(); t.document.items.forEach(i => { i.day = "2026-09-26"; delete i.startsAt; }); }).diff;
  expect(reordered.large).toBe(true);
  const moved = revised(t => { const [a, b] = t.document.items; t.document.items[0] = b!; t.document.items[1] = a!; }).diff;
  expect([moved.items, moved.other, moved.large]).toEqual([[], ["予定の並び"], false]);
});

test("half of the items is already large: 2 of 4 changed is, 1 of 4 is not", () => {
  const four = () => { const trip = testTrip(); trip.document.items.push({ id: "extra", kind: "note", status: "proposed", title: "予備", day: "2026-09-25", revision: 1 }); return trip; };
  const two = revised(t => { t.document.items[0]!.title = "駅で集合"; t.document.items.splice(3, 1); }, four()).diff;
  expect([two.items.length, two.large]).toEqual([2, true]);
  const one = revised(t => { t.document.items[0]!.title = "駅で集合"; }, four()).diff;
  expect([one.items.length, one.large]).toEqual([1, false]);
});

test("pages listed in another order are no change: the order shown is navigation's", () => {
  expect(revised(t => { t.spec.modules.reverse(); }).diff).toEqual({ modules: [], items: [], suggestions: [], comments: [], other: [], large: false });
  expect(revised(t => { t.spec.modules[0]!.label = "日程"; }).diff.other).toEqual(["ページの名前・設定"]);
});

test("a time that becomes a placeholder, or decided, is shown as a change of how sure the time is", () => {
  const { diff: d } = revised(t => { t.document.items[0] = { ...t.document.items[0]!, timeTentative: true }; t.document.items[2] = { ...t.document.items[2]!, timeTentative: undefined }; });
  expect(d.items).toEqual([
    { change: "changed", id: "arrival", title: "集合", fields: [{ field: "時刻の確度", before: "決定", after: "仮置き" }] },
    { change: "changed", id: "walk", title: "公園の散歩", fields: [{ field: "時刻の確度", before: "仮置き", after: "決定" }] },
  ]);
  // An item that had no time has no certainty either.
  const timed = testTrip(); delete timed.document.items[2]!.startsAt; delete timed.document.items[2]!.timeTentative;
  expect(revised(t => { t.document.items[2] = { ...t.document.items[2]!, startsAt: "2026-09-26T10:00:00+09:00", timeTentative: true }; }, timed).diff.items).toEqual([
    { change: "changed", id: "walk", title: "公園の散歩", fields: [{ field: "開始時刻", before: "（なし）", after: "2026-09-26T10:00:00+09:00" }, { field: "時刻の確度", before: "（なし）", after: "仮置き" }] },
  ]);
  // No mark and `false` are the same decided time.
  expect(revised(t => { t.document.items[0] = { ...t.document.items[0]!, timeTentative: false }; }).diff.items).toEqual([]);
});


test("candidates and talk are told apart by id: added, changed, removed", () => {
  const current = testTrip();
  const at = "2026-09-16T00:00:00Z";
  current.document.comments = [{ id: "talk", body: "相談前", author: "あお", createdAt: at }, { id: "removed", body: "消す相談", author: "あお", createdAt: at }];
  const { next, diff: d } = revised(t => {
    t.document.suggestions[0]!.body = "夜は月を見たい"; t.document.suggestions[0]!.promoted = true;
    t.document.suggestions.push({ id: "new", body: "新しい候補", promoted: false });
    t.document.comments = [{ id: "talk", body: "相談後" }, { id: "new-talk", body: "新しい相談" }];
  }, current);
  expect(d.suggestions).toEqual([
    { change: "changed", id: "s1", title: "夜は星を見たい", fields: [{ field: "本文", before: "夜は星を見たい", after: "夜は月を見たい" }, { field: "旅程に追加済み", before: "いいえ", after: "はい" }] },
    { change: "added", id: "new", title: "新しい候補" },
  ]);
  expect(d.comments).toEqual([
    { change: "changed", id: "talk", title: "相談前", fields: [{ field: "本文", before: "相談前", after: "相談後" }] },
    { change: "added", id: "new-talk", title: "新しい相談" }, { change: "removed", id: "removed", title: "消す相談" },
  ]);
  expect(next.document.suggestions[0]!.promoted).toBe(true);
});

test("who wrote a post and when come from the host, whatever the answer carries", () => {
  const current = testTrip(), at = "2026-09-16T00:00:00Z";
  current.document.suggestions = [{ id: "old", body: "元", promoted: false, author: "元の人", createdAt: "2026-09-15T00:00:00Z" }];
  const answer = revisable(current.spec, current.document);
  const forged = { ...answer, document: { ...answer.document,
    suggestions: [{ id: "old", body: "更新", promoted: true, author: "偽", createdAt: "偽" }, { id: "new", body: "新", promoted: false, author: "偽", createdAt: "偽" }],
    comments: [{ id: "talk", body: "相談", author: "偽", createdAt: "偽" }] } };
  const merged = merge(current, forged, { author: "編集者", at }) as { document: typeof current.document };
  expect(merged.document.suggestions).toEqual([{ ...current.document.suggestions[0]!, body: "更新", promoted: true }, { id: "new", body: "新", promoted: false, author: "編集者", createdAt: at }]);
  expect(merged.document.comments).toEqual([{ id: "talk", body: "相談", author: "編集者", createdAt: at }]);
  expect((merge(current, { ...answer, document: { ...answer.document, suggestions: [null, 7], comments: "bad" } }, { author: "編集者", at }) as { document: Record<string, unknown> }).document).toMatchObject({ suggestions: [null, 7], comments: "bad" });
});

test("an item moved to the candidates shows as an item removed and a candidate added", () => {
  const { diff: d } = revised(t => { const [item] = t.document.items.splice(0, 1); t.document.suggestions.push({ id: "moved", body: item!.title, promoted: false }); });
  expect(d.items).toEqual([{ change: "removed", id: "arrival", title: "集合" }]);
  expect(d.suggestions).toEqual([{ change: "added", id: "moved", title: "集合" }]);
});

test("changing or removing a post already there is a large change; adding one is not", () => {
  expect(revised(t => { t.document.suggestions = []; }).diff.large).toBe(true);
  expect(revised(t => { t.document.suggestions[0]!.body = "変更"; }).diff.large).toBe(true);
  expect(revised(t => { t.document.suggestions.push({ id: "new", body: "追加", promoted: false }); }).diff.large).toBe(false);
  expect(revised(t => { t.document.comments.push({ id: "new", body: "追加" }); }).diff.large).toBe(false);
  const current = testTrip(); current.document.comments = [{ id: "talk", body: "相談", author: "あお", createdAt: "2026-09-16T00:00:00Z" }];
  expect(revised(t => { t.document.comments = []; }, structuredClone(current)).diff.large).toBe(true);
  expect(revised(t => { t.document.comments[0]!.body = "変更"; }, structuredClone(current)).diff.large).toBe(true);
});

test("coordinates added to a place by a chat show as a change of 場所", () => {
  const { next, diff: d } = revised(t => { t.document.items[1] = { ...t.document.items[1]!, place: { label: "港の食堂", lat: 35.1, lng: 139.6 } }; });
  expect(d.items).toHaveLength(1);
  expect(d.items[0]).toMatchObject({ change: "changed", id: "dinner", fields: [{ field: "場所" }] });
  expect(next.document.items[1]!.place).toEqual({ label: "港の食堂", lat: 35.1, lng: 139.6 });
});

test("a changed coordinate of a place that has them already shows as a change of 場所 with both values", () => {
  const current = testTrip(); current.document.items[1]!.place = { label: "港の食堂", lat: 35.1, lng: 139.6 };
  const { diff: d } = revised(t => { t.document.items[1] = { ...t.document.items[1]!, place: { label: "港の食堂", lat: 35.2, lng: 139.6 } }; }, current);
  expect(d.items).toEqual([{ change: "changed", id: "dinner", title: "夕食", fields: [{ field: "場所", before: "港の食堂 / 35.1 / 139.6", after: "港の食堂 / 35.2 / 139.6" }] }]);
});

// The host and the browser revise and undo with the same functions: what the browser shows for a sealed trip is what the
// host shows for a plain one.
test("reviseTrip and undoTrip match the host", async () => {
  const db = new LocalD1(), at = +new Date("2026-09-16T00:00:00Z"), origin = "https://trip.example";
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "test-key-".repeat(8), CAPSULE_ORIGIN: origin }, () => at, async () => "test");
  try {
    const send = (path: string, method = "GET", body?: unknown, cookie?: string, revision = 1) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const created = await (await send("/v1/publish", "POST", { ...testTrip(), confirm: true })).json() as { id: string; url: string }, base = `/v1/c/${created.id}`;
    const owner = (await send(base + "/sessions", "POST", { secret: new URLSearchParams(new URL(created.url).hash.slice(1)).get("k") })).headers.get("Set-Cookie")!.split(";")[0]!;
    const stored = async () => JSON.parse((await host.store.get(host.digest(created.id)))!.payload!);
    const trip = structuredClone(revisable(testTrip().spec, testTrip().document));
    trip.document.items[1]!.startsAt = "2026-09-25T18:30:00+09:00"; trip.document.suggestions.push({ id: "s-new", body: "星を見る", promoted: false });
    const text = `直しました。\n\n\`\`\`json\n${JSON.stringify(trip)}\n\`\`\``;
    const c = await stored(), by = { author: "オーナー", at: new Date(at).toISOString(), created: c.created, now: at, keepSpec: false };
    const local = reviseTrip({ spec: c.spec, document: c.document }, text, by);
    const shown = await (await send(base + "/revise/check", "POST", { text }, owner)).json();
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    expect(shown).toEqual({ ok: true, diff: local.diff, revision: 1 });
    expect((await send(base + "/revise", "POST", { text, confirm: true }, owner)).status).toBe(200);
    const after = await stored();
    expect(after.document).toEqual({ ...local.next.document, revision: 2 });
    expect(after.spec).toEqual(local.next.spec);
    const back = undoTrip({ spec: after.spec, document: after.document }, after.previous, { created: after.created, keepSpec: false });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(await (await send(base + "/undo", "GET", undefined, owner, 2)).json()).toEqual({ diff: back.diff, revision: 2 });
    expect(undoTrip({ spec: after.spec, document: after.document }, undefined, { created: after.created, keepSpec: false })).toEqual({ ok: false, reason: "none" });
    // The paste's own rules, before anything reaches the host: https only, 4000 characters a text, 200,000 bytes in all.
    const refused = (edit: (t: typeof trip) => void) => { const t = structuredClone(trip); edit(t); return reviseTrip({ spec: c.spec, document: c.document }, JSON.stringify(t), by); };
    expect(refused(t => { t.document.items[0]!.place = { label: "駅", publicUrl: "http://example.com/" }; })).toMatchObject({ ok: false, messages: [expect.stringContaining("公開HTTPS URLのみ使用できます")] });
    expect(refused(t => { t.document.items[0]!.description = "あ".repeat(4001); })).toEqual({ ok: false, messages: ["1 つめの予定の説明: 4000 文字以内で指定してください"] });
    expect(reviseTrip({ spec: c.spec, document: c.document }, "x".repeat(PASTE_LIMIT + 1), by)).toEqual({ ok: false, tooLong: true });
    expect(PASTE_LIMIT).toBe(200_000);
  } finally { db.close(); }
});
test("revise runs in the browser", async () => {
  const built = await Bun.build({ entrypoints: ["src/revise.ts", "src/schema.ts"], target: "browser" });
  expect(built.success).toBe(true);
  for (const out of built.outputs) expect((await out.text()).includes("node:")).toBe(false);
});
