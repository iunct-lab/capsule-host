// A member's own plans and diary are revised by a chat assistant too (#427), but the host holds them sealed (#343): the text to
// copy is made in the browser from what it could open, and the answer is taken out, checked and compared there, before it is
// sealed and applied in one PATCH private. The shared trip goes along as a reference only, titles and times, never to be answered.
import { z } from "zod";
import text from "../docs/recipes/private.md" with { type: "text" };
import { instant, localDay, problems, type Spec, type Document } from "./schema";
import { extract, explain } from "./paste";
import { same } from "./revise";
import type { PlainEntry } from "./private-entries";

const time = (zone: string, at: string) => new Intl.DateTimeFormat("ja", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
export function privateReviseText(spec: Spec, document: Document, entries: PlainEntry[]) {
  // Each at its own clock, as the screen shows it: an item may have a zone of its own.
  const shared = document.items.map(i => { const zone = i.timezone ?? spec.timezone; return `- ${i.day}${i.startsAt ? ` ${time(zone, i.startsAt)}` : ""}${i.endsAt ? `〜${time(zone, i.endsAt)}` : ""} ${i.title}`; });
  return `${text}\n## 旅行\n\n- 期間: ${spec.trip.startsOn}〜${spec.trip.endsOn}\n- 時間帯: ${spec.timezone}\n\n## 共有の予定（参照）\n\n直しても反映されません。返事には入れないでください。\n\n${shared.join("\n") || "（なし）"}\n\n## 自分の予定・日記\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, entries })}\n\`\`\`\n`;
}

// The screen's own rules for an entry (src/client.ts, the private form): a plan has a title and a start, a diary its words and
// no time. The lengths are those the host's sealed sizes are made for.
const entry = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(160).optional(), kind: z.enum(["item", "diary"]), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startsAt: instant.optional(), endsAt: instant.optional(),
  title: z.string().trim().max(160), body: z.string().trim().max(4000),
  place: z.object({ label: z.string().trim().min(1).max(160), publicUrl: z.string().url().max(2000).refine(v => v.startsWith("https://"), "公開HTTPS URLのみ使用できます").optional() }).strict().optional(),
}).strict()
  .refine(e => e.kind === "diary" || e.title, { message: "予定の題を入れてください", path: ["title"] })
  .refine(e => e.kind === "diary" || e.startsAt, { message: "予定の開始時刻を入れてください", path: ["startsAt"] })
  .refine(e => e.kind === "item" || e.body, { message: "日記の本文を入れてください", path: ["body"] })
  .refine(e => e.kind === "item" || !e.startsAt, { message: "日記には時刻を書きません", path: ["startsAt"] })
  .refine(e => e.kind === "item" || !e.endsAt, { message: "日記には時刻を書きません", path: ["endsAt"] })
  .refine(e => !e.startsAt || !e.endsAt || +new Date(e.endsAt) >= +new Date(e.startsAt), { message: "終了時刻が開始時刻より前です", path: ["endsAt"] });
export const privateAnswerSchema = z.object({ schemaVersion: z.literal(1), entries: z.array(entry).max(100) }).strict();

const reasons = { empty: "返事が貼られていません。チャットの答えを貼ってください。", "not-json": "自分の予定・日記が見つかりません。チャットの返事を、前後の文ごとそのまま貼ってください。", many: "JSON が 2 つ以上あります。使いたい方だけを貼ってください。", "cut-off": "答えが途中で切れています。チャットの返事を最後まで貼ってください。" };
// The entries the answer holds, each with an id (a new one gets one here), or what to fix in the words the screen uses.
export function takePrivate(answer: string, spec: Spec): { ok: true; entries: PlainEntry[] } | { ok: false; messages: string[] } {
  const taken = extract(answer); if (!taken.ok) return { ok: false, messages: [reasons[taken.reason]] };
  const parsed = privateAnswerSchema.safeParse(taken.value, { reportInput: true });
  if (!parsed.success) return { ok: false, messages: explain(problems(parsed.error, "")) };
  const { startsOn, endsOn } = spec.trip, messages: string[] = [], named = parsed.data.entries.flatMap(e => e.id ? [e.id] : []);
  parsed.data.entries.forEach((e, i) => {
    const real = !isNaN(+new Date(e.day)) && new Date(e.day).toISOString().slice(0, 10) === e.day;
    if (!real || e.day < startsOn || e.day > endsOn) messages.push(...explain([{ path: `entries.${i}.day`, message: `旅行期間（${startsOn}〜${endsOn}）の日付にしてください` }]));
    else if (e.startsAt && localDay(+new Date(e.startsAt), spec.timezone) !== e.day) messages.push(...explain([{ path: `entries.${i}.startsAt`, message: `${e.day} の時刻にしてください（時間帯 ${spec.timezone}）` }]));
  });
  for (const id of new Set(named.filter((id, i) => named.indexOf(id) !== i))) messages.push(`同じ id（${id}）の項目が 2 つあります。1 つにしてください。`);
  if (messages.length) return { ok: false, messages };
  return { ok: true, entries: parsed.data.entries.map(({ id, place, ...e }) => ({ ...e, id: id ?? crypto.randomUUID(), ...(place ? { place } : {}) })) };
}

// What applying `next` does to `current`, the entries this browser could open. An entry `current` does not have is added, under
// a new id: an id the chat made up, or one of an entry this browser cannot read, never replaces one. So an entry left out of
// the copy is never removed either.
export function privateDiff(current: PlainEntry[], next: PlainEntry[]) {
  const known = (e: PlainEntry) => current.find(c => c.id === e.id);
  return {
    added: next.filter(e => !known(e)).map(e => ({ ...e, id: crypto.randomUUID() })),
    changed: next.filter(e => { const c = known(e); return c && !same(c, e); }),
    removed: current.filter(c => !next.some(e => e.id === c.id)),
  };
}
