// Where the line between two footprints is cut: a gap this long, or a move faster than this (a flight, a bullet train). Fixed, not a
// Spec setting (PBI #439).
export const TRACK_LIMITS = { gapMs: 3 * 3600_000, kmh: 150 };

// A footprint as the page gets it (`view.footprints`): when, where, and the display name of the member who left it.
export type Point = { id: string; at: string; lat: number; lng: number; by: string };

// The distance in km between two places on the earth (haversine).
export const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

// When a device that turned it on leaves a point by itself, on opening the trip's page or coming back to it (PBI #481): a point
// every visit would bury the ones pressed, so only 15 minutes or 300 m on from this member's last one. Fixed, as `TRACK_LIMITS`.
export const AUTO_FOOTPRINT = { everyMs: 15 * 60_000, metres: 300 };
export function autoDue(last: { at: string; lat: number; lng: number } | undefined, now: number, here: { lat: number; lng: number }): boolean {
  return !last || now - Date.parse(last.at) >= AUTO_FOOTPRINT.everyMs || km(last, here) * 1000 >= AUTO_FOOTPRINT.metres;
}

// The footprints in the order they were left (one whose time does not read as an instant is left out), and the lines joining them.
// A line runs through one member's (`by`) footprints one after another and is cut where the next one comes `gapMs` or more later or
// is further than `kmh` allows (over at least a minute, so that footprints left seconds apart, tens of metres off by GPS, are not a
// fast move); a line of one point is left out. The lines are in the order of their first point. They join where the member was,
// not the way the trip went.
export function footprints(points: Point[]): { points: Point[]; lines: Point[][] } {
  const timed = points.map(p => ({ p, t: Date.parse(p.at) })).filter(({ t }) => Number.isFinite(t)).sort((a, b) => a.t - b.t);
  const lines: Point[][] = [], open = new Map<string, { line: Point[]; t: number }>();
  for (const { p, t } of timed) {
    const o = open.get(p.by);
    if (o && t - o.t < TRACK_LIMITS.gapMs && km(o.line.at(-1)!, p) <= TRACK_LIMITS.kmh * Math.max(t - o.t, 60_000) / 3600_000) { o.line.push(p); o.t = t; }
    else { const line = [p]; lines.push(line); open.set(p.by, { line, t }); }
  }
  return { points: timed.map(({ p }) => p), lines: lines.filter(l => l.length > 1) };
}

// The spots of the map: footprints at the same place to 4 decimals of a degree (about 10 m) are one spot, which sits where the
// first of them was. Spots are in the order of their first footprint. Kept in degrees, not in pixels, so zooming does not change them.
export function spotsOf(points: { id: string; lat: number; lng: number }[]): { lat: number; lng: number; ids: string[] }[] {
  const spots = new Map<string, { lat: number; lng: number; ids: string[] }>();
  for (const p of points) {
    const key = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    if (!spots.has(key)) spots.set(key, { lat: p.lat, lng: p.lng, ids: [] });
    spots.get(key)!.ids.push(p.id);
  }
  return [...spots.values()];
}
