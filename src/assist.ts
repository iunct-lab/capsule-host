import Anthropic from "@anthropic-ai/sdk";
import { recipe } from "./recipe";

// What a creator may ask for in one generation, in bytes (not characters: the bytes bound the tokens).
export const ASSIST_LIMIT = 6000;
// A second turn: the answer the model gave and what the host's own check found wrong with it, so it can put that right once.
export type Follow = { answer: string; problems: string[] };
export type Generated = { kind: "text"; text: string } | { kind: "cut-off" } | { kind: "refused" };

// Said to the model in both uses: it, not the host, decides whether a request needs the web (#658: planning does, a small edit does not).
export const SEARCH_NOTE = `# 調べもの
web_search を使えます。使うかどうかはあなたが判断してください。
- 旅の計画を新しく立てる・大きく作り直す依頼では、行き先の見どころ・営業時間・休業日・移動の時間などの最新の情報を調べてから、予定に入れてください
- 予定の時刻の変更、一言の言い換え、項目の追加・削除のような小さな修正では、調べずに直してください
- 調べた結果は予定の title・note に反映し、旅程の JSON の外に出典の文などを書かない`;
// At most this many searches a call, so a request's cost to the key's owner stays bounded.
const MAX_SEARCHES = 5;

// A call may search the web (an Anthropic-side tool, billed to the key's owner) and may pause to be continued; the answer is the
// text after the last search. It is plain text that goes to the host's own check(), as a pasted one does: the API's
// structured-output mode is not used (its schema limits refused the trip's schema, and check() decides anyway). The first call
// (not the repair) has the tool; a request the API refuses over the tool itself is made again without it.
export async function generate(client: Pick<Anthropic, "messages">, model: string, text: string, system: string = recipe.text, follow?: Follow, budget = 170_000): Promise<Generated> {
  const base: Anthropic.MessageParam[] = [{ role: "user", content: text }];
  if (follow) base.push({ role: "assistant", content: follow.answer }, { role: "user", content: `この答えには、次の直すところがあります。直して、旅程の JSON だけをもう一度返してください。\n\n${follow.problems.map(p => `- ${p}`).join("\n")}` });
  const messages = [...base], started = Date.now();
  let tools: Anthropic.ToolUnion[] | undefined = follow ? undefined : [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }];
  for (let turn = 0; turn < 4;) {
    const left = budget - (Date.now() - started);
    if (left < 5000) return { kind: "cut-off" };
    let message: Anthropic.Message;
    try {
      // The note on searching is only said when the tool is there to use.
      message = await client.messages.create({ model, max_tokens: 16000, system: tools ? `${system}\n\n${SEARCH_NOTE}` : system, messages, ...(tools ? { tools } : {}) }, { timeout: left });
    } catch (e) {
      // Refused over the tool itself (not enabled for the organisation, not offered for the model): start again without it, from the original messages.
      if (tools && e instanceof Anthropic.BadRequestError && /web.?search|tools\.0/i.test(String(e.message))) { tools = undefined; messages.length = 0; messages.push(...base); continue; }
      throw e;
    }
    turn++;
    if (message.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] }); continue; }
    if (message.stop_reason === "max_tokens") return { kind: "cut-off" };
    if (message.stop_reason === "refusal") return { kind: "refused" };
    // The answer is what follows the last search; a turn that ended on a search takes the text it had written before.
    const lastSearch = message.content.map(b => b.type).reduce((at, type, i) => type === "web_search_tool_result" || type === "server_tool_use" ? i : at, -1);
    const texts = (from: number) => message.content.slice(from).filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
    const answer = texts(lastSearch + 1).trim() ? texts(lastSearch + 1) : texts(0);
    return answer.trim() ? { kind: "text", text: answer } : { kind: "cut-off" };
  }
  return { kind: "cut-off" };
}
// 170 seconds for the answer (searching included) and 100 for a repair: both inside the function's 300 and the job's 360.
export const anthropicGenerate = (apiKey: string, model: string, text: string, system?: string, follow?: Follow) =>
  generate(new Anthropic({ apiKey, maxRetries: 0 }), model, text, system, follow, follow ? 100_000 : 170_000);
