import { join } from "node:path";
import { REGION_NAME, WORLD } from "./mapdata";

// The local host's answer under /map/ (src/main.ts), from the data folder's map/: the record map/regions.json, and the files
// it may list (the world and regions by name, nothing else). Apart from main.ts so that it can be tested without starting the
// server. Undefined for any other path.
export function mapRoute(dir: string, pathname: string, rangeHeader: string | null): Promise<Response> | undefined {
  if (pathname === "/map/regions.json") return mapRecord(join(dir, "regions.json"));
  const name = pathname.match(/^\/map\/(.+)\.pmtiles$/)?.[1];
  if (name && (name === WORLD.name || REGION_NAME.test(name))) return mapTiles(join(dir, `${name}.pmtiles`), rangeHeader);
}
async function mapRecord(path: string): Promise<Response> {
  const file = Bun.file(path);
  return await file.exists() ? new Response(file, { headers: { "Content-Type": "application/json" } }) : Response.json({ error: "地図データがありません" }, { status: 404 });
}
// A map file read a range at a time, as S3 answers on AWS.
export async function mapTiles(path: string, rangeHeader: string | null): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return Response.json({ error: "地図データがありません" }, { status: 404 });
  const range = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range) return new Response(file, { headers: { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" } });
  const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : file.size - 1, file.size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
  return new Response(file.slice(start, end + 1), { status: 206, headers: { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${file.size}` } });
}
