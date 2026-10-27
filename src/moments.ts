import type { PhotoAsset } from "./media";
import { localDay, type Item, type Spec } from "./schema";
import { wallClock } from "./timing";

// A photo as `GET /v1/c/:id` gives it to the page: who uploaded it stays in the host, the page only learns whether it is its own.
export type Shown = Omit<PhotoAsset, "contributor" | "blob"> & { mine: boolean };

// A photo without a time, or with one that does not read as an instant, sorts after the others and is `unlinked`.
const taken = (p: Shown) => { const t = +new Date(p.capturedAt ?? NaN); return Number.isFinite(t) ? t : Infinity; };
const inOrder = (a: Shown, b: Shown) => taken(a) - taken(b) || +new Date(a.uploadedAt) - +new Date(b.uploadedAt);

// Which item each photo goes under, worked out each time the page draws and never stored. A photo linked by hand stays with its
// item while the item is there, whatever its day, time or status. Any other goes under the last item of the day it was taken (in
// the trip's zone) that is not cancelled and starts at or before it (the later in the itinerary when two start together); before
// the day's first such item it is `beforeFirst` that day. A photo without a time, or taken outside the trip, is `unlinked`.
// Each group is in the order the photos were taken, then uploaded.
export function linkPhotos(items: Item[], photos: Shown[], spec: Pick<Spec, "timezone" | "trip">): { byItem: Map<string, Shown[]>; beforeFirst: Map<string, Shown[]>; unlinked: Shown[] } {
  const byItem = new Map<string, Shown[]>(), beforeFirst = new Map<string, Shown[]>(), unlinked: Shown[] = [];
  const put = (map: Map<string, Shown[]>, key: string, p: Shown) => map.set(key, [...map.get(key) ?? [], p]);
  for (const p of [...photos].sort(inOrder)) {
    if (p.itineraryItemId !== undefined && items.some(i => i.id === p.itineraryItemId)) { put(byItem, p.itineraryItemId, p); continue; }
    const at = taken(p), day = at === Infinity ? undefined : localDay(at, spec.timezone);
    if (day === undefined || day < spec.trip.startsOn || day > spec.trip.endsOn) { unlinked.push(p); continue; }
    const under = itemAt(items, at, spec.timezone);
    if (under) put(byItem, under.id, p); else put(beforeFirst, day, p);
  }
  return { byItem, beforeFirst, unlinked };
}

// The item going on at `at`: of the items on that day (in `timezone`) that are not cancelled and have a start time at or before
// `at`, the one that starts last (the later in the itinerary when two start together).
export function itemAt(items: Item[], at: number, timezone: string): Item | undefined {
  const day = localDay(at, timezone);
  let under: Item | undefined;
  for (const i of items) if (i.day === day && i.status !== "cancelled" && i.startsAt !== undefined && +new Date(i.startsAt) <= at && (!under || +new Date(i.startsAt) >= +new Date(under.startsAt!))) under = i;
  return under;
}

// Where a photo was taken: its own place when it has one, or else the place of the footprint nearest the time it was taken, any
// member's, if one was left within 30 minutes of it (the earlier of two as near). Worked out as the page shows the photo, never stored.
export const PLACE_WITHIN = 30 * 60 * 1000;
export function photoPlace<P extends { at: string; lat: number; lng: number }>(own: { lat: number; lng: number } | null, capturedAt: string | undefined, points: P[]): { lat: number; lng: number; from: "photo" | "footprint" } | null {
  if (own) return { lat: own.lat, lng: own.lng, from: "photo" };
  const at = +new Date(capturedAt ?? NaN); if (!Number.isFinite(at)) return null;
  let near: P | undefined, gap = Infinity;
  for (const p of points) { const d = Math.abs(+new Date(p.at) - at); if (d <= PLACE_WITHIN && (d < gap || (d === gap && +new Date(p.at) < +new Date(near!.at)))) { near = p; gap = d; } }
  return near ? { lat: near.lat, lng: near.lng, from: "footprint" } : null;
}

// With photos off (the operator's switch) the page is not shown unless photos are already there, and nothing can be put up; a viewer,
// a trip whose sharing has ended, a trip that is not sealed and a browser without the key put up nothing either.
export const photosPageShown = (v: { photos?: boolean; media?: unknown[] }) => Boolean(v.photos || v.media?.length);
export const photosUploadable = (v: { photos?: boolean; sealed?: unknown; role: string; state: string }, hasKey: boolean) => Boolean(v.photos && v.sealed && hasKey) && v.role !== "viewer" && v.state !== "frozen";

// The time a photo was taken, as the host keeps it: an instant with its offset (it must have one, or `linkPhotos` would read it in
// the zone of whoever opens the page). An EXIF time with an offset keeps it; one without is the wall clock of the trip's zone.
export function photoInstant(taken: { local: string; offset?: string }, zone: string): string {
  if (taken.offset) return `${taken.local}${taken.offset}`;
  const [day, time] = taken.local.split("T") as [string, string];
  return new Date(wallClock(day, time.slice(0, 5), zone) + Number(time.slice(6, 8)) * 1000).toISOString();
}

// The photos by the day they were taken (in the trip's zone), each day in the order they were taken and then uploaded; those with no
// time that reads as an instant come last, as a group of their own.
export function photoDays(photos: Shown[], zone: string): { days: Array<{ day: string; photos: Shown[] }>; unknown: Shown[] } {
  const days = new Map<string, Shown[]>(), unknown: Shown[] = [];
  for (const p of [...photos].sort(inOrder)) {
    const at = taken(p);
    if (at === Infinity) { unknown.push(p); continue; }
    const day = localDay(at, zone);
    days.set(day, [...days.get(day) ?? [], p]);
  }
  return { days: [...days].sort(([a], [b]) => a < b ? -1 : 1).map(([day, list]) => ({ day, photos: list })), unknown };
}
