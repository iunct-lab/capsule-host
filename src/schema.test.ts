import { describe, test, expect } from "bun:test";
import { CIPHER, validate, validateSealed, sealedOperationSchema, type SealedDocument, type SealedSpec } from "./schema";
import { b64, pack, unpack } from "./private-entries";
import { testTrip } from "./test-fixture";

// A stand-in ciphertext of the right form: the host cannot tell it from a real one, and needs not (§4).
const fake = () => `v1.1.${b64(crypto.getRandomValues(new Uint8Array(40)))}`;
function sealedTrip(): { spec: SealedSpec; document: SealedDocument } {
  const { spec, document } = testTrip();
  document.suggestions = [{ id: "s1", author: "A", body: "朝市", createdAt: "2026-09-20T00:00:00.000Z", promoted: false }];
  document.budget = [{ id: "b1", title: "宿", amount: 12000, description: "" }];
  const { title, summary, trip, modules, ...rest } = spec;
  return {
    spec: { ...rest, title: fake(), summary: fake(), trip: { ...trip, destinations: fake() }, modules: modules.map(m => ({ ...m, label: fake() })),
      presentation: { kicker: fake(), postcardLabel: fake(), postcardCaption: fake(), dayHeadings: [{ day: trip.startsOn, title: fake() }], travelers: fake() } },
    document: {
      revision: document.revision, notes: fake(),
      items: document.items.map(({ id, day, startsAt, timeTentative, revision }) => ({ id, day, ...(startsAt ? { startsAt } : {}), ...(timeTentative ? { timeTentative } : {}), revision, sealed: fake() })),
      suggestions: document.suggestions.map(({ id, createdAt, promoted }) => ({ id, createdAt, promoted, seat: "seat1", author: fake(), body: fake() })),
      comments: [], reflections: [],
      checklist: document.checklist.map(({ id, done }) => ({ id, done, title: fake() })),
      budget: document.budget.map(({ id }) => ({ id, title: fake(), amount: fake(), description: fake() })),
    },
  };
}
const created = Date.parse("2026-09-01T00:00:00Z");

describe("the sealed trip's form", () => {
  test("sealed trip shape: ciphertext where docs/design/trip-e2e.md §3.1 seals, the plain parts as they are", () => {
    const t = sealedTrip();
    expect(() => validateSealed(t.spec, t.document, created)).not.toThrow();
    // A plain trip is still checked by the plain rules only, and a sealed one does not pass them.
    const plain = testTrip();
    expect(() => validate(plain.spec, plain.document, created)).not.toThrow();
    expect(() => validate(t.spec, t.document, created)).toThrow();
    expect(() => validateSealed(plain.spec, plain.document, created)).toThrow();
  });
  test("plain parts are still checked: a word left plain, ciphertext without a generation or too long, dates and ids", () => {
    const bad = (change: (t: ReturnType<typeof sealedTrip>) => void) => { const t = sealedTrip(); change(t); return () => validateSealed(t.spec, t.document, created); };
    expect(bad(t => { t.spec.title = "テスト旅行"; })).toThrow();
    expect(bad(t => { t.spec.title = `v1.${b64(crypto.getRandomValues(new Uint8Array(40)))}`; })).toThrow();
    expect(bad(t => { t.spec.title = `v1.1.${"A".repeat(CIPHER.short)}`; })).toThrow();
    expect(bad(t => { t.document.items[0]!.sealed = "集合"; })).toThrow();
    expect(bad(t => { t.document.notes = "メモ"; })).toThrow();
    expect(bad(t => { (t.document.budget[0] as { amount: unknown }).amount = 12000; })).toThrow();
    expect(bad(t => { t.document.items[0]!.day = "2026-12-01"; })).toThrow("旅行期間");
    expect(bad(t => { t.document.items[1]!.id = t.document.items[0]!.id; })).toThrow("重複");
    expect(bad(t => { t.spec.navigation.push("nowhere"); })).toThrow();
    // A plain field stays plain: a day heading's day is a date, not ciphertext.
    expect(bad(t => { t.spec.presentation!.dayHeadings[0]!.day = fake(); })).toThrow();
  });
  test("a sealed operation carries ciphertext where a plain one carries words", () => {
    expect(sealedOperationSchema.safeParse({ type: "suggest", id: "p1", author: fake(), body: fake() }).success).toBe(true);
    expect(sealedOperationSchema.safeParse({ type: "suggest", author: "A", body: "朝市" }).success).toBe(false);
    expect(sealedOperationSchema.safeParse({ type: "promote", id: "s1", day: "2026-09-24", item: { id: "i9", sealed: fake() } }).success).toBe(true);
    expect(sealedOperationSchema.safeParse({ type: "checklist", checklist: [{ id: "c1", title: "傘" }] }).success).toBe(false);
    expect(sealedOperationSchema.safeParse({ type: "check", id: "c1", done: true }).success).toBe(true);
  });
  test("unpack reads both forms: a member's own entries (v1.) and a trip's (v1.<generation>.)", () => {
    const iv = crypto.getRandomValues(new Uint8Array(12)), data = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const plain = pack(iv, data), sealed = pack(iv, data, 3);
    expect(plain).toMatch(/^v1\.[A-Za-z0-9_-]+$/); expect(sealed).toMatch(/^v1\.3\.[A-Za-z0-9_-]+$/);
    expect(unpack(plain).generation).toBeUndefined(); expect(unpack(sealed).generation).toBe(3);
    expect(unpack(sealed).iv).toEqual(iv); expect(unpack(sealed).data).toEqual(unpack(plain).data);
    for (const wrong of ["v1.0.AAAA", "v1.1.", "v2.AAAA", `v1.1.2.${b64(new Uint8Array(40))}`]) expect(() => unpack(wrong)).toThrow();
  });
});
