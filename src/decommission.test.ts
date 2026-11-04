import { test, expect } from "bun:test";
import { decommissionReport, type Listed } from "./decommission";

const now = +new Date("2026-11-04T00:00:00Z");
const trip = (id: string, state: string | null, purgeAt: string): Listed => ({ id, kind: "trip", state, purgeAt });

test("no live trip lets the decommission go on", () => {
  const r = decommissionReport([], now);
  expect(r).toMatchObject({ live: 0, byState: {}, latestPurgeAt: null, ok: true });
  expect(r.lines[0]).toBe("有効な旅行: 0 件");
});

test("one live trip stops the decommission", () => {
  const r = decommissionReport([trip("c1", "active", "2026-12-01T00:00:00Z")], now);
  expect(r).toMatchObject({ live: 1, byState: { active: 1 }, latestPurgeAt: "2026-12-01T00:00:00Z", ok: false });
});

test("trips past their purge date are not counted", () => {
  const r = decommissionReport([trip("c1", "frozen", "2026-11-03T23:59:59Z")], now);
  expect(r).toMatchObject({ live: 0, ok: true });
});

test("a purge date that does not parse counts as live", () => {
  expect(decommissionReport([trip("c1", "active", "not a date")], now)).toMatchObject({ live: 1, ok: false, latestPurgeAt: null });
  expect(decommissionReport([trip("c1", "active", "not a date"), trip("c2", "active", "2026-12-01T00:00:00Z")], now).latestPurgeAt).toBe("2026-12-01T00:00:00Z");
});

test("counts by state and the latest purge date", () => {
  const r = decommissionReport([
    trip("c1", "active", "2026-12-01T00:00:00Z"),
    trip("c2", "reflection", "2027-01-15T00:00:00Z"),
    trip("c3", "active", "2026-11-20T00:00:00Z"),
    trip("c4", null, "2026-11-10T00:00:00Z"),
    trip("c5", "frozen", "2026-10-01T00:00:00Z"),
  ], now);
  expect(r.live).toBe(4);
  expect(r.byState).toEqual({ active: 2, reflection: 1, unknown: 1 });
  expect(r.latestPurgeAt).toBe("2027-01-15T00:00:00Z");
  expect(r.lines).toContain("  active: 2 件");
  expect(r.lines).toContain("いちばん遅い削除予定: 2027-01-15T00:00:00Z");
});

test("the lines name no capsule id or title", () => {
  const r = decommissionReport([{ id: "c0ffee1d", kind: "trip", state: "active", purgeAt: "2026-12-01T00:00:00Z", title: "京都の旅" } as Listed], now);
  const text = r.lines.join("\n");
  expect(text).not.toContain("c0ffee1d");
  expect(text).not.toContain("京都");
  expect(text).toContain("所有者に確かめてください");
});
