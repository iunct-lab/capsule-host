import { test, expect } from "bun:test";
import { assertNoSecrets, report, resourcesOf, type StackResource } from "./aws-remnants";

const listed: StackResource[] = [
  { LogicalResourceId: "Host", PhysicalResourceId: "capsule-host-dev-Host-AbC", ResourceType: "AWS::Lambda::Function" },
  { LogicalResourceId: "Data", PhysicalResourceId: "capsule-host-dev-Data-1XYZ", ResourceType: "AWS::DynamoDB::Table" },
  { LogicalResourceId: "Assets", PhysicalResourceId: "capsule-host-dev-assets-q1w2e3", ResourceType: "AWS::S3::Bucket" },
  { LogicalResourceId: "Media", PhysicalResourceId: "capsule-host-dev-media-r4t5y6", ResourceType: "AWS::S3::Bucket" },
];

test("resourcesOf finds the table and both buckets", () => {
  expect(resourcesOf(listed)).toEqual({ table: "capsule-host-dev-Data-1XYZ", assets: "capsule-host-dev-assets-q1w2e3", media: "capsule-host-dev-media-r4t5y6" });
});

test("resourcesOf throws when Media is not in the stack, naming no physical name", () => {
  let message = "";
  try { resourcesOf(listed.filter(r => r.LogicalResourceId !== "Media")); } catch (e) { message = (e as Error).message; }
  expect(message).toBe("Media がスタックに無い");
  for (const r of listed) expect(message).not.toContain(r.PhysicalResourceId!);
});

test("nothing left exits 0", () => {
  expect(report({ data: 0, tripRows: 0, media: 0, assets: 0 })).toEqual({ lines: ["Data: 0", "  うち旅程の本体の行: 0", "Media: 0", "Assets: 0", "残りなし"], code: 0 });
});

test("anything left exits 1", () => {
  expect(report({ data: 1, tripRows: 1, media: 0, assets: 0 })).toEqual({ lines: ["Data: 1", "  うち旅程の本体の行: 1", "Media: 0", "Assets: 0", "残りあり"], code: 1 });
  expect(report({ data: 0, tripRows: 0, media: 1, assets: 0 }).code).toBe(1);
  expect(report({ data: 0, tripRows: 0, media: 0, assets: 1 }).code).toBe(1);
});

test("rows without a trip in them still count as left: the table is there to be deleted", () => {
  expect(report({ data: 289, tripRows: 0, media: 0, assets: 0 })).toEqual({ lines: ["Data: 289", "  うち旅程の本体の行: 0", "Media: 0", "Assets: 0", "残りあり"], code: 1 });
});

test("a resource already deleted counts as 0 and says so", () => {
  expect(report({ data: 0, tripRows: 0, media: 0, assets: 0 }, ["media", "data"])).toEqual({ lines: ["Data: 0（table なし）", "  うち旅程の本体の行: 0", "Media: 0（bucket なし）", "Assets: 0", "残りなし"], code: 0 });
});

test("assertNoSecrets refuses an account id, an ARN, a URL, a #k= or an API key", () => {
  for (const bad of ["Data: 123456789012", "arn:aws:s3:::capsule-host-dev-media-x", "https://d111.cloudfront.net", "http://localhost:47840", "#k=AAAA", "sk-ant-api03-x"]) {
    expect(() => assertNoSecrets(["Data: 0", bad])).toThrow("出力に秘密の形の値があります");
  }
});

test("report checks its own lines", () => {
  expect(() => report({ data: 123456789012, tripRows: 0, media: 0, assets: 0 })).toThrow("出力に秘密の形の値があります");
});

test("report's own lines pass the check", () => {
  expect(() => assertNoSecrets(report({ data: 123, tripRows: 12, media: 45, assets: 6789 }, ["media"]).lines)).not.toThrow();
});
