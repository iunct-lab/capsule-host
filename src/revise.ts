// A trip is revised the way it was made: by a chat assistant, outside the host. The owner hands it the trip as it stands
// and the recipe it was made from. Candidates and talk go out by their words only; who wrote them, when, memories
// and the version stay in the host.
import type { Spec, Document, Item } from "./schema";
import { recipe } from "./recipe";

export const revisable = (spec: Spec, document: Document) =>
  ({ schemaVersion: 1 as const, spec, document: { items: document.items, checklist: document.checklist, notes: document.notes, budget: document.budget, suggestions: document.suggestions.map(({ id, body, promoted }) => ({ id, body, promoted })), comments: document.comments.map(({ id, body }) => ({ id, body })) } });

// An editor may not change the settings, so their chat is told to leave `spec` as it is (the host keeps it anyway). The recipe's
// example and the trip's indentation are left out: a long trip must still fit in one chat message (#306).
export const reviseText = (spec: Spec, document: Document, keepSpec = false) =>
  `${recipe.withoutExample}\n## 今の旅程\n\n例は省いています。この旅程を土台にしてください。\n\n${keepSpec ? "この旅程は編集者が直します。`spec`（題・日程・削除期限・ページ・見た目など）は変えずにそのまま返してください。変えても反映されません。\n\n" : ""}\`\`\`json\n${JSON.stringify(revisable(spec, document))}\n\`\`\`\n`;

type Trip = { spec: Spec; document: Document };
// The answer's own parts, and the rest from the trip as it stands. Anything not shaped like a trip is returned as it came,
// so check() refuses it in its own words.
export function merge(current: Trip, answer: unknown, by: { author: string; at: string }): unknown {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const { document, ...rest } = answer as Record<string, unknown>;
  if (!document || typeof document !== "object" || Array.isArray(document)) return answer;
  const { items, checklist, notes, budget, suggestions, comments } = document as Record<string, unknown>, { revision, reflections } = current.document;
  // `itemId` (the item a promoted suggestion made) is the host's (suggestions only): an answer never carries it, so it is put back from the post as it was.
  const posts = (list: unknown, old: Array<{ id: string; author: string; createdAt: string; itemId?: string }>, own = false) => !Array.isArray(list) ? list : list.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const previous = old.find(o => o.id === entry.id), { itemId: _, ...bare } = entry;
    return { ...(own ? bare : entry), ...(own && previous?.itemId ? { itemId: previous.itemId } : {}), author: previous?.author ?? by.author, createdAt: previous?.createdAt ?? by.at };
  });
  return { ...rest, document: { revision, items, checklist, notes, budget, suggestions: posts(suggestions, current.document.suggestions, true), comments: posts(comments, current.document.comments), reflections } };
}

// Key order is not content: an answer may write an item's fields in any order.
const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
export const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const content = ({ revision, ...rest }: Item) => rest;

// A check is a participant's, not the answer's; an item's version moves only when the item did.
export function settle(current: Document, next: Document): Document {
  return {
    ...next,
    items: next.items.map(i => { const old = current.items.find(o => o.id === i.id); return { ...i, revision: !old ? 1 : same(content(old), content(i)) ? old.revision : old.revision + 1 }; }),
    checklist: next.checklist.map(c => ({ ...c, done: current.checklist.find(o => o.id === c.id)?.done ?? false })),
  };
}

type Change = { change: "added" | "changed" | "removed"; id: string; title: string; fields?: Array<{ field: string; before: string; after: string }> };
export type Diff = {
  title?: [string, string]; dates?: [string, string]; purgeAt?: [string, string]; modules: string[];
  items: Change[]; suggestions: Change[]; comments: Change[];
  other: string[]; large: boolean;
};
const itemFields: Record<string, string> = { title: "題", kind: "種類", status: "状態", day: "日付", startsAt: "開始時刻", timeTentative: "時刻の確度", endsAt: "終了時刻", timezone: "時間帯", place: "場所", description: "説明", tags: "タグ" };
// The mark reads as what it says about the time: no mark and `false` are both a decided time, and an item without a time has neither.
const valueOf = (i: Item, k: string) => k !== "timeTentative" ? i[k as keyof Item] : !i.startsAt ? undefined : i.timeTentative ? "仮置き" : "決定";
const shown = (v: unknown): string => v === undefined ? "（なし）" : typeof v === "string" ? v : Array.isArray(v) ? v.map(shown).join("、") : v && typeof v === "object" ? Object.values(v).filter(x => x !== undefined).map(shown).join(" / ") : String(v);
// The parts of a trip besides title, dates, deadline, added pages and items, in the words the screen uses. `base` is the
// trip before the change: a page it did not have is shown as added, not as a changed page.
const others: Array<[string, (t: Trip, base: Trip) => unknown]> = [
  ["紹介文", t => t.spec.summary], ["行き先", t => t.spec.trip.destinations], ["言語", t => t.spec.locale], ["時間帯", t => t.spec.timezone],
  ["見た目", t => t.spec.theme], ["参加者にできること", t => t.spec.collaboration], ["旅行後に追記できる日数", t => t.spec.lifecycle.reflectionDays],
  ["書き出せる形式", t => t.spec.exports], ["表紙の文言・日ごとの見出し・顔ぶれ", t => t.spec.presentation],
  ["ページの名前・設定", (t, base) => t.spec.modules.filter(m => base.spec.modules.some(n => n.id === m.id)).sort((a, b) => a.id < b.id ? -1 : 1)], ["ページの並び", t => t.spec.navigation],
  ["旅のメモ", t => t.document.notes], ["準備リスト", t => t.document.checklist.map(({ id, title }) => ({ id, title }))], ["費用メモ", t => t.document.budget],
];

// What applying `after` does to `before`, computed by the host so the screen shows what will be saved. A large change —
// a new title or dates, at least half of today's items removed or changed, or an existing post changed or removed — asks for the title.
export function diff(before: Trip, after: Trip): Diff {
  const d: Diff = { modules: after.spec.modules.filter(m => !before.spec.modules.some(n => n.id === m.id)).map(m => m.label), items: [], suggestions: [], comments: [], other: [], large: false };
  if (before.spec.title !== after.spec.title) d.title = [before.spec.title, after.spec.title];
  const dates = (t: Trip) => `${t.spec.trip.startsOn}〜${t.spec.trip.endsOn}`;
  if (dates(before) !== dates(after)) d.dates = [dates(before), dates(after)];
  if (before.spec.lifecycle.purgeAt !== after.spec.lifecycle.purgeAt) d.purgeAt = [before.spec.lifecycle.purgeAt, after.spec.lifecycle.purgeAt];
  for (const i of after.document.items) {
    const old = before.document.items.find(o => o.id === i.id);
    if (!old) { d.items.push({ change: "added", id: i.id, title: i.title }); continue; }
    const fields = Object.entries(itemFields).filter(([k]) => !same(valueOf(old, k), valueOf(i, k))).map(([k, field]) => ({ field, before: shown(valueOf(old, k)), after: shown(valueOf(i, k)) }));
    if (fields.length) d.items.push({ change: "changed", id: i.id, title: old.title, fields });
  }
  for (const o of before.document.items) if (!after.document.items.some(i => i.id === o.id)) d.items.push({ change: "removed", id: o.id, title: o.title });
  const posts = (before: Array<{ id: string; body: string }>, after: Array<{ id: string; body: string }>, labels: Record<string, string>): Change[] => {
    const title = (body: string) => body.length > 40 ? body.slice(0, 40) + "…" : body;
    const value = (post: typeof before[number], key: string) => key === "promoted" ? (post as unknown as { promoted: boolean }).promoted ? "はい" : "いいえ" : post.body;
    const rows: Change[] = [];
    for (const post of after) {
      const old = before.find(o => o.id === post.id);
      if (!old) { rows.push({ change: "added", id: post.id, title: title(post.body) }); continue; }
      const fields = Object.entries(labels).filter(([key]) => !same(value(old, key), value(post, key))).map(([key, field]) => ({ field, before: shown(value(old, key)), after: shown(value(post, key)) }));
      if (fields.length) rows.push({ change: "changed", id: post.id, title: title(old.body), fields });
    }
    for (const old of before) if (!after.some(p => p.id === old.id)) rows.push({ change: "removed", id: old.id, title: title(old.body) });
    return rows;
  };
  d.suggestions = posts(before.document.suggestions, after.document.suggestions, { body: "本文", promoted: "旅程に追加済み" });
  d.comments = posts(before.document.comments, after.document.comments, { body: "本文" });
  d.other = others.filter(([, part]) => !same(part(before, before), part(after, before))).map(([name]) => name);
  const kept = (t: Trip, other: Trip) => t.document.items.filter(i => other.document.items.some(o => o.id === i.id)).map(i => i.id);
  if (!same(kept(before, after), kept(after, before))) d.other.push("予定の並び");
  const touched = d.items.filter(i => i.change !== "added").length;
  d.large = Boolean(d.title || d.dates) || (before.document.items.length > 0 && touched * 2 >= before.document.items.length) || [...d.suggestions, ...d.comments].some(r => r.change !== "added");
  return d;
}
