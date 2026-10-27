// The trip's key and each seat's key pair (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」). The browser makes them; the host keeps only
// public keys and what is already wrapped, so it can open nothing. crypto.subtle only (X25519, Ed25519, HKDF, AES-GCM):
// the screen and aws/verify.ts (under bun) share these functions. Ciphertext has the shape of private-entries.ts (`v1.`).
import { b64, pack, unb64, unpack } from "./private-entries";
import { canon } from "./revise";
import { author, documentSchema, itemSchema, operationSchema, pointSchema, specSchema, type Document, type PlainPoint, type Item, type SealedDocument, type SealedItem, type SealedOperation, type SealedSpec, type Spec, type Role } from "./schema";
const text = (s: string) => new TextEncoder().encode(s);
const aes = { name: "AES-GCM", length: 256 } as const;
export type SeatKeys = { x25519: CryptoKeyPair; ed25519: CryptoKeyPair };
export type SeatPublic = { x25519: string; ed25519: string };

// Extractable only so the pair can be wrapped; the copy a browser keeps is unwrapped again as one that cannot be taken out.
export async function newSeatKeys(): Promise<SeatKeys> {
  return {
    x25519: await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair,
    ed25519: await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair,
  };
}
export async function seatPublic(keys: { x25519: CryptoKeyPair; ed25519: CryptoKeyPair }): Promise<SeatPublic> {
  return { x25519: b64(await crypto.subtle.exportKey("raw", keys.x25519.publicKey)), ed25519: b64(await crypto.subtle.exportKey("raw", keys.ed25519.publicKey)) };
}
export const newTripKey = () => crypto.subtle.generateKey(aes, true, ["encrypt", "decrypt"]);

// HKDF-SHA-256 (empty salt) of a shared secret or PRF output into an AES-GCM key that only wraps.
async function hkdf(secret: ArrayBuffer | BufferSource, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: text(info) }, base, aes, false, ["wrapKey", "unwrapKey"]);
}
const tripInfo = (capsuleId: string, generation: number) => `capsule trip key v1/${capsuleId}/${generation}`;
const tripAad = (capsuleId: string, generation: number) => text(`${capsuleId}/${generation}`);

// The trip key for one seat: a throwaway X25519 pair, ECDH with the seat's public key, HKDF, AES-GCM. The throwaway
// private key is not kept, so only the seat's private key opens it.
// A handoff (spec「5.1 旅行の鍵と受け渡し」) passes its own throwaway pair (newHandoffKeys), whose public half the member's screen has already
// confirmed with the codes; without one a fresh pair is made as before.
export async function wrapTripKey(trip: CryptoKey, seatX25519: string, capsuleId: string, generation: number, ephemeralPair?: CryptoKeyPair): Promise<{ wrapped: string; ephemeral: string }> {
  const eph = ephemeralPair ?? await crypto.subtle.generateKey("X25519", false, ["deriveBits"]) as CryptoKeyPair;
  const pub = await crypto.subtle.importKey("raw", unb64(seatX25519), "X25519", false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, eph.privateKey, 256);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = pack(iv, await crypto.subtle.wrapKey("raw", trip, await hkdf(shared, tripInfo(capsuleId, generation)), { name: "AES-GCM", iv, additionalData: tripAad(capsuleId, generation) }));
  return { wrapped, ephemeral: b64(await crypto.subtle.exportKey("raw", eph.publicKey)) };
}
export async function unwrapTripKey(wrapped: string, ephemeral: string, seatX25519Private: CryptoKey, capsuleId: string, generation: number, extractable = false): Promise<CryptoKey> {
  const { iv, data } = unpack(wrapped);
  const pub = await crypto.subtle.importKey("raw", unb64(ephemeral), "X25519", false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, seatX25519Private, 256);
  return crypto.subtle.unwrapKey("raw", data, await hkdf(shared, tripInfo(capsuleId, generation)), { name: "AES-GCM", iv, additionalData: tripAad(capsuleId, generation) }, aes, extractable, ["encrypt", "decrypt"]);
}

// The seat's private keys wrapped with a key from the passkey's PRF output, so a browser with nothing kept gets them back
// with one confirmation. The info differs from the memo key's (private-entries.ts), so the two wrapping keys never coincide.
const seatInfo = (capsuleId: string) => `capsule seat key v1/${capsuleId}`;
export async function wrapSeatSecret(keys: { x25519: CryptoKeyPair; ed25519: CryptoKeyPair }, prf: BufferSource, capsuleId: string): Promise<SeatPublic> {
  const wrapping = await hkdf(prf, seatInfo(capsuleId));
  const one = async (key: CryptoKey, which: string) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return pack(iv, await crypto.subtle.wrapKey("pkcs8", key, wrapping, { name: "AES-GCM", iv, additionalData: text(`${capsuleId}/${which}`) }));
  };
  return { x25519: await one(keys.x25519.privateKey, "x25519"), ed25519: await one(keys.ed25519.privateKey, "ed25519") };
}
export async function unwrapSeatSecret(wrapped: SeatPublic, prf: BufferSource, capsuleId: string): Promise<{ x25519: CryptoKey; ed25519: CryptoKey }> {
  const wrapping = await hkdf(prf, seatInfo(capsuleId));
  const one = (sealed: string, which: string, alg: "X25519" | "Ed25519", usages: KeyUsage[]) => {
    const { iv, data } = unpack(sealed);
    return crypto.subtle.unwrapKey("pkcs8", data, wrapping, { name: "AES-GCM", iv, additionalData: text(`${capsuleId}/${which}`) }, alg, false, usages);
  };
  return { x25519: await one(wrapped.x25519, "x25519", "X25519", ["deriveBits"]), ed25519: await one(wrapped.ed25519, "ed25519", "Ed25519", ["sign"]) };
}

// The confirmation-code handoff (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」). Pure functions only: the screen keeps the values it
// saw (never re-reads them from the host) and the host calls none of these, so it never computes or holds a code.
const raw = (b64url: string) => unb64(b64url);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const sha256 = async (data: BufferSource) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

// Step 1: a new random nonce every attempt, so a failed attempt's values tell the host nothing about the next one.
const commitHash = async (seat: SeatPublic, nonce: string, capsuleId: string) =>
  b64(await sha256(concat(text(`capsule handoff commit v1/${capsuleId}`), raw(seat.x25519), raw(seat.ed25519), raw(nonce))));
export async function newAttempt(seat: SeatPublic, capsuleId: string): Promise<{ nonce: string; commitment: string }> {
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { nonce, commitment: await commitHash(seat, nonce, capsuleId) };
}
// Step 3: the giver's screen checks the member's values against the commitment it read before showing its own.
export async function matchesCommitment(commitment: string, seat: SeatPublic, nonce: string, capsuleId: string): Promise<boolean> {
  try { return (await commitHash(seat, nonce, capsuleId)) === commitment; } catch { return false; }
}

// Step 4: two 6-digit codes from different parts of one hash over every public value of the attempt. A host that swaps
// any of them makes the two screens show different codes.
export async function confirmationCodes(a: {
  capsuleId: string;
  giver: { ephemeral: string; x25519: string; ed25519: string };
  member: { x25519: string; ed25519: string; nonce: string };
}): Promise<{ member: string; giver: string }> {
  const h = await sha256(concat(text(`capsule handoff codes v1/${a.capsuleId}`), raw(a.giver.ephemeral), raw(a.giver.x25519), raw(a.giver.ed25519),
    raw(a.member.x25519), raw(a.member.ed25519), raw(a.member.nonce)));
  const code = (at: number) => String(new DataView(h.buffer).getUint32(at, false) % 1_000_000).padStart(6, "0");
  return { member: code(0), giver: code(4) };
}

// Step 2: the giver's throwaway pair. The private half cannot be taken out of the browser.
export async function newHandoffKeys(): Promise<{ pair: CryptoKeyPair; ephemeral: string }> {
  const pair = await crypto.subtle.generateKey("X25519", false, ["deriveBits"]) as CryptoKeyPair;
  return { pair, ephemeral: b64(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

// The edge (spec「5.1 旅行の鍵と受け渡し」): this seat's signature over another seat's confirmed public keys.
type EdgeTarget = { seat: string; x25519: string; ed25519: string };
const edgeText = (o: EdgeTarget, capsuleId: string) => text(`capsule edge v1/${capsuleId}/${o.seat}/${o.x25519}/${o.ed25519}`);
export async function signEdge(ed25519Private: CryptoKey, other: EdgeTarget, capsuleId: string): Promise<string> {
  return b64(await crypto.subtle.sign("Ed25519", ed25519Private, edgeText(other, capsuleId)));
}
export async function verifyEdge(ed25519Public: string, signature: string, other: EdgeTarget, capsuleId: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", raw(ed25519Public), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, raw(signature), edgeText(other, capsuleId));
  } catch { return false; }
}

// A trip's words, sealed record by record under the trip's key (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」). The associated data
// names where the words belong, `<capsule id>/<kind>/<record id>/<field>`, so ciphertext moved to another trip, record or
// field no longer opens. An item's date and times are not in it: the host rewrites them when it places an item (spec「5.2 暗号化するもの・平文に残すもの」).
export type RecordKind = "spec" | "module" | "heading" | "item" | "suggestion" | "comment" | "reflection" | "checklist" | "budget" | "notes" | "footprint" | "photo" | "member" | "grant";
const recordAad = (capsuleId: string, kind: RecordKind, recordId: string, field: string) => text(`${capsuleId}/${kind}/${recordId}/${field}`);
export async function sealField(key: CryptoKey, capsuleId: string, generation: number, kind: RecordKind, recordId: string, field: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return pack(iv, await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: recordAad(capsuleId, kind, recordId, field) }, key, text(plain)), generation);
}
export async function openField(key: CryptoKey, capsuleId: string, kind: RecordKind, recordId: string, field: string, sealed: string): Promise<string> {
  const { generation, iv, data } = unpack(sealed);
  if (generation === undefined) throw new Error("not trip ciphertext");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: recordAad(capsuleId, kind, recordId, field) }, key, data));
}

// A footprint's position, one ciphertext per point (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」, the footprint row): `lat`, `lng` and
// `accuracy` as one JSON. The range is checked before sealing and again after opening, since the host no longer sees it.
export async function sealPoint(key: CryptoKey, capsuleId: string, generation: number, id: string, point: PlainPoint): Promise<string> {
  const { lat, lng, accuracy } = pointSchema.parse(point);
  return sealField(key, capsuleId, generation, "footprint", id, "point", JSON.stringify({ lat, lng, accuracy }));
}
// null when it does not open here or is out of range: the screen leaves such a point out rather than draw a false one.
export async function openPoint(key: CryptoKey, capsuleId: string, id: string, sealed: string): Promise<PlainPoint | null> {
  try {
    const p = pointSchema.safeParse(JSON.parse(await openField(key, capsuleId, "footprint", id, "point", sealed)));
    return p.success ? p.data : null;
  } catch { return null; }
}
// A photo (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」, the photo rows). Each image is sealed under a key of the photo's own, a random AES-GCM key
// that the trip's key seals into the photo's record as `key`: a new trip key seals that one short string again and no image has to
// come back to the browser (spec「5.5 旅行の鍵を替える」). An image is its 12-byte IV, the sealed bytes and the 16-byte tag, the form the host measures
// (src/media.ts SEALED_OVERHEAD); what names it is the AAD `<capsule id>/photo/<photo id>/<thumb|display>`. The location is one
// ciphertext of the trip's key, as a footprint's point is, with the accuracy left out when the photo had none.
export type PhotoSize = "thumb" | "display";
export const locationSchema = pointSchema.partial({ accuracy: true });
export type PlainLocation = Omit<PlainPoint, "accuracy"> & { accuracy?: number };
const imageAad = (capsuleId: string, id: string, size: PhotoSize) => text(`${capsuleId}/photo/${id}/${size}`);
export async function sealPhoto(key: CryptoKey, capsuleId: string, generation: number, id: string, photo: { display: Uint8Array; thumb: Uint8Array; location?: PlainLocation }) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), own = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const image = async (size: PhotoSize, bytes: Uint8Array) => {
    const iv = crypto.getRandomValues(new Uint8Array(12)), out = new Uint8Array(12 + bytes.length + 16);
    out.set(iv); out.set(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: imageAad(capsuleId, id, size) }, own, bytes.slice())), 12);
    return out;
  };
  const place = photo.location && locationSchema.parse(photo.location);
  return {
    key: await sealField(key, capsuleId, generation, "photo", id, "key", b64(raw)),
    display: await image("display", photo.display), thumb: await image("thumb", photo.thumb),
    ...place && { location: await sealField(key, capsuleId, generation, "photo", id, "location", JSON.stringify(place)) },
  };
}
// The image's bytes, or a throw when the key, the photo or the size is not the one it was sealed for.
export async function openPhotoImage(key: CryptoKey, capsuleId: string, id: string, sealedKey: string, size: PhotoSize, bytes: Uint8Array): Promise<Uint8Array> {
  const own = await crypto.subtle.importKey("raw", unb64(await openField(key, capsuleId, "photo", id, "key", sealedKey)), "AES-GCM", false, ["decrypt"]);
  if (bytes.length < 28) throw new Error("not sealed image");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: imageAad(capsuleId, id, size) }, own, bytes.slice(12)));
}
// null when it does not open here or is out of range: the screen leaves the photo off the map rather than draw a false place.
export async function openPhotoLocation(key: CryptoKey, capsuleId: string, id: string, sealed: string): Promise<PlainLocation | null> {
  try {
    const p = locationSchema.safeParse(JSON.parse(await openField(key, capsuleId, "photo", id, "location", sealed)));
    return p.success ? p.data : null;
  } catch { return null; }
}
// A name (spec「5.2 暗号化するもの・平文に残すもの」, the `Session` and `Grant` rows, and a footprint's copy of its member's name): a seat's or an invite's
// `label`, or a footprint's `by`. The same 1–80 characters as an author's, before sealing and after opening.
type Named = "member" | "grant" | "footprint";
const nameField = (kind: Named) => kind === "footprint" ? "by" : "label";
export async function sealName(key: CryptoKey, capsuleId: string, generation: number, kind: Named, id: string, name: string): Promise<string> {
  const n = author.safeParse(name);
  if (!n.success) throw new Error("名前は1〜80字です");
  return sealField(key, capsuleId, generation, kind, id, nameField(kind), n.data);
}
// A name not in the form of ciphertext is one the host gave ("自分用", "招待リンク", "オーナー", "メンバー3") and is shown as
// it is; no table tells the host's names apart (docs/ephemeral-trip-capsule.md「5.6 自分だけの予定・日記の鍵」). Ciphertext that does not open is null.
export async function openName(key: CryptoKey, capsuleId: string, kind: Named, id: string, value: string): Promise<string | null> {
  try { unpack(value); } catch { return value; }
  try {
    const n = author.safeParse(await openField(key, capsuleId, kind, id, nameField(kind), value));
    return n.success ? n.data : null;
  } catch { return null; }
}

export type Previous = { spec: Spec; document: Partial<Document>; revisedIds?: { suggestions: string[]; comments: string[] } };
type Sealer = (kind: RecordKind, id: string, field: string, plain: string) => Promise<string>;
const POSTS = { suggestions: "suggestion", comments: "comment", reflections: "reflection" } as const;
const ITEM_PLAIN = ["id", "day", "startsAt", "timeTentative", "endsAt", "timezone", "revision"] as const;
// The Spec's words: its title, summary, destinations, page labels and presentation. The rest stays plain for the host.
export async function sealSpec(key: CryptoKey, capsuleId: string, generation: number, spec: Spec, f: Sealer = (kind, id, field, plain) => sealField(key, capsuleId, generation, kind, id, field, plain)): Promise<SealedSpec> {
  const { title, summary, trip, modules, presentation, ...rest } = spec;
  return {
    ...rest, title: await f("spec", "spec", "title", title), ...(summary !== undefined ? { summary: await f("spec", "spec", "summary", summary) } : {}),
    trip: { ...trip, destinations: await f("spec", "spec", "destinations", JSON.stringify(trip.destinations)) },
    modules: await Promise.all(modules.map(async m => ({ ...m, label: await f("module", m.id, "label", m.label) }))),
    ...(presentation ? { presentation: {
      kicker: await f("spec", "spec", "kicker", presentation.kicker), postcardLabel: await f("spec", "spec", "postcardLabel", presentation.postcardLabel),
      postcardCaption: await f("spec", "spec", "postcardCaption", presentation.postcardCaption),
      dayHeadings: await Promise.all(presentation.dayHeadings.map(async h => ({ day: h.day, title: await f("heading", h.day, "title", h.title) }))),
      travelers: await f("spec", "spec", "travelers", JSON.stringify(presentation.travelers)),
    } } : {}),
  };
}
// One item: its kind, status, title, place, description and tags as one ciphertext, the rest plain.
async function sealItem(key: CryptoKey, capsuleId: string, generation: number, item: Item, f: Sealer = (kind, id, field, plain) => sealField(key, capsuleId, generation, kind, id, field, plain)): Promise<SealedItem> {
  const plain: Record<string, unknown> = {}, words: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (v !== undefined) ((ITEM_PLAIN as readonly string[]).includes(k) ? plain : words)[k] = v;
  return { ...plain, sealed: await f("item", item.id, "sealed", JSON.stringify(words)) } as SealedItem;
}
async function sealDocument<D extends Partial<Document>>(key: CryptoKey, capsuleId: string, generation: number, d: D, f: Sealer = (kind, id, field, plain) => sealField(key, capsuleId, generation, kind, id, field, plain)) {
  const out: Record<string, unknown> = { ...d };
  if (d.items) out.items = await Promise.all(d.items.map(i => sealItem(key, capsuleId, generation, i, f)));
  for (const list of ["suggestions", "comments", "reflections"] as const) {
    const posts = d[list] as Array<{ id: string; author: string; body: string }> | undefined;
    if (posts) out[list] = await Promise.all(posts.map(async p => ({ ...p, author: await f(POSTS[list], p.id, "author", p.author), body: await f(POSTS[list], p.id, "body", p.body) })));
  }
  if (d.checklist) out.checklist = await Promise.all(d.checklist.map(async c => ({ ...c, title: await f("checklist", c.id, "title", c.title) })));
  if (d.budget) out.budget = await Promise.all(d.budget.map(async b => ({ id: b.id, title: await f("budget", b.id, "title", b.title), amount: await f("budget", b.id, "amount", JSON.stringify(b.amount)), description: await f("budget", b.id, "description", b.description) })));
  if (d.notes !== undefined) out.notes = await f("notes", "notes", "body", d.notes);
  return out;
}
// The whole trip, as the owner's browser seals a plain one (POST seal). `previous` is sealed the same way; its revisedIds stay plain.
export async function sealTrip(key: CryptoKey, capsuleId: string, generation: number, t: { spec: Spec; document: Document; previous?: Previous }) {
  return {
    spec: await sealSpec(key, capsuleId, generation, t.spec),
    document: await sealDocument(key, capsuleId, generation, t.document) as SealedDocument,
    ...(t.previous ? { previous: { ...t.previous, spec: await sealSpec(key, capsuleId, generation, t.previous.spec), document: await sealDocument(key, capsuleId, generation, t.previous.document) } } : {}),
  };
}

// A plain trip as the owner's browser reads it (GET "", GET seal, GET grants), to move it at once (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」).
export type MoveInput = {
  spec: Spec; document: Document; previous: Previous | null;
  footprints: Array<{ id: string; lat: number; lng: number; accuracy: number; by: string }>;
  grants: Array<{ id: string; label: string; members: Array<{ id: string; label: string }> }>;
};
// The body of the one POST seal that moves a plain trip (spec「5.4 平文の旅行を移す」): the trip as sealTrip seals it, each footprint's point and
// `by`, and each member's and invite's name. The host's own invite names stay as they are (#712); the history's names
// are not sent, the host drops them. A trip too large to move goes again with `dropPrevious`.
export async function sealMove(key: CryptoKey, capsuleId: string, generation: number, input: MoveInput, { dropPrevious = false } = {}) {
  const { spec, document, previous } = input;
  const footprints = await Promise.all(input.footprints.map(async p => ({ id: p.id, point: await sealPoint(key, capsuleId, generation, p.id, { lat: p.lat, lng: p.lng, accuracy: p.accuracy }), by: await sealName(key, capsuleId, generation, "footprint", p.id, p.by) })));
  const members: Record<string, string> = {}, grants: Record<string, string> = {};
  for (const g of input.grants) {
    grants[g.id] = g.label === "自分用" || g.label === "招待リンク" ? g.label : await sealName(key, capsuleId, generation, "grant", g.id, g.label);
    for (const m of g.members) members[m.id] = await sealName(key, capsuleId, generation, "member", m.id, m.label);
  }
  return { generation, ...await sealTrip(key, capsuleId, generation, { spec, document, ...(previous && !dropPrevious ? { previous } : {}) }), footprints, members, grants, confirm: true as const };
}

// Where each ciphertext of a sealed trip belongs: [kind, record id, field, ciphertext], as sealSpec and sealDocument put them.
function sealedFields(t: { spec: SealedSpec; document: Partial<SealedDocument> }): Array<[RecordKind, string, string, string]> {
  const { spec, document: d } = t, p = spec.presentation, out: Array<[RecordKind, string, string, string]> = [["spec", "spec", "title", spec.title], ["spec", "spec", "destinations", spec.trip.destinations]];
  if (spec.summary !== undefined) out.push(["spec", "spec", "summary", spec.summary]);
  for (const m of spec.modules) out.push(["module", m.id, "label", m.label]);
  if (p) {
    for (const field of ["kicker", "postcardLabel", "postcardCaption", "travelers"] as const) out.push(["spec", "spec", field, p[field]]);
    for (const h of p.dayHeadings) out.push(["heading", h.day, "title", h.title]);
  }
  for (const i of d.items ?? []) out.push(["item", i.id, "sealed", i.sealed]);
  for (const list of ["suggestions", "comments", "reflections"] as const) for (const x of d[list] ?? []) out.push([POSTS[list], x.id, "author", x.author], [POSTS[list], x.id, "body", x.body]);
  for (const c of d.checklist ?? []) out.push(["checklist", c.id, "title", c.title]);
  for (const b of d.budget ?? []) out.push(["budget", b.id, "title", b.title], ["budget", b.id, "amount", b.amount], ["budget", b.id, "description", b.description]);
  if (d.notes !== undefined) out.push(["notes", "notes", "body", d.notes]);
  return out;
}
// Words kept as JSON are compared as values: an answer may write an item's fields in another order.
const JSON_FIELDS = ["item/sealed", "spec/destinations", "spec/travelers", "budget/amount"];
// The next trip a revise or an undo made in this browser, sealed for the host (spec「5.3 暗号化した旅行で Host にできないこと」). A record whose words are the same as in one
// of `from` (the trip as this browser opened it; for an undo, the step back too) keeps that ciphertext, in `from`'s order, so the
// host can see that what it must keep did not change; a new or changed record is sealed anew. A post kept keeps its seat
// (by its list and id: a suggestion and a comment may share an id).
export async function resealTrip(key: CryptoKey, capsuleId: string, generation: number, from: Array<{ spec: SealedSpec; document: Partial<SealedDocument> }>, next: { spec: Spec; document: Document }): Promise<{ spec: SealedSpec; document: SealedDocument }> {
  const at = (kind: RecordKind, id: string, field: string, plain: string) => `${kind}/${id}/${field}\n${JSON_FIELDS.includes(`${kind}/${field}`) ? canon(JSON.parse(plain)) : plain}`;
  const kept = new Map<string, string>(), seats = new Map<string, string>();
  for (const t of from) {
    for (const [kind, id, field, sealed] of sealedFields(t)) {
      // One that does not open is not kept: what takes its place is sealed anew.
      try { const k = at(kind, id, field, await openField(key, capsuleId, kind, id, field, sealed)); if (!kept.has(k)) kept.set(k, sealed); } catch { /* sealed anew */ }
    }
    for (const list of ["suggestions", "comments"] as const) for (const x of t.document[list] ?? []) if (x.seat && !seats.has(`${list}/${x.id}`)) seats.set(`${list}/${x.id}`, x.seat);
  }
  const f: Sealer = async (kind, id, field, plain) => kept.get(at(kind, id, field, plain)) ?? sealField(key, capsuleId, generation, kind, id, field, plain);
  const document = await sealDocument(key, capsuleId, generation, next.document, f) as SealedDocument;
  for (const list of ["suggestions", "comments"] as const) for (const x of document[list]) { const seat = seats.get(`${list}/${x.id}`); if (seat) x.seat = seat; }
  return { spec: await sealSpec(key, capsuleId, generation, next.spec, f), document };
}

// Opens what the host sent and checks the words as the host checks a plain trip, before anything is shown (spec「5.3 暗号化した旅行で Host にできないこと」): a place's
// link that is not public https is dropped, and a record that does not open or does not pass the plain shape is left out
// and named in `unreadable` ("<kind>/<id>"), never shown with made-up words. null when the Spec itself does not open.
export async function openTrip(key: CryptoKey, capsuleId: string, sealed: { spec: SealedSpec; document: SealedDocument }): Promise<{ spec: Spec; document: Document; unreadable: string[] } | null> {
  const f = (kind: RecordKind, id: string, field: string, s: string) => openField(key, capsuleId, kind, id, field, s);
  let spec: Spec;
  try {
    const { title, summary, trip, modules, presentation, ...rest } = sealed.spec;
    const parsed = specSchema.safeParse({
      ...rest, title: await f("spec", "spec", "title", title), ...(summary !== undefined ? { summary: await f("spec", "spec", "summary", summary) } : {}),
      trip: { ...trip, destinations: JSON.parse(await f("spec", "spec", "destinations", trip.destinations)) },
      modules: await Promise.all(modules.map(async m => ({ ...m, label: await f("module", m.id, "label", m.label) }))),
      ...(presentation ? { presentation: {
        kicker: await f("spec", "spec", "kicker", presentation.kicker), postcardLabel: await f("spec", "spec", "postcardLabel", presentation.postcardLabel),
        postcardCaption: await f("spec", "spec", "postcardCaption", presentation.postcardCaption),
        dayHeadings: await Promise.all(presentation.dayHeadings.map(async h => ({ day: h.day, title: await f("heading", h.day, "title", h.title) }))),
        travelers: JSON.parse(await f("spec", "spec", "travelers", presentation.travelers)),
      } } : {}),
    });
    if (!parsed.success) return null;
    spec = parsed.data;
  } catch { return null; }
  const unreadable: string[] = [], d = sealed.document;
  // Each record on its own: one that fails is dropped and counted, the others still show.
  const each = async <S extends { id: string }, P>(kind: RecordKind, list: S[], openOne: (s: S) => Promise<unknown>, shape: { safeParse(v: unknown): { success: true; data: P } | { success: false } }) =>
    (await Promise.all(list.map(async s => {
      try { const r = shape.safeParse(await openOne(s)); if (r.success) return [r.data]; } catch { /* left out below */ }
      unreadable.push(`${kind}/${s.id}`); return [];
    }))).flat();
  const items = await each("item", d.items, async i => {
    const { sealed: words, ...plain } = i, item = { ...JSON.parse(await f("item", i.id, "sealed", words)), ...plain };
    // A link that is not public https is dropped, the rest of the item kept (spec「5.3 暗号化した旅行で Host にできないこと」).
    if (item.place?.publicUrl !== undefined && itemSchema.safeParse(item).error?.issues.some(x => x.path.join(".") === "place.publicUrl")) delete item.place.publicUrl;
    return item;
  }, itemSchema);
  const post = (kind: RecordKind) => async ({ seat: _seat, ...p }: { id: string; author: string; body: string; seat?: string }) => ({ ...p, author: await f(kind, p.id, "author", p.author), body: await f(kind, p.id, "body", p.body) });
  const document: Document = {
    revision: d.revision, items,
    suggestions: await each("suggestion", d.suggestions, post("suggestion"), shapes.suggestions.element),
    comments: await each("comment", d.comments, post("comment"), shapes.comments.element),
    reflections: await each("reflection", d.reflections, post("reflection"), shapes.reflections.element),
    checklist: await each("checklist", d.checklist, async c => ({ ...c, title: await f("checklist", c.id, "title", c.title) }), shapes.checklist.element),
    budget: await each("budget", d.budget, async b => ({ id: b.id, title: await f("budget", b.id, "title", b.title), amount: JSON.parse(await f("budget", b.id, "amount", b.amount)), description: await f("budget", b.id, "description", b.description) }), shapes.budget.element),
    notes: (await each("notes", [{ id: "notes", body: d.notes }], async n => f("notes", "notes", "body", n.body), shapes.notes))[0] ?? "",
  };
  return { spec, document, unreadable };
}

// A plain operation as the screen made it, checked as the host checks a plain one (operationSchema, then the record's plain
// shape) and sealed into the form a sealed trip takes (sealedOperationSchema). Throws before sealing when the words do not
// pass: the screen shows the message. A post gets its id here, since its words are sealed against it; promoting a
// suggestion makes the item the host made from it before (title: the body's first 80 characters), under a new id.
const newId = () => crypto.randomUUID().replace(/-/g, ""), shapes = documentSchema.shape;
export async function sealOperation(key: CryptoKey, capsuleId: string, generation: number, input: unknown, document: Document): Promise<SealedOperation> {
  const op = operationSchema.parse(input), f = (kind: RecordKind, id: string, field: string, plain: string) => sealField(key, capsuleId, generation, kind, id, field, plain);
  switch (op.type) {
    case "check": case "include": case "move": case "remove": return op;
    case "suggest": case "comment": case "reflect": {
      const id = newId(), kind = ({ suggest: "suggestion", comment: "comment", reflect: "reflection" } as const)[op.type];
      return { type: op.type, id, author: await f(kind, id, "author", op.author), body: await f(kind, id, "body", op.body) };
    }
    case "rewrite": return { ...op, body: await f(POSTS[op.list], op.id, "body", op.body) };
    case "item": return { ...op, item: await sealItem(key, capsuleId, generation, op.item) };
    case "promote": {
      const t = document.suggestions.find(s => s.id === op.id);
      if (!t || t.promoted) throw new Error("候補が存在しないか追加済みです");
      const id = newId(), item = itemSchema.parse({ id, day: op.day, title: t.body.slice(0, 80), description: t.body, status: "confirmed", kind: "activity", revision: 1 });
      const { sealed: words } = await sealItem(key, capsuleId, generation, item);
      return { type: "promote", id: op.id, day: op.day, item: { id, sealed: words } };
    }
    case "notes": return { type: "notes", body: await f("notes", "notes", "body", shapes.notes.parse(op.body)) };
    // Sealed under the ids as the plain shape reads them, so they open where openTrip looks for them.
    case "checklist": return { type: "checklist", checklist: await Promise.all(op.checklist.map(async c => { const p = shapes.checklist.element.pick({ id: true, title: true }).parse(c); return { id: p.id, title: await f("checklist", p.id, "title", p.title) }; })) };
    case "budget": return { type: "budget", budget: await Promise.all(op.budget.map(async b => { const p = shapes.budget.element.parse(b); return { id: p.id, title: await f("budget", p.id, "title", p.title), amount: await f("budget", p.id, "amount", JSON.stringify(p.amount)), description: await f("budget", p.id, "description", p.description) }; })) };
  }
}

// Replacing the trip key with the next generation (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」). The owner's browser walks the edges from its own
// seat, wraps the new key to the seats it reaches and signs each wrap; a member's browser takes a new generation only when it is
// signed by an owner seat it reaches by its own edges, so the operator cannot place a key of its own (spec「5.5 旅行の鍵を替える」).
// `since`: a seat whose pair was made again (a passkey registered later) keeps its previous public keys and their signature over
// the new ones, for one generation of pairs (spec「5.5 旅行の鍵を替える」): edges signed over the previous keys still lead to it.
export type KeyedSeat = { id: string; role: Role; x25519: string; ed25519: string; edges: Array<{ seat: string; signature: string }>; since?: { x25519: string; ed25519: string; signature: string } };
const successionText = (capsuleId: string, seat: string, next: SeatPublic) => text(`capsule seat successor v1/${capsuleId}/${seat}/${next.x25519}/${next.ed25519}`);
export async function signSuccession(oldEd25519Private: CryptoKey, previous: SeatPublic, a: { capsuleId: string; seat: string; x25519: string; ed25519: string }): Promise<NonNullable<KeyedSeat["since"]>> {
  return { ...previous, signature: b64(await crypto.subtle.sign("Ed25519", oldEd25519Private, successionText(a.capsuleId, a.seat, a))) };
}
export async function verifySuccession(seat: KeyedSeat, capsuleId: string): Promise<boolean> {
  if (!seat.since) return false;
  try {
    const key = await crypto.subtle.importKey("raw", raw(seat.since.ed25519), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, raw(seat.since.signature), successionText(capsuleId, seat.id, seat));
  } catch { return false; }
}
// The seats reached from `root` by edges whose signatures hold, each signed over the seat's present keys or, through `since`,
// its previous ones. A seat not in `seats` (revoked, or still pending) is not passed through. `root.ed25519` is the public key
// this browser holds for its own seat, never the one `seats` lists: the host could list another key with edges of its own.
export async function reachableSeats(root: { id: string; ed25519: string }, seats: KeyedSeat[], capsuleId: string): Promise<Set<string>> {
  const by = new Map(seats.map(s => [s.id, s])), out = new Set<string>(), queue = by.has(root.id) ? [root.id] : [];
  if (queue.length) out.add(root.id);
  while (queue.length) {
    const from = by.get(queue.shift()!)!, signer = from.id === root.id ? root.ed25519 : from.ed25519;
    for (const e of from.edges) {
      const to = by.get(e.seat);
      if (!to || out.has(to.id)) continue;
      const reached = await verifyEdge(signer, e.signature, { seat: to.id, x25519: to.x25519, ed25519: to.ed25519 }, capsuleId)
        || (to.since !== undefined && await verifyEdge(signer, e.signature, { seat: to.id, x25519: to.since.x25519, ed25519: to.since.ed25519 }, capsuleId) && await verifySuccession(to, capsuleId));
      if (reached) { out.add(to.id); queue.push(to.id); }
    }
  }
  return out;
}
type Rekey = { capsuleId: string; generation: number; seat: string; x25519: string; wrapped: string; ephemeral: string };
const rekeyText = (r: Rekey) => text(`capsule rekey v1/${r.capsuleId}/${r.generation}/${r.seat}/${r.x25519}/${r.wrapped}/${r.ephemeral}`);
// The owner's signature over one seat's wrap of the new generation: `seat` and `x25519` are the seat wrapped to.
export async function signRekey(ownerEd25519Private: CryptoKey, r: Rekey): Promise<string> {
  return b64(await crypto.subtle.sign("Ed25519", ownerEd25519Private, rekeyText(r)));
}
export async function verifyRekey(ownerEd25519Public: string, signature: string, r: Rekey): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", raw(ownerEd25519Public), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, raw(signature), rekeyText(r));
  } catch { return false; }
}
// Whether this browser takes the trip key its seat holds. A generation it already took (`known`) is taken as before; a later one
// only when an owner seat this seat reaches signed that very wrap. `self` as reachableSeats takes its root: the public key this
// browser holds for its own seat.
export async function acceptRekey(a: { self: { id: string; ed25519: string }; known: number; capsuleId: string; seats: KeyedSeat[]; seatKey: { generation: number; wrapped: string; ephemeral: string; x25519: string; rekey?: { seat: string; signature: string } } }): Promise<boolean> {
  const k = a.seatKey;
  if (k.generation <= a.known) return true;
  const owner = k.rekey && a.seats.find(s => s.id === k.rekey!.seat);
  if (!owner || owner.role !== "owner" || !(await reachableSeats(a.self, a.seats, a.capsuleId)).has(owner.id)) return false;
  return verifyRekey(owner.id === a.self.id ? a.self.ed25519 : owner.ed25519, k.rekey!.signature, { capsuleId: a.capsuleId, generation: k.generation, seat: a.self.id, x25519: k.x25519, wrapped: k.wrapped, ephemeral: k.ephemeral });
}
// The whole sealed trip opened with the old key and sealed again under the new generation: the trip, each footprint's point and
// name, each member's and invite's name. A name the host gave stays as it is. Nothing that fails to open is dropped quietly: it
// throws, and the key is not replaced. `previous` is not sealed again; the host drops it (spec「5.5 旅行の鍵を替える」).
const isCipher = (v: string) => { try { unpack(v); return true; } catch { return false; } };
export async function resealAll(oldKey: CryptoKey, newKey: CryptoKey, capsuleId: string, generation: number, t: {
  spec: SealedSpec; document: SealedDocument; footprints: Array<{ id: string; point: string; by: string }>; members: Array<{ id: string; label: string }>; grants: Array<{ id: string; label: string }>;
  // The photos' sealed parts (src/media.ts PhotoAsset). The images stay as they are: they are sealed under each photo's own key.
  media?: Array<{ id: string; key: string; location?: string; caption?: string }>;
}) {
  const opened = await openTrip(oldKey, capsuleId, t);
  if (!opened) throw new Error("旅程を開けません");
  const unreadable = [...opened.unreadable];
  const name = async (kind: Named, id: string, value: string) => {
    if (!isCipher(value)) return value;
    const plain = await openName(oldKey, capsuleId, kind, id, value);
    if (plain === null) { unreadable.push(`${kind}/${id}`); return ""; }
    return sealName(newKey, capsuleId, generation, kind, id, plain);
  };
  const footprints = await Promise.all(t.footprints.map(async p => {
    const point = await openPoint(oldKey, capsuleId, p.id, p.point), by = await name("footprint", p.id, p.by);
    if (!point) { unreadable.push(`footprint/${p.id}`); return { id: p.id, point: "", by }; }
    return { id: p.id, point: await sealPoint(newKey, capsuleId, generation, p.id, point), by };
  }));
  const members = await Promise.all(t.members.map(async m => ({ id: m.id, label: await name("member", m.id, m.label) })));
  const grants = await Promise.all(t.grants.map(async g => ({ id: g.id, label: await name("grant", g.id, g.label) })));
  const photoField = async (id: string, field: "key" | "location" | "caption", value: string) => {
    try { return await sealField(newKey, capsuleId, generation, "photo", id, field, await openField(oldKey, capsuleId, "photo", id, field, value)); } catch { unreadable.push(`photo/${id}`); return ""; }
  };
  const media = await Promise.all((t.media ?? []).map(async p => ({ id: p.id, key: await photoField(p.id, "key", p.key), ...p.location && { location: await photoField(p.id, "location", p.location) }, ...p.caption && { caption: await photoField(p.id, "caption", p.caption) } })));
  if (unreadable.length) throw new Error(`開けない記録があります（${new Set(unreadable).size} 件）`);
  const { spec, document } = await sealTrip(newKey, capsuleId, generation, opened);
  // A post keeps the seat that wrote it, which openTrip leaves out.
  for (const list of ["suggestions", "comments", "reflections"] as const) for (const x of document[list] as Array<{ id: string; seat?: string }>) {
    const seat = (t.document[list] as Array<{ id: string; seat?: string }>).find(y => y.id === x.id)?.seat;
    if (seat) x.seat = seat;
  }
  return { spec, document, footprints, media, members, grants };
}
