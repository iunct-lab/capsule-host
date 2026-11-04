import { invoke } from "./invoke";
import { decommissionReport } from "../src/decommission";
// The operator's view of the Host: every live capsule by its id, kind, state, dates and counts (never its title, plan or
// members' names), whether its plan is sealed (`sealed`) and whether it cannot be used until its owner moves
// it (`mustSeal`: not sealed, so not to be used until its owner seals it, docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」), ending one at once,
// and, before the Host is torn down, counting the live trips and stopping while any is left (`check-decommission`).
// Only this IAM-authorized command reaches any of them; no browser can.
const usage = [
  "Usage: bun aws/capsules.ts list <function> <profile> [region]",
  "       bun aws/capsules.ts terminate <capsule id> <function> <profile> [region]",
  "       bun aws/capsules.ts check-decommission <function> <profile> [region]",
].join("\n");
const [command, ...args] = process.argv.slice(2);
const detail = (r: { statusCode: number; body?: { error?: string } }) => `(${r.statusCode})${r.body?.error ? `: ${r.body.error}` : ""}`;
if (command === "list") {
  const [functionName, profile, region = "ap-northeast-1"] = args;
  if (!functionName || !profile) throw new Error(usage);
  const result = await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} });
  if (result.statusCode !== 200) throw new Error(`一覧の取得に失敗しました ${detail(result)}`);
  console.log(JSON.stringify(result.body, null, 2));
} else if (command === "check-decommission") {
  // Before the stack is deleted: counts the live trips and stops (exit 1) while any is left, so no plan is lost with it.
  const [functionName, profile, region = "ap-northeast-1"] = args;
  if (!functionName || !profile) throw new Error(usage);
  const result = await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} });
  if (result.statusCode !== 200) throw new Error(`一覧の取得に失敗しました ${detail(result)}`);
  const report = decommissionReport(result.body, Date.now());
  for (const line of report.lines) console.log(line);
  if (!report.ok) { console.error("有効な旅行が残っています。廃止しません。"); process.exit(1); }
  console.log("有効な旅行はありません。廃止に進めます。");
} else if (command === "terminate") {
  const [id, functionName, profile, region = "ap-northeast-1"] = args;
  if (!id || !functionName || !profile) throw new Error(usage);
  // Ending a trip cannot be undone, so the id is typed a second time rather than taken from a flag.
  const typed = prompt("終了するカプセルの ID をもう一度入力してください:")?.trim();
  if (typed !== id) { console.error("ID が一致しません。何もしていません。"); process.exit(1); }
  const result = await invoke(functionName, profile, region, { path: `/v1/c/${id}/terminate`, payload: { id, confirm: true } });
  if (result.statusCode !== 200) throw new Error(`強制終了に失敗しました ${detail(result)}`);
  console.log("カプセルを終了しました。以後このカプセルへのアクセスは 410 になります。取り消せません。");
} else throw new Error(usage);
