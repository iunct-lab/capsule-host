import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD, HEADER_BYTES, awsErrorCode, JAPAN, REGION_NAME, REGION_ZOOM, WORLD, parseBbox, place, regionsOf, type Bbox, type MapRegions } from "../src/mapdata";

// Makes the footprint map's data and puts it where the host serves `/map/` from (#564, aws/README.md「足あとの地図の背景」):
//   build: the world to z8 and every region in the record (Japan when there is none) to z15, from one Protomaps build.
//   add:   one more region to z15, from the build the record already names.
// The files are cut with go-pmtiles' `pmtiles extract` (on PATH), checked, and only then put; the record goes last. Prints only
// `map/<name>.pmtiles <bytes> <sha256>` lines (and `map/regions.json` last), never the bucket, the account or a URL; an error
// says which step failed and, from AWS, only the error's code.
const usage = "Usage: bun aws/mapdata.ts build [--build YYYYMMDD] (--bucket BUCKET --profile PROFILE | --dir DIR)\n       bun aws/mapdata.ts add <name> <minLon,minLat,maxLon,maxLat> (--bucket BUCKET --profile PROFILE | --dir DIR)";
const args = process.argv.slice(2), flags = new Map<string, string>(), rest: string[] = [];
for (let i = 0; i < args.length; i++) args[i]!.startsWith("--") ? flags.set(args[i]!.slice(2), args[++i] ?? "") : rest.push(args[i]!);
const [command, ...positional] = rest, bucket = flags.get("bucket"), profile = flags.get("profile"), dir = flags.get("dir");
const stop = (message: string): never => { console.error(message); process.exit(1); };
if (!(command === "build" && positional.length === 0 || command === "add" && positional.length === 2) || [...flags.keys()].some(k => !["build", "bucket", "profile", "dir"].includes(k))) stop(usage);
if (!!dir === !!bucket || !!bucket !== !!profile) stop(usage);
if (flags.has("build") && (command !== "build" || !BUILD.test(flags.get("build")!))) stop(usage);
// Inside the run a failure throws, so the work folder is removed before the message is printed.
const fail = (message: string): never => { throw new Error(message); };
const region = "ap-northeast-1", source = (build: string) => `https://build.protomaps.com/${build}.pmtiles`;
const aws = async (what: string, ...a: string[]) => {
  const proc = Bun.spawn(["aws", ...a, "--profile", profile!, "--region", region, "--no-cli-pager"], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const why = awsErrorCode(err);
  return { ok: code === 0, out, why, err: `${what}に失敗しました（${why ?? "コードなし。認証が切れていれば aws sso login"}）` };
};

// The record now in place, or null when nothing has been made yet.
async function current(work: string): Promise<MapRegions | null> {
  if (dir) { const f = Bun.file(join(dir, "map", "regions.json")); return await f.exists() ? regionsOf(await f.json()) : null; }
  const r = await aws("map/regions.json を読む", "s3api", "get-object", "--bucket", bucket!, "--key", "map/regions.json", join(work, "current.json"));
  if (!r.ok) return r.why === "NoSuchKey" ? null : fail(r.err);
  return regionsOf(JSON.parse(await readFile(join(work, "current.json"), "utf8")));
}
// The newest build: Protomaps makes one a day, so walk back from today until one answers.
async function latest(): Promise<string> {
  for (let d = 0; d < 14; d++) {
    const build = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
    if ((await fetch(source(build), { method: "HEAD" })).status === 200) return build;
  }
  return fail("直近 14 日の Protomaps の build が見つかりません。--build YYYYMMDD で日付を渡してください");
}
async function extract(build: string, path: string, maxzoom: number, bbox: Bbox | null) {
  console.error(`切り出し中: ${path.split("/").at(-1)}（z${maxzoom}${bbox ? `、${bbox.join(",")}` : ""}、build ${build}）`);
  const proc = Bun.spawn(["pmtiles", "extract", source(build), path, ...(bbox ? [`--bbox=${bbox.join(",")}`] : []), `--maxzoom=${maxzoom}`, "--download-threads=8"], { stdout: "ignore", stderr: "ignore" });
  // Its own messages (the progress, a failed request's URL, the work path) are not passed on.
  const code = await proc.exited;
  if (code !== 0) fail(`pmtiles extract が失敗しました（終了コード ${code}、build ${build}）。何も置いていません`);
}
async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function head(path: string) {
  const f = await open(path, "r");
  try { const b = new Uint8Array(HEADER_BYTES); const { bytesRead } = await f.read(b, 0, HEADER_BYTES, 0); return b.subarray(0, bytesRead); } finally { await f.close(); }
}

const work = await mkdtemp(join(tmpdir(), "capsule-mapdata-"));
try {
  const before = await current(work);
  let build: string, made: { name: string; maxzoom: number; bbox: Bbox | null }[], kept: MapRegions["files"];
  if (command === "build") {
    build = flags.get("build") ?? await latest();
    const regions = before ? before.files.slice(1).map(f => ({ name: f.name, bbox: f.bbox! })) : [JAPAN];
    made = [WORLD, ...regions.map(r => ({ ...r, maxzoom: REGION_ZOOM }))]; kept = [];
  } else {
    const [name, box] = positional as [string, string];
    if (!REGION_NAME.test(name)) fail(`地域の名前は英小文字・数字・ハイフン（world・regions 以外）にしてください: ${name}`);
    const was = before ?? fail("map/regions.json がありません。先に build で作ってください（地域は同じ build から切るため）");
    build = was.build; made = [{ name, maxzoom: REGION_ZOOM, bbox: parseBbox(box) }];
    // Adding a name that is there already cuts it again with the new box.
    kept = was.files.filter(f => f.name !== name);
  }
  const files = made.map(f => ({ ...f, path: join(work, `${f.name}.pmtiles`) }));
  for (const f of files) await extract(build, f.path, f.maxzoom, f.bbox);
  const done = await Promise.all(files.map(async f => ({ name: f.name, maxzoom: f.maxzoom, bbox: f.bbox, bytes: Bun.file(f.path).size, sha256: await sha256(f.path) })));
  const record: MapRegions = { build, made: new Date().toISOString(), files: [...kept, ...done] };
  const recordPath = join(work, "regions.json");
  await writeFile(recordPath, JSON.stringify(regionsOf(record), null, 2) + "\n");
  await place(files, recordPath, {
    read: head,
    put: async (key, path) => {
      const sum = done.find(f => `${f.name}.pmtiles` === key)?.sha256 ?? await sha256(path), bytes = Bun.file(path).size;
      if (dir) { await mkdir(join(dir, "map"), { recursive: true }); await copyFile(path, join(dir, "map", key)); }
      else {
        const cp = await aws(`map/${key} を置く`, "s3", "cp", path, `s3://${bucket}/map/${key}`, "--only-show-errors", "--checksum-algorithm", "SHA256", "--metadata", `sha256=${sum}`, ...(key === "regions.json" ? ["--content-type", "application/json"] : []));
        if (!cp.ok) fail(cp.err);
        // What S3 now holds must be what was checked here: the same size and the hash given with it.
        const h = await aws(`map/${key} を確かめる`, "s3api", "head-object", "--bucket", bucket!, "--key", `map/${key}`, "--output", "json");
        if (!h.ok) fail(h.err);
        const meta = JSON.parse(h.out) as { ContentLength: number; Metadata?: { sha256?: string } };
        if (meta.ContentLength !== bytes || meta.Metadata?.sha256 !== sum) fail(`map/${key} の大きさかハッシュが手元と一致しません（置いたものを確かめてください）`);
      }
      console.log(`map/${key} ${bytes} ${sum}`);
    },
  });
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
finally { await rm(work, { recursive: true, force: true }); }
