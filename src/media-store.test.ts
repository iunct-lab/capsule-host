import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMediaStore } from "./media-store";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const store = () => { const dir = mkdtempSync(join(tmpdir(), "capsule-host.media-store.")); dirs.push(dir); return { dir, media: new LocalMediaStore(join(dir, "media")) }; };
const prefix = "a".repeat(64), name = (n: string) => `${n.repeat(32)}.display`;

test("put, get, remove and removeAll: what was put comes back, a missing one is null, removing is not an error twice", async () => {
  const { dir, media } = store();
  await media.put(prefix, name("1"), new Uint8Array([1, 2, 3])); await media.put(prefix, name("2"), new Uint8Array([4]));
  expect(await media.get(prefix, name("1"))).toEqual(new Uint8Array([1, 2, 3]));
  expect(await media.get(prefix, name("3"))).toBeNull(); expect(await media.get("b".repeat(64), name("1"))).toBeNull();
  await media.remove(prefix, name("1")); await media.remove(prefix, name("1"));
  expect(await media.get(prefix, name("1"))).toBeNull(); expect(await media.get(prefix, name("2"))).not.toBeNull();
  await media.removeAll(prefix); await media.removeAll(prefix);
  expect(readdirSync(join(dir, "media"))).toEqual([]);
});
test("the files are the owner's alone", async () => {
  const { dir, media } = store();
  await media.put(prefix, name("1"), new Uint8Array([1]));
  expect(statSync(join(dir, "media", prefix)).mode & 0o777).toBe(0o700); expect(statSync(join(dir, "media", prefix, name("1"))).mode & 0o777).toBe(0o600);
});
test("only a capsule row's key and a photo's name are keys: a path cannot leave the directory", async () => {
  const { media } = store();
  for (const [p, n] of [["../x", name("1")], [prefix, "../../x.display"], [prefix, "x.display"], [prefix, `${"1".repeat(32)}.original`], ["", name("1")], [`${"a".repeat(63)}/`, name("1")]] as const) {
    await expect(media.put(p, n, new Uint8Array([1]))).rejects.toThrow(); await expect(media.get(p, n)).rejects.toThrow(); await expect(media.remove(p, n)).rejects.toThrow();
  }
  for (const p of ["..", ".", "", "a".repeat(63)]) await expect(media.removeAll(p)).rejects.toThrow();
});
