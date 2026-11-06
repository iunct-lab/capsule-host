import { expect, test } from "bun:test";
import { ZodError } from "zod";
import { Refused, type Asked, type Role } from "./kit";
import { kitOf } from "./kits";
import { boardKit } from "./board-kit";
import { boardSealedOperationSchema, boardSpecSchema, stateOfBoard, validateBoard, validateBoardSealed, type BoardSpec, type BoardDocument } from "./board-schema";
import { testBoard, testTrip } from "./test-fixture";
import { newTripKey, openCapsule, openField, openTrip, resealAll, sealMove, sealOperation, sealTrip } from "./trip-keys";

const now = +new Date("2026-09-01T00:00:00Z");
const asked = (role: Role, board = testBoard(), state: Asked<BoardSpec, BoardDocument>["state"] = "active"): Asked<BoardSpec, BoardDocument> =>
  ({ ...board, created: now, sealed: false, role, state, seat: "seat-1", now });
const refused = (f: () => unknown) => { try { f(); } catch (e) { return e; } };

test("a board's kit is found by its kind", () => {
  expect(kitOf({ kind: "board" })).toBe(boardKit);
});

test("a board without dates or places publishes; a trip's page, a trip's dates and a deadline too far are refused", () => {
  const board = testBoard();
  expect(boardKit.publish(board.spec, board.document, now)).toEqual(validateBoard(board.spec, board.document, now));
  for (const spec of [
    { ...board.spec, modules: [...board.spec.modules, { id: "days", kind: "day-timeline", label: "日程" }] },
    { ...board.spec, trip: { startsOn: "2026-09-24", endsOn: "2026-09-26", destinations: ["箱根"] } },
    { ...board.spec, lifecycle: { reflectionDays: 7, purgeAt: board.spec.lifecycle.purgeAt } },
    { ...board.spec, exports: ["ics"] },
    { ...board.spec, navigation: ["nowhere"] },
    { ...board.spec, lifecycle: { purgeAt: "2027-06-01T00:00:00Z" } },
  ]) expect(refused(() => boardKit.publish(spec, board.document, now))).toMatchObject({ status: 400, message: "内容と期限を確認してください" });
  // A trip is not a board, nor a board a trip; a board's document holds no items.
  const trip = testTrip();
  expect(() => validateBoard(trip.spec, board.document, now)).toThrow();
  expect(() => validateBoard(board.spec, { ...board.document, items: [] }, now)).toThrow();
  expect(() => validateBoard(board.spec, { ...board.document, checklist: [board.document.checklist[0], board.document.checklist[0]] }, now)).toThrow("IDが重複しています");
  expect(boardSpecSchema.shape.modules.element.options.map(o => o.shape.kind.value)).toEqual(["suggestion-board", "checklist", "budget", "notes", "reflection"]);
});

test("a board is active until the owner ends the sharing, and gone at its deadline: there is no time after it", () => {
  const { spec } = testBoard(), deadline = +new Date(spec.lifecycle.purgeAt);
  expect(stateOfBoard(spec, null, now)).toBe("active");
  expect(stateOfBoard(spec, null, deadline - 1)).toBe("active");
  expect(stateOfBoard(spec, "frozen", now)).toBe("frozen");
  expect(stateOfBoard(spec, null, deadline)).toBe("purged");
  expect(stateOfBoard(spec, "frozen", deadline)).toBe("purged");
  expect(boardKit.stateOf).toBe(stateOfBoard);
  expect(boardKit.period).toBeUndefined();
  expect(boardKit.revise).toBeUndefined();
});

test("a member's request does to a board what it does to a trip's same page, by role", () => {
  const owner = asked("owner");
  boardKit.apply(owner, { type: "suggest", author: "A", body: "土曜の夜" });
  expect(owner.document.suggestions).toEqual([{ id: expect.any(String), author: "A", body: "土曜の夜", createdAt: new Date(now).toISOString() }]);
  for (const op of [{ type: "check", id: "a", done: true }, { type: "comment", author: "A", body: "賛成" }, { type: "reflect", author: "A", body: "楽しかった" }, { type: "notes", body: "集合は駅" },
    { type: "checklist", checklist: [{ id: "a", title: "Aさん" }, { id: "b", title: "Bさん" }] }, { type: "budget", budget: [{ id: "fee", title: "会費", amount: 3000, description: "" }] }]) boardKit.apply(owner, op);
  expect(owner.document).toMatchObject({ revision: 8, checklist: [{ id: "a", done: true }, { id: "b", done: false }], notes: "集合は駅", budget: [{ id: "fee", amount: 3000 }] });
  expect(owner.document.reflections).toHaveLength(1);
  // A participant suggests, checks and comments as the board allows; the owner's parts are refused.
  const participant = asked("participant");
  boardKit.apply(participant, { type: "check", id: "a", done: true });
  boardKit.apply(participant, { type: "reflect", author: "B", body: "また行きたい" });
  for (const op of [{ type: "notes", body: "x" }, { type: "checklist", checklist: [] }, { type: "budget", budget: [] }]) expect(refused(() => boardKit.apply(participant, op))).toMatchObject({ status: 403 });
  const closed = testBoard(); closed.spec.collaboration.participantChecklist = false;
  expect(refused(() => boardKit.apply(asked("participant", closed), { type: "check", id: "a", done: true }))).toMatchObject({ status: 403, message: "この操作は許可されていません" });
  for (const [setting, op] of [["participantSuggestions", { type: "suggest", author: "B", body: "x" }], ["participantComments", { type: "comment", author: "B", body: "x" }]] as const) {
    const off = testBoard(); off.spec.collaboration[setting] = false;
    expect(refused(() => boardKit.apply(asked("participant", off), op))).toMatchObject({ status: 403, message: "この操作は許可されていません" });
    expect(() => boardKit.apply(asked("participant"), op)).not.toThrow();
  }
  // An editor changes the owner's parts as the owner does: rewrites and removes a post, includes a memory; a participant may not.
  const edited = testBoard(), at = new Date(now).toISOString();
  edited.document.suggestions.push({ id: "s1", author: "A", body: "土曜", createdAt: at }); edited.document.comments.push({ id: "c1", author: "A", body: "賛成", createdAt: at });
  edited.document.reflections.push({ id: "r1", author: "A", body: "楽しかった", createdAt: at, included: false });
  for (const op of [{ type: "rewrite", list: "suggestions", id: "s1", body: "日曜" }, { type: "remove", list: "comments", id: "c1" }, { type: "include", id: "r1", included: true }, { type: "notes", body: "編集者のメモ" }])
    expect(refused(() => boardKit.apply(asked("participant", structuredClone(edited)), op))).toMatchObject({ status: 403 });
  const editor = asked("editor", edited);
  for (const op of [{ type: "rewrite", list: "suggestions", id: "s1", body: "日曜" }, { type: "remove", list: "comments", id: "c1" }, { type: "include", id: "r1", included: true }, { type: "notes", body: "編集者のメモ" }]) boardKit.apply(editor, op);
  expect(editor.document).toMatchObject({ suggestions: [{ id: "s1", body: "日曜", author: "A", createdAt: at }], comments: [], reflections: [{ id: "r1", included: true }], notes: "編集者のメモ" });
  // A page the board does not show takes no request.
  const hidden = testBoard(); hidden.spec.navigation = ["ideas"];
  expect(refused(() => boardKit.apply(asked("owner", hidden), { type: "notes", body: "x" }))).toMatchObject({ status: 403, message: "このモジュールは無効です" });
});

test("a board has no items: adding, moving and promoting one are refused", () => {
  const board = testBoard();
  board.document.suggestions.push({ id: "s1", author: "A", body: "土曜", createdAt: new Date(now).toISOString() });
  for (const op of [{ type: "promote", id: "s1", day: "2026-09-24" }, { type: "move", id: "x", before: null }, { type: "item", item: testTrip().document.items[0] }]) {
    const e = refused(() => boardKit.apply(asked("owner", board), op));
    expect(e).toBeInstanceOf(ZodError);
  }
  expect(board.document.revision).toBe(1);
  // What would break the board's rules is refused.
  const full = asked("owner");
  expect(refused(() => boardKit.apply(full, { type: "checklist", checklist: [{ id: "a", title: "A" }, { id: "a", title: "A" }] }))).toBeInstanceOf(Refused);
});

test("a board's exports are the trip's without the days, and it reads its accent and its deletion rules", async () => {
  const { spec, document } = testBoard();
  document.checklist[0]!.done = true;
  const markdown = boardKit.exports!.markdown(spec, document);
  expect(markdown).toStartWith(`---\ntitle: "テストの出欠"\nrevision: 1\n---\n\n# テストの出欠\n\n来られるかどうか\n\n## 準備\n- [x] Aさん\n`);
  const html = boardKit.exports!.html(spec, document);
  expect(html).toContain("<h1>テストの出欠</h1><p>revision 1</p><p>来られるかどうか</p><h2>準備</h2>");
  expect(boardKit.exports!.name(spec)).toBe("board.zip");
  const zipped = new TextDecoder().decode(await boardKit.exports!.zip("cap", spec, document, "2026-09-01T00:00:00.000Z"));
  for (const name of ["README.md", "board.json", "index.html", "manifest.json"]) expect(zipped).toContain(name);
  expect(zipped).not.toContain("calendar.ics");
  expect(boardKit.accent(spec)).toBe("#335c4a");
  expect(boardKit.refusal(spec, { ...spec, modules: spec.modules.slice(1) }, now)).toBe("今あるページは消せません");
  expect(boardKit.refusal(spec, { ...spec, lifecycle: { purgeAt: "2026-08-01T00:00:00Z" } }, now)).toBe("削除期限は今より後にしてください");
  expect(boardKit.refusal(spec, spec, now)).toBeUndefined();
});

test("a board is kept sealed: the sealed rules check the sealed form, and a move brings no step back", async () => {
  const board = testBoard(), sealed = await sealTrip(await newTripKey(), "board-a", 1, board);
  expect(boardKit.validate(sealed.spec, sealed.document, now, true)).toEqual(validateBoardSealed(sealed.spec, sealed.document, now));
  expect(() => boardKit.validate(board.spec, board.document, now, true)).toThrow();
  expect(boardKit.sealed!.previous.safeParse(undefined).success).toBe(false);
  expect(boardKit.sealed!.previous.optional().safeParse(undefined).success).toBe(true);
});

// A board with a word in every record that is sealed: none of them may be left in what the host keeps.
const fullBoard = () => {
  const b = testBoard(), at = new Date(now).toISOString();
  b.document = {
    revision: 3, suggestions: [{ id: "s1", author: "候補の人", body: "候補の言葉", createdAt: at }], comments: [{ id: "c1", author: "コメントの人", body: "コメントの言葉", createdAt: at }],
    reflections: [{ id: "r1", author: "ふりかえりの人", body: "ふりかえりの言葉", createdAt: at, included: true }], checklist: [{ id: "a", title: "チェックの言葉", done: true }],
    notes: "メモの言葉", budget: [{ id: "fee", title: "会費の言葉", amount: 4321, description: "会費の説明の言葉" }],
  };
  return b;
};
const words = ["テストの出欠", "来られるかどうか", "候補", "出欠", "メモ", "ふりかえり", "会費", "候補の人", "候補の言葉", "コメントの言葉", "ふりかえりの言葉", "チェックの言葉", "メモの言葉", "会費の言葉", "会費の説明の言葉", "4321"];

test("往復: a sealed board keeps none of its words, passes the sealed rules, and opens back with its key and id only", async () => {
  const key = await newTripKey(), b = fullBoard(), sealed = await sealTrip(key, "board-a", 1, b), stored = JSON.stringify(sealed);
  for (const w of words) expect(stored).not.toContain(w);
  expect(validateBoardSealed(sealed.spec, sealed.document, now)).toEqual(sealed);
  expect(() => validateBoardSealed(b.spec, b.document, now)).toThrow();
  expect(await openCapsule(key, "board-a", sealed)).toEqual({ ...b, unreadable: [] });
  // Not a trip: openTrip does not take it, and a trip's sealed rules refuse it.
  expect(await openTrip(key, "board-a", sealed as never)).toBeNull();
  expect(await openCapsule(await newTripKey(), "board-a", sealed)).toBeNull();
  expect(await openCapsule(key, "board-b", sealed)).toBeNull();
  // A record moved under another record's name does not open, and is named rather than shown.
  const moved = { ...sealed, document: { ...sealed.document, notes: sealed.document.checklist[0]!.title } };
  expect((await openCapsule(key, "board-a", moved))!.unreadable).toEqual(["notes/notes"]);
});

test("世代: resealAll seals a board under the next generation, keeping each post's seat; the old key opens none of it", async () => {
  const oldKey = await newTripKey(), newKey = await newTripKey(), b = fullBoard(), sealed = await sealTrip(oldKey, "board-a", 1, b);
  sealed.document.suggestions[0]!.seat = "seat-a";
  const out = await resealAll(oldKey, newKey, "board-a", 2, { ...sealed, footprints: [], members: [{ id: "seat-o", label: "オーナー" }], grants: [] });
  for (const w of words) expect(JSON.stringify(out)).not.toContain(w);
  expect(validateBoardSealed(out.spec, out.document, now).document.suggestions[0]!.seat).toBe("seat-a");
  expect(await openCapsule(newKey, "board-a", out)).toEqual({ ...b, unreadable: [] });
  expect(await openCapsule(oldKey, "board-a", out)).toBeNull();
  await expect(openField(oldKey, "board-a", "notes", "notes", "body", out.document.notes)).rejects.toThrow();
});

test("a board's move to the sealed form and its members' requests are sealed as a trip's, without items", async () => {
  const key = await newTripKey(), b = fullBoard();
  const body = await sealMove(key, "board-a", 1, { ...b, previous: null, footprints: [], grants: [{ id: "g", label: "友だちへの招待", members: [] }] });
  for (const w of [...words, "友だちへの招待"]) expect(JSON.stringify(body)).not.toContain(w);
  expect(body).not.toHaveProperty("previous");
  expect(await openCapsule(key, "board-a", body)).toEqual({ ...b, unreadable: [] });
  for (const op of [{ type: "suggest", author: "A", body: "日曜" }, { type: "check", id: "a", done: false }, { type: "notes", body: "駅" }, { type: "checklist", checklist: [{ id: "a", title: "Aさん" }] }, { type: "budget", budget: [{ id: "fee", title: "会費", amount: 1, description: "" }] }]) {
    const sealed = await sealOperation(key, "board-a", 1, op, b.document);
    expect(boardSealedOperationSchema.parse(sealed)).toEqual(sealed as never);
  }
  // A board's suggestion is not promoted to an item: the browser refuses before sealing, the host's form has no such request.
  await expect(sealOperation(key, "board-a", 1, { type: "promote", id: "s1", day: "2026-09-24" }, b.document)).rejects.toThrow("候補が存在しないか追加済みです");
  expect(() => boardSealedOperationSchema.parse({ type: "promote", id: "s1", day: "2026-09-24", item: { id: "x", sealed: "v1.1.AAAA" } })).toThrow();
});
