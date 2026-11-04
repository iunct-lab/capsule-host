import { report, resourcesOf, assertNoSecrets, type Counts, type StackResource } from "../src/aws-remnants";

// After the Host is torn down: counts what is left in the stack's Retain resources (Data's items, Media's and Assets' objects).
// Works on a deleted stack too (DELETE_COMPLETE: its resources are read by the stack's id). Counts only, deletes nothing, and
// prints no table or bucket name, ARN or account id. Exit 0 = nothing left, 1 = something left, 2 = could not count.
const [stack, profile, region = "ap-northeast-1"] = process.argv.slice(2);
if (!stack || !profile) {
  console.error("Usage: bun aws/remnants.ts STACK PROFILE [REGION]");
  process.exit(2);
}

class Missing extends Error {}
// As aws/verify.ts's cliIn: the CLI's stderr names ARNs (the account id), so a failure says only which call failed. It is read
// for the error codes that mean the resource is not there, and never printed.
async function cli(missing: RegExp | null, ...args: string[]) {
  const proc = Bun.spawn(["aws", ...args, "--profile", profile!, "--region", region, "--no-cli-pager", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0 && missing?.test(err)) throw new Missing();
  if (code !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} に失敗しました（終了コード ${code}。詳細はこのコマンドを手で実行して確認してください）`);
  return JSON.parse(out);
}

// A live stack by its name; a deleted one only by its id, the latest deleted under that name.
async function stackResources(): Promise<StackResource[] | null> {
  const list = async (id: string) => (await cli(null, "cloudformation", "list-stack-resources", "--stack-name", id)).StackResourceSummaries as StackResource[];
  try {
    return (await cli(/does not exist/, "cloudformation", "list-stack-resources", "--stack-name", stack!)).StackResourceSummaries as StackResource[];
  } catch (e) {
    if (!(e instanceof Missing)) throw e;
  }
  const { StackSummaries } = await cli(null, "cloudformation", "list-stacks", "--stack-status-filter", "DELETE_COMPLETE") as { StackSummaries: Array<{ StackId: string; StackName: string; DeletionTime?: string }> };
  const deleted = StackSummaries.filter(s => s.StackName === stack).sort((a, b) => +new Date(b.DeletionTime ?? 0) - +new Date(a.DeletionTime ?? 0))[0];
  return deleted ? await list(deleted.StackId) : null;
}

// One scan gives both counts: Count is the items the filter keeps (a trip's payload rows), ScannedCount every item. Names only are
// compared on the server; nothing of a row comes back.
async function countItems(table: string) {
  let data = 0, tripRows = 0, start: unknown = undefined;
  do {
    const page = await cli(/ResourceNotFoundException/, "dynamodb", "scan", "--table-name", table, "--select", "COUNT", "--consistent-read", "--no-paginate",
      "--filter-expression", "begins_with(sk, :c)", "--expression-attribute-values", '{":c":{"S":"chunk:"}}', ...(start ? ["--exclusive-start-key", JSON.stringify(start)] : [])) as { Count: number; ScannedCount: number; LastEvaluatedKey?: unknown };
    data += page.ScannedCount; tripRows += page.Count; start = page.LastEvaluatedKey;
  } while (start);
  return { data, tripRows };
}

async function countObjects(bucket: string) {
  let count = 0, token: string | undefined = undefined;
  do {
    const page = await cli(/NoSuchBucket/, "s3api", "list-objects-v2", "--bucket", bucket, "--no-paginate", ...(token ? ["--continuation-token", token] : [])) as { KeyCount: number; NextContinuationToken?: string };
    count += page.KeyCount; token = page.NextContinuationToken;
  } while (token);
  return count;
}

try {
  const listed = await stackResources();
  if (!listed) {
    console.error("スタックが見つからない（動いているものにも、削除済みのものにも無い）");
    process.exit(2);
  }
  const { table, media, assets } = resourcesOf(listed);
  const gone: Array<"data" | "media" | "assets"> = [];
  const counted = async <T>(key: "data" | "media" | "assets", count: () => Promise<T>, none: T) => {
    try { return await count(); } catch (e) { if (e instanceof Missing) { gone.push(key); return none; } throw e; }
  };
  const items = await counted("data", () => countItems(table), { data: 0, tripRows: 0 });
  const counts: Counts = { ...items, media: await counted("media", () => countObjects(media), 0), assets: await counted("assets", () => countObjects(assets), 0) };
  const { lines, code } = report(counts, gone);
  for (const line of lines) console.log(line);
  process.exit(code);
} catch (e) {
  // An error not made here (a JSON parse error quotes what it read) is not printed if it looks like a name, an ARN or an id.
  const message = (e as Error).message;
  try { assertNoSecrets([message]); console.error(message); } catch { console.error("数えられませんでした（詳細は伏せた）"); }
  process.exit(2);
}
