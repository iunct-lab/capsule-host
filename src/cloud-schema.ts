// Provider-neutral SQL for the D1 deployment adapter; migrations must use these statements separately. Every kind of capsule
// (src/kits.ts) is kept in the one table, whose name is the trip's, the first kind, for the rows already stored.
export const cloudSchema = [
  "CREATE TABLE IF NOT EXISTS trip_capsules(key TEXT PRIMARY KEY,payload TEXT,version INTEGER NOT NULL,purge_at INTEGER NOT NULL,purged_at INTEGER,owner_key TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_trip_capsules_owner ON trip_capsules(owner_key)",
  "CREATE INDEX IF NOT EXISTS idx_trip_capsules_purge ON trip_capsules(purge_at) WHERE payload IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS trip_rate_limits(key TEXT PRIMARY KEY,bucket INTEGER NOT NULL,count INTEGER NOT NULL,expires INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_trip_rate_expiry ON trip_rate_limits(expires)",
  "CREATE TABLE IF NOT EXISTS creator_keys(subject TEXT PRIMARY KEY,sealed TEXT NOT NULL,updated INTEGER NOT NULL)",
];
