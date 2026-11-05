import { test, expect } from "bun:test";
import { expiredIn, listedRow, type Joined } from "./joined";

const row = (id: string, purgeAt: string): Joined => ({ id, title: id, startsOn: "2026-09-24", endsOn: "2026-09-25", purgeAt });

test("expiredIn names the trips past their purge time only", () => {
  const now = +new Date("2026-10-01T00:00:00.000Z");
  const list = [row("before", "2026-10-01T00:00:00.001Z"), row("at", "2026-10-01T00:00:00.000Z"), row("after", "2026-09-30T23:59:59.999Z")];
  expect(expiredIn(list, now)).toEqual(["at", "after"]);
  expect(expiredIn([], now)).toEqual([]);
});

test("listedRow keeps the title it opened, and never the ciphertext", () => {
  const now = { id: "t", title: "京都の週末", startsOn: "2026-09-26", endsOn: "2026-09-27", purgeAt: "2026-10-27T00:00:00.000Z" };
  const prev = { ...row("t", "2026-10-25T00:00:00.000Z"), title: "前に開いた題" };
  expect(listedRow(undefined, now, true)).toEqual(now);
  expect(listedRow(prev, now, true).title).toBe("京都の週末");
  expect(listedRow(prev, { ...now, title: "ciphertext" }, false)).toEqual({ ...now, title: "前に開いた題" });
  expect(listedRow(undefined, { ...now, title: "ciphertext" }, false)).toEqual({ ...now, title: "暗号化した旅行" });
  // The owner renamed the trip: the next opening lists the new title.
  expect(listedRow(listedRow(undefined, now, true), { ...now, title: "京都と奈良" }, true).title).toBe("京都と奈良");
});
