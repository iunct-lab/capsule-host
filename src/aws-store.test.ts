import { test, expect } from "bun:test";
import { AwsStore, CHUNK_BYTES, splitPayload } from "./aws-store";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

test("multi-byte private document survives chunk boundaries below DynamoDB item size", () => {
  const payload = JSON.stringify({ notes: "旅の記録🧳".repeat(80000) });
  const chunks = splitPayload(payload);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(c => c.length <= CHUNK_BYTES)).toBe(true);
  expect(Buffer.concat(chunks).toString()).toBe(payload);
  expect(() => splitPayload("x".repeat(1_900_001))).toThrow();
});
test("conditional write conflicts return false; operational errors are not hidden", async () => {
  const row = { key: "trip", payload: "{}", version: 1, purge_at: 500, purged_at: null, owner_key: "publisher" };
  const conflict = Object.assign(new Error("conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
  let error: Error = conflict;
  const store = new AwsStore("table", { send: async () => { throw error; } } as unknown as DynamoDBDocumentClient);
  expect(await store.save(row, "{}", 500, 100)).toBe(false);
  // A replayed operation id reaches create with a key that already exists: that is changes: 0, not an exception.
  expect(await store.create("trip", "{}", 500, "publisher", 100)).toEqual({ meta: { changes: 0 } });
  error = Object.assign(new Error("access denied"), { name: "AccessDeniedException" });
  expect(store.save(row, "{}", 500, 100)).rejects.toThrow("access denied");
});
test("list reads the live keys off the expiry index, page after page", async () => {
  const sent: any[] = [];
  const pages = [{ Items: [{ pk: "a" }, { pk: "b" }], LastEvaluatedKey: { pk: "b" } }, { Items: [{ pk: "c" }] }];
  const store = new AwsStore("table", { send: async (command: { input: unknown }) => { sent.push(command.input); return pages[sent.length - 1]; } } as unknown as DynamoDBDocumentClient);
  expect(await store.list(100)).toEqual(["a", "b", "c"]);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({ TableName: "table", IndexName: "expiry", KeyConditionExpression: "expiry_kind = :active AND purge_at > :now", ExpressionAttributeValues: { ":active": "active", ":now": 100 } });
  expect(sent[1].ExclusiveStartKey).toEqual({ pk: "b" });
});
test("sweep erases the media before the payload and retries when that fails", async () => {
  const log: string[] = [];
  const store = new AwsStore("table", { send: async () => ({ Items: [{ pk: "a" }, { pk: "b" }, { pk: "c" }] }) } as unknown as DynamoDBDocumentClient);
  store.get = async key => ({ key, payload: key === "c" ? null : "{}", version: 1, purge_at: 50, purged_at: null, owner_key: "o" });
  store.save = async row => { log.push(`save ${row.key}`); return true; };
  // The one whose photos cannot be removed keeps its payload for the next sweep; the others go on.
  await store.sweep(100, async key => { log.push(`erase ${key}`); if (key === "a") throw new Error("down"); });
  expect(log).toEqual(["erase a", "erase b", "save b"]);
  log.length = 0;
  await store.sweep(100, async key => { log.push(`erase ${key}`); });
  expect(log).toEqual(["erase a", "save a", "erase b", "save b"]);
  // Without a place for photos the rows are emptied as before.
  log.length = 0; await store.sweep(100);
  expect(log).toEqual(["save a", "save b"]);
});
