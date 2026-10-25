import { describe, test, expect } from "bun:test";
import { newMemoKey, open, openEntry, privateMarkdown, seal, sealEntry, unwrapMemoKey, wrapMemoKey, wrappingKey, type PlainEntry } from "./private-entries";
import { testTrip } from "./test-fixture";

// Stand-ins for a passkey's PRF output: 32 bytes, the same each time for one passkey.
const prf = () => crypto.getRandomValues(new Uint8Array(32)), form = /^v1\.[A-Za-z0-9_-]+$/;
describe("the memo key and sealed text", () => {
  test("a memo key wrapped with one PRF output opens with that output and that trip only, as a key that cannot be taken out", async () => {
    const mine = prf(), memo = await newMemoKey(), wrapped = await wrapMemoKey(memo, await wrappingKey(mine, "trip-a"), "trip-a");
    expect(wrapped).toMatch(form);
    const kept = await unwrapMemoKey(wrapped, await wrappingKey(mine, "trip-a"), "trip-a");
    expect(kept.extractable).toBe(false); await expect(crypto.subtle.exportKey("raw", kept)).rejects.toThrow();
    expect(await open(kept, await seal(memo, "同じ鍵", "a"), "a")).toBe("同じ鍵");
    await expect(unwrapMemoKey(wrapped, await wrappingKey(prf(), "trip-a"), "trip-a")).rejects.toThrow();
    await expect(unwrapMemoKey(wrapped, await wrappingKey(mine, "trip-b"), "trip-b")).rejects.toThrow();
    // Rewrapping (a passkey replaced) needs the key taken out once, so it opens extractable when asked.
    expect((await unwrapMemoKey(wrapped, await wrappingKey(mine, "trip-a"), "trip-a", true)).extractable).toBe(true);
  });
  test("sealed text opens under the same key and the same associated data only", async () => {
    const key = await newMemoKey(), long = "旅".repeat(4000), sealed = await seal(key, long, "e1/body/item/2026-09-25/2026-09-25T10:00:00+09:00/");
    expect(sealed).toMatch(form); expect(sealed).not.toContain("旅");
    expect(await open(key, sealed, "e1/body/item/2026-09-25/2026-09-25T10:00:00+09:00/")).toBe(long);
    await expect(open(key, sealed, "e1/body/item/2026-09-26/2026-09-25T10:00:00+09:00/")).rejects.toThrow();
    await expect(open(await newMemoKey(), sealed, "e1/body/item/2026-09-25/2026-09-25T10:00:00+09:00/")).rejects.toThrow();
    await expect(open(key, "v1.AAAA", "x")).rejects.toThrow(); await expect(open(key, "plain", "x")).rejects.toThrow();
    // A fresh IV each time: the same text never seals the same way twice.
    expect(await seal(key, "同じ", "a")).not.toBe(await seal(key, "同じ", "a"));
    expect(await seal(key, "", "a")).toMatch(form);
  });
  test("an entry's words open where they were sealed only: not in another entry, not with its date or time rewritten", async () => {
    const key = await newMemoKey(), plan: PlainEntry = { id: "p1", kind: "item", day: "2026-09-25", startsAt: "2026-09-25T10:00:00+09:00", title: "病院", body: "10時に予約", place: { label: "駅前クリニック", publicUrl: "https://example.com/clinic" } };
    const sealed = await sealEntry(key, plan), other = await sealEntry(key, { id: "p2", kind: "diary", day: "2026-09-25", title: "", body: "日記" });
    expect(JSON.stringify(sealed)).not.toContain("病院"); expect(JSON.stringify(sealed)).not.toContain("クリニック");
    expect(sealed).toMatchObject({ id: "p1", kind: "item", day: "2026-09-25", startsAt: "2026-09-25T10:00:00+09:00" });
    expect(await openEntry(key, sealed)).toEqual(plan);
    expect(await openEntry(key, { ...other, body: sealed.body })).toBeNull();
    expect(await openEntry(key, { ...sealed, title: sealed.body })).toBeNull();
    expect(await openEntry(key, { ...sealed, day: "2026-09-26" })).toBeNull();
    expect(await openEntry(key, { ...sealed, startsAt: "2026-09-25T01:00:00.000Z" })).toBeNull();
    expect(await openEntry(await newMemoKey(), sealed)).toBeNull();
    expect(await openEntry(key, other)).toEqual({ id: "p2", kind: "diary", day: "2026-09-25", title: "", body: "日記" });
  });
});
describe("privateMarkdown", () => {
  const spec = testTrip().spec, a: PlainEntry[] = [
    { id: "a2", kind: "diary", day: "2026-09-24", title: "", body: "Aの日記" },
    { id: "a1", kind: "item", day: "2026-09-25", startsAt: "2026-09-25T10:00:00+09:00", title: "題Aのしるし", body: "Aの本文\n二行目" },
  ];
  test("the entries this browser opened, by day, times in the trip's zone, and nothing of anyone else's", () => {
    const text = privateMarkdown(spec, a, 0, "2026-09-25T00:00:00.000Z");
    expect(text).toStartWith('---\ntitle: "テスト旅行"\nstartsOn: 2026-09-24\nendsOn: 2026-09-26\nexportedAt: 2026-09-25T00:00:00.000Z\n---\n\n# テスト旅行（自分のメモ）\n');
    expect(text).toContain("## 2026-09-24\n\n- Aの日記"); expect(text).toContain("## 2026-09-25\n\n- **10:00 題Aのしるし** Aの本文\n  二行目\n");
    expect(text).not.toContain("読めなかった"); expect(text).not.toContain("Bのしるし");
    // The escaping is the README.md's: what would be Markdown is shown as typed.
    expect(privateMarkdown(spec, [{ id: "x", kind: "diary", day: "2026-09-24", title: "*太字*", body: "[リンク](https://example.com)" }], 0, "t")).toContain("- **\\*太字\\*** \\[リンク\\]\\(https://example.com\\)");
  });
  test("entries this browser could not open are left out and counted under the heading", () => {
    const text = privateMarkdown(spec, a.slice(0, 1), 2, "t");
    expect(text).toContain("# テスト旅行（自分のメモ）\n\nこの端末で読めなかった 2 件は含まれていません。\n\n## 2026-09-24");
    expect(privateMarkdown(spec, [], 0, "t")).not.toContain("## 2026");
  });
});
