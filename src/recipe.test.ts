import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { specSchema } from "./schema";
import { extract } from "./paste";
import { check } from "./validate";

// docs/recipes/trip.md is what a generating agent is given. It must not drift from the schema it describes.
const recipe = await readFile(`${import.meta.dir}/../docs/recipes/trip.md`, "utf8");
const section = (title: string) => recipe.split(/^## /m).find(s => s.startsWith(title)) ?? "";

test("the example in the recipe passes the check", () => {
  const example = section("例").match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(example).toBeDefined();
  const spec = JSON.parse(example!).spec;
  expect(check(example, +new Date(spec.trip.startsOn) - 30 * 86400000)).toMatchObject({ ok: true, title: spec.title });
  // The example shows every list an agent may fill, and lists items the way the recipe says to (the screen does not sort).
  const { items, suggestions, comments } = JSON.parse(example!).document;
  expect(suggestions.length && comments.length).toBeTruthy();
  const days = items.map((i: { day: string }) => i.day), timed = items.flatMap((i: { startsAt?: string }) => i.startsAt ? [+new Date(i.startsAt)] : []);
  expect(days).toEqual([...days].sort()); expect(timed).toEqual([...timed].sort((a, b) => a - b));
});

test("promoted belongs to suggestions only, as the recipe says", () => {
  const trip = JSON.parse(section("例").match(/```json\n([\s\S]*?)\n```/)![1]!);
  trip.document.comments[0].promoted = false;
  const result = check(trip, +new Date(trip.spec.trip.startsOn) - 30 * 86400000);
  expect(result.ok ? [] : result.errors.map(e => e.path)).toEqual(["document.comments.0"]);
  expect(section("決め方")).toContain("`suggestions[]` だけ");
});

test("the recipe names every module kind, theme preset and export the schema accepts", () => {
  const shape = specSchema.innerType().shape;
  const words = [...shape.modules.element.options.map(o => o.shape.kind.value), ...shape.theme.shape.preset.options, ...shape.exports.element.options];
  expect(words.length).toBeGreaterThanOrEqual(7 + 4 + 4);
  expect(words.filter(w => !section("構造").includes(`\`${w}\``))).toEqual([]);
});

test("the recipe lists what must not be stored (spec §1.4)", () => {
  const forbidden = section("入れてはいけない情報");
  for (const word of ["パスポート", "クレジットカード", "予約", "QR", "住所", "パスワード"]) expect(forbidden).toContain(word);
});

test("the rules the recipe gives a chat assistant are the ones the host enforces", () => {
  const output = section("出力");
  // Each rule exists because extract() refuses the opposite; if a refusal is dropped, its sentence should go too.
  expect(output).toContain("旅程は 1 つだけ");
  expect(extract("{\"a\":1}\n{\"b\":2}")).toEqual({ ok: false, reason: "many" });
  expect(output).toContain("途中で切らず");
  expect(extract('{"a": ')).toEqual({ ok: false, reason: "cut-off" });
  expect(output).toContain("前後に説明の文が付いていても");
  expect(extract('どうぞ\n{"a":1}\nご確認ください')).toEqual({ ok: true, value: { a: 1 } });
});

test("the recipe says how to revise a trip handed back with it (PBI #133)", () => {
  const revise = section("直すとき");
  expect(revise).toContain("今の旅程");
  // The host tells changed items from added and removed ones by id, and refuses a trip that drops a page.
  expect(revise).toContain("`id` は保つ");
  expect(revise).toContain("`spec.modules`）は消さない");
  expect(revise).toContain("全体を 1 つ");
});

test("the recipe tells how to give a place its latitude and longitude, and its example has them", () => {
  expect(recipe).toContain("place.lat");
  expect(recipe).toContain("推測で付けない");
  const items = JSON.parse(section("例").match(/```json\n([\s\S]*?)\n```/)![1]!).document.items as Array<{ place?: { lat?: number; lng?: number } }>;
  expect(items.filter(i => i.place?.lat !== undefined && i.place.lng !== undefined).length).toBeGreaterThanOrEqual(3);
});
