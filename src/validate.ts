import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { checkTrip, type Problem } from "./schema";
import { checkBoard } from "./board-schema";

// The fingerprint of a publication (spec + document), the one the owner approves and the Host keeps to recognise a retry.
// Not the capsule's `hash`, which covers the spec only and follows its edits.
export function publishHash(validated: { spec: unknown; document: unknown }): string { return createHash("sha256").update(JSON.stringify(validated)).digest("hex"); }

// `items`: a trip's count of plans; a board (src/board-schema.ts) has none.
export type Checked = { ok: true; title: string; purgeAt: string; items?: number; sha256: string } | { ok: false; errors: Problem[] };

// Checks without publishing: src/schema.ts's checkTrip, or a board's checkBoard by `spec.kind`, with the hash aws/publish.ts asks
// the owner to approve.
export function check(input: unknown, now: number, options: { allowUntimed?: string[] } = {}): Checked {
  let parsed = input;
  if (typeof parsed === "string") try { parsed = JSON.parse(parsed); } catch { /* checkTrip says so */ }
  if ((parsed as { spec?: { kind?: unknown } } | null)?.spec?.kind === "board") {
    const board = checkBoard(parsed, now);
    return board.ok ? { ok: true, title: board.validated.spec.title, purgeAt: board.validated.spec.lifecycle.purgeAt, sha256: publishHash(board.validated) } : board;
  }
  const checked = checkTrip(input, now, options);
  if (!checked.ok) return checked;
  const { validated } = checked;
  return { ok: true, title: validated.spec.title, purgeAt: validated.spec.lifecycle.purgeAt, items: validated.document.items.length, sha256: publishHash(validated) };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("Usage: bun run validate <file.json>   （発行しません。検査の結果をJSONで出します）"); process.exit(2); }
  const result = check(await readFile(file, "utf8"), Date.now());
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
