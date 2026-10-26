// D1 operations are prepared statements. A whole capsule is atomically updated by version CAS,
// so link revocation and edits cannot race across Worker instances.
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1 { prepare(sql: string): Statement }
export type CloudRow = { key: string; payload: string | null; version: number; purge_at: number; purged_at: number | null; owner_key: string | null };
export interface CapsuleStore {
  get(key: string): Promise<CloudRow | null>;
  create(key: string, payload: string, expires: number, owner: string, now: number): Promise<{ meta: { changes?: number } }>;
  save(row: CloudRow, payload: string | null, expires: number, now: number): Promise<boolean>;
  // `erase` is told each expired capsule's key before its row is emptied; a row it throws for is left for the next sweep.
  sweep(now: number, erase?: (key: string) => Promise<void>): Promise<void>;
  // The keys of every row still holding a payload before its deadline: the capsules, and the creators' registry.
  list(now: number): Promise<string[]>;
  rate(key: string, limit: number, now: number): Promise<boolean>;
}
export class CloudStore implements CapsuleStore {
  constructor(public db: D1) {}
  get(key: string) { return this.db.prepare("SELECT * FROM trip_capsules WHERE key=?").bind(key).first<CloudRow>(); }
  async create(key: string, payload: string, expires: number, owner: string, now: number) {
    // The INSERT enforces the per-owner storage quota atomically across Worker instances. DO NOTHING on the key makes a
    // replayed operation id report changes: 0 the way AwsStore's attribute_not_exists does, instead of throwing — and
    // only for that conflict, so a real constraint failure is still an error rather than a silent "quota full".
    return this.db.prepare("INSERT INTO trip_capsules(key,payload,version,purge_at,owner_key) SELECT ?,?,1,?,? WHERE (SELECT count(*) FROM trip_capsules WHERE owner_key=? AND payload IS NOT NULL AND purge_at>?)<10 ON CONFLICT(key) DO NOTHING").bind(key, payload, expires, owner, owner, now).run();
  }
  async save(row: CloudRow, payload: string | null, expires: number, now: number) {
    const result = await this.db.prepare("UPDATE trip_capsules SET payload=?,version=version+1,purge_at=?,purged_at=?,owner_key=? WHERE key=? AND version=? AND payload IS NOT NULL AND purge_at>?").bind(payload, expires, payload === null ? now : null, payload === null ? null : row.owner_key, row.key, row.version, now).run();
    return result.meta.changes === 1;
  }
  // One row back, so the D1 shape needs no statement that returns many.
  async list(now: number) {
    const row = await this.db.prepare("SELECT json_group_array(key) AS keys FROM trip_capsules WHERE payload IS NOT NULL AND purge_at>?").bind(now).first<{ keys: string }>();
    return JSON.parse(row?.keys ?? "[]") as string[];
  }
  async sweep(now: number, erase?: (key: string) => Promise<void>) {
    const purge = (where: string, ...keys: string[]) => this.db.prepare(`UPDATE trip_capsules SET payload=NULL,version=version+1,purged_at=?,owner_key=NULL WHERE payload IS NOT NULL AND purge_at<=?${where}`).bind(now, now, ...keys).run();
    if (!erase) await purge("");
    else {
      const due = await this.db.prepare("SELECT json_group_array(key) AS keys FROM trip_capsules WHERE payload IS NOT NULL AND purge_at<=?").bind(now).first<{ keys: string }>();
      for (const key of JSON.parse(due?.keys ?? "[]") as string[]) { try { await erase(key); } catch { continue; } await purge(" AND key=?", key); }
    }
    await this.db.prepare("DELETE FROM trip_capsules WHERE payload IS NULL AND purged_at<?").bind(now - 30 * 86400000).run();
    await this.db.prepare("DELETE FROM trip_rate_limits WHERE expires<?").bind(now).run();
  }
  async rate(key: string, limit: number, now: number) {
    const bucket = Math.floor(now / 60000), expires = (bucket + 2) * 60000;
    const result = await this.db.prepare("INSERT INTO trip_rate_limits(key,bucket,count,expires) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END,bucket=excluded.bucket,expires=excluded.expires RETURNING count").bind(key, bucket, expires).first<{ count: number }>();
    return (result?.count ?? limit + 1) <= limit;
  }
}
