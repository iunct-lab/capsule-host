import { describe, expect, test } from "bun:test";
import { exportFiles, photoExportFiles, tripHtml, tripMarkdown, zip, zipParts } from "./export";
import type { Shown } from "./moments";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTrip } from "./test-fixture";

test("a placeholder time reads \"ごろ\" in the Markdown and HTML; the calendar is the same either way", async () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "html", "ics"];
  trip.document.items[0] = { ...trip.document.items[0]!, timeTentative: true };
  const marked = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(marked["README.md"]).toContain("- **集合** (confirmed) 2026-09-24T13:15:00+09:00 ごろ");
  expect(marked["README.md"]).toContain("- **夕食** (confirmed) 2026-09-25T19:00:00+09:00\n");
  expect(marked["index.html"]).toContain("<small>決定 · 13:15 ごろ</small>");
  expect(marked["index.html"]).toContain("<small>決定 · 19:00</small>");
  delete trip.document.items[0]!.timeTentative;
  expect(marked["calendar.ics"]).toBe((await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z"))["calendar.ics"]);
  expect(marked["calendar.ics"]).toContain("DTSTART:20260924T041500Z");
});

test("an item with an end reads \"13:15 – 14:30\" in the HTML and gives the end in the Markdown, \"ごろ\" after both", async () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "html"];
  trip.document.items[0] = { ...trip.document.items[0]!, endsAt: "2026-09-24T14:30:00+09:00" };
  const files = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(files["README.md"]).toContain("- **集合** (confirmed) 2026-09-24T13:15:00+09:00 – 2026-09-24T14:30:00+09:00\n");
  expect(files["index.html"]).toContain("<small>決定 · 13:15 – 14:30</small>");
  trip.document.items[0].timeTentative = true;
  const marked = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(marked["README.md"]).toContain("2026-09-24T13:15:00+09:00 – 2026-09-24T14:30:00+09:00 ごろ");
  expect(marked["index.html"]).toContain("<small>決定 · 13:15 – 14:30 ごろ</small>");
});

test("tripMarkdown is the README.md of the ZIP", async () => {
  const trip = testTrip();
  expect(tripMarkdown(trip.spec, trip.document)).toBe((await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z"))["README.md"]!);
});
test("tripHtml is the index.html of the ZIP", async () => {
  const trip = testTrip(), html = tripHtml(trip.spec, trip.document);
  expect(html).toBe((await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z"))["index.html"]!);
  expect(html).not.toContain("<script");
});

test("the calendar names capsule-host as its maker and keeps each event's UID", async () => {
  const trip = testTrip(); trip.spec.exports = ["ics"];
  const lines = (await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z"))["calendar.ics"]!.split("\r\n");
  expect(lines.filter(l => l.startsWith("PRODID:"))).toEqual(["PRODID:-//capsule-host//Trip Capsule//JA"]);
  expect(lines).toContain(`UID:c1-${trip.document.items.find(i => i.status === "confirmed" && i.startsAt)!.id}@trip-capsule`);
});

// The ZIP made before the move to crypto.subtle and Uint8Array: the host and the browser must give these bytes.
test("export bytes stay the same", async () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "json", "ics", "html"];
  const files = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(files["manifest.json"]).toBe("{\n  \"schemaVersion\": 1,\n  \"capsuleId\": \"c1\",\n  \"revision\": 1,\n  \"createdAt\": \"2026-09-20T00:00:00Z\",\n  \"files\": {\n    \"README.md\": \"e9cd0c000543c107c37af83b3899bedab0af266a42a63d738416f4c63b5b14ec\",\n    \"trip.json\": \"a7b56a6a0a1aae62f3f1bf747d536631d11c78f1f598c201e67661d11a395ebd\",\n    \"calendar.ics\": \"e9042a46a3cf0491323d5e2f295b37b97ffc35c8e617f69b54d605851314c4b4\",\n    \"index.html\": \"cc7055f61e029ad7caa20380e4a92596996aecdbf6c46158e80350827dd66d32\"\n  }\n}");
  expect(new Bun.CryptoHasher("sha256").update(zip(files)).digest("hex")).toBe("996f224f62c3dd1a7c712a761e3444d51acc44a4ad5a158d61f6c1774fae3b61");
});
test("export runs in the browser", async () => {
  const built = await Bun.build({ entrypoints: ["src/export.ts"], target: "browser" });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]!.text();
  expect(code.includes("node:")).toBe(false);
  expect(/\bBuffer\b/.test(code)).toBe(false);
});

describe("photos", () => {
  // A JPEG made of segments (the checks walk them and never decode); `exif` puts an APP1 with the text "Exif" before the image.
  const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));
  const jpeg = (exif: boolean, seed = 0) => new Uint8Array([0xff, 0xd8, ...segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), ...(exif ? segment(0xe1, [...ascii("Exif"), 0, 0, ...ascii("GPS 35.658 139.701")]) : []), ...segment(0xdb, [0, ...Array(64).fill(1)]), ...segment(0xc0, [8, 3, 0x84, 4, 0xb0, 1, 1, 0x11, 0]), ...segment(0xc4, [0, ...Array(16).fill(0)]), ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0xff, 0x00, seed, 0xff, 0xd9]);
  const shown = (id: string, capturedAt: string | undefined, uploadedAt: string): Shown => ({ id, capturedAt, uploadedAt, width: 1200, height: 900, thumb: { width: 400, height: 300 }, itineraryItemId: undefined, key: "k", mine: false });
  const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
  // testTrip: 集合 (09-24 13:15), 夕食 (09-25 19:00), 公園の散歩 (09-26 10:00), in Asia/Tokyo.
  const taken = {
    dinner: shown("dinner", "2026-09-25T19:30:00+09:00", "2026-09-27T00:00:01Z"),
    early: shown("early", "2026-09-24T09:00:00+09:00", "2026-09-27T00:00:02Z"),
    twin2: shown("twin2", "2026-09-24T14:00:00+09:00", "2026-09-27T00:00:04Z"),
    twin1: shown("twin1", "2026-09-24T14:00:00+09:00", "2026-09-27T00:00:03Z"),
    unknown: shown("unknown", undefined, "2026-09-27T00:00:00Z"),
  };
  const make = async (list: Shown[], points: Parameters<typeof photoExportFiles>[5] = [], spots: Record<string, { lat: number; lng: number }> = {}) => {
    const trip = testTrip(); trip.spec.exports = ["markdown", "json", "ics", "html"];
    return photoExportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z", list.map((photo, n) => ({ photo, image: jpeg(false, n), location: spots[photo.id] })), points);
  };

  test("photos: names follow the time taken, then the upload, unknown time last", async () => {
    const { files, skipped } = await make(Object.values(taken));
    expect(skipped).toEqual([]);
    expect(Object.keys(files).filter(n => n.startsWith("photos/"))).toEqual(["photos/001.jpg", "photos/002.jpg", "photos/003.jpg", "photos/004.jpg", "photos/005.jpg"]);
    // Order taken: early, twin1 (uploaded first), twin2, dinner, then the one with no time. Each file is the image it names.
    const order = ["early", "twin1", "twin2", "dinner", "unknown"], list = Object.values(taken);
    order.forEach((id, n) => expect((files[`photos/00${n + 1}.jpg`] as Uint8Array).at(-3)).toBe(list.findIndex(p => p.id === id)));
    expect(JSON.parse(files["manifest.json"] as string).photos).toEqual(Object.keys(files).filter(n => n.startsWith("photos/")));
  });

  test("photos: an image with EXIF goes in without its APP1 and a broken one is skipped", async () => {
    const trip = testTrip();
    const { files, skipped } = await photoExportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z", [
      { photo: taken.dinner, image: jpeg(true) }, { photo: taken.early, image: new Uint8Array([1, 2, 3, 4, 5]) }, { photo: taken.unknown, image: jpeg(false) },
    ], []);
    expect(skipped).toEqual(["early"]);
    expect(Object.keys(files).filter(n => n.startsWith("photos/"))).toEqual(["photos/001.jpg", "photos/002.jpg"]);
    for (const n of ["photos/001.jpg", "photos/002.jpg"]) { expect(text(files[n] as Uint8Array)).not.toContain("Exif"); expect(text(files[n] as Uint8Array)).not.toContain("GPS"); }
    expect(text(files["photos/001.jpg"] as Uint8Array)).toContain("JFIF");
    expect(files["index.html"] as string).not.toContain("early");
  });

  test("photos: index.html and README.md put each item's photos under it with relative names", async () => {
    const { files } = await make(Object.values(taken));
    const html = files["index.html"] as string, md = files["README.md"] as string;
    expect(html).toContain("img-src 'self' file:");
    const names = [...html.matchAll(/<img src="([^"]+)" alt="" loading="lazy">/g)].map(m => m[1]!);
    expect(names.sort()).toEqual(["photos/001.jpg", "photos/002.jpg", "photos/003.jpg", "photos/004.jpg", "photos/005.jpg"]);
    for (const n of names) expect(files[n]).toBeInstanceOf(Uint8Array);
    // 001 before the first item of 09-24, 002/003 under 集合, 004 under 夕食, 005 in the section of photos with no time.
    expect(html).toMatch(/<h2>2026-09-24<\/h2><img src="photos\/001.jpg"[^>]*><article>.*集合.*<img src="photos\/002.jpg"[^>]*><img src="photos\/003.jpg"[^>]*><\/article>/);
    expect(html).toMatch(/夕食.*<img src="photos\/004.jpg"[^>]*><\/article>/);
    expect(html).toMatch(/<h2>時刻の分からない写真<\/h2><img src="photos\/005.jpg"[^>]*><\/section>/);
    expect(md).toContain("## 2026-09-24\n\n![](photos/001.jpg)\n- **集合**");
    expect(md).toContain("  ![](photos/002.jpg)\n  ![](photos/003.jpg)\n\n## 2026-09-25");
    expect(md).toContain("  ![](photos/004.jpg)\n");
    expect(md).toContain("## 時刻の分からない写真\n\n![](photos/005.jpg)\n");
    // Without photos the page and the CSP are what they were.
    const trip = testTrip();
    expect(tripHtml(trip.spec, trip.document)).not.toContain("img-src");
    expect(tripHtml(trip.spec, trip.document)).not.toContain("<img");
    expect(tripMarkdown(trip.spec, trip.document)).not.toContain("![](");
    // A photo ZIP with no photo in it: no img-src, no image CSS.
    expect((await make([])).files["index.html"]).not.toContain("img-src");
  });

  test("photos: track.geojson has the footprints, their lines and located photos as given", async () => {
    const points = [
      { id: "p1", at: "2026-09-24T10:00:00+09:00", lat: 35.658034, lng: 139.701636, by: "A" },
      { id: "p2", at: "2026-09-24T10:30:00+09:00", lat: 35.659, lng: 139.7, by: "A" },
      { id: "p3", at: "2026-09-24T11:00:00+09:00", lat: 34.9, lng: 135.7, by: "B" },
    ];
    const { files } = await make([taken.dinner, taken.unknown], points, { dinner: { lat: 35.123456, lng: 139.654321 } });
    const geo = JSON.parse(files["track.geojson"] as string);
    expect(geo.type).toBe("FeatureCollection");
    expect(geo.features.filter((f: any) => f.properties.kind === "footprint").map((f: any) => [f.geometry.coordinates, f.properties.at, f.properties.by])).toEqual(points.map(p => [[p.lng, p.lat], p.at, p.by]));
    expect(geo.features.filter((f: any) => f.properties.kind === "track")).toEqual([{ type: "Feature", geometry: { type: "LineString", coordinates: [[139.701636, 35.658034], [139.7, 35.659]] }, properties: { kind: "track", by: "A", from: points[0]!.at, to: points[1]!.at } }]);
    // A photo with a place is a point; the one without (and the located one's neighbours) is not.
    expect(geo.features.filter((f: any) => f.properties.kind === "photo")).toEqual([{ type: "Feature", geometry: { type: "Point", coordinates: [139.654321, 35.123456] }, properties: { kind: "photo", file: "photos/001.jpg", at: taken.dinner.capturedAt } }]);
    // No photo at all: the footprints are still there. Nothing at all: an empty collection.
    expect(JSON.parse((await make([], points)).files["track.geojson"] as string).features).toHaveLength(4);
    expect(JSON.parse((await make([])).files["track.geojson"] as string).features).toEqual([]);
  });

  test("photos: zip holds bytes as they are and unzip reads every entry", async () => {
    const { files } = await make(Object.values(taken), [{ id: "p1", at: "2026-09-24T10:00:00+09:00", lat: 35.1, lng: 139.1, by: "A" }]);
    const parts = zipParts(files), whole = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    parts.reduce((at, b) => (whole.set(b, at), at + b.length), 0);
    expect(zip(files)).toEqual(whole);
    // The image's bytes are in the ZIP unchanged (one part is the image itself).
    expect(parts.includes(files["photos/001.jpg"] as Uint8Array)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "capsule-host.zip."));
    try {
      writeFileSync(join(dir, "trip.zip"), whole);
      const listed = Bun.spawnSync(["unzip", "-t", join(dir, "trip.zip")]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toContain("No errors detected");
      for (const name of Object.keys(files)) expect(listed.stdout.toString()).toContain(name);
      const out = Bun.spawnSync(["unzip", "-p", join(dir, "trip.zip"), "photos/002.jpg"]);
      expect([...out.stdout]).toEqual([...files["photos/002.jpg"] as Uint8Array]);
      expect(readFileSync(join(dir, "trip.zip")).length).toBe(whole.length);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
