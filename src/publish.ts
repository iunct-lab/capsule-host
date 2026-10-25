import { readFileSync, writeFileSync, chmodSync, closeSync, existsSync, openSync, rmSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { CloudHost } from "./cloud-host";
import { LocalD1 } from "./local-d1";
import { storage } from "./storage";
import { validate, untimed } from "./schema";
import { publishHash } from "./validate";

// Host-side publisher: prepare a hash, review the input, then explicitly approve that exact hash.
const args = process.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const input = value("--input");
if (!input) throw new Error("Usage: bun src/publish.ts --input trip.json [--approve-sha256 HASH --owner-link-file PRIVATE_FILE]");
const payload = JSON.parse(readFileSync(resolve(input), "utf8"));
const checked = validate(payload.spec, payload.document, Date.now()), missing = untimed(checked.document);
if (missing.length) throw new Error(`開始時刻の無い予定があります: ${missing.map(m => m.path).join(", ")}`);
const hash = publishHash(checked);
const approval = value("--approve-sha256");
if (!approval) {
  console.log(JSON.stringify({ title: checked.spec.title, trip: checked.spec.trip, purgeAt: checked.spec.lifecycle.purgeAt, payloadHash: hash, items: checked.document.items.length, instruction: "内容・期限・ホストのバックアップ保持方針を確認し、このhashを --approve-sha256 に渡して実行してください。" }, null, 2));
} else {
  if (approval !== hash) throw new Error("承認したデータと現在の入力が一致しません");
  const origin = process.env.CAPSULE_ORIGIN;
  if (!origin || !origin.startsWith("https://")) throw new Error("公開先CAPSULE_ORIGINはHTTPSで指定してください");
  const output = value("--owner-link-file");
  if (!output) throw new Error("--owner-link-file に秘密のオーナーリンクの保存先を指定してください");
  if (existsSync(output)) throw new Error("保存先は既に存在しています。新しいファイル名を指定してください");
  // The owner link is the only way into a published capsule, so its file is created empty and 0600 first: a missing directory
  // or an unwritable path fails before anything exists, and the reservation is removed if publishing fails.
  const destination = resolve(output);
  let file: number;
  try { file = openSync(destination, "wx", 0o600); } catch { throw new Error("オーナーリンクの保存先を作成できませんでした。保存先のディレクトリと書き込み権限を確認してください"); }
  let written = false;
  const { path, key, data } = storage();
  const db = new LocalD1(path); chmodSync(path, 0o600);
  try {
    // The command line is the publisher: it goes through the same /v1/publish as every other creation.
    const host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: key, CAPSULE_ORIGIN: origin }, undefined, async () => "local-publisher");
    const response = await host.fetch(new Request(`${origin}/v1/publish`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...checked, confirm: true }) }));
    const c = await response.json() as { id: string; url: string; hash: string; error?: string };
    if (response.status !== 201) throw new Error(`発行に失敗しました (${response.status}): ${c.error}`);
    writeSync(file, c.url + "\n"); written = true;
    writeFileSync(`${data}/receipt-${c.id}.json`, JSON.stringify({ id: c.id, url: `${origin}/c/${c.id}`, specHash: c.hash, payloadHash: hash, purgeAt: checked.spec.lifecycle.purgeAt }, null, 2), { mode: 0o600, flag: "wx" });
    console.log(`Created capsule ${c.id}. Owner link written to the private output file; not printed.`);
  } finally { closeSync(file); if (!written) rmSync(destination, { force: true }); db.close(); }
}
