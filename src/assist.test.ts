import { test, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { generate, ASSIST_LIMIT, SEARCH_NOTE } from "./assist";
import { recipe } from "./recipe";

// A client that answers with the replies in turn and records what it was asked.
const fake = (...replies: Array<object | Error>) => { const calls: any[] = []; let n = 0; return { calls, client: { messages: { create: async (p: any) => { calls.push(structuredClone(p)); const r = replies[Math.min(n++, replies.length - 1)]!; if (r instanceof Error) throw r; return r; } } } as any }; };
const text = (t: string) => ({ type: "text", text: t });

test("the recipe and the note on searching are the system text, the wish is the only user message, and web search is offered", async () => {
  const f = fake({ stop_reason: "end_turn", content: [text("{}")] });
  expect(await generate(f.client, "claude-haiku-5-5", "京都 2泊3日")).toEqual({ kind: "text", text: "{}" });
  const p = f.calls[0];
  expect(p.system).toContain(recipe.text); expect(p.system).toContain(SEARCH_NOTE);  // said because the tool is there
  expect(p.messages).toEqual([{ role: "user", content: "京都 2泊3日" }]);
  expect(p.model).toBe("claude-haiku-5-5"); expect(p.output_config).toBeUndefined();
  expect(p.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
});
test("only the text after the last search is the answer; a paused turn is continued", async () => {
  const f = fake(
    { stop_reason: "pause_turn", content: [text("調べます。"), { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "福岡 見どころ" } }] },
    { stop_reason: "end_turn", content: [text("調べます。"), { type: "server_tool_use", id: "s1", name: "web_search", input: {} }, { type: "web_search_tool_result", tool_use_id: "s1", content: [] }, text('{"spec":'), text('{}}')] },
  );
  expect(await generate(f.client, "m", "x")).toEqual({ kind: "text", text: '{"spec":{}}' });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1].messages.at(-1).role).toBe("assistant");
});
test("a request the API refuses over web search is made again without it", async () => {
  const refused = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "web search is not enabled" } } as never, "400 web search is not enabled", new Headers());
  const f = fake(refused, { stop_reason: "end_turn", content: [text("{}")] });
  expect(await generate(f.client, "m", "x")).toEqual({ kind: "text", text: "{}" });
  expect(f.calls[0].tools).toBeDefined(); expect(f.calls[1].tools).toBeUndefined(); expect(f.calls[1].system).not.toContain(SEARCH_NOTE);
  // Any other 400 is not hidden.
  const other = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } } as never, "400 max_tokens too large", new Headers());
  await expect(generate(fake(other).client, "m", "x")).rejects.toThrow("max_tokens");
});
test("a refusal over web search after a pause starts again from the original messages", async () => {
  const refused = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "web search is not enabled" } } as never, "400 web search is not enabled", new Headers());
  const f = fake({ stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] }, refused, { stop_reason: "end_turn", content: [text("{}")] });
  expect(await generate(f.client, "m", "x")).toEqual({ kind: "text", text: "{}" });
  expect(f.calls[2].messages).toEqual([{ role: "user", content: "x" }]); expect(f.calls[2].tools).toBeUndefined();
});
test("a turn that ended on a search keeps the text written before it; no text at all is cut-off, not refused", async () => {
  const f = fake({ stop_reason: "end_turn", content: [text('{"spec":{}}'), { type: "server_tool_use", id: "s1", name: "web_search", input: {} }, { type: "web_search_tool_result", tool_use_id: "s1", content: [] }] });
  expect(await generate(f.client, "m", "x")).toEqual({ kind: "text", text: '{"spec":{}}' });
  expect(await generate(fake({ stop_reason: "end_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] }).client, "m", "x")).toEqual({ kind: "cut-off" });
});
test("a continuation that carries only the new blocks is read the same", async () => {
  const f = fake({ stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] }, { stop_reason: "end_turn", content: [text("{}")] });
  expect(await generate(f.client, "m", "x")).toEqual({ kind: "text", text: "{}" });
});
test("a repair has no search and echoes the answer with the problems", async () => {
  const f = fake({ stop_reason: "end_turn", content: [text("{}")] });
  await generate(f.client, "m", "x", undefined, { answer: "{bad}", problems: ["候補の本文: 指定してください"] });
  const p = f.calls[0];
  expect(p.tools).toBeUndefined(); expect(p.system).not.toContain(SEARCH_NOTE);  // not told it may search when it cannot
  expect(p.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(p.messages[2].content).toContain("候補の本文: 指定してください");
});
test("a stop for length is cut-off and a refusal is refused", async () => {
  expect(await generate(fake({ stop_reason: "max_tokens", content: [text("{\"spec\"")] }).client, "m", "x")).toEqual({ kind: "cut-off" });
  expect(await generate(fake({ stop_reason: "refusal", content: [] }).client, "m", "x")).toEqual({ kind: "refused" });
  expect(await generate(fake({ stop_reason: "end_turn", content: [] }).client, "m", "x")).toEqual({ kind: "cut-off" });
});
test("the limit is 6,000 bytes", () => expect(ASSIST_LIMIT).toBe(6000));
