// The board: a capsule without a trip's dates or places (an attendance check, a packing list), registered as `kind: "board"`
// (src/board-kit.ts). Its pages are the trip's that need no date, in the same form (src/schema.ts); its document is a trip's
// without the items. It is never purged before its deadline and has no time after it is over: active until the owner ends the
// sharing (frozen), then gone at `purgeAt`.
import { z, ZodError } from "zod";
import { modulesOf, short, text, zone, identifier, instant, entry, cipher, CIPHER, specSchema, documentSchema, operationSchema, sealedDocumentSchema, sealedOperationSchema, pagesRule, purgeWithin, bounded, problems, type Problem } from "./schema";
import type { State } from "./kit";

// The pages a board may have: those of a trip that need no date.
export const boardModulesOf = <L extends z.ZodTypeAny>(label: L) => {
  const [, , suggestions, checklist, budget, notes, reflection] = modulesOf(label).options;
  return z.discriminatedUnion("kind", [suggestions, checklist, budget, notes, reflection]);
};
export const boardSpecSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("board"), title: short, summary: text.optional(),
  locale: specSchema.shape.locale, timezone: zone,
  modules: z.array(boardModulesOf(short)).min(1).max(12), navigation: z.array(identifier).min(1).max(12),
  theme: specSchema.shape.theme, collaboration: specSchema.shape.collaboration,
  lifecycle: z.object({ purgeAt: instant }).strict(),
  exports: z.array(z.enum(["markdown", "json", "html"])).min(1).max(3),
}).strict().superRefine(pagesRule);
// A suggestion on a board is a post only: there is no plan to promote it to.
export const boardDocumentSchema = documentSchema.omit({ items: true }).extend({ suggestions: z.array(z.object(entry).strict()).max(300) }).strict();
export type BoardSpec = z.infer<typeof boardSpecSchema>;
export type BoardDocument = z.infer<typeof boardDocumentSchema>;
export function validateBoard(spec: unknown, document: unknown, createdAt: number) {
  const s = boardSpecSchema.parse(spec), d = boardDocumentSchema.parse(document);
  purgeWithin(s.lifecycle.purgeAt, createdAt);
  bounded([d.suggestions, d.checklist, d.comments, d.reflections, d.budget], { spec: s, document: d });
  return { spec: s, document: d };
}
// The checks of a board as a chat assistant wrote it, without publishing (src/schema.ts checkTrip for a trip): what passes here
// passes at publication. `input` is { spec, document } or its JSON text.
export function checkBoard(input: unknown, now: number): { ok: true; validated: ReturnType<typeof validateBoard> } | { ok: false; errors: Problem[] } {
  if (typeof input === "string") try { input = JSON.parse(input); } catch (e) { return { ok: false, errors: [{ path: "", message: `JSONとして読めません: ${(e as Error).message}` }] }; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: [{ path: "", message: "{ spec, document } の形のJSONが必要です" }] };
  const { spec, document } = input as Record<string, unknown>, errors: Problem[] = [];
  for (const [name, schema, value] of [["spec", boardSpecSchema, spec], ["document", boardDocumentSchema, document]] as const) {
    if (value === undefined) { errors.push({ path: name, message: "必須です" }); continue; }
    const parsed = schema.safeParse(value, { reportInput: true });
    if (!parsed.success) errors.push(...problems(parsed.error, name));
  }
  if (errors.length) return { ok: false, errors };
  try { return { ok: true, validated: validateBoard(spec, document, now) }; }
  catch (e) { return { ok: false, errors: e instanceof ZodError ? problems(e, "") : [{ path: "", message: (e as Error).message }] }; }
}
// What a member asks of a board: a trip's asks without those of its items (adding, moving, promoting a suggestion to one).
const [check, suggest, comment, reflect, rewrite, remove, include, , , notes, , checklist, budget] = operationSchema.options;
export const boardOperationSchema = z.discriminatedUnion("type", [check, suggest, comment, reflect, rewrite, remove, include, notes, checklist, budget]);
// Without an end date there is no time after the trip: memories are written while it is active.
export function stateOfBoard(spec: Pick<BoardSpec, "lifecycle">, forced: string | null, now: number): State {
  if (now >= +new Date(spec.lifecycle.purgeAt)) return "purged";
  return forced === "frozen" ? "frozen" : "active";
}
// A sealed board as the host keeps it (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」): as a sealed trip, its words are ciphertext
// under the board's key (src/trip-keys.ts) and the parts the host works with stay plain. Without dates or places, the only
// words in the Spec are its title, summary and page labels.
export const sealedBoardSpecSchema = z.object({
  ...boardSpecSchema.shape, title: cipher(CIPHER.short), summary: cipher(CIPHER.text).optional(),
  modules: z.array(boardModulesOf(cipher(CIPHER.short))).min(1).max(12),
}).strict().superRefine(pagesRule);
export const sealedBoardDocumentSchema = sealedDocumentSchema.omit({ items: true }).extend({ suggestions: z.array(sealedDocumentSchema.shape.comments.element).max(300) }).strict();
export type SealedBoardSpec = z.infer<typeof sealedBoardSpecSchema>;
export type SealedBoardDocument = z.infer<typeof sealedBoardDocumentSchema>;
export function validateBoardSealed(spec: unknown, document: unknown, createdAt: number) {
  const s = sealedBoardSpecSchema.parse(spec), d = sealedBoardDocumentSchema.parse(document);
  purgeWithin(s.lifecycle.purgeAt, createdAt);
  bounded([d.suggestions, d.checklist, d.comments, d.reflections, d.budget], { spec: s, document: d });
  return { spec: s, document: d };
}
const [sCheck, sSuggest, sComment, sReflect, sRewrite, sRemove, sInclude, , , sNotes, , sChecklist, sBudget] = sealedOperationSchema.options;
export const boardSealedOperationSchema = z.discriminatedUnion("type", [sCheck, sSuggest, sComment, sReflect, sRewrite, sRemove, sInclude, sNotes, sChecklist, sBudget]);
