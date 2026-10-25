import { expect, test } from "bun:test";
import { exportFiles, tripHtml, tripMarkdown, zip } from "./export";
import { testTrip } from "./test-fixture";

test("a placeholder time reads \"ごろ\" in the Markdown and HTML; the calendar is the same either way", async () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "html", "ics"];
  trip.document.items[0] = { ...trip.document.items[0]!, timeTentative: true };
  const marked = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(marked["README.md"]).toContain("- **集合** (confirmed) 2026-09-24T13:15:00+09:00 ごろ");
  expect(marked["README.md"]).toContain("- **夕食** (confirmed) 2026-09-25T19:00:00+09:00\n");
  expect(marked["index.html"]).toContain("<small>決定 · 13:15 ごろ</small>");
  expect(marked["index.html"]).toContain("<small>決定 · 19:00</small>");
  delete trip.document.items[0]!.timeTentative;
  expect(marked["calendar.ics"]).toBe((await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z"))["calendar.ics"]);
  expect(marked["calendar.ics"]).toContain("DTSTART:20260924T041500Z");
});

test("an item with an end reads \"13:15 – 14:30\" in the HTML and gives the end in the Markdown, \"ごろ\" after both", async () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "html"];
  trip.document.items[0] = { ...trip.document.items[0]!, endsAt: "2026-09-24T14:30:00+09:00" };
  const files = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(files["README.md"]).toContain("- **集合** (confirmed) 2026-09-24T13:15:00+09:00 – 2026-09-24T14:30:00+09:00\n");
  expect(files["index.html"]).toContain("<small>決定 · 13:15 – 14:30</small>");
  trip.document.items[0].timeTentative = true;
  const marked = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(marked["README.md"]).toContain("2026-09-24T13:15:00+09:00 – 2026-09-24T14:30:00+09:00 ごろ");
  expect(marked["index.html"]).toContain("<small>決定 · 13:15 – 14:30 ごろ</small>");
});

test("tripMarkdown is the README.md of the ZIP", async () => {
  const trip = testTrip();
  expect(tripMarkdown(trip.spec, trip.document)).toBe((await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z"))["README.md"]!);
});
test("tripHtml is the index.html of the ZIP", async () => {
  const trip = testTrip(), html = tripHtml(trip.spec, trip.document);
  expect(html).toBe((await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z"))["index.html"]!);
  expect(html).not.toContain("<script");
});

// The ZIP made before the move to crypto.subtle and Uint8Array: the host and the browser must give these bytes.
test("export bytes stay the same", async () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "json", "ics", "html"];
  const files = await exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(files["manifest.json"]).toBe("{\n  \"schemaVersion\": 1,\n  \"capsuleId\": \"c1\",\n  \"revision\": 1,\n  \"createdAt\": \"2026-09-20T00:00:00Z\",\n  \"files\": {\n    \"README.md\": \"e9cd0c000543c107c37af83b3899bedab0af266a42a63d738416f4c63b5b14ec\",\n    \"trip.json\": \"d61be5adfb82764417d81d9c80352d837309647f7a6b3c1545f7e186ca88f6e3\",\n    \"calendar.ics\": \"4c5063941610e2a6b2f472ca3cd7533a6984d9efcd7c69705166296077472ad2\",\n    \"index.html\": \"cc7055f61e029ad7caa20380e4a92596996aecdbf6c46158e80350827dd66d32\"\n  }\n}");
  expect(new Bun.CryptoHasher("sha256").update(zip(files)).digest("hex")).toBe("7feef7cc00c9f1ef3b28d0ed4cca1900c8280cbc7c21652b51a49c1d8f5099fe");
});
test("export runs in the browser", async () => {
  const built = await Bun.build({ entrypoints: ["src/export.ts"], target: "browser" });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]!.text();
  expect(code.includes("node:")).toBe(false);
  expect(/\bBuffer\b/.test(code)).toBe(false);
});
