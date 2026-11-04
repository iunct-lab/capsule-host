// The operator checks, by reading only, that a deployed stack still has what aws/template.yaml (and aws/edge-logs.yaml) wrote:
// `aws/config-check.ts` reads the distribution's config, the log groups' retention and, when asked, the stack's budget, and prints
// these lines. The expected values are kept here, not parsed out of the template (its intrinsic functions would need a YAML layer
// of their own); src/aws-config-check.test.ts holds them to the template's text. A line never carries an id, an ARN, a URL or an
// account id, so the output can be pasted into an issue.
import { assertNoSecrets } from "./aws-remnants";

export const EXPECTED = {
  api: { pathPattern: "/v1/*", cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", viewerProtocolPolicy: "https-only", originProtocolPolicy: "https-only" },
  assets: { cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", viewerProtocolPolicy: "redirect-to-https", functionEvent: "viewer-request" },
  retentionInDays: 90,
  budget: { type: "COST", timeUnit: "MONTHLY", notifications: ["ACTUAL GREATER_THAN 80 PERCENTAGE", "FORECASTED GREATER_THAN 100 PERCENTAGE"] },
} as const;

export type Check = { item: string; ok: boolean; detail: string };

// The parts of `aws cloudfront get-distribution-config`'s DistributionConfig that are compared.
type Behavior = { PathPattern?: string; TargetOriginId: string; ViewerProtocolPolicy: string; CachePolicyId?: string; FunctionAssociations?: { Items?: Array<{ EventType: string }> } };
type Origin = { Id: string; OriginAccessControlId?: string; CustomOriginConfig?: { OriginProtocolPolicy: string } };
export type DistributionConfig = { Origins: { Items: Origin[] }; DefaultCacheBehavior: Behavior; CacheBehaviors?: { Items?: Behavior[] } };

const is = (item: string, actual: string | undefined, expected: string): Check =>
  ({ item, ok: actual === expected, detail: actual === expected ? expected : `${actual ?? "なし"}（template は ${expected}）` });
const has = (item: string, present: boolean): Check => ({ item, ok: present, detail: present ? "あり" : "なし（template はあり）" });

// A cache policy id is AWS's managed one (the same in every account), so it is printed; the OAC's and the function's ids are not.
export function compareDistribution(config: DistributionConfig): Check[] {
  const origin = (id: string) => config.Origins.Items.find(o => o.Id === id);
  const api = config.CacheBehaviors?.Items?.find(b => b.PathPattern === EXPECTED.api.pathPattern);
  const checks: Check[] = [];
  if (!api) checks.push({ item: "/v1/* behavior", ok: false, detail: "なし（template はあり）" });
  else {
    const o = origin(api.TargetOriginId);
    checks.push(
      is("/v1/* キャッシュポリシー", api.CachePolicyId, EXPECTED.api.cachePolicyId),
      is("/v1/* ViewerProtocolPolicy", api.ViewerProtocolPolicy, EXPECTED.api.viewerProtocolPolicy),
      has("/v1/* Origin の OAC", !!o?.OriginAccessControlId),
      is("/v1/* Origin のプロトコル", o?.CustomOriginConfig?.OriginProtocolPolicy, EXPECTED.api.originProtocolPolicy),
    );
  }
  const d = config.DefaultCacheBehavior;
  checks.push(
    is("静的 キャッシュポリシー", d.CachePolicyId, EXPECTED.assets.cachePolicyId),
    is("静的 ViewerProtocolPolicy", d.ViewerProtocolPolicy, EXPECTED.assets.viewerProtocolPolicy),
    has("静的 Origin の OAC", !!origin(d.TargetOriginId)?.OriginAccessControlId),
    has(`静的 ${EXPECTED.assets.functionEvent} の関数`, !!d.FunctionAssociations?.Items?.some(f => f.EventType === EXPECTED.assets.functionEvent)),
  );
  return checks;
}

// `names` maps a label (the template's logical id) to the group the stack should have; a group missing from `groups`
// (describe-log-groups' logGroups) fails. A group with no retentionInDays keeps its logs forever. The label is printed, not the
// name: the Host's group is named after its function's physical name.
export function compareRetention(groups: Array<{ logGroupName: string; retentionInDays?: number }>, names: Record<string, string>): Check[] {
  return Object.entries(names).map(([label, name]) => {
    const g = groups.find(g => g.logGroupName === name);
    const item = `ログ ${label} の保持`;
    if (!g) return { item, ok: false, detail: "ロググループなし（template はあり）" };
    const days = g.retentionInDays;
    return { item, ok: days === EXPECTED.retentionInDays, detail: days === EXPECTED.retentionInDays ? `${days} 日` : `${days ? `${days} 日` : "無期限"}（template は ${EXPECTED.retentionInDays} 日）` };
  });
}

// The stack's Budget (aws/template.yaml's, made only when BudgetLimitUsd and BudgetEmail are given). null = the stack has none: the
// caller asked for it (`--budget`), so that fails as 「未設定」. `limitUsd` is the stack's BudgetLimitUsd parameter.
export type Budget = { BudgetType: string; TimeUnit: string; BudgetLimit?: { Amount: string; Unit: string } };
export type Notification = { NotificationType: string; ComparisonOperator: string; Threshold: number; ThresholdType?: string };
export function compareBudget(budget: { budget: Budget; notifications: Notification[] } | null, limitUsd?: string): Check[] {
  if (!budget) return [{ item: "予算", ok: false, detail: "未設定" }];
  const { budget: b, notifications } = budget;
  const amount = b.BudgetLimit ? `${Number(b.BudgetLimit.Amount)} ${b.BudgetLimit.Unit}` : undefined;
  const got = notifications.map(n => `${n.NotificationType} ${n.ComparisonOperator} ${n.Threshold} ${n.ThresholdType ?? "PERCENTAGE"}`).sort();
  const want = [...EXPECTED.budget.notifications].sort();
  return [
    is("予算 種類", b.BudgetType, EXPECTED.budget.type),
    is("予算 期間", b.TimeUnit, EXPECTED.budget.timeUnit),
    ...(limitUsd === undefined ? [] : [is("予算 上限", amount, `${Number(limitUsd)} USD`)]),
    { item: "予算 通知", ok: got.join() === want.join(), detail: got.join() === want.join() ? want.join(" / ") : `${got.join(" / ") || "なし"}（template は ${want.join(" / ")}）` },
  ];
}

// One line per check, then the verdict. Exit 0 = all pass, 1 = something differs.
export function report(checks: Check[], notes: string[] = []): { lines: string[]; code: 0 | 1 } {
  const failed = checks.filter(c => !c.ok).length;
  const lines = [...checks.map(c => `${c.ok ? "pass" : "fail"} ${c.item}: ${c.detail}`), ...notes, failed ? `差あり（${failed} 件）` : "差なし"];
  assertNoSecrets(lines);
  return { lines, code: failed ? 1 : 0 };
}
