// The trip as a Domain Kit (src/kit.ts): its shapes, exports and checks stay where they were (src/schema.ts, export.ts,
// revise.ts, recipe.ts, validate.ts, paste.ts) and are put together here, with what a member's request does to the
// document, so a published trip reads and writes as before.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { refuse, type DomainKit } from "./kit";
import { localDay } from "./fields";
import { validate, validateSealed, untimed, stateOf, operationSchema, sealedOperationSchema, sealedSpecSchema, sealedDocumentSchema, type Spec, type Document, type SealedSpec, type SealedDocument, type SealedOperation } from "./schema";
import { exportFiles, tripHtml, tripMarkdown, zip } from "./export";
import { refusal, reviseText, reviseTrip, undoTrip, same, type Previous } from "./revise";
import { recipe } from "./recipe";
import { check } from "./validate";
import { extract, explain } from "./paste";
import { GENERATE_SYSTEM, REVISE_SYSTEM, todayLine } from "./assist";
import { placeholder, type Timed } from "./timing";

// A trip as the host keeps it: plain, or sealed with its words as ciphertext (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」).
// The exports read a plain one only; the host refuses them for a sealed trip before they are reached.
export type TripSpec = Spec | SealedSpec;
export type TripDocument = Document | SealedDocument;
const uid = () => randomBytes(16).toString("hex");

const instant = (at?: string) => at === undefined ? undefined : +new Date(at);
// Puts one item where its time belongs among its day's items: before the first one that starts later, or after the day's last.
// Only this item moves: the others keep their order, in step or not, and a published trip is never sorted as a whole.
// Without a time there is nowhere it belongs: it stays where it was, or goes last when it is new.
type Placed = Timed & { revision: number; timeTentative?: boolean };
// The document as PATCH document works on it, plain or sealed: what the operations read and write is the same in both forms,
// the words being plain text or ciphertext (src/schema.ts). The form is checked as a whole after each operation.
type Post = { id: string; author: string; body: string; createdAt: string; seat?: string };
type Doc = { revision: number; items: Placed[]; suggestions: Array<Post & { promoted: boolean; itemId?: string }>; comments: Post[]; reflections: Array<Post & { included: boolean }>; checklist: Array<{ id: string; title: string; done: boolean }>; notes: string; budget: Array<{ id: string; title: string; amount: number | string; description: string }> };
function placeByTime<T extends Placed>(items: T[], item: T): T[] {
  const was = items.findIndex(x => x.id === item.id), rest = items.filter(x => x.id !== item.id), at = instant(item.startsAt);
  if (at === undefined) { rest.splice(was < 0 ? rest.length : was, 0, item); return rest; }
  const later = rest.findIndex(x => x.day === item.day && x.startsAt !== undefined && instant(x.startsAt)! > at), last = rest.map(x => x.day).lastIndexOf(item.day);
  rest.splice(later >= 0 ? later : last >= 0 ? last + 1 : rest.length, 0, item); return rest;
}

// The start an item takes where it was dropped or added, by the rule in `timing.ts`. A time the host chooses is a placeholder,
// so the item is marked `timeTentative`; one that already fits is kept, mark and version too. The end moves along; an item that
// had no start keeps its end only when it still comes after the new start.
function retime<T extends Placed>(items: T[], index: number, timezone: string): T | undefined {
  const item = items[index]!, now = instant(item.startsAt), at = placeholder(items, index, timezone); if (at === undefined) return;
  const end = instant(item.endsAt), endsAt = end === undefined ? undefined : now !== undefined ? end + at - now : end >= at ? end : undefined;
  const { endsAt: _, ...rest } = item;
  return { ...rest, startsAt: new Date(at).toISOString(), ...(endsAt !== undefined ? { endsAt: new Date(endsAt).toISOString() } : {}), timeTentative: true, revision: item.revision + 1 } as T;
}


export const tripKit: DomainKit<TripSpec, TripDocument> = {
  kind: "trip",
  publish(spec, document, now) {
    let data: ReturnType<typeof validate>; try { data = validate(spec, document, now); } catch { return refuse(400, "旅程と期限を確認してください"); }
    if (untimed(data.document).length) refuse(400, "開始時刻の無い予定があります。時刻を書くか、決まっていなければ妥当な時刻と timeTentative: true を入れてください");
    return data;
  },
  validate: (spec, document, createdAt, sealed) => sealed ? validateSealed(spec, document, createdAt) : validate(spec, document, createdAt),
  stateOf,
  accent: spec => spec.theme.accent,
  refusal,
  period: spec => ({ startsOn: spec.trip.startsOn, endsOn: spec.trip.endsOn, timezone: spec.timezone }),
  hasItem: (document, id) => document.items.some(i => i.id === id),
  exports: {
    zip: async (id, spec, document, updatedAt) => zip(await exportFiles(id, spec as Spec, document as Document, updatedAt)),
    name: spec => `trip-${spec.trip.startsOn}.zip`,
    markdown: (spec, document) => tripMarkdown(spec as Spec, document as Document),
    html: (spec, document) => tripHtml(spec as Spec, document as Document),
  },
  recipe: { text: recipe.text, generate: GENERATE_SYSTEM },
  // Only the two parts check() validated come back, so the screen shows what the host checked; anything else the answer
  // carried is not echoed.
  judge(text, now) {
    const taken = extract(text);
    if (!taken.ok) return { ok: false, reason: taken.reason };
    const checked = check(taken.value, now);
    if (!checked.ok) return { ...checked, messages: explain(checked.errors) };
    const { spec, document } = taken.value as { spec: unknown; document: unknown };
    return { ...checked, trip: { spec, document } };
  },
  apply({ spec, document, created, sealed, role, state, seat, now }, input) {
    // A sealed trip's records arrive as ciphertext (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」): the roles are checked by the kind of
    // operation as before, and only where the forms differ (a post's id and seat, the item a promotion brings) is there a branch.
    const op = sealed ? sealedOperationSchema.parse(input) : operationSchema.parse(input), doc = document as Doc, editor = role === "owner" || role === "editor";
    if (state === "reflection" && !editor && op.type !== "reflect") refuse(403, "旅行後は思い出のみ追記できます");
    if (!editor && ["item", "promote", "notes", "include", "move", "checklist", "budget", "rewrite", "remove"].includes(op.type)) refuse(403, "確定旅程の編集はオーナー・編集者のみです");
    if (!editor && ((op.type === "suggest" && !spec.collaboration.participantSuggestions) || (op.type === "comment" && !spec.collaboration.participantComments) || (op.type === "check" && !spec.collaboration.participantChecklist))) refuse(403, "この操作は許可されていません");
    const kinds: Record<string, string> = { check: "checklist", suggest: "suggestion-board", comment: "suggestion-board", reflect: "reflection", include: "reflection", item: "day-timeline", promote: "suggestion-board", notes: "notes", move: "day-timeline", checklist: "checklist", budget: "budget", rewrite: "suggestion-board", remove: "suggestion-board" };
    if (!spec.modules.some(m => m.kind === kinds[op.type] && spec.navigation.includes(m.id))) refuse(403, "このモジュールは無効です");
    if (op.type === "check") { const t = doc.checklist.find(x => x.id === op.id); if (!t) refuse(404, "項目が見つかりません"); t.done = op.done; }
    // A sealed post keeps the id its words were sealed against, and the seat that wrote it.
    const post = (list: "suggestions" | "comments" | "reflections") => {
      const at = new Date(now).toISOString();
      if (!("id" in op)) return { id: uid(), createdAt: at };
      if (doc[list].some(x => x.id === op.id)) refuse(400, "投稿を確認してください");
      return { id: op.id, seat, createdAt: at };
    };
    if (op.type === "suggest") doc.suggestions.push({ ...post("suggestions"), author: op.author, body: op.body, promoted: false });
    if (op.type === "comment") doc.comments.push({ ...post("comments"), author: op.author, body: op.body });
    if (op.type === "rewrite") { const t = doc[op.list].find(x => x.id === op.id); if (!t) refuse(404, "投稿が見つかりません"); t.body = op.body; }
    if (op.type === "remove") { const i = doc[op.list].findIndex(x => x.id === op.id); if (i < 0) refuse(404, "投稿が見つかりません"); doc[op.list].splice(i, 1); }
    if (op.type === "reflect") doc.reflections.push({ ...post("reflections"), author: op.author, body: op.body, included: false });
    if (op.type === "include") { const t = doc.reflections.find(x => x.id === op.id); if (!t) refuse(404, "項目が見つかりません"); t.included = op.included; }
    if (op.type === "notes") doc.notes = op.body;
    // A check stays with its item through a rename; an item new to the list comes in unchecked.
    if (op.type === "checklist") doc.checklist = op.checklist.map(x => ({ ...x, done: doc.checklist.find(o => o.id === x.id)?.done ?? false }));
    if (op.type === "budget") doc.budget = op.budget;
    let moved: { id: string; startsAt: string } | undefined;
    if (op.type === "item" && op.after !== undefined) {
      const target = doc.items.findIndex(x => x.id === op.after);
      if (doc.items.some(x => x.id === op.item.id) || target < 0 || doc.items[target]!.day !== op.item.day) refuse(400, "予定の並びを確認してください");
      doc.items.splice(target + 1, 0, { ...op.item, revision: 1 });
      const retimed = retime(doc.items, target + 1, spec.timezone); if (retimed) { doc.items[target + 1] = { ...retimed, revision: 1 }; moved = { id: retimed.id, startsAt: retimed.startsAt! }; }
    } else if (op.type === "item") {
      // The list is shown as stored, so a time that changed has to move the item; an edit of anything else leaves it where it is.
      const i = doc.items.findIndex(x => x.id === op.item.id), old = doc.items[i], next = { ...op.item, revision: old ? old.revision + 1 : 1 };
      if (!old || old.day !== next.day || instant(old.startsAt) !== instant(next.startsAt)) doc.items = placeByTime(doc.items, next); else doc.items[i] = next;
    }
    if (op.type === "promote") { const t = doc.suggestions.find(x => x.id === op.id); if (!t || t.promoted) refuse(400, "候補が存在しないか追加済みです");
      // In a sealed trip the screen made the item from the suggestion's words, under its own id; the place and time are still the host's.
      const given = "item" in op ? (op as Extract<SealedOperation, { type: "promote" }>).item : undefined;
      if (given && doc.items.some(x => x.id === given.id)) refuse(400, "予定の並びを確認してください");
      const itemId = given?.id ?? uid(); t.promoted = true; t.itemId = itemId;
      // The day is checked with the rest of the trip below, but a time cannot even be worked out for a day that is no date or
      // lies far outside the trip (a zone's offset in 1800 is not whole minutes).
      if (isNaN(Date.parse(`${op.day}T00:00:00Z`)) || op.day < spec.trip.startsOn || op.day > spec.trip.endsOn) refuse(400, "旅程の日付・内容・容量を確認してください");
      // After the day's last item, at the time the host gives it there (a placeholder). A new item stays at version 1.
      const last = doc.items.map(x => x.day).lastIndexOf(op.day), to = last < 0 ? doc.items.length : last + 1;
      doc.items.splice(to, 0, given ? { id: itemId, day: op.day, sealed: given.sealed, revision: 1 } as Placed : { id: itemId, day: op.day, title: t.body.slice(0, 80), description: t.body, status: "confirmed", kind: "activity", revision: 1 } as Placed);
      const retimed = retime(doc.items, to, spec.timezone); if (retimed) doc.items[to] = { ...retimed, revision: 1 };
    }
    if (op.type === "move") {
      const from = doc.items.findIndex(x => x.id === op.id), item = doc.items[from], target = doc.items.find(x => x.id === op.before);
      if (!item || op.before === op.id || (op.before !== null && target?.day !== item.day)) refuse(400, "予定の並びを確認してください");
      doc.items.splice(from, 1);
      // Last means after the day's last item; the only item of its day stays where it was.
      const last = doc.items.map(x => x.day).lastIndexOf(item.day), to = target ? doc.items.indexOf(target) : last < 0 ? from : last + 1;
      doc.items.splice(to, 0, item);
      const retimed = retime(doc.items, to, spec.timezone); if (retimed) { doc.items[to] = retimed; moved = { id: retimed.id, startsAt: retimed.startsAt! }; }
    }
    doc.revision++; try { tripKit.validate(spec, doc, created, sealed); } catch { refuse(400, "旅程の日付・内容・容量を確認してください"); }
    return moved ? { moved } : {};
  },
  revise: {
    text: (spec, document, keepSpec) => reviseText(spec as Spec, document as Document, keepSpec),
    ask: (spec, document, keepSpec, instruction, now) => ({ system: REVISE_SYSTEM, text: `${todayLine(localDay(now, spec.timezone))}${reviseText(spec as Spec, document as Document, keepSpec)}${instruction.trim() ? `\n## 直してほしいこと\n\n${instruction.trim()}\n` : ""}` }),
    revise: (c, text, by) => reviseTrip({ spec: c.spec as Spec, document: c.document as Document }, text, { ...by, created: c.created }),
    undo(c, keepSpec) {
      const r = undoTrip({ spec: c.spec as Spec, document: c.document as Document }, c.previous as Previous<Spec, Document> | undefined, { created: c.created, keepSpec });
      if (r.ok) return r;
      return r.reason === "none" ? refuse(404, "戻せる旅程がありません") : r.reason === "invalid" ? refuse(400, "1 つ前の旅程に戻せません") : refuse(403, "設定も戻るため、オーナーだけが戻せます");
    },
    // The words are not read: the plain parts and the form are checked as PATCH spec and PATCH document check them, and
    // ciphertext that must not change is compared as it is kept. The Spec must stay the trip's own after an editor's revise,
    // and be the step's after an undo. Memories are not revised, and a post kept keeps its seat and time.
    resealed(c, input, { undo, keepSpec }, { seat, now }) {
      const previous = c.previous as Previous<SealedSpec, SealedDocument> | undefined;
      if (undo && !previous) refuse(404, "戻せる旅程がありません");
      if (undo && keepSpec && !same(previous!.spec, c.spec)) refuse(403, "設定も戻るため、オーナーだけが戻せます");
      const kept = undo ? previous!.spec : keepSpec ? c.spec : undefined;
      const v = z.object({ spec: z.unknown(), document: z.unknown(), confirm: z.literal(true) }).strict().parse(input);
      let next: { spec: SealedSpec; document: SealedDocument };
      try { next = validateSealed(v.spec, { ...(v.document as object), revision: c.document.revision }, c.created); } catch { refuse(400, "旅程の日付・内容・容量を確認してください"); }
      if (kept && !same(next.spec, kept)) undo ? refuse(400, "1 つ前の旅程に戻せません") : refuse(403, "設定はオーナーだけが変えられます");
      // Going back may drop a page the revise added; the deadline must still be ahead.
      const refused = refusal(undo ? { modules: [] } : c.spec, next.spec, now); if (refused) refuse(400, refused);
      const document = c.document as SealedDocument;
      if (!same(next.document.reflections, document.reflections)) refuse(400, "思い出は直せません");
      // A post an undo brings back is one the step held, as it was there. A new post is this member's, at this time (as in a plain revise).
      type Post = { id: string; seat?: string; createdAt: string };
      for (const list of ["suggestions", "comments"] as const) for (const p of next.document[list] as Post[]) {
        const old = [...document[list] as Post[], ...(undo ? (previous?.document[list] ?? []) as Post[] : [])].find(o => o.id === p.id);
        if (old && (old.seat !== p.seat || old.createdAt !== p.createdAt)) refuse(400, "投稿の書き手と時刻は変えられません");
        if (!old) Object.assign(p, { seat, createdAt: new Date(now).toISOString() });
      }
      return next;
    },
    // The owner's part as it was, and which posts the revise touched (src/revise.ts undoTrip). Memories and checks stay out.
    step(spec, document, next) {
      const { items, checklist, notes, budget, suggestions, comments } = document, after = next as Doc;
      return { spec, document: { items, checklist, notes, budget, suggestions, comments }, revisedIds: { suggestions: after.suggestions.map(p => p.id), comments: after.comments.map(p => p.id) } };
    },
  },
  sealed: {
    previous: z.object({ spec: sealedSpecSchema, document: sealedDocumentSchema.pick({ items: true, checklist: true, notes: true, budget: true }).extend({ suggestions: sealedDocumentSchema.shape.suggestions.optional(), comments: sealedDocumentSchema.shape.comments.optional() }).strict(), revisedIds: z.object({ suggestions: z.array(z.string()), comments: z.array(z.string()) }).strict().optional() }).strict(),
    // The trip as it stands, sealed again: the same records, a post keeping its seat and time.
    rekeyed(before, after) {
      const ids = (list: Array<{ id: string }>) => list.map(x => x.id).sort().join("\n"), d = before as Doc, n = after as Doc;
      const lists = ["items", "suggestions", "comments", "reflections", "checklist", "budget"] as const;
      if (lists.some(l => ids(d[l]) !== ids(n[l]))) refuse(409, "旅行が変わりました。開き直してください");
      for (const l of ["suggestions", "comments", "reflections"] as const) for (const p of n[l]) { const o = d[l].find(x => x.id === p.id)!; if (o.seat !== p.seat || o.createdAt !== p.createdAt) refuse(400, "投稿の書き手と時刻は変えられません"); }
    },
  },
};
