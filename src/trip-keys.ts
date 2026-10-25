// The trip's key and each seat's key pair (docs/design/trip-e2e.md §2.1). The browser makes them; the host keeps only
// public keys and what is already wrapped, so it can open nothing. crypto.subtle only (X25519, Ed25519, HKDF, AES-GCM):
// the screen and aws/verify.ts (under bun) share these functions. Ciphertext has the shape of private-entries.ts (`v1.`).
import { b64, pack, unb64, unpack } from "./private-entries";
import { documentSchema, itemSchema, operationSchema, specSchema, type Document, type Item, type SealedDocument, type SealedItem, type SealedOperation, type SealedSpec, type Spec } from "./schema";
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
// A handoff (§2.1 案 A) passes its own throwaway pair (newHandoffKeys), whose public half the member's screen has already
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

// The confirmation-code handoff (docs/design/trip-e2e.md §2.1 案 A). Pure functions only: the screen keeps the values it
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

// The edge (§2.1 "確かめた公開鍵の名簿"): this seat's signature over another seat's confirmed public keys.
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

// A trip's words, sealed record by record under the trip's key (docs/design/trip-e2e.md §3, §3.1). The associated data
// names where the words belong, `<capsule id>/<kind>/<record id>/<field>`, so ciphertext moved to another trip, record or
// field no longer opens. An item's date and times are not in it: the host rewrites them when it places an item (§3).
export type RecordKind = "spec" | "module" | "heading" | "item" | "suggestion" | "comment" | "reflection" | "checklist" | "budget" | "notes";
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

type Previous = { spec: Spec; document: Partial<Document>; revisedIds?: { suggestions: string[]; comments: string[] } };
const POSTS = { suggestions: "suggestion", comments: "comment", reflections: "reflection" } as const;
const ITEM_PLAIN = ["id", "day", "startsAt", "timeTentative", "endsAt", "timezone", "revision"] as const;
// The Spec's words: its title, summary, destinations, page labels and presentation. The rest stays plain for the host.
export async function sealSpec(key: CryptoKey, capsuleId: string, generation: number, spec: Spec): Promise<SealedSpec> {
  const f = (kind: RecordKind, id: string, field: string, plain: string) => sealField(key, capsuleId, generation, kind, id, field, plain);
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
async function sealItem(key: CryptoKey, capsuleId: string, generation: number, item: Item): Promise<SealedItem> {
  const plain: Record<string, unknown> = {}, words: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (v !== undefined) ((ITEM_PLAIN as readonly string[]).includes(k) ? plain : words)[k] = v;
  return { ...plain, sealed: await sealField(key, capsuleId, generation, "item", item.id, "sealed", JSON.stringify(words)) } as SealedItem;
}
async function sealDocument<D extends Partial<Document>>(key: CryptoKey, capsuleId: string, generation: number, d: D) {
  const f = (kind: RecordKind, id: string, field: string, plain: string) => sealField(key, capsuleId, generation, kind, id, field, plain);
  const out: Record<string, unknown> = { ...d };
  if (d.items) out.items = await Promise.all(d.items.map(i => sealItem(key, capsuleId, generation, i)));
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

// Opens what the host sent and checks the words as the host checks a plain trip, before anything is shown (§4): a place's
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
    // A link that is not public https is dropped, the rest of the item kept (§4).
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
