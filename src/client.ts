import Anthropic from "@anthropic-ai/sdk";
import type { Spec, Document, Role, State, Item, SealedSpec, SealedDocument, PlainPoint } from "./schema";
import { validate, untimed, localDay, sameTitle, specSchema, pointSchema } from "./schema";
import { explain } from "./paste";
import { placeholder, gapBefore } from "./timing";
import { emptyTrip } from "./template";
import { reviseText, reviseTrip, undoTrip, type Diff, type Previous } from "./revise";
import { exportFiles, tripHtml, tripMarkdown, zip } from "./export";
import { PRF_INPUT, assistSealingKey, b64, unb64, newMemoKey, unwrapMemoKey, wrapMemoKey, wrappingKey, openEntry, sealEntry, privateMarkdown, seal as sealWords, open as openWords, type PlainEntry } from "./private-entries";
import { generate, REVISE_LIMIT, REVISE_SYSTEM, todayLine } from "./assist";
import { openField, sealField, openPhotoImage, openPhotoLocation, sealPhoto, type PhotoSize, openName, openPoint, sealMove, sealName, sealPoint, openTrip, resealTrip, sealOperation, sealSpec, confirmationCodes, matchesCommitment, newAttempt, newHandoffKeys, newSeatKeys, newTripKey, seatPublic, signEdge, unwrapSeatSecret, unwrapTripKey, wrapSeatSecret, wrapTripKey, acceptRekey, reachableSeats, resealAll, signRekey, signSuccession, verifyEdge, verifySuccession, type KeyedSeat } from "./trip-keys";
import { privateReviseText, takePrivate, privateDiff } from "./private-revise";
import { expiredIn, type Joined } from "./joined";
import { autoDue, footprints, spotsOf, type Point } from "./footprints";
import type { MapCamera, MapData } from "./map";
import { itemAt, linkPhotos, photoDays, photoInstant, photoPlace, photosPageShown, photosUploadable, type Shown } from "./moments";
import { inspectJpeg, readExif, PHOTO_LIMITS } from "./media";
import { firstPage, story, type StoryEntry } from "./story";
const e = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// A member's own plan or diary entry, as the host keeps it (src/cloud-host.ts): the title, body and place sealed. Only this seat's
// come with the trip; a draft has none. `plain` holds each one as this browser opened it, or null when it could not.
type PrivateEntry = { id: string; kind: "item" | "diary"; day: string; startsAt?: string; endsAt?: string; title: string; body: string; place?: string; createdAt: string; updatedAt: string };
let plain = new Map<string, PlainEntry | null>();
// `privateKey`: this seat's memo key as the host keeps it, wrapped with the seat's passkey (null until the seat's first entry).
// `footprints`: the trip's points, every member's, oldest first (src/cloud-host.ts). `mine`: left by this seat. `auto`: left on
// opening the page, not on a press (#481). In a sealed trip they come from the host as `point` and `by` ciphertext, and
// `openFootprints` opens them into this shape first (`HostFootprint`).
type Footprint = { id: string; at: string; lat: number; lng: number; accuracy: number; by: string; mine: boolean; auto: boolean };
type HostFootprint = Omit<Footprint, "lat" | "lng" | "accuracy"> & (PlainPoint | { point: string });
type View = { id?: string; spec: Spec; document: Document; role: Role; state: State | "draft"; passkey?: boolean; private?: PrivateEntry[]; privateKey?: string | null; seatKey?: SeatKey | null; keyed?: boolean; handoff?: Handoff | null; waiting?: Array<{ id: string; label: string; handoff: Handoff | null }>; footprints?: Footprint[]; media?: Shown[]; photos?: boolean; sealed?: { generation: number } | null; unreadable?: string[]; updated?: string; created?: number; label?: string; self?: { id: string; label: string }; assistKey?: boolean; assistWrapped?: string | null; assistModel?: string; mustSeal?: boolean; rekey?: "auto" | "ask" | null; seats?: KeyedSeat[] };
// This seat's keys for the trip as the host keeps them (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」): public keys and what is already wrapped.
// `rekey`: the owner seat's signature over this wrap, when the owner's browser replaced the trip key (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」).
type SeatKey = { x25519: string; ed25519: string; generation: number; wrapped: string; ephemeral: string; secret?: { x25519: string; ed25519: string; passkey: string }; edges?: Array<{ seat: string; signature: string }>; since?: KeyedSeat["since"]; rekey?: { seat: string; signature: string } };
// One attempt of the confirmation-code handoff as the host relays it (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」). Public values only.
type Handoff = { attempt: string; commitment: string; giver?: { seat: string; ephemeral: string; x25519: string; ed25519: string }; reveal?: { x25519: string; ed25519: string; nonce: string } };
// `loads`: how many times this page has read the trip (load()), for the 20-second refresh to tell an answer older than one read since.
let view: View, tab = "days", opened = false, selectedDay = "", diaryDay = "", editingDiaryId = "", stale = false, loads = 0;
// The footprint map's narrowing: one day (in the trip's zone) and one member (`by`), "" for all.
let mapDay = "", mapBy = "";
// What the footprints page shows (#646): the plans with a place on the map, the footprints, or both. Not kept past the page.
let mapShow = { plans: true, footprints: true };
// What the footprint map on this page draws, set as the page is drawn, and what removes the map drawn before (src/map.ts).
let mapData: MapData | undefined, unmountMap: (() => MapCamera | undefined) | undefined;
// How many times 「もう一度」 was pressed for src/map.ts: each is asked for under a URL of its own, as a browser that keeps a failed
// module (Chrome up to 155) answers the same URL with the same failure until the page is read again.
let mapRetries = 0;
// Where the member moved the map to, kept for the next drawing of the same page and narrowing (`mapCameraKey`), so footprints
// arriving meanwhile do not send it back to all the points (#574).
let mapCamera: MapCamera | undefined, mapCameraKey = "";
// How this browser likes to read a day: the cards, or one line an item. A preference of the device, so it stays here and is never sent to the host.
let timelineView: "detail" | "list" = (() => { try { return localStorage.getItem("timeline-view") === "list" ? "list" : "detail"; } catch { return "detail"; } })();
let canCreate = false, localOnly = false, creatorLabel = "", creatorSecret = "", creatorCapsule = "", unclaimed: { id: string; secret: string; url: string } | undefined;
const app = document.querySelector<HTMLElement>("#app")!;
const dialog = document.querySelector<HTMLDialogElement>("#dialog")!;
const id = /^\/c\/([a-f0-9]{32})$/.exec(location.pathname)?.[1];
// 開いたときに足あとを残す (#481): turned on by this device for this trip, so it stays here and is never sent to the host.
let autoStep = (() => { try { return Boolean(id) && localStorage.getItem(`auto-footprint:${id}`) === "1"; } catch { return false; } })();
const roleNames = { owner: "オーナー", editor: "編集者", participant: "参加者", viewer: "閲覧のみ" };
// The lines of the owner's history of invites and owner seats (GET history), by the host's event names.
const historyNames: Record<string, string> = { publish: "旅行を作成", replay: "オーナー招待を再発行", "creator-owner": "オーナー招待を作り直し（作成者）", recover: "オーナー招待を差し替え（発行者）", sessions: "席を引換", grants: "招待を発行", rotate: "招待を交換", revoke: "招待を失効", "revoke-member": "メンバーを失効", freeze: "共有を終了" };
const stateNames = { draft: "公開前のプレビュー", active: "旅の準備・旅行中", reflection: "思い出を追記する期間", frozen: "共有終了・読み取り専用", purged: "削除済み" };
const statusNames = { confirmed: "決定", proposed: "候補・要確認", cancelled: "中止" };
const kindNames = { transport: "移動", stay: "宿泊", activity: "お出かけ", meal: "食事", note: "メモ" };
function notice(text: string, error = false) { const el = document.querySelector<HTMLElement>("#message")!; el.textContent = text; el.className = error ? "message error" : "message"; el.hidden = false; if (dialog.open) { let status = dialog.querySelector<HTMLElement>(".dialog-message"); if (!status) { status = document.createElement("p"); status.className = "dialog-message"; status.setAttribute("role", "status"); dialog.prepend(status); } status.textContent = text; } }
// `revision` is the version a change was computed against, when that is not the one on screen (a revision's shown diff).
// An owner's important action, or a creator's key or trip handover and deletion, answered 428 needs a passkey checked first: the
// seat's passkey for an owner, a fresh sign-in for a creator. It is then sent once more as it was.
async function api(action = "", method = "GET", body?: unknown, revision = view?.document.revision, retried = false): Promise<any> {
  const url = action.startsWith("/") ? action : `/v1/c/${id}/${action}`.replace(/\/$/, "");
  // ui=2: this screen draws a sealed trip and moves a plain one; the host asks an older screen to reload (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」).
  const res = await fetch(url.startsWith("/v1/c/") ? `${url}${url.includes("?") ? "&" : "?"}ui=2` : url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(revision !== undefined ? { "If-Match": `"${revision}"` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (res.status === 428 && !retried) {
    try { await (url.startsWith("/v1/c/") ? stepUp() : creatorCheck()); } catch (err) { throw (err as Error).name === "NotAllowedError" ? new Error("パスキーの操作を中止しました。") : err; }
    return api(action, method, body, revision, true);
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    const data = await res.json(); if (res.status === 409) stale = true;
    // The owner replaced the trip key meanwhile: what this page sealed is of the older generation (spec「5.5 旅行の鍵を替える」). Read again to take the new one.
    if (res.status === 409 && data.error === "旅行の鍵が替わりました。開き直してください" && id) { await reload(); throw new Error("旅行の鍵が替わりました。もう一度保存してください"); }
    throw Object.assign(new Error(data.error ?? "通信に失敗しました"), { status: res.status, gone: data.seat === "gone", ...(data.pending ? { pending: true, code: data.code as string } : {}) }); }
  return res.json();
}
// The seat is held by the cookie this browser keeps. It is a bearer key: a copy opens the trip from any device, and nothing here
// binds it to this one. Passkeys are optional for reading: a way back to the seat after its cookie is lost, the way in from a PC
// (the OS shows a QR code for the phone), and an owner's check before an important action. They do not stop a copied cookie from
// reading the trip. Browsers without WebAuthn (in-app webviews) never see the buttons.
const passkeys = "PublicKeyCredential" in window;
// A seat's own entries are sealed with its memo key, wrapped with a key derived from its passkey's PRF output (#343,
// docs/ephemeral-trip-capsule.md「5.6 自分だけの予定・日記の鍵」). Every ceremony of the seat's passkey asks for that output, so the one Face ID that
// checks or brings back a seat also opens its memo key. A passkey made without asking for PRF never gives it (spec「5.6 自分だけの予定・日記の鍵」).
const prfAsk: AuthenticationExtensionsClientInputs = { prf: { eval: { first: PRF_INPUT } } };
const prfOf = (c: PublicKeyCredential) => c.getClientExtensionResults().prf?.results?.first as ArrayBuffer | undefined;
const rewrapFailed = "今のパスキーで自分だけのメモの鍵（または旅行の鍵）を開けませんでした。このまま置き換えると読めなくなるため、置き換えを止めました。パスキーのある端末で直接開くか、別のブラウザで開いて置き換えてください。";
const noPrf = "このブラウザ（またはこのパスキー）では、自分だけのメモに鍵をかけられません。別のブラウザで開くか、パスキーを登録し直してください。";
const passkeyCannotRead = "このパスキーでは読めませんでした。この旅行に登録したパスキーを選んでください。別の端末から QR で使った場合は、パスキーのある端末で直接開いてください。";
// This browser's copy of the memo key, per trip, in IndexedDB: a key that cannot be taken out, next to the wrapped form it was
// opened from, so a key from before a re-invite (another seat, another wrapped key) is never used. Kept in memory as well, for a
// browser that has no IndexedDB (private browsing): there it lasts as long as the page. Both this and the seat's keys below go
// with the trip's row when the seat or the trip is gone, or the trip is past its deletion (forgetTrip).
let held: { trip: string; wrapped: string; key: CryptoKey } | undefined;
function keyStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const opened = indexedDB.open("capsule", 1);
    opened.onupgradeneeded = () => opened.result.createObjectStore("private-keys");
    opened.onerror = () => reject(opened.error);
    // A transaction or a put can also throw (a key the store cannot clone, a closing database): that rejects too, so the caller
    // falls back to the copy in memory instead of waiting for ever.
    opened.onsuccess = () => { const db = opened.result; try { const r = use(db.transaction("private-keys", mode).objectStore("private-keys")); r.onsuccess = () => { db.close(); resolve(r.result); }; r.onerror = () => { db.close(); reject(r.error); }; } catch (err) { db.close(); reject(err); } };
  });
}
async function memoKey(): Promise<CryptoKey | undefined> {
  if (!id || !view.privateKey) return;
  if (held?.trip === id && held.wrapped === view.privateKey) return held.key;
  const kept = await keyStore<{ wrapped: string; key: CryptoKey } | undefined>("readonly", s => s.get(id)).catch(() => undefined);
  return kept?.wrapped === view.privateKey ? kept.key : undefined;
}
async function unlock(prf: BufferSource, wrapped = view.privateKey!) {
  const key = await unwrapMemoKey(wrapped, await wrappingKey(prf, id!), id!);
  held = { trip: id!, wrapped, key }; await keyStore("readwrite", s => s.put({ wrapped, key }, id!)).catch(() => undefined);
}
// This seat's passkey, checked with the host (as stepUp does) and asked for its PRF output: undefined when it gives none.
// `only`: right after a replacement the device still holds the old passkey too, which the host no longer takes (#759).
async function prfAssertion(only?: ArrayBuffer) {
  const { challenge, rpId } = await api("passkey/challenge", "POST", {});
  const credential = await navigator.credentials.get({ publicKey: { challenge: unb64(challenge), rpId, userVerification: "required", extensions: prfAsk, ...(only ? { allowCredentials: [{ id: only, type: "public-key" as const }] } : {}) } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("この操作にはパスキーでの本人確認が必要です");
  const r = credential.response as AuthenticatorAssertionResponse;
  await api("passkey/verify", "POST", { challenge, id: credential.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) });
  return prfOf(credential);
}
// The trip's key and this seat's key pair (#689, docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」). The first browser an owner opens the trip in
// makes them and puts only public keys and wrapped forms on the seat. The seat's private keys stay in this browser's IndexedDB as
// keys that cannot be taken out (`seat:<trip>`, next to the memo key's store; no new version), and a passkey's PRF output also
// wraps them for the seat (sealSeatKeys), so a browser with nothing kept gets them back with one check (passkeyLogin).
type SeatSecret = { x25519: CryptoKey; ed25519: CryptoKey };
let heldSeat: { trip: string; x25519: string; secret: SeatSecret } | undefined, tripKey: CryptoKey | undefined, makingKeys: Promise<void> | undefined;
// The wrapped key `tripKey` was opened from, so a page redrawn with the same seat does not open it again (nor wait on IndexedDB).
let tripKeyFrom = "";
async function seatSecret(): Promise<SeatSecret | undefined> {
  const pub = view.seatKey?.x25519; if (!id || !pub) return;
  if (heldSeat?.trip === id && heldSeat.x25519 === pub) return heldSeat.secret;
  const kept = await keyStore<{ x25519: string; secret: SeatSecret } | undefined>("readonly", s => s.get(`seat:${id}`)).catch(() => undefined);
  return kept?.x25519 === pub ? kept.secret : undefined;
}
// `generation`: the trip key's generation this browser last took (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」): a later one is taken only when
// the owner signed it (acceptRekey). A pair kept before it was recorded takes the generation it holds, once.
async function keepSeat(x25519: string, secret: SeatSecret, ed25519?: string, generation?: number) {
  heldSeat = { trip: id!, x25519, secret };
  // The same pair kept again (brought back with the passkey) keeps the generation this browser took: forgetting it would let a
  // later generation in unchecked.
  const before = await keptSeat(), same = before?.x25519 === x25519;
  ed25519 ??= same ? before?.ed25519 : undefined; generation ??= same ? before?.generation : undefined;
  await keyStore("readwrite", s => s.put({ x25519, secret, ...(ed25519 ? { ed25519 } : {}), ...(generation ? { generation } : {}) }, `seat:${id}`)).catch(() => undefined);
}
const keptSeat = () => keyStore<{ x25519: string; ed25519?: string; secret: SeatSecret; generation?: number } | undefined>("readonly", s => s.get(`seat:${id}`)).catch(() => undefined);
async function keepGeneration(generation: number) {
  const kept = await keptSeat();
  if (kept) await keyStore("readwrite", s => s.put({ ...kept, generation }, `seat:${id}`)).catch(() => undefined);
}
// Whether the public keys the host lists for this seat are the ones whose private halves this browser holds: the Ed25519 key
// signs what it verifies, and the X25519 key agrees on the same secret with a throwaway pair. The edges are walked from these.
async function owns(secret: SeatSecret, pub: { x25519: string; ed25519: string }) {
  try {
    const m = crypto.getRandomValues(new Uint8Array(32)), signed = await crypto.subtle.sign("Ed25519", secret.ed25519, m);
    if (!await crypto.subtle.verify("Ed25519", await crypto.subtle.importKey("raw", unb64(pub.ed25519), "Ed25519", false, ["verify"]), signed, m)) return false;
    const other = await crypto.subtle.generateKey("X25519", false, ["deriveBits"]) as CryptoKeyPair;
    const mine = await crypto.subtle.deriveBits({ name: "X25519", public: other.publicKey }, secret.x25519, 256);
    const theirs = await crypto.subtle.deriveBits({ name: "X25519", public: await crypto.subtle.importKey("raw", unb64(pub.x25519), "X25519", false, []) }, other.privateKey, 256);
    return b64(mine) === b64(theirs);
  } catch { return false; }
}
// A later generation whose signature this browser could not trace to an owner seat it reaches: it is not opened (spec「5.5 旅行の鍵を替える」).
let keyRefused = false;
// The trip key, opened with this browser's copy of the seat's private key; undefined where this browser holds none, where the seat
// holds an older generation than the trip's (it was left out when the key was replaced, and takes the present one by the codes),
// and where a later generation is not the owner's.
async function openTripKey() {
  const k = view.seatKey;
  // The same wrap opened before, while it is still of the trip's generation (a seat left out keeps its older wrap).
  if (tripKey && k && tripKeyFrom === `${id}/${k.x25519}/${k.wrapped}` && (!view.sealed || k.generation === view.sealed.generation)) return;
  const secret = await seatSecret(), kept = secret && await keptSeat();
  tripKey = undefined; tripKeyFrom = ""; keyRefused = false;
  if (!k || !secret || (view.sealed && k.generation !== view.sealed.generation)) return;
  if (kept?.generation !== undefined && k.generation > kept.generation) {
    const self = view.self && await owns(secret, k) ? { id: view.self.id, ed25519: k.ed25519 } : undefined;
    if (!self || !await acceptRekey({ self, known: kept.generation, capsuleId: id!, seats: view.seats ?? [], seatKey: k })) { keyRefused = true; return; }
  }
  tripKey = await unwrapTripKey(k.wrapped, k.ephemeral, secret.x25519, id!, k.generation).catch(() => undefined);
  if (!tripKey) return;
  tripKeyFrom = `${id}/${k.x25519}/${k.wrapped}`;
  if (kept && kept.generation !== k.generation) await keepGeneration(k.generation);
}
// A key made extractable only to be wrapped is read back as one that cannot be taken out.
const sealedAway = async (key: CryptoKey, alg: "X25519" | "Ed25519", usages: KeyUsage[]) => crypto.subtle.importKey("pkcs8", await crypto.subtle.exportKey("pkcs8", key), alg, false, usages);
// An owner of a trip nobody holds keys for makes them now. Nothing here asks the OS for a passkey: Safari refuses that without a press.
function ensureTripKey() {
  if (!id || view.state === "draft" || view.seatKey || view.role !== "owner" || view.keyed) return openTripKey();
  return makingKeys ??= (async () => {
    try {
      const seat = await newSeatKeys(), pub = await seatPublic(seat), wrap = await wrapTripKey(await newTripKey(), pub.x25519, id!, 1);
      await api("keys", "PATCH", { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: 1, wrapped: wrap.wrapped });
      view.seatKey = { ...pub, generation: 1, wrapped: wrap.wrapped, ephemeral: wrap.ephemeral }; view.keyed = true;
      await keepSeat(pub.x25519, { x25519: await sealedAway(seat.x25519.privateKey, "X25519", ["deriveBits"]), ed25519: await sealedAway(seat.ed25519.privateKey, "Ed25519", ["sign"]) }, pub.ed25519, 1);
    } catch {
      // 409: another owner seat made them first. Read the keys again so this seat shows as waiting, not as one about to make them.
      stale = false;
      const now = await api().catch(() => undefined) as View | undefined;
      if (now) { view.seatKey = now.seatKey ?? null; view.keyed = now.keyed; }
    }
    await openTripKey();
  })().finally(() => { makingKeys = undefined; });
}
// With this seat's key pair in this browser and none wrapped by a passkey on the seat, makes a new pair, wraps the trip key to it
// and puts both with the private keys wrapped by `prf`. The old private key cannot be taken out of IndexedDB to be wrapped, so the
// pair is made again. The old Ed25519 key signs the new public keys (`since`), so the edges other seats signed over the old ones
// still lead here, and this seat's own edges that still hold are signed again with the new key (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」).
async function sealSeatKeys(prf: BufferSource | undefined) {
  const k = view.seatKey, secret = await seatSecret();
  if (!prf || !id || !k || k.secret || !secret) return;
  const trip = await unwrapTripKey(k.wrapped, k.ephemeral, secret.x25519, id, k.generation, true);
  const seat = await newSeatKeys(), pub = await seatPublic(seat), wrap = await wrapTripKey(trip, pub.x25519, id, k.generation);
  const since = view.self && await owns(secret, k) ? await signSuccession(secret.ed25519, { x25519: k.x25519, ed25519: k.ed25519 }, { capsuleId: id, seat: view.self.id, ...pub }) : undefined;
  const edges: Array<{ seat: string; signature: string }> = [];
  for (const e of since ? k.edges ?? [] : []) {
    // An edge holds over the other seat's present keys, or over its previous ones when that seat made its pair again (`since`).
    const to = view.seats?.find(s => s.id === e.seat), target = to && { seat: to.id, x25519: to.x25519, ed25519: to.ed25519 };
    const holds = target && (await verifyEdge(k.ed25519, e.signature, target, id) || (to.since !== undefined && await verifyEdge(k.ed25519, e.signature, { seat: to.id, x25519: to.since.x25519, ed25519: to.since.ed25519 }, id) && await verifySuccession(to, id)));
    if (target && holds) edges.push({ seat: to.id, signature: await signEdge(seat.ed25519.privateKey, target, id) });
  }
  const body = { type: "seat", ...pub, ephemeral: wrap.ephemeral, generation: k.generation, wrapped: wrap.wrapped, secret: await wrapSeatSecret(seat, prf, id), ...since && { since, edges } };
  const put = await api("keys", "PATCH", body);
  view.seatKey = put.seatKey;
  await keepSeat(pub.x25519, { x25519: await sealedAway(seat.x25519.privateKey, "X25519", ["deriveBits"]), ed25519: await sealedAway(seat.ed25519.privateKey, "Ed25519", ["sign"]) }, pub.ed25519, k.generation);
  await openTripKey();
}
// The seat's private keys opened from what the passkey's PRF wrapped, when this browser holds none.
async function restoreSeat(prf: BufferSource) {
  const k = view.seatKey; if (!id || !k?.secret) return;
  await keepSeat(k.x25519, await unwrapSeatSecret(k.secret, prf, id));
  await openTripKey();
}
// The confirmation-code handoff (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」, #690). Both dialogs keep the values they saw in these
// variables and nowhere else (never in IndexedDB, never read again from the host): closing the dialog or reading the page again
// starts over, with a new nonce and so a new commitment. The two codes are typed into the other's screen; there is no
// 「一致」 button to press without looking.
const codeNotice = "このコードは秘密ではありません。旅行の連絡に使っているチャット（LINE など）に貼るか、口頭で伝えてください。";
const codeAsk = "相手の画面に出ているコードを聞いて、下に入力してください。";
const wrongCode = "確認コードが違います。もう一度やり直してください";
let handoffRun = 0, codeResolver: ((value: string) => void) | undefined;
// The close event comes after close() returns: a dialog opened again meanwhile (another 「鍵を受け取る」) is a new attempt, not one to end.
dialog.addEventListener("close", () => { if (dialog.open) return; handoffRun++; codeResolver?.(""); codeResolver = undefined; displayRun++; if (openedDisplay) { URL.revokeObjectURL(openedDisplay); openedDisplay = ""; } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// The seat's own pair kept in this browser (`seat:<trip>`), made when there is none. The public keys are kept with it: a pair that
// cannot be taken out cannot say its public half again.
async function ownPair(): Promise<{ pub: { x25519: string; ed25519: string }; secret: SeatSecret }> {
  const kept = await keyStore<{ x25519: string; ed25519?: string; secret: SeatSecret } | undefined>("readonly", s => s.get(`seat:${id}`)).catch(() => undefined);
  if (kept?.ed25519 && !view.seatKey) return { pub: { x25519: kept.x25519, ed25519: kept.ed25519 }, secret: kept.secret };
  const seat = await newSeatKeys(), pub = await seatPublic(seat);
  const secret = { x25519: await sealedAway(seat.x25519.privateKey, "X25519", ["deriveBits"]), ed25519: await sealedAway(seat.ed25519.privateKey, "Ed25519", ["sign"]) };
  await keepSeat(pub.x25519, secret, pub.ed25519);
  return { pub, secret };
}
const retry = (action: string, attrs = "") => `<div class="admin-actions">${button("やり直す", action, "primary", attrs)}</div>`;
const showCode = (title: string, lead: string, own: string, ownLabel: string) =>
  modal(title, `${lead}<p>${e(ownLabel)}</p><p class="handoff-code" data-handoff-own><strong>${e(own)}</strong></p><p class="muted">${codeNotice}</p><p>${codeAsk}</p><label>相手のコード<input data-handoff-input inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]{6}"></label><div class="admin-actions">${button("確かめる", "handoff-submit", "primary")}</div>`);
// Resolves with what was typed, or "" when the dialog was closed meanwhile.
const typedCode = () => new Promise<string>(resolve => { codeResolver = resolve; });
async function watch<T>(run: number, read: (v: View) => T | undefined): Promise<T | undefined> {
  for (const end = Date.now() + 600_000; Date.now() < end && run === handoffRun;) {
    const got = read(await api() as View); if (got !== undefined) return got;
    await sleep(1000);
  }
}
const finishHandoff = async (message: string) => { if (dialog.open) dialog.close(); await reload(); notice(message); };
// The new member's side: steps 1, 3 and 4 (the giver's are in giveKey).
async function receiveKey() {
  const run = ++handoffRun; if (!id) return;
  try {
    modal("鍵を受け取る", "<p>準備しています…</p>");
    const { pub, secret } = await ownPair(), attempt = await newAttempt(pub, id);
    const put = await api("keys", "PATCH", { type: "wait", commitment: attempt.commitment }) as { handoff: Handoff };
    const att = put.handoff.attempt;
    modal("鍵を受け取る", "<p>鍵を持つメンバーの画面で、あなたの名前の横の「渡す」を押してもらってください。</p><p class=\"muted\">押されると、確認コードが出ます。</p>");
    const giver = await watch(run, v => v.handoff?.attempt !== att ? null as never : v.handoff.giver);
    if (run !== handoffRun) return;
    if (!giver) { modal("鍵を受け取る", `<p>${wrongCode}</p>${retry("receive-key")}`); return; }
    await api("keys", "PATCH", { type: "reveal", attempt: att, ...pub, nonce: attempt.nonce });
    const codes = await confirmationCodes({ capsuleId: id, giver, member: { ...pub, nonce: attempt.nonce } });
    showCode("鍵を受け取る", "<p>鍵を渡すメンバーと、コードを伝え合ってください。</p>", codes.member, "あなたのコード");
    const typed = await typedCode(); if (run !== handoffRun || !typed) return;
    if (typed.trim() !== codes.giver) { await api("keys", "PATCH", { type: "abandon", attempt: att }).catch(() => undefined); modal("鍵を受け取る", `<p>${wrongCode}</p>${retry("receive-key")}`); return; }
    modal("鍵を受け取る", "<p>コードが合いました。鍵を受け取っています…</p>");
    // A seat left out when the key was replaced still holds its older wrap: the one to wait for is to this attempt's keys.
    const key = await watch(run, v => v.seatKey?.x25519 === pub.x25519 ? v.seatKey : v.handoff?.attempt === att ? undefined : null as never);
    if (run !== handoffRun) return;
    if (!key || key.ephemeral !== giver.ephemeral || key.x25519 !== pub.x25519 || key.ed25519 !== pub.ed25519) { modal("鍵を受け取る", `<p>${wrongCode}</p>${retry("receive-key")}`); return; }
    const opened = await unwrapTripKey(key.wrapped, key.ephemeral, secret.x25519, id, key.generation).catch(() => undefined);
    if (!opened) { modal("鍵を受け取る", `<p>${wrongCode}</p>${retry("receive-key")}`); return; }
    // The giver's public keys are the ones this screen kept at step 2, which the codes confirmed.
    const edge = await signEdge(secret.ed25519, { seat: giver.seat, x25519: giver.x25519, ed25519: giver.ed25519 }, id);
    await api("keys", "PATCH", { type: "edge", seat: giver.seat, signature: edge }).catch(() => undefined);
    // Taken by the codes, so it is this browser's from now on, whichever generation it is.
    await keepGeneration(key.generation);
    await finishHandoff("旅行の鍵を受け取りました。");
  } catch (err) { if (run === handoffRun) modal("鍵を受け取る", `<p>${e((err as Error).message)}</p>${retry("receive-key")}`); }
}
// The giving member's side: steps 2 and 4, the wrap, and the edge.
async function giveKey(seat: string, label: string) {
  const run = ++handoffRun; if (!id) return;
  const title = `${label}に鍵を渡す`, again = retry("give-key", `data-id="${e(seat)}" data-label="${e(label)}"`);
  try {
    const own = view.seatKey, mine = await seatSecret();
    if (!own || !mine || !tripKey) throw new Error("この端末には旅行の鍵がありません");
    modal(title, `<p>${e(label)}の画面で「鍵を受け取る」を押してもらってください。</p>`);
    const commitment = await watch(run, v => { const w = v.waiting?.find(x => x.id === seat); return w?.handoff?.commitment ? w.handoff : undefined; });
    if (!commitment || run !== handoffRun) return;
    const h = await newHandoffKeys();
    await api("keys", "PATCH", { type: "give", seat, attempt: commitment.attempt, ephemeral: h.ephemeral });
    modal(title, `<p>${e(label)}の画面にコードが出るまでお待ちください…</p>`);
    const reveal = await watch(run, v => { const w = v.waiting?.find(x => x.id === seat)?.handoff; return !w || w.attempt !== commitment.attempt ? null as never : w.reveal; });
    if (run !== handoffRun) return;
    // The commitment was read before this seat's values were put; the member's are checked against it, never against a re-read.
    if (!reveal || !await matchesCommitment(commitment.commitment, { x25519: reveal.x25519, ed25519: reveal.ed25519 }, reveal.nonce, id)) {
      await api("keys", "PATCH", { type: "abandon", seat, attempt: commitment.attempt }).catch(() => undefined);
      modal(title, `<p>${wrongCode}</p>${again}`); return;
    }
    const codes = await confirmationCodes({ capsuleId: id, giver: { ephemeral: h.ephemeral, x25519: own.x25519, ed25519: own.ed25519 }, member: reveal });
    showCode(title, `<p>${e(label)}と、コードを伝え合ってください。</p>`, codes.giver, "あなたのコード");
    const typed = await typedCode(); if (run !== handoffRun || !typed) return;
    if (typed.trim() !== codes.member) { await api("keys", "PATCH", { type: "abandon", seat, attempt: commitment.attempt }).catch(() => undefined); modal(title, `<p>${wrongCode}</p>${again}`); return; }
    const trip = await unwrapTripKey(own.wrapped, own.ephemeral, mine.x25519, id, own.generation, true);
    const wrap = await wrapTripKey(trip, reveal.x25519, id, own.generation, h.pair);
    await api("keys", "PATCH", { type: "wrap", seat, attempt: commitment.attempt, wrapped: wrap.wrapped });
    const edge = await signEdge(mine.ed25519, { seat, x25519: reveal.x25519, ed25519: reveal.ed25519 }, id);
    await api("keys", "PATCH", { type: "edge", seat, signature: edge }).catch(() => undefined);
    await finishHandoff(`${label}に旅行の鍵を渡しました。`);
  } catch (err) { if (run === handoffRun) modal(title, `<p>${e((err as Error).message)}</p>${again}`); }
}
// 「パスキーで読む」: the memo key of a seat that has one, opened in this browser with one check.
async function readWithPasskey() {
  const prf = await prfAssertion();
  // The seat's trip keys come with the same check; the memo key below is what this action is for, so they never stop it.
  if (prf) { await restoreSeat(prf).catch(() => undefined); await sealSeatKeys(prf).catch(() => undefined); }
  if (!view.privateKey) return;
  try { if (!prf) throw new Error(); await unlock(prf); } catch { throw new Error(passkeyCannotRead); }
}
// The memo key before a first entry is sealed: this browser's copy, or the seat's opened with its passkey, or a new one made now,
// wrapped and handed to the host. A seat without a passkey registers one first; without PRF nothing is written (spec「5.6 自分だけの予定・日記の鍵」).
async function ensureMemoKey(): Promise<CryptoKey | undefined> {
  if (view.privateKey) { const kept = await memoKey(); if (kept) return kept; await readWithPasskey(); return memoKey(); }
  if (!passkeys) throw new Error(noPrf);
  if (!view.passkey) { if (!confirm("自分だけのメモは、運用者にも読めないようにパスキーで鍵をかけます。この端末でパスキーを登録して続けますか？")) return; await registerPasskey(); }
  const prf = await prfAssertion(); if (!prf) throw new Error(noPrf);
  const wrapped = await wrapMemoKey(await newMemoKey(), await wrappingKey(prf, id!), id!);
  await api("private", "PATCH", { type: "key", wrapped }); view.privateKey = wrapped; await unlock(prf); return memoKey();
}
async function registerPasskey() {
  // Replacing is allowed (a new phone), but the old passkey stops working, so say so before the OS dialog appears. The host takes
  // a check by the current passkey in the same request as the new one, so the OS asks for that first.
  if (view.passkey && !confirm("今のパスキーで本人確認してから、この端末のパスキーに置き換えます。前に登録したパスキーでは戻れなくなります。今のパスキーを失った場合は、オーナーに失効と再招待を頼んでください。続けますか？")) return;
  let check: Record<string, string> | undefined, memo: CryptoKey | undefined;
  // Whether this browser holds the seat's keys is read once, before the OS dialogs, and kept in memory for the wrap below: read
  // again after the new passkey is made, a copy in IndexedDB gone meanwhile would leave the seat's keys wrapped by no passkey,
  // the host having dropped the old one's wrap (#933).
  let seat = await seatSecret();
  if (view.passkey) {
    const asked = await api("passkey/challenge", "POST", {});
    const current = await navigator.credentials.get({ publicKey: { challenge: unb64(asked.challenge), rpId: asked.rpId, userVerification: "required", extensions: prfAsk } }) as PublicKeyCredential | null;
    if (!current) return;
    const a = current.response as AuthenticatorAssertionResponse;
    check = { challenge: asked.challenge, id: current.id, clientDataJSON: b64(a.clientDataJSON), authenticatorData: b64(a.authenticatorData), signature: b64(a.signature) };
    // A seat whose entries are sealed rewraps its memo key for the new passkey. Stopped here, before the OS makes one, if the
    // current passkey cannot open it: the old passkey goes with the replacement, and every entry would be lost (spec「5.6 自分だけの予定・日記の鍵」).
    if (view.privateKey) { const prf = prfOf(current); try { if (!prf) throw new Error(); memo = await unwrapMemoKey(view.privateKey, await wrappingKey(prf, id!), id!, true); } catch { throw new Error(rewrapFailed); } }
    // The seat's keys wrapped by this passkey are dropped by the host with it: a browser that no longer holds them opens them now,
    // or the replacement stops here with the old passkey still in place (the trip key would otherwise be lost, #689).
    if (view.seatKey?.secret && !seat) {
      const prf = prfOf(current);
      try { if (!prf) throw new Error(); await restoreSeat(prf); seat = heldSeat?.secret; } catch { throw new Error(rewrapFailed); }
    }
  }
  if (seat && view.seatKey) heldSeat = { trip: id!, x25519: view.seatKey.x25519, secret: seat };
  const { challenge, rpId } = await api("passkey/challenge", "POST", {});
  // user.name is what the OS shows in its passkey list: the trip, never a person's name.
  const credential = await navigator.credentials.create({ publicKey: { challenge: unb64(challenge), rp: { id: rpId, name: "旅のカプセル" }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: view.spec.title, displayName: view.spec.title }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none", extensions: { prf: {} } } }) as PublicKeyCredential | null;
  if (!credential) return;
  const r = credential.response as AuthenticatorAttestationResponse;
  // Safari 16.0-16.3 and Firefox before 119 have PublicKeyCredential without these, and this app reads the key rather than the attestation.
  if (typeof r.getPublicKey !== "function" || typeof r.getAuthenticatorData !== "function") throw new Error("このブラウザのパスキーには対応していません。別のブラウザをお試しください");
  const key = r.getPublicKey();
  if (!key) throw new Error("この端末のパスキーには対応していません");
  // The new passkey's PRF output: given at creation by some authenticators, otherwise asked for once more (Chrome gives none at
  // creation). Nothing has reached the host yet, so a passkey without PRF is refused with the old one still in place.
  // The trip's seat keys are wrapped with the new passkey's output too when this browser holds them. That is asked after the
  // passkey is on the seat (below), where the same ceremony is also the check PATCH keys needs.
  const seats = Boolean(seat);
  let next = memo && prfOf(credential), privateKey: string | undefined;
  if (memo && !next) {
    const again = await api("passkey/challenge", "POST", {});
    const made = await navigator.credentials.get({ publicKey: { challenge: unb64(again.challenge), rpId: again.rpId, userVerification: "required", allowCredentials: [{ id: credential.rawId, type: "public-key" }], extensions: prfAsk } }) as PublicKeyCredential | null;
    next = made ? prfOf(made) : undefined;
  }
  if (memo) { if (!next) throw new Error(noPrf); privateKey = await wrapMemoKey(memo, await wrappingKey(next, id!), id!); }
  try { await api("passkey", "POST", { challenge, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.getAuthenticatorData()), publicKey: b64(key), algorithm: r.getPublicKeyAlgorithm(), ...(check ? { check } : {}), ...(privateKey ? { privateKey } : {}) }); }
  catch (err) { throw check && (err as Error).message === "パスキーで本人確認してください" ? new Error(`${(err as Error).message}。この旅行に登録した今のパスキーを選んでください。今のパスキーを失った場合は、オーナーに失効と再招待を頼んでください。`) : err; }
  if (privateKey && next) { view.privateKey = privateKey; await unlock(next); }
  // The host dropped what the old passkey wrapped; this seat's pair is wrapped again with the new passkey's output.
  // The host dropped what the old passkey wrapped; this seat's pair is wrapped again with the new passkey's output.
  if (view.seatKey) delete view.seatKey.secret;
  let sealFailed = false;
  if (seats) try { await sealSeatKeys(next ?? await prfAssertion(credential.rawId)); } catch { sealFailed = true; }
  const again = view.passkey; view.passkey = true; if (dialog.open) dialog.close(); render();
  notice(`${again ? "この端末のパスキーに登録し直しました。前に登録したパスキーでは戻れなくなります。" : "パスキーを登録しました。ブラウザのデータを消しても「パスキーで戻る」から同じ席に戻れます。"}${view.role === "owner" ? "招待の発行や削除などの前の本人確認にも使います。" : view.role === "editor" ? "招待の発行・失効の前の本人確認にも使います。" : ""}${sealFailed ? "旅行の鍵をこのパスキーで包めませんでした。鍵はこの端末にだけあります。もう一度登録し直すと包めます。" : ""}`);
}
// The check the host asks for before an owner's important action. A browser without a passkey registers one, which counts as the check.
// An owner who lost the passkey gets the owner invite moved to another browser by whoever published the trip (spec「2.3 Grant（招待）と Session（メンバー）」).
const lostPasskey = "パスキーを失ったときは、旅行を発行した人にオーナー招待の差し替え（aws/recover.ts）を頼み、新しい端末で開いてください。";
async function stepUp() {
  if (!passkeys) throw new Error(`この操作はパスキーの使えるブラウザ（Safari・Chrome）で行ってください。${lostPasskey}`);
  if (!view.passkey) {
    if (!confirm("この操作には、この端末でのパスキー（Face ID・指紋）の確認が要ります。パスキーを登録して続けますか？")) throw new Error("この操作にはパスキーでの本人確認が必要です");
    return registerPasskey();
  }
  const { challenge, rpId } = await api("passkey/challenge", "POST", {});
  const credential = await navigator.credentials.get({ publicKey: { challenge: unb64(challenge), rpId, userVerification: "required" } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("この操作にはパスキーでの本人確認が必要です");
  const r = credential.response as AuthenticatorAssertionResponse;
  try { await api("passkey/verify", "POST", { challenge, id: credential.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) }); }
  catch (err) { throw new Error(`${(err as Error).message}。この旅行に登録したパスキーを選んでください。${lostPasskey}`); }
}
async function passkeyLogin() {
  const { challenge, rpId } = await api("passkey/challenge", "POST", {});
  // No allowCredentials: the passkey is discoverable, so a PC can offer the phone's passkey through the OS's QR code.
  const credential = await navigator.credentials.get({ publicKey: { challenge: unb64(challenge), rpId, userVerification: "required", extensions: prfAsk } }) as PublicKeyCredential | null;
  if (!credential) return;
  const r = credential.response as AuthenticatorAssertionResponse;
  await api("passkey/session", "POST", { challenge, id: credential.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) });
  joinSecret = ""; history.replaceState(null, "", location.pathname); await reload();
  // The same check opens the seat's memo key in this browser; one it cannot open is left for 「パスキーで読む」.
  const prf = prfOf(credential);
  if (prf) {
    const seat = await restoreSeat(prf).then(() => Boolean(tripKey), () => false), memo = Boolean(view.privateKey) && await unlock(prf).then(() => true, () => false);
    if (seat || memo) { await openAll(); render(); await rekeyIfDue(); }
  }
}
// Cancelling the OS dialog is not an error worth a red banner.
const passkeyError = (err: unknown) => (err as Error).name === "NotAllowedError" ? notice("パスキーの操作を中止しました。") : notice((err as Error).message, true);
// A creator makes new trips from this page and reads none. Unlike a member's, a creator's passkey is required: the enrollment
// link does nothing in a browser that cannot make one. The OS lists it as the creator's, next to any trip passkeys.
async function creatorRegister() {
  // The link is checked again here, so one used up since the screen opened stops before the OS dialog.
  const { challenge, rpId } = await api("/v1/creators/challenge", "POST", { secret: creatorSecret });
  // A delegation link is redeemed under its trip, where this browser's owner seat goes with the request (#108).
  const register = creatorCapsule ? `/v1/c/${creatorCapsule}/creators/register` : "/v1/creators/register";
  const credential = await navigator.credentials.create({ publicKey: { challenge: unb64(challenge), rp: { id: rpId, name: "旅のカプセル" }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "旅のカプセルの作成者", displayName: "旅のカプセルの作成者" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none" } }) as PublicKeyCredential | null;
  if (!credential) return;
  const r = credential.response as AuthenticatorAttestationResponse;
  if (typeof r.getPublicKey !== "function" || typeof r.getAuthenticatorData !== "function" || !r.getPublicKey()) throw new Error("このブラウザのパスキーには対応していません。別のブラウザをお試しください");
  creatorPasskey.set("");
  await api(register, "POST", { secret: creatorSecret, challenge, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.getAuthenticatorData()), publicKey: b64(r.getPublicKey()!), algorithm: r.getPublicKeyAlgorithm() });
  // Taken on a trip's page, the page goes to the top afresh: what it holds of the trip (its id, its view and the reading of it every
  // 20 seconds) must not stay under the creator's top page. The top page then shows the new creator's card.
  creatorPasskey.set(credential.id); creatorSecret = "";
  if (creatorCapsule) return location.replace("/");
  history.replaceState(null, "", "/"); await creationHome();
  notice("作成者として登録しました。この端末から新しい旅行を作れます。次からは「作成者としてサインイン」から入れます。");
}
// The creator's passkey this browser last signed in with. It names no secret; it only narrows a check to that one passkey.
// It is let go before the cookie changes and written after, so a write that fails leaves none (the next check asks to press
// again), never another creator's.
const creatorPasskey = { get: () => { try { return localStorage.getItem("creator-passkey") ?? ""; } catch { return ""; } }, set: (v: string) => { try { localStorage.removeItem("creator-passkey"); if (v) localStorage.setItem("creator-passkey", v); } catch { /* none kept */ } } };
// Signing in is also how a creator checks again before replacing the key or handing over or deleting a trip (#748).
async function creatorSignIn(only = "") {
  const { challenge, rpId } = await api("/v1/creators/challenge", "POST", {});
  const credential = await navigator.credentials.get({ publicKey: { challenge: unb64(challenge), rpId, userVerification: "required", ...(only ? { allowCredentials: [{ id: unb64(only), type: "public-key" as const }] } : {}) } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("この操作にはパスキーでの本人確認が必要です");
  const r = credential.response as AuthenticatorAssertionResponse;
  creatorPasskey.set("");
  await api("/v1/creators/session", "POST", { challenge, id: credential.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) });
  creatorPasskey.set(credential.id);
}
// A phone may hold two creators' passkeys. The action is sent again only when the check could offer this creator's passkey
// alone; otherwise signing in as the other would send it as them. Then the creator signs in and presses again.
async function creatorCheck() {
  const only = creatorPasskey.get();
  await creatorSignIn(only);
  if (!only) { await creationHome(); throw new Error("サインインし直しました。もう一度操作してください。"); }
}
async function creatorLogin() { await creatorSignIn(); await creationHome(); }
// A creator's right reads no trip, so a saved trip needs an owner, and the creator chooses who: this browser, or whoever opens
// the owner link (another device of theirs, or another person). There is no default. Until chosen, the link lives in this page only.
const ownerOptions = (here = "この端末をオーナーにする") => `<div class="admin-actions">${button(here, "claim-owner", "primary")}${button("オーナーリンクを受け取る", "owner-link", "secondary")}</div><p class="muted">オーナーリンクは、別の端末や別の人に渡すときに使います。最初に開いた1台がオーナーになり、3日以内に開く必要があります。</p><p class="muted">${later()}</p>`;
// A creator's trip nobody owns stays listed on the creator's home until an owner is chosen (#320). The local server keeps no creators.
const later = () => localOnly ? "選ばずに閉じると、この旅行にはオーナーを決められません。" : "選ばずに閉じても、トップの「オーナーを決めていない旅行」からあとで決められます。";
// Closing the dialog by its button, Escape or the back gesture asks first; once the creator agrees, the link is let go.
function leaveOwnerless() {
  if (!unclaimed) return true;
  if (!confirm(`オーナーを選ばずに閉じますか？${localOnly ? "閉じると、この旅行にはオーナーを決められなくなります。" : "トップの「オーナーを決めていない旅行」からあとで決められます。"}`)) return false;
  unclaimed = undefined; return true;
}
dialog.addEventListener("cancel", event => { if (!leaveOwnerless()) event.preventDefault(); });
// A save whose answer was lost is sent again with the same operation id, so the host makes the trip once and, while nobody holds
// the owner seat, hands back a fresh owner link (spec「2.6 作成者（新しい旅行を作る人）と旅行の owner」). The id stays with this tab until an owner is chosen; a changed draft is
// another trip and gets another id.
function operationFor(body: string) {
  let h = 2166136261; for (let i = 0; i < body.length; i++) h = Math.imul(h ^ body.charCodeAt(i), 16777619);
  const fingerprint = (h >>> 0).toString(16);
  try { const kept = JSON.parse(sessionStorage.getItem("publish-operation") ?? "null") as { id: string; fingerprint: string } | null; if (kept?.fingerprint === fingerprint) return kept.id; } catch { /* none kept */ }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem("publish-operation", JSON.stringify({ id, fingerprint })); } catch { /* private browsing: a retry after reloading is a new trip */ }
  return id;
}
function settled() { try { sessionStorage.removeItem("publish-operation"); } catch { /* nothing kept */ } }
function chooseOwner(saved = true) { modal("この旅行のオーナーを決めてください", `<p>${saved ? "旅行を保存しました。" : ""}作成者の権利では旅行を開けないので、オーナーを決めます。</p>${ownerOptions()}`); }
async function claimOwner() {
  const { id: trip, secret } = unclaimed!;
  try { await api(`/v1/c/${trip}/sessions`, "POST", { secret }); }
  catch (err) { modal("この端末をオーナーにできませんでした", `<p>旅行は保存されています。${e((err as Error).message)}</p>${ownerOptions("もう一度試す")}`); return; }
  unclaimed = undefined; settled(); if (dialog.open) dialog.close();
  app.innerHTML = '<main class="empty"><h1>保存しました。旅行を開いています…</h1></main>'; location.href = `/c/${trip}`;
}
// The link is never shown: it goes to the clipboard, to be opened on the other device. Safari keeps the tap's permission to write
// the clipboard only if the write starts before the request returns, hence the promise handed to ClipboardItem. The host asks for
// a passkey of this creator in the same request, so that promise covers the OS's passkey check too. With `ownerOf`, the link is a
// delegation one (#108): for that trip's owner, to become a creator of their own.
async function creatorAddDevice(ownerOf?: string) {
  const link = (async () => {
    const { challenge, rpId } = await api("/v1/creators/challenge", "POST", {});
    const credential = await navigator.credentials.get({ publicKey: { challenge: unb64(challenge), rpId, userVerification: "required" } }) as PublicKeyCredential | null;
    if (!credential) throw new Error("この操作にはパスキーでの本人確認が必要です");
    const r = credential.response as AuthenticatorAssertionResponse;
    // The OS lists trip passkeys next to the creator's; a trip's picked by mistake is refused, so say which one to pick.
    try { return (await api("/v1/creators/enroll", "POST", { confirm: true, ...(ownerOf ? { ownerOf } : {}), challenge, id: credential.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) })).url as string; }
    catch (err) { throw (err as Error).message === "パスキーで本人確認してください" ? new Error("パスキーで本人確認できませんでした。作成者として登録したパスキーを選んでください") : err; }
  })();
  try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": link.then(u => new Blob([u], { type: "text/plain" })) })]); }
  catch { await link; try { await navigator.clipboard.writeText(await link); } catch { throw new Error("リンクをコピーできませんでした。もう一度押してください"); } }
  notice(ownerOf ? "委任リンクをコピーしました（画面には表示しません）。その旅行のオーナーの端末で、1日以内に開いてもらってください。1回だけ使えます。" : "登録リンクをコピーしました（画面には表示しません）。1日以内に、追加する端末の既定のブラウザで開いてください。1回だけ使えます。");
}
// `capsule`: a delegation link, opened on that trip's page. Only the browser holding its owner seat may take it, so another is
// stopped before the OS makes a passkey that nothing will accept.
async function creatorEnrollScreen(secret: string, capsule = "") {
  creatorSecret = secret; creatorCapsule = capsule;
  const title = capsule ? "作成権限を受け取る" : "作成者として登録する";
  const able = passkeys && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
  // A used or expired link must not get as far as the OS making a passkey that nothing will accept.
  // 401 is a used or expired link, 400 one cut short on the way; anything else (a busy minute) says so and leaves the link alone.
  const refused = await api("/v1/creators/challenge", "POST", { secret }).then(() => "", (err: { status?: number; message: string }) => [400, 401].includes(err.status ?? 0) ? "この登録リンクは使用済みか、期限（1日）が切れているか、途中で切れています。この端末ではパスキーを作りません。" : `${err.message}。しばらくしてから、このページを開き直してください。`)
    || (capsule ? await api(`/v1/c/${capsule}`).then((v: { role?: string }) => v.role === "owner" ? "" : "この旅行のオーナーだけが受け取れます。この端末ではパスキーを作りません。", () => "この旅行のオーナーの端末で開いてください。この端末ではパスキーを作りません。") : "");
  if (refused) { app.innerHTML = `<header class="topbar"><a class="brand" href="/">旅のカプセル</a></header><main class="empty"><h1>${title}</h1><p class="warning">${e(refused)}</p><p>${capsule ? "リンクが使えないときは、作成権限を分けた作成者に新しい委任リンクを依頼してください。" : "リンクが使えないときは、作成者を登録した人に新しい登録リンクを依頼してください。作成者の方が別の端末を足すときは、サインインしたトップ画面の「別の端末を追加」から新しいリンクを作れます。"}</p><a class="button secondary" href="/">トップへ</a></main>`; return; }
  app.innerHTML = `<header class="topbar"><a class="brand" href="/">旅のカプセル</a></header><main class="empty"><h1>${title}</h1><p>${capsule ? "この旅行のオーナーとして、新しい旅行を作る権利を受け取ります。この端末でパスキーを作ると作成者になります。作成者の権利では、誰の旅行の中身も読めません。" : "この端末でパスキーを作ると、この端末から新しい旅行を作れるようになります。作成者の権利では、誰の旅行の中身も読めません。作った旅行は、保存したときに、この端末をオーナーにするか、オーナーのリンクを受け取って別の端末・別の人に渡すかを選びます。"}</p>${able ? `${button("この端末でパスキーを作る", "creator-register", "primary")}<p class="muted">登録リンクは1回だけ使えます。パスキーを作れなかったときは、リンクはそのまま使えます。</p>` : '<p class="warning">この端末ではパスキーを作れないため、作成者になれません。スマホの既定のブラウザ（Safari・Chrome）で開き直してください。</p>'}</main>`;
}
// Trips this browser has joined. Holds no secret: the HttpOnly cookie is still required, this only lets the top page link back.
function saved(): Joined[] { try { return JSON.parse(localStorage.getItem("capsules") ?? "[]") as Joined[]; } catch { return []; } }
function joined(): Joined[] { const gone = expiredIn(saved(), Date.now()); return saved().filter(t => !gone.includes(t.id)); }
// The rows past their deletion stay until the top page forgets them with their keys (forgetTrip): dropped here, their keys would stay.
function remember(update: (list: Joined[]) => Joined[]) { try { localStorage.setItem("capsules", JSON.stringify(update(saved()).slice(-30))); } catch { /* private browsing: bookmark is the only way back */ } }
// What this browser put here for one trip: its memo key and seat keys, the setting to leave footprints, and its row in the list.
async function forgetTrip(trip: string) {
  await keyStore("readwrite", s => s.delete(trip)).catch(() => undefined);
  await keyStore("readwrite", s => s.delete(`seat:${trip}`)).catch(() => undefined);
  try { localStorage.removeItem(`auto-footprint:${trip}`); } catch { /* private browsing: nothing was kept */ }
  remember(list => list.filter(t => t.id !== trip));
  if (held?.trip === trip) held = undefined;
  if (heldSeat?.trip === trip) heldSeat = undefined;
  if (trip === id) { tripKey = undefined; tripKeyFrom = ""; }
}
// A sealed trip is listed on this browser by its plain dates only: its title stays out of localStorage (spec「5.3 暗号化した旅行で Host にできないこと」).
async function reload() { await load(); if (id) remember(list => [...list.filter(t => t.id !== id), { id, title: view.sealed ? "暗号化した旅行" : view.spec.title, startsOn: view.spec.trip.startsOn, endsOn: view.spec.trip.endsOn, purgeAt: view.spec.lifecycle.purgeAt }]); }
// The page a trip opens on is chosen once, on the first load: a press of a tab, a reload or the 20-second refresh keeps the one shown.
async function load() {
  loads++;
  view = id ? await api() : { ...await api("/v1/preview"), role: "owner", state: "draft" }; stale = false;
  await openAll(); await openSealed();
  if (!opened && !locked) { opened = true; tab = firstPage(pageModules(), view.state); }
  render();
  await rekeyIfDue();
}
// A seat that held the key is gone (revoked, its invite rotated or revoked, or past its invite's end): the owner's browser
// replaces the key at once (spec「5.5 旅行の鍵を替える」), on reading the trip and on taking the key back with the passkey. Once a page: a failure is told
// and tried again on the next opening.
async function rekeyIfDue() {
  if (view.rekey === "auto" && view.role === "owner" && tripKey && !rekeying && !rekeyFailed) {
    rekeying = true;
    try { await rekeyTrip(); } catch (err) { rekeyFailed = true; notice((err as Error).message, true); } finally { rekeying = false; }
  }
  // After the owner invite was handed over or replaced (/recover), the new owner holding the key is asked once a page whether to
  // replace it: a person who only changed devices need not; one who gave the old device away or handed the trip over should.
  if (view.rekey === "ask" && view.role === "owner" && tripKey && !rekeyAsked) {
    rekeyAsked = true;
    modal("鍵を替えますか", `<p>前のオーナーの端末で読める鍵のままです。鍵を替えますか。同じ人が端末を替えただけなら、替えなくてかまいません。古い端末を手放す・別の人に渡したなら替えてください。</p><div class="admin-actions">${button("鍵を替える", "rekey", "primary")}${button("替えない", "rekey-keep", "secondary")}</div>`);
  }
}
let rekeyAsked = false;
// The trip key replaced with the next generation by this owner's browser (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」): the trip as the host holds
// it opened with the present key and sealed again with a new one (resealAll), the new key wrapped to every seat this seat reaches
// by the edges and signed by this seat, all in one POST rekey. A seat not reached takes the key again by the codes. Another
// member's change meanwhile (409) is read again once; a second one stops.
let rekeying = false, rekeyFailed = false;
async function rekeyTrip() {
  for (let attempt = 0; ; attempt++) {
    const raw = await api() as Omit<View, "footprints"> & { footprints: Array<{ id: string; point: string; by: string }> }, k = raw.seatKey, secret = await seatSecret();
    if (!id || !raw.sealed || !k || !raw.self || !secret || !await owns(secret, k)) throw new Error("この端末には旅行の鍵がありません");
    const grants = await api("grants") as Array<{ id: string; label: string; members: Array<{ id: string; label: string }> }>;
    const old = await unwrapTripKey(k.wrapped, k.ephemeral, secret.x25519, id, k.generation, true), key = await newTripKey(), generation = raw.sealed.generation + 1;
    const sealed = await resealAll(old, key, id, generation, { spec: raw.spec as unknown as SealedSpec, document: raw.document as unknown as SealedDocument, footprints: raw.footprints.map(p => ({ id: p.id, point: p.point, by: p.by })), media: raw.media, members: grants.flatMap(g => g.members).map(m => ({ id: m.id, label: m.label })), grants: grants.map(g => ({ id: g.id, label: g.label })) });
    const seats = raw.seats ?? [], reached = await reachableSeats({ id: raw.self.id, ed25519: k.ed25519 }, seats, id);
    // This seat's own wrap goes to the key it just showed it holds, not to the one the list names.
    const to = seats.filter(s => reached.has(s.id)).map(s => s.id === raw.self!.id ? { ...s, x25519: k.x25519 } : s);
    const wraps = await Promise.all(to.map(async s => { const w = await wrapTripKey(key, s.x25519, id, generation); return { seat: s.id, ...w, signature: await signRekey(secret.ed25519, { capsuleId: id, generation, seat: s.id, x25519: s.x25519, ...w }) }; }));
    try { await api("rekey", "POST", { generation, ...sealed, seats: wraps, confirm: true }, raw.document.revision); }
    catch (err) { if ((err as { status?: number }).status === 409 && attempt === 0) continue; throw (err as { status?: number }).status === 409 ? new Error("鍵を替えられませんでした。開き直してください") : err; }
    await keepGeneration(generation); await reload();
    const left = seats.length - to.length;
    notice(left ? `旅行の鍵を替えました。${left} 人は確認コードで鍵を受け取り直します。` : "旅行の鍵を替えました。");
    return;
  }
}
// A sealed trip (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」, docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」) is opened here, once, right after it is read: the rest of the screen draws the
// plain trip as before. What did not open or did not pass the plain shape is left out and counted (`unreadable`). The opened words
// live in `view` only, never in IndexedDB or localStorage. `locked`: why the plan cannot be shown on this browser.
let locked = "", sealedNow: { spec: SealedSpec; document: SealedDocument } | undefined;
async function openSealed() {
  locked = ""; view.unreadable = []; sealedNow = undefined;
  if (!view.sealed) return;
  if (!tripKey) { view.footprints = []; locked = keyRefused ? unverifiedKey : "オーナーかメンバーから鍵を受け取ってください"; return; }
  const t = await openTrip(tripKey, id!, view as unknown as { spec: SealedSpec; document: SealedDocument });
  if (!t) { view.footprints = []; locked = "旅程を開けません（旅行の鍵が合いません）"; return; }
  // The ciphertext as the host sent it, kept for a revise or an undo: a record left as it was is sent back as it came (resealTrip).
  sealedNow = { spec: view.spec as unknown as SealedSpec, document: view.document as unknown as SealedDocument };
  view.spec = t.spec; view.document = t.document; view.unreadable = t.unreadable;
  view.footprints = await openFootprints(view.footprints ?? []);
  if (view.label !== undefined && view.self) view.label = await nameOf("member", view.self.id, view.label);
  for (const w of view.waiting ?? []) w.label = await nameOf("member", w.id, w.label);
  if (view.role === "owner" && !namesSealed) { namesSealed = true; void sealNames(); }
}
// A name in a sealed trip (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」, the `Session`, `Grant` and `Audit` rows): a seat's or an invite's,
// opened with the trip's key. One that is not ciphertext is the host's own (「自分用」「招待リンク」「オーナー」「メンバー3」) and
// shows as it is. Every name the screen shows of a sealed trip goes through here: invites, members, who issued, the history
// and the seats waiting for the key.
async function nameOf(kind: "member" | "grant", rid: string, value: string) {
  if (!view.sealed) return value;
  return (tripKey && await openName(tripKey, id!, kind, rid, value)) ?? "（開けない名前）";
}
// The names the host gave the seats (「オーナー」「メンバー3」) are put back sealed by the owner's browser (spec「5.2 暗号化するもの・平文に残すもの」), once a page and
// whenever 招待とメンバー is opened, through members PATCH as a rename. A failure says nothing: the next opening tries again.
// One pass at a time, each reading the names afresh, and a rename waits for the pass under way (`namesSealing`): a pass
// holding names it read before must not put a seat's default name back over the owner's rename.
const sealedForm = /^v1\.[1-9][0-9]{0,5}\.[A-Za-z0-9_-]+$/;
let namesSealed = false, namesSealing: Promise<void> = Promise.resolve();
function sealNames() {
  return namesSealing = namesSealing.then(async () => {
    if (!view.sealed || view.role !== "owner" || !tripKey) return;
    const grants = await api("grants").catch(() => []) as Array<{ members: Array<{ id: string; label: string }> }>;
    for (const m of grants.flatMap(g => g.members).filter(m => !sealedForm.test(m.label))) {
      try { await api("members", "PATCH", { id: m.id, label: await sealName(tripKey, id!, view.sealed.generation, "member", m.id, m.label) }); } catch { /* next time */ }
    }
  });
}
// What a sealed trip sends as a name: sealed against its seat or invite. A plain trip's goes as it is.
const nameFor = async (kind: "member" | "grant", rid: string, name: string) => view.sealed && tripKey ? sealName(tripKey, id!, view.sealed.generation, kind, rid, name) : name;
const newGrantId = () => crypto.randomUUID().replaceAll("-", "");
// A sealed trip's footprints (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」, the footprint row), opened into the shape the plain trip's come in,
// so the map, the list, the narrowing and `autoDue` draw them as before. One that does not open or is out of range (spec「5.3 暗号化した旅行で Host にできないこと」) is left
// out and counted in `unreadable`, never drawn somewhere false. The opened points live in `view` only.
async function openFootprints(list: HostFootprint[]): Promise<Footprint[]> {
  if (!view.sealed) return list as Footprint[];
  const out: Footprint[] = [];
  for (const p of list) {
    const point = "point" in p && tripKey ? await openPoint(tripKey, id!, p.id, p.point) : null, by = point && await openName(tripKey!, id!, "footprint", p.id, p.by);
    if (point && by) out.push({ id: p.id, at: p.at, ...point, by, mine: p.mine, auto: p.auto });
    else if (!view.unreadable?.includes(`footprint/${p.id}`)) view.unreadable = [...view.unreadable ?? [], `footprint/${p.id}`];
  }
  return out;
}
// Every footprint this browser leaves goes through here. A sealed trip's is checked against the range, then sealed under the
// trip's key against an id chosen here, with this seat's name then as `by` (spec「5.2 暗号化するもの・平文に残すもの」「5.3 暗号化した旅行で Host にできないこと」); the host checks the rest.
async function sendFootprint(point: PlainPoint, auto?: true): Promise<Footprint[]> {
  const add = (body: object) => api("footprints", "PATCH", { type: "add", ...body, ...auto && { auto } }) as Promise<{ footprints: HostFootprint[] }>;
  if (!view.sealed) return (await add(point)).footprints as Footprint[];
  if (!tripKey) throw new Error("この端末には旅行の鍵がありません");
  if (!pointSchema.safeParse(point).success) throw new Error("位置を確認してください");
  const fid = crypto.randomUUID().replaceAll("-", ""), generation = view.sealed.generation;
  const me = (view.self && await openName(tripKey, id!, "member", view.self.id, view.self.label)) || "（名前なし）";
  return openFootprints((await add({ id: fid, point: await sealPoint(tripKey, id!, generation, fid, point), by: await sealName(tripKey, id!, generation, "footprint", fid, me) })).footprints);
}
// Every change to the trip's document goes through here. A sealed trip's is the same plain operation, checked and sealed under
// the trip's key just before it is sent (spec「5.3 暗号化した旅行で Host にできないこと」): a word the plain trip would refuse is refused here, before anything leaves.
async function sendOperation(op: unknown) {
  if (!view.sealed) return api("document", "PATCH", op);
  if (!tripKey) throw new Error("この端末には旅行の鍵がありません");
  let sealed: unknown;
  try { sealed = await sealOperation(tripKey, id!, view.sealed.generation, op, view.document); }
  catch (err) { throw plainError(err); }
  return api("document", "PATCH", sealed);
}
// What the plain check before sealing said: its own Japanese words, or the host's for a plain trip when zod's default is English.
const plainError = (err: unknown) => { const said = (err as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? (err as Error).message; return new Error(/[^\x00-\x7f]/.test(said) ? said : "入力内容を確認してください"); };
// A list one of whose records this browser could not open is not edited as a whole: saving it would drop that record.
const whole = (kind: "checklist" | "budget" | "notes") => !view.unreadable?.some(u => u.startsWith(`${kind}/`));
// Every entry of this seat opened with this browser's memo key; without the key, none can be.
async function openAll() {
  await ensureTripKey();
  const key = await memoKey().catch(() => undefined);
  plain = new Map(await Promise.all(own().map(async p => [p.id, key ? await openEntry(key, p) : null] as const)));
}
// A creator's own Anthropic API key makes the host write the trip from a wish (POST /v1/assist). The key is only ever sent, never shown back.
let assistKey = false;
const assistCard = () => assistKey
  ? `<div class="card" data-assist-card><h2>ここで作る</h2><p>行き先・日程・人数・やりたいことを書くと、あなたの Anthropic API キーで旅程を作ります。できた旅程は、貼り付けたときと同じ画面で確認できます。確認して保存するまでは、旅行として残りません。</p><label>希望<textarea data-assist rows="5" placeholder="行き先・日程・人数・やりたいことを書いてください"></textarea></label><div class="admin-actions">${button("旅程を作る", "assist-run", "primary")}${button("API キーを削除", "assist-key-delete", "quiet danger-text")}</div><ul class="paste-problems assist-problems" hidden></ul><p class="muted">書いた希望は Anthropic に送られます。本名・予約番号は書かないでください。費用はあなたの Anthropic アカウントに請求されます。30 日使わないと、鍵はこのホストから自動で削除します。</p></div>`
  : `<div class="card" data-assist-card><h2>ここで作る</h2><p>あなたの Anthropic API キーで、この画面から旅程を作れます。費用はあなたの Anthropic アカウントに請求されます。鍵はこのホストに暗号化して保存し、画面には二度と表示しません。30 日使わないと、鍵はこのホストから自動で削除します。</p><form data-form="assist-key"><label>Anthropic API キー<input name="key" type="password" autocomplete="off" required placeholder="sk-ant-…"></label><button class="primary">鍵を登録</button></form></div>`;
async function creationHome() {
  for (const trip of expiredIn(saved(), Date.now())) await forgetTrip(trip);
  const account = await api("/v1/account"); canCreate = account.canCreate ?? account.signedIn; localOnly = account.localOnly; creatorLabel = account.creator?.label ?? ""; const creator = account.creator as { delegated?: boolean; delegates?: Array<{ id: string; label: string; device: string; created: number }> } | null; assistKey = Boolean(account.assistKey);
  const today = new Date().toISOString().slice(0, 10);
  const unowned: Array<{ id: string; title: string; startsOn: string; endsOn: string; purgeAt: string }> = creatorLabel ? await api("/v1/creators/trips", "POST", {}).catch(() => []) : [];
  app.innerHTML = `<header class="topbar"><a class="brand" href="/">旅のカプセル</a></header><main><section class="content"><span class="eyebrow">YOUR PRIVATE TRIP</span><h1>旅ごとに、<br>小さなしおりを。</h1><p>公開ページには誰の旅行も載せません。作成した旅行は、招待した人とだけ共有できます。</p>${joined().length ? `<div class="card"><h2>この端末で参加中の旅行</h2><div class="grant-list">${joined().reverse().map(t => `<div class="grant"><div><strong>${e(t.title)}</strong><small>${e(t.startsOn)}〜${e(t.endsOn)}</small></div><a class="button secondary" href="/c/${t.id}">開く</a></div>`).join("")}</div></div>` : ""}${!canCreate ? `<div class="card"><p>旅行のしおりは、受け取った招待リンクから開いてください。アカウント登録は不要です。</p></div><div class="card"><h2>旅行を作る方へ</h2>${passkeys ? `<p>作成者として登録済みの方は、パスキーでサインインしてください。</p><div class="admin-actions">${button("作成者としてサインイン", "creator-login", "secondary")}</div>` : '<p class="muted">このブラウザではパスキーが使えないため、作成者としてサインインできません。</p>'}</div>` : `${creatorLabel ? `<div class="card"><p>作成者: <strong>${e(creatorLabel)}</strong></p><p class="muted">作った旅行は、保存したときに、この端末をオーナーにするか、オーナーのリンクを受け取って別の端末・別の人に渡すかを選びます。</p><div class="admin-actions">${button("別の端末を追加", "creator-add-device", "quiet")}${button("サインアウト", "creator-signout", "quiet")}</div>${creator?.delegated === false ? `<hr><h3>作成権限を分ける</h3><p class="muted">旅行のオーナーに、新しい旅行を作る権利を分けられます。分けた人はさらに分けられず、作成者の権利では誰の旅行の中身も読めません。委任リンクは画面に表示せず、コピーします。</p><label>作成権限を渡す旅行の URL<input data-delegate-trip inputmode="url" placeholder="その旅行のページの URL"></label><div class="admin-actions">${button("委任リンクをコピー", "creator-delegate", "quiet")}</div>` : ""}${creator?.delegates?.length ? `<h3>分けた作成者</h3><div class="grant-list">${creator.delegates.map(d => `<div class="grant"><div><strong>${e(d.label)}</strong><small>${e(d.device)} · ${e(new Date(d.created).toLocaleDateString("ja-JP"))}</small></div>${button("失効", "creator-revoke-delegate", "quiet danger-text", `data-id="${e(d.id)}" data-title="${e(d.label)}"`)}</div>`).join("")}</div>` : ""}</div>` : ""}${unowned.length ? `<div class="card"><h2>オーナーを決めていない旅行</h2><p class="muted">保存したあと、オーナーを選ばずに閉じた旅行です。オーナーを決めるまで誰も開けません。削除予定日を過ぎると自動で消えます。「オーナーを決める」を押すと、前に受け取ったオーナーリンクは使えなくなります。</p><div class="grant-list">${unowned.map(t => `<div class="grant"><div><strong>${e(t.title)}</strong><small>${e(t.startsOn)}〜${e(t.endsOn)} · 削除予定 ${e(t.purgeAt.slice(0, 10))}</small></div><div>${button("オーナーを決める", "unowned-owner", "secondary", `data-id="${t.id}"`)}${button("削除", "unowned-purge", "quiet danger-text", `data-id="${t.id}" data-title="${e(t.title)}"`)}</div></div>`).join("")}</div></div>` : ""}<form data-form="create" class="card"><h2>新しい旅行を作成</h2>${localOnly ? '<p class="warning">開発用のローカル環境です。外部公開はしていません。</p>' : ""}<label>旅行のタイトル<input name="title" required maxlength="160" placeholder="週末の旅行"></label><label>行き先<input name="destination" required maxlength="160" placeholder="行き先を入力"></label><div class="form-grid"><label>初日<input name="start" type="date" required value="${today}"></label><label>最終日<input name="end" type="date" required value="${today}"></label></div><button class="primary">空のしおりを確認</button></form>${assistCard()}<div class="card"><h2>チャットで作って、貼り付ける</h2><p>「作り方をコピー」を押して、ChatGPTなどの使い慣れたアプリに貼り、旅行の希望を伝えてください。返ってきた答えを、前後の文ごとそのまま下に貼れます。</p><div class="admin-actions">${button("作り方をコピー", "copy-recipe", "secondary")}</div><label>チャットの返事<textarea data-paste rows="5" placeholder="返事をそのまま貼ってください（前後の文が混ざっていても大丈夫です）"></textarea></label><div class="admin-actions">${button("内容を確認する", "check-paste", "primary")}</div><ul class="paste-problems" hidden></ul><p class="muted">貼った内容は、確かめるためにこのサーバーへ送りますが、確認して保存するまでは残しません。本名・予約番号が混ざっていないか、取り込み前に確かめてください。</p><hr><h3>ファイルから取り込む</h3><label>旅程ファイル<input type="file" accept="application/json,.json" data-import="trip"></label></div>`}</section></main>`;
}
const unverifiedKey = "新しい鍵を確かめられません。オーナーかメンバーから鍵を受け取り直してください";
const lastKey = "鍵を持つメンバーが他にいないため、交換すると旅程をだれも読めなくなります。先に別の端末かメンバーに鍵を渡してください";
// Whether this browser holds the trip's key (#689). The plan is still plain; a seat that has none waits for another seat's hand-over.
const keyStatus = () => !id || view.state === "draft" ? ""
  : tripKey ? `<span data-trip-key="held">この端末に鍵がある</span>`
  : keyRefused ? `<span data-trip-key="unverified">${unverifiedKey}</span>${button("鍵を受け取る", "receive-key", "quiet")}`
  : view.seatKey && !(view.sealed && view.seatKey.generation !== view.sealed.generation) ? `<span data-trip-key="missing">この端末には旅行の鍵がありません</span>`
  : view.role !== "owner" || view.keyed ? `<span data-trip-key="waiting">鍵を待っています。鍵を持つメンバーと確認コードを伝え合うと受け取れます</span>${button("鍵を受け取る", "receive-key", "quiet")}` : "";
// Seats that wait for the key, shown to a seat that holds it (any role): each with 「渡す」.
const handoffWaiting = () => tripKey && view.waiting?.length ? view.waiting.map(w => `<span data-handoff-waiting="${e(w.id)}">${e(w.label)}が鍵を待っています</span>${button("渡す", "give-key", "quiet", `data-id="${e(w.id)}" data-label="${e(w.label)}"`)}`).join("") : "";
const editor = () => view.role === "owner" || view.role === "editor";
// Every role keeps entries of its own, a viewer too, until sharing ends (the role table does not apply to them).
const mine = () => Boolean(id) && (view.state === "active" || view.state === "reflection");
const own = () => view.private ?? [];
const editable = () => view.state !== "draft" && view.state !== "frozen" && view.state !== "purged" && view.role !== "viewer";
function allowed(type: "suggest" | "comment" | "check" | "reflect") {
  if (!editable()) return false;
  if (view.state === "reflection" && !editor() && type !== "reflect") return false;
  return editor() || type === "reflect" || view.spec.collaboration[type === "suggest" ? "participantSuggestions" : type === "comment" ? "participantComments" : "participantChecklist"];
}
const map = (name: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
const button = (label: string, action: string, cls = "", attrs = "") => `<button class="${cls}" data-action="${action}" ${attrs}>${e(label)}</button>`;
const dateLabel = (s: string) => new Intl.DateTimeFormat("ja", { timeZone: "UTC", month: "numeric", day: "numeric", weekday: "short" }).format(new Date(s));
function days() { const a = []; for (let d = new Date(view.spec.trip.startsOn); d.toISOString().slice(0, 10) <= view.spec.trip.endsOn && a.length < 181; d.setUTCDate(d.getUTCDate() + 1)) a.push(d.toISOString().slice(0, 10)); return a; }
const clock = (at: number | string, zone: string) => new Intl.DateTimeFormat("ja", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
// A time the host placed, or one nobody has decided yet, reads "10:30 ごろ". Only an item nobody has timed since it was published has none.
function time(i: Item) { return i.startsAt ? `${clock(i.startsAt, i.timezone ?? view.spec.timezone)}${i.timeTentative ? " ごろ" : ""}` : "時間未定"; }
// On the day's cards and lines an item with an end reads "10:30 – 12:00" ("10:30 – 12:00 ごろ" for a placeholder).
function span(i: Item) { return i.startsAt && i.endsAt ? `${clock(i.startsAt, i.timezone ?? view.spec.timezone)} – ${clock(i.endsAt, i.timezone ?? view.spec.timezone)}${i.timeTentative ? " ごろ" : ""}` : time(i); }
// Between an item and the ones before it: an overlap marks the item when it starts before the latest end of those, five minutes or
// more free from that end is shown before it (`gapBefore`). Items without a time are looked past; nothing free is shown when one
// before without an end starts at or after that end. Only shown; nothing is moved for it. A cancelled item is not waited for, and is marked by nothing.
const overlap = (items: Item[], k: number) => (gapBefore(items, k) ?? 0) < 0 ? '<span class="badge overlap">前の予定と重なっています</span>' : "";
function spare(items: Item[], k: number, tag: "div" | "li") {
  const g = gapBefore(items, k); if (g === undefined || g < 5 * 60000) return "";
  const m = Math.round(g / 60000), h = Math.floor(m / 60);
  return `<${tag} class="gap">空き ${h ? `${h} 時間${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分`}</${tag}>`;
}
function links(i: Item) { return i.place ? `<div class="links"><a href="${e(map(i.place.label))}" target="_blank" rel="noopener noreferrer">地図 ↗</a>${https(i.place.publicUrl) ? `<a href="${e(i.place.publicUrl!)}" target="_blank" rel="noopener noreferrer">お店・詳細 ↗</a>` : ""}</div>` : ""; }
// The grip is the only part of a row that starts a drag (touch-action: none in the stylesheet); the rest of the row scrolls the page as before.
// Each shared item has separate shared and personal insertion targets, outside its row.
const insert = (i: Item) => `<div class="insert-actions">${editor() && editable() ? button("＋ 共有", "insert-item", "insert", `data-after="${e(i.id)}" aria-label="${e(i.title)}の後に共有予定を追加"`) : ""}${mine() ? button("＋ 自分だけ（試験機能）", "insert-private-item", "insert", `data-after="${e(i.id)}" aria-label="${e(i.title)}の後に自分だけの予定を追加（試験機能）"`) : ""}</div>`;
const handle = (i: Item) => `<button class="drag-handle" data-drag aria-label="${e(i.title)}の順番を動かす" title="ドラッグ、または上下の矢印キーで動かす">⠿</button>`;
function timeline() {
  const all = days(); if (!all.includes(selectedDay)) selectedDay = all[0]!;
  const heading = view.spec.presentation?.dayHeadings.find(d => d.day === selectedDay)?.title ?? `${dateLabel(selectedDay)}の予定`;
  const sortable = editor() && editable(), items = view.document.items.filter(i => i.day === selectedDay);
  // This seat's own plans go among the shared items by time: each before the first shared one that starts later. They take no part
  // in the free time and overlaps, which are the group's (another member would see a gap that is not there), and are never dragged.
  const plans = own().filter(p => p.kind === "item" && p.day === selectedDay), at = (t?: string) => t === undefined ? Infinity : +new Date(t);
  const locked = own().filter(p => p.kind === "item" && !plain.get(p.id)).length;
  const slot = (p: PrivateEntry) => items.findIndex(i => at(i.startsAt) > at(p.startsAt)), before = (k: number) => plans.filter(p => slot(p) === k), rest = plans.filter(p => slot(p) < 0);
  // The photos go under the shared items by the time they were taken (src/moments.ts), worked out each time the day is drawn.
  const linked = linkPhotos(view.document.items, view.media ?? [], view.spec), early = linked.beforeFirst.get(selectedDay);
  const count = (i: Item) => { const n = linked.byItem.get(i.id)?.length; return n ? `<span class="row-photos" aria-label="写真 ${n} 枚">📷 ${n}</span>` : ""; };
  return `<div class="day-tabs">${all.map((d, i) => button(`DAY ${i + 1}　${dateLabel(d)}`, "day", d === selectedDay ? "selected" : "", `data-day="${d}" aria-pressed="${d === selectedDay}"`)).join("")}</div>
    <div class="section-heading"><div><span class="eyebrow">DAY ${all.indexOf(selectedDay) + 1}</span><h2>${e(heading)}</h2></div>${`<div class="admin-actions">${editor() && editable() ? button("＋ 共有の予定", "new-item", "secondary") : ""}${mine() ? button("＋ 自分だけの予定（試験機能）", "new-private-item", "secondary") : ""}</div>`}</div>
    <div class="view-toggle" role="group" aria-label="表示">${(["detail", "list"] as const).map(v => button(v === "detail" ? "詳細" : "リスト", "timeline-view", "", `data-view="${v}" aria-pressed="${timelineView === v}"`)).join("")}</div>
    <p class="muted">「決定」は会話で合意した予定です。予約の有無はそれぞれのメモを確認してください。</p>
    ${locked ? `<p class="private-locked">自分だけの予定のうち ${locked} 件は、この端末では読めません。</p>` : ""}
    ${timelineView === "list" && (items.length || plans.length) ? `<ol class="timeline-list" ${sortable ? `data-order-day="${selectedDay}"` : ""}>${items.map((i, k) => `${before(k).map(privateRow).join("")}${spare(items, k, "li")}<li class="row ${i.status}" ${sortable ? `data-item="${e(i.id)}"` : ""}>${sortable ? handle(i) : ""}<button data-action="open-item" data-id="${e(i.id)}"><span class="row-time">${e(span(i))}</span><span class="row-title">${e(i.title)}</span>${count(i)}${overlap(items, k)}${i.status !== "confirmed" ? `<span class="badge ${i.status}">${statusNames[i.status]}</span>` : ""}</button></li>${sortable || mine() ? `<li class="insert-row">${insert(i)}</li>` : ""}`).join("")}${rest.map(privateRow).join("")}</ol>` : `<div class="timeline" ${sortable ? `data-order-day="${selectedDay}"` : ""}>${early ? `<section class="photos-before" data-photos-before><h3>予定の前</h3>${photoStrip(early)}</section>` : ""}${items.map((i, k) => `${before(k).map(privateCard).join("")}${spare(items, k, "div")}<article class="event ${i.status}" id="item-${e(i.id)}" ${sortable ? `data-item="${e(i.id)}"` : ""}><div class="event-time">${e(span(i))}<small>${kindNames[i.kind]}</small>${sortable ? handle(i) : ""}</div><div class="event-content"><div class="card-top"><span class="badge ${i.status}">${statusNames[i.status]}</span>${overlap(items, k)}${editor() && editable() ? button("編集", "edit-item", "quiet", `data-id="${i.id}"`) : ""}</div><h3>${e(i.title)}</h3><p>${e(i.description ?? "")}</p>${links(i)}${photoStrip(linked.byItem.get(i.id))}</div></article>${sortable || mine() ? insert(i) : ""}`).join("")}${rest.map(privateCard).join("")}${items.length || plans.length ? "" : '<p class="empty">この日の予定はまだありません。</p>'}</div>`}
    ${privateTools()}`;
}
// A plan of this seat's own: marked 自分だけ, opened to edit; no grip, no "＋", no status (it is nobody else's to agree to).
const privateTime = (p: PrivateEntry) => p.startsAt ? `${clock(p.startsAt, view.spec.timezone)}${p.endsAt ? ` – ${clock(p.endsAt, view.spec.timezone)}` : ""}` : "時間未定";
const privateNotice = '<p class="warning">試験機能です。機微な情報は入力しないでください。</p>';
const privateProtection = "このサービスに保存した題・本文・場所は暗号化され、同行者・オーナー・サービスの運用者には読めません。日付・時刻などは暗号化されません。機微な情報を安心して保管できることを保証するものではありません。この席のパスキーで鍵をかけます。パスキーを失うと、あなたにも読めなくなります。";
const privateBadge = '<span class="badge private">自分だけ</span><span class="badge">試験機能</span>', unreadable = "この端末では読めません";
// The link is checked again as it is shown: the host cannot look inside the sealed place.
const https = (u?: string) => { try { return !!u && new URL(u).protocol === "https:"; } catch { return false; } };
function privateLinks(p: PlainEntry) { return p.place ? `<div class="links"><a href="${e(map(p.place.label))}" target="_blank" rel="noopener noreferrer">地図 ↗</a>${https(p.place.publicUrl) ? `<a href="${e(p.place.publicUrl!)}" target="_blank" rel="noopener noreferrer">お店・詳細 ↗</a>` : ""}</div>` : ""; }
// One this browser cannot open stays where its plain date and time put it, marked the same, its words replaced (spec「5.6 自分だけの予定・日記の鍵」).
const privateCard = (p: PrivateEntry) => { const x = plain.get(p.id); return `<article class="event private${x ? "" : " locked"}" id="private-${e(p.id)}"><div class="event-time">${e(privateTime(p))}<small>自分だけ</small></div><div class="event-content"><div class="card-top">${privateBadge}${mine() || !x ? button(x ? "編集" : "開く", "edit-private", "quiet", `data-id="${e(p.id)}"`) : ""}</div><h3>${e(x ? x.title : unreadable)}</h3>${x ? `<p>${e(x.body)}</p>${privateLinks(x)}` : ""}</div></article>`; };
const privateRow = (p: PrivateEntry) => { const x = plain.get(p.id); return `<li class="row private${x ? "" : " locked"}"><button data-action="open-private" data-id="${e(p.id)}"><span class="row-time">${e(privateTime(p))}</span><span class="row-title">${e(x ? x.title : unreadable)}</span>${privateBadge}</button></li>`; };
// The memories tab lists the selected day's diary, with an inline form like shared memories.
function diary(day: string) {
  const all = days(); if (!all.includes(day)) day = all.includes(selectedDay) ? selectedDay : all[0]!;
  diaryDay = day;
  const written = own().filter(p => p.kind === "diary" && p.day === day).sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  const candidate = editingDiaryId ? plain.get(editingDiaryId) : undefined, existing = candidate?.kind === "diary" ? candidate : undefined;
  if (!existing) editingDiaryId = "";
  const locked = own().filter(p => p.kind === "diary" && !plain.get(p.id)).length;
  if (!mine() && !own().length) return "";
  return `<section class="card diary"><h3>自分の日記（試験機能）</h3>${privateNotice}<p class="muted">自分だけに保存します。${privateProtection}</p><label>日記の日付<select data-diary-day aria-label="日記の日付">${all.map(d => `<option value="${d}" ${d === day ? "selected" : ""}>${dateLabel(d)}</option>`).join("")}</select></label>${locked ? `<p class="private-locked">自分の日記のうち ${locked} 件は、この端末では読めません。</p>` : ""}${mine() ? `<form data-form="private" class="entry-form" data-id="${e(existing?.id ?? crypto.randomUUID())}"><input name="kind" type="hidden" value="diary"><label>日付<input name="day" type="date" required min="${view.spec.trip.startsOn}" max="${view.spec.trip.endsOn}" value="${existing?.day ?? day}"></label><label>本文<textarea name="body" required maxlength="4000" rows="3">${e(existing?.body ?? "")}</textarea></label><div class="admin-actions"><button class="primary">保存する</button>${existing ? button("編集をやめる", "cancel-diary", "quiet", 'type="button"') : ""}</div></form>` : ""}${written.map(p => { const x = plain.get(p.id); return `<article class="diary-entry${x ? "" : " locked"}">${!x ? `<strong>${unreadable}</strong>` : x.title ? `<strong>${e(x.title)}</strong>` : ""}${x ? `<p class="entry-body">${e(x.body)}</p>${privateLinks(x)}` : ""}${mine() || !x ? `<div class="admin-actions">${button(x ? "編集" : "開く", "edit-private", "quiet", `data-id="${e(p.id)}"`)}${mine() ? button("削除", "remove-private", "quiet danger-text", `data-id="${e(p.id)}"`) : ""}</div>` : ""}</article>`; }).join("") || '<p class="empty">この日の日記はまだありません。</p>'}${privateTools()}</section>`;
}
function privateTools() {
  if (!mine() && !own().length) return "";
  return `<div class="private-tools"><div class="admin-actions">${mine() ? button("チャットで直す（試験機能）", "revise-private", "quiet") : ""}${own().some(p => plain.get(p.id)) ? button("自分のメモを保存 ↓", "save-private", "quiet") : ""}</div>${own().length && !own().some(p => plain.get(p.id)) ? '<p class="muted">この端末では自分のメモを読めないため保存できません。</p>' : ""}</div>`;
}
// Personal plans use the shared plan form's date/time suggestion, with the existing sealed save handler.
function privatePlanForm(existing?: PlainEntry, place?: { day: string; after?: string }) {
  const items = view.document.items, after = place?.after && items.some(i => i.id === place.after) ? place.after : undefined;
  const at = after ? items.findIndex(i => i.id === after) + 1 : items.length;
  const probe = place && [...items.slice(0, at), { id: "", title: "", day: place.day, kind: "activity", status: "proposed", revision: 1 } as Item, ...items.slice(at)];
  const offered = probe ? placeholder(probe, at, view.spec.timezone) : undefined;
  const start = existing?.startsAt ? clock(existing.startsAt, view.spec.timezone) : offered !== undefined ? clock(offered, view.spec.timezone) : "";
  modal(existing ? "自分だけの予定を編集" : "自分だけの予定を追加", `<form data-form="private" data-id="${e(existing?.id ?? crypto.randomUUID())}"><input type="hidden" name="kind" value="item">${privateNotice}<p class="muted">${privateProtection}</p><label>タイトル<input name="title" required maxlength="160" value="${e(existing?.title ?? "")}"></label><div class="form-grid"><label>日付<input name="day" type="date" required min="${view.spec.trip.startsOn}" max="${view.spec.trip.endsOn}" value="${existing?.day ?? place?.day ?? selectedDay}"></label><label>開始時刻<input name="time" type="time" required value="${start}"></label></div><label>本文<textarea name="body" maxlength="4000" rows="5">${e(existing?.body ?? "")}</textarea></label><div class="admin-actions"><button class="primary">保存する</button>${existing ? button("削除", "remove-private", "quiet danger-text", `type="button" data-id="${e(existing.id)}"`) : ""}</div></form>`);
}
// An entry this browser cannot open offers the passkey that can, and removing it: sealed words cannot be edited (spec「5.6 自分だけの予定・日記の鍵」).
// After sharing ends the host refuses every change to them, removing too, so 削除 is offered only while they can be written.
function lockedPrivate(p: PrivateEntry) {
  const remove = mine() ? button("削除", "remove-private", "quiet danger-text", `data-id="${e(p.id)}"`) : "";
  modal(unreadable, view.passkey && passkeys ? `<p>このメモは、この席のパスキーで開くと読めます。</p><div class="admin-actions">${button("パスキーで読む", "read-private", "primary")}${remove}</div>`
    : `<p>この席のパスキーが無いため、自分だけのメモは読むことも書くこともできません。${mine() ? "削除はできます。" : ""}新しい端末で続けるには、オーナーに失効と再招待を頼んでください（今のメモは消えます）。</p><div class="admin-actions">${remove}</div>`);
}
// The Markdown is made here from what this browser opened: the host keeps ciphertext only. The file is handed over as a download.
function savePrivateMarkdown() {
  const opened = own().map(p => plain.get(p.id)).filter((x): x is PlainEntry => Boolean(x));
  const text = privateMarkdown(view.spec, opened, own().length - opened.length, new Date().toISOString());
  download(text, "text/markdown;charset=utf-8", `trip-${view.spec.trip.startsOn}-private.md`);
}
function download(text: BlobPart, type: string, name: string) {
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([text], { type })); link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
async function savePrivate(op: unknown) { await api("private", "PATCH", op); if (dialog.open) dialog.close(); await reload(); notice("保存しました。"); }
// A member's own entries revised with a chat (#427): the text is made here from what this browser opened, and the answer is
// checked and compared here, then sealed and applied all at once. The host sees ciphertext only; the chat sees what is copied.
const readable = () => own().map(p => plain.get(p.id)).filter((x): x is PlainEntry => Boolean(x));
let revisingPrivate: ReturnType<typeof privateDiff> | undefined;
function privateRevise() {
  const locked = own().length - readable().length; revisingPrivate = undefined;
  modal("自分の予定・日記をチャットで直す", `${privateNotice}<p class="warning">コピーした文はチャットのサービスに渡り、そのサービスには読めます。運用者に読めないのはこのサービスの中に置いたものだけです。</p><p>自分だけの予定・日記（この端末で読めるもの）と直し方に、共有の予定の日付・時刻・題を参考として付けてコピーします。同行者の自分だけのメモは含みません。</p>${locked ? `<p>この端末で読めない ${locked} 件は含めず、反映しても消えません。</p>` : ""}<h3>1. チャットに渡す</h3><label>直してほしいこと（任意）<textarea data-revise-request maxlength="2000" rows="3" placeholder="例: 2日目の朝にランニングを足して、3日目の日記を短くする"></textarea></label><p class="muted">書くと、コピーする文の最初に付きます。空のままコピーして、チャットで書いても構いません。</p><div class="admin-actions">${button("自分の予定・日記と直し方をコピー", "copy-revise-private", "primary")}</div><hr><h3>2. チャットの返事を貼る</h3><label>チャットの返事<textarea data-revise-paste rows="5" placeholder="返事をそのまま貼ってください（前後の文が混ざっていても大丈夫です）"></textarea></label><div class="admin-actions">${button("差分を見る", "revise-private-check", "primary")}</div><ul class="paste-problems" hidden></ul><div class="revise-diff" hidden></div><p class="muted">差分を見て反映するまで、自分の予定・日記は変わりません。</p>`);
}
function checkPrivateRevise() {
  const field = dialog.querySelector<HTMLTextAreaElement>("[data-revise-paste]"), out = dialog.querySelector<HTMLElement>(".revise-diff"); if (!field || !out) return;
  out.hidden = true; revisingPrivate = undefined; problems([]);
  const taken = takePrivate(field.value, view.spec);
  if (!taken.ok) { problems(taken.messages); notice("貼った内容を確認してください。", true); return; }
  const d = privateDiff(readable(), taken.entries);
  // The entries this browser cannot read stay, so they count towards the hundred too.
  if (own().length - d.removed.length + d.added.length > 100) { problems(["自分の予定・日記は 100 件までです（この端末で読めない分も数えます）。減らすようにチャットに頼んでください。"]); notice("貼った内容を確認してください。", true); return; }
  revisingPrivate = d;
  const named = (x: PlainEntry) => `${x.day} ${x.kind === "item" ? `${x.startsAt ? clock(x.startsAt, view.spec.timezone) + " " : ""}${x.title}` : `日記 ${x.title || x.body.slice(0, 30)}`}`;
  const rows = ([["追加", d.added], ["変更", d.changed], ["削除", d.removed]] as const).filter(([, list]) => list.length).map(([label, list]) => `<h4>${label}（${list.length} 件）</h4><ul>${list.map(x => `<li>${e(named(x))}</li>`).join("")}</ul>`).join("");
  out.innerHTML = !rows ? "<p>今の自分の予定・日記から変わるところはありません。</p>" : `<h3>反映すると変わるところ</h3>${rows}<form data-form="revise-private"><button class="primary">反映する</button></form>`;
  out.hidden = false; out.scrollIntoView({ block: "start", behavior: "smooth" });
}
function entries(type: "suggest" | "comment" | "reflect") {
  const list = type === "suggest" ? view.document.suggestions : type === "comment" ? view.document.comments : view.document.reflections;
  // An owner or editor may change the words of a 候補・相談 post or take it out; who wrote it is not recorded, so not the writer.
  const posts = type === "suggest" ? "suggestions" : "comments", change = (v: { id: string }) => type !== "reflect" && editor() && editable() ? button("直す", "rewrite-post", "quiet", `data-list="${posts}" data-id="${v.id}"`) + button("消す", "remove-post", "quiet danger-text", `data-list="${posts}" data-id="${v.id}"`) : "";
  const cards = list.map(v => `<article class="card"><p class="entry-body">${e(v.body)}</p><div class="card-bottom"><small>${e(v.author)} · ${dateLabel(v.createdAt.slice(0, 10))}</small><div>${type === "suggest" && "promoted" in v ? v.promoted ? '<span class="badge confirmed">旅程に追加済み</span>' : editor() && editable() ? button("旅程に追加", "promote", "quiet", `data-id="${v.id}"`) : "" : ""}${type === "reflect" && "included" in v && editor() ? button(v.included ? "✓ 旅行記に含める" : "旅行記に含める", "include", "quiet", `data-id="${v.id}" data-included="${!v.included}" ${!editable() ? "disabled" : ""}`) : ""}${change(v)}</div></div></article>`).join("");
  return `${allowed(type) ? `<form data-form="entry" data-type="${type}" class="card entry-form"><label>表示名 <input name="author" required maxlength="80" autocomplete="nickname" placeholder="あなたの名前"></label><label>${type === "suggest" ? "行きたい場所・提案" : type === "comment" ? "相談・ひとこと" : "旅の思い出"}<textarea name="body" required maxlength="4000" rows="3" placeholder="みんなに共有したいことを書こう"></textarea></label><button class="primary">${type === "suggest" ? "候補を追加" : "投稿する"}</button></form>` : ""}${cards || '<p class="empty">まだ投稿はありません。</p>'}`;
}
// Diaries remain reachable even when an older Spec did not put memories in navigation.
// This is only a screen entry; never add it to the stored Spec. The synthetic ID cannot collide with Spec IDs.
// Footprints are such a page too, for a trip whose Spec has no trip-map page (one made before #439): the kind exists on the screen
// only, never in a Spec. With a trip-map page, that page is where footprints are left, seen and removed (#583), and no second page is added.
function pageModules() {
  const { modules, navigation } = view.spec;
  const pages: Array<{ id: string; kind: Spec["modules"][number]["kind"] | "footprints"; label: string }> = navigation.map(n => modules.find(m => m.id === n)!)
    // Without photos on (the operator's switch) and none put up, the page is not shown.
    .filter(m => m.kind !== "moments" || photosPageShown(view));
  if (!pages.some(m => m.kind === "reflection")) pages.push(modules.find(m => m.kind === "reflection") ?? { id: ":memories", kind: "reflection", label: "旅の思い出" });
  if (!pages.some(m => m.kind === "trip-map")) pages.push({ id: ":footprints", kind: "footprints", label: "足あと" });
  return pages;
}
// The pages drawn from the footprints, redrawn when a point comes or goes (footprints move no revision).
const onFootprints = () => tab === ":footprints" || ["trip-map", "story"].includes(pageModules().find(m => m.id === tab)?.kind ?? "");
// A footprint is left during the trip by all but a viewer, as the host allows (src/cloud-host.ts).
function canStep() {
  const today = localDay(Date.now(), view.spec.timezone);
  return Boolean(id) && view.role !== "viewer" && view.state === "active" && today >= view.spec.trip.startsOn && today <= view.spec.trip.endsOn;
}
// The trip's story (src/story.ts), each day's plans with the time a footprint first came in their time and the points no plan covers.
// A line to look back on, not to edit: the shape of the day tab's list, without its buttons.
function storyPage() {
  const zone = view.spec.timezone, points = view.footprints ?? [], at = (p: Point) => clock(p.at, zone);
  const row = (x: StoryEntry) => x.kind === "unplanned"
    ? `<li class="row unplanned"><span class="row-time">${at(x.point)}</span><span class="row-title">予定になかったところ · ${e(x.point.by)}</span><a class="button quiet" href="${map(`${x.point.lat},${x.point.lng}`)}" target="_blank" rel="noopener noreferrer">地図 ↗</a></li>`
    : x.recorded ? `<li class="row"><span class="row-time">予定 ${e(time(x.item))} / 記録 ${at(x.recorded)}</span><span class="row-title">${e(x.item.title)}</span></li>`
    : `<li class="row plan-only"><span class="row-time">${e(time(x.item))}</span><span class="row-title">${e(x.item.title)}</span></li>`;
  const days = [...story(view.document.items, points, view.spec)].map(([day, entries]) => `<section class="card story"><h3>${dateLabel(day)}</h3><ol class="timeline-list">${entries.map(row).join("")}</ol></section>`).join("");
  return `<h2>旅の記録</h2><p class="muted">予定と、足あとから分かった実際の時刻を並べます。『記録』はその予定の時間帯の最初の足あとの時刻です。</p>${points.length ? "" : '<p class="muted">まだ足あとがありません。旅行期間中に足あとのページの『ここにいる』を押すと、予定の横に実際の時刻が出ます。</p>'}${days || '<p class="empty">まだ予定がありません。</p>'}`;
}
// One fix of this browser's position. Refused, it says why and how to allow it; nothing is sent.
function here(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }));
}
// A browser with the <geolocation> element (Chrome) asks again for a refused position when the member presses it (#675); it
// keeps the button while the position is allowed or not yet asked, since the element's words and look are the browser's (#760).
// The others keep the button, and a refusal there is put right in the browser's site settings. The one place the two are told apart.
const canPlaceElement = "HTMLGeolocationElement" in window;
const unplaced = (err: unknown) => (err as GeolocationPositionError).code === 1
  ? canPlaceElement ? "位置の許可がありません。「ここにいる」の横の位置のボタンを押して、許可し直してください。" : "位置の許可がありません。ブラウザのサイト設定でこのページの位置情報を「許可」にしてから、もう一度押してください。"
  : "位置を取得できませんでした。空の見える所で、もう一度押してください。";
// `given` is the fix the <geolocation> element handed over; without it the position is asked for here.
async function leaveFootprint(given?: GeolocationPosition) {
  if (!given && !("geolocation" in navigator)) return notice("このブラウザでは位置を使えません。", true);
  let position: GeolocationPosition;
  try { position = given ?? await here(); } catch (err) { return notice(unplaced(err), true); }
  const { latitude: lat, longitude: lng, accuracy } = position.coords;
  // Tenths of a kilometre rounded up, so that a fix just over the limit never reads as 約1.0 km.
  if (accuracy > 1000) return notice(`位置の精度が低い（約${(Math.ceil(accuracy / 100) / 10).toFixed(1)} km）ため残しませんでした。もう一度押してください。`, true);
  await sendFootprint({ lat, lng, accuracy }); await reload(); notice("足あとを残しました。");
}
// Turning it on is the one time the position is asked for: opening the page later only uses a permission already given.
// Nothing is left now; the next opening is the first.
async function switchAutoFootprint(box: HTMLInputElement) {
  if (box.checked) {
    if (!("geolocation" in navigator)) { box.checked = false; return notice("このブラウザでは位置を使えません。", true); }
    try { await here(); } catch (err) { box.checked = false; return notice(unplaced(err), true); }
  }
  autoStep = box.checked;
  try { if (autoStep) localStorage.setItem(`auto-footprint:${id}`, "1"); else localStorage.removeItem(`auto-footprint:${id}`); } catch { /* private browsing: on as long as the page */ }
  if (autoStep) notice("次に旅行のページを開いた時から、足あとを自動で残します。");
}
// As the page opens or comes back into view on a device that turned it on: one point, when this member's last one (pressed or
// not) is 15 minutes or 300 m away (src/footprints.ts). It never asks for the position, and says nothing when it leaves none —
// no one pressed anything, and a refused or blurred fix or the host's 403 / 429 is nothing the member can put right from here.
let autoStepping = false;
async function autoFootprint() {
  if (!autoStep || autoStepping || !view || !canStep() || document.visibilityState !== "visible" || !navigator.permissions || !("geolocation" in navigator)) return;
  autoStepping = true;
  try {
    if ((await navigator.permissions.query({ name: "geolocation" })).state !== "granted") return;
    const { latitude: lat, longitude: lng, accuracy } = (await here()).coords;
    if (accuracy > 1000) return;
    const latest = await api() as View;
    // Turned off or hidden while the fix or the read was on its way: nothing is sent.
    if (!autoStep || document.visibilityState !== "visible") return;
    if (!autoDue((await openFootprints(latest.footprints ?? [])).filter(p => p.mine).at(-1), Date.now(), { lat, lng })) return;
    view.footprints = await sendFootprint({ lat, lng, accuracy }, true);
    if (onFootprints() && !app.querySelector("form") && !dialog.open) render();
  } catch { /* left unsaid, as above */ } finally { autoStepping = false; }
}
// The footprints page (#480, #439, #583): 「ここにいる」 and the switch for leaving one on opening (during the trip, for all but a
// viewer), then every member's footprints as dots over the map of the host's own origin (#563: src/map.ts, loaded as the map is
// first shown), with `showTrack` each member's dots joined in time order where src/footprints.ts does not cut the line, and under
// the map the same footprints as rows by the day they were left on, oldest first: who and when (自動 for one left on opening), the
// map in a new tab as an item's, and 消す. Narrowed by day and member, map and rows alike. Dots in the same cell of 0.0001° (about
// 10 m) are one dot (src/footprints.ts `spotsOf`), which shows every footprint in it with the plan going on then.
// The Spec's trip-map page draws it; a trip without that page (one made before #439, whose Spec is kept as it was) has it as the
// screen's 足あと page.
function tripMap(track: boolean) {
  const zone = view.spec.timezone, all = footprints(view.footprints ?? []).points, dayOf = (p: Point) => localDay(+new Date(p.at), zone);
  const head = `<h2>足あと</h2><p class="muted">「ここにいる」を押した時刻と場所を、この旅行のメンバー全員に共有します。旅行期間中だけ残せます。</p>${canStep() ? `<div class="admin-actions">${canPlaceElement ? `<span data-geo-button>${button("ここにいる", "footprint-here", "primary")}</span><span data-geo-place hidden><span class="muted">ここにいる</span><geolocation data-action="footprint-element"></geolocation></span>` : button("ここにいる", "footprint-here", "primary")}</div>${canPlaceElement ? '<p class="muted" data-geo-denied hidden>位置の許可がありません。「ここにいる」の横の位置のボタンを押して、許可し直してください。</p>' : ""}<label class="check"><input type="checkbox" data-action="auto-footprint"${autoStep ? " checked" : ""}><span>開いたときに足あとを残す</span></label><p class="muted">この端末だけ。旅行のページを開いた時と画面に戻った時に、前の自分の足あとから 15 分以上たったか 300 m 以上動いていれば残します。画面を閉じている間は残りません。</p>` : ""}`;
  // The items with a position, cancelled ones not (#646); the host reads a place's coordinates as the chat gave them.
  const plans = view.document.items.filter(i => i.status !== "cancelled" && i.place?.lat !== undefined && i.place.lng !== undefined);
  if (!all.length && !plans.length) return `${head}<p class="empty">まだ足あとはありません。</p>${canStep() ? "" : '<p class="muted">旅行期間中にメンバーが「ここにいる」を押すと、ここに地図と一覧が出ます。</p>'}`;
  const days = [...new Set([...all.map(dayOf), ...plans.map(i => i.day)])].sort(), people = [...new Set(all.map(p => p.by))];
  if (!days.includes(mapDay)) mapDay = ""; if (!people.includes(mapBy)) mapBy = "";
  const choice = (action: string, value: string, label: string, current: string) => button(label, action, "", `data-value="${e(value)}" aria-pressed="${current === value}"`);
  const show = (key: "plans" | "footprints", label: string) => button(label, "map-show", "", `data-value="${key}" aria-pressed="${mapShow[key]}"`);
  const kinds = plans.length ? `<div class="view-toggle" role="group" aria-label="表示">${show("plans", "予定")}${show("footprints", "足あと")}</div>` : "";
  const filters = `<div class="map-filters">${kinds}<div class="view-toggle" role="group" aria-label="日">${choice("map-day", "", "全日程", mapDay)}${days.map(d => choice("map-day", d, dateLabel(d), mapDay)).join("")}</div>${all.length ? `<div class="view-toggle" role="group" aria-label="メンバー">${choice("map-by", "", "全員", mapBy)}${people.map(b => choice("map-by", b, b, mapBy)).join("")}</div>` : ""}</div>`;
  const showPlans = mapShow.plans, showFootprints = mapShow.footprints || !plans.length;
  const shown = showFootprints ? all.filter(p => (!mapDay || dayOf(p) === mapDay) && (!mapBy || p.by === mapBy)) : [], shownIds = new Set(shown.map(p => p.id));
  const shownPlans = showPlans ? plans.filter(i => !mapDay || i.day === mapDay) : [];
  if (!shown.length && !shownPlans.length) return `${head}${filters}<p class="empty">${!showFootprints && !showPlans ? "表示するものがありません。" : "この日のこの人の予定・足あとはありません。"}</p>`;
  // The lines are drawn on the map's canvas; `data-lines` says how many points each joins, for a reader of the page (verify:ui).
  mapData = { spots: spotsOf(shown), lines: track ? footprints(shown).lines : [], plans: shownPlans.map(i => ({ id: i.id, lat: i.place!.lat!, lng: i.place!.lng!, label: i.title })) };
  const note = track ? '<p class="muted">線は同じ人の足あとを時刻の順に結んだもので、実際に通った道ではありません。3 時間以上あいた区間と、飛行機・新幹線のような速い移動は線を切っています。</p>' : "";
  // Each footprint is a row of the kind the member list uses: who and when on the left, the map and 消す on the right.
  const removable = (p: Footprint) => (p.mine || editor()) && Boolean(id) && view.state !== "frozen" && view.state !== "purged", byDay = new Map<string, Footprint[]>();
  for (const p of view.footprints ?? []) if (shownIds.has(p.id)) { const day = dayOf(p); byDay.set(day, [...byDay.get(day) ?? [], p]); }
  const list = [...byDay].map(([day, ps]) => `<section class="card footprints"><h3>${dateLabel(day)}</h3><div class="grant-list">${ps.map(p => `<div class="grant" data-footprint="${e(p.id)}"><div><strong>${e(p.by)}</strong><small>${clock(p.at, zone)}${p.auto ? " · 自動" : ""}</small></div><div class="admin-actions"><a class="button quiet" href="${map(`${p.lat},${p.lng}`)}" target="_blank" rel="noopener noreferrer">地図 ↗</a>${removable(p) ? button("消す", "remove-footprint", "quiet danger-text", `data-id="${e(p.id)}"`) : ""}</div></div>`).join("")}</div></section>`).join("");
  return `${head}${filters}<div class="trip-map" data-map data-lines="${mapData.lines.map(l => l.length).join(" ")}" role="region" aria-label="足あとの地図"></div>${note}${list}`;
}
// Draws the map the page asks for, once src/map.ts is loaded. A page drawn again meanwhile has its own map to draw, so a
// container no longer on the page is left alone.
async function mountMap() {
  const el = document.querySelector<HTMLElement>("[data-map]"), data = mapData;
  if (!el || !data) return;
  const url = mapRetries ? `/map.js?retry=${mapRetries}` : "/map.js";   // Not bundled into app.js: fetched the first time a map is shown (aws/build.ts builds it apart).
  let showMap: typeof import("./map").showMap;
  // Not loaded (the connection dropped): the box says so, and the list under it still opens every dot.
  try { ({ showMap } = await import(url) as typeof import("./map")); } catch { el.innerHTML = `<p>地図を読み込めませんでした。下の一覧から見られます。</p>${button("もう一度", "map-retry")}`; return; }
  // Decided here, after tripMap() has dropped a narrowing whose points are gone, so a narrowing changed that way fits again too.
  const key = `${tab}|${mapDay}|${mapBy}|${mapShow.plans}|${mapShow.footprints}`;
  if (el.isConnected) { el.textContent = ""; unmountMap = showMap(el, data, spotDialog, planDialog, key === mapCameraKey ? mapCamera : undefined); mapCameraKey = key; }
}
// An item's mark on the map: its day and time, its title and place, and the map in a new tab.
function planDialog(id: string) {
  const i = view.document.items.find(x => x.id === id); if (!i) return;
  modal("予定", `<div class="grant-list"><div class="grant" data-plan-dialog="${e(i.id)}"><div><strong>${e(i.title)}</strong><small>${dateLabel(i.day)} ${time(i)}</small>${i.place ? `<small>${e(i.place.label)}</small>` : ""}</div>${links(i)}</div></div>`);
}
// The footprints of one dot: when, who, the item going on then (if any), and the map in a new tab.
function spotDialog(ids: string[]) {
  const zone = view.spec.timezone;
  modal("この地点の足あと", `<div class="grant-list">${(view.footprints ?? []).filter(p => ids.includes(p.id)).map(p => { const t = +new Date(p.at), item = itemAt(view.document.items, t, zone);
    return `<div class="grant" data-spot="${e(p.id)}"><div><strong>${e(p.by)}</strong><small>${dateLabel(localDay(t, zone))} ${clock(p.at, zone)}</small>${item ? `<small>予定: ${e(item.title)}</small>` : ""}</div><a class="button quiet" href="${map(`${p.lat},${p.lng}`)}" target="_blank" rel="noopener noreferrer">地図 ↗</a></div>`; }).join("")}</div>`);
}
// The photos page (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」, the photo rows). A photo is opened here and nowhere else: its sealed image is
// fetched, opened with the photo's own key (which the trip's key opens), walked by `inspectJpeg` again (any member could have put
// anything there, spec「5.3 暗号化した旅行で Host にできないこと」) and shown from a `blob:` URL, kept in `shownPhotos` until the photo is removed.
const shownPhotos = new Map<string, string>();
// A full-size image is made for the dialog that shows it and released when that closes: only the thumbnails, small and at most 500,
// are kept across redraws, and those of a photo no longer on the trip are released with each redraw of the page.
let openedDisplay = "", displayRun = 0;
const releasePhoto = (key: string) => { const url = shownPhotos.get(key); if (url) URL.revokeObjectURL(url); shownPhotos.delete(key); };
const photoRefused = "この写真は開けませんでした";
async function photoUrl(p: Shown, size: PhotoSize): Promise<string> {
  const held = size === "thumb" ? shownPhotos.get(`${p.id}/thumb`) : undefined; if (held) return held;
  if (!tripKey) throw new Error("この端末には旅行の鍵がありません");
  const res = await fetch(`/v1/c/${id}/media/${p.id}/${size}?ui=2`);
  if (!res.ok) throw new Error(photoRefused);
  const [edge, bytes] = size === "thumb" ? [PHOTO_LIMITS.thumbEdge, PHOTO_LIMITS.thumbBytes] : [PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes];
  const clean = inspectJpeg(await openPhotoImage(tripKey, id!, p.id, p.key, size, new Uint8Array(await res.arrayBuffer())), edge, bytes);
  const url = URL.createObjectURL(new Blob([clean.bytes as BlobPart], { type: "image/jpeg" }));
  if (size === "thumb") shownPhotos.set(`${p.id}/thumb`, url);
  return url;
}
// A thumbnail, and its caption once opened (mountPhotos), on the photos page and under the day's items alike.
const photoFigure = (p: Shown) => `<figure class="photo-figure"><button class="photo" data-action="photo-open" data-id="${e(p.id)}" aria-label="写真を開く"><img data-thumb="${e(p.id)}" alt="" width="${p.thumb.width}" height="${p.thumb.height}"></button>${p.caption ? `<figcaption data-caption="${e(p.id)}"></figcaption>` : ""}</figure>`;
const photoStrip = (list?: Shown[]) => list?.length ? `<div class="event-photos photo-grid">${list.map(photoFigure).join("")}</div>` : "";
// The captions this browser opened, by their ciphertext: a caption changed is a new one.
const openedCaptions = new Map<string, string>();
const captionOf = async (p: Shown) => {
  if (!p.caption || !tripKey) return "";
  const held = openedCaptions.get(p.caption); if (held !== undefined) return held;
  const text = await openField(tripKey, id!, "photo", p.id, "caption", p.caption).catch(() => "");
  openedCaptions.set(p.caption, text); return text;
};
// Anyone but a viewer adds photos, until sharing ends, and only to a trip this browser holds the key of.
const canUpload = () => photosUploadable(view, Boolean(tripKey));
function photosPage() {
  for (const key of [...shownPhotos.keys()]) if (!view.media?.some(p => key === `${p.id}/thumb`)) releasePhoto(key);
  // 「時刻の分からない写真」: those the day's tab has no place for (without a time, or taken outside the trip), and those without a
  // time that were put under an item by hand.
  const unlinked = linkPhotos(view.document.items, view.media ?? [], view.spec).unlinked, dated = photoDays((view.media ?? []).filter(p => !unlinked.includes(p)), view.spec.timezone);
  const days = dated.days, unknown = [...unlinked, ...dated.unknown];
  const group = (title: string, list: Shown[], attr = "") => `<section class="photo-day" ${attr}><h3>${e(title)}</h3><div class="photo-grid">${list.map(photoFigure).join("")}</div></section>`;
  const upload = canUpload() ? `<div class="admin-actions"><label class="button primary photo-upload">写真を上げる<input type="file" accept="image/jpeg,image/heic,image/*" multiple data-upload="photos"></label></div>`
    : !view.photos || view.sealed ? "" : `<p class="muted">この旅行はまだ暗号化されていないため、写真は上げられません。オーナーが旅行を暗号化すると使えます。</p>`;
  return `<h2>旅の写真</h2><p class="muted">旅行中の写真をみんなで。写真の位置は画像から消し、この旅行の中だけで使います。旅行の削除と一緒に消えます。</p><p class="muted">iPhone は写真を選ぶ画面で位置情報を含めると、地図に使えます。Android のブラウザから上げた写真には位置が付きません。</p>${upload}${days.map(d => group(dateLabel(d.day), d.photos, `data-photo-day="${e(d.day)}"`)).join("")}${unknown.length ? group("時刻の分からない写真", unknown, 'data-photo-day="unknown"') : ""}${(view.media ?? []).length ? "" : `<p class="muted" data-photos-empty>まだ写真はありません。</p>`}`;
}
// The thumbnails are fetched, opened and drawn as they come into view, a few at a time by the browser's own pace.
async function mountPhotos() {
  const frames = [...app.querySelectorAll<HTMLImageElement>("img[data-thumb]")]; if (!frames.length) return;
  const byId = new Map((view.media ?? []).map(p => [p.id, p]));
  for (const cap of app.querySelectorAll<HTMLElement>("figcaption[data-caption]")) { const p = byId.get(cap.dataset.caption!); if (p) void captionOf(p).then(text => { cap.textContent = text; }); }
  const show = async (img: HTMLImageElement) => {
    const p = byId.get(img.dataset.thumb!); if (!p) return;
    try { img.src = await photoUrl(p, "thumb"); } catch { img.replaceWith(Object.assign(document.createElement("span"), { textContent: photoRefused, className: "photo-refused" })); }
  };
  const seen = new IntersectionObserver(entries => { for (const en of entries) if (en.isIntersecting) { seen.unobserve(en.target); void show(en.target as HTMLImageElement); } }, { rootMargin: "300px" });
  for (const img of frames) seen.observe(img);
}
async function photoDialog(pid: string) {
  const p = view.media?.find(x => x.id === pid); if (!p) return;
  const zone = view.spec.timezone, at = +new Date(p.capturedAt ?? NaN);
  const when = Number.isFinite(at) ? `${dateLabel(localDay(at, zone))} ${clock(at, zone)}` : "撮影時刻の分からない写真";
  // Without a place of its own, the footprint nearest its time stands for where it was taken (src/moments.ts photoPlace).
  const place = photoPlace(p.location && tripKey ? await openPhotoLocation(tripKey, id!, p.id, p.location) : null, p.capturedAt, view.footprints ?? []);
  const caption = await captionOf(p), mayEdit = (p.mine || editor()) && editable();
  // The uploader, an owner or an editor chooses the item it goes under (or leaves it to its time) and writes its caption.
  const items = view.document.items.map(i => `<option value="${e(i.id)}" ${i.id === p.itineraryItemId ? "selected" : ""}>${e(`${dateLabel(i.day)} ${i.startsAt ? `${clock(i.startsAt, zone)} ` : ""}${i.title}`)}</option>`).join("");
  const edit = mayEdit ? `<form data-form="photo" data-id="${e(p.id)}" class="entry-form"><label>載せる予定<select name="item"><option value="">撮影時刻で自動</option>${items}</select></label>${tripKey ? `<label>一言（160 字まで）<input name="caption" maxlength="160" value="${e(caption)}"></label>` : ""}<button class="primary">保存する</button></form>` : "";
  modal("写真", `<div class="photo-view"><img data-display alt="" width="${p.width}" height="${p.height}"><small>${e(when)}</small>${place ? `<small><a href="${map(`${place.lat},${place.lng}`)}" target="_blank" rel="noopener noreferrer">撮影した場所を地図で見る${place.from === "footprint" ? "（近くの足あとから）" : ""}</a></small>` : ""}${caption ? `<p class="entry-body" data-photo-caption>${e(caption)}</p>` : ""}${edit}<div class="admin-actions">${p.mine || editor() ? button("消す", "photo-remove", "quiet danger-text", `data-id="${e(p.id)}"`) : ""}</div></div>`);
  const img = dialog.querySelector<HTMLImageElement>("img[data-display]")!, run = ++displayRun;
  try {
    const url = await photoUrl(p, "display");
    // The dialog this was made for may have closed, or another photo's replaced it, while the image was fetched and opened: it is then no one's.
    if (run !== displayRun || !dialog.open) { URL.revokeObjectURL(url); return; }
    if (openedDisplay) URL.revokeObjectURL(openedDisplay);
    openedDisplay = url; img.src = url;
  } catch { if (run === displayRun) img.replaceWith(Object.assign(document.createElement("p"), { textContent: photoRefused, className: "photo-refused" })); }
}
// Pressed twice: the first press asks, the second takes the photo out for everyone.
async function removePhoto(b: HTMLButtonElement) {
  if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "もう一度押すと消します"; return; }
  const pid = b.dataset.id!, res = await api("media", "PATCH", { type: "remove", id: pid }) as { media: Shown[] };
  releasePhoto(`${pid}/thumb`);
  view.media = res.media; if (dialog.open) dialog.close(); render(); notice("写真を消しました。");
}
// Only what changed is sent: the item chosen (none gives it back to its time), and the caption sealed with the trip key (none removes it).
async function savePhoto(pid: string, item: string, caption?: string) {
  const p = view.media?.find(x => x.id === pid); if (!p) return;
  const text = caption?.trim(), was = await captionOf(p);
  if (text !== undefined && [...text].length > 160) throw new Error("一言は 160 字までです");
  const patch = async (body: object) => { const { photo } = await api("media", "PATCH", body) as { photo: Shown }; view.media = (view.media ?? []).map(x => x.id === pid ? photo : x); };
  if (item !== (p.itineraryItemId ?? "")) await patch({ type: "link", id: pid, itemId: item || null });
  if (text !== undefined && text !== was) await patch({ type: "caption", id: pid, caption: text ? await sealField(tripKey!, id!, view.sealed!.generation, "photo", pid, "caption", text) : null });
  if (dialog.open) dialog.close(); render(); notice("写真を直しました。");
}
const base64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unreadablePhoto = "この写真は読めませんでした（JPEG で選び直してください）";
// A copy of the picture no longer than `edge` on its long side, as a JPEG that fits `limit` bytes: the quality goes down a step at a
// time until it does. The canvas writes no EXIF, and the picture was turned the way it was taken by createImageBitmap.
async function drawn(bitmap: ImageBitmap, edge: number, limit: number): Promise<Uint8Array> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let out = new Uint8Array();
  for (const quality of [0.85, 0.75, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, "image/jpeg", quality));
    if (!blob) throw new Error(unreadablePhoto);
    out = new Uint8Array(await blob.arrayBuffer()); if (out.length <= limit) break;
  }
  return out;
}
// One photo up: its time and place read from the original (and nowhere else: what the file or the device says now does not stand in
// for what the picture says), the two copies drawn and walked, the images and the place sealed, and one POST. The host is told no
// more than it keeps (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」).
async function uploadPhoto(file: File) {
  if (!view.sealed || !tripKey) throw new Error("この端末には旅行の鍵がありません");
  const exif = readExif(new Uint8Array(await file.arrayBuffer()));
  let bitmap: ImageBitmap; try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { throw new Error(unreadablePhoto); }
  try {
    const display = inspectJpeg(await drawn(bitmap, PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes), PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes);
    const thumb = inspectJpeg(await drawn(bitmap, PHOTO_LIMITS.thumbEdge, PHOTO_LIMITS.thumbBytes), PHOTO_LIMITS.thumbEdge, PHOTO_LIMITS.thumbBytes);
    const pid = crypto.randomUUID().replaceAll("-", ""), where = exif.location && { lat: exif.location.lat, lng: exif.location.lng, ...exif.location.accuracy !== undefined && exif.location.accuracy <= 1000 && { accuracy: exif.location.accuracy } };
    const sealed = await sealPhoto(tripKey, id!, view.sealed.generation, pid, { display: display.bytes, thumb: thumb.bytes, ...where && { location: where } });
    const taken = exif.capturedAt && photoInstant(exif.capturedAt, view.spec.timezone);
    const res = await api("media", "POST", { id: pid, images: { display: base64(sealed.display), thumb: base64(sealed.thumb) }, width: display.width, height: display.height, thumb: { width: thumb.width, height: thumb.height }, ...taken && { capturedAt: taken }, key: sealed.key, ...sealed.location && { location: sealed.location } }) as { photo: Shown };
    view.media = [...view.media ?? [], res.photo];
  } finally { bitmap.close(); }
}
async function uploadPhotos(files: File[]) {
  if (!files.length || !canUpload()) return;
  const failed: string[] = [];
  for (const [n, file] of files.entries()) {
    notice(`写真を上げています（${n + 1} / ${files.length}）`);
    try { await uploadPhoto(file); } catch (err) { failed.push(`${file.name}: ${(err as Error).message}`); }
  }
  render();
  notice(failed.length ? `${files.length - failed.length} 枚を上げました。上げられなかった写真 — ${failed.join(" / ")}` : `${files.length} 枚を上げました。`, failed.length > 0);
}
function content() {
  const kind = pageModules().find(m => m.id === tab)?.kind;
  switch (kind) {
    case "day-timeline": return timeline();
    case "places": return `<div class="section-heading"><h2>行き先を、ひとまとめに。</h2></div><div class="grid">${view.document.items.filter(i => i.place).map(i => `<article class="card"><span class="eyebrow">${dateLabel(i.day)} · ${kindNames[i.kind]}</span><h3>${e(i.place!.label)}</h3><p>${e(i.description ?? "")}</p>${links(i)}</article>`).join("")}</div>`;
    case "suggestion-board": return `<h2>行きたい、を持ち寄ろう。</h2><div class="two-columns"><section><h3>候補ボード</h3><p class="muted">行きたい場所・やりたいことを書く所です。オーナー・編集者が「旅程に追加」すると予定になります。旅行記にも候補として載ります。</p>${entries("suggest")}</section><section><h3>みんなの相談</h3><p class="muted">決めたいこと・質問・ひとことを書く所です。旅程にも旅行記にも入りません。</p>${entries("comment")}</section></div>`;
    case "checklist": return `<h2>あとは、ここを確認。</h2><p class="muted">全員で使う準備リスト。変更はメンバーに共有されます。</p><div class="card checks">${view.document.checklist.map(c => `<label class="check ${c.done ? "done" : ""}"><input type="checkbox" data-check="${c.id}" ${c.done ? "checked" : ""} ${!allowed("check") ? "disabled" : ""}><span>${e(c.title)}</span></label>`).join("")}${editor() && editable() && whole("checklist") ? button("準備リストを編集", "edit-checklist", "secondary") : ""}</div>`;
    case "budget": return `<h2>旅のお金、いまの目安。</h2><div class="grid">${view.document.budget.map(b => `<article class="card"><span class="eyebrow">概算</span><h3>${e(b.title)}</h3><div class="amount">¥${b.amount.toLocaleString("ja")}</div><p>${e(b.description)}</p></article>`).join("")}</div>${editor() && editable() && whole("budget") ? button("費用メモを編集", "edit-budget", "secondary") : ""}<p class="muted">支払い・精算の記録ではありません。実費は旅行中に確認してください。</p>`;
    case "notes": return `<h2>覚えておきたいこと。</h2><div class="card"><p class="entry-body">${e(view.document.notes)}</p>${editor() && editable() && whole("notes") ? button("メモを編集", "notes", "secondary") : ""}</div>`;
    case "footprints": return tripMap(true);
    case "story": return storyPage();
    case "moments": return photosPage();
    case "trip-map": { const m = view.spec.modules.find(m => m.id === tab); return tripMap(m?.kind === "trip-map" && m.showTrack); }
    case "reflection": return `<h2>旅の思い出</h2>${view.spec.modules.some(m => m.kind === "reflection" && view.spec.navigation.includes(m.id)) ? `<p class="muted">旅行後も${view.spec.lifecycle.reflectionDays}日間、思い出を追記できます。オーナー・編集者が選んだ投稿を旅行記に載せます。JSONには全投稿が含まれます。</p><section class="shared-memories"><h3>みんなの思い出</h3><p class="muted">この旅行のメンバーに共有します。</p>${entries("reflect")}</section>` : ""}${diary(diaryDay)}`;
    default: return "";
  }
}
// Reuse a wrapped row's line gaps as boundary clearance, without increasing its height.
function boundaryRows() {
  const buttons = [...app.querySelectorAll<HTMLElement>('.timeline-list .row > [data-action]')];
  for (const button of buttons) { button.classList.remove('boundary-wrapped'); button.style.removeProperty('--wrapped-gaps'); }
  const gaps = buttons.map(button => {
    let bottom: number | undefined, count = 0;
    for (const child of button.children) {
      const r = child.getBoundingClientRect();
      if (bottom !== undefined && r.top >= bottom + 1) { count++; bottom = r.bottom; }
      else bottom = Math.max(bottom ?? r.bottom, r.bottom);
    }
    return count * parseFloat(getComputedStyle(button).rowGap);
  });
  buttons.forEach((button, k) => { if (gaps[k]) { button.classList.add('boundary-wrapped'); button.style.setProperty('--wrapped-gaps', String(gaps[k])); } });
}
new ResizeObserver(boundaryRows).observe(app);
// A plain trip is moved to the sealed form once, by its owner's browser at a press (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」): until then it is
// used as before. A trip published after the host's line (`mustSeal`) shows this alone. A browser without WebAuthn cannot move it.
const moveBanner = () => !id || view.sealed || !["active", "reflection"].includes(view.state) ? ""
  : view.role !== "owner" ? `<p class="muted" data-move="member">オーナーが開くと、この旅行は運用者にも読めない形になります</p>`
  : !passkeys ? `<p class="warning" data-move="no-passkey">${view.mustSeal ? "この旅行は、パスキーの使えるブラウザでオーナーが移すまで開けません" : "このブラウザでは旅行を移せません。パスキーの使える別のブラウザ（Safari・Chrome など）で開いてください"}</p>`
  : `<div class="preview-banner" data-move="owner"><div><strong>この旅行を、メンバーにだけ読める形に移します。</strong><p>移すと、運用者にも読めなくなります。</p></div>${button("移す", "move-trip", "primary")}</div>`;
// The trip as the host has it now, with the step back (GET seal) and every member's and invite's name, sealed under the trip's key
// and put back in one POST seal (src/trip-keys.ts sealMove), whose passkey check api() asks for (428). Too large with the step
// back, it goes once more without it; too large still, it stays plain. A point or a seat added meanwhile: read again, once.
let moving = false;
async function moveTrip() {
  if (moving) return; moving = true;
  try {
    await ensureTripKey();
    const generation = view.seatKey?.generation;
    if (!tripKey || !generation) { notice("この端末には旅行の鍵がありません", true); return; }
    for (let attempt = 0; ; attempt++) {
      const now = await api() as View, { previous } = await api("seal"), grants = await api("grants");
      const input = { spec: now.spec, document: now.document, previous, footprints: (now.footprints ?? []).map(({ id, lat, lng, accuracy, by }) => ({ id, lat, lng, accuracy, by })), grants };
      try {
        try { await api("seal", "POST", await sealMove(tripKey, id!, generation, input), now.document.revision); }
        catch (err) { if ((err as { status?: number }).status !== 413) throw err; await api("seal", "POST", await sealMove(tripKey, id!, generation, input, { dropPrevious: true }), now.document.revision); }
        break;
      } catch (err) {
        if ((err as { status?: number }).status === 413) { notice("旅程が大きすぎて移せません。予定や投稿を減らしてください", true); return; }
        if (attempt === 0 && (err as { status?: number }).status === 409 && (err as Error).message.endsWith("もう一度移してください")) continue;
        throw err;
      }
    }
    await reload(); notice("旅行を、メンバーにだけ読める形に移しました。");
  } catch (err) { notice((err as Error).message, true); } finally { moving = false; }
}
function render() {
  mapCamera = unmountMap?.(); unmountMap = undefined; mapData = undefined;
  if (locked || view.mustSeal) {
    document.title = "旅のカプセル";
    app.innerHTML = `<header class="topbar"><a class="brand" href="/" aria-label="ホーム（旅のカプセル）"><span class="brand-icon">旅</span> <span class="brand-name">旅のカプセル</span></a><div class="top-actions"><a class="button quiet" href="/">ホーム</a><span class="role">${roleNames[view.role]}</span>${button("再読込", "reload", "quiet")}</div></header><main><section class="content">${view.mustSeal ? moveBanner() || `<p class="warning" data-move="closed">共有が終わったため、この旅行は開けません</p>` : `<p class="warning" data-sealed="locked">${e(locked)}</p>`}</section><footer>${passkeys ? button(view.passkey ? "パスキーを登録し直す" : "パスキーで戻れるようにする", "passkey-register", "quiet") : ""}${button("この端末からログアウト", "signout", "quiet")}${keyStatus()}${handoffWaiting()}</footer></main>`;
    return;
  }
  document.title = `${view.spec.title} · 旅のカプセル`;
  let accent = document.querySelector<HTMLLinkElement>("#accent");
  if (!accent) { accent = document.createElement("link"); accent.id = "accent"; accent.rel = "stylesheet"; document.head.append(accent); }
  const accentUrl = id ? `/v1/c/${id}/theme.css?v=${view.document.revision}` : "/v1/preview-theme.css";
  if (accent.getAttribute("href") !== accentUrl) accent.setAttribute("href", accentUrl);
  document.body.dataset.theme = view.spec.theme.preset;
  const pages = pageModules();
  if (!pages.some(m => m.id === tab)) tab = pages[0]!.id;
  const s = view.spec, d = view.document;
  const remaining = Math.max(0, Math.ceil((+new Date(s.lifecycle.purgeAt) - Date.now()) / 86400000));
  app.innerHTML = `<header class="topbar"><a class="brand" href="/" aria-label="ホーム（旅のカプセル）"><span class="brand-icon">旅</span> <span class="brand-name">旅のカプセル</span> <span class="brand-en">TRIP CAPSULE</span></a><div class="top-actions">${id ? '<a class="button quiet" href="/">ホーム</a>' : ""}<span class="role">${roleNames[view.role]}</span>${id ? button("再読込", "reload", "quiet") : ""}${id ? button("旅を保存", "save", "secondary") : ""}${id && revisable() && view.role === "editor" && editable() ? button("チャットで直す", "revise", "secondary") : ""}${id && (view.role === "owner" || view.role === "editor") ? button("共有・管理", "manage", "primary") : ""}</div></header>
    <div class="lifecycle ${remaining <= 7 ? "urgent" : ""}"><span>● ${stateNames[view.state]}</span><span>${dateLabel(s.lifecycle.purgeAt.slice(0, 10))} に自動削除 · あと${remaining}日${remaining <= 7 && editor() ? " — 削除前に「旅を保存」で書き出してください" : ""}</span></div>
    ${moveBanner()}
    ${view.unreadable?.length ? `<p class="warning" data-unreadable="${view.unreadable.length}">この端末で開けない記録が ${view.unreadable.length} 件あります</p>` : ""}
    ${view.state === "draft" ? `<div class="preview-banner"><div><strong>このしおりは公開前のプレビューです。</strong><p>内容・表示名・削除期限を確認して保存します。保存しただけでは招待リンクは配られません。</p></div>${button("内容を確認して作成", "publish", "primary")}</div>` : ""}
    <main><section class="hero"><div class="hero-copy"><span class="eyebrow">${e(s.presentation?.kicker ?? "A LITTLE GETAWAY")}</span><h1>${e(s.title)}</h1><p>${e(s.summary ?? "")}</p><div class="trip-meta"><span>${dateLabel(s.trip.startsOn)} — ${dateLabel(s.trip.endsOn)}</span><span>${e(s.timezone)}</span></div><div class="people">${(s.presentation?.travelers ?? []).map(t => `<span>${e(t.name.slice(0, 1))}</span>`).join("")}<small>${(s.presentation?.travelers ?? []).map(t => e(t.name) + (t.note ? `（${e(t.note)}）` : "")).join("・")}</small></div></div><div class="postcard" aria-hidden="true"><div class="postcard-top">POSTCARD <span>${e(s.presentation?.postcardLabel ?? s.trip.destinations[0]!)}</span></div><div class="landscape"><div class="sun"></div><div class="island one"></div><div class="island two"></div><div class="sea"></div><div class="boat">⛵</div></div><div class="postcard-bottom">${e(s.presentation?.postcardCaption ?? "旅に、出かけよう。").replace(/\n/g, "<br>")}<span>TRIP<br>CAPSULE</span></div></div></section>
    <section class="overview"><div><small>旅のルート</small><strong>${s.trip.destinations.map(e).join(" → ")}</strong></div><div><small>準備チェック</small><strong>${d.checklist.filter(c => c.done).length} / ${d.checklist.length} 完了</strong></div><div><small>まず決めたいこと</small><strong>${e(d.checklist.find(c => !c.done)?.title ?? "準備が整いました")}</strong></div></section>
    <nav class="navigation" aria-label="しおりのページ">${pages.map(m => button(m.label, "tab", m.id === tab ? "active" : "", `data-tab="${e(m.id)}" aria-current="${m.id === tab ? "page" : "false"}"`)).join("")}</nav><section class="content">${content()}</section>
    <footer>この旅のための、小さなしおり。${id && passkeys ? button(view.passkey ? "パスキーを登録し直す" : "パスキーで戻れるようにする", "passkey-register", "quiet") : ""}${id ? button("この端末からログアウト", "signout", "quiet") : ""}${keyStatus()}${handoffWaiting()}<span>招待された人との共有 · revision ${d.revision}</span></footer></main>`;
  boundaryRows();
  void mountMap();
  void mountPlaceElement();
  void mountPhotos();
}
// The element's `location` event carries the fix (`position`) or why there is none (`error`); a prompt the member dismissed says
// nothing. Opening the page asks for nothing: a refusal already on record is only shown, and the element is what asks again.
// The element stands in for the button only while the position is refused, and the two trade places as the permission changes
// (refused at a press of the button, allowed again from the element or the site settings) without opening the page again.
async function mountPlaceElement() {
  const el = app.querySelector<HTMLElement & { position?: GeolocationPosition | null; error?: GeolocationPositionError | null }>('[data-action="footprint-element"]');
  if (!el) return;
  // One press can bring the same fix twice: a fix is used once (by its timestamp), and none while another is being left.
  let lastFix = 0, leaving = false;
  el.addEventListener("location", async () => {
    if (el.position) {
      if (leaving || el.position.timestamp === lastFix) return;
      lastFix = el.position.timestamp; leaving = true;
      try { await leaveFootprint(el.position); } catch (err) { notice(err instanceof Error ? err.message : String(err), true); } finally { leaving = false; }
    } else if (el.error) notice(unplaced(el.error), true);
  });
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    const show = () => {
      if (!el.isConnected) return status.removeEventListener("change", show);
      const denied = status.state === "denied";
      for (const [at, shown] of [["[data-geo-place]", denied], ["[data-geo-denied]", denied], ["[data-geo-button]", !denied]] as const) {
        const part = app.querySelector<HTMLElement>(at); if (part) part.hidden = !shown;
      }
    };
    show(); status.addEventListener("change", show);
  } catch { /* no Permissions API: the button stays, and a refusal at its press says where to allow it */ }
}
// The 候補・相談 post a card's 「直す」「消す」 stands for.
const post = (b: HTMLElement) => (b.dataset.list === "comments" ? view.document.comments : view.document.suggestions).find(x => x.id === b.dataset.id);
function modal(title: string, html: string) { dialog.innerHTML = `<div class="modal-heading"><h2>${e(title)}</h2>${button("閉じる", "close", "quiet")}</div>${html}`; if (!dialog.open) dialog.showModal(); }
// One line of the checklist or budget form. Lines are added and removed on the page; the whole list is sent when saved.
function listRow(kind: "checklist" | "budget", row: { id: string; title: string; amount?: number; description?: string }) {
  const title = `<input name="title" aria-label="${kind === "budget" ? "題" : "項目"}" maxlength="160" value="${e(row.title)}">`, remove = button("削除", "remove-row", "quiet", `type="button" aria-label="${e(row.title || "この行")}を削除"`);
  return kind === "checklist" ? `<div class="list-row" data-row data-id="${e(row.id)}">${title}${remove}</div>`
    : `<div class="list-row budget" data-row data-id="${e(row.id)}">${title}<input name="amount" type="number" inputmode="numeric" min="0" max="100000000" step="1" aria-label="金額（円）" placeholder="円" value="${row.amount ?? ""}">${remove}<input name="description" aria-label="説明" maxlength="4000" placeholder="説明" value="${e(row.description ?? "")}"></div>`;
}
function listForm(kind: "checklist" | "budget") {
  const rows = kind === "checklist" ? view.document.checklist.map(c => listRow(kind, c)) : view.document.budget.map(b => listRow(kind, b));
  modal(kind === "checklist" ? "準備リストを編集" : "費用メモを編集", `<form data-form="${kind}"><div data-rows>${rows.join("")}</div>${button("＋ 行を足す", "add-row", "secondary", 'type="button"')}<p class="muted">何も入れていない行は保存されません。</p><button class="primary">保存する</button></form>`);
}
async function mutate(body: unknown) { await sendOperation(body); dialog.close(); await reload(); notice("保存しました。"); }
// Reordering a day: any `[data-item]` row inside a `[data-order-day]` container moves by its `[data-drag]` grip, whatever the row looks like.
// Pointer Events rather than HTML5 drag and drop, which a touch on iOS Safari does not start.
// `next` is the item the row stood before when the drag began (null: it was last), so a drop back in place saves nothing.
// `parts`: each row with what stands next to it (the free time before it, its "＋" after it), moved with it so the day keeps its shape.
let dragging: { row: HTMLElement; list: HTMLElement; next: string | null; pointer: number; y: number; parts: Map<HTMLElement, HTMLElement[]> } | undefined;
const partsOf = (list: HTMLElement) => new Map(rowsOf(list).map(r => { const before = r.previousElementSibling as HTMLElement | null, after = r.nextElementSibling as HTMLElement | null;
  return [r, [...(before?.classList.contains("gap") ? [before] : []), r, ...(after && (after.classList.contains("insert-row") || after.classList.contains("insert-actions")) ? [after] : [])]]; }));
const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>("[data-item]")];
// The rows only: a day also shows the free time between two items, which is not a row.
const nextOf = (row: HTMLElement, list: HTMLElement) => rowsOf(list)[rowsOf(list).indexOf(row) + 1]?.dataset.item ?? null;
const gripOf = (item: string) => rowsOf(app).find(r => r.dataset.item === item)?.querySelector<HTMLElement>("[data-drag]");
// One save at a time: a second move made before the first has redrawn the day would be computed from rows that are about to be replaced.
let ordering = false;
// The host decides the time an item takes where it landed, and says so when it changed one; the screen only reports it.
async function saveMove(id: string, before: string | null) {
  ordering = true;
  try {
    const r = await sendOperation({ type: "move", id, before }) as { moved?: { id: string } }; await reload();
    const item = r.moved && view.document.items.find(i => i.id === r.moved!.id);
    notice(item ? `${item.title}を ${time(item)} に変えました。` : "保存しました。");
  }
  // A refusal (409: someone else saved first) puts the rows back as the trip has them; the message asks for a reload.
  catch (err) { render(); notice((err as Error).message, true); } finally { ordering = false; }
  gripOf(id)?.focus();
}
// The row goes where the finger is: before the first other row whose middle is below it, or after the last one. The other rows
// are moved around it, never the row itself: its grip holds the pointer capture, and a node taken out of the document loses it.
function place() {
  if (!dragging) return;
  const { row, list, y, parts } = dragging, others = rowsOf(list).filter(r => r !== row), own = parts.get(row)!, of = (r: HTMLElement) => parts.get(r)!;
  const found = others.findIndex(r => { const box = r.getBoundingClientRect(); return y < box.top + box.height / 2; }), at = found < 0 ? others.length : found;
  if (rowsOf(list).indexOf(row) !== at) { row.before(...others.slice(0, at).flatMap(of), ...own.slice(0, own.indexOf(row))); row.after(...own.slice(own.indexOf(row) + 1), ...others.slice(at).flatMap(of)); }
}
// Near the top or bottom edge the page scrolls by itself, so a row can travel further than one screen.
function edgeScroll() {
  if (!dragging) return;
  const edge = 60, speed = dragging.y < edge ? dragging.y - edge : dragging.y > innerHeight - edge ? dragging.y - (innerHeight - edge) : 0;
  if (speed) { scrollBy(0, Math.max(-20, Math.min(20, speed / 3))); place(); }
  requestAnimationFrame(edgeScroll);
}
document.addEventListener("pointerdown", event => {
  const grip = (event.target as HTMLElement).closest<HTMLElement>("[data-drag]"), row = grip?.closest<HTMLElement>("[data-item]"), list = row?.closest<HTMLElement>("[data-order-day]");
  if (!grip || !row || !list || dragging || ordering || event.button !== 0) return;
  event.preventDefault(); grip.focus(); grip.setPointerCapture(event.pointerId);
  dragging = { row, list, next: nextOf(row, list), pointer: event.pointerId, y: event.clientY, parts: partsOf(list) }; row.classList.add("dragging");
  requestAnimationFrame(edgeScroll);
});
document.addEventListener("pointermove", event => { if (dragging?.pointer === event.pointerId) { dragging.y = event.clientY; place(); } });
for (const type of ["pointerup", "pointercancel"] as const) document.addEventListener(type, event => {
  if (dragging?.pointer !== event.pointerId) return;
  const { row, list, next } = dragging; dragging = undefined; row.classList.remove("dragging");
  // A cancelled gesture (the browser took the touch) saves nothing and puts the rows back.
  // Nor does a day that was redrawn under the finger (a second finger on another tab): its rows are no longer the ones on screen.
  // A row brought back where it was saves nothing, but the day is drawn again: the free time between items did not move with the rows.
  if (type === "pointercancel") render(); else if (list.isConnected && nextOf(row, list) !== next) void saveMove(row.dataset.item!, nextOf(row, list)); else if (list.isConnected) { render(); gripOf(row.dataset.item!)?.focus(); }
});
document.addEventListener("keydown", event => {
  const grip = (event.target as HTMLElement).closest?.<HTMLElement>("[data-drag]"), row = grip?.closest<HTMLElement>("[data-item]"), list = row?.closest<HTMLElement>("[data-order-day]");
  if (!row || !list || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
  event.preventDefault(); if (dragging || ordering) return;
  // Up: before the row above. Down: before the row after the one below, or last when there is none.
  const rows = rowsOf(list), from = rows.indexOf(row), up = event.key === "ArrowUp"; if (up ? from === 0 : from === rows.length - 1) return;
  void saveMove(row.dataset.item!, (up ? rows[from - 1] : rows[from + 2])?.dataset.item ?? null);
});
function formValues(form: HTMLFormElement) { return Object.fromEntries(new FormData(form).entries()) as Record<string, string>; }
// The start is required. An item that has none opens with the time the host would give it where it stands, marked a placeholder;
// changing the time takes the mark off (it can be put back), and saving keeps the mark as the box says.
// The end is optional. It keeps the length when the start changes, and is emptied when that would take it off its day; an end on a
// later day than the item (a night's stay) keeps that day (`data-days`).
// A new item opens on its day with the start the host would give it where it goes (after `place.after`, or on a day with nothing
// yet), marked a placeholder. Saved on that day with that time, it goes right there; the host, not this form, settles the time.
// A time typed over it is the user's own, and the item goes where that time fits, as any edit does.
function itemForm(existing?: Item, place?: { day: string; after?: string }) {
  const zone = existing?.timezone ?? view.spec.timezone, index = existing ? view.document.items.indexOf(existing) : -1, items = view.document.items;
  const after = place?.after && items.some(i => i.id === place.after) ? place.after : undefined, at = after ? items.findIndex(i => i.id === after) + 1 : items.length, probe = place && [...items.slice(0, at), { id: "", title: "", day: place.day, kind: "activity", status: "proposed", revision: 1 } as Item, ...items.slice(at)];
  const offered = existing && !existing.startsAt ? placeholder(items, index, view.spec.timezone) : probe ? placeholder(probe, at, view.spec.timezone) : undefined;
  const start = existing?.startsAt ? clock(existing.startsAt, zone) : offered !== undefined ? clock(offered, zone) : "", tentative = existing?.timeTentative ?? offered !== undefined;
  const ends = existing?.endsAt, later = ends ? Math.max(0, Math.round((Date.parse(localDay(+new Date(ends), zone)) - Date.parse(existing!.day)) / 86400000)) : 0;
  modal(existing ? "予定を編集" : "予定を追加", `<form data-form="item" data-id="${existing?.id ?? crypto.randomUUID()}" ${place && after ? `data-after="${e(after)}" data-after-day="${place.day}" data-offered="${start}"` : ""}><label>タイトル<input name="title" required maxlength="160" value="${e(existing?.title ?? "")}"></label><div class="form-grid"><label>日付<input name="day" type="date" required min="${view.spec.trip.startsOn}" max="${view.spec.trip.endsOn}" value="${existing?.day ?? place?.day ?? selectedDay ?? view.spec.trip.startsOn}"></label><label>開始時刻<input name="time" type="time" required value="${start}"></label><label>終了時刻（任意）<input name="end" type="time" value="${ends ? clock(ends, zone) : ""}" data-days="${later}"></label><label class="check"><input type="checkbox" name="tentative" ${tentative ? "checked" : ""}><span>時刻は仮置き（決定ではない）</span></label><label>種類<select name="kind">${Object.entries(kindNames).map(([v, l]) => `<option value="${v}" ${v === existing?.kind ? "selected" : ""}>${l}</option>`).join("")}</select></label><label>状態<select name="status">${Object.entries(statusNames).map(([v, l]) => `<option value="${v}" ${v === (existing?.status ?? "proposed") ? "selected" : ""}>${l}</option>`).join("")}</select></label></div><label>メモ<textarea name="description" maxlength="4000" rows="4">${e(existing?.description ?? "")}</textarea></label><label>場所<input name="place" maxlength="160" value="${e(existing?.place?.label ?? "")}"></label><label>公開URL（HTTPS）<input name="url" type="url" value="${e(existing?.place?.publicUrl ?? "")}"></label><p class="muted">時刻は${e(view.spec.timezone)}。予約番号・秘密URL・チケットQRは入力しないでください。</p><button class="primary">保存する</button></form>`);
  const box = dialog.querySelector<HTMLInputElement>("input[name=tentative]")!, field = dialog.querySelector<HTMLInputElement>("input[name=time]")!, end = dialog.querySelector<HTMLInputElement>("input[name=end]")!;
  const minutes = (v: string) => +v.slice(0, 2) * 60 + +v.slice(3, 5);
  let last = field.value;
  // An end emptied is typed again on the item's own day.
  end.addEventListener("input", () => { if (!end.value) end.dataset.days = "0"; });
  field.addEventListener("input", () => {
    box.checked = false;
    if (!field.value) return;
    if (last && end.value) {
      const days = +end.dataset.days!, at = days * 1440 + minutes(end.value) + minutes(field.value) - minutes(last);
      if (at < 0 || Math.floor(at / 1440) !== days) { end.value = ""; end.dataset.days = "0"; }
      else end.value = `${String(Math.floor(at % 1440 / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
    }
    last = field.value;
  });
}
// What each file of the ZIP is for and how it opens; only the files this trip's exports put in the ZIP are listed.
const saveNotes: Record<"markdown" | "json" | "ics" | "html", string> = {
  markdown: "README.md — メモや Markdown のアプリで読める旅行記です。",
  json: "trip.json — データの控えです（読むためのものではありません）。",
  ics: "calendar.ics — 開くと、決定した予定をカレンダーに取り込めます。",
  html: "index.html — ブラウザで開くと、旅程のページとして読めます。",
};
// Every member copies the trip as Markdown; the ZIP stays with the owner and editors, as the host has it (#355).
// The share sheet opens only right after a tap (transient activation), so the trip page is fetched when the dialog opens and
// kept at hand for the tap. A fetch that failed is forgotten, so the tap asks again.
// A sealed trip's exports are made here from the trip this browser opened, with the host's own functions (src/export.ts,
// docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」); a plain trip's come from the host as before.
const exported = async (kind: "html" | "md") => view.sealed ? (kind === "html" ? tripHtml : tripMarkdown)(view.spec, view.document) : (await api(kind === "html" ? "export.html" : "export.md")).text as string;
let savedPage: Promise<string> | undefined, pageText: string | undefined;
function fetchPage() {
  const fetched = savedPage = exported("html");
  fetched.then(t => { if (savedPage === fetched) pageText = t; }, () => { if (savedPage === fetched) savedPage = undefined; });
  return fetched;
}
function saveModal() {
  pageText = undefined; fetchPage();
  modal("旅を保存", `<h3>旅程のページを保存</h3><p>日ごとの旅程・準備・候補などを、ブラウザで開ける 1 つのファイル（HTML）で保存します。アプリが無くても開けます。スマホでは共有から「ファイルに保存」や LINE・メールに送って残せます。</p><div class="admin-actions">${button("旅程のページを保存", "save-page", "primary")}</div><hr><h3>Markdown をコピー</h3><p>旅程・準備・候補・費用メモ・メモ・思い出をテキストでコピーします。軽く、メモアプリなどに貼ればアプリ無しで読めます。</p><div class="admin-actions">${button("Markdown をコピー", "copy-markdown", "secondary")}</div>${editor() ? `<hr><h3>ZIP を保存</h3><p>旅行のファイルをまとめて保存します。スマホでは「ファイル」アプリ（iPhone）やファイルマネージャ（Android）で ZIP をタップすると展開されます。</p><ul>${view.spec.exports.map(x => `<li>${e(saveNotes[x])}</li>`).join("")}</ul><div class="admin-actions">${view.sealed ? button("ZIP を保存", "save-zip", "secondary") : `<a class="button secondary" href="/v1/c/${id}/export">ZIP を保存</a>`}</div>` : ""}${view.unreadable?.length ? `<p class="warning" data-unreadable-save>この端末で開けない記録 ${view.unreadable.length} 件は、保存する内容に入りません</p>` : ""}`);
}
// An editor gets the same dialog for the viewer invites it hands out (the host lists only those); the rest is the owner's.
async function manage() {
  const owner = view.role === "owner";
  const [grants, history] = await Promise.all([api("grants"), owner ? api("history") : []]) as [Array<{ id: string; role: Role; label: string; expires: number; revoked: number | null; seats: number; claimed: number; claimBy: number; issuedBy: { id: string; label: string } | null; members: Array<{ id: string; label: string; device: string; created: number; self: boolean; pending?: boolean; code?: string }> }>, Array<{ event: string; at: number; role?: Role; label?: string; by?: string; device?: string; grant?: string; seat?: string; member?: string }>];
  if (view.sealed) {
    if (owner) await sealNames();
    for (const g of grants) {
      g.label = await nameOf("grant", g.id, g.label);
      if (g.issuedBy) g.issuedBy.label = await nameOf("member", g.issuedBy.id, g.issuedBy.label);
      for (const m of g.members) m.label = await nameOf("member", m.id, m.label);
    }
    // A sealed trip's history names by id (spec「5.2 暗号化するもの・平文に残すもの」, `Audit`): put back into the places a plain line has its names, the invite
    // or the member it was about as `label` and who did it as `by`, as the host's label() did before.
    const seats = new Map(grants.flatMap(g => g.members.map(m => [m.id, m.label]))), invites = new Map(grants.map(g => [g.id, g.label]));
    const seat = (sid: string) => seats.get(sid) ?? "（失効したメンバー）";
    for (const a of history) {
      if (a.member !== undefined) a.label = seat(a.member); else if (a.grant !== undefined) a.label = invites.get(a.grant) ?? "（失効した招待）";
      if (a.seat !== undefined) a.by = seat(a.seat);
    }
  }
  const day = (t: number) => new Date(t).toLocaleDateString("ja");
  const undo = owner && revisable() && view.state !== "frozen" && await api("undo").then(() => true, () => false);
  modal(owner ? "招待とメンバー、旅の終わり" : "閲覧者の招待", `${owner ? "" : "<p>あなたが出した閲覧者の招待です。失効できるのは自分が出した招待だけです。</p>"}<p>招待リンクは人数分の席を持ち、開いたブラウザを1席ずつ登録します。定員に達するか受付期限を過ぎたリンクは使えなくなり、登録済みのブラウザだけが入れます。登録したブラウザの鍵（Cookie）が他人に渡ると、その人も入れます。</p><p>招待の発行・失効${owner ? "、共有終了、削除、期限の変更" : ""}の前に、この端末のパスキーで本人確認します（5 分間有効）。</p>${location.protocol === "http:" ? '<p class="warning">現在はこのPC内のローカル版です。別の端末から使うには、HTTPSの公開ホストへ配置してください。</p>' : ""}<form data-form="grant"><div class="form-grid"><label>権限<select name="role">${owner ? '<option value="participant">参加者：候補・チェック・思い出</option><option value="viewer">閲覧者：見るだけ</option><option value="editor">編集者：旅程も編集</option>' : '<option value="viewer">閲覧者：見るだけ</option>'}</select></label><label>リンク名（任意）<input name="label" maxlength="80" placeholder="空欄なら自動で付けます"></label><label>人数（席）<input name="seats" type="number" required min="1" max="50" value="1"></label><label>受付期限（日）<input name="claimDays" type="number" required min="1" max="30" value="3"></label>${owner ? '<label>参加の承認<select name="approval"><option value="auto">自動で参加（既定）</option><option value="owner">オーナーが確認コードで承認</option></select></label>' : ""}</div>${owner ? '<p class="muted">機密度の高い旅行向け。参加者の画面に出る 6 桁のコードを LINE などで聞いて照合します。</p>' : ""}<button class="primary" ${view.state === "frozen" ? "disabled" : ""}>招待リンクを発行</button></form><div class="grant-list">${grants.map(g => `<div class="grant"><div><strong>${e(g.label)}</strong><small>${roleNames[g.role]} · ${g.revoked ? "失効済み" : `登録 ${g.claimed}/${g.seats}席 · ${g.claimed >= g.seats ? "定員に達し受付終了" : g.claimBy <= Date.now() ? "受付期限切れ" : "受付 " + day(g.claimBy) + "まで"}`}</small>${owner ? `<small>発行: ${e(g.issuedBy?.label ?? "オーナー（発行時）")}</small>` : ""}${g.revoked ? "" : g.members.map(m => `<small class="member">${e(m.label)}${m.self ? "（この端末）" : ""} · ${e(m.device)} · ${day(m.created)}登録 ${m.pending ? `<strong>承認待ち · コード <span class="code">${e(m.code ?? "")}</span></strong> ${owner ? button("承認", "approve-member", "quiet", `data-id="${m.id}"`) + button("拒否", "reject-member", "quiet danger-text", `data-id="${m.id}"`) : ""}` : ""}${owner ? button("名前", "rename-member", "quiet", `data-id="${m.id}" data-label="${e(m.label)}"`) : ""}${g.role !== "owner" ? button("失効", "revoke-member", "quiet danger-text", `data-id="${m.id}"`) : ""}</small>`).join("")}</div>${!g.revoked && view.state !== "frozen" ? `<div>${button("交換", "rotate", "quiet", `data-id="${g.id}" data-role="${g.role}" data-label="${e(g.label)}"`)}${g.role !== "owner" ? button("失効", "revoke", "quiet danger-text", `data-id="${g.id}"`) : ""}</div>` : ""}</div>`).join("")}</div>${owner ? `<details class="history"><summary>招待とオーナーの履歴（${history.length} 件）</summary>${history.length ? `<ol>${history.map(a => `<li>${[`${day(a.at)} ${new Date(a.at).toLocaleTimeString("ja", { hour: "2-digit", minute: "2-digit" })}`, e(historyNames[a.event] ?? a.event), a.role ? roleNames[a.role] : "", a.label ? e(a.label) : "", a.by ? `${e(a.by)}${a.device ? `（${e(a.device)}）` : ""}` : ""].filter(Boolean).join(" · ")}</li>`).join("")}</ol>` : "<p>まだありません</p>"}</details><hr><p>自動削除：${e(new Date(view.spec.lifecycle.purgeAt).toLocaleString("ja"))}<br>削除前に『旅を保存』で書き出してください。</p>${revisable() ? "" : `<p class="muted" data-sealed="manage">${notRevisable}</p>`}<div class="admin-actions">${button("旅を保存", "save", "secondary")}${revisable() ? button("チャットで直す", "revise", "secondary", view.state === "frozen" ? "disabled" : "") : ""}${undo ? button("1 つ前に戻す", "undo", "secondary") : ""}${button("設定・期限の変更", "settings", "secondary", view.state === "frozen" ? "disabled" : "")}${button("共有を終了", "freeze", "secondary", view.state === "frozen" ? "disabled" : "")}${button("完全に削除", "purge", "danger")}</div><p class="muted">共有終了はオーナー以外のリンクを失効させます。完全削除すると元に戻せません。</p>` : ""}`);
}
function showLink(url: string, owner = false, openHere = owner) { modal(owner ? "オーナーとして使う端末で開いてください" : "招待リンクができました", `<p>${owner ? "このリンクは最初に開いて登録した1つのブラウザだけをオーナーにします。後から再表示できません。3日以内に、普段使う端末のブラウザで開いてください。" : "メンバーに送ってください。開いたブラウザが1席ずつ登録され、定員に達するか受付期限を過ぎると使えなくなります。"}</p><label>リンク<input id="issued-link" readonly value="${e(url)}"></label><div class="admin-actions">${button("コピー", "copy", "primary")}${openHere ? `<a class="button secondary" href="${e(url)}">カプセルを開く</a>` : ""}</div>`); }
document.addEventListener("click", async event => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]"); if (!b || b.disabled) return;
  const action = b.dataset.action;
  try {
    if (action === "tab") { tab = b.dataset.tab!; render(); }
    if (action === "map-retry") { (b as HTMLButtonElement).disabled = true; mapRetries++; void mountMap(); }   // Not pressed again while it loads.
    if (action === "day") { selectedDay = b.dataset.day!; render(); }
    if (action === "timeline-view" || action === "open-item") {
      // A line of the list opens its card: the list is for the day at a glance, the card for the details.
      timelineView = action === "timeline-view" && b.dataset.view === "list" ? "list" : "detail";
      try { localStorage.setItem("timeline-view", timelineView); } catch { /* private browsing: the choice lasts as long as the page */ }
      render();
      // The pressed button is gone with the redraw, so the focus moves to what it opened: from there Tab goes on through that card.
      if (action === "open-item") { const card = document.getElementById("item-" + b.dataset.id); if (card) { card.scrollIntoView({ block: "start" }); card.tabIndex = -1; card.focus({ preventScroll: true }); } }
      else app.querySelector<HTMLElement>(`[data-action="timeline-view"][data-view="${timelineView}"]`)?.focus();
    }
    if (action === "close" && leaveOwnerless()) dialog.close();
    if (action === "reload") { await reload(); notice("最新の内容を読み込みました。"); }
    // The heading's button adds after the day's last item, as its last "＋" does.
    if (action === "new-item") itemForm(undefined, { day: selectedDay, after: view.document.items.filter(i => i.day === selectedDay).at(-1)?.id });
    if (action === "insert-item") itemForm(undefined, { day: selectedDay, after: b.dataset.after });
    if (action === "edit-item") itemForm(view.document.items.find(i => i.id === b.dataset.id));
    if (action === "new-private-item") privatePlanForm(undefined, { day: selectedDay, after: view.document.items.filter(i => i.day === selectedDay).at(-1)?.id });
    if (action === "insert-private-item") privatePlanForm(undefined, { day: selectedDay, after: b.dataset.after });
    if (action === "edit-private") { const p = own().find(p => p.id === b.dataset.id), x = p && plain.get(p.id); if (x) { if (x.kind === "item") privatePlanForm(x); else { tab = pageModules().find(m => m.kind === "reflection")!.id; diaryDay = x.day; editingDiaryId = x.id; render(); app.querySelector<HTMLTextAreaElement>(".diary [name=body]")?.focus(); } } else if (p) lockedPrivate(p); }
    if (action === "cancel-diary") { editingDiaryId = ""; render(); }
    if (action === "save-private") savePrivateMarkdown();
    if (action === "receive-key") void receiveKey();
    if (action === "move-trip") void moveTrip();
    if (action === "give-key") void giveKey(b.dataset.id!, b.dataset.label ?? "メンバー");
    if (action === "handoff-submit") { const input = dialog.querySelector<HTMLInputElement>("[data-handoff-input]"); const typed = input?.value.trim() ?? ""; if (typed) { const resolve = codeResolver; codeResolver = undefined; resolve?.(typed); } else input?.focus(); }
    if (action === "read-private") try { await readWithPasskey(); await openAll(); if (dialog.open) dialog.close(); render(); notice("自分だけのメモを読めるようにしました。"); } catch (err) { passkeyError(err); }
    if (action === "footprint-here") await leaveFootprint();
    if (action === "photo-open") await photoDialog(b.dataset.id!);
    if (action === "photo-remove") await removePhoto(b);
    if (action === "auto-footprint") await switchAutoFootprint(b as unknown as HTMLInputElement);
    if (action === "map-day" || action === "map-by") { if (action === "map-day") mapDay = b.dataset.value!; else mapBy = b.dataset.value!; mapCameraKey = ""; render(); }
    if (action === "map-show") { const k = b.dataset.value as "plans" | "footprints"; mapShow = { ...mapShow, [k]: !mapShow[k] }; mapCameraKey = ""; render(); }
    if (action === "remove-footprint" && confirm("この足あとを消しますか？")) { await api("footprints", "PATCH", { type: "remove", id: b.dataset.id }); await reload(); notice("足あとを消しました。"); }
    if (action === "remove-private" && confirm(`この${own().find(p => p.id === b.dataset.id)?.kind === "item" ? "予定" : "日記"}を削除しますか？取り消せません。`)) await savePrivate({ type: "remove", id: b.dataset.id });
    // A line of the list opens its card, as a shared item's does.
    if (action === "open-private") { timelineView = "detail"; try { localStorage.setItem("timeline-view", timelineView); } catch { /* the choice lasts as long as the page */ } render(); const card = document.getElementById("private-" + b.dataset.id); if (card) { card.scrollIntoView({ block: "start" }); card.tabIndex = -1; card.focus({ preventScroll: true }); } }
    if (action === "edit-checklist") listForm("checklist");
    if (action === "edit-budget") listForm("budget");
    if (action === "add-row") { const rows = b.closest("form")!.querySelector("[data-rows]")!, kind = b.closest<HTMLFormElement>("form")!.dataset.form as "checklist" | "budget";
      rows.insertAdjacentHTML("beforeend", listRow(kind, { id: crypto.randomUUID(), title: "" })); rows.querySelector<HTMLInputElement>("[data-row]:last-child input")!.focus(); }
    if (action === "remove-row") b.closest("[data-row]")!.remove();
    if (action === "notes") modal("旅のメモ", `<form data-form="notes"><textarea name="body" rows="10" maxlength="4000">${e(view.document.notes)}</textarea><button class="primary">保存する</button></form>`);
    if (action === "promote") modal("候補を旅程へ追加", `<form data-form="promote" data-id="${b.dataset.id}"><label>追加する日<select name="day">${days().map(d => `<option value="${d}">${dateLabel(d)}</option>`).join("")}</select></label><p>「決定」の予定として追加します。候補の本文はメモに残ります。</p><button class="primary">旅程へ追加</button></form>`);
    if (action === "rewrite-post") modal("投稿を直す", `<form data-form="rewrite" data-list="${b.dataset.list}" data-id="${b.dataset.id}"><label>本文<textarea name="body" required maxlength="4000" rows="6">${e(post(b)?.body ?? "")}</textarea></label><button class="primary">保存する</button></form>`);
    if (action === "remove-post" && confirm(`この投稿を消しますか？取り消せません。${(post(b) as { promoted?: boolean } | undefined)?.promoted ? "旅程に追加した予定は残ります。" : ""}`)) await mutate({ type: "remove", list: b.dataset.list, id: b.dataset.id });
    if (action === "include") await mutate({ type: "include", id: b.dataset.id, included: b.dataset.included === "true" });
    if (action === "manage") await manage();
    if (action === "save") saveModal();
    if (action === "copy") { const field = document.querySelector<HTMLInputElement>("#issued-link")!; try { await navigator.clipboard.writeText(field.value); notice("リンクをコピーしました。"); } catch { field.select(); notice("リンクを選択しました。コピーして保存してください。"); } }
    if (action === "join") { const joined = await api("sessions", "POST", { secret: joinSecret }); joinSecret = ""; history.replaceState(null, "", location.pathname); if (joined.pending) return pendingScreen(joined.code); await reload(); modal("この端末を登録しました", `<p>次からは <strong>${e(location.host)}</strong> を開くと「この端末で参加中の旅行」から入れます。このページをブックマークするか、ホーム画面に追加しておくと確実です。</p><p class="muted">受け取った招待リンクも、このブラウザでなら開き直せます。ブラウザのデータ（Cookie）を消すと登録が消え、${passkeys ? "パスキーを登録していなければ" : ""}オーナーからの再招待が必要になります。</p>${passkeys ? `<div class="admin-actions">${button("Face ID / 指紋で戻れるようにする（任意）", "passkey-register", "secondary")}</div><p class="muted">Cookie を消したときに同じ席に戻れます。${view.role === "owner" ? "オーナーは、招待の発行や削除などの前の本人確認にも使います。" : view.role === "editor" ? "編集者は、招待の発行・失効の前の本人確認にも使います。" : ""}閲覧の盗み見を防ぐものではありません。</p>` : ""}`); }
    if (action === "copy-recipe") {
      const { text } = await api("/v1/recipe") as { text: string };
      try { await navigator.clipboard.writeText(text); notice("作り方をコピーしました。チャットに貼って、旅行の希望を書いてください。"); }
      catch {
        modal("作り方", `<p>下の文をすべて選んでコピーし、チャットに貼ってください。</p><label><textarea id="recipe-text" rows="10" readonly>${e(text)}</textarea></label>`);
        const field = document.querySelector<HTMLTextAreaElement>("#recipe-text"); field?.focus(); field?.select();
      }
    }
    // An editor comes here from the header, not from 共有・管理, so one step back is offered here — when the host allows it.
    const editorUndo = action === "revise" && view.role === "editor" && await api("undo").then(() => true, () => false);
    // Two ways to ask: write here and copy (paste and send as it is), or copy and write in the chat. The written request is
    // what a chat sent from the host would be given one day (docs/ephemeral-trip-capsule.md「1.5 生成と検査」), and never goes to the host.
    if (action === "revise") modal("チャットで直す", `<p>今の旅程と直し方をコピーしてチャットに貼ると、チャットが直した旅程を返します。候補・相談は本文だけ含めます。書いた人の名前、思い出、メンバー・招待の情報は含めません。</p>${view.role === "editor" ? "<p>編集者が直せるのは予定・候補・相談・準備リスト・メモ・費用メモです。題・日程・期限・ページなどの設定は今のまま残ります。</p>" : ""}${hostRevise()}<h3>1. チャットに渡す</h3><label>直してほしいこと（任意）<textarea data-revise-request maxlength="2000" rows="3" placeholder="例: 2日目の夕食を18:30にして、3日目の朝に散歩を足す"></textarea></label><p class="muted">書くと、コピーする文の最初に付きます。空のままコピーして、チャットで書いても構いません。予約番号・パスワードなどは書かないでください。</p><div class="admin-actions">${button("今の旅程と直し方をコピー", "copy-revise", "primary")}${editorUndo ? button("1 つ前に戻す", "undo", "secondary") : ""}</div><hr><h3>2. チャットの返事を貼る</h3><label>チャットの返事<textarea data-revise-paste rows="5" placeholder="返事をそのまま貼ってください（前後の文が混ざっていても大丈夫です）"></textarea></label><div class="admin-actions">${button("差分を見る", "revise-check", "primary")}</div><ul class="paste-problems" hidden></ul><div class="revise-diff" hidden></div><p class="muted">差分を見て反映するまで、旅行は変わりません。</p>`);
    if (action === "copy-revise") {
      // As in creatorAddDevice: Safari keeps the tap's permission to write the clipboard only if the write starts before the request returns.
      const request = document.querySelector<HTMLTextAreaElement>("[data-revise-request]")?.value.trim() ?? "";
      // The request goes first: were the text cut short where it is pasted, the request would be the part lost (#306).
      // A sealed trip's text is made here from the trip this browser opened, as the host makes a plain one's (spec「5.3 暗号化した旅行で Host にできないこと」).
      const made: Promise<string> = view.sealed ? Promise.resolve(reviseText(view.spec, view.document, view.role !== "owner")) : api("revise").then(r => r.text as string);
      const text = made.then(t => request ? `## 直してほしいこと\n\n${request}\n\n---\n\n${t}` : t);
      try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(t => new Blob([t], { type: "text/plain" })) })]); notice(request ? "今の旅程と直し方に、直してほしいことを付けてコピーしました。チャットに貼って、そのまま送ってください。" : "今の旅程と直し方をコピーしました。チャットに貼って、直してほしいことを書いてください。"); }
      catch {
        const value = await text;
        modal("チャットで直す", `<p>下の文をすべて選んでコピーし、チャットに貼って${request ? "、そのまま送って" : "から、直してほしいことを書いて"}ください。</p><label><textarea id="revise-text" rows="10" readonly>${e(value)}</textarea></label>`);
        const field = document.querySelector<HTMLTextAreaElement>("#revise-text"); field?.focus(); field?.select();
      }
    }
    // One HTML file: to the share sheet where the browser can hand it a file, else downloaded. Closing the sheet saves nothing.
    // A tap that waited for the page may have lost the sheet's permission: one more tap, with the page at hand, opens it.
    if (action === "save-page") {
      const waited = pageText === undefined, name = `trip-${view.spec.trip.startsOn}.html`, text = pageText ?? await (savedPage ?? fetchPage()), file = new File([text], name, { type: "text/html" });
      let shared = false;
      if (navigator.canShare?.({ files: [file] })) try { await navigator.share({ files: [file], title: view.spec.title }); shared = true; } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if ((err as Error).name === "NotAllowedError" && waited) { notice("旅程のページの用意ができました。もう一度押すと共有できます。"); return; }
      }
      if (!shared) download(text, "text/html;charset=utf-8", name);
      notice("旅程のページを保存しました。ブラウザで開くと旅のしおりとして読めます。");
    }
    // A sealed trip's ZIP: the same files the host makes, made here from the opened trip.
    if (action === "save-zip") {
      download(new Uint8Array(zip(await exportFiles(id!, view.spec, view.document, view.updated ?? new Date().toISOString()))), "application/zip", `trip-${view.spec.trip.startsOn}.zip`);
      notice("ZIP を保存しました。");
    }
    if (action === "copy-markdown") {
      // The same shape as copy-revise: the write starts before the request returns, so Safari keeps the tap's permission.
      const text = exported("md");
      try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(t => new Blob([t], { type: "text/plain" })) })]); notice("旅程を Markdown でコピーしました。メモアプリなどに貼って残してください。"); }
      catch {
        const value = await text;
        modal("Markdown をコピー", `<p>下の文をすべて選んでコピーし、メモアプリなどに貼ってください。</p><label><textarea id="markdown-text" rows="10" readonly>${e(value)}</textarea></label>`);
        const field = document.querySelector<HTMLTextAreaElement>("#markdown-text"); field?.focus(); field?.select();
      }
    }
    if (action === "revise-check") await checkRevise();
    // The memo key first, from this browser or the seat's passkey: what cannot be opened cannot be copied, nor an answer sealed.
    if (action === "revise-private") try { if (!await ensureMemoKey()) return; await openAll(); render(); privateRevise(); } catch (err) { passkeyError(err); }
    if (action === "copy-revise-private") {
      const request = dialog.querySelector<HTMLTextAreaElement>("[data-revise-request]")?.value.trim() ?? "", made = privateReviseText(view.spec, view.document, readable());
      const text = request ? `## 直してほしいこと\n\n${request}\n\n---\n\n${made}` : made;
      try { await navigator.clipboard.writeText(text); notice(request ? "自分の予定・日記と直し方に、直してほしいことを付けてコピーしました。チャットに貼って、そのまま送ってください。" : "自分の予定・日記と直し方をコピーしました。チャットに貼って、直してほしいことを書いてください。"); }
      catch {
        modal("自分の予定・日記をチャットで直す", `${privateNotice}<p>下の文をすべて選んでコピーし、チャットに貼って${request ? "、そのまま送って" : "から、直してほしいことを書いて"}ください。コピーした文はチャットのサービスには読めます。</p><label><textarea id="revise-text" rows="10" readonly>${e(text)}</textarea></label>`);
        const field = document.querySelector<HTMLTextAreaElement>("#revise-text"); field?.focus(); field?.select();
      }
    }
    if (action === "revise-private-check") checkPrivateRevise();
    if (action === "undo") await showUndo();
    if (action === "check-paste") await checkPaste();
    if (action === "assist-run") await runAssist();
    if (action === "revise-assist") await reviseAssist();
    if (action === "revise-key-delete" && confirm("登録した API キーを削除しますか？もう一度登録すれば、また使えます。")) { await api("key", "DELETE", {}); await reload(); redrawHostRevise(); notice("API キーを削除しました。"); }
    if (action === "assist-key-delete" && confirm("登録した API キーを削除しますか？もう一度登録すれば、また使えます。")) { await api("/v1/account/key", "DELETE"); await creationHome(); notice("API キーを削除しました。"); }
    if (action === "passkey-register") try { await registerPasskey(); } catch (err) { passkeyError(err); }
    if (action === "passkey-login") try { await passkeyLogin(); } catch (err) { passkeyError(err); }
    if (action === "creator-register") try { await creatorRegister(); } catch (err) { passkeyError(err); }
    // One message for every failure, as the host gives: a trip's passkey picked by mistake reads the same as an unknown one.
    if (action === "creator-login") try { await creatorLogin(); } catch (err) { if ((err as Error).name === "NotAllowedError") passkeyError(err); else notice("サインインできませんでした", true); }
    if (action === "claim-owner" && unclaimed) await claimOwner();
    if (action === "unowned-owner") { const trip = b.dataset.id!, { url } = await api("/v1/creators/trips", "POST", { id: trip, owner: true }); unclaimed = { id: trip, secret: new URLSearchParams(new URL(url).hash.slice(1)).get("k") ?? "", url }; chooseOwner(false); }
    // Either way the list is drawn again: a trip handed over or deleted elsewhere in the meantime leaves it.
    if (action === "unowned-purge" && confirm(`「${b.dataset.title}」を削除しますか？取り消せません。`)) { try { await api("/v1/creators/trips", "POST", { id: b.dataset.id, purge: true, confirm: true }); } finally { await creationHome(); } notice("旅行を削除しました。"); }
    // The link is for another device or person, so this screen offers no shortcut to open it here.
    if (action === "owner-link" && unclaimed) { const { url } = unclaimed; unclaimed = undefined; settled(); showLink(url, true, false); }
    if (action === "creator-add-device") try { await creatorAddDevice(); } catch (err) { passkeyError(err); }
    if (action === "creator-delegate") {
      const trip = /\/c\/([a-f0-9]{32})/.exec(document.querySelector<HTMLInputElement>("[data-delegate-trip]")?.value ?? "")?.[1];
      if (!trip) notice("旅行の URL を貼ってください", true); else try { await creatorAddDevice(trip); } catch (err) { passkeyError(err); }
    }
    if (action === "creator-revoke-delegate" && confirm(`「${b.dataset.title}」の作成権限を失効しますか？この人は新しい旅行を作れなくなります。作った旅行はそのまま残ります。`)) { try { await api("/v1/creators/revoke", "POST", { creator: b.dataset.id, confirm: true }); } finally { await creationHome(); } notice("作成権限を失効しました。"); }
    if (action === "creator-signout") { await api("/v1/creators/signout", "POST", {}); await creationHome(); notice("サインアウトしました。"); }
    // Signing out replaces this browser's cookie on the host. The seat stays: its passkey brings it back, without one the owner invites again.
    if (action === "signout" && confirm(`この端末からログアウトしますか？${view.passkey ? "登録したパスキーで、この旅行の「パスキーで戻る」から戻れます。" : `パスキーを登録していないため、ログアウトすると、${view.role === "owner" ? "運用者によるオーナーリンクの出し直し（aws/recover.ts）" : "オーナーの再招待"}が要ります。`}`)) {
      await api("signout", "POST", { confirm: true }); remember(list => list.filter(t => t.id !== id)); location.href = "/";
    }
    if (action === "rekey") { await stepUp(); dialog.close(); await rekeyTrip(); }
    if (action === "rekey-keep") { await stepUp(); await api("keys", "PATCH", { type: "keep" }); dialog.close(); await reload(); notice("鍵はそのままです"); }
    if (action === "approve-member") { await api("approve", "POST", { member: b.dataset.id, approve: true, confirm: true }); await manage(); }
    if (action === "reject-member" && confirm("拒否しますか？席は戻りません")) { await api("approve", "POST", { member: b.dataset.id, approve: false, confirm: true }); await manage(); }
    if (action === "pending-reload") location.reload();
    // A seat that held the key is gone: reading the trip again lets the owner's browser replace the key (load) before the list is shown.
    if (action === "revoke-member" && confirm("この端末の登録を失効させますか？席は戻りません。再参加には新しい招待リンクが必要です。")) { await api("revoke", "POST", { member: b.dataset.id, confirm: true }); await reload(); await manage(); }
    if (action === "rename-member") { const label = prompt("メンバーの表示名", b.dataset.label)?.trim(); if (label) { await namesSealing; await api("members", "PATCH", { id: b.dataset.id, label: await nameFor("member", b.dataset.id!, label) }); await manage(); } }
    if (action === "revoke" && confirm("この招待リンクと、そこから登録した全員を失効させますか？")) { await api("revoke", "POST", { id: b.dataset.id, confirm: true }); await reload(); await manage(); }
    // The owner invite handed over takes its seat's key with it: with no other seat holding the present one, the trip would be
    // read by nobody (spec「5.5 旅行の鍵を替える」). The same rule as the host's (409 last-key), on the seats that hold a key and do not wait for one.
    if (action === "rotate" && b.dataset.role === "owner" && view.sealed && !(view.seats ?? []).some(s => s.id !== view.self?.id && !view.waiting?.some(w => w.id === s.id))) notice(lastKey, true);
    else if (action === "rotate" && confirm(`新しいリンクに交換し、古いリンクを直ちに失効させますか？${b.dataset.role === "owner" && view.sealed ? "新しいオーナーは、鍵を持つメンバーと確認コードを合わせて鍵を受け取ります。" : ""}`)) {
      // The new invite keeps the name: the host's own as it is, one of the members' sealed against the new invite's id.
      const gid = newGrantId(), host = b.dataset.label === "自分用" || b.dataset.label === "招待リンク";
      const v = await api("grants", "POST", { role: b.dataset.role, label: host ? b.dataset.label : await nameFor("grant", gid, b.dataset.label!), ...view.sealed && { id: gid }, expiresAt: view.spec.lifecycle.purgeAt, confirm: true, rotate: b.dataset.id });
      // An owner invite handed over takes this seat with it: there is nothing left to read again (the new owner is asked, spec「5.5 旅行の鍵を替える」).
      if (b.dataset.role !== "owner") await reload();
      showLink(v.url, b.dataset.role === "owner");
    }
    if (action === "freeze" && confirm("共有を終了し、オーナー以外のリンクをすべて失効させますか？以降は読み取り専用です。")) { await api("freeze", "POST", { confirm: true }); dialog.close(); await reload(); }
    if (action === "purge") modal("完全に削除", `<form data-form="purge"><p>旅程・投稿・すべてのリンクを削除します。取り消せません。必要なZIPは先に保存してください。</p><label>確認のため「${e(view.spec.title)}」を入力<input name="title" required autocomplete="off"></label><button class="danger">完全に削除する</button></form>`);
    if (action === "settings") modal("設定・期限の変更", `<form data-form="settings"><label>タイトル<input name="title" value="${e(view.spec.title)}" required maxlength="160"></label><label>行き先<input name="destination" value="${e(view.spec.trip.destinations.join("、"))}" required maxlength="160"></label><div class="form-grid"><label>初日<input name="start" type="date" required value="${view.spec.trip.startsOn}"></label><label>最終日<input name="end" type="date" required value="${view.spec.trip.endsOn}"></label></div><label>テーマ<select name="theme">${["paper", "postcard", "minimal", "night"].map(x => `<option ${x === view.spec.theme.preset ? "selected" : ""}>${x}</option>`).join("")}</select></label><label>自動削除日（日本時間0時）<input name="purge" type="date" required value="${view.spec.lifecycle.purgeAt.slice(0, 10)}"></label><p>旅行後の追記期間：${view.spec.lifecycle.reflectionDays}日。期限は作成から最大180日で、最終日より後にしてください。登録済みの予定は新しい日程の範囲内に収まっている必要があります。</p><button class="primary">変更内容を確認</button></form>`);
    if (action === "publish") modal("旅程を確認して、作成", `<form data-form="publish"><p>旅程は${e(view.spec.trip.startsOn)}〜${e(view.spec.trip.endsOn)}、削除予定は${e(view.spec.lifecycle.purgeAt.slice(0, 10))}です。予定と表示名に共有したくない情報が残っていないか確認してください。</p><label>旅行の初日<input name="start" type="date" value="${view.spec.trip.startsOn}" required></label><label class="check"><input type="checkbox" required><span>日付・旅程・削除期限を確認しました</span></label><p class="muted">日付を変更すると全予定と削除日も同じ日数だけ移動します。</p><button class="primary">この内容でカプセルを作成</button></form>`);
  } catch (err) { notice((err as Error).message, true); }
});
document.addEventListener("change", async event => { const t = event.target as HTMLInputElement; if (t.matches("[data-diary-day]")) { diaryDay = t.value; editingDiaryId = ""; render(); } if (t.dataset.check) try { await mutate({ type: "check", id: t.dataset.check, done: t.checked }); } catch (err) { t.checked = !t.checked; notice((err as Error).message, true); } });
document.addEventListener("change", async event => {
  const field = event.target as HTMLInputElement;
  if (field.dataset.upload === "photos") { const files = [...field.files ?? []]; field.value = ""; await uploadPhotos(files); return; }
  if (!field.dataset.import || !canCreate) return;
  try {
    const file = field.files?.[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error("ファイルは2 MiB以内にしてください");
    const data = JSON.parse(await file.text()), checked = validate(data.spec, data.document, Date.now()), missing = untimed(checked.document);
    // Refused here as publishing would refuse it, naming the item, rather than after the preview.
    if (missing.length) throw new Error(explain(missing).join(" / "));
    view = { ...checked, role: "owner", state: "draft" }; render();
    notice("まだ送信していません。内容と表示名を確認してください。");
  } catch (err) { notice((err as Error).message, true); }
});
document.addEventListener("submit", async event => {
  const form = event.target as HTMLFormElement; if (!form.dataset.form) return; event.preventDefault();
  const f = formValues(form), submit = form.querySelector<HTMLButtonElement>('button[type="submit"],button:not([type])'); if (submit) submit.disabled = true;
  try {
    if (form.dataset.form === "revise-key") { if (view.sealed) await wrapAssistKey(f.key ?? ""); else await api("key", "PUT", { key: f.key }); await reload(); redrawHostRevise(); notice("API キーを登録しました。"); }
    if (form.dataset.form === "assist-key") { await api("/v1/account/key", "PUT", { key: f.key }); await creationHome(); notice("API キーを登録しました。"); }
    if (form.dataset.form === "create") {
      if (!canCreate) throw new Error("旅行の発行権限が必要です");
      const seed = emptyTrip(f.start!, f.end!, f.title!, f.destination!);
      validate(seed.spec, seed.document, Date.now());
      view = { ...seed, role: "owner", state: "draft" }; render();
    }
    if (form.dataset.form === "entry") await mutate({ type: form.dataset.type, author: f.author, body: f.body });
    if (form.dataset.form === "notes") await mutate({ type: "notes", body: f.body });
    if (form.dataset.form === "photo") await savePhoto(form.dataset.id!, f.item ?? "", f.caption);
    if (form.dataset.form === "rewrite") await mutate({ type: "rewrite", list: form.dataset.list, id: form.dataset.id, body: f.body });
    if (form.dataset.form === "checklist" || form.dataset.form === "budget") {
      // A line left wholly empty is dropped; one with something in it but no title, or a budget line without an amount, is
      // refused rather than lost or saved as ¥0.
      const rows = [...form.querySelectorAll<HTMLElement>("[data-row]")].map(r => ({ id: r.dataset.id!, value: (name: string) => r.querySelector<HTMLInputElement>(`[name=${name}]`)?.value.trim() ?? "" }))
        .filter(r => ["title", "amount", "description"].some(n => r.value(n)));
      if (rows.some(r => !r.value("title"))) throw new Error("題の無い行があります。題を入れるか、行を削除してください");
      if (form.dataset.form === "budget" && rows.some(r => !r.value("amount"))) throw new Error("金額の無い行があります。金額を入れてください（0 円でもかまいません）");
      if (form.dataset.form === "checklist") await mutate({ type: "checklist", checklist: rows.map(r => ({ id: r.id, title: r.value("title") })) });
      else await mutate({ type: "budget", budget: rows.map(r => ({ id: r.id, title: r.value("title"), amount: Number(r.value("amount")), description: r.value("description") })) });
    }
    if (form.dataset.form === "promote") await mutate({ type: "promote", id: form.dataset.id, day: f.day });
    if (form.dataset.form === "item") {
      const old = view.document.items.find(i => i.id === form.dataset.id);
      // An item kept in another zone would come back shifted: the form reads and writes Tokyo time only.
      if (view.spec.timezone !== "Asia/Tokyo" || (old?.timezone ?? "Asia/Tokyo") !== "Asia/Tokyo") throw new Error("時刻の編集UIは現在Asia/Tokyoのみ対応しています。");
      // Refused here as the host would refuse it; an end left as it was keeps the way it was written.
      const startsAt = `${f.day}T${f.time}:00+09:00`, later = +form.querySelector<HTMLInputElement>("input[name=end]")!.dataset.days!;
      const written = f.end ? `${new Date(Date.parse(f.day!) + later * 86400000).toISOString().slice(0, 10)}T${f.end}:00+09:00` : undefined;
      if (written && +new Date(written) < +new Date(startsAt)) throw new Error("終了時刻が開始時刻より前です");
      const endsAt = written && old?.endsAt && +new Date(old.endsAt) === +new Date(written) ? old.endsAt : written;
      const item = { ...old, id: form.dataset.id, title: f.title, day: f.day, kind: f.kind, status: f.status, description: f.description, revision: old?.revision ?? 1, startsAt, endsAt, timeTentative: f.tentative ? true : undefined, place: f.place ? { label: f.place, ...(f.url ? { publicUrl: f.url } : {}), ...(old?.place?.label === f.place && old.place.lat !== undefined ? { lat: old.place.lat, lng: old.place.lng } : {}) } : undefined };
      // Moved to another day in the form, or given a time of the user's own, it goes where its time fits instead.
      const after = form.dataset.after && f.day === form.dataset.afterDay && f.time === form.dataset.offered ? form.dataset.after : undefined;
      await mutate({ type: "item", item, ...(after ? { after } : {}) });
      const placed = after && view.document.items.find(i => i.id === item.id); if (placed) notice(`${placed.title}を ${time(placed)} に置きました。`);
    }
    if (form.dataset.form === "private") {
      const item = f.kind === "item";
      if (item && !f.title?.trim()) throw new Error("予定の題を入れてください");
      if (item && !f.time) throw new Error("予定の開始時刻を入れてください");
      if (!item && !f.body?.trim()) throw new Error("日記の本文を入れてください");
      if (item && view.spec.timezone !== "Asia/Tokyo") throw new Error("時刻の編集UIは現在Asia/Tokyoのみ対応しています。");
      // The host replaces an entry whole, so what this form does not show (an end, a place, a diary's title) is kept as it was. The
      // end moves with the start, as on the shared items' form; a plan made a diary drops its times. The host cannot read the words,
      // so they are checked here, before they are sealed with this seat's memo key.
      const old = plain.get(form.dataset.id!) ?? undefined, title = item ? f.title!.trim() : old?.title ?? "", body = f.body!.trim();
      if (title.length > 160) throw new Error("題は160字までです"); if (body.length > 4000) throw new Error("本文は4000字までです");
      if (old?.place?.publicUrl && !https(old.place.publicUrl)) throw new Error("場所のURLはHTTPSだけです");
      // A start the form shows unchanged keeps its own string (and its end), seconds and all; a moved end is written to the
      // millisecond (in UTC), so the plan keeps its length exactly.
      const was = old?.startsAt, unmoved = was && localDay(+new Date(was), "Asia/Tokyo") === f.day && clock(was, "Asia/Tokyo") === f.time ? was : undefined;
      const startsAt = item ? unmoved ?? `${f.day}T${f.time}:00+09:00` : undefined, moved = old?.endsAt && was ? +new Date(old.endsAt) + +new Date(startsAt!) - +new Date(was) : undefined;
      const ends = !item || !old?.endsAt ? undefined : moved === undefined || unmoved ? old.endsAt : new Date(moved).toISOString();
      const entry: PlainEntry = { id: form.dataset.id!, kind: f.kind as PlainEntry["kind"], day: f.day!, ...(startsAt ? { startsAt } : {}), ...(ends ? { endsAt: ends } : {}), title, body, ...(old?.place ? { place: old.place } : {}) };
      const key = await ensureMemoKey(); if (!key) return;
      await savePrivate({ type: "put", entry: await sealEntry(key, entry) });
      if (!item) { diaryDay = f.day!; editingDiaryId = ""; render(); }
    }
    if (form.dataset.form === "grant") { const gid = newGrantId(), v = await api("grants", "POST", { role: f.role, label: await nameFor("grant", gid, f.label!.trim() || `${roleNames[f.role as Role]}の招待 ${new Date().toLocaleDateString("ja", { month: "numeric", day: "numeric" })}`), ...view.sealed && { id: gid }, seats: Number(f.seats), claimDays: Number(f.claimDays), approval: f.approval ?? "auto", expiresAt: view.spec.lifecycle.purgeAt, confirm: true }); showLink(v.url); }
    if (form.dataset.form === "revise-private" && revisingPrivate) {
      // Sealed here, every entry, and sent in one apply: the host takes all of them or none.
      const d = revisingPrivate, key = await memoKey(); if (!key) throw new Error("自分だけのメモの鍵を開けませんでした。もう一度「チャットで直す」から開いてください。");
      const put = await Promise.all([...d.added, ...d.changed].map(x => sealEntry(key, x)));
      try { await api("private", "PATCH", { type: "apply", put, remove: d.removed.map(x => x.id) }); }
      // A refusal (4xx) is the host's answer before anything was stored. Otherwise the answer may have been lost after the
      // store: the list is read again rather than said to be unchanged, and the diff is dropped so it is not applied twice.
      catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== undefined && status < 500) throw new Error(`${(err as Error).message}。自分の予定・日記は何も変わっていません。`);
        revisingPrivate = undefined; dialog.close();
        // Retrying from a list that was not read again would add the same entries twice, so that is offered only once it was.
        if (!await reload().then(() => true, () => false)) throw new Error("反映できたか確かめられず、一覧も読み込めませんでした。もう一度反映する前に、ページを開き直して自分の予定・日記を確かめてください。");
        throw new Error("反映できたか確かめられませんでした。読み込み直した一覧を見て、足りなければもう一度「チャットで直す」から反映してください。");
      }
      revisingPrivate = undefined; dialog.close(); await reload(); notice("反映しました。");
    }
    if (form.dataset.form === "revise" && revising) {
      // The text and version are the ones the diff on screen was computed from, so what is applied is what was shown.
      try { await api("revise", "POST", revising.next ? await resealed(revising.next, revising.large, f.title) : { text: revising.text, confirm: true, ...(f.title !== undefined ? { title: f.title } : {}) }, revising.revision); }
      catch (err) { if ((err as { status?: number }).status !== 409) throw err; notice("別の人が更新しました。差分を出し直します。", true); await checkRevise(); return; }
      revising = undefined; dialog.close(); await reload(); notice(`反映しました。「${view.role === "owner" ? "共有・管理" : "チャットで直す"}」から 1 つ前に戻せます。`);
    }
    if (form.dataset.form === "undo" && undoing) {
      try { await api("undo", "POST", undoing.next ? await resealed(undoing.next, undoing.large, f.title, undoing.step) : { confirm: true, ...(f.title !== undefined ? { title: f.title } : {}) }, undoing.revision); }
      catch (err) { if ((err as { status?: number }).status !== 409) throw err; notice("別の人が更新しました。差分を出し直します。", true); await showUndo(); return; }
      undoing = undefined; dialog.close(); await reload(); notice("1 つ前に戻しました。");
    }
    // A sealed trip's title is compared here: the host cannot read it (spec「5.3 暗号化した旅行で Host にできないこと」).
    if (form.dataset.form === "purge") { if (view.sealed && !sameTitle(f.title, view.spec.title)) throw new Error("確認用のタイトルが一致しません"); await api("purge", "POST", { title: view.sealed ? "" : f.title }); await forgetTrip(id!); dialog.close(); unmountMap?.(); unmountMap = undefined; app.innerHTML = '<main class="empty"><h1>カプセルを削除しました。</h1><p>すべてのリンクが失効しました。</p><a href="/">プレビューに戻る</a></main>'; }
    if (form.dataset.form === "settings") {
      if (confirm(`タイトル：${view.spec.title} → ${f.title}\n日程：${view.spec.trip.startsOn}〜${view.spec.trip.endsOn} → ${f.start}〜${f.end}\nテーマ：${view.spec.theme.preset} → ${f.theme}\n削除日：${view.spec.lifecycle.purgeAt.slice(0, 10)} → ${f.purge}\nこの変更を反映しますか？`)) { const spec = structuredClone(view.spec); spec.title = f.title!; spec.trip = { startsOn: f.start!, endsOn: f.end!, destinations: f.destination!.split(/[、,]/).map(x => x.trim()).filter(Boolean) }; spec.theme.preset = f.theme as Spec["theme"]["preset"]; spec.lifecycle.purgeAt = `${f.purge}T00:00:00+09:00`;
        // A sealed trip's settings go sealed: the words checked as a plain Spec first, then its title, destinations and labels sealed.
        if (view.sealed && !tripKey) throw new Error("この端末には旅行の鍵がありません");
        let sealedSpec: unknown; if (view.sealed) try { sealedSpec = await sealSpec(tripKey!, id!, view.sealed.generation, specSchema.parse(spec)); } catch (err) { throw plainError(err); }
        await api("spec", "PATCH", { spec: view.sealed ? sealedSpec : spec, confirm: true }); dialog.close(); await reload(); }
    }
    if (form.dataset.form === "publish") {
      const spec = structuredClone(view.spec), doc = structuredClone(view.document), delta = +new Date(f.start!) - +new Date(spec.trip.startsOn);
      const shiftDay = (s: string) => new Date(+new Date(s) + delta).toISOString().slice(0, 10);
      spec.presentation?.dayHeadings.forEach(h => { h.day = shiftDay(h.day); });
      spec.trip.startsOn = shiftDay(spec.trip.startsOn); spec.trip.endsOn = shiftDay(spec.trip.endsOn); spec.lifecycle.purgeAt = new Date(+new Date(spec.lifecycle.purgeAt) + delta).toISOString();
      doc.items.forEach(i => { i.day = shiftDay(i.day); if (i.startsAt) i.startsAt = new Date(+new Date(i.startsAt) + delta).toISOString(); if (i.endsAt) i.endsAt = new Date(+new Date(i.endsAt) + delta).toISOString(); });
      const operationId = operationFor(JSON.stringify({ spec, document: doc }));
      let result: { id: string; url?: string; replayed?: true };
      try { result = await api("/v1/publish", "POST", { spec, document: doc, confirm: true, operationId }); }
      catch (err) {
        // No answer, or the host failed: the trip may or may not be saved. Pressing again sends the same id, so it is made once.
        const status = (err as { status?: number }).status;
        if (status === undefined || status >= 500) { notice("送信できませんでした。もう一度「この内容でカプセルを作成」を押してください。二重には作られません。", true); return; }
        // This id can never succeed again (its trip was deleted, or it names other contents): the next press is a new trip.
        if (status === 409 || status === 410) settled();
        throw err;
      }
      // The id is kept: pressing again says the same, rather than making a second trip.
      if (!result.url) { modal("旅行は保存されています", `<p>オーナーの席はすでに登録されたか、オーナーリンクの受付期限（3日）を過ぎています。${localOnly ? "" : "受付期限を過ぎただけなら、トップの「オーナーを決めていない旅行」から決め直せます。"}オーナーの端末で開けなくなったときは、旅行を発行した人に <code>aws/recover.ts</code> でオーナーリンクを出し直してもらってください。</p>`); return; }
      unclaimed = { id: result.id, secret: new URLSearchParams(new URL(result.url).hash.slice(1)).get("k") ?? "", url: result.url }; chooseOwner();
    }
  } catch (err) { notice((err as Error).message, true); } finally { if (submit) submit.disabled = false; }
});
// The paste is judged by the host (POST /v1/check), never here: one place decides what a trip is.
function problems(messages: string[], source: "paste" | "assist" = "paste") {
  const list = document.querySelector<HTMLElement>(source === "assist" ? ".assist-problems" : ".paste-problems:not(.assist-problems)"); if (!list) return;
  const shown = messages.slice(0, 10), rest = messages.length - shown.length;
  list.innerHTML = shown.map(m => `<li>${e(m)}</li>`).join("") + (rest > 0 ? `<li class="muted">ほか ${rest} 件</li>` : "");
  list.hidden = messages.length === 0;
  if (messages.length) list.scrollIntoView({ block: "center", behavior: "smooth" });
}
const pasteReasons = { empty: "返事が貼られていません。チャットの答えを貼ってください。", "not-json": "旅程が見つかりません。チャットの返事を、前後の文ごとそのまま貼ってください。", many: "旅程が 2 つ以上あります。使いたい方だけを貼ってください。", "cut-off": "答えが途中で切れています。チャットの返事を最後まで貼ってください。" };
// What the host answered for a trip (POST /v1/check, or the finished job of POST /v1/assist): the same shape, shown the same way.
type Checked = { ok: boolean; reason?: keyof typeof pasteReasons; messages?: string[]; title?: string; purgeAt?: string; items?: number; trip?: { spec: unknown; document: unknown } };
const assistFailed = "生成に失敗しました。もう一度試すか、作り方をコピーしてチャットで作ってください";
async function checkPaste() {
  const field = document.querySelector<HTMLTextAreaElement>("[data-paste]"); if (!field) return;
  showChecked(await api("/v1/check", "POST", { text: field.value }) as Checked, "paste");
}
function showChecked(result: Checked, source: "paste" | "assist") {
  const reasons = source === "assist" ? { ...pasteReasons, "cut-off": "生成が途中で切れました。希望を短くしてもう一度試してください。" } : pasteReasons;
  if (!result.ok) { problems(result.reason ? [reasons[result.reason]] : result.messages ?? [], source); notice(source === "assist" ? "できた旅程を確認してください。" : "貼った内容を確認してください。", true); return; }
  problems([], source);
  view = { ...validate(result.trip!.spec, result.trip!.document, Date.now()), role: "owner", state: "draft" }; render();
  notice(`${result.title}（${result.items} 件の予定、${result.purgeAt?.slice(0, 10)} に自動削除）を読み込みました。まだ保存していません。`);
}
// The host writes the trip as a job; this asks every 3 seconds, and gives up after 150 seconds with the host's own wording.
async function runAssist() {
  const field = document.querySelector<HTMLTextAreaElement>("[data-assist]"), run = document.querySelector<HTMLButtonElement>('[data-action="assist-run"]'); if (!field || !run) return;
  const label = run.textContent; run.disabled = true; run.textContent = "作成中…（1 分ほどかかります）";
  try {
    let job: { id: string };
    try { job = await api("/v1/assist", "POST", { text: field.value }); }
    catch (err) { if ((err as { status?: number }).status === 412) { await creationHome(); notice((err as Error).message, true); return; } throw err; }
    // The host gives up on a job at 360 seconds and then says so; a little more than that is the most this waits.
    for (const end = Date.now() + 380_000; Date.now() < end;) {
      await new Promise(r => setTimeout(r, 3000));
      if (!run.isConnected) return;  // the screen moved on: do not replace it with a draft
      const state = await api(`/v1/assist/${job.id}`) as { state: string; result?: Checked; message?: string };
      if (state.state === "done") { showChecked(state.result!, "assist"); return; }
      if (state.state === "failed") { problems([state.message ?? assistFailed], "assist"); notice(state.message ?? assistFailed, true); return; }
    }
    problems([assistFailed], "assist"); notice(assistFailed, true);
  } catch (err) { notice((err as Error).message, true); }
  finally { run.disabled = false; run.textContent = label; }
}
// The host compares the answer with the trip (POST revise/check); the screen only shows what it found.
const changeNames = { added: "追加", changed: "変更", removed: "削除" };
function renderDiff(d: Diff) {
  const pair = (name: string, p?: [string, string]) => p ? [`<li><strong>${name}</strong> ${e(p[0])} → ${e(p[1])}</li>`] : [];
  const change = (r: Diff["items"][number], list = "") => `<li><span class="change ${r.change}">${changeNames[r.change]}</span>${list ? `${list}：` : ""}${e(r.title)}${r.fields ? `<ul>${r.fields.map(f => `<li>${e(f.field)}: ${e(f.before)} → ${e(f.after)}</li>`).join("")}</ul>` : ""}</li>`;
  const rows = [...pair("題", d.title), ...pair("日程", d.dates), ...pair("削除期限", d.purgeAt?.map(at => new Date(at).toLocaleString("ja", { timeZone: view.spec.timezone, dateStyle: "medium", timeStyle: "short" })) as [string, string] | undefined),
    ...(d.modules.length ? [`<li><strong>ページを追加</strong> ${e(d.modules.join("、"))}</li>`] : []),
    ...d.items.map(r => change(r)), ...d.suggestions.map(r => change(r, "候補")), ...d.comments.map(r => change(r, "相談")),
    ...(d.other.length ? [`<li><strong>ほかに変わる所</strong> ${e(d.other.join("、"))}</li>`] : [])];
  return rows.length ? `<ul class="diff">${rows.join("")}</ul>` : "";
}
// A large change asks for the trip's title, as deleting does; a small one for one check.
const approval = (form: string, d: Diff, label: string) => `<form data-form="${form}">${d.large ? `<p class="warning">大きな変更です（題か日程が変わる、今の予定の半分以上が削除・変更される、または今ある候補・相談が変更・削除されます）。</p><label>確認のため、今の題「${e(view.spec.title)}」を入力${d.title ? "（変更後の題ではありません）" : ""}<input name="title" required autocomplete="off"></label>` : `<label class="check"><input type="checkbox" required><span>この差分で${e(label)}</span></label>`}<button class="primary">${e(label)}</button></form>`;
// `next` (a sealed trip): the trip the diff on screen was made from here, sent sealed when it is applied.
type Next = { spec: Spec; document: Document };
let revising: { text: string; revision: number; next?: Next; large?: boolean } | undefined;
let undoing: { revision: number; next?: Next; large?: boolean; step?: { spec: SealedSpec; document: Partial<SealedDocument> } } | undefined;
// A sealed trip with a record this browser cannot open is not revised or undone here: the trip sent back would drop it.
const revisable = () => !view.unreadable?.length;
const notRevisable = "この端末で開けない記録があるため、チャットで直す・1 つ前に戻すは使えません（反映すると、その記録が消えるため）。";
// The next sealed trip, as POST revise and POST undo take it (spec「5.3 暗号化した旅行で Host にできないこと」). The title of a large change is compared here, as the host
// compares a plain trip's. A record left as it was keeps its ciphertext; the Spec of an editor's revise is the trip's own and an
// undo's is the step's, as they came; memories are not revised and go back as they came.
async function resealed(next: Next, large: boolean | undefined, title: string | undefined, step?: { spec: SealedSpec; document: Partial<SealedDocument> }) {
  if (large && !sameTitle(title, view.spec.title)) throw new Error("確認用のタイトルが一致しません。今の題を入力してください");
  if (!tripKey || !sealedNow) throw new Error("この端末には旅行の鍵がありません");
  // The 20-second refresh may have brought one since the diff was made.
  if (!revisable()) throw new Error(notRevisable);
  const t = await resealTrip(tripKey, id!, view.sealed!.generation, step ? [step, sealedNow] : [sealedNow], next);
  return { spec: step ? step.spec : view.role === "owner" ? t.spec : sealedNow.spec, document: { ...t.document, reflections: sealedNow.document.reflections }, confirm: true as const };
}
// A sealed trip's step back is opened here (GET undo gives it sealed) and set against the trip as this browser opened it (spec「5.3 暗号化した旅行で Host にできないこと」).
async function sealedUndo(): Promise<{ diff: Diff; revision: number; next?: Next; step?: { spec: SealedSpec; document: Partial<SealedDocument> } }> {
  const got = await api("undo") as { previous: Previous<SealedSpec, SealedDocument>; revision: number };
  if (got.revision !== view.document.revision) await reload();
  if (!revisable()) throw new Error(notRevisable);
  // What the step does not hold is the trip's as it stands.
  const opened = tripKey && sealedNow ? await openTrip(tripKey, id!, { spec: got.previous.spec, document: { ...sealedNow.document, ...got.previous.document } }) : null;
  if (!opened || opened.unreadable.length) throw new Error("1 つ前の旅程をこの端末で開けません");
  const { items, checklist, notes, budget, suggestions, comments } = opened.document, has = got.previous.document;
  const previous: Previous<Spec, Document> = { spec: opened.spec, document: { items, checklist, notes, budget, ...(has.suggestions ? { suggestions } : {}), ...(has.comments ? { comments } : {}) }, ...(got.previous.revisedIds ? { revisedIds: got.previous.revisedIds } : {}) };
  const r = undoTrip({ spec: view.spec, document: view.document }, previous, { created: view.created!, keepSpec: view.role !== "owner" });
  if (!r.ok) throw new Error(r.reason === "spec" ? "設定も戻るため、オーナーだけが戻せます" : r.reason === "none" ? "戻せる旅程がありません" : "1 つ前の旅程に戻せません");
  return { diff: r.diff, revision: got.revision, next: r.next, step: got.previous };
}
async function showUndo() {
  const back = view.sealed ? await sealedUndo() : await api("undo") as { diff: Diff; revision: number; next?: Next; step?: undefined };
  undoing = { revision: back.revision, next: back.next, large: back.diff.large, step: back.step };
  modal("1 つ前に戻す", `<p>最後に「チャットで直す」で反映する前の旅程（${view.role === "owner" ? "設定と" : ""}予定・候補・相談・準備リスト・メモ・費用メモ）に戻します。反映の後に手で直した予定・メモ${view.role === "owner" ? "・設定" : ""}も戻ります（下の差分に出ます）。反映の後に書かれた候補・相談・思い出とチェックの状態は残ります。戻せるのは 1 回だけです。</p><h3>戻すと変わるところ</h3>${renderDiff(back.diff) || "<p>今の旅程から変わるところはありません。</p>"}${approval("undo", back.diff, "戻す")}`);
}
// Revising on the host with this member's own Anthropic API key (#658). The key is the seat's alone: it is sent once, kept sealed,
// and never shown again; nobody else in the trip, nor the creator, can use it.
const sentDirect = () => view.sealed ? "鍵はこの端末のパスキーで包んで置き、旅程と鍵はこの端末から Anthropic に直接送ります（このサービスには届きません）。" : "";
const hostRevise = () => `<div data-host-revise>${view.assistKey
  ? `<h3>自分の API キーで、ここで直す</h3><p class="muted">下の「直してほしいこと」を、あなた自身の Anthropic API キーで直します。できた案は、同じ差分の確認に出ます。費用はあなたの Anthropic アカウントに請求されます。旅程と書いた内容は Anthropic に送られます。${sentDirect()}</p><div class="admin-actions">${button("ここで直す（1 分ほどかかります）", "revise-assist", "primary")}${button("API キーを削除", "revise-key-delete", "quiet danger-text")}</div><hr>`
  : `<h3>自分の API キーで、ここで直す</h3><p class="muted">自分の Anthropic API キーを登録すると、コピーして貼る手間なしに、ここで直せます。鍵はあなたの席だけのもので、ほかのメンバーや作成者は使えません。暗号化して保管し、画面には二度と表示しません。費用はあなたの Anthropic アカウントに請求されます。${sentDirect()}</p><form data-form="revise-key"><label>Anthropic API キー<input name="key" type="password" autocomplete="off" required placeholder="sk-ant-…"></label><button class="primary">鍵を登録</button></form><hr>`}</div>`;
// The key's part of the open チャットで直す, drawn again once a key is put or removed: the dialog may have come from the header or
// from 共有・管理, so it is redrawn where it is rather than opened again.
const redrawHostRevise = () => { const box = document.querySelector("#dialog [data-host-revise]"); if (box) box.outerHTML = hostRevise(); };
async function reviseAssist() {
  const request = document.querySelector<HTMLTextAreaElement>("[data-revise-request]"), paste = document.querySelector<HTMLTextAreaElement>("[data-revise-paste]"), run = document.querySelector<HTMLButtonElement>('[data-action="revise-assist"]');
  if (!request || !paste || !run) return;
  const label = run.textContent; run.disabled = true; run.textContent = "作成中…（1 分ほどかかります）";
  try {
    if (view.sealed) {
      const out = await sealedAssist(request.value).catch((err: Error) => ({ failed: err.message }));
      if (!run.isConnected) return;
      if ("failed" in out) { problems([out.failed]); notice(out.failed, true); return; }
      if (out.text === undefined) { problems([pasteReasons["cut-off"].replace("チャットの返事を最後まで貼ってください。", "直してほしいことを短くしてもう一度試してください。")]); notice("できた案を確認してください。", true); return; }
      paste.value = out.text; await checkRevise(); return;
    }
    const job = await api("revise/assist", "POST", { instruction: request.value }) as { id: string };
    for (const end = Date.now() + 380_000; Date.now() < end;) {
      await new Promise(r => setTimeout(r, 3000));
      if (!run.isConnected) return;  // the dialog was closed
      const state = await api(`revise/assist/${job.id}`) as { state: string; result?: { ok: boolean; text?: string; reason?: string }; message?: string };
      if (state.state === "done") {
        if (!state.result?.ok) { problems([pasteReasons["cut-off"].replace("チャットの返事を最後まで貼ってください。", "直してほしいことを短くしてもう一度試してください。")]); notice("できた案を確認してください。", true); return; }
        paste.value = state.result.text ?? ""; await checkRevise(); return;
      }
      if (state.state === "failed") { problems([state.message ?? assistFailed]); notice(state.message ?? assistFailed, true); return; }
    }
    problems([assistFailed]); notice(assistFailed, true);
  } catch (err) { notice((err as Error).message, true); }
  finally { run.disabled = false; run.textContent = label; }
}
// A sealed trip's 「ここで直す」 (#692, 回答 B; docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」): this browser sends the trip it opened and the request
// to Anthropic itself, under the member's own key, so the host never holds either in plain. The key is checked with Anthropic and
// kept on the seat wrapped with the passkey's PRF, as a memo key is; opened, it stays in memory only (a reload asks the passkey
// again). The call and the one repair are the host's own (generate in src/assist.ts), with no job to poll: the page waits.
// Kept with the wrapped value it came from: another tab may have put another key on the seat since.
let assistKeyOpened: { wrapped: string; key: string } | undefined;
const anthropic = (apiKey: string, timeout?: number) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0, ...(timeout ? { timeout } : {}) });
const assistPrf = async () => { const prf = await prfAssertion(); if (!prf) throw new Error(noPrf); return assistSealingKey(prf, id!); };
async function wrapAssistKey(key: string) {
  const refused = "この API キーは使えません。Anthropic Console で発行した鍵を貼ってください";
  if (!/^sk-ant-/.test(key) || key.length < 20 || key.length > 256) throw new Error(refused);
  try { await anthropic(key, 10_000).models.list(); }
  catch (err) { throw new Error(err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError ? refused : "Anthropic に接続できませんでした。時間をおいて再試行してください"); }
  const wrapped = await sealWords(await assistPrf(), key, `${id}/assist`);
  await api("key", "PUT", { wrapped });
  assistKeyOpened = { wrapped, key };
}
// The answer's text, or no text when it was cut off; a failure throws the words the host's runAssist says.
async function sealedAssist(request: string): Promise<{ text?: string }> {
  // Built as the host builds a plain trip's (revise/assist): today's date first, in the trip's time zone (#658).
  const text = `${todayLine(localDay(Date.now(), view.spec.timezone))}${reviseText(view.spec, view.document, view.role !== "owner")}${request.trim() ? `\n## 直してほしいこと\n\n${request.trim()}\n` : ""}`;
  if (new TextEncoder().encode(text).length > REVISE_LIMIT) throw new Error("旅程が長すぎて、ここでは直せません。「チャットで直す」でコピーして使ってください");
  if (!view.assistWrapped) throw new Error("Anthropic の API キーを登録してください");
  if (assistKeyOpened?.wrapped !== view.assistWrapped) assistKeyOpened = { wrapped: view.assistWrapped, key: await openWords(await assistPrf(), view.assistWrapped, `${id}/assist`) };
  const client = anthropic(assistKeyOpened.key), model = view.assistModel!;
  const problemsOf = async (answer: string) => { const r = await sealedCheck(answer); return r.ok ? [] : r.messages?.length ? r.messages : r.reason ? [pasteReasons[r.reason]] : []; };
  try {
    let out = await generate(client, model, text, REVISE_SYSTEM, undefined, 170_000);
    // What the check refuses is told back once; if the repair fails, the first answer stands (as on the host).
    if (out.kind === "text" && out.text.trim()) {
      const problems = await problemsOf(out.text);
      if (problems.length) try { const again = await generate(client, model, text, REVISE_SYSTEM, { answer: out.text, problems: problems.slice(0, 10) }, 100_000); if (again.kind === "text" && again.text.trim()) out = again; } catch { /* keep the first answer */ }
    }
    if (out.kind === "refused") throw new Error("この希望からは旅程を作れませんでした。内容を変えて試してください");
    return out.kind === "text" ? { text: out.text } : {};
  } catch (e) {
    if (!(e instanceof Anthropic.APIError)) throw e;
    const status = e.status, kind = (e as { error?: { error?: { type?: string } } }).error?.error?.type;
    if (status === 401 || status === 403) { assistKeyOpened = undefined; throw new Error("登録した API キーが Anthropic に拒否されました。鍵を登録し直してください"); }
    if (status === 429) throw new Error("Anthropic の利用上限に達しています。時間をおいて試してください");
    throw new Error(assistFailed + (e instanceof Anthropic.APIConnectionError ? "（原因: Anthropic に接続できないか、時間内に答えが返りませんでした）" : status !== undefined ? `（原因: ${status}${kind ? ` ${kind}` : ""}。${String(e.message).replace(/\s+/g, " ").slice(0, 200)}）` : ""));
  }
}
async function checkRevise() {
  const field = document.querySelector<HTMLTextAreaElement>("[data-revise-paste]"), out = document.querySelector<HTMLElement>(".revise-diff"); if (!field || !out) return;
  out.hidden = true; revising = undefined; problems([]);
  const result = view.sealed ? await sealedCheck(field.value) : await api("revise/check", "POST", { text: field.value }) as { ok: boolean; reason?: keyof typeof pasteReasons; messages?: string[]; diff?: Diff; revision?: number; next?: Next };
  if (!result.ok) { problems(result.reason ? [pasteReasons[result.reason]] : result.messages ?? []); notice("貼った内容を確認してください。", true); return; }
  // The title asked for is the trip's as the host has it: someone may have renamed it since this page loaded.
  if (result.revision !== view.document.revision) await reload();
  revising = { text: field.value, revision: result.revision!, next: result.next, large: result.diff!.large };
  const d = result.diff!, rows = renderDiff(d);
  out.innerHTML = !rows ? "<p>今の旅程から変わるところはありません。</p>" : `<h3>反映すると変わるところ</h3>${rows}${approval("revise", d, "反映する")}`;
  out.hidden = false; out.scrollIntoView({ block: "start", behavior: "smooth" });
}
// A sealed trip's answer is checked here, as the host checks a plain one's in revise/check (spec「5.3 暗号化した旅行で Host にできないこと」): the same function, against the
// trip as this browser opened it. A paste that is too long or not a trip is refused before anything is sent.
async function sealedCheck(text: string) {
  if (stale || view.document.revision !== (await api() as View).document.revision) await reload();
  // A reload may have brought a record this browser cannot open: an answer applied now would drop it.
  if (!revisable()) return { ok: false, messages: [notRevisable] };
  const now = Date.now(), r = reviseTrip({ spec: view.spec, document: view.document }, text, { author: view.label ?? "", at: new Date(now).toISOString(), created: view.created!, now, keepSpec: view.role !== "owner" });
  if (!r.ok) return "tooLong" in r ? { ok: false, messages: ["貼り付けが長すぎます。旅程の部分だけを貼ってください"] } : { ok: false, reason: r.reason, messages: r.messages };
  return { ok: true, diff: r.diff, revision: view.document.revision, next: r.next };
}
let joinSecret = "";
// A member of an owner-approved invite sees only this until the owner approves: the code to tell the owner by another route.
function pendingScreen(code: string) {
  app.innerHTML = `<main class="empty"><h1>オーナーの承認待ちです</h1><p class="code">${e(code)}</p><p>このコードをオーナーに伝えてください。承認されるとしおりが開きます。</p>${button("再読み込み", "pending-reload", "primary")}</main>`;
}
const returnByPasskey = passkeys ? `<p class="muted">すでに参加していて、パスキーを登録済みの方は</p>${button("パスキーで戻る", "passkey-login", "secondary")}` : "";
// Redeeming a seat is an explicit tap: it binds this browser, so an in-app webview or a wrong device must not take it silently.
function joinScreen() {
  const inApp = /Line\/|FBAN|FBAV|Instagram|MicroMessenger|Twitter/i.test(navigator.userAgent);
  app.innerHTML = `<main class="empty"><h1>旅のしおりに参加する</h1><p>このブラウザをメンバーとして登録します。登録すると、このブラウザに鍵（Cookie）が保存され、次からはこのブラウザで開けます。鍵が他人に渡るとその人も開けるので、共用の端末では登録しないでください。名前やパスワードの入力はありません。</p>${inApp ? '<p class="warning">アプリ内ブラウザで開いています。ここで登録すると、SafariやChromeからは開けません。メニューの「ブラウザで開く」から開き直すことをおすすめします。</p>' : ""}${button(inApp ? "このまま登録する" : "この端末で参加する", "join", "primary")}<p class="muted">リンクは定員に達すると使えなくなります。他の人へ転送しないでください。</p>${returnByPasskey}</main>`;
}
async function boot() {
  const secret = id ? new URLSearchParams(location.hash.slice(1)).get("k") ?? "" : "";
  try {
    const enrollment = id ? "" : new URLSearchParams(location.hash.slice(1)).get("creator") ?? "";
    if (enrollment) return await creatorEnrollScreen(enrollment);
    const delegation = id ? new URLSearchParams(location.hash.slice(1)).get("delegate") ?? "" : "";
    if (delegation) return await creatorEnrollScreen(delegation, id);
    if (id) { await reload(); void autoFootprint(); } else await creationHome();
    if (secret) history.replaceState(null, "", location.pathname);
  } catch (err) {
    // The link stays in the address bar until it is redeemed, so it can still be handed to the real browser.
    if (id && (err as { pending?: boolean }).pending) return pendingScreen((err as unknown as { code: string }).code);
    // A seat or a trip that is gone takes this browser's keys for it along (before a new invite may take a seat); a cookie only
    // unused for 30 days keeps them for the passkey.
    const { status, gone } = err as { status?: number; gone?: boolean };
    if (id && ([404, 410].includes(status ?? 0) || status === 401 && gone)) await forgetTrip(id);
    if (secret && status === 401) { joinSecret = secret; return joinScreen(); }
    if (id && status === 401) remember(list => list.filter(t => t.id !== id));
    app.innerHTML = `<main class="empty"><h1>しおりを開けませんでした。</h1><p>${e((err as Error).message)}</p>${id && (err as { status?: number }).status === 401 ? `<p>30 日使わなかったか、ログアウトしたか、失効しました。${passkeys ? "パスキーを登録していれば「パスキーで戻る」、なければ" : ""}オーナーに新しい招待を頼んでください。</p>${returnByPasskey}` : "<p>共有されたリンクから開き直してください。</p>"}</main>`; }
}
void boot();
document.addEventListener("visibilitychange", () => void autoFootprint());
// An enrollment link pasted into a tab already showing the top page changes only the fragment, as a delegation link does in a
// tab already showing its trip.
// On the trip's page it is read afresh, so that the trip shown before (and its reading every 20 seconds) is not drawn over the screen.
addEventListener("hashchange", () => { const link = new URLSearchParams(location.hash.slice(1)); if (id && link.get("delegate")) location.reload(); else if (!id && link.get("creator")) void boot(); });
setInterval(async () => {
  if (!id || !view || document.hidden || dialog.open || dragging) return;
  // Asked again after the request: a grip pressed while it was in flight must not have its day redrawn under the finger.
  // An answer asked for before this page read the trip again (a save, ここにいる, 再読込) can arrive after it: older than what is
  // shown, it shows nothing, whatever its revision (footprints move no revision).
  // Footprints move no revision: on their page, the map and the story, a point left or removed by another member redraws it too.
  try { const asked = loads, latest = await api() as View; if (asked !== loads || dragging || ordering || latest.document.revision < view.document.revision) return;
    const stepped = onFootprints() && (latest.footprints?.length !== view.footprints?.length || latest.footprints?.at(-1)?.id !== view.footprints?.at(-1)?.id);
    // Photos move no revision either: on their page, one put up or taken out by another member redraws it.
    const photoKey = (v: View) => (v.media ?? []).map(p => p.id).join();
    const photos = pageModules().find(m => m.id === tab)?.kind === "moments" && photoKey(latest) !== photoKey(view);
    const handoffKey = (v: View) => JSON.stringify([(v.waiting ?? []).map(w => w.id), Boolean(v.seatKey)]);
    const handoffs = handoffKey(latest) !== handoffKey(view);
    if (latest.document.revision !== view.document.revision || latest.state !== view.state || stepped || photos || handoffs) { if (app.querySelector("form") || stale) { notice("新しい更新があります。「再読込」で確認してください。入力中の内容はコピーしてから再読込してください。"); } else { view = latest; await openAll(); await openSealed(); render(); } } }
  catch (err) { notice((err as Error).message, true); }
}, 20000);
