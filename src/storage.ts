import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

export function storage() {
  const data = resolve(process.env.CAPSULE_DATA_DIR ?? resolve(homedir(), ".local/share/capsule-host/dev"));
  mkdirSync(data, { recursive: true, mode: 0o700 }); chmodSync(data, 0o700);
  const keyPath = `${data}/hmac.key`;
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(48).toString("hex"), { mode: 0o600, flag: "wx" });
  chmodSync(keyPath, 0o600);
  return { data, path: `${data}/capsule.sqlite`, key: readFileSync(keyPath, "utf8").trim() };
}
