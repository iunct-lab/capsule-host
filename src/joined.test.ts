import { test, expect } from "bun:test";
import { expiredIn, type Joined } from "./joined";

const row = (id: string, purgeAt: string): Joined => ({ id, title: id, startsOn: "2026-09-24", endsOn: "2026-09-25", purgeAt });

test("expiredIn names the trips past their purge time only", () => {
  const now = +new Date("2026-10-01T00:00:00.000Z");
  const list = [row("before", "2026-10-01T00:00:00.001Z"), row("at", "2026-10-01T00:00:00.000Z"), row("after", "2026-09-30T23:59:59.999Z")];
  expect(expiredIn(list, now)).toEqual(["at", "after"]);
  expect(expiredIn([], now)).toEqual([]);
});
