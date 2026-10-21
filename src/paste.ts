// A person pastes what a chat assistant answered: prose around the trip, fenced or not. Take the trip out of it,
// and turn what check() refused into sentences that say where to look. No parser and no new rules — the host still
// decides with check(), so what passes here passes at publication.
export type Taken = { ok: true; value: unknown } | { ok: false; reason: "empty" | "not-json" | "many" | "cut-off" };

// The object ends at the brace that closes it: quotes and their escapes are skipped so text may contain braces.
function objectAt(text: string, start: number) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (quoted) { if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
}
// Scanning stops at a brace that never closes: the rest of the answer is inside it, so anything found there would be a
// fragment of something cut off. Stopping also keeps this linear — restarting inside every unclosed brace is quadratic.
const objects = (text: string) => {
  const found: string[] = [];
  let cut = false;
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    const object = objectAt(text, i);
    if (!object) { cut = true; break; }
    found.push(object); i += object.length - 1;
  }
  return { found, cut };
};

export function extract(text: string): Taken {
  if (!text.trim()) return { ok: false, reason: "empty" };
  // A fenced block is the assistant's own answer to "give me JSON", so it wins over anything quoted in the prose. When a
  // fence yields nothing — a trip whose own text contains ``` closes it early — the whole answer is scanned instead.
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]!);
  const fromFences = fenced.map(objects), inFences = fromFences.flatMap(f => f.found);
  const { found, cut } = inFences.length ? { found: inFences, cut: fromFences.some(f => f.cut) } : objects(text);
  if (found.length > 1) return { ok: false, reason: "many" };
  if (!found.length) return { ok: false, reason: cut ? "cut-off" : "not-json" };
  try { return { ok: true, value: JSON.parse(found[0]!) }; } catch { return { ok: false, reason: "not-json" }; }
}

// Paths check() reports, in the words the screen uses. Anything missing here is shown as its path: a person can still
// find it, and hiding it would leave them with nothing to fix.
const places: Record<string, string> = {
  "": "旅程全体", spec: "旅程の設定", document: "旅程の中身",
  "spec.title": "旅行の題", "spec.summary": "旅行の紹介文", "spec.locale": "言語", "spec.timezone": "時間帯",
  "spec.trip.startsOn": "旅行の初日", "spec.trip.endsOn": "旅行の最終日", "spec.trip.destinations": "行き先",
  "spec.theme.preset": "見た目のテーマ", "spec.theme.accent": "差し色",
  "spec.lifecycle.purgeAt": "自動削除の日時", "spec.lifecycle.reflectionDays": "旅行後に追記できる日数",
  "spec.modules": "しおりのページ", "spec.navigation": "表示するページの並び", "spec.exports": "書き出せる形式",
  "document.notes": "旅のメモ", "document.revision": "版数", entries: "自分の予定・日記",
};
const lists: Record<string, string> = {
  "document.items": "予定", "document.checklist": "準備リスト", "document.suggestions": "候補",
  "document.comments": "相談", "document.reflections": "思い出", "document.budget": "費用メモ",
  "spec.modules": "しおりのページ", "spec.presentation.travelers": "顔ぶれ", entries: "自分の予定・日記",
};
const fields: Record<string, string> = {
  title: "題", startsAt: "開始時刻", endsAt: "終了時刻", day: "日付", kind: "種類", status: "状態",
  body: "本文", author: "表示名", amount: "金額", description: "説明", label: "名前", id: "ID",
  place: "場所", "place.label": "場所の名前", "place.publicUrl": "場所の公開URL", "place.lat": "場所の緯度", "place.lng": "場所の経度",
};
function place(path: string): string {
  if (path in places) return places[path]!;
  const list = /^(.*)\.(\d+)(?:\.(.*))?$/.exec(path);
  if (list) {
    const [, head, index, rest] = list;
    const name = lists[head!];
    if (name) return `${Number(index) + 1} つめの${name}${rest ? `の${fields[rest] ?? rest}` : ""}`;
  }
  return path;
}
// zod's own wording is English and reaches the screen unchanged; these are the ones this schema produces. Anything
// else is shown as it came, so a message is never swallowed.
const reasons: Array<[RegExp, string]> = [
  [/^Required$/, "指定してください"],
  [/^Invalid$/, "形式が正しくありません"],
  [/^Invalid input$/, "形式が正しくありません"],
  [/^Invalid url$/, "URL の形式が正しくありません"],
  [/^Invalid datetime$/, "日時の形式が正しくありません（例 2026-11-21T10:30:00+09:00）"],
  [/^Invalid literal value, expected (.+)$/, "$1 のみ指定できます"],
  [/^Expected (\w+), received (\w+)$/, "$1 で指定してください（いまは $2）"],
  [/^String must contain at least (\d+) character\(s\)$/, "$1 文字以上で指定してください"],
  [/^String must contain at most (\d+) character\(s\)$/, "$1 文字以内で指定してください"],
  [/^Array must contain at least (\d+) element\(s\)$/, "$1 件以上必要です"],
  [/^Array must contain at most (\d+) element\(s\)$/, "$1 件以内にしてください"],
  [/^Number must be greater than or equal to (-?\d+)$/, "$1 以上で指定してください"],
  [/^Number must be less than or equal to (-?\d+)$/, "$1 以下で指定してください"],
  [/^Unrecognized key\(s\) in object: (.+)$/, "知らない項目があります: $1"],
];
const reason = (message: string) => reasons.reduce((text, [pattern, japanese]) => text.replace(pattern, japanese), message);
export const explain = (errors: Array<{ path: string; message: string }>) => errors.map(e => `${place(e.path)}: ${reason(e.message)}`);
