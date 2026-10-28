import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { emptyTrip } from "./template";
import { newAttempt, newHandoffKeys, newSeatKeys, newTripKey, openName, openPoint, openTrip, sealMove, sealName, sealOperation, sealPoint, sealSpec, seatPublic, wrapTripKey } from "./trip-keys";
// Fictional test data only. Not imported by client or production entrypoints.
// The day n days after `start` (YYYY-MM-DD), counted in UTC like `emptyTrip`.
export function tripDay(start: string, n: number) {
  const d = new Date(start); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function testTrip(start = "2026-09-24") {
  const [d0, d1, d2] = [0, 1, 2].map(n => tripDay(start, n));
  const seed = emptyTrip(d0!, d2!, "テスト旅行");
  seed.document.items = [
    { id: "arrival", title: "集合", day: d0!, startsAt: `${d0}T13:15:00+09:00`, kind: "transport", status: "confirmed", revision: 1 },
    { id: "dinner", title: "夕食", day: d1!, startsAt: `${d1}T19:00:00+09:00`, kind: "meal", status: "confirmed", revision: 1 },
    { id: "walk", title: "公園の散歩", day: d2!, startsAt: `${d2}T10:00:00+09:00`, timeTentative: true, kind: "activity", status: "proposed", revision: 1 },
  ];
  return seed;
}

// Stands in for a platform authenticator: builds the two byte strings a browser hands to the server.
export function fakeAuthenticator(options: { rsa?: boolean; origin?: string } = {}) {
  const origin = options.origin ?? "https://trip.example", rpId = new URL(origin).hostname, b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  const pair = options.rsa ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(20);
  let counter = 0;
  const authData = (flags: number, site: string, attested: boolean) => {
    const head = Buffer.alloc(37); createHash("sha256").update(site).digest().copy(head); head[32] = flags; head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), length, credentialId, Buffer.from([0xa5, 0x01, 0x02])]); // AAGUID, id, then the COSE key the server never parses
  };
  const clientData = (type: string, challenge: string, from: string) => Buffer.from(JSON.stringify({ type, challenge, origin: from, crossOrigin: false }));
  return {
    id: b64(credentialId),
    setCounter(n: number) { counter = n; },
    register(challenge: string, o: { origin?: string; rpId?: string; flags?: number; type?: string } = {}) {
      return { clientDataJSON: b64(clientData(o.type ?? "webauthn.create", challenge, o.origin ?? origin)), authenticatorData: b64(authData(o.flags ?? 0x45, o.rpId ?? rpId, true)), publicKey: b64(pair.publicKey.export({ format: "der", type: "spki" })), algorithm: options.rsa ? -257 : -7 };
    },
    assert(challenge: string, o: { origin?: string; rpId?: string; flags?: number; type?: string; key?: KeyObject } = {}) {
      const data = authData(o.flags ?? 0x05, o.rpId ?? rpId, false), client = clientData(o.type ?? "webauthn.get", challenge, o.origin ?? origin);
      const signature = sign("sha256", Buffer.concat([data, createHash("sha256").update(client).digest()]), o.key ?? pair.privateKey);
      return { clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(signature) };
    },
  };
}

// An owner's important actions need a passkey check in the last five minutes. A browser's first passkey counts as the check
// (registering it); after that the browser checks with that passkey. `send` takes a path under the capsule. Returns the cookie.
// `devices` is the browsers' passkeys by cookie; a test file clears it between tests.
export type Send = (path: string, method: string, body?: unknown, cookie?: string) => Promise<Response>;
export const devices = new Map<string, ReturnType<typeof fakeAuthenticator>>();
export async function stepUp(send: Send, cookie: string) {
  const { challenge } = await (await send("/passkey/challenge", "POST", {})).json() as { challenge: string }, device = devices.get(cookie);
  if (device) { await expectOk(send("/passkey/verify", "POST", { challenge, id: device.id, ...device.assert(challenge) }, cookie)); return cookie; }
  const fresh = fakeAuthenticator(); devices.set(cookie, fresh);
  await expectOk(send("/passkey", "POST", { challenge, ...fresh.register(challenge) }, cookie)); return cookie;
}
async function expectOk(r: Promise<Response>) { const res = await r; if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`); return res; }

// What a test sends to a capsule: as setup's `request` in src/cloud-host.test.ts (path under the capsule, If-Match revision, Origin).
export type CapsuleRequest = (path?: string, method?: string, body?: unknown, cookie?: string, revision?: number, source?: string) => Promise<Response>;
// The trip sealed as the owner's browser seals it as soon as its seat is taken (docs/design/trip-e2e.md §5, the third step of
// handing out: the host keeps no trip plain once it has an owner): the seat's keys and the trip key put on the seat (PATCH keys),
// then the trip, its step back, points and names sealed in one POST seal (src/trip-keys.ts sealMove). The owner's passkey check
// of the last five minutes is the caller's (stepUp), so that a test checking with a passkey of its own keeps it. Returns
// the trip key, which the test holds as every member's browser would, the revisions the seal took and the owner's seat.
export async function sealedTrip(request: CapsuleRequest, capsuleId: string, owner: string) {
  const seat = await newSeatKeys(), pub = await seatPublic(seat), trip = await newTripKey(), wrap = await wrapTripKey(trip, pub.x25519, capsuleId, 1);
  await expectOk(request("/keys", "PATCH", { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped }, owner));
  const view = await (await expectOk(request("", "GET", undefined, owner))).json(), grants = await (await expectOk(request("/grants", "GET", undefined, owner))).json();
  const { previous } = await (await expectOk(request("/seal", "GET", undefined, owner))).json();
  await expectOk(request("/seal", "POST", await sealMove(trip, capsuleId, 1, { spec: view.spec, document: view.document, previous, footprints: view.footprints, grants }), owner, view.document.revision));
  return { trip, revisions: 1, owner: { cookie: owner, seat, pub } };
}
// The trip key handed from a seat holding it to another member's seat, as their two browsers do it (docs/ephemeral-trip-capsule.md
// 「鍵の受け渡し」; PATCH keys wait → give → reveal → wrap. The codes the two screens compare are tested in src/cloud-host.test.ts).
export async function handKey(request: CapsuleRequest, capsuleId: string, giver: { cookie: string; pub: { x25519: string; ed25519: string } }, trip: CryptoKey, member: string) {
  const keys = (cookie: string, body: object) => expectOk(request("/keys", "PATCH", body, cookie)), view = async (cookie: string) => (await (await expectOk(request("", "GET", undefined, cookie))).json()) as any;
  const memberPub = await seatPublic(await newSeatKeys()), attempt = await newAttempt(memberPub, capsuleId);
  const att = (await (await keys(member, { type: "wait", commitment: attempt.commitment })).json() as any).handoff.attempt as string;
  const waiting = (await view(giver.cookie)).waiting.find((w: any) => w.handoff?.attempt === att), h = await newHandoffKeys();
  await keys(giver.cookie, { type: "give", seat: waiting.id, attempt: att, ephemeral: h.ephemeral });
  await keys(member, { type: "reveal", attempt: att, ...memberPub, nonce: attempt.nonce });
  const wrap = await wrapTripKey(trip, memberPub.x25519, capsuleId, 1, h.pair);
  await keys(giver.cookie, { type: "wrap", seat: waiting.id, attempt: att, wrapped: wrap.wrapped });
}
// `request` for a sealed trip, as a member's browser holding the trip key talks to the host: what it writes is sealed
// (src/trip-keys.ts sealOperation, sealSpec, sealPoint, sealName) and what it reads is opened (openTrip, openPoint, openName),
// so a test reads and writes the trip's words as it would a plain trip's. Words the browser itself refuses do not seal: the
// call throws, as the screen shows the message before sending (the host's own checks of plain words are a plain trip's). A test counts revisions from the trip as
// published: the `revisions` the seal took are added to what it sends (If-Match) and taken off what it reads.
const WORDS = ["suggest", "comment", "reflect", "rewrite", "item", "promote", "notes", "checklist", "budget"];
export function sealedRequests(request: CapsuleRequest, capsuleId: string, { trip, revisions }: { trip: CryptoKey; revisions: number }, generation = 1): CapsuleRequest {
  const id = () => crypto.randomUUID().replaceAll("-", ""), name = (kind: "member" | "grant" | "footprint", of: string, n: string) => sealName(trip, capsuleId, generation, kind, of, n);
  const read = async (cookie?: string) => (await (await request("", "GET", undefined, cookie)).json()) as { spec: never; document: never; self?: { id: string; label: string } };
  const seal = async (path: string, method: string, body: Record<string, any>, cookie?: string): Promise<unknown> => {
    // An operation with no words is sent as it is: there is nothing to seal, and the host's own checks are what a test looks at.
    if (path === "/document" && method === "PATCH" && !WORDS.includes(body.type)) return body;
    if (path === "/document" && method === "PATCH") return sealOperation(trip, capsuleId, generation, body, body.type === "promote" ? (await openTrip(trip, capsuleId, await read(cookie)))!.document : { suggestions: [] } as never);
    if (path === "/spec" && method === "PATCH" && body.spec) return { ...body, spec: await sealSpec(trip, capsuleId, generation, body.spec) };
    if (path === "/footprints" && method === "PATCH" && body.type === "add") {
      // The point carries its member's name as the browser read it; a trip gone (410) has none to read, and the host answers for it.
      const { type, lat, lng, accuracy, ...rest } = body, fid = id(), me = (await read(cookie)).self, by = me ? (await openName(trip, capsuleId, "member", me.id, me.label))! : "メンバー";
      return { type, id: fid, point: await sealPoint(trip, capsuleId, generation, fid, { lat, lng, accuracy }), by: await name("footprint", fid, by), ...rest };
    }
    if (path === "/grants" && method === "POST") { const gid = id(), label = body.label === undefined || ["自分用", "招待リンク"].includes(body.label) ? body.label : await name("grant", gid, body.label); return { ...body, id: gid, ...(label === undefined ? {} : { label }) }; }
    if (path === "/members" && method === "PATCH" && typeof body.label === "string") return { ...body, label: await name("member", body.id, body.label) };
    return body;
  };
  const named = async (kind: "member" | "grant", x: { id: string; label: string }) => ({ ...x, label: await openName(trip, capsuleId, kind, x.id, x.label) });
  const open = async (path: string, method: string, json: any): Promise<unknown> => {
    if (!json || typeof json !== "object") return json;
    if (path === "/grants" && method === "GET" && Array.isArray(json)) return Promise.all(json.map(async g => ({ ...await named("grant", g), ...(g.issuedBy ? { issuedBy: await named("member", g.issuedBy) } : {}), members: await Promise.all(g.members.map((m: { id: string; label: string }) => named("member", m))) })));
    if (Array.isArray(json)) return json;
    const out = { ...json };
    if (typeof json.revision === "number") out.revision = json.revision - revisions;
    if (json.spec && json.document && typeof json.spec.title === "string" && json.spec.title.startsWith("v1.")) { const opened = (await openTrip(trip, capsuleId, json))!; out.spec = opened.spec; out.document = opened.document; }
    if (typeof out.document?.revision === "number") out.document = { ...out.document, revision: out.document.revision - revisions };
    if (json.self) out.self = await named("member", json.self);
    if (typeof json.label === "string" && json.self) out.label = out.self.label;
    if (Array.isArray(json.footprints)) out.footprints = await Promise.all(json.footprints.map(async ({ point, by, ...p }: { id: string; point?: string; by: string }) => point === undefined ? { ...p, by } : { ...p, ...await openPoint(trip, capsuleId, p.id, point), by: await openName(trip, capsuleId, "footprint", p.id, by) }));
    return out;
  };
  return async (path = "", method = "GET", body?, cookie?, revision = 1, source?) => {
    let sent = body;
    if (body && typeof body === "object" && method !== "GET") sent = await seal(path, method, body as Record<string, unknown>, cookie);
    const res = await request(path, method, sent, cookie, revision + revisions, source);
    if (!res.headers.get("Content-Type")?.includes("application/json")) return res;
    const json = await open(path, method, await res.clone().json());
    return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
