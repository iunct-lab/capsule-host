import { describe, expect, test } from "bun:test";
import { explain, extract } from "./paste";
import { testTrip } from "./test-fixture";
import { check } from "./validate";

const trip = JSON.stringify({ schemaVersion: 1, ...testTrip() }, null, 2);
const taken = (text: string) => { const r = extract(text); if (!r.ok) throw new Error(`expected a trip, got ${r.reason}`); return r.value; };
const refused = (text: string) => { const r = extract(text); if (r.ok) throw new Error("expected a refusal"); return r.reason; };

describe("taking the trip out of a chat answer", () => {
  test("the answer as the person pasted it, in the shapes an assistant sends", () => {
    for (const text of [
      trip,
      "```json\n" + trip + "\n```",
      "```\n" + trip + "\n```",
      `承知しました。ご希望の旅程です。\n\n\`\`\`json\n${trip}\n\`\`\`\n\nいかがでしょうか。気になる点があれば直します。`,
      `はい、作りました！\n${trip}\n上の内容でよければお使いください。`,
      `   \n\n${trip}\n\n   `,
    ]) expect(taken(text)).toEqual(JSON.parse(trip));
  });

  test("what comes out is what the host checks, so a pasted answer can be published", () => {
    const value = taken("説明です\n```json\n" + trip + "\n```");
    expect(check(value, +new Date("2026-09-01T00:00:00Z"))).toMatchObject({ ok: true, title: "テスト旅行" });
  });

  test("braces inside strings do not end the trip early", () => {
    const withBraces = structuredClone(testTrip());
    withBraces.document.notes = 'メモ {「終わり」} と "引用" と \\ 記号';
    const text = `どうぞ\n${JSON.stringify({ schemaVersion: 1, ...withBraces })}\nご確認ください`;
    expect((taken(text) as { document: { notes: string } }).document.notes).toBe(withBraces.document.notes);
  });

  test("an example quoted in the prose does not compete with the fenced answer", () => {
    const text = `ポイントは \`{"kind": "trip"}\` の部分です。全体はこちら:\n\n\`\`\`json\n${trip}\n\`\`\`\n\n{"補足": "この行も JSON に見えます"}`;
    expect(taken(text)).toEqual(JSON.parse(trip));
  });

  test("two separate trips are refused rather than guessed at", () => {
    expect(refused(`1 案目\n${trip}\n2 案目\n${trip}`)).toBe("many");
    expect(refused("```json\n" + trip + "\n```\nもう一案:\n```json\n" + trip + "\n```")).toBe("many");
  });

  test("nothing to take is told apart from something that is not a trip", () => {
    expect(refused("")).toBe("empty");
    expect(refused("   \n\t  ")).toBe("empty");
    expect(refused("すみません、旅程は作れませんでした。")).toBe("not-json");
    expect(refused("{ 旅程: これは JSON ではありません }")).toBe("not-json");
    expect(refused("```json\n{ \"spec\": \n```")).toBe("cut-off"); // the fence closed before the object did
  });

  test("an answer that was cut off says so, instead of using a fragment of it", () => {
    expect(refused(`{"result": ${trip}`)).toBe("cut-off");
    expect(refused(`はい、作りました！\n${trip.slice(0, trip.length - 40)}`)).toBe("cut-off");
    // Whatever was complete before the cut is still usable.
    expect(taken(`${trip}\n続きです: {"memo": `)).toEqual(JSON.parse(trip));
  });

  test("a fence that the trip's own text closes early does not lose the trip", () => {
    const withFence = structuredClone(testTrip());
    withFence.document.notes = "コードは ``` で囲みます";
    const text = "```json\n" + JSON.stringify({ schemaVersion: 1, ...withFence }, null, 2) + "\n```";
    expect((taken(text) as { document: { notes: string } }).document.notes).toBe(withFence.document.notes);
  });

  test("an answer full of opening braces is refused quickly, not scanned again and again", () => {
    const started = performance.now();
    expect(refused("{".repeat(40_000))).toBe("cut-off");
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a trip nested in the answer's own wrapper is still found", () => {
    // Some assistants answer {"result": {...}}; the host checks what it finds, and check() will say what is missing.
    const wrapped = `{"result": ${trip}}`;
    expect(taken(wrapped)).toEqual({ result: JSON.parse(trip) });
  });
});

describe("saying what is wrong in a way a person can act on", () => {
  test("each place is named in Japanese, with the reason kept", () => {
    expect(explain([{ path: "spec.trip.endsOn", message: "実在する日付を指定してください" }]))
      .toEqual(["旅行の最終日: 実在する日付を指定してください"]);
    expect(explain([{ path: "spec.title", message: "必須です" }])[0]).toBe("旅行の題: 必須です");
    expect(explain([{ path: "spec.lifecycle.purgeAt", message: "x" }])[0]!.startsWith("自動削除の日時: ")).toBe(true);
    expect(explain([{ path: "document.items.3.startsAt", message: "x" }])[0]!.startsWith("4 つめの予定の開始時刻: ")).toBe(true);
    expect(explain([{ path: "document.checklist.0.title", message: "x" }])[0]!.startsWith("1 つめの準備リストの題: ")).toBe(true);
    expect(explain([{ path: "document.checklist.0", message: "不明な項目です" }])[0]).toBe("1 つめの準備リスト: 不明な項目です");
  });

  test("a place's latitude out of range is named in Japanese", () => {
    expect(explain([{ path: "document.items.0.place.lat", message: "Number must be less than or equal to 90" }])[0]).toBe("1 つめの予定の場所の緯度: 90 以下で指定してください");
    expect(explain([{ path: "document.items.1.place.lng", message: "Number must be greater than or equal to -180" }])[0]).toBe("2 つめの予定の場所の経度: -180 以上で指定してください");
    expect(explain([{ path: "document.items.0.place", message: "緯度と経度は両方そろえてください" }])[0]).toBe("1 つめの予定の場所: 緯度と経度は両方そろえてください");
  });

  test("the schema's own English wording is put into Japanese", () => {
    const cases: Array<[string, string]> = [
      ["Required", "指定してください"],
      ["Invalid", "形式が正しくありません"],
      ["Invalid url", "URL の形式が正しくありません"],
      ["String must contain at least 1 character(s)", "1 文字以上で指定してください"],
      ["Array must contain at most 12 element(s)", "12 件以内にしてください"],
      ["Expected number, received string", "number で指定してください（いまは string）"],
      ["Unrecognized key(s) in object: 'extra'", "知らない項目があります: 'extra'"],
    ];
    for (const [english, japanese] of cases) expect(explain([{ path: "spec.title", message: english }])[0]).toBe(`旅行の題: ${japanese}`);
    // A message the schema wrote itself is already Japanese and must come through untouched.
    expect(explain([{ path: "", message: "旅行期間と削除期限の順序が不正です" }])[0]).toBe("旅程全体: 旅行期間と削除期限の順序が不正です");
    // Anything unrecognised is shown as it came rather than swallowed.
    expect(explain([{ path: "spec.title", message: "Some new zod wording" }])[0]).toBe("旅行の題: Some new zod wording");
  });

  test("a place with no translation is shown as it is, never hidden", () => {
    expect(explain([{ path: "spec.presentation.dayHeadings.2.title", message: "x" }])[0]).toContain("spec.presentation.dayHeadings.2.title");
    expect(explain([{ path: "", message: "旅程の日付・時刻が旅行期間と一致しません" }])[0]).toBe("旅程全体: 旅程の日付・時刻が旅行期間と一致しません");
  });

  test("the real errors of a broken trip come back as sentences", () => {
    const broken = structuredClone(testTrip());
    broken.spec.trip.endsOn = "2026-09-23";
    const result = check(broken, +new Date("2026-09-01T00:00:00Z"));
    expect(result.ok).toBe(false);
    const messages = explain(result.ok ? [] : result.errors);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("旅行期間と削除期限の順序が不正です");
  });
});

test("an item without a time is named by its place in the plan", () => {
  const trip = testTrip(); delete trip.document.items[1]!.startsAt;
  const r = check(trip, +new Date("2026-09-01T00:00:00Z"));
  expect(r.ok ? [] : explain(r.errors)).toEqual(["2 つめの予定の開始時刻: 開始時刻を書いてください（決まっていなければ妥当な時刻と timeTentative: true）"]);
});
