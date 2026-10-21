import { expect, test } from "bun:test";
import { exportFiles, tripHtml, tripMarkdown } from "./export";
import { testTrip } from "./test-fixture";

test("a placeholder time reads \"ごろ\" in the Markdown and HTML; the calendar is the same either way", () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "html", "ics"];
  trip.document.items[0] = { ...trip.document.items[0]!, timeTentative: true };
  const marked = exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(marked["README.md"]).toContain("- **集合** (confirmed) 2026-09-24T13:15:00+09:00 ごろ");
  expect(marked["README.md"]).toContain("- **夕食** (confirmed) 2026-09-25T19:00:00+09:00\n");
  expect(marked["index.html"]).toContain("<small>決定 · 13:15 ごろ</small>");
  expect(marked["index.html"]).toContain("<small>決定 · 19:00</small>");
  delete trip.document.items[0]!.timeTentative;
  expect(marked["calendar.ics"]).toBe(exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z")["calendar.ics"]);
  expect(marked["calendar.ics"]).toContain("DTSTART:20260924T041500Z");
});

test("an item with an end reads \"13:15 – 14:30\" in the HTML and gives the end in the Markdown, \"ごろ\" after both", () => {
  const trip = testTrip(); trip.spec.exports = ["markdown", "html"];
  trip.document.items[0] = { ...trip.document.items[0]!, endsAt: "2026-09-24T14:30:00+09:00" };
  const files = exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(files["README.md"]).toContain("- **集合** (confirmed) 2026-09-24T13:15:00+09:00 – 2026-09-24T14:30:00+09:00\n");
  expect(files["index.html"]).toContain("<small>決定 · 13:15 – 14:30</small>");
  trip.document.items[0].timeTentative = true;
  const marked = exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z");
  expect(marked["README.md"]).toContain("2026-09-24T13:15:00+09:00 – 2026-09-24T14:30:00+09:00 ごろ");
  expect(marked["index.html"]).toContain("<small>決定 · 13:15 – 14:30 ごろ</small>");
});

test("tripMarkdown is the README.md of the ZIP", () => {
  const trip = testTrip();
  expect(tripMarkdown(trip.spec, trip.document)).toBe(exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z")["README.md"]!);
});
test("tripHtml is the index.html of the ZIP", () => {
  const trip = testTrip(), html = tripHtml(trip.spec, trip.document);
  expect(html).toBe(exportFiles("c1", trip.spec, trip.document, "2026-09-20T00:00:00Z")["index.html"]!);
  expect(html).not.toContain("<script");
});
