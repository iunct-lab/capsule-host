// The board as a Domain Kit (src/kit.ts): a capsule without dates or places (src/board-schema.ts). Its pages and what a
// member's request does to them are the trip's (src/trip-kit.ts applyShared), and its exports the trip's without the days.
import { z } from "zod";
import { refuse, type DomainKit } from "./kit";
import { boardOperationSchema, boardSealedOperationSchema, stateOfBoard, validateBoard, validateBoardSealed, type BoardSpec, type BoardDocument, type SealedBoardSpec, type SealedBoardDocument } from "./board-schema";
import { applyShared, rekeyedPosts } from "./trip-kit";
import { refusal } from "./revise";
import { boardFiles, pageHtml, pageMarkdown, zip } from "./export";
import { boardRecipe } from "./recipe";
import { check } from "./validate";
import { extract, explain } from "./paste";
import { ONE_SHOT } from "./assist";

// A board as the host keeps it: plain, or sealed with its words as ciphertext (docs/ephemeral-trip-capsule.md「5.2 暗号化するもの・平文に残すもの」).
export const boardKit: DomainKit<BoardSpec | SealedBoardSpec, BoardDocument | SealedBoardDocument> = {
  kind: "board",
  publish(spec, document, now) {
    try { return validateBoard(spec, document, now); } catch { return refuse(400, "内容と期限を確認してください"); }
  },
  validate: (spec, document, createdAt, sealed) => sealed ? validateBoardSealed(spec, document, createdAt) : validateBoard(spec, document, createdAt),
  stateOf: stateOfBoard,
  accent: spec => spec.theme.accent,
  refusal,
  exports: {
    zip: async (id, spec, document, updatedAt) => zip(await boardFiles(id, spec as BoardSpec, document as BoardDocument, updatedAt)),
    name: () => "board.zip",
    markdown: (spec, document) => pageMarkdown({ spec, doc: document as BoardDocument }),
    html: (spec, document) => pageHtml({ spec, doc: document as BoardDocument }),
  },
  // The host's own generation makes a trip only (POST /v1/assist); `generate` is what it would be told for a board.
  recipe: { text: boardRecipe, generate: `${boardRecipe}\n\n${ONE_SHOT}` },
  // As the trip's: only the two parts check() validated come back.
  judge(text, now) {
    const taken = extract(text);
    if (!taken.ok) return { ok: false, reason: taken.reason };
    const checked = check(taken.value, now);
    if (!checked.ok) return { ...checked, messages: explain(checked.errors) };
    const { spec, document } = taken.value as { spec: unknown; document: unknown };
    return { ...checked, trip: { spec, document } };
  },
  apply(asked, input) {
    const op = asked.sealed ? boardSealedOperationSchema.parse(input) : boardOperationSchema.parse(input), doc = asked.document;
    applyShared(asked, op, doc);
    doc.revision++; try { boardKit.validate(asked.spec, doc, asked.created, asked.sealed); } catch { refuse(400, "内容・容量を確認してください"); }
    return {};
  },
  // A board has no step back to move with it (no revise), and its records are a trip's without the items.
  sealed: {
    previous: z.never(),
    rekeyed: (before, after) => rekeyedPosts(before, after, ["suggestions", "comments", "reflections", "checklist", "budget"]),
  },
};
