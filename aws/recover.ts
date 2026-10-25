import { writeFile, chmod } from "node:fs/promises";
import { invoke } from "./invoke";
// The owner's bound browser was lost (cookie cleared, new phone). Replaces every owner invite of one capsule; old owner browsers stop working.
const [capsuleId, functionName, profile, region = "ap-northeast-1", destination = `./capsule-${capsuleId}.owner.json`] = process.argv.slice(2);
if (!/^[a-f0-9]{32}$/.test(capsuleId ?? "") || !functionName || !profile) throw new Error("Usage: bun aws/recover.ts capsule-id function profile [region] [output.owner.json]");
const result = await invoke(functionName, profile, region, { path: `/v1/c/${capsuleId}/recover`, payload: { confirm: true } });
if (result.statusCode !== 201) throw new Error(`回復に失敗しました (${result.statusCode})`);
await writeFile(destination, JSON.stringify({ id: capsuleId, ...result.body }, null, 2), { mode: 0o600, flag: "wx" });
await chmod(destination, 0o600);
console.log(`新しいownerリンクを ${destination} に保存しました（秘密のためログには表示しません）。3日以内にオーナーとして使う端末で開いてください。`);
