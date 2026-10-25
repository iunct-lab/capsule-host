import { invoke } from "./invoke";
// The operator's view of the Host: every live capsule by its id, kind, state, dates and counts (never its title, plan or
// members' names), and ending one at once. Only this IAM-authorized command reaches either; no browser can.
const usage = [
  "Usage: bun aws/capsules.ts list <function> <profile> [region]",
  "       bun aws/capsules.ts terminate <capsule id> <function> <profile> [region]",
].join("\n");
const [command, ...args] = process.argv.slice(2);
const detail = (r: { statusCode: number; body?: { error?: string } }) => `(${r.statusCode})${r.body?.error ? `: ${r.body.error}` : ""}`;
if (command === "list") {
  const [functionName, profile, region = "ap-northeast-1"] = args;
  if (!functionName || !profile) throw new Error(usage);
  const result = await invoke(functionName, profile, region, { path: "/v1/capsules/list", payload: {} });
  if (result.statusCode !== 200) throw new Error(`一覧の取得に失敗しました ${detail(result)}`);
  console.log(JSON.stringify(result.body, null, 2));
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
