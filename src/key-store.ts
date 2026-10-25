import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { D1 } from "./cloud-store";

// A creator's Anthropic API key is only ever stored sealed: AES-256-GCM under a key derived from the host's HMAC secret,
// with the subject as AAD so a value moved to another creator's slot cannot be opened.
export interface KeyStore {
  put(subject: string, sealed: string): Promise<void>;
  get(subject: string): Promise<string | null>;
  remove(subject: string): Promise<void>;
  // Marks the key as used at `at` without rewriting it, so a touch racing a removal never brings the key back.
  touch(subject: string, at: number): Promise<void>;
  // Removes every key last put or touched at or before `cutoff`.
  sweep(cutoff: number): Promise<void>;
}
const derive = (hmacKey: string) => Buffer.from(hkdfSync("sha256", hmacKey, "", "capsule-host creator-key", 32));
export function seal(hmacKey: string, subject: string, plaintext: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", derive(hmacKey), iv);
  cipher.setAAD(Buffer.from(subject));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function open(hmacKey: string, subject: string, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < 29) throw new Error("sealed value is too short");
  const decipher = createDecipheriv("aes-256-gcm", derive(hmacKey), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(subject)); decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export class LocalKeyStore implements KeyStore {
  constructor(private db: D1, private clock = () => Date.now()) {}
  async put(subject: string, sealed: string) {
    await this.db.prepare("INSERT INTO creator_keys(subject,sealed,updated) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET sealed=excluded.sealed,updated=excluded.updated").bind(subject, sealed, this.clock()).run();
  }
  async get(subject: string) {
    return (await this.db.prepare("SELECT sealed FROM creator_keys WHERE subject=?").bind(subject).first<{ sealed: string }>())?.sealed ?? null;
  }
  async remove(subject: string) { await this.db.prepare("DELETE FROM creator_keys WHERE subject=?").bind(subject).run(); }
  async touch(subject: string, at: number) { await this.db.prepare("UPDATE creator_keys SET updated=? WHERE subject=?").bind(at, subject).run(); }
  async sweep(cutoff: number) { await this.db.prepare("DELETE FROM creator_keys WHERE updated<=?").bind(cutoff).run(); }
}
