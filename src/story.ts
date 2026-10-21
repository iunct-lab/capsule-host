import { km, type Point } from "./footprints";
import { itemAt } from "./moments";
import { localDay, type Item, type Spec, type State } from "./schema";

// How far from a plan's first point a later point in its time still counts as being there. Fixed, not a Spec setting (PBI #440).
export const UNPLANNED_KM = 2;

export type StoryEntry = { kind: "plan"; item: Item; recorded?: Point } | { kind: "unplanned"; point: Point };

// The trip's story, worked out each time the page draws and never stored: for each day of the trip with a plan or a point, its plans
// in the itinerary's order (a cancelled one left out), each with the first point in its time (`itemAt`, the rule photos go by) as
// `recorded`. A point before the day's first plan, after its plan's end, or `UNPLANNED_KM` or more from its plan's first point is
// `unplanned`, put before the first plan that starts later than it. A later point near the first one adds nothing.
export function story(items: Item[], points: Point[], spec: Pick<Spec, "timezone" | "trip">): Map<string, StoryEntry[]> {
  const shown = items.filter(i => i.status !== "cancelled"), first = new Map<string, Point>(), unplanned: Point[] = [];
  const t = (s?: string) => s === undefined ? Infinity : +new Date(s);
  for (const p of [...points].sort((a, b) => t(a.at) - t(b.at))) {
    const day = localDay(t(p.at), spec.timezone);
    if (day < spec.trip.startsOn || day > spec.trip.endsOn) continue;
    const under = itemAt(shown, t(p.at), spec.timezone), seen = under && first.get(under.id);
    if (!under || t(p.at) > t(under.endsAt) || (seen && km(seen, p) >= UNPLANNED_KM)) unplanned.push(p);
    else if (!seen) first.set(under.id, p);
  }
  const days = [...new Set([...shown.map(i => i.day), ...unplanned.map(p => localDay(t(p.at), spec.timezone))])].filter(d => d >= spec.trip.startsOn && d <= spec.trip.endsOn).sort();
  return new Map(days.map(day => {
    const plans = shown.filter(i => i.day === day), extra = unplanned.filter(p => localDay(t(p.at), spec.timezone) === day);
    const slot = (p: Point) => plans.findIndex(i => t(i.startsAt) > t(p.at)), before = (k: number) => extra.filter(p => slot(p) === k);
    const entry = (point: Point): StoryEntry => ({ kind: "unplanned", point });
    return [day, [...plans.flatMap((item, k): StoryEntry[] => [...before(k).map(entry), { kind: "plan", item, ...(first.has(item.id) ? { recorded: first.get(item.id) } : {}) }]), ...extra.filter(p => slot(p) < 0).map(entry)]];
  }));
}

// The page a trip opens on: its story once the trip is over, if it has one, otherwise the first of its navigation.
export function firstPage(pages: Array<{ id: string; kind: string }>, state: State | "draft"): string {
  return (state === "reflection" || state === "frozen" ? pages.find(p => p.kind === "story")?.id : undefined) ?? pages[0]!.id;
}
