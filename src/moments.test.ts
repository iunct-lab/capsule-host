import { test, expect } from "bun:test";
import type { Item } from "./schema";
import { itemAt, linkPhotos, photoDays, photoInstant, photosPageShown, photosUploadable, type Shown } from "./moments";

const day = "2026-09-24", at = (time: string, on = day) => `${on}T${time}:00+09:00`;
const spec = { timezone: "Asia/Tokyo", trip: { startsOn: day, endsOn: "2026-09-25", destinations: ["唐津"] } };
const item = (id: string, time?: string, extra: Partial<Item> = {}): Item => ({ id, title: id, day, kind: "activity", status: "confirmed", revision: 1, ...(time ? { startsAt: at(time) } : {}), ...extra });
const photo = (id: string, time?: string, extra: Partial<Shown> = {}): Shown => ({ id, uploadedAt: at("23:59", "2026-09-25"), width: 2048, height: 1536, thumb: { width: 400, height: 300 }, key: "v1.1.x", mine: false, ...(time ? { capturedAt: at(time) } : {}), ...extra });
const ids = (photos: Shown[] | undefined) => (photos ?? []).map(p => p.id);

test("link: 11:03, 13:02 and 15:41 go under the 11:00, 13:00 and 15:30 items", () => {
  const items = [item("karatsu", "11:00"), item("yobuko", "13:00"), item("itoshima", "15:30")];
  const { byItem, beforeFirst, unlinked } = linkPhotos(items, [photo("p3", "15:41"), photo("p1", "11:03"), photo("p2", "13:02"), photo("p0", "13:00")], spec);
  expect(ids(byItem.get("karatsu"))).toEqual(["p1"]);
  // 13:00 on the dot is the 13:00 item's already.
  expect(ids(byItem.get("yobuko"))).toEqual(["p0", "p2"]);
  expect(ids(byItem.get("itoshima"))).toEqual(["p3"]);
  expect(beforeFirst.size).toBe(0);
  expect(unlinked).toEqual([]);
});

test("link: a cancelled item or one without a time takes no photo", () => {
  const items = [item("lunch", "12:00"), item("cancelled", "13:00", { status: "cancelled" }), item("untimed"), item("same-a", "15:00"), item("same-b", "15:00")];
  const { byItem } = linkPhotos(items, [photo("p1", "13:30"), photo("p2", "15:10")], spec);
  expect(ids(byItem.get("lunch"))).toEqual(["p1"]);
  expect(byItem.has("cancelled")).toBe(false);
  expect(byItem.has("untimed")).toBe(false);
  // Two items starting together: the later one in the itinerary.
  expect(ids(byItem.get("same-b"))).toEqual(["p2"]);
  expect(byItem.has("same-a")).toBe(false);
});

test("link: a photo linked by hand stays with its item when the item's time changes, and goes back to its time when the item is gone", () => {
  const items = [item("karatsu", "11:00"), item("yobuko", "13:00")], hand = photo("p1", "11:03", { itineraryItemId: "yobuko" });
  expect(ids(linkPhotos(items, [hand], spec).byItem.get("yobuko"))).toEqual(["p1"]);
  // The item moved to the next day and was cancelled: the photo stays with it.
  const moved = [items[0]!, item("yobuko", undefined, { day: "2026-09-25", startsAt: at("18:00", "2026-09-25"), status: "cancelled" })];
  expect(ids(linkPhotos(moved, [hand], spec).byItem.get("yobuko"))).toEqual(["p1"]);
  // The item is gone (removed, and the host has not cleared the link yet): its time decides again.
  const gone = linkPhotos([items[0]!], [hand], spec);
  expect(ids(gone.byItem.get("karatsu"))).toEqual(["p1"]);
  expect(gone.byItem.has("yobuko")).toBe(false);
});

test("unlinked: before the day's first item, without a time, and outside the trip", () => {
  const items = [item("karatsu", "11:00"), item("dinner", "19:00", { day: "2026-09-25", startsAt: at("19:00", "2026-09-25") })];
  const photos = [
    photo("early", "08:15"), photo("next-day", "10:00", { capturedAt: at("10:00", "2026-09-25") }),
    // 23:30 in Tokyo is still the 24th there though it is 14:30 UTC; 00:30 in Tokyo is the 25th though it is the 24th in UTC.
    photo("late", "23:30"), photo("past-midnight", undefined, { capturedAt: at("00:30", "2026-09-25") }),
    photo("no-time"), photo("unreadable", undefined, { capturedAt: "2026:09:24 13:02:00" }), photo("before-trip", "12:00", { capturedAt: at("12:00", "2026-09-23") }), photo("after-trip", "12:00", { capturedAt: at("12:00", "2026-09-26") }),
  ];
  const { byItem, beforeFirst, unlinked } = linkPhotos(items, photos, spec);
  expect(ids(byItem.get("karatsu"))).toEqual(["late"]);
  expect(byItem.has("dinner")).toBe(false);
  expect([...beforeFirst.keys()].sort()).toEqual(["2026-09-24", "2026-09-25"]);
  expect(ids(beforeFirst.get("2026-09-24"))).toEqual(["early"]);
  expect(ids(beforeFirst.get("2026-09-25"))).toEqual(["past-midnight", "next-day"]);
  expect(ids(unlinked)).toEqual(["before-trip", "after-trip", "no-time", "unreadable"]);
});

test("link: photos under one item are in the order they were taken", () => {
  const items = [item("yobuko", "13:00")];
  const photos = [photo("c", "14:20"), photo("b2", "13:40", { uploadedAt: at("20:00") }), photo("a", "13:02"), photo("b1", "13:40", { uploadedAt: at("19:00") })];
  // The same moment: the one uploaded first.
  expect(ids(linkPhotos(items, photos, spec).byItem.get("yobuko"))).toEqual(["a", "b1", "b2", "c"]);
});

test("itemAt: the latest item of that day, not cancelled, starting at or before the time", () => {
  const items = [item("eleven", "11:00"), item("one", "13:00"), item("dropped", "13:01", { status: "cancelled" }), item("half", "15:30"), item("untimed")];
  expect(itemAt(items, +new Date(at("13:02")), spec.timezone)?.id).toBe("one");
  expect(itemAt(items, +new Date(at("10:00")), spec.timezone)).toBeUndefined();
  expect(itemAt(items, +new Date(at("13:00", "2026-09-25")), spec.timezone)).toBeUndefined();
});

test("photoInstant keeps the offset an EXIF time came with, and reads one without in the trip's zone", () => {
  expect(photoInstant({ local: "2026-09-25T10:15:30", offset: "+09:00" }, "America/New_York")).toBe("2026-09-25T10:15:30+09:00");
  expect(photoInstant({ local: "2026-09-25T10:15:30" }, "Asia/Tokyo")).toBe("2026-09-25T01:15:30.000Z");
  expect(photoInstant({ local: "2026-09-25T10:15:30" }, "Asia/Kolkata")).toBe("2026-09-25T04:45:30.000Z");
  // Either form reads as the same instant by `linkPhotos` and by the host (an offset or Z is what its check asks for).
  for (const t of ["2026-09-25T10:15:30+09:00", photoInstant({ local: "2026-09-25T10:15:30" }, "Asia/Tokyo")]) expect(Number.isFinite(+new Date(t))).toBe(true);
});
test("photoDays: by the day taken in the trip's zone, in the order taken then uploaded; no time comes last", () => {
  const photos = [photo("late", "23:30", { capturedAt: "2026-09-24T23:30:00+09:00" }), photo("none"), photo("next", "00:10", { capturedAt: "2026-09-25T00:10:00+09:00" }), photo("early", "08:00", { capturedAt: "2026-09-24T08:00:00+09:00" }),
    photo("bad", undefined, { capturedAt: "昼" }), photo("utc", "09:00", { capturedAt: "2026-09-24T15:20:00Z" })];
  const { days, unknown } = photoDays(photos, "Asia/Tokyo");
  expect(days.map(d => [d.day, ids(d.photos)])).toEqual([["2026-09-24", ["early", "late"]], ["2026-09-25", ["next", "utc"]]]);
  expect(ids(unknown)).toEqual(["none", "bad"]);
  expect(photoDays([], "Asia/Tokyo")).toEqual({ days: [], unknown: [] });
});

test("photos off: no page unless photos are there, and nothing to put up; on: the page, and the field for those who may", () => {
  expect([photosPageShown({}), photosPageShown({ photos: false, media: [] }), photosPageShown({ photos: false, media: [{}] }), photosPageShown({ photos: true, media: [] })]).toEqual([false, false, true, true]);
  const trip = { photos: true, sealed: { generation: 1 }, role: "participant", state: "active" };
  expect(photosUploadable(trip, true)).toBe(true);
  expect(photosUploadable({ ...trip, photos: false }, true)).toBe(false);
  expect([{ ...trip, role: "viewer" }, { ...trip, state: "frozen" }, { ...trip, sealed: null }, { ...trip, photos: undefined }].map(v => photosUploadable(v, true))).toEqual([false, false, false, false]);
  expect(photosUploadable(trip, false)).toBe(false);
});
