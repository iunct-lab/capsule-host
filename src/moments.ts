import type { PhotoAsset } from "./media";
import { localDay, type Item, type Spec } from "./schema";

// A photo as `GET /v1/c/:id` gives it to the page: who uploaded it stays in the host, the page only learns whether it is its own.
export type Shown = Omit<PhotoAsset, "contributor"> & { mine: boolean };

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
