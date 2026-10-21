import { Database } from "bun:sqlite";
import { cloudSchema } from "./cloud-schema";
import type { D1, Statement } from "./cloud-store";

// bun:sqlite behind D1's asynchronous shape: local development and the tests run CloudHost on the same statements as production.
export class LocalD1 implements D1 {
  db: Database;
  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON");
    cloudSchema.forEach(sql => this.db.exec(sql));
  }
  prepare(sql: string): Statement {
    let values: any[] = [];
    return { bind(...v) { values = v; return this; }, first: async <T>() => this.db.query(sql).get(...values) as T | null, run: async () => ({ meta: { changes: this.db.query(sql).run(...values).changes } }) };
  }
  close() { this.db.close(); }
}
