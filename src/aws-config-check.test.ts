import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { EXPECTED, compareBudget, compareDistribution, compareRetention, report, type DistributionConfig } from "./aws-config-check";

// The shape aws/template.yaml's Cdn deploys to, as get-distribution-config returns it (ids made up).
const deployed = (): DistributionConfig => ({
  Origins: { Items: [
    { Id: "assets", OriginAccessControlId: "E1ASSETS" },
    { Id: "api", OriginAccessControlId: "E2WEB", CustomOriginConfig: { OriginProtocolPolicy: "https-only" } },
  ] },
  DefaultCacheBehavior: { TargetOriginId: "assets", ViewerProtocolPolicy: "redirect-to-https", CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", FunctionAssociations: { Items: [{ EventType: "viewer-request" }] } },
  CacheBehaviors: { Items: [{ PathPattern: "/v1/*", TargetOriginId: "api", ViewerProtocolPolicy: "https-only", CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" }] },
});
const failed = (checks: { item: string; ok: boolean }[]) => checks.filter(c => !c.ok).map(c => c.item);

test("a distribution as the template wrote it has no difference", () => {
  const checks = compareDistribution(deployed());
  expect(failed(checks)).toEqual([]);
  expect(checks).toHaveLength(8);
  expect(report(checks).code).toBe(0);
});

test("each part of the distribution that differs is named, one at a time", () => {
  const cases: Array<[string, (c: DistributionConfig) => void]> = [
    ["/v1/* キャッシュポリシー", c => { c.CacheBehaviors!.Items![0]!.CachePolicyId = "658327ea-f89d-4fab-a63d-7e88639e58f6"; }],
    ["/v1/* ViewerProtocolPolicy", c => { c.CacheBehaviors!.Items![0]!.ViewerProtocolPolicy = "allow-all"; }],
    ["/v1/* Origin の OAC", c => { delete c.Origins.Items[1]!.OriginAccessControlId; }],
    ["/v1/* Origin のプロトコル", c => { c.Origins.Items[1]!.CustomOriginConfig!.OriginProtocolPolicy = "match-viewer"; }],
    ["静的 キャッシュポリシー", c => { c.DefaultCacheBehavior.CachePolicyId = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"; }],
    ["静的 ViewerProtocolPolicy", c => { c.DefaultCacheBehavior.ViewerProtocolPolicy = "allow-all"; }],
    ["静的 Origin の OAC", c => { c.Origins.Items[0]!.OriginAccessControlId = ""; }],
    ["静的 viewer-request の関数", c => { c.DefaultCacheBehavior.FunctionAssociations = { Items: [] }; }],
  ];
  for (const [item, change] of cases) {
    const c = deployed();
    change(c);
    expect(failed(compareDistribution(c))).toEqual([item]);
  }
});

test("a distribution without the /v1/* behavior fails on that line", () => {
  const c = deployed();
  c.CacheBehaviors = { Items: [] };
  expect(failed(compareDistribution(c))).toEqual(["/v1/* behavior"]);
});

test("a difference says what was found and what the template wrote, and exits 1", () => {
  const c = deployed();
  c.CacheBehaviors!.Items![0]!.ViewerProtocolPolicy = "allow-all";
  const { lines, code } = report(compareDistribution(c));
  expect(lines).toContain("fail /v1/* ViewerProtocolPolicy: allow-all（template は https-only）");
  expect(lines.at(-1)).toBe("差あり（1 件）");
  expect(code).toBe(1);
});

test("log groups are held to 90 days, a missing or unlimited one fails, and only the label is printed", () => {
  const names = { "Logs": "/aws/lambda/capsule-host-dev-Host-AbC", "WebLogs": "/capsule-host/capsule-host-dev/web", "cdn": "/capsule-host/capsule-host-dev/cdn" };
  const groups = [
    { logGroupName: "/aws/lambda/capsule-host-dev-Host-AbC", retentionInDays: 90 },
    { logGroupName: "/capsule-host/capsule-host-dev/web" },
  ];
  expect(compareRetention(groups, names)).toEqual([
    { item: "ログ Logs の保持", ok: true, detail: "90 日" },
    { item: "ログ WebLogs の保持", ok: false, detail: "無期限（template は 90 日）" },
    { item: "ログ cdn の保持", ok: false, detail: "ロググループなし（template はあり）" },
  ]);
  expect(compareRetention([{ logGroupName: "/capsule-host/capsule-host-dev/cdn", retentionInDays: 30 }], { cdn: "/capsule-host/capsule-host-dev/cdn" })[0]!.detail).toBe("30 日（template は 90 日）");
  expect(report(compareRetention(groups, names)).lines.join("\n")).not.toContain("Host-AbC");
});

const notifications = [
  { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 80, ThresholdType: "PERCENTAGE" },
  { NotificationType: "FORECASTED", ComparisonOperator: "GREATER_THAN", Threshold: 100, ThresholdType: "PERCENTAGE" },
];
const budget = { BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "20.0", Unit: "USD" } };

test("a budget as the template wrote it has no difference", () => {
  expect(failed(compareBudget({ budget, notifications }, "20"))).toEqual([]);
});

test("no budget is 「未設定」", () => {
  expect(compareBudget(null)).toEqual([{ item: "予算", ok: false, detail: "未設定" }]);
});

test("a budget that differs in limit, period or notifications is named", () => {
  expect(failed(compareBudget({ budget, notifications }, "10"))).toEqual(["予算 上限"]);
  expect(failed(compareBudget({ budget: { ...budget, TimeUnit: "ANNUALLY" }, notifications }, "20"))).toEqual(["予算 期間"]);
  expect(failed(compareBudget({ budget, notifications: notifications.slice(1) }, "20"))).toEqual(["予算 通知"]);
});

test("the expected values are the ones aws/template.yaml and aws/edge-logs.yaml write", () => {
  const template = readFileSync(new URL("../aws/template.yaml", import.meta.url), "utf8");
  const edge = readFileSync(new URL("../aws/edge-logs.yaml", import.meta.url), "utf8");
  // The /v1/* behavior's lines, then the default behavior's.
  const apiAt = template.indexOf(`- PathPattern: '${EXPECTED.api.pathPattern}'`);
  const apiEnd = template.indexOf("OriginRequestPolicyId:", apiAt);
  expect(apiEnd).toBeGreaterThan(apiAt);
  const api = template.slice(apiAt, apiEnd);
  expect(api).toContain(`ViewerProtocolPolicy: ${EXPECTED.api.viewerProtocolPolicy}`);
  expect(api).toContain(`CachePolicyId: ${EXPECTED.api.cachePolicyId}`);
  const assets = template.slice(template.indexOf("DefaultCacheBehavior:"), template.indexOf("CacheBehaviors:"));
  expect(assets).toContain(`ViewerProtocolPolicy: ${EXPECTED.assets.viewerProtocolPolicy}`);
  expect(assets).toContain(`CachePolicyId: ${EXPECTED.assets.cachePolicyId}`);
  expect(assets).toContain(`EventType: ${EXPECTED.assets.functionEvent}`);
  expect(template).toContain(`OriginProtocolPolicy: ${EXPECTED.api.originProtocolPolicy}`);
  expect(template.match(/OriginAccessControlId: !Ref \w+/g)).toEqual(["OriginAccessControlId: !Ref Access", "OriginAccessControlId: !Ref WebAccess"]);
  // Logs, WebLogs and WebLogsLocal; and cdn.
  expect(template.match(new RegExp(`RetentionInDays: ${EXPECTED.retentionInDays}\\b`, "g"))).toHaveLength(3);
  expect(template.match(/RetentionInDays: \d+/g)).toHaveLength(3);
  expect(edge).toContain(`RetentionInDays: ${EXPECTED.retentionInDays}\n`);
  expect(template).toContain(`BudgetType: ${EXPECTED.budget.type}`);
  expect(template).toContain(`TimeUnit: ${EXPECTED.budget.timeUnit}`);
  expect(template).toContain("NotificationType: ACTUAL, ComparisonOperator: GREATER_THAN, Threshold: 80, ThresholdType: PERCENTAGE");
  expect(template).toContain("NotificationType: FORECASTED, ComparisonOperator: GREATER_THAN, Threshold: 100, ThresholdType: PERCENTAGE");
});
