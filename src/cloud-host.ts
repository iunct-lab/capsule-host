import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { CloudStore, type D1, type CapsuleStore, type CloudRow } from "./cloud-store";
import { LocalKeyStore, open, seal, type KeyStore } from "./key-store";
import { ASSIST_LIMIT, ASSIST_MODEL, REVISE_LIMIT, anthropicGenerate, todayLine, type Follow, type Generated } from "./assist";
import { instant as isoTime, localDay, sameTitle, author, pointSchema, cipher, CIPHER, PASTE_LIMIT } from "./fields";
import { Refused, type DomainKit, type Envelope, type Role, type Versioned } from "./kit";
import { kits as registered, kitOf, DEFAULT_KIND } from "./kits";
import { deviceLabel, CLAIM_WINDOW } from "./device";
import { rpIdOf, verifyAssertion, verifyRegistration, type Passkey } from "./webauthn";
import { PHOTO_LIMITS, SEALED_OVERHEAD, tooLargeText, type PhotoAsset } from "./media";
import type { MediaStore } from "./media-store";

// A Grant is an invite: its link can be redeemed `seats` times until `claimBy`. Each redemption binds one browser as a Session (member).
// `issuedBy`: the member (Session id) who handed it out; none for one handed out from outside the trip (publishing, recover).
type Grant = { id: string; role: Role; digest: string; label: string; expires: number; revoked: number | null; created: number; lastUsed: number | null; seats: number; claimed: number; claimBy: number; issuedBy?: string; approval?: "auto" | "owner" };
// Which invites each role may hand out: none stronger than its own. The one who handed an invite out and the owner may revoke it.
const canIssue: Record<Role, Role[]> = { owner: ["owner", "editor", "participant", "viewer"], editor: ["viewer"], participant: [], viewer: [] };
// `verifiedUntil`: until when this session's owner actions count as checked by its passkey (none: not checked).
// `seen`: when this browser last read the trip, kept to the day; a session stored before it was kept counts as seen now.
// `privateKey`: the key this seat's own entries are sealed with, as the browser wrapped it with the PRF of the passkey `passkey`
// (docs/ephemeral-trip-capsule.md「5.6 自分だけの予定・日記の鍵」). The host cannot unwrap it.
// `seatKey`: this seat's keys for the trip (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」): its public keys, the trip key wrapped to its X25519
// key with a throwaway public key, and, when a passkey's PRF could wrap it, its private keys. Only what is already wrapped: the host opens none.
// `edges`: the seats whose public keys this seat has confirmed, each signed with this seat's Ed25519 key. It goes with the
// seatKey: a seat whose pair is made again brings its edges signed anew, and `since`, its previous public keys and their
// signature over the new ones (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」).
// `rekey`: the owner seat's signature over this wrap, when the owner's browser replaced the trip key (POST rekey, spec「5.5 旅行の鍵を替える」).
type SeatKey = { x25519: string; ed25519: string; generation: number; wrapped: string; ephemeral: string; secret?: { x25519: string; ed25519: string; passkey: string }; edges?: Array<{ seat: string; signature: string }>; since?: { x25519: string; ed25519: string; signature: string }; rekey?: { seat: string; signature: string } };
// `handoff`: the values of a seat waiting for the trip key, in the order of docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」 (the commitment,
// then the giver's, then the member's own). Every one is public; the host only holds them and checks who may write which.
type Handoff = { attempt: string; commitment: string; giver?: { seat: string; ephemeral: string; x25519: string; ed25519: string }; reveal?: { x25519: string; ed25519: string; nonce: string } };
type Session = { id: string; digest: string; grantId: string; expires: number; label: string; device: string; created: number; lastUsed: number; passkey?: Passkey; verifiedUntil?: number; pending?: boolean; code?: string; seen?: number; privateKey?: { wrapped: string; passkey: string }; seatKey?: SeatKey; handoff?: Handoff; assistKey?: string; assistWrapped?: string };
// `assistKey`: this seat's own Anthropic API key for revising the trip on the host, sealed with the subject `<capsule id>:<seat id>`
// (src/key-store.ts). It is the seat's alone: no other member and no creator can open it, and it goes with the seat when the
// seat or the trip goes.
// `assistWrapped`: in a sealed trip, this seat's Anthropic API key wrapped by its browser with a key from its passkey's PRF
// (src/private-entries.ts, as the memo key is). The host cannot open it; the browser sends the trip to Anthropic itself (#692 回答 B).
// A member's own plan or diary entry, kept by seat and never shown to anyone else (#341). The title, body and place (as JSON) are
// sealed by the browser, `v1.` ciphertext the host never opens (#343); the date and times stay plain, for the host to order by.
export type PrivateEntry = { id: string; kind: "item" | "diary"; day: string; startsAt?: string; endsAt?: string; title: string; body: string; place?: string; createdAt: string; updatedAt: string };
// Where a member was when they pressed ここにいる, shared with every member (#480). `seat` is the `Session.id` that left it, `by`
// the seat's name then: the point outlives the seat, as a comment does, so the trip can be looked back on after sharing ends.
// `at` is the host's clock. In a sealed trip `point` (`lat`, `lng` and `accuracy`) and `by` are ciphertext under the trip's key
// and the id is the browser's, sealed against (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」); the seat and the time stay plain, for the checks.
// `auto` marks a point the browser left on opening the trip's page, not on a press (#481); only `true` is kept.
type FootprintRecord = { id: string; seat: string; by: string; at: string; auto?: true } & ({ lat: number; lng: number; accuracy: number } | { point: string });
// `hash` follows the Spec as it is edited; `publishHash` is the fingerprint of what was published and never changes, so a
// replayed operation id can be compared against the original input rather than against the trip as it stands today.
// `previous` holds the document just before an owner or editor revised it. Older steps have no candidates or talk.
// `ownedAt` is when an owner seat was first taken: from then on the trip is out of its creator's reach for good (#320).
// `id` lets the operator's list name a capsule, since its storage key is a one-way digest. Capsules published before it
// was stored get it at their next write.
// `private`: each seat's own entries, by `Session.id`. Outside `document`, so no role, export or revision ever reaches them.
// `footprints`: the trip's points, oldest first. Outside `document` too: leaving one moves no revision, and no export or revision holds them.
// `media`: the trip's photos, oldest upload first, outside `document` as the footprints are. Only what the screen needs to place and
// open each is here; the image bytes, sealed by the browser, are in `env.MEDIA` under the capsule row's key (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」).
// One line of the capsule's record. What an invite or an owner seat went through also names the role, the link or member it was
// about (`label`), and who did it: a member's name and device, or 発行者 / 作成者 for the publisher and the creator. Older lines
// have none of these, and are not filled in. A sealed trip's lines copy no name (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」, `Audit`): they
// hold the invite's id (`grant`), the seat that did it (`seat`) and the seat it was done to (`member`), and the screen names them.
type Audit = { event: string; at: number; role?: Role; label?: string; by?: string; device?: string; grant?: string; seat?: string; member?: string };
// The events the owner sees as the history of invites and owner seats (GET history).
const HISTORY = ["publish", "replay", "creator-owner", "recover", "sessions", "grants", "rotate", "revoke", "revoke-member", "freeze"];
// `sealed`: the trip's words are kept as ciphertext under the trip's key (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」), in the key generation
// named; `spec`, `document` and `previous` then have the kind's sealed forms (src/schema.ts for a trip). Without it they are plain.
// All three are the kind's (src/kit.ts, by `spec.kind`): the host reads only the Envelope and the document's version.
// `departed`: the seats that held the present generation of the trip key and are gone, and why (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」).
// The owner's browser replacing the key clears it.
type Capsule = { sealed?: { generation: number }; spec: Envelope; document: Versioned; previous?: unknown; id?: string; ownedAt?: number; joined?: number; created: number; updated: string; forced: string | null; hash: string; publishHash?: string; grants: Grant[]; sessions: Session[]; audit: Audit[]; spent?: Array<{ digest: string; expires: number }>; private?: Record<string, PrivateEntry[]>; footprints?: FootprintRecord[]; media?: PhotoAsset[]; departed?: Departure[]; left?: string[] };
// `left`: the cookie digests of the seats that are gone (revoked, their invite rotated, revoked or ended, sharing ended, the owner
// recovered), newest last, so their 401 can say so. A cookie not in it (a seat gone before it was kept, or dropped off its end) is
// answered as an idle one is: the browser then keeps its keys, as before. Its end bounds the row: a trip holds 100 seats at
// once, but an editor issuing and revoking viewer invites could otherwise grow it until the trip no longer saves.
// `owner`: the owner seat handed over (rotation of the owner invite, /recover): its owner is asked. The rest are replaced at once.
type Departure = { seat: string; at: number; why: "revoke" | "rotate" | "expired" | "owner" };
// What the host does by reading a trip's words (export, revise, undo) waits for the browser to do it (spec「5.3 暗号化した旅行で Host にできないこと」).
function plain(c: Capsule) { if (c.sealed) throw new Fault(409, "暗号化した旅行では、まだ使えません", "sealed"); }
// A creator may publish new trips and nothing else: no seat in any capsule comes with it. One row holds every creator, so
// enrolling, signing in and revoking are the same version CAS as a capsule edit. An enrollment is a one-time link, dropped once used.
// `unowned` names the trips a creator made that may still have no owner, so the creator can finish or delete them later (#320).
// `signedOut`: a creator cookie that passkey signed in with at or before this time is refused.
// `delegatedBy`: the creator who handed this one the right to create (#108); such a creator cannot hand it on.
type Creator = { id: string; label: string; created: number; lastUsed: number | null; revoked: number | null; delegatedBy?: string; unowned?: string[]; passkeys: Array<Passkey & { revoked: number | null; device: string; signedOut?: number }> };
// A delegation link (`ownerOf`, `by`): made by a creator for one trip's owner, redeemed only under that trip with its owner seat.
type Enrollment = { digest: string; creatorId: string | null; label: string; expires: number; ownerOf?: string; by?: string };
type Registry = { creators: Creator[]; enrollments: Enrollment[]; spent?: Array<{ digest: string; expires: number }> };
// `seat`: told back with the error. "gone" = the seat this cookie held is no more (revoked, its invite rotated, revoked or ended,
// sharing ended, the owner recovered), so the browser forgets the trip's keys; a cookie only unused for 30 days is not.
// The images an upload has put but not yet committed with its record, under the name it gave them (`PhotoAsset.blob`): whatever is
// left when the request ends is taken out again, so a request that failed, lost the race for the capsule or met a purge leaves none.
type Stage = { prefix: string; blob: string; names: string[]; done: boolean };
// A kit refuses with its own Refused (src/kit.ts); the host's own refusals also carry a reason for the log and the seat's fate.
class Fault extends Refused { constructor(status: number, message: string, public reason?: string, public seat?: "gone") { super(status, message); } }
function fail(status: number, text: string): never { throw new Fault(status, text); }
const token = () => randomBytes(32).toString("base64url");
// A generation: the job row and the creator's running row are kept past its deadline only briefly; the host-wide slots (2) are rows too.
const ASSIST_DEADLINE = 360_000, ASSIST_SLOTS = 2;
type AssistJob = { who: string; subject: string; state: "running" | "done" | "failed"; deadline: number; text?: string; result?: unknown; message?: string; kind?: "revise"; sealed?: string; system?: string; capsule?: string; seat?: string };
const reasonText = (reason?: string) => reason === "cut-off" ? "答えが途中で切れています" : reason === "many" ? "旅程が 2 つ以上あります。1 つだけ返してください" : "旅程の JSON が見つかりません。JSON だけを返してください";
const ASSIST_FAILED = "生成に失敗しました。もう一度試すか、作り方をコピーしてチャットで作ってください";
const PASSKEY_WINDOW = 5 * 60000, PASSKEY_CEREMONIES = 100;  // a capsule holds at most 50 members, so this is twice what a real five minutes can need
// Pending links are counted per requester: a creator's device links cannot crowd out the publisher's, or another creator's.
const CREATOR_SESSION = 12 * 3600000, ENROLL_WINDOW = 86400000, ENROLLMENTS = 20, DEVICE_ENROLLMENTS = 3, CREATOR_PASSKEYS = 10;
const FOREVER = 8.64e15;  // the registry row is never swept
// A member's cookie left unused this long is refused, however long its invite lasts (#252). The seat and its passkey stay.
const IDLE = 30 * 86400000, SEEN_EVERY = 86400000, LEFT = 1000;
// A creator's API key left unused this long (since it was put, or last started a generation) is swept from the key store (#744).
const KEY_IDLE = 30 * 86400000;
const uid = () => randomBytes(16).toString("hex");
const encoded = z.string().regex(/^[A-Za-z0-9_-]+$/).max(4000);
// What a member writes for themself. The host keeps the times as it is given them (the browser sealed the words against those
// very strings) and writes the two timestamps itself. The words arrive sealed: only their form and length are checked here,
// the lengths being those of the longest plain text the screen allows (docs/ephemeral-trip-capsule.md「5.6 自分だけの予定・日記の鍵」).
const PRIVATE_ENTRIES = 100;
const sealed = (max: number) => z.string().regex(/^v1\.[A-Za-z0-9_-]+$/).max(max);
const privateEntry = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(160), kind: z.enum(["item", "diary"]), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const n = new Date(v); return !isNaN(+n) && n.toISOString().slice(0, 10) === v; }),
  startsAt: isoTime.optional(), endsAt: isoTime.optional(),
  title: sealed(700), body: sealed(16_100), place: sealed(17_400).optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
}).strict().refine(e => !e.startsAt || !e.endsAt || +new Date(e.endsAt) >= +new Date(e.startsAt), "終了時刻が開始時刻より前です");
const privateOperations = z.discriminatedUnion("type", [
  z.object({ type: z.literal("put"), entry: privateEntry }).strict(),
  z.object({ type: z.literal("remove"), id: z.string() }).strict(),
  z.object({ type: z.literal("key"), wrapped: sealed(200) }).strict(),
  // Many at once, as a chat's answer changes them (#427): every entry is checked first, and one refusal leaves the list as it was.
  z.object({ type: z.literal("apply"), put: z.array(privateEntry).max(PRIVATE_ENTRIES), remove: z.array(z.string()).max(PRIVATE_ENTRIES) }).strict(),
]);
// A seat's keys for the trip (#689). Only the form and length are checked here; the host cannot open any of it.
const rawKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);  // 32 bytes, base64url
const nonce = z.string().regex(/^[A-Za-z0-9_-]{22}$/);  // 16 bytes
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);  // 64 bytes
const attempt = z.string().regex(/^[a-f0-9]{32}$/);
const seatId = z.string().min(1).max(64);
const keysOperation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("seat"), x25519: rawKey, ed25519: rawKey, ephemeral: rawKey, generation: z.number().int().min(1), wrapped: sealed(200),
    secret: z.object({ x25519: sealed(200), ed25519: sealed(200) }).strict().optional(),
    since: z.object({ x25519: rawKey, ed25519: rawKey, signature }).strict().optional(), edges: z.array(z.object({ seat: seatId, signature }).strict()).max(200).optional(),
  }).strict(),
  // The handoff of the trip key to a seat that has none (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」, steps 1-4 and the edge).
  z.object({ type: z.literal("wait"), commitment: rawKey }).strict(),
  z.object({ type: z.literal("give"), seat: seatId, attempt, ephemeral: rawKey }).strict(),
  z.object({ type: z.literal("reveal"), attempt, x25519: rawKey, ed25519: rawKey, nonce }).strict(),
  z.object({ type: z.literal("wrap"), seat: seatId, attempt, wrapped: sealed(200) }).strict(),
  z.object({ type: z.literal("edge"), seat: seatId, signature }).strict(),
  z.object({ type: z.literal("abandon"), seat: seatId.optional(), attempt }).strict(),  // no seat: the caller's own attempt
  // The owner keeps the trip key after an owner seat was handed over (spec「5.5 旅行の鍵を替える」).
  z.object({ type: z.literal("keep") }).strict(),
]);
const EDGES = 200;
// Every ciphertext in what a request brings, for the check that it is of the trip key's present generation (spec「5.5 旅行の鍵を替える」).
const ciphers = (value: unknown): string[] => typeof value === "string" ? value.startsWith("v1.") ? [value] : [] : value && typeof value === "object" ? Object.values(value).flatMap(ciphers) : [];
// A footprint is one fix of the browser's position: at most a kilometre off, once a minute per seat, a thousand per trip.
const FOOTPRINTS = 1000, FOOTPRINT_EVERY = 60000;
const footprintOperations = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), ...pointSchema.shape, auto: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("remove"), id: z.string().min(1).max(64) }).strict(),
]);
// A sealed trip's point arrives sealed against the id the browser chose (src/trip-keys.ts sealPoint, sealName): its range is
// the browser's to check (docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」); the rest of the checks are the same as a plain one's.
const sealedFootprintOperations = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), point: cipher(200), by: cipher(CIPHER.short), auto: z.literal(true).optional() }).strict(),
  footprintOperations.options[1],
]);
// A photo arrives sealed by the browser, which chose its id (the id is in the ciphertext's associated data): the host checks the plain
// parts, the form of what is sealed and the sizes, and opens and reads no image. `images` are the IV, sealed bytes and tag, in base64.
// The size of what is sealed is told apart from its form (413, in Japanese, as the browser's own check says it).
const image = z.string().refine(v => { const n = Buffer.from(v, "base64"); return n.length > SEALED_OVERHEAD && n.toString("base64") === v; });
const edge = (max: number) => z.number().int().min(1).max(max);
const photoInput = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/), images: z.object({ display: image, thumb: image }).strict(),
  width: edge(PHOTO_LIMITS.displayEdge), height: edge(PHOTO_LIMITS.displayEdge), thumb: z.object({ width: edge(PHOTO_LIMITS.thumbEdge), height: edge(PHOTO_LIMITS.thumbEdge) }).strict(),
  capturedAt: isoTime.optional(), key: cipher(200), location: cipher(300).optional(), caption: cipher(CIPHER.short).optional(),
}).strict();
// What is done to a photo already there: taken out, put under an item chosen by hand (`null` gives it back to its time,
// src/moments.ts linkPhotos), or given a caption, sealed by the browser as at upload (its 160 characters are the browser's to check).
const photoId = z.string().regex(/^[a-f0-9]{32}$/);
const photoOperations = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remove"), id: photoId }).strict(),
  z.object({ type: z.literal("link"), id: photoId, itemId: z.string().min(1).max(200).nullable() }).strict(),
  z.object({ type: z.literal("caption"), id: photoId, caption: cipher(CIPHER.short).nullable() }).strict(),
]);
const grantInput = z.object({ role: z.enum(["owner", "editor", "participant", "viewer"]), label: author.default("招待リンク"), expiresAt: isoTime, seats: z.number().int().min(1).max(50).default(1), claimDays: z.number().int().min(1).max(30).default(3), confirm: z.literal(true), rotate: z.string().optional(), approval: z.enum(["auto", "owner"]).optional() }).strict();
// A sealed trip's invite is named in ciphertext sealed against the id the browser chose, or with one of the host's own names.
const sealedGrantInput = grantInput.extend({ id: z.string().regex(/^[0-9a-f]{32}$/), label: z.union([cipher(CIPHER.short), z.enum(["自分用", "招待リンク"])]).default("招待リンク") });

// Whether Anthropic accepts the key: listing models costs nothing. A key it refuses is false; an outage throws.
async function anthropicAccepts(apiKey: string) {
  try { await new Anthropic({ apiKey, maxRetries: 0, timeout: 10_000 }).models.list(); return true; }
  catch (e) { if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return false; throw e; }
}

export class CloudHost {
  store: CapsuleStore;
  keys: KeyStore;
  kits: Record<string, DomainKit>;
  // `KITS`: the kinds this host publishes and opens (src/kits.ts by default; a test adds its own).
  constructor(public env: { KITS?: Record<string, DomainKit>; DB?: D1; STORE?: CapsuleStore; KEYS?: KeyStore; MEDIA?: MediaStore; VERIFY_KEY?: (apiKey: string) => Promise<boolean>; ASSIST?: { generate: (apiKey: string, model: string, text: string, system?: string, follow?: Follow) => Promise<Generated>; dispatch?: (id: string) => Promise<void> }; CAPSULE_ASSIST_MODEL?: string; CAPSULE_HMAC_KEY: string; CAPSULE_ORIGIN: string; CAPSULE_CLAIM_COUNTRIES?: string; CAPSULE_DISABLED_ACTIONS?: string; CAPSULE_SEALED_FROM?: string; CAPSULE_PHOTOS?: string }, public clock = () => Date.now(), public publisherIdentity: (req: Request) => Promise<string | null> = async () => null) {
    // Publisher authorization only permits creation; all trip access requires a capability session.
    const origin = new URL(env.CAPSULE_ORIGIN);
    if (origin.origin !== env.CAPSULE_ORIGIN || (origin.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) throw new Error("公開ホストはHTTPSが必要です");
    if (env.CAPSULE_HMAC_KEY.length < 32) throw new Error("Missing secrets");
    if (!env.STORE && !env.DB) throw new Error("Missing store");
    this.store = env.STORE ?? new CloudStore(env.DB!);
    if (!env.KEYS && !env.DB) throw new Error("Missing key store");
    this.keys = env.KEYS ?? new LocalKeyStore(env.DB!, () => this.clock());
    this.kits = env.KITS ?? registered;
    if (env.CAPSULE_SEALED_FROM) { this.sealedFrom = Date.parse(env.CAPSULE_SEALED_FROM); if (Number.isNaN(this.sealedFrom)) throw new Error("CAPSULE_SEALED_FROM は時刻で指定してください"); }
  }
  // The line after which a trip was published once the new screen was out (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」, aws/README.md「旅程の暗号化を始めた後に発行した旅行（`SealedFrom`）」):
  // such a trip is not used plain. Until the operator sets it, there is none.
  sealedFrom: number | undefined;
  // Photos are off until the operator turns them on (CAPSULE_PHOTOS=1): nothing is put up while they are off, and what is there
  // is still read, taken out and deleted with the trip.
  get photosOn() { return this.env.CAPSULE_PHOTOS === "1"; }
  // A trip published after the line and not moved yet: only its owner may come in, to take the seat, check a passkey, put the
  // keys, move it or delete it.
  mustSeal(c: Capsule) { return !c.sealed && this.sealedFrom !== undefined && c.created >= this.sealedFrom; }
  digest(s: string) { return createHmac("sha256", this.env.CAPSULE_HMAC_KEY).update(s).digest("hex"); }
  equal(a: string, b: string) { return timingSafeEqual(Buffer.from(this.digest(a), "hex"), Buffer.from(this.digest(b), "hex")); }
  async json(req: Request) {
    if (!(req.headers.get("Content-Type") ?? "").startsWith("application/json")) fail(415, "JSONを送信してください");
    const reader = req.body?.getReader(); if (!reader) fail(400, "本文が必要です");
    let length = 0; const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 2 * 1024 * 1024) { await reader.cancel(); fail(413, "本文が大きすぎます"); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, "JSONが不正です"); }
  }
  // The kit of a capsule kept. One whose kind this host no longer has is not opened.
  kit(c: { spec: Envelope }) { return kitOf(c.spec, this.kits) ?? fail(500, "この種類のカプセルは開けません"); }
  // What a creator makes when the request names no kind (the top page's trip).
  get made() { return this.kits[DEFAULT_KIND] ?? fail(404, "この種類では使えません"); }
  // A named row held until a time: free when absent or past `until`, taken by a version CAS so two requests cannot both win.
  // The rows never expire (FOREVER): a swept row would block its own re-creation. There are two slots and one per creator, so they stay few.
  async take(name: string, holder: string, until: number) {
    const key = this.digest(name), now = this.clock(), payload = JSON.stringify({ holder, until });
    const row = await this.store.get(key);
    if (!row?.payload) return (await this.store.create(key, payload, FOREVER, key, now)).meta.changes === 1;
    if ((JSON.parse(row.payload) as { until: number }).until > now) return false;
    return this.store.save(row, payload, FOREVER, now);
  }
  async letGo(name: string, holder: string) {
    const key = this.digest(name);
    for (let i = 0; i < 2; i++) {
      const row = await this.store.get(key);
      if (!row?.payload || (JSON.parse(row.payload) as { holder: string }).holder !== holder) return;
      if (await this.store.save(row, JSON.stringify({ holder, until: 0 }), FOREVER, this.clock())) return;
    }
  }
  async finishAssist(id: string, patch: Partial<AssistJob>) {
    const key = this.digest(`assist:${id}`);
    for (let i = 0; i < 3; i++) {
      const row = await this.store.get(key);
      if (!row?.payload) return;
      const { text: _, sealed: __, ...job } = JSON.parse(row.payload) as AssistJob;  // neither the wish nor the sealed key stays
      if (job.state !== "running" || job.deadline <= this.clock()) return;  // a late answer does not overwrite the failure the poll already gave
      if (await this.store.save(row, JSON.stringify({ ...job, ...patch }), row.purge_at, this.clock())) return;
    }
  }
  // The periodic cleanup: expired trips, then creators' keys unused for KEY_IDLE. The trips are done by the time the keys are
  // looked at, so a failing key store (a missing permission, an outage) leaves only a log line with no key or subject in it.
  async sweep(now: number) {
    // A trip's photos go before its row does; one that cannot be removed leaves the trip for the next sweep to try again.
    const media = this.env.MEDIA;
    await this.store.sweep(now, media && (async key => { try { await media.removeAll(key); } catch (err) { this.log({ action: "sweep", method: "RUN", status: 500, reason: "sweep:media", ip: "-" }); throw err; } }));
    try { await this.keys.sweep(now - KEY_IDLE); } catch { this.log({ action: "sweep", method: "RUN", status: 500, reason: "sweep:keys", ip: "-" }); }
  }
  // Takes the creator's or seat's running row and a host-wide slot, writes the job row and starts it: the one way a generation
  // begins, for a creator's new trip and for a member revising theirs. `holder` names who is counted and who may read it.
  async beginAssist(holder: string, job: Pick<AssistJob, "subject" | "text"> & Partial<AssistJob>, rateKey: string) {
    const now = this.clock(), id = uid(), who = this.digest(holder), deadline = now + ASSIST_DEADLINE;
    const held = [`assist:running:${who}`];
    const release = () => Promise.all(held.map(name => this.letGo(name, id)));
    if (!await this.take(held[0]!, id, deadline)) fail(429, "前の生成が終わるまで待ってください");
    try {
      await this.rate(rateKey, 2);  // after the running row, so a refused second click does not use up a turn
      let slot = false;
      for (let i = 0; i < ASSIST_SLOTS && !slot; i++) if (slot = await this.take(`assist:slot:${i}`, id, deadline)) held.push(`assist:slot:${i}`);
      if (!slot) fail(429, "混み合っています。1分ほど待ってもう一度試してください");
      const row: AssistJob = { ...job, who, state: "running", deadline };
      const jobKey = this.digest(`assist:${id}`);
      if ((await this.store.create(jobKey, JSON.stringify(row), deadline + 3_600_000, jobKey, now)).meta.changes !== 1) fail(500, "処理に失敗しました。再試行してください");
      try { await (this.env.ASSIST?.dispatch ?? (async (id: string) => { this.runAssist(id).catch(() => {}); }))(id); }
      catch { await this.finishAssist(id, { state: "failed", message: ASSIST_FAILED }); await release(); fail(502, ASSIST_FAILED); }
    } catch (e) { await release(); throw e; }
    return id;
  }
  // Runs the generation a POST /v1/assist accepted. Nothing but a status is kept of a failure; the wish, the key and the
  // answer are never logged, and the wish leaves the row as soon as the answer is in.
  async runAssist(id: string) {
    const row = await this.store.get(this.digest(`assist:${id}`));
    const job = row?.payload ? JSON.parse(row.payload) as AssistJob : undefined;
    if (!job || job.state !== "running" || job.text === undefined) return;
    try {
      let sealed = job.sealed ?? (job.kind === "revise" ? undefined : await this.keys.get(job.subject));
      let problemsOf = (text: string): string[] => { const j = this.made.judge(text, this.clock()); return j.ok ? [] : j.messages?.length ? j.messages : [reasonText(j.reason)]; };
      if (job.kind === "revise") {
        // The seat is read again now: one that was revoked, lost its role or its key since the request does not get its key used.
        const capsule = job.capsule && job.seat ? await this.store.get(this.digest(job.capsule)) : null;
        const c = capsule?.payload ? JSON.parse(capsule.payload) as Capsule : undefined, seat = c?.sessions.find(x => x.id === job.seat);
        const grant = seat && c?.grants.find(g => g.id === seat.grantId);
        const live = Boolean(seat && grant && grant.revoked === null && grant.expires > this.clock() && seat.expires > this.clock() && !seat.pending && (grant.role === "owner" || grant.role === "editor") && seat.assistKey && seat.assistKey === job.sealed);
        // A trip sealed since the request is not sent out: the host cannot read its words (spec「5.3 暗号化した旅行で Host にできないこと」).
        if (c?.sealed) return await this.finishAssist(id, { state: "failed", message: "暗号化した旅行では、まだ使えません" });
        if (!live) sealed = undefined;
        else problemsOf = (text: string) => {
          try { const r = this.revision(c!, text, seat!.label, grant!.role !== "owner"); return r.ok ? [] : r.messages?.length ? r.messages : [reasonText(r.reason)]; } catch { return []; }
        };
      }
      if (!sealed) return await this.finishAssist(id, { state: "failed", message: "Anthropic の API キーを登録してください" });
      const apiKey = open(this.env.CAPSULE_HMAC_KEY, job.subject, sealed), model = this.env.CAPSULE_ASSIST_MODEL ?? ASSIST_MODEL, call = this.env.ASSIST?.generate ?? anthropicGenerate;
      let out = await call(apiKey, model, job.text, job.system);
      // What the host's own check refuses is told back once, so a first answer with a wrong field is put right rather than shown as an error.
      // The repair is only a second chance: if it fails, the first answer stands and is shown with what was wrong with it.
      if (out.kind === "text" && out.text.trim()) {
        const problems = problemsOf(out.text);
        if (problems.length) try { const again = await call(apiKey, model, job.text, job.system, { answer: out.text, problems: problems.slice(0, 10) }); if (again.kind === "text" && again.text.trim()) out = again; } catch { /* keep the first answer */ }
      }
      if (out.kind === "refused") await this.finishAssist(id, { state: "failed", message: "この希望からは旅程を作れませんでした。内容を変えて試してください" });
      else await this.finishAssist(id, { state: "done", result: out.kind === "cut-off" ? { ok: false, reason: "cut-off" } : job.kind === "revise" ? (out.text.trim() ? { ok: true, text: out.text } : { ok: false, reason: "empty" }) : this.made.judge(out.text, this.clock()) });
    } catch (e) {
      const status = (e as { status?: number }).status, kind = (e as { error?: { error?: { type?: string } } }).error?.error?.type;
      // What Anthropic said is for the one whose key it was: its status and type go to the log, its sentence only to them.
      const said = e instanceof Anthropic.APIError && status !== undefined && ![401, 403, 429].includes(status) ? `（原因: ${status}${kind ? ` ${kind}` : ""}。${String(e.message).replace(/\s+/g, " ").slice(0, 200)}）` : "";
      const unreached = e instanceof Anthropic.APIConnectionError ? "（原因: Anthropic に接続できないか、時間内に答えが返りませんでした）" : "";
      if (status !== undefined) try { this.log({ action: "assist", method: "RUN", status, reason: `anthropic:${kind ?? "error"}`.slice(0, 64), ip: "-" }); } catch { /* the log is best effort */ }
      await this.finishAssist(id, { state: "failed", message: status === 401 || status === 403 ? "登録した API キーが Anthropic に拒否されました。鍵を登録し直してください" : status === 429 ? "Anthropic の利用上限に達しています。時間をおいて試してください" : ASSIST_FAILED + said + unreached });
    } finally {
      await this.letGo(`assist:running:${job.who}`, id);
      for (let i = 0; i < ASSIST_SLOTS; i++) await this.letGo(`assist:slot:${i}`, id);
    }
  }
  async rate(key: string, max: number) { if (!await this.store.rate(this.digest(key), max, this.clock())) throw new Fault(429, "操作が多すぎます。1分後に再試行してください", `rate:${key.slice(0, Math.max(0, key.indexOf(":")))}`); }
  issue(c: Capsule, id: string, role: Role, label: string, expires: number, seats = 1, claimBy = this.clock() + CLAIM_WINDOW, issuedBy?: string, approval: "auto" | "owner" = "auto", grantId = uid()) {
    if (expires <= this.clock() || expires > +new Date(c.spec.lifecycle.purgeAt)) fail(400, "リンクの期限が不正です");
    const active = c.grants.filter(g => !g.revoked && g.expires > this.clock());
    if (active.length >= 50) fail(400, "有効なリンクは50件までです");
    if (active.reduce((n, g) => n + g.seats, seats) > 100) fail(400, "招待できるのは合計100席までです");
    const secret = token();
    c.grants.push({ id: grantId, role, label, digest: this.digest(secret), expires, revoked: null, created: this.clock(), lastUsed: null, seats, claimed: 0, claimBy: Math.min(claimBy, expires), ...(issuedBy ? { issuedBy } : {}), ...(approval === "owner" ? { approval } : {}) });
    // openExternalBrowser makes LINE hand the link to the default browser, so the seat is not bound to an in-app webview.
    return { grantId, url: `${this.env.CAPSULE_ORIGIN}/c/${id}?openExternalBrowser=1#k=${secret}` };
  }
  // Records the seats that held the trip key's present generation and are gone (spec「5.5 旅行の鍵を替える」). Nothing for a plain trip, nor for a seat
  // that held an older generation only: it cannot read what follows anyway. True when something was recorded.
  depart(c: Capsule, gone: Session[], why: Departure["why"]) {
    if (!c.sealed) return false;
    const now = this.clock(), added = gone.filter(s => s.seatKey?.generation === c.sealed!.generation && !c.departed?.some(d => d.seat === s.id));
    if (added.length) c.departed = [...c.departed ?? [], ...added.map(s => ({ seat: s.id, at: now, why }))].slice(-200);
    return added.length > 0;
  }
  cookie(req: Request, id: string) { const v = req.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`capsule_${id}=`))?.split("=")[1]; return v && v.length <= 200 ? v : undefined; }
  setCookie(id: string, secret: string, expires: number) { return `capsule_${id}=${secret}; HttpOnly; ${this.env.CAPSULE_ORIGIN.startsWith("https:") ? "Secure; " : ""}SameSite=Strict; Path=/v1/c/${id}; Max-Age=${Math.floor((expires - this.clock()) / 1000)}`; }
  session(req: Request, c: Capsule, id: string) {
    const value = this.cookie(req, id);
    if (!value) fail(401, "招待リンクから参加してください");
    const digest = this.digest(value), s = c.sessions.find(s => s.digest === digest);
    const g = s && c.grants.find(g => g.id === s.grantId);
    if (!s || s.expires <= this.clock() || this.idle(s) || !g || g.revoked !== null || g.expires <= this.clock()) {
      // A cookie that a passkey return elsewhere or a sign-out replaced matches no seat either, but its seat is there: not gone.
      const gone = s ? !g || g.revoked !== null || g.expires <= this.clock() || s.expires <= this.clock() : Boolean(c.left?.includes(digest));
      throw gone ? new Fault(401, "この端末の登録は失効したか、期限が切れました", "seat-gone", "gone") : new Fault(401, "この端末の登録は失効したか、期限が切れました");
    }
    return { grant: g, member: s, secret: value };
  }
  idle(s: Session) { return (s.seen ?? this.clock()) + IDLE <= this.clock(); }
  leave(c: Capsule, gone: Session[]) { const added = gone.map(s => s.digest).filter(d => !c.left?.includes(d)); if (added.length) c.left = [...c.left ?? [], ...added].slice(-LEFT); }
  // A stolen cookie alone must not hand out seats or end a trip: an owner's important actions need this browser's passkey
  // checked in the last five minutes. 428 tells the screen to check (or register a first passkey) and send the action again.
  verified(member: Session) { if ((member.verifiedUntil ?? 0) <= this.clock()) fail(428, "パスキーで本人確認してください"); }
  // A stolen creator cookie alone must not replace or delete the API key, nor hand over or delete a trip: these need the sign-in
  // that made the cookie to be in the last five minutes. Checking again is signing in again (#748).
  recentCreator(signed: { signedAt: number }) { if (signed.signedAt + PASSKEY_WINDOW <= this.clock()) fail(428, "パスキーで本人確認してください"); }
  // A WebAuthn challenge is signed rather than stored, so issuing one to a browser that has no cookie yet writes nothing.
  // Only a challenge that completed a ceremony is recorded, which is what stops it being replayed.
  passkeyChallenge(id: string) {
    const head = Buffer.alloc(22);
    head.writeUIntBE(this.clock() + PASSKEY_WINDOW, 0, 6); randomBytes(16).copy(head, 6);
    return Buffer.concat([head, Buffer.from(this.digest(`passkey:${id}:${head.toString("hex")}`), "hex")]).toString("base64url");
  }
  // The entry to record once the ceremony succeeds, or undefined if the challenge is forged, expired, for another capsule, or already used.
  passkeyChallengeOf(c: { spent?: Capsule["spent"] }, id: string, challenge: string) {
    const raw = Buffer.from(challenge, "base64url");
    if (raw.length !== 54) return;
    const head = raw.subarray(0, 22), mac = raw.subarray(22), expires = head.readUIntBE(0, 6);
    if (expires <= this.clock() || !timingSafeEqual(mac, Buffer.from(this.digest(`passkey:${id}:${head.toString("hex")}`), "hex"))) return;
    const digest = mac.toString("base64url");
    if (this.spent(c).some(x => x.digest === digest)) return;
    return { digest, expires };
  }
  spent(c: { spent?: Capsule["spent"] }) { return (c.spent ?? []).filter(x => x.expires > this.clock()); }
  // A used challenge is kept until it expires on its own: dropping one early would let its ceremony be replayed.
  // The list can only grow for as long as a challenge lives, so a saturated capsule refuses new ceremonies instead.
  record(c: { spent?: Capsule["spent"] }, used: { digest: string; expires: number }) {
    const kept = this.spent(c);
    if (kept.length >= PASSKEY_CEREMONIES) fail(429, "操作が多すぎます。1分後に再試行してください");
    c.spent = [...kept, used];
  }
  // Read without writing: the row is created by the first enrollment, so a sign-in attempt on an empty host stores nothing.
  async registry(): Promise<{ row: CloudRow | null; reg: Registry }> {
    const row = await this.store.get(this.digest("creators"));
    return { row, reg: row?.payload ? JSON.parse(row.payload) as Registry : { creators: [], enrollments: [] } };
  }
  async saveRegistry(row: CloudRow | null, reg: Registry) {
    const serialized = JSON.stringify(reg);
    if (Buffer.byteLength(serialized) > 1_900_000) fail(413, "作成者の登録簿の容量上限です");
    if (row) return this.store.save(row, serialized, FOREVER, this.clock());
    return (await this.store.create(this.digest("creators"), serialized, FOREVER, this.digest("creators"), this.clock())).meta.changes === 1;
  }
  // Signed rather than stored, like a passkey challenge; the registry is read on every request, so revocation takes effect at once.
  creatorCookie(creatorId: string, passkeyId: string) {
    const expires = this.clock() + CREATOR_SESSION, body = `${creatorId}.${passkeyId}.${expires}`;
    return `capsule_creator=${Buffer.from(`${body}.${this.digest(`creator:${body}`)}`).toString("base64url")}; HttpOnly; ${this.env.CAPSULE_ORIGIN.startsWith("https:") ? "Secure; " : ""}SameSite=Strict; Path=/v1; Max-Age=${CREATOR_SESSION / 1000}`;
  }
  creatorOf(req: Request, reg: Registry) {
    const raw = req.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("capsule_creator="))?.slice("capsule_creator=".length);
    if (!raw || raw.length > 4000) return;
    const [creatorId, passkeyId, expires, mac] = Buffer.from(raw, "base64url").toString().split(".");
    if (!mac || !this.equal(mac, this.digest(`creator:${creatorId}.${passkeyId}.${expires}`)) || Number(expires) <= this.clock()) return;
    const creator = reg.creators.find(c => c.id === creatorId && c.revoked === null), passkey = creator?.passkeys.find(p => p.id === passkeyId && p.revoked === null);
    return creator && passkey && Number(expires) - CREATOR_SESSION > (passkey.signedOut ?? -1) ? { creator, passkey, signedAt: Number(expires) - CREATOR_SESSION } : undefined;
  }
  // A usable enrollment: unexpired, for a device link its creator not revoked, for a delegation link the one who made it not revoked.
  enrollmentOf(reg: Registry, secret: string, now: number) {
    const digest = Buffer.from(this.digest(secret), "hex"), enrollment = reg.enrollments.find(e => e.expires > now && timingSafeEqual(Buffer.from(e.digest, "hex"), digest));
    const live = (id: string) => reg.creators.find(c => c.id === id && c.revoked === null);
    const target = enrollment?.creatorId ? live(enrollment.creatorId) : undefined;
    return enrollment && (!enrollment.creatorId || target) && (!enrollment.by || live(enrollment.by)) ? { enrollment, target } : undefined;
  }
  // Rewrites a creator's list of trips that may have no owner. Refused when the creator is gone or the registry keeps changing.
  async unowned(creatorId: string, update: (ids: string[]) => string[]) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { row, reg } = await this.registry(), creator = reg.creators.find(c => c.id === creatorId && c.revoked === null);
      if (!creator) fail(401, "作成者としてサインインしてください");
      creator.unowned = update(creator.unowned ?? []);
      if (await this.saveRegistry(row, reg)) return;
    }
    fail(409, "同時更新がありました。再試行してください");
  }
  // A creator's own trips that nobody owns yet: listed by title, dates and deletion date only (never the trip itself), so the
  // creator can still choose the owner, or delete the trip, after closing the page. The trip stays the creator's until an owner
  // seat is taken; then it is handed over for good (`ownedAt`), even if the IAM publisher later replaces the owner invite.
  async creatorTrips(req: Request, input: unknown): Promise<Response> {
    const signed = this.creatorOf(req, (await this.registry()).reg), creator = signed?.creator;
    if (!signed || !creator) fail(401, "作成者としてサインインしてください");
    await this.rate(`trips:${creator.id}`, 60);
    const trip = z.string().regex(/^[a-f0-9]{32}$/);
    const v = z.union([z.object({}).strict(), z.object({ id: trip, owner: z.literal(true) }).strict(), z.object({ id: trip, purge: z.literal(true), confirm: z.literal(true) }).strict()]).parse(input);
    const now = this.clock(), open = async (id: string) => {
      const row = await this.store.get(this.digest(id));
      if (!row?.payload || row.purge_at <= now) return;
      // A capsule claimed before `ownedAt` was recorded shows it by its owner invite's claims instead.
      const c = JSON.parse(row.payload) as Capsule; return c.ownedAt === undefined && !c.grants.some(g => g.role === "owner" && g.claimed > 0) ? { row, c } : undefined;
    };
    if (!("id" in v)) {
      const listed: Array<{ id: string; title: string; startsOn?: string; endsOn?: string; purgeAt: string; created: number }> = [], gone: string[] = [];
      for (const id of creator.unowned ?? []) {
        const t = await open(id), period = t && kitOf(t.c.spec, this.kits)?.period?.(t.c.spec);
        if (t) listed.push({ id, title: t.c.spec.title, ...period && { startsOn: period.startsOn, endsOn: period.endsOn }, purgeAt: t.c.spec.lifecycle.purgeAt, created: t.c.created });
        // A name with no row yet may be a publish still on its way, so only a trip seen deleted, expired or handed over is dropped.
        else if (await this.store.get(this.digest(id))) gone.push(id);
      }
      // Keeping a stale name costs nothing, so a failed write is not an error.
      if (gone.length) try { await this.unowned(creator.id, ids => ids.filter(id => !gone.includes(id))); } catch { /* next time */ }
      return Response.json(listed.reverse());
    }
    this.recentCreator(signed);
    if (!(creator.unowned ?? []).includes(v.id)) fail(404, "オーナーを決めていない旅行が見つかりません");
    for (let attempt = 0; attempt < 4; attempt++) {
      const t = await open(v.id);
      if (!t) fail(404, "オーナーを決めていない旅行が見つかりません");
      if ("owner" in v) {
        // Every owner invite goes (none has been taken), and a fresh one opens a new claim window.
        t.c.grants = t.c.grants.filter(g => g.role !== "owner");
        const link = this.issue(t.c, v.id, "owner", "自分用", +new Date(t.c.spec.lifecycle.purgeAt));
        t.c.audit.push({ event: "creator-owner", role: "owner", by: "作成者", at: now }); t.c.audit = t.c.audit.slice(-2000);
        if (await this.store.save(t.row, JSON.stringify(t.c), t.row.purge_at, now)) return Response.json(link, { status: 201 });
      } else if (await this.store.save(t.row, null, t.row.purge_at, now)) {
        try { await this.unowned(creator.id, ids => ids.filter(id => id !== v.id)); } catch { /* dropped when the list is next read */ }
        return Response.json({ ok: true });
      }
    }
    return fail(409, "同時更新がありました。再試行してください");
  }
  // `ownerOf`: a delegation link redeemed under that trip (POST /v1/c/<id>/creators/register), by a browser holding its owner seat.
  // The seat is only checked, never written; the creator cookie still opens no trip.
  async creators(req: Request, action: string, identity: string | null, ip: string, ownerOf?: string): Promise<Response> {
    if (["enroll", "challenge", "register", "session"].includes(action)) await this.rate(`login:${ip}`, 15);
    if (action === "trips") return this.creatorTrips(req, await this.json(req));
    if (ownerOf) {
      const row = await this.store.get(this.digest(ownerOf));
      if (!row) fail(404, "カプセルが見つかりません");
      if (!row.payload || row.purge_at <= this.clock()) fail(410, "この旅のカプセルは削除されました");
      if (this.session(req, JSON.parse(row.payload) as Capsule, ownerOf).grant.role !== "owner") fail(403, "この旅行のオーナーだけが受け取れます");
    }
    const input = await this.json(req), rpId = rpIdOf(this.env.CAPSULE_ORIGIN), expected = (challenge: string) => ({ challenge, origin: this.env.CAPSULE_ORIGIN, rpId });
    if (action === "challenge") {
      // With an enrollment link, the link is checked first: a used or expired one must stop the browser before its OS makes a
      // passkey that nothing will accept. Nothing is written either way.
      const v = z.object({ secret: z.string().min(32).max(100).optional() }).strict().parse(input);
      if (v.secret !== undefined) { const { reg } = await this.registry(); if (!this.enrollmentOf(reg, v.secret, this.clock())) fail(401, "登録リンクが無効か期限切れです"); }
      return Response.json({ challenge: this.passkeyChallenge("creators"), rpId });
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const { row, reg } = await this.registry(), now = this.clock();
      reg.enrollments = reg.enrollments.filter(e => e.expires > now);
      let response: Response;
      if (action === "enroll") {
        // The IAM publisher enrolls a new creator; a signed-in creator adds a device to themself, with a passkey of theirs in this
        // same request (their cookie alone is not enough). Nobody else can do either. A refused check writes nothing.
        const creator = identity ? undefined : this.creatorOf(req, reg)?.creator;
        let label: string | undefined;
        if (identity) {
          label = z.object({ label: author.optional(), confirm: z.literal(true) }).strict().parse(input).label;
          if (!label) fail(400, "作成者の名前を指定してください");
        } else {
          if (!creator) fail(401, "作成者としてサインインしてください");
          // A cookie with no assertion is refused like a wrong one (401), not as a malformed request.
          const v = z.object({ confirm: z.literal(true), ownerOf: z.string().regex(/^[a-f0-9]{32}$/).optional(), challenge: encoded.optional(), id: encoded.optional(), clientDataJSON: encoded.optional(), authenticatorData: encoded.optional(), signature: encoded.optional() }).strict().parse(input);
          const { challenge, id, clientDataJSON, authenticatorData, signature } = v;
          const used = challenge ? this.passkeyChallengeOf(reg, "creators", challenge) : undefined, passkey = creator.passkeys.find(p => p.id === id && p.revoked === null);
          let counter: number | undefined;
          if (used && passkey && challenge && clientDataJSON && authenticatorData && signature) try { counter = verifyAssertion({ clientDataJSON, authenticatorData, signature }, expected(challenge), passkey); } catch { /* refused below */ }
          if (counter === undefined || !used || !passkey) fail(401, "パスキーで本人確認してください");
          passkey.counter = counter; this.record(reg, used);
          // A delegation link: for one trip's owner, who becomes a creator of their own. A delegated creator cannot hand it on.
          if (v.ownerOf) {
            if (creator.delegatedBy) fail(403, "作成権限を分けられるのは、もとの作成者だけです");
            if (reg.enrollments.filter(e => e.by === creator.id).length >= DEVICE_ENROLLMENTS) fail(429, "有効な登録リンクが多すぎます。1日後に再試行してください");
            const secret = token(), expires = now + ENROLL_WINDOW;
            reg.enrollments.push({ digest: this.digest(secret), creatorId: null, ownerOf: v.ownerOf, by: creator.id, label: `${creator.label} の委任`, expires });
            response = Response.json({ url: `${this.env.CAPSULE_ORIGIN}/c/${v.ownerOf}#delegate=${secret}`, expires }, { status: 201 });
            if (await this.saveRegistry(row, reg)) return response;
            continue;
          }
        }
        // Delegation links are counted per creator above, never against the IAM publisher's.
        if (reg.enrollments.filter(e => creator ? e.creatorId === creator.id : !e.creatorId && !e.by).length >= (creator ? DEVICE_ENROLLMENTS : ENROLLMENTS)) fail(429, "有効な登録リンクが多すぎます。1日後に再試行してください");
        const secret = token(), expires = now + ENROLL_WINDOW;
        reg.enrollments.push({ digest: this.digest(secret), creatorId: creator?.id ?? null, label: creator?.label ?? label!, expires });
        response = Response.json({ url: `${this.env.CAPSULE_ORIGIN}/#creator=${secret}`, expires }, { status: 201 });
      } else if (action === "register") {
        // Nothing is written unless the passkey verifies: a browser that cannot make one leaves the link usable and no creator behind.
        const v = z.object({ secret: z.string().min(32).max(100), challenge: encoded, clientDataJSON: encoded, authenticatorData: encoded, publicKey: encoded, algorithm: z.number().int() }).strict().parse(input);
        const { enrollment, target } = this.enrollmentOf(reg, v.secret, now) ?? fail(401, "登録リンクが無効か期限切れです");
        // A delegation link is redeemed under its own trip only; any other link not under a trip at all.
        if (enrollment.ownerOf !== ownerOf) fail(401, "登録リンクが無効か期限切れです");
        const used = this.passkeyChallengeOf(reg, "creators", v.challenge);
        if (!used) fail(401, "もう一度やり直してください");
        let passkey: Passkey | undefined; try { passkey = verifyRegistration(v, expected(v.challenge), now); } catch { /* refused below */ }
        if (!passkey || reg.creators.some(c => c.passkeys.some(p => p.id === passkey.id))) fail(400, "パスキーを登録できませんでした");
        if (target && target.passkeys.filter(p => p.revoked === null).length >= CREATOR_PASSKEYS) fail(400, `パスキーは${CREATOR_PASSKEYS}本までです`);
        const creator: Creator = target ?? { id: uid(), label: enrollment.label, created: now, lastUsed: null, revoked: null, ...(enrollment.by ? { delegatedBy: enrollment.by } : {}), passkeys: [] };
        if (!target) reg.creators.push(creator);
        creator.passkeys.push({ ...passkey, revoked: null, device: deviceLabel(req.headers.get("user-agent")) }); creator.lastUsed = now;
        reg.enrollments = reg.enrollments.filter(e => e !== enrollment); this.record(reg, used);
        response = Response.json({ label: creator.label }, { status: 201, headers: { "Set-Cookie": this.creatorCookie(creator.id, passkey.id) } });
      } else if (action === "session") {
        const v = z.object({ challenge: encoded, id: encoded, clientDataJSON: encoded, authenticatorData: encoded, signature: encoded }).strict().parse(input);
        const used = this.passkeyChallengeOf(reg, "creators", v.challenge), creator = reg.creators.find(c => c.revoked === null && c.passkeys.some(p => p.id === v.id && p.revoked === null)), passkey = creator?.passkeys.find(p => p.id === v.id);
        let counter: number | undefined;
        if (used && passkey) try { counter = verifyAssertion(v, expected(v.challenge), passkey); } catch { /* refused below */ }
        // One answer for every refusal: it must not reveal whether a passkey or a creator exists. A refusal writes nothing.
        if (counter === undefined || !used || !creator || !passkey) fail(401, "サインインできませんでした");
        passkey.counter = counter; passkey.device = deviceLabel(req.headers.get("user-agent")); creator.lastUsed = now; this.record(reg, used);
        response = Response.json({ label: creator.label }, { headers: { "Set-Cookie": this.creatorCookie(creator.id, passkey.id) } });
      } else if (action === "signout") {
        // This browser's passkey stops signing anyone in with the cookies it gave out so far; the creator's other devices go on.
        z.object({}).strict().parse(input);
        const signed = this.creatorOf(req, reg); if (!signed) fail(401, "作成者としてサインインしてください");
        signed.passkey.signedOut = now;
        response = Response.json({ ok: true }, { headers: { "Set-Cookie": `capsule_creator=; HttpOnly; ${this.env.CAPSULE_ORIGIN.startsWith("https:") ? "Secure; " : ""}SameSite=Strict; Path=/v1; Max-Age=0` } });
      } else if (action === "list") {
        if (!identity) fail(401, "旅行の発行権限が必要です");
        z.object({}).strict().parse(input);
        return Response.json(reg.creators.map(({ passkeys, unowned: _, ...c }) => ({ ...c, passkeys: passkeys.map(({ id, device, created, revoked }) => ({ id, device, created, revoked })) })));
      } else if (!identity) {
        // A creator revokes only the creators they handed the right to; any other id is not found.
        const signed = this.creatorOf(req, reg); if (!signed) fail(401, "作成者としてサインインしてください");
        const v = z.object({ creator: z.string(), confirm: z.literal(true) }).strict().parse(input);
        const c = reg.creators.find(c => c.id === v.creator && c.delegatedBy === signed.creator.id && c.revoked === null); if (!c) fail(404, "作成者が見つかりません");
        c.revoked = now; await this.keys.remove(c.id);
        reg.enrollments = reg.enrollments.filter(e => e.creatorId !== c.id && e.by !== c.id);
        response = Response.json({ ok: true });
      } else {
        const v = z.object({ creator: z.string().optional(), passkey: z.string().optional(), confirm: z.literal(true) }).strict().parse(input);
        if (v.creator) { const c = reg.creators.find(c => c.id === v.creator); if (!c) fail(404, "作成者が見つかりません"); c.revoked ??= now; await this.keys.remove(c.id); }
        else if (v.passkey) {
          // A lost device's passkey takes the device and delegation links its creator has not used yet with it: they may have been asked for from it.
          const holder = reg.creators.find(c => c.passkeys.some(p => p.id === v.passkey)), p = holder?.passkeys.find(p => p.id === v.passkey); if (!holder || !p) fail(404, "パスキーが見つかりません");
          p.revoked ??= now; reg.enrollments = reg.enrollments.filter(e => e.creatorId !== holder.id && e.by !== holder.id);
        }
        else fail(400, "失効する作成者かパスキーを指定してください");
        const live = (id: string) => reg.creators.some(c => c.id === id && c.revoked === null);
        reg.enrollments = reg.enrollments.filter(e => (!e.creatorId || live(e.creatorId)) && (!e.by || live(e.by)));
        response = Response.json({ ok: true });
      }
      if (await this.saveRegistry(row, reg)) return response;
    }
    return fail(409, "同時更新がありました。再試行してください");
  }
  refusal(c: Capsule, updated: Envelope) { return this.kit(c).refusal(c.spec, updated, this.clock()); }
  // Applies a Spec that passed its rules. Undo does not pass the page rule: going back drops a page the revise added.
  respec(c: Capsule, updated: Envelope) {
    const before = +new Date(c.spec.lifecycle.purgeAt), after = +new Date(updated.lifecycle.purgeAt);
    // Invites that lasted for the whole trip follow the new deadline; bound browsers must not be locked out by an extension.
    c.grants.forEach(g => { g.expires = g.expires >= before ? after : Math.min(g.expires, after); g.claimBy = Math.min(g.claimBy, g.expires); c.sessions.forEach(s => { if (s.grantId === g.id) s.expires = g.expires; }); });
    // A sealed Spec is fingerprinted as kept, ciphertext and all, so a new title still gives a new hash (spec「5.2 暗号化するもの・平文に残すもの」).
    Object.assign(c, { spec: updated, hash: createHash("sha256").update(JSON.stringify(updated)).digest("hex") });
  }
  // Revising and going back, which a kind may not have.
  revising(c: Capsule) { return this.kit(c).revise ?? fail(404, "この種類では使えません"); }
  // A chat's answer to "revise this", against the plain capsule as it stands.
  revision(c: Capsule, text: string, author: string, keepSpec = false) {
    plain(c);
    const now = this.clock(), r = this.revising(c).revise(c, text, { author, at: new Date(now).toISOString(), now, keepSpec });
    if (!r.ok && r.tooLong) fail(413, "貼り付けが長すぎます。旅程の部分だけを貼ってください");
    return r;
  }
  // The next sealed capsule a member's browser made by revising (`undo`: going back), as its kit checks it (docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」).
  // `keepSpec`: an editor's, which keeps the settings. A new post is this member's.
  resealed(c: Capsule, member: Session, input: unknown, how: { undo: boolean; keepSpec: boolean }) {
    const next = this.revising(c).resealed(c, input, how, { seat: member.id, now: this.clock() });
    if (next.spec.lifecycle.purgeAt !== c.spec.lifecycle.purgeAt) this.verified(member);  // only a change that moves the deadline is an important action
    return next;
  }
  match(req: Request, c: Capsule) { if (req.headers.get("if-match") !== `"${c.document.revision}"`) fail(409, "別の人が更新しました。再読込して内容を確認し、もう一度操作してください"); }
  // One line per refused request, for the operator to look back on (#608). Only the capsule id, the action and a reason code that
  // is a fixed string in this file, and the address the request was counted under (which API Gateway's own log cannot show, #609): never a cookie, an invite secret, a body, a title or an exception message.
  log: (line: { capsule?: string; action: string; method: string; status: number; reason: string; ip: string }) => void = () => {};
  async fetch(req: Request) {
    let response: Response, reason = "";
    try { response = await this.route(req); } catch (err) {
      reason = err instanceof Refused ? (err instanceof Fault ? err.reason : undefined) ?? err.message : err instanceof z.ZodError ? "invalid" : err instanceof Error ? err.name : "unknown";
      response = Response.json({ error: err instanceof Refused ? err.message : err instanceof z.ZodError ? "入力内容を確認してください" : "処理に失敗しました。再試行してください", ...err instanceof Fault && err.seat ? { seat: err.seat } : {} }, { status: err instanceof Refused ? err.status : err instanceof z.ZodError ? 400 : 500 });
    }
    if (response.status >= 400) {
      const path = new URL(req.url).pathname, m = /^\/v1\/c\/([a-f0-9]{32})(?:\/(.*))?$/.exec(path);
      try { this.log({ ...(m ? { capsule: m[1] } : {}), action: (m ? m[2] ?? "" : path.replace(/^\/v1\//, "")).slice(0, 64), method: req.method, status: response.status, reason: reason || "response", ip: req.headers.get("cf-connecting-ip") ?? "unknown" }); } catch {}
    }
    return secure(response, this.env.CAPSULE_ORIGIN);
  }
  async route(req: Request): Promise<Response> {
    const stage: Stage = { prefix: "", blob: "", names: [], done: false };
    try { return await this.routing(req, stage); }
    finally { for (const name of stage.names) try { await this.env.MEDIA?.remove(stage.prefix, name); } catch { /* what is left goes with the trip's purge */ } }
  }
  async routing(req: Request, stage: Stage): Promise<Response> {
    const url = new URL(req.url), now = this.clock();
    if (url.origin !== this.env.CAPSULE_ORIGIN) fail(403, "ホスト名が一致しません");
    // The operator's switch (#610): a named action answers 503 and the rest keeps working. The name is the first path segment after
    // /v1/ (after /v1/c/<id>/ for a capsule); the view itself (GET /v1/c/<id>) has none and cannot be stopped. An IAM publisher
    // invoke goes through this route too, so it stops the same way.
    const stopName = /^\/v1\/(?:c\/[a-f0-9]{32}\/?)?([^/]*)/.exec(url.pathname)?.[1];
    if (stopName && this.env.CAPSULE_DISABLED_ACTIONS?.split(",").filter(Boolean).includes(stopName)) fail(503, "この操作は一時的に停止しています。時間をおいて再試行してください");
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    // A page of photos reads hundreds of images at once, so these are counted apart, at a higher count, and leave the rest of the
    // API its own.
    const picture = req.method === "GET" && /^\/v1\/c\/[a-f0-9]{32}\/media\/[a-f0-9]{32}\/(thumb|display)$/.test(url.pathname);
    await this.rate(picture ? `ip-media:${ip}` : `ip:${ip}`, picture ? 1200 : 300);
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.get("origin") !== this.env.CAPSULE_ORIGIN) fail(403, "別のサイトからの操作は許可されていません");
    const identity = await this.publisherIdentity(req);
    // A creator may make a new trip and nothing more: the cookie is read on these four paths only, and never opens a capsule.
    const registry = (["/v1/account", "/v1/account/key", "/v1/recipe", "/v1/check", "/v1/publish"].includes(url.pathname) || /^\/v1\/assist(\/[a-f0-9]{32})?$/.test(url.pathname)) && req.headers.get("cookie")?.includes("capsule_creator=") ? (await this.registry()).reg : undefined;
    const signed = registry && this.creatorOf(req, registry);
    const creator = signed?.creator;
    // The one who holds the API key: the signed-in creator, or the issuer's identity. Whether a key is registered is all
    // that is ever answered; the key itself is never returned.
    const keyHolder = creator?.id ?? identity;
    if (url.pathname === "/v1/account" && req.method === "GET") return Response.json({ signedIn: false, canCreate: Boolean(creator), creator: creator ? { label: creator.label, delegated: Boolean(creator.delegatedBy), delegates: registry!.creators.filter(c => c.delegatedBy === creator.id && c.revoked === null).map(c => ({ id: c.id, label: c.label, created: c.created, device: c.passkeys[0]?.device ?? "" })) } : null, localOnly: false, assistKey: keyHolder ? await this.keys.get(keyHolder) !== null : false });
    if (url.pathname === "/v1/account/key") {
      if (!keyHolder) fail(401, "作成者としてサインインしてください");
      if (req.method === "PUT") {
        const v = z.object({ key: z.string().min(20).max(256).regex(/^sk-ant-/) }).strict().parse(await this.json(req));
        if (signed) this.recentCreator(signed);
        await this.rate(`key:${keyHolder}`, 5);
        let accepted: boolean;
        try { accepted = await (this.env.VERIFY_KEY ?? anthropicAccepts)(v.key); } catch { fail(502, "Anthropic に接続できませんでした。時間をおいて再試行してください"); }
        if (!accepted) fail(400, "この API キーは使えません。Anthropic Console で発行した鍵を貼ってください");
        // The creator may have been revoked while Anthropic was answering: a key is not put back after the revocation took it.
        if (creator && !this.creatorOf(req, (await this.registry()).reg)?.creator) fail(401, "作成者としてサインインしてください");
        await this.keys.put(keyHolder, seal(this.env.CAPSULE_HMAC_KEY, keyHolder, v.key));
        return new Response(null, { status: 204 });
      }
      if (req.method === "DELETE") { if (signed) this.recentCreator(signed); await this.keys.remove(keyHolder); return new Response(null, { status: 204 }); }
    }
    // Both of these are pure: no capsule, nothing written. A creator is holding their phone and their chat assistant's
    // answer, and needs to know what to paste and what is wrong with what came back. Nobody else is shown how to make a trip.
    if (["/v1/recipe", "/v1/check"].includes(url.pathname) && !identity && !creator) fail(401, "作成者としてサインインしてください");
    if (url.pathname === "/v1/recipe" && req.method === "GET") return Response.json({ kind: this.made.kind, text: this.made.recipe.text });
    if (url.pathname === "/v1/check" && req.method === "POST") {
      const v = z.object({ text: z.string() }).strict().parse(await this.json(req));
      if (Buffer.byteLength(v.text) > PASTE_LIMIT) fail(413, "貼り付けが長すぎます。旅程の部分だけを貼ってください");
      return Response.json(this.made.judge(v.text, now));
    }
    const assist = /^\/v1\/assist(?:\/([a-f0-9]{32}))?$/.exec(url.pathname);
    if (assist && !assist[1] && req.method === "POST") {
      if (!keyHolder) fail(401, "作成者としてサインインしてください");
      const v = z.object({ text: z.string().min(1) }).strict().parse(await this.json(req));
      if (!await this.keys.get(keyHolder)) fail(412, "Anthropic の API キーを登録してください");
      if (Buffer.byteLength(v.text) > ASSIST_LIMIT) fail(413, "希望が長すぎます。6,000バイト（日本語で約2,000文字）までにしてください");
      const id = await this.beginAssist(keyHolder, { subject: keyHolder, text: `${todayLine(localDay(now, "Asia/Tokyo"))}${v.text}`, system: this.made.recipe.generate }, `assist:${keyHolder}`);
      // The generation has started, so a failure to mark the key as used only shortens its life: it is logged, not answered.
      try { await this.keys.touch(keyHolder, now); } catch { this.log({ action: "assist", method: "POST", status: 500, reason: "touch:keys", ip }); }
      return Response.json({ id }, { status: 202 });
    }
    if (assist?.[1] && req.method === "GET") {
      if (!keyHolder) fail(401, "作成者としてサインインしてください");
      const row = await this.store.get(this.digest(`assist:${assist[1]}`));
      const job = row?.payload && row.purge_at > now ? JSON.parse(row.payload) as AssistJob : undefined;
      if (!job || job.who !== this.digest(keyHolder)) fail(404, "生成が見つかりません");
      if (job.state === "done") return Response.json({ state: "done", result: job.result });
      if (job.state === "failed" || job.deadline <= now) return Response.json({ state: "failed", message: job.message ?? ASSIST_FAILED });
      return Response.json({ state: "running" });
    }

    // The operator (the IAM publisher) sees every live capsule by its counts and dates only: never its title, plan or members' names.
    if (url.pathname === "/v1/capsules/list" && req.method === "POST") {
      if (!identity) fail(401, "旅行の発行権限が必要です");
      z.object({}).strict().parse(await this.json(req));
      const listed = [];
      for (const key of await this.store.list(now)) {
        const row = key === this.digest("creators") ? null : await this.store.get(key);
        if (!row?.payload || row.purge_at <= now) continue;
        const c = JSON.parse(row.payload) as Capsule;
        if (!c.spec) continue;  // a job or a slot of the generation (assist), not a capsule
        listed.push({ id: c.id ?? null, kind: c.spec.kind, state: kitOf(c.spec, this.kits)?.stateOf(c.spec, c.forced, now) ?? null, created: c.created, updated: c.updated, purgeAt: c.spec.lifecycle.purgeAt, grants: c.grants.filter(g => g.revoked === null && g.expires > now).length, members: c.sessions.filter(s => s.expires > now).length, sealed: Boolean(c.sealed), mustSeal: this.mustSeal(c) });
      }
      return Response.json(listed.sort((a, b) => a.created - b.created));
    }
    const creators = /^\/v1\/creators\/(enroll|challenge|register|session|signout|list|revoke|trips)$/.exec(url.pathname);
    if (creators && req.method === "POST") return this.creators(req, creators[1]!, identity, ip);
    if (url.pathname === "/v1/publish" && req.method === "POST") {
      // Limits are per creator (10 kept, 5 a minute), the same as for the IAM publisher. The response's owner link is how
      // the creator's browser takes the owner seat; the creator's cookie itself never reads the trip.
      const publisher = identity ?? (creator && `creator:${creator.id}`);
      if (!publisher) fail(401, "旅行の発行権限が必要です");
      const ownerKey = this.digest(`owner:${publisher}`);
      await this.rate(`create:${ownerKey}`, 5);
      const b = z.object({ confirm: z.literal(true), spec: z.unknown(), document: z.unknown(), operationId: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict().parse(await this.json(req));
      const kit = kitOf(b.spec, this.kits) ?? fail(400, "対応していない種類です");
      // After the line nothing new is used plain, and a kind with no sealed form could never be moved to it (mustSeal).
      if (!kit.sealed && this.sealedFrom !== undefined && now >= this.sealedFrom) fail(400, "この種類は、この Host では発行できません");
      const data = kit.publish(b.spec, b.document, now);
      if (+new Date(data.spec.lifecycle.purgeAt) <= now) fail(400, "未来の期限を指定してください");
      // A publisher that lost the response retries with the same operation id. The capsule id is derived from it, so the
      // retry lands on the same row and the store's "this key already exists" becomes the idempotency check: no index,
      // no lookup endpoint, and nothing extra to keep in step.
      const id = b.operationId ? this.digest(`op:${publisher}:${b.operationId}`).slice(0, 32) : uid();
      // The fingerprint of what was published (src/validate.ts publishHash, the hash a publisher approves).
      const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
      const c: Capsule = { id, ...data, created: now, updated: new Date(now).toISOString(), forced: null, hash: createHash("sha256").update(JSON.stringify(data.spec)).digest("hex"), ...(b.operationId ? { publishHash: fingerprint } : {}), grants: [], sessions: [], audit: [{ event: "publish", at: now }] };
      const link = this.issue(c, id, "owner", "自分用", +new Date(data.spec.lifecycle.purgeAt));
      // Stamped with the capsule's own time: a retry recognises the invite the publish made by it (see the replay below).
      c.grants[0]!.created = now;
      const serialized = JSON.stringify(c);
      // Sealing makes a trip about 4/3 as large: one of this size still fits the capsule's 1,900,000 bytes once moved (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」).
      if (Buffer.byteLength(serialized) > 1_200_000) fail(413, "旅程が大きすぎます。予定や投稿を減らしてください");
      // A creator's trip is named in their registry entry before it exists, so a trip is never left that its creator cannot find
      // again. A name whose trip never came is dropped when the list is read.
      if (!identity) await this.unowned(creator!.id, ids => [...ids.filter(x => x !== id), id].slice(-20));
      const saved = await this.store.create(this.digest(id), serialized, +new Date(c.spec.lifecycle.purgeAt), ownerKey, now);
      if (saved.meta.changes !== 1) {
        const existing = b.operationId ? await this.store.get(this.digest(id)) : null;
        if (!existing) {
          if (!identity) try { await this.unowned(creator!.id, ids => ids.filter(x => x !== id)); } catch { /* bounded by the list's 20 */ }
          fail(429, "同時に保持できる旅行は10件までです");
        }
        if (!existing.payload || existing.purge_at <= now) fail(410, "この操作IDで発行した旅行は削除されています");
        const prior = JSON.parse(existing.payload) as Capsule;
        if (prior.publishHash !== fingerprint) fail(409, "同じ操作IDで別の内容は発行できません");
        // The earlier attempt did succeed. Its owner link cannot be shown again (only the secret's digest is stored), so the
        // retry gets what the lost answer held and no more: while the invite the publish made is unredeemed and inside its claim
        // window, it is swapped for a fresh one closing at the same time. That invite is the one stamped with the publish's time
        // (a swap keeps the stamp; /recover's invite has its own), so a retry never takes over a recovered invite. Once the seat is held,
        // nothing. A creator has no /recover (it would seat them in any trip whose id they know); the IAM publisher does.
        const owner = prior.grants.find(g => g.role === "owner" && g.revoked === null && g.claimed === 0 && g.created === prior.created);
        if (owner && owner.claimBy > now) {
          prior.grants = prior.grants.filter(g => g !== owner);
          const fresh = this.issue(prior, id, "owner", "自分用", owner.expires, 1, owner.claimBy); prior.grants.at(-1)!.created = owner.created;
          prior.audit.push({ event: "replay", role: "owner", by: identity ? "発行者" : "作成者", at: now }); prior.audit = prior.audit.slice(-2000);
          if (!await this.store.save(existing, JSON.stringify(prior), existing.purge_at, now)) fail(409, "同時更新がありました。再試行してください");
          return Response.json({ id, hash: c.hash, replayed: true, ...fresh });
        }
        return Response.json({ id, hash: c.hash, replayed: true });
      }
      return Response.json({ id, hash: c.hash, ...link }, { status: 201 });
    }
    const match = /^\/v1\/c\/([a-f0-9]{32})(?:\/(.*))?$/.exec(url.pathname);
    if (!match) fail(404, "ページが見つかりません");
    const id = match[1]!, action = match[2] ?? "", write = !['GET', 'HEAD'].includes(req.method);
    if (action === "creators/register" && req.method === "POST") return this.creators(req, "register", null, ip, id);
    if (["sessions", "passkey/challenge", "passkey/session", "passkey/verify"].includes(action)) await this.rate(`login:${ip}`, 15);
    const input = write ? await this.json(req) : undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this.store.get(this.digest(id));
      if (!row) fail(404, "カプセルが見つかりません");
      if (!row.payload || row.purge_at <= this.clock()) fail(410, "この旅のカプセルは削除されました");
      const c = JSON.parse(row.payload) as Capsule, before = c.sessions;
      c.id ??= id;
      // A seat whose invite ended before the trip's deletion goes here; one that held the key is recorded, and saved even on a read.
      const ended = c.sessions.filter(s => s.expires <= this.clock()), expired = this.depart(c, ended, "expired"); this.leave(c, ended);
      c.sessions = c.sessions.filter(s => s.expires > this.clock());
      const kit = this.kit(c), state = kit.stateOf(c.spec, c.forced, this.clock());
      if (state === "purged") fail(410, "この旅のカプセルは期限を過ぎました");
      let response: Response, erase = false, entry: Omit<Audit, "at"> = { event: action };
      // A history line names the invite and the members by id in a sealed trip, by name in a plain one.
      const named = (ids: Pick<Audit, "grant" | "seat" | "member">, names: Pick<Audit, "label" | "by">) => c.sealed ? ids : names;
      if (action === "sessions" && req.method === "POST") {
        const v = z.object({ secret: z.string().min(32).max(100) }).strict().parse(input);
        const digest = this.digest(v.secret), grant = c.grants.find(g => timingSafeEqual(Buffer.from(g.digest, "hex"), Buffer.from(digest, "hex")));
        if (!grant || grant.revoked !== null || grant.expires <= this.clock()) fail(401, "招待リンクが無効か期限切れです");
        // Re-opening the link in the browser that already redeemed it is not a new seat.
        const held = this.cookie(req, id), existing = held && c.sessions.find(s => s.grantId === grant.id && s.digest === this.digest(held) && !this.idle(s));
        if (existing) return Response.json({ role: grant.role }, { headers: { "Set-Cookie": this.setCookie(id, held!, existing.expires) } });
        if (grant.claimBy <= this.clock()) fail(401, "この招待リンクは受付期限を過ぎました。オーナーに新しいリンクを依頼してください");
        if (grant.claimed >= grant.seats) fail(401, "この招待リンクは定員に達しました。オーナーに新しいリンクを依頼してください");
        const countries = this.env.CAPSULE_CLAIM_COUNTRIES?.split(",").filter(Boolean);
        if (countries?.length && !countries.includes(req.headers.get("cloudfront-viewer-country") ?? "")) fail(403, "この地域からは参加登録できません");
        const secret = token(); grant.claimed++; grant.lastUsed = this.clock(); c.joined = (c.joined ?? 0) + 1; if (grant.role === "owner") c.ownedAt ??= this.clock();
        c.sessions.push({ id: uid(), digest: this.digest(secret), grantId: grant.id, expires: grant.expires, label: grant.role === "owner" ? "オーナー" : `メンバー${c.joined}`, device: deviceLabel(req.headers.get("user-agent")), created: this.clock(), lastUsed: this.clock(), seen: this.clock() });
        const seat = c.sessions.at(-1)!; entry = { event: "sessions", role: grant.role, ...named({ grant: grant.id, seat: seat.id }, { label: grant.label, by: seat.label }), device: seat.device };
        // An invite the owner approves holds its member out of the trip until then. The seat is consumed now and stays so if refused.
        // The code is for matching by another route (not a secret): only this browser and the owner ever see it.
        if (grant.approval === "owner" && grant.role !== "owner") { seat.pending = true; seat.code = String(randomInt(1000000)).padStart(6, "0"); }
        response = Response.json(seat.pending ? { role: grant.role, pending: true, code: seat.code } : { role: grant.role }, { headers: { "Set-Cookie": this.setCookie(id, secret, grant.expires) } });
      } else if (action === "passkey/challenge" && req.method === "POST") {
        // No cookie is required: the browser that lost its is the one that needs to come back. It writes nothing either,
        // so anyone holding the capsule id can only spend their own rate limit, not churn the capsule or its audit trail.
        z.object({}).strict().parse(input);
        return Response.json({ challenge: this.passkeyChallenge(id), rpId: rpIdOf(this.env.CAPSULE_ORIGIN) });
      } else if (action === "passkey/session" && req.method === "POST") {
        // A browser that lost its cookie returns to the seat it already holds. The member's cookie secret is replaced, not added:
        // no seat is consumed, the role is the same, and the browser that held the old cookie is signed out (one member, one browser).
        // Not limited by claim country: this is access after redemption, and the trip may be abroad.
        const v = z.object({ challenge: encoded, id: encoded, clientDataJSON: encoded, authenticatorData: encoded, signature: encoded }).strict().parse(input);
        const used = this.passkeyChallengeOf(c, id, v.challenge), member = c.sessions.find(s => s.passkey?.id === v.id), grant = member && c.grants.find(g => g.id === member.grantId);
        let counter: number | undefined;
        if (used && member?.passkey && grant && grant.revoked === null && grant.expires > this.clock()) try { counter = verifyAssertion(v, { challenge: v.challenge, origin: this.env.CAPSULE_ORIGIN, rpId: rpIdOf(this.env.CAPSULE_ORIGIN) }, member.passkey); } catch { /* refused below */ }
        // One answer for every refusal, the same as an expired cookie gets: it must not reveal whether a passkey exists. A refusal writes nothing.
        if (counter === undefined || !used || !member?.passkey || !grant) fail(401, "この端末の登録は失効したか、期限が切れました");
        const secret = token(); member.passkey.counter = counter; member.digest = this.digest(secret); member.device = deviceLabel(req.headers.get("user-agent")); member.lastUsed = grant.lastUsed = member.seen = this.clock();
        this.record(c, used);
        response = Response.json({ role: grant.role }, { headers: { "Set-Cookie": this.setCookie(id, secret, member.expires) } });
      } else if (action === "recover" && req.method === "POST") {
        // Owner lost the bound browser: the IAM-authorized publisher replaces every owner invite. Trip content stays unreadable to it.
        // A creator cannot: this would hand them an owner seat in any trip whose id they know.
        if (!identity) fail(401, "旅行の発行権限が必要です");
        z.object({ confirm: z.literal(true) }).strict().parse(input);
        c.grants.forEach(g => { if (g.role === "owner") g.revoked = this.clock(); }); entry = { event: "recover", role: "owner", by: "発行者" };
        this.depart(c, c.sessions.filter(s => c.grants.some(g => g.id === s.grantId && g.role === "owner")), "owner");
        response = Response.json(this.issue(c, id, "owner", "自分用", +new Date(c.spec.lifecycle.purgeAt)), { status: 201 });
      } else if (action === "terminate" && req.method === "POST") {
        // The operator ends a trip at once, stored the way an owner's purge is. The id typed again is checked here as well as by the CLI.
        if (!identity) fail(401, "旅行の発行権限が必要です");
        z.object({ id: z.literal(id), confirm: z.literal(true) }).strict().parse(input);
        response = Response.json({ ok: true }); erase = true;
      } else {
        const { grant, member, secret: held } = this.session(req, c, id);
        // Counted only after authentication: counting before lets anyone who knows the id lock every member out (#609).
        // A page of photos reads a few hundred images at once, which the two counters below would refuse: an image read is counted by seat.
        if (req.method === "GET" && /^media\/[a-f0-9]{32}\/(thumb|display)$/.test(action)) await this.rate(`mediaread:${member.id}`, 600);
        else { await this.rate(`capsule:${id}`, 600); await this.rate(`grant:${grant.id}`, 120); }
        const editor = grant.role === "owner" || grant.role === "editor";
        const owner = () => { if (grant.role !== "owner") fail(403, "オーナーのみ操作できます"); };
        // Hands out invites (canIssue); changes only those it handed out, unless it is the owner.
        const issuer = () => { if (!canIssue[grant.role].length) fail(403, "オーナー・編集者のみ操作できます"); };
        const mine = (g: Grant | undefined) => grant.role === "owner" || g?.issuedBy === member.id;
        // Revising with a chat is for those who edit the plan by hand; an editor's leaves the settings as they are.
        const reviser = () => { if (!editor) fail(403, "オーナー・編集者のみ操作できます"); return grant.role !== "owner"; };
        // Every member reads every photo's record; which seat uploaded it is told only as whether it was this one.
        const shown = () => (c.media ?? []).map(({ contributor, blob, ...p }) => ({ ...p, mine: contributor === member.id }));
        const media = () => this.env.MEDIA ?? fail(503, "写真の保存先がありません");
        // Until the owner approves, nothing but the code that member shows the owner is given out.
        if (member.pending) { if (action === "" && req.method === "GET") return Response.json({ error: "オーナーの承認待ちです。画面のコードをオーナーに伝えてください", pending: true, code: member.code }, { status: 403 }); fail(403, "オーナーの承認待ちです"); }
        if (action === "theme.css" && req.method === "GET") return new Response(`:root{--accent:${kit.accent(c.spec)}}`, { headers: { "Content-Type": "text/css" } });
        // The new screen marks its requests (ui=2). An older one cannot draw ciphertext, nor move a trip that must be moved: it is
        // asked to reload. A plain trip published before the line works with it as before (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」).
        if ((c.sealed || this.mustSeal(c)) && url.searchParams.get("ui") !== "2") throw new Fault(409, "画面を更新してください", "stale-ui");
        if (this.mustSeal(c) && !(grant.role === "owner" && (req.method === "GET" ? ["", "grants", "seal"] : ["keys", "passkey", "passkey/verify", "signout", "seal", "purge"]).includes(action))) throw new Fault(409, "オーナーがこの旅行を移すまで開けません", "unsealed");
        // An image, as the browser sealed it, for any seat of the trip: the answer is not the page's to cache for long, and not shared.
        const image = /^media\/([a-f0-9]{32})\/(thumb|display)$/.exec(action);
        if (image && req.method === "GET") {
          const photo = c.media?.find(p => p.id === image[1]), bytes = photo ? await media().get(row.key, `${photo.blob}.${image[2]}`) : null;
          if (!bytes) fail(404, "写真が見つかりません");
          return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=3600" } });
        }
        if (action === "grants" && req.method === "GET") {
          issuer(); const label = (sid: string) => c.sessions.find(s => s.id === sid)?.label ?? "（失効したメンバー）";
          return Response.json(c.grants.filter(mine).map(({ digest, issuedBy, ...safe }) => ({ ...safe, issuedBy: issuedBy ? { id: issuedBy, label: label(issuedBy) } : null, members: c.sessions.filter(s => s.grantId === safe.id).map(({ digest, passkey, privateKey, seatKey, handoff, assistKey, assistWrapped, ...m }) => ({ ...m, passkey: Boolean(passkey), publicKey: seatKey ? { x25519: seatKey.x25519, ed25519: seatKey.ed25519 } : null, self: m.id === member.id })) })));
        }
        // Newest first. The record is not written to by reading it, as with GET grants.
        if (action === "history" && req.method === "GET") { owner(); return Response.json(c.audit.filter(a => HISTORY.includes(a.event)).reverse().map(({ event, at, role, label, by, device, grant, seat, member }) => ({ event, at, role, label, by, device, grant, seat, member }))); }
        const exports = () => { plain(c); return kit.exports ?? fail(404, "この種類では使えません"); };
        if (action === "export" && req.method === "GET") {
          if (!editor) fail(403, "出力はオーナー・編集者のみです"); const out = exports();
          return new Response(new Uint8Array(await out.zip(id, c.spec, c.document, c.updated)), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${out.name(c.spec)}"` } });
        }
        // The same text as the ZIP's README.md, for every role: it holds no more than the document GET "" gives each of them.
        if (action === "export.md" && req.method === "GET") return Response.json({ text: exports().markdown(c.spec, c.document) });
        // The ZIP's index.html as one file, for every role, as export.md is.
        if (action === "export.html" && req.method === "GET") return Response.json({ text: exports().html(c.spec, c.document) });
        // The trip goes to a chat assistant outside the host, so only those who may take it out as a ZIP hand it out. Nothing is written.
        if (action === "revise" && req.method === "GET") { const keep = reviser(); plain(c); return Response.json({ text: this.revising(c).text(c.spec, c.document, keep) }); }
        // The step back of a plain trip, for the owner's browser to seal with the rest when it moves the trip (POST seal, spec「5.4 平文の旅行を移す」).
        // Apart from GET "", so that every read of the trip does not carry it.
        if (action === "seal" && req.method === "GET") { owner(); if (c.sealed) fail(409, "旅程はもう暗号化してあります"); if (!kit.sealed) fail(404, "この種類では使えません"); return Response.json({ previous: c.previous ?? null }); }
        if (action === "undo" && req.method === "GET") {
          // A sealed trip's step back is sealed: the browser opens it and makes the diff (docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」).
          if (c.sealed) { reviser(); this.revising(c); if (!c.previous) fail(404, "戻せる旅程がありません"); return Response.json({ previous: c.previous, revision: c.document.revision }); }
          const keep = reviser(); plain(c); const back = this.revising(c).undo(c, keep); return Response.json({ diff: back.diff, revision: c.document.revision });
        }
        if (action === "revise/check" && req.method === "POST") {
          const keep = reviser(); plain(c); if (state === "frozen") fail(403, "共有終了後は変更できません");
          const r = this.revision(c, z.object({ text: z.string() }).strict().parse(input).text, member.label, keep);
          return Response.json(r.ok ? { ok: true, diff: r.diff, revision: c.document.revision } : r);
        }
        // Revising on the host with this seat's own key (#658): the trip goes to Anthropic under the key of the one who asked, and
        // the answer comes back as text for the same revise/check as a pasted one. No other seat's or creator's key is ever opened.
        if (action === "revise/assist" && req.method === "POST") {
          const keep = reviser(); plain(c); if (state === "frozen") fail(403, "共有終了後は変更できません");
          const v = z.object({ instruction: z.string().max(2000).default("") }).strict().parse(input);
          if (!member.assistKey) fail(412, "Anthropic の API キーを登録してください");
          const { system, text } = this.revising(c).ask(c.spec, c.document, keep, v.instruction, this.clock());
          if (Buffer.byteLength(text) > REVISE_LIMIT) fail(413, "旅程が長すぎて、ここでは直せません。「チャットで直す」でコピーして使ってください");
          const subject = `${id}:${member.id}`;
          return Response.json({ id: await this.beginAssist(subject, { subject, text, system, kind: "revise", sealed: member.assistKey, capsule: id, seat: member.id }, `assist:${subject}`) }, { status: 202 });
        }
        const polled = /^revise\/assist\/([a-f0-9]{32})$/.exec(action);
        if (polled && req.method === "GET") {
          reviser();
          const row = await this.store.get(this.digest(`assist:${polled[1]}`));
          const job = row?.payload && row.purge_at > this.clock() ? JSON.parse(row.payload) as AssistJob : undefined;
          if (!job || job.who !== this.digest(`${id}:${member.id}`)) fail(404, "生成が見つかりません");
          if (job.state === "done") return Response.json({ state: "done", result: job.result });
          if (job.state === "failed" || job.deadline <= this.clock()) return Response.json({ state: "failed", message: job.message ?? ASSIST_FAILED });
          return Response.json({ state: "running" });
        }
        response = Response.json({ ok: true });
        // Every member reads every point; which seat left it is told only as whether it was this one.
        const footprints = () => (c.footprints ?? []).map(p => ({ id: p.id, at: p.at, ...("point" in p ? { point: p.point } : { lat: p.lat, lng: p.lng, accuracy: p.accuracy }), by: p.by, mine: p.seat === member.id, auto: Boolean(p.auto) }));
        // Only a seat that holds the key is told who waits for it; it is any role's to give, so it is not the grants list's.
        // A seat holds the key when it holds the present generation: one left out when the key was replaced waits again (spec「5.5 旅行の鍵を替える」).
        const generation = c.sealed?.generation ?? 1, holds = (s: Session) => s.seatKey?.generation === generation;
        const waiting = () => member.seatKey ? c.sessions.filter(s => !holds(s) && !s.pending && s.id !== member.id).map(s => ({ id: s.id, label: s.label, handoff: s.handoff ?? null })) : [];
        // The public values of every seat holding a key, for a browser to walk the edges (src/trip-keys.ts reachableSeats): told
        // only to a seat that holds one, as `waiting` is.
        const seats = () => c.sessions.filter(s => s.seatKey && !s.pending).map(s => ({ id: s.id, role: c.grants.find(g => g.id === s.grantId)?.role, x25519: s.seatKey!.x25519, ed25519: s.seatKey!.ed25519, edges: s.seatKey!.edges ?? [], ...s.seatKey!.since && { since: s.seatKey!.since } }));
        // Once the key is replaced, ciphertext of another generation is not written: a member who left holds the older key. One
        // without a generation is not of the trip's form, and is refused by the checks below (400).
        if (c.sealed && write && ["document", "spec", "footprints", "media", "members", "grants", "revise", "undo"].includes(action) && ciphers(input).some(v => /^v1\.\d+\./.test(v) && !v.startsWith(`v1.${c.sealed!.generation}.`))) throw new Fault(409, "旅行の鍵が替わりました。開き直してください", "generation");
        if (action === "" && req.method === "GET") {
          response = Response.json({ id, spec: c.spec, document: c.document, sealed: c.sealed ?? null, role: grant.role, state, hash: c.hash, passkey: Boolean(member.passkey), ...(c.sealed ? { assistKey: Boolean(member.assistWrapped), assistWrapped: member.assistWrapped ?? null, assistModel: this.env.CAPSULE_ASSIST_MODEL ?? ASSIST_MODEL, updated: c.updated, created: c.created, label: member.label } : { assistKey: Boolean(member.assistKey) }), self: { id: member.id, label: member.label }, private: c.private?.[member.id] ?? [], privateKey: member.privateKey?.wrapped ?? null, seatKey: member.seatKey ?? null, keyed: c.sessions.some(s => s.seatKey), handoff: member.handoff ?? null, rekey: grant.role === "owner" && c.sealed && c.departed?.length ? c.departed.some(d => d.why !== "owner") ? "auto" : "ask" : null, waiting: waiting(), seats: member.seatKey ? seats() : [], footprints: footprints(), media: shown(), photos: this.photosOn, mustSeal: this.mustSeal(c) }, { headers: { ETag: `"${c.document.revision}"`, "Set-Cookie": this.setCookie(id, held, member.expires) } });
          // Reading is what keeps a session alive, recorded at most once a day so that reading the trip stays free of writes.
          if (member.seen !== undefined && member.seen + SEEN_EVERY > this.clock() && !expired) return response;
          member.seen = this.clock();
        } else if (action === "signout" && req.method === "POST") {
          // This browser signs itself out: its cookie is replaced by one nobody holds. The seat and its passkey stay, so the
          // passkey brings it back; without one, the owner invites again.
          z.object({ confirm: z.literal(true) }).strict().parse(input); member.digest = this.digest(token());
          response = Response.json({ ok: true }, { headers: { "Set-Cookie": this.setCookie(id, "", this.clock()) } });
        } else if (action === "grants" && req.method === "POST") {
          issuer(); this.verified(member); if (state === "frozen") fail(403, "共有終了後はリンクを発行できません");
          const sealedInput = c.sealed ? sealedGrantInput.parse(input) : undefined, v = sealedInput ?? grantInput.parse(input), grantId = sealedInput?.id ?? uid();
          if (c.grants.some(g => g.id === grantId)) fail(400, "招待を確認してください");
          if (!canIssue[grant.role].includes(v.role)) fail(403, "この権限の招待は出せません");
          // Only the owner reads the codes, so only the owner asks for approval. A rotated invite keeps the one it replaces.
          if (v.approval === "owner" && grant.role !== "owner") fail(403, "承認つきの招待を出せるのはオーナーだけです");
          const approval = v.approval ?? (v.rotate ? c.grants.find(g => g.id === v.rotate)?.approval : undefined) ?? "auto";
          if (v.role === "owner" && approval === "owner") fail(400, "オーナー招待は承認を使えません");
          if (v.role === "owner" && v.seats !== 1) fail(400, "オーナー招待は1席です");
          if (v.rotate) {
            const old = c.grants.find(g => g.id === v.rotate); if (!old || old.role !== v.role) fail(400, "交換対象が一致しません"); if (!mine(old)) fail(403, "交換できるのはオーナーと、この招待を出した人だけです");
            // An owner seat handed over must not take the last copy of the trip key with it (spec「5.5 旅行の鍵を替える」).
            if (old.role === "owner" && c.sealed && !c.sessions.some(s => s.grantId !== old.id && !s.pending && s.seatKey?.generation === c.sealed!.generation)) throw new Fault(409, "鍵を持つメンバーが他にいないため、交換すると旅程をだれも読めなくなります。先に別の端末かメンバーに鍵を渡してください", "last-key");
            old.revoked = this.clock(); this.depart(c, c.sessions.filter(s => s.grantId === old.id), old.role === "owner" ? "owner" : "rotate"); c.sessions = c.sessions.filter(s => s.grantId !== old.id);
          }
          entry = { event: v.rotate ? "rotate" : "grants", role: v.role, ...named({ grant: grantId, seat: member.id }, { label: v.label, by: member.label }), device: member.device };
          response = Response.json(this.issue(c, id, v.role, v.label, +new Date(v.expiresAt), v.seats, this.clock() + v.claimDays * 86400000, member.id, approval, grantId), { status: 201 });
        } else if (action === "revoke" && req.method === "POST") {
          issuer(); this.verified(member); const v = z.object({ id: z.string().optional(), member: z.string().optional(), confirm: z.literal(true) }).strict().parse(input);
          if (v.member) {
            // The seat stays consumed: a leaked link must not become redeemable again by removing its member.
            const m = c.sessions.find(s => s.id === v.member); if (!m) fail(404, "メンバーが見つかりません");
            const of = c.grants.find(g => g.id === m.grantId), role = of?.role;
            if (!mine(of)) fail(403, "失効できるのはオーナーと、この招待を出した人だけです");
            if (role === "owner") fail(400, "オーナーは交換を使ってください"); this.depart(c, [m], "revoke"); c.sessions = c.sessions.filter(s => s !== m);
            entry = { event: "revoke-member", role, ...named({ grant: m.grantId, member: m.id, seat: member.id }, { label: m.label, by: member.label }), device: member.device };
          } else {
            const target = c.grants.find(g => g.id === v.id);
            if (!target) fail(404, "リンクが見つかりません"); if (!mine(target)) fail(403, "失効できるのはオーナーと、この招待を出した人だけです"); if (target.role === "owner") fail(400, "オーナーリンクは交換を使ってください"); target.revoked = this.clock(); this.depart(c, c.sessions.filter(s => s.grantId === target.id), "rotate"); c.sessions = c.sessions.filter(s => s.grantId !== target.id);
            entry = { event: "revoke", role: target.role, ...named({ grant: target.id, seat: member.id }, { label: target.label, by: member.label }), device: member.device };
          }
        } else if (action === "approve" && req.method === "POST") {
          // Lets a member in who redeemed an owner-approved invite, or turns them away. A refusal removes the member but not the seat.
          owner(); this.verified(member); const v = z.object({ member: z.string(), approve: z.boolean(), confirm: z.literal(true) }).strict().parse(input);
          const m = c.sessions.find(s => s.id === v.member && s.pending); if (!m) fail(404, "承認待ちのメンバーが見つかりません");
          if (v.approve) { delete m.pending; delete m.code; } else c.sessions = c.sessions.filter(s => s !== m);
          entry = { event: v.approve ? "approve" : "reject", role: c.grants.find(g => g.id === m.grantId)?.role, ...named({ grant: m.grantId, member: m.id, seat: member.id }, { label: m.label, by: member.label }), device: member.device };
        } else if (action === "passkey" && req.method === "POST") {
          // Optional: a member may add one passkey to their own seat. Replacing it needs `check`, an assertion by the one it replaces
          // in this same request (a check made for another action does not count), so a cookie alone cannot swap in another.
          // It lives on the Session, so revoking the member or the invite removes it.
          const assertion = z.object({ challenge: encoded, id: encoded, clientDataJSON: encoded, authenticatorData: encoded, signature: encoded }).strict();
          const v = z.object({ challenge: encoded, clientDataJSON: encoded, authenticatorData: encoded, publicKey: encoded, algorithm: z.number().int(), check: assertion.optional(), privateKey: sealed(200).optional() }).strict().parse(input);
          // A seat whose entries are sealed hands in the key rewrapped by the new passkey: replacing without it would leave every
          // entry unreadable, since the old passkey is gone (docs/ephemeral-trip-capsule.md「5.6 自分だけの予定・日記の鍵」).
          if (member.privateKey && !v.privateKey) fail(400, "自分だけのメモの鍵を包み直してください");
          if (!member.privateKey && v.privateKey) fail(400, "自分だけのメモの鍵がありません");
          let checked: ReturnType<typeof this.passkeyChallengeOf> = undefined;
          if (member.passkey) {
            let counter: number | undefined;
            checked = v.check && v.check.challenge !== v.challenge ? this.passkeyChallengeOf(c, id, v.check.challenge) : undefined;
            if (checked && v.check!.id === member.passkey.id) try { counter = verifyAssertion(v.check!, { challenge: v.check!.challenge, origin: this.env.CAPSULE_ORIGIN, rpId: rpIdOf(this.env.CAPSULE_ORIGIN) }, member.passkey); } catch { /* refused below */ }
            if (counter === undefined || !checked) fail(401, "パスキーで本人確認してください");
          }
          const used = this.passkeyChallengeOf(c, id, v.challenge);
          if (!used) fail(401, "もう一度やり直してください");
          let passkey: Passkey | undefined; try { passkey = verifyRegistration(v, { challenge: v.challenge, origin: this.env.CAPSULE_ORIGIN, rpId: rpIdOf(this.env.CAPSULE_ORIGIN) }, this.clock()); } catch { /* refused below */ }
          if (!passkey || c.sessions.some(s => s !== member && s.passkey?.id === passkey.id)) fail(400, "パスキーを登録できませんでした");
          // The first passkey of a seat counts as its check: from then on the cookie alone is not enough.
          if (checked) this.record(c, checked); else member.verifiedUntil = this.clock() + PASSKEY_WINDOW;
          this.record(c, used); member.passkey = passkey;
          if (v.privateKey) member.privateKey = { wrapped: v.privateKey, passkey: passkey.id };
          // What the old passkey's PRF wrapped no longer opens; the browser wraps again with the new one (PATCH keys).
          if (member.seatKey) delete member.seatKey.secret;
        } else if (action === "passkey/verify" && req.method === "POST") {
          // The member's own passkey, in this browser's session: the check is kept on the session, so it cannot be used by another
          // member or in another capsule. One answer for every refusal, and a refusal writes nothing.
          const v = z.object({ challenge: encoded, id: encoded, clientDataJSON: encoded, authenticatorData: encoded, signature: encoded }).strict().parse(input);
          const used = this.passkeyChallengeOf(c, id, v.challenge);
          let counter: number | undefined;
          if (used && member.passkey?.id === v.id) try { counter = verifyAssertion(v, { challenge: v.challenge, origin: this.env.CAPSULE_ORIGIN, rpId: rpIdOf(this.env.CAPSULE_ORIGIN) }, member.passkey); } catch { /* refused below */ }
          if (counter === undefined || !used || !member.passkey) fail(401, "本人確認できませんでした");
          member.passkey.counter = counter; this.record(c, used); member.verifiedUntil = this.clock() + PASSKEY_WINDOW;
        } else if (action === "private" && req.method === "PATCH") {
          // A member's own entries: any role, no If-Match and no new revision, since nobody else sees them change. Until sharing ends.
          // They fall on the capsule's days, so a kind without dates has none.
          const period = kit.period?.(c.spec) ?? fail(404, "この種類では使えません");
          if (state === "frozen") fail(403, "共有終了後は変更できません");
          const op = privateOperations.parse(input), mine = [...c.private?.[member.id] ?? []], at = new Date(this.clock()).toISOString();
          // Puts one entry in the seat's list: replaced if it was there, keeping when it was made. By day, then by time; an entry
          // without a time (a diary) after the day's timed ones, in the order it was written.
          const upsert = (list: PrivateEntry[], entry: z.infer<typeof privateEntry>) => {
            const { createdAt: _, updatedAt: __, ...e } = entry, was = list.find(x => x.id === e.id);
            if (e.day < period.startsOn || e.day > period.endsOn) fail(400, "旅行期間の日付を指定してください");
            const next = [...list.filter(x => x.id !== e.id), { ...e, createdAt: was?.createdAt ?? at, updatedAt: at }];
            const key = (x: PrivateEntry) => [x.day, x.startsAt ? new Date(x.startsAt).toISOString() : "~", x.createdAt].join(" ");
            return next.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
          };
          if (op.type === "key") {
            // Once per seat, by its own passkey checked just now; replacing the passkey rewraps it (POST passkey below).
            this.verified(member); if (!member.passkey) fail(400, "パスキーを登録してください");
            if (member.privateKey) fail(409, "自分だけのメモの鍵はもうあります");
            member.privateKey = { wrapped: op.wrapped, passkey: member.passkey.id };
          } else if (op.type === "put") {
            if (!member.privateKey) fail(400, "自分だけのメモの鍵がありません");
            const next = upsert(mine, op.entry);
            if (next.length > PRIVATE_ENTRIES) fail(400, `個人メモは${PRIVATE_ENTRIES}件までです`);
            c.private = { ...c.private, [member.id]: next };
          } else if (op.type === "apply") {
            if (!member.privateKey) fail(400, "自分だけのメモの鍵がありません");
            const named = [...op.put.map(e => e.id), ...op.remove];
            if (new Set(named).size !== named.length) fail(400, "同じ項目が2回あります");
            const next = op.put.reduce(upsert, mine.filter(x => !op.remove.includes(x.id)));
            if (next.length > PRIVATE_ENTRIES) fail(400, `個人メモは${PRIVATE_ENTRIES}件までです`);
            c.private = { ...c.private, [member.id]: next };
          } else c.private = { ...c.private, [member.id]: mine.filter(x => x.id !== op.id) };  // with no key too: a lost key leaves removing
          response = Response.json({ ok: true, private: c.private?.[member.id] ?? [] });
        } else if (action === "keys" && req.method === "PATCH") {
          // The seat's own keys (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」). Not a change to the plan, so no If-Match and no new revision, and
          // taken after sharing ends too: it is the key to read with. The first key of a trip is the owner's, once; a seat that has
          // keys puts a new set only with its passkey checked just now, as a browser that took its seat key from the passkey does.
          const op = keysOperation.parse(input);
          if (op.type === "keep") {
            // The owner chose to keep the key after an owner seat was handed over: that question is not asked again. A seat
            // revoked or expired is still replaced.
            owner(); this.verified(member);
            c.departed = c.departed?.filter(d => d.why !== "owner"); if (!c.departed?.length) delete c.departed;
            response = Response.json({ ok: true });
          } else if (op.type !== "seat") {
            // The handoff (spec「5.1 旅行の鍵と受け渡し」). The host checks who may write what and that the values have the form of keys; the
            // commitment and the codes are the two screens' to check, so none is computed here.
            // The waiting seat takes back its own attempt (`abandon` with no seat, or its own); every other action names another seat.
            const self = op.type === "abandon" && (!op.seat || op.seat === member.id);
            const other = op.type === "wait" || op.type === "reveal" ? undefined : self ? member : c.sessions.find(s => s.id === op.seat);
            if (op.type !== "wait" && op.type !== "reveal" && (!other || (other.id === member.id && !self))) fail(404, "メンバーが見つかりません");
            if (op.type === "wait") {
              if (holds(member)) fail(409, "旅行の鍵はもうあります");
              if (!c.sessions.some(s => s.seatKey)) fail(409, "旅行の鍵がまだありません");
              member.handoff = { attempt: uid(), commitment: op.commitment };
            } else if (op.type === "reveal") {
              const h = member.handoff;
              if (!h || h.attempt !== op.attempt) fail(409, "やり直しになりました");
              if (!h.giver) fail(409, "渡すメンバーの値がまだありません");
              if (h.reveal) fail(409, "もう置いてあります");
              h.reveal = { x25519: op.x25519, ed25519: op.ed25519, nonce: op.nonce };
            } else if (op.type === "edge") {
              if (!member.seatKey || !other!.seatKey) fail(409, "鍵のある席どうしだけ結べます");
              const edges = (member.seatKey.edges ?? []).filter(e => e.seat !== op.seat);
              if (edges.length >= EDGES) fail(400, `辺は${EDGES}件までです`);
              member.seatKey.edges = [...edges, { seat: op.seat, signature: op.signature }];
            } else if (op.type === "give") {
              if (!holds(member)) fail(403, "旅行の鍵を持つメンバーだけが渡せます");
              const h = other!.handoff;
              if (holds(other!) || other!.pending) fail(409, "このメンバーは鍵を待っていません");
              if (!h || h.attempt !== op.attempt) fail(409, "相手がやり直しました");
              if (h.giver) fail(409, "ほかのメンバーが渡しています");
              h.giver = { seat: member.id, ephemeral: op.ephemeral, x25519: member.seatKey!.x25519, ed25519: member.seatKey!.ed25519 };
            } else if (op.type === "wrap") {
              const h = other!.handoff;
              if (!holds(member)) fail(403, "旅行の鍵を持つメンバーだけが渡せます");
              if (!h || h.attempt !== op.attempt || h.giver?.seat !== member.id) fail(409, "相手がやり直しました");
              if (!h.reveal) fail(409, "相手の値がまだありません");
              other!.seatKey = { x25519: h.reveal.x25519, ed25519: h.reveal.ed25519, generation: member.seatKey!.generation, wrapped: op.wrapped, ephemeral: h.giver.ephemeral };
              delete other!.handoff;
            } else {
              const h = other!.handoff;
              if (h && h.attempt === op.attempt && (other!.id === member.id || h.giver?.seat === member.id)) delete other!.handoff;
              else if (!h || h.attempt !== op.attempt) { /* already gone or already redone: nothing to take back */ }
              else fail(403, "この試みを取りやめられるのは、待っている人と渡している人だけです");
            }
            response = Response.json({ ok: true, seatKey: member.seatKey ?? null, handoff: member.handoff ?? null });
          } else {
          if (!member.seatKey) {
            owner();
            if (c.sessions.some(s => s.seatKey)) fail(409, "旅行の鍵はもうあります");
          } else if (!op.secret) fail(400, "席の秘密鍵の包みが要ります");
          // The first key is generation 1; a pair made again keeps the generation it holds.
          if (op.generation !== (member.seatKey?.generation ?? 1)) fail(400, "鍵の世代を確認してください");
          if (op.secret) { if (!member.passkey) fail(400, "パスキーを登録してください"); this.verified(member); }
          const { type: _, secret, ...pub } = op;
          member.seatKey = { ...pub, ...(secret && member.passkey ? { secret: { ...secret, passkey: member.passkey.id } } : {}) };
          delete member.handoff;
          response = Response.json({ ok: true, seatKey: member.seatKey });
          }
        } else if (action === "footprints" && req.method === "PATCH") {
          // As a member's own entries: no If-Match and no new revision. Left during the trip by all but a viewer; taken out by the
          // seat that left it, or by an owner or editor, until sharing ends.
          const op = c.sealed ? sealedFootprintOperations.parse(input) : footprintOperations.parse(input), list = c.footprints ?? [];
          if (op.type === "add") {
            if (grant.role === "viewer") fail(403, "閲覧者は足あとを残せません");
            const period = kit.period?.(c.spec) ?? fail(404, "この種類では使えません"), today = localDay(this.clock(), period.timezone);
            if (state !== "active" || today < period.startsOn || today > period.endsOn) fail(403, "足あとは旅行期間中だけ残せます");
            if (list.length >= FOOTPRINTS) fail(400, `足あとは1旅行${FOOTPRINTS}件までです`);
            // Measured from the seat's last point that is kept: removing one leaves the seat free to leave another at once.
            const last = list.filter(p => p.seat === member.id).at(-1);
            if (last && this.clock() - +new Date(last.at) < FOOTPRINT_EVERY) fail(429, "足あとは1分に1回までです");
            const at = new Date(this.clock()).toISOString(), auto = op.auto && { auto: true as const };
            if ("point" in op) {
              if (list.some(p => p.id === op.id)) fail(400, "足あとを確認してください");
              c.footprints = [...list, { id: op.id, seat: member.id, by: op.by, at, point: op.point, ...auto }];
            } else c.footprints = [...list, { id: uid(), seat: member.id, by: member.label, at, lat: op.lat, lng: op.lng, accuracy: op.accuracy, ...auto }];
          } else {
            if (state === "frozen") fail(403, "共有終了後は変更できません");
            const point = list.find(p => p.id === op.id); if (!point) fail(404, "足あとが見つかりません");
            if (point.seat !== member.id && !editor) fail(403, "自分の足あとだけ消せます");
            c.footprints = list.filter(p => p !== point);
          }
          response = Response.json({ ok: true, footprints: footprints() });
        } else if (action === "media" && req.method === "POST") {
          // A photo is sealed by the browser, so it only goes into a trip that has a key: no If-Match and no new revision, as with a
          // footprint. Left by all but a viewer, before and after the trip, until sharing ends.
          if (!this.photosOn) fail(403, "写真は今は使えません");
          if (!c.sealed) fail(409, "旅行を暗号化してから写真を上げてください");
          if (grant.role === "viewer") fail(403, "閲覧者は写真を上げられません");
          if (state === "frozen") fail(403, "共有終了後は変更できません");
          const v = photoInput.parse(input), list = c.media ?? [];
          if (list.length >= PHOTO_LIMITS.count) fail(413, `この旅行の写真は ${PHOTO_LIMITS.count} 枚までです`);
          if (list.some(p => p.id === v.id)) fail(409, "同じ写真がもう上がっています");
          const { images, ...record } = v, sealedImages = { display: Buffer.from(images.display, "base64"), thumb: Buffer.from(images.thumb, "base64") };
          if (sealedImages.display.length > PHOTO_LIMITS.displayBytes + SEALED_OVERHEAD) fail(413, tooLargeText(PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes));
          if (sealedImages.thumb.length > PHOTO_LIMITS.thumbBytes + SEALED_OVERHEAD) fail(413, tooLargeText(PHOTO_LIMITS.thumbEdge, PHOTO_LIMITS.thumbBytes));
          await this.rate(`media:${member.id}`, 60);
          // Put once, under a name of this upload's own, and kept by the record only when it is saved (a retry after losing the race
          // for the capsule finds them put already).
          if (!stage.done) {
            stage.prefix = row.key; stage.blob = uid();
            for (const size of ["display", "thumb"] as const) { stage.names.push(`${stage.blob}.${size}`); await media().put(row.key, `${stage.blob}.${size}`, sealedImages[size]); }
            stage.done = true;
          }
          c.media = [...list, { ...record, blob: stage.blob, contributor: member.id, uploadedAt: new Date(this.clock()).toISOString() } satisfies PhotoAsset];
          response = Response.json({ photo: shown().at(-1) }, { status: 201 });
        } else if (action === "media" && req.method === "PATCH") {
          // Taken out, linked or captioned by the seat that uploaded it, or by an owner or editor. A seat that is gone leaves its photos
          // with the trip. Like the photo itself, none of it moves the trip's revision.
          const v = photoOperations.parse(input), list = c.media ?? [], photo = list.find(p => p.id === v.id);
          if (state === "frozen") fail(403, "共有終了後は変更できません");
          if (!photo) fail(404, "写真が見つかりません");
          if (photo.contributor !== member.id && !editor) fail(403, v.type === "remove" ? "自分の写真だけ消せます" : "自分の写真だけ直せます");
          if (v.type === "remove") {
            await media().remove(row.key, `${photo.blob}.display`); await media().remove(row.key, `${photo.blob}.thumb`);
            c.media = list.filter(p => p !== photo);
            response = Response.json({ ok: true, media: shown() });
          } else {
            if (v.type === "link" && v.itemId !== null && !kit.hasItem?.(c.document, v.itemId)) fail(400, "予定が見つかりません");
            if (v.type === "link") { if (v.itemId === null) delete photo.itineraryItemId; else photo.itineraryItemId = v.itemId; }
            else if (v.caption === null) delete photo.caption; else photo.caption = v.caption;
            response = Response.json({ photo: shown().find(p => p.id === photo.id) });
          }
        } else if (action === "members" && req.method === "PATCH") {
          // A sealed trip's names arrive sealed against the seat (src/trip-keys.ts sealName).
          owner(); const v = z.object({ id: z.string(), label: c.sealed ? cipher(CIPHER.short) : author }).strict().parse(input), m = c.sessions.find(s => s.id === v.id);
          if (!m) fail(404, "メンバーが見つかりません"); m.label = v.label;
        } else if (action === "freeze" && req.method === "POST") {
          owner(); this.verified(member); z.object({ confirm: z.literal(true) }).strict().parse(input); this.match(req, c); c.forced = "frozen";
          c.grants.forEach(g => { if (g.role !== "owner") g.revoked = this.clock(); }); c.sessions = c.sessions.filter(s => c.grants.some(g => g.id === s.grantId && g.role === "owner"));
          entry = { event: "freeze", ...named({ seat: member.id }, { by: member.label }), device: member.device };
        } else if (action === "purge" && req.method === "POST") {
          owner(); this.verified(member); const v = z.object({ title: z.string() }).strict().parse(input);
          // A sealed trip's title is compared by the screen, which can read it (spec「5.3 暗号化した旅行で Host にできないこと」).
          if (!c.sealed && !sameTitle(v.title, c.spec.title)) fail(400, "確認用のタイトルが一致しません"); erase = true;
        } else if (action === "seal" && req.method === "POST") {
          // The owner's browser puts the trip back sealed under the trip's key, all at once (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」).
          // Only a seat holding that key's generation can have sealed it; the host checks the plain parts and the form, never the words.
          owner(); this.verified(member); if (state === "frozen") fail(403, "共有終了後は変更できません"); this.match(req, c);
          if (c.sealed) fail(409, "旅程はもう暗号化してあります");
          const sealing = kit.sealed ?? fail(404, "この種類では使えません");
          // Moving a plain trip (spec「5.4 平文の旅行を移す」): the same request also brings every footprint's point and `by`, and every member's and
          // invite's name, sealed by the browser (src/trip-keys.ts sealMove), so no plain word of the trip is left behind.
          const name = cipher(CIPHER.short);
          const v = z.object({ generation: z.number().int().min(1), spec: z.unknown(), document: z.unknown(), previous: sealing.previous.optional(),
            footprints: z.array(z.object({ id: z.string(), point: cipher(200), by: name }).strict()).default([]), members: z.record(z.string(), name).default({}), grants: z.record(z.string(), z.union([name, z.enum(["自分用", "招待リンク"])])).default({}), confirm: z.literal(true) }).strict().parse(input);
          if (!member.seatKey || member.seatKey.generation !== v.generation) fail(409, "旅行の鍵がありません");
          let sealed: { spec: Envelope; document: Versioned }; try { sealed = kit.validate(v.spec, v.document, c.created, true); } catch { fail(400, "旅程の形を確認してください"); }
          const refused = this.refusal(c, sealed.spec); if (refused) fail(400, refused);
          // What was read before sealing must be what is here now: a point, a seat or an invite added meanwhile would stay plain, and
          // one gone meanwhile (revoked, expired, refused) is read again too.
          const points = c.footprints ?? [], sent = new Map(v.footprints.map(p => [p.id, p]));
          if (sent.size !== v.footprints.length || sent.size !== points.length || points.some(p => !sent.has(p.id))) fail(409, "足あとが増えました。もう一度移してください");
          if (Object.keys(v.members).some(k => !c.sessions.some(s => s.id === k)) || Object.keys(v.grants).some(k => !c.grants.some(g => g.id === k))) fail(409, "メンバーが変わりました。もう一度移してください");
          if (c.sessions.some(s => !Object.hasOwn(v.members, s.id)) || c.grants.some(g => !Object.hasOwn(v.grants, g.id))) fail(409, "メンバーが増えました。もう一度移してください");
          const revision = c.document.revision + 1;
          this.respec(c, sealed.spec);
          if (c.footprints) c.footprints = points.map(({ id, seat, at, auto }) => ({ id, seat, at, ...auto && { auto }, point: sent.get(id)!.point, by: sent.get(id)!.by }));
          c.sessions.forEach(s => { s.label = v.members[s.id]!; }); c.grants.forEach(g => { g.label = v.grants[g.id]!; });
          // The history's lines before sealing name no invite or seat by id, so their names cannot be sealed against one (#712):
          // they go. 発行者 and 作成者 are not a member's.
          c.audit = c.audit.map(({ label: _label, by, ...a }) => ({ ...a, ...(by === "発行者" || by === "作成者") && { by } }));
          // A plain `previous` is not kept beside sealed words: the browser's sealed copy, or none.
          Object.assign(c, { sealed: { generation: v.generation }, document: { ...sealed.document, revision }, previous: v.previous });
          if (!v.previous) delete c.previous;
          // The host's revise is not used in a sealed trip, so the keys it kept for it go (the browser wraps its own, #692 回答 B).
          c.sessions.forEach(s => delete s.assistKey);
          response = Response.json({ revision });
        } else if (action === "rekey" && req.method === "POST") {
          // The owner's browser replaces the trip key with the next generation (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」): every ciphertext of the
          // trip sealed again, and the new key wrapped, with the owner seat's signature, to the seats it reached by the edges. The
          // host opens nothing: it checks the generation's mark, that the records are the ones it holds, and who is wrapped to.
          owner(); this.verified(member); if (state === "frozen") fail(403, "共有終了後は変更できません"); this.match(req, c);
          const sealing = kit.sealed ?? fail(404, "この種類では使えません");
          if (!c.sealed) fail(409, "旅程はまだ暗号化していません");
          if (member.seatKey?.generation !== c.sealed.generation) fail(409, "旅行の鍵がありません");
          const name = z.string().min(1).max(CIPHER.short);
          const v = z.object({ generation: z.number().int(), spec: z.unknown(), document: z.unknown(), footprints: z.array(z.object({ id: z.string(), point: cipher(200), by: cipher(CIPHER.short) }).strict()).max(FOOTPRINTS),
            media: z.array(z.object({ id: z.string(), key: cipher(200), location: cipher(300).optional(), caption: cipher(CIPHER.short).optional() }).strict()).max(PHOTO_LIMITS.count).default([]),
            members: z.array(z.object({ id: z.string(), label: name }).strict()).max(200), grants: z.array(z.object({ id: z.string(), label: name }).strict()).max(200),
            seats: z.array(z.object({ seat: seatId, wrapped: sealed(200), ephemeral: rawKey, signature }).strict()).min(1).max(200), confirm: z.literal(true) }).strict().parse(input);
          const generation = c.sealed.generation + 1;
          if (v.generation !== generation) fail(400, "鍵の世代を確認してください");
          let next: { spec: Envelope; document: Versioned }; try { next = kit.validate(v.spec, { ...(v.document as object), revision: c.document.revision }, c.created, true); } catch { fail(400, "旅程の形を確認してください"); }
          // A name the host gave (not ciphertext) stays as it is.
          const kept = (sent: string, now: string) => sent.startsWith("v1.") || sent === now;
          if (ciphers([next, v.footprints, v.media, v.members, v.grants]).some(x => !x.startsWith(`v1.${generation}.`)) || [...v.members.map(m => kept(m.label, c.sessions.find(s => s.id === m.id)?.label ?? "")), ...v.grants.map(g => kept(g.label, c.grants.find(x => x.id === g.id)?.label ?? ""))].includes(false)) fail(400, "鍵の世代を確認してください");
          // The trip as it stands, sealed again: the same footprints, photos, seats and invites, and the same records of the
          // kind's (`rekeyed`), a post keeping its seat and time. One changed meanwhile is read again.
          const ids = (list: Array<{ id: string }>) => list.map(x => x.id).sort().join("\n");
          if (ids(c.footprints ?? []) !== ids(v.footprints) || ids(c.media ?? []) !== ids(v.media) || (c.media ?? []).some(p => { const m = v.media.find(x => x.id === p.id)!; return Boolean(p.location) !== Boolean(m.location) || Boolean(p.caption) !== Boolean(m.caption); }) || ids(c.sessions) !== ids(v.members) || ids(c.grants) !== ids(v.grants)) fail(409, "旅行が変わりました。開き直してください");
          sealing.rekeyed(c.document, next.document);
          const refused = this.refusal(c, next.spec); if (refused) fail(400, refused);
          // Wrapped to seats of this trip that hold a key, the owner's own among them, each once.
          const to = v.seats.map(x => ({ ...x, s: c.sessions.find(s => s.id === x.seat) }));
          if (!to.some(x => x.seat === member.id) || new Set(to.map(x => x.seat)).size !== to.length || to.some(x => !x.s?.seatKey || x.s.pending)) fail(400, "包む席を確認してください");
          this.respec(c, next.spec); c.document = { ...next.document, revision: c.document.revision + 1 };
          const points = new Map(v.footprints.map(p => [p.id, p]));
          if (c.footprints) c.footprints = c.footprints.map(({ id, seat, at, auto }) => ({ id, seat, at, ...auto && { auto }, point: points.get(id)!.point, by: points.get(id)!.by }));
          if (c.media) c.media = c.media.map(({ location, caption, ...p }) => { const m = v.media.find(x => x.id === p.id)!; return { ...p, key: m.key, ...m.location && { location: m.location }, ...m.caption && { caption: m.caption } }; });
          for (const m of v.members) c.sessions.find(s => s.id === m.id)!.label = m.label;
          for (const g of v.grants) c.grants.find(x => x.id === g.id)!.label = g.label;
          for (const x of to) x.s!.seatKey = { ...x.s!.seatKey!, generation, wrapped: x.wrapped, ephemeral: x.ephemeral, rekey: { seat: member.id, signature: x.signature } };
          c.sealed = { generation }; delete c.departed; delete c.previous;
          response = Response.json({ revision: c.document.revision });
        } else if (action === "spec" && req.method === "PATCH") {
          owner(); this.verified(member); if (state === "frozen") fail(403, "共有終了後は変更できません"); this.match(req, c);
          const v = z.object({ spec: z.unknown(), confirm: z.literal(true) }).strict().parse(input);
          // A sealed trip's settings arrive sealed: only their plain parts and the ciphertext's form are checked here.
          let updated: Envelope; try { updated = kit.validate(v.spec, c.document, c.created, Boolean(c.sealed)).spec; } catch { fail(400, "設定と期限を確認してください"); }
          const refused = this.refusal(c, updated); if (refused) fail(400, refused);
          this.respec(c, updated); c.document.revision++;
        } else if (action === "revise" && req.method === "POST" && c.sealed) {
          // A sealed trip arrives revised by the browser, sealed (docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」): the host checks the plain parts
          // and that ciphertext which must stay the same did, and keeps the trip as it was to go back to.
          const keep = reviser(); if (state === "frozen") fail(403, "共有終了後は変更できません"); this.match(req, c);
          const next = this.resealed(c, member, input, { undo: false, keepSpec: keep });
          c.previous = this.revising(c).step(c.spec, c.document, next.document);
          this.respec(c, next.spec); c.document = { ...next.document, revision: c.document.revision + 1 };
          response = Response.json({ revision: c.document.revision });
        } else if (action === "revise" && req.method === "POST") {
          const keep = reviser(); plain(c); if (state === "frozen") fail(403, "共有終了後は変更できません"); this.match(req, c);
          const v = z.object({ text: z.string(), confirm: z.literal(true), title: z.string().optional() }).strict().parse(input), r = this.revision(c, v.text, member.label, keep);
          if (!r.ok) fail(400, r.messages?.[0] ?? "貼った内容を確認してください");
          if (r.diff.purgeAt) this.verified(member);  // only a revise that moves the deadline is an important action
          if (r.diff.large && !sameTitle(v.title, c.spec.title)) fail(400, "確認用のタイトルが一致しません。今の題を入力してください");
          c.previous = this.revising(c).step(c.spec, c.document, r.next.document);
          this.respec(c, r.next.spec); c.document = r.next.document; c.document.revision++;
          response = Response.json({ revision: c.document.revision });
        } else if (action === "key" && req.method === "PUT" && c.sealed) {
          // The browser checked the key with Anthropic and wrapped it: the host only keeps it on the seat, and is never sent the key itself.
          reviser(); if (state === "frozen") fail(403, "共有終了後は変更できません");
          member.assistWrapped = z.object({ wrapped: z.string().regex(/^v1\.[A-Za-z0-9_-]+$/).max(1000) }).strict().parse(input).wrapped;
          response = new Response(null, { status: 204 });
        } else if (action === "key" && req.method === "PUT") {
          reviser(); if (state === "frozen") fail(403, "共有終了後は変更できません");
          const v = z.object({ key: z.string().min(20).max(256).regex(/^sk-ant-/) }).strict().parse(input);
          await this.rate(`key:${id}:${member.id}`, 5);
          let accepted: boolean;
          try { accepted = await (this.env.VERIFY_KEY ?? anthropicAccepts)(v.key); } catch { fail(502, "Anthropic に接続できませんでした。時間をおいて再試行してください"); }
          if (!accepted) fail(400, "この API キーは使えません。Anthropic Console で発行した鍵を貼ってください");
          member.assistKey = seal(this.env.CAPSULE_HMAC_KEY, `${id}:${member.id}`, v.key);
          response = new Response(null, { status: 204 });
        } else if (action === "key" && req.method === "DELETE") {
          delete member.assistKey; delete member.assistWrapped; response = new Response(null, { status: 204 });
        } else if (action === "undo" && req.method === "POST" && c.sealed) {
          // The browser opened the sealed step back and sends the trip it makes, sealed (docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」): its Spec is the step's own.
          const keep = reviser(); if (state === "frozen") fail(403, "共有終了後は変更できません"); this.match(req, c);
          const next = this.resealed(c, member, input, { undo: true, keepSpec: keep });
          this.respec(c, next.spec); c.document = { ...next.document, revision: c.document.revision + 1 }; delete c.previous;
          response = Response.json({ revision: c.document.revision });
        } else if (action === "undo" && req.method === "POST") {
          const keep = reviser(); plain(c); if (state === "frozen") fail(403, "共有終了後は変更できません"); this.match(req, c);
          const v = z.object({ confirm: z.literal(true), title: z.string().optional() }).strict().parse(input), back = this.revising(c).undo(c, keep);
          if (back.diff.purgeAt) this.verified(member);
          if (+new Date(back.next.spec.lifecycle.purgeAt) <= this.clock()) fail(400, "削除期限は今より後にしてください");
          if (back.diff.large && !sameTitle(v.title, c.spec.title)) fail(400, "確認用のタイトルが一致しません。今の題を入力してください");
          this.respec(c, back.next.spec); c.document = back.next.document; c.document.revision++; delete c.previous;
          response = Response.json({ revision: c.document.revision });
        } else if (action === "document" && req.method === "PATCH") {
          this.match(req, c); if (grant.role === "viewer" || state === "frozen") fail(403, "読み取り専用です");
          const note = kit.apply({ spec: c.spec, document: c.document, created: c.created, sealed: Boolean(c.sealed), role: grant.role, state, seat: member.id, now: this.clock() }, input);
          response = Response.json({ revision: c.document.revision, ...note });
        } else fail(404, "操作が見つかりません");
      }
      // Footprints and photos are not recorded: a thousand and five hundred of them would push the history of invites out, and each carries its time and name.
      if (action !== "" && action !== "footprints" && action !== "media") { c.audit.push({ ...entry, at: this.clock() }); c.audit = c.audit.slice(-2000); }
      if (["document", "spec", "revise", "undo", "seal", "rekey"].includes(action)) c.updated = new Date(this.clock()).toISOString();
      // Expired/revoked links need no retained secret digest; bounded metadata is sufficient.
      c.grants = c.grants.filter(g => g.revoked === null && g.expires > this.clock());
      c.sessions = c.sessions.filter(s => c.grants.some(g => g.id === s.grantId));
      // A seat that is gone (revoked, expired, or sharing ended) takes its own entries with it: they never pass to anyone else.
      if (c.private) for (const k of Object.keys(c.private)) if (!c.sessions.some(s => s.id === k) || !c.private[k]!.length) delete c.private[k];
      // A photo put under an item by hand goes back to its time when the item is gone, by whichever route it went (revise, undo, an edit).
      for (const p of c.media ?? []) if (p.itineraryItemId !== undefined && !kit.hasItem?.(c.document, p.itineraryItemId)) delete p.itineraryItemId;
      // Every seat this request took away, by whichever route (the ones expired above are kept already).
      this.leave(c, before.filter(b => !c.sessions.some(s => s.id === b.id)));
      // The photos go first: a trip erased with its photos left behind would have nothing to find them by.
      if (erase) await this.env.MEDIA?.removeAll(row.key);
      const serialized = erase ? null : JSON.stringify(c);
      if (serialized && Buffer.byteLength(serialized) > 1_900_000) fail(413, "カプセルの容量上限です");
      if (await this.store.save(row, serialized, +new Date(c.spec.lifecycle.purgeAt), this.clock())) { stage.names = []; return response; }
    }
    return fail(409, "同時更新がありました。再読込して再試行してください");
  }
}
// HSTS only means something on https; local development runs on http loopback.
export function secure(response: Response, origin: string) {
  if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer"); response.headers.set("X-Content-Type-Options", "nosniff"); response.headers.set("X-Frame-Options", "DENY");
  // One outside origin: a sealed trip's browser sends the trip to Anthropic itself, under the member's own key (#692 回答 B).
  response.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://api.anthropic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  if (origin.startsWith("https:")) response.headers.set("Strict-Transport-Security", "max-age=31536000");
  return response;
}
