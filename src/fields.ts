// The forms of values the host and every Domain Kit share (src/kit.ts): no kind's own shape is here. src/schema.ts, the
// trip's shapes, uses and re-exports them.
import { z } from "zod";

// zod 4 compiles a fast path with `new Function`; the page's CSP has no 'unsafe-eval' (src/cloud-host.ts), so in the browser
// that throws partway through a parse. Every bundle that parses imports this module (src/schema.ts does).
z.config({ jitless: true });

// zod 3's `.datetime({ offset: true })`, which zod 4 narrowed (seconds required, the offset only as ±hh:mm). Trips and entries
// stored under zod 3 hold what it took: seconds optional, the offset as Z, ±hh:mm or ±hhmm. A real date, as zod 3 checked.
export const instant = z.stringFormat("date-time", /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|([+-]\d{2}:?\d{2}))$/);
// A sealed field: `v1.<generation>.` ciphertext under the trip's key. The limits are those of src/schema.ts's sealed trip.
export const CIPHER = { short: 700, text: 16_100, item: 64_000, destinations: 40_000, travelers: 100_000, amount: 100 };
export const cipher = (max: number) => z.string().regex(/^v1\.[1-9][0-9]{0,5}\.[A-Za-z0-9_-]+$/).max(max);
// A footprint's position (#480): at most a kilometre off. The host checks it of a plain trip's footprint; of a sealed trip's,
// the screen checks it before sealing and after opening (docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」).
export const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(1000) }).strict();
export type PlainPoint = z.infer<typeof pointSchema>;
// The largest pasted or generated answer taken in, in bytes.
export const PASTE_LIMIT = 200_000;
// The name a member writes under (a post's author, a member's or an invite's name).
export const author = z.string().trim().min(1).max(80);
// The title typed to confirm a purge or a large change, as a phone types it: a space after a predicted word, full-width
// spaces and letters. What is compared is what a person sees, not the code points. The screen compares it for a sealed trip,
// whose title the host cannot read (docs/ephemeral-trip-capsule.md「5.3 暗号化した旅行で Host にできないこと」).
export const seen = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim();
export const sameTitle = (given: string | undefined, title: string) => given !== undefined && seen(given) === seen(title);
export function localDay(now: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k)!.value).join("-");
}
