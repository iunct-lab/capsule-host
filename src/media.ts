// Photos of a trip: the shape the host keeps for each one, its limits, the check the host runs on every JPEG it is given, and
// what the page reads from the original before it draws the copies it uploads. No image library: the page scales and turns the
// picture, the host only walks the JPEG's segments, keeps the image and drops the metadata (EXIF, GPS, XMP, comments).

// `contributor` is the uploader's `Session.id`; it stays in the host and the page is told only whether a photo is its own.
// `itineraryItemId` is the item a member chose for the photo by hand; the host does not set it (which item a photo goes under is
// worked out by `linkPhotos` in src/moments.ts each time it is drawn). What the browser sealed (docs/design/trip-e2e.md §3.1) is
// ciphertext of the trip key: `location` and `caption`, and `key`, the random key the photo's two images are sealed under, so a
// new trip key has these few strings to seal again and no image to fetch and send back (§8). The images are in the MediaStore,
// under `blob`, a name the host gives each upload: an upload that loses a race or fails can take back its own images, and no other
// upload can write over a committed photo's.
export type PhotoAsset = { id: string; contributor: string; capturedAt?: string; uploadedAt: string; width: number; height: number; thumb: { width: number; height: number }; itineraryItemId?: string; blob: string; key: string; location?: string; caption?: string };

export const PHOTO_LIMITS = { count: 500, displayEdge: 2048, displayBytes: 1024 * 1024, thumbEdge: 400, thumbBytes: 150 * 1024 };
// An image's ciphertext is its 12-byte IV, the sealed bytes and AES-GCM's 16-byte tag.
export const SEALED_OVERHEAD = 12 + 16;

const size = (bytes: number) => bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`;
export const tooLargeText = (maxEdge: number, maxBytes: number) => `写真が大きすぎます（長辺 ${maxEdge}px・${size(maxBytes)} まで）`;
const broken = () => new Error("写真が壊れています");

// The image of `bytes` without its APP1–APP15 and COM segments and without whatever follows the first EOI (a Motion Photo carries
// a second JPEG and an MP4 with sound there), and its size. Throws, in Japanese, for what is not a baseline/extended/progressive
// JPEG, for a broken one, and for one past `maxEdge` on its long side or `maxBytes` in length.
export function inspectJpeg(bytes: Uint8Array, maxEdge: number, maxBytes: number): { bytes: Uint8Array; width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG の写真を選んでください");
  const tooLarge = new Error(tooLargeText(maxEdge, maxBytes));
  if (bytes.length > maxBytes) throw tooLarge;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2, width = 0, height = 0, scanned = false;
  for (;;) {
    if (scanned) {
      // Entropy-coded data: a 0xFF is followed by 0x00 (a stuffed byte) or a restart marker; anything else is the next marker.
      const from = at;
      while (at + 1 < bytes.length && !(bytes[at] === 0xff && bytes[at + 1] !== 0x00 && (bytes[at + 1]! < 0xd0 || bytes[at + 1]! > 0xd7))) at++;
      if (at + 1 >= bytes.length) throw broken();
      kept.push(bytes.subarray(from, at));
    }
    if (bytes[at] !== 0xff) throw broken();
    while (bytes[at + 1] === 0xff) at++;
    const marker = bytes[at + 1];
    if (marker === undefined) throw broken();
    if (marker === 0xd9) {
      if (!scanned || !width) throw broken();
      kept.push(bytes.subarray(at, at + 2));
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) throw broken();
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    if (length < 2 || at + 2 + length > bytes.length) throw broken();
    const segment = bytes.subarray(at, at + 2 + length);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) throw broken();
      height = (segment[5]! << 8) | segment[6]!;
      width = (segment[7]! << 8) | segment[8]!;
      if (!width || !height) throw broken();
      if (Math.max(width, height) > maxEdge) throw tooLarge;
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) throw new Error("JPEG の写真を選んでください");
    if (marker === 0xda && !width) throw broken();
    // APP2 (ICC) and APP14 (Adobe) go too: the page's canvas never writes them, and an APPn can carry anything.
    if (!(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe) kept.push(segment);
    if (marker === 0xda) scanned = true;
    at += 2 + length;
  }
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  kept.reduce((n, part) => (out.set(part, n), n + part.length), 0);
  return { bytes: out, width, height };
}

export type Exif = { capturedAt?: { local: string; offset?: string }; location?: { lat: number; lng: number; accuracy?: number } };

// When and where the photo in `bytes` was taken, from the EXIF of its APP1 (either byte order): DateTimeOriginal and
// OffsetTimeOriginal, GPSLatitude/Longitude with their refs (south and west negative, none without a ref) and GPSHPositioningError. What cannot be
// read, or is out of range, is left out; it never throws.
export function readExif(bytes: Uint8Array): Exif {
  const tiff = exifBlock(bytes);
  if (!tiff) return {};
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0] ?? 0, tiff[1] ?? 0);
  if (order !== "II" && order !== "MM") return {};
  const little = order === "II";
  const u16 = (at: number) => view.getUint16(at, little), u32 = (at: number) => view.getUint32(at, little);
  // The tags of the IFD at `offset`, each read on demand; a read past the block throws and is caught by the caller of `read`.
  const ifd = (offset: number) => {
    const tags = new Map<number, number>(), count = u16(offset);
    for (let i = 0; i < count; i++) tags.set(u16(offset + 2 + i * 12), offset + 2 + i * 12);
    const where = (entry: number, unit: number) => u32(entry + 4) * unit <= 4 ? entry + 8 : u32(entry + 8);
    return {
      ascii(tag: number) {
        const entry = tags.get(tag);
        if (entry === undefined || u16(entry + 2) !== 2) return undefined;
        const from = where(entry, 1), n = u32(entry + 4);
        if (from + n > tiff.length) throw broken();
        return String.fromCharCode(...tiff.subarray(from, from + n)).replace(/\0.*$/s, "");
      },
      rationals(tag: number) {
        const entry = tags.get(tag);
        if (entry === undefined || u16(entry + 2) !== 5) return undefined;
        const from = where(entry, 8);
        return Array.from({ length: u32(entry + 4) }, (_, i) => {
          const d = u32(from + i * 8 + 4);
          if (!d) throw broken();
          return u32(from + i * 8) / d;
        });
      },
      long(tag: number) {
        const entry = tags.get(tag);
        return entry === undefined || u16(entry + 2) !== 4 ? undefined : u32(entry + 8);
      },
    };
  };
  const read = <T>(f: () => T | undefined) => { try { return f(); } catch { return undefined; } };
  const root = read(() => ifd(u32(4)));
  const out: Exif = {};
  const capturedAt = read(() => {
    const exif = ifd(root!.long(0x8769)!);
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(exif.ascii(0x9003)?.trim() ?? "");
    const [year, month, day, hour, minute, second] = m ? m.slice(1).map(Number) as [number, number, number, number, number, number] : [];
    const date = m && new Date(Date.UTC(year!, month! - 1, day!));
    if (!date || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day || hour! > 23 || minute! > 59 || second! > 59) return undefined;
    const offset = read(() => exif.ascii(0x9011)?.trim());
    return { local: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, ...(offset && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset) ? { offset } : {}) };
  });
  if (capturedAt) out.capturedAt = capturedAt;
  const location = read(() => {
    const gps = ifd(root!.long(0x8825)!);
    const degrees = (tag: number, ref: number, negative: string) => {
      const [d, m = 0, s = 0] = gps.rationals(tag) ?? [];
      if (d === undefined) return undefined;
      const side = gps.ascii(ref)?.trim().toUpperCase();
      return side === negative ? -(d + m / 60 + s / 3600) : side === (negative === "S" ? "N" : "E") ? d + m / 60 + s / 3600 : undefined;
    };
    const lat = degrees(2, 1, "S"), lng = degrees(4, 3, "W");
    if (lat === undefined || lng === undefined || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return undefined;
    const accuracy = read(() => gps.rationals(0x1f)?.[0]);
    return { lat, lng, ...(accuracy !== undefined && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}) };
  });
  if (location) out.location = location;
  return out;
}

// The TIFF block of the first `Exif\0\0` APP1 before the image data, or undefined.
function exifBlock(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1]!, length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker === 0xda || marker === 0xd9 || length < 2) return undefined;
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === "Exif\0\0") return bytes.subarray(at + 10, Math.min(at + 2 + length, bytes.length));
    at += 2 + length;
  }
  return undefined;
}
