import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IAM-authorized publisher call. Request and result only touch 0600 temp files because results carry owner links.
export async function invoke(functionName: string, profile: string, region: string, event: { path?: string; payload: unknown }): Promise<{ statusCode: number; body: any }> {
  const dir = await mkdtemp(join(tmpdir(), "capsule-invoke-"));
  try {
    const input = join(dir, "request.json"), output = join(dir, "result.json");
    await writeFile(input, JSON.stringify({ source: "capsule.publisher", ...event }), { mode: 0o600 });
    await writeFile(output, "", { mode: 0o600 });
    const proc = Bun.spawn(["aws", "lambda", "invoke", "--function-name", functionName, "--profile", profile, "--region", region, "--payload", `fileb://${input}`, "--no-cli-pager", output], { stdout: "pipe", stderr: "pipe" });
    const [code, metadata] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code !== 0) throw new Error("Lambdaの呼び出しに失敗しました。AWS接続・関数ログを確認してください。");
    const result = JSON.parse(await readFile(output, "utf8"));
    // The Lambda's own error message (never the trace) lets a caller tell an old Host ("Unsupported publisher path") from a broken one.
    if (JSON.parse(metadata).FunctionError) throw new Error(`Lambdaが失敗しました（${result?.errorMessage ?? "理由不明"}）。関数ログを確認してください。`);
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
