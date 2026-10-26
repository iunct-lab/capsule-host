import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactGetCommand, TransactWriteCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { CapsuleStore, CloudRow } from "./cloud-store";

// Fixed binary chunks keep each item below DynamoDB's 400 KiB limit. The metadata
// and all chunks are read/written transactionally, including revocation and purge.
export const CHUNK_BYTES = 128 * 1024, CHUNKS = 16;
export function splitPayload(payload: string) {
  const bytes = Buffer.from(payload);
  if (bytes.length > 1_900_000) throw new Error("Capsule too large");
  return Array.from({ length: Math.ceil(bytes.length / CHUNK_BYTES) }, (_, i) => bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
}
export class AwsStore implements CapsuleStore {
  constructor(public table: string, public db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })) {}
  key(pk: string, sk = "meta") { return { pk, sk }; }
  async get(key: string): Promise<CloudRow | null> {
    const result = await this.db.send(new TransactGetCommand({ TransactItems: ["meta", ...Array.from({ length: CHUNKS }, (_, i) => `chunk:${i}`)].map(sk => ({ Get: { TableName: this.table, Key: this.key(key, sk) } })) }));
    const meta = result.Responses?.[0]?.Item;
    if (!meta) return null;
    const payload = meta.purged_at == null ? Buffer.concat((result.Responses ?? []).slice(1).flatMap(r => r.Item ? [Buffer.from(r.Item.bytes)] : [])).toString() : null;
    return { key, payload, version: meta.version, purge_at: meta.purge_at, purged_at: meta.purged_at ?? null, owner_key: meta.owner_key ?? null };
  }
  async write(row: CloudRow, payload: string | null, expires: number, now: number, create: boolean) {
    const pieces = payload === null ? [] : splitPayload(payload);
    const meta = { ...this.key(row.key), version: row.version + 1, purge_at: expires, purged_at: payload === null ? now : undefined, owner_key: payload === null ? undefined : row.owner_key, expiry_kind: payload === null ? undefined : "active", ttl: payload === null ? Math.floor(now / 1000) + 30 * 86400 : undefined };
    const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [{ Put: { TableName: this.table, Item: meta, ConditionExpression: create ? "attribute_not_exists(pk)" : "#v = :v AND attribute_not_exists(purged_at) AND purge_at > :now", ...(create ? {} : { ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": row.version, ":now": now } }) } }];
    for (let i = 0; i < CHUNKS; i++) items.push(pieces[i] ? { Put: { TableName: this.table, Item: { ...this.key(row.key, `chunk:${i}`), bytes: pieces[i] } } } : { Delete: { TableName: this.table, Key: this.key(row.key, `chunk:${i}`) } });
    if (create) items.push({ Update: { TableName: this.table, Key: this.key(`owner:${row.owner_key}`), UpdateExpression: "ADD #n :one", ConditionExpression: "attribute_not_exists(#n) OR #n < :max", ExpressionAttributeNames: { "#n": "count" }, ExpressionAttributeValues: { ":one": 1, ":max": 10 } } });
    if (!create && payload === null) items.push({ Update: { TableName: this.table, Key: this.key(`owner:${row.owner_key}`), UpdateExpression: "ADD #n :minus", ExpressionAttributeNames: { "#n": "count" }, ExpressionAttributeValues: { ":minus": -1 } } });
    // Scheduled expiry also uses version CAS, but allows the expired row.
    if (!create && payload === null) items[0] = { Put: { ...items[0]!.Put!, ConditionExpression: "#v = :v AND attribute_not_exists(purged_at)", ExpressionAttributeValues: { ":v": row.version } } };
    try { await this.db.send(new TransactWriteCommand({ TransactItems: items })); return true; }
    catch (e) { if (e instanceof Error && e.name === "TransactionCanceledException" && (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.some(r => r.Code === "ConditionalCheckFailed" || r.Code === "TransactionConflict")) return false; throw e; }
  }
  async create(key: string, payload: string, expires: number, owner: string, now: number) {
    const ok = await this.write({ key, payload: null, version: 0, purge_at: expires, purged_at: null, owner_key: owner }, payload, expires, now, true);
    return { meta: { changes: ok ? 1 : 0 } };
  }
  save(row: CloudRow, payload: string | null, expires: number, now: number) { return this.write(row, payload, expires, now, false); }
  async sweep(now: number, erase?: (key: string) => Promise<void>) {
    let cursor: Record<string, any> | undefined;
    do {
      const batch = await this.db.send(new QueryCommand({ TableName: this.table, IndexName: "expiry", KeyConditionExpression: "expiry_kind = :active AND purge_at <= :now", ExpressionAttributeValues: { ":active": "active", ":now": now }, Limit: 25, ExclusiveStartKey: cursor }));
      for (const item of batch.Items ?? []) {
        const row = await this.get(item.pk);
        if (!row?.payload || row.purge_at > now) continue;
        if (erase) try { await erase(row.key); } catch { continue; }
        await this.save(row, null, row.purge_at, now);
      }
      cursor = batch.LastEvaluatedKey;
    } while (cursor);
  }
  // The index holds only rows with a payload (`expiry_kind` goes with it), keys only.
  async list(now: number) {
    const keys: string[] = [];
    let cursor: Record<string, any> | undefined;
    do {
      const batch = await this.db.send(new QueryCommand({ TableName: this.table, IndexName: "expiry", KeyConditionExpression: "expiry_kind = :active AND purge_at > :now", ExpressionAttributeValues: { ":active": "active", ":now": now }, ExclusiveStartKey: cursor }));
      keys.push(...(batch.Items ?? []).map(item => item.pk as string));
      cursor = batch.LastEvaluatedKey;
    } while (cursor);
    return keys;
  }
  async rate(key: string, limit: number, now: number) {
    try {
      await this.db.send(new UpdateCommand({ TableName: this.table, Key: this.key(`rate:${key}:${Math.floor(now / 60000)}`), UpdateExpression: "SET #ttl = :ttl ADD #n :one", ConditionExpression: "attribute_not_exists(#n) OR #n < :max", ExpressionAttributeNames: { "#n": "count", "#ttl": "ttl" }, ExpressionAttributeValues: { ":ttl": Math.floor(now / 1000) + 120, ":one": 1, ":max": limit } })); return true;
    } catch (e) { if (e instanceof Error && e.name === "ConditionalCheckFailedException") return false; throw e; }
  }
}
