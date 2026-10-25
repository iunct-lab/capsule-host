import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { checkTrip, type validate, type Problem } from "./schema";

// The fingerprint of a publication (spec + document), the one the owner approves and the Host keeps to recognise a retry.
// Not the capsule's `hash`, which covers the spec only and follows its edits.
export function publishHash(validated: ReturnType<typeof validate>): string { return createHash("sha256").update(JSON.stringify(validated)).digest("hex"); }

export type Checked = { ok: true; title: string; purgeAt: string; items: number; sha256: string } | { ok: false; errors: Problem[] };

// Checks without publishing: src/schema.ts's checkTrip, with the hash aws/publish.ts asks the owner to approve.
export function check(input: unknown, now: number, options: { allowUntimed?: string[] } = {}): Checked {
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
