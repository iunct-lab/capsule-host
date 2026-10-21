import { expect, test } from "bun:test";
import { AUTO_FOOTPRINT, autoDue, footprints, spotsOf } from "./footprints";

const point = (id: string, at: string, lat: number, lng: number, by = "A") => ({ id, at, lat, lng, by });

test("track: Fukuoka to Haneda is not joined, 20 minutes and 5 km on the same day are", () => {
  // Fukuoka Airport → Haneda is about 880 km in 2 hours (440 km/h). Hakata Station → Tenjin is about 2 km, then 3 km more.
  const flight = footprints([point("fuk", "2026-10-10T08:00:00+09:00", 33.5859, 130.4510), point("hnd", "2026-10-10T10:00:00+09:00", 35.5494, 139.7798)]);
  expect(flight.points.map(p => p.id)).toEqual(["fuk", "hnd"]);
  expect(flight.lines).toEqual([]);
  const walk = footprints([point("b", "2026-10-10T12:20:00+09:00", 33.6350, 130.4430), point("a", "2026-10-10T12:00:00+09:00", 33.5902, 130.4207)]);
  expect(walk.points.map(p => p.id)).toEqual(["a", "b"]);
  expect(walk.lines.map(l => l.map(p => p.id))).toEqual([["a", "b"]]);
});

test("track: 149 km/h is joined and 151 km/h is cut", () => {
  // Along a meridian one hour apart, so the distance in km is the speed in km/h.
  const north = (kmh: number) => 35 + kmh / 6371 * 180 / Math.PI;
  const { lines } = footprints([
    point("a", "2026-10-10T09:00:00+09:00", 35, 135), point("b", "2026-10-10T10:00:00+09:00", north(149), 135),
    point("c", "2026-10-10T11:00:00+09:00", north(149) + north(151) - 35, 135),
  ]);
  expect(lines.map(l => l.map(p => p.id))).toEqual([["a", "b"]]);
});

test("track: footprints left in the same second or seconds apart, a few tens of metres off, stay on the line", () => {
  // GPS wanders by tens of metres: footprints left seconds apart at one spot are not a fast move.
  const { lines } = footprints([
    point("a", "2026-10-10T12:00:00+09:00", 35.0, 135.0), point("b", "2026-10-10T12:00:00+09:00", 35.0002, 135.0),
    point("c", "2026-10-10T12:00:02+09:00", 35.0005, 135.0), point("d", "2026-10-10T12:10:00+09:00", 35.005, 135.0),
  ]);
  expect(lines.map(l => l.map(p => p.id))).toEqual([["a", "b", "c", "d"]]);
  // Within that minute a move further than 150 km/h allows over a minute (2.5 km) is still cut: 10 km in the same second.
  expect(footprints([point("a", "2026-10-10T12:00:00+09:00", 35.0, 135.0), point("b", "2026-10-10T12:00:00+09:00", 35.09, 135.0)]).lines).toEqual([]);
});

test("track: a gap of 3 hours or more cuts the line", () => {
  const { lines } = footprints([
    point("a", "2026-10-10T09:00:00+09:00", 35.0, 135.0), point("b", "2026-10-10T09:30:00+09:00", 35.001, 135.0),
    point("c", "2026-10-10T12:30:00+09:00", 35.002, 135.0), point("d", "2026-10-10T12:40:00+09:00", 35.003, 135.0),
    point("e", "2026-10-10T15:39:00+09:00", 35.004, 135.0),
  ]);
  // b → c is exactly 3 hours (cut); d → e is 2 h 59 min (joined).
  expect(lines.map(l => l.map(p => p.id))).toEqual([["a", "b"], ["c", "d", "e"]]);
});

test("track: the points come back in the order they were left, as they were given", () => {
  const b = point("b", "2026-10-10T09:20:00+09:00", 35.001, 135.0, "B"), a = point("a", "2026-10-10T00:00:00Z", 35.0, 135.001);
  const { points } = footprints([b, a]);
  expect(points).toEqual([a, b]);
});

test("track: each member's points make their own line, and a point whose time does not read is left out", () => {
  // A and B walk the same streets in turns; each line joins only one member's points, and the lines go by their first point.
  const { points, lines } = footprints([
    point("b1", "2026-10-10T09:05:00+09:00", 35.0, 135.01, "B"), point("a1", "2026-10-10T09:00:00+09:00", 35.0, 135.0),
    point("a2", "2026-10-10T09:10:00+09:00", 35.001, 135.0), point("b2", "2026-10-10T09:15:00+09:00", 35.001, 135.01, "B"),
    point("bad", "not a time", 35.002, 135.0), point("a3", "2026-10-10T09:20:00+09:00", 35.002, 135.0),
    point("c1", "2026-10-10T09:30:00+09:00", 35.0, 135.02, "C"),
  ]);
  expect(points.map(p => p.id)).toEqual(["a1", "b1", "a2", "b2", "a3", "c1"]);
  expect(lines.map(l => l.map(p => p.id))).toEqual([["a1", "a2", "a3"], ["b1", "b2"]]);
});

test("spotsOf makes one spot of points at the same place to 4 decimals, in the order of the first", () => {
  // 0.00004° is about 4 m: the same spot. 0.0001° (about 11 m) apart is the next one.
  const spots = spotsOf([{ id: "a", lat: 33.59001, lng: 130.40001 }, { id: "b", lat: 35, lng: 135 }, { id: "c", lat: 33.59004, lng: 130.39998 }, { id: "d", lat: 33.5901, lng: 130.4 }]);
  expect(spots.map(s => s.ids)).toEqual([["a", "c"], ["b"], ["d"]]);
  expect(spots[0]).toMatchObject({ lat: 33.59001, lng: 130.40001 });
  expect(spotsOf([])).toEqual([]);
});

test("auto: due with no point before, after 15 minutes or 300 m, not at 14 min 59 s and 299 m", () => {
  // Along a meridian, so the distance in metres is exact enough: 1 m north is 1 / 6371000 rad.
  const at = "2026-10-10T09:00:00+09:00", t = Date.parse(at), last = { at, lat: 35, lng: 135 };
  const north = (m: number) => ({ lat: 35 + m / 6371000 * 180 / Math.PI, lng: 135 });
  expect(AUTO_FOOTPRINT).toEqual({ everyMs: 15 * 60_000, metres: 300 });
  expect(autoDue(undefined, t, north(0))).toBe(true);
  expect(autoDue(last, t + 14 * 60_000 + 59_000, north(299))).toBe(false);
  expect(autoDue(last, t + 15 * 60_000, north(0))).toBe(true);
  // 300 m to a millimetre: the haversine of exactly 300 m comes back a hair under it in floating point.
  expect(autoDue(last, t + 60_000, north(300.001))).toBe(true);
  expect(autoDue(last, t, north(0))).toBe(false);
});
