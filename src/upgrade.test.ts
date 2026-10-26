import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { itemSchema, validate, validateSealed } from "./schema";
import { privateAnswerSchema } from "./private-revise";
import { check } from "./validate";
import { explain } from "./paste";
import schema3 from "./fixtures/zod3-schema.json";
import trips3 from "./fixtures/zod3-trips.json";
import messages3 from "./fixtures/zod3-messages.json";

// What the Host gave under zod 3.25.76, fixed once before the move to zod 4 (#830): `bun run schema`'s output, a plain
// and a sealed trip as they were stored, and the Japanese a bad paste showed. The files are not rewritten by any test.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
// The schema with every `$ref` put in its place, so two schemas that hold the same constraints compare equal however they
// share them. `$ref` is a JSON pointer into the whole document (`#/definitions/…`, `#/$defs/…`); the tables themselves go.
function normalizeSchema(schema: Json): Json {
  const root = schema;
  const at = (ref: string): Json => ref.replace(/^#\/?/, "").split("/").filter(Boolean)
    .map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<Json>((node, key) => {
      const next = (node as Record<string, Json> | Json[])[key as never];
      if (next === undefined) throw new Error(`unresolved $ref ${ref}`);
      return next;
    }, root);
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") { const { $ref, ...rest } = node; return walk({ ...(at($ref) as Record<string, Json>), ...rest }); }
    return Object.fromEntries(Object.entries(node).filter(([k]) => !["$schema", "definitions", "$defs"].includes(k)).map(([k, v]) => [k, walk(v)]));
  };
  return walk(root);
}

// What `z.toJSONSchema` (zod 4) writes differently from zod-to-json-schema (zod 3) without losing a constraint: each undoes
// one difference where it occurs. Anything else, a lost or loosened constraint above all, still fails the comparison.
type Node = { [key: string]: Json };
const allowedSchemaDifferences: Array<{ where: string; why: string; undo: (node: Node) => Node }> = [
  { where: "every `format: date-time` string (startsAt, endsAt, createdAt, purgeAt)",
    why: "zod 4 also writes the pattern `instant` (src/schema.ts) checks, zod 3's date-time: the one `format` already names",
    undo: ({ pattern, ...node }) => node.format === "date-time" || pattern === undefined ? node : { ...node, pattern } },
  { where: "every `type: integer` without an upper bound (the revisions)",
    why: "zod 4's `z.number().int()` holds to safe integers, a bound zod 3 had not; a revision counts edits up from 1 and never nears it",
    undo: ({ maximum, ...node }) => node.type === "integer" && maximum === Number.MAX_SAFE_INTEGER || maximum === undefined ? node : { ...node, maximum } },
  { where: "spec.modules.items (the page kinds): the `moments` page",
    why: "the photos page (#437) came after the zod 3 schema was fixed; it is the one option added to the union, and the others are as they were",
    undo: node => !Array.isArray(node.oneOf) ? node : { ...node, oneOf: node.oneOf.filter(o => !(o && typeof o === "object" && !Array.isArray(o) && (o.properties as Node | undefined)?.kind && ((o.properties as Node).kind as Node).const === "moments")) } },
  { where: "spec.modules.items (the page kinds, the one discriminated union)",
    why: "zod 4 writes a discriminated union as `oneOf`; its options differ in the `kind` const, so at most one matches and `anyOf` holds the same",
    undo: ({ oneOf, ...node }) => oneOf === undefined ? node : { ...node, anyOf: oneOf } },
];
const allowing = (node: Json): Json => {
  if (Array.isArray(node)) return node.map(allowing);
  if (!node || typeof node !== "object") return node;
  const undone = allowedSchemaDifferences.reduce((n, d) => d.undo(n), node);
  return Object.fromEntries(Object.entries(undone).map(([k, v]) => [k, allowing(v)]));
};

describe("what zod 3 gave stays the same", () => {
  test("the trip schema keeps the constraints it had under zod 3", () => {
    // The CLI itself (`bun run schema`), so the check follows whatever library prints it.
    const run = Bun.spawnSync(["bun", "src/json-schema.ts"], { cwd: `${import.meta.dir}/..` });
    expect(run.exitCode).toBe(0);
    expect(allowing(normalizeSchema(JSON.parse(run.stdout.toString())))).toEqual(normalizeSchema(schema3 as unknown as Json));
  });

  test("trips stored under zod 3 still read", () => {
    const createdAt = Date.parse(trips3.createdAt);
    expect(validate(trips3.plain.spec, trips3.plain.document, createdAt)).toEqual(trips3.plain as never);
    expect(validateSealed(trips3.sealed.spec, trips3.sealed.document, createdAt)).toEqual(trips3.sealed as never);
  });

  test("a bad paste reads the same Japanese as under zod 3", () => {
    const now = Date.parse(trips3.createdAt);
    expect(messages3.length).toBeGreaterThan(0);
    for (const { name, input, messages } of messages3) {
      const result = check(input, now);
      expect({ name, messages: result.ok ? [] : explain(result.errors) }).toEqual({ name, messages });
    }
  });
});

describe("what zod 3 took still reads", () => {
  // Under zod 3 a time could leave out its seconds and write its offset without the colon; trips stored then hold such times.
  test("a time without seconds or with a ±hhmm offset", () => {
    for (const startsAt of ["2026-09-24T13:15+09:00", "2026-09-24T13:15:00+0900", "2026-09-24T04:15Z", "2026-09-24T13:15:00.5+09:00"]) {
      const trip = structuredClone(trips3.plain); trip.document.items[0]!.startsAt = startsAt;
      expect(itemSchema.safeParse(trip.document.items[0]).success).toBe(true);
      expect(privateAnswerSchema.safeParse({ schemaVersion: 1, entries: [{ kind: "item", day: "2026-09-24", startsAt, title: "a", body: "" }] }).success).toBe(true);
    }
    for (const startsAt of ["2026-09-24T13:15:00+09", "2026-09-24T13+09:00", "2026-02-30T13:15:00+09:00", "2026-09-24T24:00:00+09:00"]) expect(itemSchema.safeParse({ ...trips3.plain.document.items[0], startsAt }).success).toBe(false);
  });
});

describe("zod 4 in the page", () => {
  test("parsing never evaluates a string as code, which the page's CSP refuses", () => {
    expect(z.config().jitless).toBe(true);
  });
});
