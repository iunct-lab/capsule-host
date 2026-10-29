import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CloudHost, secure } from "./cloud-host";
import { LocalD1 } from "./local-d1";
import { isLoopback, localIdentity } from "./local-identity";
import { emptyTrip } from "./template";
import { storage } from "./storage";
import { mapRoute } from "./map-tiles";
import { LocalMediaStore } from "./media-store";

const root = resolve(import.meta.dir, "..");
const { data, path, key } = storage();
const hostname = process.env.CAPSULE_BIND ?? "127.0.0.1";
const port = Number(process.env.CAPSULE_PORT ?? 47840);
// localhost, not 127.0.0.1: a browser refuses an IP literal as a passkey RP ID, and the server still binds to the loopback address.
const origin = process.env.CAPSULE_ORIGIN ?? `http://localhost:${port}`;
const local = isLoopback(origin);
if (local && hostname !== "127.0.0.1" && hostname !== "::1") throw new Error("ローカルプレビューはループバックでのみ起動できます");
const build = await Bun.build({ entrypoints: [`${root}/src/client.ts`], target: "browser", minify: true });
if (!build.success) throw new Error(build.logs.join("\n"));
// The footprint map's parts, apart from app.js as on AWS (aws/build.ts).
const mapBuild = await Bun.build({ entrypoints: [`${root}/src/map.ts`], target: "browser", format: "esm", minify: true });
if (!mapBuild.success) throw new Error(mapBuild.logs.join("\n"));
const assets = new Map([
  ["/index.html", { body: readFileSync(`${root}/src/index.html`, "utf8"), type: "text/html; charset=utf-8" }],
  ["/app.js", { body: await build.outputs[0]!.text(), type: "text/javascript; charset=utf-8" }],
  ["/app.css", { body: readFileSync(`${root}/src/style.css`, "utf8"), type: "text/css; charset=utf-8" }],
  ["/map.js", { body: await mapBuild.outputs[0]!.text(), type: "text/javascript; charset=utf-8" }],
  ["/maplibre-worker.mjs", { body: readFileSync(`${root}/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs`, "utf8"), type: "text/javascript; charset=utf-8" }],
  ["/map.css", { body: readFileSync(`${root}/node_modules/maplibre-gl/dist/maplibre-gl.css`, "utf8"), type: "text/css; charset=utf-8" }],
]);
const start = process.env.CAPSULE_TRIP_START ?? new Date().toISOString().slice(0, 10);
const db = new LocalD1(path); chmodSync(path, 0o600);
// The host's clock. Only a loopback server may move it forward (POST /dev/clock below); it is not saved, so a restart puts it back.
let advanced = 0;
const clock = () => Date.now() + advanced;
// The same CloudHost as on AWS; only the store differs. A loopback server may make a trip from its own page and hand out a
// creator enrollment link (to a request without a creator's cookie alone); /recover and the creator registry's list and revoke
// (the IAM publisher's on AWS) stay closed here (src/local-identity.ts).
const host = new CloudHost({ DB: db, MEDIA: new LocalMediaStore(`${data}/media`), CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, CAPSULE_PHOTOS: process.env.CAPSULE_PHOTOS }, clock, localIdentity(origin));
const preview = local ? emptyTrip(start) : undefined;
// /dev/clock lets verify:ui move the host's clock instead of waiting out the passkey check's 5 minutes, the per-minute counts
// and a footprint's minute in real time. Only a loopback host has it; elsewhere the path goes on to CloudHost and is a 404.
// JSON only, so another site's page cannot send it without a preflight this server never answers.
async function moveClock(req: Request): Promise<Response> {
  if (req.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") return Response.json({ error: "JSON で送ってください" }, { status: 415 });
  const advance = await req.json().then((body: { advance?: unknown }) => body?.advance, () => undefined);
  if (!Number.isInteger(advance) || (advance as number) < 0 || (advance as number) > 3600000) return Response.json({ error: "advance は 0 以上 3600000 以下の整数（ミリ秒）です" }, { status: 400 });
  advanced += advance as number;
  return Response.json({ now: clock() });
}
// Routes production serves elsewhere (static files from S3/CloudFront) or not at all (preview). Kept out of CloudHost so the Lambda does not carry them.
function localRoute(req: Request, url: URL): Response | Promise<Response> | undefined {
  if (req.method !== "GET") return;
  if (url.pathname === "/health") return Response.json({ ok: true });
  // A creator's screen is answered by CloudHost, as on AWS (the creator card, the creators they delegated to).
  if (url.pathname === "/v1/account" && !req.headers.get("cookie")?.includes("capsule_creator=")) return (async () => Response.json({ signedIn: false, canCreate: local, localOnly: true, assistKey: local && await host.keys.get("local") !== null }))();
  if (url.pathname === "/v1/preview" && preview) return Response.json(preview);
  if (url.pathname === "/v1/preview-theme.css" && preview) return new Response(`:root{--accent:${preview.spec.theme.accent}}`, { headers: { "Content-Type": "text/css" } });
  // The map data, if this machine has it (README の「ローカル開発」).
  const tiles = mapRoute(`${data}/map`, url.pathname, req.headers.get("Range"));
  if (tiles) return tiles;
  const asset = assets.get(url.pathname === "/" || /^\/c\/[a-f0-9]{32}$/.test(url.pathname) ? "/index.html" : url.pathname);
  if (asset) return new Response(asset.body, { headers: { "Content-Type": asset.type } });
}
await host.sweep(clock());
const server = Bun.serve({
  hostname, port, maxRequestBodySize: 2 * 1024 * 1024,
  fetch: async (req, server) => {
    // Bun.serve speaks plain http even when a proxy terminates TLS for an https origin, so the host name is what is compared
    // (as the local Host did); CloudHost then sees the request under the configured origin. The path is copied onto that origin
    // rather than resolved against it: "//elsewhere/x" resolved as a relative URL would carry its own host.
    const seen = new URL(req.url), url = new URL(origin), ip = server.requestIP(req)?.address ?? "unknown";
    url.pathname = seen.pathname; url.search = seen.search;
    if (seen.host !== url.host) return secure(Response.json({ error: "ホスト名が一致しません" }, { status: 403 }), origin);
    const moving = local && req.method === "POST" && url.pathname === "/dev/clock";
    const served = moving ? undefined : localRoute(req, url);
    // A map asks for many ranges as it is moved, so its tiles have their own count and never use up the API's (src/cloud-host.ts).
    const tiles = url.pathname.startsWith("/map/");
    if (served || moving) return secure(await host.store.rate(host.digest(`${tiles ? "tiles" : "ip"}:${ip}`), tiles ? 3000 : 300, clock()) ? await (served ?? moveClock(req)) : Response.json({ error: "操作が多すぎます。1分後に再試行してください" }, { status: 429 }), origin);
    // As in src/aws-handler.ts: the client address comes from the connection, never from a header the client sent.
    const headers = new Headers(req.headers); headers.set("cf-connecting-ip", ip);
    return host.fetch(new Request(url, { method: req.method, headers, body: req.body }));
  },
});
const cleanup = setInterval(() => host.sweep(clock()), 60000);
const stop = () => { clearInterval(cleanup); server.stop(); db.close(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
console.log(`Trip Capsule: ${origin}${local ? " / ローカルプレビュー" : ""}`);
