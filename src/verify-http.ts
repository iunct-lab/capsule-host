import assert from "node:assert/strict";
import { fakeAuthenticator, handKey, sealedRequests, sealedTrip, testTrip, tripDay, type CapsuleRequest } from "./test-fixture";
import { localDay } from "./schema";

// Uses a disposable capsule on an already-running local host; never prints capability links/cookies.
const origin = process.env.CAPSULE_ORIGIN ?? "http://localhost:47840";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Verification is restricted to a local host");
let capsuleId = "", owner = "";
// Owner links not yet redeemed, newest last: if a check fails before the owner seat is taken, `finally` takes it to purge.
const unredeemed: string[] = [];
type Request = (path: string, method?: string, body?: unknown, cookie?: string, revision?: number, source?: string) => Promise<Response>;
// The new screen marks what it sends to a trip (ui=2, src/client.ts api()).
let request: Request = (path: string, method = "GET", body?: unknown, cookie = owner, revision = 1, source = origin) => fetch(origin + path + (path.startsWith("/v1/c/") ? "?ui=2" : ""), { method, headers: { Origin: source, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const api = (action: string) => `/v1/c/${capsuleId}${action}`;
async function login(url: string) {
  const secret = new URLSearchParams(new URL(url).hash.slice(1)).get("k");
  const r = await request(api("/sessions"), "POST", { secret }, ""); assert.equal(r.status, 200);
  assert.match(r.headers.get("Set-Cookie")!, /HttpOnly; SameSite=Strict/); return r.headers.get("Set-Cookie")!.split(";")[0]!;
}
// The owner's important actions need a passkey check in the last five minutes; registering the first passkey counts as one.
const device = fakeAuthenticator({ origin }); let registered = false;
async function stepUp() {
  const { challenge } = await (await request(api("/passkey/challenge"), "POST", {}, "")).json();
  const r = registered ? await request(api("/passkey/verify"), "POST", { challenge, id: device.id, ...device.assert(challenge) }) : await request(api("/passkey"), "POST", { challenge, ...device.register(challenge) });
  assert.equal(r.status, 200); registered = true;
}
// The trip sealed by its owner's browser right after the seat is taken, as every trip is (docs/design/trip-e2e.md §5, the third
// step of handing out): then `request` seals what is written to the trip and opens what is read from it, as a browser holding
// the trip key does (src/test-fixture.ts sealedTrip, sealedRequests). The owner has just checked with its passkey.
let receive: (cookie: string) => Promise<string> = async cookie => cookie;
async function sealAfterClaim() {
  const plain = request, base = api(""), under: CapsuleRequest = (p = "", m = "GET", b?, c = owner, r = 1, s = origin) => plain(base + p, m, b, c, r, s);
  const seal = await sealedTrip(under, capsuleId, owner), sealed = sealedRequests(under, capsuleId, seal);
  // A member reads and writes once its seat holds the trip key, handed from the owner's (the codes compared by the two screens).
  receive = async (cookie: string) => { await handKey(under, capsuleId, seal.owner, seal.trip, cookie); return cookie; };
  request = (path, method = "GET", body?, cookie = owner, revision = 1, source = origin) => path === base || path.startsWith(base + "/") ? sealed(path.slice(base.length), method, body, cookie, revision, source) : plain(path, method, body, cookie, revision, source);
}
try {
  const page = await request("/"); assert.equal(page.status, 200); assert.match(await page.text(), /app.js/);
  for (const path of ["/app.js", "/app.css"]) { const r = await request(path); assert.equal(r.status, 200); assert.ok((await r.text()).length > 1000); }
  // The trip starts today, so it is under way while it is checked: footprints are left during the trip only.
  const d0 = localDay(Date.now(), "Asia/Tokyo"), d1 = tripDay(d0, 1);
  const seed = testTrip(d0); seed.spec.title = "HTTP動作確認用（自動削除）";
  seed.document.suggestions = [{ id: "before-revise", body: "反映前の候補", promoted: false, author: "HTTP確認用", createdAt: "2026-09-16T00:00:00Z" }];
  // A second item on the first day, so that day has an order to change.
  seed.document.items.push({ id: "checkin", title: "チェックイン", day: d0, startsAt: `${d0}T15:00:00+09:00`, kind: "stay", status: "confirmed", revision: 1 });
  // The answer to a save is lost and the same operation id is sent again: one trip, and while the owner seat is free a fresh
  // owner link that replaces the lost one. Once the seat is held, a retry is only told the trip exists.
  const operationId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  const created = await request("/v1/publish", "POST", { ...seed, confirm: true, operationId }); assert.equal(created.status, 201);
  const lost = await created.json(); capsuleId = lost.id; unredeemed.push(lost.url);
  const retried = await request("/v1/publish", "POST", { ...seed, confirm: true, operationId }); assert.equal(retried.status, 200);
  const c = await retried.json(); assert.equal(c.id, lost.id); assert.equal(c.replayed, true); assert.ok(c.url); unredeemed.push(c.url);
  assert.equal((await request(api("/sessions"), "POST", { secret: new URLSearchParams(new URL(lost.url).hash.slice(1)).get("k") }, "")).status, 401);
  owner = await login(c.url);
  const held = await (await request("/v1/publish", "POST", { ...seed, confirm: true, operationId })).json(); assert.equal(held.replayed, true); assert.equal(held.url, undefined);
  // Local-only routes answer for the configured host only, and carry the same policy headers as the API.
  const health = await request("/health"); assert.equal(health.status, 200); assert.match(health.headers.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
  assert.equal((await fetch(origin + "/v1/preview", { headers: { Host: "evil.example" } })).status, 403);
  // A protocol-relative path must not smuggle its own host past that check.
  assert.equal((await fetch(origin + "//evil.example/v1/preview", { headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await fetch(origin + "//evil.example/v1/preview")).status, 404);
  // A loopback server may publish, and nothing more: replacing the owner invite stays with the IAM publisher on AWS.
  assert.equal((await request(api("/recover"), "POST", { confirm: true }, "")).status, 401);
  const get = await request(api("")); assert.equal(get.status, 200); assert.equal(get.headers.get("ETag"), '"1"');
  assert.match(get.headers.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
  // Sealing is an important action: the owner's cookie alone does not seal the trip; after the passkey check it does.
  assert.equal((await request(api("/seal"), "POST", { confirm: true })).status, 428);
  await stepUp(); await sealAfterClaim();
  const invite = { role: "participant", label: "HTTP確認用", expiresAt: seed.spec.lifecycle.purgeAt, confirm: true };
  const issued = await request(api("/grants"), "POST", invite);
  assert.equal(issued.status, 201); const g = await issued.json(); const participant = await receive(await login(g.url));
  const editorInvite = await (await request(api("/grants"), "POST", { ...invite, role: "editor", label: "HTTP確認用（編集）" })).json(), editor = await receive(await login(editorInvite.url));
  // The owner reads who issued and took which invite, newest first, by the invite's id (a sealed trip's history holds no name); nobody else reads it.
  const history = await request(api("/history")); assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).slice(0, 2).map((a: any) => [a.event, a.role, a.grant]), [["sessions", "editor", editorInvite.grantId], ["grants", "editor", editorInvite.grantId]]);
  assert.equal((await request(api("/history"), "GET", undefined, editor)).status, 403);
  // An editor hands out viewer invites only, after its own passkey check (its first passkey counts as one), lists and revokes
  // its own; the owner's list says who handed each out (#107).
  const editorKey = fakeAuthenticator({ origin }), { challenge: editorCheck } = await (await request(api("/passkey/challenge"), "POST", {}, "")).json();
  assert.equal((await request(api("/passkey"), "POST", { challenge: editorCheck, ...editorKey.register(editorCheck) }, editor)).status, 200);
  assert.equal((await request(api("/grants"), "POST", { ...invite, role: "editor" }, editor)).status, 403);
  const handed = await request(api("/grants"), "POST", { ...invite, role: "viewer", label: "HTTP確認用（編集者の招待）" }, editor); assert.equal(handed.status, 201);
  const h = await handed.json(), editorList = await (await request(api("/grants"), "GET", undefined, editor)).json();
  assert.deepEqual(editorList.map((x: any) => x.id), [h.grantId]);
  const ownerList = await (await request(api("/grants"))).json(), editorSeat = ownerList.find((x: any) => x.label === "HTTP確認用（編集）").members[0];
  assert.deepEqual(ownerList.find((x: any) => x.id === h.grantId).issuedBy, { id: editorSeat.id, label: editorSeat.label });
  assert.equal((await request(api("/revoke"), "POST", { id: h.grantId, confirm: true }, participant)).status, 403);
  assert.equal((await request(api("/revoke"), "POST", { id: h.grantId, confirm: true }, editor)).status, 200);
  assert.equal((await request(api("/document"), "PATCH", { type: "notes", body: "unauthorized" }, participant)).status, 403);
  // The 準備 list, the 費用メモ and the 候補・相談 posts are changed by the owner and editors only (refused before the post is
  // looked for); a participant may still tick (below).
  for (const op of [{ type: "checklist", checklist: [] }, { type: "budget", budget: [] }, { type: "rewrite", list: "suggestions", id: "x", body: "x" }, { type: "remove", list: "comments", id: "x" }]) assert.equal((await request(api("/document"), "PATCH", op, participant)).status, 403);
  assert.equal((await request(api("/document"), "PATCH", { type: "check", id: "c3", done: true }, owner, 1, "https://evil.example")).status, 403);
  assert.equal((await request(api("/document"), "PATCH", { type: "check", id: "c3", done: true }, participant)).status, 200);
  assert.equal((await request(api("/document"), "PATCH", { type: "check", id: "c3", done: false }, owner)).status, 409);
  // The host keeps the trip's words sealed and makes no ZIP of them: the owner's browser does (the host has no export, 404).
  assert.equal((await request(api("/export"))).status, 404);
  // A member's own entry is read back by that member only: not in the owner's trip. It moves no revision. The words
  // go in sealed (here any v1. text stands in for the browser's ciphertext): after the seat's passkey hands in its wrapped key, a
  // plain title is refused, and the host gives the sealed text back as it was, the plain words nowhere.
  const marker = "HTTP確認用の個人メモ", sealed = `v1.${Buffer.from(`sealed:${marker}`).toString("base64url")}`, seat = fakeAuthenticator({ origin });
  const entry = (title: string) => ({ type: "put", entry: { id: "http-private", kind: "item", day: d1, startsAt: `${d1}T09:00:00+09:00`, title, body: title } });
  assert.equal((await request(api("/private"), "PATCH", entry(sealed), participant)).status, 400);
  const { challenge: seated } = await (await request(api("/passkey/challenge"), "POST", {}, "")).json();
  assert.equal((await request(api("/passkey"), "POST", { challenge: seated, ...seat.register(seated) }, participant)).status, 200);
  assert.equal((await request(api("/private"), "PATCH", { type: "key", wrapped: `v1.${"A".repeat(80)}` }, participant)).status, 200);
  assert.equal((await request(api("/private"), "PATCH", entry(marker), participant)).status, 400);
  assert.equal((await request(api("/private"), "PATCH", entry(sealed), participant)).status, 200);
  const own = await (await request(api(""), "GET", undefined, participant)).text(); assert.ok(own.includes(sealed)); assert.ok(!own.includes(marker));
  // The host's revision: the published trip's 1, the seal's 2 and the tick's 3.
  const ownerView = await request(api("")); assert.equal(ownerView.headers.get("ETag"), '"3"'); const seen = await ownerView.text(); assert.ok(!seen.includes(sealed) && !seen.includes(marker));
  // A footprint: a participant leaves one, once a minute; a viewer may not. Every member reads it, and no revision moves.
  await stepUp(); const viewer = await receive(await login((await (await request(api("/grants"), "POST", { ...invite, role: "viewer", label: "HTTP確認用（閲覧）" })).json()).url));
  const here = { type: "add", lat: 35.6812, lng: 139.7671, accuracy: 20 };
  assert.equal((await request(api("/footprints"), "PATCH", here, participant)).status, 200);
  assert.equal((await request(api("/footprints"), "PATCH", here, viewer)).status, 403);
  assert.equal((await request(api("/footprints"), "PATCH", here, participant)).status, 429);
  const left = await request(api(""), "GET", undefined, viewer); assert.equal(left.headers.get("ETag"), '"3"');
  assert.deepEqual((await left.json()).footprints.map((p: { lat: number; mine: boolean }) => [p.lat, p.mine]), [[35.6812, false]]);
  // Revising with a chat and going back are the browser's in a sealed trip: the host neither copies the trip's words nor reads an answer (404).
  for (const [path, method, body] of [["/revise", "GET", undefined], ["/revise/check", "POST", { text: "{}" }]] as const) assert.equal((await request(api(path), method, body)).status, 404);
  // The trip's revision as the test counts it, from the published trip (src/test-fixture.ts sealedRequests takes the seal's off).
  const rev = async () => (await (await request(api(""))).json()).document.revision as number;
  // Reordering a day: the owner drops the day's last item before its first and the host gives it a time ahead of it; a participant may not.
  const dropped = { type: "move", id: "checkin", before: "arrival" };
  assert.equal((await request(api("/document"), "PATCH", dropped, participant, await rev())).status, 403);
  const movedTo = await request(api("/document"), "PATCH", dropped, owner, await rev()); assert.equal(movedTo.status, 200);
  assert.deepEqual((await movedTo.json()).moved, { id: "checkin", startsAt: `${d0}T03:45:00.000Z` });
  const reordered = (await (await request(api(""))).json()).document.items as Array<{ id: string; startsAt?: string; timeTentative?: boolean }>;
  assert.deepEqual(reordered.map(i => i.id), ["checkin", "arrival", "dinner", "walk"]); assert.deepEqual([reordered[0]!.startsAt, reordered[0]!.timeTentative], [`${d0}T03:45:00.000Z`, true]);
  // An item without a time, as a trip published before may hold: an edit still saves it, and dropped last in its day it is given
  // an hour after the day's last item (which has no end), marked a placeholder.
  const free = { id: "free", title: "自由行動", day: d0, kind: "activity", status: "proposed", revision: 1 };
  assert.equal((await request(api("/document"), "PATCH", { type: "item", item: free }, owner, await rev())).status, 200);
  const freed = await request(api("/document"), "PATCH", { type: "move", id: "free", before: null }, owner, await rev()); assert.equal(freed.status, 200);
  assert.deepEqual((await freed.json()).moved, { id: "free", startsAt: `${d0}T05:15:00.000Z` });
  const placed = (await (await request(api(""))).json()).document.items as Array<{ id: string; startsAt?: string; timeTentative?: boolean }>;
  assert.deepEqual(placed.map(i => i.id), ["checkin", "arrival", "free", "dinner", "walk"]); assert.equal(placed[2]!.timeTentative, true);
  // The owner replaces the 費用メモ as a whole, at the version the trip is at now, and reads it back.
  const at = await rev(), budget = [{ id: "b1", title: "宿", amount: 24000, description: "確認用" }];
  assert.equal((await request(api("/document"), "PATCH", { type: "budget", budget }, owner, at)).status, 200);
  assert.deepEqual((await (await request(api(""))).json()).document.budget, budget);
  // A participant's 候補: the owner changes its words and then takes it out; the participant may do neither.
  const posted = at + 1, ideas = async () => (await (await request(api(""))).json()).document.suggestions as Array<{ id: string; body: string }>;
  assert.equal((await request(api("/document"), "PATCH", { type: "suggest", author: "HTTP確認用", body: "確認用の候補" }, participant, posted)).status, 200);
  const idea = (await ideas()).find(x => x.body === "確認用の候補")!.id;
  for (const op of [{ type: "rewrite", list: "suggestions", id: idea, body: "x" }, { type: "remove", list: "suggestions", id: idea }]) assert.equal((await request(api("/document"), "PATCH", op, participant, posted + 1)).status, 403);
  assert.equal((await request(api("/document"), "PATCH", { type: "rewrite", list: "suggestions", id: idea, body: "直した候補" }, owner, posted + 1)).status, 200);
  assert.equal((await ideas()).find(x => x.id === idea)?.body, "直した候補");
  assert.equal((await request(api("/document"), "PATCH", { type: "remove", list: "suggestions", id: idea }, owner, posted + 2)).status, 200);
  assert.equal((await ideas()).some(x => x.id === idea), false);
  // A suggestion promoted to the plan once; the owner's browser does not promote it again (it is added already).
  assert.equal((await request(api("/document"), "PATCH", { type: "suggest", author: "確認用", body: "追加する候補" }, participant, await rev())).status, 200);
  const once = (await ideas()).find(p => p.body === "追加する候補")!.id, promote = async () => (await request(api("/document"), "PATCH", { type: "promote", id: once, day: d0 }, owner, await rev())).status;
  assert.equal(await promote(), 200); await assert.rejects(promote(), /追加済み/);
  assert.ok((await (await request(api(""))).json()).document.items.some((i: { description?: string }) => i.description === "追加する候補"));
  assert.equal((await request(api("/revoke"), "POST", { id: g.grantId, confirm: true })).status, 200);
  assert.equal((await request(api(""), "GET", undefined, participant)).status, 401);
  console.log("HTTP verification passed, on a trip its owner sealed right after claiming the seat (each member reading it once its seat holds the key): assets, a retried publish (one trip, a fresh owner link while the seat is free), sessions, permissions, the owner's history of invites by id (not the editor's), an editor's own viewer invites (another role refused, issued, listed, named in the owner's list, revoked by it and not by a participant), Origin, revision conflicts, the host making no ZIP and revising nothing (404: the browser's in a sealed trip), reordering a day (the host's time a placeholder; an item without a time given one), the 準備 list and 費用メモ changed by the owner (not by a participant), a participant's 候補 rewritten and removed by the owner (not by the participant) and promoted once, revocation, a passkey check before the owner's important actions (sealing first), a member's own entry read back by that member only (not in the owner's trip), a footprint left by a participant once a minute (not by a viewer) and read by every member.");
} finally {
  for (const url of unredeemed.reverse()) { if (!capsuleId || owner) break; try { owner = await login(url); } catch { /* replaced by the retry */ } }
  if (capsuleId && owner) { await stepUp(); const purged = await request(api("/purge"), "POST", { title: "HTTP動作確認用（自動削除）" }); assert.equal(purged.status, 200); assert.equal((await request(api(""))).status, 410); console.log("Disposable test capsule removed; subsequent access returns 410."); }
}
