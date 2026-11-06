// The instructions a person hands to their own chat assistant. Bun reads the document itself, so the file in docs/ is
// the only copy: what the host serves and what a reader of the repository sees cannot drift apart.
import text from "../docs/recipes/trip.md" with { type: "text" };
import board from "../docs/recipes/board.md" with { type: "text" };
// Revising starts from the trip as it stands, so the example a new trip is modelled on is left out of what is copied then:
// the copy has to fit in one chat message (#306).
const cut = text.indexOf("\n## 例\n");
if (cut < 0) throw new Error("the recipe has no example section");
export const recipe = { kind: "trip" as const, text, withoutExample: text.slice(0, cut + 1) };
// A board's (src/board-kit.ts), served by GET /v1/recipe?kind=board. It is not revised, so it has no copy without the example.
export const boardRecipe: string = board;
