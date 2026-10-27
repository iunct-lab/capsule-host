// A member's own entries are sealed in the browser, so the host keeps ciphertext only (#343, docs/ephemeral-trip-capsule.md「5.6 自分だけの予定・日記の鍵」).
// Each seat has one random memo key, wrapped with a key derived from its passkey's PRF output and kept on the seat; the browser
// that unwrapped it keeps it in IndexedDB as a key that cannot be taken out. crypto.subtle only: the screen and aws/verify.ts
// (under bun) share these functions.
import type { Spec } from "./schema";
const INFO = "capsule private entries v1";
// What the passkey's PRF is evaluated at: the same for every trip and seat, so one passkey gives one output (spec「5.6 自分だけの予定・日記の鍵」).
export const PRF_INPUT = new TextEncoder().encode(INFO);
const text = (s: string) => new TextEncoder().encode(s);
// base64url without padding. Built a character at a time: a sealed body is too long to spread into one call.
export const b64 = (b: ArrayBuffer | Uint8Array) => { let s = ""; for (const c of new Uint8Array(b)) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
// Ciphertext is `v1.` and the base64url of a fresh 12-byte IV followed by the AES-GCM output (its 16-byte tag included).
// Under a trip's key it also names the key's generation, `v1.<generation>.` (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」); base64url has no
// `.`, so the two forms never mix.
export const pack = (iv: Uint8Array, data: ArrayBuffer, generation?: number) => { const out = new Uint8Array(12 + data.byteLength); out.set(iv); out.set(new Uint8Array(data), 12); return `v1.${generation === undefined ? "" : `${generation}.`}${b64(out)}`; };
export function unpack(sealed: string) {
  const m = /^v1\.(?:([1-9][0-9]{0,5})\.)?([A-Za-z0-9_-]+)$/.exec(sealed);
  if (!m) throw new Error("not v1. ciphertext");
  const raw = unb64(m[2]!); if (raw.length < 28) throw new Error("not v1. ciphertext");
  return { ...(m[1] ? { generation: Number(m[1]) } : {}), iv: raw.slice(0, 12), data: raw.slice(12) };
}
// The key that wraps the memo key: HKDF-SHA-256 of the PRF output (already 32 uniform bytes, so no salt), bound to the trip.
export async function wrappingKey(prf: BufferSource, capsuleId: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: text(`${INFO}/${capsuleId}`) }, base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}
// The key that seals a seat's Anthropic API key on a sealed trip (#787): from the same PRF output, under its own info, so it is
// never the memo key's wrapping key. The API key is words, not a CryptoKey, so this one encrypts and decrypts (seal / open).
export async function assistSealingKey(prf: BufferSource, capsuleId: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: text(`${INFO}/${capsuleId}/assist`) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
// Extractable only so it can be wrapped; the copy a browser keeps is unwrapped again as one that cannot be taken out.
export const newMemoKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
export async function wrapMemoKey(memo: CryptoKey, wrapping: CryptoKey, capsuleId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return pack(iv, await crypto.subtle.wrapKey("raw", memo, wrapping, { name: "AES-GCM", iv, additionalData: text(capsuleId) }));
}
export async function unwrapMemoKey(wrapped: string, wrapping: CryptoKey, capsuleId: string, extractable = false): Promise<CryptoKey> {
  const { iv, data } = unpack(wrapped);
  return crypto.subtle.unwrapKey("raw", data, wrapping, { name: "AES-GCM", iv, additionalData: text(capsuleId) }, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
}
// `aad` names where the text belongs, so a ciphertext moved to another entry or field, or put next to other plain dates, fails to open.
export async function seal(key: CryptoKey, plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return pack(iv, await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text(aad) }, key, text(plain)));
}
export async function open(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  const { iv, data } = unpack(sealed);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: text(aad) }, key, data));
}
// An entry as its writer sees it, and as the host keeps it: the title, body and place (as JSON) sealed, the rest plain.
export type PlainEntry = { id: string; kind: "item" | "diary"; day: string; startsAt?: string; endsAt?: string; title: string; body: string; place?: { label: string; publicUrl?: string } };
export type SealedEntry = Omit<PlainEntry, "title" | "body" | "place"> & { title: string; body: string; place?: string };
// Each field is sealed against the entry's plain parts, so a ciphertext moved to another entry or field, or a date or time
// rewritten where the host keeps it, no longer opens (spec「5.6 自分だけの予定・日記の鍵」). The times are the strings as written.
export const aadOf = (e: Pick<PlainEntry, "id" | "kind" | "day" | "startsAt" | "endsAt">, field: "title" | "body" | "place") => `${e.id}/${field}/${e.kind}/${e.day}/${e.startsAt ?? ""}/${e.endsAt ?? ""}`;
export async function sealEntry(key: CryptoKey, e: PlainEntry): Promise<SealedEntry> {
  const { title, body, place, ...plain } = e;
  return { ...plain, title: await seal(key, title, aadOf(e, "title")), body: await seal(key, body, aadOf(e, "body")), ...(place ? { place: await seal(key, JSON.stringify(place), aadOf(e, "place")) } : {}) };
}
// null when any field fails to open: the entry is shown as one this browser cannot read.
export async function openEntry(key: CryptoKey, e: SealedEntry): Promise<PlainEntry | null> {
  try {
    const { id, kind, day, startsAt, endsAt } = e, plain = { id, kind, day, ...(startsAt !== undefined ? { startsAt } : {}), ...(endsAt !== undefined ? { endsAt } : {}) };
    return { ...plain, title: await open(key, e.title, aadOf(e, "title")), body: await open(key, e.body, aadOf(e, "body")), ...(e.place ? { place: JSON.parse(await open(key, e.place, aadOf(e, "place"))) } : {}) };
  } catch { return null; }
}
// A member's own plans and diary as Markdown, made in the browser from what it could open (the host has ciphertext only, spec「5.6 自分だけの予定・日記の鍵」).
// Times read in the trip's zone. The Markdown escaping lives here and src/export.ts uses it too.
export const md = (s: string) => s.replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");
export function privateMarkdown(spec: Spec, entries: PlainEntry[], unreadable: number, exportedAt: string) {
  const time = (at: string) => new Intl.DateTimeFormat("ja", { timeZone: spec.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  const text = (s: string) => md(s).replace(/\r?\n/g, "\n  ");
  const lines = ["---", `title: ${JSON.stringify(spec.title)}`, `startsOn: ${spec.trip.startsOn}`, `endsOn: ${spec.trip.endsOn}`, `exportedAt: ${exportedAt}`, "---", "", `# ${md(spec.title)}（自分のメモ）`, ...(unreadable > 0 ? ["", `この端末で読めなかった ${unreadable} 件は含まれていません。`] : [])];
  for (const day of [...new Set(entries.map(e => e.day))].sort()) {
    lines.push("", `## ${day}`, "");
    for (const e of entries.filter(e => e.day === day)) lines.push(e.kind === "item" ? `- **${e.startsAt ? `${time(e.startsAt)} ` : ""}${md(e.title)}**${e.body ? ` ${text(e.body)}` : ""}` : `- ${e.title ? `**${md(e.title)}** ` : ""}${text(e.body)}`);
  }
  return lines.join("\n") + "\n";
}
