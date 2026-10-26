import { test, expect } from "bun:test";
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { S3MediaStore } from "./aws-media";

const prefix = "a".repeat(64), name = "1".repeat(32) + ".display";
const store = (send: (command: { input: any; constructor: { name: string } }) => unknown) => new S3MediaStore("bucket", { send: async (c: any) => send(c) } as unknown as S3Client);

test("removeAll lists every page under the prefix and deletes in batches", async () => {
  const sent: Array<{ name: string; input: any }> = [];
  const keys = Array.from({ length: 2500 }, (_, i) => `${prefix}/${String(i).padStart(32, "0")}.thumb`);
  const pages = [{ Contents: keys.slice(0, 1200).map(Key => ({ Key })), IsTruncated: true, NextContinuationToken: "t1" }, { Contents: keys.slice(1200).map(Key => ({ Key })), IsTruncated: false }];
  await store(c => { sent.push({ name: c.constructor.name, input: c.input }); return c instanceof ListObjectsV2Command ? pages[sent.filter(s => s.name === "ListObjectsV2Command").length - 1] : {}; }).removeAll(prefix);
  const lists = sent.filter(s => s.name === "ListObjectsV2Command"), deletes = sent.filter(s => s.name === "DeleteObjectsCommand");
  expect(lists.map(l => [l.input.Prefix, l.input.ContinuationToken])).toEqual([[`${prefix}/`, undefined], [`${prefix}/`, "t1"]]);
  // Each page goes in batches of at most 1000; every key is deleted once and none outside the prefix.
  expect(deletes.map(d => d.input.Delete.Objects.length)).toEqual([1000, 200, 1000, 300]);
  expect(deletes.flatMap(d => d.input.Delete.Objects.map((o: { Key: string }) => o.Key))).toEqual(keys);
  expect(deletes.every(d => d.input.Bucket === "bucket")).toBe(true);
});
test("removeAll of a prefix with nothing under it deletes nothing, and a failed delete is an error", async () => {
  const sent: string[] = [];
  await store(c => { sent.push(c.constructor.name); return {}; }).removeAll(prefix);
  expect(sent).toEqual(["ListObjectsV2Command"]);
  await expect(store(c => c instanceof DeleteObjectsCommand ? { Errors: [{ Key: "k", Code: "AccessDenied" }] } : { Contents: [{ Key: `${prefix}/x` }] }).removeAll(prefix)).rejects.toThrow("消せませんでした");
});
test("put keeps the bytes under <prefix>/<name> as an opaque object; get returns them, and null for a missing object", async () => {
  const sent: Array<{ name: string; input: any }> = [];
  await store(c => { sent.push({ name: c.constructor.name, input: c.input }); return {}; }).put(prefix, name, new Uint8Array([1, 2, 3]));
  expect(sent[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "bucket", Key: `${prefix}/${name}`, ContentType: "application/octet-stream" } });
  expect(sent[0]!.input.Body).toEqual(new Uint8Array([1, 2, 3]));
  expect(await store(() => ({ Body: { transformToByteArray: async () => new Uint8Array([4, 5]) } })).get(prefix, name)).toEqual(new Uint8Array([4, 5]));
  expect(await store(() => { throw Object.assign(new Error("gone"), { name: "NoSuchKey" }); }).get(prefix, name)).toBeNull();
  await expect(store(() => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); }).get(prefix, name)).rejects.toThrow("denied");
});
test("remove deletes the one object", async () => {
  const sent: Array<{ name: string; input: any }> = [];
  await store(c => { sent.push({ name: c.constructor.name, input: c.input }); return {}; }).remove(prefix, name);
  expect(sent).toEqual([{ name: "DeleteObjectCommand", input: { Bucket: "bucket", Key: `${prefix}/${name}` } }]);
});
