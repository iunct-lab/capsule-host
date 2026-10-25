import { z } from "zod";

const short = z.string().trim().min(1).max(160);
const identifier = short.regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().trim().max(4000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const n = new Date(v); return !isNaN(+n) && n.toISOString().slice(0, 10) === v;
}, "実在する日付を指定してください");
const instant = z.string().datetime({ offset: true });
const zone = z.string().max(80).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } });
const url = z.string().url().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } }, "公開HTTPS URLのみ使用できます");
// The page kinds, with the label's type as the argument: plain words, or ciphertext in a sealed trip (§3.1).
const modulesOf = <L extends z.ZodTypeAny>(label: L) => z.discriminatedUnion("kind", [
  z.object({ id: identifier, kind: z.literal("day-timeline"), label }).strict(),
  z.object({ id: identifier, kind: z.literal("places"), label, groupBy: z.enum(["area", "category"]).optional() }).strict(),
  z.object({ id: identifier, kind: z.literal("suggestion-board"), label }).strict(),
  z.object({ id: identifier, kind: z.literal("checklist"), label, mode: z.literal("shared") }).strict(),
  z.object({ id: identifier, kind: z.literal("budget"), label, currency: z.literal("JPY") }).strict(),
  z.object({ id: identifier, kind: z.literal("notes"), label }).strict(),
  z.object({ id: identifier, kind: z.literal("reflection"), label }).strict(),
  z.object({ id: identifier, kind: z.literal("trip-map"), label, showPhotos: z.boolean().optional(), showTrack: z.boolean() }).strict(),
  z.object({ id: identifier, kind: z.literal("story"), label }).strict(),
]);
// The rules on a Spec's plain parts, the same for a plain and a sealed trip.
type SpecPlain = { modules: Array<{ id: string }>; navigation: string[]; trip: { startsOn: string; endsOn: string }; lifecycle: { purgeAt: string } };
function specRules(s: SpecPlain, ctx: z.RefinementCtx) {
  const ids = s.modules.map(m => m.id);
  if (new Set(ids).size !== ids.length || new Set(s.navigation).size !== s.navigation.length || s.navigation.some(id => !ids.includes(id))) ctx.addIssue({ code: "custom", message: "モジュールID・navigationが不正です" });
  if (+new Date(s.trip.endsOn) - +new Date(s.trip.startsOn) > 180 * 86400000) ctx.addIssue({ code: "custom", message: "旅行期間は180日以内です" });
  if (s.trip.endsOn < s.trip.startsOn || s.lifecycle.purgeAt.slice(0, 10) <= s.trip.endsOn) ctx.addIssue({ code: "custom", message: "旅行期間と削除期限の順序が不正です" });
}
export const specSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("trip"), title: short, summary: text.optional(),
  locale: z.enum(["ja", "en"]), timezone: zone,
  trip: z.object({ startsOn: day, endsOn: day, destinations: z.array(short).min(1).max(30) }).strict(),
  modules: z.array(modulesOf(short)).min(1).max(12), navigation: z.array(identifier).min(1).max(12),
  theme: z.object({ preset: z.enum(["paper", "postcard", "minimal", "night"]), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict(),
  collaboration: z.object({ participantSuggestions: z.boolean(), participantComments: z.boolean(), participantChecklist: z.boolean() }).strict(),
  lifecycle: z.object({ reflectionDays: z.number().int().min(0).max(30), purgeAt: instant }).strict(),
  exports: z.array(z.enum(["markdown", "json", "ics", "html"])).min(1).max(4),
  presentation: z.object({
    kicker: short, postcardLabel: short, postcardCaption: short,
    dayHeadings: z.array(z.object({ day, title: short }).strict()).max(180),
    travelers: z.array(z.object({ name: short, note: z.string().max(160).optional() }).strict()).max(50),
  }).strict().optional(),
}).strict().superRefine(specRules);
export const itemSchema = z.object({
  id: identifier, kind: z.enum(["transport", "stay", "activity", "meal", "note"]), status: z.enum(["proposed", "confirmed", "cancelled"]),
  title: short, day, startsAt: instant.optional(), timeTentative: z.boolean().optional(), endsAt: instant.optional(), timezone: zone.optional(),
  place: z.object({ label: short, address: text.optional(), publicUrl: url.optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }).strict()
    .refine(p => (p.lat === undefined) === (p.lng === undefined), "緯度と経度は両方そろえてください").optional(),
  description: text.optional(), tags: z.array(short).max(10).optional(), revision: z.number().int().min(1),
}).strict().refine(v => !v.startsAt || !v.endsAt || +new Date(v.endsAt) >= +new Date(v.startsAt), "終了時刻が開始時刻より前です");
const entry = { id: identifier, author: short, body: text.min(1), createdAt: instant };
export const documentSchema = z.object({
  revision: z.number().int().min(1), items: z.array(itemSchema).max(300),
  suggestions: z.array(z.object({ ...entry, promoted: z.boolean(), itemId: identifier.optional() }).strict()).max(300),
  checklist: z.array(z.object({ id: identifier, title: short, done: z.boolean() }).strict()).max(200),
  comments: z.array(z.object(entry).strict()).max(500),
  reflections: z.array(z.object({ ...entry, included: z.boolean() }).strict()).max(300),
  notes: text, budget: z.array(z.object({ id: identifier, title: short, amount: z.number().int().min(0).max(100000000), description: text }).strict()).max(100),
}).strict();
export type Spec = z.infer<typeof specSchema>;
export type Document = z.infer<typeof documentSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Role = "owner" | "editor" | "participant" | "viewer";
export type State = "active" | "reflection" | "frozen" | "purged";
// The rules on the parts the host can read: the purge date, each item's day and time within the trip, unique ids, the size.
function rules<S extends SpecPlain & { timezone: string }, D extends { items: Array<{ id: string; day: string; startsAt?: string; timezone?: string }> } & Record<"suggestions" | "checklist" | "comments" | "reflections" | "budget", Array<{ id: string }>>>(s: S, d: D, createdAt: number) {
  if (+new Date(s.lifecycle.purgeAt) > createdAt + 180 * 86400000) throw new Error("削除期限は作成から180日以内です");
  if (d.items.some(i => i.day < s.trip.startsOn || i.day > s.trip.endsOn || (i.startsAt && localDay(+new Date(i.startsAt), i.timezone ?? s.timezone) !== i.day))) throw new Error("旅程の日付・時刻が旅行期間と一致しません");
  for (const list of [d.items, d.suggestions, d.checklist, d.comments, d.reflections, d.budget]) if (new Set(list.map(x => x.id)).size !== list.length) throw new Error("IDが重複しています");
  if (new TextEncoder().encode(JSON.stringify({ spec: s, document: d })).length > 2 * 1024 * 1024) throw new Error("カプセルは2 MiB以内です");
  return { spec: s, document: d };
}
export function validate(spec: unknown, document: unknown, createdAt: number) {
  return rules(specSchema.parse(spec), documentSchema.parse(document), createdAt);
}
// A sealed trip as the host keeps it (docs/design/trip-e2e.md §3.1): the words are `v1.<generation>.` ciphertext under the
// trip's key, the parts the host works with stay plain. Each limit is that of the longest plain text the field allows
// (3 bytes a character, JSON's quotes), sealed. The host checks only the plain parts and the ciphertext's form; the words
// are checked by the browser, before sealing and after opening (§4).
export const CIPHER = { short: 700, text: 16_100, item: 64_000, destinations: 40_000, travelers: 100_000, amount: 100 };
export const cipher = (max: number) => z.string().regex(/^v1\.[1-9][0-9]{0,5}\.[A-Za-z0-9_-]+$/).max(max);
export const sealedSpecSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("trip"), title: cipher(CIPHER.short), summary: cipher(CIPHER.text).optional(),
  locale: z.enum(["ja", "en"]), timezone: zone,
  trip: z.object({ startsOn: day, endsOn: day, destinations: cipher(CIPHER.destinations) }).strict(),
  modules: z.array(modulesOf(cipher(CIPHER.short))).min(1).max(12), navigation: z.array(identifier).min(1).max(12),
  theme: specSchema.innerType().shape.theme, collaboration: specSchema.innerType().shape.collaboration,
  lifecycle: specSchema.innerType().shape.lifecycle, exports: specSchema.innerType().shape.exports,
  presentation: z.object({
    kicker: cipher(CIPHER.short), postcardLabel: cipher(CIPHER.short), postcardCaption: cipher(CIPHER.short),
    dayHeadings: z.array(z.object({ day, title: cipher(CIPHER.short) }).strict()).max(180),
    travelers: cipher(CIPHER.travelers),
  }).strict().optional(),
}).strict().superRefine(specRules);
// An item's kind, status, title, place, description and tags are one ciphertext; its date and times stay plain for the host to place it.
export const sealedItemSchema = z.object({
  id: identifier, day, startsAt: instant.optional(), timeTentative: z.boolean().optional(), endsAt: instant.optional(), timezone: zone.optional(),
  revision: z.number().int().min(1), sealed: cipher(CIPHER.item),
}).strict().refine(v => !v.startsAt || !v.endsAt || +new Date(v.endsAt) >= +new Date(v.startsAt), "終了時刻が開始時刻より前です");
// `seat`: the `Session.id` that wrote a post, kept plain by the host. Posts written before the trip was sealed have none.
const sealedEntry = { id: identifier, author: cipher(CIPHER.short), body: cipher(CIPHER.text), createdAt: instant, seat: z.string().max(160).optional() };
export const sealedDocumentSchema = z.object({
  revision: z.number().int().min(1), items: z.array(sealedItemSchema).max(300),
  suggestions: z.array(z.object({ ...sealedEntry, promoted: z.boolean(), itemId: identifier.optional() }).strict()).max(300),
  checklist: z.array(z.object({ id: identifier, title: cipher(CIPHER.short), done: z.boolean() }).strict()).max(200),
  comments: z.array(z.object(sealedEntry).strict()).max(500),
  reflections: z.array(z.object({ ...sealedEntry, included: z.boolean() }).strict()).max(300),
  notes: cipher(CIPHER.text), budget: z.array(z.object({ id: identifier, title: cipher(CIPHER.short), amount: cipher(CIPHER.amount), description: cipher(CIPHER.text) }).strict()).max(100),
}).strict();
export type SealedSpec = z.infer<typeof sealedSpecSchema>;
export type SealedDocument = z.infer<typeof sealedDocumentSchema>;
export type SealedItem = z.infer<typeof sealedItemSchema>;
export function validateSealed(spec: unknown, document: unknown, createdAt: number) {
  return rules(sealedSpecSchema.parse(spec), sealedDocumentSchema.parse(document), createdAt);
}
// What a member asks of the trip's document (PATCH document). The screen checks a plain one with this before sealing it (§4).
export const author = z.string().trim().min(1).max(80);
const body = z.string().trim().min(1).max(4000);
const posts = z.enum(["suggestions", "comments"]);
export const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("check"), id: z.string(), done: z.boolean() }).strict(),
  z.object({ type: z.literal("suggest"), author, body }).strict(),
  z.object({ type: z.literal("comment"), author, body }).strict(),
  z.object({ type: z.literal("reflect"), author, body }).strict(),
  // One post's words, or the post itself. Who wrote it and when stay; an item it was added to the plan as stays too.
  z.object({ type: z.literal("rewrite"), list: posts, id: z.string(), body }).strict(),
  z.object({ type: z.literal("remove"), list: posts, id: z.string() }).strict(),
  z.object({ type: z.literal("include"), id: z.string(), included: z.boolean() }).strict(),
  // `after`: a new item goes right after that item of its day, at the time the host fits there (the "＋" between two items).
  z.object({ type: z.literal("item"), item: itemSchema, after: z.string().optional() }).strict(),
  z.object({ type: z.literal("promote"), id: z.string(), day: z.string() }).strict(),
  z.object({ type: z.literal("notes"), body: z.string().max(4000) }).strict(),
  // One item goes before another of its day, or last (`before: null`). The host, not the screen, decides what time it gets there.
  z.object({ type: z.literal("move"), id: z.string(), before: z.string().nullable() }).strict(),
  // The whole list at once, as the screen's form holds it, stored trimmed; the shape and the ranges are left to `validate` below.
  z.object({ type: z.literal("checklist"), checklist: z.array(z.object({ id: z.string(), title: z.string().trim() }).strict()).max(200) }).strict(),
  z.object({ type: z.literal("budget"), budget: z.array(z.object({ id: z.string(), title: z.string().trim(), amount: z.number(), description: z.string().trim() }).strict()).max(100) }).strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
// The same asks in a sealed trip: the words arrive as ciphertext. A post's id is the screen's, since its words are sealed
// against it; promoting a suggestion brings the item the screen made from it, and the host still picks its place and time.
export const sealedOperationSchema = z.discriminatedUnion("type", [
  operationSchema.options[0],
  z.object({ type: z.literal("suggest"), id: identifier, author: cipher(CIPHER.short), body: cipher(CIPHER.text) }).strict(),
  z.object({ type: z.literal("comment"), id: identifier, author: cipher(CIPHER.short), body: cipher(CIPHER.text) }).strict(),
  z.object({ type: z.literal("reflect"), id: identifier, author: cipher(CIPHER.short), body: cipher(CIPHER.text) }).strict(),
  z.object({ type: z.literal("rewrite"), list: posts, id: z.string(), body: cipher(CIPHER.text) }).strict(),
  operationSchema.options[5], operationSchema.options[6],
  z.object({ type: z.literal("item"), item: sealedItemSchema, after: z.string().optional() }).strict(),
  z.object({ type: z.literal("promote"), id: z.string(), day: z.string(), item: z.object({ id: identifier, sealed: cipher(CIPHER.item) }).strict() }).strict(),
  z.object({ type: z.literal("notes"), body: cipher(CIPHER.text) }).strict(),
  operationSchema.options[10],
  z.object({ type: z.literal("checklist"), checklist: z.array(z.object({ id: z.string(), title: cipher(CIPHER.short) }).strict()).max(200) }).strict(),
  z.object({ type: z.literal("budget"), budget: z.array(z.object({ id: z.string(), title: cipher(CIPHER.short), amount: cipher(CIPHER.amount), description: cipher(CIPHER.text) }).strict()).max(100) }).strict(),
]);
export type SealedOperation = z.infer<typeof sealedOperationSchema>;
// A new trip gives every item a time: one not yet decided is written anyway and marked `timeTentative`. Only publishing
// asks for this; a trip published before, which may hold items without one, is still read, edited and revised as it is
// (`allowed`: the ids of the items it already held without a time).
export function untimed(document: Document, allowed: string[] = []) {
  return document.items.flatMap((i, n) => i.startsAt || allowed.includes(i.id) ? [] : [{ path: `document.items.${n}.startsAt`, message: "開始時刻を書いてください（決まっていなければ妥当な時刻と timeTentative: true）" }]);
}
// The title typed to confirm a purge or a large change, as a phone types it: a space after a predicted word, full-width
// spaces and letters. What is compared is what a person sees, not the code points. The screen compares it for a sealed trip,
// whose title the host cannot read (docs/design/trip-e2e.md §4).
export const seen = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim();
export const sameTitle = (given: string | undefined, title: string) => given !== undefined && seen(given) === seen(title);
export function localDay(now: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k)!.value).join("-");
}
export function stateOf(spec: Pick<Spec, "lifecycle" | "timezone"> & { trip: { endsOn: string } }, forced: string | null, now: number): State {
  if (now >= +new Date(spec.lifecycle.purgeAt)) return "purged";
  if (forced === "frozen") return "frozen";
  const today = localDay(now, spec.timezone);
  if (today <= spec.trip.endsOn) return "active";
  const last = new Date(spec.trip.endsOn); last.setUTCDate(last.getUTCDate() + spec.lifecycle.reflectionDays);
  return today <= last.toISOString().slice(0, 10) ? "reflection" : "frozen";
}
