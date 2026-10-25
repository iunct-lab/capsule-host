import { open, unlink } from "node:fs/promises";
import { invoke } from "./invoke";
// The owner's bound browser was lost (cookie cleared, new phone). Replaces every owner invite of one capsule; old owner browsers stop working.
const [capsuleId, functionName, profile, region = "ap-northeast-1", destination = `./capsule-${capsuleId}.owner.json`] = process.argv.slice(2);
if (!/^[a-f0-9]{32}$/.test(capsuleId ?? "") || !functionName || !profile) throw new Error("Usage: bun aws/recover.ts capsule-id function profile [region] [output.owner.json]");
// /recover revokes the old owner seat and issues the new link in one call, so claim the destination first: a link that
// cannot be stored would leave only the revocation behind.
const file = await open(destination, "wx", 0o600).catch((e) => { throw new Error(`${destination} に保存できないため、何も変えずに止めました（${e.code ?? e.message}）。ファイルを消すか、別の保存先を最後の引数に渡してください。`); });
const result = await invoke(functionName, profile, region, { path: `/v1/c/${capsuleId}/recover`, payload: { confirm: true } })
  .catch(async (e) => { await file.close(); await unlink(destination); throw e; });
if (result.statusCode !== 201) { await file.close(); await unlink(destination); throw new Error(`回復に失敗しました (${result.statusCode})`); }
await file.writeFile(JSON.stringify({ id: capsuleId, ...result.body }, null, 2));
await file.chmod(0o600);
await file.close();
console.log(`新しいownerリンクを ${destination} に保存しました（秘密のためログには表示しません）。3日以内にオーナーとして使う端末で開いてください。`);
