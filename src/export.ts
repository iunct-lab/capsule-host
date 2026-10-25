import { createHash } from "node:crypto";
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
  const chunks: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name), data = Buffer.from(value), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    chunks.push(local, n, data);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(33, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, n); offset += local.length + n.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, directory, end]));
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
export function exportFiles(id: string, spec: Spec, doc: Document, updatedAt: string) {
  const calendar = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Switchboard//Trip Capsule//JA", "CALSCALE:GREGORIAN"];
  for (const i of doc.items.filter(i => i.status === "confirmed" && i.startsAt)) calendar.push("BEGIN:VEVENT", `UID:${id}-${i.id}@trip-capsule`, `DTSTAMP:${stamp(updatedAt)}`, `DTSTART:${stamp(i.startsAt!)}`, ...(i.endsAt ? [`DTEND:${stamp(i.endsAt)}`] : []), `SUMMARY:${ics(i.title)}`, `DESCRIPTION:${ics(i.description ?? "")}`, ...(i.place ? [`LOCATION:${ics(i.place.label)}`] : []), "END:VEVENT");
  calendar.push("END:VCALENDAR");
  const files: Record<string, string> = {};
  if (spec.exports.includes("markdown")) files["README.md"] = tripMarkdown(spec, doc);
  if (spec.exports.includes("json")) files["trip.json"] = JSON.stringify({ schemaVersion: 1, spec, document: doc }, null, 2) + "\n";
  if (spec.exports.includes("ics")) files["calendar.ics"] = calendar.map(fold).join("\r\n") + "\r\n";
  if (spec.exports.includes("html")) files["index.html"] = tripHtml(spec, doc);
  files["manifest.json"] = JSON.stringify({ schemaVersion: 1, capsuleId: id, revision: doc.revision, createdAt: updatedAt, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")])) }, null, 2);
  return files;
}
