// After the Host is torn down, the operator counts what is left of the trips: `aws/remnants.ts` reads the stack's resources
// (a deleted stack's too: `Data`, `Assets` and `Media` are Retain), counts the table's items and the buckets' objects, and prints
// these lines. Counts only: never a table or bucket name, an ARN, an account id or anything of a trip. Nothing is deleted here.
export type StackResource = { LogicalResourceId: string; PhysicalResourceId?: string; ResourceType: string };
// `data` is every item in the table; `tripRows` the ones of them that hold a trip's plan (its payload's `chunk:` rows: one trip may
// span several). The rest are rows without a trip in them (a purged trip's mark, kept 30 days by TTL, and counters), which keep
// `data` above 0 until the table itself is deleted by hand.
export type Counts = { data: number; tripRows: number; media: number; assets: number };

// The physical names of the three Retain resources. A missing one is named by its logical id only: the physical names hold the
// stack name and, for the buckets, a random suffix that need not be printed.
export function resourcesOf(listed: StackResource[]): { table: string; assets: string; media: string } {
  const name = (id: string) => {
    const r = listed.find(r => r.LogicalResourceId === id);
    if (!r?.PhysicalResourceId) throw new Error(`${id} がスタックに無い`);
    return r.PhysicalResourceId;
  };
  return { table: name("Data"), assets: name("Assets"), media: name("Media") };
}

// `gone` names the resources that were already deleted by hand: the caller counts them as 0, and the line says so.
export function report(counts: Counts, gone: Array<"data" | "media" | "assets"> = []): { lines: string[]; code: 0 | 1 } {
  const line = (label: string, key: "data" | "media" | "assets") => `${label}: ${counts[key]}${gone.includes(key) ? `（${key === "data" ? "table" : "bucket"} なし）` : ""}`;
  const left = counts.data + counts.media + counts.assets > 0;
  const lines = [line("Data", "data"), `  うち旅程の本体の行: ${counts.tripRows}`, line("Media", "media"), line("Assets", "assets"), left ? "残りあり" : "残りなし"];
  assertNoSecrets(lines);
  return { lines, code: left ? 1 : 0 };
}

// What these lines must never carry, as aws/verify.ts looks for it in the logs: an account id (12 digits), an ARN, a URL, an invite
// secret's #k= and an Anthropic API key. The output is meant to be pasted into an issue.
export function assertNoSecrets(lines: string[]) {
  for (const line of lines) if (/\d{12}|arn:|https?:\/\/|#k=|sk-ant-/.test(line)) throw new Error("出力に秘密の形の値があります");
}
