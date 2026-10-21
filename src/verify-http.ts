import assert from "node:assert/strict";
import { fakeAuthenticator, testTrip, tripDay } from "./test-fixture";
import { localDay } from "./schema";

// Uses a disposable capsule on an already-running local host; never prints capability links/cookies.
const origin = process.env.CAPSULE_ORIGIN ?? "http://localhost:47840";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Verification is restricted to a local host");
let capsuleId = "", owner = "";
// Owner links not yet redeemed, newest last: if a check fails before the owner seat is taken, `finally` takes it to purge.
const unredeemed: string[] = [];
const request = (path: string, method = "GET", body?: unknown, cookie = owner, revision = 1, source = origin) => fetch(origin + path, { method, headers: { Origin: source, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  const invite = { role: "participant", label: "HTTP確認用", expiresAt: seed.spec.lifecycle.purgeAt, confirm: true };
  // The owner's cookie alone does not hand out a seat; after the passkey check it does.
  assert.equal((await request(api("/grants"), "POST", invite)).status, 428);
  await stepUp();
  const issued = await request(api("/grants"), "POST", invite);
  assert.equal(issued.status, 201); const g = await issued.json(); const participant = await login(g.url);
  const editor = await login((await (await request(api("/grants"), "POST", { ...invite, role: "editor", label: "HTTP確認用（編集）" })).json()).url);
  // The owner reads who issued and took which invite, newest first; nobody else reads it.
  const history = await request(api("/history")); assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).slice(0, 2).map((a: any) => [a.event, a.role, a.label]), [["sessions", "editor", "HTTP確認用（編集）"], ["grants", "editor", "HTTP確認用（編集）"]]);
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
  const exportResponse = await request(api("/export")); assert.equal(exportResponse.status, 200);
  const archive = Buffer.from(await exportResponse.arrayBuffer()); assert.equal(archive.readUInt32LE(0), 0x04034b50);
  // Parse uncompressed ZIP entries and verify that each required artifact is present.
  const files = new Map<string, string>(); let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) { const size = archive.readUInt32LE(offset + 18), n = archive.readUInt16LE(offset + 26), extra = archive.readUInt16LE(offset + 28); const start = offset + 30 + n + extra; files.set(archive.subarray(offset + 30, offset + 30 + n).toString(), archive.subarray(start, start + size).toString()); offset = start + size; }
  assert.equal(files.size, 5); assert.equal(JSON.parse(files.get("trip.json")!).document.revision, 2);
  // A member's own entry is read back by that member only: not in the owner's trip, nor in the ZIP. It moves no revision. The words
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
  const ownerView = await request(api("")); assert.equal(ownerView.headers.get("ETag"), '"2"'); const seen = await ownerView.text(); assert.ok(!seen.includes(sealed) && !seen.includes(marker));
  assert.ok(!Buffer.from(await (await request(api("/export"))).arrayBuffer()).includes(Buffer.from(sealed)));
  // A footprint: a participant leaves one, once a minute; a viewer may not. Every member reads it, and no revision moves.
  await stepUp(); const viewer = await login((await (await request(api("/grants"), "POST", { ...invite, role: "viewer", label: "HTTP確認用（閲覧）" })).json()).url);
  const here = { type: "add", lat: 35.6812, lng: 139.7671, accuracy: 20 };
  assert.equal((await request(api("/footprints"), "PATCH", here, participant)).status, 200);
  assert.equal((await request(api("/footprints"), "PATCH", here, viewer)).status, 403);
  assert.equal((await request(api("/footprints"), "PATCH", here, participant)).status, 429);
  const left = await request(api(""), "GET", undefined, viewer); assert.equal(left.headers.get("ETag"), '"2"');
  assert.deepEqual((await left.json()).footprints.map((p: { lat: number; mine: boolean }) => [p.lat, p.mine]), [[35.6812, false]]);
  // Revising with a chat: only the owner copies, checks and applies, from this site only; the change applied is the one shown.
  assert.equal((await request(api("/revise"), "GET", undefined, participant)).status, 403);
  const copied = (await (await request(api("/revise"))).json()).text as string;
  const trip = JSON.parse(copied.split("## 今の旅程")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!);
  assert.deepEqual(trip.document.suggestions, [{ id: "before-revise", body: "反映前の候補", promoted: false }]);
  assert.equal(trip.document.suggestions[0].author, undefined);
  trip.document.items[1].startsAt = `${d1}T18:30:00+09:00`;
  trip.document.suggestions = [{ id: "after-revise", body: "反映で足した候補", promoted: false }];
  trip.document.comments.push({ id: "revise-talk", body: "広域で相談する" });
  const text = `直しました。\n${JSON.stringify(trip)}`;
  const shown = await (await request(api("/revise/check"), "POST", { text })).json();
  assert.deepEqual([shown.ok, shown.revision, shown.diff.items.map((i: { change: string }) => i.change)], [true, 2, ["changed"]]);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true }, participant, 2)).status, 403);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true }, owner, 2, "https://evil.example")).status, 403);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true }, owner, 1)).status, 409);
  assert.deepEqual(shown.diff.suggestions.map((r: { change: string }) => r.change), ["added", "removed"]);
  assert.deepEqual(shown.diff.comments.map((r: { change: string }) => r.change), ["added"]);
  assert.equal(shown.diff.large, true);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true }, owner, 2)).status, 400);
  assert.equal((await request(api("/revise"), "POST", { text, confirm: true, title: seed.spec.title }, owner, 2)).status, 200);
  const applied = (await (await request(api(""))).json()).document;
  assert.deepEqual(applied.suggestions.map((p: { id: string }) => p.id), ["after-revise"]); assert.equal(applied.comments[0].body, "広域で相談する");
  assert.equal((await request(api(""))).headers.get("ETag"), '"3"');
  // One step back, by the owner only.
  assert.equal((await request(api("/undo"), "GET", undefined, participant)).status, 403);
  assert.deepEqual((await (await request(api("/undo"))).json()).diff.items.map((i: { change: string }) => i.change), ["changed"]);
  assert.equal((await request(api("/undo"), "POST", { confirm: true }, participant, 3)).status, 403);
  assert.equal((await request(api("/undo"), "POST", { confirm: true, title: seed.spec.title }, owner, 3)).status, 200);
  assert.equal((await request(api("/undo"))).status, 404);
  const back = (await (await request(api(""))).json()).document;
  assert.deepEqual(back.suggestions, seed.document.suggestions); assert.deepEqual(back.comments, seed.document.comments);
  // Reordering a day: the owner drops the day's last item before its first and the host gives it a time ahead of it; a participant may not.
  const dropped = { type: "move", id: "checkin", before: "arrival" };
  assert.equal((await request(api("/document"), "PATCH", dropped, participant, 4)).status, 403);
  const movedTo = await request(api("/document"), "PATCH", dropped, owner, 4); assert.equal(movedTo.status, 200);
  assert.deepEqual((await movedTo.json()).moved, { id: "checkin", startsAt: `${d0}T03:45:00.000Z` });
  const reordered = (await (await request(api(""))).json()).document.items as Array<{ id: string; startsAt?: string; timeTentative?: boolean }>;
  assert.deepEqual(reordered.map(i => i.id), ["checkin", "arrival", "dinner", "walk"]); assert.deepEqual([reordered[0]!.startsAt, reordered[0]!.timeTentative], [`${d0}T03:45:00.000Z`, true]);
  // An item without a time, as a trip published before may hold: an edit still saves it, and dropped last in its day it is given
  // an hour after the day's last item (which has no end), marked a placeholder.
  const free = { id: "free", title: "自由行動", day: d0, kind: "activity", status: "proposed", revision: 1 };
  assert.equal((await request(api("/document"), "PATCH", { type: "item", item: free }, owner, 5)).status, 200);
  const freed = await request(api("/document"), "PATCH", { type: "move", id: "free", before: null }, owner, 6); assert.equal(freed.status, 200);
  assert.deepEqual((await freed.json()).moved, { id: "free", startsAt: `${d0}T05:15:00.000Z` });
  const placed = (await (await request(api(""))).json()).document.items as Array<{ id: string; startsAt?: string; timeTentative?: boolean }>;
  assert.deepEqual(placed.map(i => i.id), ["checkin", "arrival", "free", "dinner", "walk"]); assert.equal(placed[2]!.timeTentative, true);
  // The owner replaces the 費用メモ as a whole, at the version the trip is at now, and reads it back.
  const at = Number(JSON.parse((await request(api(""))).headers.get("ETag")!)), budget = [{ id: "b1", title: "宿", amount: 24000, description: "確認用" }];
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
  // An editor revises with a chat and undoes it; the settings stay the owner's, whatever the answer holds.
  const edited = (await (await request(api("/revise"), "GET", undefined, editor)).json()).text as string; assert.ok(edited.split("## 今の旅程")[1]!.includes("この旅程は編集者が直します"));
  const draft = JSON.parse(edited.split("## 今の旅程")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!); draft.spec.title = "編集者の題"; draft.document.notes = "編集者の確認";
  const editorText = JSON.stringify(draft), from = Number(JSON.parse((await request(api(""))).headers.get("ETag")!));
  const editorShown = await (await request(api("/revise/check"), "POST", { text: editorText }, editor)).json();
  assert.deepEqual([editorShown.ok, editorShown.diff.title, editorShown.diff.other], [true, undefined, ["旅のメモ"]]);
  assert.equal((await request(api("/revise"), "POST", { text: editorText, confirm: true }, editor, from)).status, 200);
  const byEditor = await (await request(api(""))).json(); assert.deepEqual([byEditor.spec.title, byEditor.document.notes], [seed.spec.title, "編集者の確認"]);
  assert.equal((await request(api("/undo"), "POST", { confirm: true }, editor, from + 1)).status, 200);
  // A suggestion promoted to an item that a revise then drops can be promoted again.
  const etag = async () => Number(JSON.parse((await request(api(""))).headers.get("ETag")!));
  assert.equal((await request(api("/document"), "PATCH", { type: "suggest", author: "確認用", body: "追加し直す候補" }, participant, await etag())).status, 200);
  const retry = (await ideas()).find(p => p.body === "追加し直す候補")!.id, promote = async () => (await request(api("/document"), "PATCH", { type: "promote", id: retry, day: d0 }, owner, await etag())).status;
  assert.equal(await promote(), 200); assert.equal(await promote(), 400);
  const madeItem = (await (await request(api(""))).json()).document.items.find((i: { description?: string }) => i.description === "追加し直す候補").id as string;
  const without = JSON.parse(((await (await request(api("/revise"))).json()).text as string).split("## 今の旅程")[1]!.match(/```json\n([\s\S]*?)\n```/)![1]!);
  without.document.items = without.document.items.filter((i: { id: string }) => i.id !== madeItem);
  assert.equal((await request(api("/revise"), "POST", { text: JSON.stringify(without), confirm: true, title: seed.spec.title }, owner, await etag())).status, 200);
  assert.equal(await promote(), 200);
  assert.equal((await request(api("/revoke"), "POST", { id: g.grantId, confirm: true })).status, 200);
  assert.equal((await request(api(""), "GET", undefined, participant)).status, 401);
  console.log("HTTP verification passed: assets, a retried publish (one trip, a fresh owner link while the seat is free), sessions, permissions, the owner's history of invites (not the editor's), an editor's own viewer invites (another role refused, issued, listed, named in the owner's list, revoked by it and not by a participant), Origin, revision conflicts, ZIP, revising and undo, editors revising without the settings, reordering a day (the host's time a placeholder; an item without a time given one), the 準備 list and 費用メモ changed by the owner (not by a participant), a participant's 候補 rewritten and removed by the owner (not by the participant), revocation, a passkey check before the owner's important actions, a member's own entry read back by that member only (not in the owner's trip or the ZIP), a footprint left by a participant once a minute (not by a viewer) and read by every member.");
} finally {
  for (const url of unredeemed.reverse()) { if (!capsuleId || owner) break; try { owner = await login(url); } catch { /* replaced by the retry */ } }
  if (capsuleId && owner) { await stepUp(); const purged = await request(api("/purge"), "POST", { title: "HTTP動作確認用（自動削除）" }); assert.equal(purged.status, 200); assert.equal((await request(api(""))).status, 410); console.log("Disposable test capsule removed; subsequent access returns 410."); }
}
