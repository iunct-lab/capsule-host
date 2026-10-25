import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { invoke } from "./invoke";
import { fakeAuthenticator, testTrip } from "../src/test-fixture";
import { regionsOf } from "../src/mapdata";
import { openName, openPoint, sealName, sealPoint, openTrip, resealTrip, sealOperation, sealMove, confirmationCodes, matchesCommitment, newAttempt, newHandoffKeys, newSeatKeys, newTripKey, seatPublic, signEdge, unwrapSeatSecret, unwrapTripKey, wrapSeatSecret, wrapTripKey, acceptRekey, openField, reachableSeats, resealAll, signRekey, type SeatKeys } from "../src/trip-keys";
import { assistSealingKey, newMemoKey, open as openEntryText, openEntry, seal as sealText, sealEntry, unwrapMemoKey, wrapMemoKey, wrappingKey, type SealedEntry } from "../src/private-entries";

// Publishes a disposable fictional capsule through IAM Lambda Invoke, verifies it through CloudFront, then purges it.
// Never prints capability links/cookies. Run from a country listed in the stack's ClaimCountries.
const [origin, functionName, profile, region = "ap-northeast-1"] = process.argv.slice(2);
if (!origin || !functionName || !profile) throw new Error("Usage: bun aws/verify.ts https://DISTRIBUTION.cloudfront.net function profile [region]");
let capsuleId = "", owner = "";
// When this run began, and every secret it handled (an invite's secret, a session cookie's value): the logs are read for
// the requests since, and none of these may be in them (#608). Values are only compared, never printed.
const started = Date.now() - 60000, secrets: string[] = [];
// The second disposable capsule, published to be terminated: if a check fails before that, `finally` terminates it.
let spare = "";
// The third, sealed under its trip key (#691), then the fourth, the plain one moved (#694), and its owner's cookie (for the scene): if a check fails before its purge, `finally` terminates it by id.
let sealedId = "", sealedOwner = "";
// The third's id kept past its purge: after the line, the log check looks for its 403 and 429 (#893).
let sealedTripId = "";
// Owner links not yet redeemed, newest last: if a check fails before the owner seat is taken, `finally` takes it to purge.
const unredeemed: string[] = [];
const title = "AWS動作確認用（自動削除）";
// If-Match is API-only: S3 would evaluate it against the asset's own ETag.
const request = (path: string, method = "GET", body?: unknown, cookie = owner, revision = 1, source = origin) => fetch(origin + path, { method, headers: { Origin: source, "Content-Type": "application/json", ...(path.startsWith("/v1/") ? { "If-Match": `"${revision}"` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const api = (action: string) => `/v1/c/${capsuleId}${action}`;
const redeem = (url: string, cookie = "") => { const secret = new URLSearchParams(new URL(url).hash.slice(1)).get("k"); if (secret) secrets.push(secret); return request(api("/sessions"), "POST", { secret }, cookie); };
async function join(url: string) {
  assert.equal(new URL(url).origin, origin);
  const r = await redeem(url); assert.equal(r.status, 200);
  assert.match(r.headers.get("Set-Cookie")!, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = r.headers.get("Set-Cookie")!.split(";")[0]!; secrets.push(cookie.slice(cookie.indexOf("=") + 1)); return cookie;
}
// The owner's important actions need a passkey check in the last five minutes. The ceremony itself is covered by the unit tests
// and verify:ui; here a software authenticator for this origin registers the owner browser's first passkey (which counts as the
// check) or checks with it.
const devices = new Map<string, ReturnType<typeof fakeAuthenticator>>();
async function stepUp(ui = "") {
  const { challenge } = await (await request(api("/passkey/challenge") + ui, "POST", {}, "")).json(), device = devices.get(owner), fresh = fakeAuthenticator({ origin });
  const r = device ? await request(api("/passkey/verify") + ui, "POST", { challenge, id: device.id, ...device.assert(challenge) }) : await request(api("/passkey") + ui, "POST", { challenge, ...fresh.register(challenge) });
  assert.equal(r.status, 200); if (!device) devices.set(owner, fresh);
}
const cliIn = async (where: string, ...args: string[]) => {
  const proc = Bun.spawn(["aws", ...args, "--profile", profile, "--region", where, "--no-cli-pager", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  // The CLI's stderr names ARNs, so it carries the account id, and this output gets pasted into issues.
  if (code !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} に失敗しました（終了コード ${code}。詳細はこのコマンドを手で実行して確認してください）`);
  return JSON.parse(out);
};
const cli = (...args: string[]) => cliIn(region, ...args);
// Every capsule's payload as stored in DynamoDB, joined from its chunks: what an operator with the table's read permission reads.
async function storedPayloads() {
  const table = await cli("lambda", "get-function-configuration", "--function-name", functionName!, "--query", "Environment.Variables.CAPSULE_TABLE") as string;
  const { Items } = await cli("dynamodb", "scan", "--table-name", table, "--consistent-read", "--filter-expression", "begins_with(sk, :c)", "--expression-attribute-values", '{":c":{"S":"chunk:"}}') as { Items: Array<{ pk: { S: string }; sk: { S: string }; bytes: { B: string } }> };
  const payloads = new Map<string, Array<[number, Buffer]>>();
  for (const i of Items) payloads.set(i.pk.S, [...payloads.get(i.pk.S) ?? [], [Number(i.sk.S.slice("chunk:".length)), Buffer.from(i.bytes.B, "base64")]]);
  return [...payloads.values()].map(parts => Buffer.concat(parts.sort((x, y) => x[0] - y[0]).map(([, b]) => b)).toString());
}
// The Web Function's own address is read from the stack's output, never passed in: a run that was handed nothing would skip the check
// that the function refuses a caller who bypasses CloudFront (#610). Not printed.
const stackName = await cli("lambda", "get-function", "--function-name", functionName, "--query", 'Tags."aws:cloudformation:stack-name"') as string | null;
if (!stackName) throw new Error("この関数は CloudFormation のスタックに属していません");
const webEndpoint = await cli("cloudformation", "describe-stacks", "--stack-name", stackName, "--query", "Stacks[0].Outputs[?OutputKey=='WebEndpoint'].OutputValue | [0]") as string | null;
if (!webEndpoint) throw new Error("スタック出力 WebEndpoint がありません。aws/template.yaml を配置してください");
// The line (SealedFrom, aws/README.md) is read from the Host's own settings, never passed in. After it, the plain trip this run
// publishes opens to nothing but its owner's move (docs/design/trip-e2e.md §5): its scenes give way to checks of the line, and
// the sealed and moved trips' scenes keep to what such a trip allows before its move (#893). Its time is not printed.
const sealedFrom = await cli("lambda", "get-function-configuration", "--function-name", functionName, "--query", "Environment.Variables.CAPSULE_SEALED_FROM") as string | null;
if (sealedFrom && Number.isNaN(Date.parse(sealedFrom))) throw new Error("CAPSULE_SEALED_FROM は時刻として読めません（Host も起動のときに断ります）");
const afterLine = Boolean(sealedFrom) && Date.parse(sealedFrom!) <= Date.now(), ui = afterLine ? "?ui=2" : "";
console.log(afterLine ? "SealedFrom: set (trips published by this run are after the line)" : sealedFrom ? "SealedFrom: set, not reached yet (trips published by this run are before the line)" : "SealedFrom: not set");
try {
  const page = await request("/"); assert.equal(page.status, 200); assert.match(await page.text(), /app.js/);
  assert.match(page.headers.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
  // The only outside origin the page may reach: Anthropic, for a sealed trip's 「ここで直す」 sent by the browser (#692).
  assert.match(page.headers.get("Content-Security-Policy")!, /(^|; )connect-src 'self' https:\/\/api\.anthropic\.com(;|$)/);
  // CloudFront's page lets the trip use the position (足あと) and keeps the camera and microphone closed, as the host does.
  assert.equal(page.headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=(self)");
  for (const path of ["/app.js", "/app.css"]) { const r = await request(path); assert.equal(r.status, 200); assert.ok((await r.text()).length > 1000); }
  // The page script carries its packages' licence notices, as aws/build.ts puts them (#841).
  assert.ok((await (await request("/app.js")).text()).startsWith("/*! app.js carries:\n"), "app.js does not start with its notices");
  // The footprint map's parts and map data come from this origin only; the browser reads the PMTiles a range at a time.
  for (const path of ["/map.js", "/maplibre-worker.mjs", "/map.css"]) { const r = await request(path); assert.equal(r.status, 200, path); assert.ok((await r.text()).length > 1000, path); }
  assert.match((await request("/maplibre-worker.mjs")).headers.get("Content-Type")!, /javascript/);
  // CloudFront compresses the page files (Compress, #569); Bun's fetch would undo it, so read the encoding as sent. index.html
  // is left out: CloudFront compresses only files of 1,000 B or more.
  for (const path of ["/app.js", "/app.css", "/map.js", "/maplibre-worker.mjs", "/map.css"]) {
    const r: Response = await fetch(origin + path, { headers: { "Accept-Encoding": "br, gzip" }, decompress: false }); await r.arrayBuffer();
    assert.equal(r.status, 200, path); assert.match(r.headers.get("Content-Encoding") ?? "", /^(br|gzip)$/, path);
  }
  // The map files are the ones the record lists (bun aws/mapdata.ts, #564): the world first, each the size it was made.
  const record = await request("/map/regions.json"); assert.equal(record.status, 200, "/map/regions.json");
  const regions = regionsOf(await record.json()); assert.match(regions.build, /^\d{8}$/); assert.equal(regions.files[0]!.name, "world");
  for (const { name, bytes } of regions.files) {
    const path = `/map/${name}.pmtiles`;
    // A host that ignored the range would send the whole file (gigabytes): judge the status and range before reading, and stop
    // reading once more than the range has come.
    const r: Response = await fetch(origin + path, { headers: { Range: "bytes=0-1023" } }), reader = r.body!.getReader(), parts: Uint8Array[] = [];
    if (r.status !== 206 || !/^bytes 0-1023\/\d+$/.test(r.headers.get("Content-Range") ?? "")) void reader.cancel().catch(() => undefined);
    assert.equal(r.status, 206, path); assert.equal(r.headers.get("Content-Range"), `bytes 0-1023/${bytes}`, path);
    for (let n = 0; n <= 1024;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
    await reader.cancel(); const head = Buffer.concat(parts);
    assert.equal(head.length, 1024, path); assert.equal(head.subarray(0, 7).toString(), "PMTiles", path);
  }
  // The browser revalidates the page files on every open, so a deploy is not hidden behind a previous app.js; the API is never stored.
  assert.equal(page.headers.get("Cache-Control"), "no-cache");
  for (const path of ["/c/00000000000000000000000000000000", "/app.js", "/app.css"]) { const r = await request(path); assert.equal(r.status, 200, path); assert.equal(r.headers.get("Cache-Control"), "no-cache", path); }
  assert.equal((await request("/v1/account", "GET", undefined, "")).headers.get("Cache-Control"), "no-store");
  const seed = testTrip(); seed.spec.title = title;
  // Keep this fictional trip active when the fixed item dates are in the past, so participant checks remain permitted.
  const end = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  if (end > seed.spec.trip.endsOn) seed.spec.trip.endsOn = end;
  const purge = new Date(+new Date(seed.spec.trip.endsOn) + 30 * 86400000).toISOString();
  if (+new Date(purge) > +new Date(seed.spec.lifecycle.purgeAt)) seed.spec.lifecycle.purgeAt = purge;
  // A second item on the first day, so that day has an order to change. It has an end, which a move carries along.
  seed.document.items.push({ id: "checkin", title: "チェックイン", day: "2026-09-24", startsAt: "2026-09-24T15:00:00+09:00", endsAt: "2026-09-24T16:00:00+09:00", kind: "stay", status: "confirmed", revision: 1 });
  // Public HTTP must never publish without a creator's passkey sign-in; the IAM-authorized invoke can.
  assert.equal((await request("/v1/publish", "POST", { ...seed, confirm: true }, "")).status, 401);
  // Bypassing CloudFront would let a caller forge the viewer country, so the function refuses a call without CloudFront's signature.
  // With the headers a caller would forge, so a function that stopped asking for CloudFront's signature would not pass on a missing header alone.
  assert.equal((await fetch(webEndpoint + "/v1/account", { headers: { "CloudFront-Viewer-Address": "203.0.113.9:1", "CloudFront-Viewer-Country": "JP" } })).status, 403);
  const operationId = randomBytes(16).toString("hex");
  const created = await invoke(functionName, profile, region, { payload: { ...seed, confirm: true, operationId } }); assert.equal(created.statusCode, 201);
  capsuleId = created.body.id; unredeemed.push(created.body.url);
  // No other site may read the API: no response through CloudFront names an allowed origin, and a preflight is not answered
  // with a 2xx.
  const evil = "https://evil.example", cors = [await request("/v1/account", "GET", undefined, ""), await request(api("/document"), "POST", { type: "notes", body: "x" }, "", 1, evil)];
  for (const r of cors) assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  const preflight = await fetch(origin + api(""), { method: "OPTIONS", headers: { Origin: evil, "Access-Control-Request-Method": "PATCH" } });
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), null); assert.ok(preflight.status < 200 || preflight.status >= 300, `OPTIONS ${preflight.status}`);
  // A publisher that lost the response retries the identical call: the same trip, not a second one. While nobody holds the
  // owner seat, the retry carries a fresh owner link and the lost one stops working; once the seat is held, no link.
  const retried = await invoke(functionName, profile, region, { payload: { ...seed, confirm: true, operationId } });
  assert.equal(retried.statusCode, 200); assert.equal(retried.body.replayed, true); assert.equal(retried.body.id, capsuleId); assert.ok(retried.body.url); unredeemed.push(retried.body.url);
  assert.equal((await redeem(created.body.url)).status, 401);
  owner = await join(retried.body.url);
  const replayed = await invoke(functionName, profile, region, { payload: { ...seed, confirm: true, operationId } });
  assert.equal(replayed.statusCode, 200); assert.equal(replayed.body.replayed, true);
  assert.equal(replayed.body.id, capsuleId); assert.equal(replayed.body.url, undefined);
  // The owner seat is bound to the first browser; the same link is dead for anyone else.
  assert.equal((await redeem(retried.body.url)).status, 401);
  assert.equal((await redeem(retried.body.url, owner)).status, 200);
  const invite = { role: "participant", label: "AWS確認用", seats: 2, expiresAt: seed.spec.lifecycle.purgeAt, confirm: true };
  const here = { type: "add", lat: 35.6812, lng: 139.7671, accuracy: 20 };
  // The plain trip's members, made in the first of its scenes and used in the second.
  let participant = "", second = "", editor = "", viewerLink = "", g: any, listed: any;
  // The plain trip's scenes, in two parts around the sealed and moved trips' (not indented, so the diff keeps to what changed).
  plainScenes: {
  if (afterLine) break plainScenes;
  const get = await request(api("")); assert.equal(get.status, 200); assert.equal(get.headers.get("ETag"), '"1"');
  // The owner's cookie alone does not hand out a seat; after the passkey check it does.
  const unchecked = await request(api("/grants"), "POST", invite); assert.equal(unchecked.status, 428); assert.equal((await unchecked.json()).error, "パスキーで本人確認してください");
  await stepUp();
  const issued = await request(api("/grants"), "POST", invite);
  assert.equal(issued.status, 201); g = await issued.json(); participant = await join(g.url); second = await join(g.url);
  // A viewer's invite for the footprint check, taken after the minute below: joining counts against the login limit.
  viewerLink = (await (await request(api("/grants"), "POST", { ...invite, role: "viewer", label: "AWS確認用（閲覧）", seats: 1 })).json()).url as string;
  editor = await join((await (await request(api("/grants"), "POST", { ...invite, role: "editor", label: "AWS確認用（編集）", seats: 1 })).json()).url);
  // Owner-only actions are refused to the roles below it, each by its own cookie.
  assert.equal((await request(api("/spec"), "PATCH", { spec: seed.spec, confirm: true }, editor)).status, 403);
  assert.equal((await request(api("/members"), "PATCH", { id: "x", label: "x" }, editor)).status, 403);
  // The owner reads who issued and took which invite, newest first; nobody else reads it.
  const history = await request(api("/history")); assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).slice(0, 2).map((a: any) => [a.event, a.role, a.label]), [["sessions", "editor", "AWS確認用（編集）"], ["grants", "editor", "AWS確認用（編集）"]]);
  assert.equal((await request(api("/history"), "GET", undefined, editor)).status, 403);
  // A cookie alone cannot swap the owner's passkey for another, even with the owner's check for that invite still fresh.
  const swap = await (await request(api("/passkey/challenge"), "POST", {}, "")).json(), thief = fakeAuthenticator({ origin });
  const swapped = await request(api("/passkey"), "POST", { challenge: swap.challenge, ...thief.register(swap.challenge) });
  assert.equal(swapped.status, 401); assert.equal((await swapped.json()).error, "パスキーで本人確認してください");
  assert.equal((await redeem(g.url)).status, 401);
  listed = (await (await request(api("/grants"))).json()).find((x: any) => x.id === g.grantId);
  assert.equal(listed.claimed, 2); assert.equal(listed.members.length, 2);
  assert.equal((await request(api("/document"), "PATCH", { type: "notes", body: "unauthorized" }, participant)).status, 403);
  // The 準備 list, the 費用メモ and the 候補・相談 posts are changed by the owner and editors only (refused before the post is
  // looked for); a participant may still tick (below).
  for (const op of [{ type: "checklist", checklist: [] }, { type: "budget", budget: [] }, { type: "rewrite", list: "suggestions", id: "x", body: "x" }, { type: "remove", list: "comments", id: "x" }]) assert.equal((await request(api("/document"), "PATCH", op, participant)).status, 403);
  assert.equal((await request(api("/document"), "PATCH", { type: "check", id: "c3", done: true }, owner, 1, "https://evil.example")).status, 403);
  assert.equal((await request(api("/document"), "PATCH", { type: "check", id: "c3", done: true }, participant)).status, 200);
  assert.equal((await request(api("/document"), "PATCH", { type: "check", id: "c3", done: false }, owner)).status, 409);
  // A member's own entry, sealed as the screen seals it (src/private-entries.ts): random bytes stand in for the passkey's PRF
  // output, the memo key is wrapped and handed in after the seat's passkey, then a plan whose title, body and place hold a
  // marker is put, and a diary entry holding it is applied. The member reads both back and opens them; the owner's trip and the ZIP hold neither the marker nor its
  // ciphertext. It moves no revision.
  const marker = `scan-marker-${randomBytes(8).toString("hex")}`, seat = fakeAuthenticator({ origin }), prf = randomBytes(32);
  const { challenge: seated } = await (await request(api("/passkey/challenge"), "POST", {}, "")).json();
  assert.equal((await request(api("/passkey"), "POST", { challenge: seated, ...seat.register(seated) }, participant)).status, 200);
  const memo = await newMemoKey(), wrapped = await wrapMemoKey(memo, await wrappingKey(prf, capsuleId), capsuleId);
  assert.equal((await request(api("/private"), "PATCH", { type: "key", wrapped }, participant)).status, 200);
  const plan = { id: "aws-private", kind: "item" as const, day: "2026-09-25", startsAt: "2026-09-25T10:00:00+09:00", title: `題 ${marker}`, body: `本文 ${marker}`, place: { label: `場所 ${marker}` } };
  const sealed = await sealEntry(memo, plan);
  assert.equal((await request(api("/private"), "PATCH", { type: "put", entry: sealed }, participant)).status, 200);
  // A second one, as 「チャットで直す」 applies a chat's answer (#427): sealed the same way and sent in one apply, all or none.
  const diary = { id: "aws-private-diary", kind: "diary" as const, day: "2026-09-25", title: "", body: `日記 ${marker}` };
  assert.equal((await request(api("/private"), "PATCH", { type: "apply", put: [await sealEntry(memo, diary)], remove: [] }, participant)).status, 200);
  const kept = (await (await request(api(""), "GET", undefined, participant)).json()).private as SealedEntry[];
  assert.equal(kept.length, 2); assert.ok(!JSON.stringify(kept).includes(marker));
  const opened = await unwrapMemoKey(wrapped, await wrappingKey(prf, capsuleId), capsuleId);
  assert.deepEqual(await Promise.all(kept.map(k => openEntry(opened, k))), [plan, diary]);
  const ownerView = await request(api("")); assert.equal(ownerView.headers.get("ETag"), '"2"'); const seen = await ownerView.text(); assert.ok(!seen.includes(marker) && !seen.includes(sealed.body));
  // The trip's key (#689, docs/design/trip-e2e.md §2.1): the owner's browser makes it and the seat's key pair, and hands in the
  // public keys, the trip key wrapped to the seat's X25519 key, and the private keys wrapped by a PRF output (random bytes
  // stand in), after the passkey check. The seat reads them back and opens them; a participant's first put is refused; the
  // grants list shows public keys only. It moves no revision. Their plain bytes are looked for in the table below (dev).
  // Its passkey check counts against the login limit of 15 a minute with the scenes around it: it starts in a fresh minute.
  await new Promise(r => setTimeout(r, 61000 - Date.now() % 60000));
  const seatKeys = await newSeatKeys(), seatPub = await seatPublic(seatKeys), tripKey = await newTripKey(), keyPrf = randomBytes(32);
  const tripWrap = await wrapTripKey(tripKey, seatPub.x25519, capsuleId, 1), seatWrap = await wrapSeatSecret(seatKeys, keyPrf, capsuleId);
  const keyBody = { type: "seat", ...seatPub, ephemeral: tripWrap.ephemeral, generation: 1, wrapped: tripWrap.wrapped, secret: seatWrap };
  assert.equal((await request(api("/keys"), "PATCH", keyBody, participant)).status, 403);
  await stepUp(); assert.equal((await request(api("/keys"), "PATCH", keyBody)).status, 200);
  assert.equal((await request(api("/keys"), "PATCH", { ...keyBody, wrapped: "plain" })).status, 400);
  const keyed = await (await request(api(""))).json();
  assert.equal(keyed.keyed, true); assert.deepEqual({ ...keyed.seatKey, secret: undefined }, { ...seatPub, generation: 1, wrapped: tripWrap.wrapped, ephemeral: tripWrap.ephemeral, secret: undefined });
  const keyBack = await unwrapSeatSecret(keyed.seatKey.secret, keyPrf, capsuleId);
  const tripBack = await unwrapTripKey(keyed.seatKey.wrapped, keyed.seatKey.ephemeral, keyBack.x25519, capsuleId, 1);
  assert.equal(await openEntryText(tripBack, await sealText(tripKey, "trip key check", "aws/keys"), "aws/keys"), "trip key check");
  assert.equal((await (await request(api(""), "GET", undefined, participant)).json()).seatKey, null);
  const grantsText = await (await request(api("/grants"))).text(), selfSeat = JSON.parse(grantsText).flatMap((g: { members: Array<Record<string, unknown>> }) => g.members).find((m: { self: boolean }) => m.self);
  assert.deepEqual(selfSeat.publicKey, seatPub); assert.ok(!("seatKey" in selfSeat) && !("secret" in selfSeat));
  assert.ok(![tripWrap.wrapped, tripWrap.ephemeral, seatWrap.x25519, seatWrap.ed25519].some(v => grantsText.includes(v)));
  assert.equal((await request(api(""))).headers.get("ETag"), '"2"');
  // The handoff by confirmation codes (#690, docs/design/trip-e2e.md §2.1 案 A), both screens played here with the same functions:
  // the participant waits with a commitment, the owner gives a throwaway key, the participant reveals its public keys, both
  // compute the two codes from what each kept (they match), the owner wraps the trip key to the participant's public key and
  // both sign the other's keys. A seat with no key cannot give (403); the host computes no code and holds no plain key.
  const pSeat = await newSeatKeys(), pPub = await seatPublic(pSeat), tried = await newAttempt(pPub, capsuleId);
  const waited = await request(api("/keys"), "PATCH", { type: "wait", commitment: tried.commitment }, participant); assert.equal(waited.status, 200);
  const attemptId = (await waited.json()).handoff.attempt as string;
  const waitingList = (await (await request(api(""))).json()).waiting as Array<{ id: string; handoff: { commitment?: string } | null }>;
  const memberId = waitingList.find(w => w.handoff?.commitment === tried.commitment)!.id;
  assert.equal((await request(api("/keys"), "PATCH", { type: "give", seat: memberId, attempt: attemptId, ephemeral: tripWrap.ephemeral }, second)).status, 403);
  const throwaway = await newHandoffKeys();
  assert.equal((await request(api("/keys"), "PATCH", { type: "give", seat: memberId, attempt: attemptId, ephemeral: throwaway.ephemeral })).status, 200);
  const given = (await (await request(api(""), "GET", undefined, participant)).json()).handoff;
  assert.equal(given.giver.ephemeral, throwaway.ephemeral);
  assert.equal((await request(api("/keys"), "PATCH", { type: "reveal", attempt: attemptId, ...pPub, nonce: tried.nonce }, participant)).status, 200);
  const revealed = (await (await request(api(""))).json()).waiting.find((w: { id: string }) => w.id === memberId).handoff.reveal;
  assert.ok(await matchesCommitment(tried.commitment, { x25519: revealed.x25519, ed25519: revealed.ed25519 }, revealed.nonce, capsuleId));
  const ownerCodes = await confirmationCodes({ capsuleId, giver: { ephemeral: throwaway.ephemeral, ...seatPub }, member: revealed });
  const memberCodes = await confirmationCodes({ capsuleId, giver: given.giver, member: { ...pPub, nonce: tried.nonce } });
  assert.deepEqual(ownerCodes, memberCodes); assert.match(ownerCodes.giver, /^\d{6}$/); assert.notEqual(ownerCodes.giver, ownerCodes.member);
  const handedKey = await wrapTripKey(await unwrapTripKey(keyed.seatKey.wrapped, keyed.seatKey.ephemeral, keyBack.x25519, capsuleId, 1, true), revealed.x25519, capsuleId, 1, throwaway.pair);
  assert.equal((await request(api("/keys"), "PATCH", { type: "wrap", seat: memberId, attempt: attemptId, wrapped: handedKey.wrapped })).status, 200);
  const edgeOwner = await signEdge(seatKeys.ed25519.privateKey, { seat: memberId, ...pPub }, capsuleId);
  assert.equal((await request(api("/keys"), "PATCH", { type: "edge", seat: memberId, signature: edgeOwner })).status, 200);
  const received = (await (await request(api(""), "GET", undefined, participant)).json()).seatKey;
  assert.equal(received.ephemeral, throwaway.ephemeral); assert.equal(received.x25519, pPub.x25519);
  const gotTrip = await unwrapTripKey(received.wrapped, received.ephemeral, pSeat.x25519.privateKey, capsuleId, 1, true);
  assert.deepEqual(Buffer.from(await crypto.subtle.exportKey("raw", gotTrip)), Buffer.from(await crypto.subtle.exportKey("raw", tripKey)));
  const ownerId = given.giver.seat as string;
  assert.equal((await request(api("/keys"), "PATCH", { type: "edge", seat: ownerId, signature: await signEdge(pSeat.ed25519.privateKey, { seat: ownerId, ...seatPub }, capsuleId) }, participant)).status, 200);
  assert.equal((await (await request(api(""), "GET", undefined, participant)).json()).seatKey.edges.length, 1);
  assert.equal((await (await request(api(""))).json()).seatKey.edges.length, 1);
  assert.equal((await request(api(""))).headers.get("ETag"), '"2"');
  const keyNeedles = [Buffer.from(await crypto.subtle.exportKey("raw", tripKey)), Buffer.from(await crypto.subtle.exportKey("pkcs8", seatKeys.x25519.privateKey)), Buffer.from(await crypto.subtle.exportKey("pkcs8", seatKeys.ed25519.privateKey)), Buffer.from(await crypto.subtle.exportKey("pkcs8", pSeat.x25519.privateKey)), Buffer.from(await crypto.subtle.exportKey("pkcs8", pSeat.ed25519.privateKey))].flatMap(b => [b.toString("base64url"), b.toString("base64")]);
  // A footprint (#480): a participant leaves one during the trip, and the owner one as the page leaves it on opening (#481,
  // `auto`; another seat, so the minute's limit is not met); the owner reads both, and no revision moves. A viewer is refused
  // after the minute below. They go with the capsule at the purge.
  assert.equal((await request(api("/footprints"), "PATCH", here, participant)).status, 200);
  assert.equal((await request(api("/footprints"), "PATCH", { ...here, lat: 35.6813, auto: true })).status, 200);
  // The same seat again within the minute: a 429 that is not the login limit, so the logs get one without spending it (#608).
  assert.equal((await request(api("/footprints"), "PATCH", { ...here, lat: 35.6814 }, participant)).status, 429);
  const stepped = await request(api("")); assert.equal(stepped.headers.get("ETag"), '"2"');
  assert.deepEqual((await stepped.json()).footprints.map((p: { lat: number; mine: boolean; auto: boolean }) => [p.lat, p.mine, p.auto]), [[35.6812, false, false], [35.6813, true, true]]);
  const exportResponse = await request(api("/export")); assert.equal(exportResponse.status, 200);
  const archive = Buffer.from(await exportResponse.arrayBuffer()); assert.equal(archive.readUInt32LE(0), 0x04034b50); assert.ok(!archive.includes(Buffer.from(marker)) && !archive.includes(Buffer.from(sealed.body)));
  // The trip page saved as one file (#471): the trip's own page, for every role, and no member's own entry in it.
  const pageResponse = await request(api("/export.html"), "GET", undefined, participant); assert.equal(pageResponse.status, 200);
  const tripPage = (await pageResponse.json()).text as string; assert.ok(tripPage.startsWith("<!doctype html>") && tripPage.includes(`<h1>${title}</h1>`)); assert.ok(!tripPage.includes(marker) && !tripPage.includes(sealed.body));
  // What the operator reads from DynamoDB: the stored payloads of the whole table hold no marker, while the same reading does
  // find this trip's title (plain, shared), so the decoding is right. dev only: prod holds real capsules, and dev and prod share
  // the account and the profile, so the stack the Lambda belongs to decides, not an argument.
  if (stackName !== "capsule-host-dev") console.log("scan: dev だけで行う（このスタックでは飛ばした）");
  else {
    const stored = await storedPayloads(), found = (text: string) => stored.filter(p => p.includes(text)).length;
    console.log(`scan: ${stored.length} capsules read, marker in ${found(marker)}, trip title in ${found(title)}`);
    for (const needle of keyNeedles) assert.equal(found(needle), 0, "a trip key or a seat's private key is readable in DynamoDB");
    assert.equal(found(marker), 0, "the private entry's words are readable in DynamoDB"); assert.ok(found(title) >= 1, "the scan did not find this trip's own title: the decoding is wrong");
  }
  }
  // After the line, the plain trip just published is checked for it instead (src/cloud-host.ts mustSeal): an older screen is asked
  // to reload, and the new one gets the owner's view marked mustSeal but no invite, edit or footprint; the operator's list says so.
  if (afterLine) {
    const line = async (path: string, method = "GET", body?: unknown) => { const r = await request(path, method, body); return [r.status, (await r.json()).error]; };
    assert.deepEqual(await line(api("")), [409, "画面を更新してください"]);
    const fresh = await request(api("") + ui); assert.equal(fresh.status, 200); assert.equal((await fresh.json()).mustSeal, true);
    for (const [action, method, body] of [["/grants", "POST", invite], ["/document", "PATCH", { type: "check", id: "c3", done: true }], ["/footprints", "PATCH", here]] as const) assert.deepEqual(await line(api(action) + ui, method, body), [409, "オーナーがこの旅行を移すまで開けません"], action);
    assert.equal((await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} })).body.find((c: { id: string }) => c.id === capsuleId).mustSeal, true);
    console.log("plain trip after the line: 409 画面を更新してください without ui=2, 409 オーナーがこの旅行を移すまで開けません for an invite, an edit and a footprint, mustSeal for the owner and in the operator's list");
  }
  // The trip sealed under the trip's key (#691, docs/design/trip-e2e.md §3): a third disposable capsule whose title, an item and
  // a suggestion carry a marker. Its owner puts the trip key on the seat, seals the plan it reads with src/trip-keys.ts and posts
  // it after the passkey check; the plan opens back the same, a participant may post (sealed) but not add an item, theme.css and
  // the operator's list read as before, export is 409, and on dev the stored payload of this capsule holds no marker. The purge
  // compares no title (the screen does). The joins start in a fresh minute of the login limit.
  await new Promise(r => setTimeout(r, 61000 - Date.now() % 60000));
  const sealedMarker = `sealed-marker-${randomBytes(8).toString("hex")}`, sealedSeed = testTrip();
  sealedSeed.spec.title = `${title} ${sealedMarker}`; sealedSeed.spec.trip.endsOn = seed.spec.trip.endsOn; sealedSeed.spec.lifecycle.purgeAt = seed.spec.lifecycle.purgeAt;
  sealedSeed.document.items[0]!.title = sealedMarker; sealedSeed.document.suggestions = [{ id: "s1", author: "AWS確認", body: sealedMarker, createdAt: new Date().toISOString(), promoted: false }];
  const sealedMade = await invoke(functionName, profile, region, { payload: { ...sealedSeed, confirm: true } }); assert.equal(sealedMade.statusCode, 201); sealedTripId = sealedId = sealedMade.body.id;
  const sAt = (action: string) => `/v1/c/${sealedId}${action}?ui=2`;  // as the new screen sends them (a sealed trip refuses an older one)
  const enter = async (url: string) => {
    const secret = new URLSearchParams(new URL(url).hash.slice(1)).get("k")!; secrets.push(secret);
    const r = await request(sAt("/sessions"), "POST", { secret }, ""); assert.equal(r.status, 200);
    const cookie = r.headers.get("Set-Cookie")!.split(";")[0]!; secrets.push(cookie.slice(cookie.indexOf("=") + 1)); return cookie;
  };
  sealedOwner = await enter(sealedMade.body.url);
  // The owner browser's first passkey, which counts as the check before seal and purge.
  const sealedDevice = fakeAuthenticator({ origin }), { challenge: sealedChallenge } = await (await request(sAt("/passkey/challenge"), "POST", {}, "")).json();
  assert.equal((await request(sAt("/passkey"), "POST", { challenge: sealedChallenge, ...sealedDevice.register(sealedChallenge) }, sealedOwner)).status, 200);
  const sSeat = await newSeatKeys(), sPub = await seatPublic(sSeat), sTrip = await newTripKey(), sWrap = await wrapTripKey(sTrip, sPub.x25519, sealedId, 1);
  assert.equal((await request(sAt("/keys"), "PATCH", { type: "seat", ...sPub, ephemeral: sWrap.ephemeral, generation: 1, wrapped: sWrap.wrapped }, sealedOwner)).status, 200);
  // After the line the trip takes no one before its seal: the participant is invited after it, under a sealed name (below).
  let sMember = afterLine ? "" : await enter((await (await request(sAt("/grants"), "POST", { ...invite, seats: 1 }, sealedOwner)).json()).url);
  const plainView = await (await request(sAt(""), "GET", undefined, sealedOwner)).json();
  const theme = async () => { const r = await request(sAt("/theme.css"), "GET", undefined, sealedOwner); assert.equal(r.status, 200); const css = await r.text(); assert.match(css, /--accent:#/); return css; };
  const listedOf = async () => { const { updated: _updated, ...rest } = (await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} })).body.find((c: { id: string }) => c.id === sealedId); return rest; };
  const [themeBefore, listedBefore] = [await theme(), await listedOf()];
  const sealedBody = await sealMove(sTrip, sealedId, 1, { spec: plainView.spec, document: plainView.document, previous: null, footprints: plainView.footprints, grants: await (await request(sAt("/grants"), "GET", undefined, sealedOwner)).json() });
  assert.equal((await request(sAt("/seal"), "POST", sealedBody, sealedOwner, plainView.document.revision)).status, 200);
  if (afterLine) { const id = randomBytes(16).toString("hex"); sMember = await enter((await (await request(sAt("/grants"), "POST", { ...invite, seats: 1, id, label: await sealName(sTrip, sealedId, 1, "grant", id, "AWS確認用") }, sealedOwner)).json()).url); }
  const sealedView = await (await request(sAt(""), "GET", undefined, sealedOwner)).json(), sealedText = JSON.stringify(sealedView);
  assert.equal(sealedView.sealed.generation, 1); assert.ok(!sealedText.includes(sealedMarker), "the host returns a plain word of the sealed trip");
  const reopened = await openTrip(sTrip, sealedId, sealedView);
  assert.deepEqual(reopened, { spec: plainView.spec, document: { ...plainView.document, revision: plainView.document.revision + 1 }, unreadable: [] });
  const sOp = (op: object) => sealOperation(sTrip, sealedId, 1, op, reopened!.document);
  assert.equal((await request(sAt("/document"), "PATCH", await sOp({ type: "item", item: { id: "sealed-new", kind: "meal", status: "proposed", title: "x", day: plainView.document.items[0].day, revision: 1 } }), sMember, sealedView.document.revision)).status, 403);
  assert.equal((await request(sAt("/document"), "PATCH", await sOp({ type: "suggest", author: "参加者", body: sealedMarker }), sMember, sealedView.document.revision)).status, 200);
  assert.equal(await theme(), themeBefore); assert.deepEqual(await listedOf(), { ...listedBefore, sealed: true, ...(afterLine ? { mustSeal: false, grants: listedBefore.grants + 1, members: listedBefore.members + 1 } : {}) });  // only whether it is sealed changes (after the line, also whether it must be, and the participant invited after the seal is counted)
  // A revise of the sealed trip as the browser sends it (#786): the next trip sealed, records left as they were keeping their
  // ciphertext. One step back is then held by the host as ciphertext (GET undo), and opens to the trip before the revise (#783).
  const beforeRevise = await (await request(sAt(""), "GET", undefined, sealedOwner)).json(), openedBefore = await openTrip(sTrip, sealedId, beforeRevise);
  assert.ok(openedBefore && !openedBefore.unreadable.length, "the sealed trip did not open before the revise");
  const nextTrip = structuredClone({ spec: openedBefore.spec, document: openedBefore.document }); nextTrip.document.items[0]!.title = "AWS確認で直した予定";
  const resealed = await resealTrip(sTrip, sealedId, 1, [beforeRevise], nextTrip);
  assert.equal((await request(sAt("/revise"), "POST", { ...resealed, document: { ...resealed.document, reflections: beforeRevise.document.reflections }, confirm: true }, sealedOwner, beforeRevise.document.revision)).status, 200);
  const undoResponse = await request(sAt("/undo"), "GET", undefined, sealedOwner); assert.equal(undoResponse.status, 200);
  const undoText = await undoResponse.text(), stepBack = JSON.parse(undoText).previous;
  assert.ok(!undoText.includes(sealedMarker) && /^v1\./.test(stepBack.spec.title), "GET undo of the sealed trip holds a plain word");
  const reopenedBack = await openTrip(sTrip, sealedId, { spec: stepBack.spec, document: { ...beforeRevise.document, ...stepBack.document } });
  assert.equal(reopenedBack?.document.items[0]!.title, sealedMarker, "GET undo did not hold the sealed trip before the revise");
  // The host's exports of a sealed trip give nothing (the screen makes them, #785).
  for (const path of ["/export", "/export.md", "/export.html"]) {
    const r = await request(sAt(path), "GET", undefined, sealedOwner); assert.equal(r.status, 409, `${path} of the sealed trip`);
    assert.ok(!(await r.text()).includes(sealedMarker), `${path} of the sealed trip holds a plain word`);
  }
  // The owner's Anthropic key, wrapped by the browser with the passkey's PRF (random bytes stand in for it): kept on the seat as it
  // came; a plain key is refused (#784, #787).
  const assistWrapped = await sealText(await assistSealingKey(randomBytes(32), sealedId), `sk-ant-aws-verify-${randomBytes(16).toString("hex")}`, `${sealedId}/assist`);
  assert.equal((await request(sAt("/key"), "PUT", { key: `sk-ant-aws-verify-${randomBytes(16).toString("hex")}` }, sealedOwner)).status, 400);
  assert.equal((await request(sAt("/key"), "PUT", { wrapped: assistWrapped }, sealedOwner)).status, 204);
  assert.equal((await (await request(sAt(""), "GET", undefined, sealedOwner)).json()).assistWrapped, assistWrapped);
  console.log("sealed trip: exports hold no plain words, GET undo holds the step back sealed, the assist key is wrapped by the browser, CSP allows api.anthropic.com only");
  // Footprints, names and the history of the sealed trip (#693, docs/design/trip-e2e.md §3.1): a participant's point and name
  // sealed against the id the browser chose open back the same, the same seat within the minute is 429 and a viewer 403; the
  // owner names the participant and an invite in ciphertext only, and the history lines name the invite and the seats by id.
  const nameMarker = `sealed-name-${randomBytes(6).toString("hex")}`, point = { lat: Number(`35.68${randomInt(10, 100)}7`), lng: 139.7671, accuracy: 20 };
  const gid = () => randomBytes(16).toString("hex");
  const sCheck = async () => { const { challenge } = await (await request(sAt("/passkey/challenge"), "POST", {}, "")).json(); assert.equal((await request(sAt("/passkey/verify"), "POST", { challenge, id: sealedDevice.id, ...sealedDevice.assert(challenge) }, sealedOwner)).status, 200); };
  const leave = async (cookie: string) => { const id = gid(); return request(sAt("/footprints"), "PATCH", { type: "add", id, point: await sealPoint(sTrip, sealedId, 1, id, point), by: await sealName(sTrip, sealedId, 1, "footprint", id, nameMarker) }, cookie); };
  assert.equal((await request(sAt("/footprints"), "PATCH", { type: "add", ...point }, sMember)).status, 400);
  assert.equal((await leave(sMember)).status, 200);
  const stepView = await (await request(sAt(""), "GET", undefined, sealedOwner)).json(), [left] = stepView.footprints;
  assert.deepEqual([await openPoint(sTrip, sealedId, left.id, left.point), await openName(sTrip, sealedId, "footprint", left.id, left.by), left.mine], [point, nameMarker, false]);
  assert.ok(!JSON.stringify(stepView).includes(String(point.lat)) && !JSON.stringify(stepView).includes(nameMarker), "the host returns a plain point or name of the sealed trip");
  assert.equal((await leave(sMember)).status, 429);
  await sCheck();
  const memberSeat = (await (await request(sAt(""), "GET", undefined, sMember)).json()).self.id as string;
  assert.equal((await request(sAt("/members"), "PATCH", { id: memberSeat, label: nameMarker }, sealedOwner)).status, 400);
  assert.equal((await request(sAt("/members"), "PATCH", { id: memberSeat, label: await sealName(sTrip, sealedId, 1, "member", memberSeat, nameMarker) }, sealedOwner)).status, 200);
  const viewerGrant = gid(), viewerMade = await request(sAt("/grants"), "POST", { role: "viewer", id: viewerGrant, label: await sealName(sTrip, sealedId, 1, "grant", viewerGrant, nameMarker), seats: 1, expiresAt: sealedSeed.spec.lifecycle.purgeAt, confirm: true }, sealedOwner);
  assert.equal(viewerMade.status, 201); const sViewer = await enter((await viewerMade.json()).url);
  assert.equal((await leave(sViewer)).status, 403);
  const sGrantsText = await (await request(sAt("/grants"), "GET", undefined, sealedOwner)).text();
  assert.ok(!sGrantsText.includes(nameMarker), "the grants list holds a plain name of the sealed trip");
  assert.equal(await openName(sTrip, sealedId, "grant", viewerGrant, JSON.parse(sGrantsText).find((g: { id: string }) => g.id === viewerGrant).label), nameMarker);
  const sHistory = await (await request(sAt("/history"), "GET", undefined, sealedOwner)).json() as Array<Record<string, unknown>>;
  assert.deepEqual([sHistory[0]!.event, sHistory[0]!.grant, typeof sHistory[0]!.seat, sHistory[1]!.event, sHistory[1]!.grant], ["sessions", viewerGrant, "string", "grants", viewerGrant]);
  assert.ok(sHistory.slice(0, 2).every(h => !("label" in h) && !("by" in h)), "a sealed trip's history line holds a name");
  console.log("sealed trip: a footprint and the names sealed by the browser open back, 429 within the minute, 403 for a viewer; the history holds the invite's and the seats' ids");
  if (stackName === "capsule-host-dev") {
    const stored = await storedPayloads(), mine = stored.filter(p => p.includes(`"id":"${sealedId}"`));
    console.log(`scan (sealed): ${mine.length} payload of the sealed capsule found, marker in ${stored.filter(p => p.includes(sealedMarker)).length}`);
    assert.equal(mine.length, 1, "the scan did not find the sealed capsule's payload: the decoding is wrong");
    assert.equal(stored.filter(p => p.includes(sealedMarker)).length, 0, "a sealed trip's words are readable in DynamoDB");
    console.log("trip sealed by the owner's trip key (no plain words in the table's stored payloads on dev)");
    console.log(`scan (sealed footprints and names): point in ${stored.filter(p => p.includes(String(point.lat))).length}, name in ${stored.filter(p => p.includes(nameMarker)).length}`);
    assert.equal(stored.filter(p => p.includes(String(point.lat)) || p.includes(nameMarker)).length, 0, "a sealed trip's point or name is readable in DynamoDB");
    console.log("footprints and names sealed by the trip key (no plain point or name in the table's stored payloads on dev)");
  }
  // The trip key replaced (#695, docs/design/trip-e2e.md §8) in the same sealed trip: the owner hands the key to the participant (A)
  // and to a second participant (B) by the handoff, as the browsers do (the codes are the screens' and are not compared here). B is
  // revoked: the owner's GET says to replace the key, the owner's browser seals the trip again under generation 2 and wraps it to
  // the seats it reaches (POST rekey). A opens it and takes it as the owner's; B's key of generation 1 opens none of it, and B's
  // cookie is refused. On dev the stored payload holds generation 2 only. Then /recover: the new owner takes the key from A, is
  // asked (rekey: ask), and keeps the key. The joins and the checks start in a fresh minute of the login limit.
  await new Promise(r => setTimeout(r, 61000 - Date.now() % 60000));
  const ownerSeat = { cookie: sealedOwner, id: (await (await request(sAt(""), "GET", undefined, sealedOwner)).json()).self.id as string, seat: sSeat, pub: sPub };
  type Holder = { cookie: string; id: string; seat: SeatKeys; pub: { x25519: string; ed25519: string } };
  const handTo = async (giver: Holder, cookie: string, key: CryptoKey, generation: number): Promise<Holder> => {
    const seat = await newSeatKeys(), pub = await seatPublic(seat), attempt = await newAttempt(pub, sealedId), h = await newHandoffKeys();
    const att = (await (await request(sAt("/keys"), "PATCH", { type: "wait", commitment: attempt.commitment }, cookie)).json()).handoff.attempt as string;
    const id = (await (await request(sAt(""), "GET", undefined, cookie)).json()).self.id as string;
    // As the two screens do: the giver keeps the commitment it read before its own values are put, the member keeps the giver's.
    const commitment = (await (await request(sAt(""), "GET", undefined, giver.cookie)).json()).waiting.find((w: { id: string }) => w.id === id).handoff.commitment as string;
    assert.equal((await request(sAt("/keys"), "PATCH", { type: "give", seat: id, attempt: att, ephemeral: h.ephemeral }, giver.cookie)).status, 200);
    const shown = (await (await request(sAt(""), "GET", undefined, cookie)).json()).handoff.giver;
    assert.equal((await request(sAt("/keys"), "PATCH", { type: "reveal", attempt: att, ...pub, nonce: attempt.nonce }, cookie)).status, 200);
    const revealed = (await (await request(sAt(""), "GET", undefined, giver.cookie)).json()).waiting.find((w: { id: string }) => w.id === id).handoff.reveal;
    assert.ok(await matchesCommitment(commitment, { x25519: revealed.x25519, ed25519: revealed.ed25519 }, revealed.nonce, sealedId), "the member's values do not match its commitment");
    assert.deepEqual(await confirmationCodes({ capsuleId: sealedId, giver: { ephemeral: h.ephemeral, ...giver.pub }, member: revealed }), await confirmationCodes({ capsuleId: sealedId, giver: shown, member: { ...pub, nonce: attempt.nonce } }), "the two screens' codes differ");
    assert.equal((await request(sAt("/keys"), "PATCH", { type: "wrap", seat: id, attempt: att, wrapped: (await wrapTripKey(key, pub.x25519, sealedId, generation, h.pair)).wrapped }, giver.cookie)).status, 200);
    assert.equal((await request(sAt("/keys"), "PATCH", { type: "edge", seat: id, signature: await signEdge(giver.seat.ed25519.privateKey, { seat: id, ...pub }, sealedId) }, giver.cookie)).status, 200);
    assert.equal((await request(sAt("/keys"), "PATCH", { type: "edge", seat: giver.id, signature: await signEdge(seat.ed25519.privateKey, { seat: giver.id, ...giver.pub }, sealedId) }, cookie)).status, 200);
    return { cookie, id, seat, pub };
  };
  const keyA = await handTo(ownerSeat, sMember, sTrip, 1);
  const bGrant = gid(), bMade = await request(sAt("/grants"), "POST", { role: "participant", id: bGrant, label: await sealName(sTrip, sealedId, 1, "grant", bGrant, "AWS確認用"), seats: 1, expiresAt: sealedSeed.spec.lifecycle.purgeAt, confirm: true }, sealedOwner);
  assert.equal(bMade.status, 201); const keyB = await handTo(ownerSeat, await enter((await bMade.json()).url), sTrip, 1);
  await sCheck();
  assert.equal((await request(sAt("/revoke"), "POST", { member: keyB.id, confirm: true }, sealedOwner)).status, 200);
  const toReplace = await (await request(sAt(""), "GET", undefined, sealedOwner)).json(), sGrants = await (await request(sAt("/grants"), "GET", undefined, sealedOwner)).json() as Array<{ id: string; label: string; members: Array<{ id: string; label: string }> }>;
  assert.equal(toReplace.rekey, "auto"); assert.equal((await (await request(sAt(""), "GET", undefined, sMember)).json()).rekey, null);
  const nextKey = await newTripKey(), resealedAll = await resealAll(sTrip, nextKey, sealedId, 2, { spec: toReplace.spec, document: toReplace.document, footprints: toReplace.footprints.map((p: { id: string; point: string; by: string }) => ({ id: p.id, point: p.point, by: p.by })), members: sGrants.flatMap(g => g.members).map(m => ({ id: m.id, label: m.label })), grants: sGrants.map(g => ({ id: g.id, label: g.label })) });
  const reached = await reachableSeats({ id: ownerSeat.id, ed25519: sPub.ed25519 }, toReplace.seats, sealedId);
  assert.deepEqual([...reached].sort(), [ownerSeat.id, keyA.id].sort());
  const rekeyed = await Promise.all(toReplace.seats.filter((x: { id: string }) => reached.has(x.id)).map(async (x: { id: string; x25519: string }) => { const w = await wrapTripKey(nextKey, x.x25519, sealedId, 2); return { seat: x.id, ...w, signature: await signRekey(sSeat.ed25519.privateKey, { capsuleId: sealedId, generation: 2, seat: x.id, x25519: x.x25519, ...w }) }; }));
  assert.equal((await request(sAt("/rekey"), "POST", { generation: 2, ...resealedAll, seats: rekeyed, confirm: true }, sealedOwner, toReplace.document.revision)).status, 200);
  const aView = await (await request(sAt(""), "GET", undefined, sMember)).json();
  const aKey = await unwrapTripKey(aView.seatKey.wrapped, aView.seatKey.ephemeral, keyA.seat.x25519.privateKey, sealedId, 2, true);  // A hands it on below
  assert.equal((await openTrip(aKey, sealedId, aView))?.spec.title, sealedSeed.spec.title, "the remaining participant does not read the trip of the next generation");
  assert.equal(await acceptRekey({ self: { id: keyA.id, ed25519: keyA.pub.ed25519 }, known: 1, capsuleId: sealedId, seats: aView.seats, seatKey: aView.seatKey }), true);
  await assert.rejects(openField(sTrip, sealedId, "spec", "spec", "title", aView.spec.title), "the revoked participant's key of generation 1 opens the new title");
  assert.equal((await request(sAt(""), "GET", undefined, keyB.cookie)).status, 401);
  if (stackName === "capsule-host-dev") {
    const mine = (await storedPayloads()).find(p => p.includes(`"id":"${sealedId}"`))!, kept = JSON.parse(mine);
    const generations = new Set([...mine.matchAll(/v1\.(\d+)\./g)].map(m => m[1]));
    console.log(`scan (rekey): generations ${[...generations].join(",")}, sealed ${kept.sealed.generation}`);
    assert.deepEqual([[...generations], kept.sealed.generation, "departed" in kept, "previous" in kept], [["2"], 2, false, false], "the stored payload holds ciphertext of another generation, or what was replaced");
  }
  // /recover: the publisher replaces the owner invite; the new owner takes the key from A and is asked, then keeps it.
  const recoveredSealed = await invoke(functionName, profile, region, { path: `/v1/c/${sealedId}/recover`, payload: { confirm: true } }); assert.equal(recoveredSealed.statusCode, 201);
  assert.equal((await request(sAt(""), "GET", undefined, sealedOwner)).status, 401);
  sealedOwner = await enter(recoveredSealed.body.url);
  const recoveredHolder = await handTo(keyA, sealedOwner, aKey, 2), recoveredView = await (await request(sAt(""), "GET", undefined, sealedOwner)).json();
  const recoveredKey = await unwrapTripKey(recoveredView.seatKey.wrapped, recoveredView.seatKey.ephemeral, recoveredHolder.seat.x25519.privateKey, sealedId, 2);
  assert.equal((await openTrip(recoveredKey, sealedId, recoveredView))?.spec.title, sealedSeed.spec.title, "the new owner after recover does not read the trip");
  assert.equal((await (await request(sAt(""), "GET", undefined, sealedOwner)).json()).rekey, "ask");
  const recoveredDevice = fakeAuthenticator({ origin }), { challenge: recoveredChallenge } = await (await request(sAt("/passkey/challenge"), "POST", {}, "")).json();
  assert.equal((await request(sAt("/passkey"), "POST", { challenge: recoveredChallenge, ...recoveredDevice.register(recoveredChallenge) }, sealedOwner)).status, 200);
  assert.equal((await request(sAt("/keys"), "PATCH", { type: "keep" }, sealedOwner)).status, 200);
  assert.equal((await (await request(sAt(""), "GET", undefined, sealedOwner)).json()).rekey, null);
  console.log("trip key replaced: after a member's revocation the owner sealed the trip again under generation 2 (the remaining member reading it, the revoked member's key opening none of it); after recover the new owner was asked and kept the key");
  assert.equal((await request(sAt("/purge"), "POST", { title: "" }, sealedOwner)).status, 200);
  assert.equal((await request(sAt(""), "GET", undefined, sealedOwner)).status, 410); sealedId = "";
  // Moving a plain trip (#694, docs/design/trip-e2e.md §5): a fourth disposable capsule, plain, whose title, an item, a post, the
  // participant's name and an invite's name carry a marker, and where the participant and the owner each leave a point. The owner
  // reads it (GET "", GET seal, GET grants), seals all of it with src/trip-keys.ts sealMove and posts it after the passkey check:
  // it opens back the same, a request without the new screen's mark (ui=2) is asked to reload, the operator's list says sealed,
  // and on dev no stored payload holds the marker or the point. The joins start in a fresh minute of the login limit.
  await new Promise(r => setTimeout(r, 61000 - Date.now() % 60000));
  const moveMarker = `move-marker-${randomBytes(8).toString("hex")}`, moveSeed = testTrip();
  moveSeed.spec.title = `${title} ${moveMarker}`; moveSeed.spec.trip.endsOn = seed.spec.trip.endsOn; moveSeed.spec.lifecycle.purgeAt = seed.spec.lifecycle.purgeAt;
  moveSeed.document.items[0]!.title = moveMarker; moveSeed.document.suggestions = [{ id: "s1", author: "AWS確認", body: moveMarker, createdAt: new Date().toISOString(), promoted: false }];
  const moveMade = await invoke(functionName, profile, region, { payload: { ...moveSeed, confirm: true } }); assert.equal(moveMade.statusCode, 201); sealedId = moveMade.body.id;
  sealedOwner = await enter(moveMade.body.url);
  const moveDevice = fakeAuthenticator({ origin }), moveCheck = async (register = false) => {
    const { challenge } = await (await request(sAt("/passkey/challenge"), "POST", {}, "")).json();
    assert.equal((await request(sAt(register ? "/passkey" : "/passkey/verify"), "POST", register ? { challenge, ...moveDevice.register(challenge) } : { challenge, id: moveDevice.id, ...moveDevice.assert(challenge) }, sealedOwner)).status, 200);
  };
  await moveCheck(true);
  const mSeat = await newSeatKeys(), mPub = await seatPublic(mSeat), mTrip = await newTripKey(), mWrap = await wrapTripKey(mTrip, mPub.x25519, sealedId, 1);
  assert.equal((await request(sAt("/keys"), "PATCH", { type: "seat", ...mPub, ephemeral: mWrap.ephemeral, generation: 1, wrapped: mWrap.wrapped }, sealedOwner)).status, 200);
  // After the line the owner alone may come in before the move: no member, name or point to carry over.
  const mMember = afterLine ? "" : await enter((await (await request(sAt("/grants"), "POST", { role: "participant", label: moveMarker, seats: 1, expiresAt: moveSeed.spec.lifecycle.purgeAt, confirm: true }, sealedOwner)).json()).url);
  if (mMember) {
  const mMemberSeat = (await (await request(sAt(""), "GET", undefined, mMember)).json()).self.id as string;
  assert.equal((await request(sAt("/members"), "PATCH", { id: mMemberSeat, label: moveMarker }, sealedOwner)).status, 200);
  }
  const movePoint = { lat: Number(`35.67${randomInt(10, 100)}3`), lng: 139.7671, accuracy: 20 };
  for (const cookie of mMember ? [mMember, sealedOwner] : []) assert.equal((await request(sAt("/footprints"), "PATCH", { type: "add", ...movePoint }, cookie)).status, 200);
  const moveFrom = await (await request(sAt(""), "GET", undefined, sealedOwner)).json(), { previous: movePrevious } = await (await request(sAt("/seal"), "GET", undefined, sealedOwner)).json();
  const moveBody = await sealMove(mTrip, sealedId, 1, { spec: moveFrom.spec, document: moveFrom.document, previous: movePrevious, footprints: moveFrom.footprints, grants: await (await request(sAt("/grants"), "GET", undefined, sealedOwner)).json() });
  await moveCheck();
  assert.equal((await request(sAt("/seal"), "POST", moveBody, sealedOwner, moveFrom.document.revision)).status, 200);
  const movedView = await (await request(sAt(""), "GET", undefined, sealedOwner)).json();
  assert.equal(movedView.sealed.generation, 1); assert.ok(!JSON.stringify(movedView).includes(moveMarker) && !JSON.stringify(movedView).includes(String(movePoint.lat)), "the host returns a plain word or point of the moved trip");
  assert.deepEqual(await openTrip(mTrip, sealedId, movedView), { spec: moveFrom.spec, document: { ...moveFrom.document, revision: moveFrom.document.revision + 1 }, unreadable: [] });
  for (const p of movedView.footprints) assert.deepEqual(await openPoint(mTrip, sealedId, p.id, p.point), movePoint);
  const olderScreen = await request(`/v1/c/${sealedId}`, "GET", undefined, sealedOwner);
  assert.deepEqual([olderScreen.status, (await olderScreen.json()).error], [409, "画面を更新してください"]);
  const movedListed = (await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} })).body.find((c: { id: string }) => c.id === sealedId);
  assert.deepEqual([movedListed.sealed, movedListed.mustSeal], [true, false]);
  if (stackName === "capsule-host-dev") {
    const stored = await storedPayloads(), mine = stored.filter(p => p.includes(`"id":"${sealedId}"`));
    console.log(`scan (moved): ${mine.length} payload of the moved capsule found, marker in ${stored.filter(p => p.includes(moveMarker)).length}, point in ${stored.filter(p => p.includes(String(movePoint.lat))).length}`);
    assert.equal(mine.length, 1, "the scan did not find the moved capsule's payload: the decoding is wrong");
    assert.equal(stored.filter(p => p.includes(moveMarker) || p.includes(String(movePoint.lat))).length, 0, "a moved trip's words, names or points are readable in DynamoDB");
    console.log("plain trip moved by its owner (no plain words or points left in the table on dev)");
  } else console.log("plain trip moved by its owner (the table's scan: dev だけで行う)");
  assert.equal((await request(sAt("/purge"), "POST", { title: "" }, sealedOwner)).status, 200);
  assert.equal((await request(sAt(""), "GET", undefined, sealedOwner)).status, 410); sealedId = "";
  plainScenesAfter: {
  if (afterLine) break plainScenesAfter;
  // Revising with a chat: the owner copies the trip without anyone's posts, a pasted answer shows its change and writes
  // nothing, applying needs the version it was shown against, and one step back restores it. Nobody else may do any of it.
  assert.equal((await request(api("/document"), "PATCH", { type: "suggest", author: "AWS確認", body: "星を見に行きたい" }, participant, 2)).status, 200);
  assert.equal((await request(api("/revise"), "GET", undefined, participant)).status, 403);
  const copied = (await (await request(api("/revise"))).json()).text as string, current = copied.split("## 今の旅程")[1]!;
  assert.ok(current.includes(title)); assert.ok(current.includes("星を見に行きたい"));
  const trip = JSON.parse(current.match(/```json\n([\s\S]*?)\n```/)![1]!); trip.document.items[1].startsAt = "2026-09-25T18:30:00+09:00";
  assert.equal(trip.document.suggestions[0].author, undefined); assert.equal(trip.document.suggestions[0].createdAt, undefined);
  trip.document.suggestions = [{ id: "aws-revise-added", body: "反映で足した候補", promoted: false }];
  trip.document.comments.push({ id: "aws-revise-talk", body: "広域で相談する" });
  const text = `直しました。\n${JSON.stringify(trip)}`, shown = await (await request(api("/revise/check"), "POST", { text })).json();
  assert.deepEqual([shown.ok, shown.revision, shown.diff.items.map((i: { change: string }) => i.change), shown.diff.large], [true, 3, ["changed"], true]);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true }, participant, 3)).status, 403);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true }, owner, 2)).status, 409);
  assert.deepEqual(shown.diff.suggestions.map((r: { change: string }) => r.change), ["added", "removed"]);
  assert.deepEqual(shown.diff.comments.map((r: { change: string }) => r.change), ["added"]);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true }, owner, 3)).status, 400);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true, title }, owner, 3)).status, 200);
  const revised = (await (await request(api(""))).json()).document;
  assert.deepEqual(revised.suggestions.map((p: { id: string }) => p.id), ["aws-revise-added"]);
  assert.equal(revised.comments.at(-1).body, "広域で相談する");
  assert.equal((await request(api("/undo"), "GET", undefined, participant)).status, 403);
  assert.equal((await request(api("/undo"), "POST", { confirm: true }, participant, 4)).status, 403);
  assert.deepEqual((await (await request(api("/undo"))).json()).diff.items.map((i: { change: string }) => i.change), ["changed"]);
  assert.equal((await request(api("/undo"), "POST", { confirm: true, title }, owner, 4)).status, 200);
  assert.equal((await request(api("/undo"))).status, 404);
  const back = (await (await request(api(""))).json()).document;
  assert.equal(back.items[1].startsAt, "2026-09-25T19:00:00+09:00"); assert.deepEqual(back.suggestions.map((s: { body: string }) => s.body), ["星を見に行きたい"]); assert.ok(!back.comments.some((p: { id: string }) => p.id === "aws-revise-talk"));
  // Reordering a day: the owner drops the day's last item before its first and the host gives it a time ahead of it; a participant may not.
  const dropped = { type: "move", id: "checkin", before: "arrival" };
  assert.equal((await request(api("/document"), "PATCH", dropped, participant, 5)).status, 403);
  const movedTo = await request(api("/document"), "PATCH", dropped, owner, 5); assert.equal(movedTo.status, 200);
  assert.deepEqual((await movedTo.json()).moved, { id: "checkin", startsAt: "2026-09-24T03:45:00.000Z" });
  const reordered = (await (await request(api(""))).json()).document.items as Array<{ id: string; startsAt?: string; endsAt?: string; timeTentative?: boolean }>;
  assert.deepEqual(reordered.map(i => i.id), ["checkin", "arrival", "dinner", "walk"]); assert.deepEqual([reordered[0]!.startsAt, reordered[0]!.endsAt, reordered[0]!.timeTentative], ["2026-09-24T03:45:00.000Z", "2026-09-24T04:45:00.000Z", true]);
  // An item without a time, as a trip published before may hold: an edit still saves it, and dropped last in its day it is given
  // an hour after the day's last item (which has no end), marked a placeholder.
  const free = { id: "free", title: "自由行動", day: "2026-09-24", kind: "activity", status: "proposed", revision: 1 };
  assert.equal((await request(api("/document"), "PATCH", { type: "item", item: free }, owner, 6)).status, 200);
  const freed = await request(api("/document"), "PATCH", { type: "move", id: "free", before: null }, owner, 7); assert.equal(freed.status, 200);
  assert.deepEqual((await freed.json()).moved, { id: "free", startsAt: "2026-09-24T05:15:00.000Z" });
  const placed = (await (await request(api(""))).json()).document.items as Array<{ id: string; startsAt?: string; timeTentative?: boolean }>;
  assert.deepEqual(placed.map(i => i.id), ["checkin", "arrival", "free", "dinner", "walk"]); assert.equal(placed[2]!.timeTentative, true);
  // An end, as the edit form sends it: saved and read back; one before the start is refused and changes nothing.
  const ended = { ...free, startsAt: "2026-09-24T14:15:00+09:00", endsAt: "2026-09-24T15:00:00+09:00", revision: 2 };
  assert.equal((await request(api("/document"), "PATCH", { type: "item", item: ended }, owner, 8)).status, 200);
  assert.equal(((await (await request(api(""))).json()).document.items as Array<{ id: string; endsAt?: string }>).find(i => i.id === "free")!.endsAt, "2026-09-24T15:00:00+09:00");
  assert.equal((await request(api("/document"), "PATCH", { type: "item", item: { ...ended, endsAt: "2026-09-24T14:00:00+09:00" } }, owner, 9)).status, 400);
  assert.equal((await (await request(api(""))).json()).document.revision, 9);
  // Added between two items (the "＋"): right after the one named, even with a time that belongs elsewhere; the host fits it
  // halfway to the next (the one before has no end, and an hour after it reaches the next), a placeholder, and says so.
  // An `after` on another day is refused and changes nothing.
  const between = { id: "between", title: "間の予定", day: "2026-09-24", startsAt: "2026-09-24T12:00:00+09:00", kind: "activity", status: "proposed", revision: 1 };
  assert.equal((await request(api("/document"), "PATCH", { type: "item", item: between, after: "dinner" }, owner, 9)).status, 400);
  const inserted = await request(api("/document"), "PATCH", { type: "item", item: between, after: "arrival" }, owner, 9); assert.equal(inserted.status, 200);
  assert.deepEqual((await inserted.json()).moved, { id: "between", startsAt: "2026-09-24T04:45:00.000Z" });
  const around = (await (await request(api(""))).json()).document.items as Array<{ id: string; startsAt?: string; timeTentative?: boolean }>;
  assert.deepEqual(around.map(i => i.id), ["checkin", "arrival", "between", "free", "dinner", "walk"]); assert.deepEqual([around[2]!.startsAt, around[2]!.timeTentative], ["2026-09-24T04:45:00.000Z", true]);
  // The participant's 候補 from above: the owner changes its words and then takes it out; the participant may do neither.
  const ideas = async () => (await (await request(api(""))).json()).document.suggestions as Array<{ id: string; body: string }>;
  const idea = (await ideas()).find(x => x.body === "星を見に行きたい")!.id, posted = Number(JSON.parse((await request(api(""))).headers.get("ETag")!));
  for (const op of [{ type: "rewrite", list: "suggestions", id: idea, body: "x" }, { type: "remove", list: "suggestions", id: idea }]) assert.equal((await request(api("/document"), "PATCH", op, participant, posted)).status, 403);
  assert.equal((await request(api("/document"), "PATCH", { type: "rewrite", list: "suggestions", id: idea, body: "丘で星を見たい" }, owner, posted)).status, 200);
  assert.equal((await ideas()).find(x => x.id === idea)?.body, "丘で星を見たい");
  assert.equal((await request(api("/document"), "PATCH", { type: "remove", list: "suggestions", id: idea }, owner, posted + 1)).status, 200);
  assert.equal((await ideas()).some(x => x.id === idea), false);
  // One member is removed individually: the other stays, and the seat does not reopen. The sealed scene above took part of
  // the passkey check's five minutes, so the owner checks again.
  await stepUp();
  assert.equal((await request(api("/revoke"), "POST", { member: listed.members[0].id, confirm: true })).status, 200);
  assert.deepEqual([(await request(api(""), "GET", undefined, participant)).status, (await request(api(""), "GET", undefined, second)).status].sort(), [200, 401]);
  // The revoked seat's 401 says the seat is gone (#842: the screen then forgets the trip's keys); the text is the one before.
  const goneOne = (await request(api(""), "GET", undefined, participant)).status === 401 ? participant : second;
  assert.deepEqual(await (await request(api(""), "GET", undefined, goneOne)).json(), { error: "この端末の登録は失効したか、期限が切れました", seat: "gone" });
  assert.equal((await redeem(g.url)).status, 401);
  // The member left signs out: the cookie is cleared, and a copy of it kept from before is refused.
  const remaining = (await request(api(""), "GET", undefined, participant)).status === 200 ? participant : second;
  const signedOut = await request(api("/signout"), "POST", { confirm: true }, remaining);
  assert.equal(signedOut.status, 200); assert.match(signedOut.headers.get("Set-Cookie")!, /Max-Age=0/);
  // Signing out keeps the seat (its passkey brings it back), so the copy's 401 does not say the seat is gone.
  const copy = await request(api(""), "GET", undefined, remaining); assert.equal(copy.status, 401);
  assert.deepEqual(await copy.json(), { error: "この端末の登録は失効したか、期限が切れました" });
  // Lost owner browser: the publisher replaces the owner invite and the old browser is cut off.
  const recovered = await invoke(functionName, profile, region, { path: api("/recover"), payload: { confirm: true } }); assert.equal(recovered.statusCode, 201);
  assert.equal((await request(api(""))).status, 401); owner = await join(recovered.body.url);
  // The new owner browser reads and edits on its cookie alone, and is asked for a passkey before an important action.
  const now = (await (await request(api(""))).json()).document.revision;
  assert.equal((await request(api("/document"), "PATCH", { type: "check", id: "c3", done: true }, owner, now)).status, 200);
  assert.equal((await request(api("/grants"), "POST", { ...invite, seats: 1 })).status, 428);
  // Passkeys: the verification logic is covered by unit tests; here only that the endpoints exist behind CloudFront and refuse nonsense.
  const pending = await request(api("/passkey/challenge"), "POST", {}, ""); assert.equal(pending.status, 200);
  const issuedChallenge = await pending.json(); assert.equal(issuedChallenge.rpId, new URL(origin).hostname);
  // Refused for the assertion, not for the missing cookie: a browser that lost its cookie must still be able to try.
  const refused = await request(api("/passkey/session"), "POST", { challenge: issuedChallenge.challenge, id: "AAAA", clientDataJSON: "AAAA", authenticatorData: "AAAA", signature: "AAAA" }, "");
  assert.equal(refused.status, 401); assert.equal((await refused.json()).error, "この端末の登録は失効したか、期限が切れました");
  // The new owner browser has no passkey yet: its first one needs no check, so a forged ceremony is refused for its challenge
  // ("もう一度やり直してください"). Both refusals are 401; only the message tells a missing check ("パスキーで本人確認してください") apart.
  const first = await request(api("/passkey"), "POST", { challenge: "A".repeat(72), clientDataJSON: "AAAA", authenticatorData: "AAAA", publicKey: "AAAA", algorithm: -7 });
  assert.equal(first.status, 401); assert.equal((await first.json()).error, "もう一度やり直してください");
  // The owner replaces the 費用メモ as a whole, at the version the trip is at now, and reads it back.
  const at = Number(JSON.parse((await request(api(""))).headers.get("ETag")!)), budget = [{ id: "b1", title: "宿", amount: 24000, description: "確認用" }];
  assert.equal((await request(api("/document"), "PATCH", { type: "budget", budget }, owner, at)).status, 200);
  assert.deepEqual((await (await request(api(""))).json()).document.budget, budget);
  // An editor revises with a chat and undoes it; the settings stay the owner's, whatever the answer holds.
  const edited = (await (await request(api("/revise"), "GET", undefined, editor)).json()).text as string; assert.ok(edited.split("## 今の旅程")[1]!.includes("この旅程は編集者が直します"));
  const draft = JSON.parse(edited.split("## 今の旅程")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!); draft.spec.title = "編集者の題"; draft.document.notes = "編集者の確認";
  const editorText = JSON.stringify(draft), from = Number(JSON.parse((await request(api(""))).headers.get("ETag")!));
  const editorShown = await (await request(api("/revise/check"), "POST", { text: editorText }, editor)).json();
  assert.deepEqual([editorShown.ok, editorShown.diff.title, editorShown.diff.other], [true, undefined, ["旅のメモ"]]);
  assert.equal((await request(api("/revise"), "POST", { text: editorText, confirm: true }, editor, from)).status, 200);
  const byEditor = await (await request(api(""))).json(); assert.deepEqual([byEditor.spec.title, byEditor.document.notes], [title, "編集者の確認"]);
  assert.equal((await request(api("/undo"), "POST", { confirm: true }, editor, from + 1)).status, 200);
  // A suggestion promoted to an item that a revise then drops can be promoted again.
  const etag = async () => Number(JSON.parse((await request(api(""))).headers.get("ETag")!));
  assert.equal((await request(api("/document"), "PATCH", { type: "suggest", author: "確認用", body: "追加し直す候補" }, owner, await etag())).status, 200);
  const retry = (await ideas()).find(p => p.body === "追加し直す候補")!.id, promote = async () => (await request(api("/document"), "PATCH", { type: "promote", id: retry, day: "2026-09-24" }, owner, await etag())).status;
  assert.equal(await promote(), 200); assert.equal(await promote(), 400);
  const madeItem = (await (await request(api(""))).json()).document.items.find((i: { description?: string }) => i.description === "追加し直す候補").id as string;
  const without = JSON.parse(((await (await request(api("/revise"))).json()).text as string).split("## 今の旅程")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!);
  without.document.items = without.document.items.filter((i: { id: string }) => i.id !== madeItem);
  assert.equal((await request(api("/revise"), "POST", { text: JSON.stringify(without), confirm: true, title: title }, owner, await etag())).status, 200);
  assert.equal(await promote(), 200);
  // Joining, passkeys and creators share one login limit of 15 a minute per address, counted in whole minutes: the creator
  // checks and the cleanup's passkey check start in a fresh minute (a second's margin for the clocks) instead of being refused.
  await new Promise(r => setTimeout(r, 61000 - Date.now() % 60000));
  // The viewer may not leave a footprint, and reads both, the participant's staying when that seat was revoked above.
  const viewer = await join(viewerLink);
  assert.equal((await request(api("/grants"), "POST", { ...invite, role: "viewer", label: "x", seats: 1 }, viewer)).status, 403);
  // An invite the owner approves (#13): the member gets a six digit code and no trip until the owner approves it. The code is not printed.
  await stepUp();
  const approvalLink = (await (await request(api("/grants"), "POST", { ...invite, label: "AWS確認用（承認）", seats: 1, approval: "owner" })).json()).url as string;
  const waiting = await redeem(approvalLink); assert.equal(waiting.status, 200);
  const waitingCookie = waiting.headers.get("set-cookie")!.split(";")[0]!, waitingBody = await waiting.json();
  secrets.push(waitingCookie.slice(waitingCookie.indexOf("=") + 1));  // the six digit code is too short to look for in a log
  assert.equal(waitingBody.pending, true); assert.match(waitingBody.code, /^\d{6}$/);
  const held = await request(api(""), "GET", undefined, waitingCookie); assert.equal(held.status, 403); assert.ok(!(await held.text()).includes('"spec"'));
  const awaiting = (await (await request(api("/grants"))).json()).flatMap((x: any) => x.members).find((m: any) => m.pending);
  assert.equal(awaiting.code, waitingBody.code);
  assert.equal((await request(api("/approve"), "POST", { member: awaiting.id, approve: true, confirm: true })).status, 200);
  assert.equal((await request(api(""), "GET", undefined, waitingCookie)).status, 200);
  assert.equal((await request(api("/footprints"), "PATCH", here, viewer)).status, 403);
  assert.deepEqual((await (await request(api(""), "GET", undefined, viewer)).json()).footprints.map((p: { lat: number; mine: boolean; auto: boolean }) => [p.lat, p.mine, p.auto]), [[35.6812, false, false], [35.6813, false, true]]);
  // An editor hands out viewer invites only, after its own passkey check (its first passkey counts as one), lists and revokes
  // its own; the owner's list says who handed each out (#107). Here, in the fresh minute: its passkey challenge counts against
  // the login limit, and the minute before has no room left.
  const editorKey = fakeAuthenticator({ origin }), { challenge: editorCheck } = await (await request(api("/passkey/challenge"), "POST", {}, "")).json();
  assert.equal((await request(api("/passkey"), "POST", { challenge: editorCheck, ...editorKey.register(editorCheck) }, editor)).status, 200);
  assert.equal((await request(api("/grants"), "POST", { ...invite, role: "editor", seats: 1 }, editor)).status, 403);
  const handed = await request(api("/grants"), "POST", { ...invite, role: "viewer", label: "AWS確認用（編集者の招待）", seats: 1 }, editor); assert.equal(handed.status, 201);
  const h = await handed.json(), editorList = await (await request(api("/grants"), "GET", undefined, editor)).json();
  assert.deepEqual(editorList.map((x: any) => x.id), [h.grantId]);
  const ownerList = await (await request(api("/grants"))).json(), editorSeat = ownerList.find((x: any) => x.label === "AWS確認用（編集）").members[0];
  assert.deepEqual(ownerList.find((x: any) => x.id === h.grantId).issuedBy, { id: editorSeat.id, label: editorSeat.label });
  assert.equal((await request(api("/revoke"), "POST", { id: h.grantId, confirm: true }, viewer)).status, 403);
  assert.equal((await request(api("/revoke"), "POST", { id: h.grantId, confirm: true }, editor)).status, 200);
  }
  // How to make a trip is shown to a signed-in creator only: without the sign-in, the instructions and the paste check are closed.
  assert.equal((await request("/v1/recipe", "GET", undefined, "")).status, 401);
  assert.equal((await request("/v1/check", "POST", { text: "すみません、旅程は作れませんでした。" }, "")).status, 401);
  assert.deepEqual(await (await request("/v1/account", "GET", undefined, "")).json(), { signedIn: false, canCreate: false, creator: null, localOnly: false, assistKey: false });
  // Generating with a creator's own API key, and registering one, are closed the same way; no key's prefix may reach the logs.
  assert.equal((await request("/v1/assist", "POST", { text: "京都 2泊3日" }, "")).status, 401);
  assert.equal((await request("/v1/account/key", "PUT", { key: "sk-ant-" + "x".repeat(40) }, "")).status, 401);
  secrets.push("sk-ant-");
  // Creators: the passkey logic is covered by unit tests; here, that the endpoints are behind CloudFront, refuse nonsense
  // without writing, and that only the IAM publisher lists them. No creator is enrolled, so nothing needs cleaning up.
  const creatorChallenge = await request("/v1/creators/challenge", "POST", {}, ""); assert.equal(creatorChallenge.status, 200);
  const { challenge } = await creatorChallenge.json(), nonsense = { clientDataJSON: "AAAA", authenticatorData: "AAAA" };
  // A link that is not usable is refused at the challenge, before a browser's OS would make a passkey for it.
  assert.equal((await request("/v1/creators/challenge", "POST", { secret: "A".repeat(43) }, "")).status, 401);
  assert.equal((await request("/v1/creators/register", "POST", { secret: "A".repeat(43), challenge, ...nonsense, publicKey: "AAAA", algorithm: -7 }, "")).status, 401);
  const refusedCreator = await request("/v1/creators/session", "POST", { challenge, id: "AAAA", ...nonsense, signature: "AAAA" }, "");
  assert.equal(refusedCreator.status, 401); assert.equal((await refusedCreator.json()).error, "サインインできませんでした");
  assert.equal((await request("/v1/creators/signout", "POST", {}, "")).status, 401);
  for (const action of ["enroll", "list", "revoke"]) assert.equal((await request(`/v1/creators/${action}`, "POST", action === "list" ? {} : { label: "x", confirm: true }, "")).status, 401);
  // A creator's trips nobody owns yet are theirs alone: without a creator's cookie there is nothing to list, take or delete.
  for (const body of [{}, { id: capsuleId, owner: true }, { id: capsuleId, purge: true, confirm: true }]) assert.equal((await request("/v1/creators/trips", "POST", body, "")).status, 401);
  // The IAM publisher reaches all three of its creator paths. Enroll without a name and revoke of nobody are refused by the
  // Host (not by the invoke's path allowlist, which would fail the invoke), and write nothing.
  const creators = await invoke(functionName, profile, region, { path: "/v1/creators/list", payload: {} });
  assert.equal(creators.statusCode, 200); assert.ok(Array.isArray(creators.body));
  assert.equal((await invoke(functionName, profile, region, { path: "/v1/creators/enroll", payload: { confirm: true } })).statusCode, 400);
  assert.equal((await invoke(functionName, profile, region, { path: "/v1/creators/revoke", payload: { creator: "nobody", confirm: true } })).statusCode, 404);
  // What the Host was built from is for the publisher alone (#103): over IAM it answers, over HTTP there is no such path.
  const version = await invoke(functionName, profile, region, { path: "/v1/version", payload: {} });
  assert.equal(version.statusCode, 200); assert.match(version.body.src, /^[a-f0-9]{40}(-dirty)?$/);
  assert.equal((await request("/v1/version", "POST", {}, "")).status, 404);
  // The operator lists every live capsule (this one among them, without its title) and terminates one, over IAM only: through
  // CloudFront, even with the owner's cookie, both are refused. A second disposable capsule is terminated, needing its id again.
  const capsules = await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} });
  assert.equal(capsules.statusCode, 200); assert.ok(capsules.body.some((c: { id: string | null }) => c.id === capsuleId));
  assert.ok(!JSON.stringify(capsules.body).includes(title)); assert.ok(capsules.body.every((c: object) => !("title" in c)));
  assert.equal((await request("/v1/capsules/list", "POST", {})).status, 401);
  assert.equal((await request(api("/terminate"), "POST", { id: capsuleId, confirm: true })).status, 401);
  const terminated = await invoke(functionName, profile, region, { payload: { ...seed, confirm: true } }); assert.equal(terminated.statusCode, 201); spare = terminated.body.id;
  // A cookie renamed for another capsule opens nothing there.
  assert.ok(owner.startsWith(`capsule_${capsuleId}=`));
  assert.equal((await request(`/v1/c/${spare}`, "GET", undefined, owner.replace(`capsule_${capsuleId}=`, `capsule_${spare}=`))).status, 401);
  assert.equal((await invoke(functionName, profile, region, { path: `/v1/c/${spare}/terminate`, payload: { id: capsuleId, confirm: true } })).statusCode, 400);
  assert.equal((await invoke(functionName, profile, region, { path: `/v1/c/${spare}/terminate`, payload: { id: spare, confirm: true } })).statusCode, 200);
  assert.equal((await fetch(`${origin}/v1/c/${spare}`)).status, 410); spare = "";
  assert.ok(!(await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} })).body.some((c: { id: string | null }) => c.id === terminated.body.id));
  // The logs (#608): CloudFront's access log (us-east-1, aws/edge-logs.yaml) has every request with its address, path and status; the
  // Web Function's own log has the ones the Host refused with the capsule, the action and a reason. Neither may hold a cookie, a secret, a #k= or a title.
  // filter-log-events searches every stream of the group from `started`, and the CLI follows its pages to the end (empty ones included).
  const logLines = async (group: string, where = region) => {
    try { const r = await cliIn(where, "logs", "filter-log-events", "--log-group-name", group, "--start-time", String(started)) as { events?: Array<{ message: string }> }; return (r.events ?? []).map(e => e.message); }
    catch { throw new Error("ログを読めませんでした。プロファイルの権限を確認してください"); }
  };
  // CloudFront's field names, as the rows the checks below look for.
  const edgeRows = (rows: Array<Record<string, unknown>>) => rows.map(r => ({ ...r, ip: r["c-ip"], path: r["cs-uri-stem"], status: r["sc-status"], requestTime: r.timestamp }));
  // A line is JSON: CloudFront's own record, or the Web Function's wrapper (time, level, request id) around what console.log wrote.
  const json = (lines: string[]) => lines.flatMap(l => { try { const o = JSON.parse(l.slice(l.indexOf("{"))) as Record<string, unknown>; return [typeof o.message === "string" && o.message.startsWith("{") ? JSON.parse(o.message) as Record<string, unknown> : o]; } catch { return []; } });
  // After the line the plain trip refuses no one with a 403 or a 429: the sealed trip's are looked for. CloudFront's path holds no query (ui=2).
  const refusing = afterLine ? `/v1/c/${sealedTripId}` : api("");
  const wanted = (rows: Array<Record<string, unknown>>) => ({
    login: rows.find(r => r.path === api("/sessions") && r.status === "401"),
    forbidden: rows.find(r => String(r.path).startsWith(refusing) && r.status === "403"),
    limited: rows.find(r => r.path === `${refusing}/footprints` && r.status === "429"),
  });
  let access: string[] = [], hostLog: string[] = [], lines = { login: undefined as unknown, forbidden: undefined as unknown, limited: undefined as unknown };
  // A line the Host wrote for a request it refused, with the viewer's address (CloudFront-Viewer-Address); the 401 is the one for this capsule's sessions.
  const hostRefused = (status: number) => json(hostLog).some(r => r.kind === "refused" && r.status === status && typeof r.ip === "string" && r.ip !== "unknown" && (status !== 401 || (r.capsule === capsuleId && r.action === "sessions")));
  for (let waited = 0; ; waited += 15000) {
    access = await logLines(`/capsule-host/${stackName}/cdn`, "us-east-1"); hostLog = await logLines(`/capsule-host/${stackName}/web.local`);
    lines = wanted(edgeRows(json(access)));
    if ((lines.login && lines.forbidden && lines.limited && hostRefused(401) && hostRefused(403) && hostRefused(429)) || waited >= 600000) break;
    await new Promise(r => setTimeout(r, 15000));
  }
  for (const [name, row] of Object.entries(lines)) {
    const r = row as Record<string, unknown> | undefined;
    assert.ok(r, `the access log has no ${name} line`);
    assert.ok(r.ip && r.path && r.status && r.requestTime, `the ${name} line lacks its address, path, status or time`);
    assert.ok(!Object.keys(r).some(k => /cookie/i.test(k)), "a cookie is in the access log");
  }
  for (const status of [401, 403, 429]) assert.ok(hostRefused(status), `the Host's log has no refused ${status} line`);
  const all = [...access, ...hostLog].join("\n");
  for (const secret of secrets) assert.ok(secret.length < 12 || !all.includes(secret.slice(0, 12)), "a capsule secret is in the logs");
  assert.ok(!all.includes("#k=") && !all.includes(title) && !all.includes(encodeURIComponent(title)), "a #k= or the title is in the logs");
  // Whose address the access log holds: CloudFront logs the viewer's own address, never one of its edges. Said as a word only.
  const ip = String((lines.login as Record<string, unknown>).ip);
  const edge = await (async () => {
    try {
      const ranges = (await (await fetch("https://ip-ranges.amazonaws.com/ip-ranges.json")).json()).prefixes as Array<{ ip_prefix: string; service: string }>;
      if (ip.includes(":")) return undefined;  // IPv6: not judged
      const num = (a: string) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
      return ranges.some(p => p.service.startsWith("CLOUDFRONT") && (() => { const [base, bits] = p.ip_prefix.split("/"); const size = 2 ** (32 - Number(bits)); return Math.floor(num(ip) / size) === Math.floor(num(base!) / size); })());
    } catch { return undefined; }
  })();
  assert.ok(edge !== true, "the access log holds a CloudFront edge's address, not the viewer's");
  console.log(`access log address: ${edge === undefined ? "unknown" : "not an edge (viewer)"}`);
  // After the line, the plain trip's scenes were not run (the dev run without the line goes through them): the summary says what was.
  if (afterLine) console.log("AWS verification passed (after the line): the plain trip published after it (409 画面を更新してください without ui=2; 409 オーナーがこの旅行を移すまで開けません for an invite, an edit and a footprint; mustSeal for the owner and in the operator's list), a plain trip moved by its owner alone (opened back the same, an older screen asked to reload, listed as sealed), the trip key replaced after a member's revocation (every ciphertext of the next generation in the stored payload, the remaining member reading it, the revoked member's old key not opening it), the new owner asked after recover and keeping the key, a trip sealed under the owner's trip key and its participant invited after the seal (opened back the same, a participant's sealed post taken and item refused, theme.css as before, the operator's list sealed and no longer mustSeal, export 409, a footprint and names sealed, 429 within the minute, 403 for a viewer, purged without a title), function URL direct 403 (always), generation and key registration closed without a creator, no CORS, OPTIONS refused, a cookie moved to another capsule refused; CloudFront's access log and the Host's refused lines (401 / 403 / 429 with IP, path and status; no cookie, invite secret, #k= or title), assets (app.js carrying its packages' notices), IAM-only publish, idempotent publish (a fresh owner link while the seat is free), edge-only API, seat binding, paste endpoints closed without a creator, creator endpoints, the build read by the publisher only, operator list and terminate (IAM only, no title, 410 after), the page's Permissions-Policy, the page files compressed (br / gzip), both map files by range (206), the plain trip purged by its owner with the new screen's mark.");
  else console.log("AWS verification passed: a plain trip moved by its owner (its points and names sealed with it, opened back the same, an older screen asked to reload, listed as sealed), the trip key replaced after a member's revocation (every ciphertext of the next generation in the stored payload, the remaining member reading it, the revoked member's old key not opening it), the new owner asked after recover and keeping the key, a trip sealed under the owner's trip key (opened back the same, a participant's sealed post taken and item refused, theme.css and the operator's list as before, export 409, purged without a title), function URL direct 403 (always), generation and key registration closed without a creator, no CORS, OPTIONS refused, a cookie moved to another capsule refused, viewer/editor owner-only actions refused; CloudFront's access log and the Host's refused lines (401 / 403 / 429 with IP, path and status; no cookie, invite secret, #k= or title), owner approval, assets (app.js carrying its packages' notices), IAM-only publish, idempotent publish (a fresh owner link while the seat is free), edge-only API, seat binding, per-member revoke (its 401 saying the seat is gone, a signed-out copy's not), permissions, the owner's history of invites (not the editor's), an editor's own viewer invites (another role refused, issued, listed, named in the owner's list, revoked by it and not by a viewer), Origin, revision conflicts, ZIP, the trip page as one file (every role, no private entry), owner recovery, passkey endpoints, paste endpoints closed without a creator, creator endpoints, the build read by the publisher only, operator list and terminate (IAM only, no title, 410 after), revising and undo, editors revising without the settings, reordering a day (the host's time a placeholder, the end carried along; an item without a time given one), an item's end (saved, refused before its start), an item added after another (placed there, its time fitted; another day refused), the 準備 list and 費用メモ changed by the owner (not by a participant), a participant's 候補 rewritten and removed by the owner (not by the participant), a passkey check before the owner's important actions (428 on the cookie alone; reading and editing not asked), no passkey swapped in on the cookie alone, a member signing out (a copy of the cookie refused), creator sign-out closed without a cookie, trip keys put by the owner's browser (wrapped only; not in the table's stored payloads on dev; a participant refused), trip key handed over by confirmation codes (wrapped only), a member's own entry sealed as the screen seals it and read back by that member only (not in the owner's trip or the ZIP; on dev, not in the table's stored payloads either), the page's Permissions-Policy (the position open, the camera and microphone closed), the page files compressed (br / gzip), the footprint map's parts and both map files by range (206), a footprint left by a participant and an automatic one by the owner, read by the owner (no revision moved; the automatic one marked), refused to a viewer, who reads both after the participant's seat was revoked.");
} finally {
  // A failure here must not keep the first capsule from its purge below.
  if (sealedId) try { const r = await invoke(functionName, profile, region, { path: `/v1/c/${sealedId}/terminate`, payload: { id: sealedId, confirm: true } }); console.log([200, 410].includes(r.statusCode) ? "The sealed disposable capsule was terminated." : `The sealed disposable capsule was not terminated (${r.statusCode}); check it with aws/capsules.ts list.`); } catch (e) { console.log(`The sealed disposable capsule was not terminated: ${(e as Error).message}`); }
  if (spare) try { const r = await invoke(functionName, profile, region, { path: `/v1/c/${spare}/terminate`, payload: { id: spare, confirm: true } }); console.log([200, 410].includes(r.statusCode) ? "The second disposable capsule was terminated." : `The second disposable capsule was not terminated (${r.statusCode}); check it with aws/capsules.ts list.`); } catch (e) { console.log(`The second disposable capsule was not terminated (${e instanceof Error ? e.message : e}); check it with aws/capsules.ts list.`); }
  for (const url of unredeemed.reverse()) { if (!capsuleId || owner) break; try { owner = await join(url); } catch { /* replaced by the retry */ } }
  if (capsuleId && owner) { await stepUp(ui); const purged = await request(api("/purge") + ui, "POST", { title }); assert.equal(purged.status, 200); assert.equal((await request(api(""))).status, 410); console.log("Disposable test capsule removed; subsequent access returns 410."); }
}
