import { describe, expect, test } from "bun:test";
import { awsErrorCode, checkHeader, parseBbox, place, regionsOf, REGION_NAME, type Bbox } from "./mapdata";

// A PMTiles v3 header (127 bytes) as `pmtiles extract` writes it: vector tiles, the zooms and bounds given.
function header(o: { maxzoom?: number; bbox?: Bbox; tileType?: number; version?: number } = {}): Uint8Array {
  const b = new Uint8Array(127), v = new DataView(b.buffer), [w, s, e, n] = o.bbox ?? [130.2, 33.5, 130.5, 33.7];
  b.set(new TextEncoder().encode("PMTiles")); b[7] = o.version ?? 3;
  v.setBigUint64(8, 127n, true); b[96] = 1; b[97] = 2; b[98] = 2; b[99] = o.tileType ?? 1; b[100] = 0; b[101] = o.maxzoom ?? 15;
  [w, s, e, n].forEach((x, i) => v.setInt32(102 + 4 * i, Math.round(x * 1e7), true));
  return b;
}
const fukuoka: Bbox = [130.2, 33.5, 130.5, 33.7];

describe("parseBbox", () => {
  test("reads west,south,east,north", () => expect(parseBbox("130.2, 33.5,130.5,33.7")).toEqual(fukuoka));
  test("refuses a box turned round, outside the map, or not four numbers", () => {
    expect(() => parseBbox("130.5,33.5,130.2,33.7")).toThrow("逆");
    expect(() => parseBbox("130.2,33.7,130.5,33.5")).toThrow("逆");
    expect(() => parseBbox("130.2,33.5,190,33.7")).toThrow("地図の外");
    expect(() => parseBbox("130.2,-89,130.5,33.7")).toThrow("地図の外");
    expect(() => parseBbox("130.2,33.5,130.5")).toThrow("4 つの数");
    expect(() => parseBbox("130.2,33.5,,33.7")).toThrow("4 つの数");
  });
});

test("REGION_NAME takes a file name and refuses world, regions, and anything that could leave map/", () => {
  for (const ok of ["japan", "taiwan-taipei", "k2"]) expect(REGION_NAME.test(ok)).toBe(true);
  for (const no of ["world", "regions", "Japan", "../x", "a/b", "-x", "", "a".repeat(33)]) expect(REGION_NAME.test(no)).toBe(false);
});

describe("checkHeader", () => {
  test("passes the header asked for", () => {
    expect(() => checkHeader(header(), { maxzoom: 15, bbox: fukuoka })).not.toThrow();
    expect(() => checkHeader(header({ maxzoom: 8, bbox: [-180, -85, 180, 85] }), { maxzoom: 8, bbox: null })).not.toThrow();
  });
  test("refuses a broken start, another version or tile type, another zoom, bounds outside the box", () => {
    const broken = header(); broken[0] = 0x3c;
    expect(() => checkHeader(broken, { maxzoom: 15, bbox: fukuoka })).toThrow("PMTiles のファイルではありません");
    expect(() => checkHeader(new TextEncoder().encode("<html>not found</html>"), { maxzoom: 15, bbox: fukuoka })).toThrow("PMTiles のファイルではありません");
    expect(() => checkHeader(header({ version: 2 }), { maxzoom: 15, bbox: fukuoka })).toThrow("版");
    expect(() => checkHeader(header({ tileType: 2 }), { maxzoom: 15, bbox: fukuoka })).toThrow("MVT");
    expect(() => checkHeader(header({ maxzoom: 14 }), { maxzoom: 15, bbox: fukuoka })).toThrow("最大ズーム");
    expect(() => checkHeader(header({ bbox: [130.2, 33.5, 131.5, 33.7] }), { maxzoom: 15, bbox: fukuoka })).toThrow("範囲");
  });
});

describe("place", () => {
  const files = [{ name: "world", path: "w", maxzoom: 8, bbox: null }, { name: "fukuoka", path: "f", maxzoom: 15, bbox: fukuoka }];
  const io = (bytes: Record<string, Uint8Array>) => {
    const put: string[] = [];
    return { put, io: { read: async (p: string) => bytes[p]!, put: async (key: string, p: string) => { put.push(`${key}<${p}`); } } };
  };
  test("puts every file, then the record last", async () => {
    const t = io({ w: header({ maxzoom: 8, bbox: [-180, -85, 180, 85] }), f: header() });
    await place(files, "r", t.io);
    expect(t.put).toEqual(["world.pmtiles<w", "fukuoka.pmtiles<f", "regions.json<r"]);
  });
  test("puts nothing when one file is broken, even the last one", async () => {
    const broken = header(); broken.set(new TextEncoder().encode("garbage"));
    const t = io({ w: header({ maxzoom: 8, bbox: [-180, -85, 180, 85] }), f: broken });
    await expect(place(files, "r", t.io)).rejects.toThrow("fukuoka: PMTiles のファイルではありません（先頭が違う）。何も置いていません");
    expect(t.put).toEqual([]);
  });
});

describe("regionsOf", () => {
  const file = (name: string, maxzoom: number, bbox: Bbox | null) => ({ name, maxzoom, bbox, bytes: 1, sha256: "0".repeat(64) });
  const ok = { build: "20261011", made: "2026-10-12T00:00:00.000Z", files: [file("world", 8, null), file("japan", 15, [122.93, 20.42, 153.99, 45.56])] };
  test("reads a record", () => expect(regionsOf(ok)).toEqual(ok));
  test("refuses a record without the world first, a bad build or name, a repeated name", () => {
    expect(() => regionsOf({ ...ok, files: ok.files.slice(1) })).toThrow("files[0]");
    expect(() => regionsOf({ ...ok, build: "2026-10-11" })).toThrow("build");
    expect(() => regionsOf({ ...ok, files: [ok.files[0], file("../x", 15, [1, 1, 2, 2])] })).toThrow("files[1]");
    expect(() => regionsOf({ ...ok, files: [...ok.files, ok.files[1]] })).toThrow("名前");
    expect(() => regionsOf(null)).toThrow();
  });
});

test("awsErrorCode keeps the code and none of the message", () => {
  expect(awsErrorCode("\nAn error occurred (AccessDenied) when calling the HeadObject operation: User: arn:aws:iam::123456789012:user/someone is not authorized")).toBe("AccessDenied");
  expect(awsErrorCode("An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.")).toBe("NoSuchKey");
  expect(awsErrorCode("Could not connect to the endpoint URL: \"https://example-bucket.s3.ap-northeast-1.amazonaws.com/map/x\"")).toBeUndefined();
});
