import { test, expect } from "bun:test";
import { inspectJpeg, readExif, PHOTO_LIMITS } from "./media";

// A JPEG put together segment by segment. The image data is not a real picture: the checks walk segments and never decode.
const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));

type Tag = { tag: number; type: 2 | 4 | 5; value: number[] | string };
// A TIFF block with IFD0 pointing at an Exif IFD and a GPS IFD, in either byte order. Values longer than 4 bytes go after the IFDs.
function tiff(little: boolean, exif: Tag[], gps: Tag[] | undefined): number[] {
  const u16 = (n: number) => little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff];
  const u32 = (n: number) => little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const size = (tags: Tag[]) => 2 + tags.length * 12 + 4;
  const root: Tag[] = [{ tag: 0x8769, type: 4, value: [0] }, ...(gps ? [{ tag: 0x8825, type: 4, value: [0] } as Tag] : [])];
  const at = { root: 8, exif: 8 + size(root), gps: 8 + size(root) + size(exif) };
  root[0]!.value = [at.exif];
  if (gps) root[1]!.value = [at.gps];
  let extra = 8 + size(root) + size(exif) + (gps ? size(gps) : 0);
  const tail: number[] = [];
  const ifd = (tags: Tag[]) => [...u16(tags.length), ...tags.flatMap(t => {
    const data = t.type === 2 ? [...ascii(t.value as string), 0] : t.type === 4 ? u32((t.value as number[])[0]!) : (t.value as number[]).flatMap(u32);
    const count = t.type === 2 ? data.length : t.type === 4 ? 1 : data.length / 8;
    let field = data;
    if (data.length > 4) { field = u32(extra); tail.push(...data); extra += data.length; }
    return [...u16(t.tag), ...u16(t.type), ...u32(count), ...field, ...Array(4 - field.length).fill(0)];
  }), ...u32(0)];
  return [...ascii(little ? "II" : "MM"), ...u16(42), ...u32(8), ...ifd(root), ...ifd(exif), ...(gps ? ifd(gps) : []), ...tail];
}
const dms = (deg: number, min: number, sec: number) => [deg, 1, min, 1, sec * 100, 100];
const exifTags = (time = "2026:09:24 14:05:30", offset = "+09:00"): Tag[] => [{ tag: 0x9003, type: 2, value: time }, { tag: 0x9011, type: 2, value: offset }];
const gpsTags = (lat = "N", lng = "E"): Tag[] => [
  { tag: 1, type: 2, value: lat }, { tag: 2, type: 5, value: dms(35, 39, 29.16) },
  { tag: 3, type: 2, value: lng }, { tag: 4, type: 5, value: dms(139, 42, 3.6) },
  { tag: 0x1f, type: 5, value: [12, 1] },
];
const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56, 0xff, 0xd9];
function jpeg({ width = 1200, height = 900, exif = tiff(true, exifTags(), gpsTags()), tail = [] as number[] } = {}) {
  const head = [
    0xff, 0xd8,
    ...segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...ascii("Exif"), 0, 0, ...exif]),
    ...segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta/>")]),
    ...segment(0xfe, ascii("taken at home")),
    ...segment(0xdb, [0, ...Array(64).fill(1)]),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0, ...Array(16).fill(0)]),
  ];
  const scan = [...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), ...SCAN];
  return { bytes: new Uint8Array([...head, ...scan, ...tail]), scan };
}
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text);

test("inspectJpeg drops EXIF, XMP and comments and keeps the image", () => {
  const { bytes, scan } = jpeg();
  expect(has(bytes, "Exif") && has(bytes, "xmpmeta") && has(bytes, "taken at home")).toBe(true);
  const out = inspectJpeg(bytes, PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes);
  expect([out.width, out.height]).toEqual([1200, 900]);
  expect(has(out.bytes, "Exif") || has(out.bytes, "xmpmeta") || has(out.bytes, "taken at home")).toBe(false);
  expect(Array.from(out.bytes.subarray(out.bytes.length - scan.length))).toEqual(scan);
  expect(has(out.bytes, "JFIF")).toBe(true);
  // What it returns passes again unchanged.
  expect(inspectJpeg(out.bytes, PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes).bytes).toEqual(out.bytes);
});

test("inspectJpeg keeps every scan of a progressive JPEG and drops an APPn between them", () => {
  const scan = (data: number[]) => [...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), ...data];
  const parts = [
    [0xff, 0xd8], segment(0xc2, [8, 0, 100, 0, 200, 1, 1, 0x11, 0]), segment(0xc4, [0, ...Array(16).fill(0)]), scan([1, 0xff, 0x00, 2]),
    segment(0xe1, [...ascii("Exif"), 0, 0, ...tiff(true, exifTags(), gpsTags())]), segment(0xc4, [0x10, ...Array(16).fill(0)]), scan([3, 0xff, 0xd1, 4]), [0xff, 0xd9],
  ];
  const out = inspectJpeg(new Uint8Array(parts.flat()), 2048, 1024 * 1024);
  expect([out.width, out.height]).toEqual([200, 100]);
  expect(Array.from(out.bytes)).toEqual([...parts.slice(0, 4), ...parts.slice(5)].flat());
});

test("inspectJpeg drops what follows the first EOI", () => {
  const motion = [...jpeg({ width: 300, height: 400 }).bytes, ...[0, 0, 0, 0x18], ...ascii("ftypmp42"), ...ascii("sound and video")];
  const { bytes, scan } = jpeg({ tail: motion });
  const out = inspectJpeg(bytes, PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes);
  expect(Array.from(out.bytes.subarray(out.bytes.length - scan.length))).toEqual(scan);
  expect(has(out.bytes, "ftyp") || has(out.bytes, "Exif")).toBe(false);
});

test("inspectJpeg refuses what is not a JPEG, a broken one, and one past the limits", () => {
  const check = (bytes: Uint8Array | number[], edge = 2048, max = 1024 * 1024) => () => inspectJpeg(new Uint8Array(bytes), edge, max);
  const good = Array.from(jpeg().bytes);
  expect(check([0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a, 0, 0])).toThrow("JPEG の写真を選んでください");
  expect(check(ascii("GIF89a"))).toThrow("JPEG の写真を選んでください");
  expect(check([0xff, 0xd8, ...segment(0xc3, [8, 0, 10, 0, 10, 1, 1, 0x11, 0]), 0xff, 0xd9])).toThrow("JPEG の写真を選んでください");
  expect(check(good.slice(0, good.length - 2))).toThrow("写真が壊れています");                       // no EOI
  expect(check(good.slice(0, 30))).toThrow("写真が壊れています");                                    // a segment longer than the file
  expect(check([0xff, 0xd8, ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 1, 2, 0xff, 0xd9])).toThrow("写真が壊れています"); // no SOF
  expect(check(jpeg({ width: 0 }).bytes)).toThrow("写真が壊れています");
  expect(check(jpeg({ width: 2049, height: 100 }).bytes)).toThrow("写真が大きすぎます（長辺 2048px・1 MiB まで）");
  expect(check(jpeg({ width: 100, height: 401 }).bytes, 400, 150 * 1024)).toThrow("写真が大きすぎます（長辺 400px・150 KiB まで）");
  expect(check(good, 2048, good.length - 1)).toThrow("写真が大きすぎます");
  expect(check(good, 1200, good.length)).not.toThrow();
});

test("readExif reads the time, the offset and the GPS position in both byte orders", () => {
  for (const little of [true, false]) {
    const north = readExif(jpeg({ exif: tiff(little, exifTags(), gpsTags()) }).bytes);
    expect(north.capturedAt).toEqual({ local: "2026-09-24T14:05:30", offset: "+09:00" });
    expect(north.location!.lat).toBeCloseTo(35.6581, 4);
    expect(north.location!.lng).toBeCloseTo(139.701, 3);
    expect(north.location!.accuracy).toBe(12);
    const south = readExif(jpeg({ exif: tiff(little, exifTags("2026:01:02 03:04:05", "-03:00"), gpsTags("S", "W")) }).bytes);
    expect(south.capturedAt).toEqual({ local: "2026-01-02T03:04:05", offset: "-03:00" });
    expect(south.location!.lat).toBeCloseTo(-35.6581, 4);
    expect(south.location!.lng).toBeCloseTo(-139.701, 3);
  }
});

test("readExif returns nothing it cannot read", () => {
  expect(readExif(new Uint8Array(ascii("not a jpeg")))).toEqual({});
  const noExif = jpeg().bytes;
  expect(readExif(inspectJpeg(noExif, 2048, 1024 * 1024).bytes)).toEqual({});              // like a photo shared through LINE
  expect(readExif(jpeg({ exif: tiff(true, exifTags("0000:00:00 00:00:00", "+9"), undefined) }).bytes)).toEqual({});
  expect(readExif(jpeg({ exif: tiff(true, exifTags("2026:09:24 14:05:30", "JST"), undefined) }).bytes)).toEqual({ capturedAt: { local: "2026-09-24T14:05:30" } });
  const refs = [{ tag: 1, type: 2, value: "N" }, { tag: 3, type: 2, value: "E" }] as Tag[];
  const outOfRange = [...refs, { tag: 2, type: 5, value: dms(95, 0, 0) }, { tag: 4, type: 5, value: dms(10, 0, 0) }] as Tag[];
  expect(readExif(jpeg({ exif: tiff(false, [], outOfRange) }).bytes)).toEqual({});
  const zero = [...refs, { tag: 2, type: 5, value: [35, 0, 0, 1, 0, 1] }, { tag: 4, type: 5, value: dms(10, 0, 0) }] as Tag[];
  expect(readExif(jpeg({ exif: tiff(true, [], zero) }).bytes)).toEqual({});
  expect(readExif(jpeg({ exif: tiff(true, exifTags(), gpsTags()).slice(0, 40) }).bytes)).toEqual({});
  expect(readExif(jpeg({ exif: tiff(true, exifTags("2026:02:31 10:00:00"), undefined) }).bytes)).toEqual({});   // no such day
  // Without its ref a coordinate could be either side of the equator or of Greenwich.
  const noRef = gpsTags().filter(t => t.tag !== 3);
  expect(readExif(jpeg({ exif: tiff(true, [], noRef) }).bytes)).toEqual({});
});

test("readExif returns no location for a GPS IFD without coordinates", () => {
  // The Pixel camera's original: a GPS IFD that carries only the direction of the camera.
  const direction = [{ tag: 0x10, type: 2, value: "T" }, { tag: 0x11, type: 5, value: [27000, 100] }] as Tag[];
  expect(readExif(jpeg({ exif: tiff(true, exifTags(), direction) }).bytes)).toEqual({ capturedAt: { local: "2026-09-24T14:05:30", offset: "+09:00" } });
});
