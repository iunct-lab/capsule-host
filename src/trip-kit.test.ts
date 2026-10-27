import { expect, test } from "bun:test";
import { Refused } from "./kit";
import { kitOf, kits, DEFAULT_KIND } from "./kits";
import { tripKit } from "./trip-kit";
import { stateOf, validate } from "./schema";
import { testTrip } from "./test-fixture";
import { recipe } from "./recipe";

const now = +new Date("2026-09-01T00:00:00Z");

test("a trip's kit is found by its kind; another kind, or none, finds no kit", () => {
  expect(kitOf({ kind: "trip" })).toBe(tripKit);
  expect(kits[DEFAULT_KIND]).toBe(tripKit);
  for (const spec of [{ kind: "x" }, { kind: "constructor" }, { kind: "__proto__" }, {}, null, "trip", { kind: 1 }]) expect(kitOf(spec)).toBeUndefined();
});

test("the trip kit publishes what validate() takes, and refuses a broken trip and an item without a time with the publisher's sentence", () => {
  const trip = testTrip();
  expect(tripKit.publish(trip.spec, trip.document, now)).toEqual(validate(trip.spec, trip.document, now));
  const refused = (spec: unknown, document: unknown) => { try { tripKit.publish(spec, document, now); } catch (e) { return e; } };
  expect(refused({ ...trip.spec, kind: "x" }, trip.document)).toMatchObject({ status: 400, message: "旅程と期限を確認してください" });
  const untimed = { ...trip.document, items: trip.document.items.map(({ startsAt: _, ...i }) => i) };
  const e = refused(trip.spec, untimed);
  expect(e).toBeInstanceOf(Refused);
  expect((e as Refused).message).toStartWith("開始時刻の無い予定があります");
  // A trip kept with such items (published before the rule) still passes the rules of a kept trip.
  expect(tripKit.validate(trip.spec, untimed, now, false).document.items).toHaveLength(3);
  expect(() => tripKit.validate(trip.spec, trip.document, now, true)).toThrow();
});

test("the trip kit reads the state, the accent, the dates, the items and the export's name from the trip", () => {
  const { spec, document } = testTrip();
  for (const at of [now, +new Date("2026-09-27T00:00:00Z"), +new Date("2026-10-27T00:00:00Z")]) expect(tripKit.stateOf(spec, null, at)).toBe(stateOf(spec, null, at));
  expect(tripKit.stateOf(spec, "frozen", now)).toBe("frozen");
  expect(tripKit.accent(spec)).toBe(spec.theme.accent);
  expect(tripKit.period!(spec)).toEqual({ startsOn: "2026-09-24", endsOn: "2026-09-26", timezone: spec.timezone });
  expect([tripKit.hasItem!(document, "dinner"), tripKit.hasItem!(document, "nothing")]).toEqual([true, false]);
  expect(tripKit.exports!.name(spec)).toBe("trip-2026-09-24.zip");
  expect(tripKit.refusal(spec, { ...spec, modules: spec.modules.slice(1) }, now)).toBe("今あるページは消せません");
  expect(tripKit.refusal(spec, spec, now)).toBeUndefined();
});

test("the trip kit judges a pasted answer as POST /v1/check did, and gives the recipe the host serves", () => {
  const trip = testTrip();
  expect(tripKit.judge(`はい、どうぞ。\n\`\`\`json\n${JSON.stringify(trip)}\n\`\`\``, now)).toMatchObject({ ok: true, title: "テスト旅行", items: 3, trip });
  expect(tripKit.judge("", now)).toEqual({ ok: false, reason: "empty" });
  const wrong = tripKit.judge(JSON.stringify({ ...trip, spec: { ...trip.spec, locale: "fr" } }), now);
  expect(wrong.ok).toBe(false);
  expect(!wrong.ok && wrong.messages?.length).toBeGreaterThan(0);
  expect(tripKit.recipe.text).toBe(recipe.text);
  expect(tripKit.recipe.generate).toStartWith(recipe.text);
});
