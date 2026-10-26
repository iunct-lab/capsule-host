import type { Spec, Document } from "./schema";

// Public application code contains no real trip, chat history, participant, or reservation.
export function emptyTrip(start: string, end = start, title = "新しい旅", destination = "行き先未定") {
  const purge = new Date(end); purge.setUTCDate(purge.getUTCDate() + 30);
  const spec: Spec = {
    schemaVersion: 1, kind: "trip", title, summary: "予定を持ち寄って、旅のしおりをつくろう。",
    locale: "ja", timezone: "Asia/Tokyo", trip: { startsOn: start, endsOn: end, destinations: [destination] },
    modules: [{ id: "days", kind: "day-timeline", label: "旅程" }, { id: "photos", kind: "moments", label: "写真" }, { id: "story", kind: "story", label: "旅の記録" }, { id: "places", kind: "places", label: "行くところ" }, { id: "ideas", kind: "suggestion-board", label: "候補・相談" }, { id: "check", kind: "checklist", label: "準備", mode: "shared" }, { id: "budget", kind: "budget", label: "費用メモ", currency: "JPY" }, { id: "notes", kind: "notes", label: "旅のメモ" }, { id: "map", kind: "trip-map", label: "足あとの地図", showTrack: true }, { id: "memories", kind: "reflection", label: "思い出" }],
    navigation: ["days", "photos", "story", "places", "ideas", "check", "budget", "notes", "map", "memories"],
    theme: { preset: "paper", accent: "#b6563e" }, collaboration: { participantSuggestions: true, participantComments: true, participantChecklist: true },
    lifecycle: { reflectionDays: 7, purgeAt: `${purge.toISOString().slice(0, 10)}T00:00:00+09:00` }, exports: ["markdown", "json", "ics", "html"],
  };
  const document: Document = { revision: 1, items: [], suggestions: [], checklist: [{ id: "c1", title: "集合場所を決める", done: false }, { id: "c2", title: "移動手段を確認する", done: false }, { id: "c3", title: "必要な予約を確認する", done: false }], comments: [], reflections: [], notes: "表示名はニックネームを使えます。予約番号や本人確認書類、秘密のURLは保存しないでください。", budget: [] };
  return { spec, document };
}
