// The footprint map's data (#564): what `bun aws/mapdata.ts` cuts out of a Protomaps build and puts under `map/`, and the record
// `map/regions.json` the page reads to know which files there are. No node API here, so the page can import the type.
import { bytesToHeader, TileType } from "pmtiles";

export type Bbox = [number, number, number, number];
// files[0] is the world (z8, no bbox); the regions follow at z15. `build` is the Protomaps build (YYYYMMDD) every file was cut from.
export type MapFile = { name: string; maxzoom: number; bbox: Bbox | null; bytes: number; sha256: string };
export type MapRegions = { build: string; made: string; files: MapFile[] };

export const WORLD = { name: "world", maxzoom: 8, bbox: null };
export const REGION_ZOOM = 15;
// The region a first build makes when there is no record yet.
export const JAPAN = { name: "japan", bbox: [122.93, 20.42, 153.99, 45.56] as Bbox };
// A region's name is its file's name (`map/<name>.pmtiles`); `world` and `regions` are taken by the world and the record.
export const REGION_NAME = /^(?!(?:world|regions)$)[a-z][a-z0-9-]{0,31}$/;
export const BUILD = /^\d{8}$/;
// The header is the first 127 bytes; a reader is given this much of each file.
export const HEADER_BYTES = 16384;

// "minLon,minLat,maxLon,maxLat" in degrees, as `pmtiles extract --bbox` takes it.
export function parseBbox(s: string): Bbox {
  const v = s.split(",").map(x => x.trim() === "" ? NaN : Number(x));
  if (v.length !== 4 || v.some(x => !Number.isFinite(x))) throw new Error(`範囲は「西の経度,南の緯度,東の経度,北の緯度」の 4 つの数で書いてください: ${s}`);
  const [w, south, e, n] = v as Bbox;
  if ([w, e].some(x => x < -180 || x > 180) || [south, n].some(x => x < -85.06 || x > 85.06)) throw new Error(`範囲が地図の外です（経度 -180〜180、緯度 -85〜85）: ${s}`);
  if (w >= e || south >= n) throw new Error(`範囲の西と東、南と北が逆か同じです: ${s}`);
  return [w, south, e, n];
}

// A file that came from the network is not trusted until its header says it is the PMTiles that was asked for: version 3, vector
// tiles, the zoom asked for, and (for a region) bounds inside the box asked for.
export function checkHeader(bytes: Uint8Array, want: { maxzoom: number; bbox: Bbox | null }): void {
  if (bytes.length < 127 || new TextDecoder().decode(bytes.subarray(0, 7)) !== "PMTiles") throw new Error("PMTiles のファイルではありません（先頭が違う）");
  const h = bytesToHeader(bytes.slice(0, 127).buffer);
  if (h.specVersion !== 3) throw new Error(`PMTiles の版が 3 ではありません: ${h.specVersion}`);
  if (h.tileType !== TileType.Mvt) throw new Error(`ベクタータイル（MVT）ではありません: ${h.tileType}`);
  if (h.maxZoom !== want.maxzoom) throw new Error(`最大ズームが ${want.maxzoom} ではありません: ${h.maxZoom}`);
  const b = want.bbox, e = 0.01;
  if (b && !(h.minLon >= b[0] - e && h.minLat >= b[1] - e && h.maxLon <= b[2] + e && h.maxLat <= b[3] + e)) throw new Error(`範囲が ${b.join(",")} の外に出ています: ${[h.minLon, h.minLat, h.maxLon, h.maxLat].join(",")}`);
}

// Checks every file before anything is put, so a bad file leaves the place as it was; the record goes last, so the page never
// lists a file that is not there yet.
export async function place(files: { name: string; path: string; maxzoom: number; bbox: Bbox | null }[], record: string, io: { read(path: string): Promise<Uint8Array>; put(key: string, path: string): Promise<void> }): Promise<void> {
  for (const f of files) {
    try { checkHeader(await io.read(f.path), f); } catch (e) { throw new Error(`${f.name}: ${(e as Error).message}。何も置いていません`); }
  }
  for (const f of files) await io.put(`${f.name}.pmtiles`, f.path);
  await io.put("regions.json", record);
}

// A record read back (from the bucket or the data folder), checked before a new one is made from it.
export function regionsOf(value: unknown): MapRegions {
  const r = value as MapRegions, bad = (why: string): never => { throw new Error(`map/regions.json の形が違います: ${why}`); };
  if (!r || typeof r !== "object" || typeof r.build !== "string" || !BUILD.test(r.build) || typeof r.made !== "string" || !Array.isArray(r.files)) bad("build・made・files");
  r.files.forEach((f, i) => {
    if (!f || typeof f.name !== "string" || typeof f.bytes !== "number" || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) bad(`files[${i}]`);
    const world = i === 0;
    if (world ? f.name !== WORLD.name || f.maxzoom !== WORLD.maxzoom || f.bbox !== null : !REGION_NAME.test(f.name) || f.maxzoom !== REGION_ZOOM || !Array.isArray(f.bbox)) bad(`files[${i}]`);
    if (!world) parseBbox(f.bbox!.join(","));
  });
  if (!r.files.length || new Set(r.files.map(f => f.name)).size !== r.files.length) bad("files の名前");
  return r;
}

// What a failed AWS CLI call may show: the error's code (AccessDenied, NoSuchKey, ExpiredToken…) and nothing of its message,
// which can carry the bucket, an ARN with the account and the user, or an endpoint URL.
export const awsErrorCode = (stderr: string) => stderr.match(/An error occurred \(([A-Za-z0-9.]+)\)/)?.[1];
