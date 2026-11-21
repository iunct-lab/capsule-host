// Runs in the host and the browser (no node: modules, no Buffer): a sealed trip's exports are made in the browser from the opened trip.
import type { Spec, Document } from "./schema";
import type { BoardSpec, BoardDocument } from "./board-schema";
import { md } from "./private-entries";
import { footprints, type Point } from "./footprints";
import { linkPhotos, photoDays, type Shown } from "./moments";
import { inspectJpeg, PHOTO_LIMITS } from "./media";

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ics = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const stamp = (s: string) => new Date(s).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
function fold(line: string) {
  let result = "", length = 0;
  for (const c of line) { const bytes = new TextEncoder().encode(c).length; if (length + bytes > 75) { result += "\r\n "; length = 1; } result += c; length += bytes; }
  return result;
}
// ZIP STORE, UTF-8 names; no compression dependency or subprocess. Exports are bounded by the document limit.
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); return c >>> 0; });
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = (c >>> 8) ^ crcTable[(c ^ b) & 0xff]!;
  return (c ^ 0xffffffff) >>> 0;
}
// The ZIP as the parts to join: each entry's local header, name and content, then the central directory and the end. A caller with
// hundreds of MB of images hands them to a Blob as they are, without copying them into one array.
export function zipParts(files: Record<string, string | Uint8Array>): Uint8Array[] {
  const text = new TextEncoder(), chunks: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  const header = (size: number, write: (v: DataView) => void) => { const b = new Uint8Array(size); write(new DataView(b.buffer)); return b; };
  for (const [name, value] of Object.entries(files)) {
    const n = text.encode(name), data = typeof value === "string" ? text.encode(value) : value, crc = crc32(data);
    const local = header(30, v => { v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(12, 33, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, n.length, true); });
    chunks.push(local, n, data);
    const cd = header(46, v => { v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x800, true); v.setUint16(14, 33, true); v.setUint32(16, crc, true); v.setUint32(20, data.length, true); v.setUint32(24, data.length, true); v.setUint16(28, n.length, true); v.setUint32(42, offset, true); });
    central.push(cd, n); offset += local.length + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0), count = Object.keys(files).length;
  const end = header(22, v => { v.setUint32(0, 0x06054b50, true); v.setUint16(8, count, true); v.setUint16(10, count, true); v.setUint32(12, size, true); v.setUint32(16, offset, true); });
  return [...chunks, ...central, end];
}
export function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts = zipParts(files), out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  parts.reduce((at, b) => (out.set(b, at), at + b.length), 0);
  return out;
}
// What every kind's page shows besides its own sections: the board (src/board-kit.ts) has only these.
export type Page = { spec: { title: string; summary?: string }; doc: Pick<Document, "revision" | "checklist" | "budget" | "notes" | "reflections"> & { suggestions: Array<{ body: string; author: string }> } };
// Where the photos go in a trip's page, as names inside the ZIP (`photos/001.jpg`): under the item, before the day's first item
// (by day), and after everything for those that go under no item.
export type PhotoNames = { byItem: Map<string, string[]>; beforeFirst: Map<string, string[]>; unlinked: string[] };
// The days to show: the items' days, and with photos a day that has only photos taken before any item.
const tripDays = (doc: Document, photos?: PhotoNames) => [...new Set([...doc.items.map(i => i.day), ...photos?.beforeFirst.keys() ?? []])].sort();
// The trip as Markdown: the ZIP's README.md, and the text a member copies without the ZIP.
export function tripMarkdown(spec: Spec, doc: Document, photos?: PhotoNames) {
  const lines: string[] = [], image = (name: string) => `![](${name})`;
  for (const day of tripDays(doc, photos)) {
    lines.push("", `## ${day}`, "", ...(photos?.beforeFirst.get(day) ?? []).map(image));
    for (const i of doc.items.filter(i => i.day === day)) lines.push(`- **${md(i.title)}** (${i.status})${i.startsAt ? ` ${i.startsAt}${i.endsAt ? ` – ${i.endsAt}` : ""}${i.timeTentative ? " ごろ" : ""}` : ""}`, `  ${md(i.description ?? "")}`, ...(i.place?.publicUrl ? [`  [${md(i.place.label)}](<${i.place.publicUrl.replace(/[<>\s]/g, c => encodeURIComponent(c))}>)`] : []), ...(photos?.byItem.get(i.id) ?? []).map(n => `  ${image(n)}`));
  }
  if (photos?.unlinked.length) lines.push("", "## 時刻の分からない写真", "", ...photos.unlinked.map(image));
  return pageMarkdown({ spec, doc }, [`startsOn: ${spec.trip.startsOn}`, `endsOn: ${spec.trip.endsOn}`], lines);
}
// A page as Markdown, `front` in its front matter and `sections` (a trip's days) before the shared ones.
export function pageMarkdown({ spec, doc }: Page, front: string[] = [], sections: string[] = []) {
  const lines = ["---", `title: ${JSON.stringify(spec.title)}`, ...front, `revision: ${doc.revision}`, "---", "", `# ${md(spec.title)}`, "", md(spec.summary ?? ""), ...sections];
  lines.push("", "## 準備", ...doc.checklist.map(c => `- [${c.done ? "x" : " "}] ${md(c.title)}`), "", "## 候補", ...doc.suggestions.map(s => `- ${md(s.body)} (${md(s.author)})`), "", "## 費用メモ", ...doc.budget.map(b => `- ${md(b.title)}: ¥${b.amount} / ${md(b.description)}`), "", "## メモ", md(doc.notes), "", "## 思い出", ...doc.reflections.filter(r => r.included).map(r => `- ${md(r.body)} (${md(r.author)})`));
  return lines.join("\n") + "\n";
}
// The trip page: the ZIP's index.html, and the file a member saves without the ZIP.
export function tripHtml(spec: Spec, doc: Document, photos?: PhotoNames) {
  const h = escapeHtml, image = (name: string) => `<img src="${h(name)}" alt="" loading="lazy">`;
  const status = { confirmed: "決定", proposed: "候補・要確認", cancelled: "中止" };
  const sections = tripDays(doc, photos).map(day => `<section><h2>${h(day)}</h2>${(photos?.beforeFirst.get(day) ?? []).map(image).join("")}${doc.items.filter(i => i.day === day).map(i => `<article><small>${status[i.status]}${i.startsAt ? ` · ${[i.startsAt, i.endsAt].filter(t => t !== undefined).map(t => h(new Intl.DateTimeFormat("ja", { timeZone: i.timezone ?? spec.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(t!)))).join(" – ")}${i.timeTentative ? " ごろ" : ""}` : ""}</small><h3>${h(i.title)}</h3><p>${h(i.description ?? "")}</p>${i.place?.publicUrl ? `<a href="${h(i.place.publicUrl)}" rel="noopener noreferrer">${h(i.place.label)} ↗</a>` : ""}${(photos?.byItem.get(i.id) ?? []).map(image).join("")}</article>`).join("")}</section>`).join("") + (photos?.unlinked.length ? `<section><h2>時刻の分からない写真</h2>${photos.unlinked.map(image).join("")}</section>` : "");
  return pageHtml({ spec, doc }, `${h(spec.trip.startsOn)} — ${h(spec.trip.endsOn)} · `, sections, Boolean(photos && (photos.byItem.size || photos.beforeFirst.size || photos.unlinked.length)));
}
// A page as HTML: `period` before its revision, `sections` (a trip's days) before the shared ones. Both are HTML already escaped.
// `withImages`: the sections hold the ZIP's own images, which the page may load from its own folder (and from file:).
export function pageHtml({ spec, doc }: Page, period = "", sections = "", withImages = false) {
  const h = escapeHtml;
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';${withImages ? " img-src 'self' file:;" : ""} style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${h(spec.title)}</title><style>body{max-width:760px;margin:40px auto;padding:24px;background:#f7f5ef;color:#26362e;font:16px/1.9 system-ui}p{white-space:pre-wrap;overflow-wrap:anywhere}article{background:#fffefa;border:1px solid #ddd;padding:20px;margin:16px 0;border-radius:8px}h2{margin-top:40px}h3{margin:8px 0}small{color:#6b766a}a{color:#355a47}${withImages ? "img{display:block;max-width:100%;height:auto;margin:12px 0;border-radius:6px}" : ""}@media print{article{break-inside:avoid}body{background:white}}</style><h1>${h(spec.title)}</h1><p>${period}revision ${doc.revision}</p><p>${h(spec.summary ?? "")}</p>${sections}<h2>準備</h2><ul>${doc.checklist.map(c => `<li>${c.done ? "☑" : "☐"} ${h(c.title)}</li>`).join("")}</ul><h2>候補</h2>${doc.suggestions.map(s => `<p>${h(s.body)} — ${h(s.author)}</p>`).join("")}<h2>費用メモ</h2>${doc.budget.map(b => `<p>${h(b.title)}: ¥${b.amount.toLocaleString("ja")}<br>${h(b.description)}</p>`).join("")}<h2>メモ</h2><p>${h(doc.notes)}</p><h2>思い出</h2>${doc.reflections.filter(r => r.included).map(r => `<p>${h(r.body)} — ${h(r.author)}</p>`).join("")}</html>`;
}
const sha256 = async (s: string | Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s as Uint8Array<ArrayBuffer>))].map(b => b.toString(16).padStart(2, "0")).join("");
export async function exportFiles(id: string, spec: Spec, doc: Document, updatedAt: string) {
  return manifested(id, doc.revision, updatedAt, tripFiles(id, spec, doc, updatedAt));
}
// The trip's files before the manifest; with `photos`, the README.md and index.html carry them.
function tripFiles(id: string, spec: Spec, doc: Document, updatedAt: string, photos?: PhotoNames) {
  const calendar = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//capsule-host//Trip Capsule//JA", "CALSCALE:GREGORIAN"];
  for (const i of doc.items.filter(i => i.status === "confirmed" && i.startsAt)) calendar.push("BEGIN:VEVENT", `UID:${id}-${i.id}@trip-capsule`, `DTSTAMP:${stamp(updatedAt)}`, `DTSTART:${stamp(i.startsAt!)}`, ...(i.endsAt ? [`DTEND:${stamp(i.endsAt)}`] : []), `SUMMARY:${ics(i.title)}`, `DESCRIPTION:${ics(i.description ?? "")}`, ...(i.place ? [`LOCATION:${ics(i.place.label)}`] : []), "END:VEVENT");
  calendar.push("END:VCALENDAR");
  const files: Record<string, string> = {};
  if (spec.exports.includes("markdown")) files["README.md"] = tripMarkdown(spec, doc, photos);
  if (spec.exports.includes("json")) files["trip.json"] = JSON.stringify({ schemaVersion: 1, spec, document: doc }, null, 2) + "\n";
  if (spec.exports.includes("ics")) files["calendar.ics"] = calendar.map(fold).join("\r\n") + "\r\n";
  if (spec.exports.includes("html")) files["index.html"] = tripHtml(spec, doc, photos);
  return files;
}
// The files with their manifest (each one's hash), as every kind's ZIP holds them.
// `extra` is more for the manifest to say (the names of the photos).
export async function manifested<F extends Record<string, string | Uint8Array>>(id: string, revision: number, updatedAt: string, files: F, extra: Record<string, unknown> = {}): Promise<F> {
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, content]) => [name, await sha256(content)])));
  (files as Record<string, string | Uint8Array>)["manifest.json"] = JSON.stringify({ schemaVersion: 1, capsuleId: id, revision, createdAt: updatedAt, files: hashes, ...extra }, null, 2);
  return files;
}
// A board's ZIP (src/board-kit.ts; a sealed board's, made in the browser): the trip's files without the days and the calendar.
export async function boardFiles(id: string, spec: BoardSpec, doc: BoardDocument, updatedAt: string) {
  const files: Record<string, string> = {};
  if (spec.exports.includes("markdown")) files["README.md"] = pageMarkdown({ spec, doc });
  if (spec.exports.includes("json")) files["board.json"] = JSON.stringify({ schemaVersion: 1, spec, document: doc }, null, 2) + "\n";
  if (spec.exports.includes("html")) files["index.html"] = pageHtml({ spec, doc });
  return manifested(id, doc.revision, updatedAt, files);
}

// The photos' names (`photos/001.jpg`, in the order taken and then uploaded) and where each goes, as `tripMarkdown` / `tripHtml` take them.
// Only those that passed `inspectJpeg` are here; a photo's name is its place in this list.
const nameOf = (n: number) => `photos/${String(n).padStart(3, "0")}.jpg`;
// The ZIP of the trip with its photos (made in the browser from what the page opened): `exportFiles`' files with the README.md and
// index.html carrying the photos, `photos/NNN.jpg`, `track.geojson` and a manifest over all of them. Every image goes through
// `inspectJpeg` here, so none carries EXIF or GPS whatever the caller passed; one that does not pass is left out and its id is in `skipped`.
export async function photoExportFiles(id: string, spec: Spec, doc: Document, updatedAt: string, photos: Array<{ photo: Shown; image: Uint8Array; location?: { lat: number; lng: number } }>, points: Point[]): Promise<{ files: Record<string, string | Uint8Array>; skipped: string[] }> {
  const skipped: string[] = [], clean = new Map<string, { photo: Shown; bytes: Uint8Array; location?: { lat: number; lng: number } }>();
  for (const { photo, image, location } of photos) {
    try { clean.set(photo.id, { photo, bytes: inspectJpeg(image, PHOTO_LIMITS.displayEdge, PHOTO_LIMITS.displayBytes).bytes, location }); } catch { skipped.push(photo.id); }
  }
  const shown = [...clean.values()].map(c => c.photo), { days, unknown } = photoDays(shown, spec.timezone);
  const names = new Map([...days.flatMap(d => d.photos), ...unknown].map((p, n) => [p.id, nameOf(n + 1)])), name = (p: Shown) => names.get(p.id)!;
  const linked = linkPhotos(doc.items, shown, spec), named = (m: Map<string, Shown[]>) => new Map([...m].map(([k, list]) => [k, list.map(name)]));
  const place: PhotoNames = { byItem: named(linked.byItem), beforeFirst: named(linked.beforeFirst), unlinked: linked.unlinked.map(name) };
  const files: Record<string, string | Uint8Array> = tripFiles(id, spec, doc, updatedAt, place);
  const ordered = [...names].map(([photoId, file]) => ({ file, ...clean.get(photoId)! }));
  for (const { file, bytes } of ordered) files[file] = bytes;
  files["track.geojson"] = trackGeoJson(points, ordered.map(({ file, photo, location }) => ({ file, capturedAt: photo.capturedAt, location })));
  return { files: await manifested(id, doc.revision, updatedAt, files, { photos: ordered.map(o => o.file) }), skipped };
}
// The footprints (each a point), the lines joining them (`footprints` in src/footprints.ts) and the photos with a place (each a
// point), as GeoJSON with every coordinate `[lng, lat]` as it was given. A photo without a place is not a point.
export function trackGeoJson(points: Point[], photos: Array<{ file: string; capturedAt?: string; location?: { lat: number; lng: number } }>): string {
  const spots = footprints(points), at = (p: { lat: number; lng: number }) => [p.lng, p.lat];
  const features = [
    ...spots.points.map(p => ({ type: "Feature", geometry: { type: "Point", coordinates: at(p) }, properties: { kind: "footprint", at: p.at, by: p.by } })),
    ...spots.lines.map(l => ({ type: "Feature", geometry: { type: "LineString", coordinates: l.map(at) }, properties: { kind: "track", by: l[0]!.by, from: l[0]!.at, to: l.at(-1)!.at } })),
    ...photos.flatMap(p => p.location ? [{ type: "Feature", geometry: { type: "Point", coordinates: at(p.location) }, properties: { kind: "photo", file: p.file, at: p.capturedAt } }] : []),
  ];
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2) + "\n";
}
