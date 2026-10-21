import { writeFile, chmod, rm } from "node:fs/promises";
import { invoke } from "./invoke";
// Creators may make a new trip from their phone's browser, signed in with a passkey, and read no trip. Only this IAM-authorized
// command enrolls one (a one-time link, one day), lists them, or revokes a creator or one of their passkeys.
const usage = [
  "Usage: bun aws/creator.ts enroll <label> <function> <profile> [region]",
  "       bun aws/creator.ts list <function> <profile> [region]",
  "       bun aws/creator.ts revoke --creator <id> | --passkey <id> <function> <profile> [region]",
].join("\n");
const [command, ...args] = process.argv.slice(2);
const date = (t: number | null) => t === null ? "-" : new Date(t).toISOString().slice(0, 16).replace("T", " ");
const detail = (r: { statusCode: number; body?: { error?: string } }) => `(${r.statusCode})${r.body?.error ? `: ${r.body.error}` : ""}`;
if (command === "enroll") {
  const [label, functionName, profile, region = "ap-northeast-1"] = args;
  if (!label || !functionName || !profile) throw new Error(usage);
  const destination = `./creator-${label.replace(/[^\p{L}\p{N}_-]/gu, "_")}.enroll.json`;
  // The file is claimed before the link exists: a name already taken must stop here, not after the Host has issued a link nobody can read.
  await writeFile(destination, "", { mode: 0o600, flag: "wx" });
  let saved = false;
  try {
    const result = await invoke(functionName, profile, region, { path: "/v1/creators/enroll", payload: { label, confirm: true } });
    if (result.statusCode !== 201) throw new Error(`登録リンクの発行に失敗しました ${detail(result)}`);
    await writeFile(destination, JSON.stringify({ label, ...result.body }, null, 2), { mode: 0o600 });
    await chmod(destination, 0o600); saved = true;
  } finally { if (!saved) await rm(destination, { force: true }); }
  console.log(`作成者「${label}」の登録リンクを ${destination} に保存しました（秘密のためログには表示しません）。1日以内に、作成者にするスマホの既定のブラウザで開き、パスキーを作ってください。1回だけ使えます。`);
} else if (command === "list") {
  const [functionName, profile, region = "ap-northeast-1"] = args;
  if (!functionName || !profile) throw new Error(usage);
  const result = await invoke(functionName, profile, region, { path: "/v1/creators/list", payload: {} });
  if (result.statusCode !== 200) throw new Error(`一覧の取得に失敗しました ${detail(result)}`);
  const creators = result.body as Array<{ id: string; label: string; created: number; lastUsed: number | null; revoked: number | null; passkeys: Array<{ id: string; device: string; created: number; revoked: number | null }> }>;
  if (!creators.length) console.log("作成者はいません。");
  for (const c of creators) {
    console.log(`${c.revoked === null ? "有効" : `失効 ${date(c.revoked)}`}  ${c.label}  id=${c.id}  登録 ${date(c.created)}  最終利用 ${date(c.lastUsed)}`);
    for (const p of c.passkeys) console.log(`    パスキー ${p.revoked === null ? "有効" : `失効 ${date(p.revoked)}`}  ${p.device}  登録 ${date(p.created)}  id=${p.id}`);
  }
} else if (command === "revoke") {
  const [flag, id, functionName, profile, region = "ap-northeast-1"] = args;
  if (!["--creator", "--passkey"].includes(flag ?? "") || !id || !functionName || !profile) throw new Error(usage);
  const result = await invoke(functionName, profile, region, { path: "/v1/creators/revoke", payload: { [flag!.slice(2)]: id, confirm: true } });
  if (result.statusCode !== 200) throw new Error(`失効に失敗しました ${detail(result)}`);
  console.log(flag === "--creator" ? "作成者を失効しました。その人のパスキーと登録リンクはすべて使えなくなりました。作った旅行と、その owner 席はそのまま残ります。" : "パスキーを失効しました。その端末ではサインインできません。ほかの端末はそのまま使えます。");
} else throw new Error(usage);
