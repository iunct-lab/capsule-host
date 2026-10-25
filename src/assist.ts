import Anthropic from "@anthropic-ai/sdk";
import { recipe } from "./recipe";

// What a creator may ask for in one generation, in bytes (not characters: the bytes bound the tokens).
export const ASSIST_LIMIT = 6000;
// The model when CAPSULE_ASSIST_MODEL names none. The host and, for a sealed trip, the browser call the same one (#692).
export const ASSIST_MODEL = "claude-haiku-5-5";
// Revising a trip (#658): the bytes of the trip and the request one call may carry, and what the model is told. The host uses
// these for a plain trip; a sealed trip's browser sends the same to Anthropic itself (docs/design/trip-e2e.md §4).
export const REVISE_LIMIT = 120_000;
// The recipe is written for a chat that may ask what it needs. A call here has one answer and nobody to ask (#658): what is missing
// is decided and said in the notes. This overrides the recipe's "ask" in both uses; the date rule is for a new trip only.
export const ONE_SHOT = `- 上の作り方の「聞く」は、ここでは聞かずに、次のとおりにする: 質問や確認はせず、足りない情報は妥当な仮定で決めて、旅程の JSON だけを返してください（JSON のほかの文は書かない）
- 人数・好み・出発地が書かれていなければ、一般的な観光客を想定して決める
- 仮定したことは document.notes に短く書く（予約番号など秘密は書かない）`;
// The model does not know the date, so the host puts it first in what it sends.
export const todayLine = (day: string) => `今日は ${day} です。\n\n`;
// The recipe with its example, so the answer is shaped as the check wants it, then what this call is for.
export const REVISE_SYSTEM = `${recipe.text}

# この呼び出しの役割
あとに示す「今の旅程」を、「直してほしいこと」のとおりに直して、旅程の JSON だけを返してください。
- 直してほしいことが旅の計画を立てる依頼なら、予定（document.items）を具体的に作ってください。空のままにしない。日付は今の旅程の日付の中に収める
- 候補・相談の本文は body に書く（title は使えません）。使える項目は上の作り方のとおりです
- 旅程の JSON のほかの文は書かない
${ONE_SHOT}`;
// What the generation of a new trip is told (the top page's 「ここで作る」): the recipe, and that there is nobody to ask.
export const GENERATE_SYSTEM = `${recipe.text}

${ONE_SHOT}
- 「今日は …です」の日付が文の先頭にある。希望に日付が無いときは、希望の月の最初の週末のうち今日以降のもの（その月が過ぎていれば来年のその月）に決める。月も無ければ今日から近い週末
- 旅の計画を立てる依頼なので、予定（document.items）を具体的に、時刻つきで作る。空のままにしない`;
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
