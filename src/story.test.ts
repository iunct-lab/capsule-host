import { test, expect } from "bun:test";
import type { Item } from "./schema";
import type { Point } from "./footprints";
import { firstPage, story, type StoryEntry } from "./story";

const day = "2026-09-24", at = (time: string, on = day) => `${on}T${time}:00+09:00`;
const spec = { timezone: "Asia/Tokyo", trip: { startsOn: day, endsOn: "2026-09-25", destinations: ["唐津"] } };
const item = (id: string, time?: string, extra: Partial<Item> = {}): Item => ({ id, title: id, day, kind: "activity", status: "confirmed", revision: 1, ...(time ? { startsAt: at(time) } : {}), ...extra });
// Karatsu castle; 0.009° of latitude is about 1 km.
const point = (id: string, time: string, north = 0, on = day): Point => ({ id, at: at(time, on), lat: 33.4568 + north * 0.009, lng: 129.9768, by: "ゆき" });
const shape = (entries: StoryEntry[] | undefined) => (entries ?? []).map(x => x.kind === "plan" ? `${x.item.id}${x.recorded ? `@${x.recorded.id}` : ""}` : `?${x.point.id}`);

test("story: planned and recorded — the first point in a plan's time is its record", () => {
  const items = [item("karatsu", "11:00"), item("yobuko", "13:00"), item("itoshima", "15:30")];
  const days = story(items, [point("p3", "13:40"), point("p1", "11:20"), point("p2", "13:02")], spec);
  expect([...days.keys()]).toEqual([day]);
  expect(shape(days.get(day))).toEqual(["karatsu@p1", "yobuko@p2", "itoshima"]);
});

test("story: unplanned — a point after the plan's end, 2 km or more from its first point, or before the day's first plan", () => {
  const items = [item("karatsu", "11:00", { endsAt: at("12:00") }), item("yobuko", "13:00"), item("itoshima", "15:30")];
  const points = [
    point("early", "10:15"), point("k1", "11:10"), point("after-end", "12:20"),
    point("y1", "13:05"), point("near", "13:30", 1.9), point("far", "14:00", 2.1), point("i1", "15:40"),
  ];
  const days = story(items, points, spec);
  // 1.9 km from the plan's first point stays the plan's; 2.1 km does not. Each unplanned point goes before the first plan starting later.
  expect(shape(days.get(day))).toEqual(["?early", "karatsu@k1", "?after-end", "yobuko@y1", "?far", "itoshima@i1"]);
  // A point outside the trip is left out; a day with only an unplanned point is there.
  const next = story(items, [point("out", "09:00", 0, "2026-09-26"), point("d2", "09:00", 0, "2026-09-25")], spec);
  expect([...next.keys()]).toEqual([day, "2026-09-25"]);
  expect(shape(next.get("2026-09-25"))).toEqual(["?d2"]);
});

test("story: plan only — a plan without points has no record, a cancelled plan is left out", () => {
  const items = [item("lunch", "12:00"), item("cancelled", "13:00", { status: "cancelled" }), item("untimed"), item("other", "10:00", { day: "2026-09-25", startsAt: at("10:00", "2026-09-25") })];
  const days = story(items, [], spec);
  expect(shape(days.get(day))).toEqual(["lunch", "untimed"]);
  expect(shape(days.get("2026-09-25"))).toEqual(["other"]);
  // A point at 13:10 is the lunch's, not the cancelled plan's.
  expect(shape(story(items, [point("p", "13:10")], spec).get(day))).toEqual(["lunch@p", "untimed"]);
});

test("story: first page — story after the trip, the first of navigation during it", () => {
  const pages = [{ id: "days", kind: "day-timeline" }, { id: "story", kind: "story" }];
  expect(firstPage(pages, "reflection")).toBe("story");
  expect(firstPage(pages, "frozen")).toBe("story");
  expect(firstPage(pages, "active")).toBe("days");
  expect(firstPage(pages, "draft")).toBe("days");
  expect(firstPage([pages[0]!], "reflection")).toBe("days");
});
