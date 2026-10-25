import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ZodError } from "zod";
import { specSchema, documentSchema, validate, untimed } from "./schema";

// The fingerprint of a publication (spec + document), the one the owner approves and the Host keeps to recognise a retry.
// Not the capsule's `hash`, which covers the spec only and follows its edits.
export function publishHash(validated: ReturnType<typeof validate>): string { return createHash("sha256").update(JSON.stringify(validated)).digest("hex"); }

type Problem = { path: string; message: string };
export type Checked = { ok: true; title: string; purgeAt: string; items: number; sha256: string } | { ok: false; errors: Problem[] };

// Checks without publishing. The rules are validate()'s, so a file that passes here passes at publication;
// the hash is the one aws/publish.ts asks the owner to approve. `input` is { spec, document } or its JSON text.
// An item without a time is refused as publishing refuses it, except those named in `allowUntimed`: in a revise, the items the
// trip already held without a time.
export function check(input: unknown, now: number, options: { allowUntimed?: string[] } = {}): Checked {
  if (typeof input === "string") try { input = JSON.parse(input); } catch (e) { return { ok: false, errors: [{ path: "", message: `JSONとして読めません: ${(e as Error).message}` }] }; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: [{ path: "", message: "{ spec, document } の形のJSONが必要です" }] };
  const { spec, document } = input as Record<string, unknown>, errors: Problem[] = [];
  for (const [name, schema, value] of [["spec", specSchema, spec], ["document", documentSchema, document]] as const) {
    if (value === undefined) { errors.push({ path: name, message: "必須です" }); continue; }
    const parsed = schema.safeParse(value);
    if (!parsed.success) errors.push(...problems(parsed.error, name));
  }
  if (errors.length) return { ok: false, errors };
  try {
    const validated = validate(spec, document, now), missing = untimed(validated.document, options.allowUntimed);
    if (missing.length) return { ok: false, errors: missing };
    return { ok: true, title: validated.spec.title, purgeAt: validated.spec.lifecycle.purgeAt, items: validated.document.items.length, sha256: publishHash(validated) };
  } catch (e) {
    return { ok: false, errors: e instanceof ZodError ? problems(e, "") : [{ path: "", message: (e as Error).message }] };
  }
}
// Zod's enum message quotes the rejected value; a generated file can hold something that should not be repeated in a log.
const problems = (error: ZodError, prefix: string): Problem[] => error.issues.map(i => ({
  path: [prefix, ...i.path].filter(p => p !== "").join("."),
  message: i.code === "invalid_enum_value" ? `次のいずれかを指定してください: ${i.options.join(" | ")}` : i.message,
}));

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("Usage: bun run validate <file.json>   （発行しません。検査の結果をJSONで出します）"); process.exit(2); }
  const result = check(await readFile(file, "utf8"), Date.now());
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
