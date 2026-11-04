import { compareBudget, compareDistribution, compareRetention, report, type Budget, type Check, type DistributionConfig, type Notification } from "../src/aws-config-check";
import { assertNoSecrets } from "../src/aws-remnants";

// Reads a deployed stack and compares it with what aws/template.yaml and aws/edge-logs.yaml wrote: the distribution's two behaviors,
// the log groups' retention and, with --budget, the stack's budget. Read only (describe-* / get-*): nothing is changed.
// Prints no id, ARN, URL or account id. Exit 0 = no difference, 1 = a difference (or wrong arguments), 2 = could not read.
const args = process.argv.slice(2);
const budgetToo = args.includes("--budget");
const [stack, profile, region = "ap-northeast-1"] = args.filter(a => a !== "--budget");
if (!stack || !profile) {
  console.error("Usage: bun aws/config-check.ts STACK PROFILE [REGION] [--budget]");
  process.exit(1);
}

// As aws/remnants.ts's cli: the CLI's stderr names ARNs (the account id), so a failure says only which call failed.
async function cli(at: string, ...rest: string[]) {
  const proc = Bun.spawn(["aws", ...rest, "--profile", profile!, "--region", at, "--no-cli-pager", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`aws ${rest.slice(0, 2).join(" ")} に失敗しました（終了コード ${code}。詳細はこのコマンドを手で実行して確認してください）`);
  return JSON.parse(out);
}

async function logGroups(at: string, prefix: string) {
  const groups: Array<{ logGroupName: string; retentionInDays?: number }> = [];
  let token: string | undefined;
  do {
    const page = await cli(at, "logs", "describe-log-groups", "--log-group-name-prefix", prefix, ...(token ? ["--next-token", token] : [])) as { logGroups: typeof groups; nextToken?: string };
    groups.push(...page.logGroups); token = page.nextToken;
  } while (token);
  return groups;
}

try {
  const { Stacks: [described] } = await cli(region, "cloudformation", "describe-stacks", "--stack-name", stack) as { Stacks: Array<{ Outputs?: Array<{ OutputKey: string; OutputValue: string }>; Parameters?: Array<{ ParameterKey: string; ParameterValue: string }> }> };
  const output = (key: string) => {
    const value = described?.Outputs?.find(o => o.OutputKey === key)?.OutputValue;
    if (!value) throw new Error(`スタックの出力 ${key} が無い`);
    return value;
  };
  const { DistributionConfig: config } = await cli("us-east-1", "cloudfront", "get-distribution-config", "--id", output("DistributionId")) as { DistributionConfig: DistributionConfig };
  const checks: Check[] = compareDistribution(config);

  const host = `/aws/lambda/${output("FunctionName")}`, own = `/capsule-host/${stack}/`;
  const groups = [...await logGroups(region, host), ...await logGroups(region, own), ...await logGroups("us-east-1", `${own}cdn`)];
  checks.push(...compareRetention(groups, { "Logs（Host）": host, "WebLogs": `${own}web`, "WebLogsLocal": `${own}web.local`, "cdn（us-east-1）": `${own}cdn` }));

  const notes: string[] = [];
  if (budgetToo) {
    // The stack's own Budget resource, by its physical name; a stack given no BudgetLimitUsd / BudgetEmail has none.
    const { StackResources } = await cli(region, "cloudformation", "describe-stack-resources", "--stack-name", stack) as { StackResources: Array<{ LogicalResourceId: string; PhysicalResourceId?: string }> };
    const name = StackResources.find(r => r.LogicalResourceId === "Budget")?.PhysicalResourceId;
    let found: { budget: Budget; notifications: Notification[] } | null = null;
    if (name) {
      const { Account } = await cli(region, "sts", "get-caller-identity") as { Account: string };
      const { Budget: budget } = await cli("us-east-1", "budgets", "describe-budget", "--account-id", Account, "--budget-name", name) as { Budget: Budget };
      const { Notifications } = await cli("us-east-1", "budgets", "describe-notifications-for-budget", "--account-id", Account, "--budget-name", name) as { Notifications: Notification[] };
      found = { budget, notifications: Notifications };
    }
    checks.push(...compareBudget(found, described?.Parameters?.find(p => p.ParameterKey === "BudgetLimitUsd")?.ParameterValue));
  } else notes.push("予算: 見ていない（--budget なし）");

  const { lines, code } = report(checks, notes);
  for (const line of lines) console.log(line);
  process.exit(code);
} catch (e) {
  const message = (e as Error).message;
  try { assertNoSecrets([message]); console.error(message); } catch { console.error("読み取れませんでした（詳細は伏せた）"); }
  process.exit(2);
}
