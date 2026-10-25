// Runs in the host and the browser (no node: modules, no Buffer): a sealed trip's exports are made in the browser from the opened trip.
import type { Spec, Document } from "./schema";
import { md } from "./private-entries";

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ics = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const stamp = (s: string) => new Date(s).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
function fold(line: string) {
  let result = "", length = 0;
  for (const c of line) { const bytes = new TextEncoder().encode(c).length; if (length + bytes > 75) { result += "\r\n "; length = 1; } result += c; length += bytes; }
  return result;
}
// ZIP STORE, UTF-8 names; no compression dependency or subprocess. Exports are bounded by the document limit.
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
export function zip(files: Record<string, string>): Uint8Array {
  const text = new TextEncoder(), chunks: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  const header = (size: number, write: (v: DataView) => void) => { const b = new Uint8Array(size); write(new DataView(b.buffer)); return b; };
  for (const [name, value] of Object.entries(files)) {
    const n = text.encode(name), data = text.encode(value), crc = crc32(data);
    const local = header(30, v => { v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(12, 33, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, n.length, true); });
    chunks.push(local, n, data);
    const cd = header(46, v => { v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x800, true); v.setUint16(14, 33, true); v.setUint32(16, crc, true); v.setUint32(20, data.length, true); v.setUint32(24, data.length, true); v.setUint16(28, n.length, true); v.setUint32(42, offset, true); });
    central.push(cd, n); offset += local.length + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0), count = Object.keys(files).length;
  const end = header(22, v => { v.setUint32(0, 0x06054b50, true); v.setUint16(8, count, true); v.setUint16(10, count, true); v.setUint32(12, size, true); v.setUint32(16, offset, true); });
  const parts = [...chunks, ...central, end], out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  parts.reduce((at, b) => (out.set(b, at), at + b.length), 0);
  return out;
}
// The trip as Markdown: the ZIP's README.md, and the text a member copies without the ZIP.
export function tripMarkdown(spec: Spec, doc: Document) {
  const lines = ["---", `title: ${JSON.stringify(spec.title)}`, `startsOn: ${spec.trip.startsOn}`, `endsOn: ${spec.trip.endsOn}`, `revision: ${doc.revision}`, "---", "", `# ${md(spec.title)}`, "", md(spec.summary ?? "")];
  for (const day of [...new Set(doc.items.map(i => i.day))].sort()) {
    lines.push("", `## ${day}`, "");
    for (const i of doc.items.filter(i => i.day === day)) lines.push(`- **${md(i.title)}** (${i.status})${i.startsAt ? ` ${i.startsAt}${i.endsAt ? ` – ${i.endsAt}` : ""}${i.timeTentative ? " ごろ" : ""}` : ""}`, `  ${md(i.description ?? "")}`, ...(i.place?.publicUrl ? [`  [${md(i.place.label)}](<${i.place.publicUrl.replace(/[<>\s]/g, c => encodeURIComponent(c))}>)`] : []));
  }
  lines.push("", "## 準備", ...doc.checklist.map(c => `- [${c.done ? "x" : " "}] ${md(c.title)}`), "", "## 候補", ...doc.suggestions.map(s => `- ${md(s.body)} (${md(s.author)})`), "", "## 費用メモ", ...doc.budget.map(b => `- ${md(b.title)}: ¥${b.amount} / ${md(b.description)}`), "", "## メモ", md(doc.notes), "", "## 思い出", ...doc.reflections.filter(r => r.included).map(r => `- ${md(r.body)} (${md(r.author)})`));
  return lines.join("\n") + "\n";
}
// The trip page: the ZIP's index.html, and the file a member saves without the ZIP.
export function tripHtml(spec: Spec, doc: Document) {
  const h = escapeHtml;
  const status = { confirmed: "決定", proposed: "候補・要確認", cancelled: "中止" };
  const sections = [...new Set(doc.items.map(i => i.day))].sort().map(day => `<section><h2>${h(day)}</h2>${doc.items.filter(i => i.day === day).map(i => `<article><small>${status[i.status]}${i.startsAt ? ` · ${[i.startsAt, i.endsAt].filter(t => t !== undefined).map(t => h(new Intl.DateTimeFormat("ja", { timeZone: i.timezone ?? spec.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(t!)))).join(" – ")}${i.timeTentative ? " ごろ" : ""}` : ""}</small><h3>${h(i.title)}</h3><p>${h(i.description ?? "")}</p>${i.place?.publicUrl ? `<a href="${h(i.place.publicUrl)}" rel="noopener noreferrer">${h(i.place.label)} ↗</a>` : ""}</article>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${h(spec.title)}</title><style>body{max-width:760px;margin:40px auto;padding:24px;background:#f7f5ef;color:#26362e;font:16px/1.9 system-ui}p{white-space:pre-wrap;overflow-wrap:anywhere}article{background:#fffefa;border:1px solid #ddd;padding:20px;margin:16px 0;border-radius:8px}h2{margin-top:40px}h3{margin:8px 0}small{color:#6b766a}a{color:#355a47}@media print{article{break-inside:avoid}body{background:white}}</style><h1>${h(spec.title)}</h1><p>${h(spec.trip.startsOn)} — ${h(spec.trip.endsOn)} · revision ${doc.revision}</p><p>${h(spec.summary ?? "")}</p>${sections}<h2>準備</h2><ul>${doc.checklist.map(c => `<li>${c.done ? "☑" : "☐"} ${h(c.title)}</li>`).join("")}</ul><h2>候補</h2>${doc.suggestions.map(s => `<p>${h(s.body)} — ${h(s.author)}</p>`).join("")}<h2>費用メモ</h2>${doc.budget.map(b => `<p>${h(b.title)}: ¥${b.amount.toLocaleString("ja")}<br>${h(b.description)}</p>`).join("")}<h2>メモ</h2><p>${h(doc.notes)}</p><h2>思い出</h2>${doc.reflections.filter(r => r.included).map(r => `<p>${h(r.body)} — ${h(r.author)}</p>`).join("")}</html>`;
}
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
export async function exportFiles(id: string, spec: Spec, doc: Document, updatedAt: string) {
  const calendar = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Switchboard//Trip Capsule//JA", "CALSCALE:GREGORIAN"];
  for (const i of doc.items.filter(i => i.status === "confirmed" && i.startsAt)) calendar.push("BEGIN:VEVENT", `UID:${id}-${i.id}@trip-capsule`, `DTSTAMP:${stamp(updatedAt)}`, `DTSTART:${stamp(i.startsAt!)}`, ...(i.endsAt ? [`DTEND:${stamp(i.endsAt)}`] : []), `SUMMARY:${ics(i.title)}`, `DESCRIPTION:${ics(i.description ?? "")}`, ...(i.place ? [`LOCATION:${ics(i.place.label)}`] : []), "END:VEVENT");
  calendar.push("END:VCALENDAR");
  const files: Record<string, string> = {};
  if (spec.exports.includes("markdown")) files["README.md"] = tripMarkdown(spec, doc);
  if (spec.exports.includes("json")) files["trip.json"] = JSON.stringify({ schemaVersion: 1, spec, document: doc }, null, 2) + "\n";
  if (spec.exports.includes("ics")) files["calendar.ics"] = calendar.map(fold).join("\r\n") + "\r\n";
  if (spec.exports.includes("html")) files["index.html"] = tripHtml(spec, doc);
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, content]) => [name, await sha256(content)])));
  files["manifest.json"] = JSON.stringify({ schemaVersion: 1, capsuleId: id, revision: doc.revision, createdAt: updatedAt, files: hashes }, null, 2);
  return files;
}
