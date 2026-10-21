import { test, expect } from "bun:test";
import { itemSchema, type Item } from "./schema";
import { wallClock, timedNeighbours, fitBetween, placeholder, gapBefore } from "./timing";

const day = "2026-09-24", at = (time: string, on = day) => `${on}T${time}:00+09:00`, ms = (time: string, on = day) => +new Date(at(time, on));
const item = (id: string, time?: string, extra: Partial<Item> = {}): Item => ({ id, title: id, day, kind: "activity", status: "confirmed", revision: 1, ...(time ? { startsAt: at(time) } : {}), ...extra });

test("wallClock is the instant a day reads a time in a zone, on either side of a change of offset", () => {
  expect(new Date(wallClock(day, "09:00", "Asia/Tokyo")).toISOString()).toBe("2026-09-24T00:00:00.000Z");
  expect(new Date(wallClock(day, "09:00", "UTC")).toISOString()).toBe("2026-09-24T09:00:00.000Z");
  expect(new Date(wallClock(day, "09:00", "Asia/Kolkata")).toISOString()).toBe("2026-09-24T03:30:00.000Z");
  // Los Angeles moves to summer time at 02:00 on 2026-03-08 and back at 02:00 on 2026-11-01.
  expect(new Date(wallClock("2026-03-07", "09:00", "America/Los_Angeles")).toISOString()).toBe("2026-03-07T17:00:00.000Z");
  expect(new Date(wallClock("2026-03-08", "09:00", "America/Los_Angeles")).toISOString()).toBe("2026-03-08T16:00:00.000Z");
  expect(new Date(wallClock("2026-11-01", "09:00", "America/Los_Angeles")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
});

test("timedNeighbours looks past items without a time and items of other days", () => {
  const items = [item("nine", "09:00"), item("gap"), item("x", "10:00", { day: "2026-09-25", startsAt: at("10:00", "2026-09-25") }), item("here"), item("gap2"), item("noon", "12:00")];
  expect(timedNeighbours(items, 3)).toEqual({ prev: items[0], next: items[5] });
  expect(timedNeighbours(items, 0)).toEqual({ prev: undefined, next: items[5] });
});

test("fitBetween: when the one before ends, or an hour after it starts; halfway in five-minute steps when that passes the next; half an hour before the next; 09:00", () => {
  expect(fitBetween(item("a", "10:00", { endsAt: at("11:15") }), item("b", "15:00"), day, "Asia/Tokyo")).toBe(ms("11:15"));
  expect(fitBetween(item("a", "10:00"), item("b", "15:00"), day, "Asia/Tokyo")).toBe(ms("11:00"));
  expect(fitBetween(item("a", "10:00"), undefined, day, "Asia/Tokyo")).toBe(ms("11:00"));
  expect(fitBetween(item("a", "10:00"), item("b", "10:20"), day, "Asia/Tokyo")).toBe(ms("10:10"));
  // Landing exactly on the next start is not a place before it either.
  expect(fitBetween(item("a", "10:00"), item("b", "11:00"), day, "Asia/Tokyo")).toBe(ms("10:30"));
  expect(fitBetween(item("a", "10:00"), item("b", "11:05"), day, "Asia/Tokyo")).toBe(ms("11:00"));
  // An end past the next start: halfway between the starts, never before the one before even when the step falls there.
  expect(fitBetween(item("a", "10:00", { endsAt: at("16:00") }), item("b", "12:00"), day, "Asia/Tokyo")).toBe(ms("11:00"));
  expect(fitBetween(item("a", "10:02"), item("b", "10:04"), day, "Asia/Tokyo")).toBe(ms("10:02"));
  expect(fitBetween(undefined, item("b", "10:00"), day, "Asia/Tokyo")).toBe(ms("09:30"));
  expect(fitBetween(undefined, undefined, day, "Asia/Tokyo")).toBe(ms("09:00"));
  expect(fitBetween(undefined, undefined, day, "UTC")).toBe(ms("18:00"));
});

test("placeholder keeps a time that fits, keeps the item in its day, and gives an item without a time one", () => {
  expect(placeholder([item("a", "09:00"), item("b", "10:00"), item("c", "12:00")], 1, "Asia/Tokyo")).toBeUndefined();
  expect(placeholder([item("a", "09:00"), item("b", "08:00"), item("c", "12:00")], 1, "Asia/Tokyo")).toBe(ms("10:00"));
  expect(placeholder([item("a", "23:30"), item("b")], 1, "Asia/Tokyo")).toBe(ms("23:30"));
  expect(placeholder([item("a"), item("b")], 0, "Asia/Tokyo")).toBe(ms("09:00"));
  // An item kept in another zone whose neighbour is the day before there: one with a time keeps it, one without takes 09:00 there.
  expect(placeholder([item("la", undefined, { startsAt: "2026-09-24T10:00:00-07:00", timezone: "America/Los_Angeles" }), item("tokyo", "00:10")], 0, "Asia/Tokyo")).toBeUndefined();
  expect(placeholder([item("la", undefined, { timezone: "America/Los_Angeles" }), item("tokyo", "00:10")], 0, "Asia/Tokyo")).toBe(+new Date("2026-09-24T16:00:00Z"));
});

test("timeTentative is an optional boolean on an item", () => {
  expect(itemSchema.safeParse(item("a", "10:00", { timeTentative: true })).success).toBe(true);
  expect(itemSchema.safeParse(item("a", "10:00")).success).toBe(true);
  expect(itemSchema.safeParse({ ...item("a", "10:00"), timeTentative: "yes" }).success).toBe(false);
});

test("gapBefore is the time from the latest end before an item to its start: negative inside one, nothing without an end", () => {
  const H = 3600000, M = 60000, end = (time: string) => ({ endsAt: at(time) });
  // A long item with a shorter one inside it: the one after both is still inside the long one.
  const tour = [item("a", "10:00", end("15:00")), item("b", "11:00", end("11:30")), item("c", "12:00")];
  expect(gapBefore(tour, 2)).toBe(-3 * H); expect(gapBefore(tour, 1)).toBe(-4 * H); expect(gapBefore(tour, 0)).toBeUndefined();
  expect(gapBefore([item("a", "10:30", end("12:00")), item("b", "12:45")], 1)).toBe(45 * M);
  expect(gapBefore([item("a", "10:30", end("12:00")), item("b", "12:00")], 1)).toBe(0);
  expect(gapBefore([item("a", "10:30", end("12:00")), item("b", "11:30")], 1)).toBe(-30 * M);
  // Nothing before has an end; the item itself has no time.
  expect(gapBefore([item("a", "10:30"), item("b", "09:00"), item("c", "12:45")], 2)).toBeUndefined();
  expect(gapBefore([item("a", "10:30", end("12:00")), item("b")], 1)).toBeUndefined();
  // A cancelled long item, one on another day and one without a time are not looked at.
  expect(gapBefore([item("a", "10:00", { ...end("15:00"), status: "cancelled" }), item("b", "11:00", end("11:30")), item("c", "12:00")], 2)).toBe(30 * M);
  expect(gapBefore([item("x", "10:00", { day: "2026-09-25", startsAt: at("10:00", "2026-09-25"), endsAt: at("15:00", "2026-09-25") }), item("b", "11:00", end("11:30")), item("c", "12:00")], 2)).toBe(30 * M);
  expect(gapBefore([item("b", "11:00", end("11:30")), item("t"), item("c", "12:00")], 2)).toBe(30 * M);
  // One without an end starting at or after the latest end may still be going on; one starting before it does not hide the gap.
  expect(gapBefore([item("a", "10:00", end("11:30")), item("b", "11:45"), item("c", "12:30")], 2)).toBeUndefined();
  expect(gapBefore([item("a", "10:00", end("11:30")), item("b", "11:30"), item("c", "12:30")], 2)).toBeUndefined();
  expect(gapBefore([item("b", "09:00"), item("a", "10:00", end("11:30")), item("c", "12:30")], 2)).toBe(H);
  expect(gapBefore([item("a", "10:00", end("15:00")), item("b", "11:45"), item("c", "12:30")], 2)).toBe(-150 * M);
  // A cancelled item is marked by nothing.
  expect(gapBefore([item("a", "10:00", end("15:00")), item("c", "12:00", { status: "cancelled" })], 1)).toBeUndefined();
});

test("placeholder reads only the days and times: a sealed item (ciphertext, no kind, status or title) gets the same time", () => {
  const plain = [item("a", "10:00", { endsAt: at("11:15") }), item("new"), item("b", "15:00"), item("c", "09:00"), item("d")];
  const sealed = plain.map(({ id, day, startsAt, endsAt, revision }) => ({ id, day, revision, sealed: "v1.1.AAAA", ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) }));
  for (let i = 0; i < plain.length; i++) expect(placeholder(sealed, i, "Asia/Tokyo")).toBe(placeholder(plain, i, "Asia/Tokyo"));
  expect(placeholder(sealed, 1, "Asia/Tokyo")).toBe(ms("11:15"));
});
