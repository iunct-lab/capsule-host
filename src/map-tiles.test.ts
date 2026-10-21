import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapRoute, mapTiles } from "./map-tiles";

const dir = mkdtempSync(join(tmpdir(), "capsule-map-tiles-")), path = join(dir, "japan.pmtiles");
writeFileSync(path, Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256)));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("map tiles: a range is 206 with Content-Range, an open range runs to the end, past the end is 416, a missing file 404", async () => {
  const first = await mapTiles(path, "bytes=0-1023");
  expect(first.status).toBe(206); expect(first.headers.get("Content-Range")).toBe("bytes 0-1023/5000");
  const body = new Uint8Array(await first.arrayBuffer()); expect(body.length).toBe(1024); expect(body[1023]).toBe(1023 % 256);
  const tail = await mapTiles(path, "bytes=4990-");
  expect(tail.status).toBe(206); expect(tail.headers.get("Content-Range")).toBe("bytes 4990-4999/5000"); expect((await tail.arrayBuffer()).byteLength).toBe(10);
  const clamped = await mapTiles(path, "bytes=4999-9999");
  expect(clamped.headers.get("Content-Range")).toBe("bytes 4999-4999/5000");
  const past = await mapTiles(path, "bytes=5000-");
  expect(past.status).toBe(416); expect(past.headers.get("Content-Range")).toBe("bytes */5000");
  const whole = await mapTiles(path, null);
  expect(whole.status).toBe(200); expect((await whole.arrayBuffer()).byteLength).toBe(5000);
  expect((await mapTiles(join(dir, "world.pmtiles"), "bytes=0-1023")).status).toBe(404);
});

test("map route: the record as JSON, the world and regions by name, nothing else under /map/", async () => {
  writeFileSync(join(dir, "world.pmtiles"), "PMTiles");
  const none = await mapRoute(dir, "/map/regions.json", null);
  expect(none!.status).toBe(404);
  writeFileSync(join(dir, "regions.json"), JSON.stringify({ build: "20261012" }));
  const record = await mapRoute(dir, "/map/regions.json", null);
  expect(record!.status).toBe(200); expect(record!.headers.get("Content-Type")).toBe("application/json"); expect(await record!.json()).toEqual({ build: "20261012" });
  expect((await mapRoute(dir, "/map/world.pmtiles", "bytes=0-6"))!.status).toBe(206);
  expect((await mapRoute(dir, "/map/japan.pmtiles", "bytes=0-1023"))!.status).toBe(206);
  expect((await mapRoute(dir, "/map/taiwan-taipei.pmtiles", null))!.status).toBe(404);
  for (const path of ["/map/../regions.json.pmtiles", "/map/..%2Fsecret.pmtiles", "/map/Japan.pmtiles", "/map/a/b.pmtiles", "/map/regions.pmtiles", "/map/japan.pmtiles.bak", "/map/other.json"]) expect(mapRoute(dir, path, null)).toBeUndefined();
});
