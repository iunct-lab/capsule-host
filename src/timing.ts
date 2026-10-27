import { localDay, type Item } from "./schema";

// The one rule for the time the host gives an item from its neighbours: when it is moved, promoted from a suggestion, and
// what the edit form offers for an item that has none. A time chosen this way is a placeholder (`timeTentative`), not a decision.
export const HOUR = 3600000, HALF_HOUR = 1800000, STEP = 300000;
// What placing an item reads: its day and times, never its words, so a sealed item is placed the same way (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」).
export type Timed = Pick<Item, "id" | "day" | "startsAt" | "endsAt" | "timezone">;
const instant = (at?: string) => at === undefined ? undefined : +new Date(at);

// The instant `day` reads `hhmm` in `zone`. The only place a wall-clock time is assembled: the offset is read back from Intl,
// then read again at the instant it gave, so a day on which the zone changes its offset lands on the offset of that hour.
export function wallClock(day: string, hhmm: string, zone: string): number {
  const guess = Date.parse(`${day}T${hhmm}:00Z`);
  const offset = (t: number) => {
    const name = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(t).find(p => p.type === "timeZoneName")!.value;
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name)!;
    return m[1] ? (m[1] === "-" ? -1 : 1) * (+m[2]! * HOUR + +m[3]! * 60000) : 0;
  };
  return guess - offset(guess - offset(guess));
}

// The nearest items of the same day before and after `items[index]` that have a time; items without one are looked past.
export function timedNeighbours<T extends Timed>(items: T[], index: number): { prev?: T; next?: T } {
  const day = items[index]!.day, timed = (x: T) => x.day === day && x.startsAt !== undefined;
  return { prev: items.slice(0, index).reverse().find(timed), next: items.slice(index + 1).find(timed) };
}

// Where an item goes between two neighbours: when the one before ends (an hour after it starts when it has no end), or halfway
// between the two starts in five-minute steps when that would reach the one after, never earlier than the one before. Half an hour
// before the one after when nothing is before; 09:00 of the day when neither is there.
export function fitBetween(prev: Timed | undefined, next: Timed | undefined, day: string, zone: string): number {
  const start = instant(prev?.startsAt), after = instant(next?.startsAt);
  if (start === undefined) return after !== undefined ? after - HALF_HOUR : wallClock(day, "09:00", zone);
  const at = instant(prev!.endsAt) ?? start + HOUR;
  return after !== undefined && at >= after ? Math.max(start, Math.floor((start + after) / 2 / STEP) * STEP) : at;
}

// `fitBetween` for `items[index]` itself, kept inside the item's own day: a time that would leave it becomes the neighbour's own.
// An item with a time keeps it when that fits already, or when no neighbour's time is its day either (it may keep another zone);
// one without a time takes 09:00 then. Undefined when nothing changes.
export function placeholder<T extends Timed>(items: T[], index: number, timezone: string): number | undefined {
  const item = items[index]!, now = instant(item.startsAt), zone = item.timezone ?? timezone, { prev, next } = timedNeighbours(items, index);
  const before = instant(prev?.startsAt), after = instant(next?.startsAt), inDay = (t: number) => localDay(t, zone) === item.day;
  if (now !== undefined && (before === undefined || before <= now) && (after === undefined || now <= after)) return;
  let at = fitBetween(prev, next, item.day, zone);
  if (!inDay(at)) at = before ?? after!;
  if (!inDay(at)) { if (now !== undefined) return; at = wallClock(item.day, "09:00", zone); }
  return at === now ? undefined : at;
}

// How long from the latest end among the items before `items[index]` to its start: negative when it starts inside one of them. The
// ones before are those of the same day with a time that are not cancelled, so an item inside a long one is seen inside it even after
// a shorter one. Undefined when the item is cancelled or has no time, when none before has an end, or when one before without an end
// starts at or after that latest end and so may still be going on: nothing is known then. Only shown, never used to move anything.
export function gapBefore(items: Item[], index: number): number | undefined {
  const item = items[index]!, start = instant(item.startsAt);
  if (item.status === "cancelled" || start === undefined) return;
  const before = items.slice(0, index).filter(x => x.day === item.day && x.status !== "cancelled" && x.startsAt !== undefined);
  const ends = before.flatMap(x => x.endsAt === undefined ? [] : [instant(x.endsAt)!]);
  if (!ends.length) return;
  const end = Math.max(...ends);
  return start >= end && before.some(x => x.endsAt === undefined && instant(x.startsAt)! >= end) ? undefined : start - end;
}
