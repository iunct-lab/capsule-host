import { describe, test, expect, afterEach } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CloudHost, secure } from "./cloud-host";
import { open as openKey, seal as sealKey } from "./key-store";
import { exportFiles, tripHtml, tripMarkdown, zip } from "./export";
import { LocalD1 } from "./local-d1";
import { LocalMediaStore, type MediaStore } from "./media-store";
import { validate, stateOf } from "./schema";
import { fakeAuthenticator, testTrip } from "./test-fixture";
import { recipe } from "./recipe";
import { revisable, reviseTrip, undoTrip } from "./revise";
import { emptyTrip } from "./template";
import { b64 } from "./private-entries";
import { confirmationCodes, matchesCommitment, openName, openPoint, sealName, sealPoint, sealTrip, sealMove, sealSpec, openField, openTrip, sealOperation, newAttempt, newHandoffKeys, newSeatKeys, newTripKey, seatPublic, signEdge, unwrapSeatSecret, unwrapTripKey, verifyEdge, wrapSeatSecret, wrapTripKey, acceptRekey, reachableSeats, resealAll, sealField, signRekey, signSuccession, type SeatKeys } from "./trip-keys";

// Exercises actual SQLite statements through D1's asynchronous shape, without claiming remote D1 QA.

const origin = "https://trip.example";
// An owner's important actions need a passkey check in the last five minutes. A browser's first passkey counts as the check
// (registering it); after that the browser checks with that passkey. `send` takes a path under the capsule. Returns the cookie.
type Send = (path: string, method: string, body?: unknown, cookie?: string) => Promise<Response>;
const devices = new Map<string, ReturnType<typeof fakeAuthenticator>>();
async function stepUp(send: Send, cookie: string) {
  const { challenge } = await (await send("/passkey/challenge", "POST", {})).json() as { challenge: string }, device = devices.get(cookie);
  if (device) { expect((await send("/passkey/verify", "POST", { challenge, id: device.id, ...device.assert(challenge) }, cookie)).status).toBe(200); return cookie; }
  const fresh = fakeAuthenticator(); devices.set(cookie, fresh);
  expect((await send("/passkey", "POST", { challenge, ...fresh.register(challenge) }, cookie)).status).toBe(200); return cookie;
}
test("anonymous and forged identity headers cannot create or discover private trips", async () => {
  const db = new LocalD1(); const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin });
  try {
    const account = await host.fetch(new Request(origin + "/v1/account")); expect(await account.json()).toEqual({ signedIn: false, canCreate: false, creator: null, localOnly: false, assistKey: false });
    const result = await host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "oai-authenticated-user-id": "spoofed", Authorization: "Bearer spoofed" }, body: JSON.stringify({ ...testTrip(), confirm: true }) }));
    expect(result.status).toBe(401);
    expect((await host.fetch(new Request(origin + "/v1/preview"))).status).toBe(404);
    expect(db.db.query("SELECT * FROM trip_capsules").all()).toHaveLength(0);
  } finally { db.close(); }
});
test("publisher cannot read trips without capability; invite role and CAS survive independent requests", async () => {
  const db = new LocalD1(); let identity: string | null = "creator-1", now = +new Date("2026-09-17T00:00:00Z");
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => now, async () => identity);
  const req = (path: string, method = "GET", body?: unknown, cookie?: string, revision = 1) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  try {
    const published = await req("/v1/publish", "POST", { ...testTrip(), confirm: true }); expect(published.status).toBe(201);
    const created = await published.json(), path = `/v1/c/${created.id}`;
    expect((await req(path)).status).toBe(401);
    const ownerLogin = await req(path + "/sessions", "POST", { secret: new URL(created.url).hash.slice(3) });
    const ownerCookie = await stepUp((p, m, b, c) => req(path + p, m, b, c), ownerLogin.headers.get("Set-Cookie")!.split(";")[0]!);
    identity = "creator-2"; expect((await req(path)).status).toBe(401);
    identity = "creator-1";
    const issued = await req(path + "/grants", "POST", { role: "participant", label: "個別招待", expiresAt: testTrip().spec.lifecycle.purgeAt, confirm: true }, ownerCookie); expect(issued.status).toBe(201);
    const invite = await issued.json(); identity = null;
    const login = await req(path + "/sessions", "POST", { secret: new URL(invite.url).hash.slice(3) }); expect(login.status).toBe(200);
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await req(path + "/document", "PATCH", { type: "notes", body: "unauthorized" }, cookie)).status).toBe(403);
    const results = await Promise.all([true, false].map(done => req(path + "/document", "PATCH", { type: "check", id: "c3", done }, cookie)));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    identity = "creator-1";
    expect((await req(path + "/revoke", "POST", { id: invite.grantId, confirm: true }, ownerCookie)).status).toBe(200);
    identity = null; expect((await req(path, "GET", undefined, cookie)).status).toBe(401);
    now = +new Date(testTrip().spec.lifecycle.purgeAt);
    expect((await req(path)).status).toBe(410);
    await host.store.sweep(now);
    const tomb = db.db.query("SELECT * FROM trip_capsules").get() as any;
    expect(tomb.payload).toBeNull(); expect(tomb.owner_key).toBeNull();
  } finally { db.close(); }
});
test("seats, claim country and publisher recovery of a lost owner browser", async () => {
  const db = new LocalD1(); let identity: string | null = "creator-1", now = +new Date("2026-09-17T00:00:00Z"), country = "JP";
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin, CAPSULE_CLAIM_COUNTRIES: "JP" }, () => now, async () => identity);
  const req = (path: string, method = "GET", body?: unknown, cookie?: string) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": '"1"', "CloudFront-Viewer-Country": country, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Version/19.0 Mobile/15E148 Safari/604.1", ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const claim = async (url: string, cookie?: string) => req(`/v1/c/${created.id}/sessions`, "POST", { secret: new URL(url).hash.slice(3) }, cookie);
  const published = await req("/v1/publish", "POST", { ...testTrip(), confirm: true }), created = await published.json(), path = `/v1/c/${created.id}`;
  try {
    identity = null; country = "US"; expect((await claim(created.url)).status).toBe(403);
    country = "JP"; const owner = await stepUp((p, m, b, c) => req(path + p, m, b, c), (await claim(created.url)).headers.get("Set-Cookie")!.split(";")[0]!);
    expect((await claim(created.url)).status).toBe(401);
    // Access after redemption is not geo-restricted: the trip itself may be abroad.
    country = "US"; expect((await req(path, "GET", undefined, owner)).status).toBe(200); country = "JP";
    const invite = await (await req(path + "/grants", "POST", { role: "participant", label: "旅行メンバー用", seats: 2, expiresAt: testTrip().spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const results = await Promise.all([1, 2, 3].map(() => claim(invite.url)));
    expect(results.map(r => r.status).sort()).toEqual([200, 200, 401]);
    const listed = (await (await req(path + "/grants", "GET", undefined, owner)).json()).find((g: any) => g.id === invite.grantId);
    expect(listed.claimed).toBe(2); expect(listed.members[0].device).toBe("iPhone · Safari"); expect(JSON.stringify(listed)).not.toContain("digest");
    expect((await req(path + "/revoke", "POST", { member: listed.members[0].id, confirm: true }, owner)).status).toBe(200);
    expect((await claim(invite.url)).status).toBe(401);
    // Only the IAM-authorized publisher can replace the owner invite; the old owner browser is cut off.
    expect((await req(path + "/recover", "POST", { confirm: true }, owner)).status).toBe(401);
    identity = "creator-1"; const recovered = await req(path + "/recover", "POST", { confirm: true }); expect(recovered.status).toBe(201);
    identity = null; expect((await req(path, "GET", undefined, owner)).status).toBe(401);
    const next = (await claim((await recovered.json()).url)).headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await (await req(path, "GET", undefined, next)).json()).role).toBe("owner");
  } finally { db.close(); }
});

test("same operation id publishes once; replay hands back a fresh owner link while the seat is free and recover reissues the owner invite", async () => {
  const db = new LocalD1(); let identity: string | null = "creator-1", now = +new Date("2026-09-17T00:00:00Z");
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => now, async () => identity);
  const req = (path: string, method = "GET", body?: unknown, cookie?: string, revision = 1) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const operationId = "0123456789abcdef".repeat(2);
  const rows = () => db.db.query("SELECT * FROM trip_capsules").all();
  try {
    // The publisher's first call succeeded but its answer was lost, so it sends the very same request again.
    const first = await req("/v1/publish", "POST", { ...testTrip(), confirm: true, operationId }); expect(first.status).toBe(201);
    const created = await first.json(), path = `/v1/c/${created.id}`;
    const again = await req("/v1/publish", "POST", { ...testTrip(), confirm: true, operationId }); expect(again.status).toBe(200);
    const replay = await again.json();
    expect(replay).toMatchObject({ id: created.id, hash: created.hash, replayed: true }); expect(replay.url).toBeString();
    expect(rows()).toHaveLength(1);
    // An operation id names one publication, not a slot to overwrite: neither a different spec nor a different document may reuse it.
    const otherSpec = testTrip(); otherSpec.spec.title = "別の旅行";
    expect((await req("/v1/publish", "POST", { ...otherSpec, confirm: true, operationId })).status).toBe(409);
    const otherDoc = testTrip(); otherDoc.document.notes = "別の持ち物メモ";
    expect((await req("/v1/publish", "POST", { ...otherDoc, confirm: true, operationId })).status).toBe(409);
    expect(rows()).toHaveLength(1);
    // The publisher cannot read the trip. It may still recover the owner invite, as aws/publish.ts does on every replay.
    expect((await req(path)).status).toBe(401);
    const recovered = await req(path + "/recover", "POST", { confirm: true }); expect(recovered.status).toBe(201);
    identity = null;
    const login = await req(path + "/sessions", "POST", { secret: new URL((await recovered.json()).url).hash.slice(3) });
    expect(login.status).toBe(200);
    const cookie = await stepUp((p, m, b, c) => req(path + p, m, b, c), login.headers.get("Set-Cookie")!.split(";")[0]!);
    expect((await (await req(path, "GET", undefined, cookie)).json()).role).toBe("owner");
    expect((await (await req(path + "/history", "GET", undefined, cookie)).json()).map((a: { event: string; by?: string }) => [a.event, a.by])).toEqual([["sessions", "オーナー"], ["recover", "発行者"], ["replay", "発行者"], ["publish", undefined]]);
    // The owner edits the trip. A retry of the original publish is still that publication, not a conflicting one.
    const edited = testTrip(); edited.spec.summary = "オーナーが書き換えた説明";
    expect((await req(path + "/spec", "PATCH", { spec: edited.spec, confirm: true }, cookie)).status).toBe(200);
    now += 60_000; identity = "creator-1";  // a fresh publish rate-limit bucket
    const afterEdit = await req("/v1/publish", "POST", { ...testTrip(), confirm: true, operationId }); expect(afterEdit.status).toBe(200);
    expect((await afterEdit.json()).id).toBe(created.id);
    // Once the trip is deleted the operation id is spent: replaying says so instead of claiming the owner is out of slots.
    expect((await req(path + "/purge", "POST", { title: testTrip().spec.title }, cookie, 2)).status).toBe(200);
    expect((await req("/v1/publish", "POST", { ...testTrip(), confirm: true, operationId })).status).toBe(410);
    expect(rows()).toHaveLength(1);
  } finally { db.close(); }
});

test("a retry recognises the publish's owner invite on a clock that moves between reads", async () => {
  // A real clock reads a little later each time; the invite made while publishing must still be the one a retry swaps.
  const db = new LocalD1(); let now = +new Date("2026-09-17T00:00:00Z");
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => now++, async () => "local");
  const publish = () => host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...testTrip(), confirm: true, operationId: "ab".repeat(16) }) }));
  try {
    expect((await publish()).status).toBe(201);
    expect((await (await publish()).json()).url).toBeString();
  } finally { db.close(); }
});

test("a full owner is told the quota is full, not that the publish was already done", async () => {
  const db = new LocalD1(); let now = +new Date("2026-09-17T00:00:00Z");
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => now, async () => "creator-1");
  const publish = (operationId?: string) => host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...testTrip(), confirm: true, ...(operationId ? { operationId } : {}) }) }));
  try {
    // Ten live trips is the per-owner limit. The publish rate limit is five a minute, so the clock moves between batches.
    for (let i = 0; i < 10; i++) { if (i && i % 5 === 0) now += 60_000; expect((await publish()).status).toBe(201); }
    expect(db.db.query("SELECT * FROM trip_capsules").all()).toHaveLength(10);
    now += 60_000;
    // An operation id nobody has used names no earlier publication: the eleventh trip is refused for the quota, and the
    // publisher must not read that as "your trip is already there".
    const refused = await publish("f".repeat(32));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toBe("同時に保持できる旅行は10件までです");
    expect(db.db.query("SELECT * FROM trip_capsules").all()).toHaveLength(10);
  } finally { db.close(); }
});

// The cases below came from the local Host (src/host.ts): CloudHost on LocalD1 must meet them alone.
const key = "test-key-".repeat(8);
let now = +new Date("2026-09-16T00:00:00Z");
const dbs: LocalD1[] = [];
afterEach(() => { dbs.splice(0).forEach(d => d.close()); now = +new Date("2026-09-16T00:00:00Z"); devices.clear(); });
async function setup(path?: string, env: { CAPSULE_SEALED_FROM?: string; MEDIA?: MediaStore; CAPSULE_PHOTOS?: string } = {}) {
  const db = new LocalD1(path); dbs.push(db);
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, ...env }, () => now, async () => "test");
  const seed = testTrip();
  const publish = async () => { const r = await host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) })); expect(r.status).toBe(201); return await r.json() as { id: string; url: string; grantId: string }; };
  const created = await publish(), base = `/v1/c/${created.id}`;
  // As the new screen sends them (ui=2, src/client.ts api()); an older screen's are sent with host.fetch directly.
  const request = (path = "", method = "GET", body?: unknown, cookie?: string, revision = 1, source = origin) => host.fetch(new Request(origin + base + path + "?ui=2", { method, headers: { Origin: source, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const login = async (url: string) => { const secret = new URLSearchParams(new URL(url).hash.slice(1)).get("k"); const res = await request("/sessions", "POST", { secret }); expect(res.status).toBe(200); return res.headers.get("Set-Cookie")!.split(";")[0]!; };
  return { host, db, seed, created, publish, request, login };
}
// Publishing asks every item for a time; a trip published before did not. One with items without a time is published with
// times, which are then taken off where it is stored, so it reads as such a trip does.
async function publishUntimed(host: CloudHost, seed: ReturnType<typeof testTrip>) {
  const untimed = seed.document.items.filter(i => !i.startsAt).map(i => i.id), timed = structuredClone(seed);
  for (const i of timed.document.items) i.startsAt ??= i.endsAt ?? `${i.day}T12:00:00Z`;
  const r = await host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...timed, confirm: true }) })); expect(r.status).toBe(201);
  const created = await r.json() as { id: string; url: string }, row = (await host.store.get(host.digest(created.id)))!, c = JSON.parse(row.payload!);
  for (const i of c.document.items) if (untimed.includes(i.id)) delete i.startsAt;
  expect(await host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
  return created;
}
describe("a loopback origin for local development", () => {
  const local = "http://127.0.0.1:47840";
  test("a public origin must be https; loopback may be http", () => {
    const make = (o: string) => new CloudHost({ DB: new LocalD1(), CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: o });
    expect(() => make("http://trip.example")).toThrow(); expect(() => make("https://trip.example/path")).toThrow();
    for (const o of [local, "http://localhost:47840", "http://[::1]:47840", origin]) expect(() => make(o)).not.toThrow();
  });
  test("Permissions-Policy: the page may use the position, not the camera or microphone; Secure and HSTS are sent on https only; every response carries the policy headers", async () => {
    const db = new LocalD1(); dbs.push(db);
    const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: local }, () => now, async () => "test");
    const post = (path: string, body: unknown) => host.fetch(new Request(local + path, { method: "POST", headers: { Origin: local, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const created = await (await post("/v1/publish", { ...testTrip(), confirm: true })).json();
    const session = await post(`/v1/c/${created.id}/sessions`, { secret: new URL(created.url).hash.slice(3) });
    expect(session.status).toBe(200);
    expect(session.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Strict"); expect(session.headers.get("Set-Cookie")).not.toContain("Secure");
    expect(session.headers.get("Strict-Transport-Security")).toBeNull();
    expect(session.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(self)");
    const t = await setup(), secureSession = await t.request("/sessions", "POST", { secret: new URL(t.created.url).hash.slice(3) });
    expect(secureSession.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=Strict"); expect(secureSession.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(secureSession.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(self)");
  });
  test("CSP: images and scripts come only from the host itself; connections also go to Anthropic, and nowhere else", async () => {
    // The footprint map's background (#563) comes from the same origin: MapLibre's worker is a file beside app.js and the
    // map tiles are ranges of /map/*.pmtiles, so the policy needs nothing added (docs/design/footprint-basemap.md §2).
    // The one outside origin is Anthropic's API, which a sealed trip's browser calls with the member's own key (#692 回答 B).
    const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://api.anthropic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    // The page itself (src/main.ts passes it through secure(), as every answer of the host) and an answer of the API.
    expect(secure(new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }), local).headers.get("Content-Security-Policy")).toBe(csp);
    const t = await setup();
    expect((await t.request("", "GET")).headers.get("Content-Security-Policy")).toBe(csp);
    expect(readFileSync(join(import.meta.dir, "../aws/template.yaml"), "utf8")).toContain(`ContentSecurityPolicy: "${csp}"`);
    // Where the map could be pointed at a tile, font or image server: only the host itself (and inline data and the page's own blob: for images).
    const sources = (name: string) => csp.split(";").map(d => d.trim().split(" ")).find(([n]) => n === name)!.slice(1);
    expect(sources("connect-src")).toEqual(["'self'", "https://api.anthropic.com"]);
    expect(sources("img-src")).toEqual(["'self'", "data:", "blob:"]);
    for (const name of ["script-src", "style-src", "default-src"]) expect(sources(name).every(s => s === "'self'" || s === "'none'")).toBe(true);
  });
});
describe("capability permissions and session boundaries", () => {
  test("owner issues independent links, participant cannot edit, viewer cannot write, revoked sessions fail", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const issue = async (role: string) => {
      const r = await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner);
      expect(r.status).toBe(201); return await r.json();
    };
    const p = await issue("participant"), v = await issue("viewer"), participant = await t.login(p.url), viewer = await t.login(v.url);
    // Only digests are stored. Checked while the links and sessions are live: a revoked grant is dropped from the payload.
    const stored = JSON.stringify(t.db.db.query("SELECT * FROM trip_capsules").all());
    expect(stored).toContain(p.grantId);
    for (const secret of [new URL(p.url).hash.slice(3), new URL(t.created.url).hash.slice(3), participant.split("=")[1]!, owner.split("=")[1]!]) expect(stored).not.toContain(secret);
    expect((await t.request("", "GET", undefined, participant)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "item", item: t.seed.document.items[0] }, participant)).status).toBe(403);
    expect((await t.request("/document", "PATCH", { type: "check", id: "c3", done: true }, viewer)).status).toBe(403);
    expect((await t.request("/export", "GET", undefined, viewer)).status).toBe(403);
    expect((await t.request("/grants", "GET", undefined, participant)).status).toBe(403);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "参加者", body: "海を見たい" }, participant)).status).toBe(200);
    expect((await t.request("/revoke", "POST", { id: p.grantId, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("", "GET", undefined, participant)).status).toBe(401);
    expect((await t.request("/sessions", "POST", { secret: new URL(p.url).hash.slice(3) })).status).toBe(401);
    expect((await t.request("", "GET", undefined, viewer)).status).toBe(200);
    expect(owner).toMatch(/^capsule_/);
  });
  test("strict origin, secure cookies, rotation and cross-capsule access", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    expect((await t.request("/document", "PATCH", { type: "check", id: "c3", done: true }, owner, 1, "https://evil.example")).status).toBe(403);
    // The owner seat is taken: another browser is refused, the bound browser may re-open its link.
    expect((await t.request("/sessions", "POST", { secret: new URL(t.created.url).hash.slice(3) })).status).toBe(401);
    const session = await t.request("/sessions", "POST", { secret: new URL(t.created.url).hash.slice(3) }, owner);
    // aws/verify.ts matches this exact order against the deployed stack.
    expect(session.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
    const rotated = await t.request("/grants", "POST", { role: "owner", label: "new", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, rotate: t.created.grantId }, owner);
    expect(rotated.status).toBe(201);
    expect((await t.request("", "GET", undefined, owner)).status).toBe(401);
    const next = await t.login((await rotated.json()).url);
    const other = await t.publish();
    const fakeCookie = next.replace(t.created.id, other.id);
    const r = await t.host.fetch(new Request(`${origin}/v1/c/${other.id}`, { headers: { Cookie: fakeCookie } }));
    expect(r.status).toBe(401);
  });
  test("named actions stop with 503 while the rest keeps working", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const invite = await (await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const participant = await t.login(invite.url), secret = new URL(invite.url).hash.slice(3);
    const withStopped = (names: string) => {
      const host = new CloudHost({ ...t.host.env, CAPSULE_DISABLED_ACTIONS: names }, () => now, async () => "test");
      return (path: string, method = "GET", body?: unknown, cookie?: string) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": '"1"', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    };
    const base = `/v1/c/${t.created.id}`, grant = { role: "viewer", label: "v", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true };
    const sessions = withStopped("sessions");
    expect((await sessions(base, "GET", undefined, participant)).status).toBe(200);
    const stopped = await sessions(base + "/sessions", "POST", { secret });
    expect(stopped.status).toBe(503); expect((await stopped.json()).error).toBe("この操作は一時的に停止しています。時間をおいて再試行してください");
    expect((await sessions(base + "/grants", "GET", undefined, owner)).status).toBe(200);
    const several = withStopped("sessions,grants,publish");
    expect((await several(base + "/grants", "POST", grant, owner)).status).toBe(503);
    expect((await several("/v1/publish", "POST", { ...t.seed, confirm: true })).status).toBe(503);
    expect((await several(base, "GET", undefined, participant)).status).toBe(200);
    const open = withStopped("");
    expect((await open(base + "/grants", "POST", grant, owner)).status).toBe(201);
    expect((await open(base + "/sessions", "POST", { secret })).status).toBe(401);  // the seat is taken, not stopped
  });
  test("logs a refused request as one line without the secret, cookie, or body", async () => {
    const t = await setup(), lines: Array<Record<string, unknown>> = []; t.host.log = line => { lines.push(line); };
    const owner = await t.login(t.created.url), good = new URL(t.created.url).hash.slice(3), wrong = "wrong-secret-".repeat(4);
    expect(lines).toEqual([]);  // a 2xx adds nothing
    expect((await t.request("/sessions", "POST", { secret: wrong })).status).toBe(401);
    expect(lines[0]).toMatchObject({ capsule: t.created.id, action: "sessions", method: "POST", status: 401 });
    expect((await t.request("", "GET", undefined, owner)).status).toBe(200);
    expect(lines.length).toBe(1);
    // Fifteen logins per minute are allowed from one IP; the next one is refused and says which limit it was.
    for (let i = 0; i < 16; i++) await t.request("/sessions", "POST", { secret: wrong });
    expect(lines.some(l => l.status === 429 && l.reason === "rate:login")).toBe(true);
    // The line says which address was counted: the one the edge handed over.
    for (let i = 0; i < 16; i++) await asIp(t, "10.9.0.1", "/sessions", "POST", { secret: wrong });
    expect(lines.some(l => l.status === 429 && l.reason === "rate:login" && l.ip === "10.9.0.1")).toBe(true);
    expect(lines[0]!.ip).toBe("unknown");
    const text = JSON.stringify(lines);
    for (const value of [wrong, good, owner.split("=")[1]!, t.seed.spec.title]) expect(text.includes(value)).toBe(false);
    // A failing logger never changes the response.
    t.host.log = () => { throw new Error("boom"); };
    expect((await t.request("/sessions", "POST", { secret: wrong })).status).toBe(429);
  });
  test("invite seats bind one browser each; full, late and revoked seats stay closed", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), secret = (url: string) => new URL(url).hash.slice(3);
    const issued = await t.request("/grants", "POST", { role: "participant", label: "旅行メンバー用", seats: 2, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner);
    const invite = await issued.json(), first = await t.login(invite.url);
    // Same browser re-opening the link keeps its seat instead of taking the second one.
    expect((await t.request("/sessions", "POST", { secret: secret(invite.url) }, first)).status).toBe(200);
    const second = await t.login(invite.url);
    expect((await t.request("/sessions", "POST", { secret: secret(invite.url) })).status).toBe(401);
    const listed = (await (await t.request("/grants", "GET", undefined, owner)).json()).find((g: any) => g.id === invite.grantId);
    expect(listed).toMatchObject({ seats: 2, claimed: 2 }); expect(listed.members.map((m: any) => m.label)).toEqual(["メンバー2", "メンバー3"]);
    expect(JSON.stringify(listed)).not.toContain("digest");
    expect((await t.request("/members", "PATCH", { id: listed.members[0].id, label: "はるか" }, owner)).status).toBe(200);
    expect((await t.request("/members", "PATCH", { id: listed.members[0].id, label: "x" }, first)).status).toBe(403);
    // Removing one member neither frees the seat nor affects the other member.
    expect((await t.request("/revoke", "POST", { member: listed.members[0].id, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("", "GET", undefined, first)).status).toBe(401);
    expect((await t.request("", "GET", undefined, second)).status).toBe(200);
    expect((await t.request("/sessions", "POST", { secret: secret(invite.url) })).status).toBe(401);
    // Unredeemed seats lapse after the claim window, while bound browsers keep working until the trip ends.
    const late = await (await t.request("/grants", "POST", { role: "viewer", label: "家族用", seats: 3, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const viewer = await t.login(late.url); now += 3 * 86400000;
    expect((await t.request("/sessions", "POST", { secret: secret(late.url) })).status).toBe(401);
    expect((await t.request("", "GET", undefined, viewer)).status).toBe(200);
    expect((await t.request("", "GET", undefined, owner)).status).toBe(200);
  });
  test("stale updates are rejected without losing the first edit", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    const op = { type: "check", id: "c3", done: true };
    expect((await t.request("/document", "PATCH", op, owner)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { ...op, done: false }, owner)).status).toBe(409);
    const data = await (await t.request("", "GET", undefined, owner)).json();
    expect(data.document.revision).toBe(2);
    expect(data.document.checklist.find((x: any) => x.id === "c3").done).toBe(true);
  });
  test("invalid payloads and unsafe URLs cannot be persisted", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    for (const publicUrl of ["javascript:alert(1)", "http://example.com", "https://user:password@example.com"]) {
      const r = await t.request("/document", "PATCH", { type: "item", item: { ...t.seed.document.items[0], place: { label: "x", publicUrl } } }, owner);
      expect(r.status).toBe(400);
    }
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "a", body: "x".repeat(4001) }, owner)).status).toBe(400);
    const bad = structuredClone(t.seed.spec); bad.navigation = ["missing"];
    expect((await t.request("/spec", "PATCH", { spec: bad, confirm: true }, owner)).status).toBe(400);
    expect((await t.request("/document", "PATCH", { type: "item", item: { ...t.seed.document.items[0], id: '\"><img src=x>' } }, owner)).status).toBe(400);
    expect((await t.host.fetch(new Request("https://evil.example/v1/preview"))).status).toBe(403);
    expect((await t.host.fetch(new Request(`${origin}/v1/preview`))).status).toBe(404);
  });
  test("Spec collaboration settings are enforced by the API", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const g = await (await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const p = await t.login(g.url);
    const spec = structuredClone(t.seed.spec); spec.collaboration = { participantSuggestions: false, participantComments: false, participantChecklist: false };
    expect((await t.request("/spec", "PATCH", { spec, confirm: true }, owner)).status).toBe(200);
    for (const op of [{ type: "suggest", author: "p", body: "x" }, { type: "comment", author: "p", body: "x" }, { type: "check", id: "c3", done: true }]) expect((await t.request("/document", "PATCH", op, p, 2)).status).toBe(403);
  });
  test("owner and editor replace the checklist and the budget; participants and viewers cannot", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const invite = async (role: string) => t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    const editor = await invite("editor"), participant = await invite("participant"), viewer = await invite("viewer");
    const doc = async () => (await (await t.request("", "GET", undefined, owner)).json()).document;
    // A renamed item keeps its check, a removed one is gone, a new one comes in unchecked where it was put.
    expect((await t.request("/document", "PATCH", { type: "check", id: "c1", done: true }, participant)).status).toBe(200);
    const checklist = [{ id: "c1", title: "集合場所と時刻を決める" }, { id: "c3", title: "必要な予約を確認する" }, { id: "c4", title: "充電器を持つ" }];
    expect((await t.request("/document", "PATCH", { type: "checklist", checklist: checklist.map(x => x.id === "c4" ? { ...x, title: ` ${x.title} ` } : x) }, owner, 2)).status).toBe(200);
    expect((await doc()).checklist).toEqual([{ ...checklist[0], done: true }, { ...checklist[1], done: false }, { ...checklist[2], done: false }]);
    const budget = [{ id: "b1", title: "宿", amount: 24000, description: "2 泊・1 人あたり" }, { id: "b2", title: "交通", amount: 0, description: "" }];
    expect((await t.request("/document", "PATCH", { type: "budget", budget }, editor, 3)).status).toBe(200);
    expect((await doc()).budget).toEqual(budget);
    // A participant may tick items (participantChecklist) but not change the list; a viewer changes nothing.
    for (const cookie of [participant, viewer]) for (const op of [{ type: "checklist", checklist: [] }, { type: "budget", budget: [] }]) expect((await t.request("/document", "PATCH", op, cookie, 4)).status).toBe(403);
    // Out of range, not whole, a repeated id or an empty title: refused, nothing saved.
    const refused = [
      { type: "budget", budget: [{ ...budget[0], amount: -1 }] }, { type: "budget", budget: [{ ...budget[0], amount: 1.5 }] }, { type: "budget", budget: [{ ...budget[0], amount: 100000001 }] },
      { type: "budget", budget: [budget[0], { ...budget[1], id: "b1" }] }, { type: "budget", budget: [{ ...budget[0], title: " " }] },
      { type: "checklist", checklist: [checklist[0], { ...checklist[1], id: "c1" }] }, { type: "checklist", checklist: [{ id: "c9", title: "" }] },
    ];
    for (const op of refused) expect((await t.request("/document", "PATCH", op, owner, 4)).status).toBe(400);
    expect(await doc()).toMatchObject({ revision: 4, checklist: [{ id: "c1" }, { id: "c3" }, { id: "c4" }], budget });
    // Nothing on a trip whose 準備 or 費用メモ page is not shown, nor after sharing ends.
    const spec = structuredClone(t.seed.spec); spec.navigation = spec.navigation.filter(n => n !== "check" && n !== "budget");
    expect((await t.request("/spec", "PATCH", { spec, confirm: true }, owner, 4)).status).toBe(200);
    for (const op of [{ type: "checklist", checklist }, { type: "budget", budget }]) expect((await t.request("/document", "PATCH", op, owner, 5)).status).toBe(403);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, 5)).status).toBe(200);
    for (const op of [{ type: "checklist", checklist }, { type: "budget", budget }]) expect((await t.request("/document", "PATCH", op, owner, 5)).status).toBe(403);
  });
  test("owner and editor rewrite and remove suggestions and comments; participants and viewers cannot", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const invite = async (role: string) => t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    const editor = await invite("editor"), participant = await invite("participant"), viewer = await invite("viewer");
    const doc = async () => (await (await t.request("", "GET", undefined, owner)).json()).document;
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "みどり", body: "夜は星を見たい" }, participant)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "みどり", body: "朝市に行く" }, participant, 2)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "comment", author: "あおい", body: "集合は何時？" }, participant, 3)).status).toBe(200);
    const before = await doc(), [star, market] = before.suggestions, [question] = before.comments;
    // Only the words change: who wrote it, when, and whether it is in the plan stay.
    expect((await t.request("/document", "PATCH", { type: "rewrite", list: "suggestions", id: star.id, body: " 夜は星を見に行きたい " }, owner, 4)).status).toBe(200);
    expect((await doc()).suggestions[0]).toEqual({ ...star, body: "夜は星を見に行きたい" });
    expect((await t.request("/document", "PATCH", { type: "rewrite", list: "comments", id: question.id, body: "集合は 9 時でいい？" }, editor, 5)).status).toBe(200);
    expect((await doc()).comments).toEqual([{ ...question, body: "集合は 9 時でいい？" }]);
    expect((await t.request("/document", "PATCH", { type: "remove", list: "comments", id: question.id }, editor, 6)).status).toBe(200);
    expect((await doc()).comments).toEqual([]);
    expect((await t.request("/document", "PATCH", { type: "remove", list: "suggestions", id: market.id }, editor, 7)).status).toBe(200);
    const after = await doc(), readme = (await exportFiles(t.created.id, t.seed.spec, after, "2026-09-16T00:00:00Z"))["README.md"]!;
    expect(after.suggestions.map((s: { body: string }) => s.body)).toEqual(["夜は星を見に行きたい"]);
    expect(readme).toContain("- 夜は星を見に行きたい (みどり)"); expect(readme).not.toContain("朝市");
    // A participant may post (participantSuggestions, participantComments) but not change or remove a post; a viewer changes nothing.
    const others = [{ type: "rewrite", list: "suggestions", id: star.id, body: "x" }, { type: "remove", list: "suggestions", id: star.id }, { type: "rewrite", list: "comments", id: star.id, body: "x" }, { type: "remove", list: "comments", id: star.id }];
    for (const cookie of [participant, viewer]) for (const op of others) expect((await t.request("/document", "PATCH", op, cookie, 8)).status).toBe(403);
    // A post that is not there is 404; empty or too long words, or a list that holds no posts, are 400. Nothing is saved.
    for (const op of [{ type: "rewrite", list: "suggestions", id: market.id, body: "x" }, { type: "remove", list: "comments", id: question.id }, { type: "remove", list: "suggestions", id: "nobody" }]) expect((await t.request("/document", "PATCH", op, owner, 8)).status).toBe(404);
    for (const op of [{ type: "rewrite", list: "suggestions", id: star.id, body: " " }, { type: "rewrite", list: "suggestions", id: star.id, body: "あ".repeat(4001) }, { type: "remove", list: "reflections", id: star.id }]) expect((await t.request("/document", "PATCH", op, owner, 8)).status).toBe(400);
    expect(await doc()).toMatchObject({ revision: 8, suggestions: [{ id: star.id, body: "夜は星を見に行きたい" }], comments: [] });
    // Nothing on a trip whose 候補・相談 page is not shown, nor after sharing ends.
    const ops = [{ type: "rewrite", list: "suggestions", id: star.id, body: "x" }, { type: "remove", list: "suggestions", id: star.id }];
    const spec = structuredClone(t.seed.spec); spec.navigation = spec.navigation.filter(n => n !== "ideas");
    expect((await t.request("/spec", "PATCH", { spec, confirm: true }, owner, 8)).status).toBe(200);
    for (const op of ops) expect((await t.request("/document", "PATCH", op, owner, 9)).status).toBe(403);
    // Sharing ended with the page shown again: still refused.
    expect((await t.request("/spec", "PATCH", { spec: t.seed.spec, confirm: true }, owner, 9)).status).toBe(200);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, 10)).status).toBe(200);
    for (const op of ops) expect((await t.request("/document", "PATCH", op, owner, 10)).status).toBe(403);
    expect((await doc()).suggestions).toMatchObject([{ id: star.id, body: "夜は星を見に行きたい" }]);
  });
  test("SQLite persists documents and capability sessions across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "capsule-test-")), path = join(directory, "state.sqlite");
    let t = await setup(path);
    try {
      const cookie = await t.login(t.created.url);
      t.db.close(); dbs.splice(0);
      const db = new LocalD1(path); dbs.push(db);
      const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin }, () => now);
      const response = await host.fetch(new Request(`${origin}/v1/c/${t.created.id}`, { headers: { Cookie: cookie } }));
      expect(response.status).toBe(200); expect((await response.json()).document.items).toHaveLength(3);
    } finally { dbs.splice(0).forEach(d => d.close()); rmSync(directory, { recursive: true, force: true }); }
  });
});
describe("who may hand out which invite", () => {
  const roles = ["owner", "editor", "participant", "viewer"] as const;
  // The table (src/cloud-host.ts canIssue): no role hands out one stronger than its own.
  const table: Record<string, string[]> = { owner: [...roles], editor: ["viewer"], participant: [], viewer: [] };
  const hand = (t: Awaited<ReturnType<typeof setup>>, cookie: string, role: string, extra: object = {}) =>
    t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, ...extra }, cookie);
  // An owner, and one browser in each other role (two editors), each with a passkey checked just now.
  async function seats() {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const editors = await (await hand(t, owner, "editor", { seats: 2 })).json();
    const a = await stepUp(t.request, await t.login(editors.url)), b = await stepUp(t.request, await t.login(editors.url));
    const p = await stepUp(t.request, await t.login((await (await hand(t, owner, "participant")).json()).url));
    const v = await stepUp(t.request, await t.login((await (await hand(t, owner, "viewer")).json()).url));
    const list = async (cookie = owner) => (await (await t.request("/grants", "GET", undefined, cookie)).json()) as any[];
    const [first, second] = (await list()).find(g => g.id === editors.grantId).members;
    return { t, owner, a, b, p, v, list, aId: first.id as string, bId: second.id as string };
  }
  test("every cell of the table", async () => {
    const s = await seats(), by: Record<string, string> = { owner: s.owner, editor: s.a, participant: s.p, viewer: s.v };
    for (const from of roles) for (const to of roles) {
      const r = await hand(s.t, by[from]!, to);
      expect([from, to, r.status]).toEqual([from, to, table[from]!.includes(to) ? 201 : 403]);
    }
  });
  test("an invite remembers who handed it out; an editor lists, rotates and revokes only its own", async () => {
    const s = await seats();
    const mine = await (await hand(s.t, s.a, "viewer")).json(), theirs = await (await hand(s.t, s.b, "viewer")).json(), owners = await (await hand(s.t, s.owner, "viewer")).json();
    const listed = await s.list();
    expect(listed.find(g => g.id === mine.grantId).issuedBy).toEqual({ id: s.aId, label: "メンバー2" });
    const self = listed.find(g => g.id === s.t.created.grantId).members[0];
    expect(listed.find(g => g.id === owners.grantId).issuedBy).toEqual({ id: self.id, label: self.label });
    // The owner seat handed out at publishing has no one in the trip behind it.
    expect(listed.find(g => g.id === s.t.created.grantId).issuedBy).toBeNull();
    expect((await s.list(s.a)).map(g => g.id)).toEqual([mine.grantId]);
    expect((await s.t.request("/grants", "GET", undefined, s.p)).status).toBe(403);
    expect((await s.t.request("/grants", "GET", undefined, s.v)).status).toBe(403);
    // Rotating is replacing: only for the one who handed it out, or the owner.
    expect((await hand(s.t, s.a, "viewer", { rotate: theirs.grantId })).status).toBe(403);
    expect((await hand(s.t, s.a, "viewer", { rotate: owners.grantId })).status).toBe(403);
    const rotated = await hand(s.t, s.a, "viewer", { rotate: mine.grantId }); expect(rotated.status).toBe(201);
    const next = (await rotated.json()).grantId;
    // Revoking: the one who handed it out and the owner; any other member is refused, and nothing changes.
    expect((await s.t.request("/revoke", "POST", { id: next, confirm: true }, s.b)).status).toBe(403);
    expect((await s.t.request("/revoke", "POST", { id: next, confirm: true }, s.p)).status).toBe(403);
    expect((await s.t.request("/revoke", "POST", { id: owners.grantId, confirm: true }, s.a)).status).toBe(403);
    expect((await s.list()).find(g => g.id === next).revoked).toBeNull();
    expect((await s.t.request("/revoke", "POST", { id: next, confirm: true }, s.a)).status).toBe(200);
    expect((await s.t.request("/revoke", "POST", { id: theirs.grantId, confirm: true }, s.owner)).status).toBe(200);
    // A member who came in by an editor's invite: removed by that editor or the owner only.
    const invite = await (await hand(s.t, s.a, "viewer", { seats: 2 })).json(), one = await s.t.login(invite.url), two = await s.t.login(invite.url);
    const [m1, m2] = (await s.list(s.a)).find(g => g.id === invite.grantId).members;
    expect((await s.t.request("/revoke", "POST", { member: m1.id, confirm: true }, s.b)).status).toBe(403);
    expect((await s.t.request("/revoke", "POST", { member: m1.id, confirm: true }, s.a)).status).toBe(200);
    expect((await s.t.request("/revoke", "POST", { member: m2.id, confirm: true }, s.owner)).status).toBe(200);
    expect((await s.t.request("", "GET", undefined, one)).status).toBe(401);
    expect((await s.t.request("", "GET", undefined, two)).status).toBe(401);
  });
  // Handing the owner seat over by rotating its invite removes the seat that handed out every invite so far: the new owner
  // sees them, and the handover invite, as handed out by a removed member, and may revoke any of them.
  test("an owner seat handed over by rotation leaves its invites to the new owner", async () => {
    const s = await seats(), viewer = await (await hand(s.t, s.owner, "viewer")).json();
    const handed = await (await hand(s.t, s.owner, "owner", { rotate: s.t.created.grantId })).json(), next = await stepUp(s.t.request, await s.t.login(handed.url));
    const listed = await s.list(next), gone = { id: expect.any(String), label: "（失効したメンバー）" };
    expect(listed.find(g => g.id === viewer.grantId).issuedBy).toEqual(gone);
    expect(listed.find(g => g.id === handed.grantId).issuedBy).toEqual(gone);
    expect((await s.t.request("/revoke", "POST", { id: viewer.grantId, confirm: true }, next)).status).toBe(200);
  });
  test("an invite stays when the member who handed it out is removed", async () => {
    const s = await seats(), invite = await (await hand(s.t, s.a, "viewer")).json(), viewer = await s.t.login(invite.url);
    expect((await s.t.request("/revoke", "POST", { member: s.aId, confirm: true }, s.owner)).status).toBe(200);
    expect((await s.t.request("", "GET", undefined, viewer)).status).toBe(200);
    const kept = (await s.list()).find(g => g.id === invite.grantId);
    expect(kept).toMatchObject({ revoked: null, issuedBy: { id: s.aId, label: "（失効したメンバー）" } });
    expect((await s.t.request("/revoke", "POST", { id: invite.grantId, confirm: true }, s.owner)).status).toBe(200);
    expect((await s.t.request("", "GET", undefined, viewer)).status).toBe(401);
  });
});
describe("lifecycle and deletion", () => {
  test("Japan day boundaries, reflection and freeze without a job", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const grant = await (await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const participant = await t.login(grant.url);
    now = +new Date("2026-09-26T14:59:59Z");
    expect(stateOf(t.seed.spec, null, now)).toBe("active");
    now += 1000;
    expect((await (await t.request("", "GET", undefined, participant)).json()).state).toBe("reflection");
    expect((await t.request("/document", "PATCH", { type: "check", id: "c3", done: true }, participant)).status).toBe(403);
    expect((await t.request("/document", "PATCH", { type: "reflect", author: "参加者", body: "楽しかった" }, participant)).status).toBe(200);
    now = +new Date("2026-10-03T15:00:00Z");
    expect((await (await t.request("", "GET", undefined, participant)).json()).state).toBe("frozen");
    expect((await t.request("/document", "PATCH", { type: "reflect", author: "参加者", body: "追記" }, participant, 2)).status).toBe(403);
    now = +new Date(t.seed.spec.lifecycle.purgeAt);
    expect((await t.request("", "GET", undefined, participant)).status).toBe(410);
    await t.host.store.sweep(now);
    const rows = t.db.db.query("SELECT * FROM trip_capsules").all() as any[];
    expect(rows).toHaveLength(1); expect(rows[0].payload).toBeNull(); expect(rows[0].owner_key).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("テスト旅行");
  });
  test("freeze revokes others immediately, owner can export; purge requires exact title", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const g = await (await t.request("/grants", "POST", { role: "editor", label: "e", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const editor = await t.login(g.url);
    expect((await t.request("/freeze", "POST", { confirm: true }, editor)).status).toBe(403);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(200);
    expect((await t.request("", "GET", undefined, editor)).status).toBe(401);
    expect((await t.request("/export", "GET", undefined, owner)).status).toBe(200);
    expect((await t.request("/purge", "POST", { title: "incorrect" }, owner)).status).toBe(400);
    expect((await t.request("/purge", "POST", { title: t.seed.spec.title }, owner)).status).toBe(200);
    expect((await t.request("/export", "GET", undefined, owner)).status).toBe(410);
  });
  test("Markdown copy: every role gets the README.md text while the ZIP stays owner and editor; frozen still owner, purged 410", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const login = async (role: string) => t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    const others = { editor: await login("editor"), participant: await login("participant"), viewer: await login("viewer") };
    const { spec, document } = await (await t.request("", "GET", undefined, owner)).json();
    const readme = (await exportFiles(t.created.id, spec, document, "2026-09-16T00:00:00Z"))["README.md"];
    expect(readme).toContain("# テスト旅行");
    for (const cookie of [owner, ...Object.values(others)]) {
      const r = await t.request("/export.md", "GET", undefined, cookie);
      expect(r.status).toBe(200); expect(await r.json()).toEqual({ text: readme });
    }
    expect((await t.request("/export", "GET", undefined, others.editor)).status).toBe(200);
    expect((await t.request("/export", "GET", undefined, others.participant)).status).toBe(403);
    expect((await t.request("/export", "GET", undefined, others.viewer)).status).toBe(403);
    // The Spec's exports choose the ZIP's files, not the copy: a trip whose ZIP has no README.md still gives the text.
    expect((await t.request("/spec", "PATCH", { spec: { ...spec, exports: ["json"] }, confirm: true }, owner)).status).toBe(200);
    const edited = await (await t.request("", "GET", undefined, owner)).json();
    expect((await exportFiles(t.created.id, edited.spec, edited.document, "2026-09-16T00:00:00Z"))["README.md"]).toBeUndefined();
    expect(await (await t.request("/export.md", "GET", undefined, others.viewer)).json()).toEqual({ text: tripMarkdown(edited.spec, edited.document) });
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, edited.document.revision)).status).toBe(200);
    expect((await t.request("/export.md", "GET", undefined, owner)).status).toBe(200);
    expect((await t.request("/export.md", "GET", undefined, others.participant)).status).toBe(401);
    expect((await t.request("/purge", "POST", { title: t.seed.spec.title }, owner, edited.document.revision)).status).toBe(200);
    expect((await t.request("/export.md", "GET", undefined, owner)).status).toBe(410);
  });
  test("trip page: every role gets the ZIP's index.html as text; the Spec's exports do not stop it; frozen still owner, purged 410", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const login = async (role: string) => t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    const others = { editor: await login("editor"), participant: await login("participant"), viewer: await login("viewer") };
    const { spec, document } = await (await t.request("", "GET", undefined, owner)).json();
    const page = (await exportFiles(t.created.id, spec, document, "2026-09-16T00:00:00Z"))["index.html"];
    expect(page).toContain("<h1>テスト旅行</h1>");
    for (const cookie of [owner, ...Object.values(others)]) {
      const r = await t.request("/export.html", "GET", undefined, cookie);
      expect(r.status).toBe(200); expect(r.headers.get("Content-Type")).toContain("application/json"); expect(await r.json()).toEqual({ text: page });
    }
    // The Spec's exports choose the ZIP's files, not the trip page: a trip whose ZIP has no index.html still gives it.
    expect((await t.request("/spec", "PATCH", { spec: { ...spec, exports: ["json"] }, confirm: true }, owner)).status).toBe(200);
    const edited = await (await t.request("", "GET", undefined, owner)).json();
    expect((await exportFiles(t.created.id, edited.spec, edited.document, "2026-09-16T00:00:00Z"))["index.html"]).toBeUndefined();
    expect(await (await t.request("/export.html", "GET", undefined, others.viewer)).json()).toEqual({ text: tripHtml(edited.spec, edited.document) });
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, edited.document.revision)).status).toBe(200);
    expect((await t.request("/export.html", "GET", undefined, owner)).status).toBe(200);
    expect((await t.request("/export.html", "GET", undefined, others.participant)).status).toBe(401);
    expect((await t.request("/purge", "POST", { title: t.seed.spec.title }, owner, edited.document.revision)).status).toBe(200);
    expect((await t.request("/export.html", "GET", undefined, owner)).status).toBe(410);
  });
  test("a capsule past purgeAt is unreadable before the sweep runs; the sweep erases it", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    now = +new Date(t.seed.spec.lifecycle.purgeAt);
    expect((await t.request("", "GET", undefined, owner)).status).toBe(410);
    expect((await t.request("/export", "GET", undefined, owner)).status).toBe(410);
    expect((t.db.db.query("SELECT payload FROM trip_capsules").get() as any).payload).not.toBeNull();
    await t.host.store.sweep(now);
    expect((t.db.db.query("SELECT payload, purged_at FROM trip_capsules").get() as any)).toEqual({ payload: null, purged_at: now });
    await t.host.store.sweep(now + 31 * 86400000);
    expect(t.db.db.query("SELECT * FROM trip_capsules").all()).toHaveLength(0);
  });
});
describe("invite history", () => {
  // The history lines as they are shown, without their times.
  const history = async (t: Awaited<ReturnType<typeof setup>>, cookie: string) => { const r = await t.request("/history", "GET", undefined, cookie); expect(r.status).toBe(200); return (await r.json() as Array<{ at: number }>).map(({ at, ...rest }) => rest); };
  const invite = async (t: Awaited<ReturnType<typeof setup>>, owner: string, role: string, label: string, rotate?: string) => { const r = await t.request("/grants", "POST", { role, label, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, ...(rotate ? { rotate } : {}) }, owner); expect(r.status).toBe(201); return await r.json() as { url: string; grantId: string }; };
  test("invite history records who issued, rotated and revoked which role", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), by = { by: "オーナー", device: "不明な端末" };
    const first = await invite(t, owner, "participant", "履歴テスト"); await t.login(first.url);
    const second = await invite(t, owner, "participant", "交換後", first.grantId); await t.login(second.url);
    const member = (await (await t.request("/grants", "GET", undefined, owner)).json()).find((g: any) => g.id === second.grantId).members[0];
    expect((await t.request("/revoke", "POST", { member: member.id, confirm: true }, owner)).status).toBe(200);
    const viewer = await invite(t, owner, "viewer", "閲覧用");
    expect((await t.request("/revoke", "POST", { id: viewer.grantId, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(200);
    // Passkey checks and reading are in the record too, but not in the history.
    expect(await history(t, owner)).toEqual([
      { event: "freeze", ...by },
      { event: "revoke", role: "viewer", label: "閲覧用", ...by },
      { event: "grants", role: "viewer", label: "閲覧用", ...by },
      { event: "revoke-member", role: "participant", label: "メンバー3", ...by },
      { event: "sessions", role: "participant", label: "交換後", by: "メンバー3", device: "不明な端末" },
      { event: "rotate", role: "participant", label: "交換後", ...by },
      { event: "sessions", role: "participant", label: "履歴テスト", by: "メンバー2", device: "不明な端末" },
      { event: "grants", role: "participant", label: "履歴テスト", ...by },
      { event: "sessions", role: "owner", label: "自分用", ...by },
      { event: "publish" },
    ]);
    // The publisher replaces the owner invite: the new owner sees who did.
    const recovered = await t.request("/recover", "POST", { confirm: true }); expect(recovered.status).toBe(201);
    const next = await t.login((await recovered.json()).url);
    expect((await history(t, next)).slice(0, 2)).toEqual([{ event: "sessions", role: "owner", label: "自分用", ...by }, { event: "recover", role: "owner", by: "発行者" }]);
  });
  test("invite history is for the owner only", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    for (const role of ["editor", "participant", "viewer"]) {
      const cookie = await t.login((await invite(t, owner, role, role)).url);
      expect((await t.request("/history", "GET", undefined, cookie)).status).toBe(403);
    }
    expect((await t.request("/history")).status).toBe(401);
  });
  test("invite history holds no secret", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const links = [t.created.url, (await invite(t, owner, "participant", "秘密なし")).url], member = await t.login(links[1]!);
    const shown = await (await t.request("/history", "GET", undefined, owner)).text();
    const c = JSON.parse((await t.host.store.get(t.host.digest(t.created.id)))!.payload!), stored = JSON.stringify(c.audit);
    const secrets = [...links.map(u => new URLSearchParams(new URL(u).hash.slice(1)).get("k")!), ...c.grants.map((g: any) => g.digest), ...c.sessions.map((s: any) => s.digest), ...[owner, member].map(k => k.split("=")[1]!)];
    expect(secrets.length).toBe(8);
    for (const secret of secrets) { expect(shown).not.toContain(secret); expect(stored).not.toContain(secret); }
    expect(shown).toContain("秘密なし");
  });
  test("invite history reads older records without role or name", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    const row = (await t.host.store.get(t.host.digest(t.created.id)))!, c = JSON.parse(row.payload!);
    c.audit = [{ event: "publish", at: 1 }, { event: "grants", at: 2 }, { event: "document", at: 3 }];
    expect(await t.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
    const r = await t.request("/history", "GET", undefined, owner);
    expect(r.status).toBe(200); expect(await r.json()).toEqual([{ event: "grants", at: 2 }, { event: "publish", at: 1 }]);
  });
});
describe("spec and portable exports", () => {
  test("seed validates, dates and module references have semantic checks", () => {
    const { spec, document } = testTrip();
    expect(validate(spec, document, now).document.items.length).toBe(3);
    expect(() => validate({ ...spec, trip: { ...spec.trip, endsOn: "2026-02-31" } }, document, now)).toThrow();
    expect(() => validate({ ...spec, lifecycle: { ...spec.lifecycle, purgeAt: "2028-01-01T00:00:00Z" } }, document, now)).toThrow();
    expect(() => validate({ ...spec, navigation: ["unknown"] }, document, now)).toThrow();
  });
  // aws/verify-expiry.ts builds exactly this shape to watch a real deadline pass, without any "short deadline" flag
  // in the schema or the host. If the rule ever tightens, that script breaks silently on AWS; this fails here instead.
  test("a finished trip can still be published with a deadline minutes away, and it is in its reflection window", () => {
    const day = (back: number) => new Date(now - back * 86400000).toISOString().slice(0, 10);
    const { spec, document } = emptyTrip(day(3), day(2), "期限確認用");
    const purgeAt = new Date(now + 6 * 60000).toISOString();
    const lived = { ...spec, lifecycle: { reflectionDays: 30, purgeAt } };
    expect(validate(lived, document, now).spec.lifecycle.purgeAt).toBe(purgeAt);
    expect(stateOf(validate(lived, document, now).spec, null, now)).toBe("reflection");
    // The deadline must still land on a later date than the last day of the trip.
    expect(() => validate({ ...spec, lifecycle: { reflectionDays: 30, purgeAt: `${day(2)}T23:59:59Z` } }, document, now)).toThrow();
  });
  test("snapshot exports are deterministic, escaped and have correct hashes and confirmed calendar events", async () => {
    const { spec, document } = testTrip(); document.notes = "<script>alert(1)</script>";
    document.reflections.push({ id: "r1", author: "a", body: "unselected memory", createdAt: "2026-09-27T00:00:00Z", included: false });
    const a = await exportFiles("id", spec, document, "2026-09-16T00:00:00Z"), b = await exportFiles("id", spec, document, "2026-09-16T00:00:00Z");
    expect(a).toEqual(b); expect(zip(a)).toEqual(zip(b));
    expect(a["index.html"]).not.toContain("<script>"); expect(a["index.html"]).toContain("&lt;script&gt;");
    expect(a["README.md"]).not.toContain("unselected memory"); expect(a["trip.json"]).toContain("unselected memory");
    expect(a["calendar.ics"]).toContain("DTSTART:20260925T100000Z");
    expect(a["calendar.ics"]).not.toContain("SUMMARY:公園の散歩");
    for (const line of a["calendar.ics"]!.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const manifest = JSON.parse(a["manifest.json"]!);
    for (const [name, hash] of Object.entries(manifest.files as Record<string, string>)) expect(createHash("sha256").update(a[name]!).digest("hex")).toBe(hash);
    expect(Buffer.from(zip(a)).readUInt32LE(0)).toBe(0x04034b50);
  });
});
// The browser seals a private entry's words (src/private-entries.ts); here any `v1.` text stands in, the host never opens it.
const seal = (text: string) => `v1.${Buffer.from(`sealed:${text}`).toString("base64url")}`;  // never empty, as AES-GCM output is not
// A seat's first passkey counts as its check (stepUp), after which it may hand in its wrapped memo key.
async function withKey(request: Send, cookie: string, wrapped = seal(`key-${cookie.slice(-8)}`)) {
  await stepUp(request, cookie); expect((await request("/private", "PATCH", { type: "key", wrapped }, cookie)).status).toBe(200); return cookie;
}
describe("個人用の予定・日記", () => {
  // Every role may keep entries of its own seat; nobody else reads them, and they are not part of the shared trip.
  const members = async (t: Awaited<ReturnType<typeof setup>>) => {
    const owner = await withKey(t.request, await stepUp(t.request, await t.login(t.created.url)));
    const login = async (role: string) => withKey(t.request, await t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url));
    return { owner, editor: await login("editor"), participant: await login("participant"), other: await login("participant"), viewer: await login("viewer") };
  };
  const entry = (id: string, marker: string, extra: Record<string, unknown> = {}) => ({ id, kind: "item", day: "2026-09-25", startsAt: "2026-09-25T10:00:00+09:00", title: seal(`題${marker}`), body: seal(`本文${marker}`), ...extra });
  const put = (t: Awaited<ReturnType<typeof setup>>, cookie: string, e: unknown) => t.request("/private", "PATCH", { type: "put", entry: e }, cookie);
  const payload = (t: Awaited<ReturnType<typeof setup>>) => (t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload;
  test("an entry is read by its own seat only: never by another member, the owner or an editor, the ZIP or the chat copy", async () => {
    const t = await setup(), m = await members(t), marker = seal("本文ひみつのしるし");
    const saved = await put(t, m.participant, entry("p1", "ひみつのしるし"));
    expect(saved.status).toBe(200);
    expect((await saved.json()).private).toMatchObject([{ id: "p1", title: seal("題ひみつのしるし"), body: marker, createdAt: "2026-09-16T00:00:00.000Z" }]);
    expect((await (await t.request("", "GET", undefined, m.participant)).json()).private.map((e: any) => e.id)).toEqual(["p1"]);
    for (const cookie of [m.owner, m.editor, m.other, m.viewer]) {
      const r = await t.request("", "GET", undefined, cookie); expect(r.status).toBe(200);
      const text = await r.text(); expect(text).not.toContain(marker); expect(JSON.parse(text).private).toEqual([]);
      expect(await (await t.request("/export.md", "GET", undefined, cookie)).text()).not.toContain(marker);
    }
    for (const cookie of [m.owner, m.editor]) {
      const zip = Buffer.from(await (await t.request("/export", "GET", undefined, cookie)).arrayBuffer());
      expect(zip.includes(Buffer.from(marker))).toBe(false); expect(zip.includes(Buffer.from("テスト旅行"))).toBe(true);
      expect((await (await t.request("/revise", "GET", undefined, cookie)).json()).text).not.toContain(marker);
    }
    // The owner's list of members does not carry them either.
    expect(await (await t.request("/grants", "GET", undefined, m.owner)).text()).not.toContain(marker);
  });
  test("every role writes, edits and removes its own entries, a viewer too, without moving the trip's revision", async () => {
    const t = await setup(), m = await members(t);
    const before = await t.request("", "GET", undefined, m.viewer), revision = (await before.json()).document.revision, etag = before.headers.get("ETag");
    for (const [i, cookie] of Object.values(m).entries()) expect((await put(t, cookie, entry(`e${i}`, `${i}`))).status).toBe(200);
    // A diary has no time; it comes after the day's timed entries. An entry put again is replaced, keeping when it was made.
    now += 60000;
    expect((await put(t, m.viewer, { id: "d1", kind: "diary", day: "2026-09-25", title: seal(""), body: seal("日記") })).status).toBe(200);
    expect((await put(t, m.viewer, entry("early", "朝", { startsAt: "2026-09-25T07:00:00+09:00" }))).status).toBe(200);
    now += 60000;
    const edited = await (await put(t, m.viewer, { id: "d1", kind: "diary", day: "2026-09-25", title: seal(""), body: seal("書き直した日記") })).json();
    expect(edited.private.map((e: any) => e.id)).toEqual(["early", "e4", "d1"]);
    expect(edited.private[2]).toMatchObject({ body: seal("書き直した日記"), createdAt: "2026-09-16T00:01:00.000Z", updatedAt: "2026-09-16T00:02:00.000Z" });
    const removed = await (await t.request("/private", "PATCH", { type: "remove", id: "early" }, m.viewer)).json();
    expect(removed.private.map((e: any) => e.id)).toEqual(["e4", "d1"]);
    // Neither If-Match nor a new revision: the others' screens see nothing changed.
    const after = await t.request("", "GET", undefined, m.viewer);
    expect((await after.json()).document.revision).toBe(revision); expect(after.headers.get("ETag")).toBe(etag);
    expect((await t.host.fetch(new Request(`${origin}/v1/c/${t.created.id}/private`, { method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json", Cookie: m.participant }, body: JSON.stringify({ type: "remove", id: "e2" }) }))).status).toBe(200);
    expect((await t.request("/private", "PATCH", { type: "put", entry: entry("x", "x") }, m.owner, 1, "https://evil.example")).status).toBe(403);
    expect((await t.request("/private", "PATCH", { type: "put", entry: entry("x", "x") })).status).toBe(401);
  });
  test("a passkey brings the entries back to the seat; revoking the member erases them from what is stored", async () => {
    const t = await setup(), m = await members(t), marker = seal("題失効で消えるしるし"), device = devices.get(m.participant)!;
    const challenge = async () => (await (await t.request("/passkey/challenge", "POST", {})).json()).challenge as string;
    expect((await put(t, m.participant, entry("p1", "失効で消えるしるし"))).status).toBe(200);
    device.setCounter(1); const back = await challenge();
    const returned = await t.request("/passkey/session", "POST", { challenge: back, id: device.id, ...device.assert(back) }); expect(returned.status).toBe(200);
    const again = returned.headers.get("Set-Cookie")!.split(";")[0]!, read = await (await t.request("", "GET", undefined, again)).json();
    expect(read.private.map((e: any) => e.title)).toEqual([marker]); expect(read.privateKey).toBe(seal(`key-${m.participant.slice(-8)}`));
    expect(payload(t)).toContain(marker);
    const seat = (await (await t.request("/grants", "GET", undefined, m.owner)).json()).flatMap((g: any) => g.members).find((x: any) => x.label !== "オーナー" && JSON.parse(payload(t)).private?.[x.id]);
    expect((await t.request("/revoke", "POST", { member: seat.id, confirm: true }, m.owner)).status).toBe(200);
    expect(payload(t)).not.toContain(marker); expect(JSON.parse(payload(t)).private?.[seat.id]).toBeUndefined();
    // Revoking an invite takes its members' entries too.
    expect((await put(t, m.other, entry("o1", "招待の失効で消えるしるし"))).status).toBe(200);
    const grant = (await (await t.request("/grants", "GET", undefined, m.owner)).json()).find((g: any) => g.role === "participant" && g.members.length);
    expect((await t.request("/revoke", "POST", { id: grant.id, confirm: true }, m.owner)).status).toBe(200);
    expect(payload(t)).not.toContain(seal("題招待の失効で消えるしるし"));
  });
  test("written after the trip too, not once sharing has ended, and gone with the capsule", async () => {
    const t = await setup(), m = await members(t);
    now = +new Date("2026-09-26T15:00:00Z");
    expect((await (await t.request("", "GET", undefined, m.participant)).json()).state).toBe("reflection");
    expect((await put(t, m.participant, entry("r1", "旅行後"))).status).toBe(200);
    now = +new Date("2026-10-03T15:00:00Z");
    expect((await (await t.request("", "GET", undefined, m.participant)).json()).state).toBe("frozen");
    expect((await put(t, m.participant, entry("r2", "終了後"))).status).toBe(403);
    expect((await t.request("/private", "PATCH", { type: "remove", id: "r1" }, m.participant)).status).toBe(403);
    // The owner's freeze: the other seats go at once, and with them their entries.
    now = +new Date("2026-09-26T15:00:00Z");
    const u = await setup(), n = await members(u);
    expect((await put(u, n.participant, entry("f1", "凍結で消えるしるし"))).status).toBe(200);
    expect((await put(u, n.owner, entry("f2", "オーナーのしるし"))).status).toBe(200);
    expect((await u.request("/freeze", "POST", { confirm: true }, n.owner)).status).toBe(200);
    expect(payload(u)).not.toContain(seal("題凍結で消えるしるし")); expect(payload(u)).toContain(seal("題オーナーのしるし"));
    expect((await put(u, n.owner, entry("f3", "x"))).status).toBe(403);
    expect((await u.request("/purge", "POST", { title: u.seed.spec.title }, n.owner)).status).toBe(200);
    expect((await put(u, n.owner, entry("f4", "x"))).status).toBe(410);
  });
  test("outside the trip's dates or on a day that does not exist, or past 100 entries, is refused", async () => {
    const t = await setup(), m = await members(t);
    const error = async (r: Response) => [r.status, (await r.json()).error];
    expect(await error(await put(t, m.participant, entry("a", "x", { day: "2026-09-27", startsAt: undefined })))).toEqual([400, "旅行期間の日付を指定してください"]);
    expect(await error(await put(t, m.participant, entry("a", "x", { day: "2026-09-23", startsAt: undefined })))).toEqual([400, "旅行期間の日付を指定してください"]);
    for (let i = 1; i <= 100; i++) expect((await put(t, m.participant, entry(`n${i}`, `${i}`))).status).toBe(200);
    expect(await error(await put(t, m.participant, entry("n101", "x")))).toEqual([400, "個人メモは100件までです"]);
    // A day that does not exist is refused as a malformed entry, even one that sorts between the trip's first and last days; a
    // real day gets as far as the seat's key (this seat has none).
    const t2 = await setup(); const month = emptyTrip("2026-09-29", "2026-10-02", "月をまたぐ旅行");
    const crossing = await (await t2.host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...month, confirm: true }) }))).json();
    const cookie = (await t2.host.fetch(new Request(`${origin}/v1/c/${crossing.id}/sessions`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: new URL(crossing.url).hash.slice(3) }) }))).headers.get("Set-Cookie")!.split(";")[0]!;
    const diaryOn = (day: string) => t2.host.fetch(new Request(`${origin}/v1/c/${crossing.id}/private`, { method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ type: "put", entry: { id: "d", kind: "diary", day, title: seal(""), body: seal("日記") } }) }));
    expect(await error(await diaryOn("2026-09-31"))).toEqual([400, "入力内容を確認してください"]); expect(await error(await diaryOn("2026-09-30"))).toEqual([400, "自分だけのメモの鍵がありません"]);
    // Replacing one of the hundred is still allowed; another seat has its own hundred.
    expect((await put(t, m.participant, entry("n1", "書き直し"))).status).toBe(200);
    expect((await put(t, m.other, entry("n100", "x"))).status).toBe(200);
  });
  test("apply は何件もまとめて入れ替え、1 件でも通らなければ何も変えない", async () => {
    // What a chat's answer changes at once (#427): all of it goes in, or none of it.
    const t = await setup(), m = await members(t);
    const apply = (cookie: string, put: unknown[], remove: string[] = []) => t.request("/private", "PATCH", { type: "apply", put, remove }, cookie);
    const ids = async (cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()).private.map((e: any) => e.id);
    expect((await put(t, m.participant, entry("keep", "残る"))).status).toBe(200);
    expect((await put(t, m.participant, entry("gone", "消える", { startsAt: "2026-09-25T09:00:00+09:00" }))).status).toBe(200);
    expect((await put(t, m.other, entry("theirs", "他人"))).status).toBe(200);
    const before = await t.request("", "GET", undefined, m.participant), revision = (await before.json()).document.revision, etag = before.headers.get("ETag");
    now += 60000;
    const applied = await apply(m.participant, [entry("a1", "朝", { startsAt: "2026-09-25T07:00:00+09:00" }), { id: "d1", kind: "diary", day: "2026-09-25", title: seal(""), body: seal("日記") }, entry("keep", "直した")], ["gone"]);
    expect(applied.status).toBe(200);
    const list = (await applied.json()).private;
    expect(list.map((e: any) => e.id)).toEqual(["a1", "keep", "d1"]);
    expect(list[1]).toMatchObject({ title: seal("題直した"), createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:01:00.000Z" });
    const after = await t.request("", "GET", undefined, m.participant);
    expect((await after.json()).document.revision).toBe(revision); expect(after.headers.get("ETag")).toBe(etag);
    expect(await ids(m.other)).toEqual(["theirs"]);
    // One entry outside the trip's dates, one id twice, or more than a hundred in the end: refused, and nothing changed.
    const error = async (r: Response) => [r.status, (await r.json()).error];
    expect(await error(await apply(m.participant, [entry("b1", "x"), entry("b2", "x", { day: "2026-09-27", startsAt: undefined })], ["a1"]))).toEqual([400, "旅行期間の日付を指定してください"]);
    expect(await error(await apply(m.participant, [entry("b1", "x"), entry("b1", "y")]))).toEqual([400, "同じ項目が2回あります"]);
    expect(await error(await apply(m.participant, [entry("b1", "x")], ["b1"]))).toEqual([400, "同じ項目が2回あります"]);
    expect(await error(await apply(m.participant, Array.from({ length: 98 }, (_, i) => entry(`n${i}`, `${i}`))))).toEqual([400, "個人メモは100件までです"]);
    expect(await ids(m.participant)).toEqual(["a1", "keep", "d1"]);
    // Removing makes room in the same apply: 3 - 1 + 98 = 100.
    expect((await apply(m.participant, Array.from({ length: 98 }, (_, i) => entry(`n${i}`, `${i}`)), ["d1"])).status).toBe(200);
    expect(await ids(m.participant)).toHaveLength(100);
    // A seat without its key, and after sharing has ended.
    const u = await setup(), owner = await stepUp(u.request, await u.login(u.created.url));
    const bare = await u.login((await (await u.request("/grants", "POST", { role: "viewer", label: "v", expiresAt: u.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    const refused = await u.request("/private", "PATCH", { type: "apply", put: [entry("k", "x")], remove: [] }, bare);
    expect(refused.status).toBe(400); expect((await refused.json()).error).toBe("自分だけのメモの鍵がありません");
    now = +new Date("2026-10-03T15:00:00Z");
    expect((await apply(m.participant, [entry("late", "x")])).status).toBe(403);
  });
});
describe("footprints", () => {
  // Every member reads the trip's footprints; all but a viewer leave them, during the trip only. The clock is put inside the trip.
  // Seats are named in the order they joined: オーナー, then メンバー2 (editor), 3 (participant), 4 (other), 5 (viewer).
  const members = async (t: Awaited<ReturnType<typeof setup>>) => {
    const owner = await stepUp(t.request, await t.login(t.created.url));
    const login = async (role: string) => t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    return { owner, editor: await login("editor"), participant: await login("participant"), other: await login("participant"), viewer: await login("viewer") };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;
  const here = { type: "add", lat: 35.6812, lng: 139.7671, accuracy: 20 };
  const add = (t: Setup, cookie: string, point: Record<string, unknown> = {}) => t.request("/footprints", "PATCH", { ...here, ...point }, cookie);
  const remove = (t: Setup, cookie: string, id: string) => t.request("/footprints", "PATCH", { type: "remove", id }, cookie);
  const read = async (t: Setup, cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()).footprints as Array<{ id: string; at: string; lat: number; lng: number; accuracy: number; by: string; mine: boolean; auto: boolean }>;
  const error = async (r: Response) => [r.status, (await r.json()).error];
  const during = +new Date("2026-09-25T01:00:00Z");
  test("footprint: members add and every role reads, viewer / frozen / outside the trip refused", async () => {
    const t = await setup(), m = await members(t);
    now = during;
    // A trip stored before footprints were kept has none: it reads as an empty list.
    const before = await t.request("", "GET", undefined, m.viewer), first = await before.json(), revision = first.document.revision, etag = before.headers.get("ETag");
    expect(first.footprints).toEqual([]);
    for (const cookie of [m.participant, m.editor, m.owner]) { const r = await add(t, cookie); expect(r.status).toBe(200); expect((await r.json()).ok).toBe(true); now += 1000; }
    expect(await error(await add(t, m.viewer))).toEqual([403, "閲覧者は足あとを残せません"]);
    for (const [name, cookie] of Object.entries(m)) {
      const list = await read(t, cookie);
      expect(list.map(p => p.by)).toEqual(["メンバー3", "メンバー2", "オーナー"]);
      expect(list.map(p => p.at)).toEqual(["2026-09-25T01:00:00.000Z", "2026-09-25T01:00:01.000Z", "2026-09-25T01:00:02.000Z"]);
      expect(list[0]).toMatchObject({ lat: 35.6812, lng: 139.7671, accuracy: 20 }); expect(list[0]).not.toHaveProperty("seat");
      expect(list.map(p => p.mine)).toEqual([name === "participant", name === "editor", name === "owner"]);
    }
    // Neither If-Match nor a new revision, as with a member's own entries.
    const after = await t.request("", "GET", undefined, m.viewer);
    expect((await after.json()).document.revision).toBe(revision); expect(after.headers.get("ETag")).toBe(etag);
    // The day before the trip, after it (reflection) and once sharing has ended.
    const outside = "足あとは旅行期間中だけ残せます";
    now = +new Date("2026-09-23T14:00:00Z"); expect(await error(await add(t, m.other))).toEqual([403, outside]);
    now = +new Date("2026-09-26T15:00:00Z"); expect((await (await t.request("", "GET", undefined, m.other)).json()).state).toBe("reflection");
    expect(await error(await add(t, m.other))).toEqual([403, outside]);
    now = during + 3600000; expect((await t.request("/freeze", "POST", { confirm: true }, await stepUp(t.request, m.owner))).status).toBe(200);
    expect(await error(await add(t, m.owner))).toEqual([403, outside]);
    expect(await read(t, m.owner)).toHaveLength(3);
  });
  test("footprint: self, owner and editor remove; another participant 403", async () => {
    const t = await setup(), m = await members(t);
    now = during;
    const ids: string[] = [];
    for (const cookie of [m.participant, m.participant, m.other, m.other]) { const r = await add(t, cookie); expect(r.status).toBe(200); ids.push((await r.json()).footprints.at(-1).id); now += 60000; }
    expect(await error(await remove(t, m.other, ids[0]!))).toEqual([403, "自分の足あとだけ消せます"]);
    expect(await error(await remove(t, m.viewer, ids[0]!))).toEqual([403, "自分の足あとだけ消せます"]);
    const own = await remove(t, m.participant, ids[0]!); expect(own.status).toBe(200);
    expect((await own.json()).footprints.map((p: any) => p.id)).toEqual(ids.slice(1));
    expect((await remove(t, m.editor, ids[1]!)).status).toBe(200);
    expect((await remove(t, m.owner, ids[2]!)).status).toBe(200);
    expect((await read(t, m.viewer)).map(p => p.id)).toEqual([ids[3]!]);
    expect(await error(await remove(t, m.owner, ids[0]!))).toEqual([404, "足あとが見つかりません"]);
    // After the trip a point may still be taken out; once sharing has ended, nothing changes.
    now = +new Date("2026-09-26T15:00:00Z"); expect((await remove(t, m.other, ids[3]!)).status).toBe(200);
    now = +new Date("2026-09-25T02:00:00Z"); const kept = (await (await add(t, m.owner)).json()).footprints.at(-1).id;
    expect((await t.request("/freeze", "POST", { confirm: true }, await stepUp(t.request, m.owner))).status).toBe(200);
    expect(await error(await remove(t, m.owner, kept))).toEqual([403, "共有終了後は変更できません"]);
  });
  test("footprint limits: 1000 per trip, once a minute per seat, accuracy over 1 km refused, purge then 410", async () => {
    const t = await setup(), m = await members(t);
    now = during;
    expect((await add(t, m.participant)).status).toBe(200);
    now += 59999; expect(await error(await add(t, m.participant))).toEqual([429, "足あとは1分に1回までです"]);
    expect((await add(t, m.other)).status).toBe(200);  // another seat has its own minute
    now += 1; expect((await add(t, m.participant)).status).toBe(200);
    now += 60000;
    for (const point of [{ accuracy: 1000.5 }, { lat: 90.1 }, { lng: -180.1 }, { accuracy: -1 }, { lat: "35" }, { extra: 1 }]) expect((await add(t, m.participant, point)).status).toBe(400);
    expect((await add(t, m.participant, { accuracy: 1000 })).status).toBe(200);
    // The trip's 1000th point is taken; the next is refused, whoever leaves it.
    const row = (await t.host.store.get(t.host.digest(t.created.id)))!, c = JSON.parse(row.payload!);
    c.footprints = [...c.footprints, ...Array.from({ length: 995 }, (_, i) => ({ id: `f${i}`, seat: "gone", by: "メンバー", at: "2026-09-25T00:00:00.000Z", lat: 35, lng: 139, accuracy: 10 }))];
    expect(await t.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
    now += 60000; expect((await add(t, m.editor)).status).toBe(200);
    expect(await read(t, m.viewer)).toHaveLength(1000);
    now += 60000; expect(await error(await add(t, m.owner))).toEqual([400, "足あとは1旅行1000件までです"]);
    // Leaving footprints writes nothing to the capsule's record: a thousand points would push the history of invites out of it.
    expect(JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload).audit.some((a: any) => a.event === "footprints")).toBe(false);
    expect((await t.request("/purge", "POST", { title: t.seed.spec.title }, await stepUp(t.request, m.owner))).status).toBe(200);
    expect((await add(t, m.participant)).status).toBe(410);
    expect((await t.request("", "GET", undefined, m.participant)).status).toBe(410);
  });
  test("footprint auto: kept and read by every role, false refused, the limits and roles still apply", async () => {
    const t = await setup(), m = await members(t);
    now = during;
    // A point left on opening the page carries auto; one left by the button has none and reads as false.
    expect((await add(t, m.participant, { auto: true })).status).toBe(200);
    now += 1000; expect(await error(await add(t, m.participant, { auto: true }))).toEqual([429, "足あとは1分に1回までです"]);
    now += 59000; expect((await add(t, m.participant)).status).toBe(200);
    for (const cookie of [m.owner, m.viewer]) expect((await read(t, cookie)).map(p => p.auto)).toEqual([true, false]);
    expect((await add(t, m.other, { auto: false })).status).toBe(400);
    expect(await error(await add(t, m.viewer, { auto: true }))).toEqual([403, "閲覧者は足あとを残せません"]);
    now = +new Date("2026-09-23T14:00:00Z"); expect(await error(await add(t, m.other, { auto: true }))).toEqual([403, "足あとは旅行期間中だけ残せます"]);
  });
  test("footprint: a revoked seat's points stay with their name", async () => {
    const t = await setup(), m = await members(t);
    now = during;
    expect((await add(t, m.other)).status).toBe(200);
    const seat = (await (await t.request("/grants", "GET", undefined, m.owner)).json()).flatMap((g: any) => g.members).find((x: any) => x.label === "メンバー4");
    expect((await t.request("/revoke", "POST", { member: seat.id, confirm: true }, await stepUp(t.request, m.owner))).status).toBe(200);
    expect(await read(t, m.viewer)).toMatchObject([{ by: "メンバー4", mine: false }]);
    // The owner's freeze takes every other seat; their points stay for the owner to look back on.
    expect((await add(t, m.participant)).status).toBe(200);
    expect((await t.request("/freeze", "POST", { confirm: true }, await stepUp(t.request, m.owner))).status).toBe(200);
    expect((await read(t, m.owner)).map(p => p.by)).toEqual(["メンバー4", "メンバー3"]);
  });
});
describe("個人メモの暗号文", () => {
  const participant = async (t: Awaited<ReturnType<typeof setup>>) => {
    const owner = await stepUp(t.request, await t.login(t.created.url));
    return { owner, member: await t.login((await (await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url) };
  };
  const item = (extra: Record<string, unknown> = {}) => ({ id: "s1", kind: "item", day: "2026-09-25", startsAt: "2026-09-25T10:00:00+09:00", title: seal("題"), body: seal("本文"), ...extra });
  const put = (t: Awaited<ReturnType<typeof setup>>, cookie: string, e: unknown) => t.request("/private", "PATCH", { type: "put", entry: e }, cookie);
  test("the title, body and place are taken only as v1. ciphertext of a bounded length", async () => {
    const t = await setup(), { member } = await participant(t); await withKey(t.request, member);
    for (const bad of [{ title: "目印" }, { title: "x1.AAAA" }, { title: "v1.目印" }, { title: `v1.${"A".repeat(698)}` }, { body: "本文の目印" }, { body: `v1.${"A".repeat(16_098)}` }, { place: JSON.stringify({ label: "駅" }) }, { place: `v1.${"A".repeat(17_398)}` }, { place: { label: "駅" } }])
      expect((await put(t, member, item(bad))).status).toBe(400);
    expect((await put(t, member, item({ title: `v1.${"A".repeat(697)}`, body: `v1.${"A".repeat(16_097)}`, place: `v1.${"A".repeat(17_397)}` }))).status).toBe(200);
    // The plain times are kept as they were written: the browser sealed the words against those very strings.
    expect((await put(t, member, item({ startsAt: "2026-09-25T10:00:00+09:00", endsAt: "2026-09-25T11:30:00+09:00" }))).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, member)).json()).private[0]).toMatchObject({ startsAt: "2026-09-25T10:00:00+09:00", endsAt: "2026-09-25T11:30:00+09:00" });
  });
  test("a seat without its key cannot write, but may remove", async () => {
    const t = await setup(), { member } = await participant(t);
    const refused = await put(t, member, item()); expect(refused.status).toBe(400); expect((await refused.json()).error).toBe("自分だけのメモの鍵がありません");
    expect((await t.request("/private", "PATCH", { type: "remove", id: "s1" }, member)).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, member)).json()).privateKey).toBeNull();
  });
  test("the wrapped key is handed in once, after the seat's passkey check, and goes back to that seat only", async () => {
    const t = await setup(), { owner, member } = await participant(t), wrapped = seal("wrapped-memo-key");
    expect((await t.request("/private", "PATCH", { type: "key", wrapped }, member)).status).toBe(428);
    await stepUp(t.request, member);
    expect((await t.request("/private", "PATCH", { type: "key", wrapped: "plain key" }, member)).status).toBe(400);
    expect((await t.request("/private", "PATCH", { type: "key", wrapped }, member)).status).toBe(200);
    const again = await t.request("/private", "PATCH", { type: "key", wrapped: seal("another") }, member); expect(again.status).toBe(409); expect((await again.json()).error).toBe("自分だけのメモの鍵はもうあります");
    expect((await (await t.request("", "GET", undefined, member)).json()).privateKey).toBe(wrapped);
    expect((await (await t.request("", "GET", undefined, owner)).json()).privateKey).toBeNull();
    const listed = await (await t.request("/grants", "GET", undefined, owner)).text(); expect(listed).not.toContain(wrapped); expect(listed).not.toContain("privateKey");
    expect((await put(t, member, item())).status).toBe(200);
  });
  test("replacing the passkey of a seat with a key needs the key rewrapped; a seat without one may not send one", async () => {
    const t = await setup(), { member } = await participant(t), wrapped = seal("wrapped-by-the-first");
    await withKey(t.request, member, wrapped);
    const current = devices.get(member)!, next = fakeAuthenticator();
    const challenge = async () => (await (await t.request("/passkey/challenge", "POST", {})).json()).challenge as string;
    const replace = async (extra: Record<string, unknown>) => { const check = await challenge(), fresh = await challenge(); return t.request("/passkey", "POST", { challenge: fresh, ...next.register(fresh), check: { challenge: check, id: current.id, ...current.assert(check) }, ...extra }, member); };
    const refused = await replace({}); expect(refused.status).toBe(400); expect((await refused.json()).error).toBe("自分だけのメモの鍵を包み直してください");
    expect((await replace({ privateKey: seal("rewrapped-by-the-second") })).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, member)).json()).privateKey).toBe(seal("rewrapped-by-the-second"));
    expect(JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload).sessions.find((s: any) => s.privateKey).privateKey.passkey).toBe(next.id);
    // A seat that never had a key: its first passkey sends none, and a key sent anyway is refused.
    const u = await setup(), other = await participant(u), first = await (await u.request("/passkey/challenge", "POST", {})).json(), device = fakeAuthenticator();
    const sent = await u.request("/passkey", "POST", { challenge: first.challenge, ...device.register(first.challenge), privateKey: seal("nothing to rewrap") }, other.member);
    expect(sent.status).toBe(400); expect((await sent.json()).error).toBe("自分だけのメモの鍵がありません");
  });
});
describe("trip keys", () => {
  // Made as the browser makes them (src/trip-keys.ts): the host is handed only public keys and what is already wrapped.
  async function made(capsuleId: string, withSecret = true) {
    const seat = await newSeatKeys(), pub = await seatPublic(seat), prf = crypto.getRandomValues(new Uint8Array(32));
    const wrap = await wrapTripKey(await newTripKey(), pub.x25519, capsuleId, 1);
    return { seat, prf, body: { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped, ...(withSecret ? { secret: await wrapSeatSecret(seat, prf, capsuleId) } : {}) } as Record<string, any> };
  }
  const put = (t: Awaited<ReturnType<typeof setup>>, cookie: string, body: unknown) => t.request("/keys", "PATCH", body, cookie);
  const invite = async (t: Awaited<ReturnType<typeof setup>>, owner: string, body: object = {}) => t.login((await (await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, ...body }, owner)).json()).url);
  const sessions = (t: Awaited<ReturnType<typeof setup>>) => JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload).sessions as any[];

  test("the owner's browser puts the keys once, and reads them back and opens them", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), k = await made(t.created.id);
    const before = await (await t.request("", "GET", undefined, owner)).json(); expect(before.seatKey).toBeNull(); expect(before.keyed).toBe(false);
    expect((await put(t, owner, k.body)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    expect(view.keyed).toBe(true); expect(view.seatKey).toMatchObject({ x25519: k.body.x25519, ed25519: k.body.ed25519, generation: 1, wrapped: k.body.wrapped, ephemeral: k.body.ephemeral });
    const back = await unwrapSeatSecret(view.seatKey.secret, k.prf, t.created.id);
    expect(await unwrapTripKey(view.seatKey.wrapped, view.seatKey.ephemeral, back.x25519, t.created.id, 1)).toBeDefined();
    expect(sessions(t).find(s => s.seatKey).seatKey.secret.passkey).toBe(devices.get(owner)!.id);
    // The trip is read as it was: the plan, the revision and the schema do not move.
    expect(view.document.revision).toBe(before.document.revision);
  });
  test("a value that is not a wrapped key is refused with 400", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), { body } = await made(t.created.id);
    for (const bad of [{ x25519: "short" }, { ed25519: `${"A".repeat(42)}=` }, { ephemeral: "目印" }, { generation: 2 }, { wrapped: "plain" }, { wrapped: `v1.${"A".repeat(198)}` }, { type: "other" }, { extra: 1 }, { secret: { x25519: "plain", ed25519: body.secret.ed25519 } }, { secret: { x25519: body.secret.x25519 } }])
      expect((await put(t, owner, { ...body, ...bad })).status).toBe(400);
    expect(sessions(t).some(s => s.seatKey)).toBe(false);
  });
  test("only the owner puts the first key; a second owner seat waits (409)", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), member = await stepUp(t.request, await invite(t, owner));
    const second = await stepUp(t.request, await invite(t, owner, { role: "owner" })), k = await made(t.created.id);
    expect((await put(t, member, k.body)).status).toBe(403);
    expect((await put(t, owner, k.body)).status).toBe(200);
    const again = await put(t, second, (await made(t.created.id)).body); expect(again.status).toBe(409); expect((await again.json()).error).toBe("旅行の鍵はもうあります");
    expect((await put(t, member, (await made(t.created.id)).body)).status).toBe(403);
    expect((await (await t.request("", "GET", undefined, member)).json())).toMatchObject({ seatKey: null, keyed: true });
  });
  test("a seat without a PRF keeps no wrapped secret key, and one with keys puts a new set only with its passkey checked", async () => {
    const t = await setup(), owner = await t.login(t.created.url), k = await made(t.created.id, false);
    // No passkey at all: public keys and the wrapped trip key only.
    expect((await put(t, owner, k.body)).status).toBe(200);
    expect(sessions(t).find(s => s.seatKey).seatKey.secret).toBeUndefined();
    const view = await (await t.request("", "GET", undefined, owner)).json(); expect(view.seatKey.secret).toBeUndefined();
    // Putting a new set with a secret needs the passkey, then the check just made.
    const next = await made(t.created.id);
    const none = await put(t, owner, next.body); expect(none.status).toBe(400);
    await stepUp(t.request, owner);
    expect((await put(t, owner, { ...next.body, secret: undefined })).status).toBe(400);
    expect((await put(t, owner, next.body)).status).toBe(200);
    expect(sessions(t).find(s => s.seatKey).seatKey).toMatchObject({ x25519: next.body.x25519, secret: { passkey: devices.get(owner)!.id } });
    now += 6 * 60_000;  // the check is old
    expect((await put(t, owner, (await made(t.created.id)).body)).status).toBe(428);
  });
  test("replacing the passkey drops the secret key wrapped by the old one", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), k = await made(t.created.id);
    expect((await put(t, owner, k.body)).status).toBe(200);
    const current = devices.get(owner)!, next = fakeAuthenticator();
    const challenge = async () => (await (await t.request("/passkey/challenge", "POST", {})).json()).challenge as string;
    const check = await challenge(), fresh = await challenge();
    expect((await t.request("/passkey", "POST", { challenge: fresh, ...next.register(fresh), check: { challenge: check, id: current.id, ...current.assert(check) } }, owner)).status).toBe(200);
    const seat = sessions(t).find(s => s.seatKey).seatKey; expect(seat.secret).toBeUndefined(); expect(seat.wrapped).toBe(k.body.wrapped);
  });
  test("a seat waiting for approval and a revoked seat cannot put keys", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const pending = await invite(t, owner, { approval: "owner" }), k = await made(t.created.id);
    expect((await put(t, pending, k.body)).status).toBe(403);
    const other = await invite(t, owner), listed = await (await t.request("/grants", "GET", undefined, owner)).json();
    const id = listed.flatMap((g: any) => g.members).find((m: any) => !m.pending && !m.self).id;
    expect((await t.request("/revoke", "POST", { member: id, confirm: true }, owner)).status).toBe(200);
    expect((await put(t, other, k.body)).status).toBe(401);
    expect((await put(t, "", k.body)).status).toBe(401);
  });
  test("keys are taken after sharing ends, and the grants list shows public keys only", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), k = await made(t.created.id);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(200);
    expect((await put(t, owner, k.body)).status).toBe(200);
    const text = await (await t.request("/grants", "GET", undefined, owner)).text();
    const self = JSON.parse(text).flatMap((g: any) => g.members).find((m: any) => m.self);
    expect(self.publicKey).toEqual({ x25519: k.body.x25519, ed25519: k.body.ed25519 });
    for (const hidden of [k.body.wrapped, k.body.ephemeral, k.body.secret.x25519, "seatKey"]) expect(text).not.toContain(hidden);
  });
  test("a trip with no keys reads as before", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const view = await (await t.request("", "GET", undefined, owner)).json();
    expect(view).toMatchObject({ seatKey: null, keyed: false, role: "owner" }); expect(view.spec.schemaVersion).toBe(t.seed.spec.schemaVersion);
    const listed = (await (await t.request("/grants", "GET", undefined, owner)).json()).flatMap((g: any) => g.members);
    expect(listed.every((m: any) => m.publicKey === null)).toBe(true);
  });

  describe("鍵の受け渡し", () => {
    type T = Awaited<ReturnType<typeof setup>>;
    // The owner's seat takes the trip key, as its browser does; the seat keys stay in the test, as in the browser.
    async function keyedOwner(t: T) {
      const owner = await stepUp(t.request, await t.login(t.created.url)), seat = await newSeatKeys(), pub = await seatPublic(seat), trip = await newTripKey();
      const wrap = await wrapTripKey(trip, pub.x25519, t.created.id, 1);
      expect((await put(t, owner, { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped })).status).toBe(200);
      return { cookie: owner, seat, pub, trip };
    }
    const patch = async (t: T, cookie: string, body: object) => { const r = await put(t, cookie, body); return { status: r.status, body: await r.json() as any }; };
    const view = async (t: T, cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()) as any;
    // Steps 1-4 with both browsers' real functions. `mutate` is the operator's hand on the stored payload between steps.
    async function run(t: T, giver: { cookie: string; seat: { x25519: CryptoKeyPair; ed25519: CryptoKeyPair }; pub: { x25519: string; ed25519: string }; trip: CryptoKey }, member: string, typed?: { member?: string; giver?: string }) {
      const memberSeat = await newSeatKeys(), memberPub = await seatPublic(memberSeat), attempt = await newAttempt(memberPub, t.created.id);
      const waited = await patch(t, member, { type: "wait", commitment: attempt.commitment }); expect(waited.status).toBe(200);
      const att = waited.body.handoff.attempt as string;
      const waiting = (await view(t, giver.cookie)).waiting.find((w: any) => w.handoff?.attempt === att);
      const commitment = waiting.handoff.commitment as string;  // read before the giver's own values are put
      const h = await newHandoffKeys();
      expect((await patch(t, giver.cookie, { type: "give", seat: waiting.id, attempt: att, ephemeral: h.ephemeral })).status).toBe(200);
      const given = (await view(t, member)).handoff.giver;  // the member keeps this
      expect((await patch(t, member, { type: "reveal", attempt: att, ...memberPub, nonce: attempt.nonce })).status).toBe(200);
      const revealed = (await view(t, giver.cookie)).waiting.find((w: any) => w.id === waiting.id).handoff.reveal;
      expect(await matchesCommitment(commitment, { x25519: revealed.x25519, ed25519: revealed.ed25519 }, revealed.nonce, t.created.id)).toBe(true);
      const mine = await confirmationCodes({ capsuleId: t.created.id, giver: { ephemeral: given.ephemeral, x25519: given.x25519, ed25519: given.ed25519 }, member: { ...memberPub, nonce: attempt.nonce } });
      const theirs = await confirmationCodes({ capsuleId: t.created.id, giver: { ephemeral: h.ephemeral, x25519: giver.pub.x25519, ed25519: giver.pub.ed25519 }, member: revealed });
      return { att, memberSeat, memberPub, attempt, waiting, given, h, mine, theirs, wrapNow: async () => {
        const wrap = await wrapTripKey(giver.trip, revealed.x25519, t.created.id, 1, h.pair);
        return patch(t, giver.cookie, { type: "wrap", seat: waiting.id, attempt: att, wrapped: wrap.wrapped });
      } };
    }

    test("owner → participant: the codes agree, the key is wrapped, and both seats hold the edge", async () => {
      const t = await setup(), giver = await keyedOwner(t), member = await invite(t, giver.cookie);
      const r = await run(t, giver, member);
      expect(r.mine).toEqual(r.theirs);
      expect((await r.wrapNow()).status).toBe(200);
      const v = await view(t, member);
      expect(v.handoff).toBeNull(); expect(v.seatKey).toMatchObject({ x25519: r.memberPub.x25519, ed25519: r.memberPub.ed25519, ephemeral: r.h.ephemeral });
      const opened = await unwrapTripKey(v.seatKey.wrapped, v.seatKey.ephemeral, r.memberSeat.x25519.privateKey, t.created.id, 1);
      // The same key: what one encrypts, the other decrypts.
      const iv = crypto.getRandomValues(new Uint8Array(12)), sealedText = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, giver.trip, new TextEncoder().encode("旅行の鍵"));
      expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, opened, sealedText))).toBe("旅行の鍵");
      const ownerId = r.given.seat as string, memberId = r.waiting.id as string;
      expect((await patch(t, giver.cookie, { type: "edge", seat: memberId, signature: await signEdge(giver.seat.ed25519.privateKey, { seat: memberId, ...r.memberPub }, t.created.id) })).status).toBe(200);
      expect((await patch(t, member, { type: "edge", seat: ownerId, signature: await signEdge(r.memberSeat.ed25519.privateKey, { seat: ownerId, ...giver.pub }, t.created.id) })).status).toBe(200);
      const edges = sessions(t).flatMap(s => s.seatKey?.edges ?? []);
      expect(edges).toHaveLength(2);
      const stored = sessions(t).find(s => s.id === ownerId).seatKey.edges[0];
      expect(await verifyEdge(giver.pub.ed25519, stored.signature, { seat: memberId, ...r.memberPub }, t.created.id)).toBe(true);
    });
    test("every role with the key can give, and a seat without it cannot (403)", async () => {
      const t = await setup(), owner = await keyedOwner(t);
      for (const role of ["viewer", "editor", "participant"]) {
        const holder = await invite(t, owner.cookie, { role, label: role });
        const first = await run(t, owner, holder); expect((await first.wrapNow()).status).toBe(200);
        // The holder gives to a newcomer with the key it was just given.
        const newcomer = await invite(t, owner.cookie, { role: "participant", label: `n-${role}` });
        const giver = { cookie: holder, seat: first.memberSeat, pub: first.memberPub, trip: owner.trip };
        const second = await run(t, giver, newcomer); expect(second.mine).toEqual(second.theirs);
        expect((await second.wrapNow()).status).toBe(200);
      }
      const keyless = await invite(t, owner.cookie, { label: "k" }), other = await invite(t, owner.cookie, { label: "o" });
      const w = await patch(t, other, { type: "wait", commitment: (await newAttempt(await seatPublic(await newSeatKeys()), t.created.id)).commitment });
      const id = (await view(t, owner.cookie)).waiting.find((x: any) => x.handoff?.attempt === w.body.handoff.attempt).id;
      const h = await newHandoffKeys();
      const refused = await patch(t, keyless, { type: "give", seat: id, attempt: w.body.handoff.attempt, ephemeral: h.ephemeral });
      expect(refused.status).toBe(403); expect(refused.body.error).toBe("旅行の鍵を持つメンバーだけが渡せます");
    });
    test("abandon leaves nothing, and a new wait changes the attempt and the commitment", async () => {
      const t = await setup(), giver = await keyedOwner(t), member = await invite(t, giver.cookie);
      const r = await run(t, giver, member);
      expect((await patch(t, giver.cookie, { type: "abandon", seat: r.waiting.id, attempt: r.att })).status).toBe(200);
      expect((await view(t, member)).handoff).toBeNull();
      expect((await r.wrapNow()).status).toBe(409);
      expect((await view(t, member)).seatKey).toBeNull();
      const again = await run(t, giver, member);
      expect(again.att).not.toBe(r.att); expect(again.attempt.commitment).not.toBe(r.attempt.commitment);
      // A newer attempt makes the older one's writes fail.
      expect((await patch(t, member, { type: "reveal", attempt: r.att, ...r.memberPub, nonce: r.attempt.nonce })).status).toBe(409);
      expect((await patch(t, giver.cookie, { type: "give", seat: r.waiting.id, attempt: r.att, ephemeral: r.h.ephemeral })).status).toBe(409);
    });
    test("the waiting member takes back its own attempt", async () => {
      const t = await setup(), giver = await keyedOwner(t), member = await invite(t, giver.cookie);
      const r = await run(t, giver, member);
      expect((await patch(t, member, { type: "abandon", attempt: r.att })).status).toBe(200);
      expect((await view(t, member)).handoff).toBeNull();
      expect((await r.wrapNow()).status).toBe(409);
      expect((await view(t, member)).seatKey).toBeNull();
      const again = await run(t, giver, member);
      expect((await patch(t, member, { type: "abandon", seat: r.waiting.id, attempt: again.att })).status).toBe(200);
      expect((await view(t, member)).handoff).toBeNull();
    });
    test("a payload rewritten by the host is caught by the screens, not passed", async () => {
      const t = await setup(), giver = await keyedOwner(t), member = await invite(t, giver.cookie);
      const rewrite = (edit: (h: any) => void) => {
        const row = t.db.db.query("SELECT key, payload FROM trip_capsules").get() as { key: string; payload: string }, c = JSON.parse(row.payload);
        edit(c.sessions.find((s: any) => s.handoff).handoff); t.db.db.query("UPDATE trip_capsules SET payload = ? WHERE key = ?").run(JSON.stringify(c), row.key);
      };
      // The member's public key is swapped: the giver's check of the commitment fails.
      const a = await run(t, giver, member);
      const other = await seatPublic(await newSeatKeys());
      rewrite(h => { h.reveal.x25519 = other.x25519; });
      const swapped = (await view(t, giver.cookie)).waiting.find((w: any) => w.id === a.waiting.id).handoff.reveal;
      expect(await matchesCommitment(a.attempt.commitment, { x25519: swapped.x25519, ed25519: swapped.ed25519 }, swapped.nonce, t.created.id)).toBe(false);
      // The giver's throwaway key is swapped after the member kept the original: the two codes no longer agree.
      const t2 = await setup(), g2 = await keyedOwner(t2), m2 = await invite(t2, g2.cookie);
      const b = await run(t2, g2, m2);
      const row = t2.db.db.query("SELECT key, payload FROM trip_capsules").get() as { key: string; payload: string }, c = JSON.parse(row.payload);
      c.sessions.find((s: any) => s.handoff).handoff.giver.ephemeral = (await newHandoffKeys()).ephemeral;
      t2.db.db.query("UPDATE trip_capsules SET payload = ? WHERE key = ?").run(JSON.stringify(c), row.key);
      const shown = (await view(t2, g2.cookie)).waiting[0].handoff;
      const fromHost = await confirmationCodes({ capsuleId: t2.created.id, giver: { ephemeral: shown.giver.ephemeral, x25519: shown.giver.x25519, ed25519: shown.giver.ed25519 }, member: { ...b.memberPub, nonce: b.attempt.nonce } });
      expect(fromHost.member).not.toBe(b.mine.member); expect(fromHost.giver).not.toBe(b.mine.giver);
    });
    test("pending seat 403, revoked seat 401, an unknown seat or another capsule's seat 404, frozen lists the owner only", async () => {
      const t = await setup(), giver = await keyedOwner(t), pending = await invite(t, giver.cookie, { approval: "owner" });
      const att = (await newAttempt(await seatPublic(await newSeatKeys()), t.created.id)).commitment;
      expect((await put(t, pending, { type: "wait", commitment: att })).status).toBe(403);
      const member = await invite(t, giver.cookie);
      const h = await newHandoffKeys();
      const missing = await patch(t, giver.cookie, { type: "give", seat: "no-such-seat", attempt: "a".repeat(32), ephemeral: h.ephemeral });
      expect(missing.status).toBe(404);
      // A seat that exists, but in another capsule on the same host: its id is no seat of this trip.
      const other = await t.publish(), there = (p: string, method: string, body?: unknown, cookie?: string) => t.host.fetch(new Request(`${origin}/v1/c/${other.id}${p}`, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      const otherOwner = (await there("/sessions", "POST", { secret: new URLSearchParams(new URL(other.url).hash.slice(1)).get("k") })).headers.get("Set-Cookie")!.split(";")[0]!;
      const otherSeat = (await (await there("/grants", "GET", undefined, otherOwner)).json()).flatMap((g: any) => g.members).find((m: any) => m.self).id as string;
      expect((await patch(t, giver.cookie, { type: "give", seat: otherSeat, attempt: "a".repeat(32), ephemeral: h.ephemeral })).status).toBe(404);
      const listed = (await (await t.request("/grants", "GET", undefined, giver.cookie)).json()).flatMap((g: any) => g.members);
      const id = listed.find((m: any) => !m.self && !m.pending).id;
      expect((await t.request("/revoke", "POST", { member: id, confirm: true }, giver.cookie)).status).toBe(200);
      expect((await put(t, member, { type: "wait", commitment: att })).status).toBe(401);
      expect((await t.request("/freeze", "POST", { confirm: true }, giver.cookie)).status).toBe(200);
      const v = await view(t, giver.cookie);
      expect(v.waiting).toEqual([]);
    });
    test("the host takes only the form of the values and keeps no code", async () => {
      const t = await setup(), giver = await keyedOwner(t), member = await invite(t, giver.cookie);
      const good = await newAttempt(await seatPublic(await newSeatKeys()), t.created.id);
      for (const bad of [{ commitment: "short" }, { commitment: `${"A".repeat(42)}=` }, { type: "other" }, { extra: 1 }])
        expect((await put(t, member, { type: "wait", commitment: good.commitment, ...bad })).status).toBe(400);
      const w = await patch(t, member, { type: "wait", commitment: good.commitment });
      const att = w.body.handoff.attempt;
      expect((await put(t, giver.cookie, { type: "give", seat: (await view(t, giver.cookie)).waiting[0].id, attempt: att, ephemeral: "short" })).status).toBe(400);
      expect((await put(t, member, { type: "reveal", attempt: att, x25519: "x", ed25519: "y", nonce: "z" })).status).toBe(400);
      expect((await put(t, giver.cookie, { type: "wrap", seat: "s", attempt: att, wrapped: "plain" })).status).toBe(400);
      expect((await put(t, giver.cookie, { type: "edge", seat: "s", signature: "short" })).status).toBe(400);
      const text = await (await t.request("/grants", "GET", undefined, giver.cookie)).text();
      expect(text).not.toContain("handoff"); expect(text).not.toContain(good.commitment);
      expect(JSON.stringify(sessions(t))).not.toMatch(/"code":"\d{6}"/);
    });
  });
});
describe("passkeys", () => {
  const challenge = async (t: Awaited<ReturnType<typeof setup>>) => (await (await t.request("/passkey/challenge", "POST", {})).json()) as { challenge: string; rpId: string };
  test("passkey registration is optional, bound to the member, and its challenge is single-use", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), device = fakeAuthenticator();
    const invite = await (await t.request("/grants", "POST", { role: "participant", label: "p", seats: 2, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    // Without a passkey everything works as before.
    const plain = await t.login(invite.url), member = await t.login(invite.url);
    expect((await (await t.request("", "GET", undefined, plain)).json()).passkey).toBe(false);
    expect((await t.request("/document", "PATCH", { type: "check", id: "c3", done: true }, plain)).status).toBe(200);
    const first = await challenge(t); expect(first.rpId).toBe("trip.example"); expect(first.challenge.length).toBeGreaterThanOrEqual(32);
    // Registration needs the member's cookie (a request without one is refused before it can spend anything).
    expect((await t.request("/passkey", "POST", { challenge: first.challenge, ...device.register(first.challenge) })).status).toBe(401);
    const second = await challenge(t), registered = await t.request("/passkey", "POST", { challenge: second.challenge, ...device.register(second.challenge) }, member);
    expect(registered.status).toBe(200); expect(await registered.json()).toEqual({ ok: true });
    expect((await (await t.request("", "GET", undefined, member)).json()).passkey).toBe(true);
    expect((await (await t.request("", "GET", undefined, plain)).json()).passkey).toBe(false);
    // The challenge the registration used cannot be used again; a forged one is refused.
    expect((await t.request("/passkey", "POST", { challenge: second.challenge, ...device.register(second.challenge) }, member)).status).toBe(401);
    expect((await t.request("/passkey", "POST", { challenge: "x".repeat(72), ...device.register("x".repeat(72)) }, member)).status).toBe(401);
    // A ceremony for another site is refused, and the refusal writes nothing.
    const third = await challenge(t);
    const version = (t.db.db.query("SELECT version FROM trip_capsules").get() as { version: number }).version;
    expect((await t.request("/passkey", "POST", { challenge: third.challenge, ...fakeAuthenticator({ origin: "https://evil.example" }).register(third.challenge) }, plain)).status).toBe(400);
    expect((t.db.db.query("SELECT version FROM trip_capsules").get() as { version: number }).version).toBe(version);
    // One credential belongs to one member.
    const fourth = await challenge(t);
    expect((await t.request("/passkey", "POST", { challenge: fourth.challenge, ...device.register(fourth.challenge) }, plain)).status).toBe(400);
    // Registering again replaces the member's passkey, with a check by the one it replaces in the same request.
    const checked = await challenge(t), fifth = await challenge(t), replacement = fakeAuthenticator();
    expect((await t.request("/passkey", "POST", { challenge: fifth.challenge, ...replacement.register(fifth.challenge), check: { challenge: checked.challenge, id: device.id, ...device.assert(checked.challenge) } }, member)).status).toBe(200);
    // The public key never leaves the host; the owner sees only whether a member has one.
    const listed = await (await t.request("/grants", "GET", undefined, owner)).json(), text = JSON.stringify(listed) + JSON.stringify(await (await t.request("", "GET", undefined, member)).json());
    expect(listed.find((g: any) => g.id === invite.grantId).members.map((m: any) => m.passkey).sort()).toEqual([false, true]);
    // A seat's public key for the trip (#689) is an object or null, never the passkey's string.
    expect(text).not.toContain("\"publicKey\":\""); expect(text).not.toContain(replacement.register("z").publicKey);
    // Stored: the credential id and the public key. A challenge is only ever stored once it has been used.
    const stored = (t.db.db.query("SELECT payload FROM trip_capsules").get() as any).payload as string;
    expect(stored).toContain(replacement.id); expect(stored).not.toContain(device.id);
    for (const c of [first, second, fourth, fifth]) expect(stored).not.toContain(c.challenge);
  });
  test("a passkey returns the same member without consuming a seat; revocation closes it", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), device = fakeAuthenticator();
    const invite = await (await t.request("/grants", "POST", { role: "participant", label: "p", seats: 2, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const cookie = await t.login(invite.url), reg = await challenge(t);
    expect((await t.request("/passkey", "POST", { challenge: reg.challenge, ...device.register(reg.challenge) }, cookie)).status).toBe(200);
    const members = async () => (await (await t.request("/grants", "GET", undefined, owner)).json()).find((g: any) => g.id === invite.grantId);
    const before = await members();
    const back = async (d = device, c?: string) => { const ch = c ?? (await challenge(t)).challenge; return t.request("/passkey/session", "POST", { challenge: ch, id: d.id, ...d.assert(ch) }); };
    // The browser lost its cookie: the passkey brings back the same member, role and seat.
    device.setCounter(1);
    const returned = await back(); expect(returned.status).toBe(200); expect(await returned.json()).toEqual({ role: "participant" });
    const fresh = returned.headers.get("Set-Cookie")!; expect(fresh).toContain("HttpOnly; Secure; SameSite=Strict");
    const next = fresh.split(";")[0]!, after = await members();
    expect(after.claimed).toBe(before.claimed); expect(after.members.map((m: any) => m.id)).toEqual(before.members.map((m: any) => m.id));
    expect((await t.request("/document", "PATCH", { type: "check", id: "c3", done: true }, next)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "notes", body: "x" }, next, 2)).status).toBe(403);
    now += 61000; // the login rate limit is 15 a minute
    // One member is one browser: the cookie it replaced no longer works.
    expect((await t.request("", "GET", undefined, cookie)).status).toBe(401);
    // A challenge cannot be replayed even by a device whose counter has moved on, and the counter must advance.
    const replay = (await challenge(t)).challenge; device.setCounter(2);
    expect((await back(device, replay)).status).toBe(200);
    device.setCounter(3); expect((await back(device, replay)).status).toBe(401);
    expect((await back()).status).toBe(200);
    device.setCounter(3); expect((await back()).status).toBe(401);
    // A refused attempt leaves the capsule untouched.
    const version = () => (t.db.db.query("SELECT version FROM trip_capsules").get() as { version: number }).version;
    const untouched = version(); device.setCounter(3);
    expect((await back()).status).toBe(401); expect(version()).toBe(untouched);
    device.setCounter(4);
    now += 61000; // the login rate limit is 15 a minute
    // Someone else's credential, or an unknown one, gets the same answer as a revoked member.
    const stranger = fakeAuthenticator(); expect((await back(stranger)).status).toBe(401);
    // A credential is looked up inside its own capsule: the other capsule's own challenge does not find it either.
    const other = await t.publish();
    const post = (path: string, body: unknown) => t.host.fetch(new Request(`${origin}/v1/c/${other.id}/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const elsewhere = await (await post("passkey/challenge", {})).json() as { challenge: string };
    expect((await post("passkey/session", { challenge: elsewhere.challenge, id: device.id, ...device.assert(elsewhere.challenge) })).status).toBe(401);
    // …and this capsule's challenge is not valid over there.
    const mineHere = (await challenge(t)).challenge;
    expect((await post("passkey/session", { challenge: mineHere, id: device.id, ...device.assert(mineHere) })).status).toBe(401);
    // Nothing secret is stored or returned.
    const stored = (t.db.db.query("SELECT payload FROM trip_capsules WHERE payload LIKE ?").get(`%${device.id}%`) as any).payload as string;
    expect(stored).not.toContain(next.split("=")[1]!); expect(JSON.parse(stored).audit.map((a: any) => a.event)).toContain("passkey/session");
    now += 61000; // the login rate limit is 15 a minute
    // Revoking the member closes the passkey too; so does revoking the invite, and a purge.
    device.setCounter(10); const current = (await back()).headers.get("Set-Cookie")!.split(";")[0]!;
    const self = (await members()).members.find((m: any) => m.passkey);
    expect((await t.request("/revoke", "POST", { member: self.id, confirm: true }, owner)).status).toBe(200);
    device.setCounter(11); const refused = await back(); expect(refused.status).toBe(401); expect((await refused.json()).error).toBe("この端末の登録は失効したか、期限が切れました");
    expect((await t.request("", "GET", undefined, current)).status).toBe(401);
    now += 61000; // the login rate limit is 15 a minute
    const second = fakeAuthenticator(), seat = await t.login(invite.url), again = await challenge(t);
    expect((await t.request("/passkey", "POST", { challenge: again.challenge, ...second.register(again.challenge) }, seat)).status).toBe(200);
    expect((await t.request("/revoke", "POST", { id: invite.grantId, confirm: true }, owner)).status).toBe(200);
    second.setCounter(1); expect((await back(second)).status).toBe(401);
    const mine = fakeAuthenticator(), oc = await challenge(t), ov = await challenge(t), held = devices.get(owner)!;
    expect((await t.request("/passkey", "POST", { challenge: oc.challenge, ...mine.register(oc.challenge), check: { challenge: ov.challenge, id: held.id, ...held.assert(ov.challenge) } }, owner)).status).toBe(200);
    const last = (await challenge(t)).challenge;
    expect((await t.request("/purge", "POST", { title: t.seed.spec.title }, owner)).status).toBe(200);
    mine.setCounter(1); expect((await back(mine, last)).status).toBe(410);
  });
  test("handing out challenges writes nothing; a challenge expires; the capsule is unchanged throughout", async () => {    const t = await setup(), owner = await t.login(t.created.url), device = fakeAuthenticator();
    const row = () => t.db.db.query("SELECT version, payload FROM trip_capsules").get() as { version: number; payload: string };
    const before = row(), early = await challenge(t);
    // Anyone holding the capsule id can ask; it must cost the capsule nothing (no write, no audit entry, no version bump).
    for (let i = 0; i < 25; i++) { if (i % 10 === 9) now += 60000; await challenge(t); }
    expect(row()).toEqual(before);
    expect(JSON.parse(before.payload).audit.map((a: { event: string }) => a.event)).not.toContain("passkey/challenge");
    now += 5 * 60000 + 1;
    expect((await t.request("/passkey", "POST", { challenge: early.challenge, ...device.register(early.challenge) }, owner)).status).toBe(401);
    expect(row().version).toBe(before.version);
    // A capsule published before passkeys existed has no stored field of its own and keeps working.
    expect(JSON.parse(before.payload).spent).toBeUndefined();
    expect((await t.request("", "GET", undefined, owner)).status).toBe(200);
  });

  test("a refused registration leaves the challenge usable for the next attempt", async () => {
    const t = await setup(), owner = await t.login(t.created.url), device = fakeAuthenticator();
    const { challenge: once } = await challenge(t);
    expect((await t.request("/passkey", "POST", { challenge: once, ...fakeAuthenticator({ origin: "https://evil.example" }).register(once) }, owner)).status).toBe(400);
    expect((await (await t.request("", "GET", undefined, owner)).json()).passkey).toBe(false);
    expect((await t.request("/passkey", "POST", { challenge: once, ...device.register(once) }, owner)).status).toBe(200);
    // Once it has been used, it is refused for good.
    expect((await t.request("/passkey", "POST", { challenge: once, ...device.register(once) }, owner)).status).toBe(401);
  });

  test("a used challenge stays used until it expires, however many ceremonies follow", async () => {
    const t = await setup(), owner = await t.login(t.created.url), device = fakeAuthenticator();
    // Each request comes from its own address so the per-address limit does not hide the point.
    const from = (ip: string) => (path: string, body: unknown) => t.host.fetch(new Request(`${origin}/v1/c/${t.created.id}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "cf-connecting-ip": ip, Cookie: owner }, body: JSON.stringify(body) }));
    const first = await (await from("10.0.0.1")("/passkey/challenge", {})).json() as { challenge: string };
    expect((await from("10.0.0.1")("/passkey", { challenge: first.challenge, ...device.register(first.challenge) })).status).toBe(200);
    for (let i = 0; i < 60; i++) {
      const post = from(`10.0.1.${i}`), next = await (await post("/passkey/challenge", {})).json() as { challenge: string };
      expect((await post("/passkey/verify", { challenge: next.challenge, id: device.id, ...device.assert(next.challenge) })).status).toBe(200);
    }
    const stored = JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload);
    expect(stored.spent.length).toBe(61);
    // The very first challenge is still inside its five minutes, and still refused.
    expect((await from("10.0.0.1")("/passkey/verify", { challenge: first.challenge, id: device.id, ...device.assert(first.challenge) })).status).toBe(401);
    // It becomes usable again for nobody: once it expires it is simply invalid.
    now += 5 * 60000 + 1;
    expect((await from("10.0.0.1")("/passkey/verify", { challenge: first.challenge, id: device.id, ...device.assert(first.challenge) })).status).toBe(401);
    expect(JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload).spent.length).toBe(61);
  });

  test("a capsule saturated with ceremonies refuses more rather than forgetting one", async () => {
    const t = await setup(), owner = await t.login(t.created.url), device = fakeAuthenticator();
    const from = (ip: string) => (path: string, body: unknown) => t.host.fetch(new Request(`${origin}/v1/c/${t.created.id}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "cf-connecting-ip": ip, Cookie: owner }, body: JSON.stringify(body) }));
    const ceremony = async (ip: string) => { const post = from(ip), next = await (await post("/passkey/challenge", {})).json() as { challenge: string }; return (await post("/passkey/verify", { challenge: next.challenge, id: device.id, ...device.assert(next.challenge) })).status; };
    const first = await (await from("10.1.1.1")("/passkey/challenge", {})).json() as { challenge: string };
    expect((await from("10.1.1.1")("/passkey", { challenge: first.challenge, ...device.register(first.challenge) })).status).toBe(200);
    let last = 0;
    for (let i = 0; i < 100; i++) last = await ceremony(`10.1.0.${i}`);
    expect(last).toBe(429);
    // Refused because the capsule is saturated, not because a request was rate limited: the list stopped at the cap.
    expect(JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload).spent.length).toBe(100);
    // The window passes and the capsule accepts ceremonies again.
    now += 5 * 60000 + 1;
    expect(await ceremony("10.2.0.1")).toBe(200);
  });

  test("the unauthenticated endpoints share the login rate limit", async () => {
    const t = await setup();
    const device = fakeAuthenticator(), ceremony = (c: string) => ({ challenge: c, id: device.id, ...device.assert(c) });
    let last = 0;
    for (let i = 0; i < 16; i++) last = (await t.request("/passkey/challenge", "POST", {})).status;
    expect(last).toBe(429);
    now += 61000;
    const { challenge: fresh } = await challenge(t);
    // Returning by passkey draws on the same bucket as redeeming an invite does.
    for (let i = 0; i < 14; i++) last = (await t.request("/passkey/session", "POST", ceremony(fresh))).status;
    expect(last).toBe(401);
    expect((await t.request("/passkey/session", "POST", ceremony(fresh))).status).toBe(429);
    expect((await t.request("/sessions", "POST", { secret: "x".repeat(40) })).status).toBe(429);
  });
});
describe("step-up", () => {
  const window = 5 * 60000;
  const challenge = async (t: Awaited<ReturnType<typeof setup>>) => ((await (await t.request("/passkey/challenge", "POST", {})).json()) as { challenge: string }).challenge;
  const register = async (t: Awaited<ReturnType<typeof setup>>, cookie: string, device = fakeAuthenticator()) => { const c = await challenge(t); expect((await t.request("/passkey", "POST", { challenge: c, ...device.register(c) }, cookie)).status).toBe(200); return device; };
  const check = (t: Awaited<ReturnType<typeof setup>>, cookie: string, device: ReturnType<typeof fakeAuthenticator>, c: string) => t.request("/passkey/verify", "POST", { challenge: c, id: device.id, ...device.assert(c) }, cookie);
  test("important owner actions refuse a cookie alone and accept one after a passkey check", async () => {
    const t = await setup(), owner = await t.login(t.created.url), device = await register(t, owner);
    now += window;
    const invite = { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, spec = { ...t.seed.spec, summary: "書き換えた説明" };
    const actions = [["/grants", "POST", invite], ["/revoke", "POST", { id: "x", confirm: true }], ["/spec", "PATCH", { spec, confirm: true }], ["/freeze", "POST", { confirm: true }], ["/purge", "POST", { title: t.seed.spec.title }]] as const;
    for (const [path, method, body] of actions) {
      const refused = await t.request(path, method, body, owner);
      expect(refused.status).toBe(428); expect((await refused.json()).error).toBe("パスキーで本人確認してください");
    }
    // Reading and editing the plan stay on the cookie alone.
    expect((await t.request("", "GET", undefined, owner)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "check", id: "c3", done: true }, owner)).status).toBe(200);
    expect((await check(t, owner, device, await challenge(t))).status).toBe(200);
    const issued = await t.request("/grants", "POST", invite, owner); expect(issued.status).toBe(201);
    expect((await t.request("/revoke", "POST", { id: (await issued.json()).grantId, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/spec", "PATCH", { spec, confirm: true }, owner, 2)).status).toBe(200);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, 3)).status).toBe(200);
    expect((await t.request("/purge", "POST", { title: t.seed.spec.title }, owner)).status).toBe(200);
  });
  test("a passkey check lasts five minutes, for that session and that capsule only", async () => {
    const t = await setup(), owner = await t.login(t.created.url), device = await register(t, owner);
    const issue = (cookie: string, role = "viewer") => t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, cookie);
    // The first registration was the check; it holds until five minutes have passed, and not a moment longer.
    now += window - 1; const second = await issue(owner, "owner"); expect(second.status).toBe(201);
    now += 1; expect((await issue(owner)).status).toBe(428);
    const used = await challenge(t); expect((await check(t, owner, device, used)).status).toBe(200);
    expect((await issue(owner)).status).toBe(201);
    // Another owner's session is not checked by this one's passkey check.
    const other = await t.login((await second.json()).url); expect((await issue(other)).status).toBe(428);
    now += 61000; // the login rate limit is 15 a minute
    // A used challenge, one from another capsule, an expired one, and another member's passkey or an unknown one are all refused alike.
    device.setCounter(1); expect((await check(t, other, device, await challenge(t))).status).toBe(401);
    expect((await check(t, owner, device, used)).status).toBe(401);
    const elsewhere = await t.publish(), foreign = ((await (await t.host.fetch(new Request(`${origin}/v1/c/${elsewhere.id}/passkey/challenge`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" }))).json()) as { challenge: string }).challenge;
    expect((await check(t, owner, device, foreign)).status).toBe(401);
    const early = await challenge(t);
    expect((await check(t, owner, fakeAuthenticator(), await challenge(t))).status).toBe(401);
    const theirs = await register(t, other); expect((await check(t, owner, theirs, await challenge(t))).status).toBe(401);
    now += window + 1; expect((await check(t, owner, device, early)).status).toBe(401);
    // A refusal writes nothing and does not count as a check.
    const version = (t.db.db.query("SELECT version FROM trip_capsules WHERE payload LIKE ?").get(`%${device.id}%`) as { version: number }).version;
    const refused = await check(t, owner, fakeAuthenticator(), await challenge(t)); expect((await refused.json()).error).toBe("本人確認できませんでした");
    expect((t.db.db.query("SELECT version FROM trip_capsules WHERE payload LIKE ?").get(`%${device.id}%`) as { version: number }).version).toBe(version);
    expect((await issue(owner)).status).toBe(428);
  });
  test("a passkey check is a real assertion by this seat's passkey, and draws on the login rate limit", async () => {
    const t = await setup(), owner = await t.login(t.created.url), device = await register(t, owner), stranger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    now += window;
    // Signed by another key, for another site or relying party, without user verification, or as a registration: all refused.
    for (const o of [{ key: stranger }, { origin: "https://evil.example" }, { rpId: "evil.example" }, { flags: 0x01 }, { type: "webauthn.create" }]) {
      const c = await challenge(t); expect((await t.request("/passkey/verify", "POST", { challenge: c, id: device.id, ...device.assert(c, o) }, owner)).status).toBe(401);
    }
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(428);
    // An authenticator that counts must move forward.
    device.setCounter(5); expect((await check(t, owner, device, await challenge(t))).status).toBe(200);
    now += 61000; // the login rate limit is 15 a minute
    expect((await check(t, owner, device, await challenge(t))).status).toBe(401);
    now += 61000;
    const junk = { challenge: "x", id: "x", clientDataJSON: "x", authenticatorData: "x", signature: "x" };
    for (let i = 0; i < 15; i++) expect((await t.request("/passkey/verify", "POST", junk, owner)).status).toBe(401);
    expect((await t.request("/passkey/verify", "POST", junk, owner)).status).toBe(429);
  });
  test("an owner without a passkey is asked to register, and the first registration counts as the check", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(428);
    await register(t, owner);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(200);
  });
  test("a revise or undo that keeps the deadline needs no check; one that moves it does", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    const answer = (edit: (trip: ReturnType<typeof revisable>) => void) => { const trip = structuredClone(revisable(t.seed.spec, t.seed.document)); edit(trip); return `\`\`\`json\n${JSON.stringify(trip)}\n\`\`\``; };
    const later = answer(trip => { trip.document.items[1]!.startsAt = "2026-09-25T18:30:00+09:00"; }), moved = answer(trip => { trip.spec.lifecycle.purgeAt = "2026-11-20T00:00:00+09:00"; });
    expect((await t.request("/revise", "POST", { text: later, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 2)).status).toBe(200);
    expect((await t.request("/revise", "POST", { text: moved, confirm: true }, owner, 3)).status).toBe(428);
    const device = await register(t, owner);
    expect((await t.request("/revise", "POST", { text: moved, confirm: true }, owner, 3)).status).toBe(200);
    now += window;
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 4)).status).toBe(428);
    expect((await check(t, owner, device, await challenge(t))).status).toBe(200);
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 4)).status).toBe(200);
  });
  test("replacing a member's passkey needs a check by the current one in the same request, and it is used once", async () => {
    const t = await setup(), owner = await t.login(t.created.url), device = await register(t, owner), replacement = fakeAuthenticator(), stranger = fakeAuthenticator();
    const body = async (checker?: ReturnType<typeof fakeAuthenticator>, c?: string) => { const r = await challenge(t), k = c ?? await challenge(t); return { challenge: r, ...replacement.register(r), ...(checker ? { check: { challenge: k, id: checker.id, ...checker.assert(k) } } : {}) }; };
    const replace = (b: unknown) => t.request("/passkey", "POST", b, owner);
    const back = async (d: ReturnType<typeof fakeAuthenticator>) => { const c = await challenge(t); return t.request("/passkey/session", "POST", { challenge: c, id: d.id, ...d.assert(c) }); };
    const refusedAs = async (r: Response) => { expect(r.status).toBe(401); expect((await r.json()).error).toBe("パスキーで本人確認してください"); };
    // The registration just now made this session's check (five minutes): it does not replace, nor does a check by another passkey.
    await refusedAs(await replace(await body()));
    await refusedAs(await replace(await body(stranger)));
    // A check made for another action within five minutes does not either.
    expect((await check(t, owner, device, await challenge(t))).status).toBe(200);
    await refusedAs(await replace(await body()));
    // A check whose challenge expired, or is the registration's own, is refused.
    const early = await challenge(t); now += window + 1; await refusedAs(await replace(await body(device, early)));
    const same = await challenge(t); await refusedAs(await replace({ challenge: same, ...replacement.register(same), check: { challenge: same, id: device.id, ...device.assert(same) } }));
    // The check must be a real assertion by the current passkey: another key's signature, no user verification, a registration's
    // ceremony, or a counter that does not move are refused, though the id and the challenge are right.
    const forged = async (o: Parameters<typeof device.assert>[1]) => { const r = await challenge(t), k = await challenge(t); return replace({ challenge: r, ...replacement.register(r), check: { challenge: k, id: device.id, ...device.assert(k, o) } }); };
    now += 61000; // the login rate limit is 15 a minute
    for (const o of [{ key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey }, { flags: 0x01 }, { type: "webauthn.create" }]) await refusedAs(await forged(o));
    device.setCounter(3); expect((await check(t, owner, device, await challenge(t))).status).toBe(200);
    now += 61000; await refusedAs(await forged({}));
    now += 61000; // the login rate limit is 15 a minute
    device.setCounter(4); const ok = await body(device); expect((await replace(ok)).status).toBe(200);
    // The same request sent again is refused: its check is used.
    expect((await replace(ok)).status).toBe(401);
    // The old passkey no longer opens the seat; the new one does.
    expect((await back(device)).status).toBe(401); expect((await back(replacement)).status).toBe(200);
  });
  test("a stolen member cookie cannot swap in its own passkey", async () => {
    const t = await setup(), owner = await t.login(t.created.url), mine = await register(t, owner), thief = fakeAuthenticator();
    // The same cookie, sent from another address and another browser, while the member's own check is still fresh.
    const stolen = (path: string, body: unknown) => t.host.fetch(new Request(`${origin}/v1/c/${t.created.id}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: owner, "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(body) }));
    const c = await challenge(t), k = await challenge(t);
    expect((await stolen("/passkey", { challenge: c, ...thief.register(c) })).status).toBe(401);
    expect((await stolen("/passkey", { challenge: c, ...thief.register(c), check: { challenge: k, id: thief.id, ...thief.assert(k) } })).status).toBe(401);
    // The member's own passkey still opens the seat; the thief's does not.
    const e = await challenge(t); expect((await t.request("/passkey/session", "POST", { challenge: e, id: thief.id, ...thief.assert(e) })).status).toBe(401);
    const f = await challenge(t); expect((await t.request("/passkey/session", "POST", { challenge: f, id: mine.id, ...mine.assert(f) })).status).toBe(200);
  });
});

describe("signing out and idle sessions", () => {
  const day = 86400000, idle = 30 * day;
  const challenge = async (t: Awaited<ReturnType<typeof setup>>) => ((await (await t.request("/passkey/challenge", "POST", {})).json()) as { challenge: string }).challenge;
  const register = async (t: Awaited<ReturnType<typeof setup>>, cookie: string, device = fakeAuthenticator()) => { const c = await challenge(t); expect((await t.request("/passkey", "POST", { challenge: c, ...device.register(c) }, cookie)).status).toBe(200); return device; };
  const back = async (t: Awaited<ReturnType<typeof setup>>, device: ReturnType<typeof fakeAuthenticator>) => { const c = await challenge(t); return t.request("/passkey/session", "POST", { challenge: c, id: device.id, ...device.assert(c) }); };
  const version = (t: Awaited<ReturnType<typeof setup>>) => (t.db.db.query("SELECT version FROM trip_capsules").get() as { version: number }).version;
  const stored = (t: Awaited<ReturnType<typeof setup>>) => JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").get() as { payload: string }).payload);
  // Each call is a fresh one-seat invite from the owner, who checks with their passkey when the last check is over five minutes old.
  const owners = new WeakMap<object, string>();
  const invite = async (t: Awaited<ReturnType<typeof setup>>) => {
    const owner = await stepUp(t.request, owners.get(t) ?? await t.login(t.created.url)); owners.set(t, owner);
    return (await (await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()) as { url: string; grantId: string };
  };
  test("a member who signs out cannot come back with a copy of the cookie, but can with their passkey", async () => {
    const t = await setup(), member = await t.login((await invite(t)).url), device = await register(t, member);
    expect((await t.request("/signout", "POST", { confirm: true })).status).toBe(401);
    expect((await t.request("/signout", "POST", {}, member)).status).toBe(400);
    const out = await t.request("/signout", "POST", { confirm: true }, member);
    expect(out.status).toBe(200); expect(out.headers.get("Set-Cookie")).toStartWith(`capsule_${t.created.id}=; `); expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    // A copy of the cookie kept from before is refused everywhere, and signing out again with it is refused too.
    expect((await t.request("", "GET", undefined, member)).status).toBe(401);
    expect((await t.request("/document", "PATCH", { type: "check", id: "c3", done: true }, member)).status).toBe(401);
    expect((await t.request("/signout", "POST", { confirm: true }, member)).status).toBe(401);
    // The seat and its passkey stay: the member's passkey brings them back.
    device.setCounter(1); const returned = await back(t, device); expect(returned.status).toBe(200);
    expect((await t.request("", "GET", undefined, returned.headers.get("Set-Cookie")!.split(";")[0]!)).status).toBe(200);
    expect((await t.request("", "GET", undefined, member)).status).toBe(401);
  });
  test("a member without a passkey who signs out needs a new invite", async () => {
    const t = await setup(), link = await invite(t), member = await t.login(link.url);
    expect((await t.request("/signout", "POST", { confirm: true }, member)).status).toBe(200);
    expect((await t.request("", "GET", undefined, member)).status).toBe(401);
    // The one seat of the link was taken, and re-opening the link with the old cookie is not the same browser any more.
    expect((await t.request("/sessions", "POST", { secret: new URL(link.url).hash.slice(3) }, member)).status).toBe(401);
    const again = await t.login((await invite(t)).url); expect((await t.request("", "GET", undefined, again)).status).toBe(200);
  });
  test("a session unused for 30 days is refused; one used daily lasts until its invite expires", async () => {
    const t = await setup(), link = await invite(t), started = now, idleOne = await t.login(link.url), device = await register(t, idleOne);
    const daily = await t.login((await invite(t)).url);
    // A second read within a day stores nothing, and a read is never an audit event.
    const unchanged = version(t); now += day - 1;
    expect((await t.request("", "GET", undefined, daily)).status).toBe(200); expect(version(t)).toBe(unchanged);
    now = started + 29 * day;
    expect((await t.request("", "GET", undefined, daily)).status).toBe(200); expect(version(t)).toBe(unchanged + 1);
    expect((await t.request("", "GET", undefined, daily)).status).toBe(200); expect(version(t)).toBe(unchanged + 1);
    expect(stored(t).audit.map((a: { event: string }) => a.event)).not.toContain("");
    // Thirty days to the millisecond after it was last used, the other seat's cookie is refused, and so is re-opening its link.
    now = started + idle;
    const refused = await t.request("", "GET", undefined, idleOne); expect(refused.status).toBe(401); expect((await refused.json()).error).toBe("この端末の登録は失効したか、期限が切れました");
    expect((await t.request("/sessions", "POST", { secret: new URL(link.url).hash.slice(3) }, idleOne)).status).toBe(401);
    // Its passkey still brings it back.
    device.setCounter(1); const returned = await back(t, device); expect(returned.status).toBe(200);
    expect((await t.request("", "GET", undefined, returned.headers.get("Set-Cookie")!.split(";")[0]!)).status).toBe(200);
    // The one read every 29 days lasts until the invite itself ends.
    const expires = +new Date(t.seed.spec.lifecycle.purgeAt);
    now = started + 29 * day + (expires - (started + 29 * day)) - 1; expect(now - (started + 29 * day)).toBeLessThan(idle);
    expect((await t.request("", "GET", undefined, daily)).status).toBe(200);
    now = expires; expect((await t.request("", "GET", undefined, daily)).status).toBe(410);
  });
  test("a revoked seat's 401 says the seat is gone; an idle cookie's does not", async () => {
    const text = "この端末の登録は失効したか、期限が切れました";
    const refusal = async (t: Awaited<ReturnType<typeof setup>>, cookie: string) => { const r = await t.request("", "GET", undefined, cookie); return [r.status, await r.json()]; };
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)); owners.set(t, owner);
    const self = async (cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()).self.id as string;
    // The owner revokes a member, rotates an invite, revokes an invite: each seat's cookie is told its seat is gone.
    const revoked = await t.login((await invite(t)).url);
    expect((await t.request("/revoke", "POST", { member: await self(revoked), confirm: true }, owner)).status).toBe(200);
    const rotatedLink = await invite(t), rotated = await t.login(rotatedLink.url);
    expect((await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, rotate: rotatedLink.grantId }, owner)).status).toBe(201);
    const cutLink = await invite(t), cut = await t.login(cutLink.url);
    expect((await t.request("/revoke", "POST", { id: cutLink.grantId, confirm: true }, owner)).status).toBe(200);
    for (const cookie of [revoked, rotated, cut]) expect(await refusal(t, cookie)).toEqual([401, { error: text, seat: "gone" }]);
    // A member whose passkey brought the seat back in another browser (however many times), and a kept copy of a signed-out
    // cookie: the seat is still there, so the answer is the one an idle cookie gets. (A minute apart, for the limit on sign-ins.)
    now += 60000; const moved = await t.login((await invite(t)).url), device = await register(t, moved);
    for (let i = 1; i <= 6; i++) { now += 60000; device.setCounter(i); expect((await back(t, device)).status).toBe(200); }
    const left = await t.login((await invite(t)).url); expect((await t.request("/signout", "POST", { confirm: true }, left)).status).toBe(200);
    for (const cookie of [moved, left]) expect(await refusal(t, cookie)).toEqual([401, { error: text }]);
    // A seat taken away before the host kept the gone seats' cookies is not known to be gone: its browser keeps its keys.
    now += 60000; const earlier = await t.login((await invite(t)).url), seat = await self(earlier);
    const row = t.db.db.query("SELECT key, payload FROM trip_capsules").get() as { key: string; payload: string }, c = JSON.parse(row.payload);
    c.sessions = c.sessions.filter((s: { id: string }) => s.id !== seat); t.db.db.query("UPDATE trip_capsules SET payload = ? WHERE key = ?").run(JSON.stringify(c), row.key);
    expect(await refusal(t, earlier)).toEqual([401, { error: text }]);
    // An invite that ended takes its seat with it.
    now += 60000; const short = await t.login((await (await t.request("/grants", "POST", { role: "participant", label: "p", expiresAt: new Date(now + 2 * day).toISOString(), confirm: true }, await stepUp(t.request, owner))).json()).url);
    now += 3 * day; expect(await refusal(t, short)).toEqual([401, { error: text, seat: "gone" }]);
    // Sharing ended: every seat but the owner's is gone.
    const frozen = await t.login((await invite(t)).url);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(200);
    expect(await refusal(t, frozen)).toEqual([401, { error: text, seat: "gone" }]);
    // Thirty days unused: the owner's seat is still there, and its passkey brings it back.
    now += idle; expect(await refusal(t, owner)).toEqual([401, { error: text }]);
  });
  test("the record of gone seats keeps the newest 1000", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)); owners.set(t, owner);
    const first = await t.login((await invite(t)).url), second = await t.login((await invite(t)).url);
    const self = async (cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()).self.id as string;
    expect((await t.request("/revoke", "POST", { member: await self(first), confirm: true }, owner)).status).toBe(200);
    // 999 more seats gone since, then one more: the first falls off the end, and its browser is answered as an idle cookie is.
    const row = t.db.db.query("SELECT key, payload FROM trip_capsules").get() as { key: string; payload: string }, c = JSON.parse(row.payload);
    c.left = [...c.left, ...Array.from({ length: 999 }, (_, i) => String(i).padStart(64, "0"))]; t.db.db.query("UPDATE trip_capsules SET payload = ? WHERE key = ?").run(JSON.stringify(c), row.key);
    expect((await t.request("/revoke", "POST", { member: await self(second), confirm: true }, owner)).status).toBe(200);
    expect(stored(t).left).toHaveLength(1000);
    expect((await (await t.request("", "GET", undefined, first)).json()).seat).toBeUndefined();
    expect((await (await t.request("", "GET", undefined, second)).json()).seat).toBe("gone");
  });
  test("a session stored before idle expiry keeps working", async () => {
    const t = await setup(), member = await t.login((await invite(t)).url);
    // A capsule stored before `seen` existed: its sessions carry none, and this one was made 40 days ago.
    const row = (await t.host.store.get(t.host.digest(t.created.id)))!, c = JSON.parse(row.payload!);
    for (const s of c.sessions) { delete s.seen; s.created = s.lastUsed = now - 40 * day; }
    expect(await t.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
    now += day;
    expect((await t.request("", "GET", undefined, member)).status).toBe(200);
    // The read writes `seen` on this member's session alone; the owner's, not read, still has none.
    expect(stored(t).sessions.map((s: { seen?: number }) => s.seen)).toEqual([undefined, now]);
    now += idle; expect((await t.request("", "GET", undefined, member)).status).toBe(401);
  });
});

describe("creators", () => {
  // A creator is a Host-wide person who may publish new trips. The IAM publisher enrolls one; a passkey is required.
  function creatorHost() {
    const db = new LocalD1(); dbs.push(db);
    const box = { identity: null as string | null };
    const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin }, () => now, async () => box.identity);
    const post = (action: string, body: unknown, cookie?: string) => host.fetch(new Request(`${origin}/v1/creators/${action}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Version/19.0 Mobile/15E148 Safari/604.1", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }));
    const asPublisher = async <T>(f: () => Promise<T>) => { box.identity = "aws-publisher"; try { return await f(); } finally { box.identity = null; } };
    const enroll = async (label = "作成者A") => { const r = await asPublisher(() => post("enroll", { label, confirm: true })); expect(r.status).toBe(201); return new URL((await r.json()).url).hash.slice("#creator=".length); };
    const challenge = async () => (await (await post("challenge", {})).json()).challenge as string;
    const register = async (secret: string, device = fakeAuthenticator(), cookie?: string) => { const c = await challenge(); return post("register", { secret, challenge: c, ...device.register(c) }, cookie); };
    const signIn = async (device: ReturnType<typeof fakeAuthenticator>) => { const c = await challenge(); return post("session", { challenge: c, id: device.id, ...device.assert(c) }); };
    // A signed-in creator asks for a link for another device of theirs, confirming with a passkey of theirs in the same request.
    const addDevice = async (cookie: string, device: ReturnType<typeof fakeAuthenticator>) => { const c = await challenge(); return post("enroll", { confirm: true, challenge: c, id: device.id, ...device.assert(c) }, cookie); };
    const cookieOf = (r: Response) => r.headers.get("Set-Cookie")!.split(";")[0]!;
    const list = async () => (await asPublisher(() => post("list", {}))).json() as Promise<any[]>;
    const row = () => db.db.query("SELECT payload, version FROM trip_capsules").get() as { payload: string; version: number } | null;
    return { host, db, box, post, asPublisher, enroll, challenge, register, signIn, addDevice, cookieOf, list, row };
  }

  test("an enrollment link and a passkey make a creator, who can then sign in", async () => {
    const t = creatorHost(), device = fakeAuthenticator();
    const issued = await t.asPublisher(() => t.post("enroll", { label: "作成者A", confirm: true }));
    const body = await issued.json();
    expect(body.url).toStartWith(`${origin}/#creator=`); expect(body.expires).toBe(now + 86400000);
    const registered = await t.register(new URL(body.url).hash.slice(9), device);
    expect(registered.status).toBe(201); expect(await registered.json()).toEqual({ label: "作成者A" });
    const cookie = registered.headers.get("Set-Cookie")!;
    expect(cookie).toStartWith("capsule_creator="); expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=43200");
    device.setCounter(1);
    const signedIn = await t.signIn(device); expect(signedIn.status).toBe(200); expect(await signedIn.json()).toEqual({ label: "作成者A" });
    const listed = await t.list();
    expect(listed).toEqual([{ id: expect.any(String), label: "作成者A", created: now, lastUsed: now, revoked: null, passkeys: [{ id: device.id, device: "iPhone · Safari", created: now, revoked: null }] }]);
    // Neither the link's secret nor the public key leaves the host or is stored.
    const text = JSON.stringify(listed) + t.row()!.payload;
    expect(text).not.toContain(new URL(body.url).hash.slice(9)); expect(JSON.stringify(listed)).not.toContain(device.register("z").publicKey);
  });

  test("a browser that cannot make a passkey creates no creator and does not spend the link", async () => {
    const t = creatorHost(), secret = await t.enroll(), before = t.row();
    const c = await t.challenge();
    // No passkey at all, a ceremony without user verification, and one made for another site.
    expect((await t.post("register", { secret, challenge: c })).status).toBe(400);
    expect((await t.post("register", { secret, challenge: c, ...fakeAuthenticator().register(c, { flags: 0x41 }) })).status).toBe(400);
    expect((await t.post("register", { secret, challenge: c, ...fakeAuthenticator({ origin: "https://evil.example" }).register(c) })).status).toBe(400);
    expect(t.row()).toEqual(before); expect(await t.list()).toEqual([]);
    // The same link still works once a passkey can be made, and only once.
    expect((await t.register(secret)).status).toBe(201);
    expect((await t.register(secret)).status).toBe(401);
    expect((await t.register("x".repeat(43))).status).toBe(401);
    expect(await t.list()).toHaveLength(1);
  });

  test("a creator adds a second device; losing one passkey leaves the other", async () => {
    const t = creatorHost(), phone = fakeAuthenticator(), tablet = fakeAuthenticator();
    const cookie = t.cookieOf(await t.register(await t.enroll(), phone));
    // Only a signed-in creator may ask for a link for themself, and not for a new creator.
    expect((await t.post("enroll", { confirm: true })).status).toBe(401);
    const c = await t.challenge(); expect((await t.post("enroll", { label: "別人", confirm: true, challenge: c, id: phone.id, ...phone.assert(c) }, cookie)).status).toBe(400);
    const more = await t.addDevice(cookie, phone); expect(more.status).toBe(201);
    expect((await t.register(new URL((await more.json()).url).hash.slice(9), tablet)).status).toBe(201);
    const [creator] = await t.list(); expect(creator.passkeys.map((p: any) => p.id)).toEqual([phone.id, tablet.id]);
    phone.setCounter(1); tablet.setCounter(1);
    expect((await t.signIn(phone)).status).toBe(200); expect((await t.signIn(tablet)).status).toBe(200);
    // Revoking the phone's passkey closes its sign-in and its cookie; the tablet goes on.
    expect((await t.asPublisher(() => t.post("revoke", { passkey: phone.id, confirm: true }))).status).toBe(200);
    phone.setCounter(2); tablet.setCounter(2); now += 60000;  // sign-in shares the per-address limit of 15 a minute
    expect((await t.signIn(phone)).status).toBe(401); expect((await t.signIn(tablet)).status).toBe(200);
    expect((await t.post("enroll", { confirm: true }, cookie)).status).toBe(401);
    // A credential already registered cannot be registered again.
    expect((await t.register(await t.enroll("作成者B"), tablet)).status).toBe(400);
  });

  test("revoking a creator closes every passkey, every cookie and every pending link", async () => {
    const t = creatorHost(), phone = fakeAuthenticator();
    const cookie = t.cookieOf(await t.register(await t.enroll(), phone));
    const pending = new URL((await (await t.addDevice(cookie, phone)).json()).url).hash.slice(9);
    const [creator] = await t.list();
    expect((await t.asPublisher(() => t.post("revoke", { creator: creator.id, confirm: true }))).status).toBe(200);
    phone.setCounter(1);
    expect((await t.signIn(phone)).status).toBe(401);
    expect((await t.post("enroll", { confirm: true }, cookie)).status).toBe(401);
    expect((await t.register(pending)).status).toBe(401);
    expect((await t.list())[0].revoked).toBe(now);
    expect((await t.asPublisher(() => t.post("revoke", { creator: "nobody", confirm: true }))).status).toBe(404);
  });

  test("sign-in refusals look alike, a challenge is single-use and a cookie expires", async () => {
    const t = creatorHost(), phone = fakeAuthenticator(), stranger = fakeAuthenticator();
    const cookie = t.cookieOf(await t.register(await t.enroll(), phone));
    // The counter stays 0 (an authenticator that never counts), so only the recorded challenge can refuse the replay.
    const c = await t.challenge(), ceremony = { challenge: c, id: phone.id, ...phone.assert(c) };
    expect((await t.post("session", ceremony)).status).toBe(200);
    const replay = await t.post("session", ceremony), unknown = await t.signIn(stranger), forged = await t.post("session", { ...ceremony, challenge: "x".repeat(72) });
    for (const r of [replay, unknown, forged]) { expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: "サインインできませんでした" }); }
    // The cookie is signed, not stored: a tampered one is refused, and after 12 hours it is refused too.
    expect((await t.post("enroll", { confirm: true }, cookie.slice(0, -2) + "AA")).status).toBe(401);
    now += 12 * 3600000;
    expect((await t.post("enroll", { confirm: true }, cookie)).status).toBe(401);
  });

  test("a sign-in that is not a genuine ceremony for this site, by this passkey, with user verification, is refused and writes nothing", async () => {
    const t = creatorHost(), phone = fakeAuthenticator();
    await t.register(await t.enroll(), phone);
    const before = t.row(), attempt = async (o: Parameters<typeof phone.assert>[1]) => { const c = await t.challenge(); return (await t.post("session", { challenge: c, id: phone.id, ...phone.assert(c, o) })).status; };
    expect(await attempt({ origin: "https://evil.example" })).toBe(401);
    expect(await attempt({ rpId: "evil.example" })).toBe(401);
    expect(await attempt({ flags: 0x01 })).toBe(401);                  // no user verification
    expect(await attempt({ type: "webauthn.create" })).toBe(401);
    now += 60000;
    expect(await attempt({ key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey })).toBe(401);  // another key's signature
    const stale = await t.challenge(); now += 5 * 60000 + 1;          // a challenge lives five minutes
    expect((await t.post("session", { challenge: stale, id: phone.id, ...phone.assert(stale) })).status).toBe(401);
    expect((await t.post("session", { challenge: "x".repeat(72), id: phone.id, ...phone.assert("x".repeat(72)) })).status).toBe(401);
    expect(t.row()).toEqual(before);
    // A counting authenticator must move forward.
    phone.setCounter(5); expect(await attempt({})).toBe(200);
    now += 60000; phone.setCounter(5); expect(await attempt({})).toBe(401);
  });

  test("one creator's device links cannot use up the enrollments of everyone else", async () => {
    const phone = fakeAuthenticator(), t = creatorHost(), cookie = t.cookieOf(await t.register(await t.enroll(), phone));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) { statuses.push((await t.addDevice(cookie, phone)).status); now += 60000; }
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect((await t.asPublisher(() => t.post("enroll", { label: "作成者B", confirm: true }))).status).toBe(201);
  });

  test("a challenge asked for with an enrollment link says whether the link is still usable, before any passkey is made", async () => {
    const t = creatorHost(), secret = await t.enroll(), ask = async (body: unknown) => (await t.post("challenge", body)).status;
    const before = t.row();
    expect(await ask({ secret })).toBe(200); expect(await ask({})).toBe(200);
    expect(await ask({ secret: "x".repeat(43) })).toBe(401);
    expect(t.row()).toEqual(before);
    // Used: the next browser to open the link is told before its OS makes a passkey.
    const phone = fakeAuthenticator(), cookie = t.cookieOf(await t.register(secret, phone));
    now += 60000; expect(await ask({ secret })).toBe(401);
    // A device link dies with its creator, and any link after a day.
    const device = new URL((await (await t.addDevice(cookie, phone)).json()).url).hash.slice(9), later = await t.enroll("作成者B");
    const [creator] = await t.list(); await t.asPublisher(() => t.post("revoke", { creator: creator.id, confirm: true }));
    const settled = t.row();
    expect(await ask({ secret: device })).toBe(401); expect(await ask({ secret: later })).toBe(200);
    now += 86400000; expect(await ask({ secret: later })).toBe(401); expect(await ask({ secret })).toBe(401);
    expect(t.row()).toEqual(settled);
  });

  test("a creator adds a device only with their own passkey in the same request", async () => {
    const t = creatorHost(), phone = fakeAuthenticator(), other = fakeAuthenticator();
    const cookie = t.cookieOf(await t.register(await t.enroll(), phone)); await t.register(await t.enroll("作成者B"), other);
    const before = t.row();
    // The cookie alone, another creator's passkey, one that is not registered, a forged challenge: refused alike, nothing written.
    const refusals = [await t.post("enroll", { confirm: true }, cookie), await t.addDevice(cookie, other), await t.addDevice(cookie, fakeAuthenticator())];
    const forged = "x".repeat(72); refusals.push(await t.post("enroll", { confirm: true, challenge: forged, id: phone.id, ...phone.assert(forged) }, cookie));
    for (const r of refusals) { expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: "パスキーで本人確認してください" }); }
    expect(t.row()).toEqual(before);
    // With their own passkey it is issued; the same ceremony cannot be sent again.
    const c = await t.challenge(), ceremony = { confirm: true, challenge: c, id: phone.id, ...phone.assert(c) };
    expect((await t.post("enroll", ceremony, cookie)).status).toBe(201);
    expect((await t.post("enroll", ceremony, cookie)).status).toBe(401);
    // Signed by another key, without user verification, with a challenge past its five minutes, or a counter that does not move.
    now += 60000; // the login rate limit is 15 a minute
    const refused = async (o: Parameters<typeof phone.assert>[1]) => { const c = await t.challenge(); return (await t.post("enroll", { confirm: true, challenge: c, id: phone.id, ...phone.assert(c, o) }, cookie)).status; };
    expect(await refused({ key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey })).toBe(401);
    expect(await refused({ flags: 0x01 })).toBe(401);
    const stale = await t.challenge(); now += 5 * 60000 + 1;
    expect((await t.post("enroll", { confirm: true, challenge: stale, id: phone.id, ...phone.assert(stale) }, t.cookieOf(await t.signIn(phone)))).status).toBe(401);
    phone.setCounter(7); expect((await t.addDevice(t.cookieOf(await t.signIn(phone)), phone)).status).toBe(401);
  });

  test("revoking a creator's passkey drops their unused device links", async () => {
    const t = creatorHost(), phone = fakeAuthenticator(), tablet = fakeAuthenticator();
    const cookie = t.cookieOf(await t.register(await t.enroll(), phone));
    const tabletLink = new URL((await (await t.addDevice(cookie, phone)).json()).url).hash.slice(9);
    expect((await t.register(tabletLink, tablet)).status).toBe(201);
    const pending = new URL((await (await t.addDevice(cookie, phone)).json()).url).hash.slice(9), others = await t.enroll("作成者B");
    // The phone is lost and its passkey revoked: the link it asked for goes with it, the creator and the tablet stay.
    expect((await t.asPublisher(() => t.post("revoke", { passkey: phone.id, confirm: true }))).status).toBe(200);
    now += 60000;
    expect((await t.register(pending)).status).toBe(401);
    expect(JSON.parse(t.row()!.payload).enrollments).toHaveLength(1);
    expect((await t.register(others)).status).toBe(201);
    tablet.setCounter(1); expect((await t.signIn(tablet)).status).toBe(200);
  });

  test("handing out a challenge writes nothing; only the publisher lists, revokes and enrolls new creators", async () => {
    const t = creatorHost();
    expect((await t.post("challenge", {})).status).toBe(200); expect(t.row()).toBeNull();
    expect((await t.post("list", {})).status).toBe(401);
    expect((await t.post("revoke", { creator: "x", confirm: true })).status).toBe(401);
    expect((await t.post("enroll", { label: "勝手に", confirm: true })).status).toBe(401);
    expect((await t.asPublisher(() => t.post("enroll", { confirm: true }))).status).toBe(400);
    expect(t.row()).toBeNull();
    // A link lasts one day.
    const secret = await t.enroll(); now += 86400000;
    expect((await t.register(secret)).status).toBe(401);
  });

  test("a creator who signs out on one device stays signed in on another", async () => {
    const t = creatorHost(), phone = fakeAuthenticator(), tablet = fakeAuthenticator();
    const account = async (cookie?: string) => (await (await t.host.fetch(new Request(`${origin}/v1/account`, { headers: cookie ? { Cookie: cookie } : {} }))).json()).canCreate as boolean;
    const onPhone = t.cookieOf(await t.register(await t.enroll(), phone));
    const onTablet = t.cookieOf(await t.register(new URL((await (await t.addDevice(onPhone, phone)).json()).url).hash.slice(9), tablet));
    expect(await account(onPhone)).toBe(true); expect(await account(onTablet)).toBe(true);
    expect((await t.post("signout", {})).status).toBe(401);
    const out = await t.post("signout", {}, onPhone);
    expect(out.status).toBe(200); expect(out.headers.get("Set-Cookie")).toStartWith("capsule_creator=; "); expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    // The phone's cookie, and any copy of it, is refused; the tablet's goes on.
    expect(await account(onPhone)).toBe(false); expect((await t.post("trips", {}, onPhone)).status).toBe(401); expect((await t.post("signout", {}, onPhone)).status).toBe(401);
    expect(await account(onTablet)).toBe(true);
    // A sign-in in the same millisecond as the sign-out is not after it; one a moment later is.
    phone.setCounter(1); expect(await account(t.cookieOf(await t.signIn(phone)))).toBe(false);
    now += 1; phone.setCounter(2); expect(await account(t.cookieOf(await t.signIn(phone)))).toBe(true);
  });
});
describe("what a creator may do", () => {
  // A creator may make a new trip and see how to make one. Nothing more: no trip opens to a creator's cookie.
  async function signedIn() {
    const db = new LocalD1(); dbs.push(db);
    const box = { identity: null as string | null };
    const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin }, () => now, async () => box.identity);
    const req = (path: string, method = "GET", body?: unknown, cookie?: string) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    box.identity = "aws-publisher";
    const secret = new URL((await (await req("/v1/creators/enroll", "POST", { label: "作成者A", confirm: true })).json()).url).hash.slice(9);
    box.identity = null;
    const c = (await (await req("/v1/creators/challenge", "POST", {})).json()).challenge, device = fakeAuthenticator();
    const registered = await req("/v1/creators/register", "POST", { secret, challenge: c, ...device.register(c) });
    // A creator's cookie lasts 12 hours; after that the creator signs in again with the same passkey.
    const signIn = async () => { const c = (await (await req("/v1/creators/challenge", "POST", {})).json()).challenge; return (await req("/v1/creators/session", "POST", { challenge: c, id: device.id, ...device.assert(c) })).headers.get("Set-Cookie")!.split(";")[0]!; };
    return { host, db, box, req, signIn, creator: registered.headers.get("Set-Cookie")!.split(";")[0]! };
  }
  const trip = () => ({ ...testTrip(), confirm: true });

  test("only a signed-in creator is shown the recipe, has a paste checked and publishes", async () => {
    const t = await signedIn();
    expect(await (await t.req("/v1/account")).json()).toEqual({ signedIn: false, canCreate: false, creator: null, localOnly: false, assistKey: false });
    expect(await (await t.req("/v1/account", "GET", undefined, t.creator)).json()).toEqual({ signedIn: false, canCreate: true, creator: { label: "作成者A" }, localOnly: false, assistKey: false });
    expect((await t.req("/v1/recipe")).status).toBe(401);
    expect((await t.req("/v1/check", "POST", { text: JSON.stringify(testTrip()) })).status).toBe(401);
    expect((await t.req("/v1/publish", "POST", trip())).status).toBe(401);
    expect((await t.req("/v1/recipe", "GET", undefined, t.creator)).status).toBe(200);
    expect((await t.req("/v1/check", "POST", { text: JSON.stringify({ schemaVersion: 1, ...testTrip() }) }, t.creator)).status).toBe(200);
    expect((await t.req("/v1/publish", "POST", trip(), t.creator)).status).toBe(201);
    // A forged or revoked cookie is no creator.
    expect((await t.req("/v1/recipe", "GET", undefined, t.creator.slice(0, -2) + "AA")).status).toBe(401);
    const [listed] = await (t.box.identity = "aws-publisher", await t.req("/v1/creators/list", "POST", {})).json();
    await t.req("/v1/creators/revoke", "POST", { creator: listed.id, confirm: true }); t.box.identity = null;
    expect((await t.req("/v1/publish", "POST", trip(), t.creator)).status).toBe(401);
    expect(await (await t.req("/v1/account", "GET", undefined, t.creator)).json()).toMatchObject({ canCreate: false, creator: null });
  });

  test("a creator cannot read any trip, even one they made, nor recover its owner", async () => {
    const t = await signedIn();
    const made = await (await t.req("/v1/publish", "POST", trip(), t.creator)).json(), path = `/v1/c/${made.id}`;
    expect((await t.req(path, "GET", undefined, t.creator)).status).toBe(401);
    expect((await t.req(path + "/grants", "GET", undefined, t.creator)).status).toBe(401);
    expect((await t.req(path + "/revise", "GET", undefined, t.creator)).status).toBe(401);
    expect((await t.req(path + "/revise", "POST", { text: "{}", confirm: true }, t.creator)).status).toBe(401);
    expect((await t.req(path + "/revise/check", "POST", { text: "{}" }, t.creator)).status).toBe(401);
    expect((await t.req(path + "/recover", "POST", { confirm: true }, t.creator)).status).toBe(401);
    // The owner link in the response is what gives this browser the owner seat.
    const seat = await t.req(path + "/sessions", "POST", { secret: new URL(made.url).hash.slice(3) });
    const owner = await stepUp((p, m, b, c) => t.req(path + p, m, b, c), seat.headers.get("Set-Cookie")!.split(";")[0]!);
    const opened = await t.req(path, "GET", undefined, `${t.creator}; ${owner}`);
    expect(opened.status).toBe(200); expect((await opened.json()).role).toBe("owner");
    expect((await t.req(path + "/grants", "POST", { role: "viewer", label: "閲覧", expiresAt: testTrip().spec.lifecycle.purgeAt, confirm: true }, owner)).status).toBe(201);
  });

  test("a creator who lost the answer retries the operation id and gets the owner link while the seat is still free", async () => {
    const t = await signedIn(), operationId = "0123456789abcdef".repeat(2), rows = () => t.db.db.query("SELECT * FROM trip_capsules").all().length;
    const claim = (id: string, url: string) => t.req(`/v1/c/${id}/sessions`, "POST", { secret: new URL(url).hash.slice(3) });
    const before = rows(), first = await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, t.creator)).json();
    const again = await t.req("/v1/publish", "POST", { ...trip(), operationId }, t.creator); expect(again.status).toBe(200);
    const replay = await again.json();
    expect(replay).toMatchObject({ id: first.id, hash: first.hash, replayed: true }); expect(replay.url).toBeString(); expect(rows()).toBe(before + 1);
    // The lost link stops working: only one owner invite is live at a time. An answer lost again is retried again.
    const twice = await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, t.creator)).json(); expect(twice.url).toBeString();
    expect((await claim(first.id, first.url)).status).toBe(401);
    expect((await claim(first.id, replay.url)).status).toBe(401);
    expect((await claim(first.id, twice.url)).status).toBe(200);
    // Once the seat is taken, a retry is only told the trip exists. The creator gets nothing more than the first answer held.
    const taken = await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, t.creator)).json();
    expect(taken).toEqual({ id: first.id, hash: first.hash, replayed: true });
    // Another creator's same operation id is another trip.
    t.box.identity = "aws-publisher";
    const secret = new URL((await (await t.req("/v1/creators/enroll", "POST", { label: "作成者B", confirm: true })).json()).url).hash.slice(9);
    t.box.identity = null;
    const c = (await (await t.req("/v1/creators/challenge", "POST", {})).json()).challenge;
    const other = (await t.req("/v1/creators/register", "POST", { secret, challenge: c, ...fakeAuthenticator().register(c) })).headers.get("Set-Cookie")!.split(";")[0]!;
    const theirs = await t.req("/v1/publish", "POST", { ...trip(), operationId }, other); expect(theirs.status).toBe(201);
    expect((await theirs.json()).id).not.toBe(first.id); expect(rows()).toBe(before + 2);
  });

  test("a creator's retry never takes over an owner invite the IAM publisher recovered", async () => {
    const t = await signedIn(), operationId = "00112233445566778899aabbccddeeff";
    const first = await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, t.creator)).json(), path = `/v1/c/${first.id}`;
    now += 3600000;
    t.box.identity = "aws-publisher"; const recovered = await (await t.req(path + "/recover", "POST", { confirm: true })).json(); t.box.identity = null;
    expect(await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, t.creator)).json()).toEqual({ id: first.id, hash: first.hash, replayed: true });
    expect((await t.req(path + "/sessions", "POST", { secret: new URL(recovered.url).hash.slice(3) })).status).toBe(200);
  });

  test("a creator's retry never takes over a recovered owner invite, even when the trip is purged within the claim window", async () => {
    const t = await signedIn(), operationId = "0f".repeat(16), short = trip();
    short.spec.lifecycle.purgeAt = new Date(now + 36 * 3600000).toISOString();
    short.spec.trip = { ...short.spec.trip, startsOn: "2026-09-16", endsOn: "2026-09-16" };
    short.document.items = short.document.items.map(i => ({ ...i, day: "2026-09-16", startsAt: "2026-09-16T10:00:00+09:00", endsAt: undefined }));
    const first = await t.req("/v1/publish", "POST", { ...short, operationId }, t.creator); expect(first.status).toBe(201);
    const made = await first.json(), path = `/v1/c/${made.id}`;
    now += 3600000;
    t.box.identity = "aws-publisher"; const recovered = await (await t.req(path + "/recover", "POST", { confirm: true })).json(); t.box.identity = null;
    expect((await (await t.req("/v1/publish", "POST", { ...short, operationId }, t.creator)).json()).url).toBeUndefined();
    expect((await t.req(path + "/sessions", "POST", { secret: new URL(recovered.url).hash.slice(3) })).status).toBe(200);
  });

  test("a creator's retry keeps the first owner invite's claim window and gives no link after it", async () => {
    const t = await signedIn(), operationId = "fedcba9876543210".repeat(2);
    const first = await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, t.creator)).json();
    now += 2 * 86400000;
    const replay = await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, await t.signIn())).json();
    expect(replay.url).toBeString();
    // The fresh link closes when the first one would have: three days from publishing, not from the retry.
    now += 86400000;
    expect((await t.req(`/v1/c/${first.id}/sessions`, "POST", { secret: new URL(replay.url).hash.slice(3) })).status).toBe(401);
    expect(await (await t.req("/v1/publish", "POST", { ...trip(), operationId }, await t.signIn())).json()).toEqual({ id: first.id, hash: first.hash, replayed: true });
  });

  describe("trips the creator has not given an owner yet", () => {
    const trips = (t: Awaited<ReturnType<typeof signedIn>>, body: unknown = {}, cookie = t.creator) => t.req("/v1/creators/trips", "POST", body, cookie);
    const claim = (t: Awaited<ReturnType<typeof signedIn>>, id: string, url: string) => t.req(`/v1/c/${id}/sessions`, "POST", { secret: new URL(url).hash.slice(3) });

    test("a saved trip nobody owns is listed to its creator by title, dates and deletion date only", async () => {
      const t = await signedIn();
      expect(await (await trips(t)).json()).toEqual([]);
      const made = await (await t.req("/v1/publish", "POST", trip(), t.creator)).json();
      const listed = await (await trips(t)).json();
      expect(listed).toEqual([{ id: made.id, title: testTrip().spec.title, startsOn: testTrip().spec.trip.startsOn, endsOn: testTrip().spec.trip.endsOn, purgeAt: testTrip().spec.lifecycle.purgeAt, created: now }]);
      // Without a creator's cookie there is no list, and a trip that is not one's own is not found.
      expect((await trips(t, {}, "")).status).toBe(401);
      expect((await trips(t, { id: "0".repeat(32), owner: true })).status).toBe(404);
    });

    test("the creator takes a fresh owner link from the list; once the seat is taken the trip is handed over for good", async () => {
      const t = await signedIn();
      const made = await (await t.req("/v1/publish", "POST", trip(), t.creator)).json(), path = `/v1/c/${made.id}`;
      now += 4 * 86400000;  // the first owner link's claim window has closed
      const fresh = await trips(t, { id: made.id, owner: true }, await t.signIn()); expect(fresh.status).toBe(201);
      const { url } = await fresh.json(); const creator = await t.signIn();
      expect((await claim(t, made.id, made.url)).status).toBe(401);
      const seat = await claim(t, made.id, url); expect(seat.status).toBe(200);
      // The owner sees that the creator made the owner link again.
      const lines = await (await t.req(path + "/history", "GET", undefined, seat.headers.get("Set-Cookie")!.split(";")[0]!)).json();
      expect(lines.map(({ at, ...rest }: { at: number }) => rest).slice(0, 2)).toEqual([{ event: "sessions", role: "owner", label: "自分用", by: "オーナー", device: "不明な端末" }, { event: "creator-owner", role: "owner", by: "作成者" }]);
      expect(await (await trips(t, {}, creator)).json()).toEqual([]);
      expect((await trips(t, { id: made.id, owner: true }, creator)).status).toBe(404);
      expect((await trips(t, { id: made.id, purge: true, confirm: true }, creator)).status).toBe(404);
      // The owner loses the device and the IAM publisher recovers the owner invite: the trip does not come back to the creator.
      t.box.identity = "aws-publisher"; expect((await t.req(path + "/recover", "POST", { confirm: true })).status).toBe(201); t.box.identity = null;
      expect(await (await trips(t, {}, creator)).json()).toEqual([]);
      expect((await trips(t, { id: made.id, owner: true }, creator)).status).toBe(404);
    });

    test("the creator deletes a trip nobody owns, and it leaves the list and the quota", async () => {
      const t = await signedIn();
      const made = await (await t.req("/v1/publish", "POST", trip(), t.creator)).json();
      expect((await trips(t, { id: made.id, purge: true })).status).toBe(400);
      expect((await trips(t, { id: made.id, purge: true, confirm: true })).status).toBe(200);
      expect(await (await trips(t)).json()).toEqual([]);
      expect((await claim(t, made.id, made.url)).status).toBe(410);
      now += 60000;
      for (let i = 0; i < 5; i++) expect((await t.req("/v1/publish", "POST", trip(), t.creator)).status).toBe(201);
      now += 60000;
      for (let i = 0; i < 5; i++) expect((await t.req("/v1/publish", "POST", trip(), t.creator)).status).toBe(201);
    });

    test("a trip whose owner seat was taken before handing over was recorded is still handed over", async () => {
      const t = await signedIn();
      const made = await (await t.req("/v1/publish", "POST", trip(), t.creator)).json();
      expect((await claim(t, made.id, made.url)).status).toBe(200);
      // As a capsule claimed before `ownedAt` existed looks.
      for (const row of t.db.db.query("SELECT key, payload FROM trip_capsules WHERE payload LIKE '%ownedAt%'").all() as Array<{ key: string; payload: string }>) {
        const c = JSON.parse(row.payload); delete c.ownedAt; t.db.db.query("UPDATE trip_capsules SET payload = ? WHERE key = ?").run(JSON.stringify(c), row.key);
      }
      expect(await (await trips(t)).json()).toEqual([]);
      expect((await trips(t, { id: made.id, owner: true })).status).toBe(404);
      expect((await trips(t, { id: made.id, purge: true, confirm: true })).status).toBe(404);
    });

    test("the newest is listed first, a publish refused for the quota leaves nothing behind, and the IAM publisher is not shown the ids", async () => {
      const t = await signedIn(), ids: string[] = [];
      for (let i = 0; i < 10; i++) { if (i && i % 5 === 0) now += 60000; now += 1; ids.push((await (await t.req("/v1/publish", "POST", trip(), t.creator)).json()).id); }
      now += 60000;
      expect((await t.req("/v1/publish", "POST", trip(), t.creator)).status).toBe(429);
      expect((await (await trips(t)).json()).map((x: { id: string }) => x.id)).toEqual([...ids].reverse());
      t.box.identity = "aws-publisher";
      const [listed] = await (await t.req("/v1/creators/list", "POST", {})).json(); t.box.identity = null;
      expect(listed.unowned).toBeUndefined();
    });

    test("creator step-up: five minutes after signing in, a trip is neither handed over nor deleted until the creator signs in again", async () => {
      const t = await signedIn();
      const made = await (await t.req("/v1/publish", "POST", trip(), t.creator)).json(), before = t.db.db.query("SELECT * FROM trip_capsules").all();
      now += 5 * 60000;
      for (const body of [{ id: made.id, owner: true }, { id: made.id, purge: true, confirm: true }]) {
        const r = await trips(t, body); expect(r.status).toBe(428); expect((await r.json()).error).toBe("パスキーで本人確認してください");
      }
      expect(t.db.db.query("SELECT * FROM trip_capsules").all()).toEqual(before);
      // Listing and saving go on with the same cookie.
      expect((await trips(t)).status).toBe(200);
      expect((await t.req("/v1/publish", "POST", trip(), t.creator)).status).toBe(201);
      const fresh = await t.signIn();
      expect((await trips(t, { id: made.id, owner: true }, fresh)).status).toBe(201);
      expect((await trips(t, { id: made.id, purge: true, confirm: true }, fresh)).status).toBe(200);
    });

    test("another creator sees none of them and can do nothing to them", async () => {
      const t = await signedIn();
      const made = await (await t.req("/v1/publish", "POST", trip(), t.creator)).json();
      t.box.identity = "aws-publisher";
      const secret = new URL((await (await t.req("/v1/creators/enroll", "POST", { label: "作成者B", confirm: true })).json()).url).hash.slice(9);
      t.box.identity = null;
      const c = (await (await t.req("/v1/creators/challenge", "POST", {})).json()).challenge;
      const other = (await t.req("/v1/creators/register", "POST", { secret, challenge: c, ...fakeAuthenticator().register(c) })).headers.get("Set-Cookie")!.split(";")[0]!;
      expect(await (await trips(t, {}, other)).json()).toEqual([]);
      expect((await trips(t, { id: made.id, owner: true }, other)).status).toBe(404);
      expect((await trips(t, { id: made.id, purge: true, confirm: true }, other)).status).toBe(404);
      expect(await (await trips(t)).json()).toHaveLength(1);
    });
  });

  test("a creator keeps at most 10 trips and makes at most 5 a minute, apart from the IAM publisher", async () => {
    const t = await signedIn();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await t.req("/v1/publish", "POST", trip(), t.creator)).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    now += 60000;
    for (let i = 0; i < 5; i++) statuses.push((await t.req("/v1/publish", "POST", trip(), t.creator)).status);
    expect(statuses.slice(6)).toEqual([201, 201, 201, 201, 201]);
    expect((await (await t.req("/v1/publish", "POST", trip(), t.creator)).json()).error).toBe("操作が多すぎます。1分後に再試行してください");
    now += 60000;
    expect((await (await t.req("/v1/publish", "POST", trip(), t.creator)).json()).error).toBe("同時に保持できる旅行は10件までです");
    t.box.identity = "aws-publisher";
    expect((await t.req("/v1/publish", "POST", trip())).status).toBe(201);
  });
});
describe("pasting an answer from a chat assistant", () => {
  const post = (t: Awaited<ReturnType<typeof setup>>, path: string, body: unknown) =>
    t.host.fetch(new Request(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const paste = (trip: unknown) => `承知しました。ご希望の旅程です。\n\n\`\`\`json\n${JSON.stringify(trip, null, 2)}\n\`\`\`\n\nいかがでしょうか。`;

  test("the instructions are handed out to whoever may make a trip, and to nobody else", async () => {
    const t = await setup(), anonymous = new CloudHost({ DB: t.db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin }, () => now);
    const refused = await anonymous.fetch(new Request(origin + "/v1/recipe", { headers: { Origin: origin } }));
    expect(refused.status).toBe(401); expect(await refused.json()).toEqual({ error: "作成者としてサインインしてください" });
    expect((await anonymous.fetch(new Request(origin + "/v1/check", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }) }))).status).toBe(401);
    const response = await t.host.fetch(new Request(origin + "/v1/recipe", { headers: { Origin: origin } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "trip", text: recipe.text });
    expect(recipe.text).toContain("bun run validate");
  });

  test("a pasted answer is checked and summarised, without a cookie", async () => {
    const t = await setup(), trip = { schemaVersion: 1, ...testTrip() };
    const response = await post(t, "/v1/check", { text: paste(trip) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, title: "テスト旅行", purgeAt: "2026-10-26T00:00:00+09:00", items: 3, sha256: expect.any(String), trip: { spec: trip.spec, document: trip.document } });
  });

  test("what is wrong comes back as sentences a person can act on", async () => {
    const t = await setup(), broken = { schemaVersion: 1, ...testTrip() };
    broken.spec.theme.accent = "red"; broken.document.items[0]!.title = "";
    const body = await (await post(t, "/v1/check", { text: paste(broken) })).json() as { ok: boolean; errors: Array<{ path: string }>; messages: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors.map(e => e.path)).toEqual(["spec.theme.accent", "document.items.0.title"]);
    expect(body.messages).toEqual(["差し色: 形式が正しくありません", "1 つめの予定の題: 1 文字以上で指定してください"]);
  });

  test("an answer with no trip in it says so instead of listing fields", async () => {
    const t = await setup();
    for (const [text, reason] of [["すみません、作れませんでした。", "not-json"], ["", "empty"], [`案1 ${JSON.stringify(testTrip())} 案2 ${JSON.stringify(testTrip())}`, "many"]] as const) {
      const body = await (await post(t, "/v1/check", { text })).json();
      expect(body).toEqual({ ok: false, reason });
    }
  });

  test("a paste that is too long is refused before it is parsed, counted in bytes", async () => {
    const t = await setup();
    // Japanese is three bytes a character, so the limit has to be measured in bytes to mean anything.
    expect((await post(t, "/v1/check", { text: "あ".repeat(70_000) })).status).toBe(413);
    expect((await post(t, "/v1/check", { text: "x".repeat(200_001) })).status).toBe(413);
    expect((await post(t, "/v1/check", { text: "x".repeat(200_000) })).status).toBe(200);
  });

  test("nothing the answer carried besides the trip is echoed back", async () => {
    const t = await setup(), secret = "k=" + "S".repeat(43);
    const body = await (await post(t, "/v1/check", { text: paste({ schemaVersion: 1, ...testTrip(), link: `https://trip.example/c/abc#${secret}` }) })).json() as { ok: boolean; trip: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.trip)).toEqual(["spec", "document"]);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  test("neither endpoint touches the capsule", async () => {
    const t = await setup(), before = t.db.db.query("SELECT payload, version FROM trip_capsules").get() as { payload: string; version: number };
    await t.host.fetch(new Request(origin + "/v1/recipe", { headers: { Origin: origin } }));
    await post(t, "/v1/check", { text: paste({ schemaVersion: 1, ...testTrip() }) });
    await post(t, "/v1/check", { text: "だめな返事" });
    expect(t.db.db.query("SELECT payload, version FROM trip_capsules").get()).toEqual(before);
  });

  test("they draw on the same per-address limit as everything else", async () => {
    const t = await setup();
    let last = 0;
    for (let i = 0; i < 302; i++) last = (await t.host.fetch(new Request(origin + "/v1/recipe", { headers: { Origin: origin } }))).status;
    expect(last).toBe(429);
  });
});
describe("revising a trip with a chat assistant", () => {
  test("the owner and editors copy candidates and talk by their words only, without authors or members", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const invite = async (role: string, label: string) => t.login((await (await t.request("/grants", "POST", { role, label, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    const editor = await invite("editor", "編集リンクそらいろ"), participant = await invite("participant", "参加リンクむらさき"), viewer = await invite("viewer", "閲覧リンクだいだい");
    const grants = await (await t.request("/grants", "GET", undefined, owner)).json() as Array<{ members: Array<{ id: string }> }>;
    await t.request("/members", "PATCH", { id: grants[1]!.members[0]!.id, label: "メンバーあかね" }, owner);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "ももいろ", body: "夜は星を見たい" }, participant)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "comment", author: "ももいろ", body: "店はどこにする？" }, participant, 2)).status).toBe(200);
    const copied = await t.request("/revise", "GET", undefined, owner);
    expect(copied.status).toBe(200);
    const { text } = await copied.json() as { text: string };
    expect(text.startsWith(recipe.withoutExample)).toBe(true);
    const trip = text.slice(recipe.withoutExample.length);
    expect(trip).toContain("夜は星を見たい"); expect(trip).toContain("店はどこにする？"); expect(trip).toContain("テスト旅行"); expect(trip).toContain('"id":"dinner"');
    for (const word of ["ももいろ", "createdAt", "メンバーあかね", "オーナー", "そらいろ", "むらさき", "だいだい", "自分用"]) expect(trip).not.toContain(word);
    // An editor's copy asks the chat to leave the settings as they are: an editor's answer does not change them.
    expect(trip).not.toContain("編集者が直します");
    const edited = await t.request("/revise", "GET", undefined, editor);
    expect(edited.status).toBe(200);
    const editorText = (await edited.json() as { text: string }).text;
    expect(editorText.startsWith(recipe.withoutExample)).toBe(true); expect(editorText.slice(recipe.withoutExample.length)).toContain("この旅程は編集者が直します"); expect(editorText).toContain('"id":"dinner"');
    for (const cookie of [participant, viewer]) expect((await t.request("/revise", "GET", undefined, cookie)).status).toBe(403);
    expect((await t.request("/revise")).status).toBe(401);
  });
  // An answer as a chat assistant gives it: prose around the trip it was handed, with the owner's change made.
  const answer = (edit: (trip: ReturnType<typeof revisable>) => void, seed = testTrip()) => {
    const trip = structuredClone(revisable(seed.spec, seed.document)); edit(trip);
    return `直しました。\n\n\`\`\`json\n${JSON.stringify(trip, null, 2)}\n\`\`\`\n\n夕食を 18:30 にしています。`;
  };
  const later = (trip: ReturnType<typeof revisable>) => { trip.document.items[1]!.startsAt = "2026-09-25T18:30:00+09:00"; };
  const stored = (t: Awaited<ReturnType<typeof setup>>) => t.db.db.query("SELECT payload, version FROM trip_capsules").get() as { payload: string; version: number };

  test("a pasted answer shows what would change against the trip as it stands, and writes nothing", async () => {
    const t = await setup(), owner = await t.login(t.created.url), before = stored(t);
    const r = await t.request("/revise/check", "POST", { text: answer(later) }, owner);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, revision: 1, diff: { modules: [], suggestions: [], comments: [], items: [{ change: "changed", id: "dinner", title: "夕食", fields: [{ field: "開始時刻", before: "2026-09-25T19:00:00+09:00", after: "2026-09-25T18:30:00+09:00" }] }], other: [], large: false } });
    // The same refusals as a new trip, in the same words.
    expect(await (await t.request("/revise/check", "POST", { text: "旅程はまだです" }, owner)).json()).toEqual({ ok: false, reason: "not-json" });
    const wrong = await (await t.request("/revise/check", "POST", { text: answer(trip => { trip.document.items[0]!.day = "2026-10-30"; }) }, owner)).json();
    expect(wrong).toMatchObject({ ok: false, messages: ["旅程全体: 旅程の日付・時刻が旅行期間と一致しません"] });
    // The rules of a settings change: no page dropped, no deadline in the past.
    const dropped = await (await t.request("/revise/check", "POST", { text: answer(trip => { trip.spec.modules.pop(); trip.spec.navigation.pop(); }) }, owner)).json();
    expect(dropped).toEqual({ ok: false, messages: ["今あるページは消せません"] });
    now = +new Date("2026-10-01T00:00:00Z");
    const past = await (await t.request("/revise/check", "POST", { text: answer(trip => { trip.spec.lifecycle.purgeAt = "2026-09-30T00:00:00+09:00"; }) }, owner)).json();
    expect(past).toEqual({ ok: false, messages: ["削除期限は今より後にしてください"] });
    expect((await t.request("/revise/check", "POST", { text: "x".repeat(200_001) }, owner)).status).toBe(413);
    expect(stored(t)).toEqual(before);
  });

  test("applying keeps members, links, posts and checks; only the owner's parts change", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const p = await (await t.request("/grants", "POST", { role: "participant", label: "参加", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json(), participant = await t.login(p.url);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "ももいろ", body: "夜は星を見たい" }, participant)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "check", id: "c1", done: true }, participant, 2)).status).toBe(200);
    const grantsBefore = await (await t.request("/grants", "GET", undefined, owner)).json();
    const current = await (await t.request("", "GET", undefined, owner)).json();
    const applied = await t.request("/revise", "POST", { text: answer(later, current), confirm: true }, owner, 3);
    expect(applied.status).toBe(200); expect(await applied.json()).toEqual({ revision: 4 });
    const view = await (await t.request("", "GET", undefined, participant)).json();
    expect(view.document.items[1]).toMatchObject({ id: "dinner", startsAt: "2026-09-25T18:30:00+09:00", revision: 2 });
    expect(view.document.items[0].revision).toBe(1);
    expect(view.document.suggestions.map((s: { body: string }) => s.body)).toEqual(["夜は星を見たい"]);
    expect(view.document.checklist[0].done).toBe(true);
    expect(await (await t.request("/grants", "GET", undefined, owner)).json()).toEqual(grantsBefore);
  });

  test("a new deadline from an answer moves the invites and the members' browsers with it, as a settings change does", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    await t.request("/grants", "POST", { role: "viewer", label: "閲覧", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner);
    const moved = answer(trip => { trip.spec.lifecycle.purgeAt = "2026-11-20T00:00:00+09:00"; });
    expect((await t.request("/revise", "POST", { text: moved, confirm: true }, owner)).status).toBe(200);
    const grants = await (await t.request("/grants", "GET", undefined, owner)).json() as Array<{ expires: number }>;
    expect(grants.map(g => g.expires)).toEqual([+new Date("2026-11-20T00:00:00+09:00"), +new Date("2026-11-20T00:00:00+09:00")]);
    const cookie = (await t.request("", "GET", undefined, owner)).headers.get("Set-Cookie")!;
    expect(Number(/Max-Age=(\d+)/.exec(cookie)![1])).toBe((+new Date("2026-11-20T00:00:00+09:00") - now) / 1000);
  });

  test("what is applied is the change that was shown: a trip updated since is refused with 409", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    const shown = await (await t.request("/revise/check", "POST", { text: answer(later) }, owner)).json();
    expect((await t.request("/document", "PATCH", { type: "notes", body: "集合は改札前" }, owner, shown.revision)).status).toBe(200);
    const stale = await t.request("/revise", "POST", { text: answer(later), confirm: true }, owner, shown.revision);
    expect(stale.status).toBe(409);
    expect((await t.request("", "GET", undefined, owner)).headers.get("ETag")).toBe('"2"');
  });

  test("a large change asks for the trip's title; a small one needs only the confirmation", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    const renamed = answer(trip => { trip.spec.title = "別の旅"; });
    expect((await (await t.request("/revise/check", "POST", { text: renamed }, owner)).json()).diff.large).toBe(true);
    const refused = await t.request("/revise", "POST", { text: renamed, confirm: true }, owner);
    expect(refused.status).toBe(400); expect((await refused.json()).error).toBe("確認用のタイトルが一致しません。今の題を入力してください");
    expect((await t.request("/revise", "POST", { text: renamed, confirm: true, title: "別の旅" }, owner)).status).toBe(400);
    expect((await t.request("/revise", "POST", { text: renamed, confirm: true, title: "テスト旅行" }, owner)).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, owner)).json()).spec.title).toBe("別の旅");
    const small = answer(later, { ...testTrip(), spec: { ...testTrip().spec, title: "別の旅" } });
    expect((await t.request("/revise", "POST", { text: small, confirm: true }, owner, 2)).status).toBe(200);
    expect((await t.request("/revise", "POST", { text: small }, owner, 3)).status).toBe(400);
  });

  test("a trip published with items without a time is still edited and revised as it is; a new trip without one is refused", async () => {
    const t = await setup(), seed = testTrip(); delete seed.document.items[2]!.startsAt; delete seed.document.items[2]!.timeTentative;
    const refused = await t.host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) }));
    expect(refused.status).toBe(400); expect((await refused.json()).error).toBe("開始時刻の無い予定があります。時刻を書くか、決まっていなければ妥当な時刻と timeTentative: true を入れてください");
    const created = await publishUntimed(t.host, seed), secret = new URLSearchParams(new URL(created.url).hash.slice(1)).get("k");
    const call = (path: string, method: string, body: unknown, cookie?: string, revision = 1) => t.host.fetch(new Request(origin + `/v1/c/${created.id}` + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const owner = (await call("/sessions", "POST", { secret })).headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await call("/document", "PATCH", { type: "notes", body: "メモ" }, owner)).status).toBe(200);
    const trip = await (await call("", "GET", undefined, owner)).json(), copy = structuredClone(revisable(trip.spec, trip.document));
    copy.document.items[1]!.startsAt = "2026-09-25T18:30:00+09:00";
    const applied = await call("/revise", "POST", { text: `\`\`\`json\n${JSON.stringify(copy)}\n\`\`\``, confirm: true }, owner, 2);
    expect(applied.status).toBe(200);
    const after = (await (await call("", "GET", undefined, owner)).json()).document.items;
    expect(after[2]).toEqual({ id: "walk", title: "公園の散歩", day: "2026-09-26", kind: "activity", status: "proposed", revision: 1 });
    // An item the answer adds without a time is refused, as in a new trip, and so is one it takes the time off.
    for (const edit of [(d: typeof copy.document) => { d.items.push({ id: "cafe", title: "喫茶店", day: "2026-09-25", kind: "meal", status: "proposed", revision: 1 }); }, (d: typeof copy.document) => { delete d.items[0]!.startsAt; }]) {
      const next = structuredClone(copy); edit(next.document);
      const refused = await (await call("/revise/check", "POST", { text: JSON.stringify(next) }, owner, 3)).json();
      expect(refused.ok).toBe(false); expect(refused.messages[0]).toMatch(/^\d つめの予定の開始時刻: 開始時刻を書いてください/);
    }
  });
  test("a change that breaks the trip is not applied, nor anything after sharing ends", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), before = stored(t);
    expect((await t.request("/revise", "POST", { text: answer(trip => { trip.spec.modules.pop(); trip.spec.navigation.pop(); }), confirm: true }, owner)).status).toBe(400);
    expect((await t.request("/revise", "POST", { text: "だめ", confirm: true }, owner)).status).toBe(400);
    expect(stored(t)).toEqual(before);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/revise/check", "POST", { text: answer(later) }, owner, 2)).status).toBe(403);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, owner, 2)).status).toBe(403);
  });

  test("nobody but the owner and editors checks or applies an answer", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    for (const role of ["participant", "viewer"]) {
      const cookie = await t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
      expect((await t.request("/revise/check", "POST", { text: answer(later) }, cookie)).status).toBe(403);
      expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, cookie)).status).toBe(403);
    }
    expect((await t.request("/revise/check", "POST", { text: answer(later) })).status).toBe(401);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true })).status).toBe(401);
  });

  // One step back: the trip just before the last applied answer. What participants did in between stays.
  test("undo returns the plan to just before the last revise; posts and checks made since stay", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const p = await (await t.request("/grants", "POST", { role: "participant", label: "参加", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json(), participant = await t.login(p.url);
    expect((await t.request("/undo", "GET", undefined, owner)).status).toBe(404);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "ももいろ", body: "夜は星を見たい" }, participant, 2)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "check", id: "c1", done: true }, participant, 3)).status).toBe(200);
    const shown = await (await t.request("/undo", "GET", undefined, owner)).json();
    expect(shown).toEqual({ revision: 4, diff: { modules: [], suggestions: [], comments: [], items: [{ change: "changed", id: "dinner", title: "夕食", fields: [{ field: "開始時刻", before: "2026-09-25T18:30:00+09:00", after: "2026-09-25T19:00:00+09:00" }] }], other: [], large: false } });
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 3)).status).toBe(409);
    const undone = await t.request("/undo", "POST", { confirm: true }, owner, 4);
    expect(undone.status).toBe(200); expect(await undone.json()).toEqual({ revision: 5 });
    const view = await (await t.request("", "GET", undefined, participant)).json();
    expect(view.document.items[1]).toMatchObject({ id: "dinner", startsAt: "2026-09-25T19:00:00+09:00", revision: 3 });
    expect(view.document.suggestions.map((s: { body: string }) => s.body)).toEqual(["夜は星を見たい"]);
    expect(view.document.checklist[0].done).toBe(true);
    // One step only: once undone, there is nothing to go back to.
    expect((await t.request("/undo", "GET", undefined, owner)).status).toBe(404);
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 5)).status).toBe(404);
  });

  test("undo brings back the candidates and talk the revise changed; posts written since stay", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const participant = await t.login((await (await t.request("/grants", "POST", { role: "participant", label: "参加", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    for (const [revision, body] of [[1, "消す候補"], [2, "残す候補"]] as const) expect((await t.request("/document", "PATCH", { type: "suggest", author: "あお", body }, participant, revision)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "comment", author: "あお", body: "元の相談" }, participant, 3)).status).toBe(200);
    const before = await (await t.request("", "GET", undefined, owner)).json();
    const text = answer(trip => { trip.document.suggestions.shift(); trip.document.suggestions[0]!.body = "変えた候補"; trip.document.suggestions.push({ id: "added", body: "足した候補", promoted: false }); trip.document.comments[0]!.body = "変えた相談"; trip.document.comments.push({ id: "added-talk", body: "足した相談" }); }, before);
    expect((await t.request("/revise", "POST", { text, confirm: true, title: before.spec.title }, owner, 4)).status).toBe(200);
    // The same clock tick as the revise: preservation depends on ids, not timestamps.
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "あと", body: "後の候補" }, participant, 5)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "comment", author: "あと", body: "後の相談" }, participant, 6)).status).toBe(200);
    const now = await (await t.request("", "GET", undefined, owner)).json();
    const shown = await (await t.request("/undo", "GET", undefined, owner)).json();
    expect(shown.diff.suggestions.map((r: { change: string }) => r.change)).toEqual(["added", "changed", "removed"]);
    expect(shown.diff.comments.map((r: { change: string }) => r.change)).toEqual(["changed", "removed"]);
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 7)).status).toBe(400);
    expect((await t.request("/undo", "POST", { confirm: true, title: before.spec.title }, owner, 7)).status).toBe(200);
    const after = await (await t.request("", "GET", undefined, owner)).json();
    expect(after.document.suggestions).toEqual([...before.document.suggestions, now.document.suggestions.at(-1)]);
    expect(after.document.comments).toEqual([...before.document.comments, now.document.comments.at(-1)]);
  });

  test("a revise made before candidates were kept undoes without touching them", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, owner)).status).toBe(200);
    const row = stored(t), capsule = JSON.parse(row.payload);
    delete capsule.previous.document.suggestions; delete capsule.previous.document.comments; delete capsule.previous.revisedIds;
    t.db.db.query("UPDATE trip_capsules SET payload=? WHERE owner_key IS NOT NULL").run(JSON.stringify(capsule));
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "あと", body: "後の候補" }, owner, 2)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "comment", author: "あと", body: "後の相談" }, owner, 3)).status).toBe(200);
    const before = await (await t.request("", "GET", undefined, owner)).json();
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 4)).status).toBe(200);
    const after = await (await t.request("", "GET", undefined, owner)).json();
    expect(after.document.suggestions).toEqual(before.document.suggestions); expect(after.document.comments).toEqual(before.document.comments);
    expect(after.document.items[1].startsAt).toBe(t.seed.document.items[1]!.startsAt);
  });

  test("posts rewritten or removed by hand after a revise show in the undo diff and return", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "あお", body: "元の候補" }, owner)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "comment", author: "あお", body: "元の相談" }, owner, 2)).status).toBe(200);
    const before = await (await t.request("", "GET", undefined, owner)).json();
    expect((await t.request("/revise", "POST", { text: answer(later, before), confirm: true }, owner, 3)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "rewrite", list: "suggestions", id: before.document.suggestions[0].id, body: "手で直した候補" }, owner, 4)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "remove", list: "comments", id: before.document.comments[0].id }, owner, 5)).status).toBe(200);
    const shown = await (await t.request("/undo", "GET", undefined, owner)).json();
    expect(shown.diff.suggestions[0]).toMatchObject({ change: "changed", fields: [{ field: "本文", before: "手で直した候補", after: "元の候補" }] });
    expect(shown.diff.comments[0]).toMatchObject({ change: "added", id: before.document.comments[0].id });
    expect((await t.request("/undo", "POST", { confirm: true, title: before.spec.title }, owner, 6)).status).toBe(200);
    const after = await (await t.request("", "GET", undefined, owner)).json();
    expect(after.document.suggestions).toEqual(before.document.suggestions); expect(after.document.comments).toEqual(before.document.comments);
  });

  test("a checklist or budget edited by hand after a revise shows in the undo diff", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, owner)).status).toBe(200);
    const checklist = [...t.seed.document.checklist.map(({ id, title }) => ({ id, title })), { id: "c4", title: "充電器を持つ" }];
    expect((await t.request("/document", "PATCH", { type: "checklist", checklist }, owner, 2)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "budget", budget: [{ id: "b1", title: "宿", amount: 24000, description: "" }] }, owner, 3)).status).toBe(200);
    const shown = await (await t.request("/undo", "GET", undefined, owner)).json();
    expect(shown.diff.other).toEqual(["準備リスト", "費用メモ"]);
  });
  test("the step kept is the one before the latest revise; a large undo asks for the title", async () => {
    const t = await setup(), owner = await t.login(t.created.url);
    expect((await t.request("/revise", "POST", { text: answer(trip => { trip.spec.title = "別の旅"; }), confirm: true, title: "テスト旅行" }, owner)).status).toBe(200);
    const renamed = { ...testTrip(), spec: { ...testTrip().spec, title: "別の旅" } };
    expect((await t.request("/revise", "POST", { text: answer(later, renamed), confirm: true }, owner, 2)).status).toBe(200);
    // Back to "別の旅" at 19:00, not to the trip as published: a small change, one confirmation.
    const shown = await (await t.request("/undo", "GET", undefined, owner)).json();
    expect([shown.diff.title, shown.diff.large, shown.diff.items.length]).toEqual([undefined, false, 1]);
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 3)).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, owner)).json()).spec.title).toBe("別の旅");
    // A new title is large both ways.
    expect((await t.request("/revise", "POST", { text: answer(later, renamed), confirm: true }, owner, 4)).status).toBe(200);
    expect((await t.request("/revise", "POST", { text: answer(trip => { trip.spec.title = "三つめの旅"; }, renamed), confirm: true, title: "別の旅" }, owner, 5)).status).toBe(200);
    expect((await (await t.request("/undo", "GET", undefined, owner)).json()).diff.large).toBe(true);
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 6)).status).toBe(400);
    expect((await t.request("/undo", "POST", { confirm: true, title: "三つめの旅" }, owner, 6)).status).toBe(200);
  });

  test("undo drops a page the revise added; a deadline already past is refused", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const added = answer(trip => { trip.spec.modules.push({ id: "extra", kind: "notes", label: "持ち物メモ" }); trip.spec.navigation.push("extra"); trip.spec.trip.endsOn = "2026-10-30"; trip.spec.lifecycle.purgeAt = "2026-11-20T00:00:00+09:00"; });
    expect((await t.request("/revise", "POST", { text: added, confirm: true, title: "テスト旅行" }, owner)).status).toBe(200);
    // The trip now runs to 10-30; going back would restore a deadline (10-26) that has passed. The owner reads the trip on the
    // way there, as a session unused for 30 days is refused.
    now = +new Date("2026-10-06T00:00:00+09:00"); expect((await t.request("", "GET", undefined, owner)).status).toBe(200);
    now = +new Date("2026-10-27T00:00:00+09:00"); await stepUp(t.request, owner);
    const refused = await t.request("/undo", "POST", { confirm: true, title: "テスト旅行" }, owner, 2);
    expect(refused.status).toBe(400); expect((await refused.json()).error).toBe("削除期限は今より後にしてください");
    now = +new Date("2026-09-20T00:00:00+09:00"); await stepUp(t.request, owner);
    expect((await t.request("/undo", "POST", { confirm: true, title: "テスト旅行" }, owner, 2)).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, owner)).json()).spec.modules.map((m: { id: string }) => m.id)).not.toContain("extra");
  });

  test("a settings change keeps its own rules now that each caller checks them", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), spec = structuredClone(t.seed.spec);
    spec.modules.pop(); spec.navigation.pop();
    const dropped = await t.request("/spec", "PATCH", { spec, confirm: true }, owner);
    expect(dropped.status).toBe(400); expect((await dropped.json()).error).toBe("今あるページは消せません");
    now = +new Date("2026-10-01T00:00:00Z"); await stepUp(t.request, owner);
    const past = await t.request("/spec", "PATCH", { spec: { ...t.seed.spec, lifecycle: { ...t.seed.spec.lifecycle, purgeAt: "2026-09-30T00:00:00+09:00" } }, confirm: true }, owner);
    expect(past.status).toBe(400); expect((await past.json()).error).toBe("削除期限は今より後にしてください");
  });

  test("nobody but the owner and editors undoes, and nothing is undone after sharing ends", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, owner)).status).toBe(200);
    for (const role of ["participant", "viewer"]) {
      const cookie = await t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
      expect((await t.request("/undo", "GET", undefined, cookie)).status).toBe(403);
      expect((await t.request("/undo", "POST", { confirm: true }, cookie, 2)).status).toBe(403);
    }
    expect((await t.request("/undo", "POST", { confirm: true }, undefined, 2)).status).toBe(401);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, 2)).status).toBe(200);
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 3)).status).toBe(403);
  });

  // An editor may change what editors change by hand (items, the 準備 list, notes, 費用メモ), never the settings, which are the owner's.
  const asEditor = async (t: Awaited<ReturnType<typeof setup>>, owner: string) => t.login((await (await t.request("/grants", "POST", { role: "editor", label: "編集", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
  test("an editor's answer changes the plan and leaves the settings as they are", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), editor = await asEditor(t, owner);
    const both = answer(trip => { later(trip); trip.spec.title = "別の旅"; trip.spec.lifecycle.purgeAt = "2026-11-20T00:00:00+09:00"; trip.document.notes = "集合は改札前"; });
    const shown = await (await t.request("/revise/check", "POST", { text: both }, editor)).json();
    expect(shown).toEqual({ ok: true, revision: 1, diff: { modules: [], suggestions: [], comments: [], items: [{ change: "changed", id: "dinner", title: "夕食", fields: [{ field: "開始時刻", before: "2026-09-25T19:00:00+09:00", after: "2026-09-25T18:30:00+09:00" }] }], other: ["旅のメモ"], large: false } });
    // No passkey check and no title asked: the deadline and the title stay.
    expect((await t.request("/revise", "POST", { text: both, confirm: true }, editor)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    expect(view.spec).toEqual(t.seed.spec);
    expect([view.document.items[1].startsAt, view.document.notes]).toEqual(["2026-09-25T18:30:00+09:00", "集合は改札前"]);
    // An answer without its settings is read with the trip's own.
    const { spec, ...bare } = revisable(t.seed.spec, t.seed.document);
    expect((await (await t.request("/revise/check", "POST", { text: JSON.stringify(bare) }, editor)).json()).ok).toBe(true);
    expect((await (await t.request("/revise/check", "POST", { text: JSON.stringify(bare) }, owner)).json()).ok).toBe(false);
  });

  test("new candidates carry the applying editor's member name, and removing one asks for the title", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), editor = await asEditor(t, owner);
    const text = answer(trip => { trip.document.suggestions.push({ id: "new", body: "新しい候補", promoted: false }); trip.document.comments.push({ id: "talk", body: "新しい相談" }); });
    expect((await t.request("/revise", "POST", { text, confirm: true }, editor)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    const grants = await (await t.request("/grants", "GET", undefined, owner)).json();
    expect(view.document.suggestions[0].author).toBe(grants[1].members[0].label);
    expect(view.document.comments[0].author).toBe(grants[1].members[0].label);
    expect(view.document.suggestions[0].createdAt).toBe(new Date(now).toISOString());
    const removed = answer(trip => { trip.document.suggestions = []; }, view);
    expect((await t.request("/revise", "POST", { text: removed, confirm: true }, owner, 2)).status).toBe(400);
    expect((await t.request("/revise", "POST", { text: removed, confirm: true, title: view.spec.title }, owner, 2)).status).toBe(200);
  });

  test("a promoted suggestion can be promoted again once the revise dropped its item", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "ももいろ", body: "夜は星を見たい" }, owner)).status).toBe(200);
    const id = (await (await t.request("", "GET", undefined, owner)).json()).document.suggestions[0].id as string;
    expect((await t.request("/document", "PATCH", { type: "promote", id, day: "2026-09-25" }, owner, 2)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    const made = view.document.items.find((i: { description?: string }) => i.description === "夜は星を見たい").id as string;
    expect(view.document.suggestions[0].promoted).toBe(true);
    const dropped = answer(trip => { trip.document.items = trip.document.items.filter(i => i.id !== made); }, view);
    expect((await t.request("/revise", "POST", { text: dropped, confirm: true, title: view.spec.title }, owner, 3)).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, owner)).json()).document.suggestions[0].promoted).toBe(false);
    expect((await t.request("/document", "PATCH", { type: "promote", id, day: "2026-09-25" }, owner, 4)).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, owner)).json()).document.items.some((i: { description?: string }) => i.description === "夜は星を見たい")).toBe(true);
  });

  test("a suggestion whose item is still there stays promoted through a revise and an undo", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "ももいろ", body: "夜は星を見たい" }, owner)).status).toBe(200);
    const id = (await (await t.request("", "GET", undefined, owner)).json()).document.suggestions[0].id as string;
    expect((await t.request("/document", "PATCH", { type: "promote", id, day: "2026-09-25" }, owner, 2)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    expect((await t.request("/revise", "POST", { text: answer(later, view), confirm: true }, owner, 3)).status).toBe(200);
    const again = async (revision: number) => t.request("/document", "PATCH", { type: "promote", id, day: "2026-09-25" }, owner, revision);
    let r = await again(4);
    expect(r.status).toBe(400); expect((await r.json()).error).toBe("候補が存在しないか追加済みです");
    expect((await t.request("/undo", "POST", { confirm: true }, owner, 4)).status).toBe(200);
    r = await again(5);
    expect(r.status).toBe(400);
  });

  test("a suggestion promoted after a revise can be promoted again once an undo took its item away", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "ももいろ", body: "夜は星を見たい" }, owner, 2)).status).toBe(200);
    const id = (await (await t.request("", "GET", undefined, owner)).json()).document.suggestions[0].id as string;
    expect((await t.request("/document", "PATCH", { type: "promote", id, day: "2026-09-25" }, owner, 3)).status).toBe(200);
    expect((await t.request("/undo", "POST", { confirm: true, title: "テスト旅行" }, owner, 4)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    expect(view.document.suggestions.map((s: { id: string; promoted: boolean }) => [s.id, s.promoted])).toEqual([[id, false]]);
    expect(view.document.items.some((i: { description?: string }) => i.description === "夜は星を見たい")).toBe(false);
    expect((await t.request("/document", "PATCH", { type: "promote", id, day: "2026-09-25" }, owner, 5)).status).toBe(200);
  });

  test("the preview of a revise that drops a promoted item already shows the suggestion as not added, and asks for the title", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "ももいろ", body: "夜は星を見たい" }, owner)).status).toBe(200);
    const id = (await (await t.request("", "GET", undefined, owner)).json()).document.suggestions[0].id as string;
    expect((await t.request("/document", "PATCH", { type: "promote", id, day: "2026-09-25" }, owner, 2)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json(), made = view.document.items.find((i: { description?: string }) => i.description === "夜は星を見たい").id as string;
    const text = answer(trip => { trip.document.items = trip.document.items.filter(i => i.id !== made); }, view);
    const shown = await (await t.request("/revise/check", "POST", { text }, owner)).json();
    expect(shown.diff.suggestions).toEqual([expect.objectContaining({ change: "changed", id })]);
    expect(shown.diff.large).toBe(true);
    expect((await t.request("/revise", "POST", { text, confirm: true }, owner, 3)).status).toBe(400);
    expect((await t.request("/revise", "POST", { text, confirm: true, title: view.spec.title }, owner, 3)).status).toBe(200);
  });

  test("an editor undoes a step that leaves the settings as they are, and no other", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), editor = await asEditor(t, owner);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, editor)).status).toBe(200);
    expect((await (await t.request("/undo", "GET", undefined, editor)).json()).diff.items.length).toBe(1);
    expect((await t.request("/undo", "POST", { confirm: true }, editor, 2)).status).toBe(200);
    expect((await (await t.request("", "GET", undefined, owner)).json()).document.items[1].startsAt).toBe("2026-09-25T19:00:00+09:00");
    // After the owner's revise renamed the trip, going back renames it too: that is the owner's to do.
    expect((await t.request("/revise", "POST", { text: answer(trip => { trip.spec.title = "別の旅"; }), confirm: true, title: "テスト旅行" }, owner, 3)).status).toBe(200);
    for (const r of [await t.request("/undo", "GET", undefined, editor), await t.request("/undo", "POST", { confirm: true, title: "別の旅" }, editor, 4)]) {
      expect(r.status).toBe(403); expect((await r.json()).error).toBe("設定も戻るため、オーナーだけが戻せます");
    }
    expect((await t.request("/undo", "GET", undefined, owner)).status).toBe(200);
  });

  test("an editor's large change asks for the title, and a stale or frozen trip is refused as for the owner", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), editor = await asEditor(t, owner);
    const moved = answer(trip => { for (const i of trip.document.items) i.title += "（変更）"; });
    expect((await (await t.request("/revise/check", "POST", { text: moved }, editor)).json()).diff.large).toBe(true);
    expect((await t.request("/revise", "POST", { text: moved, confirm: true }, editor)).status).toBe(400);
    expect((await t.request("/revise", "POST", { text: moved, confirm: true, title: "テスト旅行" }, editor, 0)).status).toBe(409);
    expect((await t.request("/revise", "POST", { text: moved, confirm: true, title: "テスト旅行" }, editor)).status).toBe(200);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, 2)).status).toBe(200);
    // Sharing ended by the owner revokes the editor's seat; sharing that ended with the trip's own days leaves it, read-only.
    const frozen = await t.request("/revise/check", "POST", { text: answer(later) }, editor, 3);
    expect(frozen.status).toBe(401);
  });

  test("once the trip's days and its days for memories are over, an editor may no longer revise or undo", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), editor = await asEditor(t, owner);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, editor)).status).toBe(200);
    now = +new Date("2026-10-10T00:00:00+09:00");
    expect((await t.request("/revise/check", "POST", { text: answer(later) }, editor, 2)).status).toBe(403);
    expect((await t.request("/revise", "POST", { text: answer(later), confirm: true }, editor, 2)).status).toBe(403);
    expect((await t.request("/undo", "POST", { confirm: true }, editor, 2)).status).toBe(403);
  });

  // A phone types the title the way a phone does: a space after a predicted word, full-width spaces and letters. The title
  // asked for is the trip's as it stands, not the new one the answer brings.
  test("the title typed to confirm counts when it looks the same; the new title is not the one asked for", async () => {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url)), renamed = answer(trip => { trip.spec.title = "別の旅"; });
    const refused = await t.request("/revise", "POST", { text: renamed, confirm: true, title: "別の旅" }, owner);
    expect(refused.status).toBe(400); expect((await refused.json()).error).toBe("確認用のタイトルが一致しません。今の題を入力してください");
    expect((await t.request("/revise", "POST", { text: renamed, confirm: true, title: "テスト旅行 " }, owner)).status).toBe(200);
    // Going back asks for the title as it stands too, not the one it would restore.
    const back = await t.request("/undo", "POST", { confirm: true, title: "テスト旅行" }, owner, 2);
    expect(back.status).toBe(400); expect((await back.json()).error).toBe("確認用のタイトルが一致しません。今の題を入力してください");
    expect((await t.request("/undo", "POST", { confirm: true, title: "　別の旅" }, owner, 2)).status).toBe(200);
    expect((await t.request("/revise", "POST", { text: answer(trip => { trip.spec.title = "ＡＢ 旅行"; }), confirm: true, title: "テスト旅行" }, owner, 3)).status).toBe(200);
    expect((await t.request("/purge", "POST", { title: "AB　旅行" }, owner)).status).toBe(200);
  });
});
describe("時刻を変えたら並びも移る", () => {
  const day = "2026-09-24", at = (time: string, on = day) => `${on}T${time}:00+09:00`;
  const make = (id: string, time?: string, on = day) => ({ id, title: id, day: on, kind: "activity", status: "confirmed", revision: 1, ...(time ? { startsAt: at(time, on) } : {}) });
  // The day reads 9:00, (no time), 12:00, 15:00; another day holds 10:00 and 18:00. Published in that order, so nothing has been placed yet.
  async function trip(first = [make("nine", "09:00"), make("untimed"), make("noon", "12:00"), make("three", "15:00")]) {
    const t = await setup(), seed = testTrip();
    seed.document.items = [...first, make("next-ten", "10:00", "2026-09-25"), make("next-six", "18:00", "2026-09-25")] as typeof seed.document.items;
    const created = await publishUntimed(t.host, seed), base = `/v1/c/${created.id}`; let revision = 1;
    const call = (path: string, method: string, body: unknown, cookie?: string) => t.host.fetch(new Request(origin + base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const owner = (await call("/sessions", "POST", { secret: new URLSearchParams(new URL(created.url).hash.slice(1)).get("k") })).headers.get("Set-Cookie")!.split(";")[0]!;
    const items = async () => (await (await call("", "GET", undefined, owner)).json()).document.items as Array<{ id: string; day: string; startsAt?: string; revision: number }>;
    const save = async (item: object) => { const res = await call("/document", "PATCH", { type: "item", item }, owner); expect(res.status).toBe(200); revision++; return (await items()).map(i => i.id); };
    return { items, save };
  }
  test("a new time moves the item to where that time belongs in its day; items without a time and the other days stay put", async () => {
    const t = await trip();
    expect(await t.save(make("nine", "13:00"))).toEqual(["untimed", "noon", "nine", "three", "next-ten", "next-six"]);
    expect((await t.items()).find(i => i.id === "nine")).toMatchObject({ startsAt: at("13:00"), revision: 2 });
    // Later than everything: after the day's last item. Earlier than everything: before the first item with a later time.
    expect(await t.save(make("noon", "16:00"))).toEqual(["untimed", "nine", "three", "noon", "next-ten", "next-six"]);
    expect(await t.save(make("three", "08:00"))).toEqual(["untimed", "three", "nine", "noon", "next-ten", "next-six"]);
  });
  test("an edit that leaves the time alone, or takes it away, leaves the item where it is", async () => {
    const t = await trip();
    expect(await t.save({ ...make("three", "15:00"), title: "題だけ変えた" })).toEqual(["nine", "untimed", "noon", "three", "next-ten", "next-six"]);
    // The same instant written another way is the same time.
    expect(await t.save({ ...make("nine"), startsAt: "2026-09-24T00:00:00.000Z" })).toEqual(["nine", "untimed", "noon", "three", "next-ten", "next-six"]);
    expect(await t.save(make("noon"))).toEqual(["nine", "untimed", "noon", "three", "next-ten", "next-six"]);
  });
  test("an item given its first time moves; in a day published out of order only the saved item moves", async () => {
    const t = await trip();
    expect(await t.save(make("untimed", "16:00"))).toEqual(["nine", "noon", "three", "untimed", "next-ten", "next-six"]);
    // 15:00, 9:00, 12:00 as published. Saving 9:00 as 10:00 puts it before the first item that starts later; the other two are not sorted.
    const mixed = await trip([make("three", "15:00"), make("nine", "09:00"), make("noon", "12:00")]);
    expect(await mixed.save(make("nine", "10:00"))).toEqual(["nine", "three", "noon", "next-ten", "next-six"]);
    expect(await mixed.save({ ...make("noon", "12:00"), title: "題だけ" })).toEqual(["nine", "three", "noon", "next-ten", "next-six"]);
  });
  test("an item moved to another day takes its place by time there", async () => {
    const t = await trip();
    expect(await t.save(make("nine", "12:00", "2026-09-25"))).toEqual(["untimed", "noon", "three", "next-ten", "nine", "next-six"]);
  });
  test("a new item with a time goes where the time belongs; one without goes last", async () => {
    const t = await trip();
    expect(await t.save(make("ten-thirty", "10:30"))).toEqual(["nine", "untimed", "ten-thirty", "noon", "three", "next-ten", "next-six"]);
    expect(await t.save(make("someday"))).toEqual(["nine", "untimed", "ten-thirty", "noon", "three", "next-ten", "next-six", "someday"]);
    // The first item of a day that has none goes to the end of the list.
    expect(await t.save(make("last-day", "07:00", "2026-09-26"))).toEqual(["nine", "untimed", "ten-thirty", "noon", "three", "next-ten", "next-six", "someday", "last-day"]);
  });
});
describe("予定の並べ替え", () => {
  const day = "2026-09-24", at = (time: string, on = day) => `${on}T${time}:00+09:00`, utc = (time: string, on = day) => new Date(at(time, on)).toISOString();
  const make = (id: string, time?: string, extra: object = {}) => ({ id, title: id, day, kind: "activity", status: "confirmed", revision: 1, ...(time ? { startsAt: at(time) } : {}), ...extra });
  type Stored = { id: string; day: string; startsAt?: string; endsAt?: string; timeTentative?: boolean; revision: number };
  // A trip whose first day holds the given items, followed by one item on the next day. Every write goes through `move`, which counts the version.
  async function trip(items: object[]) {
    const t = await setup(), seed = testTrip(); seed.document.items = [...items, { ...make("tomorrow", "10:00"), day: "2026-09-25", startsAt: at("10:00", "2026-09-25") }] as typeof seed.document.items;
    const created = await publishUntimed(t.host, seed), base = `/v1/c/${created.id}`; let revision = 1;
    const call = (path: string, method: string, body: unknown, cookie?: string, version = revision) => t.host.fetch(new Request(origin + base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${version}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const join = async (url: string) => (await call("/sessions", "POST", { secret: new URLSearchParams(new URL(url).hash.slice(1)).get("k") })).headers.get("Set-Cookie")!.split(";")[0]!;
    const owner = await stepUp(call, await join(created.url));
    const invite = async (role: string) => { const g = await call("/grants", "POST", { role, label: role, expiresAt: seed.spec.lifecycle.purgeAt, confirm: true }, owner); expect(g.status).toBe(201); return join((await g.json()).url); };
    const items_ = async (cookie = owner) => (await (await call("", "GET", undefined, cookie)).json()).document.items as Stored[];
    const move = async (id: string, before: string | null, cookie = owner, version = revision) => { const res = await call("/document", "PATCH", { type: "move", id, before }, cookie, version); if (res.status === 200) revision++; return res; };
    return { call, invite, owner, items: items_, move, bump: () => { revision++; }, ids: async () => (await items_()).map(i => i.id) };
  }
  const three = () => trip([make("nine", "09:00"), make("noon", "12:00"), make("three", "15:00")]);
  test("the third item dropped before the first goes half an hour ahead of it, marked a placeholder; its version goes up and the answer says so", async () => {
    const t = await three(), before = await t.items(), r = await t.move("three", "nine");
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ revision: 2, moved: { id: "three", startsAt: utc("08:30") } });
    expect(await t.ids()).toEqual(["three", "nine", "noon", "tomorrow"]);
    const after = await t.items(); expect(after[0]).toEqual({ ...before[2]!, startsAt: utc("08:30"), timeTentative: true, revision: 2 });
    // Nothing else changed: the other items are the same objects, and the next day is where it was.
    for (const id of ["nine", "noon", "tomorrow"]) expect(after.find(i => i.id === id)).toEqual(before.find(i => i.id === id));
  });
  test("a time that already fits its new neighbours is kept, and so are the version and the mark", async () => {
    const t = await trip([make("nine", "09:00"), make("ten", "10:00"), make("untimed"), make("three", "15:00")]), r = await t.move("ten", "three");
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ revision: 2 });
    expect(await t.ids()).toEqual(["nine", "untimed", "ten", "three", "tomorrow"]); expect((await t.items())[2]).toEqual(make("ten", "10:00") as Stored);
    // A placeholder that fits stays a placeholder, and a decided time stays decided.
    const marked = await trip([make("nine", "09:00"), make("ten", "10:00", { timeTentative: true }), make("three", "15:00")]);
    expect(await (await marked.move("ten", "three")).json()).toEqual({ revision: 2 }); expect((await marked.items())[1]).toEqual(make("ten", "10:00", { timeTentative: true }) as Stored);
  });
  test("between two items: when the one before ends, an hour after it starts when it has no end, or halfway in five-minute steps when that would pass the one after", async () => {
    const wide = await three(); expect(await (await wide.move("nine", "three")).json()).toEqual({ revision: 2, moved: { id: "nine", startsAt: utc("13:00") } });
    const ends = await trip([make("nine", "09:00"), make("lunch", "12:00", { endsAt: at("12:45") }), make("three", "15:00")]);
    expect(await (await ends.move("nine", "three")).json()).toEqual({ revision: 2, moved: { id: "nine", startsAt: utc("12:45") } });
    // An end past the next start is not a place between them: halfway between the two starts.
    const overlap = await trip([make("nine", "09:00"), make("long", "12:00", { endsAt: at("16:00") }), make("three", "15:00")]);
    expect(await (await overlap.move("nine", "three")).json()).toEqual({ revision: 2, moved: { id: "nine", startsAt: utc("13:30") } });
    const tight = await trip([make("first", "10:00"), make("second", "10:20"), make("late", "18:00")]);
    expect(await (await tight.move("late", "second")).json()).toEqual({ revision: 2, moved: { id: "late", startsAt: utc("10:10") } });
    const tighter = await trip([make("first", "10:02"), make("second", "10:04"), make("late", "18:00")]);
    // Never earlier than the one before, even when the five-minute step would fall there.
    expect(await (await tighter.move("late", "second")).json()).toEqual({ revision: 2, moved: { id: "late", startsAt: utc("10:02") } });
  });
  test("dropped last: an hour after the one before (or when it ends); when that would leave the day, the same time as the one before", async () => {
    const t = await three(); expect(await (await t.move("nine", null)).json()).toEqual({ revision: 2, moved: { id: "nine", startsAt: utc("16:00") } });
    expect(await t.ids()).toEqual(["noon", "three", "nine", "tomorrow"]);
    const night = await trip([make("early", "08:00"), make("late", "23:50")]); expect(await (await night.move("early", null)).json()).toEqual({ revision: 2, moved: { id: "early", startsAt: utc("23:50") } });
    const dawn = await trip([make("first", "00:10"), make("second", "09:00")]); expect(await (await dawn.move("second", "first")).json()).toEqual({ revision: 2, moved: { id: "second", startsAt: utc("00:10") } });
  });
  test("an item without a time is given one where it was dropped, marked a placeholder; neighbours without a time are looked past", async () => {
    const t = await trip([make("nine", "09:00"), make("untimed"), make("noon", "12:00"), make("three", "15:00")]);
    expect(await (await t.move("untimed", "nine")).json()).toEqual({ revision: 2, moved: { id: "untimed", startsAt: utc("08:30") } });
    expect((await t.items())[0]).toEqual({ ...make("untimed"), startsAt: utc("08:30"), timeTentative: true, revision: 2 } as Stored);
    // Dropped between two timed items, it goes an hour after the one before.
    const between = await trip([make("nine", "09:00"), make("noon", "12:00"), make("untimed")]);
    expect(await (await between.move("untimed", "noon")).json()).toEqual({ revision: 2, moved: { id: "untimed", startsAt: utc("10:00") } });
    // "three" dropped before "nine" has only an untimed item above it, so it goes ahead of nine.
    const past = await trip([make("untimed"), make("nine", "09:00"), make("noon", "12:00"), make("three", "15:00")]);
    expect(await (await past.move("three", "nine")).json()).toEqual({ revision: 2, moved: { id: "three", startsAt: utc("08:30") } });
    expect((await past.items())[0]).toEqual(make("untimed") as Stored);
  });
  test("an item without a time in a day with no times takes 09:00 of its own zone; its end is kept only when it still comes after", async () => {
    const t = await trip([make("a"), make("b", undefined, { endsAt: at("10:00") })]);
    expect(await (await t.move("a", null)).json()).toEqual({ revision: 2, moved: { id: "a", startsAt: utc("09:00") } });
    expect(await (await t.move("b", "a")).json()).toEqual({ revision: 3, moved: { id: "b", startsAt: utc("08:30") } });
    expect((await t.items())[0]).toMatchObject({ id: "b", startsAt: utc("08:30"), endsAt: utc("10:00"), timeTentative: true });
    const late = await trip([make("nine", "09:00"), make("c", undefined, { endsAt: at("09:30") })]);
    expect(await (await late.move("c", null)).json()).toEqual({ revision: 2, moved: { id: "c", startsAt: utc("10:00") } });
    expect((await late.items())[1]).toEqual({ ...make("c"), startsAt: utc("10:00"), timeTentative: true, revision: 2 } as Stored);
    // Kept in Los Angeles time, dropped before 00:10 Tokyo time (the day before there): no neighbour's time is its day, so 09:00 in Los Angeles.
    const zones = await trip([make("tokyo", "00:10"), make("la", undefined, { timezone: "America/Los_Angeles" })]);
    expect(await (await zones.move("la", "tokyo")).json()).toEqual({ revision: 2, moved: { id: "la", startsAt: "2026-09-24T16:00:00.000Z" } });
  });
  test("an item without a time stays without one while the others of its day are moved and edited", async () => {
    const t = await trip([make("nine", "09:00"), make("untimed"), make("noon", "12:00"), make("three", "15:00")]);
    await t.move("three", "nine"); await t.move("nine", null);
    const r = await t.call("/document", "PATCH", { type: "item", item: { ...make("noon", "12:00"), title: "昼" } }, t.owner); expect(r.status).toBe(200); t.bump();
    expect((await t.items()).find(i => i.id === "untimed")).toEqual(make("untimed") as Stored);
  });
  test("a time changed by a move is marked a placeholder; an edit may keep or clear the mark, and it is read back", async () => {
    const t = await three(); await t.move("three", "nine");
    expect((await t.items())[0]).toMatchObject({ id: "three", timeTentative: true });
    const r = await t.call("/document", "PATCH", { type: "item", item: { ...make("three", "08:30") } }, t.owner); expect(r.status).toBe(200); t.bump();
    expect((await t.items())[0]).toEqual({ ...make("three", "08:30"), revision: 3 });
    expect((await t.call("/document", "PATCH", { type: "item", item: { ...make("three", "08:30"), timeTentative: true } }, t.owner)).status).toBe(200); t.bump();
    expect((await t.items())[0]).toMatchObject({ id: "three", timeTentative: true, revision: 4 });
    expect((await t.call("/document", "PATCH", { type: "item", item: { ...make("three", "08:30"), timeTentative: "yes" } }, t.owner)).status).toBe(400);
  });
  test("a suggestion added to the plan goes after its day's last item, at the time the host gives it there, marked a placeholder", async () => {
    const t = await trip([make("nine", "09:00", { endsAt: at("10:30") }), make("untimed")]);
    expect((await t.call("/document", "PATCH", { type: "suggest", author: "みどり", body: "夜は星を見たい" }, t.owner)).status).toBe(200); t.bump();
    const suggestion = (await (await t.call("", "GET", undefined, t.owner)).json()).document.suggestions.at(-1).id;
    expect((await t.call("/document", "PATCH", { type: "promote", id: suggestion, day }, t.owner)).status).toBe(200); t.bump();
    const items = await t.items(); expect(items.map(i => i.id).slice(0, 2)).toEqual(["nine", "untimed"]); expect(items.at(-1)!.id).toBe("tomorrow");
    expect(items[2]).toMatchObject({ day, startsAt: utc("10:30"), timeTentative: true, revision: 1 });
    // A day with nothing on it: 09:00. A day that is no date is refused.
    const s2 = (await t.call("/document", "PATCH", { type: "suggest", author: "みどり", body: "朝市" }, t.owner)); expect(s2.status).toBe(200); t.bump();
    const second = (await (await t.call("", "GET", undefined, t.owner)).json()).document.suggestions.at(-1).id;
    for (const bad of ["2026-09-99", "1800-01-01", "2026-09-27"]) expect((await t.call("/document", "PATCH", { type: "promote", id: second, day: bad }, t.owner)).status).toBe(400);
    expect((await t.call("/document", "PATCH", { type: "promote", id: second, day: "2026-09-26" }, t.owner)).status).toBe(200); t.bump();
    expect((await t.items()).at(-1)).toMatchObject({ day: "2026-09-26", startsAt: "2026-09-26T00:00:00.000Z", timeTentative: true });
  });
  test("removing a suggestion already added to the plan leaves its item in the plan", async () => {
    const t = await trip([make("nine", "09:00")]);
    expect((await t.call("/document", "PATCH", { type: "suggest", author: "みどり", body: "夜は星を見たい" }, t.owner)).status).toBe(200); t.bump();
    const suggestion = (await (await t.call("", "GET", undefined, t.owner)).json()).document.suggestions.at(-1).id;
    expect((await t.call("/document", "PATCH", { type: "promote", id: suggestion, day }, t.owner)).status).toBe(200); t.bump();
    expect((await t.call("/document", "PATCH", { type: "remove", list: "suggestions", id: suggestion }, t.owner)).status).toBe(200); t.bump();
    const document = (await (await t.call("", "GET", undefined, t.owner)).json()).document;
    expect(document.suggestions).toEqual([]);
    expect(document.items.map((i: { id: string }) => i.id)[0]).toBe("nine"); expect(document.items[1]).toMatchObject({ day, title: "夜は星を見たい", description: "夜は星を見たい" });
  });
  test("a time that comes out the same, or that no rule can keep inside the item's own day, is left alone: no new version, nothing reported", async () => {
    // Published out of order: noon, nine, noon. The last dropped before "nine" sits between 12:00 and 9:00; halfway is clamped to 12:00, its own time.
    const same = await trip([make("first-noon", "12:00"), make("nine", "09:00"), make("second-noon", "12:00")]);
    expect(await (await same.move("second-noon", "nine")).json()).toEqual({ revision: 2 }); expect((await same.items())[1]).toMatchObject({ id: "second-noon", startsAt: at("12:00"), revision: 1 });
    // An item kept in Los Angeles time, dropped before 0:10 Tokyo time: half an hour earlier and 0:10 itself are both the 23rd in Los Angeles.
    const zones = await trip([make("tokyo", "00:10"), make("la", undefined, { startsAt: "2026-09-24T10:00:00-07:00", timezone: "America/Los_Angeles" })]);
    const r = await zones.move("la", "tokyo"); expect(r.status).toBe(200); expect(await r.json()).toEqual({ revision: 2 });
    expect((await zones.items())[0]).toMatchObject({ id: "la", startsAt: "2026-09-24T10:00:00-07:00", revision: 1 });
  });
  test("a move that ends on the time the item already has, or that no time of its own day fits, changes no time and no version", async () => {
    // Published out of order: 12:00, 9:00, 12:00. The last one dropped before 9:00 would go to 12:30, past 9:00, so halfway: back on 12:00... which it has.
    const mixed = await trip([make("a", "12:00"), make("b", "09:00"), make("c", "12:00")]);
    expect(await (await mixed.move("c", "b")).json()).toEqual({ revision: 2 }); expect(await mixed.ids()).toEqual(["a", "c", "b", "tomorrow"]); expect((await mixed.items())[1]).toMatchObject({ startsAt: at("12:00"), revision: 1 });
    // An item on Los Angeles time dropped before 00:10 Tokyo time: half an hour earlier and 00:10 itself are both the day before in Los Angeles.
    const zones = await trip([make("tokyo", "00:10"), make("la", undefined, { timezone: "America/Los_Angeles", startsAt: "2026-09-24T10:00:00-07:00" })]);
    const r = await zones.move("la", "tokyo"); expect(r.status).toBe(200); expect(await r.json()).toEqual({ revision: 2 });
    expect(await zones.ids()).toEqual(["la", "tokyo", "tomorrow"]); expect((await zones.items())[0]).toMatchObject({ startsAt: "2026-09-24T10:00:00-07:00", revision: 1 });
  });
  test("the end moves by as much as the start", async () => {
    const t = await trip([make("nine", "09:00"), make("noon", "12:00"), make("three", "15:00", { endsAt: at("16:45") })]);
    await t.move("three", "nine"); expect((await t.items())[0]).toMatchObject({ startsAt: utc("08:30"), endsAt: utc("10:15") });
  });
  test("an id that is not there, a target on another day and an item before itself are refused and change nothing", async () => {
    const t = await three();
    for (const [id, before] of [["nobody", "nine"], ["three", "nobody"], ["three", "tomorrow"], ["three", "three"], ["tomorrow", "nine"]] as const) { const r = await t.move(id, before); expect(r.status).toBe(400); expect((await r.json()).error).toBe("予定の並びを確認してください"); }
    expect((await t.call("/document", "PATCH", { type: "move", id: "three" }, t.owner)).status).toBe(400);
    expect(await t.ids()).toEqual(["nine", "noon", "three", "tomorrow"]); expect((await (await t.call("", "GET", undefined, t.owner)).json()).document.revision).toBe(1);
    // The only item of its day dropped last stays where it is.
    expect((await t.move("tomorrow", null)).status).toBe(200); expect(await t.ids()).toEqual(["nine", "noon", "three", "tomorrow"]);
  });
  test("owner and editor move; participant, viewer and anyone after sharing ends are refused; a stale version is 409", async () => {
    const t = await three(), editor = await t.invite("editor"), participant = await t.invite("participant"), viewer = await t.invite("viewer");
    expect((await t.move("three", "nine", participant)).status).toBe(403); expect((await t.move("three", "nine", viewer)).status).toBe(403);
    expect((await t.move("three", "nine", editor)).status).toBe(200);
    expect((await t.move("noon", "three", t.owner, 1)).status).toBe(409); expect(await t.ids()).toEqual(["three", "nine", "noon", "tomorrow"]);
    expect((await t.call("/freeze", "POST", { confirm: true }, t.owner)).status).toBe(200);
    expect((await t.move("noon", "three")).status).toBe(403);
  });
  test("in the reflection window an editor still moves an item; a participant does not", async () => {
    const t = await three(), editor = await t.invite("editor"), participant = await t.invite("participant");
    now = +new Date("2026-09-27T00:00:00Z");
    expect((await t.move("three", "nine", participant)).status).toBe(403); expect((await t.move("three", "nine", editor)).status).toBe(200);
  });
  test("`order`, the operation `move` replaced, is no longer known", async () => {
    const t = await three(), r = await t.call("/document", "PATCH", { type: "order", day, ids: ["three", "nine", "noon"] }, t.owner);
    expect(r.status).toBe(400); expect(await t.ids()).toEqual(["nine", "noon", "three", "tomorrow"]);
    expect((await (await t.call("", "GET", undefined, t.owner)).json()).document.revision).toBe(1);
  });
  // 予定の間に足す: an `item` with `after` goes right after that item of its day, and the host fits its time there.
  const add = async (t: Awaited<ReturnType<typeof trip>>, item: object, after: string, cookie = t.owner) => { const r = await t.call("/document", "PATCH", { type: "item", item, after }, cookie); if (r.status === 200) t.bump(); return r; };
  test("予定の間に足す: a new item goes right after the one named; a time that fits there is kept, one that does not is fitted and reported", async () => {
    const t = await three(), fits = await add(t, make("ten", "10:00"), "nine");
    expect(fits.status).toBe(200); expect(await fits.json()).toEqual({ revision: 2 });
    expect(await t.ids()).toEqual(["nine", "ten", "noon", "three", "tomorrow"]); expect((await t.items())[1]).toEqual(make("ten", "10:00") as Stored);
    // 08:00 after the 10:00 item does not fit: an hour after it (it has no end), a placeholder, and the answer says so.
    const early = await add(t, make("early", "08:00"), "ten");
    expect(await early.json()).toEqual({ revision: 3, moved: { id: "early", startsAt: utc("11:00") } });
    expect(await t.ids()).toEqual(["nine", "ten", "early", "noon", "three", "tomorrow"]);
    expect((await t.items())[2]).toEqual({ ...make("early"), startsAt: utc("11:00"), timeTentative: true, revision: 1 } as Stored);
    // A decided time past the next item does not fit either: it is fitted between the two, and becomes a placeholder.
    const late = await trip([make("nine", "09:00"), make("noon", "12:00")]);
    expect(await (await add(late, make("y", "13:00"), "nine")).json()).toEqual({ revision: 2, moved: { id: "y", startsAt: utc("10:00") } });
    expect((await late.items())[1]).toMatchObject({ id: "y", startsAt: utc("10:00"), timeTentative: true });
    // After an item with an end: its end.
    const ends = await trip([make("nine", "09:00", { endsAt: at("09:40") }), make("noon", "12:00")]);
    expect(await (await add(ends, make("x", "07:00"), "nine")).json()).toEqual({ revision: 2, moved: { id: "x", startsAt: utc("09:40") } });
  });
  test("予定の間に足す: on a day of items at the same time the new one goes where it was asked, not last", async () => {
    const t = await trip([make("a", "10:00"), make("b", "10:00"), make("c", "10:00")]);
    expect((await add(t, make("new", "10:00"), "a")).status).toBe(200); expect(await t.ids()).toEqual(["a", "new", "b", "c", "tomorrow"]);
    // Without `after`, as before: by its time, after the last one that is not later.
    expect((await t.call("/document", "PATCH", { type: "item", item: make("plain", "10:00") }, t.owner)).status).toBe(200); t.bump();
    expect(await t.ids()).toEqual(["a", "new", "b", "c", "plain", "tomorrow"]);
  });
  test("予定の間に足す: an `after` that is not there, is on another day, or an item that already exists is refused and changes nothing", async () => {
    const t = await three();
    for (const [item, after] of [[make("x", "10:00"), "nobody"], [make("x", "10:00"), "tomorrow"], [make("noon", "10:00"), "nine"], [make("x", "10:00"), "x"]] as const) {
      const r = await add(t, item, after); expect(r.status).toBe(400); expect((await r.json()).error).toBe("予定の並びを確認してください");
    }
    expect(await t.ids()).toEqual(["nine", "noon", "three", "tomorrow"]); expect((await (await t.call("", "GET", undefined, t.owner)).json()).document.revision).toBe(1);
  });
  test("予定の間に足す: an editor may; a participant and a viewer may not", async () => {
    const t = await three(), editor = await t.invite("editor"), participant = await t.invite("participant"), viewer = await t.invite("viewer");
    expect((await add(t, make("x", "10:00"), "nine", participant)).status).toBe(403); expect((await add(t, make("x", "10:00"), "nine", viewer)).status).toBe(403);
    expect((await add(t, make("x", "10:00"), "nine", editor)).status).toBe(200); expect(await t.ids()).toEqual(["nine", "x", "noon", "three", "tomorrow"]);
  });
  test("a trip whose timeline page is switched off refuses the move", async () => {
    const t = await three(), spec = structuredClone(testTrip().spec); spec.navigation = spec.navigation.filter(n => n !== spec.modules.find(m => m.kind === "day-timeline")!.id);
    expect((await t.call("/spec", "PATCH", { spec, confirm: true }, t.owner)).status).toBe(200); t.bump();
    const r = await t.move("three", "nine"); expect(r.status).toBe(403); expect((await r.json()).error).toBe("このモジュールは無効です");
  });
});
describe("the operator's list and terminate", () => {
  // The IAM publisher (the operator) lists every live capsule and ends one; a browser's cookie can do neither.
  async function operator() {
    const db = new LocalD1(); dbs.push(db);
    const box = { identity: "aws-publisher" as string | null };
    const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin }, () => now, async () => box.identity);
    const req = (path: string, method = "GET", body?: unknown, cookie?: string) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": '"1"', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const publish = async () => { const r = await req("/v1/publish", "POST", { ...testTrip(), confirm: true }); expect(r.status).toBe(201); return await r.json() as { id: string; url: string }; };
    const list = async () => { const r = await req("/v1/capsules/list", "POST", {}); expect(r.status).toBe(200); return await r.json() as Array<Record<string, unknown>>; };
    const login = async (id: string, url: string) => (await req(`/v1/c/${id}/sessions`, "POST", { secret: new URL(url).hash.slice(3) })).headers.get("Set-Cookie")!.split(";")[0]!;
    return { db, box, req, publish, list, login };
  }

  test("lists every live capsule with its counts and nothing of the trip itself", async () => {
    const t = await operator(), a = await t.publish(), b = await t.publish();
    // The creators' registry is a row of the same table; it is no capsule.
    expect((await t.req("/v1/creators/enroll", "POST", { label: "作成者A", confirm: true })).status).toBe(201);
    t.box.identity = null; await t.login(a.id, a.url); t.box.identity = "aws-publisher";
    const listed = await t.list();
    expect(listed.map(c => c.id).sort()).toEqual([a.id, b.id].sort());
    for (const c of listed) {
      expect(Object.keys(c).sort()).toEqual(["created", "grants", "id", "kind", "members", "mustSeal", "purgeAt", "sealed", "state", "updated"]);
      expect(c).toMatchObject({ kind: "trip", state: "active", purgeAt: testTrip().spec.lifecycle.purgeAt, grants: 1 });
    }
    expect(listed.find(c => c.id === a.id)!.members).toBe(1); expect(listed.find(c => c.id === b.id)!.members).toBe(0);
    const text = JSON.stringify(listed);
    for (const word of ["テスト旅行", "集合", "destinations", "items", "label", "digest", "secret", "title"]) expect(text).not.toContain(word);
  });

  test("a browser cannot list or terminate", async () => {
    const t = await operator(), a = await t.publish();
    t.box.identity = null; const owner = await t.login(a.id, a.url);
    expect((await t.req("/v1/capsules/list", "POST", {}, owner)).status).toBe(401);
    expect((await t.req(`/v1/c/${a.id}/terminate`, "POST", { id: a.id, confirm: true }, owner)).status).toBe(401);
    expect((await t.req(`/v1/c/${a.id}`, "GET", undefined, owner)).status).toBe(200);
  });

  test("terminating needs the capsule id typed again, then the capsule is gone at once", async () => {
    const t = await operator(), a = await t.publish(), b = await t.publish();
    t.box.identity = null; const owner = await t.login(a.id, a.url); t.box.identity = "aws-publisher";
    expect((await t.req(`/v1/c/${a.id}/terminate`, "POST", { id: b.id, confirm: true })).status).toBe(400);
    expect((await t.req(`/v1/c/${a.id}/terminate`, "POST", { id: a.id })).status).toBe(400);
    expect((await t.req(`/v1/c/${a.id}`, "GET", undefined, owner)).status).toBe(200);
    expect((await t.req(`/v1/c/${a.id}/terminate`, "POST", { id: a.id, confirm: true })).status).toBe(200);
    expect((await t.req(`/v1/c/${a.id}`, "GET", undefined, owner)).status).toBe(410);
    expect((await t.req(`/v1/c/${a.id}/terminate`, "POST", { id: a.id, confirm: true })).status).toBe(410);
    expect((await t.list()).map(c => c.id)).toEqual([b.id]);
    const row = t.db.db.query("SELECT payload, purged_at FROM trip_capsules WHERE purged_at IS NOT NULL").get() as { payload: string | null; purged_at: number };
    expect(row).toEqual({ payload: null, purged_at: now });
  });

  test("a capsule stored before it held its id is listed as id null until someone writes to it", async () => {
    const t = await operator(), a = await t.publish();
    const stored = t.db.db.query("SELECT payload FROM trip_capsules WHERE owner_key IS NOT NULL").get() as { payload: string }, old = JSON.parse(stored.payload);
    delete old.id; t.db.db.query("UPDATE trip_capsules SET payload=? WHERE owner_key IS NOT NULL").run(JSON.stringify(old));
    expect((await t.list()).map(c => c.id)).toEqual([null]);
    t.box.identity = null; const owner = await t.login(a.id, a.url); t.box.identity = "aws-publisher";
    expect((await t.req(`/v1/c/${a.id}/document`, "PATCH", { type: "notes", body: "メモ" }, owner)).status).toBe(200);
    expect((await t.list()).map(c => c.id)).toEqual([a.id]);
  });
});

test("owner-approved invites hide the trip until approval; rejection keeps the seat consumed", async () => {
  const db = new LocalD1(); let identity: string | null = "creator-1", now = +new Date("2026-09-17T00:00:00Z");
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => now, async () => identity);
  const req = (path: string, method = "GET", body?: unknown, cookie?: string) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": '"1"', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  try {
    const created = await (await req("/v1/publish", "POST", { ...testTrip(), confirm: true })).json(), path = `/v1/c/${created.id}`; identity = null;
    const claim = (url: string) => req(path + "/sessions", "POST", { secret: new URL(url).hash.slice(3) });
    const owner = await stepUp((p, m, b, c) => req(path + p, m, b, c), (await claim(created.url)).headers.get("Set-Cookie")!.split(";")[0]!);
    const issue = async (body: object) => (await req(path + "/grants", "POST", { role: "participant", label: "招待", expiresAt: testTrip().spec.lifecycle.purgeAt, confirm: true, ...body }, owner));
    // The default is automatic, as before.
    const auto = await claim((await (await issue({})).json()).url); expect(await auto.json()).toEqual({ role: "participant" });
    expect((await req(path, "GET", undefined, auto.headers.get("Set-Cookie")!.split(";")[0]!)).status).toBe(200);
    // An owner's own invite cannot ask for approval.
    expect((await issue({ role: "owner", approval: "owner" })).status).toBe(400);
    const invite = await (await issue({ approval: "owner", seats: 2 })).json();
    const pending = await claim(invite.url), body = await pending.json(), cookie = pending.headers.get("Set-Cookie")!.split(";")[0]!;
    expect(body).toMatchObject({ role: "participant", pending: true }); expect(body.code).toMatch(/^\d{6}$/);
    const hidden = await req(path, "GET", undefined, cookie); expect(hidden.status).toBe(403);
    const hiddenBody = await hidden.json(); expect(hiddenBody.spec).toBeUndefined(); expect(hiddenBody.code).toBe(body.code); expect(hiddenBody.pending).toBe(true);
    expect((await req(path + "/document", "PATCH", { type: "notes", body: "x" }, cookie)).status).toBe(403);
    expect((await req(path + "/theme.css", "GET", undefined, cookie)).status).toBe(403);
    const listed = (await (await req(path + "/grants", "GET", undefined, owner)).json()).find((g: any) => g.id === invite.grantId);
    expect(listed.members[0]).toMatchObject({ pending: true, code: body.code });
    // Not the pending member, nor any non-owner, can approve.
    expect((await req(path + "/approve", "POST", { member: listed.members[0].id, approve: true, confirm: true }, cookie)).status).toBe(403);
    const ok = await req(path + "/approve", "POST", { member: listed.members[0].id, approve: true, confirm: true }, owner); expect(ok.status).toBe(200);
    expect((await req(path, "GET", undefined, cookie)).status).toBe(200);
    // A second seat is refused: it goes, and the seat does not come back.
    const second = await claim(invite.url), cookie2 = second.headers.get("Set-Cookie")!.split(";")[0]!;
    const again = (await (await req(path + "/grants", "GET", undefined, owner)).json()).find((g: any) => g.id === invite.grantId).members.find((m: any) => m.pending);
    expect((await req(path + "/approve", "POST", { member: again.id, approve: false, confirm: true }, owner)).status).toBe(200);
    expect((await req(path, "GET", undefined, cookie2)).status).toBe(401);
    expect((await claim(invite.url)).status).toBe(401);
    // Rotating an approval invite keeps its approval even when the request names none; only the owner may ask for one.
    const rotated = await (await issue({ rotate: invite.grantId })).json();
    expect((await (await claim(rotated.url)).json()).pending).toBe(true);
  } finally { db.close(); }
});

// The per-capsule count (#609): only requests that passed authentication are counted, so knowing an id is not enough to lock members out.
const asIp = (t: Awaited<ReturnType<typeof setup>>, ip: string, path: string, method: string, body?: unknown, cookie?: string) => t.host.fetch(new Request(`${origin}/v1/c/${t.created.id}${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json", "cf-connecting-ip": ip, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const secretOf = (url: string) => new URL(url).hash.slice(3);
test("a cookie-less flood does not lock members out of their trip", async () => {
  const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
  const issued = await (await t.request("/grants", "POST", { role: "participant", label: "旅行メンバー用", seats: 1, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
  const participant = await t.login(issued.url);
  for (let i = 0; i < 601; i++) {
    const ip = `10.2.${i >> 8}.${i & 255}`;
    const res = i % 2 ? await asIp(t, ip, "/passkey/challenge", "POST", {}) : await asIp(t, ip, "", "GET");
    expect(res.status).toBe(i % 2 ? 200 : 401);
  }
  expect((await asIp(t, "10.2.9.9", "", "GET", undefined, participant)).status).toBe(200);
  expect((await asIp(t, "10.2.9.9", "", "GET", undefined, owner)).status).toBe(200);
});
test("join from another address is not held back by one address's login limit", async () => {
  const t = await setup(), bad = "x".repeat(40);
  let last = 0;
  for (let i = 0; i < 16; i++) last = (await asIp(t, "10.3.0.1", "/sessions", "POST", { secret: bad })).status;
  expect(last).toBe(429);
  const joined = await asIp(t, "10.3.0.2", "/sessions", "POST", { secret: secretOf(t.created.url) });
  expect(joined.status).toBe(200); expect(joined.headers.get("Set-Cookie")).toBeTruthy();
  expect((await asIp(t, "10.3.0.1", "/sessions", "POST", { secret: secretOf(t.created.url) })).status).toBe(429);
});
test("authenticated requests are still held to 600 a minute per capsule", async () => {
  const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
  // grant:<id> allows 120 a minute, so six grants are needed to reach the capsule's 600.
  const seats: string[] = [];
  for (let i = 0; i < 6; i++) {
    const issued = await (await t.request("/grants", "POST", { role: "participant", label: "旅行メンバー用", seats: 1, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const res = await asIp(t, `10.4.0.${i}`, "/sessions", "POST", { secret: secretOf(issued.url) }); expect(res.status).toBe(200); seats.push(res.headers.get("Set-Cookie")!.split(";")[0]!);
  }
  now += 61000; // a fresh window: the setup requests above are not counted
  let first = -1;
  for (let i = 0; i < 606 && first < 0; i++) if ((await asIp(t, `10.5.${i >> 8}.${i & 255}`, "", "GET", undefined, seats[i % 6])).status === 429) first = i;
  expect(first).toBe(600);
});

describe("a creator's API key", () => {
  const apiKey = "sk-ant-api03-" + "x".repeat(40);
  function keyHost(accepts = true) {
    const db = new LocalD1(); dbs.push(db);
    const box = { identity: null as string | null }, seen: string[] = [];
    const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, VERIFY_KEY: async k => { seen.push(k); return accepts; }, ASSIST: { generate: async () => ({ kind: "text", text: "{}" }), dispatch: async () => {} } }, () => now, async () => box.identity);
    const send = (path: string, method: string, body?: unknown, cookie?: string) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const device = fakeAuthenticator();
    const signIn = async () => { const c = (await (await send("/v1/creators/challenge", "POST", {})).json()).challenge as string; return (await send("/v1/creators/session", "POST", { challenge: c, id: device.id, ...device.assert(c) })).headers.get("Set-Cookie")!.split(";")[0]!; };
    const creator = async () => {
      box.identity = "aws-publisher";
      const secret = new URL((await (await send("/v1/creators/enroll", "POST", { label: "作成者A", confirm: true })).json()).url).hash.slice("#creator=".length);
      box.identity = null;
      const c = (await (await send("/v1/creators/challenge", "POST", {})).json()).challenge as string;
      const r = await send("/v1/creators/register", "POST", { secret, challenge: c, ...device.register(c) });
      expect(r.status).toBe(201);
      return r.headers.get("Set-Cookie")!.split(";")[0]!;
    };
    const assistKey = async (cookie?: string) => (await (await send("/v1/account", "GET", undefined, cookie)).json()).assistKey as boolean;
    return { host, db, box, seen, send, creator, signIn, assistKey };
  }
  test("creator step-up: five minutes after signing in, the key is neither replaced nor deleted until the creator signs in again", async () => {
    const t = keyHost(), cookie = await t.creator(), other = "sk-ant-api03-" + "w".repeat(40);
    expect((await t.send("/v1/account/key", "PUT", { key: apiKey }, cookie)).status).toBe(204);
    const stored = () => t.db.db.query("SELECT subject, sealed FROM creator_keys").all(), before = stored();
    now += 5 * 60000;
    for (const r of [await t.send("/v1/account/key", "PUT", { key: other }, cookie), await t.send("/v1/account/key", "DELETE", undefined, cookie)]) {
      expect(r.status).toBe(428); expect((await r.json()).error).toBe("パスキーで本人確認してください");
    }
    expect(stored()).toEqual(before); expect(t.seen).toEqual([apiKey]);
    // The rest of a creator's day goes on with the same cookie: the account, and a generation with the key.
    expect(await t.assistKey(cookie)).toBe(true);
    expect((await t.send("/v1/assist", "POST", { text: "京都 2泊3日" }, cookie)).status).toBe(202);
    // Signing in again is the check.
    const fresh = await t.signIn();
    expect((await t.send("/v1/account/key", "PUT", { key: other }, fresh)).status).toBe(204); expect(t.seen).toEqual([apiKey, other]);
    expect((await t.send("/v1/account/key", "DELETE", undefined, fresh)).status).toBe(204); expect(stored()).toEqual([]);
  });
  test("creator step-up: the IAM publisher's identity is no cookie and is not asked", async () => {
    const t = keyHost(); t.box.identity = "aws-publisher";
    expect((await t.send("/v1/account/key", "PUT", { key: apiKey })).status).toBe(204);
    now += 60 * 60000;
    expect((await t.send("/v1/account/key", "PUT", { key: apiKey })).status).toBe(204);
    expect((await t.send("/v1/account/key", "DELETE")).status).toBe(204);
  });
  test("registering shows only that a key exists; the value is in no response and not stored in the clear", async () => {
    const t = keyHost(), cookie = await t.creator();
    expect(await t.assistKey(cookie)).toBe(false);
    const put = await t.send("/v1/account/key", "PUT", { key: apiKey }, cookie);
    expect(put.status).toBe(204); expect(await put.text()).toBe("");
    expect(t.seen).toEqual([apiKey]);
    const account = await t.send("/v1/account", "GET", undefined, cookie), text = await account.text();
    expect(JSON.parse(text).assistKey).toBe(true); expect(text).not.toContain("sk-ant");
    const stored = t.db.db.query("SELECT subject, sealed FROM creator_keys").all() as { subject: string; sealed: string }[];
    expect(stored).toHaveLength(1); expect(JSON.stringify(stored)).not.toContain("sk-ant");
    expect(Buffer.from(stored[0]!.sealed, "base64url").toString("latin1")).not.toContain("sk-ant");
    expect(await t.assistKey()).toBe(false);
  });
  test("a key Anthropic refuses is 400 and stores nothing", async () => {
    const t = keyHost(false), cookie = await t.creator();
    const r = await t.send("/v1/account/key", "PUT", { key: apiKey }, cookie);
    expect(r.status).toBe(400); expect((await r.json()).error).toContain("この API キーは使えません");
    expect(await t.assistKey(cookie)).toBe(false);
  });
  test("without a sign-in it is 401; a wrong shape is 400 and is not sent to Anthropic", async () => {
    const t = keyHost(), cookie = await t.creator();
    expect((await t.send("/v1/account/key", "PUT", { key: apiKey })).status).toBe(401);
    expect((await t.send("/v1/account/key", "DELETE")).status).toBe(401);
    for (const body of [{ key: "sk-ant-x" }, { key: "not-an-anthropic-key-at-all" }, { key: apiKey, extra: 1 }, {}])
      expect((await t.send("/v1/account/key", "PUT", body, cookie)).status).toBe(400);
    expect(t.seen).toEqual([]);
  });
  test("deleting removes it", async () => {
    const t = keyHost(), cookie = await t.creator();
    await t.send("/v1/account/key", "PUT", { key: apiKey }, cookie);
    expect((await t.send("/v1/account/key", "DELETE", undefined, cookie)).status).toBe(204);
    expect(await t.assistKey(cookie)).toBe(false);
    expect(t.db.db.query("SELECT * FROM creator_keys").all()).toHaveLength(0);
  });
  test("revoking the creator removes the key", async () => {
    const t = keyHost(), cookie = await t.creator();
    await t.send("/v1/account/key", "PUT", { key: apiKey }, cookie);
    t.box.identity = "aws-publisher";
    const creators = await (await t.send("/v1/creators/list", "POST", {})).json() as { id: string }[];
    expect((await t.send("/v1/creators/revoke", "POST", { creator: creators[0]!.id, confirm: true })).status).toBe(200);
    expect(t.db.db.query("SELECT * FROM creator_keys").all()).toHaveLength(0);
  });
  test("an outage reaching Anthropic is 502, and the attempts are limited", async () => {
    const db = new LocalD1(); dbs.push(db);
    const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, VERIFY_KEY: async () => { throw new Error("offline"); } }, () => now, async () => "aws-publisher");
    const put = () => host.fetch(new Request(origin + "/v1/account/key", { method: "PUT", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ key: apiKey }) }));
    // The publisher's identity holds a key of its own (the local-development case).
    const first = await put(); expect(first.status).toBe(502);
    for (let i = 0; i < 4; i++) await put();
    expect((await put()).status).toBe(429);
  });
});

describe("creator key expires", () => {
  const apiKey = "sk-ant-api03-" + "k".repeat(40), DAY = 86400000;
  function keysHost(KEYS?: import("./key-store").KeyStore) {
    const db = new LocalD1(); dbs.push(db);
    const logs: { reason: string }[] = [];
    const host = new CloudHost({ DB: db, ...(KEYS ? { KEYS } : {}), CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, VERIFY_KEY: async () => true, ASSIST: { generate: async () => ({ kind: "text", text: "{}" }), dispatch: async () => {} } }, () => now, async () => "creator-1");
    host.log = line => logs.push(line);
    const send = (path: string, method = "GET", body?: unknown) => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const assistKey = async () => (await (await send("/v1/account")).json()).assistKey as boolean;
    const keys = () => db.db.query("SELECT subject FROM creator_keys").all();
    return { host, db, logs, send, assistKey, keys };
  }
  test("a key unused for 30 days is gone", async () => {
    const t = keysHost();
    expect((await t.send("/v1/account/key", "PUT", { key: apiKey })).status).toBe(204);
    now += 30 * DAY; await t.host.sweep(now);
    expect(t.keys()).toHaveLength(0);
    expect(await t.assistKey()).toBe(false);
    const r = await t.send("/v1/assist", "POST", { text: "京都 2泊3日" });
    expect(r.status).toBe(412); expect((await r.json()).error).toBe("Anthropic の API キーを登録してください");
  });
  test("a generation keeps the key", async () => {
    const t = keysHost();
    await t.send("/v1/account/key", "PUT", { key: apiKey });
    now += 29 * DAY; expect((await t.send("/v1/assist", "POST", { text: "京都 2泊3日" })).status).toBe(202);
    now += 29 * DAY; await t.host.sweep(now);
    expect(t.keys()).toHaveLength(1); expect(await t.assistKey()).toBe(true);
    now += DAY; await t.host.sweep(now);
    expect(t.keys()).toHaveLength(0); expect(await t.assistKey()).toBe(false);
  });
  test("under 30 days stays", async () => {
    const t = keysHost();
    await t.send("/v1/account/key", "PUT", { key: apiKey });
    now += 30 * DAY - 1; await t.host.sweep(now);
    expect(t.keys()).toHaveLength(1); expect(await t.assistKey()).toBe(true);
  });
  test("the publisher identity's key expires too; a seat's key does not", async () => {
    // setup() asks with the publisher's identity on every request, so its /v1/account/key is that identity's key.
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    t.host.env.VERIFY_KEY = async () => true;
    const put = (path: string) => t.host.fetch(new Request(origin + path, { method: "PUT", headers: { Origin: origin, "Content-Type": "application/json", Cookie: owner }, body: JSON.stringify({ key: apiKey }) }));
    expect((await put("/v1/account/key")).status).toBe(204);
    expect((await t.request("/key", "PUT", { key: apiKey }, owner)).status).toBe(204);
    const seatKeys = () => (JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules WHERE payload IS NOT NULL").get() as { payload: string }).payload).sessions as { assistKey?: string }[]).map(s => s.assistKey ?? null);
    const before = seatKeys(); expect(before.filter(Boolean)).toHaveLength(1);
    now += 30 * DAY; await t.host.sweep(now);
    expect(t.db.db.query("SELECT * FROM creator_keys").all()).toHaveLength(0);
    expect(seatKeys()).toEqual(before);
  });
  test("a failing touch still answers the started generation", async () => {
    const keysDb = new LocalD1(); dbs.push(keysDb);
    const failing = new (class extends (await import("./key-store")).LocalKeyStore { async touch(): Promise<void> { throw new Error("AccessDeniedException"); } })(keysDb, () => now);
    const t = keysHost(failing);
    expect((await t.send("/v1/account/key", "PUT", { key: apiKey })).status).toBe(204);
    const r = await t.send("/v1/assist", "POST", { text: "京都 2泊3日" });
    expect(r.status).toBe(202); expect((await r.json()).id).toMatch(/^[a-f0-9]{32}$/);
    expect(t.logs.map(l => l.reason)).toEqual(["touch:keys"]);
    expect(JSON.stringify(t.logs)).not.toContain("creator-1");
  });
  test("a failing key sweep leaves the trip sweep done", async () => {
    const keysDb = new LocalD1(); dbs.push(keysDb);
    const failing = new (class extends (await import("./key-store")).LocalKeyStore { async sweep(): Promise<void> { throw new Error("AccessDeniedException"); } })(keysDb);
    const t = keysHost(failing);
    expect((await t.send("/v1/publish", "POST", { ...testTrip(), confirm: true })).status).toBe(201);
    now = +new Date(testTrip().spec.lifecycle.purgeAt);
    await t.host.sweep(now);
    expect(t.db.db.query("SELECT payload FROM trip_capsules").all()).toEqual([{ payload: null }]);
    expect(t.logs.map(l => l.reason)).toEqual(["sweep:keys"]);
    expect(JSON.stringify(t.logs)).not.toContain("creator-1");
  });
});

test("a key registration that was verifying while its creator was revoked stores nothing", async () => {
  const db = new LocalD1(); dbs.push(db);
  const box = { identity: null as string | null }; let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, VERIFY_KEY: async () => { await gate; return true; } }, () => now, async () => box.identity);
  const send = (path: string, body: unknown, cookie?: string, method = "POST") => host.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }));
  box.identity = "aws-publisher";
  const secret = new URL((await (await send("/v1/creators/enroll", { label: "作成者A", confirm: true })).json()).url).hash.slice("#creator=".length);
  box.identity = null;
  const device = fakeAuthenticator(), c = (await (await send("/v1/creators/challenge", {})).json()).challenge as string;
  const reg = await send("/v1/creators/register", { secret, challenge: c, ...device.register(c) });
  const cookie = reg.headers.get("Set-Cookie")!.split(";")[0]!;
  const pending = send("/v1/account/key", { key: "sk-ant-api03-" + "z".repeat(40) }, cookie, "PUT");
  box.identity = "aws-publisher";
  const creators = await (await send("/v1/creators/list", {})).json() as { id: string }[];
  expect((await send("/v1/creators/revoke", { creator: creators[0]!.id, confirm: true })).status).toBe(200);
  release();
  expect((await pending).status).toBe(401);
  expect(db.db.query("SELECT * FROM creator_keys").all()).toHaveLength(0);
});

describe("assist", () => {
  const apiKey = "sk-ant-api03-" + "y".repeat(40);
  type Gen = (apiKey: string, model: string, text: string, follow?: { answer: string; problems: string[] }) => Promise<import("./assist").Generated>;
  function assistHost(generate: Gen = async () => ({ kind: "text", text: JSON.stringify(testTrip()) }), identityOf = (_: Request) => "creator-1" as string | null) {
    const db = new LocalD1(); dbs.push(db);
    const dispatched: string[] = [], logs: unknown[] = [], calls: { apiKey: string; model: string; text: string }[] = [];
    const host = new CloudHost({
      DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, CAPSULE_ASSIST_MODEL: "claude-test",
      VERIFY_KEY: async () => true,
      ASSIST: { generate: (k, m, t, _s, f) => { calls.push({ apiKey: k, model: m, text: t }); return generate(k, m, t, f); }, dispatch: async id => { dispatched.push(id); } },
    }, () => now, async req => identityOf(req));
    host.log = line => logs.push(line);
    const as = (identity: string | null) => async (path: string, method = "GET", body?: unknown) => {
      const h = new CloudHost(host.env, () => now, async () => identity); h.log = host.log;
      return h.fetch(new Request(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    };
    const send = as("creator-1");
    return { host, db, send, as, dispatched, logs, calls };
  }
  const register = async (t: ReturnType<typeof assistHost>, who = "creator-1") => expect((await t.as(who)("/v1/account/key", "PUT", { key: apiKey })).status).toBe(204);
  const start = async (t: ReturnType<typeof assistHost>, text = "京都 2泊3日", who = "creator-1") => t.as(who)("/v1/assist", "POST", { text });

  test("without a registered key it is 412, and without a sign-in 401", async () => {
    const t = assistHost();
    expect((await start(t)).status).toBe(412);
    expect((await t.as(null)("/v1/assist", "POST", { text: "x" })).status).toBe(401);
    expect((await t.as(null)("/v1/assist/" + "a".repeat(32))).status).toBe(401);
  });
  test("a wish over 6,000 bytes is 413 and starts nothing", async () => {
    const t = assistHost(); await register(t);
    expect((await start(t, "あ".repeat(2001))).status).toBe(413);
    expect((await start(t, "あ".repeat(2000))).status).toBe(202);
    expect(t.dispatched).toHaveLength(1);
  });
  test("a generated trip is checked like a paste and handed back with the same shape", async () => {
    const t = assistHost(); await register(t);
    const accepted = await start(t); expect(accepted.status).toBe(202);
    const { id } = await accepted.json() as { id: string };
    expect(t.dispatched).toEqual([id]);
    expect(await (await t.send("/v1/assist/" + id)).json()).toEqual({ state: "running" });
    await t.host.runAssist(id);
    expect(t.calls).toEqual([{ apiKey, model: "claude-test", text: "今日は 2026-09-16 です。\n\n京都 2泊3日" }]);
    const done = await (await t.send("/v1/assist/" + id)).json() as any;
    const pasted = await (await t.send("/v1/check", "POST", { text: JSON.stringify(testTrip()) })).json() as any;
    expect(done.state).toBe("done"); expect(done.result.ok).toBe(true); expect(done.result).toEqual(pasted);
    // The wish does not stay in the row once the answer is in.
    expect(JSON.stringify(t.db.db.query("SELECT payload FROM trip_capsules").all())).not.toContain("京都 2泊3日");
  });
  test("a broken answer comes back with the same Japanese messages as /v1/check", async () => {
    const broken = { ...testTrip(), spec: { ...testTrip().spec, schemaVersion: 99 } };
    const t = assistHost(async () => ({ kind: "text", text: JSON.stringify(broken) })); await register(t);
    const { id } = await (await start(t)).json() as { id: string };
    await t.host.runAssist(id);
    const done = await (await t.send("/v1/assist/" + id)).json() as any, pasted = await (await t.send("/v1/check", "POST", { text: JSON.stringify(broken) })).json() as any;
    expect(done.result.ok).toBe(false); expect(done.result.messages.length).toBeGreaterThan(0); expect(done.result).toEqual(pasted);
  });
  test("a cut-off answer, a refusal and an API error each end the job", async () => {
    for (const [gen, check] of [
      [async () => ({ kind: "cut-off" as const }), (r: any) => { expect(r.state).toBe("done"); expect(r.result).toEqual({ ok: false, reason: "cut-off" }); }],
      [async () => ({ kind: "refused" as const }), (r: any) => { expect(r.state).toBe("failed"); expect(r.message).toContain("旅程を作れませんでした"); }],
      [async () => { throw Object.assign(new Error("secret detail sk-ant-leak"), { status: 401 }); }, (r: any) => { expect(r.state).toBe("failed"); expect(JSON.stringify(r)).not.toContain("secret detail"); expect(r.message).toContain("鍵を登録し直してください"); }],
    ] as [Gen, (r: any) => void][]) {
      const t = assistHost(gen); await register(t);
      const { id } = await (await start(t)).json() as { id: string };
      await t.host.runAssist(id);
      check(await (await t.send("/v1/assist/" + id)).json());
    }
  });
  test("a refusal by the API says its status and type to the key's owner and to the log, not the wish", async () => {
    const t = assistHost(async () => { throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "output_config: Schema is too complex for compilation." } } as never, "400 Schema is too complex for compilation.", new Headers()); }); await register(t);
    const { id } = await (await start(t, "秘密の希望")).json() as { id: string };
    await t.host.runAssist(id);
    const failed = await (await t.send("/v1/assist/" + id)).json() as { state: string; message: string };
    expect(failed.state).toBe("failed"); expect(failed.message).toContain("400 invalid_request_error"); expect(failed.message).toContain("too complex");
    expect(JSON.stringify(t.logs)).toContain("anthropic:invalid_request_error"); expect(JSON.stringify(t.logs)).not.toContain("秘密の希望");
  });
  test("an answer the host's check refuses is told back once, and the repaired one is used", async () => {
    const seen: Array<{ follow?: { answer: string; problems: string[] } }> = [];
    const broken = { ...testTrip(), spec: { ...testTrip().spec, schemaVersion: 99 } };
    const t = assistHost(async (_k, _m, _t, follow) => { seen.push({ follow }); return { kind: "text", text: JSON.stringify(follow ? testTrip() : broken) }; });
    t.host.env.ASSIST!.generate = async (k, m, text, _s, follow) => { seen.push({ follow }); t.calls.push({ apiKey: k, model: m, text }); return { kind: "text", text: JSON.stringify(follow ? testTrip() : broken) }; };
    await register(t);
    const { id } = await (await start(t)).json() as { id: string };
    await t.host.runAssist(id);
    expect(seen).toHaveLength(2); expect(seen[0]!.follow).toBeUndefined(); expect(seen[1]!.follow!.problems.length).toBeGreaterThan(0);
    const done = await (await t.send("/v1/assist/" + id)).json() as { state: string; result: { ok: boolean } };
    expect(done.state).toBe("done"); expect(done.result.ok).toBe(true);
  });
  test("a repair that fails leaves the first answer, shown with what was wrong with it", async () => {
    const broken = { ...testTrip(), spec: { ...testTrip().spec, schemaVersion: 99 } };
    const t = assistHost(); await register(t);
    let n = 0;
    t.host.env.ASSIST!.generate = async () => { if (n++ === 0) return { kind: "text", text: JSON.stringify(broken) }; throw Object.assign(new Error("overloaded"), { status: 529 }); };
    const { id } = await (await start(t)).json() as { id: string };
    await t.host.runAssist(id);
    const done = await (await t.send("/v1/assist/" + id)).json() as { state: string; result: { ok: boolean; messages: string[] } };
    expect(n).toBe(2);  // the repair was tried
    expect(done.state).toBe("done"); expect(done.result.ok).toBe(false); expect(done.result.messages.length).toBeGreaterThan(0);
  });
  test("an empty first answer is not echoed back as an assistant turn", async () => {
    const t = assistHost(); await register(t);
    let n = 0;
    t.host.env.ASSIST!.generate = async () => { n++; return { kind: "text", text: "  " }; };
    const { id } = await (await start(t)).json() as { id: string };
    await t.host.runAssist(id);
    expect(n).toBe(1);
    expect(((await (await t.send("/v1/assist/" + id)).json()) as { result: { ok: boolean } }).result.ok).toBe(false);
  });
  test("an answer that is fine the first time is asked for once", async () => {
    const t = assistHost(); await register(t);
    const { id } = await (await start(t)).json() as { id: string };
    await t.host.runAssist(id);
    expect(t.calls).toHaveLength(1);
  });
  test("a new trip is asked for with one answer and nobody to ask, and today's date first", async () => {
    const t = assistHost(); await register(t);
    let seen: { text: string; system?: string } = { text: "" };
    t.host.env.ASSIST!.generate = async (_k, _m, text, system) => { seen = { text, system }; return { kind: "text", text: JSON.stringify(testTrip()) }; };
    const { id } = await (await start(t, "福岡 1泊2日")).json() as { id: string };
    await t.host.runAssist(id);
    expect(seen.text.startsWith("今日は 2026-09-16 です。")).toBe(true); expect(seen.text).toContain("福岡 1泊2日");
    expect(seen.system).toContain(recipe.text); expect(seen.system).toContain("質問や確認はせず"); expect(seen.system).toContain("予定（document.items）を具体的に"); expect(seen.system).toContain("今日以降のもの（その月が過ぎていれば来年のその月）");
  });
  test("two a minute and one at a time per creator", async () => {
    const t = assistHost(); await register(t);
    const first = await (await start(t)).json() as { id: string };
    const second = await start(t); expect(second.status).toBe(429); expect((await second.json() as any).error).toContain("前の生成が終わるまで");
    await t.host.runAssist(first.id);
    const third = await (await start(t)).json() as { id: string };
    await t.host.runAssist(third.id);
    expect((await start(t)).status).toBe(429);  // the third in a minute
    now += 61000;
    expect((await start(t)).status).toBe(202);
  });
  test("only two run on the host at once; a slot frees when a job ends", async () => {
    const t = assistHost(); for (const who of ["a", "b", "c"]) await register(t, who);
    const a = await (await start(t, "x", "a")).json() as { id: string };
    const b = await (await start(t, "x", "b")).json() as { id: string };
    const third = await start(t, "x", "c"); expect(third.status).toBe(429); expect((await third.json() as any).error).toContain("混み合っています");
    await t.host.runAssist(a.id);
    expect((await start(t, "x", "c")).status).toBe(202);
    await t.host.runAssist(b.id);
  });
  test("another creator cannot read a job; a job past its deadline reads as failed and frees its place", async () => {
    const t = assistHost(); await register(t); await register(t, "creator-2");
    const { id } = await (await start(t)).json() as { id: string };
    expect((await t.as("creator-2")("/v1/assist/" + id)).status).toBe(404);
    expect((await t.send("/v1/assist/" + "0".repeat(32))).status).toBe(404);
    now += 361000;
    const late = await (await t.send("/v1/assist/" + id)).json() as any;
    expect(late.state).toBe("failed"); expect(late.message).toContain("生成に失敗しました");
    expect((await start(t)).status).toBe(202);
  });
  test("the wish, the key and the answer never reach the host log", async () => {
    const t = assistHost(async (k) => { throw Object.assign(new Error(`rejected ${k} 秘密の希望`), { status: 401 }); }); await register(t);
    const { id } = await (await start(t, "秘密の希望")).json() as { id: string };
    await t.host.runAssist(id);
    expect((await t.as(null)("/v1/assist", "POST", { text: "x" })).status).toBe(401);
    const failed = await t.send("/v1/assist/" + id), text = await failed.text();
    expect(JSON.parse(text).state).toBe("failed");
    for (const seen of [JSON.stringify(t.logs), text, JSON.stringify(t.db.db.query("SELECT payload FROM trip_capsules").all())]) {
      expect(seen).not.toContain("秘密の希望"); expect(seen).not.toContain("sk-ant"); expect(seen).not.toContain(apiKey);
    }
  });
  test("a generation does not appear in the operator's capsule list", async () => {
    const t = assistHost(); await register(t);
    await start(t);
    const list = await t.as("operator")("/v1/capsules/list", "POST", {});
    expect(list.status).toBe(200); expect(await list.json()).toEqual([]);
  });
});

describe("revising on the host with a member's own API key", () => {
  const ownerKey = "sk-ant-api03-" + "o".repeat(40), editorKey = "sk-ant-api03-" + "e".repeat(40);
  async function room() {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const invite = async (role: string) => t.login((await (await t.request("/grants", "POST", { role, label: role, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    const editor = await invite("editor"), participant = await invite("participant"), viewer = await invite("viewer");
    const calls: { apiKey: string; text: string; system?: string }[] = [], dispatched: string[] = [];
    t.host.env.VERIFY_KEY = async () => true;
    t.host.env.ASSIST = { generate: async (apiKey, _m, text, system) => { calls.push({ apiKey, text, system }); return { kind: "text", text: answer }; }, dispatch: async id => { dispatched.push(id); } };
    const put = (cookie: string, k: string) => t.request("/key", "PUT", { key: k }, cookie);
    const has = async (cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()).assistKey as boolean;
    return { ...t, owner, editor, participant, viewer, calls, dispatched, put, has };
  }
  const trip = structuredClone(revisable(testTrip().spec, testTrip().document)); trip.document.items[1]!.startsAt = "2026-09-25T18:30:00+09:00";
  const answer = JSON.stringify(trip);

  test("an owner or editor registers a key of their own; only that seat sees it is set, and no response carries it", async () => {
    const t = await room();
    expect(await t.has(t.editor)).toBe(false);
    expect((await t.put(t.editor, editorKey)).status).toBe(204);
    expect(await t.has(t.editor)).toBe(true); expect(await t.has(t.owner)).toBe(false);
    const members = await (await t.request("/grants", "GET", undefined, t.owner)).text();
    expect(members).not.toContain("assistKey"); expect(members).not.toContain("sk-ant");
    const stored = JSON.stringify(t.db.db.query("SELECT payload FROM trip_capsules").all());
    expect(stored).not.toContain(editorKey);
    expect(await (await t.request("", "GET", undefined, t.editor)).text()).not.toContain("sk-ant");
  });
  test("a participant and a viewer cannot register a key or revise; a bad key is refused", async () => {
    const t = await room();
    for (const cookie of [t.participant, t.viewer]) {
      expect((await t.put(cookie, editorKey)).status).toBe(403);
      expect((await t.request("/revise/assist", "POST", { instruction: "x" }, cookie)).status).toBe(403);
    }
    t.host.env.VERIFY_KEY = async () => false;
    expect((await t.put(t.editor, editorKey)).status).toBe(400);
    expect((await t.put(t.editor, "sk-ant-x")).status).toBe(400);
    expect(await t.has(t.editor)).toBe(false);
  });
  test("without a key it is 412", async () => {
    const t = await room();
    expect((await t.request("/revise/assist", "POST", { instruction: "夕食を18:30に" }, t.editor)).status).toBe(412);
  });
  test("the revision is made with the asking seat's key alone, and its answer goes through the same revise/check", async () => {
    const t = await room();
    await t.put(t.owner, ownerKey); await t.put(t.editor, editorKey);
    const started = await t.request("/revise/assist", "POST", { instruction: "夕食を18:30にして" }, t.editor);
    expect(started.status).toBe(202);
    const { id } = await started.json() as { id: string };
    expect(await (await t.request(`/revise/assist/${id}`, "GET", undefined, t.editor)).json()).toEqual({ state: "running" });
    await t.host.runAssist(id);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.apiKey).toBe(editorKey); expect(t.calls[0]!.apiKey).not.toBe(ownerKey);
    expect(t.calls[0]!.text).toContain("夕食を18:30にして"); expect(t.calls[0]!.text).toContain("編集者が直します");
    // The owner cannot read the editor's job; the editor cannot read the owner's.
    expect((await t.request(`/revise/assist/${id}`, "GET", undefined, t.owner)).status).toBe(404);
    const done = await (await t.request(`/revise/assist/${id}`, "GET", undefined, t.editor)).json() as { state: string; result: { ok: boolean; text: string } };
    expect(done.state).toBe("done"); expect(done.result.ok).toBe(true);
    const checked = await (await t.request("/revise/check", "POST", { text: done.result.text }, t.editor)).json() as { ok: boolean; diff: { items: unknown[] } };
    expect(checked.ok).toBe(true); expect(checked.diff.items.length).toBeGreaterThan(0);
    // The owner's own revision uses the owner's key.
    const own = await (await t.request("/revise/assist", "POST", { instruction: "" }, t.owner)).json() as { id: string };
    await t.host.runAssist(own.id);
    expect(t.calls[1]!.apiKey).toBe(ownerKey);
  });
  test("the creator's stored key is never used for a member, and another seat's key cannot be opened", async () => {
    const t = await room();
    // A key kept for a creator (what #76 stores) with the same subject shape tried by hand: the member route has no key of its own.
    await t.host.keys.put("creator-x", sealKey(key, "creator-x", "sk-ant-api03-" + "c".repeat(40)));
    expect((await t.request("/revise/assist", "POST", { instruction: "" }, t.editor)).status).toBe(412);
    expect(t.calls).toHaveLength(0);
    await t.put(t.editor, editorKey);
    const sealedOf = (cookie: string) => { void cookie; const row = t.db.db.query("SELECT payload FROM trip_capsules WHERE owner_key IS NOT NULL").all() as { payload: string }[]; return row.flatMap(r => (JSON.parse(r.payload).sessions ?? []) as { id: string; assistKey?: string }[]).find(x => x.assistKey)!; };
    const seat = sealedOf(t.editor);
    expect(() => openKey(key, `${t.created.id}:someone-else`, seat.assistKey!)).toThrow();
    expect(openKey(key, `${t.created.id}:${seat.id}`, seat.assistKey!)).toBe(editorKey);
  });
  test("a seat revoked after the request does not get its key used, and the sealed copy leaves the job", async () => {
    const t = await room();
    await t.put(t.editor, editorKey);
    const { id } = await (await t.request("/revise/assist", "POST", { instruction: "" }, t.editor)).json() as { id: string };
    const grants = await (await t.request("/grants", "GET", undefined, t.owner)).json() as Array<{ id: string; role: string }>;
    const grant = grants.find(g => g.role === "editor")!;
    expect((await t.request("/revoke", "POST", { id: grant.id, confirm: true }, t.owner)).status).toBe(200);
    await t.host.runAssist(id);
    expect(t.calls).toHaveLength(0);
    const row = await t.host.store.get(t.host.digest(`assist:${id}`));
    expect(row!.payload).not.toContain("sealed"); expect(JSON.parse(row!.payload!).state).toBe("failed");
  });
  test("a job whose sealed key is not the seat's current one, or whose key was deleted, is not run", async () => {
    const t = await room();
    await t.put(t.editor, editorKey); await t.put(t.owner, ownerKey);
    const jobOf = async (cookie: string) => (await (await t.request("/revise/assist", "POST", { instruction: "" }, cookie)).json() as { id: string }).id;
    // The owner's sealed copy put into the editor's job: it is not what the editor's seat holds, so it is not used.
    const swapped = await jobOf(t.editor);
    const ownerSeat = (JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules").all() as { payload: string }[])[0]!.payload).sessions as { assistKey?: string }[]).filter(x => x.assistKey);
    const jobKey = t.host.digest(`assist:${swapped}`), row = (await t.host.store.get(jobKey))!, job = JSON.parse(row.payload!);
    job.sealed = ownerSeat.find(x => x.assistKey !== job.sealed)!.assistKey;
    expect(await t.host.store.save(row, JSON.stringify(job), row.purge_at, now)).toBe(true);
    await t.host.runAssist(swapped);
    expect(t.calls).toHaveLength(0);
    // The key deleted after the request is not used either.
    now += 61000;
    const deleted = await jobOf(t.editor);
    await t.request("/key", "DELETE", {}, t.editor);
    await t.host.runAssist(deleted);
    expect(t.calls).toHaveLength(0);
  });
  test("a revision whose first answer the host refuses is repaired once from what was found wrong", async () => {
    const t = await room(); await t.put(t.editor, editorKey);
    const turns: Array<string[] | undefined> = [];
    t.host.env.ASSIST!.generate = async (_k, _m, _t, _s, follow) => { turns.push(follow?.problems); return { kind: "text", text: follow ? answer : '{"spec":{},"document":{}}' }; };
    const { id } = await (await t.request("/revise/assist", "POST", { instruction: "夕食を18:30に" }, t.editor)).json() as { id: string };
    await t.host.runAssist(id);
    expect(turns).toHaveLength(2); expect(turns[0]).toBeUndefined(); expect(turns[1]!.length).toBeGreaterThan(0);
    const done = await (await t.request(`/revise/assist/${id}`, "GET", undefined, t.editor)).json() as { state: string; result: { ok: boolean; text: string } };
    expect(done.state).toBe("done"); expect(done.result.text).toBe(answer);
  });
  test("a revision is told it answers once without asking, and has today's date first", async () => {
    const t = await room(); await t.put(t.editor, editorKey);
    let seen: { text: string; system?: string } = { text: "" };
    t.host.env.ASSIST!.generate = async (_k, _m, text, system) => { seen = { text, system }; return { kind: "text", text: answer }; };
    const { id } = await (await t.request("/revise/assist", "POST", { instruction: "夕食を18:30に" }, t.editor)).json() as { id: string };
    await t.host.runAssist(id);
    expect(seen.text.startsWith("今日は 2026-09-16 です。")).toBe(true); expect(seen.text).toContain("夕食を18:30に");
    expect(seen.system).toContain("質問や確認はせず"); expect(seen.system).toContain("今の旅程の日付の中に収める");
    expect(seen.system).not.toContain("今日以降のもの");  // a revision keeps to the trip's own dates
  });
  test("a finished job keeps neither the wish nor the sealed key", async () => {
    const t = await room();
    await t.put(t.editor, editorKey);
    const { id } = await (await t.request("/revise/assist", "POST", { instruction: "秘密の指示" }, t.editor)).json() as { id: string };
    await t.host.runAssist(id);
    const row = await t.host.store.get(t.host.digest(`assist:${id}`));
    expect(row!.payload).not.toContain("秘密の指示"); expect(row!.payload).not.toContain('"sealed"');
  });
  test("deleting the key stops it; a frozen trip cannot be revised", async () => {
    const t = await room();
    await t.put(t.editor, editorKey);
    expect((await t.request("/key", "DELETE", {}, t.editor)).status).toBe(204);
    expect(await t.has(t.editor)).toBe(false);
    expect((await t.request("/revise/assist", "POST", { instruction: "" }, t.editor)).status).toBe(412);
  });
});

// The names a seal brings with the trip (src/trip-keys.ts sealMove): every footprint, member and invite, read as the owner's
// browser reads them just before (docs/design/trip-e2e.md §5).
async function moveNames(t: Awaited<ReturnType<typeof setup>>, trip: CryptoKey, owner: string) {
  const view = await (await t.request("", "GET", undefined, owner)).json(), grants = await (await t.request("/grants", "GET", undefined, owner)).json();
  const { footprints, members, grants: named } = await sealMove(trip, t.created.id, 1, { spec: view.spec, document: view.document, previous: null, footprints: view.footprints, grants });
  return { footprints, members, grants: named };
}
describe("sealed trip", () => {
  // As the owner's browser does it (src/trip-keys.ts): a trip key put on its seat (PATCH keys), the trip it reads sealed under
  // that key, then POST seal. Before sealing, the plan gets words of every kind, so a leak shows in the stored payload.
  const words = ["テスト旅行", "行き先未定", "集合", "夕食", "公園の散歩", "駅前の広場", "朝市に行きたい", "宿代", "98765", "集合場所を決める", "旅のしおり"];
  const fake = () => `v1.1.${b64(crypto.getRandomValues(new Uint8Array(40)))}`;
  async function sealable() {
    const t = await setup(), owner = await stepUp(t.request, await t.login(t.created.url));
    const seat = await newSeatKeys(), pub = await seatPublic(seat), trip = await newTripKey(), wrap = await wrapTripKey(trip, pub.x25519, t.created.id, 1);
    expect((await t.request("/keys", "PATCH", { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped }, owner)).status).toBe(200);
    const item = { ...t.seed.document.items[0]!, place: { label: "駅前の広場", publicUrl: "https://example.com/plaza" }, description: "旅のしおり" };
    expect((await t.request("/document", "PATCH", { type: "item", item }, owner, 1)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "suggest", author: "A", body: "朝市に行きたい" }, owner, 2)).status).toBe(200);
    expect((await t.request("/document", "PATCH", { type: "budget", budget: [{ id: "b1", title: "宿代", amount: 98765, description: "" }] }, owner, 3)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    const sealed = await sealTrip(trip, t.created.id, 1, { spec: view.spec, document: view.document });
    const seal = async (body: object = {}, cookie = owner, revision: number = view.document.revision) => t.request("/seal", "POST", { generation: 1, ...sealed, ...await moveNames(t, trip, owner), confirm: true, ...body }, cookie, revision);
    const stored = () => JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules WHERE payload IS NOT NULL").get() as { payload: string }).payload);
    return { ...t, owner, trip, view, sealed, seal, stored };
  }
  // A sealed trip's invite is named by the host (招待リンク) and carries the id the browser chose (#693).
  const invite = async (t: Awaited<ReturnType<typeof setup>>, owner: string, role = "participant") => t.login((await (await t.request("/grants", "POST", { role, ...(await (await t.request("", "GET", undefined, owner)).json()).sealed ? { id: crypto.randomUUID().replaceAll("-", "") } : {}, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);

  test("the owner's seal leaves only ciphertext of the words in the stored payload, and no plain previous", async () => {
    const t = await sealable();
    // A step to go back to, as a revise leaves it: plain, so it must not stay beside the sealed words.
    const row = (await t.host.store.get(t.host.digest(t.created.id)))!, c = JSON.parse(row.payload!);
    c.previous = { spec: c.spec, document: { items: c.document.items, checklist: c.document.checklist, notes: c.document.notes, budget: c.document.budget } };
    expect(await t.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
    const r = await t.seal(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ revision: t.view.document.revision + 1 });
    const kept = t.stored(), text = JSON.stringify(kept);
    for (const w of words) expect(text).not.toContain(w);
    expect(kept.sealed).toEqual({ generation: 1 }); expect(kept.previous).toBeUndefined();
    for (const v of [kept.spec.title, kept.spec.trip.destinations, kept.spec.modules[0].label, kept.document.items[0].sealed, kept.document.notes, kept.document.budget[0].amount, kept.document.suggestions[0].body, kept.document.checklist[0].title]) expect(v).toMatch(/^v1\.1\.[A-Za-z0-9_-]+$/);
    // What the host works with stays plain, and opens back to what the owner read.
    expect(kept.document.items.map((i: { id: string; startsAt: string }) => [i.id, i.startsAt])).toEqual(t.view.document.items.map((i: { id: string; startsAt: string }) => [i.id, i.startsAt]));
    expect(await openField(t.trip, t.created.id, "spec", "spec", "title", kept.spec.title)).toBe("テスト旅行");
    const view = await (await t.request("", "GET", undefined, t.owner)).json();
    expect(view.sealed).toEqual({ generation: 1 }); expect(view.spec).toEqual(kept.spec); expect(view.document).toEqual(kept.document);
    // A sealed previous is kept as given.
    const again = await sealable(), previous = { spec: again.sealed.spec, document: { items: again.sealed.document.items, checklist: again.sealed.document.checklist, notes: again.sealed.document.notes, budget: again.sealed.document.budget } };
    expect((await again.seal({ previous })).status).toBe(200);
    expect(again.stored().previous).toEqual(previous);
    // A plain one is not.
    const plain = await sealable();
    expect((await plain.seal({ previous: { spec: plain.view.spec, document: { items: plain.view.document.items, checklist: plain.view.document.checklist, notes: plain.view.document.notes, budget: plain.view.document.budget } } })).status).toBe(400);
    expect(plain.stored().sealed).toBeUndefined();
  });
  test("only the owner holding the trip key seals, once; a malformed ciphertext is 400, a well-formed one passes unread", async () => {
    const t = await sealable(), member = await stepUp(t.request, await invite(t, t.owner)), second = await stepUp(t.request, await invite(t, t.owner, "owner"));
    expect((await t.seal({}, member)).status).toBe(403);
    const keyless = await t.seal({}, second); expect(keyless.status).toBe(409); expect((await keyless.json()).error).toBe("旅行の鍵がありません");
    expect((await t.seal({ generation: 2 })).status).toBe(409);
    // A trip whose sharing has ended is not sealed either.
    const frozen = await sealable();
    expect((await frozen.request("/freeze", "POST", { confirm: true }, frozen.owner, frozen.view.document.revision)).status).toBe(200);
    expect((await frozen.seal({}, frozen.owner, frozen.view.document.revision)).status).toBe(403);
    for (const title of ["テスト旅行", t.sealed.spec.title.replace(/^v1\.1\./, "v1.")]) expect((await t.seal({ spec: { ...t.sealed.spec, title } })).status).toBe(400);
    expect((await t.seal({ document: { ...t.sealed.document, notes: "メモ" } })).status).toBe(400);
    expect(t.stored().sealed).toBeUndefined();
    // The host cannot tell random bytes from words, and needs not: the plain parts and the form are what it checks.
    const r = await t.seal({ spec: { ...t.sealed.spec, title: fake() } }); expect(r.status).toBe(200);
    const twice = await t.seal({}, t.owner, t.view.document.revision + 1); expect(twice.status).toBe(409); expect((await twice.json()).error).toBe("旅程はもう暗号化してあります");
  });
  test("the hash is the SHA-256 of the sealed Spec as kept, and a new title changes it; past 1,900,000 bytes the seal is 413", async () => {
    const t = await sealable(); expect((await t.seal()).status).toBe(200);
    const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    let view = await (await t.request("", "GET", undefined, t.owner)).json();
    expect(view.hash).toBe(sha(view.spec)); expect(t.stored().hash).toBe(sha(t.stored().spec));
    const retitled = { ...view.spec, title: await sealSpec(t.trip, t.created.id, 1, { ...t.view.spec, title: "新しい題" }).then(s => s.title) };
    expect((await t.request("/spec", "PATCH", { spec: retitled, confirm: true }, t.owner, view.document.revision)).status).toBe(200);
    const before = view.hash; view = await (await t.request("", "GET", undefined, t.owner)).json();
    expect(view.hash).not.toBe(before); expect(view.hash).toBe(sha(retitled));
    expect(await openField(t.trip, t.created.id, "spec", "spec", "title", view.spec.title)).toBe("新しい題");
    // A sealed Spec with a plain title, or one that drops a page, is refused as a plain one would be.
    expect((await t.request("/spec", "PATCH", { spec: { ...view.spec, title: "平文" }, confirm: true }, t.owner, view.document.revision)).status).toBe(400);
    expect((await t.request("/spec", "PATCH", { spec: { ...view.spec, modules: view.spec.modules.slice(1), navigation: view.spec.navigation.slice(1) }, confirm: true }, t.owner, view.document.revision)).status).toBe(400);
    // Within the 2 MiB of the trip's own rule, past what a capsule row holds.
    const big = await sealable(), items = Array.from({ length: 32 }, (_, n) => ({ id: `big${n}`, day: big.view.spec.trip.startsOn, revision: 1, sealed: `v1.1.${"A".repeat(60_000)}` }));
    const r = await big.seal({ document: { ...big.sealed.document, items } }); expect(r.status).toBe(413); expect((await r.json()).error).toBe("カプセルの容量上限です");
  });
  test("theme.css and the operator's list read the plain parts as before", async () => {
    const t = await sealable(), list = async () => (await (await t.host.fetch(new Request(origin + "/v1/capsules/list", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" }))).json()) as Array<Record<string, unknown>>;
    const css = await (await t.request("/theme.css", "GET", undefined, t.owner)).text(), listed = await list();
    expect((await t.seal()).status).toBe(200);
    expect(await (await t.request("/theme.css", "GET", undefined, t.owner)).text()).toBe(css);
    // Only whether it is sealed changes (#694).
    const strip = (l: Array<Record<string, unknown>>) => l.map(({ updated: _updated, sealed: _sealed, ...rest }) => rest);
    expect(strip(await list())).toEqual(strip(listed));
    expect([listed[0]!.sealed, (await list())[0]!.sealed]).toEqual([false, true]);
  });
  test("export and the host's revise text, check and assist are 409 in a sealed trip, with no plain word; purge does not compare the title", async () => {
    const t = await sealable(); expect((await t.seal()).status).toBe(200);
    const revision = t.view.document.revision + 1;
    for (const [path, method, body] of [["/export", "GET"], ["/export.md", "GET"], ["/export.html", "GET"], ["/revise", "GET"], ["/revise/check", "POST", { text: "{}" }], ["/revise/assist", "POST", { instruction: "" }], ["/revise", "POST", { text: "{}", confirm: true }], ["/undo", "POST", { confirm: true }], ["/document", "PATCH", { type: "suggest", author: "A", body: "朝市" }]] as Array<[string, string, object?]>) {
      const r = await t.request(path, method, body, t.owner, revision), text = await r.text();
      for (const w of words) expect(text).not.toContain(w);
      // A plain operation or a pasted text is not the sealed form these take now (400), and there is no step to go back to (404); the rest is 409.
      if (path === "/undo") { expect(r.status).toBe(404); continue; }
      if (["/document", "/revise"].includes(path) && method !== "GET") { expect(r.status).toBe(400); continue; }
      expect(r.status).toBe(409); expect(JSON.parse(text).error).toBe("暗号化した旅行では、まだ使えません");
    }
    expect((await t.request("/purge", "POST", { title: "どんな題でも" }, t.owner, revision)).status).toBe(200);
    expect((await t.request("", "GET", undefined, t.owner)).status).toBe(410);
  });
  test("a trip not sealed reads as before, with sealed: null", async () => {
    const t = await setup(), owner = await t.login(t.created.url), view = await (await t.request("", "GET", undefined, owner)).json();
    expect(view.sealed).toBeNull(); expect(view.spec).toEqual(t.seed.spec); expect(view.document).toEqual(t.seed.document);
    expect((await t.request("/export.md", "GET", undefined, owner)).status).toBe(200);
  });
  // A sealed trip and a way to send what a member's screen sends: the operation made on the plain trip it opened, sealed.
  async function sealedTrip() {
    const t = await sealable(); expect((await t.seal()).status).toBe(200);
    const read = async (cookie = t.owner) => { const v = await (await t.request("", "GET", undefined, cookie)).json(); return { v, plain: (await openTrip(t.trip, t.created.id, v))! }; };
    const send = async (op: object, cookie = t.owner) => { const { v, plain } = await read(); return t.request("/document", "PATCH", await sealOperation(t.trip, t.created.id, 1, op, plain.document), cookie, v.document.revision); };
    const raw = async (body: object, cookie = t.owner) => t.request("/document", "PATCH", body, cookie, (await read()).v.document.revision);
    return { ...t, read, send, raw };
  }
  // What the screen sends to revise or go back (docs/design/trip-e2e.md §4): the next trip reviseTrip / undoTrip made from the
  // opened one, sealed, with the memories and the kept posts' seats as the host keeps them. `spec`: ciphertext kept as it is.
  type Sealed = Awaited<ReturnType<typeof sealedTrip>>;
  const sealedNext = async (t: Sealed, v: { spec: object; document: Record<string, Array<{ id: string; seat?: string }>> }, next: { spec: Parameters<typeof sealTrip>[3]["spec"]; document: Parameters<typeof sealTrip>[3]["document"] }, spec?: object, step?: Record<string, Array<{ id: string; seat?: string }>>) => {
    const s = await sealTrip(t.trip, t.created.id, 1, next);
    const seat = (list: string) => (p: { id: string }) => { const old = [...v.document[list]!, ...step?.[list] ?? []].find(o => o.id === p.id); return old?.seat !== undefined ? { ...p, seat: old.seat } : p; };
    return { spec: spec ?? s.spec, document: { ...s.document, reflections: v.document.reflections, suggestions: s.document.suggestions.map(seat("suggestions")), comments: s.document.comments.map(seat("comments")) }, confirm: true };
  };
  const revised = async (t: Sealed, edit: (trip: ReturnType<typeof revisable>) => void, keepSpec = false) => {
    const { v, plain } = await t.read(), trip = structuredClone(revisable(plain.spec, plain.document)); edit(trip);
    const r = reviseTrip(plain, JSON.stringify(trip), { author: "オーナー", at: new Date(now).toISOString(), created: t.stored().created, now, keepSpec });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return { v, plain, next: r.next, body: await sealedNext(t, v, r.next, keepSpec ? v.spec : undefined) };
  };
  test("revise and undo: the browser's sealed next trip is kept; the host checks roles, plain parts and the ciphertext that must stay", async () => {
    const t = await sealedTrip(), editor = await invite(t, t.owner, "editor"), member = await invite(t, t.owner), viewer = await invite(t, t.owner, "viewer");
    expect((await t.send({ type: "reflect", author: "参加者", body: "楽しかった" }, member)).status).toBe(200);
    expect((await t.send({ type: "suggest", author: "参加者", body: "温泉" }, member)).status).toBe(200);
    expect((await t.request("/undo", "GET", undefined, t.owner)).status).toBe(404);
    // (a) The owner's revise: an item's title, a 準備 line and a 候補 change; nothing plain is kept, and the step back is the trip as it was.
    const a = await revised(t, trip => { trip.document.items[0]!.title = "新しい集合"; trip.document.checklist.push({ id: "c-new", title: "傘を持つ", done: false }); trip.document.suggestions.push({ id: "s-new", body: "夜市に寄る", promoted: false }); });
    for (const cookie of [member, viewer]) expect((await t.request("/revise", "POST", a.body, cookie, a.v.document.revision)).status).toBe(403);
    expect((await t.request("/revise", "POST", a.body, t.owner, a.v.document.revision - 1)).status).toBe(409);
    // A new post's time is the host's, whatever the browser wrote.
    a.body.document.suggestions = a.body.document.suggestions.map(p => p.id === "s-new" ? { ...p, createdAt: "2020-01-01T00:00:00Z" } : p);
    const r = await t.request("/revise", "POST", a.body, t.owner, a.v.document.revision); expect(r.status).toBe(200); expect(await r.json()).toEqual({ revision: a.v.document.revision + 1 });
    const kept = t.stored(), text = JSON.stringify(kept);
    for (const w of [...words, "新しい集合", "傘を持つ", "夜市に寄る", "温泉", "楽しかった"]) expect(text).not.toContain(w);
    const { items, checklist, notes, budget, suggestions, comments } = a.v.document;
    expect(kept.previous).toEqual({ spec: a.v.spec, document: { items, checklist, notes, budget, suggestions, comments }, revisedIds: { suggestions: a.next.document.suggestions.map(p => p.id), comments: a.next.document.comments.map(p => p.id) } });
    const after = (await t.read()).plain;
    expect(after.document.items[0]!.title).toBe("新しい集合"); expect(after.document.checklist.map(c => c.title)).toContain("傘を持つ");
    const self = kept.sessions.find((s: { grantId: string }) => kept.grants.find((g: { id: string; role: string }) => g.id === s.grantId)?.role === "owner").id;
    expect(kept.document.suggestions.find((p: { id: string }) => p.id === "s-new").seat).toBe(self);
    expect(kept.document.suggestions.find((p: { seat?: string }) => p.seat && p.seat !== self)).toBeDefined();
    // (b) An editor's revise keeps the Spec as it is kept, ciphertext and plain parts both.
    const b = await revised(t, trip => { trip.document.items[1]!.title = "編集者の夕食"; }, true);
    const retitled = { ...b.body.spec as object, title: (await sealSpec(t.trip, t.created.id, 1, { ...b.plain.spec, title: "別の題" })).title };
    const later = { ...b.v.spec, trip: { ...(b.v.spec as { trip: object }).trip, endsOn: "2026-09-27" } };
    for (const spec of [retitled, later]) { const refused = await t.request("/revise", "POST", { ...b.body, spec }, editor, b.v.document.revision); expect(refused.status).toBe(403); expect((await refused.json()).error).toBe("設定はオーナーだけが変えられます"); }
    expect((await t.request("/revise", "POST", b.body, editor, b.v.document.revision)).status).toBe(200);
    // A revise that moves the deadline is an important action: past the passkey check's five minutes it is 428.
    now += 6 * 60_000;
    const moves = await revised(t, trip => { trip.spec.lifecycle.purgeAt = "2026-10-20T00:00:00+09:00"; });
    expect((await t.request("/revise", "POST", moves.body, t.owner, moves.v.document.revision)).status).toBe(428);
    // (d) Memories are not revised; a post kept keeps its seat and time.
    const d = await revised(t, () => {});
    expect((await t.request("/revise", "POST", { ...d.body, document: { ...d.body.document, reflections: [] } }, t.owner, d.v.document.revision)).status).toBe(400);
    const moved = (d.body.document.suggestions as Array<{ id: string; seat?: string }>).map(p => p.seat ? { ...p, seat: "someone-else" } : p);
    expect((await t.request("/revise", "POST", { ...d.body, document: { ...d.body.document, suggestions: moved } }, t.owner, d.v.document.revision)).status).toBe(400);
    const plainTitle = { ...d.body.document, notes: "平文のメモ" };
    expect((await t.request("/revise", "POST", { ...d.body, document: plainTitle }, t.owner, d.v.document.revision)).status).toBe(400);
    // (e) The step back is handed out sealed; going back sends the step's own Spec.
    const shown = await (await t.request("/undo", "GET", undefined, editor)).json(), view = (await t.read()).v;
    expect(shown).toEqual({ previous: t.stored().previous, revision: view.document.revision });
    for (const cookie of [member, viewer]) expect((await t.request("/undo", "GET", undefined, cookie)).status).toBe(403);
    const back = async () => {
      const { v, plain } = await t.read(), p = (await t.request("/undo", "GET", undefined, t.owner).then(r => r.json())).previous;
      const opened = (await openTrip(t.trip, t.created.id, { spec: p.spec, document: { ...v.document, ...p.document } }))!;
      const { items, checklist, notes, budget, suggestions, comments } = opened.document;
      const u = undoTrip(plain, { spec: opened.spec, document: { items, checklist, notes, budget, suggestions, comments }, revisedIds: p.revisedIds }, { created: t.stored().created, keepSpec: false });
      if (!u.ok) throw new Error(u.reason);
      return { v, p, body: await sealedNext(t, v, u.next, p.spec, p.document) };
    };
    let u = await back();
    for (const cookie of [member, viewer]) expect((await t.request("/undo", "POST", u.body, cookie, u.v.document.revision)).status).toBe(403);
    const wrong = await t.request("/undo", "POST", { ...u.body, spec: retitled }, t.owner, u.v.document.revision); expect(wrong.status).toBe(400); expect((await wrong.json()).error).toBe("1 つ前の旅程に戻せません");
    // The owner changes the settings after the revise: the step back would change them again, which an editor may not.
    const respec = { ...u.v.spec, theme: { ...(u.v.spec as { theme: object }).theme, accent: "#123456" } };
    await stepUp(t.request, t.owner);
    expect((await t.request("/spec", "PATCH", { spec: respec, confirm: true }, t.owner, u.v.document.revision)).status).toBe(200);
    u = await back();
    const refused = await t.request("/undo", "POST", u.body, editor, u.v.document.revision); expect(refused.status).toBe(403); expect((await refused.json()).error).toBe("設定も戻るため、オーナーだけが戻せます");
    expect((await t.request("/undo", "POST", u.body, t.owner, u.v.document.revision)).status).toBe(200);
    expect(t.stored().previous).toBeUndefined();
    expect((await t.read()).plain.document.items[1]!.title).toBe("夕食");
    expect((await t.request("/undo", "GET", undefined, t.owner)).status).toBe(404);
    // A participant's post the revise dropped comes back with its seat and time; the new one got the time of the revise.
    const own = t.stored().document.suggestions.find((p: { seat?: string }) => p.seat && p.seat !== self);
    expect(t.stored().document.suggestions.find((p: { id: string }) => p.id === "s-new").createdAt).toBe("2026-09-16T00:00:00.000Z");
    const g = await revised(t, trip => { trip.document.suggestions = trip.document.suggestions.filter(p => p.id !== own.id); });
    expect((await t.request("/revise", "POST", g.body, t.owner, g.v.document.revision)).status).toBe(200);
    expect(t.stored().document.suggestions.some((p: { id: string }) => p.id === own.id)).toBe(false);
    u = await back();
    expect((await t.request("/undo", "POST", u.body, t.owner, u.v.document.revision)).status).toBe(200);
    expect(t.stored().document.suggestions.find((p: { id: string }) => p.id === own.id)).toMatchObject({ id: own.id, seat: own.seat, createdAt: own.createdAt });
    // (c) Once sharing has ended, nothing is revised or undone.
    const f = await revised(t, trip => { trip.document.notes = "終わった後"; });
    expect((await t.request("/revise", "POST", f.body, t.owner, f.v.document.revision)).status).toBe(200);
    u = await back();
    expect((await t.request("/freeze", "POST", { confirm: true }, t.owner, u.v.document.revision)).status).toBe(200);
    expect((await t.request("/revise", "POST", f.body, t.owner, u.v.document.revision + 1)).status).toBe(403);
    expect((await t.request("/undo", "POST", u.body, t.owner, u.v.document.revision + 1)).status).toBe(403);
  });
  test("assist key: a sealed trip keeps only the key its browser wrapped; the host's sealed keys go at the seal", async () => {
    const t = await sealable(), editor = await invite(t, t.owner, "editor"), member = await invite(t, t.owner), checked: string[] = [];
    t.host.env.VERIFY_KEY = async k => { checked.push(k); return true; };
    const key = "sk-ant-" + "k".repeat(40), wrapped = `v1.${b64(crypto.getRandomValues(new Uint8Array(60)))}`;
    // (e) Before the seal the host's key works as before, and is gone once the trip is sealed (a).
    expect((await t.request("/key", "PUT", { key }, editor)).status).toBe(204); expect(checked).toEqual([key]);
    expect(t.stored().sessions.some((s: { assistKey?: string }) => s.assistKey)).toBe(true);
    expect((await t.seal()).status).toBe(200);
    expect(t.stored().sessions.some((s: { assistKey?: string }) => s.assistKey)).toBe(false);
    // (b) The wrapped key is kept and handed back to its seat with the model; the key itself is refused and not sent to Anthropic.
    expect((await t.request("/key", "PUT", { wrapped }, t.owner)).status).toBe(204);
    const view = await (await t.request("", "GET", undefined, t.owner)).json();
    expect(view).toMatchObject({ assistKey: true, assistWrapped: wrapped, assistModel: "claude-haiku-5-5" });
    // The trip's creation time and the seat's own name, which the browser's revise checks against and writes on a new post (#786).
    expect(view).toMatchObject({ created: t.stored().created }); expect(typeof view.created).toBe("number");
    expect(await openName(t.trip, t.created.id, "member", view.self.id, view.label)).toBe("オーナー");  // sealed by the move (sealMove)
    expect(await (await t.request("", "GET", undefined, editor)).json()).toMatchObject({ assistKey: false, assistWrapped: null });
    for (const body of [{ key }, { wrapped: key }, { wrapped, key }, { wrapped: "v2.abc" }]) expect((await t.request("/key", "PUT", body, editor)).status).toBe(400);
    expect(checked).toEqual([key]);
    expect(JSON.stringify(t.stored())).not.toContain("sk-ant-");
    // (c) The members' list does not carry it. (d) A participant may not put one; deleting takes both kinds away.
    const members = await (await t.request("/grants", "GET", undefined, t.owner)).text(); expect(members).not.toContain("assistWrapped"); expect(members).not.toContain(wrapped);
    expect((await t.request("/key", "PUT", { wrapped }, member)).status).toBe(403);
    expect((await t.request("/key", "DELETE", {}, t.owner)).status).toBe(204);
    expect(await (await t.request("", "GET", undefined, t.owner)).json()).toMatchObject({ assistKey: false, assistWrapped: null });
    // A plain trip still answers without the sealed fields.
    const plain = await setup(), owner = await plain.login(plain.created.url), seen = await (await plain.request("", "GET", undefined, owner)).json();
    expect(seen.assistKey).toBe(false); expect("assistWrapped" in seen).toBe(false); expect("assistModel" in seen).toBe(false);
  });
  test("役割: a participant may post, and check when allowed, but not touch the plan; a viewer and a frozen trip read only", async () => {
    const t = await sealedTrip(), member = await invite(t, t.owner), viewer = await invite(t, t.owner, "viewer");
    const { plain } = await t.read(), day = plain.document.items[0]!.day;
    for (const op of [{ type: "item", item: { id: "x1", kind: "meal", status: "proposed", title: "昼食", day, revision: 1 } }, { type: "checklist", checklist: [{ id: "c1", title: "傘" }] }, { type: "notes", body: "メモ" },
      { type: "budget", budget: [] }, { type: "rewrite", list: "suggestions", id: plain.document.suggestions[0]!.id, body: "夜市" }, { type: "remove", list: "suggestions", id: plain.document.suggestions[0]!.id },
      { type: "move", id: "walk", before: null }, { type: "promote", id: plain.document.suggestions[0]!.id, day }])
      expect((await t.send(op, member)).status).toBe(403);
    for (const op of [{ type: "suggest", author: "参加者", body: "温泉" }, { type: "comment", author: "参加者", body: "賛成" }, { type: "reflect", author: "参加者", body: "楽しかった" }, { type: "check", id: "c1", done: true }])
      expect((await t.send(op, member)).status).toBe(200);
    const kept = t.stored(), self = kept.sessions.find((s: { grantId: string; id: string }) => kept.grants.find((g: { id: string; role: string }) => g.id === s.grantId)?.role === "participant").id;
    expect(kept.document.suggestions.at(-1).seat).toBe(self); expect(kept.document.comments.at(-1).seat).toBe(self); expect(kept.document.reflections.at(-1).seat).toBe(self);
    expect(kept.document.checklist[0].done).toBe(true);
    expect((await t.read()).plain.document.suggestions.at(-1)).toMatchObject({ author: "参加者", body: "温泉", promoted: false });
    expect((await t.send({ type: "suggest", author: "閲覧者", body: "x" }, viewer)).status).toBe(403);
    // Turning a participant's posts off is the owner's plain setting, in a sealed trip too.
    const v = (await t.read()).v;
    expect((await t.request("/spec", "PATCH", { spec: { ...v.spec, collaboration: { ...v.spec.collaboration, participantSuggestions: false, participantChecklist: false } }, confirm: true }, t.owner, v.document.revision)).status).toBe(200);
    expect((await t.send({ type: "suggest", author: "参加者", body: "温泉" }, member)).status).toBe(403);
    expect((await t.send({ type: "check", id: "c1", done: false }, member)).status).toBe(403);
    expect((await t.request("/freeze", "POST", { confirm: true }, t.owner, (await t.read()).v.document.revision)).status).toBe(200);
    expect((await t.send({ type: "notes", body: "メモ" })).status).toBe(403);
  });
  test("時刻: adding after an item, moving and promoting place and time the items as in a plain trip", async () => {
    const sealed = await sealedTrip(), plain = await sealable();
    const plainSend = async (op: object) => plain.request("/document", "PATCH", op, plain.owner, (await (await plain.request("", "GET", undefined, plain.owner)).json()).document.revision);
    const day = plain.view.document.items[0]!.day, other = plain.view.document.items[1]!.day, suggestion = plain.view.document.suggestions[0]!.id;
    const sealedSuggestion = (await sealed.read()).plain.document.suggestions[0]!.id;
    const steps = [
      { type: "item", item: { id: "lunch", kind: "meal", status: "proposed", title: "昼食", day, revision: 1 }, after: "arrival" },
      { type: "item", item: { id: "tea", kind: "meal", status: "proposed", title: "お茶", day, revision: 1 }, after: "arrival" },
      { type: "move", id: "arrival", before: null },
      { type: "promote", id: suggestion, day: other },
    ];
    for (const op of steps) {
      const a = await plainSend(op), b = await sealed.send(op.type === "promote" ? { ...op, id: sealedSuggestion } : op);
      expect(a.status).toBe(200); expect(b.status).toBe(200);
      expect((await b.json()).moved).toEqual((await a.json()).moved);
    }
    const shape = (items: Array<{ id: string; day: string; startsAt?: string; timeTentative?: boolean }>, promoted: string) => items.map(i => [i.id === promoted ? "promoted" : i.id, i.day, i.startsAt, i.timeTentative ?? false]);
    const p = (await (await plain.request("", "GET", undefined, plain.owner)).json()).document, s = (await sealed.read()).v.document;
    const pId = p.suggestions[0].itemId, sId = s.suggestions[0].itemId;
    expect(shape(s.items, sId)).toEqual(shape(p.items, pId));
    // The promoted item holds the words the screen made from the suggestion.
    const made = JSON.parse(await openField(sealed.trip, sealed.created.id, "item", sId, "sealed", s.items.find((i: { id: string }) => i.id === sId).sealed));
    expect(made).toEqual({ kind: "activity", status: "confirmed", title: "朝市に行きたい", description: "朝市に行きたい" });
    expect(s.suggestions[0].promoted).toBe(true);
  });
  test("形: ciphertext without a generation, plain words and dates outside the trip are 400; well-formed ciphertext passes unread", async () => {
    const t = await sealedTrip(), { plain } = await t.read(), day = plain.document.items[0]!.day;
    const item = (over: object) => ({ type: "item", item: { id: "x1", day, revision: 1, sealed: fake(), ...over } });
    expect((await t.raw(item({ sealed: fake().replace(/^v1\.1\./, "v1.") }))).status).toBe(400);
    expect((await t.raw(item({ sealed: "昼食" }))).status).toBe(400);
    expect((await t.raw(item({ day: "2027-01-01" }))).status).toBe(400);
    expect((await t.raw({ type: "notes", body: "メモ" })).status).toBe(400);
    expect((await t.raw({ type: "suggest", author: "A", body: "朝市" })).status).toBe(400);
    expect((await t.raw(item({}))).status).toBe(200);
    // A post's id is the screen's; one already in the list is refused.
    const id = plain.document.suggestions[0]!.id;
    expect((await t.raw({ type: "suggest", id, author: fake(), body: fake() })).status).toBe(400);
    expect((await t.raw({ type: "suggest", id: "fresh1", author: fake(), body: fake() })).status).toBe(200);
    expect((await t.raw({ type: "promote", id: "fresh1", day, item: { id: "x1", sealed: fake() } })).status).toBe(400);
    // What is stored is still the sealed form.
    expect(t.stored().document.items.find((i: { id: string }) => i.id === "x1").sealed).toMatch(/^v1\.1\./);
  });
});

describe("sealed footprints and names", () => {
  // A trip sealed by its owner's browser (as in "sealed trip"), whose points, names and history lines are then written as the
  // browser does with the trip's key (src/trip-keys.ts). Names and the point are chosen to be found in the stored payload.
  type Setup = Awaited<ReturnType<typeof setup>>;
  const during = +new Date("2026-09-25T01:00:00Z"), here = { lat: 35.6812, lng: 139.7671, accuracy: 20 };
  const gid = () => crypto.randomUUID().replaceAll("-", "");
  async function sealedTrip(env: { MEDIA?: MediaStore; CAPSULE_PHOTOS?: string } = {}) {
    const t = await setup(undefined, env), owner = await stepUp(t.request, await t.login(t.created.url));
    const seat = await newSeatKeys(), pub = await seatPublic(seat), trip = await newTripKey(), wrap = await wrapTripKey(trip, pub.x25519, t.created.id, 1);
    expect((await t.request("/keys", "PATCH", { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped }, owner)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, owner)).json();
    expect((await t.request("/seal", "POST", { generation: 1, ...await sealTrip(trip, t.created.id, 1, { spec: view.spec, document: view.document }), ...await moveNames(t, trip, owner), confirm: true }, owner, view.document.revision)).status).toBe(200);
    const name = (kind: "member" | "grant" | "footprint", id: string, n: string) => sealName(trip, t.created.id, 1, kind, id, n);
    const issue = async (role: string, label?: string, body: object = {}) => {
      const id = gid(), r = await t.request("/grants", "POST", { role, id, ...(label ? { label: await name("grant", id, label) } : {}), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, ...body }, owner);
      expect(r.status).toBe(201); return { id, ...await r.json() as { url: string; grantId: string } };
    };
    const join = async (role: string, label: string) => { const g = await issue(role, label); return { grant: g.id, cookie: await t.login(g.url) }; };
    const m = { editor: await join("editor", "編集の招待"), participant: await join("participant", "参加の招待"), other: await join("participant", "別の招待"), viewer: await join("viewer", "閲覧の招待") };
    const stored = () => JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules WHERE payload IS NOT NULL").get() as { payload: string }).payload);
    const self = async (cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()).self as { id: string; label: string };
    const add = async (cookie: string, point: object = here, extra: object = {}) => {
      const id = gid(), me = await self(cookie);
      return t.request("/footprints", "PATCH", { type: "add", id, point: await sealPoint(trip, t.created.id, 1, id, point as typeof here), by: await name("footprint", id, `名前-${me.id.slice(0, 6)}`), ...extra }, cookie);
    };
    return { ...t, owner, trip, name, issue, m, stored, self, add };
  }
  const error = async (r: Response) => [r.status, (await r.json()).error];

  test("足あと: a sealed point and name are kept as ciphertext and open back; the roles, dates and removal hold", async () => {
    const t = await sealedTrip(), { m } = t;
    now = during;
    const r = await t.add(m.participant.cookie); expect(r.status).toBe(200);
    const list = (await r.json()).footprints;
    expect(list).toHaveLength(1); expect(list[0]).not.toHaveProperty("lat"); expect(list[0]).not.toHaveProperty("seat");
    expect(await openPoint(t.trip, t.created.id, list[0].id, list[0].point)).toEqual(here);
    const me = await t.self(m.participant.cookie);
    expect(await openName(t.trip, t.created.id, "footprint", list[0].id, list[0].by)).toBe(`名前-${me.id.slice(0, 6)}`);
    const text = JSON.stringify(t.stored());
    expect(text).not.toContain("35.6812"); expect(text).not.toContain("139.7671"); expect(text).not.toContain(`名前-${me.id.slice(0, 6)}`);
    // Every role reads it; whose it is, only as whether it is one's own.
    for (const cookie of [t.owner, m.viewer.cookie]) expect((await (await t.request("", "GET", undefined, cookie)).json()).footprints.map((p: { mine: boolean }) => p.mine)).toEqual([false]);
    expect(await error(await t.add(m.viewer.cookie))).toEqual([403, "閲覧者は足あとを残せません"]);
    // The plain form, a ciphertext without its generation and an id already taken are refused.
    expect((await t.request("/footprints", "PATCH", { type: "add", ...here }, m.other.cookie)).status).toBe(400);
    const id = gid(), point = await sealPoint(t.trip, t.created.id, 1, id, here), by = await t.name("footprint", id, "x");
    expect((await t.request("/footprints", "PATCH", { type: "add", id, point: point.replace(/^v1\.1\./, "v1."), by }, m.other.cookie)).status).toBe(400);
    expect(await error(await t.request("/footprints", "PATCH", { type: "add", id: list[0].id, point, by }, m.other.cookie))).toEqual([400, "足あとを確認してください"]);
    // Removal: the seat itself, the owner and an editor; another participant cannot.
    now += 60000; const own = (await (await t.add(m.other.cookie)).json()).footprints.at(-1).id;
    expect(await error(await t.request("/footprints", "PATCH", { type: "remove", id: own }, m.participant.cookie))).toEqual([403, "自分の足あとだけ消せます"]);
    expect((await t.request("/footprints", "PATCH", { type: "remove", id: own }, m.other.cookie)).status).toBe(200);
    expect((await t.request("/footprints", "PATCH", { type: "remove", id: list[0].id }, m.editor.cookie)).status).toBe(200);
    // Outside the trip, and once sharing has ended.
    now = +new Date("2026-09-23T14:00:00Z"); expect(await error(await t.add(m.other.cookie))).toEqual([403, "足あとは旅行期間中だけ残せます"]);
    now = during + 3600000; expect((await t.request("/freeze", "POST", { confirm: true }, await stepUp(t.request, t.owner), t.stored().document.revision)).status).toBe(200);
    expect(await error(await t.add(t.owner))).toEqual([403, "足あとは旅行期間中だけ残せます"]);
  });
  test("件数と時刻: once a minute per seat and a thousand per trip, by the plain seat and time alone", async () => {
    const t = await sealedTrip(), { m } = t;
    now = during;
    expect((await t.add(m.participant.cookie, here, { auto: true })).status).toBe(200);
    now += 59999; expect(await error(await t.add(m.participant.cookie))).toEqual([429, "足あとは1分に1回までです"]);
    expect((await t.add(m.other.cookie)).status).toBe(200);
    now += 1; expect((await t.add(m.participant.cookie)).status).toBe(200);
    const kept = t.stored().footprints;
    expect(kept.map((p: { auto?: true }) => Boolean(p.auto))).toEqual([true, false, false]);
    for (const p of kept) { expect(Object.keys(p).sort()).toEqual(["at", "by", "id", "point", "seat", ...p.auto ? ["auto"] : []].sort()); expect(p.point).toMatch(/^v1\.1\./); }
    // The thousandth is taken, the next refused, whatever the stored points hold.
    const row = (await t.host.store.get(t.host.digest(t.created.id)))!, c = JSON.parse(row.payload!);
    c.footprints = [...c.footprints, ...Array.from({ length: 996 }, (_, i) => ({ id: `f${i}`, seat: "gone", by: "v1.1.x", at: "2026-09-25T00:00:00.000Z", point: "v1.1.x" }))];
    expect(await t.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
    now += 60000; expect((await t.add(m.editor.cookie)).status).toBe(200);
    now += 60000; expect(await error(await t.add(t.owner))).toEqual([400, "足あとは1旅行1000件までです"]);
  });
  test("名前: members and invites are named in ciphertext or with the host's own names; GET gives the seat itself", async () => {
    const t = await sealedTrip(), { m } = t;
    const grants = async () => await (await t.request("/grants", "GET", undefined, t.owner)).json() as Array<{ id: string; label: string; members: Array<{ id: string; label: string }> }>;
    const seat = (await grants()).find(g => g.id === m.participant.grant)!.members[0]!;
    expect(seat.label).toMatch(/^メンバー\d+$/);  // the host's default name, until the owner's browser seals it
    expect(await t.self(m.participant.cookie)).toEqual({ id: seat.id, label: seat.label });
    expect((await t.request("/members", "PATCH", { id: seat.id, label: "花子" }, t.owner)).status).toBe(400);
    expect((await t.request("/members", "PATCH", { id: seat.id, label: await t.name("member", seat.id, "花子") }, t.owner)).status).toBe(200);
    const renamed = (await grants()).find(g => g.id === m.participant.grant)!.members[0]!;
    expect(await openName(t.trip, t.created.id, "member", seat.id, renamed.label)).toBe("花子");
    expect(await openName(t.trip, t.created.id, "member", seat.id, (await t.self(m.participant.cookie)).label)).toBe("花子");
    // An invite: a plain name, no id, or an id taken are refused; a sealed name or none (招待リンク) is kept.
    const body = { role: "viewer", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true };
    const id = gid();
    expect((await t.request("/grants", "POST", { ...body, id, label: "家族" }, t.owner)).status).toBe(400);
    expect((await t.request("/grants", "POST", { ...body, label: await t.name("grant", id, "家族") }, t.owner)).status).toBe(400);
    expect((await t.request("/grants", "POST", { ...body, id: "short" }, t.owner)).status).toBe(400);
    expect(await error(await t.request("/grants", "POST", { ...body, id: m.viewer.grant }, t.owner))).toEqual([400, "招待を確認してください"]);
    const named = await t.issue("viewer", "家族"), plain = await t.issue("viewer"), own = await t.issue("viewer", undefined, { label: "自分用" });
    expect(named.grantId).toBe(named.id);
    const list = await grants();
    expect(await openName(t.trip, t.created.id, "grant", named.id, list.find(g => g.id === named.id)!.label)).toBe("家族");
    expect(list.find(g => g.id === plain.id)!.label).toBe("招待リンク"); expect(list.find(g => g.id === own.id)!.label).toBe("自分用");
    const text = JSON.stringify(t.stored());
    for (const w of ["花子", "家族", "編集の招待", "参加の招待"]) expect(text).not.toContain(w);
  });
  test("履歴: lines hold the invite's and the seats' ids, not their names; the publisher's stays", async () => {
    const t = await sealedTrip(), { m } = t, owner = await stepUp(t.request, t.owner), ownerSeat = await t.self(owner);
    const g = await t.issue("participant", "履歴の招待"), joined = await t.login(g.url), seat = await t.self(joined);
    const rotated = gid();
    expect((await t.request("/grants", "POST", { role: "participant", id: rotated, label: await t.name("grant", rotated, "交換の招待"), rotate: m.other.grant, expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).status).toBe(201);
    const viewerSeat = await t.self(m.viewer.cookie);
    expect((await t.request("/revoke", "POST", { member: viewerSeat.id, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/revoke", "POST", { id: g.id, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/freeze", "POST", { confirm: true }, owner, t.stored().document.revision)).status).toBe(200);
    const history = await (await t.request("/history", "GET", undefined, owner)).json() as Array<Record<string, string>>;
    const of = (event: string) => history.find(h => h.event === event)!;
    expect(of("freeze")).toMatchObject({ seat: ownerSeat.id }); expect(of("freeze")).not.toHaveProperty("by");
    expect(of("revoke")).toMatchObject({ grant: g.id, seat: ownerSeat.id, role: "participant" });
    expect(of("revoke-member")).toMatchObject({ grant: m.viewer.grant, member: viewerSeat.id, seat: ownerSeat.id, role: "viewer" });
    expect(of("rotate")).toMatchObject({ grant: rotated, seat: ownerSeat.id });
    expect(history.find(h => h.event === "sessions" && h.grant === g.id)).toMatchObject({ seat: seat.id, role: "participant" });
    expect(history.find(h => h.event === "grants" && h.grant === g.id)).toMatchObject({ seat: ownerSeat.id });
    const after = history.filter(h => h.grant !== undefined || h.seat !== undefined);
    expect(after.length).toBeGreaterThanOrEqual(10);
    for (const h of after) { expect(h).not.toHaveProperty("label"); expect(h).not.toHaveProperty("by"); }
    const audit = JSON.stringify(t.stored().audit);
    for (const w of ["履歴の招待", "交換の招待", "編集の招待", "参加の招待", "閲覧の招待", "メンバー"]) expect(audit).not.toContain(w);
    // The publisher's line is not a member's, and keeps 発行者.
    expect((await t.host.fetch(new Request(origin + `/v1/c/${t.created.id}/recover`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) }))).status).toBe(201);
    expect(t.stored().audit.at(-1)).toMatchObject({ event: "recover", by: "発行者" });
  });
  test("履歴: an approval and a refusal are kept with the ids too", async () => {
    const t = await sealedTrip(), owner = await stepUp(t.request, t.owner), ownerSeat = await t.self(owner);
    const g = await t.issue("participant", "承認の招待", { seats: 2, approval: "owner" });
    for (let n = 0; n < 2; n++) expect((await t.request("/sessions", "POST", { secret: new URLSearchParams(new URL(g.url).hash.slice(1)).get("k") })).status).toBe(200);
    const waiting = (await (await t.request("/grants", "GET", undefined, owner)).json()).find((x: { id: string }) => x.id === g.id).members as Array<{ id: string }>;
    expect((await t.request("/approve", "POST", { member: waiting[0]!.id, approve: true, confirm: true }, owner)).status).toBe(200);
    expect((await t.request("/approve", "POST", { member: waiting[1]!.id, approve: false, confirm: true }, owner)).status).toBe(200);
    const lines = t.stored().audit.filter((a: { event: string }) => a.event === "approve" || a.event === "reject");
    expect(lines).toEqual([
      expect.objectContaining({ event: "approve", grant: g.id, member: waiting[0]!.id, seat: ownerSeat.id }),
      expect.objectContaining({ event: "reject", grant: g.id, member: waiting[1]!.id, seat: ownerSeat.id }),
    ]);
    for (const a of lines) { expect(a).not.toHaveProperty("label"); expect(a).not.toHaveProperty("by"); }
    expect(JSON.stringify(t.stored().audit)).not.toContain("メンバー");
  });

  describe("photo", () => {
    // A photo as the browser sends it: each image sealed under a key of its own, which the trip key seals (src/media.ts PhotoAsset).
    // The host opens none of it, so the images here are bytes the test can look for in the store and in what comes back.
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const withMedia = async (wrap: (real: MediaStore) => MediaStore = real => real) => {
      const dir = mkdtempSync(join(tmpdir(), "capsule-host.media.")); dirs.push(dir);
      const t = await sealedTrip({ MEDIA: wrap(new LocalMediaStore(dir)), CAPSULE_PHOTOS: "1" });
      const upload = async (cookie: string, over: Record<string, unknown> = {}, sizes = { display: 5000, thumb: 900 }) => {
        const id = gid(), fill = (n: number, v: number) => Buffer.alloc(n, v).toString("base64");
        const body = { id, images: { display: fill(sizes.display, 1), thumb: fill(sizes.thumb, 2) }, width: 1536, height: 2048, thumb: { width: 300, height: 400 }, capturedAt: "2026-09-25T10:15:00+09:00", key: await sealField(t.trip, t.created.id, 1, "photo", id, "key", "photo-key"), location: await sealField(t.trip, t.created.id, 1, "photo", id, "location", '{"lat":35.6812,"lng":139.7671}'), ...over };
        return { id, body, res: await t.request("/media", "POST", body, cookie) };
      };
      const list = async (cookie: string) => (await (await t.request("", "GET", undefined, cookie)).json()).media as Array<{ id: string; mine: boolean; capturedAt?: string; location?: string; contributor?: string }>;
      const image = (cookie: string, id: string, size = "display") => t.request(`/media/${id}/${size}`, "GET", undefined, cookie);
      return { ...t, dir, upload, list, image };
    };
    const error = async (r: Response) => [r.status, (await r.json()).error];

    test("photo: members upload, every member sees them, viewer and frozen cannot upload", async () => {
      const t = await withMedia(), { m } = t;
      now = during;
      const a = await t.upload(m.participant.cookie), b = await t.upload(t.owner, { capturedAt: "2026-09-25T09:00:00+09:00" });
      expect(a.res.status).toBe(201); expect(b.res.status).toBe(201);
      expect((await a.res.json()).photo).toMatchObject({ id: a.id, mine: true });
      expect(await error((await t.upload(m.viewer.cookie)).res)).toEqual([403, "閲覧者は写真を上げられません"]);
      for (const cookie of [t.owner, m.editor.cookie, m.other.cookie, m.viewer.cookie]) {
        const seen = await t.list(cookie);
        expect(seen.map(p => p.id)).toEqual([a.id, b.id]);
        expect(seen.map(p => p.mine)).toEqual([false, cookie === t.owner]);
        for (const p of seen) expect(p).not.toHaveProperty("contributor");
      }
      expect((await t.list(m.participant.cookie)).map(p => p.mine)).toEqual([true, false]);
      // After the trip it is still open; a trip whose sharing has ended takes no more, and shows what it has.
      now = +new Date("2026-09-27T01:00:00Z");
      expect((await (await t.request("", "GET", undefined, t.owner)).json()).state).toBe("reflection");
      expect((await t.upload(m.participant.cookie)).res.status).toBe(201);
      expect((await t.request("/freeze", "POST", { confirm: true }, await stepUp(t.request, t.owner), t.stored().document.revision)).status).toBe(200);
      expect(await error((await t.upload(t.owner)).res)).toEqual([403, "共有終了後は変更できません"]);
      expect(await t.list(t.owner)).toHaveLength(3);
      expect((await t.image(t.owner, a.id)).status).toBe(200);
    });
    test("photo: the host keeps the ciphertext as given and the record keeps capturedAt in plain and location only as ciphertext", async () => {
      const t = await withMedia(), { m } = t;
      const revision = t.stored().document.revision, a = await t.upload(m.participant.cookie);
      expect(a.res.status).toBe(201);
      for (const [size, fill, length] of [["display", 1, 5000], ["thumb", 2, 900]] as const) {
        const r = await t.image(m.viewer.cookie, a.id, size);
        expect(r.status).toBe(200); expect(r.headers.get("Content-Type")).toBe("application/octet-stream"); expect(r.headers.get("Cache-Control")).toBe("private, max-age=3600");
        expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array(length).fill(fill));
      }
      const [shown] = await t.list(m.viewer.cookie);
      expect(shown).toMatchObject({ id: a.id, capturedAt: "2026-09-25T10:15:00+09:00", width: 1536, height: 2048, thumb: { width: 300, height: 400 } });
      expect(shown!.location).toMatch(/^v1\.1\./);
      expect(await openField(t.trip, t.created.id, "photo", a.id, "location", shown!.location!)).toBe('{"lat":35.6812,"lng":139.7671}');
      expect(JSON.stringify(t.stored())).not.toContain("35.6812");
      // The record holds no image; a plain location, caption or key is refused.
      expect(JSON.stringify(t.stored().media)).not.toContain(a.body.images.thumb);
      for (const plain of [{ location: '{"lat":35.6812,"lng":139.7671}' }, { caption: "朝の市場" }, { key: "photo-key" }]) expect((await t.upload(m.participant.cookie, plain)).res.status).toBe(400);
      // Nor did it put a line in the capsule's history: five hundred photos would push the invites' history out.
      expect(t.stored().audit.some((l: { event: string }) => l.event === "media")).toBe(false);
      // Nothing about the photo moved the trip's revision, so nobody else is told of an update.
      expect((await (await t.request("", "GET", undefined, t.owner)).json()).document.revision).toBe(revision);
    });
    test("photo: the uploader, owner and editor remove; others 403; removed is 404", async () => {
      const t = await withMedia(), { m } = t;
      const remove = (cookie: string, id: string) => t.request("/media", "PATCH", { type: "remove", id }, cookie);
      const [a, b, c, d] = [await t.upload(m.participant.cookie), await t.upload(m.participant.cookie), await t.upload(m.participant.cookie), await t.upload(m.other.cookie)];
      expect(await error(await remove(m.other.cookie, a.id))).toEqual([403, "自分の写真だけ消せます"]);
      expect((await remove(m.viewer.cookie, a.id)).status).toBe(403);
      expect((await remove(m.participant.cookie, a.id)).status).toBe(200);
      expect((await remove(m.editor.cookie, b.id)).status).toBe(200);
      expect((await remove(t.owner, c.id)).status).toBe(200);
      for (const gone of [a, b, c]) { expect((await t.image(t.owner, gone.id)).status).toBe(404); expect((await t.image(t.owner, gone.id, "thumb")).status).toBe(404); }
      expect(await error(await remove(t.owner, a.id))).toEqual([404, "写真が見つかりません"]);
      expect((await t.list(m.viewer.cookie)).map(p => p.id)).toEqual([d.id]);
      // The images are kept under a name the host gave the upload, not the photo's id; what is left is the one photo's two.
      const [kept] = t.stored().media as Array<{ id: string; blob: string }>;
      expect(kept!.id).toBe(d.id); expect(kept!.blob).not.toBe(d.id);
      expect(readdirSync(join(t.dir, t.host.digest(t.created.id))).sort()).toEqual([`${kept!.blob}.display`, `${kept!.blob}.thumb`]);
      // A seat that is gone leaves its photos with the trip.
      const seat = await t.self(m.other.cookie);
      expect((await t.request("/revoke", "POST", { member: seat.id, confirm: true }, await stepUp(t.request, t.owner))).status).toBe(200);
      expect((await t.list(t.owner)).map(p => p.id)).toEqual([d.id]); expect((await t.image(t.owner, d.id)).status).toBe(200);
    });
    test("photo: no seat, a revoked seat or another trip's cookie gets no image", async () => {
      const t = await withMedia(), { m } = t, a = await t.upload(m.participant.cookie);
      expect((await t.image("", a.id)).status).toBe(401);
      const other = await withMedia();
      expect((await t.image(other.owner, a.id)).status).toBe(401);
      const seat = await t.self(m.viewer.cookie);
      expect((await t.request("/revoke", "POST", { member: seat.id, confirm: true }, await stepUp(t.request, t.owner))).status).toBe(200);
      expect((await t.image(m.viewer.cookie, a.id)).status).toBe(401);
      expect((await t.request("/media", "POST", {}, m.viewer.cookie)).status).toBe(401);
      expect((await t.request("/media", "PATCH", { type: "remove", id: a.id }, m.viewer.cookie)).status).toBe(401);
      // A name that is not a photo of the trip, or not an image of it, is not found.
      expect((await t.image(t.owner, gid())).status).toBe(404);
      expect((await t.request(`/media/${a.id}/original`, "GET", undefined, t.owner)).status).toBe(404);
    });
    test("photo limits: 500 photos, size, a time without an offset, a location that is not ciphertext", async () => {
      const t = await withMedia(), { m } = t, post = (over: Record<string, unknown>, sizes?: { display: number; thumb: number }) => t.upload(m.participant.cookie, over, sizes);
      // Sizes are the sealed bytes' lengths: the limit and the 28 bytes of IV and tag.
      expect((await post({}, { display: 1024 * 1024 + 28, thumb: 150 * 1024 + 28 })).res.status).toBe(201);
      expect(await error((await post({}, { display: 1024 * 1024 + 29, thumb: 900 })).res)).toEqual([413, "写真が大きすぎます（長辺 2048px・1 MiB まで）"]);
      expect(await error((await post({}, { display: 5000, thumb: 150 * 1024 + 29 })).res)).toEqual([413, "写真が大きすぎます（長辺 400px・150 KiB まで）"]);
      expect((await post({}, { display: 28, thumb: 900 })).res.status).toBe(400);
      expect((await post({ images: { display: "not base64!", thumb: "AAAA" } })).res.status).toBe(400);
      // Dimensions past the limit, a time without an offset, a plain or wrong-form ciphertext and an id that is taken.
      expect((await post({ width: 2049 })).res.status).toBe(400); expect((await post({ height: 0 })).res.status).toBe(400); expect((await post({ thumb: { width: 401, height: 300 } })).res.status).toBe(400);
      expect((await post({ capturedAt: "2026-09-25T10:15:00" })).res.status).toBe(400); expect((await post({ capturedAt: "昼" })).res.status).toBe(400);
      expect((await post({ location: "v1.x" })).res.status).toBe(400);
      const first = (await t.list(m.participant.cookie))[0]!;
      expect(await error((await post({ id: first.id })).res)).toEqual([409, "同じ写真がもう上がっています"]);
      expect((await post({ unknown: 1 })).res.status).toBe(400);
      // The 500th is taken, the next refused, whatever the record holds.
      const row = (await t.host.store.get(t.host.digest(t.created.id)))!, c = JSON.parse(row.payload!);
      c.media = [...c.media, ...Array.from({ length: 498 }, (_, i) => ({ id: i.toString(16).padStart(32, "0"), contributor: "gone", uploadedAt: "2026-09-25T00:00:00.000Z", width: 1, height: 1, thumb: { width: 1, height: 1 }, key: "v1.1.x" }))];
      expect(await t.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
      expect((await post({})).res.status).toBe(201);
      expect(await error((await post({})).res)).toEqual([413, "この旅行の写真は 500 枚までです"]);
      // A trip not yet sealed has no key to seal a photo with.
      const plain = await setup(undefined, { MEDIA: new LocalMediaStore(t.dir), CAPSULE_PHOTOS: "1" }), owner = await stepUp(plain.request, await plain.login(plain.created.url));
      expect(await error(await plain.request("/media", "POST", {}, owner))).toEqual([409, "旅行を暗号化してから写真を上げてください"]);
    });
    test("photo: off unless the operator turns it on — nothing is put up, the trip says so, and what is there is still read and taken out", async () => {
      const dir = mkdtempSync(join(tmpdir(), "capsule-host.media.")); dirs.push(dir);
      const t = await withMedia(), off = await sealedTrip({ MEDIA: new LocalMediaStore(dir) }), id = gid();
      expect((await (await off.request("", "GET", undefined, off.owner)).json()).photos).toBe(false);
      expect((await t.request("", "GET", undefined, t.owner)).status).toBe(200); expect((await (await t.request("", "GET", undefined, t.owner)).json()).photos).toBe(true);
      const body = { id, images: { display: Buffer.alloc(40).toString("base64"), thumb: Buffer.alloc(40).toString("base64") }, width: 1, height: 1, thumb: { width: 1, height: 1 }, key: await sealField(off.trip, off.created.id, 1, "photo", id, "key", "k") };
      expect(await error(await off.request("/media", "POST", body, off.owner))).toEqual([403, "写真は今は使えません"]);
      expect(readdirSync(dir)).toEqual([]);
      // Turned off after photos were put up: they are still read and removed.
      const a = await t.upload(t.m.participant.cookie); expect(a.res.status).toBe(201);
      t.host.env.CAPSULE_PHOTOS = "0";
      expect((await t.image(t.owner, a.id)).status).toBe(200); expect(await error((await t.upload(t.m.participant.cookie)).res)).toEqual([403, "写真は今は使えません"]);
      expect((await t.request("/media", "PATCH", { type: "remove", id: a.id }, t.m.participant.cookie)).status).toBe(200);
    });
    test("photo limits: a host with no place for photos refuses them, and the screen's csp lets a blob: image show", async () => {
      const t = await sealedTrip({ CAPSULE_PHOTOS: "1" }), id = gid();
      expect((await t.request("/media", "POST", { id, images: { display: Buffer.alloc(40).toString("base64"), thumb: Buffer.alloc(40).toString("base64") }, width: 1, height: 1, thumb: { width: 1, height: 1 }, key: await sealField(t.trip, t.created.id, 1, "photo", id, "key", "k") }, t.owner)).status).toBe(503);
      const read = await t.request("", "GET", undefined, t.owner);
      expect(read.headers.get("Content-Security-Policy")).toContain("img-src 'self' data: blob:;"); expect(read.headers.get("Cache-Control")).toBe("no-store");
    });
    test("photo: an upload that fails, loses the race for the capsule or meets a purge leaves no image; one that is not its own never writes over a photo", async () => {
      // A capsule that cannot hold the record: the images were put, and are taken out again.
      const full = await withMedia();
      const row = (await full.host.store.get(full.host.digest(full.created.id)))!, c = JSON.parse(row.payload!);
      c.audit = Array.from({ length: 5 }, () => ({ event: "x", at: 1, pad: "x".repeat(400_000) }));
      expect(await full.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
      expect(await error((await full.upload(full.m.participant.cookie)).res)).toEqual([413, "カプセルの容量上限です"]);
      expect(readdirSync(full.dir)).toEqual([]);
      // Losing the race for the capsule once: the images are put once, kept by the one record, and the upload goes through.
      let puts = 0, race: () => Promise<void> = async () => {};
      const t = await withMedia(real => ({ put: async (p, n, b) => { puts++; await real.put(p, n, b); const hook = race; race = async () => {}; await hook(); }, get: (p, n) => real.get(p, n), remove: (p, n) => real.remove(p, n), removeAll: p => real.removeAll(p) }));
      race = async () => { expect((await t.request("/footprints", "PATCH", { type: "remove", id: "none" }, t.owner)).status).toBe(404); const r = (await t.host.store.get(t.host.digest(t.created.id)))!; expect(await t.host.store.save(r, r.payload, r.purge_at, now)).toBe(true); };
      const a = await t.upload(t.m.participant.cookie); expect(a.res.status).toBe(201);
      expect(puts).toBe(2); expect(readdirSync(join(t.dir, t.host.digest(t.created.id)))).toHaveLength(2);
      // The same id again: refused, and the first photo's bytes are as they were.
      const again = await t.upload(t.m.other.cookie, { id: a.id });
      expect(await error(again.res)).toEqual([409, "同じ写真がもう上がっています"]);
      expect(new Uint8Array(await (await t.image(t.owner, a.id)).arrayBuffer())).toEqual(new Uint8Array(5000).fill(1));
      expect(readdirSync(join(t.dir, t.host.digest(t.created.id)))).toHaveLength(2);
      // A purge that lands between the two images: the upload meets a deleted trip, and what it put is taken out.
      const raced = await withMedia(real => ({ put: async (p, n, b) => { await real.put(p, n, b); const hook = race; race = async () => {}; await hook(); }, get: (p, n) => real.get(p, n), remove: (p, n) => real.remove(p, n), removeAll: p => real.removeAll(p) }));
      race = async () => { expect((await raced.request("/purge", "POST", { title: "" }, await stepUp(raced.request, raced.owner))).status).toBe(200); };
      expect((await raced.upload(raced.m.participant.cookie)).res.status).toBe(410);
      expect(readdirSync(raced.dir)).toEqual([]);
    });
    test("photo limits: a page reading hundreds of images is counted by seat and apart from the address's count, which the rest of the API keeps", async () => {
      const t = await withMedia(), a = await t.upload(t.m.participant.cookie), ip = "198.51.100.7";
      const get = (path: string) => t.host.fetch(new Request(`${origin}/v1/c/${t.created.id}${path}?ui=2`, { headers: { Origin: origin, Cookie: t.m.participant.cookie, "cf-connecting-ip": ip } }));
      for (let i = 0; i < 600; i++) expect((await get(`/media/${a.id}/thumb`)).status).toBe(200);
      expect((await get(`/media/${a.id}/thumb`)).status).toBe(429);
      // The same address still reads the trip: the images did not use up its 300 a minute.
      expect((await get("")).status).toBe(200);
    });
    test("photo purge: owner purge, terminate and the sweep empty the media directory", async () => {
      for (const how of ["purge", "terminate", "sweep"] as const) {
        const t = await withMedia(), { m } = t, prefix = t.host.digest(t.created.id);
        const a = await t.upload(m.participant.cookie); expect(a.res.status).toBe(201); expect((await t.upload(t.owner)).res.status).toBe(201);
        expect(readdirSync(join(t.dir, prefix))).toHaveLength(4);
        if (how === "purge") expect((await t.request("/purge", "POST", { title: "" }, await stepUp(t.request, t.owner))).status).toBe(200);
        else if (how === "terminate") expect((await t.host.fetch(new Request(origin + `/v1/c/${t.created.id}/terminate`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ id: t.created.id, confirm: true }) }))).status).toBe(200);
        else { now = +new Date(t.seed.spec.lifecycle.purgeAt) + 1000; await t.host.sweep(now); }
        expect(readdirSync(t.dir)).toEqual([]);
        expect((await t.host.store.get(prefix))!.payload).toBeNull();
        if (how !== "sweep") expect((await t.image(t.owner, a.id)).status).toBe(410);
      }
    });
    test("photo purge: a sweep whose media removal fails leaves the trip for the next sweep", async () => {
      let failing = true;
      const t = await withMedia(real => ({ put: (p, n, b) => real.put(p, n, b), get: (p, n) => real.get(p, n), remove: (p, n) => real.remove(p, n), removeAll: p => failing ? Promise.reject(new Error("down")) : real.removeAll(p) }));
      const prefix = t.host.digest(t.created.id), lines: string[] = []; t.host.log = l => lines.push(l.reason);
      expect((await t.upload(t.m.participant.cookie)).res.status).toBe(201);
      now = +new Date(t.seed.spec.lifecycle.purgeAt) + 1000; await t.host.sweep(now);
      expect((await t.host.store.get(prefix))!.payload).not.toBeNull(); expect(readdirSync(join(t.dir, prefix))).toHaveLength(2); expect(lines).toContain("sweep:media");
      failing = false; await t.host.sweep(now);
      expect((await t.host.store.get(prefix))!.payload).toBeNull(); expect(readdirSync(t.dir)).toEqual([]);
    });
  });
});

describe("moving a plain trip", () => {
  // A plain trip with words of every kind, a step back, two seats' points and names of its own, moved by its owner's browser as
  // src/trip-keys.ts sealMove does it: GET seal, GET grants, then one POST seal (docs/design/trip-e2e.md §5).
  type Setup = Awaited<ReturnType<typeof setup>>;
  const during = +new Date("2026-09-25T01:00:00Z"), here = { lat: 35.6812, lng: 139.7671, accuracy: 20 };
  const words = ["テスト旅行", "集合", "駅前の広場", "旅のしおり", "朝市に行きたい", "相談の言葉", "傘を持つ", "宿代", "98765", "旅のメモの言葉", "直した予定の題", "35.6812", "139.7671", "名前を変えた人", "家族への招待", "オーナー", "メンバー2"];
  const error = async (r: Response) => [r.status, (await r.json()).error];
  async function plainTrip(t?: Setup) {
    t ??= await setup();
    const owner = await stepUp(t.request, await t.login(t.created.url)); now = during; await stepUp(t.request, owner);
    let view = await (await t.request("", "GET", undefined, owner)).json();
    const answer = structuredClone(revisable(view.spec, view.document)); answer.document.items[0]!.title = "直した予定の題";
    expect((await t.request("/revise", "POST", { text: "```json\n" + JSON.stringify(answer) + "\n```", confirm: true }, owner, view.document.revision)).status).toBe(200);
    view = await (await t.request("", "GET", undefined, owner)).json();
    const item = { ...view.document.items[1]!, place: { label: "駅前の広場", publicUrl: "https://example.com/plaza" }, description: "旅のしおり" };
    for (const op of [{ type: "item", item }, { type: "suggest", author: "A", body: "朝市に行きたい" }, { type: "comment", author: "A", body: "相談の言葉" }, { type: "checklist", checklist: [{ id: "c1", title: "傘を持つ" }] },
      { type: "budget", budget: [{ id: "b1", title: "宿代", amount: 98765, description: "" }] }, { type: "notes", body: "旅のメモの言葉" }]) {
      expect((await t.request("/document", "PATCH", op, owner, view.document.revision)).status).toBe(200); view.document.revision++;
    }
    const grant = await (await t.request("/grants", "POST", { role: "participant", label: "家族への招待", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json();
    const member = await t.login(grant.url), seat = (await (await t.request("", "GET", undefined, member)).json()).self.id;
    expect((await t.request("/members", "PATCH", { id: seat, label: "名前を変えた人" }, owner)).status).toBe(200);
    for (const cookie of [owner, member]) expect((await t.request("/footprints", "PATCH", { type: "add", ...here }, cookie)).status).toBe(200);
    const keys = await newSeatKeys(), pub = await seatPublic(keys), trip = await newTripKey(), wrap = await wrapTripKey(trip, pub.x25519, t.created.id, 1);
    expect((await t.request("/keys", "PATCH", { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped }, owner)).status).toBe(200);
    // What the owner's browser reads, and the body it makes of it.
    const read = async () => {
      const v = await (await t!.request("", "GET", undefined, owner)).json(), { previous } = await (await t!.request("/seal", "GET", undefined, owner)).json();
      return { view: v, input: { spec: v.spec, document: v.document, previous, footprints: v.footprints, grants: await (await t!.request("/grants", "GET", undefined, owner)).json() } };
    };
    const move = async (body: object, revision?: number) => { await stepUp(t!.request, owner); return t!.request("/seal", "POST", body, owner, revision ?? (await read()).view.document.revision); };
    const stored = () => JSON.parse((t!.db.db.query("SELECT payload FROM trip_capsules WHERE payload IS NOT NULL").get() as { payload: string }).payload);
    return { ...t, owner, member, seat, trip, read, move, stored };
  }

  test("置き直し: one POST seal leaves no plain word, point or name in any row; the trip, points and step back open as they were", async () => {
    const t = await plainTrip(), { view, input } = await t.read();
    expect(input.previous.document.items[0].title).not.toBe("直した予定の題");
    const r = await t.move(await sealMove(t.trip, t.created.id, 1, input)); expect(r.status).toBe(200);
    // Every row of every table: the version CAS wrote the trip over its plain row, so no plain version is left anywhere.
    const tables = (t.db.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(x => x.name);
    const dump = JSON.stringify(tables.map(name => t.db.db.query(`SELECT * FROM ${name}`).all()));
    for (const w of words) expect(dump).not.toContain(w);
    expect((t.db.db.query("SELECT count(*) AS n FROM trip_capsules").get() as { n: number }).n).toBe(1);
    const after = await (await t.request("", "GET", undefined, t.owner)).json();
    expect(after.sealed).toEqual({ generation: 1 });
    expect(await openTrip(t.trip, t.created.id, after)).toEqual({ spec: view.spec, document: { ...view.document, revision: view.document.revision + 1 }, unreadable: [] });
    const kept = t.stored(), back = (await openTrip(t.trip, t.created.id, { spec: kept.previous.spec, document: { ...kept.document, ...kept.previous.document } }))!;
    expect(back.document.items.map(i => i.title)).toEqual(input.previous.document.items.map((i: { title: string }) => i.title));
    expect(kept.previous.revisedIds).toEqual(input.previous.revisedIds);
    // The points keep their seat, time and id; their place and name open back.
    expect(after.footprints.map((p: { id: string }) => p.id)).toEqual(view.footprints.map((p: { id: string }) => p.id));
    for (const p of after.footprints) {
      expect(await openPoint(t.trip, t.created.id, p.id, p.point)).toEqual(here);
      expect(await openName(t.trip, t.created.id, "footprint", p.id, p.by)).toBe(view.footprints.find((x: { id: string }) => x.id === p.id).by);
    }
    expect(after.footprints.map((p: { mine: boolean }) => p.mine)).toEqual([true, false]);
    for (const p of kept.footprints) expect(Object.keys(p).sort()).toEqual(["at", "by", "id", "point", "seat"]);
    const grants = await (await t.request("/grants", "GET", undefined, t.owner)).json() as Array<{ id: string; role: string; label: string; members: Array<{ id: string; label: string }> }>;
    const family = grants.find(g => g.members.some(m => m.id === t.seat))!;
    expect(await openName(t.trip, t.created.id, "grant", family.id, family.label)).toBe("家族への招待");
    expect(await openName(t.trip, t.created.id, "member", t.seat, family.members[0]!.label)).toBe("名前を変えた人");
    expect(grants.find(g => g.role === "owner")!.label).toBe("自分用");
    // The history keeps its lines, with no name but the publisher's.
    const history = await (await t.request("/history", "GET", undefined, t.owner)).json() as Array<Record<string, unknown>>;
    expect(history.map(h => h.event)).toEqual(expect.arrayContaining(["publish", "grants", "sessions"]));
    for (const h of history) { expect(h.label).toBeUndefined(); expect([undefined, "発行者", "作成者"]).toContain(h.by as string | undefined); }
  });
  test("競合: a point, a seat or an invite added or gone meanwhile is 409, a plain name 400, an old If-Match 409", async () => {
    const t = await plainTrip(), first = await t.read(), body = await sealMove(t.trip, t.created.id, 1, first.input);
    now += 60000; expect((await t.request("/footprints", "PATCH", { type: "add", ...here }, t.member)).status).toBe(200);
    expect(await error(await t.move(body))).toEqual([409, "足あとが増えました。もう一度移してください"]);
    const again = await sealMove(t.trip, t.created.id, 1, (await t.read()).input);
    expect(await t.login((await (await t.request("/grants", "POST", { role: "viewer", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, t.owner)).json()).url)).toBeTruthy();
    expect(await error(await t.move(again))).toEqual([409, "メンバーが増えました。もう一度移してください"]);
    const third = await sealMove(t.trip, t.created.id, 1, (await t.read()).input);
    expect((await t.move({ ...third, members: { ...third.members, [t.seat]: "花子" } })).status).toBe(400);
    // A seat or an invite the body names that is not here any more (revoked, expired, refused meanwhile): read again, as for one added.
    const changed = [409, "メンバーが変わりました。もう一度移してください"]; now += 61000;  // each move checks the passkey: the login limit is 15 a minute
    expect(await error(await t.move({ ...third, grants: { ...third.grants, nope: third.grants[Object.keys(third.grants)[0]!] } }))).toEqual(changed);
    expect(await error(await t.move({ ...third, members: { ...third.members, gone: third.members[t.seat]! } }))).toEqual(changed);
    expect((await t.move({ ...third, footprints: [...third.footprints, third.footprints[0]] })).status).toBe(409);
    expect(await error(await t.move(third, first.view.document.revision - 1))).toEqual([409, "別の人が更新しました。再読込して内容を確認し、もう一度操作してください"]);
    expect(t.stored().sealed).toBeUndefined();
    expect((await t.move(third)).status).toBe(200);
  });
  test("大きな旅行: with its step back past the limit, 413 leaves the trip as it was; without the step back it moves; still too large stays plain", async () => {
    // Items written straight into the row, as a trip published before the limits might hold them: ASCII words, which seal to about 4/3.
    const grow = async (t: Awaited<ReturnType<typeof plainTrip>>, size: number, withPrevious: boolean) => {
      const row = (await t.host.store.get(t.host.digest(t.created.id)))!, c = JSON.parse(row.payload!), base = c.document.items[0];
      c.document.items = Array.from({ length: 300 }, (_, n) => ({ ...base, id: `big${n}`, title: `予定${n}`, description: "a".repeat(size) }));
      if (withPrevious) c.previous = { spec: c.spec, document: { items: c.document.items, checklist: c.document.checklist, notes: c.document.notes, budget: c.document.budget } };
      else delete c.previous;
      expect(await t.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
    };
    const t = await plainTrip(); await grow(t, 2700, true);
    const trip = (x: Record<string, unknown>) => JSON.stringify([x.spec, x.document, x.previous, x.footprints, x.sealed]);
    const { view, input } = await t.read(), before = trip(t.stored());
    expect(Buffer.byteLength(JSON.stringify(t.stored()))).toBeLessThan(1_900_000);
    // Past 2 MiB the body itself is refused (本文が大きすぎます), past 1,900,000 bytes the capsule: 413 either way, which the screen reads alike.
    expect((await t.move(await sealMove(t.trip, t.created.id, 1, input))).status).toBe(413);
    expect(trip(t.stored())).toBe(before);
    expect(t.stored()).toMatchObject({ document: { revision: view.document.revision }, spec: { title: view.spec.title } });
    expect((await t.move(await sealMove(t.trip, t.created.id, 1, input, { dropPrevious: true }))).status).toBe(200);
    expect(t.stored().previous).toBeUndefined(); expect(t.stored().sealed).toEqual({ generation: 1 });
    // One too large even without its step back stays plain, and is used as before.
    const big = await plainTrip(); await grow(big, 1, false);
    const row = (await big.host.store.get(big.host.digest(big.created.id)))!, c = JSON.parse(row.payload!);
    c.document.items = c.document.items.map((i: { description: string }) => ({ ...i, description: "あ".repeat(1700) }));
    expect(await big.host.store.save(row, JSON.stringify(c), row.purge_at, now)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(big.stored()))).toBeLessThan(1_900_000);
    const plainOnly = await big.read();
    expect((await big.move(await sealMove(big.trip, big.created.id, 1, plainOnly.input, { dropPrevious: true }))).status).toBe(413);
    expect(big.stored().sealed).toBeUndefined();
    expect((await big.request("/document", "PATCH", { type: "notes", body: "まだ平文" }, big.owner, plainOnly.view.document.revision)).status).toBe(200);
  });
  test("役割: only the owner reads GET seal, and only before the trip is sealed", async () => {
    const t = await plainTrip();
    expect((await t.request("/seal", "GET", undefined, t.member)).status).toBe(403);
    expect(await (await t.request("/seal", "GET", undefined, t.owner)).json()).toMatchObject({ previous: { revisedIds: expect.any(Object) } });
    expect((await t.move(await sealMove(t.trip, t.created.id, 1, (await t.read()).input))).status).toBe(200);
    expect(await error(await t.request("/seal", "GET", undefined, t.owner))).toEqual([409, "旅程はもう暗号化してあります"]);
  });
});

describe("after the new screen is out", () => {
  // CAPSULE_SEALED_FROM: a trip published at or after it is not used plain (docs/design/trip-e2e.md §5). The line is put in the
  // host's clock between two trips; a request without ui=2 is an older screen's.
  type Setup = Awaited<ReturnType<typeof setup>>;
  const error = async (r: Response) => [r.status, (await r.json()).error];
  const old = (t: Setup, path = "", cookie?: string) => t.host.fetch(new Request(origin + `/v1/c/${t.created.id}${path}`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } }));
  const list = async (t: Setup) => (await (await t.host.fetch(new Request(origin + "/v1/capsules/list", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" }))).json()) as Array<Record<string, unknown>>;
  // A trip with an owner and a participant, then the line put just before or after its publishing.
  async function trip(after: boolean) {
    const t = await setup(undefined, { CAPSULE_SEALED_FROM: new Date(now - 1000).toISOString() });
    if (!after) t.host.sealedFrom = now + 1000;
    // The participant is invited before the line is drawn: after it, the owner can hand out no invite until the trip is moved.
    const line = t.host.sealedFrom; t.host.sealedFrom = undefined;
    const owner = await stepUp(t.request, await t.login(t.created.url));
    const member = await t.login((await (await t.request("/grants", "POST", { role: "participant", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json()).url);
    t.host.sealedFrom = line;
    return { ...t, owner, member };
  }
  async function move(t: { request: Setup["request"]; created: { id: string }; owner: string }) {
    const keys = await newSeatKeys(), pub = await seatPublic(keys), key = await newTripKey(), wrap = await wrapTripKey(key, pub.x25519, t.created.id, 1);
    expect((await t.request("/keys", "PATCH", { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped }, t.owner)).status).toBe(200);
    const v = await (await t.request("", "GET", undefined, t.owner)).json(), { previous } = await (await t.request("/seal", "GET", undefined, t.owner)).json();
    const grants = await (await t.request("/grants", "GET", undefined, t.owner)).json();
    await stepUp(t.request, t.owner);
    return t.request("/seal", "POST", await sealMove(key, t.created.id, 1, { spec: v.spec, document: v.document, previous, footprints: v.footprints, grants }), t.owner, v.document.revision);
  }

  test("線: a trip published before the line is used plain as before; one after it, only by its owner, to move it", async () => {
    const before = await trip(false);
    expect((await (await before.request("", "GET", undefined, before.owner)).json()).mustSeal).toBe(false);
    expect((await before.request("/document", "PATCH", { type: "notes", body: "線の前" }, before.owner)).status).toBe(200);
    expect((await before.request("", "GET", undefined, before.member)).status).toBe(200);
    expect((await before.request("/export", "GET", undefined, before.owner)).status).toBe(200);
    const t = await trip(true), unsealed = [409, "オーナーがこの旅行を移すまで開けません"];
    expect((await (await t.request("", "GET", undefined, t.owner)).json()).mustSeal).toBe(true);
    expect(await error(await t.request("/document", "PATCH", { type: "notes", body: "線の後" }, t.owner))).toEqual(unsealed);
    expect(await error(await t.request("/footprints", "PATCH", { type: "add", lat: 35.6812, lng: 139.7671, accuracy: 20 }, t.owner))).toEqual(unsealed);
    expect(await error(await t.request("/grants", "POST", { role: "viewer", expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, t.owner))).toEqual(unsealed);
    expect(await error(await t.request("/export", "GET", undefined, t.owner))).toEqual(unsealed);
    expect(await error(await t.request("/history", "GET", undefined, t.owner))).toEqual(unsealed);
    expect(await error(await t.request("", "GET", undefined, t.member))).toEqual(unsealed);
    // What moving needs goes through: the keys, GET seal and grants, the passkey check, POST seal.
    expect((await move(t)).status).toBe(200);
    const view = await (await t.request("", "GET", undefined, t.owner)).json();
    expect(view).toMatchObject({ sealed: { generation: 1 }, mustSeal: false });
    expect((await t.request("", "GET", undefined, t.member)).status).toBe(200);
    expect((await t.request("/history", "GET", undefined, t.owner)).status).toBe(200);
    // Without the setting there is no line: the same trip is used plain.
    const none = await setup();
    expect(none.host.sealedFrom).toBeUndefined();
    const owner = await stepUp(none.request, await none.login(none.created.url));
    expect((await (await none.request("", "GET", undefined, owner)).json()).mustSeal).toBe(false);
    expect((await none.request("/document", "PATCH", { type: "notes", body: "設定なし" }, owner)).status).toBe(200);
    expect(() => new CloudHost({ DB: new LocalD1(), CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin, CAPSULE_SEALED_FROM: "いつか" })).toThrow("CAPSULE_SEALED_FROM は時刻で指定してください");
  });
  test("発行の上限: past 1,200,000 bytes a trip is not published; one just under it moves within 1,900,000", async () => {
    const t = await setup(), publish = (body: object) => t.host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirm: true }) }));
    const sized = (size: number) => { const seed = testTrip(), base = seed.document.items.find(i => i.startsAt)!; seed.document.items = Array.from({ length: 300 }, (_, n) => ({ ...base, id: `big${n}`, title: `予定${n}`, description: "a".repeat(size) })); return seed; };
    expect(await error(await publish(sized(4000)))).toEqual([413, "旅程が大きすぎます。予定や投稿を減らしてください"]);
    const r = await publish(sized(3600)); expect(r.status).toBe(201);
    const created = await r.json() as { id: string; url: string };
    const near = { ...t, created, request: (path = "", method = "GET", body?: unknown, cookie?: string, revision = 1) => t.host.fetch(new Request(origin + `/v1/c/${created.id}${path}?ui=2`, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })) };
    const secret = new URLSearchParams(new URL(created.url).hash.slice(1)).get("k"), joined = await near.request("/sessions", "POST", { secret });
    const owner = await stepUp(near.request, joined.headers.get("Set-Cookie")!.split(";")[0]!);
    const row = (await t.host.store.get(t.host.digest(created.id)))!;
    expect(Buffer.byteLength(row.payload!)).toBeGreaterThan(1_100_000);
    expect((await move({ ...near, owner })).status).toBe(200);
    const moved = (await t.host.store.get(t.host.digest(created.id)))!;
    expect(Buffer.byteLength(moved.payload!)).toBeGreaterThan(1_300_000); expect(Buffer.byteLength(moved.payload!)).toBeLessThanOrEqual(1_900_000);
  });
  test("古い画面: a request without ui=2 is asked to reload for a sealed trip and one after the line; a plain one before it works", async () => {
    const before = await trip(false), after = await trip(true), stale = [409, "画面を更新してください"];
    expect((await old(before, "", before.owner)).status).toBe(200);
    expect(await error(await old(after, "", after.owner))).toEqual(stale);
    expect((await move(before)).status).toBe(200);
    expect(await error(await old(before, "", before.owner))).toEqual(stale);
    expect(await error(await old(before, "", before.member))).toEqual(stale);
    expect((await old(before, "/theme.css", before.owner)).status).toBe(200);
  });
  test("一覧: whether a trip is sealed, and whether it must be moved before it is used", async () => {
    const t = await trip(true), of = async () => (await list(t)).find(c => c.id === t.created.id)!;
    expect(await of()).toMatchObject({ sealed: false, mustSeal: true });
    expect((await move(t)).status).toBe(200);
    expect(await of()).toMatchObject({ sealed: true, mustSeal: false });
  });
  test("線の後: the owner may still check its passkey, sign out and delete an unmoved trip", async () => {
    const t = await trip(true);
    expect((await t.request("/signout", "POST", { confirm: true }, t.member)).status).toBe(409);  // not the owner's
    await stepUp(t.request, t.owner);  // passkey/challenge and passkey/verify
    expect((await t.request("/purge", "POST", { title: t.seed.spec.title }, t.owner)).status).toBe(200);
    const other = await trip(true);
    expect((await other.request("/signout", "POST", { confirm: true }, other.owner)).status).toBe(200);
    // An owner without a passkey registers one there, as the move asks it to (428, then POST passkey).
    const bare = await setup(undefined, { CAPSULE_SEALED_FROM: new Date(now - 1000).toISOString() }), cookie = await bare.login(bare.created.url);
    expect((await stepUp(bare.request, cookie)) && (await (await bare.request("", "GET", undefined, cookie)).json()).passkey).toBe(true);
  });
});

// A sealed trip whose owner seat holds the trip key, and members given it by the confirmation-code handoff (#702), with the
// browsers' own functions. The seat keys stay in the test, as in the browsers.
type Keyed = { cookie: string; id: string; grant: string; seat: SeatKeys; pub: { x25519: string; ed25519: string } };
async function keyedTrip(env: { MEDIA?: MediaStore; CAPSULE_PHOTOS?: string } = {}) {
  const t = await setup(undefined, env), cookie = await stepUp(t.request, await t.login(t.created.url));
  const seat = await newSeatKeys(), pub = await seatPublic(seat), trip = await newTripKey(), wrap = await wrapTripKey(trip, pub.x25519, t.created.id, 1);
  expect((await t.request("/keys", "PATCH", { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped }, cookie)).status).toBe(200);
  const read = async (c: string) => (await (await t.request("", "GET", undefined, c)).json()) as any;
  const view = await read(cookie);
  expect((await t.request("/seal", "POST", { generation: 1, ...await sealTrip(trip, t.created.id, 1, { spec: view.spec, document: view.document }), ...await moveNames(t, trip, cookie), confirm: true }, cookie, view.document.revision)).status).toBe(200);
  const owner: Keyed = { cookie, id: view.self.id, grant: t.created.grantId, seat, pub };
  // A member's seat, with no key yet. A sealed trip's invite carries the id the browser chose.
  const join = async (body: object = {}) => {
    const r = await t.request("/grants", "POST", { role: "participant", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, ...body }, owner.cookie);
    expect(r.status).toBe(201); const g = await r.json(), c = await t.login(g.url);
    return { cookie: c, id: ((await read(c)).self?.id ?? "") as string, grant: g.grantId as string };  // no id for a seat awaiting approval
  };
  // Steps 1-4 and the two edges, from a seat holding the key to one waiting.
  const hand = async (giver: Keyed, to: { cookie: string; id: string; grant: string }, key = trip, generation = 1): Promise<Keyed> => {
    const ms = await newSeatKeys(), mp = await seatPublic(ms), attempt = await newAttempt(mp, t.created.id), h = await newHandoffKeys();
    const att = (await (await t.request("/keys", "PATCH", { type: "wait", commitment: attempt.commitment }, to.cookie)).json()).handoff.attempt;
    expect((await t.request("/keys", "PATCH", { type: "give", seat: to.id, attempt: att, ephemeral: h.ephemeral }, giver.cookie)).status).toBe(200);
    expect((await t.request("/keys", "PATCH", { type: "reveal", attempt: att, ...mp, nonce: attempt.nonce }, to.cookie)).status).toBe(200);
    const w = await wrapTripKey(key, mp.x25519, t.created.id, generation, h.pair);
    expect((await t.request("/keys", "PATCH", { type: "wrap", seat: to.id, attempt: att, wrapped: w.wrapped }, giver.cookie)).status).toBe(200);
    expect((await t.request("/keys", "PATCH", { type: "edge", seat: to.id, signature: await signEdge(giver.seat.ed25519.privateKey, { seat: to.id, ...mp }, t.created.id) }, giver.cookie)).status).toBe(200);
    expect((await t.request("/keys", "PATCH", { type: "edge", seat: giver.id, signature: await signEdge(ms.ed25519.privateKey, { seat: giver.id, ...giver.pub }, t.created.id) }, to.cookie)).status).toBe(200);
    return { ...to, seat: ms, pub: mp };
  };
  const stored = () => JSON.parse((t.db.db.query("SELECT payload FROM trip_capsules WHERE payload IS NOT NULL").get() as { payload: string }).payload);
  return { ...t, trip, owner, read, join, hand, stored };
}

describe("rekey marks", () => {
  const mark = async (t: Awaited<ReturnType<typeof keyedTrip>>, cookie: string) => (await t.read(cookie)).rekey;
  test("替える: after a key holder's revocation, its invite's rotation or revocation, the owner is told to replace the key; others are not", async () => {
    for (const how of ["member", "rotate", "revoke"] as const) {
      const t = await keyedTrip(), a = await t.hand(t.owner, await t.join()), b = await t.hand(t.owner, await t.join());
      expect(await mark(t, t.owner.cookie)).toBeNull();
      const r = how === "member" ? await t.request("/revoke", "POST", { member: b.id, confirm: true }, t.owner.cookie)
        : how === "revoke" ? await t.request("/revoke", "POST", { id: b.grant, confirm: true }, t.owner.cookie)
        : await t.request("/grants", "POST", { role: "participant", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, rotate: b.grant }, t.owner.cookie);
      expect(r.status).toBe(how === "rotate" ? 201 : 200);
      expect(await mark(t, t.owner.cookie)).toBe("auto");
      expect(await mark(t, a.cookie)).toBeNull();
      expect(t.stored().departed).toEqual([{ seat: b.id, at: now, why: how === "member" ? "revoke" : "rotate" }]);
    }
  });
  test("替えない: an unredeemed invite revoked, sharing ended, a seat without the key revoked: nothing is recorded", async () => {
    const t = await keyedTrip(), keyless = await t.join(), pending = await t.join({ approval: "owner" });
    await t.hand(t.owner, await t.join());
    const unredeemed = await (await t.request("/grants", "POST", { role: "participant", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, t.owner.cookie)).json();
    expect((await t.request("/revoke", "POST", { id: unredeemed.grantId, confirm: true }, t.owner.cookie)).status).toBe(200);
    expect((await t.request("/revoke", "POST", { member: keyless.id, confirm: true }, t.owner.cookie)).status).toBe(200);
    expect((await t.request("/revoke", "POST", { id: pending.grant, confirm: true }, t.owner.cookie)).status).toBe(200);
    expect(await mark(t, t.owner.cookie)).toBeNull();
    const view = await t.read(t.owner.cookie);
    expect((await t.request("/freeze", "POST", { confirm: true }, t.owner.cookie, view.document.revision)).status).toBe(200);
    expect(await mark(t, t.owner.cookie)).toBeNull(); expect(t.stored().departed).toBeUndefined();
    // A plain trip records nothing either.
    const p = await setup(), owner = await stepUp(p.request, await p.login(p.created.url));
    const g = await (await p.request("/grants", "POST", { role: "participant", expiresAt: p.seed.spec.lifecycle.purgeAt, confirm: true }, owner)).json(), m = await p.login(g.url);
    const seat = await newSeatKeys(), pub = await seatPublic(seat), w = await wrapTripKey(await newTripKey(), pub.x25519, p.created.id, 1);
    expect((await p.request("/keys", "PATCH", { type: "seat", ...pub, ephemeral: w.ephemeral, generation: 1, wrapped: w.wrapped }, owner)).status).toBe(200);
    expect((await p.request("/revoke", "POST", { member: (await (await p.request("", "GET", undefined, m)).json()).self.id, confirm: true }, owner)).status).toBe(200);
    expect((await (await p.request("", "GET", undefined, owner)).json()).rekey).toBeNull();
  });
  test("期限: a key holder whose invite ends before the trip's deletion is recorded when the owner next opens it; one lasting to the deletion is not", async () => {
    const t = await keyedTrip(), purge = +new Date(t.seed.spec.lifecycle.purgeAt), ends = now + 10 * 86400000;
    const short = await t.hand(t.owner, await t.join({ expiresAt: new Date(ends).toISOString() })), long = await t.hand(t.owner, await t.join());
    now = ends - 1; expect(await mark(t, t.owner.cookie)).toBeNull();
    now = ends + 1; expect(await mark(t, t.owner.cookie)).toBe("auto");
    expect(t.stored().departed).toEqual([{ seat: short.id, at: ends + 1, why: "expired" }]);
    expect(t.stored().sessions.some((s: { id: string }) => s.id === short.id)).toBe(false);
    // The seat lasting to the deletion is still there just before it; the owner reads at least once a month to stay in.
    const t2 = await keyedTrip(), kept = await t2.hand(t2.owner, await t2.join());
    for (now += 20 * 86400000; now < purge - 1; now = Math.min(now + 20 * 86400000, purge - 1)) expect(await mark(t2, t2.owner.cookie)).toBeNull();
    expect(await mark(t2, t2.owner.cookie)).toBeNull(); expect(t2.stored().departed).toBeUndefined();
    expect(t2.stored().sessions.some((s: { id: string }) => s.id === kept.id)).toBe(true);
    expect(long.id).toBeString();
  });
  test("owner: after the owner invite's rotation or /recover the new owner is asked, even before it holds the key; keep clears it", async () => {
    for (const how of ["rotate", "recover"] as const) {
      const t = await keyedTrip(), a = await t.hand(t.owner, await t.join());
      const r = how === "rotate"
        ? await t.request("/grants", "POST", { role: "owner", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, rotate: t.owner.grant }, t.owner.cookie)
        : await t.request("/recover", "POST", { confirm: true });
      expect(r.status).toBe(201);
      const next = await t.login((await r.json()).url);
      expect(await mark(t, next)).toBe("ask");
      expect(t.stored().departed).toEqual([{ seat: t.owner.id, at: now, why: "owner" }]);
      expect((await t.request("/keys", "PATCH", { type: "keep" }, a.cookie)).status).toBe(403);
      expect((await t.request("/keys", "PATCH", { type: "keep" }, next)).status).toBe(428);
      expect((await t.request("/keys", "PATCH", { type: "keep" }, await stepUp(t.request, next))).status).toBe(200);
      expect(await mark(t, next)).toBeNull(); expect(t.stored().departed).toBeUndefined();
    }
    // Keeping leaves a member's departure to be replaced.
    const t = await keyedTrip(), b = await t.hand(t.owner, await t.join()); await t.hand(t.owner, await t.join());
    expect((await t.request("/revoke", "POST", { member: b.id, confirm: true }, t.owner.cookie)).status).toBe(200);
    const r = await t.request("/grants", "POST", { role: "owner", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, rotate: t.owner.grant }, t.owner.cookie);
    const next = await stepUp(t.request, await t.login((await r.json()).url));
    expect(await mark(t, next)).toBe("auto");
    expect((await t.request("/keys", "PATCH", { type: "keep" }, next)).status).toBe(200);
    expect(await mark(t, next)).toBe("auto"); expect(t.stored().departed.map((d: { why: string }) => d.why)).toEqual(["revoke"]);
  });
  test("最後の鍵: the owner invite is not rotated while no other seat holds the key", async () => {
    const t = await keyedTrip(), a = await t.join(); await t.join();
    const rotate = () => t.request("/grants", "POST", { role: "owner", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, rotate: t.owner.grant }, t.owner.cookie);
    const refused = await rotate();
    expect(refused.status).toBe(409); expect((await refused.json()).error).toBe("鍵を持つメンバーが他にいないため、交換すると旅程をだれも読めなくなります。先に別の端末かメンバーに鍵を渡してください");
    expect(t.stored().grants.find((g: { id: string }) => g.id === t.owner.grant).revoked).toBeNull();
    await t.hand(t.owner, a);
    expect((await rotate()).status).toBe(201);
    // A plain trip rotates as before.
    const p = await setup(), owner = await stepUp(p.request, await p.login(p.created.url));
    expect((await p.request("/grants", "POST", { role: "owner", expiresAt: p.seed.spec.lifecycle.purgeAt, confirm: true, rotate: p.created.grantId }, owner)).status).toBe(201);
  });
});

describe("rekey", () => {
  type K = Awaited<ReturnType<typeof keyedTrip>>;
  const during = +new Date("2026-09-25T01:00:00Z");
  const generations = (v: unknown) => new Set([...JSON.stringify(v).matchAll(/v1\.(\d+)\./g)].map(m => Number(m[1])));
  // The body the owner's browser sends (src/client.ts rekeyTrip): the trip read as it stands, sealed again under a new key, wrapped
  // to `to` with the owner seat's signature.
  async function rekey(t: K, by: Keyed, to: Keyed[], generation?: number) {
    const view = await t.read(by.cookie), grants = await (await t.request("/grants", "GET", undefined, by.cookie)).json();
    const old = await unwrapTripKey(view.seatKey.wrapped, view.seatKey.ephemeral, by.seat.x25519.privateKey, t.created.id, view.sealed.generation, true);
    const key = await newTripKey(), gen = generation ?? view.sealed.generation + 1;
    const sealed = await resealAll(old, key, t.created.id, gen, { spec: view.spec, document: view.document, footprints: view.footprints.map((p: any) => ({ id: p.id, point: p.point, by: p.by })), media: view.media, members: grants.flatMap((g: any) => g.members).map((m: any) => ({ id: m.id, label: m.label })), grants: grants.map((g: any) => ({ id: g.id, label: g.label })) });
    const seats = await Promise.all(to.map(async s => { const w = await wrapTripKey(key, s.pub.x25519, t.created.id, gen); return { seat: s.id, ...w, signature: await signRekey(by.seat.ed25519.privateKey, { capsuleId: t.created.id, generation: gen, seat: s.id, x25519: s.pub.x25519, ...w }) }; }));
    const body = { generation: gen, ...sealed, seats, confirm: true };
    return { key, old, gen, body, send: (over: object = {}, cookie = by.cookie) => t.request("/rekey", "POST", { ...body, ...over }, cookie, view.document.revision) };
  }
  const opens = async (t: K, m: Keyed, generation: number) => {
    const v = await t.read(m.cookie), key = await unwrapTripKey(v.seatKey.wrapped, v.seatKey.ephemeral, m.seat.x25519.privateKey, t.created.id, generation);
    return { key, trip: await openTrip(key, t.created.id, v), view: v };
  };
  test("替える: the owner seals the trip again under the next generation and wraps it to the seats that remain", async () => {
    const t = await keyedTrip(), a = await t.hand(t.owner, await t.join()), b = await t.hand(t.owner, await t.join());
    expect((await t.request("/revoke", "POST", { member: b.id, confirm: true }, t.owner.cookie)).status).toBe(200);
    const r = await rekey(t, t.owner, [t.owner, a]), sent = await r.send();
    expect(sent.status).toBe(200);
    const kept = t.stored();
    expect(kept.sealed).toEqual({ generation: 2 }); expect(kept.departed).toBeUndefined(); expect(kept.previous).toBeUndefined();
    expect(generations({ spec: kept.spec, document: kept.document, labels: [kept.sessions.map((s: any) => s.label), kept.grants.map((g: any) => g.label)] })).toEqual(new Set([2]));
    expect(kept.sessions.find((s: any) => s.id === a.id).seatKey).toMatchObject({ generation: 2, rekey: { seat: t.owner.id } });
    // A reads it with the new wrap, takes the generation as the owner's, and B's key opens none of it.
    const opened = await opens(t, a, 2);
    expect(opened.trip!.spec.title).toBe("テスト旅行");
    expect(await acceptRekey({ self: { id: a.id, ed25519: a.pub.ed25519 }, known: 1, capsuleId: t.created.id, seats: opened.view.seats, seatKey: opened.view.seatKey })).toBe(true);
    expect(await openTrip(r.old, t.created.id, opened.view)).toBeNull();
    expect((await t.read(t.owner.cookie)).rekey).toBeNull();
  });
  test("断る: only the owner holding the present generation replaces it, with the next generation, the records as they are, to seats of this trip", async () => {
    now = during;
    const t = await keyedTrip(), a = await t.hand(t.owner, await t.join());
    const id = crypto.randomUUID().replaceAll("-", "");
    expect((await t.request("/footprints", "PATCH", { type: "add", id, point: await sealPoint(t.trip, t.created.id, 1, id, { lat: 35, lng: 139, accuracy: 10 }), by: await sealName(t.trip, t.created.id, 1, "footprint", id, "足あとの人") }, a.cookie)).status).toBe(200);
    const r = await rekey(t, t.owner, [t.owner, a]), error = async (res: Response) => [res.status, (await res.json()).error];
    expect((await r.send({}, await stepUp(t.request, a.cookie))).status).toBe(403);
    expect(await error(await r.send({ generation: 3 }))).toEqual([400, "鍵の世代を確認してください"]);
    const mixed = structuredClone(r.body.document); mixed.notes = await sealField(r.old, t.created.id, 1, "notes", "notes", "body", "古い世代");
    expect(await error(await r.send({ document: mixed }))).toEqual([400, "鍵の世代を確認してください"]);
    expect(await error(await r.send({ footprints: [] }))).toEqual([409, "旅行が変わりました。開き直してください"]);
    expect(await error(await r.send({ members: r.body.members.slice(1) }))).toEqual([409, "旅行が変わりました。開き直してください"]);
    // A footprint's name goes as ciphertext only: the host gives none of its own.
    expect((await r.send({ footprints: r.body.footprints.map(p => ({ ...p, by: "足あとの人" })) })).status).toBe(400);
    const stranger = await seatPublic(await newSeatKeys()), w = await wrapTripKey(r.key, stranger.x25519, t.created.id, 2);
    expect(await error(await r.send({ seats: [...r.body.seats, { seat: "no-such-seat", ...w, signature: r.body.seats[0]!.signature }] }))).toEqual([400, "包む席を確認してください"]);
    expect(await error(await r.send({ seats: r.body.seats.filter(x => x.seat !== t.owner.id) }))).toEqual([400, "包む席を確認してください"]);
    expect(t.stored().sealed).toEqual({ generation: 1 });
    // An owner seat without the key (the new owner after the owner invite's rotation) cannot replace it.
    const g = await (await t.request("/grants", "POST", { role: "owner", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true, rotate: t.owner.grant }, t.owner.cookie)).json();
    const next = await stepUp(t.request, await t.login(g.url));
    expect(await error(await t.request("/rekey", "POST", r.body, next, (await t.read(next)).document.revision))).toEqual([409, "旅行の鍵がありません"]);
  });
  test("写真: a photo's key, location and caption are sealed again with the trip; its images stay as they are and open under the new key", async () => {
    now = during;
    const dir = mkdtempSync(join(tmpdir(), "capsule-host.media.")); const media = new LocalMediaStore(dir);
    try {
      const t = await keyedTrip({ MEDIA: media, CAPSULE_PHOTOS: "1" }), a = await t.hand(t.owner, await t.join());
      const id = crypto.randomUUID().replaceAll("-", ""), seal = (key: CryptoKey, gen: number, field: string, plain: string) => sealField(key, t.created.id, gen, "photo", id, field, plain);
      const shown = Buffer.alloc(300, 9).toString("base64");
      expect((await t.request("/media", "POST", { id, images: { display: shown, thumb: shown }, width: 10, height: 10, thumb: { width: 10, height: 10 }, key: await seal(t.trip, 1, "key", "photo-key"), location: await seal(t.trip, 1, "location", "here"), caption: await seal(t.trip, 1, "caption", "朝") }, a.cookie)).status).toBe(201);
      const r = await rekey(t, t.owner, [t.owner, a]);
      expect(r.body.media).toEqual([{ id, key: expect.stringMatching(/^v1\.2\./), location: expect.stringMatching(/^v1\.2\./), caption: expect.stringMatching(/^v1\.2\./) }]);
      // A photo the host holds that the body leaves out, or a caption it drops, is not the trip as it stands.
      const refused = async (over: object) => (await r.send(over)).status;
      expect(await refused({ media: [] })).toBe(409); expect(await refused({ media: [{ ...r.body.media[0]!, caption: undefined }] })).toBe(409);
      // A key still of the old generation is refused as every ciphertext of one is.
      expect(await refused({ media: [{ ...r.body.media[0]!, key: await seal(t.trip, 1, "key", "photo-key") }] })).toBe(400);
      expect((await r.send()).status).toBe(200);
      const [kept] = t.stored().media;
      expect(kept).toMatchObject({ id, contributor: a.id, width: 10 }); expect(generations(kept)).toEqual(new Set([2]));
      const opened = await opens(t, a, 2);
      for (const [field, plain] of [["key", "photo-key"], ["location", "here"], ["caption", "朝"]] as const) expect(await openField(opened.key, t.created.id, "photo", id, field, kept[field])).toBe(plain);
      expect(Buffer.from((await media.get(t.host.digest(t.created.id), `${kept.blob}.display`))!).toString("base64")).toBe(shown);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("古い世代の書き込み: once replaced, ciphertext of the previous generation is refused; the next generation's passes", async () => {
    now = during;
    const t = await keyedTrip(), a = await t.hand(t.owner, await t.join()), r = await rekey(t, t.owner, [t.owner, a]);
    expect((await r.send()).status).toBe(200);
    const doc = (await t.read(t.owner.cookie)).document, error = async (res: Response) => [res.status, (await res.json()).error];
    const item = (key: CryptoKey, gen: number) => sealOperation(key, t.created.id, gen, { type: "item", item: { id: "new1", kind: "meal", status: "proposed", title: "昼食", day: doc.items[0].day, revision: 1 }, after: doc.items[0].id }, doc as never);
    expect(await error(await t.request("/document", "PATCH", await item(r.old, 1), t.owner.cookie, doc.revision))).toEqual([409, "旅行の鍵が替わりました。開き直してください"]);
    expect((await t.request("/document", "PATCH", await item(r.key, 2), t.owner.cookie, doc.revision)).status).toBe(200);
    const fp = async (key: CryptoKey, gen: number) => { const id = crypto.randomUUID().replaceAll("-", ""); return { type: "add", id, point: await sealPoint(key, t.created.id, gen, id, { lat: 35, lng: 139, accuracy: 10 }), by: await sealName(key, t.created.id, gen, "footprint", id, "A") }; };
    expect((await t.request("/footprints", "PATCH", await fp(r.old, 1), a.cookie)).status).toBe(409);
    expect((await t.request("/footprints", "PATCH", await fp(r.key, 2), a.cookie)).status).toBe(200);
    expect((await t.request("/members", "PATCH", { id: a.id, label: await sealName(r.old, t.created.id, 1, "member", a.id, "古い名前") }, t.owner.cookie)).status).toBe(409);
    expect((await t.request("/members", "PATCH", { id: a.id, label: await sealName(r.key, t.created.id, 2, "member", a.id, "新しい名前") }, t.owner.cookie)).status).toBe(200);
    const gid = crypto.randomUUID().replaceAll("-", ""), grant = async (key: CryptoKey, gen: number) => t.request("/grants", "POST", { role: "participant", id: gid, label: await sealName(key, t.created.id, gen, "grant", gid, "招待"), expiresAt: t.seed.spec.lifecycle.purgeAt, confirm: true }, t.owner.cookie);
    expect((await grant(r.old, 1)).status).toBe(409);
    expect((await grant(r.key, 2)).status).toBe(201);
    const v = await t.read(t.owner.cookie), spec = { ...v.spec, title: await sealField(r.old, t.created.id, 1, "spec", "spec", "title", "古い題") };
    expect((await t.request("/spec", "PATCH", { spec, confirm: true }, t.owner.cookie, v.document.revision)).status).toBe(409);
  });
  test("待っている席: a seat the owner could not reach waits again, and takes the present generation by the codes", async () => {
    const t = await keyedTrip(), a = await t.hand(t.owner, await t.join()), c = await t.hand(a, await t.join());
    expect((await t.request("/revoke", "POST", { member: a.id, confirm: true }, t.owner.cookie)).status).toBe(200);
    const view = await t.read(t.owner.cookie);
    expect([...await reachableSeats({ id: t.owner.id, ed25519: t.owner.pub.ed25519 }, view.seats, t.created.id)]).toEqual([t.owner.id]);
    const r = await rekey(t, t.owner, [t.owner]);
    expect((await r.send()).status).toBe(200);
    expect((await t.read(t.owner.cookie)).waiting.map((w: any) => w.id)).toEqual([c.id]);
    expect((await t.read(c.cookie)).seatKey.generation).toBe(1);
    // A seat of an older generation gives nothing.
    const d = await t.join(), w = await (await t.request("/keys", "PATCH", { type: "wait", commitment: (await newAttempt(await seatPublic(await newSeatKeys()), t.created.id)).commitment }, d.cookie)).json();
    expect((await t.request("/keys", "PATCH", { type: "give", seat: d.id, attempt: w.handoff.attempt, ephemeral: (await newHandoffKeys()).ephemeral }, c.cookie)).status).toBe(403);
    expect((await t.request("/keys", "PATCH", { type: "abandon", attempt: w.handoff.attempt }, d.cookie)).status).toBe(200);
    const again = await t.hand(t.owner, c, r.key, 2);
    expect((await opens(t, again, 2)).trip!.spec.title).toBe("テスト旅行");
    expect((await t.read(t.owner.cookie)).waiting.map((x: any) => x.id)).toEqual([d.id]);
  });
  test("作り直し: a pair made again brings `since` and its edges, listed in seats, and the owner still reaches it", async () => {
    const t = await keyedTrip(), a = await t.hand(t.owner, await t.join()), cookie = await stepUp(t.request, a.cookie);
    const v = await t.read(cookie), trip = await unwrapTripKey(v.seatKey.wrapped, v.seatKey.ephemeral, a.seat.x25519.privateKey, t.created.id, 1, true);
    const seat = await newSeatKeys(), pub = await seatPublic(seat), w = await wrapTripKey(trip, pub.x25519, t.created.id, 1);
    const since = await signSuccession(a.seat.ed25519.privateKey, a.pub, { capsuleId: t.created.id, seat: a.id, ...pub });
    const edges = [{ seat: t.owner.id, signature: await signEdge(seat.ed25519.privateKey, { seat: t.owner.id, ...t.owner.pub }, t.created.id) }];
    const body = { type: "seat", ...pub, ephemeral: w.ephemeral, generation: 1, wrapped: w.wrapped, secret: await wrapSeatSecret(seat, crypto.getRandomValues(new Uint8Array(32)), t.created.id), since, edges };
    expect((await t.request("/keys", "PATCH", { ...body, generation: 2 }, cookie)).status).toBe(400);
    expect((await t.request("/keys", "PATCH", body, cookie)).status).toBe(200);
    const seats = (await t.read(t.owner.cookie)).seats;
    expect(seats.find((s: any) => s.id === a.id)).toEqual({ id: a.id, role: "participant", ...pub, edges, since });
    expect(JSON.stringify(seats)).not.toContain(w.wrapped);
    // A seat that holds no key is told none of them.
    expect((await t.read((await t.join()).cookie)).seats).toEqual([]);
    expect([...await reachableSeats({ id: t.owner.id, ed25519: t.owner.pub.ed25519 }, seats, t.created.id)].sort()).toEqual([t.owner.id, a.id].sort());
  });
});

